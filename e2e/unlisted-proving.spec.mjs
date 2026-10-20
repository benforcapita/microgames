// PV-1: proving games are playable by direct link but unlisted everywhere except to their owner.
import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

const CDN = `http://127.0.0.1:${process.env.E2E_CDN_PORT ?? 4722}`;
const SEED_PROVING = { id: 'pr1smp0p', title: 'Prism Pop', creator: 'polyprism' }; // seed proving game, same creator as live Stack Tower
const env = localSupabaseEnv();
const html = '<!doctype html><html><head><meta charset="utf-8"><title>pv1</title></head><body><canvas id="c"></canvas><script>const g=document.getElementById("c").getContext("2d");(function f(){g.fillStyle="#c4ff3d";g.fillRect(0,0,50,50);requestAnimationFrame(f)})();</script></body></html>';

async function robots(page) {
  const m = page.locator('meta[name="robots"]');
  return (await m.count()) ? m.getAttribute('content') : null;
}

test('anonymous visitor: proving game is playable by direct link but listed nowhere', async ({ page }) => {
  const t = SEED_PROVING.title;
  for (const path of ['/', '/games', '/games?sort=new', `/u/${SEED_PROVING.creator}`, '/play/stk7wr01', '/proving']) {
    await page.goto(path);
    await expect(page.locator('main'), `${path} must not list ${t}`).not.toContainText(t);
  }
  // Live game page is indexable; related "more from polyprism" list omits the proving sibling (checked above).
  const liveRes = await page.goto('/play/stk7wr01');
  expect(await robots(page)).toBeNull();
  expect(liveRes.headers()['x-robots-tag']).toBeUndefined();

  // Direct link still works, but is noindex.
  const res = await page.goto(`/play/${SEED_PROVING.id}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
  await expect(page).toHaveURL(/\/play\/prism-pop$/);
  expect(await robots(page)).toBe('noindex, nofollow');
  await page.getByRole('button', { name: `Play ${t}` }).click();
  const src = await page.locator('iframe.mg-frame').getAttribute('src');
  expect(src).toContain(`${CDN}/g/${SEED_PROVING.id}/index.html`);
  expect((await page.request.get(src.split('#')[0])).status()).toBe(200);
});

test('owner sees their own proving game on profile and /proving; others do not', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const handle = `pv${stamp}`.slice(0, 32);
  const id = `pv1${stamp}`.slice(0, 32);
  const title = `Unlisted ${stamp}`;

  await page.goto('/login?mode=signup&next=/me');
  await page.locator('input[name="email"]').fill(`pv1-${stamp}@example.com`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(handle);
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/me(#upload)?$/);

  const sql = postgres(env.DATABASE_URL, { prepare: false });
  const storage = createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from('games');
  try {
    const [{ id: ownerId }] = await sql`select id from profiles where lower(handle) = lower(${handle})`;
    const { error } = await storage.upload(`${id}/index.html`, Buffer.from(html), { contentType: 'text/html; charset=utf-8', upsert: true });
    if (error) throw error;
    await sql`insert into games (id, slug, owner_id, creator, title, tagline, description, tags, license, stage, size_bytes, hue)
              values (${id}, ${id}, ${ownerId}, ${handle}, ${title}, 'pv1', 'pv1', ${['arcade']}, 'all-rights-reserved', 'proving', ${html.length}, 120)`;

    // Owner: visible on own profile and on /proving.
    await page.goto(`/u/${handle}`);
    await expect(page.locator('main')).toContainText(title);
    await page.goto('/proving');
    await expect(page.locator('main')).toContainText(title);
    await expect(page.locator('main')).not.toContainText(SEED_PROVING.title); // not the owner's game
    // Still not on the public feeds, even for the owner.
    for (const path of ['/', '/games']) {
      await page.goto(path);
      await expect(page.locator('main'), path).not.toContainText(title);
    }

    // Anonymous visitor: hidden on profile and /proving, playable by direct link.
    const anon = await browser.newContext();
    const ap = await anon.newPage();
    for (const path of [`/u/${handle}`, '/proving', '/', '/games']) {
      await ap.goto(path);
      await expect(ap.locator('main'), `anon ${path}`).not.toContainText(title);
    }
    const r = await ap.goto(`/play/${id}`);
    expect(r.status()).toBe(200);
    expect(r.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect(await robots(ap)).toBe('noindex, nofollow');
    expect((await ap.request.get(`${CDN}/g/${id}/index.html`)).status()).toBe(200);
    await anon.close();
  } finally {
    await sql`delete from games where id = ${id}`;
    await storage.remove([`${id}/index.html`]);
    await sql.end();
  }
});
