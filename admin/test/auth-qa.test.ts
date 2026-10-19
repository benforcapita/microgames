import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestAuth, type AuthKind, type RequestAuth } from '../src/lib/auth-supabase.ts';
import type { Deps } from '../src/middleware.ts';
import { CSRF_COOKIE, CSRF_FIELD, csrfField } from '../src/lib/csrf.ts';
import {
  basicAuth,
  deniedAuth,
  runRequest,
  TEST_ANON_KEY,
  TEST_ORIGIN,
  TEST_PASSWORD,
  TEST_SECRET,
  TEST_SUPABASE_URL,
  testEnv,
} from './helpers.ts';

const ENV = testEnv();
const AUTH = { authorization: basicAuth('boss', TEST_PASSWORD) };
const PAGE = `http://localhost/${TEST_SECRET}`;
const PREFIX = `/${TEST_SECRET}`;
const FACTOR = '00000000-0000-4000-8000-0000000000aa';
const QR = 'data:image/svg+xml;utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E';
const SECRET = 'BBBBBBBBBBBBBBBB';
const OTAUTH = 'otpauth://totp/Meshgrounds:ben?secret=BBBBBBBBBBBBBBBB';

type Calls = { signIn: number; enroll: number; verify: number; verifyVerified: number; signOut: number };

function client(partial: Partial<RequestAuth> & { classify?: RequestAuth['classify'] }): {
  auth: NonNullable<Deps['auth']>;
  calls: Calls;
} {
  const calls: Calls = { signIn: 0, enroll: 0, verify: 0, verifyVerified: 0, signOut: 0 };
  const auth: NonNullable<Deps['auth']> = () => ({
    ...deniedAuth,
    async classify() {
      return { kind: 'none' };
    },
    async signOut() {
      calls.signOut += 1;
    },
    setCookies: () => [],
    async signInWithPassword() {
      calls.signIn += 1;
      return { kind: 'denied' };
    },
    async enrollTotp() {
      calls.enroll += 1;
      return { kind: 'denied', unverified: [] };
    },
    async verifyTotp() {
      calls.verify += 1;
      return { kind: 'denied' };
    },
    async verifyVerifiedTotp() {
      calls.verifyVerified += 1;
      return { kind: 'denied' };
    },
    ...partial,
  });
  return { auth, calls };
}

async function csrf() {
  const { response } = await runRequest(new Request(`${PAGE}/auth/signin`, { headers: AUTH }), ENV);
  const header = response.headers.getSetCookie().find((item) => item.startsWith(`${CSRF_COOKIE}=`));
  const cookie = header?.match(/=([^;]+)/)?.[1];
  assert.ok(cookie);
  return { cookie: cookie!, field: csrfField(TEST_SECRET, cookie!) };
}

function post(
  path: string,
  cookie: string,
  fields: Record<string, string>,
  extra: HeadersInit = {},
  includeToken = true,
) {
  const url = new URL(PAGE + path);
  const headers = new Headers({
    authorization: AUTH.authorization,
    origin: TEST_ORIGIN,
    'content-type': 'application/x-www-form-urlencoded',
    cookie: `${CSRF_COOKIE}=${cookie}`,
  });
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  const body = new URLSearchParams(fields);
  if (includeToken) body.set(CSRF_FIELD, csrfField(TEST_SECRET, cookie));
  return new Request(url, { method: 'POST', headers, body });
}

async function shape(response: Response) {
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== 'date')
    .sort(([a], [b]) => a.localeCompare(b));
  return { status: response.status, body: await response.text(), headers };
}

function assertClosed(response: Response, suffix: string) {
  assert.equal(response.status, 303);
  const location = response.headers.get('location');
  assert.equal(location, `${PREFIX}${suffix}`);
  assert.equal(location.includes('evil.example'), false);
  assert.equal(location.includes('://'), false);
}

