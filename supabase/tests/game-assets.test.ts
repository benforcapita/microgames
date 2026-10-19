import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { upsertScannedAssetsSql } from '../../src/lib/server/asset-manifest.ts';

const supabaseDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = join(supabaseDir, 'migrations', '20261016044322_game_assets.sql');

const HOSTED_REGEX_HEX = '285e2f7c5c2e5c2e7c5c5c29';

describe('game_assets migration file', () => {
  it('is version 20261016044322 and name game_assets, matching the hosted statement', () => {
    const names = readdirSync(join(supabaseDir, 'migrations'));
    assert.equal(names.filter((name) => name.startsWith('20261016044322_')).join(','), '20261016044322_game_assets.sql');
    const file = readFileSync(migrationPath);
    assert.equal(file.byteLength, 1029);
    const text = file.toString('utf8');
    const pattern = text.match(/path !~ '([^']*)'/);
    assert.ok(pattern);
    assert.equal(Buffer.from(pattern[1], 'utf8').toString('hex'), HOSTED_REGEX_HEX);
    assert.equal(text.endsWith('revoke all on public.game_assets from anon, authenticated;'), true);
  });
});

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

async function connect(t: { skip: (message?: string) => void }): Promise<postgres.Sql | undefined> {
  const dbUrl = localDbUrl();
  if (!dbUrl) {
    t.skip('refusing to run game_assets SQL against a non-local database');
    return undefined;
  }
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

async function constraintCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code ?? 'error';
  }
}

