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
import { localSupabaseEnv } from '../../../scripts/lib/local-supabase.mjs';
import { ASSET_STALE_AGE_MS, GAME_VERSION_MAX_BYTES, MAX_ASSET_FILES } from './asset-upload.ts';
import {
  cleanOrphanedAssetRows,
  maintenanceStorage,
  runAssetMaintenance,
  staleStagingObjectNames,
  sweepStaleStagingObjects,
  type MaintenanceStorage,
} from './asset-maintenance.ts';

const supabaseDir = join(dirname(fileURLToPath(import.meta.url)), '../../../supabase');
const MIGRATION = '20261018120000_clean_orphan_game_asset';
const CLEAN_FN = 'private.clean_orphan_game_asset(text, integer, text, text, integer, numeric, timestamptz)';
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
  const exists = async (path: string) => {
    const res = await games.info(path);
    return res.data !== null;
  };
  return {
    sql,
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
  opts: { status?: string; sizeBytes?: number | null; sha?: string | null; ageHours?: number } = {},
) {
  // Rows are aged with SQL now() - interval, not a JS Date: real reservations carry
  // microsecond precision, which is exactly what the updated_at marker has to pin.
  await sql`
    insert into public.game_assets
      (game_id, version, path, expected_type, status, size_bytes, content_sha256, source, updated_at)
    values (${gameId}, 1, ${path}, 'image', ${opts.status ?? 'uploaded'},
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
    const { sql, storage, upload } = c;
    const gameId = await makeGame(sql);
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    try {
      // The crash-between-reserve-and-copy case: 'uploaded' row, no object behind it.
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });
      // Same age but the object exists — the reservation completed; never touched.
      await addAssetRow(sql, gameId, 'live.png', { sha: SHA('b'), sizeBytes: 10, ageHours: 3 });
      await upload(`${gameId}/1/live.png`);
      // No object, but the reservation is still inside the active finalize window.
      await addAssetRow(sql, gameId, 'fresh.png', { sha: SHA('c'), sizeBytes: 10 });
      // A 'missing' scan row is not an upload reservation — never a candidate.
      await addAssetRow(sql, gameId, 'scan.png', { status: 'missing', sizeBytes: null, sha: null, ageHours: 3 });

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

  it('fails closed: a Storage error keeps the row and reports the error', async (t) => {
    // The adapter must answer "missing" only on a definite not-found. A bad key returns a
    // bare 400 from exists() — the same shape as a missing object — and a 5xx throws; in
    // both cases the row must be KEPT and the failure land in report.errors.
    const c = await connect(t);
    if (!c) return;
    const { sql } = c;
    const gameId = await makeGame(sql);
    const olderThan = new Date(Date.now() - ASSET_STALE_AGE_MS);
    const url = process.env.PUBLIC_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SECRET_KEY ?? '';
    try {
      // Control: the real adapter on healthy storage deletes the genuinely missing object.
      await addAssetRow(sql, gameId, 'gone.png', { sha: SHA('a'), sizeBytes: 10, ageHours: 3 });
      const ok = await cleanOrphanedAssetRows(sql, c.storage, olderThan);
      assert.ok(ok.deleted >= 1, 'control: a missing object is still collectible');
      assert.equal(await rowOf(sql, gameId, 'gone.png'), undefined);

      // Bad credentials: exists() answers data:false here — treated as "missing" by the
      // naive adapter, this row would be deleted. Fail-closed keeps it.
      await addAssetRow(sql, gameId, 'auth.png', { sha: SHA('b'), sizeBytes: 10, ageHours: 3 });
      const badKey = maintenanceStorage(
        createClient(url, 'sb_secret_definitely_wrong', { auth: { persistSession: false } }).storage.from('games'),
      );
      const auth = await cleanOrphanedAssetRows(sql, badKey, olderThan);
      assert.ok(auth.errors.length > 0, 'an auth failure must be reported');
      assert.equal((await rowOf(sql, gameId, 'auth.png'))?.status, 'uploaded', 'row kept on storage auth failure');

      // Injected 5xx through the real adapter's fetch — same fail-closed path.
      await addAssetRow(sql, gameId, 'fivehundo.png', { sha: SHA('c'), sizeBytes: 10, ageHours: 3 });
      const failing = maintenanceStorage(
        createClient(url, key, {
          auth: { persistSession: false },
          global: {
            fetch: async () => new Response(JSON.stringify({ statusCode: '500', error: 'upstream', message: 'boom' }), { status: 500 }),
          },
        }).storage.from('games'),
      );
      const five = await cleanOrphanedAssetRows(sql, failing, olderThan);
      assert.ok(five.errors.length > 0, 'a 5xx must be reported');
      assert.equal((await rowOf(sql, gameId, 'fivehundo.png'))?.status, 'uploaded', 'row kept on storage 5xx');
    } finally {
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
});
