export const UPLOAD = {
  maxHtmlBytes: 5 * 1024 * 1024,
  maxThumbBytes: 512 * 1024,
  maxThumbWidth: 640,
  maxThumbHeight: 360,
  thumbTypes: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>,
  licenses: ['MIT', 'CC-BY-SA-4.0', 'All rights reserved'],
};

export const THUMB_REQUIRED = 'A thumbnail is required.';
const THUMB_TYPE = 'Thumbnail must be PNG, JPEG or WebP.';
const THUMB_SIZE = 'Thumbnail must be under 512 KB.';
const THUMB_DIMS = `Thumbnail must be at most ${UPLOAD.maxThumbWidth}×${UPLOAD.maxThumbHeight} pixels.`;
const THUMB_UNREADABLE = 'Thumbnail image could not be read.';

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
  thumb: { bytes: Uint8Array; ext: string; type: string };
  forkedFrom: string | null;
}

/** Width and height from a PNG, JPEG, or WebP header. Null when the bytes are not that format. */
export function imageSize(type: string, bytes: Uint8Array): { width: number; height: number } | null {
  if (type === 'image/png') return pngSize(bytes);
  if (type === 'image/jpeg') return jpegSize(bytes);
  if (type === 'image/webp') return webpSize(bytes);
  return null;
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24) return null;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;
  if (ascii(bytes, 12, 4) !== 'IHDR') return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  if (!width || !height) return null;
  return { width, height };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = u16(bytes, i + 2);
    if (len < 2 || i + 2 + len > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xc2) {
      const height = u16(bytes, i + 5);
      const width = u16(bytes, i + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >>> 14) & 0x3fff);
    return { width, height };
  }
  return null;
}

/** Same type, size, and dimension rules for an uploaded file and a captured preview. */
export async function validateThumb(file: File): Promise<{ error: string } | { thumb: ValidatedGameUpload['thumb'] }> {
  const ext = UPLOAD.thumbTypes[file.type];
  if (!ext) return { error: THUMB_TYPE };
  if (file.size > UPLOAD.maxThumbBytes) return { error: THUMB_SIZE };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = imageSize(file.type, bytes);
  if (!size) return { error: THUMB_UNREADABLE };
  if (size.width > UPLOAD.maxThumbWidth || size.height > UPLOAD.maxThumbHeight) return { error: THUMB_DIMS };
  return { thumb: { bytes, ext, type: file.type } };
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

  let thumb: ValidatedGameUpload['thumb'] | undefined;
  if (!(thumbFile instanceof File) || thumbFile.size === 0) errors.push(THUMB_REQUIRED);
  else {
    const checked = await validateThumb(thumbFile);
    if ('error' in checked) errors.push(checked.error);
    else thumb = checked.thumb;
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

  if (errors.length || !html || !thumb) return { errors, upload: null };
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
