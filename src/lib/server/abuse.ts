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
