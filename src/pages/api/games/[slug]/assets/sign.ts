import type { APIRoute } from 'astro';
import { gameBundleVersion } from '../../../../../lib/server/asset-manifest';
import { canonicalAssetPath } from '../../../../../lib/server/asset-scan';
import { assessAssetSign, parseAssetSignBody } from '../../../../../lib/server/asset-sign';
import {
  assetObjectPath,
  assetUploadsByUser,
  assetUsage,
  findGameAsset,
} from '../../../../../lib/server/asset-upload';
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
  if (!decision.ok) return json({ error: decision.error, message: decision.message }, decision.status);

  // One object key per asset: <game>/<version>/<path>. The signed URL authorizes exactly that.
  const objectPath = assetObjectPath(game.id, version, decision.path);
  if (!objectPath) return json({ error: 'path', message: 'That path is not allowed.' }, 400);
  const signed = await bucket().createSignedUploadUrl(objectPath, { upsert: true });
  if (signed.error || !signed.data) {
    console.error(`Signed upload URL failed for game ${game.id}`, signed.error);
    return json({ error: 'storage', message: 'The file could not be stored. Try again.' }, 500);
  }
  return json({
    path: decision.path,
    objectPath,
    version,
    url: signed.data.signedUrl,
    token: signed.data.token,
    upsert: true,
  });
};
