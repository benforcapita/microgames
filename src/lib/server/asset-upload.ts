/**
 * Owner upload of one asset into a game version.
 *
 * Limits live here (not in the scanner) so this keeps working if the scan
 * module stops exporting them. A missing-file warning is AS-4, not this upload.
 */
import crypto from 'node:crypto';
import { createLimiter } from './abuse.ts';
import type { AssetDb } from './asset-manifest.ts';
import { classifyAssetPath, type ExpectedType } from './asset-scan.ts';
import { sniffAsset } from './asset-sniff.ts';

/** HTML/code plus every asset already stored for the version, including this file. */
export const GAME_VERSION_MAX_BYTES = 4 * 1024 * 1024;
/** Larger assets are stored. The owner sees a warning afterwards. */
export const ASSET_SIZE_WARN_BYTES = 100 * 1024;
/** Rows allowed on one game, across versions. */
export const MAX_ASSET_FILES = 200;

/** Asset posts allowed per signed-in user. Same sliding window as the other limiters. */
export const ASSET_UPLOAD_MAX = 30;
export const ASSET_UPLOAD_WINDOW_MS = 10 * 60_000;

export const ASSET_SIZE_WARNING = 'This asset is over 100 KB.';

export const ASSET_UPLOAD_MESSAGES = {
  rate: 'Too many uploads. Try again in a few minutes.',
  empty: 'Choose a file to upload.',
  path: 'That path is not allowed.',
  manifest: "That path is not in this game's file list.",
  cap: 'This game already has 200 files.',
  markup: 'SVG and HTML files are not allowed.',
  type: 'This file type is not allowed.',
  storage: 'The file could not be stored. Try again.',
} as const;

export type AssetFlashCode = keyof typeof ASSET_UPLOAD_MESSAGES;

export function createAssetUploadLimiter(now?: () => number) {
  return createLimiter({ windowMs: ASSET_UPLOAD_WINDOW_MS, max: ASSET_UPLOAD_MAX, now });
}

export const assetUploadsByUser = createAssetUploadLimiter();

export function gameTooBigMessage(totalBytes: number): string {
  return `This file would bring your game to ${formatGameMb(totalBytes)} MB; the whole game, code plus assets, must stay under 4 MB`;
}

