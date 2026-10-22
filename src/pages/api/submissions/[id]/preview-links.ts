import type { APIRoute } from 'astro';
import { parsePreviewLinkTtl } from '../../../../lib/preview-link-rules';
import { createPreviewLink, listActivePreviewLinks, verifyGameOwner } from '../../../../lib/server/preview-links';

export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!locals.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const gameId = typeof params.id === 'string' ? params.id : '';
  const ownerCheck = await verifyGameOwner({ gameId, userId: locals.user.id });
  if (ownerCheck.kind === 'error') {
    return Response.json({ error: ownerCheck.message }, { status: ownerCheck.status });
  }

  const body: unknown = await request.json().catch(() => null);
  const ttlHours = parsePreviewLinkTtl(typeof body === 'object' && body !== null && 'ttlHours' in body ? body.ttlHours : undefined);
  if (ttlHours === null) {
    return Response.json({ error: 'Choose how long the link lasts.' }, { status: 400 });
  }

  const result = await createPreviewLink({
    supabase: locals.supabase,
    gameId,
    userId: locals.user.id,
    ttlHours,
    requestOrigin: new URL(request.url).origin,
  });

  if (result.kind === 'error') {
    return Response.json({ error: result.message }, { status: result.status });
  }

  return Response.json(
    {
      id: result.link.id,
      token: result.link.token,
      url: result.link.url,
      version: result.link.version,
      expiresAt: result.link.expiresAt,
      viewCount: result.link.viewCount,
      link: result.link,
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
};

export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const gameId = typeof params.id === 'string' ? params.id : '';
  const ownerCheck = await verifyGameOwner({ gameId, userId: locals.user.id });
  if (ownerCheck.kind === 'error') {
    return Response.json({ error: ownerCheck.message }, { status: ownerCheck.status });
  }

  const links = await listActivePreviewLinks({
    supabase: locals.supabase,
    gameId,
  });

  return Response.json({ links }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
};
