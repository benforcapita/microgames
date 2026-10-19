// MG-10: first_frame_ms survives arriving before session_start, and session row creation
// stays behind the same getGame + admitSessionStart admission. Local stack only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { MG_UID_COOKIE } from './abuse.ts';

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
    await probe`select 1`;
    probeOk = true;
  } catch {
    probeOk = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

let sql: typeof import('./db.ts').sql;
let POST: typeof import('../../pages/api/telemetry.ts').POST;

if (probeOk) {
  sql = (await import('./db.ts')).sql;
  ({ POST } = await import('../../pages/api/telemetry.ts'));
}

const GAME = 'stk7wr01'; // seed "Stack Tower" (live)
const GAME2 = 'neon1an3'; // seed "Neon Lanes" (live)

const userId = randomUUID();
const sessionIds: string[] = [];
const nextSession = () => {
  const id = randomUUID();
  sessionIds.push(id);
  return id;
};
let ipCounter = 0;
const nextIp = () => `10.10.${Math.floor(ipCounter / 250) + 1}.${(ipCounter++ % 250) + 1}`;

interface SessionRow {
  id: string;
  game_id: string;
  first_frame_ms: number | null;
  user_id: string | null;
}

const row = async (id: string) =>
  (await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id from sessions where id = ${id}`)[0];

/**
 * A real POST /api/telemetry call with the request surface the route reads
 * (same minimal-context convention as google-route.test.ts). `claimsSub` simulates a
 * signed-in player: Supabase Auth is the production boundary, so only getClaims is stubbed.
 */
function post(uid: string, ip: string, body: Record<string, unknown>, claimsSub?: string) {
  const cookie = `${MG_UID_COOKIE}=${uid}` + (claimsSub ? '; sb-test-auth-token=x' : '');
  const request = new Request('http://127.0.0.1/api/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const supabase = {
    auth: {
      getClaims: async () => ({ data: claimsSub ? { claims: { sub: claimsSub } } : null }),
    },
  };
  return POST({
    request,
    url: new URL('http://127.0.0.1/api/telemetry'),
    cookies: {
      get: (name: string) => (name === MG_UID_COOKIE ? { value: uid } : undefined),
      set: () => {},
    },
    locals: { supabase },
    clientAddress: ip,
  } as never);
}

function skip(t: { skip: (message?: string) => void }) {
  if (!probeOk || !sql) {
    t.skip('local supabase is not running');
    return true;
  }
  return false;
}

describe('session telemetry ordering (db)', () => {
  before(async () => {
    if (!probeOk || !sql) return;
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${userId}, 'authenticated', 'authenticated',
              ${`mg10${userId.replace(/-/g, '').slice(0, 12)}@example.com`}, '', now(), now())`;
  });

  after(async () => {
    if (!sql) return;
    try {
      await sql`delete from public.sessions where id in ${sql(sessionIds)}`;
      await sql`delete from auth.users where id = ${userId}`;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('first_frame before session_start still records first_frame_ms and the later start fills user_id', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'first_frame', value: 640 })).status, 204);
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userId)).status, 204);
    const r = await row(sessionId);
    assert.equal(r?.first_frame_ms, 640);
    assert.equal(r?.user_id, userId);
  });

  it('normal order (session_start then first_frame) records first_frame_ms', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 })).status, 204);
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'first_frame', value: 512 })).status, 204);
    const r = await row(sessionId);
    assert.equal(r?.first_frame_ms, 512);
  });

  it('duplicate first_frame keeps the first value', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    await post(uid, ip, { sessionId, gameId: GAME, type: 'first_frame', value: 111 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'first_frame', value: 999 });
    assert.equal((await row(sessionId))?.first_frame_ms, 111);
    // And when the row already exists, a repeat still cannot overwrite.
    await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'first_frame', value: 555 });
    assert.equal((await row(sessionId))?.first_frame_ms, 111);
  });

  it('session_start after first_frame never nulls or overwrites first_frame_ms, nor does a duplicate start', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    await post(uid, ip, { sessionId, gameId: GAME, type: 'first_frame', value: 432 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
    assert.equal((await row(sessionId))?.first_frame_ms, 432);
    await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
    const r = await row(sessionId);
    assert.equal(r?.first_frame_ms, 432);
    assert.equal(r?.game_id, GAME);
  });

  it('concurrent session_start/first_frame: every session keeps first_frame_ms and exactly one row', async (t) => {
    if (skip(t)) return;
    const N = 200;
    const expected = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const sessionId = nextSession();
      const ms = 700 + i;
      expected.set(sessionId, ms);
      const uid = randomUUID();
      const ip = nextIp();
      const ff = post(uid, ip, { sessionId, gameId: GAME, type: 'first_frame', value: ms });
      const ss = post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
      const res = await (i % 2 ? Promise.all([ss, ff]) : Promise.all([ff, ss]));
      for (const r of res) assert.equal(r.status, 204);
    }
    const ids = [...expected.keys()];
    const rows = await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id from sessions where id in ${sql(ids)}`;
    assert.equal(rows.length, N);
    const lost = rows.filter((r) => r.first_frame_ms !== expected.get(r.id)).length;
    assert.equal(lost, 0, `${lost}/${N} sessions lost first_frame_ms`);
    for (const r of rows) assert.equal(r.first_frame_ms, expected.get(r.id), `session ${r.id}`);
  });

  it('first_frame for an unknown game creates no row and does not 500', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const res = await post(randomUUID(), nextIp(), { sessionId, gameId: 'mg10-nosuch', type: 'first_frame', value: 100 });
    assert.notEqual(res.status, 500);
    assert.equal(await row(sessionId), undefined);
  });

  it('first_frame naming a different game cannot touch another game\u2019s session row', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME2, type: 'first_frame', value: 321 })).status, 204);
    const r = await row(sessionId);
    assert.equal(r?.game_id, GAME);
    assert.equal(r?.first_frame_ms, null);
  });

  it('first_frame-created rows stay bound by session-start admission (one per uid+game)', async (t) => {
    if (skip(t)) return;
    const uid = randomUUID();
    const ip = nextIp();
    const a = nextSession();
    const b = nextSession();
    assert.equal((await post(uid, ip, { sessionId: a, gameId: GAME, type: 'first_frame', value: 210 })).status, 204);
    assert.equal((await post(uid, ip, { sessionId: b, gameId: GAME, type: 'first_frame', value: 220 })).status, 204);
    assert.equal((await row(a))?.first_frame_ms, 210);
    assert.equal(await row(b), undefined, 'second admitted attempt must not create a row');
  });
});
