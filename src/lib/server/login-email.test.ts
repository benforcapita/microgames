import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_EMAIL_COOKIE, clearLoginEmailFlash, readLoginEmailFlash, setLoginEmailFlash } from './login-email.ts';

function jar() {
  const calls: { op: string; name: string; value?: string; options?: unknown }[] = [];
  const store = new Map<string, string>();
  return {
    calls,
    set(name: string, value: string, options: Record<string, unknown>) {
      calls.push({ op: 'set', name, value, options });
      store.set(name, value);
    },
    get(name: string) {
      const value = store.get(name);
      return value === undefined ? undefined : { value };
    },
    delete(name: string, options: Record<string, unknown>) {
      calls.push({ op: 'delete', name, options });
      store.delete(name);
    },
  };
}

test('set flashes the email HttpOnly, SameSite=Lax, Path=/login, Max-Age=60', () => {
  const c = jar();
  setLoginEmailFlash(c, 'a+b@example.test', true);
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0], {
    op: 'set',
    name: LOGIN_EMAIL_COOKIE,
    value: 'a+b@example.test',
    options: { httpOnly: true, path: '/login', sameSite: 'lax', secure: true, maxAge: 60 },
  });
});

test('the Secure flag follows the caller (plain http on the local stack stays off)', () => {
  const c = jar();
  setLoginEmailFlash(c, 'a@b.test', false);
  assert.equal((c.calls[0].options as { secure: boolean }).secure, false);
});

test('an empty email stores nothing', () => {
  const c = jar();
  setLoginEmailFlash(c, '', true);
  assert.equal(c.calls.length, 0);
});

test('read returns the flashed value; missing cookie reads as empty', () => {
  const c = jar();
  assert.equal(readLoginEmailFlash(c), '');
  setLoginEmailFlash(c, 'x@y.test', true);
  assert.equal(readLoginEmailFlash(c), 'x@y.test');
});

test('clear deletes the cookie with the same Path=/login scope', () => {
  const c = jar();
  setLoginEmailFlash(c, 'x@y.test', true);
  clearLoginEmailFlash(c);
  assert.equal(readLoginEmailFlash(c), '');
  assert.deepEqual(c.calls.at(-1), { op: 'delete', name: LOGIN_EMAIL_COOKIE, options: { path: '/login' } });
});
