import postgres from 'postgres';
import { parseLocalDbUrl } from './lib/parse-local-db-url.mjs';

function refuse() {
  process.stderr.write('[backfill-categorization] refusing non-loopback host\n');
  process.exit(2);
}

const parsed = parseLocalDbUrl(process.env.DATABASE_URL);
if (!parsed) {
  refuse();
}

const sql = postgres({
  ...parsed,
  connect_timeout: 3,
  max: 1,
  idle_timeout: 1,
});

try {
  const [row] = await sql`select private.cat_backfill_runs() as queued`;
  const count = Number(row?.queued ?? 0);
  console.log(`[backfill-categorization] queued ${count}`);
} catch (err) {
  const message = err instanceof Error ? err.message : 'query failed';
  process.stderr.write(`[backfill-categorization] ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
