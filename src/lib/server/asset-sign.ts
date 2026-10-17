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
import { canonicalAssetPath, extensionOf } from './asset-scan.ts';
import {
  ASSET_UPLOAD_MESSAGES,
  GAME_VERSION_MAX_BYTES,
  MAX_ASSET_FILES,
  assetPathRejection,
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

export function parseAssetFinalizeBody(body: unknown): { path: string } | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 512) return null;
  return { path: raw.path };
}

/** Every denial is `{error}` plus an HTTP status, so the route shells stay thin. */
export type AssetApiDenial = { ok: false; status: number; error: string; message: string };

export type AssetSignDecision = AssetApiDenial | { ok: true; path: string };

const deny = (status: number, error: string, message: string): AssetApiDenial => ({ ok: false, status, error, message });

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
  if (pathError) return deny(pathError.status, pathError.code, pathError.message);
  if (!input.rateAllowed) return deny(429, 'rate', ASSET_UPLOAD_MESSAGES.rate);
  if (input.sizeBytes < 1) return deny(400, 'empty', ASSET_UPLOAD_MESSAGES.empty);

  const canonical = canonicalAssetPath(input.rawPath);
  if (canonical.kind !== 'path' || hasControlChar(canonical.path)) {
    return deny(400, 'path', ASSET_UPLOAD_MESSAGES.path);
  }
  const path = canonical.path;
  if (!isUploadExtension(extensionOf(path))) return deny(400, 'path', ASSET_UPLOAD_MESSAGES.path);

  const row = input.existing && input.existing.path === path ? input.existing : null;
  if (!row && input.usage.fileCount >= MAX_ASSET_FILES) return deny(409, 'cap', ASSET_UPLOAD_MESSAGES.cap);

  const previous = row?.status === 'uploaded' ? (row.sizeBytes ?? 0) : 0;
  const nextTotal = versionBytesAfterUpload(input.usage.codeBytes, input.usage.uploadedBytes, previous, input.sizeBytes);
  if (nextTotal > GAME_VERSION_MAX_BYTES) return deny(413, 'too-big', gameTooBigMessage(nextTotal));

  return { ok: true, path };
}
