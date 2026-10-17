import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { shotPath } from './shots.mjs';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

const GAMES = [
  { slug: 'stack-tower', title: 'Stack Tower' },
  { slug: 'neon-lanes', title: 'Neon Lanes' },
];

function databaseUrl() {
  const fromEnv = process.env.DATABASE_URL ?? '';
  if (/^postgresql:\/\/([^@/]*@)?(127\.0\.0\.1|localhost)[:/]/.test(fromEnv)) return fromEnv;
  return localSupabaseEnv().DATABASE_URL;
}

/** This spec plays on phones and desktops. It sets input_support itself so a prior suite cannot hide a game. */
async function markPlayable() {
  const sql = postgres(databaseUrl(), { prepare: false, max: 1 });
  try {
    const rows = await sql`
      update public.games set input_support = 'both'
      where slug in ('stack-tower', 'neon-lanes')
      returning slug`;
    if (rows.length !== GAMES.length) {
      throw new Error(`fullscreen spec needs ${GAMES.map((game) => game.slug).join(' and ')}; updated ${rows.length}`);
    }
  } finally {
    await sql.end();
  }
}

async function stageState(page) {
  return page.locator('#stage').evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const webkit = document.webkitFullscreenElement;
    return {
      position: style.position,
      zIndex: style.zIndex,
      width: box.width,
      height: box.height,
      overflow: getComputedStyle(document.body).overflow,
      native: document.fullscreenElement === el || webkit === el,
      label: document.getElementById('fullscreen')?.textContent ?? '',
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const orientation = window.screen?.orientation;
    if (!orientation || typeof orientation.lock !== 'function') {
      window.__fsLock = 'unsupported';
      return;
    }
    const lock = orientation.lock.bind(orientation);
    window.__fsLock = [];
    orientation.lock = (value) => {
      window.__fsLock.push(value);
      return Promise.race([
        Promise.resolve(lock(value)).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
    };
  });
});

test('fullscreen exit sits inside the stage for every game', async ({ page, browserName }, testInfo) => {
  const immersive = browserName === 'webkit' || testInfo.project.name === 'iphone';
  const project = testInfo.project.name || 'desktop';
  const exit = page.locator('#stage [data-fullscreen-exit]');

  for (const [index, game] of GAMES.entries()) {
    await markPlayable();
    await page.goto(`/play/${game.slug}`);
    await expect(page.locator('#stage')).toBeVisible();
    const toolbar = page.locator('#fullscreen');
    await expect(toolbar).toHaveText('⛶ Fullscreen');
    await expect(toolbar).toHaveAttribute('aria-label', 'Fullscreen');

    await toolbar.click();
    const frame = page.locator('iframe.mg-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    await expect(frame).toHaveAttribute('allow', 'autoplay; gamepad; accelerometer; gyroscope; fullscreen');
    expect(await frame.getAttribute('allowfullscreen')).not.toBeNull();
    await expect(toolbar).toHaveText('⛶ Exit fullscreen');
    await expect(toolbar).toHaveAttribute('aria-label', 'Exit fullscreen');

    const box = await stageState(page);
    const viewport = page.viewportSize();
    await expect(exit).toBeVisible();
    const placed = await exit.evaluate((el) => {
      const host = el.parentElement?.getBoundingClientRect();
      const button = el.getBoundingClientRect();
      return {
        inStage: el.parentElement?.id === 'stage',
        z: Number(getComputedStyle(el).zIndex),
        inside: !!host && button.top >= host.top - 1 && button.right <= host.right + 1 && button.bottom <= host.bottom + 1,
      };
    });
    expect(placed.inStage).toBe(true);
    expect(placed.z).toBeGreaterThan(0);
    expect(placed.z).toBeLessThan(1000);
    expect(placed.inside).toBe(true);
    if (immersive) {
      expect(box.native).toBe(false);
      expect(box.position).toBe('fixed');
      expect(box.zIndex).toBe('900');
      expect(box.overflow).toBe('hidden');
      expect(box.width).toBeGreaterThan((viewport?.width ?? 0) * 0.9);
      expect(box.height).toBeGreaterThan((viewport?.height ?? 0) * 0.9);
    } else {
      expect(box.native).toBe(true);
    }

    const locks = await page.evaluate(() => window.__fsLock);
    if (Array.isArray(locks)) expect(locks).toContain('landscape');

    await page.screenshot({ path: shotPath(`fs-1-${project}-${game.slug}.png`) });

    if (immersive && index === 1) await page.keyboard.press('Escape');
    else await exit.click();
    await expect(toolbar).toHaveText('⛶ Fullscreen');
    await expect(toolbar).toHaveAttribute('aria-label', 'Fullscreen');
    await expect(toolbar).toBeFocused();
    await expect(exit).toHaveCount(0);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    if (immersive) {
      expect(await page.locator('#stage').evaluate((el) => getComputedStyle(el).position)).toBe('relative');
      expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
    }
  }
});

test('restart keeps the exit button inside the stage', async ({ page, browserName }, testInfo) => {
  const immersive = browserName === 'webkit' || testInfo.project.name === 'iphone';
  await markPlayable();
  await page.goto('/play/stack-tower');
  const toolbar = page.locator('#fullscreen');
  const exit = page.locator('#stage [data-fullscreen-exit]');
  await expect(page.locator('#stage')).toBeVisible();
  await toolbar.click();
  await expect(exit).toBeVisible();
  const entered = await stageState(page);
  if (immersive) expect(entered.native).toBe(false);
  else expect(entered.native).toBe(true);

  await page.locator('iframe.mg-frame').evaluate((frame) => {
    frame.dataset.remountMark = '1';
  });
  // Restart lives in the toolbar, outside the fullscreened stage, so the click is delivered to that button.
  await page.locator('#restart').evaluate((button) => {
    button.click();
  });
  await expect(page.locator('iframe.mg-frame')).toHaveCount(1);
  await expect(page.locator('iframe[data-remount-mark]')).toHaveCount(0);

  await expect(exit).toBeVisible();
  expect(await exit.evaluate((button) => button.parentElement?.id)).toBe('stage');
  const stayed = await stageState(page);
  if (immersive) {
    expect(stayed.native).toBe(false);
    expect(stayed.position).toBe('fixed');
  } else {
    expect(stayed.native).toBe(true);
  }

  await exit.click();
  await expect(toolbar).toHaveText('⛶ Fullscreen');
  await expect(toolbar).toHaveAttribute('aria-label', 'Fullscreen');
  await expect(exit).toHaveCount(0);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  if (immersive) {
    expect(await page.locator('#stage').evaluate((el) => getComputedStyle(el).position)).toBe('relative');
  }
});

async function swipeInGame(page) {
  const box = await page.locator('iframe.mg-frame').boundingBox();
  const y = box.y + box.height * 0.62;
  const x1 = box.x + box.width * 0.2;
  const x2 = box.x + box.width * 0.8;
  // WebKit exposes taps only. A tap still starts in the iframe, which is the lead-in under test.
  if (page.context().browser().browserType().name() !== 'chromium') {
    await page.touchscreen.tap((x1 + x2) / 2, y);
    return;
  }
  // One continuous touch, the way Chrome flushes a swipe that started in a cross-origin
  // iframe when that frame's touch ack is behind. A later tap can then miss its click.
  const cdp = await page.context().newCDPSession(page);
  const move = (type, x) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y), radiusX: 2, radiusY: 2, force: 1, id: 1 }],
  });
  await move('touchStart', x1);
  for (let i = 1; i <= 6; i++) await move('touchMove', x1 + ((x2 - x1) * i) / 6);
  await move('touchEnd', x2);
}

