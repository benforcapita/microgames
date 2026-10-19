import type { APIRoute } from 'astro';
import { revokeApiToken } from '../../../../lib/server/api-tokens';

export const POST: APIRoute = async ({ params, locals, redirect }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 });
  await revokeApiToken(locals.user.id, params.id ?? '');
  return redirect('/me?revoked=1#mcp', 303);
};
