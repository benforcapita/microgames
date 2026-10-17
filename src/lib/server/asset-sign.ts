/**
 * UP-2a: decisions for browser-direct asset uploads.
 *
 * The Files page client (UP-2b) calls POST /api/games/<slug>/assets/sign to get a one-path
 * Supabase signed upload URL, PUTs the file bytes straight to Storage, then calls
 * /api/games/<slug>/assets/finalize so the server scans the stored bytes and writes the
 * manifest row. Request bodies carry JSON metadata only — file bytes never touch /api.
 * Nothing is an asset until finalize marks the row 'uploaded'.
 *
 * The checks reuse asset-upload.ts (paths, caps, limiter) so the two upload paths apply
 * identical rules; only the transport differs.
 */
import crypto from 'node:crypto';
import { canonicalAssetPath, extensionOf } from './asset-scan.ts';
import {
  ASSET_UPLOAD_MESSAGES,
  GAME_VERSION_MAX_BYTES,
  MAX_ASSET_FILES,
  assetPathRejection,
  assetWriteAddsCountedRow,
  gameTooBigMessage,
  hasControlChar,
  isUploadExtension,
  versionBytesAfterUpload,
  type AssetUsage,
  type ExistingAsset,
} from './asset-upload.ts';

/** JSON bodies are the only payloads these endpoints accept: metadata, never file bytes. */
export interface AssetSignBody {
  path: string;
  sizeBytes: number;
  contentType: string;
}

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

export function parseAssetSignBody(body: unknown): AssetSignBody | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 512) return null;
  if (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size)) return null;
  if (typeof raw.contentType !== 'string' || raw.contentType.length > 128 || !MIME_RE.test(raw.contentType)) return null;
  return { path: raw.path, sizeBytes: raw.size, contentType: raw.contentType };
}

export function parseAssetFinalizeBody(body: unknown): { path: string; uploadId: string } | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 512) return null;
  if (typeof raw.uploadId !== 'string' || raw.uploadId.length === 0 || raw.uploadId.length > 256) return null;
  return { path: raw.path, uploadId: raw.uploadId };
}

// --- Staged uploads -----------------------------------------------------------
//
// A signed URL may never target a path the CDN serves: whoever holds the URL could PUT unscanned
// bytes straight onto the vetted object and skip finalize. Signed URLs therefore write to a
// private staging object, `<game>/_staging/<nonce>` — a version segment the CDN path parser can
// never accept (only `\d{1,9}` parses) — and finalize copies the scanned bytes to the real path.
//
// The opaque `uploadId` binds a staged object to its sign call so finalize cannot be pointed at
// another staged object: `<nonce>.<base64url hmac(game, version, path, nonce)>`. The secret is
// injected so this module stays pure (the endpoint passes SUPABASE_SERVICE_KEY).

