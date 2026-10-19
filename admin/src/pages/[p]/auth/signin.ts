import type { APIRoute } from 'astro';
import type { PasswordSignInResult } from '../../../lib/auth-supabase';
import { plain, readForm, redirectInside, signInPage } from '../../../lib/auth-pages';

// The form does not inspect an existing session. A successful password
// sign-in replaces it and sends Ben to enroll or to the TOTP challenge.

export const GET: APIRoute = (context) => signInPage(context.url, context.locals.csrfField, false);

export const POST: APIRoute = async (context) => {
  const auth = context.locals.auth;
  if (!auth) return plain(404, 'Not found');
  const form = await readForm(context.request);
  if (!form.email || !form.password) return signInPage(context.url, context.locals.csrfField, true);
  let result: PasswordSignInResult;
  try {
    result = await auth.signInWithPassword(form.email, form.password);
  } catch {
    return signInPage(context.url, context.locals.csrfField, true);
  }
  switch (result.kind) {
    case 'denied':
      return signInPage(context.url, context.locals.csrfField, true);
    case 'other-user':
      try {
        await auth.signOut();
      } catch {
        // Cookies are still cleared by the client.
      }
      return plain(404, 'Not found');
    case 'ben':
      return redirectInside(context.url, result.verifiedTotp ? 'mfa' : 'enroll');
    default: {
      const unreachable: never = result;
      throw unreachable;
    }
  }
};
