import type { APIRoute } from 'astro';
import { safeNext, siteOrigin, withParams } from '../../../lib/server/auth';

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
  const emailRedirectTo = `${siteOrigin(url)}/auth/callback?next=${encodeURIComponent(next)}`;

  if (mode === 'password') {
    const { error } = await auth.signInWithPassword({ email, password });
    return error ? back({ error: error.message }) : redirect(next, 303);
  }
  if (mode === 'signup') {
    const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo } });
    if (error) return back({ error: error.message });
    // With email confirmations disabled Supabase returns a session immediately.
    return data.session ? redirect(withParams('/onboarding', { next }), 303) : back({ sent: 'signup' });
  }
  const { error } = await auth.signInWithOtp({ email, options: { emailRedirectTo } });
  return error ? back({ error: error.message }) : back({ sent: 'magic' });
};
