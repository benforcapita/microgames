import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csrfField, mintCookieValue, CSRF_COOKIE } from '../src/lib/csrf.ts';
import {
  runRequest,
  testEnv,
  basicAuth,
  assertSecurityHeaders,
  TEST_SECRET,
  TEST_PASSWORD,
  TEST_ORIGIN,
} from './helpers.ts';

const ENV = testEnv();
const AUTH = { authorization: basicAuth('boss', TEST_PASSWORD) };

// CTO decision: Astro's built-in checkOrigin must be off — it runs before our
// middleware and answers non-GET requests with an unheadered, fingerprinting
// 403. Our own checks (below) replace it.
test('astro.config: security.checkOrigin is disabled', async () => {
  const { default: config } = await import('../astro.config.mjs');
  assert.equal(config?.security?.checkOrigin, false);
});

function authedPost(headers: Record<string, string> = {}, body = '') {
  return new Request(`http://localhost/${TEST_SECRET}`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

// Every non-GET request that fails the Origin+CSRF check gets OUR plain 403
// with the §3.5 headers — never Astro's own "Cross-site … forbidden" page,
// which carries no security headers and fingerprints the framework.
test('origin: cross-site, Origin-less and bad-CSRF POSTs all get our plain 403', async () => {
  const cookie = mintCookieValue();
  const field = csrfField(TEST_SECRET, cookie);
  const cases: [string, Request][] = [
    [
      'cross-site POST',
      authedPost(
        { origin: 'https://evil.example', cookie: `${CSRF_COOKIE}=${cookie}` },
        `csrf=${field}`,
      ),
    ],
    ['Origin-less POST', authedPost({ cookie: `${CSRF_COOKIE}=${cookie}` }, `csrf=${field}`)],
    [
      'bad CSRF token',
      authedPost(
        { origin: TEST_ORIGIN, cookie: `${CSRF_COOKIE}=${cookie}` },
        `csrf=${field.slice(0, -1)}x`,
      ),
    ],
  ];
  for (const [name, request] of cases) {
    const { response } = await runRequest(request, ENV);
    assert.equal(response.status, 403, name);
    assert.equal(response.headers.get('content-type'), 'text/plain', name);
    const body = await response.text();
    assert.equal(body, 'Forbidden', name);
    for (const fingerprint of ['Cross-site', 'forbidden', 'astro', '<html']) {
      assert.ok(!body.includes(fingerprint), `${name} body leaks '${fingerprint}'`);
    }
    assertSecurityHeaders(response);
  }
});

// Lock order: methods other than GET/POST never reach the Origin+CSRF check —
// they get the uniform plain 404 on secret and non-secret paths alike.
test('origin: PUT and DELETE without Origin get the uniform plain 404', async () => {
  for (const method of ['PUT', 'DELETE']) {
    for (const path of [`/${TEST_SECRET}`, '/wp-admin']) {
      const { response } = await runRequest(
        new Request(`http://localhost${path}`, { method }),
        ENV,
      );
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(await response.text(), 'Not found');
      assertSecurityHeaders(response);
    }
  }
});
