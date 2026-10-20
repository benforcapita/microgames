import { test, expect } from '@playwright/test';
import { shotPath } from './shots.mjs';

// MOB-1: the upload page must never scroll sideways on phones, before or after a game file is picked
// (the preview stage appears after the pick). Zoom stays locked by the MV-1 viewport meta.
const game = `<!doctype html><html><body style="margin:0"><canvas id="c" width="480" height="270"></canvas>
<script>const g=document.getElementById('c').getContext('2d');(function f(){g.fillStyle='#c4ff3d';g.fillRect(20,20,200,120);requestAnimationFrame(f);})();</script></body></html>`;

const overflow = (page) => page.evaluate(() => {
  const el = document.scrollingElement;
  const vw = el.clientWidth;
  const culprits = [...document.querySelectorAll('body *')]
    .filter((n) => n.getBoundingClientRect().right > vw + 0.5)
    .map((n) => `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : ''} right=${Math.round(n.getBoundingClientRect().right)}`);
  return { scrollWidth: el.scrollWidth, clientWidth: vw, culprits: culprits.slice(0, 8) };
});

test('upload page has no horizontal overflow at 360, 390 and 430 px', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  await page.goto('/login?mode=signup&next=/me');
  await page.locator('input[name="email"]').fill(`mob1-${stamp}@example.com`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(`mob1${stamp}`.slice(0, 32));
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/me(#upload)?$/);

  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('maximum-scale=1');
  expect(viewport).toContain('user-scalable=no');

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/me#upload');
    const before = await overflow(page);
    expect(before.scrollWidth, `${width}px before pick: ${before.culprits.join(' | ')}`).toBeLessThanOrEqual(before.clientWidth);
    await page.locator('input[name="game"]').setInputFiles({ name: 'g.html', mimeType: 'text/html', buffer: Buffer.from(game) });
    await expect(page.locator('#snap')).toBeVisible();
    await page.locator('#snap').scrollIntoViewIfNeeded();
    await page.screenshot({ path: shotPath(`mob-1-upload-${width}.png`) });
    const after = await overflow(page);
    console.log(`${width}px after pick: ${JSON.stringify(after)}`);
    expect(after.scrollWidth, `${width}px after pick: ${after.culprits.join(' | ')}`).toBeLessThanOrEqual(after.clientWidth);
  }
});
