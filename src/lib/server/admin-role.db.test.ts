// MGA-1 / AD-1: the meshgrounds_admin role sees and changes exactly what LLD Rev 2 §8
// grants — the review tables read-only plus the allowlisted games columns — and nothing
// else. Runs as postgres on the local Supabase stack and SET LOCAL ROLEs inside a
// rolled-back transaction; skips when that stack is not running (CI has no database).
// The role is NOLOGIN with no password; tests never connect as it or set a password.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let isLocal = false;
try {
  const parsed = new URL(url);
  isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
} catch {
  isLocal = false;
}

let probeOk = false;
if (isLocal) {
  const probe = postgres(url, { connect_timeout: 3, max: 1 });
  try {
    await probe`select 1`;
    probeOk = true;
  } catch {
    probeOk = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

const sql = probeOk ? postgres(url, { max: 4, idle_timeout: 20, prepare: false }) : null;

type Tx = postgres.TransactionSql;

const MIGRATION_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20261019120000_admin_role.sql',
);

const ROLE = 'meshgrounds_admin';
const ROLLBACK = new Error('mga1-rollback');

// Games columns the role may UPDATE (LLD §8.2 allowlist).
const ALLOWED_UPDATE = [
  'stage',
  'review_note',
  'reviewed_at',
  'graduated_at',
  'title',
  'slug',
  'tagline',
  'tags',
] as const;

// Table-level privileges, exactly as granted. Column-level grants (profiles SELECT,
// games UPDATE) are asserted separately — has_table_privilege stays false for them.
const EXPECTED_TABLE_PRIVS: Record<string, string[]> = {
  'public.games': ['SELECT'],
  'public.games_awaiting_review': ['SELECT'],
  'public.sessions': ['SELECT'],
  'public.ratings': ['SELECT'],
  'public.site_events': ['SELECT'],
  'public.game_validations': ['SELECT'],
  'public.game_assets': ['SELECT'],
  'public.admin_actions': ['INSERT', 'SELECT'],
  'public.admin_auth_failures': ['DELETE', 'INSERT', 'SELECT'],
};

const EXPECTED_POLICIES: Array<[string, string, string]> = [
  ['admin_actions', 'admin_insert', 'INSERT'],
  ['admin_actions', 'admin_read', 'SELECT'],
  ['admin_auth_failures', 'admin_all', 'ALL'],
  ['game_assets', 'admin_read', 'SELECT'],
  ['game_validations', 'admin_read', 'SELECT'],
  ['games', 'admin_read', 'SELECT'],
  ['games', 'admin_write', 'UPDATE'],
  ['profiles', 'admin_read', 'SELECT'],
  ['ratings', 'admin_read', 'SELECT'],
  ['sessions', 'admin_read', 'SELECT'],
  ['site_events', 'admin_read', 'SELECT'],
];

const P = 'a1' + randomUUID().replace(/-/g, '').slice(0, 10);
const uid = randomUUID();
const HANDLE = 'h' + P;
const G_QUEUE = `gq${P}`; // pending with a passed validation -> a games_awaiting_review row
const G_STAMP = `gs${P}`; // pending, never reviewed -> trigger stamp test
const SHA = 'ab'.repeat(32);

function skip(t: { skip: (message?: string) => void }) {
  if (!probeOk || !sql) {
    t.skip('local supabase is not running');
    return true;
  }
  return false;
}

// Fixture rows seeded as postgres inside the role's transaction, so every "returns
// rows" check is real. The transaction always rolls back.
async function seed(tx: Tx) {
  await tx`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', ${uid}, 'authenticated', 'authenticated',
            ${`${P}@example.com`}, '', now(), now())`;
  await tx`insert into public.profiles (id, handle) values (${uid}, ${HANDLE})`;
  await tx`
    insert into public.games (id, slug, title, creator, owner_id, stage, reviewed_at)
    values (${G_QUEUE}, ${G_QUEUE}, 'Queued', ${HANDLE}, ${uid}, 'pending', now())`;
  await tx`
    insert into public.games (id, slug, title, creator, owner_id, stage)
    values (${G_STAMP}, ${G_STAMP}, 'Stamp', ${HANDLE}, ${uid}, 'pending')`;
  await tx`
    insert into public.game_validations (game_id, version, bundle_sha256, status, static_report, finished_at)
    values (${G_QUEUE}, 1, ${SHA}, 'passed', '{}', now())`;
  await tx`insert into public.sessions (id, game_id) values (${randomUUID()}, ${G_QUEUE})`;
  await tx`insert into public.ratings (game_id, voter, stars) values (${G_QUEUE}, ${'v' + P}, 4)`;
  await tx`insert into public.site_events (event_type, path) values ('error', ${'/' + P})`;
  await tx`
    insert into public.game_assets (game_id, version, path, expected_type, status)
    values (${G_QUEUE}, 1, 'index.html', 'text', 'uploaded')`;
  await tx`
    insert into public.admin_actions (action, game_id, "before", "after")
    values ('approve', ${G_QUEUE}, '{}', '{"stage":"proving"}')`;
  await tx`insert into public.admin_auth_failures default values`;
}

// Seed as postgres, become the role for fn, roll the whole transaction back.
// PG16+ gives the role's creator ADMIN on it but not SET, so the test grants
// postgres membership inside the transaction (rolled back with everything else).
async function asRole(fn: (tx: Tx) => Promise<void>) {
  assert.ok(sql);
  let done = false;
  try {
    await sql.begin(async (tx) => {
      await seed(tx);
      await tx`grant meshgrounds_admin to postgres`;
      await tx.unsafe('set local role meshgrounds_admin');
      await fn(tx);
      done = true;
      throw ROLLBACK;
    });
  } catch (err) {
    if (!(done && err === ROLLBACK)) throw err;
  }
}

// A statement that must fail with the given SQLSTATE (default 42501
// insufficient_privilege). Runs in a savepoint so the transaction survives the error.
function denied(tx: Tx, run: (s: Tx) => Promise<unknown>, label: string, code = '42501') {
  return assert.rejects(
    () => tx.savepoint(run),
    (err: unknown) =>
      typeof err === 'object' && err !== null && 'code' in err && err.code === code,
    label,
  );
}

describe('meshgrounds_admin role (db)', () => {
  after(async () => {
    if (sql) await sql.end({ timeout: 1 }).catch(() => {});
  });

  it('the migration re-applies with no error', async (t) => {
    if (skip(t)) return;
    const body = readFileSync(MIGRATION_FILE, 'utf8');
    let applied = false;
    try {
      await sql!.begin(async (tx) => {
        await tx.unsafe(body);
        applied = true;
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    assert.ok(applied, 'migration body ran without error');
  });

  it('the role exists NOLOGIN/NOINHERIT/NOBYPASSRLS with the LLD settings', async (t) => {
    if (skip(t)) return;
    const [role] = await sql!<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolinherit: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolbypassrls: boolean;
      rolconnlimit: number;
    }[]>`
      select rolcanlogin, rolsuper, rolinherit, rolcreatedb, rolcreaterole,
             rolbypassrls, rolconnlimit
      from pg_roles where rolname = ${ROLE}`;
    assert.ok(role, 'pg_roles has meshgrounds_admin');
    assert.equal(role.rolcanlogin, false, 'no LOGIN — Ben enables it in AD-7');
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolinherit, false);
    assert.equal(role.rolcreatedb, false);
    assert.equal(role.rolcreaterole, false);
    assert.equal(role.rolbypassrls, false, 'must not bypass RLS');
    assert.equal(role.rolconnlimit, 10);
    const [setting] = await sql!<{ setconfig: string[] | null }[]>`
      select s.setconfig
      from pg_db_role_setting s
      join pg_roles r on r.oid = s.setrole
      where r.rolname = ${ROLE} and s.setdatabase = 0`;
    const config = setting?.setconfig ?? [];
    assert.ok(config.includes('statement_timeout=5s'), JSON.stringify(config));
    assert.ok(config.includes('search_path=public'), JSON.stringify(config));
  });

  it('the new tables have exactly the LLD shape, RLS on, and no public-facing access', async (t) => {
    if (skip(t)) return;
    const cols = (
      await sql!<{ table_name: string; column_name: string }[]>`
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name in ('admin_actions', 'admin_auth_failures')
        order by table_name, ordinal_position`
    ).reduce<Record<string, string[]>>((acc, r) => {
      (acc[r.table_name] ??= []).push(r.column_name);
      return acc;
    }, {});
    assert.deepEqual(cols.admin_actions, [
      'id', 'action', 'game_id', 'before', 'after', 'created_at',
    ]);
    assert.deepEqual(cols.admin_auth_failures, ['id', 'created_at']);
    for (const table of ['admin_actions', 'admin_auth_failures']) {
      const [rls] = await sql!<{ ok: boolean }[]>`
        select relrowsecurity as ok from pg_class
        where oid = ${'public.' + table}::regclass`;
      assert.equal(rls?.ok, true, `${table} RLS`);
      for (const role of ['public', 'anon', 'authenticated']) {
        const [priv] = await sql!<{ ok: boolean }[]>`
          select has_table_privilege(${role}, ${'public.' + table}, 'SELECT') as ok`;
        assert.equal(priv?.ok, false, `${table} ${role}`);
      }
    }
    const idx = (
      await sql!<{ indexname: string }[]>`
        select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'admin_actions'`
    ).map((r) => r.indexname);
    assert.ok(idx.includes('admin_actions_game_idx'));
    assert.ok(idx.includes('admin_actions_time_idx'));
  });

  it('reads every listed table and the review queue and gets rows back', async (t) => {
    if (skip(t)) return;
    await asRole(async (tx) => {
      const one = async (q: Promise<{ n: number }[]>, label: string) => {
        const [row] = await q;
        assert.ok(row && row.n >= 1, label);
      };
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.games`, 'games');
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.sessions`, 'sessions');
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.ratings`, 'ratings');
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.site_events`, 'site_events');
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.game_validations`, 'game_validations');
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.game_assets`, 'game_assets');
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.profiles`, 'profiles');
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.admin_actions`, 'admin_actions');
      await one(tx<{ n: number }[]>`select count(*)::int as n from public.admin_auth_failures`, 'admin_auth_failures');
      const [queued] = await tx<{ id: string; handle: string; preview_link: string }[]>`
        select id, handle, preview_link
        from public.games_awaiting_review where id = ${G_QUEUE}`;
      assert.equal(queued?.id, G_QUEUE, 'review queue returns the held game');
      assert.equal(queued?.handle, HANDLE);
      assert.equal(queued?.preview_link, `/play/${G_QUEUE}`);
      const [profile] = await tx<{ id: string; created_at: Date }[]>`
        select id, created_at from public.profiles where id = ${uid}`;
      assert.equal(profile?.id, uid, 'sign-up date reads through id/created_at');
    });
  });

  it('updates only the allowlisted games columns; every other column is refused', async (t) => {
    if (skip(t)) return;
    const columns = (
      await sql!<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'games'`
    ).map((r) => r.column_name);
    const allowed = new Set<string>(ALLOWED_UPDATE);
    for (const col of ALLOWED_UPDATE) assert.ok(columns.includes(col), `games.${col} exists`);
    const refused = columns.filter((c) => !allowed.has(c));
    for (const col of ['owner_id', 'creator', 'description', 'license']) {
      assert.ok(refused.includes(col), `games.${col} is not allowlisted`);
    }
    await asRole(async (tx) => {
      for (const col of ALLOWED_UPDATE) {
        await tx.unsafe(
          `update public.games set "${col}" = "${col}" where id = '${G_QUEUE}'`,
        );
      }
      for (const col of refused) {
        await denied(
          tx,
          (s) => s.unsafe(`update public.games set "${col}" = "${col}" where id = '${G_QUEUE}'`),
          `games.${col} update`,
        );
      }
      await denied(
        tx,
        (s) => s`insert into public.games (id, slug, title, creator) values ('x', 'x', 'x', 'x')`,
        'insert games',
      );
      await denied(tx, (s) => s`delete from public.games where id = ${G_QUEUE}`, 'delete games');
    });
  });

  it('refuses writes to the read-only tables and refuses edits or deletes of audit rows', async (t) => {
    if (skip(t)) return;
    await asRole(async (tx) => {
      // Paired allowed cases: the role is live and can append to both new tables.
      await tx`
        insert into public.admin_actions (action, game_id, "before", "after")
        values ('edit_metadata', ${G_QUEUE}, '{}', '{}')`;
      await tx`insert into public.admin_auth_failures default values`;
      const [counted] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.admin_auth_failures`;
      assert.ok(counted && counted.n >= 2);
      await tx`delete from public.admin_auth_failures`;

      await denied(tx, (s) => s`insert into public.sessions (id, game_id) values (${randomUUID()}, ${G_QUEUE})`, 'sessions insert');
      await denied(tx, (s) => s`update public.sessions set started = true`, 'sessions update');
      await denied(tx, (s) => s`delete from public.sessions`, 'sessions delete');
      await denied(tx, (s) => s`insert into public.ratings (game_id, voter, stars) values (${G_QUEUE}, 'v', 4)`, 'ratings insert');
      await denied(tx, (s) => s`update public.ratings set stars = 3`, 'ratings update');
      await denied(tx, (s) => s`delete from public.ratings`, 'ratings delete');
      await denied(tx, (s) => s`insert into public.profiles (id, handle) values (${randomUUID()}, 'xx')`, 'profiles insert');
      await denied(tx, (s) => s`update public.profiles set handle = 'xx'`, 'profiles update');
      await denied(tx, (s) => s`delete from public.profiles`, 'profiles delete');
      await denied(tx, (s) => s`insert into public.site_events (event_type) values ('error')`, 'site_events insert');
      await denied(tx, (s) => s`update public.site_events set path = '/x'`, 'site_events update');
      await denied(tx, (s) => s`delete from public.site_events`, 'site_events delete');
      await denied(tx, (s) => s`insert into public.game_validations (game_id, status) values (${G_QUEUE}, 'queued')`, 'game_validations insert');
      await denied(tx, (s) => s`update public.game_validations set status = 'failed'`, 'game_validations update');
      await denied(tx, (s) => s`delete from public.game_validations`, 'game_validations delete');
      await denied(tx, (s) => s`insert into public.game_assets (game_id, path, expected_type) values (${G_QUEUE}, 'x', 'text')`, 'game_assets insert');
      await denied(tx, (s) => s`update public.game_assets set status = 'missing'`, 'game_assets update');
      await denied(tx, (s) => s`delete from public.game_assets`, 'game_assets delete');

      await denied(tx, (s) => s`update public.admin_actions set action = 'reject'`, 'admin_actions update');
      await denied(tx, (s) => s`delete from public.admin_actions`, 'admin_actions delete');
      await denied(tx, (s) => s`truncate public.admin_actions`, 'admin_actions truncate');
      await denied(tx, (s) => s`update public.admin_auth_failures set created_at = created_at`, 'admin_auth_failures update');
      await denied(tx, (s) => s`truncate public.admin_auth_failures`, 'admin_auth_failures truncate');

      // The audit insert grant still runs through the table's own checks.
      await denied(
        tx,
        (s) => s`
          insert into public.admin_actions (action, game_id, "before", "after")
          values ('approve', ${G_QUEUE}, ${s.json({ k: 'x'.repeat(9000) })}, '{}')`,
        'admin_actions oversized before',
        '23514',
      );
      await denied(
        tx,
        (s) => s`
          insert into public.admin_actions (action, game_id, "before", "after")
          values ('bogus', ${G_QUEUE}, '{}', '{}')`,
        'admin_actions action check',
        '23514',
      );
    });
  });

  it('refuses handle, auth.users, private.settings and the unlisted public tables', async (t) => {
    if (skip(t)) return;
    const [settings] = await sql!<{ ok: boolean }[]>`
      select to_regclass('private.settings') is not null as ok`;
    assert.equal(settings?.ok, true, 'local stack has private.settings');
    const [users] = await sql!<{ ok: boolean }[]>`
      select to_regclass('auth.users') is not null as ok`;
    assert.equal(users?.ok, true, 'local stack has auth.users');
    await asRole(async (tx) => {
      // Paired allowed case first.
      const [profile] = await tx<{ id: string }[]>`
        select id, created_at from public.profiles where id = ${uid}`;
      assert.equal(profile?.id, uid);
      await denied(tx, (s) => s`select handle from public.profiles`, 'profiles.handle');
      await denied(tx, (s) => s`select id from auth.users`, 'auth.users');
      await denied(tx, (s) => s`select key from private.settings`, 'private.settings');
      await denied(tx, (s) => s`select user_id from public.saves`, 'saves');
      await denied(tx, (s) => s`select key from public.site_content`, 'site_content');
    });
  });

  it('moving a game to proving stamps reviewed_at through the existing trigger', async (t) => {
    if (skip(t)) return;
    await asRole(async (tx) => {
      const [beforeUpdate] = await tx<{ reviewed_at: Date | null }[]>`
        select reviewed_at from public.games where id = ${G_STAMP}`;
      assert.equal(beforeUpdate?.reviewed_at, null);
      await tx`update public.games set stage = 'proving' where id = ${G_STAMP}`;
      const [afterUpdate] = await tx<{ stage: string; reviewed_at: Date | null }[]>`
        select stage, reviewed_at from public.games where id = ${G_STAMP}`;
      assert.equal(afterUpdate?.stage, 'proving');
      assert.ok(afterUpdate?.reviewed_at instanceof Date, 'trigger stamped reviewed_at');
      assert.ok(
        Math.abs(Date.now() - afterUpdate.reviewed_at.getTime()) < 60_000,
        'reviewed_at is ~now',
      );
    });
  });

  it('grants are exactly the LLD list and never broader than PUBLIC anywhere else', async (t) => {
    if (skip(t)) return;
    // Table-level privileges on every public table/view: exactly EXPECTED_TABLE_PRIVS.
    const tableRows = await sql!<{ s: string; n: string; priv: string; ok: boolean; pub: boolean }[]>`
      select t.table_schema as s, t.table_name as n, p.priv,
             has_table_privilege(${ROLE}, format('%I.%I', t.table_schema, t.table_name), p.priv) as ok,
             has_table_privilege('public', format('%I.%I', t.table_schema, t.table_name), p.priv) as pub
      from information_schema.tables t
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
      where t.table_schema = 'public'
      order by 1, 2, 3`;
    const actual = new Map<string, string[]>();
    for (const r of tableRows) {
      if (r.ok) actual.set(`${r.s}.${r.n}`, [...(actual.get(`${r.s}.${r.n}`) ?? []), r.priv]);
    }
    assert.deepEqual(Object.fromEntries(actual), EXPECTED_TABLE_PRIVS);

    // Outside public the role must not see anything PUBLIC cannot.
    const otherRows = await sql!<{ s: string; n: string; priv: string; ok: boolean; pub: boolean }[]>`
      select t.table_schema as s, t.table_name as n, p.priv,
             has_table_privilege(${ROLE}, format('%I.%I', t.table_schema, t.table_name), p.priv) as ok,
             has_table_privilege('public', format('%I.%I', t.table_schema, t.table_name), p.priv) as pub
      from information_schema.tables t
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
      where t.table_schema not in ('public', 'pg_catalog', 'information_schema')`;
    for (const r of otherRows) {
      assert.equal(r.ok, r.pub, `${r.s}.${r.n} ${r.priv} exceeds PUBLIC`);
    }

    // Column-level privileges: the table grants above plus exactly the LLD column grants.
    const colRows = await sql!<{ s: string; n: string; c: string; priv: string; ok: boolean }[]>`
      select c.table_schema as s, c.table_name as n, c.column_name as c, p.priv,
             has_column_privilege(${ROLE}, format('%I.%I', c.table_schema, c.table_name), c.column_name, p.priv) as ok
      from information_schema.columns c
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as p(priv)
      where c.table_schema = 'public'`;
    const colsByTable = new Map<string, string[]>();
    for (const r of colRows) {
      colsByTable.set(r.n, [...(colsByTable.get(r.n) ?? []), r.c]);
    }
    const expected = new Set<string>();
    for (const [name, privs] of Object.entries(EXPECTED_TABLE_PRIVS)) {
      const table = name.replace('public.', '');
      for (const col of colsByTable.get(table) ?? []) {
        for (const priv of privs) expected.add(`${table}.${col}:${priv}`);
      }
    }
    for (const col of ['id', 'created_at']) expected.add(`profiles.${col}:SELECT`);
    for (const col of ALLOWED_UPDATE) expected.add(`games.${col}:UPDATE`);
    for (const r of colRows) {
      assert.equal(r.ok, expected.has(`${r.n}.${r.c}:${r.priv}`), `${r.n}.${r.c} ${r.priv}`);
    }
  });

  it('policies scoped to the role are exactly the LLD list', async (t) => {
    if (skip(t)) return;
    const rows = await sql!<{ tablename: string; policyname: string; cmd: string }[]>`
      select tablename, policyname, cmd
      from pg_policies
      where ${ROLE} = any(roles)
      order by tablename, policyname`;
    assert.deepEqual(
      rows.map((r) => [r.tablename, r.policyname, r.cmd]),
      EXPECTED_POLICIES,
    );
  });

  it('has no grants on other schemas, no routine grants, and no EXECUTE beyond PUBLIC', async (t) => {
    if (skip(t)) return;
    const routines = await sql!<{ routine_schema: string; routine_name: string }[]>`
      select routine_schema, routine_name
      from information_schema.role_routine_grants
      where grantee = ${ROLE}`;
    assert.equal(routines.length, 0, JSON.stringify(routines));
    const schemata = await sql!<{ schema_name: string }[]>`
      select schema_name from information_schema.schemata
      where schema_name !~ '^(pg_|information_schema)'`;
    for (const { schema_name: name } of schemata) {
      const [usage] = await sql!<{ ok: boolean; pub: boolean }[]>`
        select has_schema_privilege(${ROLE}, ${name}, 'USAGE') as ok,
               has_schema_privilege('public', ${name}, 'USAGE') as pub`;
      if (name === 'public') assert.equal(usage?.ok, true, 'public schema usage');
      else assert.equal(usage?.ok, usage?.pub, `schema ${name} usage exceeds PUBLIC`);
    }
    const extraExecute = await sql!<{ sig: string }[]>`
      select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname !~ '^(pg_|information_schema)'
        and has_function_privilege(${ROLE}, p.oid::regprocedure::text, 'EXECUTE')
        and not has_function_privilege('public', p.oid::regprocedure::text, 'EXECUTE')
      order by 1`;
    assert.equal(extraExecute.length, 0, JSON.stringify(extraExecute));
  });
});
