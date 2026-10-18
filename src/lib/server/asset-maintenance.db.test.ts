// UP-4: maintenance for the signed-upload pipeline. staleStagingObjectNames /
// sweepStaleStagingObjects collect `_staging` objects past the stale-age cutoff (Storage API
// deletes — direct SQL on storage.objects is blocked), and cleanOrphanedAssetRows deletes
// 'uploaded' rows whose served object is absent through private.clean_orphan_game_asset:
// a compare-and-set delete under the same games-row lock record_game_asset holds, whose
// predicate also requires the object to be absent from storage.objects — existence is
// judged in SQL over the same connection and project as the delete, so a wrong or
// under-privileged Storage key can never make a live row look orphaned (QA #79 B1).
// Runs only against a local stack.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { localSupabaseEnv } from '../../../scripts/lib/local-supabase.mjs';
import { ASSET_STALE_AGE_MS, GAME_VERSION_MAX_BYTES, MAX_ASSET_FILES } from './asset-upload.ts';
import {
  MAINTENANCE_MAX_ORPHAN_DELETES,
  MAINTENANCE_MAX_STAGING_REMOVES,
  MaintenanceRefusal,
  cleanOrphanedAssetRows,
  maintenanceRemoteRefusal,
  maintenanceStorage,
  runAssetMaintenance,
  staleStagingObjectNames,
  sweepStaleStagingObjects,
  type MaintenanceStorage,
} from './asset-maintenance.ts';

const supabaseDir = join(dirname(fileURLToPath(import.meta.url)), '../../../supabase');
const FIRST_MIGRATION = '20261018120000_clean_orphan_game_asset';
const MIGRATION = '20261018130000_clean_orphan_game_asset_object_check';
const CLEAN_FN = 'private.clean_orphan_game_asset(text, integer, text, text, integer, numeric, timestamptz)';
const SHA = (c: string) => c.repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('clean_orphan_game_asset migration files', () => {
  it('the object-check migration sorts after the original and is the last migration', () => {
    const names = readdirSync(join(supabaseDir, 'migrations')).sort();
    const first = names.indexOf(`${FIRST_MIGRATION}.sql`);
    assert.ok(first >= 0, 'the original clean_orphan migration stays in the PR history');
    assert.equal(names.at(-1), `${MIGRATION}.sql`, `last migration: ${names.at(-1)}`);
  });
});

interface Ctx {
  sql: postgres.Sql;
  env: ReturnType<typeof localSupabaseEnv>;
  storage: MaintenanceStorage;
  exists: (path: string) => Promise<boolean>;
  upload: (path: string) => Promise<void>;
}

async function connect(t: { skip: (message?: string) => void }, max = 2): Promise<Ctx | undefined> {
  let env: ReturnType<typeof localSupabaseEnv>;
  try {
    env = localSupabaseEnv();
  } catch {
    t.skip('local supabase is not running');
    return undefined;
  }
  try {
    const host = new URL(env.DATABASE_URL).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
      t.skip('refusing to run maintenance SQL against a non-local database');
      return undefined;
    }
  } catch {
    t.skip('refusing to run maintenance SQL against a non-local database');
    return undefined;
  }
  const sql = postgres(env.DATABASE_URL, { connect_timeout: 3, max, idle_timeout: 1 });
  try {
    await sql`select 1`;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    t.skip('local supabase is not running');
    return undefined;
  }
  const games = createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  }).storage.from('games');
  const exists = async (path: string) => {
    const res = await games.info(path);
    return res.data !== null;
  };
  return {
    sql,
    env,
    exists,
    upload: async (path) => {
      const res = await games.upload(path, PNG, { contentType: 'image/png' });
      assert.equal(res.error, null, `fixture upload ${path}: ${res.error?.message}`);
    },
    // The tests drive the same adapter the script runs — one source of truth.
    storage: maintenanceStorage(games),
  };
}

async function makeGame(sql: postgres.Sql): Promise<string> {
  // assetObjectPath accepts only 6–16 chars of the id-safe charset.
  const id = `am${randomBytes(6).toString('hex')}`;
  await sql`
    insert into public.games (id, slug, creator, title, stage, size_bytes)
    values (${id}, ${id}, 'stub', 'Maint', 'proving', 100)
  `;
  return id;
}

