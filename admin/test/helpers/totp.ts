// RFC 6238 TOTP (SHA-1, 30s, 6 digits) from a base32 enroll secret.
// The secret and the code stay in memory; callers must not print them.

import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/ /g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32: string, at = Date.now(), stepSeconds = 30, digits = 6): string {
  const counter = BigInt(Math.floor(at / 1000 / stepSeconds));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  const code = bin % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

export function totpWindow(secretBase32: string, at = Date.now()): string[] {
  return [-30_000, 0, 30_000].map((delta) => totp(secretBase32, at + delta));
}
