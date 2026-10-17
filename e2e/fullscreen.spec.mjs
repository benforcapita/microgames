import { test, expect } from '@playwright/test';
import { shotPath } from './shots.mjs';

const GAMES = [
  { slug: 'stack-tower', title: 'Stack Tower' },
  { slug: 'neon-lanes', title: 'Neon Lanes' },
];

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

test('fullscreen is the same for every game', async ({ page, browserName }, testInfo) => {
  const immersive = browserName === 'webkit' || testInfo.project.name === 'iphone';
  const project = testInfo.project.name || 'desktop';

  for (const [index, game] of GAMES.entries()) {
    await page.goto(`/play/${game.slug}`);
    await expect(page.locator('#stage')).toBeVisible();
    await expect(page.locator('#fullscreen')).toHaveText('⛶ Fullscreen');

    await page.locator('#fullscreen').click();
    const frame = page.locator('iframe.mg-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    await expect(frame).toHaveAttribute('allow', 'autoplay; gamepad; accelerometer; gyroscope; fullscreen');
    expect(await frame.getAttribute('allowfullscreen')).not.toBeNull();
    await expect(page.locator('#fullscreen')).toHaveText('⛶ Exit fullscreen');

    const box = await stageState(page);
    const viewport = page.viewportSize();
    if (immersive) {
      expect(box.native).toBe(false);
      expect(box.position).toBe('fixed');
      expect(box.zIndex).toBe('900');
      expect(box.overflow).toBe('hidden');
      expect(box.width).toBeGreaterThan((viewport?.width ?? 0) * 0.9);
      expect(box.height).toBeGreaterThan((viewport?.height ?? 0) * 0.9);
      await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    } else {
      expect(box.native).toBe(true);
    }

    const locks = await page.evaluate(() => window.__fsLock);
    if (Array.isArray(locks)) expect(locks).toContain('landscape');

    await page.screenshot({ path: shotPath(`fs-1-${project}-${game.slug}.png`) });

    if (immersive && index === 0) {
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    } else if (immersive) {
      await page.keyboard.press('Escape');
    } else {
      // Headless Chromium leaves fullscreen without the fullscreenchange event the
      // Fullscreen API fires. Dispatch the event the browser would, then check the label.
      await page.evaluate(async () => {
        if (typeof document.exitFullscreen === 'function') await document.exitFullscreen().catch(() => {});
        if (!document.fullscreenElement) document.dispatchEvent(new Event('fullscreenchange'));
      });
    }
    await expect(page.locator('#fullscreen')).toHaveText('⛶ Fullscreen');
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    if (immersive) {
      expect(await page.locator('#stage').evaluate((el) => getComputedStyle(el).position)).toBe('relative');
      expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
    }
  }
});
