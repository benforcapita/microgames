import type { APIRoute } from 'astro';
import { getGame, replaceGameBundle } from '../../../../lib/server/games';
import { readSubmission } from '../../../../lib/server/submissions';
import { sqlSubmissionStore } from '../../../../lib/server/submissions-db';
import { gameFileErrors, readGameHtml, validateThumb } from '../../../../lib/server/upload';
import { apiGame, apiJson, apiWrites, readJson, requireApiCaller, siteOrigin } from '../../../../lib/server/api-v1';
import { updateFiles } from '../../../../lib/api-games';

/** One of the caller's games plus its latest validation (checks, headline), by id or slug. */
export const GET: APIRoute = async ({ request, params, url }) => {
  const caller = await requireApiCaller(request);
  if (caller instanceof Response) return caller;
  const game = await getGame(params.id ?? '', { includeUnpublished: true });
  if (!game || game.ownerId !== caller.user.id) return apiJson({ error: 'Game not found.' }, 404);
  const submission = await readSubmission({ userId: caller.user.id, gameId: game.id, store: sqlSubmissionStore });
  const view = submission.status === 200 ? submission.view : null;
  return apiJson({
    game: apiGame(game, siteOrigin(url), view?.validation?.status ?? null),
    validation: view && { headline: view.headline, detail: view.detail, phase: view.phase, checks: view.validation?.checks ?? [] },
  });
};

/** Replace an unpublished game's HTML (it goes back through validation), its thumbnail, or both. */
export const PUT: APIRoute = async ({ request, params, url }) => {
  const caller = await requireApiCaller(request);
  if (caller instanceof Response) return caller;
  if (!apiWrites.hit(caller.user.id)) return apiJson({ error: 'Too many uploads. Try again later.' }, 429);
  const files = updateFiles(await readJson(request));
  if ('error' in files) return apiJson({ errors: [files.error] }, 400);
  if (!files.game && !files.thumb) return apiJson({ errors: ['Send new html, a new thumbnail, or both.'] }, 400);

  let html;
  if (files.game) {
    const errors = gameFileErrors(files.game);
    if (errors.length) return apiJson({ errors }, 400);
    const read = await readGameHtml(files.game);
    if (read.error) return apiJson({ errors: [read.error] }, 400);
    html = read.html;
  }
  let thumb;
  if (files.thumb) {
    const checked = await validateThumb(files.thumb);
    if ('error' in checked) return apiJson({ errors: [checked.error] }, 400);
    thumb = checked.thumb;
  }

  const result = await replaceGameBundle({ gameKey: params.id ?? '', ownerId: caller.user.id, html, thumb });
  if (!result.ok) return apiJson({ error: result.error }, result.status);
  return apiJson({ game: apiGame(result.game, siteOrigin(url), null) });
};