/** Two decimals, with extra places when rounding would hide that the total is over 4 MB. */
export function formatGameMb(bytes: number): string {
  const value = bytes / (1024 * 1024);
  if (bytes > GAME_VERSION_MAX_BYTES && value < 4.005) {
    return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }
  return value.toFixed(2);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function mismatchMessage(got: ExpectedType, want: ExpectedType): string {
  return `This file is ${got}, but the path expects ${want}.`;
}

const EXPECTED_TYPES: readonly ExpectedType[] = ['image', 'audio', 'font', 'json', 'text'];

function isExpectedType(value: string | null): value is ExpectedType {
  return !!value && (EXPECTED_TYPES as readonly string[]).includes(value);
}

export interface ExistingAsset {
  path: string;
  expectedType: ExpectedType;
  status: 'missing' | 'uploaded' | 'rejected';
  sizeBytes: number | null;
  source: 'scan' | 'creator';
}

export interface AssessAssetInput {
  userId: string | null;
  ownerId: string | null;
  rawPath: string;
  /** True for the add-file form (`source=creator`). A listed path is still a replacement. */
  adding: boolean;
  bytes: Uint8Array;
  existing: ExistingAsset | null;
  /** Byte length of the game's HTML/code. */
  codeBytes: number;
  /** Sum of uploaded asset sizes for this version, including `existing` when it is uploaded. */
  uploadedBytes: number;
  /** Manifest rows for the whole game. */
  fileCount: number;
  rateAllowed: boolean;
}

export type AssetUploadDecision =
  | { kind: 'login' }
  | { kind: 'not-found' }
  | { kind: 'flash'; code: AssetFlashCode }
  | {
      kind: 'reject';
      code: 'markup' | 'type' | 'mismatch' | 'too-big';
      path: string;
      expectedType: ExpectedType;
      source: 'scan' | 'creator';
      message: string;
      totalBytes?: number;
      got?: ExpectedType;
    }
  | {
      kind: 'store';
      path: string;
      expectedType: ExpectedType;
      source: 'scan' | 'creator';
      contentType: string;
      sha256: string;
      sizeBytes: number;
      warning: string | null;
    };

function rejectRow(
  path: string,
  expectedType: ExpectedType,
  source: 'scan' | 'creator',
  code: 'markup' | 'type' | 'mismatch' | 'too-big',
  message: string,
  extra: { totalBytes?: number; got?: ExpectedType } = {},
): AssetUploadDecision {
  return { kind: 'reject', code, path, expectedType, source, message, ...extra };
}

/** Decide what an upload may do. Does not touch storage or Postgres. */
export function assessAssetUpload(input: AssessAssetInput): AssetUploadDecision {
  if (!input.userId) return { kind: 'login' };
  if (!input.ownerId || input.userId !== input.ownerId) return { kind: 'not-found' };
  if (!input.rateAllowed) return { kind: 'flash', code: 'rate' };
  if (input.bytes.byteLength === 0) return { kind: 'flash', code: 'empty' };

  const classified = classifyAssetPath(input.rawPath);
  if (classified.kind !== 'asset') return { kind: 'flash', code: 'path' };

  const path = classified.path;
  const row = input.existing && input.existing.path === path ? input.existing : null;
  if (!row && !input.adding) return { kind: 'flash', code: 'manifest' };
  if (!row && input.fileCount >= MAX_ASSET_FILES) return { kind: 'flash', code: 'cap' };

  const expectedType = row?.expectedType ?? classified.expectedType;
  const source = row?.source ?? 'creator';
  const sniffed = sniffAsset(input.bytes);
  if (!sniffed.ok) {
    if (sniffed.reason === 'svg' || sniffed.reason === 'html') {
      return rejectRow(path, expectedType, source, 'markup', ASSET_UPLOAD_MESSAGES.markup);
    }
    return rejectRow(path, expectedType, source, 'type', ASSET_UPLOAD_MESSAGES.type);
  }
  const matches = sniffed.expectedType === expectedType || (expectedType === 'text' && sniffed.format === 'json');
  if (!matches) {
    return rejectRow(path, expectedType, source, 'mismatch', mismatchMessage(sniffed.expectedType, expectedType), {
      got: sniffed.expectedType,
    });
  }

  const previous = row?.status === 'uploaded' ? (row.sizeBytes ?? 0) : 0;
  const nextTotal = Math.max(0, input.codeBytes) + Math.max(0, input.uploadedBytes - previous) + input.bytes.byteLength;
  if (nextTotal > GAME_VERSION_MAX_BYTES) {
    return rejectRow(path, expectedType, source, 'too-big', gameTooBigMessage(nextTotal), { totalBytes: nextTotal });
  }

  const contentType = expectedType === 'text' ? 'text/plain; charset=utf-8' : sniffed.contentType;
  return {
    kind: 'store',
    path,
    expectedType,
    source,
    contentType,
    sha256: crypto.createHash('sha256').update(input.bytes).digest('hex'),
    sizeBytes: input.bytes.byteLength,
    warning: input.bytes.byteLength > ASSET_SIZE_WARN_BYTES ? ASSET_SIZE_WARNING : null,
  };
}

/** Query string for the redirect after a decision the owner is allowed to see. */
export function assetUploadQuery(decision: Exclude<AssetUploadDecision, { kind: 'login' | 'not-found' }>): Record<string, string> {
  if (decision.kind === 'flash') return { error: decision.code };
  if (decision.kind === 'reject') {
    const query: Record<string, string> = { error: decision.code };
    if (decision.code === 'too-big' && decision.totalBytes !== undefined) query.total = String(decision.totalBytes);
    if (decision.code === 'mismatch' && decision.got) {
      query.got = decision.got;
      query.want = decision.expectedType;
    }
    return query;
  }
  const query: Record<string, string> = { uploaded: decision.path };
  if (decision.warning) query.warn = '1';
  return query;
}

/**
 * Flash text for a redirect. `uploaded` is shown only when it is one of this
 * page's paths, so a crafted query cannot invent a success.
 */
export function assetFlashMessage(query: URLSearchParams, paths: readonly string[]): { error: string | null; notice: string | null } {
  const code = query.get('error');
  let error: string | null = null;
  if (code === 'too-big') {
    const total = Number(query.get('total'));
    if (Number.isSafeInteger(total) && total >= 0) error = gameTooBigMessage(total);
  } else if (code === 'mismatch') {
    const got = query.get('got');
    const want = query.get('want');
    if (isExpectedType(got) && isExpectedType(want)) error = mismatchMessage(got, want);
  } else if (code && Object.prototype.hasOwnProperty.call(ASSET_UPLOAD_MESSAGES, code)) {
    error = ASSET_UPLOAD_MESSAGES[code as AssetFlashCode];
  }

  const uploaded = query.get('uploaded');
  if (!uploaded || !paths.includes(uploaded)) return { error, notice: null };
  const warning = query.get('warn') === '1' ? ` ${ASSET_SIZE_WARNING}` : '';
  return { error, notice: `Uploaded ${uploaded}.${warning}` };
}

/** Storage key `<game>/<version>/<path>`. Null when the pieces are not safe to join. */
export function assetObjectPath(gameId: string, version: number, path: string): string | null {
  if (!/^[A-Za-z0-9_-]{6,16}$/.test(gameId)) return null;
  if (!Number.isInteger(version) || version < 1) return null;
  const classified = classifyAssetPath(path);
  if (classified.kind !== 'asset' || classified.path !== path) return null;
  return `${gameId}/${version}/${path}`;
}

export interface AssetStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: { message: string } | null }>;
}

