import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// MGA-7a: meshgrounds_admin must not reach schema net / net.http_request_queue.
// Its only access is the PUBLIC grant supabase_admin makes when it creates
// pg_net; migrations run as postgres and cannot revoke it. These tests prove
// both sides: as postgres the migration changes no grant and keeps the role
// NOLOGIN; as supabase_admin (how hosted support applies it) every privilege
// is gone and validate-game dispatch still queues.

const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const migrationFile = '20261019170000_admin_revoke_net_queue.sql';
const migrationSql = readFileSync(join(migrations, migrationFile), 'utf8');
const checkSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ops', 'check_pg_net_privileges.sql'), 'utf8');

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const proofUrl = 'http://127.0.0.1:54321/functions/v1/validate-game';
const proofSecret = 'mga7a-proof-hook-secret';

type Sql = postgres.Sql | postgres.TransactionSql;

async function connect(t: { skip: (message?: string) => void }): Promise<postgres.Sql | undefined> {
  const sql = postgres(dbUrl, { connect_timeout: 3, max: 1, idle_timeout: 1, onnotice: () => {} });
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

function withRole(appUrl: string, username: string): postgres.Sql {
  const url = new URL(appUrl);
  url.username = username;
  return postgres(url.toString(), { connect_timeout: 3, max: 1, idle_timeout: 1, onnotice: () => {} });
}

type AdminNet = { usage: boolean; select: boolean; insert: boolean; update: boolean; delete: boolean };

async function adminNet(tx: Sql): Promise<AdminNet> {
  const [row] = await tx<AdminNet[]>`
    select
      has_schema_privilege('meshgrounds_admin', 'net', 'USAGE') as usage,
      has_table_privilege('meshgrounds_admin', 'net.http_request_queue', 'SELECT') as select,
      has_table_privilege('meshgrounds_admin', 'net.http_request_queue', 'INSERT') as insert,
      has_table_privilege('meshgrounds_admin', 'net.http_request_queue', 'UPDATE') as update,
      has_table_privilege('meshgrounds_admin', 'net.http_request_queue', 'DELETE') as delete
  `;
  return row;
}

const allFalse: AdminNet = { usage: false, select: false, insert: false, update: false, delete: false };

async function canLogin(tx: Sql): Promise<boolean> {
  const [row] = await tx<{ rolcanlogin: boolean }[]>`
    select rolcanlogin from pg_roles where rolname = 'meshgrounds_admin'
  `;
  assert.ok(row, 'meshgrounds_admin exists');
  return row.rolcanlogin;
}

async function sqlState(tx: postgres.TransactionSql, query: string): Promise<string | null> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(query);
    });
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('MGA-7a migration text', () => {
  it('sorts after the admin role migration and is the newest file', () => {
    const files = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrationFile > '20261019120000_admin_role.sql');
    assert.equal(files.at(-1), migrationFile);
    assert.equal(files.filter((name) => name.startsWith('20261019170000')).length, 1, 'no version collision');
  });

  it('revokes from PUBLIC only USAGE on schema net and ALL on the queue, never touches the extension or sets LOGIN', () => {
    const code = migrationSql.replace(/--.*$/gm, '');
    assert.match(code, /revoke all on table net\.http_request_queue from public, meshgrounds_admin;/);
    assert.match(code, /revoke usage on schema net from public, meshgrounds_admin;/);
    assert.equal((code.match(/from public/g) ?? []).length, 2, 'exactly two PUBLIC revokes');
    assert.match(code, /grant usage on schema net to postgres, service_role;/);
    assert.match(code, /grant select on table net\.http_request_queue to postgres, service_role;/);
    assert.match(code, /alter role meshgrounds_admin nologin;/);
    assert.doesNotMatch(code, /\bextension\b/i);
    assert.doesNotMatch(code, /\blogin\s+password\b|\bpassword\s+'/i);
    assert.doesNotMatch(code, /\bset\s+role\b/i);
  });
});

