import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { describe, it } from 'node:test';
import { containsPii, hasUrlIntIpv4, isIPv6, redactPii, redactUrlIntIpv4, REDACTED, truncateText, utf8Bytes, wellFormed } from './pii.ts';

describe('isIPv6 (parse-based) agrees with node:net', () => {
  const cases = ['::', '::1', 'fe80::1', '2001:db8::1', '2001:db8:0:0:0:0:0:1', '::ffff:203.0.113.9', '::ffff:cb00:7109', '1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::1', 'g::1', '::ffff:256.0.0.1', ':1', '1:', 'ab::cd', '1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:7:1.2.3.4'];
  for (const c of cases) it(c, () => assert.equal(isIPv6(c), isIP(c) === 6));
});

describe('containsPii / redactPii', () => {
  it('finds encoded emails and compressed IPv6', () => {
    for (const s of ['ben%40example.com', 'ben%2540example.com', '/q?e=ben%2Bx%40example.com', '2001:db8::1', '::ffff:cb00:7109']) assert.equal(containsPii(s), true, s);
  });
  it('redacts only the PII token and keeps the rest', () => {
    assert.equal(redactPii('failed for ben%40example.com at main.js:3'), `failed for ${REDACTED} at main.js:3`);
    assert.equal(redactPii('peer ::1 closed'), `peer ${REDACTED} closed`);
    assert.equal(redactPii('mail ben at example dot com'), REDACTED, 'spans tokens: whole string');
    assert.equal(redactPii('TypeError: x\n    at main.js:3:14'), 'TypeError: x\n    at main.js:3:14');
  });
  it('scans long unbroken runs linearly and still detects prefixed PII', () => {
    for (const run of ['漢'.repeat(20_000), 'x'.repeat(20_000)]) {
      const t0 = performance.now();
      assert.equal(containsPii(run), false);
      assert.equal(redactPii(run), run);
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 200, `expected linear scan under 200ms, took ${elapsed}ms`);
    }

    const prefix = '漢'.repeat(1_000) + ' ';
    assert.equal(containsPii(prefix + 'ben@example.com'), true);
    assert.equal(containsPii(prefix + 'ben[at]example.com'), true);
    assert.equal(containsPii(prefix + 'ben at example dot com'), true);
    assert.equal(redactPii(prefix + 'ben@example.com'), prefix + REDACTED);
    assert.equal(redactPii(prefix + 'ben[at]example.com'), prefix + REDACTED);
    assert.equal(redactPii(prefix + 'ben at example dot com'), REDACTED);
  });
});

describe('truncateText (UTF-8 bytes, code-point boundaries)', () => {
  it('CJK: cut by bytes, never inside a character', () => {
    const t = truncateText('漢'.repeat(1000), 600);
    assert.ok(utf8Bytes(t) <= 600, `${utf8Bytes(t)} bytes`);
    assert.ok(t.endsWith('…'));
    assert.equal(t.slice(0, -1), '漢'.repeat(t.length - 1));
  });
  it('emoji: no lone surrogate at any cut point', () => {
    for (let max = 4; max < 40; max++) {
      const t = truncateText('😀'.repeat(20), max);
      assert.equal(wellFormed(t), t, `max ${max}`);
      assert.ok(utf8Bytes(t) <= max);
    }
  });
  it('honours a UTF-16 unit cap too (server path limit is 512 units)', () => {
    const t = truncateText('😀'.repeat(300), 10_000, 512);
    assert.ok(t.length <= 512 && wellFormed(t) === t);
  });
  it('leaves short text alone and repairs lone surrogates', () => {
    assert.equal(truncateText('hello', 10), 'hello');
    assert.equal(truncateText('a\uD83D', 10), 'a\uFFFD');
  });
});

describe('decimal-integer IPv4: URL parts only', () => {
  it('flags whole path segments and query values', () => {
    for (const p of ['/3405803777', '/a/3405803777/b', '/q?ip=3405803777', '/q?x=1&ip=3405803777#h']) assert.equal(hasUrlIntIpv4(p), true, p);
    assert.equal(redactUrlIntIpv4('/u/3405803777/x'), `/u/${REDACTED}/x`);
  });
  it('ignores free text and numbers outside the IPv4 range or inside a segment', () => {
    for (const p of ['/level-3405803777', '/q?t=a3405803777', '/1234567', '/99999999999']) assert.equal(hasUrlIntIpv4(p), false, p);
    assert.equal(containsPii('crash at 1760598000'), false);
    assert.equal(redactPii('crash at 1760598000'), 'crash at 1760598000');
  });
});
