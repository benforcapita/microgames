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
 *   updated marker, still past the cutoff) AND the object's absence in storage.objects,
 *   under the games-row lock a live finalize holds. A row whose object exists, or one
 *   reserved inside the active window, is never touched.
 *
 * Safety posture (QA #79): "object missing" is decided in SQL against storage.objects over
 * the same connection and project as the delete — never by a Storage API answer, which an
 * under-privileged or wrong-project key can answer 'Object not found' for live objects.
 * Before deleting anything the pass refuses when the candidate count exceeds a per-run cap
 * and runs a storage canary proving the credential sees the same project the database does.
 *
 * scripts/asset-maintenance.mjs runs runAssetMaintenance; everything here takes injected
 * sql + storage so the db test drives the same code.
 */
import { randomBytes } from 'node:crypto';
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
 * and the db tests so there is a single implementation. `sees` is deliberately a plain
 * boolean (any error or absence reports "not seen"): only the canary consults it, where
 * not-seen aborts the run before anything is deleted.
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The pass deletes real rows and objects, so by default it is local-only: both endpoints
 * must name a loopback host or the run is refused before any connection is attempted.
 * A deliberate hosted run passes --allow-remote (scripts/asset-maintenance.mjs).
 */
export function maintenanceRemoteRefusal(targets: { supabaseUrl: string; databaseUrl: string }): string | null {
  for (const [name, raw] of [
    ['PUBLIC_SUPABASE_URL', targets.supabaseUrl],
    ['DATABASE_URL', targets.databaseUrl],
  ] as const) {
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      return `${name} is not a URL`;
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      return `${name} host '${host || '(none)'}' is not loopback — refusing to run maintenance against a remote target without --allow-remote`;
    }
  }
  return null;
}

/**
 * fetch that aborts a Storage call after `timeoutMs` — a Storage endpoint that hangs must
 * fail the run (as an error, with nothing deleted), never hang it. A caller signal still
 * wins when it fires first.
 */
export function maintenanceFetch(timeoutMs: number): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
}

const CANARY_PREFIX = 'maintenance-canary/';
const CANARY_BYTES = new Uint8Array([0x6d, 0x67]);

export interface StorageCanaryResult {
  /** Non-null when the proof failed — or, on an empty bucket with writes off, could not run. */
  refusal: string | null;
  /** The bucket was empty and `mayWrite` was off, so the canary could not be verified at all. */
  unverifiable: boolean;
}

/**
 * Positive control run before anything is deleted: the Storage credential must see the
 * same project the database connection does. When the database lists an object, the API
 * must `info` it — a publishable or other-project key answers 'Object not found' and the
 * run refuses (QA #79 B1: Storage RLS hid every object and three live rows were deleted).
 * When the bucket is empty there is nothing to check against, so a scratch object is
 * uploaded through the API and must appear in storage.objects — the same-project proof in
 * the other direction (and proof the key can write). `mayWrite: false` (a dry run) skips
 * that upload: the canary is then unverifiable, which the caller must report as a refusal.
 */
export async function storageCanary(
  sql: AssetDb,
  storage: MaintenanceStorage,
  opts: { mayWrite?: boolean } = {},
): Promise<StorageCanaryResult> {
  const [listed] = await sql<{ name: string }[]>`
    select o.name from storage.objects o where o.bucket_id = 'games' order by o.name limit 1
  `;
  if (listed) {
    try {
      if (await storage.sees(listed.name)) return { refusal: null, unverifiable: false };
    } catch (error) {
      return {
        refusal: `storage canary failed checking '${listed.name}': ${error instanceof Error ? error.message : String(error)}`,
        unverifiable: false,
      };
    }
    return {
      refusal: `storage canary failed: the database lists object '${listed.name}' but the Storage API cannot see it (wrong key or wrong project)`,
      unverifiable: false,
    };
  }
  if (opts.mayWrite === false) {
    return {
      refusal:
        'storage canary could not be verified: the games bucket is empty and a dry run may not upload the scratch canary object',
      unverifiable: true,
    };
  }
  const name = `${CANARY_PREFIX}${randomBytes(9).toString('base64url')}`;
  const put = await storage
    .upload(name, CANARY_BYTES, 'application/octet-stream')
    .catch((error: unknown) => ({ error: { message: error instanceof Error ? error.message : String(error) } }));
  if (put.error) return { refusal: `storage canary failed: cannot upload a canary object: ${put.error.message}`, unverifiable: false };
  try {
    const [seen] = await sql`select 1 as x from storage.objects o where o.bucket_id = 'games' and o.name = ${name}`;
    if (!seen)
      return {
        refusal: 'storage canary failed: an object just uploaded through the API is not visible to the database (wrong project)',
        unverifiable: false,
      };
    return { refusal: null, unverifiable: false };
  } finally {
    await storage.remove([name]).catch(() => {});
  }
}

