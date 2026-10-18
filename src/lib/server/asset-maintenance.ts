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
 *   updated marker, still past the cutoff) under the games-row lock a live finalize
 *   holds. A row whose object exists, or one reserved inside the active window, is never
 *   touched.
 *
 * scripts/asset-maintenance.mjs runs runAssetMaintenance; everything here takes injected
 * sql + storage so the db test drives the same code.
 */
import type { AssetDb } from './asset-manifest.ts';
import { ASSET_STALE_AGE_MS } from './asset-upload.ts';

/** The slice of the games bucket the pass needs (the real bucket or a test double). */
export interface MaintenanceStorage {
  exists(path: string): Promise<boolean>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

/** The bucket methods the real adapter uses — structurally compatible with StorageFileApi. */
interface MaintenanceBucket {
  exists(path: string): Promise<{ data: boolean; error: unknown }>;
  remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
}

/**
 * The one real adapter over the Supabase Storage bucket — used by scripts/asset-maintenance.mjs
 * and the db tests so the fail-closed rule has a single implementation.
 */
export function maintenanceStorage(bucket: MaintenanceBucket): MaintenanceStorage {
  return {
    exists: async (path) => (await bucket.exists(path)).data === true,
    remove: async (paths) => {
      const res = await bucket.remove(paths);
      return { error: res.error ? { message: res.error.message } : null };
    },
  };
}

export interface MaintenanceReport {
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

/** Delete every staging object past the cutoff, in batches, through the Storage API. */
export async function sweepStaleStagingObjects(
  sql: AssetDb,
  storage: MaintenanceStorage,
  olderThan: Date,
): Promise<{ candidates: number; removed: number; errors: string[] }> {
  const names = await staleStagingObjectNames(sql, olderThan);
  const errors: string[] = [];
  let removed = 0;
  for (let i = 0; i < names.length; i += REMOVE_BATCH) {
    const batch = names.slice(i, i + REMOVE_BATCH);
    const res = await storage.remove(batch);
    if (res.error) errors.push(`remove staging objects: ${res.error.message}`);
    else removed += batch.length;
  }
  return { candidates: names.length, removed, errors };
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

/**
 * Delete 'uploaded' rows whose served object is gone. The Storage API answers existence;
 * only a missing object makes a row a victim, and private.clean_orphan_game_asset re-checks
 * the exact pinned row under the games-row lock before deleting, so a live finalize's newer
 * write — or a reservation still inside the active window — is never removed. A row that
 * errors is left alone and reported.
 */
export async function cleanOrphanedAssetRows(
  sql: AssetDb,
  storage: MaintenanceStorage,
  olderThan: Date,
): Promise<{ candidates: number; kept: number; deleted: number; errors: string[] }> {
  const candidates = await orphanCandidates(sql, olderThan);
  const errors: string[] = [];
  let kept = 0;
  let deleted = 0;
  for (const row of candidates) {
    const objectPath = `${row.gameId}/${row.version}/${row.path}`;
    try {
      if (await storage.exists(objectPath)) {
        kept += 1;
        continue;
      }
      const [res] = await sql<{ clean_orphan_game_asset: string }[]>`
        select private.clean_orphan_game_asset(
          ${row.gameId}, ${row.version}, ${row.path}, ${row.sha256}, ${row.sizeBytes},
          ${row.updatedAt}, ${olderThan})
      `;
      if (res?.clean_orphan_game_asset === 'deleted') deleted += 1;
      else kept += 1;
    } catch (error) {
      errors.push(`${objectPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { candidates: candidates.length, kept, deleted, errors };
}

/** One full pass: staging sweep, then orphan cleanup, both against the same cutoff. */
export async function runAssetMaintenance(sql: AssetDb, storage: MaintenanceStorage, now: number = Date.now()): Promise<MaintenanceReport> {
  const olderThan = new Date(now - ASSET_STALE_AGE_MS);
  const staging = await sweepStaleStagingObjects(sql, storage, olderThan);
  const orphans = await cleanOrphanedAssetRows(sql, storage, olderThan);
  return {
    stagingCandidates: staging.candidates,
    stagingRemoved: staging.removed,
    orphanCandidates: orphans.candidates,
    orphansKept: orphans.kept,
    orphansDeleted: orphans.deleted,
    errors: [...staging.errors, ...orphans.errors],
  };
}
