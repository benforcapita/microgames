/**
 * UP-4: maintenance for the signed-upload pipeline.
 *
 * Two kinds of litter accumulate from sign -> PUT -> finalize:
 *
 * - `_staging` objects whose finalize never ran (the uploader closed the tab, the signed
 *   PUT never happened). They are unservable — the CDN only maps numeric versions — but
 *   they occupy the bucket. The sweep deletes them once they are older than
 *   ASSET_STALE_AGE_MS, which is the uploadId TTL plus margin, so a staged object a
 *   still-valid uploadId could finalize is never swept. Deletes go through the Storage
 *   API: Supabase forbids direct SQL deletes on storage.objects.
 *
 * - 'uploaded' game_assets rows whose served object does not exist (finalize reserved the
 *   row, then died before the copy). The row is deleted — the same outcome as UP-3's
 *   copy-failure revert for a reservation that displaced nothing — but only through
 *   private.clean_orphan_game_asset, which re-checks the exact row (status, sha, size,
 *   updated marker, still past the cutoff) under the games-row lock a live finalize holds.
 *
 * NOTE: this commit carries the API surface the safety fixes plug into; the guards
 * themselves land in the next commit.
 *
 * scripts/asset-maintenance.mjs runs runAssetMaintenance; everything here takes injected
 * sql + storage so the db test drives the same code.
 */
import type { AssetDb } from './asset-manifest.ts';
import { ASSET_STALE_AGE_MS } from './asset-upload.ts';

/**
 * The slice of the games bucket the pass needs (the real bucket or a test double).
 * `sees` is a positive control for the canary only — whether a row or object is deleted
 * is decided in SQL / by the sweep's own listing, never by `sees`.
 */
export interface MaintenanceStorage {
  sees(path: string): Promise<boolean>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

/** The bucket methods the real adapter uses — structurally compatible with StorageFileApi. */
interface MaintenanceBucket {
  info(path: string): Promise<{ data: unknown; error: unknown }>;
  upload(
    path: string,
    body: Uint8Array,
    options: { contentType: string },
  ): Promise<{ data: unknown; error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
}

/**
 * The one real adapter over the Supabase Storage bucket — used by scripts/asset-maintenance.mjs
 * and the db tests so there is a single implementation.
 */
export function maintenanceStorage(bucket: MaintenanceBucket): MaintenanceStorage {
  return {
    sees: async (path) => (await bucket.info(path)).data !== null,
    upload: async (path, bytes, contentType) => {
      const res = await bucket.upload(path, bytes, { contentType });
      return { error: res.error ? { message: res.error.message } : null };
    },
    remove: async (paths) => {
      const res = await bucket.remove(paths);
      return { error: res.error ? { message: res.error.message } : null };
    },
  };
}

/** Per-run deletion caps — a run whose candidates exceed these refuses, deleting nothing. */
export const MAINTENANCE_MAX_ORPHAN_DELETES = 20;
export const MAINTENANCE_MAX_STAGING_REMOVES = 200;
/** Any single Storage call may take at most this long before the run fails. */
export const MAINTENANCE_STORAGE_TIMEOUT_MS = 15_000;

/** The run refused to delete — over a cap, or the storage canary failed. Nothing was removed. */
export class MaintenanceRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceRefusal';
  }
}

/**
 * Local-only by default: both endpoints must name a loopback host or the run is refused
 * before any connection is attempted (--allow-remote overrides).
 * STUB: not yet implemented.
 */
export function maintenanceRemoteRefusal(targets: { supabaseUrl: string; databaseUrl: string }): string | null {
  void targets;
  return null;
}

/**
 * fetch that aborts a Storage call after `timeoutMs`.
 * STUB: timeout not applied yet.
 */
export function maintenanceFetch(timeoutMs: number): typeof fetch {
  void timeoutMs;
  return (input, init) => fetch(input, init);
}

/**
 * Positive control run before anything is deleted: the Storage credential must see the
 * same project the database connection does.
 * STUB: not yet implemented.
 */
export async function storageCanary(sql: AssetDb, storage: MaintenanceStorage): Promise<string | null> {
  void sql;
  void storage;
  return null;
}

export interface MaintenanceOptions {
  /** Clock injection for tests. Defaults to Date.now(). */
  now?: number;
  /** Report candidates without deleting anything (no row deletes, no object removes). */
  dryRun?: boolean;
  maxOrphanDeletes?: number;
  maxStagingRemoves?: number;
}

export interface MaintenanceReport {
  dryRun: boolean;
  stagingCandidates: number;
  stagingRemoved: number;
  orphanCandidates: number;
  orphansKept: number;
  orphansDeleted: number;
  errors: string[];
}

const REMOVE_BATCH = 100;

/**
 * Staging object names created before `olderThan`. `_staging` is only ever the second
 * segment of an object name (`<game>/_staging/<nonce>`); a same-named directory inside a
 * versioned asset path is a real file and must not match — the CDN can serve those.
 */
