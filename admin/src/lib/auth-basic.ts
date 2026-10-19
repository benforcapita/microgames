// Lock 2: HTTP Basic auth (LLD §3.2). The user is compared via SHA-256 +
// timingSafeEqual and the password verify ALWAYS runs (even when the user
// mismatches or the header is absent) so timing reveals nothing about which
// part failed — except while locked out, when it must not run at all.

import { createHash, timingSafeEqual } from 'node:crypto';
import argon2 from '@node-rs/argon2';
import bcrypt from 'bcryptjs';

export type BasicAuthConfig = { user: string; passwordHash: string };

export type PasswordVerifier = (storedHash: string, candidate: string) => Promise<boolean>;

// DB-backed lockout state (LLD §3.2, §8.3). Implemented over postgres.js in
// lib/db.ts; tests inject fakes. All timings come from the database clock.
export type LockoutStore = {
  /** Seconds left on the current lock; 0 when not locked. */
  lockSecondsRemaining(): Promise<number>;
  /** Insert one failure row and purge rows older than 1 hour. */
  recordFailure(): Promise<void>;
  /** Delete every failure row (successful login). */
  clearFailures(): Promise<void>;
};

export type BasicAuthOutcome =
  | { kind: 'pass' }
  | { kind: 'fail' }
  | { kind: 'locked'; retryAfterSeconds: number }
  | { kind: 'unavailable'; code: string };

const RETRY_AFTER_CAP = 900;

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

// Only a well-formed `Basic user:password` header counts as presenting
// credentials; anything else is an anonymous probe.
function parseBasic(authorization: string | null): { user: string; password: string } | null {
  const scheme = authorization?.match(/^basic\s+(.+)$/i)?.[1];
  if (!scheme) return null;
  const decoded = Buffer.from(scheme, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export async function checkBasicAuth(
  authorization: string | null,
  config: BasicAuthConfig,
  verify: PasswordVerifier = verifyPassword,
): Promise<boolean> {
  const creds = parseBasic(authorization);
  // Always verify, even on a user mismatch or a missing/malformed header.
  const passwordOk = await verify(config.passwordHash, creds?.password ?? '');
  return creds !== null && safeEqual(creds.user, config.user) && passwordOk;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  // SQLSTATEs (and errnos) only; never the message, which can echo the URL.
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : 'store_error';
}

// Lockout gate (LLD §3.2): check the store BEFORE parsing credentials or
// running the hash. While locked nothing is verified and no row is written,
// so the lock cannot extend itself. Any store error fails closed.
export async function gateBasicAuth(
  authorization: string | null,
  config: BasicAuthConfig,
  store: LockoutStore,
  verify: PasswordVerifier = verifyPassword,
): Promise<BasicAuthOutcome> {
  let remaining: number;
  try {
    remaining = await store.lockSecondsRemaining();
  } catch (err) {
    return { kind: 'unavailable', code: errorCode(err) };
  }
  if (remaining > 0) {
    return {
      kind: 'locked',
      retryAfterSeconds: Math.min(RETRY_AFTER_CAP, Math.max(1, Math.ceil(remaining))),
    };
  }

  const creds = parseBasic(authorization);
  const passwordOk = await verify(config.passwordHash, creds?.password ?? '');
  const ok = creds !== null && safeEqual(creds.user, config.user) && passwordOk;
  // Anonymous probes (no usable Basic credentials) get a plain 401 without a
  // failure row; only presented-and-failed credentials count toward the lock.
  if (!creds) return { kind: 'fail' };
  try {
    if (ok) await store.clearFailures();
    else await store.recordFailure();
  } catch (err) {
    return { kind: 'unavailable', code: errorCode(err) };
  }
  return ok ? { kind: 'pass' } : { kind: 'fail' };
}
