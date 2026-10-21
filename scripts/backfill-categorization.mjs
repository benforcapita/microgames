import postgres from 'postgres';

function refuse() {
  process.stderr.write('[backfill-categorization] refusing non-loopback host\n');
  process.exit(2);
}

const raw = process.env.DATABASE_URL;
if (!raw) {
  refuse();
}

let u;
try {
  u = new URL(raw);
} catch {
  refuse();
}

if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
  refuse();
}

const schemeEnd = raw.indexOf('://');
if (schemeEnd === -1) {
  refuse();
}

const rest = raw.slice(schemeEnd + 3);
const delimIdx = rest.search(/[/?#]/);
const authority = delimIdx === -1 ? rest : rest.slice(0, delimIdx);
if (authority.includes(',')) {
  refuse();
}

if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
  refuse();
}

const sql = postgres({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: decodeURIComponent(u.pathname.slice(1)) || 'postgres',
  username: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
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
