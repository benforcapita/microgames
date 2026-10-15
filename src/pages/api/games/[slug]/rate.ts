import type { APIRoute } from 'astro';
import { MG_UID_COOKIE, authorizeRating, newUid, parseUid, ratingGuard, secureCookie } from '../../../../lib/server/abuse';
import { getGame, rateGame, unrateGame } from '../../../../lib/server/games';

export const POST: APIRoute = async ({ params, request, locals, cookies, url }) => {
  if (!locals.user) return new Response('Log in to rate games', { status: 401 });
  const game = await getGame(params.slug ?? '');
  if (!game) return new Response('Not found', { status: 404 });

  const rawUid = cookies.get(MG_UID_COOKIE)?.value;
  let uid = parseUid(rawUid);
  if (!uid) {
    uid = newUid();
    cookies.set(MG_UID_COOKIE, uid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie(url.protocol, import.meta.env.PROD, Boolean(process.env.VERCEL)),
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
    });
  }

  const { stars } = (await request.json().catch(() => ({}))) as { stars?: unknown };
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) return new Response('stars must be 1-5', { status: 400 });

  const decision = authorizeRating(game.ownerId, locals.user.id, uid, game.id);
  if (!decision.ok) return new Response(decision.message, { status: decision.status });

  await rateGame(game.id, locals.user.id, n);
  const updated = (await getGame(game.id))!;
  return Response.json({ avgRating: updated.avgRating, ratingCount: updated.ratingCount, stage: updated.stage, stars: n });
};

// Remove my rating. Idempotent: 200 even if I had not rated; `removed` says whether anything changed.
// Respects the same per-device guard as POST (#9/#14): a device bound to another account for this game gets 409,
// so one browser can't be used to clear ratings across accounts. No cookie is minted here.
export const DELETE: APIRoute = async ({ params, locals, cookies }) => {
  if (!locals.user) return new Response('Log in to rate games', { status: 401 });
  const game = await getGame(params.slug ?? '');
  if (!game) return new Response('Not found', { status: 404 });
  const uid = parseUid(cookies.get(MG_UID_COOKIE)?.value);
  if (uid && !ratingGuard.allow(uid, game.id, locals.user.id)) {
    return new Response('Rated from this device by another account', { status: 409 });
  }

  const removed = await unrateGame(game.id, locals.user.id);
  const updated = (await getGame(game.id))!;
  return Response.json({ avgRating: updated.avgRating, ratingCount: updated.ratingCount, stage: updated.stage, stars: null, removed });
};
