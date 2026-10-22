import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
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

function ensureLoopbackAlias() {
  const add = ['addr', 'add', '127.0.0.2/8', 'dev', 'lo'];
  try {
    execFileSync('ip', add, { stdio: 'ignore' });
  } catch {
    try { execFileSync('sudo', ['-n', 'ip', ...add], { stdio: 'ignore' }); } catch { return; }
  }
}

function statusFrom(path, localAddress) {
  const port = Number(process.env.E2E_WEB_PORT ?? 4721);
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, localAddress, family: 4 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
  });
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
  const strangerId = randomUUID();
  const gameId = `p${randomBytes(4).toString('hex')}`.slice(0, 12);
  const title = `Quarry ${gameId}`;
  const handle = `cr${gameId}`.slice(0, 32);
  const controlId = `ln${randomBytes(4).toString('hex')}`;
  const controlTitle = `Lantern ${controlId}`;
  const apiToken = `mgp_${randomBytes(32).toString('base64url')}`;
  const apiHash = createHash('sha256').update(apiToken).digest('hex');
  const v1 = html.replace('</body>', 'BUNDLE-V1</body>');
  const v2 = v1.replace('BUNDLE-V1', 'BUNDLE-V2-FAILED');
  const storage = createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from('games');
  let token = '';
  try {
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
    `;
    await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${handle})`;
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${strangerId}::uuid, 'authenticated', 'authenticated', ${`${strangerId}@example.test`}, '', now(), now())
    `;
    await sql`insert into public.profiles (id, handle) values (${strangerId}::uuid, ${controlId})`;
    await sql`
      insert into public.games (id, slug, owner_id, creator, title, tags, stage, forked_from)
      values (${gameId}, ${gameId}, ${ownerId}::uuid, 'polyprism', ${title}, ${['arcade']}::text[], 'pending', 'stk7wr01')
    `;
    await sql`
      insert into public.games (id, slug, owner_id, creator, title, tags, stage)
      values (${controlId}, ${controlId}, ${strangerId}::uuid, ${controlId}, ${controlTitle}, '{}', 'live')
    `;
    await sql`
      insert into public.api_tokens (user_id, name, token_hash, prefix)
      values (${strangerId}::uuid, 'e2e', ${apiHash}, ${apiToken.slice(0, 10)})
    `;
    const [version] = await sql`
      insert into public.game_validations (game_id, version, bundle_sha256, status)
      values (${gameId}, 1, ${sha}, 'passed')
      returning id
    `;
    await sql`insert into public.featured_games (game_id, position, label, active) values (${gameId}, -1, 'hidden', true)`;
    for (const [path, body] of [[`${gameId}/1/index.html`, v1], [`${gameId}/index.html`, v2]]) {
      const uploaded = await storage.upload(path, Buffer.from(body), { contentType: 'text/html; charset=utf-8', upsert: true });
      if (uploaded.error) throw uploaded.error;
    }
    await sql`
      insert into public.game_validations (game_id, version, bundle_sha256, status)
      values (${gameId}, 2, ${'ef'.repeat(32)}, 'failed')
    `;
    const link = await mint(ownerId, version.id);
    token = link.token;
    const expired = await mint(ownerId, version.id);
    await sql`update public.preview_links set expires_at = now() where id = ${expired.id}::uuid`;
    const revoked = await mint(ownerId, version.id);
    await sql.begin(async (tx) => {
      await asOwner(tx, ownerId);
      await tx`select public.revoke_preview_link(${revoked.id}::uuid)`;
    });

    const listings = [
      { path: '/', control: 'Stack Tower' },
      { path: '/games', control: 'Stack Tower' },
      { path: '/games?sort=new', control: 'Stack Tower' },
      { path: '/games?sort=rated', control: 'Stack Tower' },
      { path: '/games?tag=arcade', control: 'Stack Tower' },
      { path: `/games?q=${encodeURIComponent(title)}`, control: 'Stack Tower' },
      { path: '/u/polyprism', control: 'Stack Tower' },
      { path: '/play/stk7wr01', control: 'Stack Tower' },
    ];
    for (const route of listings) {
      const res = await page.goto(route.path);
      expect(res?.status(), route.path).toBe(200);
      const body = await page.content();
      expect(body, route.path).toContain(route.control);
      expect(body, route.path).not.toContain(title);
      expect(body, route.path).not.toContain(gameId);
      const og = [
        await page.locator('meta[property="og:title"]').getAttribute('content'),
        await page.locator('meta[property="og:description"]').getAttribute('content'),
        ...(await page.locator('meta[property="og:image"]').evaluateAll((els) => els.map((el) => el.getAttribute('content') ?? ''))),
      ];
      for (const value of og) {
        expect(value ?? '', route.path).not.toContain(title);
        expect(value ?? '', route.path).not.toContain(gameId);
      }
      if (route.path === '/play/stk7wr01') {
        expect(res?.headers()['referrer-policy'], route.path).toBe('strict-origin-when-cross-origin');
        expect(res?.headers()['x-robots-tag'] ?? '', route.path).not.toContain('noindex');
      }
    }
    const proving = await page.goto('/proving');
    expect(proving?.status()).toBe(200);
    expect(proving?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(proving?.headers()['x-robots-tag'] ?? '').not.toContain('noindex');
    expect((await page.request.get('/games')).headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    const anonApi = await page.request.get('/api/v1/games');
    expect(anonApi.status()).toBe(401);
    const ownApi = await page.request.get('/api/v1/games', { headers: { authorization: `Bearer ${apiToken}` } });
    expect(ownApi.status()).toBe(200);
    const ownBody = await ownApi.text();
    expect(ownBody).toContain(controlTitle);
    expect(ownBody).not.toContain(title);
    expect(ownBody).not.toContain(gameId);

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
    await expect(frame).toHaveAttribute('src', new RegExp(`/g/${gameId}/1/index.html`));
    const src = await frame.getAttribute('src');
    if (!src) throw new Error('preview frame has no source');
    const frameUrl = new URL(src);
    expect(frameUrl.pathname).toBe(`/g/${gameId}/1/index.html`);
    const playedDoc = await page.request.get(src.split('#')[0]);
    expect(playedDoc.status()).toBe(200);
    const playedHtml = await playedDoc.text();
    expect(playedHtml).toContain('BUNDLE-V1');
    expect(playedHtml).not.toContain('BUNDLE-V2-FAILED');
    expect(await (await page.request.get(`${CDN}/g/${gameId}/2/index.html${frameUrl.search}`)).text()).not.toContain('BUNDLE-V2-FAILED');
    expect(await (await page.request.get(`${CDN}/g/${gameId}/index.html${frameUrl.search}`)).text()).not.toContain('BUNDLE-V2-FAILED');
    await expect(page.frameLocator('iframe.mg-frame').locator('canvas').first()).toBeVisible();
    const gameFrame = page.frames().find((f) => f.url().includes(`/g/${gameId}/1/index.html`));
    if (!gameFrame) throw new Error('preview frame did not load');
    await page.evaluate(() => {
      window.__mgOverlay = false;
      const obs = new MutationObserver(() => {
        if (document.querySelector('.mg-ad-overlay')) window.__mgOverlay = true;
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.__mgStopOverlay = () => obs.disconnect();
    });
    const adOutcome = await gameFrame.evaluate(() => new Promise((resolve) => {
      const seen = [];
      const timer = setTimeout(() => resolve(seen.join(',')), 1500);
      window.addEventListener('message', (event) => {
        const type = event.data && event.data.type;
        if (type !== 'AD_BREAK_DONE' && type !== 'REWARD_GRANTED' && type !== 'REWARD_DENIED') return;
        seen.push(type);
        if (seen.includes('AD_BREAK_DONE') && (seen.includes('REWARD_GRANTED') || seen.includes('REWARD_DENIED'))) {
          clearTimeout(timer);
          resolve(seen.join(','));
        }
      });
      parent.postMessage({ type: 'REQUEST_AD_BREAK' }, '*');
      parent.postMessage({ type: 'REQUEST_REWARD_AD' }, '*');
    }));
    const sawOverlay = await page.evaluate(() => {
      window.__mgStopOverlay();
      return window.__mgOverlay === true;
    });
    expect(adOutcome).toContain('AD_BREAK_DONE');
    expect(adOutcome).toContain('REWARD_GRANTED');
    expect(sawOverlay).toBe(false);
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
    await sql`delete from public.games where id in (${gameId}, ${controlId})`.catch(() => {});
    await sql`delete from public.profiles where id in (${ownerId}::uuid, ${strangerId}::uuid)`.catch(() => {});
    await sql`delete from auth.users where id in (${ownerId}::uuid, ${strangerId}::uuid)`.catch(() => {});
    await storage.remove([`${gameId}/index.html`, `${gameId}/1/index.html`]).catch(() => {});
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

test('a second loopback address keeps its own preview budget', async () => {
  test.setTimeout(120_000);
  ensureLoopbackAlias();
  for (let n = 0; n < 60; n += 1) expect(await statusFrom(`/p/${freshToken()}`, '127.0.0.1')).toBe(404);
  expect(await statusFrom(`/p/${freshToken()}`, '127.0.0.2')).toBe(404);
  expect(await statusFrom(`/p/${freshToken()}`, '127.0.0.1')).toBe(429);
});

test('a signed-in visitor without a handle still gets a preview miss', async ({ page }) => {
  test.setTimeout(90_000);
  const stamp = randomBytes(4).toString('hex');
  await page.goto('/login?mode=signup&next=/me');
  await page.locator('input[name="email"]').fill(`qa-${stamp}@example.com`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  const preview = await page.goto('/p/not-a-real-token');
  expect(preview?.status()).toBe(404);
  expect(page.url()).not.toContain('/onboarding');
  expect(await page.content()).toContain('This cartridge is missing.');
  await page.goto('/play/stk7wr01');
  expect(page.url()).toContain('/onboarding');
  await page.goto('/proving');
  expect(page.url()).toContain('/onboarding');
});
