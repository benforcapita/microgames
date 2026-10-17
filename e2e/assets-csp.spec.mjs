// UP-2b: pin the Files-page CSP. Only /games/<slug>/assets may connect to Supabase Storage
// (the browser PUTs asset bytes to the signed URL on that origin): its connect-src is exactly
// 'self' plus the configured Supabase origin — no wildcard, no other origin. Every other route
// keeps the default CSP, which grants no connect-src at all. Asserted on the real built server.
import { randomBytes } from 'node:crypto';
import { test, expect, request as pwRequest } from '@playwright/test';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 4721}`;
const SUPABASE_ORIGIN = new URL(localSupabaseEnv().PUBLIC_SUPABASE_URL).origin;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const uniq = () => randomBytes(5).toString('hex');
const ctx = () => pwRequest.newContext({ baseURL: WEB, extraHTTPHeaders: { Origin: WEB } });

// 'self' is the only token a connect-src may ever carry besides the one Supabase origin.
const connectSrc = (csp) => {
  const directive = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
  return directive ? directive.split(/\s+/).slice(1) : null;
};

async function signup(c, tag) {
  const id = `${tag}${uniq()}`;
  const password = 'csp-pass-123';
  let r = await c.post('/api/auth/login', { multipart: { mode: 'signup', email: `csp-${id}@example.test`, password, next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'signup').toBe(303);
  r = await c.post('/api/profile', { multipart: { handle: `csp${id}`.slice(0, 32), next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'handle').toBe(303);
}

async function uploadGame(c, title) {
  const r = await c.post('/api/games', {
    maxRedirects: 0,
    multipart: {
      title,
      license: 'MIT',
      agree: 'on',
      game: { name: 'g.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><body>csp</body></html>') },
      thumb: { name: 't.png', mimeType: 'image/png', buffer: PNG },
    },
  });
  expect(r.status(), 'game upload').toBe(303);
  return new URL(r.headers()['location'], WEB).pathname.split('/')[2];
}

test.describe.configure({ mode: 'serial' });

test('UP-2b CSP: only the Files page may connect to the Supabase origin', async () => {
  const owner = await ctx();
  await signup(owner, 'own');
  const slug = await uploadGame(owner, `CSP ${uniq()}`);

  // The Files page itself: connect-src is exactly 'self' + the configured Supabase origin.
  const assets = await owner.get(`/games/${slug}/assets`, { maxRedirects: 0 });
  expect(assets.status(), 'files page').toBe(200);
  const csp = assets.headers()['content-security-policy'] ?? '';
  expect(connectSrc(csp), 'files page connect-src').toEqual(["'self'", SUPABASE_ORIGIN]);
  expect(csp).not.toContain('*');
  expect(csp).not.toContain('evil.example');

  // Every other route keeps the default CSP: no Supabase origin, no connect-src directive.
  const home = await owner.get('/', { maxRedirects: 0 });
  const defaultCsp = home.headers()['content-security-policy'] ?? '';
  expect(defaultCsp).not.toContain(SUPABASE_ORIGIN);
  expect(connectSrc(defaultCsp)).toBeNull();

  const routes = [
    '/login',
    '/upload',
    `/games/${slug}`,
    '/me',
    '/games/a/b/assets', // deeper path that is not the Files page
    `/games/${slug}/assets/`, // trailing slash must not match the Files page rule
    `/api/games/${slug}/assets/sign`, // API routes answer JSON, never the upload page's CSP
  ];
  for (const route of routes) {
    const res = await owner.get(route, { maxRedirects: 0 });
    const other = res.headers()['content-security-policy'] ?? '';
    expect(other, `${route} leaks the Supabase origin`).not.toContain(SUPABASE_ORIGIN);
    expect(other, `${route} gained a connect-src`).not.toContain('connect-src');
  }
});
