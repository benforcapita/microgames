import type { APIRoute } from 'astro';
import { gameBundleVersion } from '../../../../../lib/server/asset-manifest';
import { canonicalAssetPath } from '../../../../../lib/server/asset-scan';
import { parseAssetFinalizeBody, verifyAssetUploadId } from '../../../../../lib/server/asset-sign';
import {
  ASSET_UPLOAD_MESSAGES,
  assetPathRejection,
  assetUploadQuery,
  assetUsage,
  assessAssetUpload,
  findGameAsset,
  gameTooBigMessage,
  saveFinalizedAsset,
} from '../../../../../lib/server/asset-upload';
import { SUPABASE_SERVICE_KEY } from '../../../../../lib/server/config';
import { sql } from '../../../../../lib/server/db';
import { getGame } from '../../../../../lib/server/games';
import { bucket } from '../../../../../lib/server/supabase';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

const deny = (d: { status: number; error: string; message: string; flash?: Record<string, string> }) =>
  json({ error: d.error, message: d.message, ...(d.flash ? { flash: d.flash } : {}) }, d.status);

/**
 * UP-2a: after the browser PUT bytes to the signed URL — which targets a staging object the CDN
 * can never serve — the server reads the staged bytes, runs the same type/size/content scans the
 * multipart POST applies, re-checks the caps against the real size, copies them to the asset's
 * object path and writes the 'uploaded' row. `uploadId` binds the call to one sign call's staged
 * object. The staged object is deleted in every case.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  if (!locals.user) return json({ error: 'unauthorized', message: 'Log in to upload files.' }, 401);
  const slug = params.slug ?? '';
  const game = await getGame(slug, { includeUnpublished: true });
  if (!game || game.ownerId !== locals.user.id) return json({ error: 'not-found', message: 'Not found' }, 404);

  const body = parseAssetFinalizeBody(await request.json().catch(() => null));
  if (!body) return json({ error: 'bad-request', message: 'Expected JSON {path, uploadId}.' }, 400);
  const pathError = assetPathRejection(body.path);
  if (pathError) return deny({ status: pathError.status, error: pathError.code, message: pathError.message, flash: { error: pathError.code } });

  const version = await gameBundleVersion(sql, game.id);
  const canonical = canonicalAssetPath(body.path);
  const assetPath = canonical.kind === 'path' ? canonical.path : null;
  const verified = assetPath ? verifyAssetUploadId(SUPABASE_SERVICE_KEY, game.id, version, assetPath, body.uploadId) : null;
  if (!assetPath || !verified || verified.kind === 'invalid') {
    return deny({ status: 404, error: 'not-uploaded', message: ASSET_UPLOAD_MESSAGES['not-uploaded'], flash: { error: 'not-uploaded' } });
  }
  const stagedPath = verified.stagedPath;

  const storage = {
    upload: async (path: string, body: Uint8Array, contentType: string) => {
      const put = await bucket().upload(path, body, { contentType, upsert: true });
      return { error: put.error ? { message: put.error.message } : null };
    },
    remove: async (path: string) => {
      const removed = await bucket().remove([path]);
      return { error: removed.error ? { message: removed.error.message } : null };
    },
  };

  if (verified.kind === 'expired') {
    // The uploadId's signed deadline passed: never scan, copy or row-write the bytes, but
    // still delete the staged object rather than leaving it for the sweep.
    const removed = await storage.remove(stagedPath).catch((error: unknown) => ({ error: { message: String(error) } }));
    if (removed.error) console.error(`Expired-upload cleanup failed for game ${game.id} ${stagedPath}`, removed.error);
    return deny({
      status: 410,
      error: 'upload_expired',
      message: ASSET_UPLOAD_MESSAGES.upload_expired,
      flash: { error: 'upload_expired' },
    });
  }

  const stored = await bucket().download(stagedPath);
  if (stored.error || !stored.data) {
    const missing = stored.error === null || (typeof stored.error.status === 'number' && stored.error.status < 500);
    return deny({
      status: missing ? 404 : 500,
      error: missing ? 'not-uploaded' : 'storage',
      message: missing ? ASSET_UPLOAD_MESSAGES['not-uploaded'] : ASSET_UPLOAD_MESSAGES.storage,
      flash: { error: missing ? 'not-uploaded' : 'storage' },
    });
  }
  const bytes = new Uint8Array(await stored.data.arrayBuffer());

  try {
    const [existing, usage] = await Promise.all([
      findGameAsset(sql, game.id, version, assetPath),
      assetUsage(sql, game.id, version),
    ]);
    // Same scan + caps as the multipart upload; adding: true because signing already admitted
    // the path like the creator "Add file" form. The rate limit was spent at sign time.
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
      const saved = await saveFinalizedAsset(sql, storage, game.id, version, decision, bytes);
      if (!saved.ok) {
        // The DB function is the authoritative cap check: a concurrent winner can turn a
        // pre-checked 'store' into a cap denial between assess and the row write.
        if (saved.code === 'cap') {
          return deny({ status: 409, error: 'cap', message: ASSET_UPLOAD_MESSAGES.cap, flash: { error: 'cap' } });
        }
        if (saved.code === 'too-big') {
          return deny({
            status: 413,
            error: 'too-big',
            message: gameTooBigMessage(saved.totalBytes),
            flash: { error: 'too-big', total: String(saved.totalBytes) },
          });
        }
        return deny({ status: 500, error: 'storage', message: ASSET_UPLOAD_MESSAGES.storage, flash: { error: 'storage' } });
      }
      if (decision.kind === 'store') {
        return json({ path: decision.path, sizeBytes: decision.sizeBytes, warning: decision.warning });
      }
      return deny({
        status: decision.code === 'too-big' ? 413 : 400,
        error: decision.code,
        message: decision.message,
        flash: assetUploadQuery(decision),
      });
    }

    if (decision.kind === 'bad-request') {
      return deny({ status: 400, error: decision.code, message: decision.message, flash: { error: decision.code } });
    }
    if (decision.kind === 'login') return deny({ status: 401, error: 'unauthorized', message: 'Log in to upload files.' });
    if (decision.kind === 'not-found') return deny({ status: 404, error: 'not-found', message: 'Not found' });
    const status = decision.code === 'cap' ? 409 : decision.code === 'rate' ? 429 : 400;
    return deny({ status, error: decision.code, message: ASSET_UPLOAD_MESSAGES[decision.code], flash: assetUploadQuery(decision) });
  } catch (error) {
    // Fixed body — the real error (a failed usage read, a failed row write) is server-side only.
    console.error(`Finalize failed for game ${game.id} ${stagedPath}`, error);
    return deny({ status: 500, error: 'storage', message: ASSET_UPLOAD_MESSAGES.storage, flash: { error: 'storage' } });
  } finally {
    // One cleanup site: the staged object is deleted on every exit — success, every denial
    // ('flash' and 'bad-request' never get a row) and every failure, thrown or returned.
    const removed = await storage.remove(stagedPath).catch((error: unknown) => ({ error: { message: String(error) } }));
    if (removed.error) console.error(`Finalize cleanup failed for game ${game.id} ${stagedPath}`, removed.error);
  }
};
