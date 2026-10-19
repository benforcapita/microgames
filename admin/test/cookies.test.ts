import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestAuth, serializeStrictCookie } from '../src/lib/auth-supabase.ts';
import { basicAuth, runRequest, TEST_ADMIN_ID, TEST_ANON_KEY, TEST_PASSWORD, TEST_SECRET, testEnv } from './helpers.ts';
import {
  MOCK_AUTH_URL,
  MOCK_COOKIE_NAME,
  cookieHeader,
  futureExp,
  jwtWithClaim,
  pastExp,
  scriptedFetch,
  sessionCookieValue,
} from './helpers/mock-auth.ts';
import { assertStrictSetCookie, parseSetCookie } from './helpers/set-cookie.ts';

const ENV = testEnv();
const AUTH = { authorization: basicAuth('boss', TEST_PASSWORD) };

test('cookies: the CSRF cookie is HttpOnly, Secure, Strict, Path=/', async () => {
  const { response } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}`, { headers: AUTH }),
    ENV,
  );
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  const cookie = assertStrictSetCookie(setCookies[0]);
  assert.equal(cookie.name, '__Host-mga_csrf');
});

test('cookies: a value that could inject attributes is cleared instead', () => {
  const header = serializeStrictCookie('sb-x', 'v; SameSite=Lax', { maxAge: 400 });
  const cookie = assertStrictSetCookie(header);
  assert.equal(cookie.value, '');
  assert.equal(cookie.attrs.get('max-age'), '0');
  assert.equal(header.includes('SameSite=Lax'), false);
});

test('cookies: a refresh writes chunked sb-* cookies, all strict', async () => {
  const stale = jwtWithClaim({ aal: 'aal1', exp: pastExp() });
  const fresh = jwtWithClaim({ aal: 'aal2', exp: futureExp() });
  const auth = createRequestAuth({
    url: MOCK_AUTH_URL,
    anonKey: TEST_ANON_KEY,
    adminUserId: TEST_ADMIN_ID,
    request: new Request('http://localhost/admin', {
      headers: { cookie: cookieHeader(sessionCookieValue(stale, pastExp())) },
    }),
    fetch: scriptedFetch({
      userId: TEST_ADMIN_ID,
      factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
      acceptedBearer: fresh,
      refresh: { accessToken: fresh, refreshToken: 'r'.repeat(8000) },
    }),
  });
  assert.deepEqual(await auth.classify(), { kind: 'ok' });
  const setCookies = auth.setCookies();
  assert.ok(setCookies.length > 1, 'expected a chunked session cookie');
  const names = setCookies.map((header) => parseSetCookie(header).name);
  assert.ok(names.some((name) => name.startsWith('sb-') && /\.\d+$/.test(name)), names.join(','));
  for (const header of setCookies) {
    assertStrictSetCookie(header);
    assert.equal(header.includes('SameSite=Lax'), false);
    assert.equal(header.includes('HttpOnly'), true);
  }
});

test('cookies: middleware puts strict deletions on the other-user 404', async () => {
  const token = jwtWithClaim({ aal: 'aal1', exp: futureExp() });
  const value = sessionCookieValue(token, futureExp());
  const mid = Math.floor(value.length / 2);
  const cookie = `${MOCK_COOKIE_NAME}.0=${value.slice(0, mid)}; ${MOCK_COOKIE_NAME}.1=${value.slice(mid)}`;
  const { response } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}`, { headers: { ...AUTH, cookie } }),
    ENV,
    {
      auth: (request) =>
        createRequestAuth({
          url: MOCK_AUTH_URL,
          anonKey: TEST_ANON_KEY,
          adminUserId: TEST_ADMIN_ID,
          request,
          fetch: scriptedFetch({
            userId: '99999999-9999-4999-8999-999999999999',
            acceptedBearer: token,
          }),
        }),
    },
  );
  assert.equal(response.status, 404);
  const setCookies = response.headers.getSetCookie();
  assert.ok(setCookies.length >= 2);
  const deletions = setCookies.map((header) => assertStrictSetCookie(header));
  assert.ok(deletions.some((cookie) => cookie.name === `${MOCK_COOKIE_NAME}.0` && cookie.attrs.get('max-age') === '0'));
  assert.ok(deletions.some((cookie) => cookie.name === `${MOCK_COOKIE_NAME}.1` && cookie.attrs.get('max-age') === '0'));
});
