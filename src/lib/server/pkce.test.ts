// GA-1: the app's real request client (src/lib/server/supabase.ts) must start OAuth with PKCE (S256).
// signInWithOAuth builds the URL locally, so no network or DB is needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ||= 'sb_publishable_test';
process.env.SUPABASE_SECRET_KEY ||= 'sb_secret_test';
process.env.DATABASE_URL ||= 'postgresql://u:p@127.0.0.1:1/db';
const { createRequestClient } = await import('./supabase.ts');

describe('GA-1 PKCE', () => {
  it('Google sign-in URL carries code_challenge_method=s256 and a code_challenge, and stores a verifier cookie', async () => {
    const set: string[] = [];
    const cookies = { set: (name: string) => set.push(name) };
    const client = createRequestClient(new Request('http://127.0.0.1/api/auth/google'), cookies as never, new Headers());
    const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'http://127.0.0.1/auth/callback?next=%2F', skipBrowserRedirect: true } });
    assert.equal(error, null);
    const u = new URL(data.url!);
    assert.equal(u.pathname, '/auth/v1/authorize');
    assert.equal(u.searchParams.get('provider'), 'google');
    assert.equal(u.searchParams.get('code_challenge_method')?.toLowerCase(), 's256');
    assert.match(u.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.ok(set.some((n) => n.endsWith('-code-verifier')), set.join(','));
  });
});
