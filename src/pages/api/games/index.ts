import type { APIRoute } from 'astro';
import { createGame, getGame, normalizeTags } from '../../../lib/server/games';
import { validateGameUpload } from '../../../lib/server/upload';

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const { user, profile } = locals;
  if (!user || !profile) return Response.json({ errors: ['Log in and pick a handle to upload.'] }, { status: 401 });
  const form = await request.formData().catch(() => null);
  if (!form) return new Response('Expected multipart form data', { status: 400 });

  const { errors, upload } = await validateGameUpload(form, getGame);
  if (!upload) {
    return new Response(JSON.stringify({ errors }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const game = await createGame({
    ownerId: user.id,
    creator: profile.handle,
    title: upload.title,
    license: upload.license,
    html: upload.html,
    thumb: upload.thumb,
    tagline: upload.tagline,
    description: upload.description,
    tags: normalizeTags(upload.tagsRaw),
    forkedFrom: upload.forkedFrom,
  });
  return redirect(`/play/${game.slug}?uploaded=1`, 303);
};
