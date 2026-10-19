/**
 * MCP-1: JSON bodies for the token API (/api/v1/games) turned into the same FormData the
 * upload form posts, so validateGameUpload stays the one set of upload rules.
 * No database or environment access.
 */
import type { Stage } from './server/game-rules';

export const MAX_THUMB_BASE64 = 1024 * 1024;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function htmlFile(html: unknown): File | null {
  return typeof html === 'string' && html ? new File([html], 'game.html', { type: 'text/html' }) : null;
}

function thumbFile(thumb: unknown): File | null | { error: string } {
  if (thumb == null) return null;
  if (!isObject(thumb) || typeof thumb.data !== 'string' || typeof thumb.type !== 'string') {
    return { error: 'thumbnail must be { data: <base64>, type: "image/png" | "image/jpeg" | "image/webp" }.' };
  }
  if (thumb.data.length > MAX_THUMB_BASE64) return { error: 'Thumbnail must be under 512 KB.' };
  const bytes = Buffer.from(thumb.data, 'base64');
  return new File([bytes], 'thumb', { type: thumb.type.toLowerCase() });
}

function tagsText(tags: unknown): string {
  if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === 'string').join(', ');
  return str(tags);
}

/** Publish body → upload FormData. Field errors are left to validateGameUpload. */
export function publishForm(body: unknown): { form: FormData } | { error: string } {
  if (!isObject(body)) return { error: 'Expected a JSON object.' };
  const thumb = thumbFile(body.thumbnail);
  if (thumb && 'error' in thumb) return thumb;
  const form = new FormData();
  form.set('title', str(body.title));
  form.set('license', str(body.license));
  form.set('tagline', str(body.tagline));
  form.set('description', str(body.description));
  form.set('tags', tagsText(body.tags));
  form.set('forkOf', str(body.forkOf));
  if (body.agreeToContentRules === true) form.set('agree', 'on');
  const game = htmlFile(body.html);
  if (game) form.set('game', game);
  if (thumb) form.set('thumb', thumb);
  return { form };
}

/**
 * Why a game's bundle cannot be replaced, or null. Only unpublished games take new bytes:
 * the CDN caches a public game's stage, so swapping a public document could serve unreviewed
 * HTML. Uploaded assets live under the current validation version and would be orphaned
 * when the new bundle's validation bumps it.
 */
export function replaceBlocker(stage: Stage, hasUploadedAssets: boolean): string | null {
  if (stage === 'proving' || stage === 'live') {
    return 'This game is published, so its file cannot be replaced. Publish the new version as a new game that forks this one instead.';
  }
  if (hasUploadedAssets) return 'This game has uploaded asset files, so its HTML cannot be replaced from the API. Publish it as a new game instead.';
  return null;
}

/** Update body → the new game file and optional thumbnail. */
export function updateFiles(body: unknown): { game: File | null; thumb: File | null } | { error: string } {
  if (!isObject(body)) return { error: 'Expected a JSON object.' };
  const thumb = thumbFile(body.thumbnail);
  if (thumb && 'error' in thumb) return thumb;
  return { game: htmlFile(body.html), thumb };
}
