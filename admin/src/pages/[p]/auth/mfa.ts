import type { APIRoute } from 'astro';
import type { VerifyResult } from '../../../lib/auth-supabase';
import { gateAal1, mfaPage, plain, readForm, redirectInside } from '../../../lib/auth-pages';

// TOTP challenge and verify for a factor that is already verified.
// Already at AAL2: 303 back to /<p>/. No verified factor: 303 to enroll.

export const GET: APIRoute = async (context) => {
  const auth = context.locals.auth;
  if (!auth) return plain(404, 'Not found');
  const gate = await gateAal1(auth, context.url);
  if (gate.kind === 'response') return gate.response;
  if (!gate.verifiedTotp) return redirectInside(context.url, 'enroll');
  return mfaPage(context.url, context.locals.csrfField, false);
};

export const POST: APIRoute = async (context) => {
  const auth = context.locals.auth;
  if (!auth) return plain(404, 'Not found');
  const gate = await gateAal1(auth, context.url);
  if (gate.kind === 'response') return gate.response;
  if (!gate.verifiedTotp) return redirectInside(context.url, 'enroll');
  const form = await readForm(context.request);
  let result: VerifyResult;
  try {
    result = await auth.verifyVerifiedTotp(form.code ?? '');
  } catch {
    return mfaPage(context.url, context.locals.csrfField, true);
  }
  switch (result.kind) {
    case 'ok':
      return redirectInside(context.url, 'home');
    case 'denied':
      return mfaPage(context.url, context.locals.csrfField, true);
    case 'no-factor':
      return redirectInside(context.url, 'enroll');
    default: {
      const unreachable: never = result;
      throw unreachable;
    }
  }
};