async function csrfCases(path: string, auth: NonNullable<Deps['auth']>, calls: Calls) {
  const { cookie, field } = await csrf();
  const before = { ...calls };
  const requests = [
    post(path, cookie, { email: 'a@b.c', password: 'pw', code: '123456' }, {}, false),
    post(path, cookie, { [CSRF_FIELD]: `${field}x`, email: 'a@b.c', password: 'pw', code: '123456' }, {}, false),
    post(path, cookie, { email: 'a@b.c', password: 'pw', code: '123456' }, { origin: 'null' }),
    post(path, cookie, { email: 'a@b.c', password: 'pw', code: '123456' }, { origin: 'https://evil.example' }),
  ];
  for (const request of requests) {
    const { response } = await runRequest(request, ENV, { auth });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Forbidden');
    assert.equal(response.headers.get('location'), null);
  }
  assert.deepEqual(calls, before);
}

test('B5a: sign-out POST rejects a missing token, a bad token, Origin null, and a foreign Origin', async () => {
  const stub = client({});
  await csrfCases('/auth/signout', stub.auth, stub.calls);
});

test('B5c: challenge POST rejects a missing token, a bad token, Origin null, and a foreign Origin', async () => {
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: true };
    },
  });
  await csrfCases('/auth/mfa', stub.auth, stub.calls);
});

test('B5d: enroll POST rejects a missing token, a bad token, Origin null, and a foreign Origin', async () => {
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: false };
    },
  });
  await csrfCases('/auth/mfa/enroll', stub.auth, stub.calls);
});

test('B2a: Ben at AAL1 on /<p>/ is the lock-1 404', async () => {
  const lock1 = await shape((await runRequest(new Request('http://localhost/nope'), ENV)).response);
  const { cookie } = await csrf();
  for (const verifiedTotp of [false, true]) {
    const auth = client({
      async classify(): Promise<AuthKind> {
        return { kind: 'aal1-ben', verifiedTotp };
      },
    }).auth;
    for (const path of ['', '/']) {
      const label = path === '/' ? '/<p>/' : '/<p>';
      const get = await runRequest(new Request(path === '/' ? `${PAGE}/` : PAGE, { headers: AUTH }), ENV, { auth });
      assert.deepEqual(await shape(get.response), lock1, `GET ${label}`);
      const posted = await runRequest(post(path, cookie, {}), ENV, { auth });
      assert.deepEqual(await shape(posted.response), lock1, `POST ${label}`);
    }
  }
});

test('B2c: enroll GET and POST are the lock-1 404 once a verified factor exists', async () => {
  const lock1 = await shape((await runRequest(new Request('http://localhost/nope'), ENV)).response);
  const { cookie } = await csrf();
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: true };
    },
  });
  const get = await runRequest(new Request(`${PAGE}/auth/mfa/enroll`, { headers: AUTH }), ENV, { auth: stub.auth });
  assert.deepEqual(await shape(get.response), lock1);
  const posted = await runRequest(post('/auth/mfa/enroll', cookie, { code: '123456', factor: FACTOR }), ENV, {
    auth: stub.auth,
  });
  assert.deepEqual(await shape(posted.response), lock1);
  assert.equal(stub.calls.enroll, 0);
  assert.equal(stub.calls.verify, 0);
});

test('enroll GET and POST are the lock-1 404 with no session or at AAL2', async () => {
  const lock1 = await shape((await runRequest(new Request('http://localhost/nope'), ENV)).response);
  const { cookie } = await csrf();
  const kinds: AuthKind[] = [{ kind: 'none' }, { kind: 'ok' }];
  for (const kind of kinds) {
    const stub = client({
      async classify() {
        return kind;
      },
    });
    const get = await runRequest(new Request(`${PAGE}/auth/mfa/enroll`, { headers: AUTH }), ENV, { auth: stub.auth });
    assert.deepEqual(await shape(get.response), lock1, kind.kind);
    const posted = await runRequest(post('/auth/mfa/enroll', cookie, {}), ENV, { auth: stub.auth });
    assert.deepEqual(await shape(posted.response), lock1, kind.kind);
    assert.equal(stub.calls.enroll, 0, kind.kind);
  }
});

