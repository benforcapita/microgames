// AU-1: the email/password form puts only fixed codes in /login?error= and the page shows only fixed text.
// Runs against the real built server and the LOCAL Supabase stack (real Auth errors).
import { test, expect } from '@playwright/test';

const CODES = ['invalid_email', 'password_too_short', 'invalid_credentials', 'email_not_confirmed', 'account_exists', 'weak_password', 'rate_limited', 'email_unavailable', 'signin_failed'];
// Raw GoTrue / supabase-js wording that must never appear in the URL or on the page.
const SUPABASE_TEXT = /Invalid login credentials|User already registered|already been registered|Email not confirmed|AuthApiError|rate limit|Password should|Internal Server Error|PKCE/i;

async function submit(page, mode, email, password) {
  await page.goto(`/login?mode=${mode}`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form[action="/api/auth/login"] button[type="submit"]').click();
  await page.waitForURL(/\/(login|onboarding)/);
}
async function expectFixed(page, code, text) {
  const u = new URL(page.url());
  expect(u.pathname).toBe('/login');
  expect(u.searchParams.get('error')).toBe(code);
  expect(CODES).toContain(u.searchParams.get('error'));
  expect(decodeURIComponent(page.url())).not.toMatch(SUPABASE_TEXT);
  await expect(page.getByRole('alert')).toHaveText(text);
  await expect(page.locator('body')).not.toContainText(SUPABASE_TEXT);
}

test('wrong password: fixed code + text, no Supabase message in URL or page', async ({ page }) => {
  await submit(page, 'password', `au1-nobody-${Date.now()}@example.test`, 'wrong-password-123');
  await expectFixed(page, 'invalid_credentials', "That email and password don't match.");
});

test('sign-up with an existing email: fixed code + text, no Supabase message', async ({ browser }) => {
  const email = `au1-${Date.now()}@example.test`;
  const first = await browser.newPage();
  await submit(first, 'signup', email, 'au1-pass-123');
  expect(new URL(first.url()).pathname).toBe('/onboarding');
  await first.close();
  const page = await browser.newPage();
  await submit(page, 'signup', email, 'au1-pass-456');
  await expectFixed(page, 'account_exists', 'An account with this email already exists. Try logging in.');
  await page.close();
});

test('/login renders only mapped codes: free text and unknown codes show the generic text', async ({ page }) => {
  for (const raw of ['Invalid login credentials', 'PKCE code verifier not found in storage.', 'not_a_code', '<b>x</b>']) {
    await page.goto(`/login?error=${encodeURIComponent(raw)}`);
    await expect(page.getByRole('alert')).toHaveText("Sign-in didn't work. Please try again.");
    await expect(page.locator('body')).not.toContainText(raw);
  }
  await page.goto('/login');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
