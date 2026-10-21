import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import postgres from 'postgres';

type Sql = postgres.Sql | postgres.TransactionSql;
type Created = { id: string; token: string; expires_at: Date };
type Resolved = { version_id: string; html_path: string; title: string };

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

function db(name: string, fn: (sql: postgres.Sql) => Promise<void>, max = 1) {
  it(name, async (t) => {
    const dbUrl = localDbUrl();
    if (!dbUrl) {
      t.skip('refusing to run preview link SQL against a non-local database');
      return;
    }
    const sql = postgres(dbUrl, { connect_timeout: 3, max, idle_timeout: 1, onnotice: () => {} });
    try {
      await sql`select 1`;
    } catch {
      await sql.end({ timeout: 1 }).catch(() => {});
      t.skip('local supabase is not running');
      return;
    }
    try {
      await fn(sql);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
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

function pgCode(err: unknown): string | undefined {
  return err instanceof postgres.PostgresError ? err.code : undefined;
}

async function codeOf(tx: postgres.TransactionSql, fn: (sp: postgres.TransactionSql) => Promise<unknown>): Promise<string | null> {
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp);
    });
    return null;
  } catch (err) {
    const code = pgCode(err);
    if (code) return code;
    throw err;
  }
}

async function asRole(tx: Sql, role: 'anon' | 'authenticated', uid?: string): Promise<void> {
  await tx`select set_config('request.jwt.claim.sub', ${uid ?? ''}, true)`;
  await tx`select set_config('request.jwt.claims', ${JSON.stringify(uid ? { sub: uid, role } : { role })}, true)`;
  await tx.unsafe(`set local role ${role}`);
}

const bundle = (ch: string) => ch.repeat(32);

