import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Anonymous "one free game" decision and the `mg_free` cookie.
 *
 * Cookie value: `v1.<payload>.<hmac>`
 * payload is base64url JSON `{ gameId, exp }` (exp is unix milliseconds).
 * The HMAC is SHA-256 over `v1.<payload>`, keyed with a server secret the caller passes in.
 * No database, network, or environment access.
 */

export const FREE_PLAY_COOKIE = 'mg_free';

/** Persistent-cookie ceiling. Callers can pass a shorter ttl; tests do. */
export const FREE_PLAY_TTL_MS = 400 * 24 * 60 * 60 * 1000;

const VERSION = 'v1';
const MAX_GAME_ID_LENGTH = 128;
const MAX_COOKIE_LENGTH = 2048;

export interface GateUser {
  id: string;
}

export type FreePlayCookie =
  | { ok: true; gameId: string; exp: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'tampered' | 'expired' };

export interface PlayGateOptions {
  /** High-entropy server key. This module never reads it from the environment. */
  secret: string;
  /** Unix milliseconds. Defaults to `Date.now()`. */
  now?: number;
  /** Lifetime of a newly issued grant. Defaults to `FREE_PLAY_TTL_MS`. */
  ttlMs?: number;
}

export interface GateDecision {
  allow: boolean;
  reason: 'signed_in' | 'same_game' | 'first_game' | 'other_game';
  /** New `mg_free` value, or null to leave the stored cookie alone. */
  setCookie: string | null;
  /** Signed-in visitors drop `mg_free`, so the free-game id is forgotten. */
  clearCookie: boolean;
  expiresAt: number | null;
  cookieStatus: 'missing' | 'ok' | 'malformed' | 'tampered' | 'expired';
}

function requireSecret(secret: unknown): string {
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('Play-gate secret is required');
  return secret;
}

function requireNow(now: number | undefined): number {
  const time = now ?? Date.now();
  if (!Number.isSafeInteger(time)) throw new Error('Play-gate time must be a safe integer');
  return time;
}

function requireGameId(gameId: unknown): string {
  if (typeof gameId !== 'string' || gameId.trim().length === 0 || gameId.length > MAX_GAME_ID_LENGTH) {
    throw new Error('Game id is required');
  }
  return gameId;
}

function expiryAt(now: number, ttlMs: number | undefined): number {
  const ttl = ttlMs ?? FREE_PLAY_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error('Play-gate ttl must be a positive safe integer');
  const exp = now + ttl;
  if (!Number.isSafeInteger(exp)) throw new Error('Play-gate expiry is out of range');
  return exp;
}

function mac(material: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(material).digest();
}

function macMatches(material: string, secret: string, presented: string): boolean {
  const expected = mac(material, secret);
  const actual = Buffer.from(presented, 'base64url');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function readGrant(payload: string): { gameId: string; exp: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const gameId = 'gameId' in parsed ? parsed.gameId : undefined;
  const exp = 'exp' in parsed ? parsed.exp : undefined;
  if (typeof gameId !== 'string' || gameId.length === 0 || gameId.length > MAX_GAME_ID_LENGTH) return null;
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) return null;
  return { gameId, exp };
}

/** Sign a grant for `gameId`. The returned string is the `mg_free` cookie value. */
export function signFreePlayCookie(gameId: string, secret: string, now = Date.now(), ttlMs = FREE_PLAY_TTL_MS): string {
  const id = requireGameId(gameId);
  const key = requireSecret(secret);
  const time = requireNow(now);
  const exp = expiryAt(time, ttlMs);
  const payload = Buffer.from(JSON.stringify({ gameId: id, exp }), 'utf8').toString('base64url');
  const signature = mac(`${VERSION}.${payload}`, key).toString('base64url');
  return `${VERSION}.${payload}.${signature}`;
}

/**
 * Verify `mg_free`. A bad signature is `tampered` even when the embedded expiry has also passed.
 * Expired grants fail only after the signature checks out.
 */
export function verifyFreePlayCookie(cookie: string | null | undefined, secret: string, now = Date.now()): FreePlayCookie {
  const key = requireSecret(secret);
  const time = requireNow(now);
  if (typeof cookie !== 'string') return { ok: false, reason: 'missing' };
  const token = cookie.trim();
  if (token.length === 0) return { ok: false, reason: 'missing' };
  if (token.length > MAX_COOKIE_LENGTH) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, payload, signature] = parts;
  if (version !== VERSION || !payload || !signature || !isBase64Url(payload) || !isBase64Url(signature)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!macMatches(`${version}.${payload}`, key, signature)) return { ok: false, reason: 'tampered' };

  const grant = readGrant(payload);
  if (!grant) return { ok: false, reason: 'malformed' };
  if (time >= grant.exp) return { ok: false, reason: 'expired' };
  return { ok: true, gameId: grant.gameId, exp: grant.exp };
}

function signedIn(user: GateUser | null | undefined): boolean {
  return typeof user?.id === 'string' && user.id.trim().length > 0;
}

/**
 * Whether this visitor may launch `gameId`.
 * Signed-in visitors always may. Anonymous visitors may replay the granted game,
 * or take one game when the cookie is missing, malformed, tampered, or expired.
 * A valid cookie naming a different game is the only anonymous denial.
 * An unverifiable cookie counts as absent, the same as clearing it.
 */
export function decideGate(
  cookie: string | null | undefined,
  gameId: string,
  user: GateUser | null | undefined,
  options: PlayGateOptions,
): GateDecision {
  const id = requireGameId(gameId);
  const key = requireSecret(options?.secret);
  const time = requireNow(options?.now);
  const verified = verifyFreePlayCookie(cookie, key, time);
  const cookieStatus = verified.ok ? 'ok' : verified.reason;

  if (signedIn(user)) {
    const present = typeof cookie === 'string' && cookie.trim().length > 0;
    return {
      allow: true,
      reason: 'signed_in',
      setCookie: null,
      clearCookie: present,
      expiresAt: null,
      cookieStatus: present ? cookieStatus : 'missing',
    };
  }

  if (verified.ok && verified.gameId === id) {
    return {
      allow: true,
      reason: 'same_game',
      setCookie: null,
      clearCookie: false,
      expiresAt: verified.exp,
      cookieStatus: 'ok',
    };
  }

  if (verified.ok) {
    return {
      allow: false,
      reason: 'other_game',
      setCookie: null,
      clearCookie: false,
      expiresAt: verified.exp,
      cookieStatus: 'ok',
    };
  }

  const expiresAt = expiryAt(time, options.ttlMs);
  return {
    allow: true,
    reason: 'first_game',
    setCookie: signFreePlayCookie(id, key, time, expiresAt - time),
    clearCookie: false,
    expiresAt,
    cookieStatus,
  };
}