describe('meshgrounds_admin has no pg_net access', { concurrency: false }, () => {
  it('as postgres: re-applying is a no-op on grants and the role stays NOLOGIN while net is reachable', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const before = await adminNet(sql);
      // Migrations ran as postgres. Either PUBLIC still holds net (fresh stack:
      // fail closed, NOLOGIN) or supabase_admin already locked it down (all false).
      const open = Object.values(before).some(Boolean);
      if (open) assert.equal(await canLogin(sql), false, 'NOLOGIN while net is reachable');
      else assert.deepEqual(before, allFalse);

      await rollback(sql, async (tx) => {
        await tx.unsafe(migrationSql);
        await tx.unsafe(migrationSql);
        assert.deepEqual(await adminNet(tx), before, 'postgres cannot move the PUBLIC grants');
        if (open) assert.equal(await canLogin(tx), false);
      });

      // Out-of-order guard: if LOGIN was already enabled, the migration takes it away.
      if (open) {
        await rollback(sql, async (tx) => {
          await tx.unsafe('alter role meshgrounds_admin login');
          await tx.unsafe(migrationSql);
          assert.equal(await canLogin(tx), false, 'migration forces NOLOGIN while net is reachable');
        });
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('as supabase_admin: no USAGE on net, no SELECT/INSERT/UPDATE/DELETE on the queue, and validate-game still queues', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    await sql.end({ timeout: 1 });
    const admin = withRole(dbUrl, 'supabase_admin');
    try {
      try {
        await admin`select 1`;
      } catch {
        throw new Error('local supabase_admin login failed; cannot prove the PUBLIC revoke');
      }
      await rollback(admin, async (tx) => {
        await tx.unsafe(migrationSql);
        await tx.unsafe(migrationSql); // idempotent

        assert.deepEqual(await adminNet(tx), allFalse);
        const [pub] = await tx<{ usage: boolean; select: boolean; insert: boolean }[]>`
          select
            has_schema_privilege('public', 'net', 'USAGE') as usage,
            has_table_privilege('public', 'net.http_request_queue', 'SELECT') as select,
            has_table_privilege('public', 'net.http_request_queue', 'INSERT') as insert
        `;
        assert.deepEqual(pub, { usage: false, select: false, insert: false });

        // Real access, not only the catalog: as meshgrounds_admin every net object is refused.
        await tx.unsafe('set local role meshgrounds_admin');
        for (const query of [
          'select 1 from net.http_request_queue limit 1',
          `insert into net.http_request_queue (method, url, headers, timeout_milliseconds) values ('GET', 'http://127.0.0.1:9/', '{}'::jsonb, 1000)`,
          'delete from net.http_request_queue',
          'select 1 from net._http_response limit 1',
          `select net.http_get('http://127.0.0.1:9/')`,
          'select net.check_worker_is_up()',
        ]) {
          assert.equal(await sqlState(tx, query), '42501', query);
        }
        await tx.unsafe('reset role');

        // The keep set is untouched: postgres and service_role pass in the ops report.
        const report = await tx.unsafe<{ role_name: string; privilege: string; object_name: string; status: string }[]>(checkSql);
        const keep = report.filter((row) => row.role_name === 'postgres' || row.role_name === 'service_role');
        assert.ok(keep.length >= 6, JSON.stringify(report));
        assert.deepEqual(keep.filter((row) => row.status !== 'PASS'), []);

        // The validate-game hook still dispatches as postgres (trigger path).
        await tx.unsafe('set local role postgres');
        await tx`
          insert into private.settings (key, value) values ('validate_game_url', ${proofUrl})
          on conflict (key) do update set value = excluded.value
        `;
        await tx`delete from vault.secrets where name = 'validate_game_hook_secret'`;
        await tx`select vault.create_secret(${proofSecret}, 'validate_game_hook_secret', 'MGA-7a test only')`;
        const id = `mga7a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await tx`
          insert into public.games (id, slug, creator, title, stage)
          values (${id}, ${id}, 'stub', 'After MGA-7a', 'pending')
        `;
        const [req] = await tx<{ body: string }[]>`
          select convert_from(body, 'UTF8') as body
          from net.http_request_queue
          where position(${id} in convert_from(body, 'UTF8')) > 0
          order by id desc
          limit 1
        `;
        assert.ok(req, 'dispatch still queues after the PUBLIC revoke');
        assert.deepEqual(JSON.parse(req.body), { gameId: id, reason: 'stage_pending' });
        await tx`select private.sweep_stuck_pending_games()`;
      });
    } finally {
      await admin.end({ timeout: 1 });
    }
  });
});
