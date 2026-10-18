/**
 * Owner upload of one asset into a game version.
 *
 * Limits live here (not in the scanner) so this keeps working if the scan
 * module stops exporting them. A missing-file warning is AS-4, not this upload.
 */
import crypto from 'node:crypto';
import { readManualReview } from './manual-review.ts';
import { createLimiter } from './abuse.ts';
import type { AssetDb } from './asset-manifest.ts';
import { canonicalAssetPath, extensionOf, type ExpectedType } from './asset-scan.ts';
import { containsHtmlMarker, sniffAsset, type SniffedFormat } from './asset-sniff.ts';

// One source for the limits and the size formatting: the client-safe module the AS-4 warnings also use.
import { ASSET_SIZE_WARN_BYTES, GAME_VERSION_MAX_BYTES } from '../asset-limits.ts';
export { ASSET_SIZE_WARN_BYTES, GAME_VERSION_MAX_BYTES, formatBytes } from '../asset-limits.ts';
/** Rows allowed on one game, across versions. */
export const MAX_ASSET_FILES = 200;

/** Asset posts allowed per signed-in user. Same sliding window as the other limiters. */
export const ASSET_UPLOAD_MAX = 30;
export const ASSET_UPLOAD_WINDOW_MS = 10 * 60_000;

/** UP-4: a signed uploadId stays finalizable for this long. Signed into the uploadId itself. */
export const ASSET_UPLOAD_ID_TTL_MS = 15 * 60_000;
/**
 * UP-4: how old a `_staging` object or an 'uploaded' row must be before maintenance touches
 * it — the uploadId TTL plus a wide margin, so nothing a still-finalizable upload or an
 * in-flight finalize could still claim is ever swept. One source for the staging sweep and
 * the orphan cleanup's active-window guard.
 */
export const ASSET_STALE_AGE_MS = ASSET_UPLOAD_ID_TTL_MS + 105 * 60_000;

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
  encoding: 'That path is not encoded correctly.',
  control: 'That path contains a NUL or a control character.',
  'not-uploaded': 'Nothing was uploaded to that path.',
  upload_expired: 'That upload link expired. Upload the file again.',
} as const;

/**
 * Same extensions the game CDN will serve (`cdn/handler.mjs` `ASSET_MIME`).
 * A test locks this object to that map so the two cannot drift.
 * SVG and HTML are on the list and are still rejected from their bytes.
 */
export const UPLOAD_MIME = {
  html: 'text/html; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  json: 'application/json; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
} as const;

export type UploadExtension = keyof typeof UPLOAD_MIME;

/** Sniffed formats that may be stored under each CDN extension. */
const FORMATS_BY_EXT: Record<UploadExtension, readonly SniffedFormat[]> = {
  html: [],
  png: ['png'],
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  gif: ['gif'],
  webp: ['webp'],
  avif: ['avif'],
  svg: [],
  ico: ['ico'],
  mp3: ['mp3'],
  ogg: ['ogg'],
  oga: ['ogg'],
  wav: ['wav'],
  m4a: ['m4a'],
  aac: ['aac'],
  flac: ['flac'],
  weba: ['weba'],
  woff: ['woff'],
  woff2: ['woff2'],
  ttf: ['ttf'],
  otf: ['otf'],
  json: ['json'],
  js: ['text', 'json'],
  mjs: ['text', 'json'],
  css: ['text', 'json'],
  wasm: ['wasm'],
  txt: ['text', 'json'],
};

const EXPECTED_BY_EXT: Record<UploadExtension, StoredAssetType> = {
  html: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', ico: 'image',
  mp3: 'audio', ogg: 'audio', oga: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', weba: 'audio',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font',
  json: 'json',
  js: 'text', mjs: 'text', css: 'text', txt: 'text',
  wasm: 'wasm',
};

/** js and mjs may contain the characters `<script` or `<html`. Other types may not. */
const SCRIPT_EXTENSIONS = new Set<UploadExtension>(['js', 'mjs']);

export type StoredAssetType = ExpectedType | 'wasm';

export function isUploadExtension(ext: string): ext is UploadExtension {
  return Object.prototype.hasOwnProperty.call(UPLOAD_MIME, ext);
}

