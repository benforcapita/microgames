import type { APIRoute } from 'astro';
import type { EmailOtpType } from '@supabase/supabase-js';
import { safeNext, withParams } from '../../lib/server/auth';
import { afterSignIn, callbackErrorMessage } from '../../lib/server/google-auth';
import { getProfile } from '../../lib/server/profiles';

// Landing URL for magic links, signup confirmation emails and OAuth (Google).
// Handles PKCE (?code=), token-hash (?token_hash=&type=) and provider errors (?error=).
export const GET: APIRoute = async ({ url, locals, redirect }) => {
  const next = safeNext(url.searchParams.get('next'));
  const oauthError = url.searchParams.get('error');
  if (oauthError) return redirect(withParams('/login', { error: callbackErrorMessage(oauthError, url.searchParams.get('error_code')), next: next === '/' ? undefined : next }), 303);

  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const auth = locals.supabase.auth;

  const { data, error } = code
    ? await auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await auth.verifyOtp({ token_hash: tokenHash, type })
      : { data: null, error: { message: 'Invalid or expired link.' } };

  if (error) return redirect(withParams('/login', { error: error.message, next }), 303);
  const userId = data?.user?.id;
  return redirect(userId ? afterSignIn(!!(await getProfile(userId)), next) : next, 303);
};
