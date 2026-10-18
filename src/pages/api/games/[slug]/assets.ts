import type { APIRoute } from 'astro';
import { canonicalAssetPath } from '../../../../lib/server/asset-scan';
import { gameBundleVersion } from '../../../../lib/server/asset-manifest';
import {
  assessAssetUpload,
  assetPathRejection,
  assetUploadsByUser,
  assetUploadQuery,
  assetUsage,
  findGameAsset,
  saveAssetDecision,
} from '../../../../lib/server/asset-upload';
import { sql } from '../../../../lib/server/db';
import { getGame } from '../../../../lib/server/games';
import { bucket } from '../../../../lib/server/supabase';

export const POST: APIRoute = async ({ request, params, locals, redirect }) => {
  const slug = params.slug ?? '';
  const page = `/games/${encodeURIComponent(slug)}/assets`;
  const back = (query: Record<string, string>) => redirect(`${page}?${new URLSearchParams(query)}`, 303);

  if (!locals.user) return redirect(`/login?next=${encodeURIComponent(page)}`, 303);
  const game = await getGame(slug, { includeUnpublished: true });
  if (!game || game.ownerId !== locals.user.id) return new Response('Not found', { status: 404 });

  const form = await request.formData().catch(() => null);
  const rawPath = String(form?.get('path') ?? '');
  const pathError = assetPathRejection(rawPath);
  if (pathError) {
    return new Response(pathError.message, {
      status: pathError.status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
    });
  }

  const rateAllowed = assetUploadsByUser.hit(locals.user.id);
  const file = form?.get('file');
  const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  const version = await gameBundleVersion(sql, game.id);
  const canonical = canonicalAssetPath(rawPath);
  const [existing, usage] = await Promise.all([
    canonical.kind === 'path' ? findGameAsset(sql, game.id, version, canonical.path) : Promise.resolve(null),
    assetUsage(sql, game.id, version),
  ]);
  const decision = assessAssetUpload({
    userId: locals.user.id,
    ownerId: game.ownerId,
    rawPath,
    adding: form?.get('source') === 'creator',
    bytes,
    existing,
    codeBytes: usage.codeBytes,
    uploadedBytes: usage.uploadedBytes,
    fileCount: usage.fileCount,
    rateAllowed,
  });

  if (decision.kind === 'login') return redirect(`/login?next=${encodeURIComponent(page)}`, 303);
  if (decision.kind === 'not-found') return new Response('Not found', { status: 404 });
  if (decision.kind === 'bad-request') {
    return new Response(decision.message, {
      status: decision.status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
    });
  }
  if (decision.kind === 'reject' || decision.kind === 'store') {
    try {
      const saved = await saveAssetDecision(
        sql,
        {
          upload: async (path, body, contentType) => {
            const put = await bucket().upload(path, body, { contentType, upsert: true });
            return { error: put.error ? { message: put.error.message } : null };
          },
          remove: async (path) => {
            const removed = await bucket().remove([path]);
            return { error: removed.error ? { message: removed.error.message } : null };
          },
        },
        game.id,
        version,
        decision,
        bytes,
        existing,
      );
      if (!saved.ok) {
        // 'cap'/'too-big' are the DB function's verdict when a concurrent upload won the
        // slot between this route's pre-check and the row write.
        const query: Record<string, string> = { error: saved.code };
        if (saved.code === 'too-big') query.total = String(saved.totalBytes);
        return back(query);
      }
    } catch (error) {
      console.error(`Asset upload failed for game ${game.id}`, error);
      return back({ error: 'storage' });
    }
  }
  return back(assetUploadQuery(decision));
};
