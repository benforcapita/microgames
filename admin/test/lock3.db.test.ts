import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createServerClient } from '@supabase/ssr';
import type { Session } from '@supabase/supabase-js';
import { createRequestAuth } from '../src/lib/auth-supabase.ts';
import { basicAuth, runRequest, TEST_PASSWORD, TEST_SECRET, testEnv } from './helpers.ts';
import { localStack, type LocalStack } from './helpers/loopback.ts';
import {
  aal1Session,
  createConfirmedUser,
  deleteUser,
  enrollVerifiedTotp,
  type SeededUser,
} from './helpers/seed.ts';
import { assertStrictSetCookie } from './helpers/set-cookie.ts';

let stack: LocalStack | undefined;
try {
  stack = localStack();
} catch {
  stack = undefined;
}

const BASIC = { authorization: basicAuth('boss', TEST_PASSWORD) };

describe('lock 3 session gate (local supabase)', { skip: !stack && 'local supabase stack is not running' }, () => {
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

  function hit(cookie?: string) {
    const headers: Record<string, string> = { ...BASIC };
    if (cookie) headers.cookie = cookie;
    return runRequest(new Request(`http://localhost/${TEST_SECRET}`, { headers }), testEnv({ ADMIN_USER_ID: ben.id }), {
      auth: (request, config) =>
        createRequestAuth({
          url: local.apiUrl,
          anonKey: local.anonKey,
          adminUserId: config.adminUserId,
          request,
        }),
    });
  }

  async function cookieHeader(session: Session): Promise<string> {
    const jar = new Map<string, string>();
    const client = createServerClient(local.apiUrl, local.anonKey, {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll(list) {
          for (const item of list) {
            if (item.value) jar.set(item.name, item.value);
            else jar.delete(item.name);
          }
        },
      },
    });
    const { error } = await client.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (error || jar.size === 0) throw new Error(`session cookie failed (${error?.status ?? 'empty'})`);
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async function plain(response: Response) {
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      body: await response.text(),
      cookies: response.headers.getSetCookie(),
    };
  }

  it('no session, a tampered cookie, and a foreign-signed cookie match lock 1', async () => {
    const lock1 = await plain((await runRequest(new Request('http://localhost/nope'), testEnv())).response);
    const none = await plain((await hit()).response);
    assert.equal(none.status, lock1.status);
    assert.equal(none.type, lock1.type);
    assert.equal(none.body, lock1.body);
    assert.deepEqual(none.cookies, []);

    const aal1 = await aal1Session(local, ben);
    const real = await cookieHeader(aal1);
    const tampered = real.replace(/=([^;]{4})/, '=$1x');
    const bad = await plain((await hit(tampered)).response);
    assert.equal(bad.status, 404);
    assert.equal(bad.body, lock1.body);
    assert.equal(bad.type, lock1.type);

    const foreign = foreignSigned(real, ben.id);
    const rejected = await plain((await hit(foreign)).response);
    assert.equal(rejected.status, 404);
    assert.equal(rejected.body, lock1.body);
    assert.equal(rejected.type, lock1.type);
    assert.deepEqual(rejected.cookies, []);
  });

  it('Ben at aal1 is 404, including after a verified factor exists', async () => {
    const beforeEnroll = await cookieHeader(await aal1Session(local, ben));
    const first = await hit(beforeEnroll);
    assert.equal(first.response.status, 404);
    assert.equal(await first.response.text(), 'Not found');
    assert.equal(first.logs[0]?.lock, 3);
    assert.equal(
      first.response.headers.getSetCookie().some((header) => header.includes('Max-Age=0')),
      false,
    );

    const aal2 = await enrollVerifiedTotp(local, ben);
    const upgraded = await hit(await cookieHeader(aal2));
    assert.equal(upgraded.response.status, 200);
    assert.match(await upgraded.response.text(), /Meshgrounds/);

    const afterEnroll = await cookieHeader(await aal1Session(local, ben));
    const second = await hit(afterEnroll);
    assert.equal(second.response.status, 404);
    assert.equal(second.logs[0]?.lock, 3);

    const css = await runRequest(
      new Request(`http://localhost/${TEST_SECRET}/admin.css`, {
        headers: { ...BASIC, cookie: afterEnroll },
      }),
      testEnv({ ADMIN_USER_ID: ben.id }),
      {
        auth: (request, config) =>
          createRequestAuth({
            url: local.apiUrl,
            anonKey: local.anonKey,
            adminUserId: config.adminUserId,
            request,
          }),
      },
    );
    assert.equal(css.response.status, 200);
  });

  it('another account is 404 and its sb-* cookies are deleted with strict attributes', async () => {
    const cookie = await cookieHeader(await aal1Session(local, other));
    const { response } = await hit(cookie);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
    const setCookies = response.headers.getSetCookie();
    const deletions = setCookies.filter((header) => header.startsWith('sb-'));
    assert.ok(deletions.length > 0);
    for (const header of setCookies) {
      const parsed = assertStrictSetCookie(header);
      if (parsed.name.startsWith('sb-')) assert.equal(parsed.attrs.get('max-age'), '0');
    }
  });
});

function foreignSigned(cookieHeader: string, userId: string): string {
  const eq = cookieHeader.indexOf('=');
  const semi = cookieHeader.indexOf(';');
  const name = cookieHeader.slice(0, eq);
  const value = cookieHeader.slice(eq + 1, semi === -1 ? undefined : semi);
  if (!value.startsWith('base64-')) throw new Error('unexpected session cookie encoding');
  const session = JSON.parse(Buffer.from(value.slice('base64-'.length), 'base64url').toString('utf8')) as {
    access_token?: string;
    expires_at?: number;
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      aal: 'aal2',
      sub: userId,
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', randomBytes(32)).update(`${header}.${payload}`).digest('base64url');
  session.access_token = `${header}.${payload}.${sig}`;
  session.expires_at = Math.floor(Date.now() / 1000) + 3600;
  const encoded = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  const rest = semi === -1 ? '' : cookieHeader.slice(semi);
  return `${name}=${encoded}${rest}`;
}
