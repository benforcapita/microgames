import type { APIRoute } from 'astro';
import type { EnrollResult, ReportedFactor, RequestAuth, VerifyResult } from '../../../../lib/auth-supabase';
import {
  enrollFailedPage,
  enrollQrPage,
  enrollRetryPage,
  enrollStartPage,
  gateAal1,
  plain,
  readForm,
  redirectInside,
} from '../../../../lib/auth-pages';

// First-factor enrollment. The QR is the data URI Auth returned, encoded
// for an img src. Leftover unverified factors are listed and left in place.
// A verified factor goes to the challenge page instead of enrolling another.

const FACTOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function report(auth: RequestAuth): Promise<ReportedFactor[] | undefined> {
  try {
    const listed = await auth.unverifiedFactors();
    if (listed.kind === 'denied') return undefined;
    return listed.unverified;
  } catch {
    return undefined;
  }
}

export const GET: APIRoute = async (context) => {
  const auth = context.locals.auth;
  if (!auth) return plain(404, 'Not found');
  const gate = await gateAal1(auth, context.url);
  if (gate.kind === 'response') return gate.response;
  if (gate.verifiedTotp) return redirectInside(context.url, 'mfa');
  const unverified = await report(auth);
  if (!unverified) return plain(404, 'Not found');
  return enrollStartPage(context.url, context.locals.csrfField, unverified);
};

export const POST: APIRoute = async (context) => {
  const auth = context.locals.auth;
  if (!auth) return plain(404, 'Not found');
  const gate = await gateAal1(auth, context.url);
  if (gate.kind === 'response') return gate.response;
  if (gate.verifiedTotp) return redirectInside(context.url, 'mfa');
  const form = await readForm(context.request);
  const field = context.locals.csrfField;
  if (form.code) {
    let verified: VerifyResult;
    try {
      verified = await auth.verifyTotp(form.factor ?? '', form.code);
    } catch {
      verified = { kind: 'denied' };
    }
    if (verified.kind === 'ok') return redirectInside(context.url, 'home');
    const unverified = (await report(auth)) ?? [];
    if (form.factor && FACTOR_ID.test(form.factor)) {
      return enrollRetryPage(context.url, field, unverified, form.factor);
    }
    return enrollFailedPage(context.url, field, unverified);
  }
  let enrolled: EnrollResult;
  try {
    enrolled = await auth.enrollTotp();
  } catch {
    enrolled = { kind: 'denied', unverified: [] };
  }
  if (enrolled.kind === 'denied') return enrollFailedPage(context.url, field, enrolled.unverified);
  return enrollQrPage(context.url, field, enrolled.unverified, enrolled.qrDataUri, enrolled.secret, enrolled.factorId);
};
