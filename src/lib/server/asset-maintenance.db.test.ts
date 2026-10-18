// UP-4: maintenance for the signed-upload pipeline. staleStagingObjectNames /
// sweepStaleStagingObjects collect `_staging` objects past the stale-age cutoff (Storage API
// deletes — direct SQL on storage.objects is blocked), and cleanOrphanedAssetRows deletes
// 'uploaded' rows whose served object is absent through private.clean_orphan_game_asset:
// a compare-and-set delete under the same games-row lock record_game_asset holds, so it can
// never remove a live reservation. Runs only against a local stack.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { localSupabaseEnv } from '../../scripts/lib/local-supabase.mjs';
import { ASSET_STALE_AGE_MS, GAME_VERSION_MAX_BYTES, MAX_ASSET_FILES } from './asset-upload.ts';
import {
  cleanOrphanedAssetRows,
  runAssetMaintenance,
  staleStagingObjectNames,
  sweepStaleStagingObjects,
  type MaintenanceStorage,
} from './asset-maintenance.ts';

const supabaseDir = join(dirname(fileURLToPath(import.meta.url)), '../../supabase');
const MIGRATION = '20261018120000_clean_orphan_game_asset';
const CLEAN_FN = 'private.clean_orphan_game_asset(text, integer, text, text, integer, timestamptz, timestamptz)';
const SHA = (c: string) => c.repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('clean_orphan_game_asset migration file', () => {
  it('sorts after every existing migration', () => {
    const names = readdirSync(join(supabaseDir, 'migrations')).sort();
    assert.equal(names.at(-1), `${MIGRATION}.sql`);
  });
});

