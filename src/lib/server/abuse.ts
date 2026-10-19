import crypto from 'node:crypto';
import type postgres from 'postgres';

export const MG_UID_COOKIE = 'mg_uid';

const UID_RE = /^[0-9a-f-]{36}$/i;

export function parseUid(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return UID_RE.test(v) ? v.toLowerCase() : null;
}

export function newUid(): string {
  return crypto.randomUUID();
}

export interface LimiterOptions {
  windowMs: number;
  max: number;
  now?: () => number;
  maxKeys?: number;
}

export function createLimiter(opts: LimiterOptions): {
  hit(key: string): boolean;
  check(key: string): boolean;
  readonly size: number;
} {
  const { windowMs, max, now = () => Date.now(), maxKeys = 10000 } = opts;
  const map = new Map<string, number[]>();

  return {
    hit(key: string): boolean {
      const t = now();
      const cutoff = t - windowMs;

      // Evict expired entries from the head of the map (insertion/refresh order)
      while (map.size > 0) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        const entry = map.get(oldestKey);
        if (!entry || entry.length === 0 || entry[entry.length - 1] <= cutoff) {
          map.delete(oldestKey);
        } else {
          break;
        }
      }

      let timestamps = map.get(key);
      if (timestamps) {
        timestamps = timestamps.filter((ts) => ts > cutoff);
      }

      if (!timestamps || timestamps.length === 0) {
        if (!map.has(key)) {
          while (map.size >= maxKeys) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
          }
        }
        map.delete(key);
        map.set(key, [t]);
        return true;
      }

      if (timestamps.length < max) {
        timestamps.push(t);
        map.delete(key);
        map.set(key, timestamps);
        return true;
      }

      // Max reached; keep filtered timestamps in place without moving to MRU
      map.set(key, timestamps);
      return false;
    },
    /** Would `hit(key)` be allowed right now? Does not record anything. */
    check(key: string): boolean {
      const cutoff = now() - windowMs;
      const timestamps = map.get(key);
      return !timestamps || timestamps.filter((ts) => ts > cutoff).length < max;
    },
    get size(): number {
      return map.size;
    },
  };
}

export interface RatingGuardOptions {
  maxKeys?: number;
  maxEntries?: number;
}

export function createRatingGuard(opts?: RatingGuardOptions): {
  allow(uid: string, gameId: string, voter: string): boolean;
  readonly size: number;
} {
  const maxKeys = opts?.maxKeys ?? opts?.maxEntries ?? 10000;
  const map = new Map<string, string>();

  return {
    allow(uid: string, gameId: string, voter: string): boolean {
      const key = `${uid}:${gameId}`;
      const existing = map.get(key);
      if (existing !== undefined) {
        if (existing === voter) {
          map.delete(key);
          map.set(key, voter);
          return true;
        }
        return false;
      }

      while (map.size >= maxKeys) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      map.set(key, voter);
      return true;
    },
    get size(): number {
      return map.size;
    },
  };
}

export const telemetryByUid = createLimiter({ windowMs: 60_000, max: 120 });
export const ratingGuard = createRatingGuard();

/** Rating upserts allowed per logged-in user per hour. */
export const RATING_WRITES_MAX = 30;
export const RATING_WRITES_WINDOW_MS = 60 * 60_000;
export const SELF_RATING_MESSAGE = "You can't rate your own game.";
export const RATING_LIMIT_MESSAGE = 'Too many ratings';
export const DEVICE_RATING_MESSAGE = 'Already rated from this device';

/** Per-user hourly cap on rating upserts, using the shared sliding-window limiter. */
export function createRatingWriteLimiter(now?: () => number) {
  return createLimiter({
    windowMs: RATING_WRITES_WINDOW_MS,
    max: RATING_WRITES_MAX,
    now,
  });
}

export const ratingWritesByUser = createRatingWriteLimiter();

/**
 * Client IP used for rate limiting. On Vercel the socket address is the proxy, so use the
 * platform-set `x-vercel-forwarded-for`, then `x-real-ip`. Elsewhere only the socket address
 * is trusted. A raw `X-Forwarded-For` is never trusted (clients can forge it).
 */
export function clientIp(headers: Headers, socketAddress: string | undefined, isVercel: boolean): string {
  if (isVercel) {
    const fwd = headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
    const real = headers.get('x-real-ip')?.trim();
    if (real) return real;
  }
  return socketAddress || 'unknown';
}

/** Cookie `Secure` flag: always in production / on Vercel, otherwise only over https. */
export function secureCookie(protocol: string, isProd: boolean, isVercel: boolean): boolean {
  return isProd || isVercel || protocol === 'https:';
}