export interface GameAssetRow {
  path: string;
  expectedType: ExpectedType;
  status: 'missing' | 'uploaded' | 'rejected';
  sizeBytes: number | null;
  rejectReason: string | null;
  source: 'scan' | 'creator';
}

interface AssetDbRow {
  path: string;
  expected_type: string;
  status: string;
  size_bytes: number | null;
  reject_reason: string | null;
  source: string;
}

function isStatus(value: string): value is GameAssetRow['status'] {
  return value === 'missing' || value === 'uploaded' || value === 'rejected';
}

function isSource(value: string): value is GameAssetRow['source'] {
  return value === 'scan' || value === 'creator';
}

function toRow(row: AssetDbRow): GameAssetRow | null {
  if (!isExpectedType(row.expected_type) || !isStatus(row.status) || !isSource(row.source)) return null;
  return {
    path: row.path,
    expectedType: row.expected_type,
    status: row.status,
    sizeBytes: row.size_bytes,
    rejectReason: row.reject_reason,
    source: row.source,
  };
}

export async function listGameAssets(sql: AssetDb, gameId: string, version: number): Promise<GameAssetRow[]> {
  const rows = await sql<AssetDbRow[]>`
    select path, expected_type, status, size_bytes, reject_reason, source
    from public.game_assets
    where game_id = ${gameId} and version = ${version}
    order by path
  `;
  return rows.flatMap((row) => {
    const mapped = toRow(row);
    return mapped ? [mapped] : [];
  });
}

export async function findGameAsset(sql: AssetDb, gameId: string, version: number, path: string): Promise<GameAssetRow | null> {
  const rows = await sql<AssetDbRow[]>`
    select path, expected_type, status, size_bytes, reject_reason, source
    from public.game_assets
    where game_id = ${gameId} and version = ${version} and path = ${path}
  `;
  return rows[0] ? toRow(rows[0]) : null;
}

export interface AssetUsage {
  codeBytes: number;
  uploadedBytes: number;
  fileCount: number;
}

export async function assetUsage(sql: AssetDb, gameId: string, version: number): Promise<AssetUsage> {
  const [row] = await sql<{ code_bytes: number | null; uploaded_bytes: number; file_count: number }[]>`
    select
      (select size_bytes from public.games where id = ${gameId}) as code_bytes,
      (select coalesce(sum(size_bytes), 0)::int from public.game_assets
        where game_id = ${gameId} and version = ${version} and status = 'uploaded') as uploaded_bytes,
      (select count(*)::int from public.game_assets where game_id = ${gameId}) as file_count
  `;
  return {
    codeBytes: row?.code_bytes ?? 0,
    uploadedBytes: row?.uploaded_bytes ?? 0,
    fileCount: row?.file_count ?? 0,
  };
}

async function writeAssetRow(
  sql: AssetDb,
  row: {
    gameId: string;
    version: number;
    path: string;
    expectedType: ExpectedType;
    status: 'uploaded' | 'rejected';
    sizeBytes: number | null;
    sha256: string | null;
    source: 'scan' | 'creator';
    rejectReason: string | null;
  },
): Promise<void> {
  await sql`
    insert into public.game_assets
      (game_id, version, path, expected_type, status, size_bytes, content_sha256, source, reject_reason, updated_at)
    values
      (${row.gameId}, ${row.version}, ${row.path}, ${row.expectedType}, ${row.status}, ${row.sizeBytes},
       ${row.sha256}, ${row.source}, ${row.rejectReason}, now())
    on conflict (game_id, version, path) do update set
      status = excluded.status,
      size_bytes = excluded.size_bytes,
      content_sha256 = excluded.content_sha256,
      reject_reason = excluded.reject_reason,
      updated_at = now()
  `;
}

/** Store an accepted file, or record a rejection. A storage failure does not mark the row uploaded. */
export async function saveAssetDecision(
  sql: AssetDb,
  storage: AssetStorage,
  gameId: string,
  version: number,
  decision: Extract<AssetUploadDecision, { kind: 'store' | 'reject' }>,
  bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; code: 'storage' }> {
  if (decision.kind === 'store') {
    const objectPath = assetObjectPath(gameId, version, decision.path);
    if (!objectPath) return { ok: false, code: 'storage' };
    const put = await storage.upload(objectPath, bytes, decision.contentType);
    if (put.error) return { ok: false, code: 'storage' };
    await writeAssetRow(sql, {
      gameId,
      version,
      path: decision.path,
      expectedType: decision.expectedType,
      status: 'uploaded',
      sizeBytes: decision.sizeBytes,
      sha256: decision.sha256,
      source: decision.source,
      rejectReason: null,
    });
    return { ok: true };
  }
  await writeAssetRow(sql, {
    gameId,
    version,
    path: decision.path,
    expectedType: decision.expectedType,
    status: 'rejected',
    sizeBytes: null,
    sha256: null,
    source: decision.source,
    rejectReason: decision.message,
  });
  return { ok: true };
}