async function addAssetRow(
  sql: postgres.Sql,
  gameId: string,
  path: string,
  opts: { status?: string; sizeBytes?: number | null; sha?: string | null; ageHours?: number; version?: number } = {},
) {
  // Rows are aged with SQL now() - interval, not a JS Date: real reservations carry
  // microsecond precision, which is exactly what the updated_at marker has to pin.
  await sql`
    insert into public.game_assets
      (game_id, version, path, expected_type, status, size_bytes, content_sha256, source, updated_at)
    values (${gameId}, ${opts.version ?? 1}, ${path}, 'image', ${opts.status ?? 'uploaded'},
            ${opts.sizeBytes ?? 10}, ${opts.sha === undefined ? SHA('a') : opts.sha},
            'creator', now() - make_interval(hours => ${opts.ageHours ?? 0}))
  `;
}

/** The updated marker clean_orphan_game_asset pins: epoch seconds as numeric text. */
const uaEpoch = async (sql: postgres.Sql, gameId: string, path: string) =>
  (
    await sql<{ e: string }[]>`
      select extract(epoch from updated_at)::text as e
      from public.game_assets where game_id = ${gameId} and version = 1 and path = ${path}
    `
  )[0]?.e;

const rowOf = async (sql: postgres.Sql, gameId: string, path: string, version = 1) =>
  (
    await sql<{ status: string; content_sha256: string | null }[]>`
      select status, content_sha256 from public.game_assets
      where game_id = ${gameId} and version = ${version} and path = ${path}
    `
  )[0];

const clean = (
  sql: postgres.Sql | postgres.TransactionSql,
  gameId: string,
  path: string,
  row: { sha: string | null; size: number | null; updatedAt: string },
  olderThan: Date,
) =>
  sql<{ clean_orphan_game_asset: string }[]>`
    select private.clean_orphan_game_asset(
      ${gameId}, 1, ${path}, ${row.sha}, ${row.size}, ${row.updatedAt}, ${olderThan})
  `.then((rows) => rows[0]?.clean_orphan_game_asset);

/** Seed an aged 'uploaded' row and return the exact pin the cleanup would be called with. */
async function seededRow(sql: postgres.Sql, gameId: string, path: string, opts: Parameters<typeof addAssetRow>[3] = {}) {
  await addAssetRow(sql, gameId, path, { ageHours: 3, ...opts });
  return {
    sha: opts.sha === undefined ? SHA('a') : opts.sha,
    size: opts.sizeBytes === undefined ? 10 : opts.sizeBytes,
    updatedAt: (await uaEpoch(sql, gameId, path)) ?? '',
  };
}

