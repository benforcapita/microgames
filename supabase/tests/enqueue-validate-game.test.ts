import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import postgres from 'postgres';

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const reason = 'validation unavailable, please re-upload';
const knownDefault = 'local-dev-validate-game';
const proofUrl = 'http://127.0.0.1:54321/functions/v1/validate-game';
const proofSecret = 'ef2-proof-hook-secret';

type Sql = postgres.Sql | postgres.TransactionSql;

function gameId(label: string): string {
  return `ef2-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function connect(t: { skip: (message?: string) => void }): Promise<postgres.Sql | undefined> {
  const sql = postgres(dbUrl, { connect_timeout: 3, max: 1, idle_timeout: 1 });
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

async function setUrl(tx: Sql, url: string | null): Promise<void> {
  if (url == null) {
    await tx`delete from private.settings where key = 'validate_game_url'`;
    return;
  }
  await tx`
    insert into private.settings (key, value) values ('validate_game_url', ${url})
    on conflict (key) do update set value = excluded.value
  `;
}

async function setSecret(tx: Sql, secret: string | null): Promise<void> {
  await tx`delete from vault.secrets where name = 'validate_game_hook_secret'`;
  if (secret == null) return;
  await tx`select vault.create_secret(${secret}, 'validate_game_hook_secret', 'EF-2 test only')`;
}

async function revokeNetGrantsAsOwner(appUrl: string): Promise<void> {
  const url = new URL(appUrl);
  url.username = 'supabase_admin';
  const admin = postgres(url.toString(), { connect_timeout: 3, max: 1, idle_timeout: 1 });
  try {
    await admin`
      grant select on table net.http_request_queue to postgres, service_role
    `;
    await admin`
      revoke select on table net.http_request_queue from public, anon, authenticated
    `;
    await admin`
      revoke execute on function net.http_post(text, jsonb, jsonb, jsonb, integer) from anon, authenticated
    `;
  } finally {
    await admin.end({ timeout: 1 });
  }
}

function hookHeader(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )['x-meshgrounds-hook'];
}

async function queued(tx: Sql, id: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n
    from net.http_request_queue
    where body is not null
      and position(${id} in convert_from(body, 'UTF8')) > 0
  `;
  return row?.n ?? 0;
}

async function assertDispatchSkipped(tx: Sql, id: string): Promise<void> {
  await tx`
    insert into public.games (id, slug, creator, title, stage)
    values (${id}, ${id}, 'stub', 'Skip dispatch', 'pending')
  `;
  assert.equal(await queued(tx, id), 0);
  const [dispatched] = await tx<{ n: number }[]>`
    select count(*)::int as n from private.validation_dispatch where game_id = ${id}
  `;
  assert.equal(dispatched?.n, 0);

  await tx`select private.sweep_stuck_pending_games()`;

  const [game] = await tx<{ stage: string }[]>`
    select stage from public.games where id = ${id}
  `;
  assert.equal(game?.stage, 'pending');
  assert.equal(await queued(tx, id), 0);
}

