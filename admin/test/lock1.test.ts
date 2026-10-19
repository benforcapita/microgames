import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSecurityHeaders, runRequest, testEnv, basicAuth, TEST_SECRET, TEST_PASSWORD } from './helpers.ts';

const ENV = testEnv();

test('lock 1: every path outside the secret prefix returns the same plain 404', async () => {
  const paths = [
    '/',
    '/random',
    '/admin',
    '/wp-admin',
    '/login',
    '/x/' + TEST_SECRET, // prefix as a later segment
    '/' + TEST_SECRET.slice(0, 20), // short prefix
    '/' + TEST_SECRET + 'extra', // longer than the secret
    '//' + TEST_SECRET,
    '/' + TEST_SECRET.toUpperCase(),
    '/robots.txt/', // trailing slash is not the exception
  ];
  const bodies = new Set<string>();
  for (const path of paths) {
    const { response } = await runRequest(new Request('http://localhost' + path), ENV);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.headers.get('www-authenticate'), null, path);
    assert.equal(response.headers.get('x-powered-by'), null, path);
    assert.equal(response.headers.get('set-cookie'), null, path);
    bodies.add(await response.text());
  }
  assert.deepEqual([...bodies], ['Not found']);
});

test('lock 1: methods other than GET/POST get the same plain 404', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const { response } = await runRequest(
      new Request(`http://localhost/${TEST_SECRET}`, { method }),
      ENV,
    );
    assert.equal(response.status, 404, method);
    assert.equal(await response.text(), 'Not found');
    assert.equal(response.headers.get('www-authenticate'), null, method);
  }
  // ...including on /robots.txt itself
  const { response } = await runRequest(new Request('http://localhost/robots.txt', { method: 'POST' }), ENV);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});

test('lock 1: 404 body is plain text with no Astro markup', async () => {
  const { response } = await runRequest(new Request('http://localhost/definitely-not-here'), ENV);
  const body = await response.text();
  assert.equal(body, 'Not found');
  assert.doesNotMatch(body, /</); // no markup at all
});

test('robots.txt: GET disallows everything', async () => {
  const { response } = await runRequest(new Request('http://localhost/robots.txt'), ENV);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'User-agent: *\nDisallow: /\n');
});

test('middleware: unmatched paths under the secret prefix still get the plain 404', async () => {
  const authed = { headers: { authorization: basicAuth('boss', TEST_PASSWORD) } };
  for (const path of [`/${TEST_SECRET}/nope`, `/${TEST_SECRET}/a/b/c`]) {
    const { response } = await runRequest(new Request('http://localhost' + path, authed), ENV);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'Not found');
    assert.equal(response.headers.get('content-type'), 'text/plain');
  }
});

test('headers: every response carries the full §3.5 header set', async () => {
  const authed = { headers: { authorization: basicAuth('boss', TEST_PASSWORD) } };
  const responses: Response[] = [];
  // 404
  responses.push((await runRequest(new Request('http://localhost/'), ENV)).response);
  // 200 robots
  responses.push((await runRequest(new Request('http://localhost/robots.txt'), ENV)).response);
  // 401
  responses.push((await runRequest(new Request(`http://localhost/${TEST_SECRET}`), ENV)).response);
  // 200 page
  responses.push((await runRequest(new Request(`http://localhost/${TEST_SECRET}`, authed), ENV)).response);
  // 403 CSRF
  responses.push(
    (
      await runRequest(
        new Request(`http://localhost/${TEST_SECRET}`, { method: 'POST', headers: authed.headers }),
        ENV,
      )
    ).response,
  );
  // 503 bad config
  responses.push(
    (await runRequest(new Request('http://localhost/'), testEnv({ ADMIN_USER: undefined }))).response,
  );
  for (const res of responses) assertSecurityHeaders(res);
});
