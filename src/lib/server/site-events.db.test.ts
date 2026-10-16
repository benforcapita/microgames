import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let isLocal = false;
try {
  const parsed = new URL(url);
  isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
} catch {
  isLocal = false;
}

if (isLocal) {
  process.env.DATABASE_URL = url;
  process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
  process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test';
  process.env.SUPABASE_SECRET_KEY ??= 'test';
}

let probeOk = false;
if (isLocal) {
  const probe = postgres(url, { connect_timeout: 3, max: 1 });
  try {
    // Only a local DB that has this migration applied; skip otherwise.
    const [r] = await probe`select to_regclass('public.site_events') is not null as ok`;
    probeOk = Boolean(r?.ok);
  } catch {
    probeOk = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

const P = 'se' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

describe('site_events writes (local DB)', { skip: !probeOk && 'no local database' }, () => {
  let sql: typeof import('./db.ts').sql;
  let recordSiteEvent: typeof import('./site-events.ts').recordSiteEvent;
  let parseSiteEvent: typeof import('./site-events.ts').parseSiteEvent;
  let gameId = '';
  let userId = '';

  before(async () => {
    ({ sql } = await import('./db.ts'));
    ({ recordSiteEvent, parseSiteEvent } = await import('./site-events.ts'));
    const [any] = await sql<{ id: string }[]>`select id from public.games limit 1`;
    if (any) gameId = any.id;
    else {
      gameId = `${P}-g`;
      await sql`insert into public.games (id, slug, creator, title, stage) values (${gameId}, ${gameId}, ${'c' + P}, 'SE', 'live')`;
    }
    const [u] = await sql<{ id: string }[]>`select id from auth.users limit 1`;
    userId = u?.id ?? '';
  });
  after(async () => {
    await sql`delete from public.site_events where path like ${'/' + P + '%'}`;
    await sql`delete from public.games where id like ${P + '%'}`;
    await sql.end({ timeout: 1 }).catch(() => {});
  });

  const ev = (o: Record<string, unknown>) => {
    const r = parseSiteEvent(o);
    assert.ok(r.ok);
    return r.event;
  };

  it('stores an existing game_id, the session user, path and details', async () => {
    await recordSiteEvent(ev({ type: 'game_launch', path: `/${P}/a`, gameId, details: { k: 1 } }), userId || null);
    const [row] = await sql`select * from public.site_events where path = ${`/${P}/a`}`;
    assert.equal(row.event_type, 'game_launch');
    assert.equal(row.game_id, gameId);
    assert.equal(row.user_id, userId || null);
    assert.deepEqual(row.details, { k: 1 });
  });

  it('an unknown game_id is stored as null, not rejected', async () => {
    await recordSiteEvent(ev({ type: 'page_view', path: `/${P}/b`, gameId: `${P}-nope` }), null);
    const [row] = await sql`select game_id, user_id from public.site_events where path = ${`/${P}/b`}`;
    assert.equal(row.game_id, null);
    assert.equal(row.user_id, null);
  });

  it('a 10-digit Unix timestamp in an error message and details is stored', async () => {
    const r = parseSiteEvent({ type: 'error', path: `/${P}/ts`, details: { message: 'crash at 1760598000', ts: 1760598000 } });
    assert.ok(r.ok, JSON.stringify(r));
    await recordSiteEvent(r.event, null);
    const [row] = await sql`select details from public.site_events where path = ${`/${P}/ts`}`;
    assert.deepEqual(row.details, { message: 'crash at 1760598000', ts: 1760598000 });
  });

  it('rows have no IP or email column and no IP/email value', async () => {
    const cols = (await sql<{ column_name: string }[]>`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'site_events'`).map((c) => c.column_name).sort();
    assert.deepEqual(cols, ['created_at', 'details', 'event_type', 'game_id', 'id', 'path', 'user_id']);
    const rows = await sql`select row_to_json(s)::text as j from public.site_events s where path like ${'/' + P + '%'}`;
    assert.ok(rows.length >= 2);
    for (const r of rows) assert.doesNotMatch(r.j, /@|\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });

  it('the DB rejects trigger-only types inserted directly by the route path (type check holds)', async () => {
    await assert.rejects(sql`insert into public.site_events (event_type) values ('bogus')`);
  });
});
