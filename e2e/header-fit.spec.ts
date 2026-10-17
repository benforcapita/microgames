import { expect, test, type Locator } from '@playwright/test';
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
