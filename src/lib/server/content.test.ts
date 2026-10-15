import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONTENT_DEFAULTS, inWindow, isBroken, isMissingTable, resolveContent, safeHref, safeImageUrl, selectFeatured, siteMediaPrefix, ttlCache,
  type ContentRow, type FeaturedRow,
} from './content-core.ts';

const RULES = { minPlays: 5, maxCrashRate: 0.5 }; // mirrors FEATURED_BROKEN_* in config.ts
const PREFIX = siteMediaPrefix('http://127.0.0.1:54321/');
const row = (key: string, locale: string, value: unknown): ContentRow => ({ key, locale, value });

describe('getContent fallbacks: locale -> en -> hardcoded default', () => {
  it('no rows (empty or missing table) gives today\'s copy', () => {
    assert.deepEqual(resolveContent([], 'home.hero', 'en', PREFIX), CONTENT_DEFAULTS['home.hero']);
    assert.equal(resolveContent([], 'home.banner', 'he', PREFIX).text, '');
  });
  it('prefers the requested locale, then en', () => {
    const rows = [row('home.hero', 'en', { lede: 'EN lede' }), row('home.hero', 'he', { lede: 'HE lede' })];
    assert.equal(resolveContent(rows, 'home.hero', 'he', PREFIX).lede, 'HE lede');
    assert.equal(resolveContent(rows, 'home.hero', 'fr', PREFIX).lede, 'EN lede');
  });
  it('partial rows keep the default for missing or invalid fields', () => {
    const r = resolveContent([row('home.hero', 'en', { lede: 'New', eyebrow: 42 })], 'home.hero', 'en', PREFIX);
    assert.equal(r.lede, 'New');
    assert.equal(r.eyebrow, CONTENT_DEFAULTS['home.hero'].eyebrow);
    assert.equal(r.title_accent, 'instant 3D');
  });
  it('headline parts keep their edge spaces; other fields are trimmed', () => {
    const r = resolveContent([row('home.hero', 'en', { title_before: 'Spooky ', title_after: ' games.', lede: '  hi  ' })], 'home.hero', 'en', PREFIX);
    assert.deepEqual([r.title_before, r.title_after, r.lede], ['Spooky ', ' games.', 'hi']);
  });
  it('non-object values fall back entirely', () => {
    for (const v of [null, 'str', [1, 2], 7]) assert.deepEqual(resolveContent([row('home.hero', 'en', v)], 'home.hero', 'en', PREFIX), CONTENT_DEFAULTS['home.hero']);
  });
  it('values stay text: markup is kept literally (Astro escapes it), control chars dropped', () => {
    const r = resolveContent([row('home.banner', 'en', { text: '<img src=x onerror=alert(1)>\u0000hi' })], 'home.banner', 'en', PREFIX);
    assert.equal(r.text, '<img src=x onerror=alert(1)>hi');
  });
  it('banner links: only same-site paths or https; label dropped without a link; unknown tone ignored', () => {
    assert.equal(safeHref('/games?sort=new'), '/games?sort=new');
    assert.equal(safeHref('https://example.com/x'), 'https://example.com/x');
    for (const bad of ['javascript:alert(1)', '//evil.com', '/\\evil.com', 'http://plain.com', 'data:text/html,x', ' JaVaScRiPt:1']) assert.equal(safeHref(bad), '', bad);
    for (const bad of ['/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/\t\\evil.com', '\t//evil.com', 'java\tscript:alert(1)', '/\r\n\t/evil.com'])
      assert.equal(safeHref(bad), '', JSON.stringify(bad));
    assert.equal(safeHref('/ga\tmes'), '/games', 'whitespace inside a same-site path is dropped like the browser would');
    const r = resolveContent([row('home.banner', 'en', { text: 'Hi', link_label: 'Go', link_href: 'javascript:1', tone: 'red' })], 'home.banner', 'en', PREFIX);
    assert.deepEqual([r.link_href, r.link_label, r.tone], ['', '', 'info']);
  });
});

