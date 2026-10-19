import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequestAuth, serializeStrictCookie, type AuthKind, type RequestAuth } from '../src/lib/auth-supabase.ts';
import type { Deps } from '../src/middleware.ts';
import { CSRF_COOKIE, CSRF_FIELD, csrfField } from '../src/lib/csrf.ts';
import {
  assertSecurityHeaders,
  basicAuth,
  deniedAuth,
  runRequest,
  TEST_ADMIN_ID,
  TEST_ANON_KEY,
  TEST_ORIGIN,
  TEST_PASSWORD,
  TEST_SECRET,
  testEnv,
} from './helpers.ts';
import { assertStrictSetCookie, parseSetCookie } from './helpers/set-cookie.ts';
import { cookieHeader, futureExp, jwtWithClaim, scriptedFetch, sessionCookieValue } from './helpers/mock-auth.ts';

const ENV = testEnv();
const AUTH = { authorization: basicAuth('boss', TEST_PASSWORD) };
const PAGE = `http://localhost/${TEST_SECRET}`;
const PREFIX = `/${TEST_SECRET}`;
const FACTOR = '00000000-0000-4000-8000-0000000000aa';
const LEFTOVER = '00000000-0000-4000-8000-0000000000bb';
const QR = 'data:image/svg+xml;utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E';
const SECRET = 'AAAAAAAAAAAAAAAA';

type Calls = {
  signIn: number;
  enroll: number;
  verify: number;
  verifyVerified: number;
  signOut: (string | undefined)[];
};

