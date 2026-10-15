import { test, expect, devices } from '@playwright/test';
import postgres from 'postgres';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

const DESKTOP_UA = devices['Desktop Chrome'].userAgent;
const MOBILE_UA = devices['Pixel 5'].userAgent;

function databaseUrl() {
  const fromEnv = process.env.DATABASE_URL ?? '';
  if (/^postgresql:\/\/([^@/]*@)?(127\.0\.0\.1|localhost)[:/]/.test(fromEnv)) return fromEnv;
  return localSupabaseEnv().DATABASE_URL;
}

async function markStackTowerDesktop() {
  const sql = postgres(databaseUrl(), { prepare: false, max: 1 });
  try {
    // Local test database only. IS-1 owns the migration; this spec must not ship one.
    const [existing] = await sql`
      select 1 as ok from information_schema.columns
      where table_schema = 'public' and table_name = 'games' and column_name = 'input_support'`;
    if (!existing) await sql.unsafe(`alter table public.games add column input_support text default 'unknown'`);
    const rows = await sql`
      update public.games set input_support = 'desktop'
      where id = 'stk7wr01'
      returning slug, title, input_support`;
    if (!rows.length) throw new Error('seed game stk7wr01 is missing; start from a seeded local stack');
  } finally {
    await sql.end();
  }
}

function expectVariance(headers) {
  const vary = headers['vary'] ?? '';
  expect(vary.toLowerCase()).toContain('sec-ch-ua-mobile');
  expect(vary.toLowerCase()).toContain('user-agent');
  expect((headers['accept-ch'] ?? '').toLowerCase()).toContain('sec-ch-ua-mobile');
  expect((headers['critical-ch'] ?? '').toLowerCase()).toContain('sec-ch-ua-mobile');
  expect(headers['cache-control'] ?? '').toMatch(/private/i);
  expect(headers['cache-control'] ?? '').toMatch(/no-store/i);
}

test.beforeAll(async () => {
  await markStackTowerDesktop();
});

test('catalog and play headers vary by client hint and user agent', async ({ request }) => {
  for (const path of ['/', '/games', '/proving', '/play/stack-tower']) {
    const res = await request.get(path, { headers: { 'user-agent': DESKTOP_UA, 'sec-ch-ua-mobile': '?0' } });
    expect(res.status(), path).toBeLessThan(400);
    expectVariance(res.headers());
  }
  const login = await request.get('/login', { headers: { 'user-agent': DESKTOP_UA } });
  expect(login.headers()['accept-ch'] ?? '').not.toContain('Sec-CH-UA-Mobile');
});

test('mobile requests drop desktop-only games; desktop requests keep them', async ({ request }) => {
  const mobile = await request.get('/games', {
    headers: { 'user-agent': MOBILE_UA, 'sec-ch-ua-mobile': '?1' },
  });
  const desktop = await request.get('/games', {
    headers: { 'user-agent': DESKTOP_UA, 'sec-ch-ua-mobile': '?0' },
  });
  const mobileHtml = await mobile.text();
  const desktopHtml = await desktop.text();
  expect(desktopHtml).toContain('Stack Tower');
  expect(desktopHtml).toContain('Neon Lanes');
  expect(mobileHtml).toContain('Neon Lanes');
  expect(mobileHtml).not.toContain('Stack Tower');

  // Hint wins over a desktop User-Agent.
  const hinted = await request.get('/games?tag=arcade', {
    headers: { 'user-agent': DESKTOP_UA, 'sec-ch-ua-mobile': '?1' },
  });
  const hintedHtml = await hinted.text();
  expect(hintedHtml).not.toContain('Stack Tower');
  expect(hintedHtml).toContain('Neon Lanes');

  // No hint: User-Agent fallback.
  const uaOnly = await request.get('/', { headers: { 'user-agent': MOBILE_UA } });
  expect(await uaOnly.text()).not.toContain('Stack Tower');

  const creator = await request.get('/u/polyprism', { headers: { 'user-agent': MOBILE_UA, 'sec-ch-ua-mobile': '?1' } });
  const creatorHtml = await creator.text();
  expect(creatorHtml).toContain('Prism Pop');
  expect(creatorHtml).not.toContain('Stack Tower');
});

const pixel = devices['Pixel 5'];
const desktopChrome = devices['Desktop Chrome'];

test.describe('desktop browser', () => {
  test.use({
    userAgent: desktopChrome.userAgent,
    viewport: desktopChrome.viewport,
    deviceScaleFactor: desktopChrome.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
    extraHTTPHeaders: { 'sec-ch-ua-mobile': '?0' },
  });

  test('play page shows the player', async ({ page }) => {
    const res = await page.goto('/play/stack-tower');
    expectVariance(res.headers());
    await expect(page.getByRole('button', { name: 'Play Stack Tower' })).toBeVisible();
    await expect(page.getByTestId('desktop-only')).toHaveCount(0);
    await page.screenshot({ path: 'docs/pr-assets/is-3-desktop-play.png', fullPage: true });
    await page.goto('/games');
    await expect(page.getByRole('link', { name: /Stack Tower/ })).toBeVisible();
    await page.screenshot({ path: 'docs/pr-assets/is-3-desktop-games.png', fullPage: true });
  });
});

test.describe('mobile browser', () => {
  test.use({
    userAgent: pixel.userAgent,
    viewport: pixel.viewport,
    deviceScaleFactor: pixel.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    extraHTTPHeaders: { 'sec-ch-ua-mobile': '?1' },
  });

  test('direct link shows a desktop-only notice instead of the player', async ({ page }) => {
    const res = await page.goto('/play/stack-tower', { waitUntil: 'networkidle' });
    expectVariance(res.headers());
    const notice = page.getByTestId('desktop-only');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Desktop only');
    await expect(notice).toContainText('Stack Tower');
    await expect(notice).toContainText(/open stack tower on a computer/i);
    await expect(notice.locator('img, svg').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play Stack Tower' })).toHaveCount(0);
    await expect(page.locator('iframe.mg-frame')).toHaveCount(0);
    await page.screenshot({ path: 'docs/pr-assets/is-3-mobile-notice.png', fullPage: true });

    await page.goto('/games');
    await expect(page.getByRole('link', { name: /Stack Tower/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Neon Lanes/ })).toBeVisible();
    await page.screenshot({ path: 'docs/pr-assets/is-3-mobile-games.png', fullPage: true });

    await page.goto('/');
    await expect(page.getByRole('link', { name: /Stack Tower/ })).toHaveCount(0);
    await page.screenshot({ path: 'docs/pr-assets/is-3-mobile-home.png', fullPage: true });
  });
});
