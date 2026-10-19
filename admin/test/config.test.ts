import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/lib/config.ts';
import { testEnv, runRequest, TEST_SECRET, TEST_ADMIN_ID, TEST_SUPABASE_URL } from './helpers.ts';

const VALID = testEnv();

test('config: valid env passes validation', () => {
  const res = loadConfig(VALID);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.config.pathSecret, TEST_SECRET);
    assert.equal(res.config.user, 'boss');
    assert.equal(res.config.adminUserId, TEST_ADMIN_ID);
    assert.equal(res.config.supabaseUrl, TEST_SUPABASE_URL);
  }
});

test('config: ADMIN_PATH_SECRET shorter than 32 chars is rejected', () => {
  const res = loadConfig(testEnv({ ADMIN_PATH_SECRET: 'a'.repeat(31) }));
  assert.deepEqual(res, { ok: false, key: 'ADMIN_PATH_SECRET' });
});

test('config: ADMIN_PATH_SECRET with characters outside [A-Za-z0-9_-] is rejected', () => {
  for (const bad of ['a'.repeat(31) + '!', 'a'.repeat(31) + '.', 'a'.repeat(31) + ' ']) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_PATH_SECRET: bad })), {
      ok: false,
      key: 'ADMIN_PATH_SECRET',
    });
  }
});

test('config: ADMIN_PATH_SECRET at 32 chars with full alphabet is accepted', () => {
  const res = loadConfig(testEnv({ ADMIN_PATH_SECRET: 'Az09_-' + 'x'.repeat(26) }));
  assert.equal(res.ok, true);
});

test('config: missing ADMIN_USER is rejected', () => {
  for (const bad of [undefined, '']) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_USER: bad })), {
      ok: false,
      key: 'ADMIN_USER',
    });
  }
});

test('config: ADMIN_PASSWORD_HASH must be $argon2id$ or $2b$', () => {
  for (const bad of [
    undefined,
    '',
    'plaintext-password',
    '$argon2i$v=19$m=19456,t=2,p=1$aaaa',
    '$2a$10$abcdefghijklmnopqrstuuVDe', // bcrypt variant prefix: not accepted per CTO rule
    '$2y$10$abcdefghijklmnopqrstuuVDe',
    'argon2id$v=19$m=19456,t=2,p=1$aaaa',
  ]) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_PASSWORD_HASH: bad })), {
      ok: false,
      key: 'ADMIN_PASSWORD_HASH',
    });
  }
});

test('config: bcrypt $2b$ ADMIN_PASSWORD_HASH is accepted', () => {
  const res = loadConfig(testEnv({ ADMIN_PASSWORD_HASH: '$2b$10$abcdefghijklmnopqrstuuVDeWQi5FJq' }));
  assert.equal(res.ok, true);
});

test('config: ADMIN_DATABASE_URL must be postgres:// or postgresql://', () => {
  for (const bad of [undefined, '', 'http://meshgrounds_admin@h/db', 'mysql://meshgrounds_admin@h/db', 'not a url']) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_DATABASE_URL: bad })), {
      ok: false,
      key: 'ADMIN_DATABASE_URL',
    });
  }
  assert.equal(loadConfig(testEnv({ ADMIN_DATABASE_URL: 'postgresql://meshgrounds_admin@h/db' })).ok, true);
});

test('config: ADMIN_DATABASE_URL user must be meshgrounds_admin or meshgrounds_admin.<ref>', () => {
  // CTO decision: exactly `meshgrounds_admin`, or `meshgrounds_admin.<ref>`
  // (the Supabase pooler form) where ref is ^[a-z0-9]{20}$. Fail closed on
  // anything else.
  for (const bad of [
    'postgres://postgres@h/db',
    'postgres://postgres.abcdefghij1234567890@h/db', // pooler user, wrong role
    'postgres://service_role@h/db',
    'postgres://meshgrounds_admin.abcdefghij123456789@h/db', // ref 19 chars
    'postgres://meshgrounds_admin.abcdefghij12345678901@h/db', // ref 21 chars
    'postgres://meshgrounds_admin.Abcdefghij1234567890@h/db', // ref uppercase
    'postgres://meshgrounds_admin.abcdefghij-234567890@h/db', // ref with a dash
    'postgres://meshgrounds_admin.@h/db', // empty ref
    'postgres://meshgrounds_adminx@h/db',
    'postgres://admin@h/db',
    'postgres://@h/db',
  ]) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_DATABASE_URL: bad })), {
      ok: false,
      key: 'ADMIN_DATABASE_URL',
    });
  }
  assert.equal(
    loadConfig(testEnv({ ADMIN_DATABASE_URL: 'postgres://meshgrounds_admin@h/db' })).ok,
    true,
  );
  assert.equal(
    loadConfig(
      testEnv({ ADMIN_DATABASE_URL: 'postgres://meshgrounds_admin.abcdefghij1234567890@h/db' }),
    ).ok,
    true,
  );
});

test('config: ADMIN_ORIGIN must be an exact https origin off the public site', () => {
  // CTO decision: https only; an exact origin — no path, no trailing slash,
  // no query/fragment, no userinfo — and never meshground.app, a subdomain of
  // it, or meshgrounds.vercel.app.
  for (const bad of [
    undefined,
    '',
    'http://mga-admin.example', // https only
    'https://mga-admin.example/', // no trailing slash
    'https://mga-admin.example/admin', // no path
    'https://mga-admin.example/?x=1', // no query
    'https://mga-admin.example/#frag', // no fragment
    'https://u:p@mga-admin.example', // no userinfo
    'https://meshground.app', // never the public site
    'https://sub.meshground.app', // nor a subdomain of it
    'https://meshgrounds.vercel.app',
    'not a url',
  ]) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_ORIGIN: bad })), {
      ok: false,
      key: 'ADMIN_ORIGIN',
    });
  }
  assert.equal(loadConfig(testEnv({ ADMIN_ORIGIN: 'https://mga-admin.example' })).ok, true);
});

