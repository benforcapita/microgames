// MG-14: POST /api/telemetry must not call supabase.auth.getClaims when the
// sb-*-auth-token cookie cannot be parsed into a session JSON holding a
// well-formed JWT — and must never trust the unverified payload either:
// user_id comes only from getClaims' verified claims. Local stack only.
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

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
/** A well-formed JWT-shaped string (locally made-up test data, not a real token). */
const jwt = (payload: Record<string, unknown>) =>
  `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}.${b64('sig')}`;
/** An sb-*-auth-token cookie value in the `base64-` format @supabase/ssr writes. */
const sessionCookie = (accessToken: string, expiresAt = 4_000_000_000) =>
  `base64-${b64(JSON.stringify({ access_token: accessToken, refresh_token: 'rt', expires_at: expiresAt }))}`;

const GAME = 'stk7wr01'; // seed "Stack Tower" (live)
const userId = randomUUID();
const sessionIds: string[] = [];
const nextSession = () => {
  const id = randomUUID();
  sessionIds.push(id);
  return id;
};
let ipCounter = 0;
const nextIp = () => `10.30.${Math.floor(ipCounter / 250) + 1}.${(ipCounter++ % 250) + 1}`;

/**
 * A real POST /api/telemetry call with the request surface the route reads
 * (same minimal-context convention as session-telemetry.db.test.ts). Only
 * getClaims is stubbed — Supabase Auth is the production boundary; `claims`
 * is what the stub would return, and getClaimsCalls records whether the
 * route invoked it at all.
 */
async function post(body: Record<string, unknown>, authCookie: string | null, claims: { sub: string } | null) {
  const uid = randomUUID();
  const request = new Request('http://127.0.0.1/api/telemetry', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${MG_UID_COOKIE}=${uid}` + (authCookie ? `; ${authCookie}` : ''),
    },
    body: JSON.stringify(body),
  });
  let getClaimsCalls = 0;
  const supabase = {
    auth: {
      getClaims: async () => {
        getClaimsCalls += 1;
        return { data: claims ? { claims } : null, error: null };
      },
    },
  };
  const res = await POST({
    request,
    url: new URL('http://127.0.0.1/api/telemetry'),
    cookies: {
      get: (name: string) => (name === MG_UID_COOKIE ? { value: uid } : undefined),
      set: () => {},
    },
    locals: { supabase },
    clientAddress: nextIp(),
  } as never);
  return { status: res.status, getClaimsCalls };
}

const sessionRow = async (id: string) =>
  (await sql<{ user_id: string | null }[]>`select user_id from sessions where id = ${id}`)[0];

function skip(t: { skip: (message?: string) => void }) {
  if (!probeOk || !sql) {
    t.skip('local supabase is not running');
    return true;
  }
  return false;
}

describe('telemetry session_start auth-cookie gate (db)', () => {
  before(async () => {
    if (!probeOk || !sql) return;
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${userId}, 'authenticated', 'authenticated',
              ${`mg14${userId.replace(/-/g, '').slice(0, 12)}@example.com`}, '', now(), now())`;
  });

  after(async () => {
    if (!sql) return;
    try {
      if (sessionIds.length) await sql`delete from public.sessions where id in ${sql(sessionIds)}`;
      await sql`delete from auth.users where id = ${userId}`;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('garbage auth cookie: never calls getClaims and records the session anonymously', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const r = await post(
      { sessionId, gameId: GAME, type: 'session_start', value: 0 },
      'sb-test-auth-token=not-a-session',
      { sub: userId },
    );
    assert.equal(r.status, 204);
    assert.equal(r.getClaimsCalls, 0);
    assert.equal((await sessionRow(sessionId))?.user_id, null);
  });

  it('broken auth-cookie chunks: never calls getClaims either', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const r = await post(
      { sessionId, gameId: GAME, type: 'session_start', value: 0 },
      'sb-test-auth-token.1=orphaned-chunk',
      { sub: userId },
    );
    assert.equal(r.status, 204);
    assert.equal(r.getClaimsCalls, 0);
    assert.equal((await sessionRow(sessionId))?.user_id, null);
  });

  it('well-formed session cookie: calls getClaims once and records its sub as user_id', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const r = await post(
      { sessionId, gameId: GAME, type: 'session_start', value: 0 },
      `sb-test-auth-token=${sessionCookie(jwt({ sub: userId }))}`,
      { sub: userId },
    );
    assert.equal(r.status, 204);
    assert.equal(r.getClaimsCalls, 1);
    assert.equal((await sessionRow(sessionId))?.user_id, userId);
  });

  it('well-formed chunked session cookie: also reaches getClaims', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const value = sessionCookie(jwt({ sub: userId }));
    const mid = Math.floor(value.length / 2);
    const r = await post(
      { sessionId, gameId: GAME, type: 'session_start', value: 0 },
      `sb-test-auth-token.0=${value.slice(0, mid)}; sb-test-auth-token.1=${value.slice(mid)}`,
      { sub: userId },
    );
    assert.equal(r.status, 204);
    assert.equal(r.getClaimsCalls, 1);
    assert.equal((await sessionRow(sessionId))?.user_id, userId);
  });

  it('forged well-formed token: getClaims is still the only source of truth', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    // The cookie parses, so getClaims is called — but it returns no claims,
    // and the unverified payload sub must never reach the session row.
    const r = await post(
      { sessionId, gameId: GAME, type: 'session_start', value: 0 },
      `sb-test-auth-token=${sessionCookie(jwt({ sub: userId }))}`,
      null,
    );
    assert.equal(r.status, 204);
    assert.equal(r.getClaimsCalls, 1);
    assert.equal((await sessionRow(sessionId))?.user_id, null);
  });

  it('expired-but-well-formed token still goes through getClaims (it may refresh)', async (t) => {
    if (skip(t)) return;
    const sessionId = nextSession();
    const r = await post(
      { sessionId, gameId: GAME, type: 'session_start', value: 0 },
      `sb-test-auth-token=${sessionCookie(jwt({ sub: userId, exp: 1 }), 1)}`,
      { sub: userId },
    );
    assert.equal(r.status, 204);
    assert.equal(r.getClaimsCalls, 1);
    assert.equal((await sessionRow(sessionId))?.user_id, userId);
  });
});
