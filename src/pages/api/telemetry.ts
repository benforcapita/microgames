import type { APIRoute } from 'astro';
import {
  MG_UID_COOKIE,
  newUid,
  parseUid,
  sessionStartByIp,
  sessionStartByUid,
  telemetryByUid,
} from '../../lib/server/abuse';
import { getGame, recordTelemetry, type TelemetryType } from '../../lib/server/games';

const TYPES = new Set<TelemetryType>(['session_start', 'first_frame', 'start', 'complete', 'crash', 'heartbeat']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const POST: APIRoute = async (context) => {
  const { request, cookies, url } = context;

  let ip = 'unknown';
  try {
    ip = context.clientAddress || 'unknown';
  } catch {
    ip = 'unknown';
  }

  const rawUid = cookies.get(MG_UID_COOKIE)?.value;
  let uid = parseUid(rawUid);
  if (!uid) {
    uid = newUid();
    cookies.set(MG_UID_COOKIE, uid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
    });
  }

  if (!telemetryByUid.hit(uid)) {
    return new Response('Too many requests', { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as
    | { sessionId?: unknown; gameId?: unknown; type?: unknown; value?: unknown }
    | null;
  const sessionId = String(body?.sessionId ?? '');
  const gameId = String(body?.gameId ?? '');
  const type = String(body?.type ?? '') as TelemetryType;
  if (!UUID.test(sessionId) || !TYPES.has(type)) return new Response('Bad request', { status: 400 });
  if (type === 'session_start' && !(await getGame(gameId))) return new Response('Unknown game', { status: 404 });

  if (type === 'session_start') {
    if (!sessionStartByUid.hit(`${uid}:${gameId}`) || !sessionStartByIp.hit(`${ip}:${gameId}`)) {
      return new Response(null, { status: 204 });
    }
  }

  await recordTelemetry(sessionId, gameId, type, body?.value);
  return new Response(null, { status: 204 });
};