describe('image URLs only from the site-media public prefix', () => {
  it('accepts site-media objects', () => {
    assert.equal(safeImageUrl(`${PREFIX}banners/halloween.webp`, PREFIX), `${PREFIX}banners/halloween.webp`);
  });
  it('rejects other origins, buckets, traversal and schemes', () => {
    for (const bad of [
      'https://evil.example/storage/v1/object/public/site-media/a.png',
      'http://127.0.0.1:9999/storage/v1/object/public/site-media/a.png',
      'http://127.0.0.1:54321/storage/v1/object/public/games/abc/index.html',
      'http://127.0.0.1:54321/storage/v1/object/public/site-media-evil/a.png',
      `${PREFIX}../games/x.png`, `${PREFIX}%2e%2e/games/x.png`, `${PREFIX}`,
      'http://user:pw@127.0.0.1:54321/storage/v1/object/public/site-media/a.png',
      'javascript:alert(1)', 'data:image/png;base64,AAAA', '/storage/v1/object/public/site-media/a.png', 42,
    ]) assert.equal(safeImageUrl(bad, PREFIX), '', String(bad));
    const r = resolveContent([row('home.banner', 'en', { text: 'x', image_url: 'https://evil.example/a.png' })], 'home.banner', 'en', PREFIX);
    assert.equal(r.image_url, '');
  });
});

describe('featured games', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const f = (game_id: string, position: number, extra: Partial<FeaturedRow> = {}): FeaturedRow =>
    ({ game_id, position, label: null, starts_at: null, ends_at: null, active: true, ...extra });
  const g = (id: string, stage = 'live', plays = 10, crashRate: number | null = 0) => ({ id, stage, plays, crashRate });

  it('time window: start inclusive, end exclusive, nulls open-ended', () => {
    assert.ok(inWindow({ starts_at: null, ends_at: null }, now));
    assert.ok(inWindow({ starts_at: new Date(now).toISOString(), ends_at: null }, now));
    assert.ok(!inWindow({ starts_at: '2026-10-16T00:00:00Z', ends_at: null }, now));
    assert.ok(!inWindow({ starts_at: null, ends_at: new Date(now).toISOString() }, now));
    assert.ok(inWindow({ starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' }, now));
  });
  it('keeps only active, in-window, published, non-broken games, ordered by position', () => {
    const rows = [
      f('c', 3), f('a', 1, { label: 'Staff pick' }), f('off', 0, { active: false }),
      f('future', 0, { starts_at: '2027-01-01T00:00:00Z' }), f('past', 0, { ends_at: '2026-01-01T00:00:00Z' }),
      f('pending', 0), f('broken', 0), f('gone', 0), f('b', 2),
    ];
    const games = [g('a'), g('b', 'proving'), g('c'), g('off'), g('future'), g('past'), g('pending', 'pending'), g('broken', 'live', 20, 0.9)];
    const out = selectFeatured(rows, games, now, RULES);
    assert.deepEqual(out.map((x) => x.game.id), ['a', 'b', 'c']);
    assert.equal(out[0].label, 'Staff pick');
  });
  it('config.ts holds the thresholds as named constants (5 plays, 50%)', async () => {
    const { readFileSync } = await import('node:fs');
    const cfg = readFileSync(new URL('./config.ts', import.meta.url), 'utf8');
    assert.match(cfg, /export const FEATURED_BROKEN_MIN_PLAYS = 5;/);
    assert.match(cfg, /export const FEATURED_BROKEN_MAX_CRASH_RATE = 0\.5;/);
  });
  it('broken = enough plays and a crash rate over the limit', () => {
    assert.ok(isBroken({ plays: 5, crashRate: 0.6 }, RULES));
    assert.ok(!isBroken({ plays: 4, crashRate: 1 }, RULES));
    assert.ok(!isBroken({ plays: 100, crashRate: null }, RULES));
  });
});

describe('missing tables never throw', () => {
  it('recognises 42P01 and PGRST205', () => {
    assert.ok(isMissingTable({ code: '42P01' }) && isMissingTable({ code: 'PGRST205' }) && !isMissingTable({ code: '23505' }) && !isMissingTable(null));
  });
  it('ttlCache returns the fallback on errors and caches for the TTL', async () => {
    let t = 0;
    let calls = 0;
    const get = ttlCache(async () => { calls++; throw Object.assign(new Error('relation "site_content" does not exist'), { code: '42P01' }); }, [] as ContentRow[], 60_000, () => t);
    assert.deepEqual(await get(), []);
    assert.deepEqual(await get(), []);
    assert.equal(calls, 1);
    t = 60_001;
    await get();
    assert.equal(calls, 2);
    assert.equal(resolveContent(await get(), 'home.hero', 'en', PREFIX).title_accent, 'instant 3D');
  });
  it('ttlCache serves fresh data after the TTL and dedupes concurrent loads', async () => {
    let t = 0;
    let n = 0;
    const get = ttlCache(async () => ++n, 0, 60_000, () => t);
    assert.deepEqual(await Promise.all([get(), get(), get()]), [1, 1, 1]);
    t = 30_000;
    assert.equal(await get(), 1);
    t = 61_000;
    assert.equal(await get(), 2);
  });
});
