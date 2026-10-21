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
    t.skip('refusing to run categorization queue SQL against a non-local database');
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

const sha = (ch: string) => ch.repeat(64);
const gid = () => `cat2a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

async function insertGame(sql: Sql, id: string, ownerId: string | null, fields: { title?: string; tagline?: string; description?: string; tags?: string[]; creator?: string } = {}): Promise<void> {
  await sql`
    insert into public.games (id, slug, owner_id, creator, title, tagline, description, tags)
    values (
      ${id}, ${id}, ${ownerId}, ${fields.creator ?? 'stub'}, ${fields.title ?? 'Title'},
      ${fields.tagline ?? ''}, ${fields.description ?? ''}, ${fields.tags ?? []}
    )
  `;
}

async function insertRun(sql: Sql, gameId: string, bundle: string, opts: { status?: string; next?: string; attempts?: number; leaseUntil?: string | null; token?: string | null; started?: string | null; version?: number; mode?: string } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into private.categorization_runs (
      game_id, version, bundle_sha256, pipeline_version, mode, status, attempts, next_attempt_at, lease_token, lease_until, started_at
    ) values (
      ${gameId}, ${opts.version ?? 1}, ${bundle}, 'cat-v1', ${opts.mode ?? 'shadow'},
      ${opts.status ?? 'queued'}, ${opts.attempts ?? 0},
      ${opts.next ?? new Date(Date.now() - 1000).toISOString()}::timestamptz,
      ${opts.token ?? null}::uuid, ${opts.leaseUntil ?? null}::timestamptz, ${opts.started ?? null}::timestamptz
    )
    returning id::text
  `;
  return row.id;
}

async function enable(sql: Sql, on: boolean): Promise<void> {
  await sql`update private.settings set value = ${on ? 'true' : 'false'} where key = 'categorization_enabled'`;
}

async function setCap(sql: Sql, cap: number): Promise<void> {
  await sql`update private.settings set value = ${String(cap)} where key = 'categorization_daily_run_cap'`;
}

