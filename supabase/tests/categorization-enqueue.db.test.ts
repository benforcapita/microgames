import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import postgres from 'postgres';

const execFileAsync = promisify(execFile);

type Sql = postgres.Sql | postgres.TransactionSql;

type CountRow = {
  n: number;
};

type RunRow = {
  id: string;
  game_id: string;
  version: number;
  bundle_sha256: string;
  pipeline_version: string;
  mode: string;
  status: string;
};

type ValidationRow = {
  status: string;
};

type PrivRow = {
  who: string;
  fn: string;
  ok: boolean;
};

function localDbUrl(): string | undefined {
  const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  try {
    const host = new URL(raw).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') return undefined;
  } catch {
    return undefined;
  }
  return raw;
}

async function connect(t: { skip: (message?: string) => void }, max = 1): Promise<postgres.Sql | undefined> {
  const dbUrl = localDbUrl();
  if (!dbUrl) {
    t.skip('refusing to run categorization enqueue SQL against a non-local database');
    return undefined;
  }
  const sql = postgres(dbUrl, { connect_timeout: 3, max, idle_timeout: 1 });
  try {
    await sql`select 1`;
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    t.skip('local supabase is not running');
    return undefined;
  }
}

async function rollback(sql: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  let rolledBack = false;
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      rolledBack = true;
      throw new Error('ROLLBACK');
    });
  } catch (err: unknown) {
    if (!rolledBack || !(err instanceof Error) || err.message !== 'ROLLBACK') throw err;
  }
}

function sha(ch: string): string {
  return ch.repeat(64);
}

