import postgres from 'postgres';

const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let host;
try {
  host = new URL(raw).hostname;
} catch {
  process.stderr.write('[backfill-categorization] refusing invalid database URL\n');
  process.exit(2);
}

if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
  process.stderr.write('[backfill-categorization] refusing non-loopback host\n');
  process.exit(2);
}

const sql = postgres(raw, {
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