describe('categorization queue (CAT-2a)', { concurrency: false }, () => {
  it('two separate connections never claim the same run', async (t) => {
    const a = await connect(t);
    const b = await connect(t, 1);
    if (!a || !b) {
      await a?.end({ timeout: 1 });
      await b?.end({ timeout: 1 });
      return;
    }
    const gameId = gid();
    try {
      await a.begin(async (tx) => {
        await enable(tx, true);
        await insertGame(tx, gameId, null);
        await insertRun(tx, gameId, sha('a'));
        await insertRun(tx, gameId, sha('b'));
      });
      const held = a.begin(async (tx) => {
        const [locked] = await tx<{ id: string }[]>`
          select id::text from private.categorization_runs
          where game_id = ${gameId}
          order by id
          for update
          limit 1
        `;
        await tx`select pg_sleep(1.5)`;
        return locked.id;
      });
      await new Promise((r) => setTimeout(r, 200));
      const [claimed] = await b.begin((tx) => claim(tx));
      const lockedId = await held;
      assert.ok(claimed);
      assert.notEqual(claimed.run_id, lockedId);
      const stored = await a<{ id: string; status: string; attempts: number }[]>`
        select id::text, status, attempts from private.categorization_runs where game_id = ${gameId} order by id
      `;
      assert.deepEqual(stored.map((r) => r.status).sort(), ['queued', 'running']);
      assert.equal(stored.find((r) => r.status === 'running')?.attempts, 1);
    } finally {
      await a`delete from public.games where id = ${gameId}`;
      await a`update private.settings set value = 'false' where key = 'categorization_enabled'`;
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
    }
  });

  it('an expired lease is reclaimed and the old token heartbeat returns false', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const oldToken = randomUUID();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await insertGame(tx, gameId, null);
        const runId = await insertRun(tx, gameId, sha('c'), {
          status: 'running',
          attempts: 1,
          token: oldToken,
          leaseUntil: new Date(Date.now() - 60_000).toISOString(),
          started: new Date(Date.now() - 120_000).toISOString(),
        });
        const [row] = await claim(tx);
        assert.equal(row?.run_id, runId);
        assert.notEqual(row?.lease_token, oldToken);
        await tx`update private.categorization_runs set lease_until = now() - interval '1 second' where id = ${runId}::bigint`;
        const [expired] = await tx<{ ok: boolean }[]>`select private.cat_heartbeat(${runId}::bigint, ${row.lease_token}::uuid) as ok`;
        assert.equal(expired.ok, false);
        await tx`update private.categorization_runs set lease_until = now() + interval '10 minutes' where id = ${runId}::bigint`;
        const [lost] = await tx<{ ok: boolean }[]>`select private.cat_heartbeat(${runId}::bigint, ${oldToken}::uuid) as ok`;
        assert.equal(lost.ok, false);
        const [held] = await tx<{ ok: boolean }[]>`select private.cat_heartbeat(${runId}::bigint, ${row.lease_token}::uuid) as ok`;
        assert.equal(held.ok, true);
        const [stored] = await tx<{ status: string; attempts: number; lease_token: string; lease_until: Date }[]>`
          select status, attempts, lease_token::text, lease_until
          from private.categorization_runs where id = ${runId}::bigint
        `;
        assert.equal(stored.status, 'running');
        assert.equal(stored.attempts, 2);
        assert.equal(stored.lease_token, row.lease_token);
        assert.ok(stored.lease_until.getTime() > Date.now());
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('claims nothing when categorization is not enabled', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, false);
        await insertGame(tx, gameId, null);
        await insertRun(tx, gameId, sha('d'));
        assert.deepEqual(await claim(tx), []);
        const [row] = await tx<{ status: string; attempts: number }[]>`
          select status, attempts from private.categorization_runs where game_id = ${gameId}
        `;
        assert.deepEqual({ ...row }, { status: 'queued', attempts: 0 });
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('claims nothing when the daily cap is already reached', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await setCap(tx, 1);
        await insertGame(tx, gameId, null);
        await insertRun(tx, gameId, sha('e'), {
          status: 'succeeded',
          attempts: 1,
          started: new Date().toISOString(),
        });
        await insertRun(tx, gameId, sha('f'));
        assert.deepEqual(await claim(tx), []);
        const [waiting] = await tx<{ status: string; attempts: number }[]>`
          select status, attempts from private.categorization_runs where game_id = ${gameId} and bundle_sha256 = ${sha('f')}
        `;
        assert.deepEqual({ ...waiting }, { status: 'queued', attempts: 0 });
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('context has no owner id or email', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const ownerId = randomUUID();
    const handle = `h${gameId.slice(-8)}`;
    const email = `owner-${gameId}@example.test`;
    try {
      await rollback(sql, async (tx) => {
        await tx`
          insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
          values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${email}, '', now(), now())
        `;
        await tx`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${handle})`;
        await enable(tx, true);
        await insertGame(tx, gameId, ownerId, {
          title: 'Dock',
          tagline: 'A pier',
          description: 'Boats',
          tags: ['water'],
          creator: 'skipper',
        });
        await tx`
          insert into public.game_assets (game_id, version, path, expected_type, status, size_bytes, content_sha256)
          values
            (${gameId}, 1, 'boat.png', 'image', 'uploaded', 12, ${sha('1')}),
            (${gameId}, 1, 'missing.png', 'image', 'missing', null, null),
            (${gameId}, 2, 'other.png', 'image', 'uploaded', 9, ${sha('2')})
        `;
        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status, screenshot_paths)
          values (${gameId}, 1, ${sha('9')}, 'passed', ${['shots/1.png', 'shots/2.png']})
        `;
        const runId = await insertRun(tx, gameId, sha('9'), {
          status: 'running',
          attempts: 1,
          token: randomUUID(),
          leaseUntil: new Date(Date.now() + 600_000).toISOString(),
        });
        const [held] = await tx<{ lease_token: string }[]>`select lease_token::text from private.categorization_runs where id = ${runId}::bigint`;
        const [ctx] = await tx<{ context: postgres.JSONValue }[]>`
          select private.cat_get_context(${runId}::bigint, ${held.lease_token}::uuid) as context
        `;
        const body = JSON.stringify(ctx.context);
        assert.equal(body.includes(ownerId), false);
        assert.equal(body.includes(email), false);
        const keys = new Set<string>();
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
          }
          if (value !== null && typeof value === 'object') {
            for (const [key, child] of Object.entries(value)) {
              keys.add(key);
              walk(child);
            }
          }
        };
        walk(ctx.context);
        for (const forbidden of ['owner_id', 'owner', 'email', 'handle', 'user_id']) assert.equal(keys.has(forbidden), false, forbidden);
        assert.deepEqual([...keys].sort(), [
          'asset_manifest',
          'categories',
          'confirm_threshold',
          'content_sha256',
          'creator_tags',
          'definition',
          'description',
          'expected_type',
          'kind',
          'path',
          'reject_threshold',
          'screenshot_paths_count',
          'size_bytes',
          'slug',
          'status',
          'tagline',
          'title',
        ]);
        const context = ctx.context as {
          title: string;
          tagline: string;
          description: string;
          creator_tags: string[];
          asset_manifest: { path: string; status: string }[];
          screenshot_paths_count: number;
          categories: { slug: string; definition: string }[];
        };
        assert.equal(context.title, 'Dock');
        assert.equal(context.tagline, 'A pier');
        assert.equal(context.description, 'Boats');
        assert.deepEqual(context.creator_tags, ['water']);
        assert.deepEqual(context.asset_manifest.map((a) => a.path), ['boat.png']);
        assert.equal(context.screenshot_paths_count, 2);
        assert.deepEqual(
          context.categories.map((c) => c.slug),
          ['kid_safe', 'nsfw'],
        );
        assert.deepEqual(
          context.categories.map((c) => c.definition),
          [
            'suitable for ages 7+, with no realistic violence, gore, sexual content, gambling or profanity, and no open chat with strangers',
            'sexual content or nudity, graphic gore, or strong sexual themes',
          ],
        );
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('an open breaker blocks claims, including from a new connection, until open_until passes', async (t) => {
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
        await insertGame(tx, gameId, null);
        await insertRun(tx, gameId, sha('7'));
        await tx`
          insert into private.categorization_breaker (provider, consecutive_failures, open_until)
          values ('openrouter', 5, now() + interval '15 minutes')
          on conflict (provider) do update
            set consecutive_failures = 5, open_until = now() + interval '15 minutes'
        `;
      });
      assert.deepEqual(await claim(sql), []);
      assert.deepEqual(await claim(fresh), []);
      await sql`
        update private.categorization_breaker
        set open_until = now() - interval '1 second'
        where provider = 'openrouter'
      `;
      const [row] = await claim(fresh);
      assert.ok(row, 'claims resume after open_until');
      assert.equal(row.game_id, gameId);
    } finally {
      await sql`delete from public.games where id = ${gameId}`;
      await sql`delete from private.categorization_breaker where provider = 'openrouter'`;
      await sql`update private.settings set value = 'false' where key = 'categorization_enabled'`;
      await sql.end({ timeout: 1 });
      await fresh.end({ timeout: 1 });
    }
  });

  it('a live lease is not stolen and a mismatched heartbeat returns false', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = gid();
    const token = randomUUID();
    try {
      await rollback(sql, async (tx) => {
        await enable(tx, true);
        await insertGame(tx, gameId, null);
        const runId = await insertRun(tx, gameId, sha('8'), {
          status: 'running',
          attempts: 1,
          token,
          leaseUntil: new Date(Date.now() + 600_000).toISOString(),
        });
        assert.deepEqual(await claim(tx), []);
        const [bad] = await tx<{ ok: boolean }[]>`select private.cat_heartbeat(${runId}::bigint, ${randomUUID()}::uuid) as ok`;
        assert.equal(bad.ok, false);
        const [still] = await tx<{ lease_token: string }[]>`select lease_token::text from private.categorization_runs where id = ${runId}::bigint`;
        assert.equal(still.lease_token, token);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('private queue tables have row level security, no client policies, and no client grants', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const flags = await sql<{ relname: string; relrowsecurity: boolean }[]>`
        select c.relname, c.relrowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private'
          and c.relname in ('categorization_runs', 'categorization_shadow_results', 'categorization_breaker')
        order by c.relname
      `;
      assert.deepEqual(
        flags.map((r) => ({ ...r })),
        [
          { relname: 'categorization_breaker', relrowsecurity: true },
          { relname: 'categorization_runs', relrowsecurity: true },
          { relname: 'categorization_shadow_results', relrowsecurity: true },
        ],
      );
      const policies = await sql<{ n: number }[]>`
        select count(*)::int as n
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private'
          and c.relname in ('categorization_runs', 'categorization_shadow_results', 'categorization_breaker')
      `;
      assert.equal(policies[0].n, 0);
      await rollback(sql, async (tx) => {
        await tx.unsafe('set local role anon');
        for (const stmt of [
          'select * from private.categorization_runs',
          'select * from private.categorization_shadow_results',
          'select * from private.categorization_breaker',
          'select * from private.cat_claim_run(600)',
        ]) {
          await assert.rejects(tx.savepoint((sp) => sp.unsafe(stmt)), refused('42501'), stmt);
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