const UPLOAD_ID_SCOPE = 'mg-asset-upload-v1';
const NONCE_RE = /^[A-Za-z0-9_-]{16,32}$/;
const UPLOAD_ID_RE = /^([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{43})$/;
const GAME_ID_RE = /^[A-Za-z0-9_-]{6,16}$/;

function uploadIdSignature(secret: string, gameId: string, version: number, path: string, nonce: string): string {
  return crypto.createHmac('sha256', secret).update(`${UPLOAD_ID_SCOPE}:${gameId}:${version}:${path}:${nonce}`).digest('base64url');
}

export function mintAssetUploadId(secret: string, gameId: string, version: number, path: string): { uploadId: string; nonce: string } {
  const nonce = crypto.randomBytes(12).toString('base64url');
  return { uploadId: `${nonce}.${uploadIdSignature(secret, gameId, version, path, nonce)}`, nonce };
}

/**
 * The staged object key for a finalize call, or null when the uploadId is absent, malformed,
 * not bound to this game/version/path, or unsafe to join. A verified nonce is the only way in.
 */
export function stagedObjectPath(secret: string, gameId: string, version: number, path: string, uploadId: string): string | null {
  if (!GAME_ID_RE.test(gameId) || !Number.isInteger(version) || version < 1) return null;
  const m = UPLOAD_ID_RE.exec(uploadId);
  if (!m) return null;
  const [nonce, sig] = [m[1], m[2]];
  if (!NONCE_RE.test(nonce)) return null;
  const want = Buffer.from(uploadIdSignature(secret, gameId, version, path, nonce));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return `${gameId}/_staging/${nonce}`;
}

/**
 * Every denial is `{error}` plus an HTTP status, so the route shells stay thin. `flash` carries
 * the query params the Files page reloads with (the same params assetUploadQuery produces for the
 * multipart flow), so the browser reuses assetFlashMessage for identical text — only denials whose
 * code the flash renderer understands set it.
 */
export type AssetApiDenial = { ok: false; status: number; error: string; message: string; flash?: Record<string, string> };

export type AssetSignDecision = AssetApiDenial | { ok: true; path: string };

const deny = (status: number, error: string, message: string, flash?: Record<string, string>): AssetApiDenial =>
  flash ? { ok: false, status, error, message, flash } : { ok: false, status, error, message };

export interface AssessAssetSignInput {
  userId: string | null;
  ownerId: string | null;
  rawPath: string;
  /** Byte size the client declares it will upload. Re-checked against real bytes at finalize. */
  sizeBytes: number;
  existing: ExistingAsset | null;
  usage: AssetUsage;
  rateAllowed: boolean;
}

/**
 * Admit a signed-URL request. Mirrors assessAssetUpload minus the byte checks (there are no
 * bytes yet): login, ownership, path rules, rate limit, the 200-file cap and the 4 MB version
 * cap against the declared size. The manifest/'adding' rule collapses to the creator-add
 * branch — like the Files page "Add file" form, any allowlisted path may be signed.
 */
export function assessAssetSign(input: AssessAssetSignInput): AssetSignDecision {
  if (!input.userId) return deny(401, 'unauthorized', 'Log in to upload files.');
  if (!input.ownerId || input.userId !== input.ownerId) return deny(404, 'not-found', 'Not found');
  const pathError = assetPathRejection(input.rawPath);
  if (pathError) return deny(pathError.status, pathError.code, pathError.message, { error: pathError.code });
  if (!input.rateAllowed) return deny(429, 'rate', ASSET_UPLOAD_MESSAGES.rate, { error: 'rate' });
  if (input.sizeBytes < 1) return deny(400, 'empty', ASSET_UPLOAD_MESSAGES.empty, { error: 'empty' });

  const canonical = canonicalAssetPath(input.rawPath);
  if (canonical.kind !== 'path' || hasControlChar(canonical.path)) {
    return deny(400, 'path', ASSET_UPLOAD_MESSAGES.path, { error: 'path' });
  }
  const path = canonical.path;
  if (!isUploadExtension(extensionOf(path))) return deny(400, 'path', ASSET_UPLOAD_MESSAGES.path, { error: 'path' });

  const row = input.existing && input.existing.path === path ? input.existing : null;
  // Rejected rows do not count toward the cap; reviving one adds a counted row again.
  if (assetWriteAddsCountedRow(row?.status ?? null) && input.usage.fileCount >= MAX_ASSET_FILES) {
    return deny(409, 'cap', ASSET_UPLOAD_MESSAGES.cap, { error: 'cap' });
  }

  const previous = row?.status === 'uploaded' ? (row.sizeBytes ?? 0) : 0;
  const nextTotal = versionBytesAfterUpload(input.usage.codeBytes, input.usage.uploadedBytes, previous, input.sizeBytes);
  if (nextTotal > GAME_VERSION_MAX_BYTES) {
    return deny(413, 'too-big', gameTooBigMessage(nextTotal), { error: 'too-big', total: String(nextTotal) });
  }

  return { ok: true, path };
}
