import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from './safe-next.ts';

const ORIGIN = 'https://meshgrounds.vercel.app';
const sameOrigin = (r: string) => {
  assert.ok(r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\'), `unsafe output ${JSON.stringify(r)}`);
  assert.equal(new URL(r, ORIGIN).origin, ORIGIN);
};

test('keeps same-site paths', () => {
  for (const p of ['/', '/play/abc', '/me?tab=saves', '/g/x#top']) assert.equal(safeNext(p), p);
});

test('blocks open redirects', () => {
  const bad = ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/ /evil.com',
    'https://evil.com', 'evil.com', '/\\/evil.com', '\u0000/x', '/x\u007f', '',
    '/..//evil.com', '/.//evil.com', '/%2e%2e//evil.com', '/%2e//evil.com', '/a/../..//evil.com',
    '/%2E%2E//evil.com', '/./..//evil.com'];
  for (const b of bad) sameOrigin(safeNext(b));
  for (const b of ['/\t/evil.com', '/..//evil.com', '/%2e//evil.com', '/a/../..//evil.com']) assert.equal(safeNext(b), '/');
});

test('non-string input returns fallback', () => {
  assert.equal(safeNext(null, '/me'), '/me');
  assert.equal(safeNext(undefined), '/');
  assert.equal(safeNext(42 as unknown), '/');
  assert.equal(safeNext({} as unknown), '/');
});
