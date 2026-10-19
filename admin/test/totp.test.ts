import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp } from './helpers/totp.ts';

// RFC 6238 appendix B, SHA-1, 8-digit examples truncated to the 6 we use.
// Secret is the ASCII seed, carried here as base32 because enroll secrets are base32.
function base32Encode(buf: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('totp: RFC 6238 SHA-1 vectors', () => {
  assert.equal(totp(SECRET, 59_000), '287082');
  assert.equal(totp(SECRET, 1_111_111_109_000), '081804');
  assert.equal(totp(SECRET, 1_111_111_111_000), '050471');
  assert.equal(totp(SECRET, 1_234_567_890_000), '005924');
  assert.equal(totp(SECRET, 2_000_000_000_000), '279037');
});
