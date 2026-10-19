// MG-10: first_frame_ms survives arriving before session_start, and session row creation
// stays behind the same getGame + admitSessionStart admission. Local stack only.
// MG-13: the same race for start, complete, crash and heartbeat.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import postgres from 'postgres';
import { MG_UID_COOKIE, admitSessionStart } from './abuse.ts';
import type { TelemetryType } from './games.ts';
import {
  insertSessionStart,
  postgresSchemaClient,
  resetSchemaWarnings,
} from './schema-rollout.ts';

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
let recordTelemetry: typeof import('./games.ts').recordTelemetry;
let getGame: typeof import('./games.ts').getGame;

if (probeOk) {
  sql = (await import('./db.ts')).sql;
  ({ POST } = await import('../../pages/api/telemetry.ts'));
  ({ recordTelemetry, getGame } = await import('./games.ts'));
}

const GAME = 'stk7wr01'; // seed "Stack Tower" (live)
const GAME2 = 'neon1an3'; // seed "Neon Lanes" (live)

const userId = randomUUID();
const userIdB = randomUUID();
const sessionIds: string[] = [];
const nextSession = () => {
  const id = randomUUID();
  sessionIds.push(id);
  return id;
};
const gameIds: string[] = [];
const nextGame = () => {
  const id = `mg10-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  gameIds.push(id);
  return id;
};
let ipCounter = 0;
const nextIp = () => `10.10.${Math.floor(ipCounter / 250) + 1}.${(ipCounter++ % 250) + 1}`;

interface SessionRow {
  id: string;
  game_id: string;
  first_frame_ms: number | null;
  user_id: string | null;
  started: boolean;
  completed: boolean;
  crashed: boolean;
  duration_ms: number;
}

const row = async (id: string) =>
  (await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id, started, completed, crashed, duration_ms from sessions where id = ${id}`)[0];

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

/**
 * The five events that may arrive before session_start. `applied` asserts the
 * event left its value on its own session row; `untouched` asserts another
 * game's row kept the column defaults — the markers the unpublished-game,
 * cross-game and admission tests assert per event.
 */
const EVENTS: {
  type: TelemetryType;
  value: number;
  applied: (r: SessionRow | undefined) => void;
  untouched: (r: SessionRow | undefined) => void;
}[] = [
  {
    type: 'first_frame',
    value: 640,
    applied: (r) => assert.equal(r?.first_frame_ms, 640),
    untouched: (r) => assert.equal(r?.first_frame_ms, null),
  },
  {
    type: 'start',
    value: 0,
    applied: (r) => assert.equal(r?.started, true),
    untouched: (r) => assert.equal(r?.started, false),
  },
  {
    type: 'complete',
    value: 0,
    applied: (r) => {
      assert.equal(r?.completed, true);
      assert.equal(r?.started, true);
    },
    untouched: (r) => {
      assert.equal(r?.completed, false);
      assert.equal(r?.started, false);
    },
  },
  {
    type: 'crash',
    value: 0,
    applied: (r) => assert.equal(r?.crashed, true),
    untouched: (r) => assert.equal(r?.crashed, false),
  },
  {
    type: 'heartbeat',
    value: 9000,
    applied: (r) => assert.equal(r?.duration_ms, 9000),
    untouched: (r) => assert.equal(r?.duration_ms, 0),
  },
];