test('B3d: next, return, and redirect never change a redirect target', async () => {
  const { cookie } = await csrf();
  const open = {
    next: 'https://evil.example/next',
    return: 'https://evil.example/return',
    redirect: 'https://evil.example/redirect',
  };
  const ben = (verifiedTotp: boolean) =>
    client({
      async signInWithPassword() {
        return { kind: 'ben', verifiedTotp };
      },
    });
  const noFactor = await runRequest(post('/auth/signin', cookie, { email: 'a@b.c', password: 'pw', ...open }), ENV, {
    auth: ben(false).auth,
  });
  assertClosed(noFactor.response, '/auth/mfa/enroll');
  const withFactor = await runRequest(post('/auth/signin', cookie, { email: 'a@b.c', password: 'pw', ...open }), ENV, {
    auth: ben(true).auth,
  });
  assertClosed(withFactor.response, '/auth/mfa');

  const aal2 = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'ok' };
    },
  });
  const homeGet = new URL(`${PAGE}/auth/mfa`);
  for (const [key, value] of Object.entries(open)) homeGet.searchParams.set(key, value);
  const aal2Get = await runRequest(new Request(homeGet, { headers: AUTH }), ENV, { auth: aal2.auth });
  assertClosed(aal2Get.response, '');
  const aal2Post = await runRequest(post('/auth/mfa', cookie, { code: '123456', ...open }), ENV, { auth: aal2.auth });
  assertClosed(aal2Post.response, '');

  const toEnroll = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: false };
    },
  });
  const enrollGet = new URL(`${PAGE}/auth/mfa`);
  for (const [key, value] of Object.entries(open)) enrollGet.searchParams.set(key, value);
  const moved = await runRequest(new Request(enrollGet, { headers: AUTH }), ENV, { auth: toEnroll.auth });
  assertClosed(moved.response, '/auth/mfa/enroll');

  const signedOut = client({});
  const signInGet = new URL(`${PAGE}/auth/mfa`);
  for (const [key, value] of Object.entries(open)) signInGet.searchParams.set(key, value);
  const back = await runRequest(new Request(signInGet, { headers: AUTH }), ENV, { auth: signedOut.auth });
  assertClosed(back.response, '/auth/signin');

  const verified = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: true };
    },
    async verifyVerifiedTotp() {
      return { kind: 'ok' };
    },
  });
  const challenged = await runRequest(post('/auth/mfa', cookie, { code: '123456', ...open }), ENV, {
    auth: verified.auth,
  });
  assertClosed(challenged.response, '');

  const enrolled = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: false };
    },
    async verifyTotp() {
      return { kind: 'ok' };
    },
  });
  const done = await runRequest(
    post('/auth/mfa/enroll', cookie, { code: '123456', factor: FACTOR, ...open }),
    ENV,
    { auth: enrolled.auth },
  );
  assertClosed(done.response, '');

  const leaving = client({});
  const out = await runRequest(post('/auth/signout', cookie, open), ENV, { auth: leaving.auth });
  assertClosed(out.response, '/auth/signin');

  const home = await runRequest(post('', cookie, open), ENV, {
    auth: client({
      async classify(): Promise<AuthKind> {
        return { kind: 'ok' };
      },
    }).auth,
  });
  assertClosed(home.response, '');
});

test('B7a: an enroll response does not put the secret, QR, or otpauth URI in the logs', async () => {
  const { cookie } = await csrf();
  const lines: string[] = [];
  const write = console.log;
  const info = console.info;
  const warn = console.warn;
  const error = console.error;
  const debug = console.debug;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.info = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.debug = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    const stub = client({
      async classify(): Promise<AuthKind> {
        return { kind: 'aal1-ben', verifiedTotp: false };
      },
      async enrollTotp() {
        stub.calls.enroll += 1;
        return { kind: 'ok', factorId: FACTOR, qrDataUri: QR, secret: SECRET, unverified: [] };
      },
    });
    const { response, logs } = await runRequest(post('/auth/mfa/enroll', cookie, {}), ENV, { auth: stub.auth });
    assert.equal(response.status, 200);
    const logged = `${JSON.stringify(logs)}\n${lines.join('\n')}`;
    assert.equal(logged.includes(SECRET), false);
    assert.equal(logged.includes(QR), false);
    assert.equal(logged.includes('otpauth:'), false);
    assert.equal(logged.includes(OTAUTH), false);
  } finally {
    console.log = write;
    console.info = info;
    console.warn = warn;
    console.error = error;
    console.debug = debug;
  }
});

