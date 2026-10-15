import type { APIRoute } from 'astro';
import { safeNext, withParams } from '../../../lib/server/auth';
import { authEmailRedirect } from '../../../lib/server/email-redirect';

type Mode = 'password' | 'signup' | 'magic';
const MODES = new Set<Mode>(['password', 'signup', 'magic']);

export const POST: APIRoute = async ({ request, locals, redirect, url }) => {
  const form = await request.formData();
  const mode = String(form.get('mode')) as Mode;
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const next = safeNext(String(form.get('next') ?? ''));
  const back = (params: Record<string, string>) => redirect(withParams('/login', { mode, next, email, ...params }), 303);

  if (!MODES.has(mode) || !/^\S+@\S+\.\S+$/.test(email)) return back({ error: 'Enter a valid email address.' });
  if (mode !== 'magic' && password.length < 8) return back({ error: 'Password must be at least 8 characters.' });

  const auth = locals.supabase.auth;

  if (mode === 'password') {
    const { error } = await auth.signInWithPassword({ email, password });
    return error ? back({ error: error.message }) : redirect(next, 303);
  }

  // Sign-up and magic link. There is no reset-password route; if one is added it
  // must pass this same allowlisted emailRedirectTo and must not use the shared
  // project's Auth Site URL.
  const emailRedirectTo = authEmailRedirect({
    requestUrl: url,
    next,
    originHeader: request.headers.get('origin'),
  });
  if (!emailRedirectTo) return back({ error: "Sign-in email can't be sent from this address." });

  if (mode === 'signup') {
    const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo } });
    if (error) return back({ error: error.message });
    // With email confirmations disabled Supabase returns a session immediately.
    return data.session ? redirect(withParams('/onboarding', { next }), 303) : back({ sent: 'signup' });
  }
  const { error } = await auth.signInWithOtp({ email, options: { emailRedirectTo } });
  return error ? back({ error: error.message }) : back({ sent: 'magic' });
};
