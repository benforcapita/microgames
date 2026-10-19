import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
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
const opsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ops');
const checkSql = readFileSync(join(opsDir, 'check_pg_net_privileges.sql'), 'utf8');
const lockdownSql = readFileSync(join(opsDir, 'pg_net_lockdown.sql'), 'utf8');

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

type HeldNetPrivilege = { role: string; object: string; privilege: string };

// Every privilege in schema net that any of roles holds, enumerated from the
// catalog: USAGE/CREATE on the schema, every applicable privilege on every
// table and every sequence, and EXECUTE on every function. 'public' is the
// PUBLIC pseudo-role to has_*_privilege.
async function netPrivilegesHeld(tx: Sql, roles: readonly string[]): Promise<HeldNetPrivilege[]> {
  return tx<HeldNetPrivilege[]>`
    with checks as (
      select r.role, 'schema net' as object, p.priv as privilege,
             has_schema_privilege(r.role, 'net', p.priv) as held
        from unnest(${roles}::text[]) as r(role)
        cross join (values ('USAGE'), ('CREATE')) as p(priv)
      union all
      select r.role, 'net.' || c.relname, p.priv, has_table_privilege(r.role, c.oid, p.priv)
        from unnest(${roles}::text[]) as r(role)
        cross join pg_class c
        cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) as p(priv)
        where c.relnamespace = 'net'::regnamespace and c.relkind <> 'S'
      union all
      select r.role, 'net.' || c.relname, p.priv, has_sequence_privilege(r.role, c.oid, p.priv)
        from unnest(${roles}::text[]) as r(role)
        cross join pg_class c
        cross join (values ('SELECT'), ('UPDATE'), ('USAGE')) as p(priv)
        where c.relnamespace = 'net'::regnamespace and c.relkind = 'S'
      union all
      select r.role, p.oid::regprocedure::text, 'EXECUTE', has_function_privilege(r.role, p.oid, 'EXECUTE')
        from unnest(${roles}::text[]) as r(role)
        cross join pg_proc p
        where p.pronamespace = 'net'::regnamespace
    )
    select role, object, privilege from checks where held order by 1, 2, 3
  `;
}

const closedNetRoles: readonly string[] = ['meshgrounds_admin', 'public', 'anon', 'authenticated'];

// Real-access probes every closed role must fail with 42501: read the queue,
// enqueue into it, and call http_post.
const netDeniedProbes: readonly string[] = [
  'select 1 from net.http_request_queue limit 1',
  `insert into net.http_request_queue (method, url, headers, timeout_milliseconds) values ('GET', 'http://127.0.0.1:9/', '{}'::jsonb, 1000)`,
  `select net.http_post('http://127.0.0.1:9/', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1000)`,
];

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
  await tx`select vault.create_secret(${secret}, 'validate_game_hook_secret', 'MGA-7a test only')`;
}

