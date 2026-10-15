import type { APIRoute } from 'astro';
import { createGame, getGame } from '../../../lib/server/games';
import { enqueueValidation } from '../../../lib/server/submissions-db';
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
    createGame,
    enqueueValidation,
  });
  if (result.type === 'redirect') return redirect(result.location, 303);
  return new Response(JSON.stringify({ errors: result.errors }), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