describe('session telemetry ordering (db)', () => {
  before(async () => {
    if (!probeOk || !sql) return;
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${userId}, 'authenticated', 'authenticated',
              ${`mg10${userId.replace(/-/g, '').slice(0, 12)}@example.com`}, '', now(), now()),
             ('00000000-0000-0000-0000-000000000000', ${userIdB}, 'authenticated', 'authenticated',
              ${`mg10${userIdB.replace(/-/g, '').slice(0, 12)}@example.com`}, '', now(), now())`;
  });

  after(async () => {
    if (!sql) return;
    try {
      await sql`delete from public.sessions where id in ${sql(sessionIds)}`;
      if (gameIds.length) await sql`delete from public.games where id in ${sql(gameIds)}`;
      await sql`delete from auth.users where id in ${sql([userId, userIdB])}`;
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
    const rows = await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id, started, completed, crashed, duration_ms from sessions where id in ${sql(ids)}`;
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

  it('a session_start from another signed-in user cannot take over a start-created session row', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uidA = randomUUID();
    const uidB = randomUUID();
    // Paired allowed case: A's own start does set user_id on the row it created.
    assert.equal((await post(uidA, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userId)).status, 204);
    assert.equal((await row(sessionId))?.user_id, userId);
    assert.equal((await post(uidB, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userIdB)).status, 204);
    const rows = await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id, started, completed, crashed, duration_ms from sessions where id = ${sessionId}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.user_id, userId, "another user's session_start must not overwrite user_id");
    // An anonymous start for the same session id cannot clear it either.
    await post(uidB, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 });
    assert.equal((await row(sessionId))?.user_id, userId);
  });

  it('a session_start from another signed-in user cannot take over a first_frame-created row once claimed', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uidA = randomUUID();
    const uidB = randomUUID();
    assert.equal((await post(uidA, nextIp(), { sessionId, gameId: GAME, type: 'first_frame', value: 640 })).status, 204);
    // Paired allowed case: A's signed-in start claims the anonymous row.
    assert.equal((await post(uidA, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userId)).status, 204);
    assert.equal((await row(sessionId))?.user_id, userId);
    assert.equal((await post(uidB, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userIdB)).status, 204);
    const rows = await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id, started, completed, crashed, duration_ms from sessions where id = ${sessionId}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.user_id, userId, "another user's session_start must not overwrite user_id");
    assert.equal(rows[0]?.first_frame_ms, 640, "another user's session_start must not touch first_frame_ms");
  });

  it('an anonymous session row gains user_id when a later session_start is signed in', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    assert.equal((await post(uid, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 })).status, 204);
    assert.equal((await row(sessionId))?.user_id, null);
    assert.equal((await post(uid, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userId)).status, 204);
    assert.equal((await row(sessionId))?.user_id, userId);
  });

  // ---- MG-13: the same race for crash, complete, start and heartbeat ----

  it('crash before session_start still records crashed=true and the later start fills user_id', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'crash', value: 0 })).status, 204);
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userId)).status, 204);
    const r = await row(sessionId);
    assert.equal(r?.crashed, true);
    assert.equal(r?.started, false, 'a crash alone must not mark the session started');
    assert.equal(r?.user_id, userId);
  });

  it('concurrent session_start/crash: every session keeps crashed=true and exactly one row', async (t) => {
    if (skip(t)) return;
    const N = 200;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const sessionId = nextSession();
      ids.push(sessionId);
      const uid = randomUUID();
      const ip = nextIp();
      const crash = post(uid, ip, { sessionId, gameId: GAME, type: 'crash', value: 0 });
      const ss = post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
      const res = await (i % 2 ? Promise.all([ss, crash]) : Promise.all([crash, ss]));
      for (const r of res) assert.equal(r.status, 204);
    }
    const rows = await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id, started, completed, crashed, duration_ms from sessions where id in ${sql(ids)}`;
    assert.equal(rows.length, N);
    const lost = rows.filter((r) => !r.crashed).length;
    assert.equal(lost, 0, `${lost}/${N} sessions lost crashed=true`);
  });

  it('concurrent session_start/heartbeat/complete/crash: the final row has every merge applied', async (t) => {
    if (skip(t)) return;
    const N = 60;
    const expected = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const sessionId = nextSession();
      const ms = 30_000 + i;
      expected.set(sessionId, ms);
      const uid = randomUUID();
      const ip = nextIp();
      const posts = [
        post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 }),
        post(uid, ip, { sessionId, gameId: GAME, type: 'heartbeat', value: ms }),
        post(uid, ip, { sessionId, gameId: GAME, type: 'complete', value: 0 }),
        post(uid, ip, { sessionId, gameId: GAME, type: 'crash', value: 0 }),
      ];
      const res = await Promise.all([...posts.slice(i % 4), ...posts.slice(0, i % 4)]);
      for (const r of res) assert.equal(r.status, 204);
    }
    const ids = [...expected.keys()];
    const rows = await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id, started, completed, crashed, duration_ms from sessions where id in ${sql(ids)}`;
    assert.equal(rows.length, N);
    for (const r of rows) {
      assert.equal(r.started, true, `session ${r.id} lost started`);
      assert.equal(r.completed, true, `session ${r.id} lost completed`);
      assert.equal(r.crashed, true, `session ${r.id} lost crashed`);
      assert.equal(r.duration_ms, expected.get(r.id), `session ${r.id} lost duration_ms`);
    }
  });

  it('later or duplicate events never clear crashed, completed or started; a smaller heartbeat never lowers duration_ms', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    await post(uid, ip, { sessionId, gameId: GAME, type: 'crash', value: 0 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'complete', value: 0 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'heartbeat', value: 9000 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'crash', value: 0 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'start', value: 0 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'complete', value: 0 });
    await post(uid, ip, { sessionId, gameId: GAME, type: 'heartbeat', value: 3000 });
    const r = await row(sessionId);
    assert.equal(r?.crashed, true);
    assert.equal(r?.completed, true);
    assert.equal(r?.started, true);
    assert.equal(r?.duration_ms, 9000, 'a smaller heartbeat must not lower duration_ms');
    await post(uid, ip, { sessionId, gameId: GAME, type: 'heartbeat', value: 20000 });
    assert.equal((await row(sessionId))?.duration_ms, 20000, 'a larger heartbeat must raise duration_ms');
  });

  it('crash for an unknown game creates no row and does not 500', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const res = await post(randomUUID(), nextIp(), { sessionId, gameId: 'mg10-nosuch', type: 'crash', value: 0 });
    assert.notEqual(res.status, 500);
    assert.equal(await row(sessionId), undefined);
  });

  it('heartbeat for an unknown game creates no row and does not 500', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const res = await post(randomUUID(), nextIp(), { sessionId, gameId: 'mg10-nosuch', type: 'heartbeat', value: 5000 });
    assert.notEqual(res.status, 500);
    assert.equal(await row(sessionId), undefined);
  });

  for (const e of EVENTS) {
    it(`${e.type} on an unpublished game creates no session row even when admission allows`, async (t) => {
      if (skip(t)) return;
      const rejected = nextGame();
      await sql`insert into public.games (id, slug, creator, title, stage)
                values (${rejected}, ${rejected}, 'mg10', 'MG13 Rejected', 'rejected')`;
      // Reach the insert guard itself: admission always allows, so only the
      // public-stage EXISTS in the event insert can stop the row. The route
      // would 404 earlier on getGame; the DB must not depend on that.
      const admit = async () => true;
      const denied = nextSession();
      await recordTelemetry(denied, rejected, e.type, e.value, null, admit);
      assert.equal(await row(denied), undefined, `${e.type} created a session row for an unpublished game`);
      const allowed = nextSession();
      await recordTelemetry(allowed, GAME, e.type, e.value, null, admit);
      const r = await row(allowed);
      assert.ok(r, 'same admitted call creates the row on a live game');
      e.applied(r);
    });
  }

  for (const e of EVENTS) {
    // The session row belongs to GAME; the event names GAME2. Both UPDATE paths
    // miss on game_id, so only the INSERT's ON CONFLICT game guard protects the
    // foreign row — the path these parametrized tests pin.
    it(`${e.type} naming a different game cannot touch another game’s session row`, async (t) => {
      if (skip(t)) return;
      const sessionId = nextSession();
      const uid = randomUUID();
      const ip = nextIp();
      await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 });
      assert.equal((await post(uid, ip, { sessionId, gameId: GAME2, type: e.type, value: e.value })).status, 204);
      const r = await row(sessionId);
      assert.equal(r?.game_id, GAME);
      e.untouched(r);
    });
  }

  for (const e of EVENTS) {
    it(`${e.type}-created rows stay bound by session-start admission (one per uid+game)`, async (t) => {
      if (skip(t)) return;
      const uid = randomUUID();
      const ip = nextIp();
      const a = nextSession();
      const b = nextSession();
      assert.equal((await post(uid, ip, { sessionId: a, gameId: GAME, type: e.type, value: e.value })).status, 204);
      assert.equal((await post(uid, ip, { sessionId: b, gameId: GAME, type: e.type, value: e.value })).status, 204);
      e.applied(await row(a));
      assert.equal(await row(b), undefined, 'second admitted attempt must not create a row');
    });
  }

  it('a session_start from another signed-in user cannot take over a crash-created row once claimed', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uidA = randomUUID();
    const uidB = randomUUID();
    assert.equal((await post(uidA, nextIp(), { sessionId, gameId: GAME, type: 'crash', value: 0 })).status, 204);
    // Paired allowed case: A's signed-in start claims the anonymous row.
    assert.equal((await post(uidA, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userId)).status, 204);
    assert.equal((await row(sessionId))?.user_id, userId);
    assert.equal((await post(uidB, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userIdB)).status, 204);
    const rows = await sql<SessionRow[]>`select id, game_id, first_frame_ms, user_id, started, completed, crashed, duration_ms from sessions where id = ${sessionId}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.user_id, userId, "another user's session_start must not overwrite user_id");
    assert.equal(rows[0]?.crashed, true, "another user's session_start must not clear crashed");
  });

  it('an anonymous crash-created row gains user_id when a later session_start is signed in', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    assert.equal((await post(uid, nextIp(), { sessionId, gameId: GAME, type: 'crash', value: 0 })).status, 204);
    assert.equal((await row(sessionId))?.user_id, null);
    assert.equal((await post(uid, nextIp(), { sessionId, gameId: GAME, type: 'session_start', value: 0 }, userId)).status, 204);
    const r = await row(sessionId);
    assert.equal(r?.user_id, userId);
    assert.equal(r?.crashed, true);
  });

  it('complete before session_start still records completed=true and started=true', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'complete', value: 0 })).status, 204);
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 })).status, 204);
    const r = await row(sessionId);
    assert.equal(r?.completed, true);
    assert.equal(r?.started, true, 'complete implies started');
  });

  it('start before session_start still records started=true', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'start', value: 0 })).status, 204);
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 })).status, 204);
    assert.equal((await row(sessionId))?.started, true);
  });

  it('heartbeat before session_start still records duration_ms, and it only moves forward', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const uid = randomUUID();
    const ip = nextIp();
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'heartbeat', value: 12345 })).status, 204);
    assert.equal((await post(uid, ip, { sessionId, gameId: GAME, type: 'session_start', value: 0 })).status, 204);
    assert.equal((await row(sessionId))?.duration_ms, 12345);
    await post(uid, ip, { sessionId, gameId: GAME, type: 'heartbeat', value: 4000 });
    assert.equal((await row(sessionId))?.duration_ms, 12345, 'a smaller heartbeat must not lower duration_ms');
    await post(uid, ip, { sessionId, gameId: GAME, type: 'heartbeat', value: 20000 });
    assert.equal((await row(sessionId))?.duration_ms, 20000, 'a larger heartbeat must raise duration_ms');
  });

  it('holds no advisory locks after a burst of locked events', async (t) => {
    if (skip(t)) return;
    const peek = postgres(url, { max: 1, prepare: false, connect_timeout: 3 });
    try {
      const locks = async () =>
        (await peek<{ n: number }[]>`select count(*)::int as n from pg_locks where locktype = 'advisory'`)[0]?.n ?? -1;
      const before = await locks();
      // Fewer than the pool's 10 connections so this guard cannot itself exhaust it.
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          post(randomUUID(), nextIp(), {
            sessionId: nextSession(),
            gameId: GAME,
            type: ['session_start', 'first_frame', 'crash', 'heartbeat'][i % 4],
            value: 100 + i,
          })),
      );
      assert.equal(await locks(), before, 'advisory locks leaked');
    } finally {
      await peek.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('insertSessionStart keeps its missing-user_id fallback inside a transaction (savepoint)', async (t) => {
    if (skip(t)) return;
    resetSchemaWarnings();
    const warn = mock.method(console, 'warn', () => {});
    const sessionId = nextSession();
    try {
      await sql.begin(async (tx) => {
        // Reproduce the pre-play_gate schema inside a rolled-back tx: the first insert
        // errors 42703, and only a savepoint lets the retry run in an aborted tx.
        await tx`alter table public.sessions drop column user_id cascade`;
        await insertSessionStart(postgresSchemaClient(tx), { sessionId, gameId: GAME, userId });
        const [r] = await tx<{ game_id: string }[]>`select game_id from sessions where id = ${sessionId}`;
        assert.equal(r?.game_id, GAME, 'fallback insert must land the row inside the tx');
        throw new Error('__rollback__');
      });
      assert.fail('tx must roll back');
    } catch (err) {
      if ((err as Error).message !== '__rollback__') throw err;
    } finally {
      warn.mock.restore();
    }
    const [col] = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'sessions' and column_name = 'user_id'`;
    assert.equal(col?.n, 1, 'rollback must restore user_id');
    assert.equal(await row(sessionId), undefined);
  });

  // Last on purpose: a pre-fix run deadlocks the shared pool for the rest of the file.
  it('no pool deadlock: >=30 each of session_start, first_frame-first and crash-first creates all complete', async (t) => {
    if (skip(t)) return;
    // Same shape the route builds: inside the session lock it may only read via `db`
    // (the lock-holding transaction) — the pool could be exhausted by other sessions.
    const admit =
      (uid: string, ip: string) => async (db: postgres.Sql | postgres.TransactionSql) =>
        Boolean(await getGame(GAME, { db })) && admitSessionStart(uid, ip, GAME);
    const withTimeout = (p: Promise<unknown>, label: string) =>
      Promise.race([
        p,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${label}`)), 15_000)),
      ]);
    const jobs: Promise<unknown>[] = [];
    const expected = new Map<string, number | null>();
    const crashed = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const sessionId = nextSession();
      expected.set(sessionId, null);
      jobs.push(withTimeout(recordTelemetry(sessionId, GAME, 'session_start', 0, null, admit(randomUUID(), nextIp())), sessionId));
    }
    for (let i = 0; i < 30; i++) {
      const sessionId = nextSession();
      const ms = 900 + i;
      expected.set(sessionId, ms);
      jobs.push(withTimeout(recordTelemetry(sessionId, GAME, 'first_frame', ms, null, admit(randomUUID(), nextIp())), sessionId));
    }
    for (let i = 0; i < 30; i++) {
      const sessionId = nextSession();
      expected.set(sessionId, null);
      crashed.add(sessionId);
      jobs.push(withTimeout(recordTelemetry(sessionId, GAME, 'crash', 0, null, admit(randomUUID(), nextIp())), sessionId));
    }
    const results = await Promise.allSettled(jobs);
    const stuck = results.filter((r) => r.status === 'rejected').length;
    assert.equal(stuck, 0, `${stuck} events did not complete (pool exhaustion/deadlock)`);
    for (const [sessionId, want] of expected) {
      const r = await row(sessionId);
      assert.ok(r, `no row for ${sessionId}`);
      assert.equal(r.first_frame_ms, want);
      assert.equal(r.crashed, crashed.has(sessionId));
    }
  });
});
