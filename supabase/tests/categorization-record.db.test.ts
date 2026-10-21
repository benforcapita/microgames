import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import postgres from 'postgres';

type Sql = postgres.Sql | postgres.TransactionSql;

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
    t.skip('refusing to run categorization record SQL against a non-local database');
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
  } catch (err) {
    if (!rolledBack || !(err instanceof Error) || err.message !== 'ROLLBACK') throw err;
  }
}

function refused(code: string) {
  return (err: unknown) => err instanceof postgres.PostgresError && err.code === code;
}

const leaseLost = (err: unknown) =>
  err instanceof postgres.PostgresError && err.code === 'P0001' && err.message === 'lease_lost';

const sha = (ch: string) => ch.repeat(64);
const gid = () => `cat2b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

type Claim = {
  run_id: string;
  lease_token: string;
  game_id: string;
  version: number;
  bundle_sha256: string;
  mode: string;
};

async function claim(sql: Sql, leaseSeconds = 600): Promise<Claim[]> {
  const rows = await sql<Claim[]>`select * from private.cat_claim_run(${leaseSeconds})`;
  return rows.map((r) => ({ ...r }));
}

async function insertGame(sql: Sql, id: string): Promise<void> {
  await sql`insert into public.games (id, slug, owner_id, creator, title) values (${id}, ${id}, null, 'stub', 'Title')`;
}

async function insertRun(
  sql: Sql,
  gameId: string,
  bundle: string,
  opts: { status?: string; next?: string; attempts?: number; leaseUntil?: string | null; token?: string | null; started?: string | null; mode?: string } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into private.categorization_runs (
      game_id, version, bundle_sha256, pipeline_version, mode, status, attempts, next_attempt_at, lease_token, lease_until, started_at
    ) values (
      ${gameId}, 1, ${bundle}, 'cat-v1', ${opts.mode ?? 'shadow'},
      ${opts.status ?? 'queued'}, ${opts.attempts ?? 0},
      ${opts.next ?? iso(-1000)}::timestamptz,
      ${opts.token ?? null}::uuid, ${opts.leaseUntil ?? null}::timestamptz, ${opts.started ?? null}::timestamptz
    )
    returning id::text
  `;
  return row.id;
}

async function insertTag(
  sql: Sql,
  gameId: string,
  bundle: string,
  slug: string,
  status: string,
  applies: boolean | null,
  fields: { confidence?: number; evidence?: unknown; updatedDaysAgo?: number } = {},
): Promise<void> {
  await sql`
    insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies, confidence, evidence)
    values (${gameId}, ${bundle}, ${slug}, ${status}, ${applies}, ${fields.confidence ?? null}, ${fields.evidence === undefined ? null : JSON.stringify(fields.evidence)}::text::jsonb)
  `;
  if (fields.updatedDaysAgo !== undefined) {
    await sql`
      update public.game_tags
      set updated_at = now() - ${fields.updatedDaysAgo} * interval '1 day',
          created_at = now() - ${fields.updatedDaysAgo} * interval '1 day'
      where game_id = ${gameId} and bundle_sha256 = ${bundle} and category_slug = ${slug}
    `;
  }
}

async function recordResult(sql: Sql, runId: string, token: string, p: object): Promise<string> {
  const [row] = await sql<{ s: string }[]>`
    select private.cat_record_result(${runId}::bigint, ${token}::uuid, ${JSON.stringify(p)}::text::jsonb) as s
  `;
  return row.s;
}

async function failRun(sql: Sql, runId: string, token: string, code: string, retryable: boolean): Promise<string> {
  const [row] = await sql<{ s: string }[]>`
    select private.cat_fail_run(${runId}::bigint, ${token}::uuid, ${code}, ${retryable}) as s
  `;
  return row.s;
}

type RunRow = {
  status: string;
  attempts: number;
  error_code: string | null;
  next_attempt_at: Date;
  lease_token: string | null;
  lease_until: Date | null;
  finished_at: Date | null;
  usage: unknown;
};

