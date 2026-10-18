// UP-4: script-level tests for scripts/asset-maintenance.mjs — the file is spawned the way
// an operator runs it (`node … scripts/asset-maintenance.mjs` and `npm run maintenance --`)
// against the local stack, so argv forwarding, env validation, the loopback guard, the
// deletion caps, the storage canary and the storage timeout are exercised end to end.
// Runs only when a local Supabase stack is up.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { localSupabaseEnv } from './lib/local-supabase.mjs';
import { scratchMaintenanceDb } from './lib/scratch-maintenance-db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_BIN = dirname(process.execPath);
const PNG = Buffer.from('89504e4701020304', 'hex');
const SHA = 'a'.repeat(64);

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

/** Spawn the real script (or `npm run maintenance -- <args>`) with a fully replaced env. */
function runMaintenance(
  args: string[],
  env: Record<string, string>,
  opts: { npm?: boolean; timeoutMs?: number } = {},
): Promise<Run> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const [cmd, argv] = opts.npm
    ? ['npm', ['run', 'maintenance', '--', ...args]]
    : [
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          '--import',
          './scripts/register-ts.mjs',
          'scripts/asset-maintenance.mjs',
          ...args,
        ],
      ];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, timedOut });
    });
  });
}

type Env = Record<string, string>;

function stackEnv(t: { skip: (message?: string) => void }, overrides: Record<string, string | undefined> = {}): Env | undefined {
  let env: ReturnType<typeof localSupabaseEnv>;
  try {
    env = localSupabaseEnv();
  } catch {
    t.skip('local supabase is not running');
    return undefined;
  }
  const host = new URL(env.DATABASE_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    t.skip('refusing to run maintenance tests against a non-local database');
    return undefined;
  }
  const base: Env = {
    PATH: `${NODE_BIN}:${process.env.PATH ?? ''}`,
    PUBLIC_SUPABASE_URL: env.PUBLIC_SUPABASE_URL,
    PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    DATABASE_URL: env.DATABASE_URL,
  };
  const home = process.env.HOME;
  if (home) base.HOME = home;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

interface Fixture {
  gameId: string;
  stale: string[];
  cleanup: () => Promise<void>;
  rowCount: () => Promise<number>;
  rowStatus: (path: string) => Promise<string | undefined>;
  objectListed: (name: string) => Promise<boolean>;
}

/** Seed one game with stale 'uploaded' rows: `orphans` without objects, `live` with them,
 *  plus `staging` aged `_staging` objects. Ages are applied in SQL like real data. */
async function seed(env: Env, opts: { orphans?: number; live?: number; staging?: number } = {}): Promise<Fixture> {
  const sql = postgres(env.DATABASE_URL, { connect_timeout: 3, max: 2 });
  const bucket = createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  }).storage.from('games');
  const gameId = `sm${randomBytes(6).toString('hex')}`;
  const stale: string[] = [];
  const objectNames: string[] = [];
  try {
    await sql`
      insert into public.games (id, slug, creator, title, stage, size_bytes)
      values (${gameId}, ${gameId}, 'stub', 'Maint script', 'proving', 100)
    `;
    for (let i = 0; i < (opts.orphans ?? 0); i++) {
      await sql`
        insert into public.game_assets (game_id, version, path, expected_type, status, size_bytes, content_sha256, source, updated_at)
        values (${gameId}, 1, ${`orphan-${i}.png`}, 'image', 'uploaded', 10, ${SHA}, 'creator', now() - interval '3 hours')
      `;
    }
    for (let i = 0; i < (opts.live ?? 0); i++) {
      const name = `${gameId}/1/live-${i}.png`;
      const up = await bucket.upload(name, PNG, { contentType: 'image/png' });
      assert.equal(up.error, null, `seed upload: ${up.error?.message}`);
      objectNames.push(name);
      await sql`
        insert into public.game_assets (game_id, version, path, expected_type, status, size_bytes, content_sha256, source, updated_at)
        values (${gameId}, 1, ${`live-${i}.png`}, 'image', 'uploaded', 10, ${SHA}, 'creator', now() - interval '3 hours')
      `;
    }
    for (let i = 0; i < (opts.staging ?? 0); i++) {
      const name = `${gameId}/_staging/${randomBytes(9).toString('base64url')}`;
      const up = await bucket.upload(name, PNG, { contentType: 'image/png' });
      assert.equal(up.error, null, `seed upload: ${up.error?.message}`);
      objectNames.push(name);
      stale.push(name);
      await sql`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'games' and name = ${name}`;
    }
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => {});
    throw error;
  }
  return {
    gameId,
    stale,
    rowCount: async () =>
      (await sql<{ n: number }[]>`select count(*)::int as n from public.game_assets where game_id = ${gameId}`)[0]?.n ?? 0,
    rowStatus: async (path) =>
      (await sql<{ status: string }[]>`select status from public.game_assets where game_id = ${gameId} and version = 1 and path = ${path}`)[0]
        ?.status,
    objectListed: async (name) =>
      (await sql`select 1 as x from storage.objects where bucket_id = 'games' and name = ${name}`).length > 0,
    cleanup: async () => {
      await bucket.remove(objectNames).catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    },
  };
}

