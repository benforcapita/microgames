import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { authEmailRedirect, isAllowedEmailOrigin } from './email-redirect.ts';

const PROD = 'https://meshgrounds.vercel.app';
const PREVIEW = 'https://meshgrounds-git-cursor-sp-5b-benteam2.vercel.app';

function redirect(origin: string, next = '/onboarding', nodeEnv = 'production', originHeader?: string) {
  return authEmailRedirect({
    requestUrl: new URL(`${origin}/api/auth/login`),
    next,
    originHeader,
    nodeEnv,
  });
}

describe('auth email redirect allowlist', () => {
  it('builds sign-up and magic-link redirects from the request origin', () => {
    assert.equal(
      redirect(PROD, '/me'),
      `${PROD}/auth/callback?next=${encodeURIComponent('/me')}`,
    );
    assert.equal(
      redirect(PREVIEW, '/'),
      `${PREVIEW}/auth/callback?next=${encodeURIComponent('/')}`,
    );
  });

  it('allows localhost only in dev and never uses SITE_URL', () => {
    const previous = process.env.SITE_URL;
    process.env.SITE_URL = 'http://localhost:3000';
    try {
      assert.equal(redirect('http://localhost:4321', '/me', 'development'), 'http://localhost:4321/auth/callback?next=%2Fme');
      assert.equal(redirect('http://127.0.0.1:4321', '/', 'development'), 'http://127.0.0.1:4321/auth/callback?next=%2F');
      assert.equal(redirect('http://localhost:3000', '/', 'development'), 'http://localhost:3000/auth/callback?next=%2F');
      assert.equal(redirect('http://localhost:4321', '/', 'production'), null);
      assert.equal(redirect(PROD, '/me', 'production'), `${PROD}/auth/callback?next=%2Fme`);
    } finally {
      if (previous === undefined) delete process.env.SITE_URL;
      else process.env.SITE_URL = previous;
    }
  });

  it('uses an allowlisted Origin header when the request URL is not the public host', () => {
    const internal = authEmailRedirect({
      requestUrl: new URL('http://localhost:3000/api/auth/login'),
      next: '/upload',
      originHeader: PROD,
      nodeEnv: 'production',
    });
    assert.equal(internal, `${PROD}/auth/callback?next=${encodeURIComponent('/upload')}`);
  });

  it('rejects origins that are not the portal, a portal preview, or local dev', () => {
    const bad = [
      'https://evil.com',
      'https://meshgrounds.vercel.app.evil.com',
      'http://meshgrounds.vercel.app',
      'https://meshgrounds-cdn-git-foo-benteam2.vercel.app',
      'https://meshgrounds-x-benteam3.vercel.app',
      'https://MESHGROUNDS.vercel.app',
      'https://user@meshgrounds.vercel.app',
      'javascript:alert(1)',
      'http://localhost.evil.com',
      'https://localhost:4321',
    ];
    for (const origin of bad) assert.equal(isAllowedEmailOrigin(origin, true), false, origin);

    const rejectedUrls = [
      'https://evil.com',
      'https://meshgrounds.vercel.app.evil.com',
      'http://meshgrounds.vercel.app',
      'https://meshgrounds-cdn-git-foo-benteam2.vercel.app',
      'https://meshgrounds-x-benteam3.vercel.app',
      'http://localhost.evil.com',
      'https://localhost:4321',
    ];
    for (const origin of rejectedUrls) assert.equal(redirect(origin, '/', 'development'), null, origin);
  });

  it('drops an off-site next path', () => {
    assert.equal(
      redirect(PROD, 'https://evil.com/phish'),
      `${PROD}/auth/callback?next=${encodeURIComponent('/')}`,
    );
  });

  it('passes emailRedirectTo on sign-up and magic link, and there is no reset flow without it', () => {
    const login = readFileSync(new URL('../../pages/api/auth/login.ts', import.meta.url), 'utf8');
    const logout = readFileSync(new URL('../../pages/api/auth/logout.ts', import.meta.url), 'utf8');
    assert.match(login, /authEmailRedirect/);
    assert.match(login, /signUp\(\{ email, password, options: \{ emailRedirectTo \} \}/);
    assert.match(login, /signInWithOtp\(\{ email, options: \{ emailRedirectTo \} \}/);
    assert.doesNotMatch(login, /siteOrigin|SITE_URL|localhost:3000/);
    assert.doesNotMatch(`${login}\n${logout}`, /resetPasswordForEmail|recover\(/);
    const auth = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(auth, /siteOrigin|SITE_URL/);
  });
});
