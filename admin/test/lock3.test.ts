import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestAuth, serializeStrictCookie, type AuthKind, type RequestAuth } from '../src/lib/auth-supabase.ts';
import type { Deps } from '../src/middleware.ts';
import {
  assertSecurityHeaders,
  basicAuth,
  deniedAuth,
  runRequest,
  TEST_PASSWORD,
  TEST_SECRET,
  testEnv,
} from './helpers.ts';
import { assertLoopbackUrl } from './helpers/loopback.ts';
import { assertStrictSetCookie } from './helpers/set-cookie.ts';

const ENV = testEnv();
const AUTH = { authorization: basicAuth('boss', TEST_PASSWORD) };
const PAGE = `http://localhost/${TEST_SECRET}`;

function session(classify: RequestAuth['classify'], signOut?: () => Promise<void>, cookies: string[] = []): RequestAuth {
  return {
    classify,
    signOut: signOut ?? (async () => {}),
    setCookies: () => cookies,
    ...deniedAuth,
  };
}

function stub(kind: AuthKind): NonNullable<Deps['auth']> {
  return () => session(async () => kind);
}

async function shape(response: Response) {
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== 'date')
    .sort(([a], [b]) => a.localeCompare(b));
  return { status: response.status, body: await response.text(), headers };
}

test('lock 3: no session is byte-identical to lock 1', async () => {
  const lock1 = await runRequest(new Request('http://localhost/nope'), ENV);
  const lock3 = await runRequest(new Request(PAGE, { headers: AUTH }), ENV, { auth: stub({ kind: 'none' }) });
  assert.deepEqual(await shape(lock3.response), await shape(lock1.response));
  assert.equal(lock3.logs[0]?.lock, 3);
  assert.equal(lock3.logs[0]?.error, undefined);
});

test('lock 3: tampered and foreign-signed stubs are the same plain 404', async () => {
  const lock1 = await runRequest(new Request('http://localhost/nope'), ENV);
  const expected = await shape(lock1.response);
  for (const label of ['tampered', 'foreign-signed'] as const) {
    const { response, logs } = await runRequest(new Request(PAGE, { headers: AUTH }), ENV, {
      auth: stub({ kind: 'error' }),
    });
    assert.deepEqual(await shape(response), expected, label);
    assert.equal(logs[0]?.lock, 3, label);
    assert.equal(logs[0]?.error, 'auth_error', label);
    assert.equal(response.status, 404, label);
  }
});

test('lock 3: a thrown auth check is 404, not 500', async () => {
  const { response, logs } = await runRequest(new Request(PAGE, { headers: AUTH }), ENV, {
    auth: () =>
      session(async () => {
        throw new Error('token=sekret email=a@b.c');
      }),
  });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assert.equal(logs[0]?.error, 'auth_error');
  assert.equal(logs[0]?.level, 'error');
  assert.equal(logs[0]?.lock, 3);
  const line = JSON.stringify(logs);
  assert.equal(line.includes('sekret'), false);
  assert.equal(line.includes('a@b.c'), false);
});

test('lock 3: a timeout is 404, not 503', async () => {
  const { response, logs } = await runRequest(new Request(PAGE, { headers: AUTH }), ENV, {
    auth: () =>
      session(async () => {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        throw err;
      }),
  });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assert.equal(logs[0]?.error, 'auth_error');
  assert.notEqual(response.status, 503);
  assert.notEqual(response.status, 500);
});