test('boundary: bad ADMIN_ORIGIN makes every request a plain 503; the log names ADMIN_ORIGIN only', async () => {
  const { response, logs } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}`),
    testEnv({ ADMIN_ORIGIN: 'http://mga-admin.example' }),
  );
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Service unavailable');
  const line = logs.find((l) => l.error);
  assert.ok(line, 'expected a config error log line');
  assert.match(String(line.error), /ADMIN_ORIGIN/);
  assert.doesNotMatch(String(line.error), /mga-admin\.example/);
});

test('config: failure reports the first bad key in a fixed order', () => {
  const res = loadConfig(testEnv({ ADMIN_PATH_SECRET: 'short', ADMIN_USER: '' }));
  assert.deepEqual(res, { ok: false, key: 'ADMIN_PATH_SECRET' });
});

test('config: ADMIN_USER_ID must be a UUID', () => {
  for (const bad of [undefined, '', 'not-a-uuid', '00000000-0000-0000-0000-00000000000g', '00000000000040008000000000000001']) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_USER_ID: bad })), { ok: false, key: 'ADMIN_USER_ID' });
  }
  const upper = loadConfig(testEnv({ ADMIN_USER_ID: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' }));
  assert.equal(upper.ok, true);
  if (upper.ok) assert.equal(upper.config.adminUserId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('config: ADMIN_SUPABASE_URL must be an https URL', () => {
  for (const bad of [undefined, '', 'not a url', 'http://127.0.0.1:54321', 'http://auth.example', 'ws://auth.example', 'https://']) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_SUPABASE_URL: bad })), {
      ok: false,
      key: 'ADMIN_SUPABASE_URL',
    });
  }
  assert.equal(loadConfig(testEnv({ ADMIN_SUPABASE_URL: 'https://auth.example' })).ok, true);
  assert.equal(loadConfig(testEnv({ ADMIN_SUPABASE_URL: 'https://auth.example/project' })).ok, true);
});

test('config: ADMIN_SUPABASE_ANON_KEY must be non-empty and contain no whitespace', () => {
  for (const bad of [undefined, '', ' ', 'anon key', 'anon\n', '\tanon', 'anon ']) {
    assert.deepEqual(loadConfig(testEnv({ ADMIN_SUPABASE_ANON_KEY: bad })), {
      ok: false,
      key: 'ADMIN_SUPABASE_ANON_KEY',
    });
  }
  assert.equal(loadConfig(testEnv({ ADMIN_SUPABASE_ANON_KEY: 'anon' })).ok, true);
});

test('config: a bad lock-3 key is reported after the MGA-2 keys', () => {
  assert.deepEqual(loadConfig(testEnv({ ADMIN_ORIGIN: 'http://nope', ADMIN_USER_ID: 'nope' })), {
    ok: false,
    key: 'ADMIN_ORIGIN',
  });
  assert.deepEqual(
    loadConfig(testEnv({ ADMIN_USER_ID: 'nope', ADMIN_SUPABASE_URL: 'http://nope' })),
    { ok: false, key: 'ADMIN_USER_ID' },
  );
});

test('boundary: each bad lock-3 key is a plain 503 and one log line naming the key', async () => {
  const cases: [string, Record<string, string | undefined>, string | undefined][] = [
    ['ADMIN_USER_ID', { ADMIN_USER_ID: undefined }, undefined],
    ['ADMIN_USER_ID', { ADMIN_USER_ID: 'not-a-uuid' }, 'not-a-uuid'],
    ['ADMIN_SUPABASE_URL', { ADMIN_SUPABASE_URL: 'not a url' }, 'not a url'],
    ['ADMIN_SUPABASE_URL', { ADMIN_SUPABASE_URL: 'http://127.0.0.1:54321' }, '127.0.0.1'],
    ['ADMIN_SUPABASE_ANON_KEY', { ADMIN_SUPABASE_ANON_KEY: '' }, undefined],
  ];
  for (const [key, overrides, leaked] of cases) {
    const env = testEnv(overrides);
    for (const path of ['/', '/robots.txt', `/${TEST_SECRET}`]) {
      const { response, logs } = await runRequest(new Request(`http://localhost${path}`), env);
      assert.equal(response.status, 503, `${key} ${path}`);
      assert.equal(await response.text(), 'Service unavailable');
      assert.equal(response.headers.get('content-type'), 'text/plain');
      const errors = logs.filter((line) => line.error);
      assert.equal(errors.length, 1, `${key} ${path}`);
      assert.equal(errors[0]?.error, `invalid_config:${key}`);
      if (leaked) assert.equal(JSON.stringify(logs).includes(leaked), false, `${key} ${path}`);
    }
  }
});

test('boundary: bad config makes every request a plain 503', async () => {
  const env = testEnv({ ADMIN_PATH_SECRET: 'short' });
  for (const path of ['/', '/robots.txt', `/${TEST_SECRET}`, `/${TEST_SECRET}/admin.css`]) {
    const { response, logs } = await runRequest(new Request(`http://localhost${path}`), env);
    assert.equal(response.status, 503, path);
    assert.equal(await response.text(), 'Service unavailable');
    assert.equal(response.headers.get('content-type'), 'text/plain');
    // One log line naming the key (name only, never the value).
    const line = logs.find((l) => l.error);
    assert.ok(line, 'expected a config error log line');
    assert.match(String(line.error), /ADMIN_PATH_SECRET/);
    assert.doesNotMatch(String(line.error), /short/);
  }
});
