import type { APIRoute } from 'astro';
import { clientIp } from '../../lib/server/abuse';
import { handleSiteEvent } from '../../lib/server/site-events';
import { sessionUserId } from '../../lib/server/session-user';

/** POST /api/events: page_view | game_launch | error. See handleSiteEvent for the contract. */
export const POST: APIRoute = async (context) => {
  let socketAddress: string | undefined;
  try {
    socketAddress = context.clientAddress;
  } catch {
    socketAddress = undefined;
  }
  return handleSiteEvent(context.request, {
    ip: clientIp(context.request.headers, socketAddress, Boolean(process.env.VERCEL)),
    // Session only (middleware verified the claims); the body can never set user_id.
    userId: sessionUserId(context.locals.user?.id),
  });
};
