import type { APIRoute } from 'astro';
import { getGame, recordTelemetry, type TelemetryType } from '../../lib/server/games';

const TYPES = new Set<TelemetryType>(['session_start', 'first_frame', 'start', 'complete', 'crash', 'heartbeat']);
const UUID = /^[0-9a-f-]{36}$/;

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as
    | { sessionId?: unknown; gameId?: unknown; type?: unknown; value?: unknown }
    | null;
  const sessionId = String(body?.sessionId ?? '');
  const gameId = String(body?.gameId ?? '');
  const type = String(body?.type ?? '') as TelemetryType;
  if (!UUID.test(sessionId) || !TYPES.has(type)) return new Response('Bad request', { status: 400 });
  if (type === 'session_start' && !getGame(gameId)) return new Response('Unknown game', { status: 404 });

  recordTelemetry(sessionId, gameId, type, Number(body?.value) || 0);
  return new Response(null, { status: 204 });
};
