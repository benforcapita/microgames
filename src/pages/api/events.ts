import type { APIRoute } from 'astro';
import { clientIp } from '../../lib/server/abuse';
import { handleSiteEvent } from '../../lib/server/site-events';

/** POST /api/events: error events only, never tied to a user. See handleSiteEvent for the contract. */
export const POST: APIRoute = async (context) => {
  let socketAddress: string | undefined;
  try {
    socketAddress = context.clientAddress;
  } catch {
    socketAddress = undefined;
  }
  return handleSiteEvent(context.request, { ip: clientIp(context.request.headers, socketAddress, Boolean(process.env.VERCEL)) });
};