type Limiter = ReturnType<typeof createLimiter>;
type RatingGuardLike = Pick<ReturnType<typeof createRatingGuard>, 'allow'>;

export type RatingDecision =
  | { ok: true }
  | { ok: false; status: 403 | 409 | 429; message: string };

/**
 * Admit one rating write.
 * Own-game ratings are refused before the device guard or the hourly cap is touched,
 * and a device conflict does not spend an hourly write.
 */
export function authorizeRating(
  ownerId: string | null,
  userId: string,
  uid: string,
  gameId: string,
  guard: RatingGuardLike = ratingGuard,
  writes: Limiter = ratingWritesByUser,
): RatingDecision {
  if (ownerId !== null && ownerId === userId) {
    return { ok: false, status: 403, message: SELF_RATING_MESSAGE };
  }
  if (!guard.allow(uid, gameId, userId)) {
    return { ok: false, status: 409, message: DEVICE_RATING_MESSAGE };
  }
  if (!writes.hit(userId)) {
    return { ok: false, status: 429, message: RATING_LIMIT_MESSAGE };
  }
  return { ok: true };
}

export const SESSION_START_UID_WINDOW_MS = 30 * 60_000;
export const SESSION_START_IP_WINDOW_MS = 60 * 60_000;
export const SESSION_START_IP_MAX = 20;
const SWEEP_BATCH = 500;

export function sessionIpSubject(ip: string, secret: string, at: Date): string {
  const dayKey = crypto.createHmac('sha256', secret).update(at.toISOString().slice(0, 10)).digest();
  return crypto.createHmac('sha256', dayKey).update(ip).digest('hex');
}

export interface SessionAdmission {
  uid: string;
  ip: string;
  gameId: string;
  now?: number;
}

async function inWindow(
  tx: postgres.TransactionSql,
  kind: 'uid' | 'ip',
  subject: string,
  gameId: string,
  cutoff: Date,
): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from public.session_admissions
    where kind = ${kind} and subject = ${subject} and game_id = ${gameId} and created_at > ${cutoff}`;
  return row?.n ?? 0;
}

async function hit(
  tx: postgres.TransactionSql,
  kind: 'uid' | 'ip',
  subject: string,
  gameId: string,
  at: Date,
  cutoff: Date,
  sweep: Date,
  max: number,
): Promise<boolean> {
  const [row] = await tx<{ admitted: boolean }[]>`
    with pruned as (
      delete from public.session_admissions
      where id in (
        select id from public.session_admissions
        where created_at < ${sweep}
        order by id
        limit ${SWEEP_BATCH}
        for update skip locked
      )
      returning 1
    ), ins as (
      insert into public.session_admissions (kind, subject, game_id, created_at)
      select ${kind}, ${subject}, ${gameId}, ${at}
      where (select count(*) from public.session_admissions s
             where s.kind = ${kind} and s.subject = ${subject} and s.game_id = ${gameId}
               and s.created_at > ${cutoff}) < ${max}
      returning id
    )
    select exists(select 1 from ins) as admitted`;
  return row?.admitted === true;
}

export async function admitSessionStart(
  tx: postgres.TransactionSql,
  { uid, ip, gameId, now = Date.now() }: SessionAdmission,
): Promise<boolean> {
  const secret = process.env.MG_IP_HASH_SECRET;
  if (!secret) throw new Error('Missing required env var MG_IP_HASH_SECRET (see .env.example)');
  const at = new Date(now);
  const uidCutoff = new Date(now - SESSION_START_UID_WINDOW_MS);
  const ipCutoff = new Date(now - SESSION_START_IP_WINDOW_MS);
  const sweep = new Date(now - Math.max(SESSION_START_UID_WINDOW_MS, SESSION_START_IP_WINDOW_MS));
  const ipSubject = sessionIpSubject(ip, secret, at);
  const key = (kind: 'uid' | 'ip', subject: string) => `session-admit:${kind}:${subject}:${gameId}`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${key('uid', uid)}, 0))`;
  if ((await inWindow(tx, 'uid', uid, gameId, uidCutoff)) >= 1) return false;
  await tx`select pg_advisory_xact_lock(hashtextextended(${key('ip', ipSubject)}, 0))`;
  if (!(await hit(tx, 'ip', ipSubject, gameId, at, ipCutoff, sweep, SESSION_START_IP_MAX))) return false;
  return hit(tx, 'uid', uid, gameId, at, uidCutoff, sweep, 1);
}
