// CM-1: Supabase-managed site content. Reads through the server (service-role) client with a ~60s
// in-memory cache; missing or empty tables fall back to today's hardcoded copy. See docs/CONTENT.md.
import { FEATURED_BROKEN_MAX_CRASH_RATE, FEATURED_BROKEN_MIN_PLAYS, SUPABASE_URL } from './config';
import {
  CONTENT_TTL_MS, PUBLISHED_STAGES, resolveContent, selectFeatured, siteMediaPrefix, ttlCache,
  type ContentKey, type ContentRow, type ContentShapes, type FeaturedRow,
} from './content-core';
import { sql } from './db';
import { visibleOnDevice, type DeviceKind } from './device';
import { listGamesByIds, type Game } from './games';
import { admin } from './supabase';

const MEDIA_PREFIX = siteMediaPrefix(SUPABASE_URL);

async function fetchRows<T>(table: string, columns: string): Promise<T[]> {
  const { data, error } = await admin.from(table).select(columns);
  if (error) throw error;
  return (data ?? []) as T[];
}

const g = globalThis as typeof globalThis & { __mgContent?: { content: () => Promise<ContentRow[]>; featured: () => Promise<FeaturedRow[]> } };
const caches = (g.__mgContent ??= {
  content: ttlCache(() => fetchRows<ContentRow>('site_content', 'key, locale, value'), [], CONTENT_TTL_MS),
  featured: ttlCache(() => fetchRows<FeaturedRow>('featured_games', 'game_id, position, label, starts_at, ends_at, active'), [], CONTENT_TTL_MS),
});

export async function getContent<K extends ContentKey>(key: K, locale = 'en'): Promise<ContentShapes[K]> {
  return resolveContent(await caches.content(), key, locale, MEDIA_PREFIX);
}

export async function getFeatured(limit = 8, device: DeviceKind = 'desktop'): Promise<{ game: Game; label: string }[]> {
  const rows = (await caches.featured()).filter((r) => r.active);
  if (!rows.length) return [];
  try {
    const ids = rows.map((r) => r.game_id);
    const [games, crash] = await Promise.all([
      listGamesByIds(ids, [...PUBLISHED_STAGES], device),
      sql<{ game_id: string; crash_rate: number | null }[]>`
        select game_id, avg(crashed::int)::float8 as crash_rate from sessions where game_id in ${sql(ids)} group by game_id`,
    ]);
    const rate = new Map(crash.map((c) => [c.game_id, c.crash_rate]));
    const candidates = games.map((x) => ({ ...x, crashRate: rate.get(x.id) ?? null }));
    return selectFeatured(rows, candidates, Date.now(), { minPlays: FEATURED_BROKEN_MIN_PLAYS, maxCrashRate: FEATURED_BROKEN_MAX_CRASH_RATE })
      .filter((item) => visibleOnDevice(item.game.inputSupport, device))
      .slice(0, limit);
  } catch (e) {
    console.warn('[content] featured games unavailable:', (e as Error)?.message ?? e);
    return [];
  }
}