export interface MaintenanceOptions {
  /** Clock injection for tests. Defaults to Date.now(). */
  now?: number;
  /** Report candidates and run the caps + canary without a single write (no row deletes,
   *  no object removes, no scratch canary upload). */
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
  /** Why this pass would refuse a real run (over a cap, or the canary); null means the checks passed. */
  wouldAbort: string | null;
  /** Dry-run only: the bucket held no object for the canary to check and writes were off. */
  canaryUnverified: boolean;
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
 * 'uploaded' rows untouched past `olderThan` whose served object is absent from
 * storage.objects — the same judgement private.clean_orphan_game_asset re-applies under
 * the games-row lock. Existence is decided in SQL over this same connection and project;
 * a Storage credential that cannot see an object can never make a live row look orphaned.
 * The updated_at cutoff is the active-window guard: a finalize's reservation is always
 * fresher than the stale age (uploadId TTL plus margin), so nothing in flight is ever a
 * candidate. The marker is selected as epoch seconds (numeric text) so it round-trips
 * with microsecond precision.
 */
async function orphanCandidates(sql: AssetDb, olderThan: Date): Promise<OrphanCandidate[]> {
  const rows = await sql<
    { game_id: string; version: number; path: string; size_bytes: number | null; content_sha256: string | null; updated_at: string }[]
  >`
    select a.game_id, a.version, a.path, a.size_bytes, a.content_sha256,
           extract(epoch from a.updated_at)::text as updated_at
    from public.game_assets a
    where a.status = 'uploaded' and a.updated_at < ${olderThan}
      and not exists (
        select 1 from storage.objects o
        where o.bucket_id = 'games'
          and o.name = concat(a.game_id, '/', a.version, '/', a.path)
      )
    order by a.game_id, a.version, a.path
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
 * Delete 'uploaded' rows whose served object is gone. Whether the object exists is decided
 * inside private.clean_orphan_game_asset — the delete predicate itself checks
 * storage.objects over this same connection, under the games-row lock, alongside the
 * compare-and-set pins. A row that errors is left alone and reported.
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
 * One full pass over the signed-upload pipeline. Candidates for both halves are listed
 * first, then the same checks run in both modes: a run whose candidate list exceeds a
 * per-run cap refuses, and the storage canary must prove the credential sees the project
 * the database does. A real run throws MaintenanceRefusal on the first failure — deleting
 * nothing at all — while a dry run reports it in `wouldAbort`; the dry run runs every
 * check (its canary is read-only: no scratch upload) so a hosted `--dry-run` proves the
 * key, the project and the scale before any real run. Only after the checks does a real
 * run remove staging objects and delete orphan rows.
 */
export async function runAssetMaintenance(
  sql: AssetDb,
  storage: MaintenanceStorage,
  options: MaintenanceOptions = {},
): Promise<MaintenanceReport> {
  const now = options.now ?? Date.now();
  const olderThan = new Date(now - ASSET_STALE_AGE_MS);
  const dryRun = options.dryRun === true;
  const stagingNames = await staleStagingObjectNames(sql, olderThan);
  const orphans = await orphanCandidates(sql, olderThan);

  const maxOrphans = options.maxOrphanDeletes ?? MAINTENANCE_MAX_ORPHAN_DELETES;
  const maxStaging = options.maxStagingRemoves ?? MAINTENANCE_MAX_STAGING_REMOVES;
  let wouldAbort: string | null = null;
  if (orphans.length > maxOrphans) {
    wouldAbort = `refusing to run: ${orphans.length} orphan asset rows exceed the per-run cap of ${maxOrphans} (--max-orphans raises it)`;
  } else if (stagingNames.length > maxStaging) {
    wouldAbort = `refusing to run: ${stagingNames.length} stale staging objects exceed the per-run cap of ${maxStaging} (--max-staging raises it)`;
  }
  // A real run stops here, before the canary may write anything; a dry run continues and
  // reports the first refusal — the same order a real run would hit them.
  if (wouldAbort && !dryRun) throw new MaintenanceRefusal(wouldAbort);
  const canary = await storageCanary(sql, storage, { mayWrite: !dryRun });
  if (canary.refusal) {
    if (!dryRun) throw new MaintenanceRefusal(canary.refusal);
    wouldAbort ??= canary.refusal;
  }

  const errors: string[] = [];
  let stagingRemoved = 0;
  let orphansKept = 0;
  let orphansDeleted = 0;
  if (!dryRun) {
    const swept = await removeStagingObjects(storage, stagingNames);
    stagingRemoved = swept.removed;
    errors.push(...swept.errors);
    const cleaned = await deleteOrphanRows(sql, orphans, olderThan);
    orphansKept = cleaned.kept;
    orphansDeleted = cleaned.deleted;
    errors.push(...cleaned.errors);
  }
  return {
    dryRun,
    stagingCandidates: stagingNames.length,
    stagingRemoved,
    orphanCandidates: orphans.length,
    orphansKept,
    orphansDeleted,
    wouldAbort,
    canaryUnverified: canary.unverifiable,
    errors,
  };
}
