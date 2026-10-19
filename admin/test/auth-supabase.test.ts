import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestAuth, type AuthKind } from '../src/lib/auth-supabase.ts';
import { TEST_ADMIN_ID, TEST_ANON_KEY } from './helpers.ts';
import {
  MOCK_AUTH_URL,
  MOCK_COOKIE_NAME,
  cookieHeader,
  futureExp,
  jwtWithClaim,
  pastExp,
  scriptedFetch,
  sessionCookieValue,
  type AuthScript,
  type FactorFixture,
} from './helpers/mock-auth.ts';

const TOTP: FactorFixture = { id: 'factor-1', factor_type: 'totp', status: 'verified' };
const PHONE: FactorFixture = { id: 'factor-2', factor_type: 'phone', status: 'verified' };

function open(cookie: string | undefined, script: AuthScript, timeoutMs?: number) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return createRequestAuth({
    url: MOCK_AUTH_URL,
    anonKey: TEST_ANON_KEY,
    adminUserId: TEST_ADMIN_ID,
    request: new Request('http://localhost/admin', { headers }),
    fetch: scriptedFetch(script),
    timeoutMs,
  });
}

function live(aal: 'aal1' | 'aal2', exp = futureExp(), refreshToken?: string) {
  const token = jwtWithClaim({ aal, exp });
  return {
    token,
    cookie: cookieHeader(sessionCookieValue(token, exp, refreshToken)),
  };
}

async function classify(cookie: string | undefined, script: AuthScript): Promise<AuthKind> {
  return open(cookie, script).classify();
}

test('auth: no cookie is none', async () => {
  assert.deepEqual(await classify(undefined, { userId: TEST_ADMIN_ID }), { kind: 'none' });
});

test('auth: a cookie that is not a session is none', async () => {
  const cookie = cookieHeader(`base64-${Buffer.from('{"nope":true}').toString('base64url')}`);
  assert.deepEqual(await classify(cookie, { userId: TEST_ADMIN_ID, userStatus: 401 }), { kind: 'none' });
});

test('auth: a foreign-signed token the server rejects is error', async () => {
  const { cookie } = live('aal2');
  assert.deepEqual(
    await classify(cookie, { userId: TEST_ADMIN_ID, userStatus: 401, acceptedBearer: 'nope' }),
    { kind: 'error' },
  );
});

test('auth: an expired session whose refresh is rejected is error', async () => {
  const { cookie } = live('aal2', pastExp());
  assert.deepEqual(await classify(cookie, { userId: TEST_ADMIN_ID }), { kind: 'error' });
});

test('auth: Ben at aal1 without a verified factor', async () => {
  const { token, cookie } = live('aal1');
  assert.deepEqual(
    await classify(cookie, { userId: TEST_ADMIN_ID, acceptedBearer: token, factors: [] }),
    { kind: 'aal1-ben', verifiedTotp: false },
  );
});

test('auth: Ben at aal1 with a verified TOTP factor', async () => {
  const { token, cookie } = live('aal1');
  assert.deepEqual(
    await classify(cookie, { userId: TEST_ADMIN_ID, acceptedBearer: token, factors: [TOTP] }),
    { kind: 'aal1-ben', verifiedTotp: true },
  );
});

test('auth: Ben at aal1 with only an unverified TOTP factor', async () => {
  const { token, cookie } = live('aal1');
  const unverified: FactorFixture = { id: 'factor-1', factor_type: 'totp', status: 'unverified' };
  assert.deepEqual(
    await classify(cookie, { userId: TEST_ADMIN_ID, acceptedBearer: token, factors: [unverified] }),
    { kind: 'aal1-ben', verifiedTotp: false },
  );
});

test('auth: Ben at aal2 with a verified TOTP factor is ok', async () => {
  const { token, cookie } = live('aal2');
  assert.deepEqual(await classify(cookie, { userId: TEST_ADMIN_ID, acceptedBearer: token, factors: [TOTP] }), {
    kind: 'ok',
  });
});

