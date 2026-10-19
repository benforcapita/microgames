import type { APIRoute } from 'astro';
import {
  MG_UID_COOKIE,
  admitSessionStart,
  clientIp,
  secureCookie,
  newUid,
  parseUid,
  telemetryByUid,
} from '../../lib/server/abuse';
import { getGame, recordTelemetry, type GameDb, type TelemetryType } from '../../lib/server/games';
import { hasAuthSessionCookie, sessionUserId } from '../../lib/server/session-user';

const TYPES = new Set<TelemetryType>(['session_start', 'first_frame', 'start', 'complete', 'crash', 'heartbeat', 'ready']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const POST: APIRoute = async (context) => {
  const { request, cookies, url, locals } = context;

  let socketAddress: string | undefined;
  try {
    socketAddress = context.clientAddress;
  } catch {
    socketAddress = undefined;
  }
  const ip = clientIp(request.headers, socketAddress, Boolean(process.env.VERCEL));

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

  let userId: string | null = null;
  // Identity is resolved only here. Heartbeats stay on the anonymous hot path.
  // No auth cookie means anonymous: skip getClaims and store a null user id.
  if (type === 'session_start' && hasAuthSessionCookie(request.headers.get('cookie'))) {
    const { data } = await locals.supabase.auth.getClaims();
    userId = sessionUserId(data?.claims?.sub);
  }

  // Creating a session row — by session_start, or by a first_frame that reached the DB
  // first — must pass the same admission: known game plus the session-start rate limits.
  // It runs inside recordTelemetry's session lock, so reads must go through `db`, the
  // lock-holding transaction — never the pool, which could be exhausted by other sessions.
  const admitNewSession = async (db: GameDb) =>
    Boolean(await getGame(gameId, { db })) && admitSessionStart(uid, ip, gameId);
  await recordTelemetry(sessionId, gameId, type, body?.value, userId, admitNewSession);
  return new Response(null, { status: 204 });
};
