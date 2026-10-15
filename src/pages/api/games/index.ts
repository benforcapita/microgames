import type { APIRoute } from 'astro';
import { createGame, deleteGame, getGame } from '../../../lib/server/games';
import { planGameUpload } from '../../../lib/server/submissions';

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData().catch(() => null);
  const result = await planGameUpload({
    user: locals.user,
    profile: locals.profile,
    form,
    findGame: async (key) => {
      const game = await getGame(key);
      return game ? { id: game.id, license: game.license } : null;
    },
    // EF-2 enqueues validate-game inside the games insert. Do not insert a
    // game_validations placeholder here. If a post-insert enqueue is ever
    // passed and fails, delete the pending game and its bundle.
    createGame,
    rollbackUpload: async (gameId) => {
      if (locals.user) await deleteGame(gameId, locals.user.id);
    },
  });
  if (result.type === 'redirect') return redirect(result.location, 303);
  const body = result.type === 'error' ? { error: result.error } : { errors: result.errors };
  return new Response(JSON.stringify(body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
