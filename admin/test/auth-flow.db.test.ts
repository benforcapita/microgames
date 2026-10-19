import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createRequestAuth } from '../src/lib/auth-supabase.ts';
import { CSRF_COOKIE, CSRF_FIELD, csrfField } from '../src/lib/csrf.ts';
import { basicAuth, runRequest, TEST_PASSWORD, TEST_SECRET, testEnv } from './helpers.ts';
import { localStack, type LocalStack } from './helpers/loopback.ts';
import { createConfirmedUser, deleteUser, type SeededUser } from './helpers/seed.ts';
import { parseSetCookie, assertStrictSetCookie } from './helpers/set-cookie.ts';
import { totpWindow } from './helpers/totp.ts';

let stack: LocalStack | undefined;
try {
  stack = localStack();
} catch {
  stack = undefined;
}

const BASIC = { authorization: basicAuth('boss', TEST_PASSWORD) };
const PREFIX = `/${TEST_SECRET}`;

describe('auth pages (local supabase)', { skip: !stack && 'local supabase stack is not running' }, () => {
  const local = stack as LocalStack;
  let ben: SeededUser;
  let other: SeededUser;
  const created: string[] = [];

  before(async () => {
    ben = await createConfirmedUser(local);
    other = await createConfirmedUser(local);
    created.push(ben.id, other.id);
  });

  after(async () => {
    await Promise.all(created.map((id) => deleteUser(local, id).catch(() => undefined)));
  });

  function authDeps() {
    return {
      auth: (request: Request, config: { adminUserId: string; supabaseAnonKey: string }) =>
        createRequestAuth({
          url: local.apiUrl,
          anonKey: local.anonKey,
          adminUserId: config.adminUserId,
          request,
        }),
    };
  }

  function envFor(userId: string) {
    return testEnv({ ADMIN_USER_ID: userId });
  }

  it('signs in, enrolls, verifies, opens the placeholder, and signs out', async () => {
    const jar = new Map<string, string>();
    const deps = authDeps();
    const env = envFor(ben.id);

    const signin = await hit('GET', '/auth/signin', jar, env, deps);
    assert.equal(signin.status, 200);
    assert.equal(signin.body.includes('Sign in'), true);
    assert.equal(signin.body.includes('<script'), false);

    const signedIn = await hit(
      'POST',
      '/auth/signin',
      jar,
      env,
      deps,
      { email: ben.email, password: ben.password },
    );
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.location, `${PREFIX}/auth/mfa/enroll`);
    assertStrictSession(signedIn.cookies);

    const enrollForm = await hit('GET', '/auth/mfa/enroll', jar, env, deps);
    assert.equal(enrollForm.status, 200);
    assert.equal(enrollForm.body.includes('Enroll authenticator'), true);

    const enrolled = await hit('POST', '/auth/mfa/enroll', jar, env, deps, {});
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.body.includes('data:image/'), true);
    assert.equal(enrolled.body.includes('<script'), false);
    const secret = enrolled.body.match(/<code>([A-Z2-7]{16,128})<\/code>/)?.[1];
    const factor = enrolled.body.match(/name="factor" value="([^"]+)"/)?.[1];
    assert.equal(typeof secret, 'string');
    assert.equal(typeof factor, 'string');

    let verifiedLocation: string | null = null;
    let verifiedCookies: string[] = [];
    for (const code of totpWindow(secret as string)) {
      const attempt = await hit('POST', '/auth/mfa/enroll', jar, env, deps, {
        code,
        factor: factor as string,
      });
      if (attempt.status === 303) {
        verifiedLocation = attempt.location;
        verifiedCookies = attempt.cookies;
        break;
      }
    }
    assert.equal(verifiedLocation, PREFIX);
    assertStrictSession(verifiedCookies);

    const home = await hit('GET', '', jar, env, deps);
    assert.equal(home.status, 200);
    assert.equal(home.body.includes('Meshgrounds'), true);

    const signedOut = await hit('POST', '/auth/signout', jar, env, deps, {});
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.location, `${PREFIX}/auth/signin`);
    const deletions = signedOut.cookies.filter((header) => header.startsWith('sb-'));
    assert.ok(deletions.length > 0);
    for (const header of deletions) {
      const parsed = assertStrictSetCookie(header);
      assert.equal(parsed.attrs.get('max-age'), '0');
    }

    const after = await hit('GET', '', jar, env, deps);
    assert.equal(after.status, 404);
    assert.equal(after.body, 'Not found');
  });

  it('a correct password for someone else is a plain 404 and clears sb-* cookies', async () => {
    const jar = new Map<string, string>();
    const deps = authDeps();
    const env = envFor(ben.id);
    await hit('GET', '/auth/signin', jar, env, deps);
    const response = await hit('POST', '/auth/signin', jar, env, deps, {
      email: other.email,
      password: other.password,
    });
    assert.equal(response.status, 404);
    assert.equal(response.type?.startsWith('text/plain'), true);
    assert.equal(response.body, 'Not found');
    const sb = response.cookies.filter((header) => header.startsWith('sb-'));
    assert.ok(sb.length > 0);
    const last = new Map<string, ReturnType<typeof parseSetCookie>>();
    for (const header of sb) last.set(assertStrictSetCookie(header).name, assertStrictSetCookie(header));
    for (const parsed of last.values()) {
      assert.equal(parsed.value, '');
      assert.equal(parsed.attrs.get('max-age'), '0');
    }
  });

  it('a bad password and an unknown email produce the same page', async () => {
    const jar = new Map<string, string>();
    const deps = authDeps();
    const env = envFor(ben.id);
    await hit('GET', '/auth/signin', jar, env, deps);
    const bad = await hit('POST', '/auth/signin', jar, env, deps, {
      email: ben.email,
      password: `${ben.password}no`,
    });
    const unknown = await hit('POST', '/auth/signin', jar, env, deps, {
      email: 'missing@example.invalid',
      password: `${ben.password}no`,
    });
    assert.equal(bad.status, unknown.status);
    assert.equal(createHash('sha256').update(bad.body).digest('hex'), createHash('sha256').update(unknown.body).digest('hex'));
    assert.equal(bad.body.includes('Sign-in failed.'), true);
    assert.equal(bad.body.includes(ben.email), false);
    assert.equal(bad.body.includes('missing@example.invalid'), false);
    assert.equal(bad.cookies.some((header) => header.startsWith('sb-') && !header.includes('Max-Age=0')), false);
  });
});

