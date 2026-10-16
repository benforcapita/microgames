import type { APIRoute } from 'astro';
import type { EmailOtpType } from '@supabase/supabase-js';
import { parseCookieHeader } from '@supabase/ssr';
import { safeNext, withParams } from '../../lib/server/auth';
import { afterSignIn, callbackErrorCode, exchangeErrorCode, leftoverVerifierCookies, type AuthErrorCode } from '../../lib/server/google-auth';
import { getProfile } from '../../lib/server/profiles';

// Landing URL for magic links, signup confirmation emails and OAuth (Google).
// Handles PKCE (?code=), token-hash (?token_hash=&type=) and provider errors (?error=).
// Only fixed error codes go back to /login; raw Supabase/provider text is logged here and nowhere else.
export const GET: APIRoute = async ({ url, locals, redirect, request, cookies }) => {
  const next = safeNext(url.searchParams.get('next'));
  const fail = (error: AuthErrorCode) => redirect(withParams('/login', { error, next: next === '/' ? undefined : next }), 303);

  const providerError = url.searchParams.get('error');
  if (providerError) {
    console.warn('[auth/callback] provider error:', providerError, url.searchParams.get('error_code') ?? '');
    return fail(callbackErrorCode(providerError, url.searchParams.get('error_code')));
  }

  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  if (!code && !(tokenHash && type)) return fail('link_expired');

  const auth = locals.supabase.auth;
  const { data, error } = code ? await auth.exchangeCodeForSession(code) : await auth.verifyOtp({ token_hash: tokenHash!, type: type! });
  if (error) {
    console.warn('[auth/callback] exchange failed:', error.code ?? error.name, error.message);
    return fail(exchangeErrorCode(error));
  }

  // auth-js only removes the verifier it used (often just the legacy key); drop the per-flow slots and index too.
  const names = parseCookieHeader(request.headers.get('Cookie') ?? '').map((c) => c.name);
  for (const name of leftoverVerifierCookies(names)) cookies.delete(name, { path: '/' });

  const userId = data?.user?.id;
  return redirect(userId ? afterSignIn(!!(await getProfile(userId)), next) : next, 303);
};
