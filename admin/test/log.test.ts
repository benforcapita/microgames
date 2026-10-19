import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/lib/log.ts';
import { runRequest, testEnv, basicAuth, TEST_SECRET, TEST_PASSWORD } from './helpers.ts';

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