type Hit = {
  status: number;
  body: string;
  location: string | null;
  cookies: string[];
  type: string | null;
};

async function hit(
  method: 'GET' | 'POST',
  suffix: string,
  jar: Map<string, string>,
  env: Record<string, string>,
  deps: { auth: NonNullable<Parameters<typeof runRequest>[2]>['auth'] },
  fields?: Record<string, string>,
): Promise<Hit> {
  const headers = new Headers(BASIC);
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  if (cookie) headers.set('cookie', cookie);
  let body: URLSearchParams | undefined;
  if (method === 'POST') {
    const csrf = jar.get(CSRF_COOKIE);
    if (!csrf) throw new Error('missing csrf cookie');
    headers.set('origin', env.ADMIN_ORIGIN ?? '');
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams({ [CSRF_FIELD]: csrfField(TEST_SECRET, csrf), ...fields });
  }
  const { response } = await runRequest(new Request(`http://localhost${PREFIX}${suffix}`, { method, headers, body }), env, deps);
  absorb(jar, response.headers.getSetCookie());
  return {
    status: response.status,
    body: await response.text(),
    location: response.headers.get('location'),
    cookies: response.headers.getSetCookie(),
    type: response.headers.get('content-type'),
  };
}

function absorb(jar: Map<string, string>, headers: string[]) {
  for (const header of headers) {
    const parsed = parseSetCookie(header);
    if (parsed.attrs.get('max-age') === '0' || parsed.value === '') jar.delete(parsed.name);
    else jar.set(parsed.name, parsed.value);
  }
}

function assertStrictSession(headers: string[]) {
  const sb = headers.filter((header) => header.startsWith('sb-') && !header.includes('Max-Age=0'));
  assert.ok(sb.length > 0);
  for (const header of sb) {
    const parsed = assertStrictSetCookie(header);
    assert.notEqual(parsed.value, '');
  }
}