const SNIFFED_FORMATS = new Set<string>([
  'png', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'mp3', 'ogg', 'wav', 'm4a', 'aac', 'flac', 'weba',
  'woff', 'woff2', 'ttf', 'otf', 'wasm', 'json', 'text',
]);

function isSniffedFormat(value: string): value is SniffedFormat {
  return SNIFFED_FORMATS.has(value);
}

/** A decoded path that would leave the game directory, including one hidden behind percent-encoding. */
function isDecodedTraversal(value: string): boolean {
  return value.includes('..') || value.includes('\\') || value.startsWith('/');
}

/**
 * NUL, other C0 controls, DEL, a percent-escape that is not two hex digits,
 * or a traversal that appears only after percent-decoding (`%252e%252e` → `..`).
 * Literal `../` is left for the path check so the upload page can still flash it.
 */
export function assetPathRejection(raw: string): { status: 400; code: 'encoding' | 'control' | 'path'; message: string } | null {
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) return { status: 400, code: 'encoding', message: ASSET_UPLOAD_MESSAGES.encoding };
  if (hasControlChar(raw)) return { status: 400, code: 'control', message: ASSET_UPLOAD_MESSAGES.control };
  let decoded = raw;
  for (let pass = 0; pass < 8 && /%[0-9A-Fa-f]{2}/.test(decoded); pass++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return { status: 400, code: 'encoding', message: ASSET_UPLOAD_MESSAGES.encoding };
    }
    if (next === decoded) break;
    decoded = next;
    if (hasControlChar(decoded)) return { status: 400, code: 'control', message: ASSET_UPLOAD_MESSAGES.control };
    if (isDecodedTraversal(decoded)) return { status: 400, code: 'path', message: ASSET_UPLOAD_MESSAGES.path };
  }
  return null;
}

export function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

export type AssetFlashCode = keyof typeof ASSET_UPLOAD_MESSAGES;

export function createAssetUploadLimiter(now?: () => number) {
  return createLimiter({ windowMs: ASSET_UPLOAD_WINDOW_MS, max: ASSET_UPLOAD_MAX, now });
}

export const assetUploadsByUser = createAssetUploadLimiter();

/**
 * What the version total becomes if `incomingBytes` join: code plus every uploaded asset,
 * minus the bytes of the file being replaced. Shared by the direct upload and the signed-upload
 * sign/finalize checks so the 4 MB rule has one source of truth.
 */
export function versionBytesAfterUpload(codeBytes: number, uploadedBytes: number, previousBytes: number, incomingBytes: number): number {
  return Math.max(0, codeBytes) + Math.max(0, uploadedBytes - previousBytes) + incomingBytes;
}

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

export function mismatchMessage(got: StoredAssetType, want: StoredAssetType): string {
  return `This file is ${got}, but the path expects ${want}.`;
}

export function extensionMismatchMessage(format: SniffedFormat, ext: string): string {
  return `This file is ${format}, but the path expects ${ext}.`;
}

const EXPECTED_TYPES: readonly StoredAssetType[] = ['image', 'audio', 'font', 'json', 'text', 'wasm'];

function isExpectedType(value: string | null): value is StoredAssetType {
  return !!value && (EXPECTED_TYPES as readonly string[]).includes(value);
}

