import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRequest, testEnv, basicAuth, TEST_SECRET, TEST_PASSWORD } from './helpers.ts';

const ENV = testEnv();
const AUTH = { authorization: basicAuth('boss', TEST_PASSWORD) };

test('placeholder page: GET on the secret path returns minimal HTML', async () => {
  const { response } = await runRequest(new Request(`http://localhost/${TEST_SECRET}`, { headers: AUTH }), ENV);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const body = await response.text();
  assert.match(body, /Meshgrounds/i);
  // Styled only by the SSR stylesheet route — no inline style, no scripts.
  assert.match(body, new RegExp(`<link rel="stylesheet" href="/${TEST_SECRET}/admin\\.css">`));
  assert.doesNotMatch(body, /<style|<script|style=/i);
  // Carries a CSRF form field bound to the cookie that was just set.
  const cookie = response.headers.get('set-cookie')?.match(/__Host-mga_csrf=([^;]+)/)?.[1];
  assert.ok(cookie);
  assert.match(body, /name="csrf" value="[A-Za-z0-9_-]{43}"/);
});

test('admin.css: SSR stylesheet under the prefix', async () => {
  const { response } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}/admin.css`, { headers: AUTH }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/css/);
  assert.match(await response.text(), /body/);
});

test('admin.css: still requires locks 1-2 (unauthenticated → 401)', async () => {
  const { response } = await runRequest(new Request(`http://localhost/${TEST_SECRET}/admin.css`), ENV);
  assert.equal(response.status, 401);
});
