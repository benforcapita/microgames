import type { APIRoute } from 'astro';
import { createProfile } from '../../lib/server/profiles';
import { safeNext, withParams } from '../../lib/server/auth';

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  if (!locals.user) return redirect('/login', 303);
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '').trim();
  const next = safeNext(String(form.get('next') ?? ''));
  if (locals.profile) return redirect(next, 303);

  const { error } = await createProfile(locals.user.id, handle);
  return redirect(error ? withParams('/onboarding', { error, handle, next }) : next, 303);
};
