import { randomBytes, randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

const env = localSupabaseEnv();
if (!['127.0.0.1', 'localhost'].includes(new URL(env.DATABASE_URL).hostname)) throw new Error('local Supabase only');
const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
const CDN = `http://127.0.0.1:${process.env.E2E_CDN_PORT ?? 4722}`;
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><canvas id="c"></canvas><script>const g=document.getElementById("c").getContext("2d");(function f(){g.fillStyle="#c4ff3d";g.fillRect(0,0,40,40);requestAnimationFrame(f)})();</script></body></html>';
const sha = 'cd'.repeat(32);
const LISTING = /^\/($|games(?:\/|$)|proving(?:\/|$)|creators(?:\/|$)|u\/|play\/|sitemap|feed(?:\/|$)|rss|atom)/;

function freshToken() {
  return randomBytes(32).toString('base64url');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function asOwner(tx, ownerId) {
  await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
  await tx.unsafe('set local role authenticated');
}

async function mint(ownerId, versionId) {
  const [link] = await sql.begin(async (tx) => {
    await asOwner(tx, ownerId);
    return tx`select id, token from public.create_preview_link(${versionId}::uuid)`;
  });
  return link;
}

async function signature(request, path) {
  const started = performance.now();
  const res = await request.get(path);
  const body = await res.text();
  const headers = {};
  for (const [key, value] of Object.entries(res.headers())) {
    if (key === 'date') continue;
    headers[key] = value;
  }
  return { status: res.status(), body, headers, ms: performance.now() - started };
}

test.afterEach(async () => {
  await sql`delete from public.preview_page_hits`;
});

test.afterAll(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

test('a logged-out visitor can play a valid preview and cannot find the game anywhere else', async ({ page }) => {
  test.setTimeout(120_000);
  const ownerId = randomUUID();
  const gameId = `p${randomBytes(4).toString('hex')}`.slice(0, 12);
  const title = `Quarry ${gameId}`;
  const tag = `tg${gameId}`;
  const creator = `cr${gameId}`.slice(0, 32);
  const storage = createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from('games');
  let token = '';
  try {
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
    `;
    await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${creator})`;
    await sql`
      insert into public.games (id, slug, owner_id, creator, title, tags, stage, forked_from)
      values (${gameId}, ${gameId}, ${ownerId}::uuid, ${creator}, ${title}, ${[tag]}::text[], 'pending', 'stk7wr01')
    `;
    const [version] = await sql`
      insert into public.game_validations (game_id, version, bundle_sha256, status)
      values (${gameId}, 1, ${sha}, 'passed')
      returning id
    `;
    await sql`insert into public.featured_games (game_id, position, label, active) values (${gameId}, -1, 'hidden', true)`;
    const uploaded = await storage.upload(`${gameId}/index.html`, Buffer.from(html), { contentType: 'text/html; charset=utf-8', upsert: true });
    if (uploaded.error) throw uploaded.error;
    const link = await mint(ownerId, version.id);
    token = link.token;
    const expired = await mint(ownerId, version.id);
    await sql`update public.preview_links set expires_at = now() where id = ${expired.id}::uuid`;
    const revoked = await mint(ownerId, version.id);
    await sql.begin(async (tx) => {
      await asOwner(tx, ownerId);
      await tx`select public.revoke_preview_link(${revoked.id}::uuid)`;
    });

    const pages = [
      '/',
      '/games',
      '/games?sort=new',
      '/games?sort=rated',
      `/games?tag=${encodeURIComponent(tag)}`,
      `/games?q=${encodeURIComponent(title)}`,
      '/proving',
      '/creators',
      `/u/${creator}`,
      `/play/${gameId}`,
      '/play/stk7wr01',
      `/submissions/${gameId}`,
      '/sitemap.xml',
      '/sitemap-index.xml',
      '/feed.xml',
      '/rss.xml',
      '/atom.xml',
      '/feed',
      `/admin/games?q=${encodeURIComponent(title)}`,
    ];
    const apis = [
      '/api/v1/games',
      `/api/v1/games/${gameId}`,
      '/api/games',
      `/api/submissions/${gameId}`,
      `/api/saves/${gameId}`,
      `/api/games/${gameId}/assets`,
      `/api/games/${gameId}/rate`,
    ];
    const forbidden = [`/play/${gameId}`, `/g/${gameId}`, `/submissions/${gameId}`, `/games/${gameId}`];
    for (const path of pages) {
      const res = await page.goto(path);
      const body = await page.content();
      const here = new URL(page.url());
      if (here.pathname !== '/login') {
        for (const needle of forbidden) expect(body, path).not.toContain(needle);
      }
      const main = await page.locator('main').innerText();
      expect(main, path).not.toContain(title);
      const echoesTag = here.searchParams.get('tag') === tag;
      if (!echoesTag) expect(main, path).not.toContain(gameId);
      if (!path.includes(gameId) && !path.includes(encodeURIComponent(title))) expect(body, path).not.toContain(gameId);
      const og = [
        await page.locator('meta[property="og:title"]').getAttribute('content'),
        await page.locator('meta[property="og:description"]').getAttribute('content'),
        ...(await page.locator('meta[property="og:image"]').evaluateAll((els) => els.map((el) => el.getAttribute('content') ?? ''))),
      ];
      for (const value of og) {
        expect(value ?? '', path).not.toContain(title);
        expect(value ?? '', path).not.toContain(gameId);
      }
      expect(res?.headers()['x-robots-tag'] ?? '', path).not.toContain(title);
    }
    for (const path of apis) {
      const res = await page.request.get(path);
      const body = await res.text();
      expect(body, path).not.toContain(title);
      for (const needle of forbidden) expect(body, path).not.toContain(needle);
      if (!path.includes(gameId)) expect(body, path).not.toContain(gameId);
      expect(res.headers()['x-robots-tag'] ?? '', path).not.toContain(title);
    }
    expect((await page.request.get('/games')).headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');

    const played = await page.goto(`/p/${token}`);
    expect(played?.status()).toBe(200);
    expect(played?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect(played?.headers()['referrer-policy']).toBe('no-referrer');
    expect(played?.headers()['cache-control']).toContain('no-store');
    await expect(page.locator('#preview-banner')).toHaveText('Unreviewed, not yet approved');
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow');
    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
    const ogDescription = await page.locator('meta[property="og:description"]').getAttribute('content');
    expect(ogTitle ?? '').not.toContain(title);
    expect(ogDescription ?? '').not.toContain(title);
    expect(await page.locator('meta[property="og:image"]').count()).toBe(0);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.getByText('Your rating').count()).toBe(0);
    expect(await page.getByText(/comment/i).count()).toBe(0);
    const hrefs = await page.locator('a').evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    for (const href of hrefs) {
      expect(new URL(href, 'http://local').pathname).not.toMatch(LISTING);
      expect(href).not.toContain(gameId);
      expect(href).not.toContain(title);
    }
    await page.getByRole('button', { name: 'Play' }).click();
    const frame = page.locator('iframe.mg-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    const src = await frame.getAttribute('src');
    expect(src).toContain(`${CDN}/g/${gameId}/`);
    expect(src).toContain('index.html');
    expect((await page.request.get(src.split('#')[0])).status()).toBe(200);
    const bare = new URL(src);
    bare.search = '';
    bare.hash = '';
    expect((await page.request.get(bare.toString())).status()).toBe(404);

    const unknown = `/p/${freshToken()}`;
    const paths = [unknown, `/p/${expired.token}`, `/p/${revoked.token}`, '/p/x', `/p/${'z'.repeat(80)}`];
    for (const path of paths) await signature(page.request, path);
    const misses = [];
    for (const path of paths) misses.push(await signature(page.request, path));
    for (const miss of misses) {
      expect(miss.status).toBe(misses[0].status);
      expect(miss.body).toBe(misses[0].body);
      expect(miss.headers).toEqual(misses[0].headers);
      expect(miss.status).toBe(404);
    }
    expect(misses[0].body).not.toMatch(/<a\b/i);
    expect(misses[0].body).toContain('name="robots" content="noindex, nofollow"');
    expect(misses[0].body).not.toContain(title);
    expect(misses[0].body).not.toContain(gameId);
    const durations = [];
    for (const path of [unknown, `/p/${expired.token}`, '/p/x']) {
      const samples = [];
      for (let n = 0; n < 3; n += 1) samples.push((await signature(page.request, path)).ms);
      durations.push(median(samples));
    }
    const fastest = Math.min(...durations);
    const slowest = Math.max(...durations);
    expect(slowest / fastest).toBeLessThan(12);

    await sql`update public.games set stage = 'rejected' where id = ${gameId}`;
    const rejected = await signature(page.request, `/p/${token}`);
    expect(rejected.status).toBe(misses[0].status);
    expect(rejected.body).toBe(misses[0].body);
    expect(rejected.headers).toEqual(misses[0].headers);
    await sql`update public.games set stage = 'pending' where id = ${gameId}`;
    await sql`
      insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies)
      values (${gameId}, ${sha}, 'nsfw', 'confirmed', true)
    `;
    const nsfw = await signature(page.request, `/p/${token}`);
    expect(nsfw.status).toBe(misses[0].status);
    expect(nsfw.body).toBe(misses[0].body);
    expect(nsfw.headers).toEqual(misses[0].headers);
  } finally {
    await sql`delete from public.games where id = ${gameId}`.catch(() => {});
    await sql`delete from public.profiles where id = ${ownerId}::uuid`.catch(() => {});
    await sql`delete from auth.users where id = ${ownerId}::uuid`.catch(() => {});
    await storage.remove([`${gameId}/index.html`]).catch(() => {});
  }
});

test('preview opens past 60 in a minute return 429', async ({ request }) => {
  test.setTimeout(120_000);
  for (let n = 0; n < 60; n += 1) {
    const res = await request.get(`/p/${freshToken()}`);
    expect(res.status()).toBe(404);
  }
  const blocked = await request.get(`/p/${freshToken()}`);
  const again = await request.get(`/p/${freshToken()}`);
  expect(blocked.status()).toBe(429);
  expect(again.status()).toBe(429);
  expect(await blocked.text()).toBe('Too many requests');
  expect(await again.text()).toBe('Too many requests');
  expect(blocked.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(again.headers()['x-robots-tag']).toBe(blocked.headers()['x-robots-tag']);
});