describe('MGA-7a migration text', () => {
  it('sorts after the admin role migration with no version collision', () => {
    const files = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrationFile > '20261019120000_admin_role.sql');
    assert.equal(files.filter((name) => name.startsWith('20261019170000')).length, 1, 'no version collision');
  });

  it('keeps the worker and dispatch grants, revokes every net privilege from public, anon, authenticated and meshgrounds_admin', () => {
    const code = migrationSql.replace(/--.*$/gm, '');
    // Keep set measured against the real worker: pg_net.username, with
    // postgres as fallback — the worker is not supabase_admin.
    assert.match(code, /current_setting\('pg_net\.username', true\)/);
    assert.match(code, /grant usage on schema net to postgres, service_role;/);
    assert.match(code, /grant select on table net\.http_request_queue to postgres, service_role;/);
    assert.match(code, /format\('grant select, delete on table net\.http_request_queue to %I', worker_role\)/);
    assert.match(code, /format\('grant select, insert, delete on table net\._http_response to %I', worker_role\)/);
    assert.match(code, /format\('grant execute on function %s to postgres, service_role', fn\)/);
    // Uniform lockdown: the same end state as supabase/ops/pg_net_lockdown.sql.
    assert.match(code, /revoke usage on schema net from public, anon, authenticated;/);
    assert.match(code, /revoke all on all tables in schema net from public, anon, authenticated;/);
    assert.match(code, /revoke all on all sequences in schema net from public, anon, authenticated;/);
    assert.match(code, /format\('revoke execute on function %s from public, anon, authenticated', fn\)/);
    assert.match(code, /revoke all on all tables in schema net from meshgrounds_admin;/);
    assert.match(code, /revoke all on all sequences in schema net from meshgrounds_admin;/);
    assert.match(code, /revoke all on all functions in schema net from meshgrounds_admin;/);
    assert.match(code, /revoke usage on schema net from meshgrounds_admin;/);
    // Fail closed, and the warning names the real path, not only PUBLIC.
    assert.match(code, /alter role meshgrounds_admin nologin;/);
    assert.match(code, /through PUBLIC or a direct grant/);
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
        // Catalog-wide: every object in schema net, every applicable
        // privilege — meshgrounds_admin, PUBLIC, anon and authenticated hold
        // none of them.
        const reachable = await netPrivilegesHeld(tx, closedNetRoles);
        assert.equal(reachable.length, 0, `closed roles still hold: ${JSON.stringify([...reachable])}`);
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
        // anon is refused the same way: the queue and http_post.
        await tx.unsafe('set local role anon');
        for (const query of netDeniedProbes) {
          assert.equal(await sqlState(tx, query), '42501', `anon: ${query}`);
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

  it('as supabase_admin: ops pg_net_lockdown.sql leaves meshgrounds_admin, PUBLIC, anon and authenticated with zero net privileges', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    await sql.end({ timeout: 1 });
    const admin = withRole(dbUrl, 'supabase_admin');
    try {
      try {
        await admin`select 1`;
      } catch {
        throw new Error('local supabase_admin login failed; cannot prove the ops lockdown');
      }
      await rollback(admin, async (tx) => {
        await tx.unsafe(lockdownSql);
        await tx.unsafe(lockdownSql); // idempotent

        // Catalog-wide: every closed role holds nothing in schema net.
        const closed = await netPrivilegesHeld(tx, closedNetRoles);
        assert.equal(closed.length, 0, `closed roles still hold: ${JSON.stringify(closed)}`);

        // Paired allowed case: the sweep can see held privileges — postgres
        // and service_role keep USAGE on schema net and EXECUTE on http_post.
        const kept = await netPrivilegesHeld(tx, ['postgres', 'service_role']);
        for (const role of ['postgres', 'service_role']) {
          assert.ok(
            kept.some((row) => row.role === role && row.object === 'schema net' && row.privilege === 'USAGE'),
            `${role} lost USAGE on schema net`,
          );
          assert.ok(
            kept.some((row) => row.role === role && row.object.startsWith('net.http_post(') && row.privilege === 'EXECUTE'),
            `${role} lost EXECUTE on net.http_post`,
          );
        }

        // Real access, not only the catalog: the queue and http_post are refused.
        for (const role of ['meshgrounds_admin', 'anon']) {
          await tx.unsafe(`set local role ${role}`);
          for (const query of netDeniedProbes) {
            assert.equal(await sqlState(tx, query), '42501', `${role}: ${query}`);
          }
          await tx.unsafe('reset role');
        }
      });
    } finally {
      await admin.end({ timeout: 1 });
    }
  });
});

// --- Committed-state snapshot/restore ---------------------------------------
// The worker drain tests below apply each file for real: the pg_net worker
// only sees committed rows, so a rolled-back apply would prove nothing. Every
// grant, rolcanlogin, and row the test creates is put back afterwards, and a
// snapshot diff proves it.

type AclEntry = {
  kind: string;
  object: string;
  grantee: string;
  grantor: string;
  privilege: string;
  grantable: boolean;
};

type NetObject = { kind: string; object: string; owner: string };
type NetSnapshot = { objects: NetObject[]; acls: AclEntry[]; canLogin: boolean };

async function netObjects(sql: Sql): Promise<NetObject[]> {
  return sql<NetObject[]>`
    select k as kind, obj as object, owner from (
      select 'schema'::text as k, 'net'::text as obj, n.nspowner::regrole::text as owner
        from pg_namespace n where n.nspname = 'net'
      union all
      select case when c.relkind = 'S' then 'sequence' else 'table' end,
             'net.' || c.relname, c.relowner::regrole::text
        from pg_class c
        where c.relnamespace = 'net'::regnamespace and c.relkind in ('r', 'S')
      union all
      select 'function', p.oid::regprocedure::text, p.proowner::regrole::text
        from pg_proc p where p.pronamespace = 'net'::regnamespace
    ) o order by 1, 2
  `;
}

async function netAcls(sql: Sql): Promise<AclEntry[]> {
  return sql<AclEntry[]>`
    select k as kind, obj as object, grantee, grantor, priv as privilege, grantable from (
      select 'schema'::text as k, 'net'::text as obj,
             case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as grantee,
             a.grantor::regrole::text as grantor, a.privilege_type::text as priv, a.is_grantable as grantable
        from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'net'
      union all
      select case when c.relkind = 'S' then 'sequence' else 'table' end, 'net.' || c.relname,
             case when a.grantee = 0 then 'public' else a.grantee::regrole::text end,
             a.grantor::regrole::text, a.privilege_type::text, a.is_grantable
        from pg_class c, aclexplode(c.relacl) a
        where c.relnamespace = 'net'::regnamespace and c.relkind in ('r', 'S')
      union all
      select 'function', p.oid::regprocedure::text,
             case when a.grantee = 0 then 'public' else a.grantee::regrole::text end,
             a.grantor::regrole::text, a.privilege_type::text, a.is_grantable
        from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.pronamespace = 'net'::regnamespace
    ) a order by 1, 2, 3, 4, 5
  `;
}

async function netSnapshot(sql: Sql): Promise<NetSnapshot> {
  const [login] = await sql<{ rolcanlogin: boolean }[]>`
    select rolcanlogin from pg_roles where rolname = 'meshgrounds_admin'
  `;
  return { objects: await netObjects(sql), acls: await netAcls(sql), canLogin: login?.rolcanlogin ?? false };
}

function netObjectRef(entry: { kind: string; object: string }): string {
  if (entry.kind === 'schema') return `schema ${entry.object}`;
  if (entry.kind === 'function') return `function ${entry.object}`;
  return `${entry.kind} ${entry.object}`;
}

function roleName(name: string): string {
  return name === 'public' ? 'public' : `"${name.replace(/"/g, '""')}"`;
}

// Replays the snapshot exactly: wipe every current grant on each net object
// (except the object's owner, whose entries our files never touch), then
// re-grant every entry the snapshot recorded. Ran as supabase_admin so the
// grantor column matches too. One transaction, so concurrent suites never
// observe the half-restored state.
async function restoreNet(tx: Sql, snap: NetSnapshot): Promise<void> {
  const owners = new Map(snap.objects.map((o) => [`${o.kind} ${o.object}`, o.owner]));
  const touched = new Map<string, NetObject>();
  for (const o of snap.objects) touched.set(`${o.kind} ${o.object}`, o);
  for (const row of snap.acls) {
    if (!touched.has(`${row.kind} ${row.object}`)) touched.set(`${row.kind} ${row.object}`, { kind: row.kind, object: row.object, owner: '' });
  }
  const grantees = new Set(['anon', 'authenticated', 'postgres', 'public', 'service_role', 'supabase_functions_admin', 'meshgrounds_admin']);
  for (const row of snap.acls) grantees.add(row.grantee);
  for (const row of await netAcls(tx)) {
    grantees.add(row.grantee);
    if (!touched.has(`${row.kind} ${row.object}`)) touched.set(`${row.kind} ${row.object}`, { kind: row.kind, object: row.object, owner: '' });
  }
  for (const obj of touched.values()) {
    const owner = obj.owner || owners.get(`${obj.kind} ${obj.object}`);
    for (const grantee of grantees) {
      if (grantee === owner) continue;
      await tx.unsafe(`revoke all on ${netObjectRef(obj)} from ${roleName(grantee)}`);
    }
  }
  for (const row of snap.acls) {
    await tx.unsafe(`grant ${row.privilege} on ${netObjectRef(row)} to ${roleName(row.grantee)}${row.grantable ? ' with grant option' : ''}`);
  }
  await tx.unsafe(`alter role meshgrounds_admin ${snap.canLogin ? 'login' : 'nologin'}`);
}

const drainUrl = 'http://127.0.0.1:9/mga7a-drain'; // closed local port: no external calls, worker still writes an error response
const drainDeadlineMs = 20_000;

async function waitForDrain(sql: postgres.Sql, requestId: number): Promise<boolean> {
  const deadline = Date.now() + drainDeadlineMs;
  while (Date.now() < deadline) {
    const [row] = await sql<{ queued: number; responded: number }[]>`
      select
        (select count(*)::int from net.http_request_queue where id = ${requestId}) as queued,
        (select count(*)::int from net._http_response where id = ${requestId}) as responded
    `;
    if (row && (row.queued === 0 || row.responded > 0)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

describe('pg_net worker drains a real validate-game dispatch after the lockdown', { concurrency: false }, () => {
  const files: Array<[string, string, string]> = [
    ['migration', migrationFile, migrationSql],
    ['lockdown', 'supabase/ops/pg_net_lockdown.sql', lockdownSql],
  ];
  let suiteBaseline: NetSnapshot | undefined;

  after(async () => {
    if (!suiteBaseline) return;
    const admin = withRole(dbUrl, 'supabase_admin');
    try {
      assert.deepEqual(await netSnapshot(admin), suiteBaseline, 'committed net grants differ from suite baseline');
    } finally {
      await admin.end({ timeout: 1 });
    }
  });

  for (const [tag, name, fileSql] of files) {
    it(`${name} applied as supabase_admin (committed): request is drained and worker stays up`, async (t) => {
      const sql = await connect(t);
      if (!sql) return;
      const admin = withRole(dbUrl, 'supabase_admin');
      try {
        await admin`select 1`;
        const before = await netSnapshot(admin);
        suiteBaseline ??= before;
        let requestId: number | undefined;
        const id = `mga7a-drain-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          await admin.unsafe(fileSql); // committed: the worker only sees committed state

          // Fire the real hook as postgres in one committed transaction. The
          // dispatch trigger reads the url and the vault secret inside this
          // same tx, so they never become visible to other suites; only the
          // game, its dispatch row and the queue row are left visible.
          await sql.begin(async (tx) => {
            await setUrl(tx, drainUrl);
            await setSecret(tx, `mga7a-drain-${id}`);
            await tx`
              insert into public.games (id, slug, creator, title, stage)
              values (${id}, ${id}, 'stub', 'Drain probe', 'pending')
            `;
            await tx`delete from private.settings where key = 'validate_game_url'`;
            await tx`delete from vault.secrets where name = 'validate_game_hook_secret'`;
          });
          const [dispatch] = await sql<{ last_request_id: number | null }[]>`
            select last_request_id::int as last_request_id from private.validation_dispatch where game_id = ${id}
          `;
          requestId = dispatch?.last_request_id ?? undefined;
          assert.ok(requestId != null, 'dispatch did not queue a pg_net request');

          assert.ok(
            await waitForDrain(sql, requestId),
            `request ${requestId} stayed queued for ${drainDeadlineMs}ms: the pg_net worker could not drain it`,
          );
          await sql`select net.check_worker_is_up() as up`; // raises when the worker is down
          await sql`delete from public.games where id = ${id}`; // cascades validation_dispatch
        } finally {
          await sql`delete from public.games where id like ${`mga7a-drain-${tag}-%`}`.catch(() => {});
          await setUrl(sql, null).catch(() => {});
          await setSecret(sql, null).catch(() => {});
          if (requestId != null) {
            await admin`delete from net._http_response where id = ${requestId}`.catch(() => {});
            await admin`delete from net.http_request_queue where id = ${requestId}`.catch(() => {});
          }
          await admin.begin((tx) => restoreNet(tx, before));
          assert.deepEqual(await netSnapshot(admin), before, 'net grants and rolcanlogin not restored');
        }
      } finally {
        await sql.end({ timeout: 1 });
        await admin.end({ timeout: 1 });
      }
    });
  }
});
