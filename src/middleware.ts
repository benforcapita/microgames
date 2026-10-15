import { defineMiddleware } from 'astro:middleware';
import { ADSENSE_CLIENT, CDN_ORIGIN } from './lib/server/config';

const AD_FRAMES = ADSENSE_CLIENT ? ' https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com' : '';
const CSP = `frame-src ${CDN_ORIGIN}${AD_FRAMES}; frame-ancestors 'self'; object-src 'none'; base-uri 'self'`;

export const onRequest = defineMiddleware(async (ctx, next) => {
  let uid = ctx.cookies.get('mg_uid')?.value;
  if (!uid || !/^[0-9a-f-]{36}$/.test(uid)) {
    uid = crypto.randomUUID();
    ctx.cookies.set('mg_uid', uid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  }
  ctx.locals.uid = uid;

  const res = await next();
  res.headers.set('Content-Security-Policy', CSP);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return res;
});
