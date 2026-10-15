import type { APIRoute } from 'astro';
import type { EmailOtpType } from '@supabase/supabase-js';
import { safeNext, withParams } from '../../lib/server/auth';

// Landing URL for magic links and signup confirmation emails.
// Handles both PKCE (?code=) and token-hash (?token_hash=&type=) email templates.
export const GET: APIRoute = async ({ url, locals, redirect }) => {
  const next = safeNext(url.searchParams.get('next'));
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const auth = locals.supabase.auth;

  const { error } = code
    ? await auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: { message: url.searchParams.get('error_description') ?? 'Invalid or expired link.' } };

  return redirect(error ? withParams('/login', { error: error.message, next }) : next, 303);
};