function gid(): string {
  return `cat4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function insertGame(sql: Sql, id: string): Promise<void> {
  await sql`
    insert into public.games (id, slug, creator, title)
    values (${id}, ${id}, 'stub', 'Title')
  `;
}

describe('categorization enqueue (CAT-4)', { concurrency: false }, () => {
  it('inserting or updating a validation to passed creates exactly one run and repeating creates no more', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const shaA = sha('a');
    const shaB = sha('b');
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, gameId);

        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status)
          values (${gameId}, 1, ${shaA}, 'passed')
        `;

        const initialRuns = await tx<RunRow[]>`
          select id::text, game_id, version, bundle_sha256, pipeline_version, mode, status
          from private.categorization_runs
          where game_id = ${gameId} and bundle_sha256 = ${shaA}
        `;
        assert.equal(initialRuns.length, 1);
        assert.equal(initialRuns[0].game_id, gameId);
        assert.equal(initialRuns[0].version, 1);
        assert.equal(initialRuns[0].bundle_sha256, shaA);
        assert.equal(initialRuns[0].pipeline_version, 'cat-v1');
        assert.equal(initialRuns[0].mode, 'shadow');
        assert.equal(initialRuns[0].status, 'queued');

        await tx`
          update public.game_validations
          set status = 'running'
          where game_id = ${gameId} and version = 1
        `;
        await tx`
          update public.game_validations
          set status = 'passed'
          where game_id = ${gameId} and version = 1
        `;

        const runsAfterRerun = await tx<RunRow[]>`
          select id::text, game_id, version, bundle_sha256, pipeline_version, mode, status
          from private.categorization_runs
          where game_id = ${gameId} and bundle_sha256 = ${shaA}
        `;
        assert.equal(runsAfterRerun.length, 1);

        await tx`
          update public.game_validations
          set status = 'passed'
          where game_id = ${gameId} and version = 1
        `;

        const runsAfterIdenticalUpdate = await tx<RunRow[]>`
          select id::text, game_id, version, bundle_sha256, pipeline_version, mode, status
          from private.categorization_runs
          where game_id = ${gameId} and bundle_sha256 = ${shaA}
        `;
        assert.equal(runsAfterIdenticalUpdate.length, 1);

        await tx`
          update private.settings
          set value = 'v2'
          where key = 'categorization_pipeline_version'
        `;
        await tx`
          update private.settings
          set value = 'active'
          where key = 'categorization_mode'
        `;

        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status)
          values (${gameId}, 2, ${shaB}, 'queued')
        `;

        const runsBeforePass = await tx<RunRow[]>`
          select id::text
          from private.categorization_runs
          where game_id = ${gameId} and bundle_sha256 = ${shaB}
        `;
        assert.equal(runsBeforePass.length, 0);

        await tx`
          update public.game_validations
          set status = 'passed'
          where game_id = ${gameId} and version = 2
        `;

        const runsAfterPass = await tx<RunRow[]>`
          select id::text, game_id, version, bundle_sha256, pipeline_version, mode, status
          from private.categorization_runs
          where game_id = ${gameId} and bundle_sha256 = ${shaB}
        `;
        assert.equal(runsAfterPass.length, 1);
        assert.equal(runsAfterPass[0].version, 2);
        assert.equal(runsAfterPass[0].pipeline_version, 'v2');
        assert.equal(runsAfterPass[0].mode, 'active');

        const totalRuns = await tx<CountRow[]>`
          select count(*)::int as n
          from private.categorization_runs
          where game_id = ${gameId}
        `;
        assert.equal(totalRuns[0].n, 2);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('a failure inside the queueing step can never fail the validation write', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const shaC1 = sha('c');
    const shaC2 = sha('f');
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, gameId);
        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status)
          values (${gameId}, 1, ${shaC1}, 'running')
        `;

        await tx`
          update private.settings
          set value = 'bogus'
          where key = 'categorization_mode'
        `;

        await tx`
          update public.game_validations
          set status = 'passed'
          where game_id = ${gameId} and version = 1
        `;

        const [validation1] = await tx<ValidationRow[]>`
          select status
          from public.game_validations
          where game_id = ${gameId} and version = 1
        `;
        assert.equal(validation1?.status, 'passed');

        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status)
          values (${gameId}, 2, ${shaC2}, 'passed')
        `;

        const [validation2] = await tx<ValidationRow[]>`
          select status
          from public.game_validations
          where game_id = ${gameId} and version = 2
        `;
        assert.equal(validation2?.status, 'passed');

        const runs = await tx<RunRow[]>`
          select id::text
          from private.categorization_runs
          where game_id = ${gameId}
        `;
        assert.equal(runs.length, 0);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('backfill enqueues latest passed validations and repeated backfill returns 0', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const game1 = gid();
    const game2 = gid();
    const game3 = gid();
    const sha1a = sha('1');
    const sha1b = sha('2');
    const sha2 = sha('3');
    const sha3 = sha('4');
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, game1);
        await insertGame(tx, game2);
        await insertGame(tx, game3);

        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status, created_at)
          values
            (${game1}, 1, ${sha1a}, 'passed', now() - interval '2 minutes'),
            (${game1}, 2, ${sha1b}, 'passed', now() - interval '1 minute'),
            (${game2}, 1, ${sha2}, 'passed', now() - interval '1 minute'),
            (${game3}, 1, ${sha3}, 'failed', now() - interval '1 minute')
        `;

        await tx`
          delete from private.categorization_runs
          where game_id in (${game1}, ${game2}, ${game3})
        `;

        const [first] = await tx<CountRow[]>`
          select private.cat_backfill_runs() as n
        `;
        assert.equal(first.n, 2);

        const runs = await tx<RunRow[]>`
          select id::text, game_id, version, bundle_sha256, pipeline_version, mode, status
          from private.categorization_runs
          where game_id in (${game1}, ${game2}, ${game3})
          order by game_id
        `;
        assert.equal(runs.length, 2);
        const run1 = runs.find((r) => r.game_id === game1);
        const run2 = runs.find((r) => r.game_id === game2);
        assert.ok(run1);
        assert.ok(run2);
        assert.equal(run1.version, 2);
        assert.equal(run1.bundle_sha256, sha1b);
        assert.equal(run2.version, 1);
        assert.equal(run2.bundle_sha256, sha2);

        const [second] = await tx<CountRow[]>`
          select private.cat_backfill_runs() as n
        `;
        assert.equal(second.n, 0);

        const runsAfterSecond = await tx<CountRow[]>`
          select count(*)::int as n
          from private.categorization_runs
          where game_id in (${game1}, ${game2}, ${game3})
        `;
        assert.equal(runsAfterSecond[0].n, 2);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('a failed validation creates no run', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const shaD = sha('d');
    const shaE = sha('e');
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, gameId);

        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status)
          values (${gameId}, 1, ${shaD}, 'failed')
        `;

        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status)
          values (${gameId}, 2, ${shaE}, 'running')
        `;

        await tx`
          update public.game_validations
          set status = 'failed'
          where game_id = ${gameId} and version = 2
        `;

        const runs = await tx<RunRow[]>`
          select id::text
          from private.categorization_runs
          where game_id = ${gameId}
        `;
        assert.equal(runs.length, 0);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('backfill script refuses non-loopback host with exit code 2 and never prints the URL', async () => {
    const refusedCases: Array<{ url?: string; secrets?: string[] }> = [
      { url: 'postgresql://a@evil.invalid:5432,x@127.0.0.1:55861/postgres', secrets: ['evil.invalid'] },
      { url: 'postgresql://u@evil.invalid/127.0.0.1', secrets: ['evil.invalid'] },
      { url: 'postgresql://user:secretpassword@evil.invalid:5432/db', secrets: ['evil.invalid', 'secretpassword'] },
      { url: 'postgresql://u@localhost.evil.invalid/db', secrets: ['localhost.evil.invalid'] },
      { url: 'postgresql://u@127.0.0.1,evil.invalid/db', secrets: ['evil.invalid'] },
      { url: 'not a url' },
      { url: '' },
      { url: undefined },
      { url: 'http://127.0.0.1:5432/db' },
    ];

    for (const testCase of refusedCases) {
      let exitCode: number | undefined;
      let stderr = '';
      const env: Record<string, string | undefined> = {
        ...process.env,
        NODE_OPTIONS: '--import ./supabase/tests/fixtures/deny-net.mjs',
      };
      if (testCase.url !== undefined) {
        env.DATABASE_URL = testCase.url;
      } else {
        delete env.DATABASE_URL;
      }
      try {
        await execFileAsync('node', ['scripts/backfill-categorization.mjs'], { env });
      } catch (err: unknown) {
        if (err !== null && typeof err === 'object') {
          if ('code' in err && typeof err.code === 'number') {
            exitCode = err.code;
          }
          if ('stderr' in err && typeof err.stderr === 'string') {
            stderr = err.stderr;
          }
        }
      }
      assert.equal(exitCode, 2);
      assert.equal(stderr.includes('CONNECT_ATTEMPT'), false);
      assert.equal(stderr.includes('DNS_LOOKUP'), false);
      assert.ok(stderr.includes('[backfill-categorization] refusing non-loopback host'));
      if (testCase.url) {
        assert.equal(stderr.includes(testCase.url), false);
      }
      if (testCase.secrets) {
        for (const secret of testCase.secrets) {
          assert.equal(stderr.includes(secret), false);
        }
      }
    }

    let allowedStderr = '';
    try {
      const res = await execFileAsync('node', ['scripts/backfill-categorization.mjs'], {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:1/postgres',
          NODE_OPTIONS: '--import ./supabase/tests/fixtures/deny-net.mjs',
        },
      });
      allowedStderr = res.stderr;
    } catch (err: unknown) {
      if (err !== null && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string') {
        allowedStderr = err.stderr;
      }
    }
    assert.ok(allowedStderr.includes('CONNECT_ATTEMPT 127.0.0.1'));
    assert.equal(allowedStderr.includes('[backfill-categorization] refusing non-loopback host'), false);
  });

  it('new functions revoke execute from public, anon, and authenticated', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const privs = await sql<PrivRow[]>`
        select w.who, f.fn, has_function_privilege(w.who, f.fn::regprocedure, 'execute') as ok
        from (values ('public'), ('anon'), ('authenticated')) as w(who)
        cross join (values
          ('private.cat_enqueue_run(text, int, text)'),
          ('private.enqueue_categorization_on_pass()'),
          ('private.cat_backfill_runs()')
        ) as f(fn)
      `;
      for (const row of privs) {
        assert.equal(row.ok, false, `${row.who} execute on ${row.fn}`);
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