export async function staleStagingObjectNames(sql: AssetDb, olderThan: Date): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select o.name
    from storage.objects o
    where o.bucket_id = 'games'
      and split_part(o.name, '/', 2) = '_staging'
      and o.created_at < ${olderThan}
    order by o.name
  `;
  return rows.map((r) => r.name);
}

async function removeStagingObjects(
  storage: MaintenanceStorage,
  names: string[],
): Promise<{ removed: number; errors: string[] }> {
  const errors: string[] = [];
  let removed = 0;
  for (let i = 0; i < names.length; i += REMOVE_BATCH) {
    const batch = names.slice(i, i + REMOVE_BATCH);
    const res = await storage.remove(batch);
    if (res.error) errors.push(`remove staging objects: ${res.error.message}`);
    else removed += batch.length;
  }
  return { removed, errors };
}

/** Delete every staging object past the cutoff, in batches, through the Storage API. */
export async function sweepStaleStagingObjects(
  sql: AssetDb,
  storage: MaintenanceStorage,
  olderThan: Date,
): Promise<{ candidates: number; removed: number; errors: string[] }> {
  const names = await staleStagingObjectNames(sql, olderThan);
  const res = await removeStagingObjects(storage, names);
  return { candidates: names.length, ...res };
}

interface OrphanCandidate {
  gameId: string;
  version: number;
  path: string;
  sizeBytes: number | null;
  sha256: string | null;
  /** updated_at as epoch-µs numeric text — the CAS pin needs sub-millisecond precision,
   *  and a timestamp-looking string can be coerced through a millisecond Date in transit. */
  updatedAt: string;
}

/**
 * 'uploaded' rows untouched past `olderThan`. The updated_at cutoff is the active-window
 * guard: a finalize's reservation is always fresher than the stale age (uploadId TTL plus
 * margin), so nothing in flight is ever a candidate. The marker is selected as epoch
 * seconds (numeric text) so it round-trips with microsecond precision.
 */
async function orphanCandidates(sql: AssetDb, olderThan: Date): Promise<OrphanCandidate[]> {
  const rows = await sql<
    { game_id: string; version: number; path: string; size_bytes: number | null; content_sha256: string | null; updated_at: string }[]
  >`
    select game_id, version, path, size_bytes, content_sha256, extract(epoch from updated_at)::text as updated_at
    from public.game_assets
    where status = 'uploaded' and updated_at < ${olderThan}
    order by game_id, version, path
  `;
  return rows.map((r) => ({
    gameId: r.game_id,
    version: r.version,
    path: r.path,
    sizeBytes: r.size_bytes,
    sha256: r.content_sha256,
    updatedAt: r.updated_at,
  }));
}

async function deleteOrphanRows(
  sql: AssetDb,
  orphans: OrphanCandidate[],
  olderThan: Date,
): Promise<{ kept: number; deleted: number; errors: string[] }> {
  const errors: string[] = [];
  let kept = 0;
  let deleted = 0;
  for (const row of orphans) {
    try {
      const [res] = await sql<{ clean_orphan_game_asset: string }[]>`
        select private.clean_orphan_game_asset(
          ${row.gameId}, ${row.version}, ${row.path}, ${row.sha256}, ${row.sizeBytes},
          ${row.updatedAt}, ${olderThan})
      `;
      if (res?.clean_orphan_game_asset === 'deleted') deleted += 1;
      else kept += 1;
    } catch (error) {
      errors.push(`${row.gameId}/${row.version}/${row.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { kept, deleted, errors };
}

/**
 * Delete 'uploaded' rows past the cutoff through private.clean_orphan_game_asset —
 * a compare-and-set delete under the same games-row lock record_game_asset holds.
 */
export async function cleanOrphanedAssetRows(
  sql: AssetDb,
  olderThan: Date,
): Promise<{ candidates: number; kept: number; deleted: number; errors: string[] }> {
  const orphans = await orphanCandidates(sql, olderThan);
  const res = await deleteOrphanRows(sql, orphans, olderThan);
  return { candidates: orphans.length, ...res };
}

/**
 * One full pass: staging sweep, then orphan cleanup, both against the same cutoff.
 * STUB: options (dry run, caps) and the storage canary are not wired yet.
 */
export async function runAssetMaintenance(
  sql: AssetDb,
  storage: MaintenanceStorage,
  options: MaintenanceOptions = {},
): Promise<MaintenanceReport> {
  const now = options.now ?? Date.now();
  const olderThan = new Date(now - ASSET_STALE_AGE_MS);
  const staging = await sweepStaleStagingObjects(sql, storage, olderThan);
  const orphans = await cleanOrphanedAssetRows(sql, olderThan);
  return {
    dryRun: false,
    stagingCandidates: staging.candidates,
    stagingRemoved: staging.removed,
    orphanCandidates: orphans.candidates,
    orphansKept: orphans.kept,
    orphansDeleted: orphans.deleted,
    errors: [...staging.errors, ...orphans.errors],
  };
}
