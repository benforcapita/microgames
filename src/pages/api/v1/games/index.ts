import type { APIRoute } from 'astro';
import { createGame, deleteGame, getGame, listGames, ownerReviewMarks } from '../../../../lib/server/games';
import { planGameUpload } from '../../../../lib/server/submissions';
import { apiGame, apiJson, apiWrites, readJson, requireApiCaller, siteOrigin } from '../../../../lib/server/api-v1';
import { publishForm } from '../../../../lib/api-games';

export const GET: APIRoute = async ({ request, url }) => {
  const caller = await requireApiCaller(request);
  if (caller instanceof Response) return caller;
  const games = await listGames({ ownerId: caller.user.id, sort: 'new', limit: 200, includeUnpublished: true });
  const marks = await ownerReviewMarks(games.map((g) => g.id));
  const origin = siteOrigin(url);
  return apiJson({ games: games.map((g) => apiGame(g, origin, marks.get(g.id)?.latestStatus ?? null)) });
};

export const POST: APIRoute = async ({ request, url }) => {
  const caller = await requireApiCaller(request);
  if (caller instanceof Response) return caller;
  if (!apiWrites.hit(caller.user.id)) return apiJson({ error: 'Too many uploads. Try again later.' }, 429);
  const parsed = publishForm(await readJson(request));
  if ('error' in parsed) return apiJson({ errors: [parsed.error] }, 400);

  const result = await planGameUpload({
    user: caller.user,
    profile: caller.profile,
    form: parsed.form,
    findGame: async (key) => {
      const game = await getGame(key);
      return game ? { id: game.id, license: game.license } : null;
    },
    createGame,
    rollbackUpload: async (gameId) => {
      await deleteGame(gameId, caller.user.id);
    },
  });
  if (result.type === 'error') return apiJson({ errors: [result.error] }, result.status);
  if (result.type === 'errors') return apiJson({ errors: result.errors }, result.status);
  const game = await getGame(result.gameId, { includeUnpublished: true });
  return apiJson({ game: game && apiGame(game, siteOrigin(url), null) }, 201);
};