describe('game_assets schema', () => {
  it('has the hosted columns, checks, RLS, and no anon or authenticated grants', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const [migration] = await sql<{ version: string; name: string }[]>`
        select version, name from supabase_migrations.schema_migrations where version = '20261016044322'
      `;
      assert.equal(migration?.version, '20261016044322');
      assert.equal(migration?.name, 'game_assets');

      const columns = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
        select column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and table_name = 'game_assets'
        order by ordinal_position
      `;
      assert.deepEqual(
        columns.map((column) => [column.column_name, column.data_type, column.is_nullable]),
        [
          ['id', 'uuid', 'NO'],
          ['game_id', 'text', 'NO'],
          ['version', 'integer', 'NO'],
          ['path', 'text', 'NO'],
          ['expected_type', 'text', 'NO'],
          ['status', 'text', 'NO'],
          ['size_bytes', 'integer', 'YES'],
          ['content_sha256', 'text', 'YES'],
          ['source', 'text', 'NO'],
          ['reject_reason', 'text', 'YES'],
          ['created_at', 'timestamp with time zone', 'NO'],
          ['updated_at', 'timestamp with time zone', 'NO'],
          ['content_at', 'timestamp with time zone', 'YES'],
        ],
      );
      const defaults = Object.fromEntries(columns.map((column) => [column.column_name, column.column_default ?? '']));
      assert.match(defaults.id, /gen_random_uuid/);
      assert.match(defaults.version, /\b1\b/);
      assert.match(defaults.status, /missing/);
      assert.match(defaults.source, /scan/);
      assert.match(defaults.created_at, /now\(\)/);
      assert.match(defaults.updated_at, /now\(\)/);

      const constraints = await sql<{ contype: string; def: string }[]>`
        select contype::text as contype, pg_get_constraintdef(oid) as def
        from pg_constraint
        where conrelid = 'public.game_assets'::regclass
        order by contype, def
      `;
      const defs = constraints.map((constraint) => constraint.def);
      assert.ok(defs.some((def) => def.includes('PRIMARY KEY') && def.includes('id')));
      assert.ok(defs.some((def) => /FOREIGN KEY \(game_id\) REFERENCES games\(id\) ON DELETE CASCADE/i.test(def)));
      assert.ok(defs.some((def) => /UNIQUE \(game_id, version, path\)/i.test(def)));
      assert.ok(defs.some((def) => def.includes('char_length(path)') && def.includes('512')));
      assert.ok(defs.some((def) => def.includes("expected_type") && def.includes('image') && def.includes('text')));
      assert.ok(defs.some((def) => def.includes("'missing'") && def.includes("'uploaded'") && def.includes("'rejected'")));
      assert.ok(defs.some((def) => def.includes('4194304')));
      assert.ok(defs.some((def) => def.includes("source") && def.includes("'scan'") && def.includes("'creator'")));

      const [index] = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where schemaname = 'public' and indexname = 'game_assets_game_idx'
      `;
      assert.match(index?.indexdef ?? '', /game_id, version/);

      const [rls] = await sql<{ relrowsecurity: boolean; policies: number }[]>`
        select c.relrowsecurity,
               -- MGA-1 admin_read (meshgrounds_admin) is the only sanctioned policy.
               (select count(*)::int from pg_policy p where p.polrelid = c.oid and p.polname <> 'admin_read') as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'game_assets'
      `;
      assert.equal(rls?.relrowsecurity, true);
      assert.equal(rls?.policies, 0);

      const grants = await sql<{ grantee: string; privilege_type: string }[]>`
        select grantee, privilege_type
        from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'game_assets' and grantee in ('anon', 'authenticated')
      `;
      assert.equal(grants.length, 0);
      const [priv] = await sql<{ anon_select: boolean; anon_insert: boolean; auth_select: boolean; auth_update: boolean; auth_delete: boolean }[]>`
        select has_table_privilege('anon', 'public.game_assets', 'SELECT') as anon_select,
               has_table_privilege('anon', 'public.game_assets', 'INSERT') as anon_insert,
               has_table_privilege('authenticated', 'public.game_assets', 'SELECT') as auth_select,
               has_table_privilege('authenticated', 'public.game_assets', 'UPDATE') as auth_update,
               has_table_privilege('authenticated', 'public.game_assets', 'DELETE') as auth_delete
      `;
      assert.deepEqual({ ...priv }, {
        anon_select: false,
        anon_insert: false,
        auth_select: false,
        auth_update: false,
        auth_delete: false,
      });
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('rejects a leading slash, dotdot, and backslash, and ignores scan conflicts', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = `ga-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await sql`
        insert into public.games (id, slug, creator, title, stage)
        values (${id}, ${id}, 'stub', 'Assets', 'pending')
      `;
      const insert = (path: string) => sql`
        insert into public.game_assets (game_id, version, path, expected_type)
        values (${id}, 1, ${path}, 'image')
      `;
      assert.equal(await constraintCode(() => insert('/hero.png')), '23514');
      assert.equal(await constraintCode(() => insert('../hero.png')), '23514');
      assert.equal(await constraintCode(() => insert('sprites/../hero.png')), '23514');
      assert.equal(await constraintCode(() => insert('sprites\\hero.png')), '23514');
      assert.equal(await constraintCode(() => insert(`${'a'.repeat(509)}.png`)), '23514');
      assert.equal(await constraintCode(() => insert(`${'b'.repeat(508)}.png`)), 'ok');
      assert.equal(await constraintCode(() => sql`
        insert into public.game_assets (game_id, version, path, expected_type, size_bytes)
        values (${id}, 1, 'too-big.png', 'image', 4194305)
      `), '23514');

      await upsertScannedAssetsSql(sql, id, 1, [{ path: 'sprites/hero.png', expectedType: 'image' }]);
      await sql`
        update public.game_assets
        set status = 'uploaded', source = 'creator'
        where game_id = ${id} and version = 1 and path = 'sprites/hero.png'
      `;
      await upsertScannedAssetsSql(sql, id, 1, [
        { path: 'sprites/hero.png', expectedType: 'image' },
        { path: 'sfx/hit.wav', expectedType: 'audio' },
      ]);
      const rows = await sql<{ path: string; status: string; source: string; expected_type: string; version: number }[]>`
        select path, status, source, expected_type, version
        from public.game_assets
        where game_id = ${id} and path in ('sprites/hero.png', 'sfx/hit.wav')
        order by path
      `;
      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { path: 'sfx/hit.wav', status: 'missing', source: 'scan', expected_type: 'audio', version: 1 },
        { path: 'sprites/hero.png', status: 'uploaded', source: 'creator', expected_type: 'image', version: 1 },
      ]);
    } finally {
      await sql`delete from public.games where id = ${id}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });
});
