// CSRF tokens (LLD §3.4): __Host-mga_csrf cookie + HMAC field whose key is
// derived from ADMIN_PATH_SECRET via HKDF label 'mga-csrf-v1', so every
// function instance agrees without a new secret.

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const CSRF_COOKIE = '__Host-mga_csrf';
export const CSRF_FIELD = 'csrf';
export const CSRF_COOKIE_OPTS = 'Secure; HttpOnly; SameSite=Strict; Path=/';

export function mintCookieValue(): string {
  return randomBytes(32).toString('base64url');
}

function key(pathSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', pathSecret, '', 'mga-csrf-v1', 32));
}

export function csrfField(pathSecret: string, cookieValue: string): string {
  return createHmac('sha256', key(pathSecret)).update(cookieValue).digest('base64url');
}

export function verifyField(pathSecret: string, cookieValue: string, field: string): boolean {
  if (!cookieValue || !field) return false;
  const expected = createHash('sha256').update(csrfField(pathSecret, cookieValue)).digest();
  const actual = createHash('sha256').update(field).digest();
  return timingSafeEqual(expected, actual);
}
