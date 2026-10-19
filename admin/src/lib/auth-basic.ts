// Lock 2: HTTP Basic auth (LLD §3.2). The user is compared via SHA-256 +
// timingSafeEqual and the password verify ALWAYS runs (even when the user
// mismatches or the header is absent) so timing reveals nothing about which
// part failed.

import { createHash, timingSafeEqual } from 'node:crypto';
import argon2 from '@node-rs/argon2';
import bcrypt from 'bcryptjs';

export type BasicAuthConfig = { user: string; passwordHash: string };

export type PasswordVerifier = (storedHash: string, candidate: string) => Promise<boolean>;

export const verifyPassword: PasswordVerifier = async (storedHash, candidate) => {
  try {
    return storedHash.startsWith('$2b$')
      ? await bcrypt.compare(candidate, storedHash)
      : await argon2.verify(storedHash, candidate);
  } catch {
    // A malformed stored hash fails closed.
    return false;
  }
};

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export async function checkBasicAuth(
  authorization: string | null,
  config: BasicAuthConfig,
  verify: PasswordVerifier = verifyPassword,
): Promise<boolean> {
  let user = '';
  let candidate = '';
  const scheme = authorization?.match(/^basic\s+(.+)$/i)?.[1];
  if (scheme) {
    const decoded = Buffer.from(scheme, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon >= 0) {
      user = decoded.slice(0, colon);
      candidate = decoded.slice(colon + 1);
    }
  }
  // Always verify, even on a user mismatch or a missing/malformed header.
  const passwordOk = await verify(config.passwordHash, candidate);
  return safeEqual(user, config.user) && passwordOk;
}
