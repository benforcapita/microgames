import type { APIRoute } from 'astro';
import { gameBundleVersion } from '../../../../../lib/server/asset-manifest';
import { canonicalAssetPath } from '../../../../../lib/server/asset-scan';
import { assessAssetSign, mintAssetUploadId, parseAssetSignBody } from '../../../../../lib/server/asset-sign';
import {
  assetPathRejection,
  assetUploadsByUser,
  assetUsage,
  findGameAsset,
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

/**
 * UP-2a: mint a short-lived, single-path signed upload URL so the browser can PUT one asset
 * straight to Supabase Storage (file bytes never cross /api, which is what the platform
 * managed ruleset was blocking). Owner only. The path rules, file-count cap, 4 MB version cap
 * (against the declared size) and per-user rate limit all run here — the same rules the
 * multipart POST /assets applies — then /assets/finalize scans the stored bytes.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  if (!locals.user) return json({ error: 'unauthorized', message: 'Log in to upload files.' }, 401);
  const slug = params.slug ?? '';
  const game = await getGame(slug, { includeUnpublished: true });
  if (!game || game.ownerId !== locals.user.id) return json({ error: 'not-found', message: 'Not found' }, 404);

  const body = parseAssetSignBody(await request.json().catch(() => null));
  if (!body) return json({ error: 'bad-request', message: 'Expected JSON {path, size, contentType}.' }, 400);
  // Same boundary check finalize applies — a NUL or control character must be refused before
  // the path ever reaches Postgres (a parameterized query with a NUL errors into a 500).
  const pathError = assetPathRejection(body.path);
  if (pathError) return json({ error: pathError.code, message: pathError.message }, 400);

  const version = await gameBundleVersion(sql, game.id);
  const canonical = canonicalAssetPath(body.path);
  const [existing, usage] = await Promise.all([
    canonical.kind === 'path' ? findGameAsset(sql, game.id, version, canonical.path) : Promise.resolve(null),
    assetUsage(sql, game.id, version),
  ]);
  const decision = assessAssetSign({
    userId: locals.user.id,
    ownerId: game.ownerId,
    rawPath: body.path,
    sizeBytes: body.sizeBytes,
    existing,
    usage,
    rateAllowed: assetUploadsByUser.hit(locals.user.id),
  });
  if (!decision.ok) {
    return json(
      { error: decision.error, message: decision.message, ...(decision.flash ? { flash: decision.flash } : {}) },
      decision.status,
    );
  }

  // One staging object per sign call: <game>/_staging/<nonce>. A signed URL must never write a
  // path the CDN serves (whoever held it could overwrite vetted bytes and skip the scan), so it
  // authorizes exactly the staged key and nothing else. The opaque uploadId binds this staged
  // object to this game/version/path for finalize.
  const { uploadId, nonce } = mintAssetUploadId(SUPABASE_SERVICE_KEY, game.id, version, decision.path);
  const stagedPath = `${game.id}/_staging/${nonce}`;
  const signed = await bucket().createSignedUploadUrl(stagedPath, { upsert: false });
  if (signed.error || !signed.data) {
    console.error(`Signed upload URL failed for game ${game.id}`, signed.error);
    return json({ error: 'storage', message: 'The file could not be stored. Try again.', flash: { error: 'storage' } }, 500);
  }
  return json({
    path: decision.path,
    uploadId,
    uploadPath: stagedPath,
    version,
    url: signed.data.signedUrl,
    token: signed.data.token,
    upsert: false,
  });
};
