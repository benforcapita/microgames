import { test, expect } from '@playwright/test';
import { shotPath } from './shots.mjs';

// AS-4 QA (#65): long names wrap on phones, file names are rendered as text (never markup),
// and a failed scanner chunk shows a visible notice instead of silently dropping the warning.
const LONG = `very/long/${'x'.repeat(498)}.png`; // 512 chars, the DB maximum, no break opportunity
const XSS = `sprites/"><img src=x onerror="window.__xss=1">.png`;
const game = (paths) => `<!doctype html><html><body><canvas></canvas>
<script>${paths.map((p) => `fetch(${JSON.stringify(p)});`).join('')}</script></body></html>`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function signUp(page, tag) {
  const stamp = `${tag}${Date.now().toString(36)}`;
  await page.goto('/login?mode=signup&next=/upload');
  await page.locator('input[name="email"]').fill(`${stamp}@example.com`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(stamp.slice(0, 32));
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/upload$/);
  return stamp;
}
const pick = (page, paths) =>
  page.locator('input[name="game"]').setInputFiles({ name: 'g.html', mimeType: 'text/html', buffer: Buffer.from(game(paths)) });
const width = (page) => page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, view: document.scrollingElement.clientWidth }));
async function submit(page, title) {
  await page.locator('input[name="title"]').fill(title);
  await page.locator('#thumb-file').setInputFiles({ name: 't.png', mimeType: 'image/png', buffer: png });
  await page.locator('input[name="agree"]').check();
  await page.getByRole('button', { name: 'Submit for validation' }).click();
  await page.waitForURL(/\/submissions\//, { timeout: 30_000 });
}

test('a 512-character path wraps: no sideways scroll at 390 px on the upload and submission pages', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = await signUp(page, 'qal');
  await page.setViewportSize({ width: 390, height: 844 });
  await pick(page, [LONG]);
  const warn = page.locator('#asset-warnings');
  await expect(warn.getByRole('listitem')).toHaveText([LONG]);
  expect(await width(page)).toEqual({ scroll: 390, view: 390 });
  await page.screenshot({ path: shotPath('as-4-qa-upload-long-390.png'), fullPage: true });

  await submit(page, `QA long ${stamp}`);
  await expect(page.locator('#asset-warnings').getByRole('listitem')).toHaveText([LONG]);
  expect(await width(page)).toEqual({ scroll: 390, view: 390 });
  await page.screenshot({ path: shotPath('as-4-qa-submission-long-390.png'), fullPage: true });
});

test('file names render as literal text, never as markup, on both pages', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = await signUp(page, 'qax');
  await pick(page, [XSS]);
  const warn = page.locator('#asset-warnings');
  // The exact name is visible as text, and nothing was parsed out of it.
  await expect(warn.getByRole('listitem')).toHaveText([XSS]);
  expect(await warn.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss ?? null)).toBeNull();
  await warn.screenshot({ path: shotPath('as-4-qa-upload-escaped.png') });

  await submit(page, `QA xss ${stamp}`);
  const sub = page.locator('#asset-warnings');
  await expect(sub.getByRole('listitem')).toHaveText([XSS]);
  expect(await sub.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss ?? null)).toBeNull();
  await page.screenshot({ path: shotPath('as-4-qa-submission-escaped.png'), fullPage: true });
});

test('if the scanner chunk fails to load, a visible notice replaces the warning and submit still works', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = await signUp(page, 'qac');
  await page.route('**/asset-scan.*.js', (route) => route.abort());
  await pick(page, ['sprites/hero.png']);
  const warn = page.locator('#asset-warnings');
  await expect(warn).toBeVisible();
  await expect(warn).toHaveText("Couldn't check for missing files; the submission page will list them");
  await warn.screenshot({ path: shotPath('as-4-qa-upload-chunk-blocked.png') });
  await submit(page, `QA chunk ${stamp}`);
  await expect(page.locator('#asset-warnings').getByRole('listitem')).toHaveText(['sprites/hero.png']);
});
