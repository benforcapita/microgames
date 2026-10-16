import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  afterSignIn, callbackErrorMessage, googleEnabled, startGoogleSignIn,
  GOOGLE_BAD_ORIGIN, GOOGLE_UNAVAILABLE, LINK_EXPIRED, SIGN_IN_CANCELLED, SIGN_IN_FAILED,
} from './google-auth.ts';

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?x=1';
function fakeAuth(result: { url?: string | null; error?: string } = { url: GOOGLE }) {
  const calls: unknown[] = [];
  return {
    calls,
    auth: {
      async signInWithOAuth(args: unknown) {
        calls.push(args);
        return { data: { url: result.url ?? null }, error: result.error ? { message: result.error } : null };
      },
    },
  };
}
const start = (o: { origin?: string; next?: unknown; enabled?: boolean | 'throw'; auth?: ReturnType<typeof fakeAuth>; header?: string; nodeEnv?: string } = {}) => {
  const f = o.auth ?? fakeAuth();
  const p = startGoogleSignIn({
    auth: f.auth,
    requestUrl: new URL(`${o.origin ?? 'https://meshground.com'}/api/auth/google`),
    originHeader: o.header,
    next: o.next,
    nodeEnv: o.nodeEnv ?? 'production',
    providerEnabled: async () => { if (o.enabled === 'throw') throw new Error('net'); return o.enabled ?? true; },
  });
  return { f, p };
};
const loginParams = (loc: string) => { const u = new URL(loc, 'https://x'); assert.equal(u.pathname, '/login'); return u.searchParams; };

describe('GA-1 Continue with Google: start', () => {
  it('asks Supabase for Google with redirectTo = <origin>/auth/callback?next=<next>, then redirects to its URL', async () => {
    const { f, p } = start({ next: '/play/stack-tower?x=1' });
    assert.equal(await p, GOOGLE);
    assert.deepEqual(f.calls, [{ provider: 'google', options: { redirectTo: 'https://meshground.com/auth/callback?next=%2Fplay%2Fstack-tower%3Fx%3D1' } }]);
  });
  it('uses the local origin in dev', async () => {
    const { f, p } = start({ origin: 'http://127.0.0.1:4321', next: '/me', nodeEnv: 'development' });
    await p;
    assert.equal((f.calls[0] as any).options.redirectTo, 'http://127.0.0.1:4321/auth/callback?next=%2Fme');
  });
  it('sanitises a bad next to / (open-redirect attempts never reach redirectTo)', async () => {
    for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/\nx', undefined, 42]) {
      const { f, p } = start({ next });
      await p;
      assert.equal((f.calls[0] as any).options.redirectTo, 'https://meshground.com/auth/callback?next=%2F', String(next));
    }
  });
  it('refuses a non-allowlisted origin without calling Supabase', async () => {
    const { f, p } = start({ origin: 'https://evil.example', header: 'https://evil.example' });
    assert.equal(loginParams(await p).get('error'), GOOGLE_BAD_ORIGIN);
    assert.equal(f.calls.length, 0);
  });
  it('provider disabled: back to /login with the friendly message and next kept, no Supabase call', async () => {
    const { f, p } = start({ enabled: false, next: '/me' });
    const q = loginParams(await p);
    assert.equal(q.get('error'), GOOGLE_UNAVAILABLE);
    assert.equal(q.get('next'), '/me');
    assert.equal(f.calls.length, 0);
  });
  it('Supabase error, missing URL, or a failing settings lookup also land on the friendly message', async () => {
    for (const o of [{ auth: fakeAuth({ error: 'Unsupported provider' }) }, { auth: fakeAuth({ url: null }) }, { enabled: 'throw' as const }]) {
      assert.equal(loginParams(await start(o).p).get('error'), GOOGLE_UNAVAILABLE);
    }
  });
});

describe('GA-1 provider detection', () => {
  const settings = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('reads external.google from Auth settings', async () => {
    assert.equal(await googleEnabled('http://sb', 'k', settings({ external: { google: true } }))(), true);
    assert.equal(await googleEnabled('http://sb', 'k', settings({ external: { google: false, email: true } }))(), false);
    assert.equal(await googleEnabled('http://sb', 'k', settings({}, 500))(), false);
    assert.equal(await googleEnabled('http://sb', 'k', (async () => { throw new Error('down'); }) as never)(), false);
  });
});

describe('GA-1 callback', () => {
  it('maps ?error= to a friendly message and never echoes provider text', () => {
    assert.equal(callbackErrorMessage('access_denied'), SIGN_IN_CANCELLED);
    assert.equal(callbackErrorMessage('server_error'), SIGN_IN_FAILED);
    assert.equal(callbackErrorMessage('<script>x</script>'), SIGN_IN_FAILED);
    assert.equal(callbackErrorMessage('access_denied', 'otp_expired'), LINK_EXPIRED);
  });
  it('first-time users (no profile) go to onboarding, keeping next; returning users go to next', () => {
    assert.equal(afterSignIn(false, '/'), '/onboarding');
    assert.equal(afterSignIn(false, '/play/x'), '/onboarding?next=%2Fplay%2Fx');
    assert.equal(afterSignIn(true, '/play/x'), '/play/x');
  });
});
