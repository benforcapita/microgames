import crypto from 'node:crypto';

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

export const sessionStartByUid = createLimiter({ windowMs: 30 * 60_000, max: 1 });
export const sessionStartByIp = createLimiter({ windowMs: 60 * 60_000, max: 20 });
export const telemetryByUid = createLimiter({ windowMs: 60_000, max: 120 });
export const ratingGuard = createRatingGuard();

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

/**
 * Admit a session_start. A device may count once per window per game; the IP cap is a backstop.
 * The device slot is only consumed when the start is actually counted, so an IP-cap drop
 * does not lock the device out for the rest of the window.
 */
export function admitSessionStart(
  uid: string, ip: string, gameId: string,
  byUid: Limiter = sessionStartByUid, byIp: Limiter = sessionStartByIp,
): boolean {
  const uidKey = `${uid}:${gameId}`;
  if (!byUid.check(uidKey)) return false;
  if (!byIp.hit(`${ip}:${gameId}`)) return false;
  return byUid.hit(uidKey);
}
