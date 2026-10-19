import type { APIRoute } from 'astro';
import { plain, redirectInside, signOutPage } from '../../../lib/auth-pages';

// Local scope only: this browser's session. sb-* cookies are cleared with
// the strict attributes and the browser is sent back to sign-in.

export const GET: APIRoute = (context) => {
  if (!context.locals.auth) return plain(404, 'Not found');
  return signOutPage(context.url, context.locals.csrfField);
};

export const POST: APIRoute = async (context) => {
  const auth = context.locals.auth;
  if (!auth) return plain(404, 'Not found');
  try {
    await auth.signOut('local');
  } catch {
    // The client still clears sb-* cookies when Auth is unreachable.
  }
  return redirectInside(context.url, 'signin');
};