test('B1b/B1c: sign-in failures are byte-identical', async () => {
  const { cookie } = await csrf();
  const outcomes = ['bad-password', 'down', '500', '429', 'unconfirmed'] as const;
  const shapes = [];
  for (const outcome of outcomes) {
    const { response } = await runRequest(
      post('/auth/signin', cookie, { email: 'ben-test@example.invalid', password: 'not-the-password' }),
      ENV,
      {
        auth: (request, config) =>
          createRequestAuth({
            url: TEST_SUPABASE_URL,
            anonKey: TEST_ANON_KEY,
            adminUserId: config.adminUserId,
            request,
            fetch: passwordFetch(outcome),
          }),
      },
    );
    const seen = await shape(response);
    assert.equal(seen.status, 200, outcome);
    assert.equal(seen.body.includes('Sign-in failed.'), true, outcome);
    assert.equal(seen.body.includes('ben-test@example.invalid'), false, outcome);
    assert.equal(seen.body.includes('not-the-password'), false, outcome);
    shapes.push(seen);
  }
  for (const seen of shapes) assert.deepEqual(seen, shapes[0]);
});

test('B9b: auth pages and the placeholder have no script and no on* attributes', async () => {
  const { cookie } = await csrf();
  const pages: Request[] = [];
  const aal1 = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: false };
    },
    async unverifiedFactors() {
      return { kind: 'ok', unverified: [] };
    },
    async enrollTotp() {
      return { kind: 'ok', factorId: FACTOR, qrDataUri: QR, secret: SECRET, unverified: [] };
    },
    async verifyTotp() {
      return { kind: 'denied' };
    },
  });
  const challenged = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: true };
    },
  });
  const home = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'ok' };
    },
  });
  pages.push(new Request(`${PAGE}/auth/signin`, { headers: AUTH }));
  pages.push(new Request(`${PAGE}/auth/signout`, { headers: AUTH }));
  pages.push(new Request(`${PAGE}/auth/mfa`, { headers: AUTH }));
  pages.push(new Request(`${PAGE}/auth/mfa/enroll`, { headers: AUTH }));
  pages.push(new Request(PAGE, { headers: AUTH }));
  const rendered = [
    await runRequest(pages[0]!, ENV),
    await runRequest(pages[1]!, ENV),
    await runRequest(pages[2]!, ENV, { auth: challenged.auth }),
    await runRequest(pages[3]!, ENV, { auth: aal1.auth }),
    await runRequest(pages[4]!, ENV, { auth: home.auth }),
    await runRequest(post('/auth/mfa/enroll', cookie, {}), ENV, { auth: aal1.auth }),
    await runRequest(post('/auth/mfa/enroll', cookie, { code: '000000', factor: FACTOR }), ENV, { auth: aal1.auth }),
  ];
  for (const { response } of rendered) {
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(html.includes('<script'), false);
    assert.equal(/\son[a-z]+=/i.test(html), false);
  }
});

function passwordFetch(outcome: 'bad-password' | 'down' | '500' | '429' | 'unconfirmed'): typeof fetch {
  return async (input) => {
    if (outcome === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1');
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (!url.pathname.endsWith('/token')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const status = outcome === '500' ? 500 : outcome === '429' ? 429 : 400;
    const body =
      outcome === 'unconfirmed'
        ? { error_code: 'email_not_confirmed', msg: 'Email not confirmed', error: 'email_not_confirmed' }
        : outcome === 'bad-password'
          ? { error: 'invalid_grant', error_description: 'Invalid login credentials' }
          : { message: outcome === '500' ? 'internal server error' : 'too many requests' };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}
