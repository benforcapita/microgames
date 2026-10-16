// GA-1: Continue with Google, against the LOCAL stack, where the Google provider is not configured.
import { test, expect } from '@playwright/test';
import { shotPath } from './shots.mjs';

const UNAVAILABLE = "Google sign-in isn't available yet.";

for (const [name, path] of [['login', '/login'], ['signup', '/signup']]) {
  test(`${name}: Continue with Google button above the unchanged email form`, async ({ page }) => {
    await page.goto(path);
    const btn = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await expect(btn).toBeVisible();
    await expect(btn.locator('svg path')).toHaveCount(4);
    expect(await btn.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(255, 255, 255)');
    await expect(page.locator('form[action="/api/auth/login"] input[name="email"]')).toBeVisible();
    for (const [vp, size] of [['desktop', { width: 1280, height: 800 }], ['390', { width: 390, height: 844 }]]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: shotPath(`ga-1-${name}-${vp}.png`), fullPage: true });
    }
  });
}

test('provider disabled (real local Auth): clicking returns to /login with a friendly message and keeps next', async ({ page }) => {
  await page.goto('/login?next=%2Fgames');
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('next')).toBe('/games');
  await expect(page.getByRole('alert')).toHaveText(UNAVAILABLE);
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeVisible();
});

test('callback ?error= shows a friendly message, never the provider text', async ({ page }) => {
  await page.goto('/auth/callback?error=access_denied&error_description=%3Cb%3Eraw%20provider%20text%3C%2Fb%3E');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('alert')).toHaveText('Sign-in was cancelled.');
  await expect(page.locator('body')).not.toContainText('raw provider text');
});

test('callback with a bogus OAuth code fails cleanly back to /login', async ({ page }) => {
  const res = await page.goto('/auth/callback?code=not-a-real-code&next=%2Fme');
  expect(res.status()).toBe(200);
  await expect(page).toHaveURL(/\/login\?.*error=/);
  await expect(page.getByRole('alert')).toBeVisible();
});