async function runRow(sql: Sql, runId: string): Promise<RunRow> {
  const [row] = await sql<RunRow[]>`
    select status, attempts, error_code, next_attempt_at, lease_token::text, lease_until, finished_at, usage
    from private.categorization_runs where id = ${runId}::bigint
  `;
  return row;
}

async function enable(sql: Sql, on: boolean): Promise<void> {
  await sql`update private.settings set value = ${on ? 'true' : 'false'} where key = 'categorization_enabled'`;
}

async function setCap(sql: Sql, cap: number): Promise<void> {
  await sql`update private.settings set value = ${String(cap)} where key = 'categorization_daily_run_cap'`;
}

async function setMaxAttempts(sql: Sql, max: number): Promise<void> {
  await sql`update private.settings set value = ${String(max)} where key = 'categorization_max_attempts'`;
}

async function startedToday(sql: Sql): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from private.categorization_runs
    where started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  `;
  return n;
}

async function breaker(sql: Sql, provider: string): Promise<{ consecutive_failures: number; open_until: Date | null } | undefined> {
  const [row] = await sql<{ consecutive_failures: number; open_until: Date | null }[]>`
    select consecutive_failures, open_until from private.categorization_breaker where provider = ${provider}
  `;
  return row;
}

async function nextAttemptDeltaSeconds(sql: Sql, runId: string): Promise<number> {
  const [{ d }] = await sql<{ d: number }[]>`
    select extract(epoch from next_attempt_at - now()) as d
    from private.categorization_runs where id = ${runId}::bigint
  `;
  return d;
}

async function failAndCheck(sql: Sql, runId: string, leaseSeconds = 600): Promise<{ claim: Claim; next: RunRow }> {
  const [c] = await claim(sql, leaseSeconds);
  assert.equal(c?.run_id, runId);
  return { claim: c, next: await runRow(sql, runId) };
}

async function backdateNextAttempt(sql: Sql, runId: string): Promise<void> {
  await sql`update private.categorization_runs set next_attempt_at = now() - interval '1 second' where id = ${runId}::bigint`;
}

describe('categorization record, retry and purge (CAT-2b)', { concurrency: false }, () => {
  it('refuses stale and expired leases with lease_lost and writes nothing', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    const p = { tags: [{ slug: 'nsfw', status: 'confirmed', applies: true }], usage: { haiku_in: 1 } };
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await insertGame(tx, gameId);
        const runA = await insertRun(tx, gameId, sha('a'), {
          status: 'running',
          attempts: 1,
          token: tokenA,
          leaseUntil: iso(-60_000),
          started: iso(-120_000),
          next: iso(3_600_000),
        });
        const runB = await insertRun(tx, gameId, sha('b'), {
          status: 'running',
          attempts: 1,
          token: tokenB,
          leaseUntil: iso(-60_000),
          started: iso(-120_000),
          next: iso(-1_000),
        });
        await assert.rejects(tx.savepoint((sp) => recordResult(sp, runA, tokenA, p)), leaseLost);
        await assert.rejects(tx.savepoint((sp) => failRun(sp, runA, tokenA, 'haiku_5xx', true)), leaseLost);
        const [c] = await claim(tx);
        assert.equal(c?.run_id, runB);
        assert.notEqual(c?.lease_token, tokenB);
        await assert.rejects(tx.savepoint((sp) => recordResult(sp, runB, tokenB, p)), leaseLost);
        await assert.rejects(tx.savepoint((sp) => failRun(sp, runB, tokenB, 'haiku_5xx', true)), leaseLost);
        const [{ n }] = await tx<{ n: number }[]>`
          select count(*)::int as n from private.categorization_shadow_results where game_id = ${gameId}
        `;
        assert.equal(n, 0);
        const a = await runRow(tx, runA);
        assert.equal(a.status, 'running');
        assert.equal(a.lease_token, tokenA);
        const b = await runRow(tx, runB);
        assert.equal(b.status, 'running');
        assert.equal(b.lease_token, c.lease_token);
        assert.equal(b.error_code, null);
        assert.equal(b.finished_at, null);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('backs off 1, 4, 16, 60, 60 minutes, then fails at max attempts; non-retryable fails at once', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 40);
        await setMaxAttempts(tx, 10);
        await insertGame(tx, gameId);
        const runId = await insertRun(tx, gameId, sha('1'));
        for (const [i, minutes] of [1, 4, 16, 60, 60, 60, 60, 60, 60].entries()) {
          const { claim: c } = await failAndCheck(tx, runId);
          assert.equal(await failRun(tx, c.run_id, c.lease_token, 'fetch_5xx', true), 'queued');
          const row = await runRow(tx, runId);
          assert.equal(row.status, 'queued');
          assert.equal(row.error_code, 'fetch_5xx');
          assert.equal(row.lease_token, null);
          assert.equal(row.lease_until, null);
          assert.equal(row.attempts, i + 1);
          assert.equal(Math.round(await nextAttemptDeltaSeconds(tx, runId)), minutes * 60, `attempt ${i + 1}`);
          await backdateNextAttempt(tx, runId);
        }
        const { claim: last } = await failAndCheck(tx, runId);
        assert.equal(await failRun(tx, last.run_id, last.lease_token, 'fetch_5xx', true), 'failed');
        const done = await runRow(tx, runId);
        assert.equal(done.status, 'failed');
        assert.equal(done.error_code, 'fetch_5xx');
        assert.equal(done.attempts, 10);
        assert.ok(done.finished_at);
        assert.equal(done.lease_token, null);
        assert.equal(done.lease_until, null);

        await setMaxAttempts(tx, 2);
        const bounded = await insertRun(tx, gameId, sha('2'));
        const { claim: b1 } = await failAndCheck(tx, bounded);
        assert.equal(await failRun(tx, b1.run_id, b1.lease_token, 'fetch_timeout', true), 'queued');
        assert.equal(Math.round(await nextAttemptDeltaSeconds(tx, bounded)), 60);
        await backdateNextAttempt(tx, bounded);
        const { claim: b2 } = await failAndCheck(tx, bounded);
        assert.equal(await failRun(tx, b2.run_id, b2.lease_token, 'fetch_timeout', true), 'failed');
        assert.equal((await runRow(tx, bounded)).status, 'failed');

        const permanent = await insertRun(tx, gameId, sha('3'));
        const { claim: p1 } = await failAndCheck(tx, permanent);
        assert.equal(await failRun(tx, p1.run_id, p1.lease_token, 'bundle_mismatch', false), 'failed');
        const failed = await runRow(tx, permanent);
        assert.equal(failed.status, 'failed');
        assert.equal(failed.error_code, 'bundle_mismatch');
        assert.ok(failed.finished_at);
        assert.equal(failed.lease_token, null);
        assert.equal(failed.lease_until, null);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('shadow mode writes only the shadow table and records usage and status', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const review = {
      tags: [
        { slug: 'nsfw', status: 'needs_review', applies: null },
        { slug: 'kid_safe', status: 'confirmed', applies: true, confidence: 0.99 },
      ],
      usage: { haiku_in: 10, haiku_out: 20 },
    };
    const clean = {
      tags: [
        { slug: 'nsfw', status: 'rejected', applies: false, confidence: 0.01 },
        { slug: 'kid_safe', status: 'confirmed', applies: true, confidence: 0.99 },
      ],
      usage: { haiku_in: 5 },
    };
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        const runId = await insertRun(tx, gameId, sha('4'));
        const { claim: c } = await failAndCheck(tx, runId);
        assert.equal(await recordResult(tx, c.run_id, c.lease_token, review), 'needs_review');
        const [shadow] = await tx<{ run_id: string; game_id: string; result: unknown }[]>`
          select run_id::text, game_id, result from private.categorization_shadow_results where run_id = ${runId}::bigint
        `;
        assert.equal(shadow.game_id, gameId);
        assert.deepEqual(shadow.result, review);
        const [{ n }] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.game_tags where game_id = ${gameId}
        `;
        assert.equal(n, 0);
        const row = await runRow(tx, runId);
        assert.equal(row.status, 'needs_review');
        assert.deepEqual(row.usage, review.usage);
        assert.ok(row.finished_at);
        assert.equal(row.lease_token, null);
        assert.equal(row.lease_until, null);

        const runId2 = await insertRun(tx, gameId, sha('5'));
        const { claim: c2 } = await failAndCheck(tx, runId2);
        assert.equal(await recordResult(tx, c2.run_id, c2.lease_token, clean), 'succeeded');
        assert.equal((await runRow(tx, runId2)).status, 'succeeded');
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('active mode upserts game_tags but never overwrites overridden or appealed rows', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        await tx`
          insert into public.categories (slug, description, status, is_safety)
          values ('puzzle', 'puzzle and logic games', 'approved', false),
                 ('racing', 'racing and driving games', 'approved', false)
        `;
        const bundle = sha('6');
        await insertTag(tx, gameId, bundle, 'nsfw', 'overridden', true, { evidence: { note: 'keep' } });
        await insertTag(tx, gameId, bundle, 'kid_safe', 'appealed', false);
        await insertTag(tx, gameId, bundle, 'puzzle', 'confirmed', true);
        const runId = await insertRun(tx, gameId, bundle, { mode: 'active' });
        const { claim: c } = await failAndCheck(tx, runId);
        const result = {
          tags: [
            { slug: 'nsfw', status: 'rejected', applies: false, confidence: 0.01, evidence: { note: 'new' } },
            { slug: 'kid_safe', status: 'confirmed', applies: true, confidence: 0.99 },
            { slug: 'puzzle', status: 'needs_review', applies: null, confidence: 0.5 },
            { slug: 'racing', status: 'confirmed', applies: true, confidence: 0.9, model: 'm1', version: 'v1', evidence: { e: 1 } },
          ],
          usage: { jev_calls: 4 },
        };
        assert.equal(await recordResult(tx, c.run_id, c.lease_token, result), 'succeeded');
        const tags = await tx<{ category_slug: string; status: string; applies: boolean | null; confidence: string | null; evidence: unknown; model: string | null; version: string | null }[]>`
          select category_slug, status, applies, confidence::text, evidence, model, version
          from public.game_tags
          where game_id = ${gameId} and bundle_sha256 = ${bundle}
          order by category_slug
        `;
        const bySlug = new Map(tags.map((r) => [r.category_slug, r]));
        assert.deepEqual(
          { s: bySlug.get('nsfw')?.status, a: bySlug.get('nsfw')?.applies, e: bySlug.get('nsfw')?.evidence },
          { s: 'overridden', a: true, e: { note: 'keep' } },
        );
        assert.deepEqual(
          { s: bySlug.get('kid_safe')?.status, a: bySlug.get('kid_safe')?.applies },
          { s: 'appealed', a: false },
        );
        assert.deepEqual(
          { s: bySlug.get('puzzle')?.status, a: bySlug.get('puzzle')?.applies },
          { s: 'needs_review', a: null },
        );
        const racing = bySlug.get('racing');
        assert.equal(racing?.status, 'confirmed');
        assert.equal(racing?.applies, true);
        assert.equal(racing?.confidence, '0.9');
        assert.equal(racing?.model, 'm1');
        assert.equal(racing?.version, 'v1');
        assert.deepEqual(racing?.evidence, { e: 1 });
        assert.equal((await runRow(tx, runId)).status, 'succeeded');

        const runId2 = await insertRun(tx, gameId, sha('7'), { mode: 'active' });
        const { claim: c2 } = await failAndCheck(tx, runId2);
        const flagged = { tags: [{ slug: 'kid_safe', status: 'needs_review', applies: null }], usage: {} };
        assert.equal(await recordResult(tx, c2.run_id, c2.lease_token, flagged), 'needs_review');
        const [nr] = await tx<{ status: string; applies: boolean | null }[]>`
          select status, applies from public.game_tags
          where game_id = ${gameId} and bundle_sha256 = ${sha('7')} and category_slug = 'kid_safe'
        `;
        assert.deepEqual({ ...nr }, { status: 'needs_review', applies: null });
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('opens the breaker after five consecutive retryable provider failures and a success resets it', async (t) => {
    const sql = await connect(t);
    const fresh = await connect(t);
    if (!sql || !fresh) {
      await sql?.end({ timeout: 1 });
      await fresh?.end({ timeout: 1 });
      return;
    }
    const gameId = gid();
    try {
      await sql.begin(async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 60);
        await setMaxAttempts(tx, 20);
        await insertGame(tx, gameId);
      });
      const runId = await insertRun(sql, gameId, sha('a'));
      for (let i = 0; i < 4; i++) {
        const { claim: c } = await failAndCheck(sql, runId);
        assert.equal(await failRun(sql, c.run_id, c.lease_token, 'haiku_5xx', true), 'queued');
        await backdateNextAttempt(sql, runId);
      }
      let b = await breaker(sql, 'openrouter');
      assert.equal(b?.consecutive_failures, 4);
      assert.equal(b?.open_until, null);
      const { claim: c5 } = await failAndCheck(sql, runId);
      assert.equal(await failRun(sql, c5.run_id, c5.lease_token, 'haiku_5xx', true), 'queued');
      b = await breaker(sql, 'openrouter');
      assert.equal(b?.consecutive_failures, 5);
      assert.ok(b?.open_until);
      assert.ok(b.open_until.getTime() > Date.now() + 14 * 60_000, 'breaker open ~15min');
      const runX = await insertRun(sql, gameId, sha('e'));
      assert.deepEqual(await claim(sql), []);
      assert.deepEqual(await claim(fresh), []);

      await sql`
        update private.categorization_breaker set open_until = now() - interval '1 second' where provider = 'openrouter'
      `;
      const { claim: c6 } = await failAndCheck(fresh, runX);
      const success = { tags: [{ slug: 'nsfw', status: 'rejected', applies: false }], usage: {} };
      assert.equal(await recordResult(fresh, c6.run_id, c6.lease_token, success), 'succeeded');
      b = await breaker(sql, 'openrouter');
      assert.equal(b?.consecutive_failures, 0);

      const runId2 = await insertRun(sql, gameId, sha('b'));
      for (let i = 0; i < 4; i++) {
        const { claim: c } = await failAndCheck(sql, runId2);
        assert.equal(await failRun(sql, c.run_id, c.lease_token, 'haiku_5xx', true), 'queued');
        await backdateNextAttempt(sql, runId2);
      }
      b = await breaker(sql, 'openrouter');
      assert.equal(b?.consecutive_failures, 4);
      assert.equal(b?.open_until, null);
      const { claim: cOther } = await failAndCheck(sql, runId2);
      assert.equal(await failRun(sql, cOther.run_id, cOther.lease_token, 'fetch_5xx', true), 'queued');
      b = await breaker(sql, 'openrouter');
      assert.equal(b?.consecutive_failures, 4);
      assert.equal(b?.open_until, null);
      await backdateNextAttempt(sql, runId2);

      const { claim: cAuth } = await failAndCheck(sql, runId2);
      assert.equal(await failRun(sql, cAuth.run_id, cAuth.lease_token, 'haiku_auth', false), 'failed');
      b = await breaker(sql, 'openrouter');
      assert.equal(b?.consecutive_failures, 4);
      assert.ok(b?.open_until && b.open_until.getTime() > Date.now() + 14 * 60_000);
      const runY = await insertRun(sql, gameId, sha('f'));
      assert.deepEqual(await claim(sql), []);
      assert.deepEqual(await claim(fresh), []);

      await sql`
        update private.categorization_breaker set open_until = now() - interval '1 second' where provider = 'openrouter'
      `;
      const { claim: cBad } = await failAndCheck(sql, runY);
      assert.equal(await failRun(sql, cBad.run_id, cBad.lease_token, 'jev_bad_request', false), 'failed');
      const ty = await breaker(sql, 'typesafe');
      assert.ok(!ty || (ty.consecutive_failures === 0 && ty.open_until === null));

      const runId4 = await insertRun(sql, gameId, sha('d'));
      const { claim: cJev } = await failAndCheck(sql, runId4);
      assert.equal(await failRun(sql, cJev.run_id, cJev.lease_token, 'jev_auth', false), 'failed');
      const tyOpen = await breaker(sql, 'typesafe');
      assert.equal(tyOpen?.consecutive_failures, 0);
      assert.ok(tyOpen?.open_until && tyOpen.open_until.getTime() > Date.now() + 14 * 60_000);
      await insertRun(sql, gameId, sha('0'));
      assert.deepEqual(await claim(sql), []);
      assert.deepEqual(await claim(fresh), []);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql`delete from private.categorization_breaker`.catch(() => {});
      await sql`update private.settings set value = 'false' where key = 'categorization_enabled'`.catch(() => {});
      await sql`update private.settings set value = '5' where key = 'categorization_max_attempts'`.catch(() => {});
      await sql`update private.settings set value = '50' where key = 'categorization_daily_run_cap'`.catch(() => {});
      await sql.end({ timeout: 1 });
      await fresh.end({ timeout: 1 });
    }
  });

  it('purges shadow results older than 90 days and evidence older than 30 days', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, gameId);
        const oldRun = await insertRun(tx, gameId, sha('e'), { status: 'succeeded' });
        const newRun = await insertRun(tx, gameId, sha('f'), { status: 'succeeded' });
        const midRun = await insertRun(tx, gameId, sha('9'), { status: 'succeeded' });
        await tx`
          insert into private.categorization_shadow_results (run_id, game_id, result, created_at)
          values
            (${oldRun}::bigint, ${gameId}, '{}', now() - interval '91 days'),
            (${newRun}::bigint, ${gameId}, '{}', now() - interval '89 days'),
            (${midRun}::bigint, ${gameId}, '{}', now() - interval '89 days 12 hours')
        `;
        await insertTag(tx, gameId, sha('e'), 'nsfw', 'confirmed', true, { evidence: { keep: true } });
        const [{ deleted }] = await tx<{ deleted: number }[]>`
          select private.cat_purge_shadow_results() as deleted
        `;
        assert.equal(deleted, 1);
        const remaining = await tx<{ run_id: string }[]>`
          select run_id::text from private.categorization_shadow_results order by run_id
        `;
        assert.deepEqual(remaining.map((r) => r.run_id), [newRun, midRun]);
        const [tagKept] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.game_tags where game_id = ${gameId}
        `;
        assert.equal(tagKept.n, 1);

        await insertTag(tx, gameId, sha('e'), 'kid_safe', 'confirmed', true, { evidence: { old: true }, updatedDaysAgo: 31 });
        await insertTag(tx, gameId, sha('0'), 'nsfw', 'confirmed', true, { evidence: { recent: true }, updatedDaysAgo: 29 });
        await insertTag(tx, gameId, sha('8'), 'kid_safe', 'confirmed', true, { evidence: { edge: true }, updatedDaysAgo: 29.5 });
        const [{ nulled }] = await tx<{ nulled: number }[]>`
          select private.cat_purge_tag_evidence() as nulled
        `;
        const evidence = await tx<{ category_slug: string; bundle_sha256: string; evidence: unknown; status: string; applies: boolean }[]>`
          select category_slug, bundle_sha256, evidence, status, applies
          from public.game_tags where game_id = ${gameId}
          order by category_slug, bundle_sha256
        `;
        const ev = (slug: string, bundle: string) =>
          evidence.find((r) => r.category_slug === slug && r.bundle_sha256 === bundle);
        assert.equal(ev('kid_safe', sha('e'))?.evidence, null);
        assert.equal(ev('kid_safe', sha('e'))?.status, 'confirmed');
        assert.equal(ev('kid_safe', sha('e'))?.applies, true);
        assert.deepEqual(ev('nsfw', sha('0'))?.evidence, { recent: true });
        assert.deepEqual(ev('nsfw', sha('e'))?.evidence, { keep: true });
        assert.deepEqual(ev('kid_safe', sha('8'))?.evidence, { edge: true });
        assert.equal(evidence.length, 4);
        assert.equal(nulled, 1);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('clients cannot execute the new functions or read the tables', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const fnPrivs = await sql<{ who: string; fn: string; ok: boolean }[]>`
        select w.who, f.fn, has_function_privilege(w.who, f.fn::regprocedure, 'execute') as ok
        from (values ('anon'), ('authenticated'), ('service_role')) as w(who)
        cross join (values
          ('private.cat_propose_categories(bigint, uuid, jsonb)'),
          ('private.cat_record_result(bigint, uuid, jsonb)'),
          ('private.cat_fail_run(bigint, uuid, text, boolean)'),
          ('private.cat_purge_shadow_results()'),
          ('private.cat_purge_tag_evidence()')
        ) as f(fn)
      `;
      for (const row of fnPrivs) {
        if (row.who === 'service_role') assert.equal(row.ok, true, `service_role execute on ${row.fn}`);
        else assert.equal(row.ok, false, `${row.who} execute on ${row.fn}`);
      }
      await rollback(sql, async (tx) => {
        await tx.unsafe('set local role anon');
        for (const stmt of [
          'select private.cat_propose_categories(1, null, \'[]\')',
          'select private.cat_record_result(1, null, \'{}\')',
          'select private.cat_fail_run(1, null, \'internal\', true)',
          'select private.cat_purge_shadow_results()',
          'select private.cat_purge_tag_evidence()',
          'select * from private.categorization_runs',
          'select * from private.categorization_shadow_results',
          'select * from private.categorization_breaker',
        ]) {
          await assert.rejects(tx.savepoint((sp) => sp.unsafe(stmt)), refused('42501'), stmt);
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('two connections racing on the same run: exactly one write wins', async (t) => {
    const a = await connect(t);
    const b = await connect(t);
    if (!a || !b) {
      await a?.end({ timeout: 1 });
      await b?.end({ timeout: 1 });
      return;
    }
    const gameId = gid();
    try {
      await a.begin(async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
      });
      const runId = await insertRun(a, gameId, sha('8'));
      const [c] = await claim(a);
      assert.equal(c?.run_id, runId);
      const result = { tags: [{ slug: 'nsfw', status: 'rejected', applies: false }], usage: {} };

      const recordA = a
        .begin(async (tx) => {
          await tx`select private.cat_record_result(${runId}::bigint, ${c.lease_token}::uuid, ${JSON.stringify(result)}::text::jsonb)`;
          await tx`select pg_sleep(0.4)`;
        })
        .then(() => 'ok' as const, (err: unknown) => err);
      await new Promise((r) => setTimeout(r, 150));
      const recordB = await recordResult(b, runId, c.lease_token, result).then(
        () => 'ok' as const,
        (err: unknown) => err,
      );
      assert.equal(await recordA, 'ok');
      assert.ok(leaseLost(recordB), `expected lease_lost, got ${JSON.stringify(recordB)}`);
      assert.equal((await runRow(a, runId)).status, 'succeeded');
      const [{ n }] = await a<{ n: number }[]>`
        select count(*)::int as n from private.categorization_shadow_results where run_id = ${runId}::bigint
      `;
      assert.equal(n, 1);

      const runId2 = await insertRun(a, gameId, sha('9'));
      const [c2] = await claim(a);
      assert.equal(c2?.run_id, runId2);
      const failA = a
        .begin(async (tx) => {
          await tx`select private.cat_fail_run(${runId2}::bigint, ${c2.lease_token}::uuid, 'haiku_5xx', true)`;
          await tx`select pg_sleep(0.4)`;
        })
        .then(() => 'ok' as const, (err: unknown) => err);
      await new Promise((r) => setTimeout(r, 150));
      const failB = await failRun(b, runId2, c2.lease_token, 'haiku_5xx', true).then(
        () => 'ok' as const,
        (err: unknown) => err,
      );
      assert.equal(await failA, 'ok');
      assert.ok(leaseLost(failB), `expected lease_lost, got ${JSON.stringify(failB)}`);
      const stored = await runRow(a, runId2);
      assert.equal(stored.status, 'queued');
      assert.equal(stored.error_code, 'haiku_5xx');
      assert.equal(stored.lease_token, null);
    } finally {
      await a`delete from public.games where id = ${gameId}`.catch(() => {});
      await a`delete from private.categorization_breaker`.catch(() => {});
      await a`update private.settings set value = 'false' where key = 'categorization_enabled'`.catch(() => {});
      await a`update private.settings set value = '50' where key = 'categorization_daily_run_cap'`.catch(() => {});
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
    }
  });

  it('proposes up to three valid categories and refuses when 50 proposals are open', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const p = {
      proposed_categories: [
        { slug: ' New_Slug ', name: 'New', definition: 'a fresh kind of game' },
        { slug: 'ok_slug', name: 'Ok', definition: 'another fresh kind' },
        { slug: 'bad slug!', name: 'Bad', definition: 'not a valid slug' },
        { slug: 'fourth', name: 'Fourth', definition: 'past the limit of three' },
      ],
    };
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        const runId = await insertRun(tx, gameId, sha('1'));
        const { claim: c } = await failAndCheck(tx, runId);
        const [ins] = await tx<{ n: number }[]>`
          select private.cat_propose_categories(${runId}::bigint, ${c.lease_token}::uuid, ${JSON.stringify(p)}::text::jsonb) as n
        `;
        assert.equal(ins.n, 2);
        const proposed = await tx<{ slug: string; status: string; is_safety: boolean }[]>`
          select slug, status, is_safety from public.categories
          where slug in ('new_slug', 'ok_slug', 'fourth', 'bad slug!')
          order by slug
        `;
        assert.deepEqual(
          proposed.map((r) => ({ ...r })),
          [
            { slug: 'new_slug', status: 'proposed', is_safety: false },
            { slug: 'ok_slug', status: 'proposed', is_safety: false },
          ],
        );
        const [again] = await tx<{ n: number }[]>`
          select private.cat_propose_categories(${runId}::bigint, ${c.lease_token}::uuid, ${JSON.stringify(p)}::text::jsonb) as n
        `;
        assert.equal(again.n, 0);
        await assert.rejects(
          tx.savepoint((sp) => sp`
            select private.cat_propose_categories(${runId}::bigint, ${randomUUID()}::uuid, ${JSON.stringify(p)}::text::jsonb)
          `),
          leaseLost,
        );
        await tx`
          insert into public.categories (slug, description, status)
          select 'flood_' || i, 'flood proposal', 'proposed'
          from generate_series(1, 50) as i
        `;
        await assert.rejects(
          tx.savepoint((sp) => sp`
            select private.cat_propose_categories(${runId}::bigint, ${c.lease_token}::uuid, ${JSON.stringify(p)}::text::jsonb)
          `),
          refused('P0001'),
        );
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
