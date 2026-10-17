import type { APIRoute } from 'astro';
import { gameBundleVersion } from '../../../../../lib/server/asset-manifest';
import { canonicalAssetPath } from '../../../../../lib/server/asset-scan';
import { parseAssetFinalizeBody } from '../../../../../lib/server/asset-sign';
import {
  ASSET_UPLOAD_MESSAGES,
  assetObjectPath,
  assetPathRejection,
  assetUsage,
  assessAssetUpload,
  findGameAsset,
  saveFinalizedAsset,
} from '../../../../../lib/server/asset-upload';
import { sql } from '../../../../../lib/server/db';
import { getGame } from '../../../../../lib/server/games';
import { bucket } from '../../../../../lib/server/supabase';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

const deny = (d: { status: number; error: string; message: string }) =>
  json({ error: d.error, message: d.message }, d.status);

/**
 * UP-2a: after the browser PUT bytes to the signed URL, the server reads the stored object back,
 * runs the same type/size/content scans the multipart POST applies, re-checks the caps against
 * the real size, and only then writes the manifest row. Any failure deletes the stored object —
 * until a row says 'uploaded' the CDN will not serve it and the caps do not count it.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  if (!locals.user) return json({ error: 'unauthorized', message: 'Log in to upload files.' }, 401);
  const slug = params.slug ?? '';
  const game = await getGame(slug, { includeUnpublished: true });
  if (!game || game.ownerId !== locals.user.id) return json({ error: 'not-found', message: 'Not found' }, 404);

  const body = parseAssetFinalizeBody(await request.json().catch(() => null));
  if (!body) return json({ error: 'bad-request', message: 'Expected JSON {path}.' }, 400);
  const pathError = assetPathRejection(body.path);
  if (pathError) return json({ error: pathError.code, message: pathError.message }, 400);

  const version = await gameBundleVersion(sql, game.id);
  const canonical = canonicalAssetPath(body.path);
  const assetPath = canonical.kind === 'path' ? canonical.path : null;
  const objectPath = assetPath ? assetObjectPath(game.id, version, assetPath) : null;
  if (!assetPath || !objectPath) return json({ error: 'path', message: ASSET_UPLOAD_MESSAGES.path }, 400);

  const stored = await bucket().download(objectPath);
  if (stored.error || !stored.data) {
    const missing = stored.error === null || (typeof stored.error.status === 'number' && stored.error.status < 500);
    return json(
      { error: missing ? 'not-uploaded' : 'storage', message: missing ? 'Nothing was uploaded to that path.' : 'The file could not be stored. Try again.' },
      missing ? 404 : 500,
    );
  }
  const bytes = new Uint8Array(await stored.data.arrayBuffer());

  const remove = async (path: string) => {
    const removed = await bucket().remove([path]);
    return { error: removed.error ? { message: removed.error.message } : null };
  };

  const [existing, usage] = await Promise.all([
    findGameAsset(sql, game.id, version, assetPath),
    assetUsage(sql, game.id, version),
  ]);
  // Same scan + caps as the multipart upload; adding: true because signing already admitted the
  // path like the creator "Add file" form. The rate limit was spent at sign time.
  const decision = assessAssetUpload({
    userId: locals.user.id,
    ownerId: game.ownerId,
    rawPath: body.path,
    adding: true,
    bytes,
    existing,
    codeBytes: usage.codeBytes,
    uploadedBytes: usage.uploadedBytes,
    fileCount: usage.fileCount,
    rateAllowed: true,
  });

  if (decision.kind === 'store' || decision.kind === 'reject') {
    const saved = await saveFinalizedAsset(sql, { remove }, game.id, version, decision);
    if (!saved.ok) return json({ error: 'storage', message: ASSET_UPLOAD_MESSAGES.storage }, 500);
    if (decision.kind === 'store') {
      return json({ path: decision.path, sizeBytes: decision.sizeBytes, warning: decision.warning });
    }
    return deny({ status: decision.code === 'too-big' ? 413 : 400, error: decision.code, message: decision.message });
  }

  // 'flash' and 'bad-request' decisions never get a row; the unvetted object still has to go.
  const removed = await remove(objectPath);
  if (removed.error) console.error(`Finalize cleanup failed for game ${game.id} ${objectPath}`, removed.error);
  if (decision.kind === 'bad-request') return deny({ status: 400, error: decision.code, message: decision.message });
  if (decision.kind === 'login') return deny({ status: 401, error: 'unauthorized', message: 'Log in to upload files.' });
  if (decision.kind === 'not-found') return deny({ status: 404, error: 'not-found', message: 'Not found' });
  const status = decision.code === 'cap' ? 409 : decision.code === 'rate' ? 429 : 400;
  return deny({ status, error: decision.code, message: ASSET_UPLOAD_MESSAGES[decision.code] });
};