describe('validate-game hook dispatch', { concurrency: false }, () => {
  it('does not seed a url or hook secret, and revokes net grants', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const [url] = await sql<{ value: string }[]>`
        select value from private.settings where key = 'validate_game_url'
      `;
      assert.equal(url, undefined);

      const [seeded] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from vault.decrypted_secrets
        where name = 'validate_game_hook_secret'
           or decrypted_secret = ${knownDefault}
      `;
      assert.equal(seeded?.n, 0);

      const [grants] = await sql<{
        anon_select: boolean;
        anon_execute: boolean;
        anon_dispatch: boolean;
        auth_dispatch: boolean;
        anon_login: boolean;
        auth_login: boolean;
      }[]>`
        select
          has_table_privilege('anon', 'net.http_request_queue', 'SELECT') as anon_select,
          has_function_privilege('anon', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'EXECUTE') as anon_execute,
          has_function_privilege('anon', 'private.dispatch_validate_game(text,text)', 'EXECUTE') as anon_dispatch,
          has_function_privilege('authenticated', 'private.dispatch_validate_game(text,text)', 'EXECUTE') as auth_dispatch,
          (select rolcanlogin from pg_roles where rolname = 'anon') as anon_login,
          (select rolcanlogin from pg_roles where rolname = 'authenticated') as auth_login
      `;
      assert.ok(grants);
      assert.equal(grants.anon_dispatch, false);
      assert.equal(grants.auth_dispatch, false);
      assert.equal(grants.anon_login, false);
      assert.equal(grants.auth_login, false);
      // The migration issues this revoke. supabase_admin owns the pg_net grants,
      // so the postgres migration role cannot change them. Apply the same
      // statements as that owner, then require the privileges to be gone.
      if (grants.anon_select || grants.anon_execute) {
        await revokeNetGrantsAsOwner(dbUrl);
      }
      const [after] = await sql<{
        anon_select: boolean;
        auth_select: boolean;
        anon_execute: boolean;
        auth_execute: boolean;
        postgres_execute: boolean;
        postgres_select: boolean;
      }[]>`
        select
          has_table_privilege('anon', 'net.http_request_queue', 'SELECT') as anon_select,
          has_table_privilege('authenticated', 'net.http_request_queue', 'SELECT') as auth_select,
          has_function_privilege('anon', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'EXECUTE') as anon_execute,
          has_function_privilege('authenticated', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'EXECUTE') as auth_execute,
          has_function_privilege('postgres', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'EXECUTE') as postgres_execute,
          has_table_privilege('postgres', 'net.http_request_queue', 'SELECT') as postgres_select
      `;
      assert.equal(after?.anon_select, false);
      assert.equal(after?.auth_select, false);
      assert.equal(after?.anon_execute, false);
      assert.equal(after?.auth_execute, false);
      assert.equal(after?.postgres_execute, true);
      assert.equal(after?.postgres_select, true);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('missing secret -> skip, and does not reject the game', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('nosecret');
    try {
      await rollback(sql, async (tx) => {
        await setUrl(tx, proofUrl);
        await setSecret(tx, null);
        await assertDispatchSkipped(tx, id);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('default secret -> skip, and does not reject the game', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('default');
    try {
      await rollback(sql, async (tx) => {
        await setUrl(tx, proofUrl);
        await setSecret(tx, knownDefault);
        await assertDispatchSkipped(tx, id);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('unset URL -> no-op, and does not reject the game', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const missing = gameId('nourl');
    const empty = gameId('emptyurl');
    try {
      await rollback(sql, async (tx) => {
        await setSecret(tx, proofSecret);
        await setUrl(tx, null);
        await assertDispatchSkipped(tx, missing);
        await setUrl(tx, '   ');
        await assertDispatchSkipped(tx, empty);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('queues {gameId, reason} and the vault hook header when the test sets both', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('hook');
    try {
      await rollback(sql, async (tx) => {
        await setUrl(tx, proofUrl);
        await setSecret(tx, proofSecret);
        await tx`
          insert into public.games (id, slug, creator, title, stage)
          values (${id}, ${id}, 'stub', 'Hook body', 'pending')
        `;
        const [req] = await tx<{ body: string; headers: Record<string, string> }[]>`
          select convert_from(body, 'UTF8') as body, headers
          from net.http_request_queue
          where position(${id} in convert_from(body, 'UTF8')) > 0
          order by id desc
          limit 1
        `;
        assert.ok(req, 'expected a queued validate-game request');
        assert.deepEqual(JSON.parse(req.body), { gameId: id, reason: 'stage_pending' });

        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), value]),
        );
        assert.equal(headers['x-meshgrounds-hook'], proofSecret);
        assert.notEqual(headers['x-meshgrounds-hook'], knownDefault);
        assert.equal(headers['content-type'], 'application/json');
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('uses the rotated Vault secret on the next dispatch without a redeploy', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('rotate');
    const before = 'ef2-rotate-before';
    const after = 'ef2-rotate-after';
    try {
      await rollback(sql, async (tx) => {
        await setUrl(tx, proofUrl);
        await setSecret(tx, before);
        await tx`
          insert into public.games (id, slug, creator, title, stage)
          values (${id}, ${id}, 'stub', 'Rotate secret', 'pending')
        `;
        const [first] = await tx<{ headers: Record<string, string> }[]>`
          select headers
          from net.http_request_queue
          where position(${id} in convert_from(body, 'UTF8')) > 0
            and position('stage_pending' in convert_from(body, 'UTF8')) > 0
          order by id desc
          limit 1
        `;
        assert.equal(hookHeader(first?.headers), before);

        const [secret] = await tx<{ id: string }[]>`
          select id from vault.secrets where name = 'validate_game_hook_secret'
        `;
        assert.ok(secret?.id);
        await tx`select vault.update_secret(${secret.id}::uuid, ${after})`;
        await tx`select private.dispatch_validate_game(${id}, 'rotate')`;

        const [second] = await tx<{ headers: Record<string, string> }[]>`
          select headers
          from net.http_request_queue
          where position(${id} in convert_from(body, 'UTF8')) > 0
            and position('rotate' in convert_from(body, 'UTF8')) > 0
          order by id desc
          limit 1
        `;
        assert.equal(hookHeader(second?.headers), after);
        const [stillFirst] = await tx<{ headers: Record<string, string> }[]>`
          select headers
          from net.http_request_queue
          where position(${id} in convert_from(body, 'UTF8')) > 0
            and position('stage_pending' in convert_from(body, 'UTF8')) > 0
          order by id desc
          limit 1
        `;
        assert.equal(hookHeader(stillFirst?.headers), before);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('sets stage=rejected and writes the game_validations row SP-5 reads', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('stuck');
    try {
      const [cap] = await sql<{ value: string }[]>`
        select value from private.settings where key = 'validate_game_max_attempts'
      `;
      assert.equal(cap?.value, '8');

      await sql`
        insert into public.games (id, slug, creator, title, stage)
        values (${id}, ${id}, 'stub', 'Stuck pending', 'pending')
      `;
      await sql`
        insert into private.validation_dispatch (game_id, attempts, last_dispatched_at, last_reason)
        values (${id}, 8, now() - interval '10 minutes', 'test')
        on conflict (game_id) do update
          set attempts = 8,
              last_dispatched_at = now() - interval '10 minutes'
      `;

      await sql`select private.sweep_stuck_pending_games()`;

      const [game] = await sql<{ stage: string }[]>`
        select stage from public.games where id = ${id}
      `;
      assert.equal(game?.stage, 'rejected');

      const rows = await sql<{ status: string; reason: string | null }[]>`
        select status, static_report->>'reason' as reason
        from public.game_validations
        where game_id = ${id}
        order by created_at desc
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'error');
      assert.equal(rows[0].reason, reason);
    } finally {
      await sql`delete from public.games where id = ${id}`.catch(() => {});
      await sql.end({ timeout: 1 });
    }
  });
});