describe('private.clean_orphan_game_asset', () => {
  it('is a security-definer function only service_role and postgres may execute', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    try {
      const [migration] = await sql<{ version: string }[]>`
        select version from supabase_migrations.schema_migrations where version = '20261018130000'
      `;
      assert.equal(migration?.version, '20261018130000');

      const [fn] = await sql<{ prosecdef: boolean; proacl: string[] | null; proconfig: string[] | null }[]>`
        select p.prosecdef, p.proacl, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'clean_orphan_game_asset'
      `;
      assert.equal(fn?.prosecdef, true);
      assert.deepEqual(fn?.proconfig, ['search_path=""']);
      assert.ok(fn?.proacl?.every((acl) => !acl.startsWith('=')), `proacl: ${JSON.stringify(fn?.proacl)}`);

      const [priv] = await sql<{ anon: boolean; authenticated: boolean; service: boolean }[]>`
        select has_function_privilege('anon', ${CLEAN_FN}, 'EXECUTE') as anon,
               has_function_privilege('authenticated', ${CLEAN_FN}, 'EXECUTE') as authenticated,
               has_function_privilege('service_role', ${CLEAN_FN}, 'EXECUTE') as service
      `;
      assert.deepEqual({ ...priv }, { anon: false, authenticated: false, service: true });
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('skips a row whose object exists in the games bucket, and deletes it once the object is gone', async (t) => {
    // The B1 fix: whether the served object exists is part of the delete predicate in SQL
    // (storage.objects over the same connection), never a Storage API answer. A row whose
    // object exists is 'skipped' even when every CAS pin matches; once the object really
    // is gone, the same call deletes.
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    const gameId = await makeGame(sql);
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    try {
      const pin = await seededRow(sql, gameId, 'served.png');
      await c.upload(`${gameId}/1/served.png`);
      assert.equal(await clean(sql, gameId, 'served.png', pin, olderThan), 'skipped', 'object present — never orphaned');
      assert.equal((await rowOf(sql, gameId, 'served.png'))?.status, 'uploaded');

      const removed = await c.storage.remove([`${gameId}/1/served.png`]);
      assert.equal(removed.error, null);
      assert.equal(await clean(sql, gameId, 'served.png', pin, olderThan), 'deleted', 'object gone — the row is an orphan');
      assert.equal(await rowOf(sql, gameId, 'served.png'), undefined);
    } finally {
      await c.storage.remove([`${gameId}/1/served.png`]).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('rejects a judge whose sha, size, updated marker or status no longer matches', async (t) => {
    // Each compare-and-set pin is load-bearing on its own: rows are seeded old (so the
    // updated_at cutoff alone cannot rescue a dropped pin) and each call mismatches
    // exactly one field while every other pin still matches.
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    const gameId = await makeGame(sql);
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    try {
      for (const bad of [
        { path: 'pin-sha.png', pin: { sha: SHA('z') } },
        { path: 'pin-size.png', pin: { size: 11 } },
        { path: 'pin-ua.png', pin: { updatedAt: '0' } },
      ]) {
        const pin = await seededRow(sql, gameId, bad.path);
        const res = await clean(sql, gameId, bad.path, { ...pin, ...bad.pin }, olderThan);
        assert.equal(res, 'skipped', `${bad.path}: one mismatched pin must skip`);
        assert.ok((await rowOf(sql, gameId, bad.path))?.status === 'uploaded', `${bad.path} still present`);
      }
      // The status pin: an old rejected row carrying a sha is still not a victim.
      const rej = await seededRow(sql, gameId, 'pin-status.png', { status: 'rejected', sha: SHA('f'), sizeBytes: 10 });
      assert.equal(await clean(sql, gameId, 'pin-status.png', rej, olderThan), 'skipped');
      assert.equal((await rowOf(sql, gameId, 'pin-status.png'))?.status, 'rejected');
      // Control: the exact pin deletes, so the test can see success.
      const ctl = await seededRow(sql, gameId, 'pin-ctl.png');
      assert.equal(await clean(sql, gameId, 'pin-ctl.png', ctl, olderThan), 'deleted');
      assert.equal(await rowOf(sql, gameId, 'pin-ctl.png'), undefined);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('deletes only the exact uploaded row it was pointed at, and is idempotent', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    const gameId = await makeGame(sql);
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    try {
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });
      const gone = { sha: SHA('a'), size: 10, updatedAt: (await uaEpoch(sql, gameId, 'gone.png')) ?? '' };
      assert.equal(await clean(sql, gameId, 'gone.png', gone, olderThan), 'deleted');
      assert.equal(await rowOf(sql, gameId, 'gone.png'), undefined, 'the judged-orphan row is gone');
      // Idempotent: the same call again finds nothing to do.
      assert.equal(await clean(sql, gameId, 'gone.png', gone, olderThan), 'skipped');

      // A row that no longer matches the pinned sha is someone else's write — never touched.
      await addAssetRow(sql, gameId, 'keep.png', { sha: SHA('b'), sizeBytes: 10, ageHours: 3 });
      assert.equal(await clean(sql, gameId, 'keep.png', gone, olderThan), 'skipped');
      assert.equal((await rowOf(sql, gameId, 'keep.png'))?.content_sha256, SHA('b'));

      // A reservation inside the active finalize window is never touched either.
      await addAssetRow(sql, gameId, 'fresh.png', { sha: SHA('c'), sizeBytes: 10 });
      const fresh = { sha: SHA('c'), size: 10, updatedAt: (await uaEpoch(sql, gameId, 'fresh.png')) ?? '' };
      assert.equal(await clean(sql, gameId, 'fresh.png', fresh, olderThan), 'skipped');
      assert.equal((await rowOf(sql, gameId, 'fresh.png'))?.status, 'uploaded');

      // A same-sha re-finalize bumps updated_at in record_game_asset, so the judged marker
      // no longer matches — the CAS pin rejects the cleanup even for identical content.
      await addAssetRow(sql, gameId, 'samesha.png', { sha: SHA('d'), sizeBytes: 10, ageHours: 3 });
      const before = { sha: SHA('d'), size: 10, updatedAt: (await uaEpoch(sql, gameId, 'samesha.png')) ?? '' };
      await sql`
        select result from private.record_game_asset(
          ${gameId}, 1, 'samesha.png', 'image', 'uploaded',
          10, ${SHA('d')}, 'creator', null, ${MAX_ASSET_FILES}, ${GAME_VERSION_MAX_BYTES})
      `;
      assert.equal(await clean(sql, gameId, 'samesha.png', before, olderThan), 'skipped');
      assert.equal((await rowOf(sql, gameId, 'samesha.png'))?.status, 'uploaded');

      // A deleted game's rows cascade away first — the function only reports it.
      assert.equal(await clean(sql, 'no-such-game', 'x.png', gone, olderThan), 'not-found');
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('queues on the games-row lock and never deletes a live reservation', async (t) => {
    // Two deterministic halves, no sleeps — like the UP-3 lock test.
    // (1) A holds only the game's FOR NO KEY UPDATE lock — the lock a finalize takes in
    //     record_game_asset — inside an open transaction. B's cleanup call must queue on
    //     it (lock_timeout proves the wait; a row lock cannot be what B hits, because A
    //     never writes the asset row).
    // (2) After a live finalize commits a newer reservation on the row, the same cleanup
    //     call must skip it: the compare-and-set pin no longer matches, so the row is
    //     never deleted underneath an in-flight upload.
    const a = await connect(t);
    if (!a) return;
    const b = await connect(t);
    if (!b) {
      await a.sql.end({ timeout: 1 }).catch(() => {});
      return;
    }
    const gameId = await makeGame(a.sql);
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    let signalRelease: (() => void) | undefined;
    try {
      await addAssetRow(a.sql, gameId, 'race.png', { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });
      const judged = { sha: SHA('a'), size: 10, updatedAt: (await uaEpoch(a.sql, gameId, 'race.png')) ?? '' };

      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => (signalLocked = resolve));
      const release = new Promise<void>((resolve) => (signalRelease = resolve));
      const aTxn = a.sql
        .begin(async (tx) => {
          try {
            await tx`select id from public.games where id = ${gameId} for no key update`;
          } finally {
            signalLocked();
          }
          await release;
        })
        .then(
          () => 'committed',
          (e: unknown) => `a-error: ${e}`,
        );
      await locked;

      // Without the games-row lock inside clean_orphan_game_asset, B's call would run
      // straight through and delete the (matching, genuinely stale) row instead of
      // queueing — this is what proves the function serializes against finalize.
      const blocked = await b.sql
        .begin(async (tx) => {
          await tx`set local lock_timeout = '1s'`;
          await clean(tx, gameId, 'race.png', judged, olderThan);
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(
        blocked instanceof postgres.PostgresError,
        `the cleanup call must queue on the games-row lock and trip lock_timeout, got: ${String(blocked)}`,
      );
      assert.equal(blocked.code, '55P03');
      signalRelease?.();
      assert.equal(await aTxn, 'committed');

      // A live finalize commits a newer reservation on the same row — through
      // record_game_asset, exactly what a real concurrent finalize does. The cleanup's
      // pinned marker no longer matches, so the row is skipped, not deleted.
      const [reserved] = await b.sql<{ result: string }[]>`
        select result from private.record_game_asset(
          ${gameId}, 1, 'race.png', 'image', 'uploaded',
          20, ${SHA('b')}, 'creator', null, ${MAX_ASSET_FILES}, ${GAME_VERSION_MAX_BYTES})
      `;
      assert.equal(reserved?.result, 'ok');
      assert.equal(await clean(b.sql, gameId, 'race.png', judged, olderThan), 'skipped');
      const row = await rowOf(b.sql, gameId, 'race.png');
      assert.equal(row?.status, 'uploaded');
      assert.equal(row?.content_sha256, SHA('b'), 'the live reservation survives the cleanup');
    } finally {
      signalRelease?.();
      await a.sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await a.sql.end({ timeout: 1 }).catch(() => {});
      await b.sql.end({ timeout: 1 }).catch(() => {});
    }
  });
});

describe('sweepStaleStagingObjects', () => {
  it('deletes only staging objects past the cutoff, through the Storage API', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql, storage, exists, upload } = c;
    const gameId = await makeGame(sql);
    const stale = `${gameId}/_staging/${randomBytes(8).toString('hex')}`;
    const fresh = `${gameId}/_staging/${randomBytes(8).toString('hex')}`;
    const served = `${gameId}/1/served.png`;
    const deep = `${gameId}/1/dir/_staging/real.png`;
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    try {
      for (const path of [stale, fresh, served, deep]) await upload(path);
      // Backdate the stale staging object AND two non-staging objects past the cutoff:
      // a served path and a _staging-looking directory inside a versioned asset path —
      // the sweep's idea of "staging" is only the second segment of the object name.
      await sql`
        update storage.objects set created_at = now() - interval '3 hours'
        where bucket_id = 'games' and name in (${stale}, ${served}, ${deep})
      `;

      const names = await staleStagingObjectNames(sql, olderThan);
      assert.ok(names.includes(stale), 'the stale staging object is a candidate');
      assert.ok(!names.includes(fresh), 'a fresh staging object is never a candidate');
      assert.ok(!names.includes(served), 'a served-path object is never a candidate');
      assert.ok(!names.includes(deep), 'a _staging directory inside a versioned path is never a candidate');

      const res = await sweepStaleStagingObjects(sql, storage, olderThan);
      assert.deepEqual(res.errors, []);
      assert.ok(res.removed >= 1);
      assert.equal(await exists(stale), false, 'the stale staging object is deleted');
      assert.equal(await exists(fresh), true, 'the fresh staging object is untouched');
      assert.equal(await exists(served), true, 'the served object is untouched');
      assert.equal(await exists(deep), true, 'the versioned-path file is untouched');

      // Idempotent: nothing of this game is left to sweep.
      const again = await sweepStaleStagingObjects(sql, storage, olderThan);
      assert.ok(!(await staleStagingObjectNames(sql, olderThan)).includes(stale));
      assert.deepEqual(again.errors, []);
    } finally {
      await c.storage.remove([stale, fresh, served, deep]).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });
});

describe('cleanOrphanedAssetRows', () => {
  it('deletes only uploaded rows whose object is really gone and past the window', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql, upload } = c;
    const gameId = await makeGame(sql);
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    try {
      // The crash-between-reserve-and-copy case: 'uploaded' row, no object behind it.
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });
      // Same age but the object exists — the reservation completed; never even a
      // candidate: the SQL listing filters on storage.objects, same connection.
      await addAssetRow(sql, gameId, 'live.png', { sha: SHA('b'), sizeBytes: 10, ageHours: 3 });
      await upload(`${gameId}/1/live.png`);
      // No object, but the reservation is still inside the active finalize window.
      await addAssetRow(sql, gameId, 'fresh.png', { sha: SHA('c'), sizeBytes: 10 });
      // A 'missing' scan row is not an upload reservation — never a candidate.
      await addAssetRow(sql, gameId, 'scan.png', { status: 'missing', sizeBytes: null, sha: null, ageHours: 3 });

      const res = await cleanOrphanedAssetRows(sql, olderThan);
      assert.deepEqual(res.errors, []);
      assert.ok(res.deleted >= 1);

      assert.equal(await rowOf(sql, gameId, 'gone.png'), undefined, 'the orphaned reservation is deleted');
      assert.equal((await rowOf(sql, gameId, 'live.png'))?.status, 'uploaded', 'a row whose object exists is never touched');
      assert.equal((await rowOf(sql, gameId, 'fresh.png'))?.status, 'uploaded', 'an active-window reservation is never touched');
      assert.equal((await rowOf(sql, gameId, 'scan.png'))?.status, 'missing', 'a scan row is never a candidate');

      const again = await cleanOrphanedAssetRows(sql, olderThan);
      assert.equal(again.deleted, 0, 'idempotent: nothing left to delete');
      assert.deepEqual(again.errors, []);
    } finally {
      await c.storage.remove([`${gameId}/1/live.png`]).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });
});

describe('runAssetMaintenance', () => {
  it('sweeps stale staging objects and deletes orphaned reservations in one report', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql, upload } = c;
    const gameId = await makeGame(sql);
    const stale = `${gameId}/_staging/${randomBytes(8).toString('hex')}`;
    try {
      await upload(stale);
      await sql`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'games' and name = ${stale}`;
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });

      const report = await runAssetMaintenance(sql, c.storage);
      assert.deepEqual(report.errors, []);
      assert.ok(report.stagingRemoved >= 1, `report: ${JSON.stringify(report)}`);
      assert.ok(report.orphansDeleted >= 1, `report: ${JSON.stringify(report)}`);
      assert.equal(await c.exists(stale), false);
      assert.equal(await rowOf(sql, gameId, 'gone.png'), undefined);
    } finally {
      await c.storage.remove([stale]).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('dry run reports the candidates and deletes nothing', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql, upload } = c;
    const gameId = await makeGame(sql);
    const stale = `${gameId}/_staging/${randomBytes(8).toString('hex')}`;
    try {
      await upload(stale);
      await sql`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'games' and name = ${stale}`;
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });
      await addAssetRow(sql, gameId, 'live.png', { sha: SHA('b'), sizeBytes: 10, ageHours: 3 });
      await upload(`${gameId}/1/live.png`);

      const report = await runAssetMaintenance(sql, c.storage, { dryRun: true });
      assert.equal(report.dryRun, true);
      assert.ok(report.stagingCandidates >= 1 && report.orphanCandidates >= 1, `report: ${JSON.stringify(report)}`);
      assert.equal(report.stagingRemoved + report.orphansDeleted, 0, 'a dry run removes nothing');

      assert.equal(await c.exists(stale), true, 'dry run keeps the staging object');
      assert.equal((await rowOf(sql, gameId, 'gone.png'))?.status, 'uploaded', 'dry run keeps the orphan row');
      assert.equal((await rowOf(sql, gameId, 'live.png'))?.status, 'uploaded');
    } finally {
      await c.storage.remove([stale, `${gameId}/1/live.png`]).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('refuses to delete anything when orphan candidates exceed the per-run cap', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    const gameId = await makeGame(sql);
    const stale = `${gameId}/_staging/${randomBytes(8).toString('hex')}`;
    const overCap = MAINTENANCE_MAX_ORPHAN_DELETES + 5;
    try {
      await c.upload(stale);
      await sql`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'games' and name = ${stale}`;
      for (let i = 0; i < overCap; i++) {
        await addAssetRow(sql, gameId, `o-${i}.png`, { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });
      }

      await assert.rejects(
        runAssetMaintenance(sql, c.storage),
        (error: unknown) =>
          error instanceof MaintenanceRefusal && /orphan/.test(error.message) && String(overCap) && error.message.includes(String(overCap)),
        'over the orphan cap the run must refuse',
      );
      const [rows] = await sql<{ n: number }[]>`select count(*)::int as n from public.game_assets where game_id = ${gameId}`;
      assert.equal(rows?.n, overCap, 'a refused run deletes no rows');
      assert.equal(await c.exists(stale), true, 'a refused run removes no staging objects either');

      // The cap is a guardrail, not a wall: raising it runs the same pass. A generous
      // limit so concurrent test fixtures elsewhere in the suite cannot push it over.
      const report = await runAssetMaintenance(sql, c.storage, { maxOrphanDeletes: 500 });
      assert.ok(report.orphansDeleted >= overCap, `report: ${JSON.stringify(report)}`);
      assert.equal((await sql`select count(*)::int as n from public.game_assets where game_id = ${gameId}`)[0]?.n, 0);
    } finally {
      await c.storage.remove([stale]).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('refuses to delete anything when staging candidates exceed the per-run cap', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    const gameId = await makeGame(sql);
    const overCap = MAINTENANCE_MAX_STAGING_REMOVES + 1;
    const names = Array.from({ length: overCap }, (_, i) => `${gameId}/_staging/${i + 1}`);
    try {
      // Object rows without files are enough: listing is a storage.objects query, and the
      // refusal must fire before the first Storage API remove.
      await sql`
        insert into storage.objects (bucket_id, name, created_at)
        select 'games', ${gameId} || '/_staging/' || g, now() - interval '3 hours'
        from generate_series(1, ${overCap}) g
      `;

      await assert.rejects(
        runAssetMaintenance(sql, c.storage),
        (error: unknown) => error instanceof MaintenanceRefusal && /staging/.test(error.message),
        'over the staging cap the run must refuse',
      );
      const [left] = await sql<{ n: number }[]>`
        select count(*)::int as n from storage.objects where bucket_id = 'games' and name = any(${names})
      `;
      assert.equal(left?.n, overCap, 'a refused run removes no staging objects');
    } finally {
      await c.storage.remove(names).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('aborts when the Storage credential cannot see an object the database lists', async (t) => {
    // QA #79 B1/S4: SUPABASE_SECRET_KEY set to the publishable key — Storage RLS answers
    // 'Object not found' for objects that exist. The canary must see that and refuse
    // before a single row or object is touched.
    const c = await connect(t);
    if (!c) return;
    const { sql, env, upload } = c;
    const gameId = await makeGame(sql);
    const stale = `${gameId}/_staging/${randomBytes(8).toString('hex')}`;
    try {
      await addAssetRow(sql, gameId, 'live.png', { sha: SHA('b'), sizeBytes: 10, ageHours: 3 });
      await upload(`${gameId}/1/live.png`);
      await upload(stale);
      await sql`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'games' and name = ${stale}`;

      const anonStorage = maintenanceStorage(
        createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
          auth: { persistSession: false },
        }).storage.from('games'),
      );
      await assert.rejects(
        runAssetMaintenance(sql, anonStorage),
        (error: unknown) => error instanceof MaintenanceRefusal && /canary/i.test(error.message),
      );
      assert.equal((await rowOf(sql, gameId, 'live.png'))?.status, 'uploaded', 'a live row is never deleted on a bad key');
      assert.equal(await c.exists(stale), true, 'the staging object is not removed on a bad key');
    } finally {
      await c.storage.remove([stale, `${gameId}/1/live.png`]).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('aborts when the Storage endpoint cannot see the project at all', async (t) => {
    // A DB/Storage project mismatch (or a dead Storage) must fail the run closed —
    // a Storage failure must never cause a deletion.
    const c = await connect(t);
    if (!c) return;
    const { sql, env } = c;
    const gameId = await makeGame(sql);
    try {
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });

      // A loopback port nothing listens on: every Storage call fails.
      const dead = maintenanceStorage(
        createClient('http://127.0.0.1:1', env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from('games'),
      );
      await assert.rejects(runAssetMaintenance(sql, dead), MaintenanceRefusal);
      // And a Storage whose info always fails on the real client — same fail-closed path.
      const failing = maintenanceStorage(
        createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
          auth: { persistSession: false },
          global: {
            fetch: async () => new Response(JSON.stringify({ statusCode: '500', error: 'upstream', message: 'boom' }), { status: 500 }),
          },
        }).storage.from('games'),
      );
      await assert.rejects(runAssetMaintenance(sql, failing), MaintenanceRefusal);

      assert.equal((await rowOf(sql, gameId, 'gone.png'))?.status, 'uploaded', 'the row is kept when Storage cannot be trusted');
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });
});

describe('maintenanceRemoteRefusal', () => {
  it('accepts loopback targets and refuses remote or unparseable ones', () => {
    for (const supabaseUrl of ['http://127.0.0.1:56700', 'http://localhost:56700', 'http://[::1]:56700']) {
      const refusal = maintenanceRemoteRefusal({
        supabaseUrl,
        databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:56701/postgres',
      });
      assert.equal(refusal, null, supabaseUrl);
    }
    const remoteDb = maintenanceRemoteRefusal({
      supabaseUrl: 'http://127.0.0.1:56700',
      databaseUrl: 'postgresql://postgres:postgres@203.0.113.9:5432/postgres',
    });
    assert.match(remoteDb ?? '', /DATABASE_URL.*loopback/i);
    const remoteSb = maintenanceRemoteRefusal({
      supabaseUrl: 'https://project.supabase.co',
      databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:56701/postgres',
    });
    assert.match(remoteSb ?? '', /PUBLIC_SUPABASE_URL.*loopback/i);
    assert.match(
      maintenanceRemoteRefusal({ supabaseUrl: 'not a url', databaseUrl: 'postgresql://u@127.0.0.1/d' }) ?? '',
      /PUBLIC_SUPABASE_URL/,
    );
  });
});
