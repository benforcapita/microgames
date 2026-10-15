// CM-1: pure core (only depends on the pure game-rules) for Supabase-managed site content (unit-tested without a DB).
// Everything coming out of here is plain strings meant for text interpolation. Nothing is ever
// rendered as HTML, and image URLs are only accepted from the public site-media bucket.
import { isListable } from './game-rules'; // pure too: the single PV-1 listing predicate

export const DEFAULT_LOCALE = 'en';
export const CONTENT_TTL_MS = 60_000;
/** PV-1: featured games must be listable (see isListable in game-rules.ts). */
export { LISTABLE_STAGES as PUBLISHED_STAGES } from './game-rules';
/** Thresholds for skipping a broken featured game; the values live in config.ts (FEATURED_BROKEN_*). */
export interface BrokenRules {
  minPlays: number;
  maxCrashRate: number;
}

export interface HeroContent {
  eyebrow: string;
  title_before: string;
  title_accent: string;
  title_after: string;
  lede: string;
}

export interface BannerContent {
  text: string;
  link_label: string;
  link_href: string;
  image_url: string;
  tone: 'info' | 'promo' | 'warning';
}

export interface ContentShapes {
  'home.hero': HeroContent;
  'home.banner': BannerContent;
}
export type ContentKey = keyof ContentShapes;

/** Today's hardcoded homepage copy: what renders when the tables are missing, empty or invalid. */
export const CONTENT_DEFAULTS: ContentShapes = {
  'home.hero': {
    eyebrow: 'No installs · no engines · just the web',
    title_before: 'The open ground for ',
    title_accent: 'instant 3D',
    title_after: ' web games.',
    lede: 'Tiny, strange, brilliant browser games, each one a single file that loads in seconds. Play them, rate them, and decide which ones make it out of the Proving Grounds.',
  },
  // An empty banner text means "no banner".
  'home.banner': { text: '', link_label: '', link_href: '', image_url: '', tone: 'info' },
};

const MAX_TEXT = 600;
const TONES = new Set(['info', 'promo', 'warning']);

export interface ContentRow {
  key: string;
  locale: string;
  value: unknown;
}

/** Plain text only: strips control chars; markup stays literal because callers interpolate it as text. */
export function cleanText(v: unknown, max = MAX_TEXT, trim = true): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return (trim ? t.trim() : t).slice(0, max);
}

/** Headline parts keep their edge spaces ("The open ground for " + accent + " web games."). */
const UNTRIMMED = new Set(['title_before', 'title_after']);

/** Only same-site paths ("/games") or https URLs; never javascript:, data:, protocol-relative, etc. */
export function safeHref(v: unknown): string {
  // Browsers drop tab/LF/CR anywhere in a URL, so "/\t/evil.com" would navigate to //evil.com: strip them first.
  const s = (cleanText(v, 500) ?? '').replace(/[\t\n\r]/g, '');
  if (/^\/(?![/\\])/.test(s)) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

export function siteMediaPrefix(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/site-media/`;
}

/** Accepts an image URL only if it lives under the site-media public prefix (same origin, no traversal). */
export function safeImageUrl(v: unknown, prefix: string): string {
  const s = cleanText(v, 1000);
  if (!s) return '';
  try {
    const u = new URL(s);
    const p = new URL(prefix);
    if (u.origin !== p.origin || u.username || u.password) return '';
    if (!u.pathname.startsWith(p.pathname) || u.pathname.length <= p.pathname.length) return '';
    if (/(^|\/)\.\.?(\/|$)|%2e|%2f|\\/i.test(u.pathname.slice(p.pathname.length))) return '';
    return u.href;
  } catch {
    return '';
  }
}

function pickRow(rows: ContentRow[], key: string, locale: string): unknown {
  const want = (l: string) => rows.find((r) => r.key === key && r.locale === l)?.value;
  return want(locale) ?? (locale === DEFAULT_LOCALE ? undefined : want(DEFAULT_LOCALE));
}

/**
 * locale -> 'en' -> hardcoded default. Each field falls back on its own, so a partial row
 * (e.g. only a new lede) keeps the other default strings.
 */
export function resolveContent<K extends ContentKey>(rows: ContentRow[], key: K, locale: string, mediaPrefix: string): ContentShapes[K] {
  const def = CONTENT_DEFAULTS[key];
  const raw = pickRow(rows, key, locale);
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [field, fallback] of Object.entries(def)) {
    const v = obj[field];
    if (field === 'link_href') out[field] = v === undefined ? fallback : safeHref(v);
    else if (field === 'image_url') out[field] = v === undefined ? fallback : safeImageUrl(v, mediaPrefix);
    else if (field === 'tone') out[field] = typeof v === 'string' && TONES.has(v) ? v : fallback;
    else out[field] = cleanText(v, MAX_TEXT, !UNTRIMMED.has(field)) ?? fallback;
  }
  if (key === 'home.banner' && !out.link_href) out.link_label = '';
  return out as unknown as ContentShapes[K];
}

export interface FeaturedRow {
  game_id: string;
  position: number;
  label: string | null;
  starts_at: string | Date | null;
  ends_at: string | Date | null;
  active: boolean;
}

export interface FeaturedCandidate {
  id: string;
  stage: string;
  plays: number;
  crashRate: number | null;
}

const ts = (v: string | Date | null) => (v === null ? null : new Date(v).getTime());

export function inWindow(row: Pick<FeaturedRow, 'starts_at' | 'ends_at'>, now: number): boolean {
  const s = ts(row.starts_at);
  const e = ts(row.ends_at);
  return (s === null || s <= now) && (e === null || now < e);
}

export function isBroken(g: Pick<FeaturedCandidate, 'plays' | 'crashRate'>, rules: BrokenRules): boolean {
  return g.plays >= rules.minPlays && (g.crashRate ?? 0) > rules.maxCrashRate;
}

/** Active, inside its window, listable (PV-1: live + headless passed), not broken; ordered by position. */
export function selectFeatured<G extends FeaturedCandidate>(rows: FeaturedRow[], games: G[], now: number, broken: BrokenRules): { game: G; label: string }[] {
  const byId = new Map(games.map((g) => [g.id, g]));
  return rows
    .filter((r) => r.active && inWindow(r, now))
    .sort((a, b) => a.position - b.position || a.game_id.localeCompare(b.game_id))
    .flatMap((r) => {
      const g = byId.get(r.game_id);
      if (!g || !isListable(g) || isBroken(g, broken)) return [];
      return [{ game: g, label: cleanText(r.label, 40) ?? '' }];
    });
}

/** Missing table / not in the PostgREST schema cache. */
export function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

/** Tiny TTL cache that also remembers failures (so a missing table isn't re-queried on every request). */
export function ttlCache<T>(load: () => Promise<T>, fallback: T, ttlMs = CONTENT_TTL_MS, now = () => Date.now()) {
  let value: T = fallback;
  let at = -Infinity;
  let inflight: Promise<T> | null = null;
  return async (): Promise<T> => {
    if (now() - at < ttlMs) return value;
    inflight ??= load()
      .catch((e) => {
        if (!isMissingTable(e)) console.warn('[content] falling back to defaults:', (e as Error)?.message ?? e);
        return fallback;
      })
      .then((v) => {
        value = v;
        at = now();
        inflight = null;
        return v;
      });
    return inflight;
  };
}
