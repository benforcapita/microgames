import type { APIRoute } from 'astro';
import { revokePreviewLink, verifyGameOwner } from '../../../../../../lib/server/preview-links';

export const POST: APIRoute = async ({ params, locals }) => {
  if (!locals.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const gameId = typeof params.id === 'string' ? params.id : '';
  const linkId = typeof params.linkId === 'string' ? params.linkId : '';
  const ownerCheck = await verifyGameOwner({ gameId, userId: locals.user.id });
  if (ownerCheck.kind === 'error') {
    return Response.json({ error: ownerCheck.message }, { status: ownerCheck.status });
  }

  const result = await revokePreviewLink({
    supabase: locals.supabase,
    gameId,
    linkId,
    userId: locals.user.id,
  });

  if (result.kind === 'error') {
    return Response.json({ error: result.message }, { status: result.status });
  }

  return Response.json({ ok: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
};