async function fakeStorage(t: { skip: (message?: string) => void }, respond: 'not-found' | 'hang'): Promise<{ server: Server; port: number }> {
  const server =
    respond === 'hang'
      ? createServer(() => {})
      : createServer((req, res) => {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }));
        });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

describe('scripts/asset-maintenance.mjs', () => {
  it('exits 2 with a clear message when a required env var is missing', async (t) => {
    const env = stackEnv(t, { DATABASE_URL: undefined });
    if (!env) return;
    const r = await runMaintenance([], env, { timeoutMs: 20_000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /DATABASE_URL/);
  });

  it('refuses a non-local DATABASE_URL or PUBLIC_SUPABASE_URL before connecting', async (t) => {
    const remoteDb = stackEnv(t, { DATABASE_URL: 'postgresql://postgres:postgres@203.0.113.9:6543/postgres' });
    if (!remoteDb) return;
    const r1 = await runMaintenance([], remoteDb, { timeoutMs: 20_000 });
    assert.equal(r1.timedOut, false, 'a remote target must be refused, not dialed');
    assert.notEqual(r1.code, 0);
    assert.match(r1.stderr, /loopback|allow-remote/i);
    assert.ok(r1.ms < 15_000, `refusal should be immediate, took ${r1.ms}ms`);

    const remoteSb = stackEnv(t, { PUBLIC_SUPABASE_URL: 'http://203.0.113.9:8000' });
    if (!remoteSb) return;
    const r2 = await runMaintenance([], remoteSb, { timeoutMs: 20_000 });
    assert.equal(r2.timedOut, false);
    assert.notEqual(r2.code, 0);
    assert.match(r2.stderr, /loopback|allow-remote/i);
  });

  it('--allow-remote bypasses the loopback guard and still fails on connection', async (t) => {
    // Unroutable TEST-NET address: past the guard, the run reaches the connect attempt and
    // fails on it — the refusal text must be absent.
    const env = stackEnv(t, { DATABASE_URL: 'postgresql://postgres:postgres@203.0.113.9:6543/postgres' });
    if (!env) return;
    const r = await runMaintenance(['--allow-remote'], env, { timeoutMs: 45_000 });
    assert.equal(r.timedOut, false);
    assert.notEqual(r.code, 0, 'the run still fails — but on the connection, not the guard');
    assert.doesNotMatch(r.stderr, /loopback|allow-remote/i, `the loopback refusal must not appear: ${r.stderr}`);
  });

  it('npm run maintenance -- --dry-run reports candidates and deletes nothing', async (t) => {
    const env = stackEnv(t);
    if (!env) return;
    const f = await seed(env, { orphans: 1, live: 1, staging: 1 });
    try {
      const dry = await runMaintenance(['--dry-run'], env, { npm: true, timeoutMs: 90_000 });
      assert.equal(dry.code, 0, `stdout=${dry.stdout} stderr=${dry.stderr}`);
      assert.match(dry.stdout, /dryRun|dry run/i);
      assert.match(dry.stdout, /"wouldAbort":null/, 'a healthy dry run reports no would-abort reason');
      assert.equal(await f.rowCount(), 2, 'dry run must delete no rows');
      assert.equal(await f.objectListed(f.stale[0] ?? ''), true, 'dry run must remove no staging objects');

      // The paired real run still does its job, so the dry run is proving the flag, not a dead script.
      const real = await runMaintenance([], env);
      assert.equal(real.code, 0, `stderr=${real.stderr}`);
      assert.equal(await f.rowCount(), 1, 'the orphan row is deleted, the live row kept');
      assert.equal(await f.rowStatus('live-0.png'), 'uploaded');
      assert.equal(await f.objectListed(f.stale[0] ?? ''), false);
    } finally {
      await f.cleanup();
    }
  });

  it('dry run runs the canary: a publishable key exits non-zero and writes nothing', async (t) => {
    // QA #79 S4 for dry runs: the under-privileged key must fail the canary the dry run now
    // shares with real runs — non-zero exit, the would-abort reason visible, and zero writes:
    // no row deletes, no object removes, and no scratch canary upload, not even a removed one.
    const base = stackEnv(t);
    if (!base) return;
    const env = { ...base, SUPABASE_SECRET_KEY: base.PUBLIC_SUPABASE_PUBLISHABLE_KEY };
    const f = await seed(base, { orphans: 1, live: 2, staging: 1 });
    const audit = postgres(base.DATABASE_URL, { connect_timeout: 3, max: 1 });
    try {
      const rowsBefore = await audit<{ p: string; status: string }[]>`
        select game_id || '/' || version || '/' || path as p, status
        from public.game_assets where game_id = ${f.gameId} order by p`;

      const r = await runMaintenance(['--dry-run'], env);
      assert.notEqual(r.code, 0, `a dry run under the publishable key must refuse: ${r.stdout}`);
      // The refusal's exact wording is pinned at db level (deterministic scratch DB); here a
      // concurrent fixture could make a cap refusal arrive first, so pin only that one exists.
      assert.match(r.stdout, /"wouldAbort":"/, 'the dry-run report carries the would-abort reason');

      assert.equal(await f.rowCount(), 3, 'dry run must delete no rows');
      assert.equal(await f.objectListed(f.stale[0] ?? ''), true, 'dry run must remove no staging objects');
      const rowsAfter = await audit<{ p: string; status: string }[]>`
        select game_id || '/' || version || '/' || path as p, status
        from public.game_assets where game_id = ${f.gameId} order by p`;
      assert.deepEqual(rowsAfter, rowsBefore, 'every fixture row survives the refused dry run');
      const [canaryObjects] = await audit<{ n: number }[]>`
        select count(*)::int as n from storage.objects
        where bucket_id = 'games' and name like 'maintenance-canary/%'`;
      assert.equal(canaryObjects?.n, 0, 'no scratch canary object may exist after a dry run');
    } finally {
      await audit.end({ timeout: 1 }).catch(() => {});
      await f.cleanup();
    }
  });

  it('dry run over the orphan cap reports the refusal and deletes nothing', async (t) => {
    const env = stackEnv(t);
    if (!env) return;
    // A scratch database: the candidate universe is this test alone — the pass's global
    // scan cannot collide with another file's fixtures, and the write-free audit is exact.
    const scratch = await scratchMaintenanceDb(env);
    const overCap = 25; // default cap is 20
    try {
      for (let i = 0; i < overCap; i++) {
        await scratch.sql`
          insert into public.game_assets (game_id, version, path, status, size_bytes, content_sha256, updated_at)
          values ('g1', 1, ${`o-${i}.png`}, 'uploaded', 10, ${SHA}, now() - interval '3 hours')`;
      }
      // One fake object row keeps the canary on its read-only path, so the cap is the only refusal.
      await scratch.sql`insert into storage.objects (bucket_id, name) values ('games', 'g1/1/live.png')`;
      const r = await runMaintenance(['--dry-run'], { ...env, DATABASE_URL: scratch.url });
      assert.equal(r.code, 1, `an over-cap dry run must exit 1: stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /"wouldAbort":"[^"]*orphan asset rows exceed/i, `the cap refusal must be visible: ${r.stdout}`);
      const [rows] = await scratch.sql<{ n: number }[]>`select count(*)::int as n from public.game_assets`;
      assert.equal(rows?.n, overCap, 'a refused dry run deletes nothing');
    } finally {
      await scratch.drop();
    }
  });

  it('dry run over the staging cap reports the refusal and removes nothing', async (t) => {
    const env = stackEnv(t);
    if (!env) return;
    const scratch = await scratchMaintenanceDb(env);
    const overCap = 201; // default staging cap is 200
    try {
      // Object rows without files are enough: the candidate listing is a storage.objects
      // query and the refusal must fire before the first Storage call.
      await scratch.sql`
        insert into storage.objects (bucket_id, name, created_at)
        select 'games', 'g1/_staging/cap-' || g, now() - interval '3 hours'
        from generate_series(1, ${overCap}) g`;
      const r = await runMaintenance(['--dry-run'], { ...env, DATABASE_URL: scratch.url });
      assert.equal(r.code, 1, `an over-cap dry run must exit 1: stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /"wouldAbort":"[^"]*stale staging objects exceed/i, `the cap refusal must be visible: ${r.stdout}`);
      const [left] = await scratch.sql<{ n: number }[]>`select count(*)::int as n from storage.objects`;
      assert.equal(left?.n, overCap, 'a refused dry run removes nothing');
    } finally {
      await scratch.drop();
    }
  });

  it('dry run on an empty games bucket exits 3: the canary cannot be verified', async (t) => {
    const env = stackEnv(t);
    if (!env) return;
    // An empty bucket without touching the real one's objects: a scratch database on the
    // same server holding only the tables the pass reads. The Storage API still owns the
    // real storage.objects, so a scratch canary upload would land THERE — the prefix audit
    // catches a buggy dry run that wrote and removed one.
    const scratch = await scratchMaintenanceDb(env);
    const audit = postgres(env.DATABASE_URL, { connect_timeout: 3, max: 1 });
    try {
      const r = await runMaintenance(['--dry-run'], { ...env, DATABASE_URL: scratch.url });
      assert.equal(r.code, 3, `an empty-bucket dry run must exit 3: stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /"wouldAbort":"[^"]*could not be verified/i, `the reason must be visible: ${r.stdout}`);
      const [left] = await scratch.sql<{ n: number }[]>`
        select count(*)::int as n from storage.objects`;
      assert.equal(left?.n, 0, 'the scratch bucket must stay empty — a dry run may not write');
      const [canaryObjects] = await audit<{ n: number }[]>`
        select count(*)::int as n from storage.objects
        where bucket_id = 'games' and name like 'maintenance-canary/%'`;
      assert.equal(canaryObjects?.n, 0, 'no scratch canary object may land in the real bucket');
    } finally {
      await audit.end({ timeout: 1 }).catch(() => {});
      await scratch.drop();
    }
  });

  it('aborts without deleting when SUPABASE_SECRET_KEY is only the publishable key', async (t) => {
    // QA #79 S4: the anon/publishable key makes Storage answer 'Object not found' for
    // live objects. The canary must catch it — 0 deletions, non-zero exit.
    const base = stackEnv(t);
    if (!base) return;
    const env = { ...base, SUPABASE_SECRET_KEY: base.PUBLIC_SUPABASE_PUBLISHABLE_KEY };
    const f = await seed(base, { orphans: 1, live: 2, staging: 1 });
    try {
      const r = await runMaintenance([], env);
      assert.notEqual(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(r.timedOut, false);
      assert.match(r.stderr, /canary/i, `expected the canary refusal: ${r.stderr}`);
      assert.equal(await f.rowCount(), 3, 'no row may be deleted under a bad key');
      assert.equal(await f.objectListed(f.stale[0] ?? ''), true, 'no staging object may be removed either');
    } finally {
      await f.cleanup();
    }
  });

  it('aborts without deleting when the Storage endpoint answers Object not found for everything', async (t) => {
    // A DB/Storage project mismatch at the same host shape: the database lists objects,
    // the (wrong) Storage project reports every object missing.
    const base = stackEnv(t);
    if (!base) return;
    const { server, port } = await fakeStorage(t, 'not-found');
    const f = await seed(base, { orphans: 1, live: 1, staging: 1 });
    try {
      const env = { ...base, PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}` };
      const r = await runMaintenance([], env);
      assert.notEqual(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(await f.rowCount(), 2, 'no row may be deleted against a mismatched Storage');
      assert.equal(await f.objectListed(f.stale[0] ?? ''), true);
    } finally {
      server.close();
      await f.cleanup();
    }
  });

  it('a Storage endpoint that never answers fails the run instead of hanging it', async (t) => {
    const base = stackEnv(t);
    if (!base) return;
    const { server, port } = await fakeStorage(t, 'hang');
    const f = await seed(base, { orphans: 1, live: 1 });
    try {
      const env = { ...base, PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}` };
      const r = await runMaintenance(['--storage-timeout-ms', '700'], env, { timeoutMs: 20_000 });
      assert.equal(r.timedOut, false, 'a hanging Storage must not hang the run');
      assert.notEqual(r.code, 0);
      assert.equal(await f.rowCount(), 2, 'nothing may be deleted when Storage cannot be trusted');
    } finally {
      server.close();
      await f.cleanup();
    }
  });

  it('refuses when orphan candidates exceed the per-run cap; --max-orphans allows it', async (t) => {
    const env = stackEnv(t);
    if (!env) return;
    const overCap = 25; // default cap is 20
    const f = await seed(env, { orphans: overCap });
    try {
      const refused = await runMaintenance([], env);
      assert.notEqual(refused.code, 0, `stdout=${refused.stdout} stderr=${refused.stderr}`);
      assert.match(refused.stderr, /orphan|cap|refus/i);
      assert.equal(await f.rowCount(), overCap, 'a refused run deletes nothing');

      const allowed = await runMaintenance(['--max-orphans', '500'], env);
      assert.equal(allowed.code, 0, `stderr=${allowed.stderr}`);
      assert.equal(await f.rowCount(), 0);
    } finally {
      await f.cleanup();
    }
  });
});
