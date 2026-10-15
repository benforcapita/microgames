import { defineMiddleware } from 'astro:middleware';
import { ADSENSE_CLIENT, CDN_ORIGIN } from './lib/server/config';
import { createRequestClient } from './lib/server/supabase';
import { getProfile } from './lib/server/profiles';

const AD_FRAMES = ADSENSE_CLIENT ? ' https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com' : '';
const CSP = `frame-src ${CDN_ORIGIN}${AD_FRAMES}; frame-ancestors 'self'; object-src 'none'; base-uri 'self'`;
// The upload page previews the chosen file in a blob iframe so boot.js can capture a thumbnail.
const UPLOAD_CSP = `frame-src ${CDN_ORIGIN} blob:${AD_FRAMES}; frame-ancestors 'self'; object-src 'none'; base-uri 'self'`;

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

  if (!ANONYMOUS.has(pathname)) {
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
  res.headers.set('Content-Security-Policy', pathname === '/upload' ? UPLOAD_CSP : CSP);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return res;
});
