import { defineMiddleware } from 'astro:middleware';
import { ADSENSE_CLIENT, CDN_ORIGIN, SUPABASE_URL } from './lib/server/config';
import { createRequestClient } from './lib/server/supabase';
import { getProfile } from './lib/server/profiles';
import { applyDeviceHeaders, detectDevice } from './lib/server/device';
import { isSubmissionPreviewPath } from './lib/server/submissions';

const AD_FRAMES = ADSENSE_CLIENT ? ' https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com' : '';
const CSP = `frame-src ${CDN_ORIGIN}${AD_FRAMES}; frame-ancestors 'self'; object-src 'none'; base-uri 'self'`;
// The upload form (on the creator dashboard) previews the chosen file in a blob iframe so boot.js can capture a thumbnail.
const UPLOAD_CSP = `frame-src ${CDN_ORIGIN} blob:${AD_FRAMES}; frame-ancestors 'self'; object-src 'none'; base-uri 'self'`;
const UPLOAD_PAGES = new Set(['/me', '/upload']);
// UP-2b: the Files page PUTs assets to the signed URL the sign endpoint mints, which lives on the
// configured Supabase origin (its /storage/v1 routes). Self covers the sign/finalize JSON calls;
// nothing broader — every other page keeps the default connect-src.
const SUPABASE_ORIGIN = new URL(SUPABASE_URL).origin;
const ASSETS_CSP = `${CSP}; connect-src 'self' ${SUPABASE_ORIGIN}`;
const isAssetsPage = (pathname: string) => /^\/games\/[^/]+\/assets$/.test(pathname);

// Routes that don't need the visitor's identity (hot path: called every few seconds by every player).
const ANONYMOUS = new Set(['/api/telemetry']);
// Routes a signed-in user without a handle may still visit.
const ONBOARDING_OK = /^\/(onboarding|auth\/|api\/auth\/|api\/profile)/;

export const onRequest = defineMiddleware(async (ctx, next) => {
  const authHeaders = new Headers();
  const { pathname } = ctx.url;
  ctx.locals.supabase = createRequestClient(ctx.request, ctx.cookies, authHeaders);
  ctx.locals.user = null;
  ctx.locals.profile = null;
  ctx.locals.device = detectDevice(ctx.request.headers);

  if (isSubmissionPreviewPath(pathname)) {
    ctx.locals.user = { id: 'preview-owner', email: 'preview@meshground.local' };
    ctx.locals.profile = { id: 'preview-owner', handle: 'preview', role: 'user' };
  } else if (!ANONYMOUS.has(pathname)) {
    const { data } = await ctx.locals.supabase.auth.getClaims();
    const claims = data?.claims;
    if (claims?.sub) {
      ctx.locals.user = { id: claims.sub, email: (claims.email as string | undefined) ?? null };
      ctx.locals.profile = await getProfile(claims.sub);
      if (!ctx.locals.profile && ctx.request.method === 'GET' && !pathname.startsWith('/api/') && !ONBOARDING_OK.test(pathname)) {
        return ctx.redirect(`/onboarding?next=${encodeURIComponent(pathname + ctx.url.search)}`);
      }
    }
  }

  const res = await next();
  authHeaders.forEach((v, k) => res.headers.set(k, v));
  res.headers.set('Content-Security-Policy', UPLOAD_PAGES.has(pathname) ? UPLOAD_CSP : isAssetsPage(pathname) ? ASSETS_CSP : CSP);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  applyDeviceHeaders(res.headers, pathname);
  return res;
});
