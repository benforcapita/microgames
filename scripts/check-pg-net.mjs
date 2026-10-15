// Print the pg_net PASS/GAP report. Does not raise inside the database.
// --lockdown runs supabase/ops/pg_net_lockdown.sql as the current role first.
// --strict exits non-zero when any row is GAP (operator/CI gate after a real lockdown).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const lockdown = args.has('--lockdown');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkSql = readFileSync(join(root, 'supabase/ops/check_pg_net_privileges.sql'), 'utf8');
const lockdownSql = readFileSync(join(root, 'supabase/ops/pg_net_lockdown.sql'), 'utf8');
const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const sql = postgres(dbUrl, {
  connect_timeout: 3,
  max: 1,
  idle_timeout: 1,
  onnotice(notice) {
    const message = notice?.message ?? String(notice);
    process.stderr.write(`WARNING: ${message}\n`);
  },
});

try {
  await sql`select 1`;
  if (lockdown) await sql.unsafe(lockdownSql);
  const rows = await sql.unsafe(checkSql);
  let gaps = 0;
  for (const row of rows) {
    if (row.status === 'GAP') gaps += 1;
    const role = String(row.role_name).padEnd(14);
    const privilege = String(row.privilege).padEnd(8);
    process.stdout.write(`${row.status}  ${role} ${privilege} ${row.object_name}\n`);
  }
  process.stdout.write(`pg_net privileges: ${gaps} GAP, ${rows.length - gaps} PASS\n`);
  if (strict && gaps > 0) process.exitCode = 1;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pg_net privilege check failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 1 });
}