function client(partial: Partial<RequestAuth> & { classify?: RequestAuth['classify'] }): {
  auth: NonNullable<Deps['auth']>;
  calls: Calls;
  cookies: string[];
} {
  const cookies: string[] = [];
  const calls: Calls = { signIn: 0, enroll: 0, verify: 0, verifyVerified: 0, signOut: [] };
  const auth: NonNullable<Deps['auth']> = () => ({
    ...deniedAuth,
    async classify() {
      return { kind: 'none' };
    },
    async signOut(scope) {
      calls.signOut.push(scope);
      cookies.push(serializeStrictCookie('sb-test-auth-token', '', { maxAge: 0 }));
      cookies.push(serializeStrictCookie('sb-test-auth-token.0', '', { maxAge: 0 }));
    },
    setCookies: () => cookies,
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
  return { auth, calls, cookies };
}

function withSessionCookie(cookies: string[], value: string) {
  cookies.push(serializeStrictCookie('sb-test-auth-token', value));
}

async function csrf() {
  const { response } = await runRequest(new Request(`${PAGE}/auth/signin`, { headers: AUTH }), ENV);
  const header = response.headers.getSetCookie().find((item) => item.startsWith(`${CSRF_COOKIE}=`));
  const cookie = header?.match(/=([^;]+)/)?.[1];
  assert.ok(cookie);
  return { cookie: cookie!, field: csrfField(TEST_SECRET, cookie!) };
}

function post(path: string, cookie: string, fields: Record<string, string>, extra: HeadersInit = {}) {
  const headers = new Headers({
    authorization: AUTH.authorization,
    origin: TEST_ORIGIN,
    'content-type': 'application/x-www-form-urlencoded',
    cookie: `${CSRF_COOKIE}=${cookie}`,
  });
  const overrides = new Headers(extra);
  overrides.forEach((value, key) => headers.set(key, value));
  const body = new URLSearchParams({ [CSRF_FIELD]: csrfField(TEST_SECRET, cookie), ...fields });
  return new Request(PAGE + path, { method: 'POST', headers, body });
}

function assertLocation(response: Response, suffix: string) {
  assert.equal(response.status, 303);
  const location = response.headers.get('location');
  assert.equal(location, `${PREFIX}${suffix}`);
  assert.equal(location.includes('://'), false);
  assert.equal(location.startsWith('//'), false);
}

function finalSb(response: Response) {
  const last = new Map<string, ReturnType<typeof parseSetCookie>>();
  for (const header of response.headers.getSetCookie()) {
    if (!header.startsWith('sb-')) continue;
    const parsed = assertStrictSetCookie(header);
    last.set(parsed.name, parsed);
  }
  return last;
}

test('sign-in page is a form with no script and no inline style', async () => {
  const { response } = await runRequest(new Request(`${PAGE}/auth/signin`, { headers: AUTH }), ENV);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const body = await response.text();
  assert.match(body, /<h1>Sign in<\/h1>/);
  assert.match(body, /name="email"/);
  assert.match(body, /name="password"/);
  assert.match(body, new RegExp(`href="/${TEST_SECRET}/admin\\.css"`));
  assert.doesNotMatch(body, /<style|<script|style=/i);
  assertSecurityHeaders(response);
  const csrfCookie = response.headers.getSetCookie().find((item) => item.startsWith(`${CSRF_COOKIE}=`));
  assert.ok(csrfCookie);
  assertStrictSetCookie(csrfCookie!);
});

test('a failed sign-in is one generic message and sets no session cookie', async () => {
  const { cookie } = await csrf();
  const stub = client({});
  const bodies: string[] = [];
  for (const email of ['ben-test@example.invalid', 'nobody@example.invalid']) {
    const { response } = await runRequest(
      post('/auth/signin', cookie, { email, password: 'not-the-password' }),
      ENV,
      { auth: stub.auth },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes('Sign-in failed.'), true);
    assert.equal(body.includes(email), false);
    assert.equal(body.includes('not-the-password'), false);
    assert.equal(body.includes('Invalid login'), false);
    assert.equal(body.includes('not found'), false);
    assert.doesNotMatch(body, /<style|<script|style=/i);
    bodies.push(body);
    assert.equal(finalSb(response).size, 0);
  }
  assert.equal(bodies[0], bodies[1]);
  assert.equal(stub.calls.signIn, 2);
});

test('an empty sign-in is the same message and does not call Auth', async () => {
  const { cookie } = await csrf();
  const stub = client({});
  const { response } = await runRequest(post('/auth/signin', cookie, { email: '', password: '' }), ENV, {
    auth: stub.auth,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes('Sign-in failed.'), true);
  assert.equal(stub.calls.signIn, 0);
});

test('Ben with no verified factor is sent to enroll', async () => {
  const { cookie } = await csrf();
  const cookies: string[] = [];
  const stub = client({
    async signInWithPassword() {
      withSessionCookie(cookies, 'session');
      return { kind: 'ben', verifiedTotp: false };
    },
    setCookies: () => cookies,
  });
  const { response } = await runRequest(
    post('/auth/signin', cookie, { email: 'ben-test@example.invalid', password: 'pw', next: 'https://evil.example' }),
    ENV,
    { auth: stub.auth },
  );
  assertLocation(response, '/auth/mfa/enroll');
  const sb = finalSb(response);
  assert.equal(sb.get('sb-test-auth-token')?.value, 'session');
  assert.equal(sb.get('sb-test-auth-token')?.attrs.has('max-age'), false);
  assertSecurityHeaders(response);
});

test('Ben with a verified factor is sent to the challenge', async () => {
  const { cookie } = await csrf();
  const cookies: string[] = [];
  const stub = client({
    async signInWithPassword() {
      withSessionCookie(cookies, 'session');
      return { kind: 'ben', verifiedTotp: true };
    },
    setCookies: () => cookies,
  });
  const { response } = await runRequest(
    post('/auth/signin', cookie, { email: 'a@b.c', password: 'pw', next: '//evil.example' }),
    ENV,
    { auth: stub.auth },
  );
  assertLocation(response, '/auth/mfa');
});

test('a correct password for someone else is a plain 404 and the session cookie is cleared', async () => {
  const { cookie } = await csrf();
  const cookies: string[] = [];
  const stub = client({
    async signInWithPassword() {
      withSessionCookie(cookies, 'session');
      return { kind: 'other-user' };
    },
    async signOut(scope) {
      stub.calls.signOut.push(scope);
      cookies.push(serializeStrictCookie('sb-test-auth-token', '', { maxAge: 0 }));
    },
    setCookies: () => cookies,
  });
  const { response } = await runRequest(
    post('/auth/signin', cookie, { email: 'other@example.invalid', password: 'pw' }),
    ENV,
    { auth: stub.auth },
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await response.text(), 'Not found');
  assert.deepEqual(stub.calls.signOut, [undefined]);
  const sb = finalSb(response);
  assert.equal(sb.get('sb-test-auth-token')?.value, '');
  assert.equal(sb.get('sb-test-auth-token')?.attrs.get('max-age'), '0');
});

test('sign-in rejects a missing or wrong CSRF token and does not call Auth', async () => {
  const { cookie, field } = await csrf();
  const stub = client({});
  const bad = [
    post('/auth/signin', cookie, { email: 'a@b.c', password: 'pw' }, { origin: 'https://evil.example' }),
    new Request(`${PAGE}/auth/signin`, {
      method: 'POST',
      headers: {
        ...AUTH,
        origin: TEST_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${CSRF_COOKIE}=${cookie}`,
      },
      body: new URLSearchParams({ [CSRF_FIELD]: `${field}x`, email: 'a@b.c', password: 'pw' }),
    }),
  ];
  for (const request of bad) {
    const { response } = await runRequest(request, ENV, { auth: stub.auth });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Forbidden');
  }
  assert.equal(stub.calls.signIn, 0);
});

test('the challenge page sends an AAL2 session home', async () => {
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'ok' };
    },
  });
  const get = await runRequest(new Request(`${PAGE}/auth/mfa`, { headers: AUTH }), ENV, { auth: stub.auth });
  assertLocation(get.response, '');
  const { cookie } = await csrf();
  const postRes = await runRequest(post('/auth/mfa', cookie, { code: '123456' }), ENV, { auth: stub.auth });
  assertLocation(postRes.response, '');
  assert.equal(stub.calls.verifyVerified, 0);
});

test('a verified factor can be challenged and a success goes home', async () => {
  const { cookie } = await csrf();
  const cookies: string[] = [];
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: true };
    },
    async verifyVerifiedTotp() {
      stub.calls.verifyVerified += 1;
      withSessionCookie(cookies, 'aal2');
      return { kind: 'ok' };
    },
    setCookies: () => cookies,
  });
  const form = await runRequest(new Request(`${PAGE}/auth/mfa`, { headers: AUTH }), ENV, { auth: stub.auth });
  assert.equal(form.response.status, 200);
  assert.equal((await form.response.text()).includes('Authentication code'), true);
  const { response } = await runRequest(post('/auth/mfa', cookie, { code: '123456' }), ENV, { auth: stub.auth });
  assertLocation(response, '');
  assert.equal(finalSb(response).get('sb-test-auth-token')?.value, 'aal2');
  assertStrictSetCookie(response.headers.getSetCookie().find((item) => item.startsWith('sb-'))!);
});

test('a wrong authentication code is one generic message', async () => {
  const { cookie } = await csrf();
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: true };
    },
  });
  const { response } = await runRequest(post('/auth/mfa', cookie, { code: '000000' }), ENV, { auth: stub.auth });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes('Verification failed.'), true);
  assert.equal(body.includes('000000'), false);
  assert.equal(stub.calls.verifyVerified, 1);
});

test('the challenge page without a verified factor goes to enroll', async () => {
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: false };
    },
  });
  const { response } = await runRequest(new Request(`${PAGE}/auth/mfa`, { headers: AUTH }), ENV, { auth: stub.auth });
  assertLocation(response, '/auth/mfa/enroll');
});

test('the challenge page without a session goes to sign-in', async () => {
  const stub = client({});
  const { response } = await runRequest(new Request(`${PAGE}/auth/mfa`, { headers: AUTH }), ENV, { auth: stub.auth });
  assertLocation(response, '/auth/signin');
});

test('someone else opening the challenge is signed out with a plain 404', async () => {
  const cookies: string[] = [];
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'other-user' };
    },
    async signOut(scope) {
      stub.calls.signOut.push(scope);
      cookies.push(serializeStrictCookie('sb-other-auth-token', '', { maxAge: 0 }));
    },
    setCookies: () => cookies,
  });
  const { response } = await runRequest(new Request(`${PAGE}/auth/mfa`, { headers: AUTH }), ENV, { auth: stub.auth });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assert.equal(finalSb(response).get('sb-other-auth-token')?.attrs.get('max-age'), '0');
});

test('an Auth error on the challenge page is a plain 404', async () => {
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'error' };
    },
  });
  const { response } = await runRequest(new Request(`${PAGE}/auth/mfa`, { headers: AUTH }), ENV, { auth: stub.auth });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});

test('enroll lists leftover unverified factors and does not remove them', async () => {
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: false };
    },
    async unverifiedFactors() {
      return { kind: 'ok', unverified: [{ id: LEFTOVER, factorType: 'totp' }] };
    },
  });
  const { response } = await runRequest(new Request(`${PAGE}/auth/mfa/enroll`, { headers: AUTH }), ENV, {
    auth: stub.auth,
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes(LEFTOVER), true);
  assert.equal(body.includes('not removed'), true);
  assert.equal(body.includes('Enroll authenticator'), true);
  assert.equal(stub.calls.enroll, 0);
  assert.doesNotMatch(body, /<style|<script|style=/i);
});

test('enroll with a verified factor is the lock-1 404', async () => {
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: true };
    },
  });
  const { response } = await runRequest(new Request(`${PAGE}/auth/mfa/enroll`, { headers: AUTH }), ENV, {
    auth: stub.auth,
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(response.headers.get('location'), null);
  assert.equal(await response.text(), 'Not found');
  assert.equal(stub.calls.enroll, 0);
});

test('enroll renders the QR as a data URI and a failed code retries that factor', async () => {
  const { cookie } = await csrf();
  const unverified = [{ id: LEFTOVER, factorType: 'totp' as const }];
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: false };
    },
    async unverifiedFactors() {
      return { kind: 'ok', unverified };
    },
    async enrollTotp() {
      stub.calls.enroll += 1;
      return { kind: 'ok', factorId: FACTOR, qrDataUri: QR, secret: SECRET, unverified };
    },
  });
  const started = await runRequest(post('/auth/mfa/enroll', cookie, {}), ENV, { auth: stub.auth });
  assert.equal(started.response.status, 200);
  const body = await started.response.text();
  assert.equal(body.includes(`src="${QR}"`), true);
  assert.equal(body.includes(SECRET), true);
  assert.equal(body.includes(`value="${FACTOR}"`), true);
  assert.equal(body.includes(LEFTOVER), true);
  assert.equal(body.includes('not removed'), true);
  assert.doesNotMatch(body, /<style|<script|style=/i);
  assert.equal(stub.calls.enroll, 1);

  const retry = await runRequest(post('/auth/mfa/enroll', cookie, { code: '000000', factor: FACTOR }), ENV, {
    auth: stub.auth,
  });
  assert.equal(retry.response.status, 200);
  const retryBody = await retry.response.text();
  assert.equal(retryBody.includes('Verification failed.'), true);
  assert.equal(retryBody.includes(`value="${FACTOR}"`), true);
  assert.equal(stub.calls.enroll, 1);
  assert.equal(stub.calls.verify, 1);
});

test('a successful enroll verification goes home', async () => {
  const { cookie } = await csrf();
  const cookies: string[] = [];
  const stub = client({
    async classify(): Promise<AuthKind> {
      return { kind: 'aal1-ben', verifiedTotp: false };
    },
    async verifyTotp() {
      stub.calls.verify += 1;
      withSessionCookie(cookies, 'aal2');
      return { kind: 'ok' };
    },
    setCookies: () => cookies,
  });
  const { response } = await runRequest(
    post('/auth/mfa/enroll', cookie, { code: '123456', factor: FACTOR, next: 'https://evil.example' }),
    ENV,
    { auth: stub.auth },
  );
  assertLocation(response, '');
  assert.equal(finalSb(response).get('sb-test-auth-token')?.value, 'aal2');
  for (const header of response.headers.getSetCookie().filter((item) => item.startsWith('sb-'))) {
    assertStrictSetCookie(header);
  }
});

test('sign-out is local scope, clears sb-* strictly, and returns to sign-in', async () => {
  const { cookie } = await csrf();
  const cookies: string[] = [];
  const stub = client({
    async signOut(scope) {
      stub.calls.signOut.push(scope);
      cookies.push(serializeStrictCookie('sb-test-auth-token', '', { maxAge: 0 }));
      cookies.push(serializeStrictCookie('sb-test-auth-token.0', '', { maxAge: 0 }));
    },
    setCookies: () => cookies,
  });
  const form = await runRequest(new Request(`${PAGE}/auth/signout`, { headers: AUTH }), ENV, { auth: stub.auth });
  assert.equal(form.response.status, 200);
  assert.equal((await form.response.text()).includes('Sign out'), true);
  const { response } = await runRequest(post('/auth/signout', cookie, {}), ENV, { auth: stub.auth });
  assertLocation(response, '/auth/signin');
  assert.deepEqual(stub.calls.signOut, ['local']);
  const sb = finalSb(response);
  assert.equal(sb.get('sb-test-auth-token')?.attrs.get('max-age'), '0');
  assert.equal(sb.get('sb-test-auth-token.0')?.attrs.get('max-age'), '0');
});

test('sign-out through the Auth client uses local scope and strict deletions', async () => {
  const { cookie, field } = await csrf();
  const token = jwtWithClaim({ aal: 'aal1', exp: futureExp() });
  const session = cookieHeader(sessionCookieValue(token, futureExp()));
  let logout = '';
  const { response } = await runRequest(
    new Request(`${PAGE}/auth/signout`, {
      method: 'POST',
      headers: {
        ...AUTH,
        origin: TEST_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${CSRF_COOKIE}=${cookie}; ${session}`,
      },
      body: new URLSearchParams({ [CSRF_FIELD]: field }),
    }),
    ENV,
    {
      auth: (request, config) =>
        createRequestAuth({
          url: 'https://admin-supabase-test.example',
          anonKey: TEST_ANON_KEY,
          adminUserId: config.adminUserId,
          request,
          fetch: async (input, init) => {
            const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            const url = new URL(raw);
            if (url.pathname.endsWith('/logout')) {
              logout = `${url.pathname}${url.search}`;
              return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return scriptedFetch({ userId: TEST_ADMIN_ID, acceptedBearer: token })(input, init);
          },
        }),
    },
  );
  assertLocation(response, '/auth/signin');
  assert.equal(logout.includes('scope=local'), true);
  const sb = response.headers.getSetCookie().filter((header) => header.startsWith('sb-'));
  assert.ok(sb.length > 0);
  for (const header of sb) {
    const parsed = assertStrictSetCookie(header);
    assert.equal(parsed.attrs.get('max-age'), '0');
    assert.equal(parsed.value, '');
  }
});

test('google and the auth callback stay 404', async () => {
  for (const suffix of ['/auth/google', '/auth/callback']) {
    const { response } = await runRequest(new Request(PAGE + suffix, { headers: AUTH }), ENV);
    assert.equal(response.status, 404, suffix);
    assert.equal(await response.text(), 'Not found', suffix);
  }
});

test('admin sources do not delete factors or sign users up', () => {
  const root = new URL('../src', import.meta.url).pathname;
  const files = walk(root);
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('.unenroll('), false, file);
    assert.equal(text.includes('signUp'), false, file);
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
