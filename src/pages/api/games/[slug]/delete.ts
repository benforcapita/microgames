import type { APIRoute } from 'astro';
import { deleteGame, getGame } from '../../../../lib/server/games';

export const POST: APIRoute = async ({ params, locals, redirect }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 });
  const game = await getGame(params.slug ?? '', { includeUnpublished: true });
  if (!game || game.ownerId !== locals.user.id) return new Response('Not found', { status: 404 });
  await deleteGame(game.id, locals.user.id);
  return redirect('/me?deleted=1', 303);
};
