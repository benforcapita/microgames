import type { APIRoute } from 'astro';
import { getSave, parseSave, putSave } from '../../../lib/server/saves';
import { getGame } from '../../../lib/server/games';

// Cloud saves: the game's localStorage (shimmed by cdn/boot.js) persisted per user + game.
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 });
  const data = await getSave(locals.user.id, params.gameId ?? '');
  return Response.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } });
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 });
  const game = await getGame(params.gameId ?? '');
  if (!game) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
  const data = parseSave(body?.items);
  if (!data) return new Response('Invalid save (max 1 MB of string values)', { status: 400 });
  await putSave(locals.user.id, game.id, data);
  return new Response(null, { status: 204 });
};