async function seed(tx: Sql) {
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const gameId = `pl${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const sha = bundle('ab');
  for (const [id, handle] of [[ownerId, `h${gameId.slice(2)}`], [otherId, `o${gameId.slice(2)}`]] as const) {
    await tx`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${id}::uuid, 'authenticated', 'authenticated', ${`${id}@example.test`}, '', now(), now())
    `;
    await tx`insert into public.profiles (id, handle) values (${id}::uuid, ${handle})`;
  }
  await tx`
    insert into public.games (id, slug, owner_id, creator, title, stage)
    values (${gameId}, ${gameId}, ${ownerId}::uuid, 'owner', 'Preview Title', 'pending')
  `;
  const [version] = await tx<{ id: string }[]>`
    insert into public.game_validations (game_id, version, bundle_sha256, status)
    values (${gameId}, 1, ${sha}, 'passed')
    returning id
  `;
  return { ownerId, otherId, gameId, versionId: version.id, sha };
}

async function mint(tx: Sql, ownerId: string, versionId: string): Promise<Created> {
  await asRole(tx, 'authenticated', ownerId);
  const [row] = await tx<Created[]>`select * from public.create_preview_link(${versionId}::uuid)`;
  await tx.unsafe('reset role');
  return row;
}

async function play(tx: Sql, token: string): Promise<Resolved[]> {
  await asRole(tx, 'anon');
  const rows = await tx<Resolved[]>`select * from public.resolve_preview_link(${token})`;
  await tx.unsafe('reset role');
  return [...rows];
}

async function views(tx: Sql, id: string): Promise<number> {
  const [row] = await tx<{ view_count: number; revoked_at: Date | null }[]>`
    select view_count, revoked_at from public.preview_links where id = ${id}::uuid
  `;
  return row.view_count;
}

describe('preview links', () => {
  db('expires on the timestamp and resolves one microsecond later', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      await tx`update public.preview_links set expires_at = now() where id = ${link.id}::uuid`;
      assert.deepEqual(await play(tx, link.token), []);
      assert.equal(await views(tx, link.id), 0);
      await tx`update public.preview_links set expires_at = now() + interval '1 microsecond' where id = ${link.id}::uuid`;
      assert.deepEqual(await play(tx, link.token), [{
        version_id: versionId,
        html_path: `${gameId}/1/index.html`,
        title: 'Preview Title',
      }]);
      assert.equal(await views(tx, link.id), 1);
    });
  });

  db('revoke is idempotent and stops further views', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      assert.equal((await play(tx, link.token)).length, 1);
      await asRole(tx, 'authenticated', ownerId);
      await tx`select public.revoke_preview_link(${link.id}::uuid)`;
      const [first] = await tx<{ revoked_at: Date }[]>`select revoked_at from public.preview_links where id = ${link.id}::uuid`;
      await tx`select public.revoke_preview_link(${link.id}::uuid)`;
      const [second] = await tx<{ revoked_at: Date }[]>`select revoked_at from public.preview_links where id = ${link.id}::uuid`;
      await tx.unsafe('reset role');
      assert.equal(second.revoked_at.toISOString(), first.revoked_at.toISOString());
      assert.deepEqual(await play(tx, link.token), []);
      assert.equal(await views(tx, link.id), 1);
    });
  });

  db('caps active links at five until one is revoked or expired', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const ids: string[] = [];
      for (let n = 0; n < 5; n += 1) ids.push((await mint(tx, ownerId, versionId)).id);
      await asRole(tx, 'authenticated', ownerId);
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${versionId}::uuid)`), 'P0001');
      await tx.unsafe('reset role');
      const active = async () => (await tx<{ n: number }[]>`
        select count(*)::int as n from public.preview_links
        where owner_id = ${ownerId}::uuid and revoked_at is null and expires_at > now()
      `)[0].n;
      assert.equal(await active(), 5);
      await asRole(tx, 'authenticated', ownerId);
      await tx`select public.revoke_preview_link(${ids[0]}::uuid)`;
      await tx.unsafe('reset role');
      await mint(tx, ownerId, versionId);
      assert.equal(await active(), 5);
      await tx`update public.preview_links set expires_at = now() where id = ${ids[1]}::uuid`;
      await mint(tx, ownerId, versionId);
      assert.equal(await active(), 5);
    });
  });

  db('stays at five active links when eight creates race', async (sql) => {
    const ownerId = randomUUID();
    const gameId = `pl${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${`h${gameId.slice(2)}`})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, 'owner', 'Race', 'pending')
      `;
      const [version] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${bundle('ef')}, 'passed')
        returning id
      `;
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => sql.begin(async (tx) => {
        await asRole(tx, 'authenticated', ownerId);
        await tx`select * from public.create_preview_link(${version.id}::uuid)`;
      })));
      const codes = attempts.map((attempt) => (attempt.status === 'fulfilled' ? 'ok' : pgCode(attempt.reason) ?? 'other')).sort();
      assert.deepEqual(codes, ['P0001', 'P0001', 'P0001', 'ok', 'ok', 'ok', 'ok', 'ok']);
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.preview_links
        where owner_id = ${ownerId}::uuid and revoked_at is null and expires_at > now()
      `;
      assert.equal(row.n, 5);
    } finally {
      await sql`delete from auth.users where id = ${ownerId}::uuid`;
    }
  }, 8);

  db('hides a rejected game and a failed version without counting a view', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      assert.equal((await play(tx, link.token)).length, 1);
      await tx`update public.games set stage = 'rejected' where id = (select game_id from public.game_validations where id = ${versionId}::uuid)`;
      assert.deepEqual(await play(tx, link.token), []);
      await tx`update public.games set stage = 'pending' where owner_id = ${ownerId}::uuid`;
      await tx`update public.game_validations set status = 'failed' where id = ${versionId}::uuid`;
      assert.deepEqual(await play(tx, link.token), []);
      assert.equal(await views(tx, link.id), 1);
    });
  });

  db('hides a link only when its own bundle is confirmed nsfw', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId, sha } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      await tx`
        insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies)
        values (${gameId}, ${bundle('cd')}, 'nsfw', 'confirmed', true),
               (${gameId}, ${sha}, 'nsfw', 'rejected', false)
      `;
      assert.equal((await play(tx, link.token)).length, 1);
      await tx`
        update public.game_tags set status = 'confirmed', applies = true
        where game_id = ${gameId} and bundle_sha256 = ${sha}
      `;
      assert.deepEqual(await play(tx, link.token), []);
      assert.equal(await views(tx, link.id), 1);
    });
  });

  db('denies create, list, and revoke to another user, an admin, and anon', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, otherId, gameId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      const adminId = randomUUID();
      await tx`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${adminId}::uuid, 'authenticated', 'authenticated', ${`${adminId}@example.test`}, '', now(), now())
      `;
      await tx`insert into public.profiles (id, handle, role) values (${adminId}::uuid, ${`a${gameId.slice(2)}`}, 'admin')`;
      const [admin] = await tx<{ role: string }[]>`select role from public.profiles where id = ${adminId}::uuid`;
      assert.equal(admin.role, 'admin');
      const callers: Array<['authenticated', string] | ['anon']> = [
        ['authenticated', otherId],
        ['authenticated', adminId],
        ['anon'],
      ];
      for (const caller of callers) {
        await asRole(tx, caller[0], caller[1]);
        assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${versionId}::uuid)`), '42501');
        assert.equal(await codeOf(tx, (sp) => sp`select public.revoke_preview_link(${link.id}::uuid)`), '42501');
        if (caller[0] === 'anon') {
          assert.equal(await codeOf(tx, (sp) => sp`select id from public.preview_links`), '42501');
        } else {
          assert.deepEqual([...(await tx<{ id: string }[]>`select id from public.preview_links`)], []);
        }
      }
      await asRole(tx, 'authenticated', otherId);
      assert.equal(await codeOf(tx, (sp) => sp`
        insert into public.preview_links (version_id, owner_id, token_hash, expires_at)
        values (${versionId}::uuid, ${otherId}::uuid, decode(${bundle('11')}, 'hex'), now() + interval '1 day')
      `), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`update public.preview_links set view_count = 0`), '42501');
      await tx.unsafe('reset role');
      const [kept] = await tx<{ n: number; revoked_at: Date | null }[]>`
        select count(*)::int as n, max(revoked_at) as revoked_at
        from public.preview_links where owner_id = ${ownerId}::uuid
      `;
      assert.equal(kept.n, 1);
      assert.equal(kept.revoked_at, null);
      await asRole(tx, 'authenticated', ownerId);
      assert.deepEqual([...(await tx<{ id: string }[]>`select id from public.preview_links`)], [{ id: link.id }]);
    });
  });

  db('returns one empty result for an unknown token and an expired token', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      await tx`update public.preview_links set expires_at = now() where id = ${link.id}::uuid`;
      const unknown = await play(tx, 'not-a-real-preview-token');
      const expired = await play(tx, link.token);
      assert.deepEqual(unknown, expired);
      assert.deepEqual(expired, []);
      assert.equal(await views(tx, link.id), 0);
    });
  });

  db('stores the sha256 of a 32-byte base64url token and returns the plaintext once', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      const life = new Date(link.expires_at).getTime() - Date.now();
      assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(link.token, 'base64url').length, 32);
      assert.ok(life > 6.9 * 86_400_000 && life < 7.1 * 86_400_000);
      const [row] = await tx<{ token_hash: Buffer }[]>`select token_hash from public.preview_links where id = ${link.id}::uuid`;
      assert.equal(row.token_hash.length, 32);
      assert.equal(Buffer.compare(row.token_hash, createHash('sha256').update(link.token).digest()), 0);
      const columns = await tx<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'preview_links'
      `;
      assert.equal(columns.some((column) => column.column_name === 'token'), false);
      assert.notEqual((await mint(tx, ownerId, versionId)).token, link.token);
    });
  });

  db('keeps an old link on its version after a new upload', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      await tx`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 2, ${bundle('12')}, 'passed')
      `;
      assert.deepEqual(await play(tx, link.token), [{
        version_id: versionId,
        html_path: `${gameId}/1/index.html`,
        title: 'Preview Title',
      }]);
    });
  });

  db('revokes execute from public and leaves resolve callable by anon', async (sql) => {
    const [row] = await sql<{
      pub_create: boolean; anon_create: boolean; auth_create: boolean;
      pub_revoke: boolean; auth_revoke: boolean;
      pub_resolve: boolean; anon_resolve: boolean; auth_resolve: boolean;
    }[]>`
      select
        has_function_privilege('public', 'public.create_preview_link(uuid, interval)', 'execute') as pub_create,
        has_function_privilege('anon', 'public.create_preview_link(uuid, interval)', 'execute') as anon_create,
        has_function_privilege('authenticated', 'public.create_preview_link(uuid, interval)', 'execute') as auth_create,
        has_function_privilege('public', 'public.revoke_preview_link(uuid)', 'execute') as pub_revoke,
        has_function_privilege('authenticated', 'public.revoke_preview_link(uuid)', 'execute') as auth_revoke,
        has_function_privilege('public', 'public.resolve_preview_link(text)', 'execute') as pub_resolve,
        has_function_privilege('anon', 'public.resolve_preview_link(text)', 'execute') as anon_resolve,
        has_function_privilege('authenticated', 'public.resolve_preview_link(text)', 'execute') as auth_resolve
    `;
    assert.deepEqual({ ...row }, {
      pub_create: false, anon_create: false, auth_create: true,
      pub_revoke: false, auth_revoke: true,
      pub_resolve: false, anon_resolve: true, auth_resolve: true,
    });
  });
});
