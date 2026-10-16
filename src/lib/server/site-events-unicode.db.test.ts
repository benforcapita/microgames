import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import postgres from 'postgres';

// LG-1b: client-truncated CJK / emoji survive the real server path into jsonb unchanged (LOCAL DB only).
const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
let isLocal = false;
try {
  const h = new URL(url).hostname;
  isLocal = h === '127.0.0.1' || h === 'localhost';
} catch {
  isLocal = false;
}
let probeOk = false;
if (isLocal) {
  process.env.DATABASE_URL = url;
  process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
  process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test';
  process.env.SUPABASE_SECRET_KEY ??= 'test';
  const probe = postgres(url, { connect_timeout: 3, max: 1 });
  try {
    const [r] = await probe`select to_regclass('public.site_events') is not null as ok`;
    probeOk = Boolean(r?.ok);
  } catch {
    probeOk = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

const P = '/u' + Date.now().toString(36);

describe('client-truncated unicode round-trips through /api/events into local jsonb', { skip: !probeOk && 'no local database with site_events' }, () => {
  let sql: typeof import('./db.ts').sql;
  after(async () => {
    if (!sql) return;
    await sql`delete from public.site_events where path like ${P + '%'}`;
    await sql.end({ timeout: 1 }).catch(() => {});
  });
  for (const [name, ch] of Object.entries({ cjk: '漢字', emoji: '😀👍🏽', mixed: 'a😀é漢' })) {
    it(`${name}: stored truncated and byte-identical to what the client sent`, async () => {
      ({ sql } = await import('./db.ts'));
      const { handleSiteEvent } = await import('./site-events.ts');
      const { errorDetails } = await import('../../client/site-events.ts');
      const details = errorDetails('portal', ch.repeat(3000), `Error\n${`    at f (${ch.repeat(30)}.js:1:2)\n`.repeat(300)}`);
      const path = `${P}/${name}`;
      const res = await handleSiteEvent(new Request('http://x/api/events', { method: 'POST', body: JSON.stringify({ type: 'error', path, details }) }),
        { ip: 'unicode-test' }, { limiter: { hit: () => true } });
      assert.equal(res.status, 204);
      const [row] = await sql`select details, pg_column_size(details) as size from public.site_events where path = ${path}`;
      assert.ok(row, 'row stored');
      assert.deepEqual(row.details, details);
      assert.ok(String(row.details.message).endsWith('…'));
      assert.ok(row.size <= 4096);
    });
  }
});
