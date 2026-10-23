import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { shotPath } from './shots.mjs';

/** Line boxes of the link's own text. A wrapped "Log in" is 2; nowrap keeps it at 1. */
async function lineCount(link: Locator): Promise<number> {
  return link.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length;
  });
}

// 390 is where Upload is back and the row is tight: dropping nowrap wraps Log in / Sign up
// without scrolling. 700 scrolls if the 740px section-link hide is removed. 320–360 scroll
// if Upload stays in the logged-out row.
const WIDTHS = [320, 340, 360, 390, 700] as const;

test('logged-out header stays one line and does not scroll sideways', async ({ page }) => {
  await page.goto('/login');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(fits, `${width}px scrollWidth`).toBe(true);
    const header = page.locator('header');
    const login = header.getByRole('link', { name: 'Log in', exact: true });
    const signup = header.getByRole('link', { name: 'Sign up', exact: true });
    await expect(login, `${width}px Log in`).toBeVisible();
    await expect(signup, `${width}px Sign up`).toBeVisible();
    expect(await lineCount(login), `${width}px Log in lines`).toBe(1);
    expect(await lineCount(signup), `${width}px Sign up lines`).toBe(1);
    const logoLeft = await header.locator('a.logo').evaluate((el) => el.getBoundingClientRect().left);
    expect(logoLeft, `${width}px logo inset`).toBeGreaterThanOrEqual(12);
    if (width === 320 || width === 390 || width === 700) {
      await page.screenshot({ path: shotPath(`ui-1-header-${width}.png`), fullPage: true });
    }
  }
});

async function expectNavAndUploadFit(page: Page): Promise<void> {
  const nav = page.locator('header nav');
  const widths = await nav.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(widths.scrollWidth, 'nav scrollWidth').toBeLessThanOrEqual(widths.clientWidth);
  const upload = page.locator('header').getByRole('link', { name: 'Upload', exact: true });
  await expect(upload, 'Upload').toBeVisible();
  const box = await upload.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error('Upload button has no box');
  expect(box.x, 'Upload left').toBeGreaterThanOrEqual(0);
  expect(box.y, 'Upload top').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'Upload right').toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, 'Upload bottom').toBeLessThanOrEqual(viewport.height);
}

test('logged-out header nav and Upload fit inside a 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await expectNavAndUploadFit(page);
});

test('logged-out header nav and Upload fit inside a 420px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 844 });
  await page.goto('/login');
  await expectNavAndUploadFit(page);
});

test('signed-in header nav and Upload fit inside a 420px viewport', async ({ page }) => {
  test.setTimeout(90_000);
  const handle = `h${randomBytes(3).toString('hex')}`;
  await page.setViewportSize({ width: 420, height: 844 });
  await page.goto('/login?mode=signup&next=/me');
  await page.locator('input[name="email"]').fill(`${handle}@example.test`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(handle);
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/me$/);
  await expect(page.locator('header').getByRole('link', { name: `@${handle}` })).toBeVisible();
  await expect(page.locator('header').getByRole('link', { name: 'Log in', exact: true })).toHaveCount(0);
  await expectNavAndUploadFit(page);
});