test('a swipe in the game then a tap on the × leaves fullscreen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch !== true, 'phone touch only');
  const project = testInfo.project.name || 'touch';
  await markPlayable();
  await page.goto('/play/neon-lanes');
  await page.getByRole('button', { name: /Play / }).tap();
  const frame = page.frameLocator('iframe.mg-frame');
  await frame.locator('canvas').waitFor({ timeout: 30_000 });
  const toolbar = page.locator('#fullscreen');
  const exit = page.locator('#stage [data-fullscreen-exit]');
  await toolbar.tap();
  await expect(toolbar).toHaveAttribute('aria-label', 'Exit fullscreen');
  await expect(exit).toBeVisible();

  await swipeInGame(page);
  await page.screenshot({ path: shotPath(`fs-2a-${project}-before-exit.png`) });

  const box = await exit.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.screenshot({ path: shotPath(`fs-2a-${project}-after-exit.png`) });

  await expect(toolbar).toHaveAttribute('aria-label', 'Fullscreen');
  await expect(toolbar).toHaveText('⛶ Fullscreen');
  await expect(exit).toHaveCount(0);
  const closed = await page.evaluate(() => ({
    native: document.fullscreenElement,
    immersive: document.getElementById('stage')?.dataset.immersive ?? '',
  }));
  expect(closed.native).toBeNull();
  expect(closed.immersive).toBe('');

  const game = page.frames().find((entry) => /\/g\/.*index\.html/.test(entry.url()));
  await game.evaluate(() => {
    window.__mgPointers = 0;
    window.addEventListener('pointerdown', () => { window.__mgPointers += 1; }, true);
  });
  const stage = await page.locator('#stage').boundingBox();
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? '', {
    x: stage.x + stage.width / 2,
    y: stage.y + stage.height / 2,
  });
  expect(hit).toBe('IFRAME');
  await page.touchscreen.tap(stage.x + stage.width / 2, stage.y + stage.height * 0.62);
  await expect.poll(() => game.evaluate(() => window.__mgPointers)).toBeGreaterThan(0);
});