test('lock 3: Ben at aal1 is 404 on a protected page, with or without a factor', async () => {
  for (const verifiedTotp of [false, true]) {
    const { response, logs } = await runRequest(new Request(PAGE, { headers: AUTH }), ENV, {
      auth: stub({ kind: 'aal1-ben', verifiedTotp }),
    });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
    assert.equal(logs[0]?.lock, 3);
    assert.equal(logs[0]?.error, undefined);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('lock 3: another user is 404 and the response carries sb-* deletions', async () => {
  const { response } = await runRequest(new Request(PAGE, { headers: AUTH }), ENV, {
    auth: () => {
      const cookies: string[] = [];
      return session(
        async () => ({ kind: 'other-user' }),
        async () => {
          cookies.push(serializeStrictCookie('sb-test-auth-token', '', { maxAge: 0 }));
          cookies.push(serializeStrictCookie('sb-test-auth-token.0', '', { maxAge: 0 }));
        },
        cookies,
      );
    },
  });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  const setCookies = response.headers.getSetCookie();
  assert.ok(setCookies.length >= 2);
  const names = setCookies.map((header) => assertStrictSetCookie(header).name);
  assert.ok(names.includes('sb-test-auth-token'));
  assert.ok(names.includes('sb-test-auth-token.0'));
  for (const header of setCookies) {
    const cookie = assertStrictSetCookie(header);
    assert.equal(cookie.value, '');
    assert.equal(cookie.attrs.get('max-age'), '0');
  }
});

test('lock 3: Ben at aal2 opens the placeholder', async () => {
  const { response, logs } = await runRequest(new Request(PAGE, { headers: AUTH }), ENV, {
    auth: stub({ kind: 'ok' }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Meshgrounds/);
  assert.equal(logs[0]?.lock, undefined);
  assertSecurityHeaders(response);
});

test('lock 3: auth routes and the stylesheet skip the session check', async () => {
  let calls = 0;
  const auth: NonNullable<Deps['auth']> = () =>
    session(async () => {
      calls += 1;
      return { kind: 'none' };
    });
  const css = await runRequest(new Request(`${PAGE}/admin.css`, { headers: AUTH }), ENV, { auth });
  assert.equal(css.response.status, 200);
  assert.equal(calls, 0);
  for (const suffix of ['/auth/signin', '/auth/signout']) {
    const { response, logs } = await runRequest(new Request(PAGE + suffix, { headers: AUTH }), ENV, { auth });
    assert.equal(response.status, 200, suffix);
    assert.equal(logs[0]?.lock, undefined, suffix);
  }
  for (const suffix of ['/auth/mfa', '/auth/mfa/enroll']) {
    const { response, logs } = await runRequest(new Request(PAGE + suffix, { headers: AUTH }), ENV, { auth });
    assert.equal(response.status, 303, suffix);
    assert.equal(response.headers.get('location'), `/${TEST_SECRET}/auth/signin`, suffix);
    assert.equal(logs[0]?.lock, undefined, suffix);
  }
  assert.equal(calls, 2);
  const nested = await runRequest(new Request(`${PAGE}/auth/signin/extra`, { headers: AUTH }), ENV, { auth });
  assert.equal(nested.response.status, 404);
  assert.equal(nested.logs[0]?.lock, 3);
  assert.equal(calls, 3);
  const trailed = await runRequest(new Request(`${PAGE}/auth/mfa/`, { headers: AUTH }), ENV, { auth });
  assert.equal(trailed.logs[0]?.lock, 3);
});

test('lock 3: exemptions still require locks 1 and 2', async () => {
  const { response } = await runRequest(new Request(`${PAGE}/auth/signin`), ENV, {
    auth: stub({ kind: 'ok' }),
  });
  assert.equal(response.status, 401);
});

test('lock 3: a POST with no session is 404, not a CSRF 403', async () => {
  const { response } = await runRequest(
    new Request(PAGE, { method: 'POST', headers: AUTH, body: 'csrf=nope' }),
    ENV,
    { auth: stub({ kind: 'none' }) },
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});

test('lock 3: a 404 still carries the §3.5 headers', async () => {
  const { response } = await runRequest(new Request(PAGE, { headers: AUTH }), ENV, {
    auth: stub({ kind: 'none' }),
  });
  assertSecurityHeaders(response);
});

test('lock 3: an unreachable Auth server is 404, not 500', async () => {
  const token = 'header.payload.sig';
  const { response, logs } = await runRequest(
    new Request(PAGE, {
      headers: {
        ...AUTH,
        cookie: `sb-127-auth-token=base64-${Buffer.from(
          JSON.stringify({
            access_token: token,
            refresh_token: 'refresh-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).toString('base64url')}`,
      },
    }),
    ENV,
    {
      auth: (request, config) =>
        createRequestAuth({
          url: 'https://127.0.0.1:1',
          anonKey: config.supabaseAnonKey,
          adminUserId: config.adminUserId,
          request,
          timeoutMs: 500,
        }),
    },
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assert.equal(logs[0]?.error, 'auth_error');
  assert.equal(logs[0]?.lock, 3);
});

test('loopback helper refuses a non-loopback URL', () => {
  assert.throws(() => assertLoopbackUrl('https://hosted.example'), /non-loopback/);
  assert.throws(() => assertLoopbackUrl('postgresql://user@db.example/postgres'), /non-loopback/);
  assert.doesNotThrow(() => assertLoopbackUrl('http://127.0.0.1:54321'));
  assert.doesNotThrow(() => assertLoopbackUrl('http://localhost:54321'));
  assert.doesNotThrow(() => assertLoopbackUrl('postgresql://meshgrounds_admin@127.0.0.1:54322/postgres'));
});
