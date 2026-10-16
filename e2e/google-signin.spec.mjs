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

const CODES = ['google_unavailable', 'bad_origin', 'cancelled', 'link_expired', 'other_browser', 'signin_failed'];
const SUPABASE_TEXT = /PKCE|verifier|flow state|Internal Server Error|code challenge|SSR frameworks|storage/i;

test('callback ?error= puts a fixed code in the URL and fixed text on the page, never the provider text', async ({ page }) => {
  await page.goto('/auth/callback?error=access_denied&error_description=%3Cb%3Eraw%20provider%20text%3C%2Fb%3E');
  expect(new URL(page.url()).searchParams.get('error')).toBe('cancelled');
  await expect(page.getByRole('alert')).toHaveText('Sign-in was cancelled.');
  await expect(page.locator('body')).not.toContainText('raw provider text');
});

test('a failed code exchange (no verifier, bogus code) shows a fixed code + text, never the Supabase message', async ({ page }) => {
  const res = await page.goto('/auth/callback?code=not-a-real-code&next=%2Fme');
  expect(res.status()).toBe(200);
  const u = new URL(page.url());
  expect(u.pathname).toBe('/login');
  expect(CODES).toContain(u.searchParams.get('error'));
  expect(decodeURIComponent(page.url())).not.toMatch(SUPABASE_TEXT);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SUPABASE_TEXT);
});

test('cross-site POST to /api/auth/google is rejected with 403 by the built server; same-site is not', async ({ request, baseURL }) => {
  const evil = await request.post('/api/auth/google', { form: { next: '/' }, headers: { Origin: 'https://evil.example' }, maxRedirects: 0 });
  expect(evil.status()).toBe(403);
  const ok = await request.post('/api/auth/google', { form: { next: '/' }, headers: { Origin: baseURL }, maxRedirects: 0 });
  expect(ok.status()).toBe(303);
});

test('a huge next falls back to / instead of a 431', async ({ request }) => {
  const r = await request.get(`/auth/callback?error=access_denied&next=/${'a'.repeat(9000)}`, { maxRedirects: 0 });
  expect(r.status()).toBe(303);
  expect(r.headers().location).toBe('/login?error=cancelled');
});

// Real PKCE exchange on the local stack (same /auth/callback code path as Google): magic link via local Mailpit.
async function magicLink(base, email) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ mode: 'magic', email, next: '/' }) });
  const jar = new Map(r.headers.getSetCookie().map((c) => c.split(';')[0].split(/=(.*)/s).slice(0, 2)));
  const M = process.env.MAILPIT_URL;
  for (let i = 0; i < 40; i++) {
    await new Promise((ok) => setTimeout(ok, 250));
    const list = await (await fetch(`${M}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (!list.messages?.length) continue;
    const msg = await (await fetch(`${M}/api/v1/message/${list.messages[0].ID}`)).json();
    const link = msg.Text.match(/https?:\/\/\S+/)[0];
    const v = await fetch(link, { redirect: 'manual' });
    return { jar, callback: v.headers.get('location') };
  }
  throw new Error('no magic link mail');
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const apply = (jar, res) => { for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split(/=(.*)/s); if (/Max-Age=0/i.test(c) || v === '') jar.delete(k); else jar.set(k, v); } };

test('real PKCE exchange: clears all verifier cookies, and next=//evil.com cannot redirect off-site after sign-in', async ({ baseURL }) => {
  test.skip(!process.env.MAILPIT_URL, 'needs the local stack (vmg.sh exec)');
  const email = `ga1-${Date.now()}@example.test`;
  // 1. First sign-in: three verifier cookies exist before the exchange, none survive it; new user goes to onboarding.
  const first = await magicLink(baseURL, email);
  const verifiers = [...first.jar.keys()].filter((k) => k.endsWith('-code-verifier'));
  expect(verifiers.length).toBe(3);
  const ex = await fetch(new URL(first.callback, baseURL), { redirect: 'manual', headers: { cookie: cookieHeader(first.jar) } });
  expect(ex.status).toBe(303);
  expect(ex.headers.get('location')).toBe('/onboarding');
  const cleared = ex.headers.getSetCookie().filter((c) => /-code-verifier=/.test(c) && /Max-Age=0/i.test(c)).map((c) => c.split('=')[0]);
  expect(cleared.sort()).toEqual(verifiers.sort());
  apply(first.jar, ex);
  expect([...first.jar.keys()].filter((k) => k.endsWith('-code-verifier'))).toEqual([]);
  // 2. Create the profile, so the next sign-in goes straight to `next`.
  const prof = await fetch(`${baseURL}/api/profile`, { method: 'POST', redirect: 'manual', headers: { origin: baseURL, cookie: cookieHeader(first.jar), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle: `ga1${Date.now() % 1e8}`, next: '/' }) });
  expect(prof.status).toBe(303);
  // 3. Second sign-in with next tampered to an off-site target on the callback URL: lands on a same-site path.
  // (Local Auth allows 2 emails/hour, so one target here; the other variants are unit-tested on safeNext.)
  {
    const evil = '//evil.com';
    await new Promise((ok) => setTimeout(ok, 1100)); // per-address email frequency
    const again = await magicLink(baseURL, email);
    const cb = new URL(again.callback, baseURL);
    cb.searchParams.set('next', evil);
    const r = await fetch(cb, { redirect: 'manual', headers: { cookie: cookieHeader(again.jar) } });
    expect(r.status, evil).toBe(303);
    expect(r.headers.get('location'), evil).toBe('/');
    // 4. Replaying the used code fails with a fixed code, never Supabase text.
    const replay = await fetch(cb, { redirect: 'manual', headers: { cookie: cookieHeader(again.jar) } });
    const loc = replay.headers.get('location');
    expect(CODES).toContain(new URL(loc, baseURL).searchParams.get('error'));
    expect(decodeURIComponent(loc)).not.toMatch(SUPABASE_TEXT);
  }
});
