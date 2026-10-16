import type { APIRoute } from 'astro';
import { clientIp } from '../../lib/server/abuse';
import { parseSiteEvent, recordSiteEventBounded, siteEventsByIp, SITE_EVENT_MAX_DETAILS_BYTES } from '../../lib/server/site-events';
import { sessionUserId } from '../../lib/server/session-user';

/** POST /api/events: page_view | game_launch | error. awaits the insert (bounded at ~1.5s), then 204; a slow or failed write is dropped, never surfaced. */
export const POST: APIRoute = async (context) => {
  const { request, locals } = context;
  let socketAddress: string | undefined;
  try {
    socketAddress = context.clientAddress;
  } catch {
    socketAddress = undefined;
  }
  if (!siteEventsByIp.hit(clientIp(request.headers, socketAddress, Boolean(process.env.VERCEL)))) {
    return new Response('Too many requests', { status: 429 });
  }
  const raw = await request.text().catch(() => '');
  if (raw.length > SITE_EVENT_MAX_DETAILS_BYTES + 2048) return new Response('Payload too large', { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = parseSiteEvent(body);
  if (!parsed.ok) return new Response('Bad request', { status: 400 });

  // Session only (middleware verified the claims); the body can never set user_id.
  const userId = sessionUserId(locals.user?.id);
  const outcome = await recordSiteEventBounded(parsed.event, userId);
  if (outcome !== 'ok') console.warn(`[events] dropped (${outcome})`);
  return new Response(null, { status: 204 });
};
