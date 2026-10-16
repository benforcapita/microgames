import { test, expect } from '@playwright/test';
import { shotPath } from './shots.mjs';

// AS-4: a game whose HTML references one file that is not uploaded gets a warning (never a block)
// on the upload page and on its submission page, with the whole-game total against 4 MB.
const game = `<!doctype html>
<html><head><meta charset="utf-8"><title>missing asset</title></head>
<body style="margin:0;background:#111">
<canvas id="c" width="480" height="270"></canvas>
<img id="hero" src="./sprites/hero.png" hidden>
<script>
const g = document.getElementById('c').getContext('2d');
function frame() { g.fillStyle = '#c4ff3d'; g.fillRect(40, 40, 200, 120); requestAnimationFrame(frame); }
frame();
</script>
</body></html>`;

test('one missing file is warned on upload and on the submission page, and submit still works', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  await page.goto('/login?mode=signup&next=/upload');
  await page.locator('input[name="email"]').fill(`as4-${stamp}@example.com`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(`as4${stamp}`.slice(0, 32));
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/upload$/);

  await page.locator('input[name="game"]').setInputFiles({ name: 'missing.html', mimeType: 'text/html', buffer: Buffer.from(game) });
  const warn = page.locator('#asset-warnings');
  await expect(warn).toBeVisible();
  await expect(warn).toContainText('1 referenced file(s) not uploaded yet');
  await expect(warn.getByRole('listitem')).toHaveText(['sprites/hero.png']);
  await expect(warn).toContainText(/Whole game: [\d.]+ (B|KB) \([\d,]+ bytes\) of 4 MB/);
  await warn.scrollIntoViewIfNeeded();
  await warn.screenshot({ path: shotPath('as-4-upload-missing-asset.png') });

  // Warning only: the form still submits.
  await page.locator('input[name="title"]').fill(`AS4 ${stamp}`);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('#thumb-file').setInputFiles({ name: 'thumb.png', mimeType: 'image/png', buffer: png });
  await page.locator('input[name="agree"]').check();
  await page.getByRole('button', { name: 'Submit for validation' }).click();
  await page.waitForURL(/\/submissions\//, { timeout: 30_000 });

  const subWarn = page.locator('#asset-warnings');
  await expect(subWarn).toContainText('1 referenced file(s) not uploaded yet');
  await expect(subWarn.getByRole('listitem')).toHaveText(['sprites/hero.png']);
  await expect(subWarn).toContainText(/Whole game: [\d.]+ (B|KB) \([\d,]+ bytes\) of 4 MB/);
  await page.screenshot({ path: shotPath('as-4-submission-missing-asset.png'), fullPage: true });
});
