import type { APIRoute } from 'astro';
import { getGame, rateGame } from '../../../../lib/server/games';

export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!locals.user) return new Response('Log in to rate games', { status: 401 });
  const game = await getGame(params.slug ?? '');
  if (!game) return new Response('Not found', { status: 404 });
  const { stars } = (await request.json().catch(() => ({}))) as { stars?: unknown };
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) return new Response('stars must be 1-5', { status: 400 });

  await rateGame(game.id, locals.user.id, n);
  const updated = (await getGame(game.id))!;
  return Response.json({ avgRating: updated.avgRating, ratingCount: updated.ratingCount, stage: updated.stage, stars: n });
};
