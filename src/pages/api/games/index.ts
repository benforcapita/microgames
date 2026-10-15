import type { APIRoute } from 'astro';
import { UPLOAD } from '../../../lib/server/config';
import { createGame, getGame, normalizeTags } from '../../../lib/server/games';

const text = (form: FormData, key: string, max: number) => String(form.get(key) ?? '').trim().slice(0, max);

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const { user, profile } = locals;
  if (!user || !profile) return Response.json({ errors: ['Log in and pick a handle to upload.'] }, { status: 401 });
  const form = await request.formData().catch(() => null);
  if (!form) return new Response('Expected multipart form data', { status: 400 });

  const errors: string[] = [];
  const title = text(form, 'title', 60);
  const license = text(form, 'license', 32);
  const file = form.get('game');
  const thumbFile = form.get('thumb');
  const forkOf = text(form, 'forkOf', 64);
  const forked = forkOf ? await getGame(forkOf) : null;

  if (title.length < 2) errors.push('Title is required.');
  if (!UPLOAD.licenses.includes(license)) errors.push('Pick a license.');
  if (form.get('agree') !== 'on') errors.push('You must confirm the content rules.');
  if (forkOf && !forked) errors.push('The game you are forking no longer exists.');
  if (forked && forked.license === 'All rights reserved') errors.push('That game is not licensed for remixing.');
  if (!(file instanceof File) || file.size === 0) errors.push('Attach your game as a single .html file.');
  else if (!/\.html?$/i.test(file.name)) errors.push('Game file must be .html.');
  else if (file.size > UPLOAD.maxHtmlBytes) errors.push(`Game file must be under ${UPLOAD.maxHtmlBytes / 1024 / 1024} MB.`);

  let thumb: { bytes: Uint8Array; ext: string; type: string } | undefined;
  if (thumbFile instanceof File && thumbFile.size > 0) {
    const ext = UPLOAD.thumbTypes[thumbFile.type];
    if (!ext) errors.push('Thumbnail must be PNG, JPEG or WebP.');
    else if (thumbFile.size > UPLOAD.maxThumbBytes) errors.push('Thumbnail must be under 512 KB.');
    else thumb = { bytes: new Uint8Array(await thumbFile.arrayBuffer()), ext, type: thumbFile.type };
  }

  let html: Uint8Array | undefined;
  if (!errors.length && file instanceof File) {
    html = new Uint8Array(await file.arrayBuffer());
    try {
      const src = new TextDecoder('utf-8', { fatal: true }).decode(html);
      if (!/<(script|canvas|html|body)\b/i.test(src)) errors.push('That file does not look like an HTML game.');
    } catch {
      errors.push('Game file must be UTF-8 text.');
    }
  }

  if (errors.length || !html) {
    return new Response(JSON.stringify({ errors }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const game = await createGame({
    ownerId: user.id,
    creator: profile.handle,
    title,
    license,
    html,
    thumb,
    tagline: text(form, 'tagline', 90),
    description: text(form, 'description', 2000),
    tags: normalizeTags(text(form, 'tags', 200)),
    forkedFrom: forked?.id ?? null,
  });
  return redirect(`/play/${game.slug}?uploaded=1`, 303);
};
