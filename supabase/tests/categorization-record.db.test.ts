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

async function propose(sql: Sql, runId: string, token: string, p: object): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select private.cat_propose_categories(${runId}::bigint, ${token}::uuid, ${JSON.stringify(p)}::text::jsonb) as n
  `;
  return row.n;
}

async function breakerOpenWindow(sql: Sql, provider: string): Promise<{ consecutive_failures: number; open_in_window: boolean | null } | undefined> {
  const [row] = await sql<{ consecutive_failures: number; open_in_window: boolean | null }[]>`
    select consecutive_failures,
           (open_until between now() + interval '14 minutes 59 seconds'
                           and now() + interval '15 minutes 1 second') as open_in_window
    from private.categorization_breaker where provider = ${provider}
  `;
  return row;
}

const tooManyProposals = (err: unknown) =>
  err instanceof postgres.PostgresError && err.code === 'P0001' && err.message === 'too_many_proposals';

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
      const success = {
        tags: [{ slug: 'nsfw', status: 'rejected', applies: false }],
        usage: {},
        providers: ['openrouter', 'typesafe'],
      };
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
      assert.equal(await breaker(sql, 'typesafe'), undefined);
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
      const orClosed = await breaker(sql, 'openrouter');
      assert.equal(orClosed?.consecutive_failures, 4);
      assert.ok(!orClosed?.open_until || orClosed.open_until.getTime() <= Date.now());
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

  it('keeps breaker state per provider and gates claims on the full required provider set', async (t) => {
    const sql = await connect(t);
    const fresh = await connect(t);
    if (!sql || !fresh) {
      await sql?.end({ timeout: 1 });
      await fresh?.end({ timeout: 1 });
      return;
    }
    const gameId = gid();
    const park = () =>
      sql`update private.categorization_runs set next_attempt_at = now() + interval '1 day' where game_id = ${gameId} and status = 'queued'`;
    const expireOpen = (provider: string) =>
      sql`update private.categorization_breaker set open_until = now() - interval '1 second' where provider = ${provider}`;
    const failOn = async (runId: string, code: string) => {
      const { claim: c } = await failAndCheck(sql, runId);
      await failRun(sql, c.run_id, c.lease_token, code, true);
      await backdateNextAttempt(sql, runId);
    };
    const result = (providers?: string[]) => ({
      tags: [{ slug: 'nsfw', status: 'rejected', applies: false }],
      usage: {},
      ...(providers ? { providers } : {}),
    });
    const closed = (b: { consecutive_failures: number; open_until: Date | null } | undefined) =>
      !b || !b.open_until || b.open_until.getTime() <= Date.now();
    try {
      await sql.begin(async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 80);
        await setMaxAttempts(tx, 30);
        await insertGame(tx, gameId);
        await tx`delete from private.categorization_breaker`;
      });
      const newRun = (bundle: string) => insertRun(sql, gameId, sha(bundle), { next: iso(-31_536_000_000) });

      const runOR = await newRun('a');
      for (let i = 0; i < 5; i++) await failOn(runOR, 'haiku_5xx');
      let orRow = await breaker(sql, 'openrouter');
      assert.equal(orRow?.consecutive_failures, 5);
      assert.ok(orRow?.open_until && orRow.open_until.getTime() > Date.now() + 14 * 60_000);
      assert.equal(await breaker(sql, 'typesafe'), undefined);
      assert.deepEqual(await claim(sql), []);
      assert.deepEqual(await claim(fresh), []);
      await expireOpen('openrouter');

      await park();
      const runTS = await newRun('b');
      for (let i = 0; i < 5; i++) await failOn(runTS, 'jev_5xx');
      let tsRow = await breaker(sql, 'typesafe');
      assert.equal(tsRow?.consecutive_failures, 5);
      assert.ok(tsRow?.open_until && tsRow.open_until.getTime() > Date.now() + 14 * 60_000);
      orRow = await breaker(sql, 'openrouter');
      assert.equal(orRow?.consecutive_failures, 5);
      assert.ok(!orRow?.open_until || orRow.open_until.getTime() <= Date.now());
      assert.deepEqual(await claim(sql), []);
      assert.deepEqual(await claim(fresh), []);
      await expireOpen('typesafe');

      await park();
      const runReset = await newRun('c');
      let [c] = await claim(sql);
      assert.equal(c?.run_id, runReset);
      assert.equal(await recordResult(sql, c.run_id, c.lease_token, result(['openrouter', 'typesafe'])), 'succeeded');
      assert.equal((await breaker(sql, 'openrouter'))?.consecutive_failures, 0);
      assert.equal((await breaker(sql, 'typesafe'))?.consecutive_failures, 0);

      await park();
      const runBoth = await newRun('d');
      for (let i = 0; i < 4; i++) await failOn(runBoth, 'haiku_5xx');
      for (let i = 0; i < 4; i++) await failOn(runBoth, 'jev_5xx');
      assert.equal((await breaker(sql, 'openrouter'))?.consecutive_failures, 4);
      assert.equal((await breaker(sql, 'typesafe'))?.consecutive_failures, 4);

      await park();
      const runNone = await newRun('e');
      [c] = await claim(sql);
      assert.equal(c?.run_id, runNone);
      assert.equal(await recordResult(sql, c.run_id, c.lease_token, result()), 'succeeded');
      assert.equal((await breaker(sql, 'openrouter'))?.consecutive_failures, 4);
      assert.equal((await breaker(sql, 'typesafe'))?.consecutive_failures, 4);

      await park();
      const runResetOR = await newRun('f');
      [c] = await claim(sql);
      assert.equal(c?.run_id, runResetOR);
      assert.equal(await recordResult(sql, c.run_id, c.lease_token, result(['openrouter'])), 'succeeded');
      orRow = await breaker(sql, 'openrouter');
      assert.equal(orRow?.consecutive_failures, 0);
      assert.equal(orRow?.open_until, null);
      assert.equal((await breaker(sql, 'typesafe'))?.consecutive_failures, 4);
      await park();
      const runTSOpen = await newRun('0');
      await failOn(runTSOpen, 'jev_5xx');
      tsRow = await breaker(sql, 'typesafe');
      assert.equal(tsRow?.consecutive_failures, 5);
      assert.ok(tsRow?.open_until && tsRow.open_until.getTime() > Date.now() + 14 * 60_000);
      assert.deepEqual(await claim(sql), []);
      assert.deepEqual(await claim(fresh), []);
      await expireOpen('typesafe');

      await park();
      const runOR4 = await newRun('1');
      for (let i = 0; i < 4; i++) await failOn(runOR4, 'haiku_5xx');
      assert.equal((await breaker(sql, 'openrouter'))?.consecutive_failures, 4);
      await park();
      const runResetTS = await newRun('2');
      [c] = await claim(sql);
      assert.equal(c?.run_id, runResetTS);
      assert.equal(await recordResult(sql, c.run_id, c.lease_token, result(['typesafe'])), 'succeeded');
      tsRow = await breaker(sql, 'typesafe');
      assert.equal(tsRow?.consecutive_failures, 0);
      assert.equal(tsRow?.open_until, null);
      assert.equal((await breaker(sql, 'openrouter'))?.consecutive_failures, 4);
      await park();
      const runOROpen = await newRun('3');
      await failOn(runOROpen, 'haiku_5xx');
      orRow = await breaker(sql, 'openrouter');
      assert.equal(orRow?.consecutive_failures, 5);
      assert.ok(orRow?.open_until && orRow.open_until.getTime() > Date.now() + 14 * 60_000);
      assert.equal((await breaker(sql, 'typesafe'))?.consecutive_failures, 0);
      assert.deepEqual(await claim(sql), []);
      assert.deepEqual(await claim(fresh), []);
      await expireOpen('openrouter');

      assert.ok(closed(await breaker(sql, 'openrouter')));
      assert.ok(closed(await breaker(sql, 'typesafe')));
      await park();
      const runOK = await newRun('4');
      const [cok] = await claim(fresh);
      assert.equal(cok?.run_id, runOK);
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

  it('proposes up to three valid categories and refuses when more than 50 proposals are open', async (t) => {
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
        const [{ n: tagsBefore }] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.game_tags where game_id = ${gameId}
        `;
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
        const [{ n: approved }] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.categories
          where slug in ('new_slug', 'ok_slug', 'fourth') and status <> 'proposed'
        `;
        assert.equal(approved, 0);
        const [{ n: tagsAfter }] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.game_tags where game_id = ${gameId}
        `;
        assert.equal(tagsAfter, tagsBefore);
        const [{ n: proposedTags }] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.game_tags
          where game_id = ${gameId} and category_slug in ('new_slug', 'ok_slug', 'fourth')
        `;
        assert.equal(proposedTags, 0);
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
          from generate_series(1, 51) as i
        `;
        await assert.rejects(
          tx.savepoint((sp) => sp`
            select private.cat_propose_categories(${runId}::bigint, ${c.lease_token}::uuid, ${JSON.stringify(p)}::text::jsonb)
          `),
          tooManyProposals,
        );
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('opens the breaker for exactly 15 minutes on the fifth failure and at once on auth and credits errors', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        const running = async (bundle: string) => {
          const token = randomUUID();
          const id = await insertRun(tx, gameId, bundle, {
            status: 'running',
            attempts: 1,
            token,
            leaseUntil: iso(600_000),
            started: iso(-60_000),
            next: iso(3_600_000),
          });
          return { id, token };
        };
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 30);
        await setMaxAttempts(tx, 20);
        await insertGame(tx, gameId);
        const runId = await insertRun(tx, gameId, sha('a'));
        for (let i = 0; i < 5; i++) {
          const { claim: c } = await failAndCheck(tx, runId);
          assert.equal(await failRun(tx, c.run_id, c.lease_token, 'haiku_5xx', true), 'queued');
          await backdateNextAttempt(tx, runId);
        }
        assert.deepEqual(await breakerOpenWindow(tx, 'openrouter'), { consecutive_failures: 5, open_in_window: true });
        assert.equal(await breaker(tx, 'typesafe'), undefined);

        await tx`delete from private.categorization_breaker`;
        const auth = await running(sha('b'));
        assert.equal(await failRun(tx, auth.id, auth.token, 'haiku_auth', false), 'failed');
        assert.deepEqual(await breakerOpenWindow(tx, 'openrouter'), { consecutive_failures: 0, open_in_window: true });
        assert.equal(await breaker(tx, 'typesafe'), undefined);

        await tx`delete from private.categorization_breaker`;
        const credits = await running(sha('c'));
        assert.equal(await failRun(tx, credits.id, credits.token, 'haiku_credits', false), 'failed');
        assert.deepEqual(await breakerOpenWindow(tx, 'openrouter'), { consecutive_failures: 0, open_in_window: true });
        assert.equal(await breaker(tx, 'typesafe'), undefined);

        await tx`delete from private.categorization_breaker`;
        const jev = await running(sha('d'));
        assert.equal(await failRun(tx, jev.id, jev.token, 'jev_auth', false), 'failed');
        assert.deepEqual(await breakerOpenWindow(tx, 'typesafe'), { consecutive_failures: 0, open_in_window: true });
        assert.equal(await breaker(tx, 'openrouter'), undefined);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('re-opens a half-open breaker for 15 minutes and refreshes open_until on further failures', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 30);
        await setMaxAttempts(tx, 20);
        await insertGame(tx, gameId);
        const runId = await insertRun(tx, gameId, sha('a'));
        for (let i = 0; i < 5; i++) {
          const { claim: c } = await failAndCheck(tx, runId);
          assert.equal(await failRun(tx, c.run_id, c.lease_token, 'haiku_5xx', true), 'queued');
          await backdateNextAttempt(tx, runId);
        }
        assert.equal((await breaker(tx, 'openrouter'))?.consecutive_failures, 5);
        await tx`update private.categorization_breaker set open_until = now() - interval '1 second' where provider = 'openrouter'`;
        const { claim: c6 } = await failAndCheck(tx, runId);
        assert.equal(await failRun(tx, c6.run_id, c6.lease_token, 'haiku_5xx', true), 'queued');
        assert.deepEqual(await breakerOpenWindow(tx, 'openrouter'), { consecutive_failures: 6, open_in_window: true });
        await tx`update private.categorization_breaker set open_until = now() + interval '10 minutes' where provider = 'openrouter'`;
        const token = randomUUID();
        const runId2 = await insertRun(tx, gameId, sha('b'), {
          status: 'running',
          attempts: 2,
          token,
          leaseUntil: iso(600_000),
          started: iso(-60_000),
          next: iso(3_600_000),
        });
        assert.equal(await failRun(tx, runId2, token, 'haiku_5xx', true), 'queued');
        assert.deepEqual(await breakerOpenWindow(tx, 'openrouter'), { consecutive_failures: 7, open_in_window: true });
        assert.equal(await breaker(tx, 'typesafe'), undefined);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('lets claims through exactly at open_until and blocks them a microsecond later', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        const runId = await insertRun(tx, gameId, sha('a'));
        await tx`insert into private.categorization_breaker (provider, open_until) values ('openrouter', now())`;
        const [c] = await claim(tx);
        assert.equal(c?.run_id, runId);
        const runId2 = await insertRun(tx, gameId, sha('b'));
        await tx`update private.categorization_breaker set open_until = now() + interval '1 microsecond' where provider = 'openrouter'`;
        assert.deepEqual(await claim(tx), []);
        await tx`update private.categorization_breaker set open_until = now() + interval '1 second' where provider = 'openrouter'`;
        assert.deepEqual(await claim(tx), []);
        assert.equal((await runRow(tx, runId2)).status, 'queued');
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('ignores a providers field that is not a jsonb array', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        await tx`
          insert into private.categorization_breaker (provider, consecutive_failures)
          values ('openrouter', 4), ('typesafe', 2)
        `;
        const base = { tags: [{ slug: 'nsfw', status: 'rejected', applies: false }], usage: {} };
        for (const [i, providers] of ['openrouter', { provider: 'openrouter' }, 7, null].entries()) {
          const runId = await insertRun(tx, gameId, sha(String(i + 5)));
          const { claim: c } = await failAndCheck(tx, runId);
          assert.equal(await recordResult(tx, c.run_id, c.lease_token, { ...base, providers }), 'succeeded');
        }
        assert.equal((await breaker(tx, 'openrouter'))?.consecutive_failures, 4);
        assert.equal((await breaker(tx, 'typesafe'))?.consecutive_failures, 2);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('purges shadow rows strictly older than 90 days and evidence strictly older than 30 days on updated_at', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, gameId);
        const rEdge = await insertRun(tx, gameId, sha('a'), { status: 'succeeded' });
        const rUnder = await insertRun(tx, gameId, sha('b'), { status: 'succeeded' });
        const rOver = await insertRun(tx, gameId, sha('c'), { status: 'succeeded' });
        const rOld = await insertRun(tx, gameId, sha('d'), { status: 'succeeded' });
        await tx`
          insert into private.categorization_shadow_results (run_id, game_id, result, created_at)
          values
            (${rEdge}::bigint, ${gameId}, '{}', now() - interval '90 days'),
            (${rUnder}::bigint, ${gameId}, '{}', now() - interval '89 days 23 hours 30 minutes'),
            (${rOver}::bigint, ${gameId}, '{}', now() - interval '90 days 1 second'),
            (${rOld}::bigint, ${gameId}, '{}', now() - interval '91 days')
        `;
        const [{ deleted }] = await tx<{ deleted: number }[]>`
          select private.cat_purge_shadow_results() as deleted
        `;
        assert.equal(deleted, 2);
        const remaining = await tx<{ run_id: string }[]>`
          select run_id::text from private.categorization_shadow_results order by run_id
        `;
        assert.deepEqual(remaining.map((r) => r.run_id), [rEdge, rUnder]);

        await tx`insert into public.categories (slug, description, status) values ('edgecat', 'edge', 'approved')`;
        await tx`
          insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies, evidence, created_at, updated_at)
          values
            (${gameId}, ${sha('e')}, 'nsfw', 'confirmed', true, '{"k":"edge"}', now() - interval '30 days', now() - interval '30 days'),
            (${gameId}, ${sha('e')}, 'kid_safe', 'confirmed', true, '{"k":"under"}', now() - interval '29 days 23 hours 30 minutes', now() - interval '29 days 23 hours 30 minutes'),
            (${gameId}, ${sha('e')}, 'edgecat', 'confirmed', true, '{"k":"over"}', now() - interval '30 days 1 second', now() - interval '30 days 1 second'),
            (${gameId}, ${sha('f')}, 'nsfw', 'confirmed', true, '{"k":"created_old"}', now() - interval '60 days', now()),
            (${gameId}, ${sha('f')}, 'kid_safe', 'confirmed', true, '{"k":"updated_old"}', now(), now() - interval '31 days'),
            (${gameId}, ${sha('0')}, 'nsfw', 'confirmed', true, null, now() - interval '40 days', now() - interval '40 days')
        `;
        const [{ nulled }] = await tx<{ nulled: number }[]>`
          select private.cat_purge_tag_evidence() as nulled
        `;
        assert.equal(nulled, 2);
        const tags = await tx<{ category_slug: string; bundle_sha256: string; evidence: unknown }[]>`
          select category_slug, bundle_sha256, evidence
          from public.game_tags where game_id = ${gameId}
          order by bundle_sha256, category_slug
        `;
        assert.equal(tags.length, 6);
        const ev = (bundle: string, slug: string) =>
          tags.find((r) => r.bundle_sha256 === bundle && r.category_slug === slug)?.evidence;
        assert.deepEqual(ev(sha('e'), 'nsfw'), { k: 'edge' });
        assert.deepEqual(ev(sha('e'), 'kid_safe'), { k: 'under' });
        assert.equal(ev(sha('e'), 'edgecat'), null);
        assert.deepEqual(ev(sha('f'), 'nsfw'), { k: 'created_old' });
        assert.equal(ev(sha('f'), 'kid_safe'), null);
        assert.equal(ev(sha('0'), 'nsfw'), null);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('never links proposed or unknown categories to game_tags in active mode', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        await tx`
          insert into public.categories (slug, description, status)
          values ('fresh_idea', 'model proposal', 'proposed'), ('retired_cat', 'old', 'retired')
        `;
        const bundle = sha('1');
        const runId = await insertRun(tx, gameId, bundle, { mode: 'active' });
        const { claim: c } = await failAndCheck(tx, runId);
        const p = {
          tags: [
            { slug: 'nsfw', status: 'rejected', applies: false, confidence: 0.01 },
            { slug: 'fresh_idea', status: 'confirmed', applies: true, confidence: 0.9 },
            { slug: 'retired_cat', status: 'confirmed', applies: true, confidence: 0.9 },
            { slug: 'no_such_cat', status: 'confirmed', applies: true, confidence: 0.9 },
          ],
          usage: { dropped: 3 },
        };
        assert.equal(await recordResult(tx, c.run_id, c.lease_token, p), 'succeeded');
        const tags = await tx<{ category_slug: string; status: string }[]>`
          select category_slug, status from public.game_tags where game_id = ${gameId}
        `;
        assert.deepEqual(tags.map((r) => ({ ...r })), [{ category_slug: 'nsfw', status: 'rejected' }]);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('propose stores crafted input as proposed non-safety, keeps existing slugs and refuses an expired lease', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const p = {
      proposed_categories: [
        { slug: 'craft_flag', name: 'n', definition: 'crafted proposal', status: 'approved', is_safety: true, confirm_threshold: 1, reject_threshold: 0.9, game_id: gameId },
        { slug: 'kept_slug', name: 'n', definition: 'overwrite attempt', status: 'retired', is_safety: true },
        { slug: 'Craft_Retired', definition: 'second crafted', status: 'retired', is_safety: true },
      ],
    };
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        await tx`
          insert into public.categories (slug, description, status, is_safety)
          values ('kept_slug', 'original description', 'approved', true)
        `;
        const runId = await insertRun(tx, gameId, sha('1'));
        const { claim: c } = await failAndCheck(tx, runId);
        assert.equal(await propose(tx, runId, c.lease_token, p), 2);
        const rows = await tx<{ slug: string; status: string; is_safety: boolean; description: string; confirm_threshold: string; reject_threshold: string }[]>`
          select slug, status, is_safety, description, confirm_threshold::text, reject_threshold::text
          from public.categories
          where slug in ('craft_flag', 'craft_retired', 'kept_slug')
          order by slug
        `;
        assert.deepEqual(
          rows.map((r) => ({ ...r })),
          [
            { slug: 'craft_flag', status: 'proposed', is_safety: false, description: 'crafted proposal', confirm_threshold: '0.85', reject_threshold: '0.15' },
            { slug: 'craft_retired', status: 'proposed', is_safety: false, description: 'second crafted', confirm_threshold: '0.85', reject_threshold: '0.15' },
            { slug: 'kept_slug', status: 'approved', is_safety: true, description: 'original description', confirm_threshold: '0.85', reject_threshold: '0.15' },
          ],
        );
        const expiredToken = randomUUID();
        const runExp = await insertRun(tx, gameId, sha('2'), {
          status: 'running',
          attempts: 1,
          token: expiredToken,
          leaseUntil: iso(-60_000),
          started: iso(-120_000),
          next: iso(3_600_000),
        });
        await assert.rejects(tx.savepoint((sp) => propose(sp, runExp, expiredToken, p)), leaseLost);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('refuses propose only when open plus new slugs would exceed 50, counting only new valid slugs', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const p = (...slugs: string[]) => ({
      proposed_categories: slugs.map((slug) => ({ slug, definition: 'def ' + slug })),
    });
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        const runId = await insertRun(tx, gameId, sha('1'));
        const { claim: c } = await failAndCheck(tx, runId);
        const openCount = async () =>
          (await tx<{ n: number }[]>`select count(*)::int as n from public.categories where status = 'proposed'`)[0].n;
        const setOpen = async (target: number) => {
          await tx`delete from public.categories where slug like 'cf\_%'`;
          const base = await openCount();
          assert.ok(base <= target, `baseline open ${base} exceeds target ${target}`);
          await tx`
            insert into public.categories (slug, description, status)
            select 'cf_' || i, 'filler', 'proposed'
            from generate_series(${base + 1}::int, ${target}::int) as i
          `;
          assert.equal(await openCount(), target);
        };
        const absent = async (...slugs: string[]) => {
          const [{ n }] = await tx<{ n: number }[]>`
            select count(*)::int as n from public.categories where slug = any(${slugs})
          `;
          assert.equal(n, 0);
        };

        await setOpen(47);
        assert.equal(await propose(tx, runId, c.lease_token, p('cap_a', 'cap_b', 'cap_c')), 3);
        assert.equal(await openCount(), 50);

        await assert.rejects(tx.savepoint((sp) => propose(sp, runId, c.lease_token, p('cap_d'))), tooManyProposals);
        await assert.rejects(
          tx.savepoint((sp) => propose(sp, runId, c.lease_token, p('cap_e', 'cap_f', 'cap_g'))),
          tooManyProposals,
        );
        await absent('cap_d', 'cap_e', 'cap_f', 'cap_g');

        await setOpen(49);
        await assert.rejects(
          tx.savepoint((sp) => propose(sp, runId, c.lease_token, p('cap_h', 'cap_i', 'cap_j'))),
          tooManyProposals,
        );
        await absent('cap_h', 'cap_i', 'cap_j');
        assert.equal(await openCount(), 49);

        await tx`
          insert into public.categories (slug, description, status)
          values ('cap_ex1', 'existing one', 'approved'), ('cap_ex2', 'existing two', 'retired')
        `;
        assert.equal(await propose(tx, runId, c.lease_token, p('cap_ex1', 'cap_ex2', 'cap_k')), 1);
        assert.equal(await openCount(), 50);

        await setOpen(49);
        assert.equal(await propose(tx, runId, c.lease_token, p('cap_m', 'cap_m', 'cap_m')), 1);
        assert.equal(await openCount(), 50);

        assert.equal(await propose(tx, runId, c.lease_token, p('cap_ex1', 'cap_ex2')), 0);
        assert.equal(await openCount(), 50);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('serializes concurrent propose calls so two racing connections cannot both pass the cap', async (t) => {
    const a = await connect(t);
    const b = await connect(t);
    if (!a || !b) {
      await a?.end({ timeout: 1 });
      await b?.end({ timeout: 1 });
      return;
    }
    const gameId = gid();
    try {
      const [{ open }] = await a<{ open: number }[]>`
        select count(*)::int as open from public.categories where status = 'proposed'
      `;
      await a.begin(async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        await tx`
          insert into public.categories (slug, description, status)
          select 'race_' || i, 'filler', 'proposed'
          from generate_series(${open + 1}, 49) as i
        `;
      });
      const runA = await insertRun(a, gameId, sha('a'));
      const [cA] = await claim(a);
      assert.equal(cA?.run_id, runA);
      const runB = await insertRun(a, gameId, sha('b'));
      const [cB] = await claim(b);
      assert.equal(cB?.run_id, runB);
      await b`set statement_timeout = '15s'`;
      let held!: () => void;
      const aHolds = new Promise<void>((r) => {
        held = r;
      });
      const txA = a
        .begin(async (tx) => {
          try {
            assert.equal(await propose(tx, runA, cA.lease_token, { proposed_categories: [{ slug: 'race_a', definition: 'a' }] }), 1);
          } finally {
            held();
          }
          await tx`select pg_sleep(0.5)`;
        })
        .then(() => 'ok' as const, (err: unknown) => err);
      await aHolds;
      const resB = await propose(b, runB, cB.lease_token, { proposed_categories: [{ slug: 'race_b', definition: 'b' }] }).then(
        () => 'ok' as const,
        (err: unknown) => err,
      );
      assert.equal(await txA, 'ok');
      assert.ok(tooManyProposals(resB), `expected too_many_proposals, got ${JSON.stringify(resB)}`);
      const [{ n }] = await a<{ n: number }[]>`
        select count(*)::int as n from public.categories where slug in ('race_a', 'race_b')
      `;
      assert.equal(n, 1);
      const [{ open: openAfter }] = await a<{ open: number }[]>`
        select count(*)::int as open from public.categories where status = 'proposed'
      `;
      assert.equal(openAfter, 50);
    } finally {
      await a`delete from public.games where id = ${gameId}`.catch(() => {});
      await a`delete from public.categories where slug like 'race\_%'`.catch(() => {});
      await a`update private.settings set value = 'false' where key = 'categorization_enabled'`.catch(() => {});
      await a`update private.settings set value = '50' where key = 'categorization_daily_run_cap'`.catch(() => {});
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
    }
  });

  it('releases the propose advisory lock at commit so a second session can propose', async (t) => {
    const dbUrl = localDbUrl();
    if (!dbUrl) {
      t.skip('refusing to run categorization record SQL against a non-local database');
      return;
    }
    const a = postgres(dbUrl, { connect_timeout: 3, max: 1 });
    const b = postgres(dbUrl, { connect_timeout: 3, max: 1 });
    try {
      await a`select 1`;
      await b`select 1`;
    } catch {
      await a.end({ timeout: 1 }).catch(() => {});
      await b.end({ timeout: 1 }).catch(() => {});
      t.skip('local supabase is not running');
      return;
    }
    const gameId = gid();
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    try {
      await b`set statement_timeout = '10s'`;
      await insertGame(a, gameId);
      const runA = await insertRun(a, gameId, sha('a'), {
        status: 'running',
        token: tokenA,
        leaseUntil: iso(600_000),
      });
      const runB = await insertRun(a, gameId, sha('b'), {
        status: 'running',
        token: tokenB,
        leaseUntil: iso(600_000),
      });
      assert.equal(
        await propose(a, runA, tokenA, { proposed_categories: [{ slug: 'lock_a', definition: 'a' }] }),
        1,
      );
      const [{ pid }] = await a<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const [{ n: held }] = await a<{ n: number }[]>`
        select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = ${pid}
      `;
      assert.equal(held, 0);
      assert.equal(
        await propose(b, runB, tokenB, { proposed_categories: [{ slug: 'lock_b', definition: 'b' }] }),
        1,
      );
    } finally {
      await a`delete from public.games where id = ${gameId}`.catch(() => {});
      await a`delete from public.categories where slug in ('lock_a', 'lock_b')`.catch(() => {});
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
    }
  });

  it('leaves game_tags rows for categories that lost approved status untouched on a new run', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, (await startedToday(tx)) + 10);
        await insertGame(tx, gameId);
        await tx`
          insert into public.categories (slug, description, status)
          values ('fading_ret', 'retired later', 'approved'),
                 ('fading_prop', 're-proposed later', 'approved'),
                 ('control_cat', 'stays approved', 'approved')
        `;
        const bundle = sha('1');
        await insertTag(tx, gameId, bundle, 'fading_ret', 'confirmed', true, {
          confidence: 0.9,
          evidence: { keep: 'ret' },
          updatedDaysAgo: 5,
        });
        await insertTag(tx, gameId, bundle, 'fading_prop', 'confirmed', true, {
          confidence: 0.8,
          evidence: { keep: 'prop' },
          updatedDaysAgo: 5,
        });
        const snapshot = async () => {
          const rows = await tx<
            {
              category_slug: string;
              status: string;
              applies: boolean | null;
              confidence: string | null;
              evidence: unknown;
              updated_at: Date;
            }[]
          >`
            select category_slug, status, applies, confidence::text, evidence, updated_at
            from public.game_tags
            where game_id = ${gameId} and bundle_sha256 = ${bundle} and category_slug like 'fading\_%'
            order by category_slug
          `;
          return rows.map((r) => ({ ...r }));
        };
        const before = await snapshot();
        assert.equal(before.length, 2);
        await tx`update public.categories set status = 'retired' where slug = 'fading_ret'`;
        await tx`update public.categories set status = 'proposed' where slug = 'fading_prop'`;
        const runId = await insertRun(tx, gameId, bundle, { mode: 'active' });
        const { claim: c } = await failAndCheck(tx, runId);
        const p = {
          tags: [
            { slug: 'fading_ret', status: 'rejected', applies: false, confidence: 0.1, evidence: { overwrite: true } },
            { slug: 'fading_prop', status: 'rejected', applies: false, confidence: 0.2, evidence: { overwrite: true } },
            { slug: 'control_cat', status: 'confirmed', applies: true, confidence: 0.7 },
          ],
          usage: {},
        };
        assert.equal(await recordResult(tx, c.run_id, c.lease_token, p), 'succeeded');
        assert.deepEqual(await snapshot(), before);
        const [control] = await tx<{ status: string }[]>`
          select status from public.game_tags
          where game_id = ${gameId} and bundle_sha256 = ${bundle} and category_slug = 'control_cat'
        `;
        assert.equal(control?.status, 'confirmed');
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
