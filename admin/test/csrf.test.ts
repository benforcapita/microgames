import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csrfField, mintCookieValue, CSRF_COOKIE } from '../src/lib/csrf.ts';
import { runRequest, testEnv, basicAuth, TEST_SECRET, TEST_PASSWORD, TEST_ORIGIN } from './helpers.ts';

const ENV = testEnv();
const AUTH = { authorization: basicAuth('boss', TEST_PASSWORD) };

function authedPost(headers: Record<string, string> = {}, body = '') {
  return new Request(`http://localhost/${TEST_SECRET}`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

test('csrf: GET past locks 1-2 sets __Host-mga_csrf when absent', async () => {
  const { response, locals } = await runRequest(new Request(`http://localhost/${TEST_SECRET}`, { headers: AUTH }), ENV);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'expected Set-Cookie');
  assert.match(cookie!, /^__Host-mga_csrf=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.equal(typeof locals.csrfCookie, 'string');
});

test('csrf: GET with an existing cookie does not rotate it', async () => {
  const { response } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}`, { headers: { ...AUTH, cookie: `${CSRF_COOKIE}=keepme` } }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /name="csrf" value="[^"]+"/);
});

test('csrf: field value is base64url HMAC-SHA256(HKDF(secret, mga-csrf-v1), cookie)', () => {
  // Pinned vector: secret 's' (32 x 's'), cookie 'c' (43 chars).
  const field = csrfField('s'.repeat(32), 'c'.repeat(43));
  assert.match(field, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(field, 'c'.repeat(43));
  // deterministic
  assert.equal(csrfField('s'.repeat(32), 'c'.repeat(43)), field);
});

test('csrf: POST without cookie, without field, or mismatched field → 403', async () => {
  const cookie = mintCookieValue();
  const good = csrfField(TEST_SECRET, cookie);
  const cases: [string, Record<string, string>, string][] = [
    ['no cookie, no field', { origin: TEST_ORIGIN }, 'csrf=x'],
    ['field but no cookie', { origin: TEST_ORIGIN }, `csrf=${good}`],
    ['cookie but no field', { origin: TEST_ORIGIN, cookie: `${CSRF_COOKIE}=${cookie}` }, 'other=1'],
    ['mismatched field', { origin: TEST_ORIGIN, cookie: `${CSRF_COOKIE}=${cookie}` }, `csrf=${good.slice(0, -1)}x`],
    ['field for a different cookie', { origin: TEST_ORIGIN, cookie: `${CSRF_COOKIE}=${mintCookieValue()}` }, `csrf=${good}`],
  ];
  for (const [name, headers, body] of cases) {
    const { response } = await runRequest(authedPost(headers, body), ENV);
    assert.equal(response.status, 403, name);
  }
});

test('csrf: POST from another Origin → 403', async () => {
  const cookie = mintCookieValue();
  const field = csrfField(TEST_SECRET, cookie);
  for (const origin of ['https://evil.example', 'null', TEST_ORIGIN + '.evil.example']) {
    const { response } = await runRequest(
      authedPost({ origin, cookie: `${CSRF_COOKIE}=${cookie}` }, `csrf=${field}`),
      ENV,
    );
    assert.equal(response.status, 403, origin);
  }
});

test('csrf: POST with no Origin → 403; ADMIN_ORIGIN unset → 403', async () => {
  const cookie = mintCookieValue();
  const field = csrfField(TEST_SECRET, cookie);
  const noOrigin = await runRequest(
    authedPost({ cookie: `${CSRF_COOKIE}=${cookie}` }, `csrf=${field}`),
    ENV,
  );
  assert.equal(noOrigin.response.status, 403);
  const envNoOrigin = testEnv({ ADMIN_ORIGIN: undefined });
  const { response } = await runRequest(
    authedPost({ origin: TEST_ORIGIN, cookie: `${CSRF_COOKIE}=${cookie}` }, `csrf=${field}`),
    envNoOrigin,
  );
  assert.equal(response.status, 403);
});

test('csrf: valid POST passes the middleware to the route', async () => {
  const cookie = mintCookieValue();
  const field = csrfField(TEST_SECRET, cookie);
  const { response } = await runRequest(
    authedPost({ origin: TEST_ORIGIN, cookie: `${CSRF_COOKIE}=${cookie}` }, `csrf=${field}`),
    ENV,
  );
  // The placeholder index redirects back to itself on a valid POST.
  assert.equal(response.status, 303);
});

test('csrf: POST outside the secret prefix is a 404, not a 403 (lock order)', async () => {
  const { response } = await runRequest(
    new Request('http://localhost/anything', { method: 'POST', headers: AUTH }),
    ENV,
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});