test('auth: Ben at aal2 without a verified TOTP factor is not ok', async () => {
  const { token, cookie } = live('aal2');
  assert.deepEqual(
    await classify(cookie, { userId: TEST_ADMIN_ID, acceptedBearer: token, factors: [PHONE] }),
    { kind: 'error' },
  );
});

test('auth: another user is other-user even at aal2', async () => {
  const { token, cookie } = live('aal2');
  assert.deepEqual(
    await classify(cookie, {
      userId: '99999999-9999-4999-8999-999999999999',
      acceptedBearer: token,
      factors: [TOTP],
    }),
    { kind: 'other-user' },
  );
});

test('auth: aal comes from the refreshed token, not the expired cookie', async () => {
  // The cookie says aal2. The refresh (the token Auth then accepts) says aal1.
  const stale = jwtWithClaim({ aal: 'aal2', exp: pastExp() });
  const fresh = jwtWithClaim({ aal: 'aal1', exp: futureExp() });
  const kind = await classify(cookieHeader(sessionCookieValue(stale, pastExp())), {
    userId: TEST_ADMIN_ID,
    factors: [TOTP],
    acceptedBearer: fresh,
    refresh: { accessToken: fresh },
  });
  assert.deepEqual(kind, { kind: 'aal1-ben', verifiedTotp: true });
});

test('auth: a refresh to aal2 with a verified factor is ok', async () => {
  const stale = jwtWithClaim({ aal: 'aal1', exp: pastExp() });
  const fresh = jwtWithClaim({ aal: 'aal2', exp: futureExp() });
  const kind = await classify(cookieHeader(sessionCookieValue(stale, pastExp())), {
    userId: TEST_ADMIN_ID,
    factors: [TOTP],
    acceptedBearer: fresh,
    refresh: { accessToken: fresh },
  });
  assert.deepEqual(kind, { kind: 'ok' });
});

test('auth: a thrown Auth fetch is error', async () => {
  const { cookie } = live('aal2');
  assert.deepEqual(await classify(cookie, { userId: TEST_ADMIN_ID, throwNetwork: true }), { kind: 'error' });
});

test('auth: a timed-out Auth fetch is error', async () => {
  const { cookie } = live('aal2');
  const headers = new Headers();
  headers.set('cookie', cookie);
  const auth = createRequestAuth({
    url: MOCK_AUTH_URL,
    anonKey: TEST_ANON_KEY,
    adminUserId: TEST_ADMIN_ID,
    request: new Request('http://localhost/admin', { headers }),
    timeoutMs: 40,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('slow')), 5_000);
        const abort = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      }),
  });
  assert.deepEqual(await auth.classify(), { kind: 'error' });
});

test('auth: signOut clears sb-* cookies, including chunks', async () => {
  const token = jwtWithClaim({ aal: 'aal1', exp: futureExp() });
  const value = sessionCookieValue(token, futureExp());
  const mid = Math.floor(value.length / 2);
  const cookie = `${MOCK_COOKIE_NAME}.0=${value.slice(0, mid)}; ${MOCK_COOKIE_NAME}.1=${value.slice(mid)}`;
  const auth = open(cookie, {
    userId: '99999999-9999-4999-8999-999999999999',
    acceptedBearer: token,
  });
  assert.deepEqual(await auth.classify(), { kind: 'other-user' });
  await auth.signOut();
  const names = auth.setCookies().map((header) => header.slice(0, header.indexOf('=')));
  assert.ok(names.includes(`${MOCK_COOKIE_NAME}.0`), 'chunk 0 cleared');
  assert.ok(names.includes(`${MOCK_COOKIE_NAME}.1`), 'chunk 1 cleared');
  for (const header of auth.setCookies()) {
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Path=\//);
    assert.doesNotMatch(header, /SameSite=Lax/i);
  }
});
