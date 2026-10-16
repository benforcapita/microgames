// AU-1: the email/password form puts only fixed codes in /login?error= and the page shows only fixed text.
// Runs against the real built server and the LOCAL Supabase stack (real Auth errors).
import http from 'node:http';
import { test, expect } from '@playwright/test';

const CODES = ['invalid_email', 'password_too_short', 'invalid_credentials', 'email_not_confirmed', 'account_exists', 'weak_password', 'rate_limited', 'email_unavailable', 'signin_failed'];
// Raw GoTrue / supabase-js wording that must never appear in the URL or on the page.
const SUPABASE_TEXT = /Invalid login credentials|User already registered|already been registered|Email not confirmed|AuthApiError|rate limit|Password should|Internal Server Error|PKCE/i;
const FLASH = 'mg_login_email';
const unique = (tag) => `au1b+${tag}-${Date.now()}@example.test`;

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
  expect(u.searchParams.get('email')).toBeNull();
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

// --- The typed email never appears in a redirect URL or the final URL; it refills via a one-shot flash cookie ---

// Every response Location header seen during the flow (the POST's 303 and any later hops).
function locationsSeen(page) {
  const list = [];
  const listener = (res) => {
    const loc = res.headers().location;
    if (loc) list.push(loc);
  };
  page.on('response', listener);
  return { list, stop: () => page.off('response', listener) };
}

function expectNoEmailLeak(locations, finalUrl, email) {
  for (const loc of [...locations, finalUrl]) {
    expect(loc).not.toContain(email);
    expect(loc).not.toContain(encodeURIComponent(email));
    expect(new URL(loc, 'http://n.test').searchParams.get('email')).toBeNull();
  }
}

// Submit through the real page/form, recording all Location headers. `force` bypasses
// browser-side validation (e.g. the password minlength) so the server-side guard is reached.
// Resolves after landing on a failure (?error=/sent=) or /onboarding.
async function submitAudited(page, mode, email, password, { force = false } = {}) {
  const seen = locationsSeen(page);
  try {
    await page.goto(`/login?mode=${mode}`);
    await page.locator('input[name="email"]').fill(email);
    if (password !== null) await page.locator('input[name="password"]').fill(password);
    const form = page.locator('form[action="/api/auth/login"]');
    if (force) await form.evaluate((f) => f.submit());
    else await form.locator('button[type="submit"]').click();
    await page.waitForURL((u) => u.pathname === '/onboarding' || u.searchParams.has('error') || u.searchParams.has('sent'));
  } finally {
    seen.stop();
  }
  return seen.list;
}

// The flashed email refills the input exactly once; a /login reload no longer has it.
async function expectRefillOnce(page, email) {
  const input = page.locator('form[action="/api/auth/login"] input[name="email"]');
  await expect(input).toHaveValue(email);
  await page.reload();
  await expect(input).toHaveValue('');
}

// Raw POST so branches the form can't reach are still exercised (bogus mode, disallowed Host).
function postForm(base, form, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: u.origin, ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? '', setCookie: res.headers['set-cookie'] ?? [] }));
      },
    );
    req.on('error', reject);
    req.end(new URLSearchParams(form).toString());
  });
}

// The server must still flash the email via Set-Cookie (scoped to /login, one-shot, HttpOnly).
function expectFlashed(setCookie, email) {
  const c = setCookie.find((v) => v.startsWith(`${FLASH}=`));
  expect(c, JSON.stringify(setCookie)).toBeTruthy();
  const value = c.split(';')[0].slice(`${FLASH}=`.length);
  expect(decodeURIComponent(value)).toBe(email);
  expect(c).toMatch(/Path=\/login/i);
  expect(c).toMatch(/HttpOnly/i);
  expect(c).toMatch(/SameSite=Lax/i);
  expect(c).toMatch(/Max-Age=60/i);
}

test('bad email format: invalid_email, no email in any URL, refilled once from the flash cookie', async ({ page }) => {
  // A + and @ address that passes browser email validation but fails the server regex (no dot in the domain).
  const email = `au1b+badfmt-${Date.now()}@nodot`;
  const locations = await submitAudited(page, 'password', email, 'whatever-123');
  await expectFixed(page, 'invalid_email', 'Enter a valid email address.');
  expectNoEmailLeak(locations, page.url(), email);
  await expectRefillOnce(page, email);
});

