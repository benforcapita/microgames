import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import postgres from 'postgres';

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

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

async function sqlState(tx: postgres.TransactionSql, query: string): Promise<string | null> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(query);
    });
    return null;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
    return 'unknown';
  }
}

describe('session_admissions lockdown', () => {
  it('has row level security enabled and no policies, so PostgREST roles are deny-all', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const [row] = await sql<{ rls: boolean; policies: number }[]>`
        select c.relrowsecurity as rls,
               (select count(*)::int from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'session_admissions') as policies
        from pg_class c
        where c.oid = 'public.session_admissions'::regclass`;
      assert.ok(row, 'public.session_admissions must exist');
      assert.equal(row.rls, true, 'relrowsecurity must be on');
      assert.equal(row.policies, 0, 'no policies may exist');
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('anon, authenticated and PUBLIC hold zero table privileges', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const grants = await sql<{ grantee: string; privilege: string }[]>`
        select grantee, privilege_type as privilege
        from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'session_admissions'
          and grantee in ('anon', 'authenticated', 'PUBLIC')
        order by 1, 2`;
      assert.equal(grants.length, 0, `unexpected grants: ${JSON.stringify(grants)}`);
      const held = await sql<{ role: string; privilege: string }[]>`
        select r.role, p.privilege
        from unnest(${['anon', 'authenticated', 'public']}::text[]) as r(role)
        cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(privilege)
        where has_table_privilege(r.role, 'public.session_admissions', p.privilege)
        order by 1, 2`;
      assert.equal(held.length, 0, `privileges still held: ${JSON.stringify(held)}`);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('as anon and authenticated, select and insert are refused with 42501', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      await sql.begin(async (tx) => {
        for (const role of ['anon', 'authenticated']) {
          await tx.unsafe(`set local role ${role}`);
          for (const query of [
            'select 1 from public.session_admissions limit 1',
            `insert into public.session_admissions (kind, subject, game_id) values ('uid', 'probe', 'none')`,
            'delete from public.session_admissions',
          ]) {
            assert.equal(await sqlState(tx, query), '42501', `${role}: ${query}`);
          }
          await tx.unsafe('reset role');
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