export interface ExistingAsset {
  path: string;
  expectedType: StoredAssetType;
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
  | { kind: 'bad-request'; status: 400; code: 'encoding' | 'control' | 'path'; message: string }
  | { kind: 'flash'; code: AssetFlashCode }
  | {
      kind: 'reject';
      code: 'markup' | 'type' | 'mismatch' | 'too-big' | 'extension';
      path: string;
      expectedType: StoredAssetType;
      source: 'scan' | 'creator';
      message: string;
      totalBytes?: number;
      got?: StoredAssetType;
      format?: SniffedFormat;
      ext?: string;
    }
  | {
      kind: 'store';
      path: string;
      expectedType: StoredAssetType;
      source: 'scan' | 'creator';
      contentType: string;
      sha256: string;
      sizeBytes: number;
      warning: string | null;
    };

function rejectRow(
  path: string,
  expectedType: StoredAssetType,
  source: 'scan' | 'creator',
  code: 'markup' | 'type' | 'mismatch' | 'too-big' | 'extension',
  message: string,
  extra: { totalBytes?: number; got?: StoredAssetType; format?: SniffedFormat; ext?: string } = {},
): AssetUploadDecision {
  return { kind: 'reject', code, path, expectedType, source, message, ...extra };
}

/**
 * The 200-file cap denies only a write that would ADD a counted row. Every status except
 * 'rejected' already counts, so replacing an uploaded file or filling a scanned 'missing'
 * row is allowed even when the game is at or over the cap (manifest scans bypass
 * record_game_asset, so existing data can sit over 200). A new row, or a rejected audit
 * row revived as uploaded, adds one and is capped. private.record_game_asset applies this
 * same rule — the DB test in supabase/tests pins the SQL to these cases.
 */
export function assetWriteAddsCountedRow(status: ExistingAsset['status'] | null): boolean {
  return status === null || status === 'rejected';
}

/** Decide what an upload may do. Does not touch storage or Postgres. */
export function assessAssetUpload(input: AssessAssetInput): AssetUploadDecision {
  if (!input.userId) return { kind: 'login' };
  if (!input.ownerId || input.userId !== input.ownerId) return { kind: 'not-found' };
  const pathError = assetPathRejection(input.rawPath);
  if (pathError) return { kind: 'bad-request', status: 400, code: pathError.code, message: pathError.message };
  if (!input.rateAllowed) return { kind: 'flash', code: 'rate' };
  if (input.bytes.byteLength === 0) return { kind: 'flash', code: 'empty' };

  const canonical = canonicalAssetPath(input.rawPath);
  if (canonical.kind !== 'path') return { kind: 'flash', code: 'path' };
  const path = canonical.path;
  if (hasControlChar(path)) return { kind: 'bad-request', status: 400, code: 'control', message: ASSET_UPLOAD_MESSAGES.control };

  const ext = extensionOf(path);
  if (!isUploadExtension(ext)) return { kind: 'flash', code: 'path' };
  const row = input.existing && input.existing.path === path ? input.existing : null;
  if (!row && !input.adding) return { kind: 'flash', code: 'manifest' };
  // A rejected row is an audit trail, not a file: reviving it adds a counted row.
  if (assetWriteAddsCountedRow(row?.status ?? null) && input.fileCount >= MAX_ASSET_FILES) return { kind: 'flash', code: 'cap' };

  const expectedType = row?.expectedType ?? EXPECTED_BY_EXT[ext];
  const source = row?.source ?? 'creator';
  const sniffed = sniffAsset(input.bytes);
  if (!sniffed.ok) {
    if (sniffed.reason === 'svg' || sniffed.reason === 'html' || sniffed.reason === 'trailing') {
      const message = sniffed.reason === 'trailing' ? ASSET_UPLOAD_MESSAGES.type : ASSET_UPLOAD_MESSAGES.markup;
      const code = sniffed.reason === 'trailing' ? 'type' : 'markup';
      return rejectRow(path, expectedType, source, code, message);
    }
    return rejectRow(path, expectedType, source, 'type', ASSET_UPLOAD_MESSAGES.type);
  }
  if (!SCRIPT_EXTENSIONS.has(ext) && containsHtmlMarker(input.bytes)) {
    return rejectRow(path, expectedType, source, 'markup', ASSET_UPLOAD_MESSAGES.markup);
  }
  if (!FORMATS_BY_EXT[ext].includes(sniffed.format)) {
    return rejectRow(path, expectedType, source, 'extension', extensionMismatchMessage(sniffed.format, ext), {
      format: sniffed.format,
      ext,
    });
  }
  const matches = sniffed.expectedType === expectedType || (expectedType === 'text' && (sniffed.format === 'json' || sniffed.format === 'text'));
  if (!matches) {
    return rejectRow(path, expectedType, source, 'mismatch', mismatchMessage(sniffed.expectedType, expectedType), {
      got: sniffed.expectedType,
    });
  }

  const previous = row?.status === 'uploaded' ? (row.sizeBytes ?? 0) : 0;
  const nextTotal = versionBytesAfterUpload(input.codeBytes, input.uploadedBytes, previous, input.bytes.byteLength);
  if (nextTotal > GAME_VERSION_MAX_BYTES) {
    return rejectRow(path, expectedType, source, 'too-big', gameTooBigMessage(nextTotal), { totalBytes: nextTotal });
  }

  const contentType = UPLOAD_MIME[ext];
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
export function assetUploadQuery(decision: Exclude<AssetUploadDecision, { kind: 'login' | 'not-found' | 'bad-request' }>): Record<string, string> {
  if (decision.kind === 'flash') return { error: decision.code };
  if (decision.kind === 'reject') {
    const query: Record<string, string> = { error: decision.code };
    if (decision.code === 'too-big' && decision.totalBytes !== undefined) query.total = String(decision.totalBytes);
    if (decision.code === 'mismatch' && decision.got) {
      query.got = decision.got;
      query.want = decision.expectedType;
    }
    if (decision.code === 'extension' && decision.format && decision.ext) {
      query.format = decision.format;
      query.ext = decision.ext;
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
  } else if (code === 'extension') {
    const format = query.get('format');
    const ext = query.get('ext');
    if (format && isSniffedFormat(format) && ext && isUploadExtension(ext)) error = extensionMismatchMessage(format, ext);
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
  const canonical = canonicalAssetPath(path);
  if (canonical.kind !== 'path' || canonical.path !== path) return null;
  if (!isUploadExtension(extensionOf(path)) || hasControlChar(path)) return null;
  return `${gameId}/${version}/${path}`;
}

export interface AssetStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: { message: string } | null }>;
  remove(path: string): Promise<{ error: { message: string } | null }>;
}

export interface GameAssetRow {
  path: string;
  expectedType: StoredAssetType;
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
      (select count(*)::int from public.game_assets where game_id = ${gameId} and status <> 'rejected') as file_count
  `;
  return {
    codeBytes: row?.code_bytes ?? 0,
    uploadedBytes: row?.uploaded_bytes ?? 0,
    fileCount: row?.file_count ?? 0,
  };
}

/** State of the row displaced by a record_game_asset write, for a restore on failure. */
export interface RecordedAssetState {
  expectedType: StoredAssetType;
  status: 'missing' | 'uploaded' | 'rejected';
  sizeBytes: number | null;
  sha256: string | null;
  rejectReason: string | null;
  source: 'scan' | 'creator';
}

/** private.record_game_asset's verdict on one row write. */
export type RecordAssetResult =
  | { kind: 'ok'; previous: RecordedAssetState | null }
  | { kind: 'cap' }
  | { kind: 'too-big'; totalBytes: number }
  | { kind: 'not-found' };

interface RecordAssetRow {
  result: string;
  total_bytes: number | bigint | string | null;
  prev_status: string | null;
  prev_size_bytes: number | null;
  prev_sha256: string | null;
  prev_reject_reason: string | null;
  prev_source: string | null;
  prev_expected_type: string | null;
}

function parseRecordedState(row: RecordAssetRow): RecordedAssetState | null {
  if (row.prev_status === null) return null;
  const source = row.prev_source;
  const expectedType = row.prev_expected_type;
  if (
    !isStatus(row.prev_status) ||
    typeof source !== 'string' ||
    !isSource(source) ||
    typeof expectedType !== 'string' ||
    !isExpectedType(expectedType)
  ) {
    throw new Error(`record_game_asset returned an unreadable previous row: ${JSON.stringify(row)}`);
  }
  return {
    expectedType,
    status: row.prev_status,
    sizeBytes: row.prev_size_bytes,
    sha256: row.prev_sha256,
    rejectReason: row.prev_reject_reason,
    source,
  };
}

/**
 * The authoritative row write: the DB function locks the game's row, recomputes the caps
 * from game_assets (rejected rows count toward neither), and writes only when both hold.
 * Anything the route pre-checked is re-checked here, so concurrent writers serialize and
 * cannot overshoot. The caps come from this module's constants — the same values the
 * pre-checks use.
 */
async function recordGameAsset(
  sql: AssetDb,
  row: {
    gameId: string;
    version: number;
    path: string;
    expectedType: StoredAssetType;
    status: 'uploaded' | 'rejected';
    sizeBytes: number | null;
    sha256: string | null;
    source: 'scan' | 'creator';
    rejectReason: string | null;
  },
): Promise<RecordAssetResult> {
  const [res] = await sql<RecordAssetRow[]>`
    select result, total_bytes, prev_status, prev_size_bytes, prev_sha256, prev_reject_reason, prev_source, prev_expected_type
    from private.record_game_asset(
      ${row.gameId}, ${row.version}, ${row.path}, ${row.expectedType}, ${row.status},
      ${row.sizeBytes}, ${row.sha256}, ${row.source}, ${row.rejectReason},
      ${MAX_ASSET_FILES}, ${GAME_VERSION_MAX_BYTES})
  `;
  if (!res) throw new Error('record_game_asset returned no row');
  if (res.result === 'ok') return { kind: 'ok', previous: parseRecordedState(res) };
  if (res.result === 'cap') return { kind: 'cap' };
  if (res.result === 'too-big') return { kind: 'too-big', totalBytes: Number(res.total_bytes) };
  if (res.result === 'not-found') return { kind: 'not-found' };
  throw new Error(`record_game_asset returned ${res.result}`);
}

/**
 * Undo a reservation made by recordGameAsset when the storage write failed. Only applies
 * while the row is still the one this call wrote (same sha) — a newer finalize owns it.
 */
async function revertAssetRow(
  sql: AssetDb,
  gameId: string,
  version: number,
  path: string,
  wroteSha256: string,
  previous: RecordedAssetState | null,
  previousContentAt: Date | null,
): Promise<void> {
  if (previous === null) {
    await sql`
      delete from public.game_assets
      where game_id = ${gameId} and version = ${version} and path = ${path}
        and status = 'uploaded' and content_sha256 = ${wroteSha256}
    `;
    return;
  }
  await sql`
    update public.game_assets set
      status = ${previous.status},
      size_bytes = ${previous.sizeBytes},
      content_sha256 = ${previous.sha256},
      reject_reason = ${previous.rejectReason},
      source = ${previous.source},
      expected_type = ${previous.expectedType},
      content_at = ${previousContentAt},
      updated_at = now()
    where game_id = ${gameId} and version = ${version} and path = ${path}
      and status = 'uploaded' and content_sha256 = ${wroteSha256}
  `;
}

export type AssetSaveResult =
  | { ok: true }
  | { ok: false; code: 'storage' }
  | { ok: false; code: 'cap' }
  | { ok: false; code: 'too-big'; totalBytes: number };

/**
 * With manual review on, a public game goes back to pending before new asset bytes are
 * recorded. The CDN re-reads that stage on the asset row and hides the file until a
 * reviewer sets a public stage again (reviewed_at then moves to at least the asset's
 * content_at). A rejected upload does not call this. A failed copy can leave the game
 * pending, which keeps unreviewed bytes off the public URL.
 * `enabled` defaults to the database setting. Callers pass the boolean they already read.
 */
export async function holdApprovedGameForReview(
  sql: AssetDb,
  gameId: string,
  enabled?: boolean,
): Promise<boolean> {
  if (!(enabled ?? await readManualReview(sql))) return false;
  const held = await sql<{ id: string }[]>`
    update public.games
    set stage = 'pending'
    where id = ${gameId}
      and stage in ('proving', 'live')
    returning id
  `;
  return held.length > 0;
}

/**
 * Reserve the row, then copy the bytes to the served object path. The DB function is
 * authoritative on the caps, so a cap loser never writes the object — there is nothing to
 * un-copy, and a replaced asset never serves new bytes under its old row. When the copy
 * still fails, the row is restored to what it displaced.
 */
async function storeAsset(
  sql: AssetDb,
  storage: AssetStorage,
  gameId: string,
  version: number,
  decision: Extract<AssetUploadDecision, { kind: 'store' }>,
  bytes: Uint8Array,
): Promise<AssetSaveResult> {
  const objectPath = assetObjectPath(gameId, version, decision.path);
  if (!objectPath) return { ok: false, code: 'storage' };
  const reviewOn = await readManualReview(sql);
  await holdApprovedGameForReview(sql, gameId, reviewOn);
  const recorded = await recordGameAsset(sql, {
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
  if (recorded.kind === 'cap') return { ok: false, code: 'cap' };
  if (recorded.kind === 'too-big') return { ok: false, code: 'too-big', totalBytes: recorded.totalBytes };
  if (recorded.kind !== 'ok') return { ok: false, code: 'storage' };
  // Hide the row before the copy. An approval that lands while the bytes are moving
  // stamps reviewed_at against a null content_at, and the stamp below is later.
  const cleared = await sql<{ content_at: Date | null }[]>`
    with old as (
      select content_at
      from public.game_assets
      where game_id = ${gameId} and version = ${version} and path = ${decision.path}
        and status = 'uploaded' and content_sha256 = ${decision.sha256}
    ),
    cleared as (
      update public.game_assets
      set content_at = null
      where game_id = ${gameId} and version = ${version} and path = ${decision.path}
        and status = 'uploaded' and content_sha256 = ${decision.sha256}
      returning 1
    )
    select old.content_at from old, cleared
  `;
  const previousContentAt = cleared[0]?.content_at ?? null;
  if (cleared.length === 0) {
    await revertAssetRow(sql, gameId, version, decision.path, decision.sha256, recorded.previous, previousContentAt);
    return { ok: false, code: 'storage' };
  }
  const put = await storage.upload(objectPath, bytes, decision.contentType);
  if (put.error) {
    await revertAssetRow(sql, gameId, version, decision.path, decision.sha256, recorded.previous, previousContentAt);
    return { ok: false, code: 'storage' };
  }
  // clock_timestamp() is the wall clock of this statement, after the copy returned.
  await sql`
    update public.game_assets
    set content_at = clock_timestamp()
    where game_id = ${gameId} and version = ${version} and path = ${decision.path}
      and status = 'uploaded' and content_sha256 = ${decision.sha256}
  `;
  if (!reviewOn) {
    await sql`
      update public.games g
      set reviewed_at = a.content_at
      from public.game_assets a
      where a.game_id = g.id
        and a.game_id = ${gameId} and a.version = ${version} and a.path = ${decision.path}
        and a.content_sha256 = ${decision.sha256}
        and g.stage in ('proving', 'live')
        and (g.reviewed_at is null or g.reviewed_at < a.content_at)
    `;
  }
  return { ok: true };
}

async function rejectAssetRow(
  sql: AssetDb,
  gameId: string,
  version: number,
  decision: Extract<AssetUploadDecision, { kind: 'reject' }>,
): Promise<AssetSaveResult> {
  const recorded = await recordGameAsset(sql, {
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
  return recorded.kind === 'ok' ? { ok: true } : { ok: false, code: 'storage' };
}

/**
 * Store an accepted file, or record a rejection.
 * A rejected replacement of an uploaded file leaves that row and object alone, so the
 * counted size stays equal to the bytes still in the bucket. The CDN serves bucket
 * objects, so the rejected bytes are never written and cannot be served.
 * A storage failure does not mark the row uploaded.
 */
export async function saveAssetDecision(
  sql: AssetDb,
  storage: AssetStorage,
  gameId: string,
  version: number,
  decision: Extract<AssetUploadDecision, { kind: 'store' | 'reject' }>,
  bytes: Uint8Array,
  previous: Pick<GameAssetRow, 'status' | 'sizeBytes'> | null,
): Promise<AssetSaveResult> {
  if (decision.kind === 'store') return storeAsset(sql, storage, gameId, version, decision, bytes);
  if (previous?.status === 'uploaded') return { ok: true };
  const objectPath = assetObjectPath(gameId, version, decision.path);
  if (!objectPath) return { ok: false, code: 'storage' };
  if (previous?.status === 'rejected') {
    const removed = await storage.remove(objectPath);
    if (removed.error) return { ok: false, code: 'storage' };
  }
  return rejectAssetRow(sql, gameId, version, decision);
}

/**
 * UP-2a: record the outcome of a signed-upload finalize. On 'store' the row is reserved
 * under the cap lock first, then the scanned bytes are copied to the served object path
 * (upsert — a legit replacement overwrites the previous file); on 'reject' the row is
 * marked 'rejected'. The caller deletes the staged object — the finalize route removes it
 * on every exit path. A failed final copy restores the displaced row, so nothing is left
 * servable that the row does not describe.
 */
export async function saveFinalizedAsset(
  sql: AssetDb,
  storage: AssetStorage,
  gameId: string,
  version: number,
  decision: Extract<AssetUploadDecision, { kind: 'store' | 'reject' }>,
  bytes: Uint8Array,
): Promise<AssetSaveResult> {
  if (decision.kind === 'store') return storeAsset(sql, storage, gameId, version, decision, bytes);
  return rejectAssetRow(sql, gameId, version, decision);
}