test('short password: password_too_short, no email in any URL, refilled once', async ({ page }) => {
  const email = unique('shortpw');
  const locations = await submitAudited(page, 'signup', email, 'short', { force: true });
  await expectFixed(page, 'password_too_short', 'Password must be at least 8 characters.');
  expectNoEmailLeak(locations, page.url(), email);
  await expectRefillOnce(page, email);
});

test('wrong password: invalid_credentials, no email in any URL, refilled once', async ({ page }) => {
  const email = unique('wrongpw');
  const locations = await submitAudited(page, 'password', email, 'wrong-password-123');
  await expectFixed(page, 'invalid_credentials', "That email and password don't match.");
  expectNoEmailLeak(locations, page.url(), email);
  await expectRefillOnce(page, email);
});

test('sign-up with an existing email: account_exists, no email in any URL, refilled once', async ({ browser }) => {
  const email = unique('dupe');
  const first = await browser.newPage();
  await submit(first, 'signup', email, 'au1-pass-123');
  expect(new URL(first.url()).pathname).toBe('/onboarding');
  await first.close();
  const page = await browser.newPage();
  const locations = await submitAudited(page, 'signup', email, 'au1-pass-456');
  await expectFixed(page, 'account_exists', 'An account with this email already exists. Try logging in.');
  expectNoEmailLeak(locations, page.url(), email);
  await expectRefillOnce(page, email);
  await page.close();
});

test('magic link sent: the success redirect carries no email and the flash is still consumed once', async ({ page }) => {
  const email = unique('sent');
  const locations = await submitAudited(page, 'magic', email, null);
  expect(new URL(page.url()).searchParams.get('sent')).toBe('magic');
  expectNoEmailLeak(locations, page.url(), email);
  await expect(page.locator('form[action="/api/auth/login"]')).toHaveCount(0);
  await page.goto('/login');
  await expect(page.locator('input[name="email"]')).toHaveValue('');
});

test('a real password sign-in lands on next with no email anywhere and no flash left behind', async ({ browser }) => {
  const email = unique('ok');
  const first = await browser.newPage();
  await submit(first, 'signup', email, 'au1-pass-123');
  expect(new URL(first.url()).pathname).toBe('/onboarding');
  await first.close();
  const page = await browser.newPage();
  const seen = locationsSeen(page);
  try {
    await page.goto('/login?next=%2Fme');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill('au1-pass-123');
    await page.locator('form[action="/api/auth/login"] button[type="submit"]').click();
    await page.waitForURL((u) => u.pathname === '/onboarding' || u.pathname === '/me');
  } finally {
    seen.stop();
  }
  expectNoEmailLeak(seen.list, page.url(), email);
  expect((await page.context().cookies()).filter((c) => c.name === FLASH)).toEqual([]);
  await page.close();
});

test('branches the form cannot reach (bogus mode, disallowed Host) still flash the email, never put it in the URL', async ({ baseURL }) => {
  const badMode = unique('badmode');
  const r1 = await postForm(baseURL, { mode: 'bogus', email: badMode, password: 'au1-pass-123' });
  expect(r1.status).toBe(303);
  expect(new URL(r1.location, baseURL).searchParams.get('error')).toBe('invalid_email');
  expectNoEmailLeak([r1.location], new URL(r1.location, baseURL).href, badMode);
  expectFlashed(r1.setCookie, badMode);

  // A Host that is not an allowlisted portal origin: authEmailRedirect returns null -> email_unavailable.
  // Origin must equal that Host's origin or the built server's Origin check 403s first.
  const unavail = unique('unavail');
  const r2 = await postForm(baseURL, { mode: 'magic', email: unavail }, { host: 'portal.evil.example', origin: 'http://portal.evil.example' });
  expect(r2.status).toBe(303);
  expect(new URL(r2.location, baseURL).searchParams.get('error')).toBe('email_unavailable');
  expectNoEmailLeak([r2.location], r2.location, unavail);
  expectFlashed(r2.setCookie, unavail);
});
