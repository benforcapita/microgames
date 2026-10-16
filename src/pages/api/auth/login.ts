import type { APIRoute } from 'astro';
import { safeNext, withParams } from '../../../lib/server/auth';
import { authEmailRedirect } from '../../../lib/server/email-redirect';
import { emailAuthErrorCode, type AuthErrorCode } from '../../../lib/server/google-auth';

type Mode = 'password' | 'signup' | 'magic';
const MODES = new Set<Mode>(['password', 'signup', 'magic']);

export const POST: APIRoute = async ({ request, locals, redirect, url }) => {
  const form = await request.formData();
  const mode = String(form.get('mode')) as Mode;
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const next = safeNext(String(form.get('next') ?? ''));
  const back = (params: { error: AuthErrorCode } | { sent: 'signup' | 'magic' }) => redirect(withParams('/login', { mode, next, email, ...params }), 303);

  if (!MODES.has(mode) || !/^\S+@\S+\.\S+$/.test(email)) return back({ error: 'invalid_email' });
  if (mode !== 'magic' && password.length < 8) return back({ error: 'password_too_short' });
  // Only fixed codes reach the URL; the real Supabase message is logged here and nowhere else.
  const failed = (err: { code?: string; status?: number; message: string }) => {
    console.warn(`[auth/login] ${mode} failed:`, err.code ?? err.status ?? '', err.message);
    return back({ error: emailAuthErrorCode(err) });
  };

  const auth = locals.supabase.auth;

  if (mode === 'password') {
    const { error } = await auth.signInWithPassword({ email, password });
    return error ? failed(error) : redirect(next, 303);
  }

  // Sign-up and magic link. There is no reset-password route; if one is added it
  // must pass this same allowlisted emailRedirectTo and must not use the shared
  // project's Auth Site URL.
  const emailRedirectTo = authEmailRedirect({
    requestUrl: url,
    next,
    originHeader: request.headers.get('origin'),
  });
  if (!emailRedirectTo) return back({ error: 'email_unavailable' });

  if (mode === 'signup') {
    const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo } });
    if (error) return failed(error);
    // With email confirmations disabled Supabase returns a session immediately.
    return data.session ? redirect(withParams('/onboarding', { next }), 303) : back({ sent: 'signup' });
  }
  const { error } = await auth.signInWithOtp({ email, options: { emailRedirectTo } });
  return error ? failed(error) : back({ sent: 'magic' });
};
