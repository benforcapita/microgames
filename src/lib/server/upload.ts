export const UPLOAD = {
  maxHtmlBytes: 5 * 1024 * 1024,
  maxThumbBytes: 512 * 1024,
  thumbTypes: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>,
  licenses: ['MIT', 'CC-BY-SA-4.0', 'All rights reserved'],
};

const text = (form: FormData, key: string, max: number) => String(form.get(key) ?? '').trim().slice(0, max);

export interface ForkParent {
  id: string;
  license: string;
}

export interface ValidatedGameUpload {
  title: string;
  license: string;
  tagline: string;
  description: string;
  tagsRaw: string;
  html: Uint8Array;
  thumb?: { bytes: Uint8Array; ext: string; type: string };
  forkedFrom: string | null;
}

/** Checks an upload form. `findGame` resolves `forkOf`; nothing here touches storage or Postgres. */
export async function validateGameUpload(
  form: FormData,
  findGame: (slugOrId: string) => Promise<ForkParent | null>,
): Promise<{ errors: string[]; upload: ValidatedGameUpload | null }> {
  const errors: string[] = [];
  const title = text(form, 'title', 60);
  const license = text(form, 'license', 32);
  const file = form.get('game');
  const thumbFile = form.get('thumb');
  const forkOf = text(form, 'forkOf', 64);
  const forked = forkOf ? await findGame(forkOf) : null;

  if (title.length < 2) errors.push('Title is required.');
  if (!UPLOAD.licenses.includes(license)) errors.push('Pick a license.');
  if (form.get('agree') !== 'on') errors.push('You must confirm the content rules.');
  if (forkOf && !forked) errors.push('The game you are forking no longer exists.');
  if (forked && forked.license === 'All rights reserved') errors.push('That game is not licensed for remixing.');
  if (!(file instanceof File) || file.size === 0) errors.push('Attach your game as a single .html file.');
  else if (!/\.html?$/i.test(file.name)) errors.push('Game file must be .html.');
  else if (file.size > UPLOAD.maxHtmlBytes) errors.push(`Game file must be under ${UPLOAD.maxHtmlBytes / 1024 / 1024} MB.`);

  let thumb: ValidatedGameUpload['thumb'];
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

  if (errors.length || !html) return { errors, upload: null };
  return {
    errors,
    upload: {
      title,
      license,
      tagline: text(form, 'tagline', 90),
      description: text(form, 'description', 2000),
      tagsRaw: text(form, 'tags', 200),
      html,
      thumb,
      forkedFrom: forked?.id ?? null,
    },
  };
}
