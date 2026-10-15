import type { APIRoute } from 'astro';
import { MG_UID_COOKIE, authorizeRating, newUid, parseUid, secureCookie } from '../../../../lib/server/abuse';
import { getGame, rateGame } from '../../../../lib/server/games';

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
