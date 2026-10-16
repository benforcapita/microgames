import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  afterSignIn, AUTH_ERROR_TEXT, callbackErrorCode, exchangeErrorCode, googleEnabled, isAuthErrorCode, leftoverVerifierCookies, startGoogleSignIn,
} from './google-auth.ts';
import { safeNext } from './safe-next.ts';

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
    assert.equal(loginParams(await p).get('error'), 'bad_origin');
    assert.equal(f.calls.length, 0);
  });
  it('provider disabled: back to /login with the friendly message and next kept, no Supabase call', async () => {
    const { f, p } = start({ enabled: false, next: '/me' });
    const q = loginParams(await p);
    assert.equal(q.get('error'), 'google_unavailable');
    assert.equal(q.get('next'), '/me');
    assert.equal(f.calls.length, 0);
  });
  it('Supabase error, missing URL, or a failing settings lookup also land on the friendly message', async () => {
    for (const o of [{ auth: fakeAuth({ error: 'Unsupported provider' }) }, { auth: fakeAuth({ url: null }) }, { enabled: 'throw' as const }]) {
      assert.equal(loginParams(await start(o).p).get('error'), 'google_unavailable');
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
  it('maps provider ?error= to a fixed code', () => {
    assert.equal(callbackErrorCode('access_denied'), 'cancelled');
    assert.equal(callbackErrorCode('server_error'), 'signin_failed');
    assert.equal(callbackErrorCode('<script>x</script>'), 'signin_failed');
    assert.equal(callbackErrorCode('access_denied', 'otp_expired'), 'link_expired');
  });
  it('maps exchange failures by AuthError code to fixed codes; unknown errors get the generic retry code', () => {
    assert.equal(exchangeErrorCode({ code: 'pkce_code_verifier_not_found', name: 'AuthPKCECodeVerifierMissingError' }), 'other_browser');
    assert.equal(exchangeErrorCode({ code: 'flow_state_not_found' }), 'link_expired');
    assert.equal(exchangeErrorCode({ code: 'flow_state_expired' }), 'link_expired');
    assert.equal(exchangeErrorCode({ code: 'bad_code_verifier' }), 'signin_failed');
    assert.equal(exchangeErrorCode({ code: 'unexpected_failure' }), 'signin_failed');
    assert.equal(exchangeErrorCode({}), 'signin_failed');
    assert.equal(exchangeErrorCode(null), 'signin_failed');
  });
  it('every code has fixed text and no text echoes Supabase wording', () => {
    for (const [code, text] of Object.entries(AUTH_ERROR_TEXT)) {
      assert.ok(isAuthErrorCode(code) && text.length > 0);
      assert.doesNotMatch(text, /PKCE|verifier|flow state|Internal Server Error|SSR/i);
    }
    assert.equal(isAuthErrorCode('PKCE code verifier not found in storage.'), false);
    assert.equal(isAuthErrorCode('constructor'), false);
  });
  it('first-time users (no profile) go to onboarding, keeping next; returning users go to next', () => {
    assert.equal(afterSignIn(false, '/'), '/onboarding');
    assert.equal(afterSignIn(false, '/play/x'), '/onboarding?next=%2Fplay%2Fx');
    assert.equal(afterSignIn(true, '/play/x'), '/play/x');
  });
  it('finds all three PKCE verifier cookie kinds (and chunks), nothing else', () => {
    const names = ['sb-127-auth-token-code-verifier', 'sb-127-auth-token-flows-code-verifier', 'sb-127-auth-token-flow-0eee29dd328ad940f1ad4f419cb1f899-code-verifier',
      'sb-127-auth-token-code-verifier.0', 'sb-127-auth-token', 'sb-127-auth-token.0', 'mg_device', 'code-verifier'];
    assert.deepEqual(leftoverVerifierCookies(names), names.slice(0, 4));
  });
});

describe('next length cap', () => {
  it('a huge next falls back to / (no 431), a normal one passes', () => {
    assert.equal(safeNext('/' + 'a'.repeat(5000)), '/');
    assert.equal(safeNext('/' + 'a'.repeat(1023)), '/' + 'a'.repeat(1023));
    assert.equal(safeNext('/p?x=' + '%41'.repeat(300)), '/p?x=' + '%41'.repeat(300));
  });
});

describe('AU-1 email form errors', async () => {
  const { emailAuthErrorCode, authErrorText, AUTH_ERROR_TEXT: T } = await import('./google-auth.ts');
  it('maps AuthError codes to fixed codes; unknown -> signin_failed', () => {
    assert.equal(emailAuthErrorCode({ code: 'invalid_credentials' }), 'invalid_credentials');
    assert.equal(emailAuthErrorCode({ code: 'email_not_confirmed' }), 'email_not_confirmed');
    assert.equal(emailAuthErrorCode({ code: 'user_already_exists' }), 'account_exists');
    assert.equal(emailAuthErrorCode({ code: 'email_exists' }), 'account_exists');
    assert.equal(emailAuthErrorCode({ code: 'weak_password' }), 'weak_password');
    assert.equal(emailAuthErrorCode({ code: 'over_email_send_rate_limit' }), 'rate_limited');
    assert.equal(emailAuthErrorCode({ status: 429 }), 'rate_limited');
    assert.equal(emailAuthErrorCode({ code: 'unexpected_failure' }), 'signin_failed');
    assert.equal(emailAuthErrorCode(null), 'signin_failed');
  });
  it('/login text: known code -> its text; free text or unknown -> signin_failed; none -> null', () => {
    assert.equal(authErrorText('invalid_credentials'), T.invalid_credentials);
    assert.equal(authErrorText('Invalid login credentials'), T.signin_failed);
    assert.equal(authErrorText('__proto__'), T.signin_failed);
    assert.equal(authErrorText(null), null);
    assert.equal(authErrorText(''), null);
  });
});