interface Ctx {
  sql: postgres.Sql;
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
  const exists = async (path: string) => (await games.exists(path)).data === true;
  return {
    sql,
    exists,
    upload: async (path) => {
      const res = await games.upload(path, PNG, { contentType: 'image/png' });
      assert.equal(res.error, null, `fixture upload ${path}: ${res.error?.message}`);
    },
    storage: {
      exists,
      remove: async (paths) => {
        const res = await games.remove(paths);
        return { error: res.error ? { message: res.error.message } : null };
      },
    },
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
  opts: { status?: string; sizeBytes?: number | null; sha?: string | null; updatedAt?: Date } = {},
) {
  await sql`
    insert into public.game_assets
      (game_id, version, path, expected_type, status, size_bytes, content_sha256, source, updated_at)
    values (${gameId}, 1, ${path}, 'image', ${opts.status ?? 'uploaded'},
            ${opts.sizeBytes ?? 10}, ${opts.sha === undefined ? SHA('a') : opts.sha},
            'creator', ${opts.updatedAt ?? new Date()})
  `;
}

const rowOf = async (sql: postgres.Sql, gameId: string, path: string) =>
  (
    await sql<{ status: string; content_sha256: string | null }[]>`
      select status, content_sha256 from public.game_assets
      where game_id = ${gameId} and version = 1 and path = ${path}
    `
  )[0];

const clean = (sql: postgres.Sql | postgres.TransactionSql, gameId: string, path: string, row: { sha: string; size: number; updatedAt: string }, olderThan: Date) =>
  sql<{ clean_orphan_game_asset: string }[]>`
    select private.clean_orphan_game_asset(
      ${gameId}, 1, ${path}, ${row.sha}, ${row.size}, ${row.updatedAt}, ${olderThan})
  `.then((rows) => rows[0]?.clean_orphan_game_asset);

describe('private.clean_orphan_game_asset', () => {
  it('is a security-definer function only service_role and postgres may execute', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    try {
      const [migration] = await sql<{ version: string }[]>`
        select version from supabase_migrations.schema_migrations where version = '20261018120000'
      `;
      assert.equal(migration?.version, '20261018120000');

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

  it('deletes only the exact uploaded row it was pointed at, and is idempotent', async (t) => {
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    const gameId = await makeGame(sql);
    const old = new Date(Date.now() - 3 * 3600_000);
    const oldText = old.toISOString();
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    try {
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, updatedAt: old });
      assert.equal(await clean(sql, gameId, 'gone.png', { sha: SHA('a'), size: 10, updatedAt: oldText }, olderThan), 'deleted');
      assert.equal(await rowOf(sql, gameId, 'gone.png'), undefined, 'the judged-orphan row is gone');
      // Idempotent: the same call again finds nothing to do.
      assert.equal(await clean(sql, gameId, 'gone.png', { sha: SHA('a'), size: 10, updatedAt: oldText }, olderThan), 'skipped');

      // A row that no longer matches the pinned sha is someone else's write — never touched.
      await addAssetRow(sql, gameId, 'keep.png', { sha: SHA('b'), sizeBytes: 10, updatedAt: old });
      assert.equal(await clean(sql, gameId, 'keep.png', { sha: SHA('a'), size: 10, updatedAt: oldText }, olderThan), 'skipped');
      assert.equal((await rowOf(sql, gameId, 'keep.png'))?.content_sha256, SHA('b'));

      // A reservation inside the active finalize window is never touched either.
      const freshDate = new Date();
      await addAssetRow(sql, gameId, 'fresh.png', { sha: SHA('c'), sizeBytes: 10, updatedAt: freshDate });
      assert.equal(
        await clean(sql, gameId, 'fresh.png', { sha: SHA('c'), size: 10, updatedAt: freshDate.toISOString() }, olderThan),
        'skipped',
      );
      assert.equal((await rowOf(sql, gameId, 'fresh.png'))?.status, 'uploaded');

      // A deleted game's rows cascade away first — the function only reports it.
      assert.equal(await clean(sql, 'no-such-game', 'x.png', { sha: SHA('a'), size: 10, updatedAt: oldText }, olderThan), 'not-found');
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('queues on the games-row lock and never deletes a live reservation', async (t) => {
    // Deterministic, like the UP-3 lock test: A holds the game's FOR NO KEY UPDATE lock by
    // reserving the row inside an open transaction; B's cleanup call must queue on the same
    // lock (lock_timeout proves it waited), and once A commits the newer reservation, B's
    // compare-and-set must skip the row instead of deleting a live finalize's write.
    const a = await connect(t);
    if (!a) return;
    const b = await connect(t);
    if (!b) {
      await a.sql.end({ timeout: 1 }).catch(() => {});
      return;
    }
    const gameId = await makeGame(a.sql);
    const oldDate = new Date(Date.now() - 3 * 3600_000);
    const oldText = oldDate.toISOString();
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    let signalRelease: (() => void) | undefined;
    try {
      await addAssetRow(a.sql, gameId, 'race.png', { sha: SHA('a'), sizeBytes: 10, updatedAt: oldDate });

      let signalReserved!: () => void;
      const reserved = new Promise<void>((resolve) => (signalReserved = resolve));
      const release = new Promise<void>((resolve) => (signalRelease = resolve));
      const aTxn = a.sql
        .begin(async (tx) => {
          try {
            await tx`
              select result from private.record_game_asset(
                ${gameId}, 1, 'race.png', 'image', 'uploaded',
                20, ${SHA('b')}, 'creator', null, ${MAX_ASSET_FILES}, ${GAME_VERSION_MAX_BYTES})
            `;
          } finally {
            signalReserved();
          }
          await release;
        })
        .then(
          () => 'committed',
          (e: unknown) => `a-error: ${e}`,
        );
      await reserved;

      // B's cleanup must queue on the same games-row lock a finalize holds — without the
      // lock it would judge the pre-commit row stale and could delete it underneath A.
      const blocked = await b.sql
        .begin(async (tx) => {
          await tx`set local lock_timeout = '1s'`;
          await clean(tx, gameId, 'race.png', { sha: SHA('a'), size: 10, updatedAt: oldText }, olderThan);
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
      signalRelease();
      assert.equal(await aTxn, 'committed');

      // A committed a newer reservation on the row. The cleanup's pinned marker no longer
      // matches, so the row — still 'uploaded', now A's bytes — is skipped, not deleted.
      assert.equal(await clean(b.sql, gameId, 'race.png', { sha: SHA('a'), size: 10, updatedAt: oldText }, olderThan), 'skipped');
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
    const { sql, storage, upload } = c;
    const gameId = await makeGame(sql);
    const old = new Date(Date.now() - 3 * 3600_000);
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    try {
      // The crash-between-reserve-and-copy case: 'uploaded' row, no object behind it.
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, updatedAt: old });
      // Same age but the object exists — the reservation completed; never touched.
      await addAssetRow(sql, gameId, 'live.png', { sha: SHA('b'), sizeBytes: 10, updatedAt: old });
      await upload(`${gameId}/1/live.png`);
      // No object, but the reservation is still inside the active finalize window.
      await addAssetRow(sql, gameId, 'fresh.png', { sha: SHA('c'), sizeBytes: 10, updatedAt: new Date() });
      // A 'missing' scan row is not an upload reservation — never a candidate.
      await addAssetRow(sql, gameId, 'scan.png', { status: 'missing', sizeBytes: null, sha: null, updatedAt: old });

      const res = await cleanOrphanedAssetRows(sql, storage, olderThan);
      assert.deepEqual(res.errors, []);
      assert.ok(res.deleted >= 1);

      assert.equal(await rowOf(sql, gameId, 'gone.png'), undefined, 'the orphaned reservation is deleted');
      assert.equal((await rowOf(sql, gameId, 'live.png'))?.status, 'uploaded', 'a row whose object exists is never touched');
      assert.equal((await rowOf(sql, gameId, 'fresh.png'))?.status, 'uploaded', 'an active-window reservation is never touched');
      assert.equal((await rowOf(sql, gameId, 'scan.png'))?.status, 'missing', 'a scan row is never a candidate');

      const again = await cleanOrphanedAssetRows(sql, storage, olderThan);
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
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, updatedAt: new Date(Date.now() - 3 * 3600_000) });

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
});
