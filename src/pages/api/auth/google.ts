import type { APIRoute } from 'astro';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../../lib/server/config';
import { googleEnabled, startGoogleSignIn } from '../../../lib/server/google-auth';

const providerEnabled = googleEnabled(SUPABASE_URL, SUPABASE_ANON_KEY);

/** POST /api/auth/google: start "Continue with Google" (PKCE; the verifier cookie is set by the SSR client). */
export const POST: APIRoute = async ({ request, locals, redirect, url }) => {
  const form = await request.formData().catch(() => null);
  const location = await startGoogleSignIn({
    auth: locals.supabase.auth,
    requestUrl: url,
    originHeader: request.headers.get('origin'),
    next: form?.get('next'),
    providerEnabled,
  });
  return redirect(location, 303);
};
