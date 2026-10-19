import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/lib/log.ts';
import { deniedAuth, runRequest, testEnv, basicAuth, TEST_SECRET, TEST_PASSWORD } from './helpers.ts';

test('log: emits a single JSON line with allowlisted fields only', () => {
  const lines: string[] = [];
  log(
    { level: 'info', route: 'GET /[p]', status: 200, duration_ms: 3.2, action: 'x', game_id: 'g', lock: 1, error: 'e' },
    (l) => lines.push(l),
  );
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'action', 'duration_ms', 'error', 'game_id', 'level', 'lock', 'route', 'status', 'time',
  ].sort());
});

test('log: never emits the raw path, Authorization, cookies, IPs or emails through the boundary', async () => {
  const secret = TEST_SECRET;
  const markerIp = '203.0.113.77';
  const email = 'ben@example.com';
  const env = testEnv();

  const cases = [
    new Request(`http://localhost/${secret}/`, { headers: { authorization: basicAuth('boss', 'wrong') } }),
    new Request(`http://localhost/${secret}/`, {
      method: 'POST',
      headers: {
        authorization: basicAuth('boss', TEST_PASSWORD),
        cookie: `__Host-mga_csrf=abc123secret`,
        'x-forwarded-for': markerIp,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=bad&email=${encodeURIComponent(email)}`,
    }),
    new Request(`http://localhost/not-${secret}`),
  ];
  for (const req of cases) {
    const { logs } = await runRequest(req, env);
    for (const fields of logs) {
      const line = JSON.stringify(fields);
      assert.doesNotMatch(line, new RegExp(secret.replace(/[-_]/g, '.')), `log leaked path secret: ${line}`);
      assert.doesNotMatch(line, /Basic |authorization|cookie|abc123secret/i, `log leaked header/cookie: ${line}`);
      assert.doesNotMatch(line, /203\.0\.113/, 'log leaked IP');
      assert.doesNotMatch(line, /@/, 'log leaked email');
      assert.doesNotMatch(line, /wrong|test-password/, 'log leaked password');
    }
  }
});

test('log: a lock 3 failure does not emit email, token, user id, factor id, code or the raw path', async () => {
  const email = 'lock3-ben@example.com';
  const token = 'tok-marker-9f3c';
  const userId = '11111111-2222-4333-8444-555555555555';
  const factorId = 'factor-marker-9f3c';
  const code = 'totp-marker-9f3c';
  const cookie = `sb-test=${token}; factor=${factorId}; code=${code}; email=${email}`;
  const cases = [
    {
      async classify() {
        throw new Error(`${email} ${token} ${userId} ${factorId} ${code} ${TEST_SECRET}`);
      },
    },
    {
      async classify() {
        return { kind: 'none' as const };
      },
    },
  ];
  for (const impl of cases) {
    const { logs } = await runRequest(
      new Request(`http://localhost/${TEST_SECRET}`, {
        headers: { authorization: basicAuth('boss', TEST_PASSWORD), cookie },
      }),
      testEnv(),
      {
        auth: () => ({
          ...deniedAuth,
          classify: impl.classify,
          async signOut() {},
          setCookies: () => [],
        }),
      },
    );
    const line = JSON.stringify(logs);
    assert.equal(line.includes(email), false, 'log leaked email');
    assert.equal(line.includes(token), false, 'log leaked token');
    assert.equal(line.includes(userId), false, 'log leaked user id');
    assert.equal(line.includes(factorId), false, 'log leaked factor id');
    assert.equal(line.includes(code), false, 'log leaked code');
    assert.equal(line.includes(TEST_SECRET), false, 'log leaked path');
    assert.equal(logs[0]?.lock, 3);
  }
});
