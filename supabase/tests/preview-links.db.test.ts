import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
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
  it(name, { timeout: 30_000 }, async (t) => {
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

async function asRole(tx: Sql, role: 'anon' | 'authenticated' | 'service_role', uid?: string): Promise<void> {
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

async function waitForLocks(probe: postgres.Sql, pids: number[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const [row] = await probe<{ n: number }[]>`
      select count(*)::int as n
      from pg_stat_activity
      where pid in (${pids[0]}, ${pids[1]})
        and wait_event_type = 'Lock'
    `;
    if (row.n === pids.length) return;
    if (Date.now() >= deadline) {
      const activity = await probe<{ pid: number; wait_event_type: string | null; state: string }[]>`
        select pid, wait_event_type, state
        from pg_stat_activity
        where pid in (${pids[0]}, ${pids[1]})
      `;
      throw new Error(`both admin revokes did not wait on the row lock: ${JSON.stringify(activity)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('preview links', () => {
  after(async () => {
    const g = globalThis as typeof globalThis & { __mgSql?: postgres.Sql };
    if (!g.__mgSql) return;
    const { sql: appSql } = await import('../../src/lib/server/db.ts');
    await appSql.end({ timeout: 1 }).catch(() => {});
  });

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

  db('caps five links across two versions on separate connections and releases the lock', async (sql) => {
    const dbUrl = localDbUrl();
    if (!dbUrl) return;
    const ownerId = randomUUID();
    const gameId = `pl${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const clients = Array.from({ length: 8 }, (_, index) => postgres(dbUrl, {
      max: 1,
      idle_timeout: 30,
      connect_timeout: 3,
      connection: { application_name: `preview-race-${index}` },
    }));
    const probe = postgres(dbUrl, { max: 1, idle_timeout: 1, connect_timeout: 3 });
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${`h${gameId.slice(2)}`})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage, tags)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, 'owner', 'Race', 'pending', '{}')
      `;
      const [firstVersion] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${bundle('ef')}, 'passed')
        returning id
      `;
      const [secondVersion] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 2, ${bundle('12')}, 'passed')
        returning id
      `;
      const versions = [firstVersion.id, secondVersion.id];
      await Promise.all(clients.map((client) => client.unsafe(`set lock_timeout = '2s'`)));
      const pids = await Promise.all(clients.map(async (client) => {
        const [row] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
        return row.pid;
      }));
      assert.equal(new Set(pids).size, clients.length);
      let arrived = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const attempts = await Promise.allSettled(clients.map(async (client, index) => {
        arrived += 1;
        if (arrived === clients.length) release();
        await gate;
        await client.begin(async (tx) => {
          await asRole(tx, 'authenticated', ownerId);
          await tx`select * from public.create_preview_link(${versions[index % 2]}::uuid)`;
        });
      }));
      const codes = attempts.map((attempt) => (attempt.status === 'fulfilled' ? 'ok' : pgCode(attempt.reason) ?? 'other')).sort();
      assert.deepEqual(codes, ['P0001', 'P0001', 'P0001', 'ok', 'ok', 'ok', 'ok', 'ok']);
      const [active] = await probe<{ n: number }[]>`
        select count(*)::int as n from public.preview_links
        where owner_id = ${ownerId}::uuid and revoked_at is null and expires_at > now()
      `;
      assert.equal(active.n, 5);
      const [held] = await probe<{ ok: boolean }[]>`
        select pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended('preview_link:' || ${ownerId}::text, 0)
        ) as ok
      `;
      assert.equal(held.ok, true);
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 1 }).catch(() => {})));
      await probe.end({ timeout: 1 }).catch(() => {});
      await sql`delete from auth.users where id = ${ownerId}::uuid`;
    }
  });

  db('plays only a passed validation and counts no view for any other status', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      const hidden = async () => {
        assert.deepEqual(await play(tx, link.token), []);
        assert.equal(await views(tx, link.id), 1);
      };
      assert.equal((await play(tx, link.token)).length, 1);
      assert.equal(await views(tx, link.id), 1);
      for (const status of ['queued', 'running', 'error', 'failed'] as const) {
        await tx`update public.game_validations set status = ${status} where id = ${versionId}::uuid`;
        await hidden();
      }
      await tx`update public.game_validations set status = 'passed' where id = ${versionId}::uuid`;
      await tx`update public.games set stage = 'rejected' where id = ${gameId}`;
      await hidden();
      await tx`update public.games set stage = 'pending' where id = ${gameId}`;
      assert.equal((await play(tx, link.token)).length, 1);
      assert.equal(await views(tx, link.id), 2);
    });
  });

  db('hides a link only when its own bundle is confirmed nsfw', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId, sha } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      await tx`
        insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies)
        values (${gameId}, ${bundle('cd')}, 'nsfw', 'confirmed', true),
               (${gameId}, ${sha}, 'nsfw', 'rejected', false),
               (${gameId}, ${sha}, 'kid_safe', 'confirmed', true)
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

  db('resolves a bundle whose confirmed category is neither nsfw nor the only safe tag', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId, sha } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      const category = `extra_${gameId.slice(2)}`;
      await tx`
        insert into public.categories (slug, description, status, is_safety)
        values (${category}, 'stylized combat', 'approved', false)
      `;
      await tx`
        insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies)
        values (${gameId}, ${sha}, ${category}, 'confirmed', true),
               (${gameId}, ${sha}, 'kid_safe', 'confirmed', true)
      `;
      assert.equal((await play(tx, link.token)).length, 1);
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
      const empty = await play(tx, '');
      const expired = await play(tx, link.token);
      assert.deepEqual(unknown, expired);
      assert.deepEqual(empty, expired);
      assert.deepEqual(expired, []);
      assert.equal(await views(tx, link.id), 0);
    });
  });

  db('stores the sha256 of a 32-byte base64url token and returns the plaintext once', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(link.token, 'base64url').length, 32);
      const [row] = await tx<{ token_hash: Buffer; exact: boolean }[]>`
        select token_hash, expires_at = created_at + interval '7 days' as exact
        from public.preview_links where id = ${link.id}::uuid
      `;
      assert.equal(row.exact, true);
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

  db('sets the lifetime from p_ttl_hours and refuses one outside 1..168 hours', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      await asRole(tx, 'authenticated', ownerId);
      for (const hours of [1, 24, 72, 168]) {
        const [link] = await tx<Created[]>`select * from public.create_preview_link(${versionId}::uuid, ${hours}::integer)`;
        const [row] = await tx<{ exact: boolean }[]>`
          select expires_at = created_at + make_interval(hours => ${hours}::integer) as exact
          from public.preview_links where id = ${link.id}::uuid
        `;
        assert.equal(row.exact, true, `${hours}h`);
        await tx`select public.revoke_preview_link(${link.id}::uuid)`;
      }
      for (const hours of [0, -1, 169, null]) {
        assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${versionId}::uuid, ${hours}::integer)`), '22023', String(hours));
      }
      await tx.unsafe('reset role');
      const [count] = await tx<{ n: number }[]>`select count(*)::int as n from public.preview_links where owner_id = ${ownerId}::uuid`;
      assert.equal(count.n, 4);
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
        has_function_privilege('public', 'public.create_preview_link(uuid, integer)', 'execute') as pub_create,
        has_function_privilege('anon', 'public.create_preview_link(uuid, integer)', 'execute') as anon_create,
        has_function_privilege('authenticated', 'public.create_preview_link(uuid, integer)', 'execute') as auth_create,
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
    const fns = await sql<{ proname: string; proconfig: string[] | null }[]>`
      select proname, proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'public' and proname in ('create_preview_link', 'revoke_preview_link', 'admin_revoke_preview_link', 'resolve_preview_link'))
        or (n.nspname = 'private' and proname in ('preview_link_audit', 'preview_link_audit_from_link'))
      order by proname
    `;
    assert.deepEqual(fns.map((fn) => fn.proname), [
      'admin_revoke_preview_link',
      'create_preview_link',
      'preview_link_audit',
      'preview_link_audit_from_link',
      'resolve_preview_link',
      'revoke_preview_link',
    ]);
    for (const fn of fns) assert.deepEqual(fn.proconfig, ['search_path=""']);
    const [anonRevoke] = await sql<{ anon_revoke: boolean }[]>`
      select has_function_privilege('anon', 'public.revoke_preview_link(uuid)', 'execute') as anon_revoke
    `;
    assert.equal(anonRevoke.anon_revoke, false);
  });

  db('returns no other link and an empty token resolves nothing', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId } = await seed(tx);
      const [second] = await tx<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 2, ${bundle('34')}, 'passed')
        returning id
      `;
      const first = await mint(tx, ownerId, versionId);
      const other = await mint(tx, ownerId, second.id);
      assert.deepEqual(await play(tx, ''), []);
      assert.deepEqual(await play(tx, first.token), [{
        version_id: versionId,
        html_path: `${gameId}/1/index.html`,
        title: 'Preview Title',
      }]);
      assert.deepEqual(await play(tx, other.token), [{
        version_id: second.id,
        html_path: `${gameId}/2/index.html`,
        title: 'Preview Title',
      }]);
      assert.equal((await play(tx, first.token))[0].version_id, versionId);
    });
  });

  db('returns no row for a truncated token or a random token of the same length', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      const truncated = link.token.slice(0, -1);
      let random = randomBytes(32).toString('base64url');
      if (random === link.token) random = randomBytes(32).toString('base64url');
      assert.equal(truncated.length, link.token.length - 1);
      assert.equal(link.token.startsWith(truncated), true);
      assert.equal(random.length, link.token.length);
      assert.deepEqual(await play(tx, truncated), []);
      assert.deepEqual(await play(tx, random), []);
      assert.equal(await views(tx, link.id), 0);
      assert.equal((await play(tx, link.token)).length, 1);
    });
  });

  db('mints distinct 32-byte tokens that are not a hash of the uid and the time', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const tokens: string[] = [];
      for (let n = 0; n < 8; n += 1) {
        const [before] = await tx<{ ts: string }[]>`select clock_timestamp()::text as ts`;
        const link = await mint(tx, ownerId, versionId);
        const [after] = await tx<{ ts: string }[]>`select clock_timestamp()::text as ts`;
        tokens.push(link.token);
        const raw = Buffer.from(link.token, 'base64url');
        assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(raw.length, 32);
        assert.ok(raw.subarray(0, 8).some((byte) => byte !== 0));
        assert.ok(raw.subarray(24).some((byte) => byte !== 0));
        const [hit] = await tx<{ n: number }[]>`
          select count(*)::int as n
          from (select 1) as probe
          where ${link.token} = rtrim(translate(encode(extensions.digest(${ownerId}::text || now()::text, 'sha256'), 'base64'), '+/', '-_'), '=')
             or ${link.token} = rtrim(translate(encode(extensions.digest(${ownerId}::text || transaction_timestamp()::text, 'sha256'), 'base64'), '+/', '-_'), '=')
             or ${link.token} = rtrim(translate(encode(extensions.digest(${ownerId}::text, 'sha256'), 'base64'), '+/', '-_'), '=')
             or exists (
               select 1
               from generate_series(${before.ts}::timestamptz, ${after.ts}::timestamptz, interval '1 microsecond') as ts
               where ${link.token} = rtrim(translate(encode(extensions.digest(${ownerId}::text || ts::text, 'sha256'), 'base64'), '+/', '-_'), '=')
                  or ${link.token} = rtrim(translate(encode(extensions.digest(ts::text || ${ownerId}::text, 'sha256'), 'base64'), '+/', '-_'), '=')
             )
        `;
        assert.equal(hit.n, 0);
        await asRole(tx, 'authenticated', ownerId);
        await tx`select public.revoke_preview_link(${link.id}::uuid)`;
        await tx.unsafe('reset role');
      }
      assert.equal(new Set(tokens).size, tokens.length);
      const [body] = await tx<{ src: string }[]>`
        select pg_get_functiondef('public.create_preview_link(uuid, integer)'::regprocedure) as src
      `;
      const assignments = body.src.split('\n').filter((line) => /^\s*v_token\s*:=/.test(line));
      assert.deepEqual(assignments.map((line) => /extensions\.gen_random_bytes\(32\)/.test(line) && !/digest\s*\(|gen_random_uuid\s*\(/.test(line)), [true]);
    });
  });

  db('rejects a missing version with 42501', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId } = await seed(tx);
      await asRole(tx, 'authenticated', ownerId);
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${randomUUID()}::uuid)`), '42501');
      await tx.unsafe('reset role');
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from public.preview_links where owner_id = ${ownerId}::uuid`;
      assert.equal(row.n, 0);
    });
  });

  db('rejects a create with no user before it looks up a version', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      await asRole(tx, 'authenticated');
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${versionId}::uuid)`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${randomUUID()}::uuid)`), '42501');
      await tx.unsafe('reset role');
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from public.preview_links where owner_id = ${ownerId}::uuid`;
      assert.equal(row.n, 0);
    });
  });

  db('lets an admin revoke and refuses another user and anon', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, otherId, gameId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      const adminId = randomUUID();
      await tx`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${adminId}::uuid, 'authenticated', 'authenticated', ${`${adminId}@example.test`}, '', now(), now())
      `;
      await tx`insert into public.profiles (id, handle, role) values (${adminId}::uuid, ${`a${gameId.slice(2)}`}, 'admin')`;
      await asRole(tx, 'authenticated', otherId);
      assert.equal(await codeOf(tx, (sp) => sp`select public.admin_revoke_preview_link(${link.id}::uuid)`), '42501');
      await asRole(tx, 'anon');
      assert.equal(await codeOf(tx, (sp) => sp`select public.admin_revoke_preview_link(${link.id}::uuid)`), '42501');
      await asRole(tx, 'authenticated', ownerId);
      assert.equal(await codeOf(tx, (sp) => sp`select public.admin_revoke_preview_link(${link.id}::uuid)`), '42501');
      await tx.unsafe('reset role');
      assert.equal(await views(tx, link.id), 0);
      const [open] = await tx<{ revoked_at: Date | null }[]>`select revoked_at from public.preview_links where id = ${link.id}::uuid`;
      assert.equal(open.revoked_at, null);
      const [unaudited] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.admin_actions where game_id = ${gameId}
      `;
      assert.equal(unaudited.n, 0);
      await asRole(tx, 'authenticated', adminId);
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${versionId}::uuid)`), '42501');
      assert.deepEqual([...(await tx<{ id: string }[]>`select id from public.preview_links`)], []);
      await tx`select public.admin_revoke_preview_link(${link.id}::uuid)`;
      await tx.unsafe('reset role');
      const [first] = await tx<{ revoked_at: Date }[]>`select revoked_at from public.preview_links where id = ${link.id}::uuid`;
      await asRole(tx, 'authenticated', adminId);
      await tx`select public.admin_revoke_preview_link(${link.id}::uuid)`;
      assert.equal(await codeOf(tx, (sp) => sp`select public.admin_revoke_preview_link(${randomUUID()}::uuid)`), '42501');
      await tx.unsafe('reset role');
      const [second] = await tx<{ revoked_at: Date }[]>`select revoked_at from public.preview_links where id = ${link.id}::uuid`;
      assert.equal(second.revoked_at.toISOString(), first.revoked_at.toISOString());
      const [audited] = await tx<{ matched: number; total: number }[]>`
        select
          count(*) filter (
            where a.action = 'revoke_preview'
              and a.before->>'preview_link_id' = ${link.id}
              and jsonb_typeof(a.before->'revoked_at') = 'null'
              and a.after->>'preview_link_id' = ${link.id}
              and (a.after->>'revoked_at')::timestamptz = (
                select l.revoked_at from public.preview_links as l where l.id = ${link.id}::uuid
              )
          )::int as matched,
          count(*)::int as total
        from public.admin_actions as a
        where a.game_id = ${gameId}
      `;
      assert.equal(audited.matched, 1);
      assert.equal(audited.total, 1);
      assert.deepEqual(await play(tx, link.token), []);
      const [anonExec] = await tx<{ anon_exec: boolean; auth_exec: boolean }[]>`
        select
          has_function_privilege('anon', 'public.admin_revoke_preview_link(uuid)', 'execute') as anon_exec,
          has_function_privilege('authenticated', 'public.admin_revoke_preview_link(uuid)', 'execute') as auth_exec
      `;
      assert.equal(anonExec.anon_exec, false);
      assert.equal(anonExec.auth_exec, true);
    });
  });

  db('refuses admin revoke when the caller has no profile', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      const strayId = randomUUID();
      await tx`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${strayId}::uuid, 'authenticated', 'authenticated', ${`${strayId}@example.test`}, '', now(), now())
      `;
      await asRole(tx, 'authenticated', strayId);
      assert.equal(await codeOf(tx, (sp) => sp`select public.admin_revoke_preview_link(${link.id}::uuid)`), '42501');
      await tx.unsafe('reset role');
      const [open] = await tx<{ revoked_at: Date | null; audits: number }[]>`
        select l.revoked_at, (select count(*)::int from public.admin_actions where game_id = ${gameId}) as audits
        from public.preview_links as l
        where l.id = ${link.id}::uuid
      `;
      assert.equal(open.revoked_at, null);
      assert.equal(open.audits, 0);
    });
  });

  db('leaves the other link on that version open when an admin revokes one', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId, gameId } = await seed(tx);
      const first = await mint(tx, ownerId, versionId);
      const sibling = await mint(tx, ownerId, versionId);
      const adminId = randomUUID();
      await tx`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${adminId}::uuid, 'authenticated', 'authenticated', ${`${adminId}@example.test`}, '', now(), now())
      `;
      await tx`insert into public.profiles (id, handle, role) values (${adminId}::uuid, ${`b${gameId.slice(2)}`}, 'admin')`;
      await asRole(tx, 'authenticated', adminId);
      await tx`select public.admin_revoke_preview_link(${first.id}::uuid)`;
      await tx.unsafe('reset role');
      const [rows] = await tx<{ target: Date | null; other: Date | null; audits: number }[]>`
        select
          (select revoked_at from public.preview_links where id = ${first.id}::uuid) as target,
          (select revoked_at from public.preview_links where id = ${sibling.id}::uuid) as other,
          (select count(*)::int from public.admin_actions where game_id = ${gameId}) as audits
      `;
      assert.ok(rows.target);
      assert.equal(rows.other, null);
      assert.equal(rows.audits, 1);
      assert.deepEqual(await play(tx, first.token), []);
      assert.equal((await play(tx, sibling.token)).length, 1);
      assert.equal(await views(tx, sibling.id), 1);
      assert.equal(await views(tx, first.id), 0);
    });
  });

  db('writes one audit row when two admins revoke one link at the same time', async (sql) => {
    const dbUrl = localDbUrl();
    if (!dbUrl) return;
    const ownerId = randomUUID();
    const admins = [randomUUID(), randomUUID()];
    const gameId = `pl${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const clients = admins.map((_, index) => postgres(dbUrl, {
      max: 1,
      idle_timeout: 30,
      connect_timeout: 3,
      connection: { application_name: `preview-admin-${index}` },
    }));
    const holder = postgres(dbUrl, { max: 1, idle_timeout: 30, connect_timeout: 3 });
    const probe = postgres(dbUrl, { max: 1, idle_timeout: 1, connect_timeout: 3 });
    let releaseHold = () => {};
    let holding: Promise<unknown> = Promise.resolve();
    const attempts: Promise<string>[] = [];
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${`h${gameId.slice(2)}`})`;
      for (const [index, adminId] of admins.entries()) {
        await sql`
          insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
          values ('00000000-0000-0000-0000-000000000000', ${adminId}::uuid, 'authenticated', 'authenticated', ${`${adminId}@example.test`}, '', now(), now())
        `;
        await sql`insert into public.profiles (id, handle, role) values (${adminId}::uuid, ${`a${index}${gameId.slice(2, 12)}`}, 'admin')`;
      }
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, 'owner', 'Preview Title', 'pending')
      `;
      const [version] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${bundle('34')}, 'passed')
        returning id
      `;
      const link = await sql.begin((tx) => mint(tx, ownerId, version.id));
      const pids = await Promise.all(clients.map(async (client) => {
        const [row] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
        return row.pid;
      }));
      assert.equal(new Set(pids).size, clients.length);
      let markLocked = () => {};
      const locked = new Promise<void>((resolve) => { markLocked = resolve; });
      const holdGate = new Promise<void>((resolve) => { releaseHold = resolve; });
      holding = holder.begin(async (tx) => {
        await tx`select id from public.preview_links where id = ${link.id}::uuid for update`;
        markLocked();
        await holdGate;
      });
      await locked;
      attempts.push(...clients.map(async (client, index) => {
        await client.unsafe(`set lock_timeout = '4s'`);
        return client.begin(async (tx) => {
          await asRole(tx, 'authenticated', admins[index]);
          await tx`select public.admin_revoke_preview_link(${link.id}::uuid)`;
          await tx.unsafe('reset role');
          const [seen] = await tx<{ revoked_at: string }[]>`
            select revoked_at::text as revoked_at from public.preview_links where id = ${link.id}::uuid
          `;
          return seen.revoked_at;
        });
      }));
      await waitForLocks(probe, pids);
      releaseHold();
      await holding;
      const stamps = await Promise.all(attempts);
      const [row] = await probe<{ revoked_at: string; total: number; matched: number }[]>`
        select
          l.revoked_at::text as revoked_at,
          (
            select count(*)::int from public.admin_actions as a where a.game_id = ${gameId}
          ) as total,
          (
            select count(*)::int
            from public.admin_actions as a
            where a.game_id = ${gameId}
              and a.action = 'revoke_preview'
              and a.before->>'preview_link_id' = ${link.id}
              and jsonb_typeof(a.before->'revoked_at') = 'null'
              and a.after->>'preview_link_id' = ${link.id}
              and (a.after->>'revoked_at')::timestamptz = l.revoked_at
          ) as matched
        from public.preview_links as l
        where l.id = ${link.id}::uuid
      `;
      assert.equal(stamps[0], stamps[1]);
      assert.equal(row.revoked_at, stamps[0]);
      assert.equal(row.total, 1);
      assert.equal(row.matched, 1);
    } finally {
      releaseHold();
      await Promise.allSettled([holding, ...attempts]);
      await Promise.all([holder, probe, ...clients].map((client) => client.end({ timeout: 1 }).catch(() => {})));
      await sql`delete from public.admin_actions where game_id = ${gameId}`;
      await sql`delete from auth.users where id in (${ownerId}::uuid, ${admins[0]}::uuid, ${admins[1]}::uuid)`;
    }
  });

  db('stops the eleventh create within an hour after the earlier links are revoked', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const ids: string[] = [];
      for (let n = 0; n < 10; n += 1) {
        const link = await mint(tx, ownerId, versionId);
        ids.push(link.id);
        await asRole(tx, 'authenticated', ownerId);
        await tx`select public.revoke_preview_link(${link.id}::uuid)`;
        await tx.unsafe('reset role');
      }
      await asRole(tx, 'authenticated', ownerId);
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${versionId}::uuid)`), 'P0001');
      await tx.unsafe('reset role');
      const [blocked] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.preview_links
        where owner_id = ${ownerId}::uuid and created_at > now() - interval '1 hour'
      `;
      assert.equal(blocked.n, 10);
      await tx`update public.preview_links set created_at = now() - interval '2 hours' where owner_id = ${ownerId}::uuid`;
      const again = await mint(tx, ownerId, versionId);
      const [row] = await tx<{ exact: boolean; recent: number }[]>`
        select expires_at = created_at + interval '7 days' as exact,
               (select count(*)::int from public.preview_links
                 where owner_id = ${ownerId}::uuid and created_at > now() - interval '1 hour') as recent
        from public.preview_links where id = ${again.id}::uuid
      `;
      assert.equal(row.exact, true);
      assert.equal(row.recent, 1);
      assert.equal(ids.length, 10);
    });
  });

  db('counts a create in the past hour and not on the one-hour boundary', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const plant = async (shift: '61m' | '45m' | 'boundary' | 'inside') => {
        await tx`delete from public.preview_links where owner_id = ${ownerId}::uuid`;
        if (shift === '61m') {
          await tx`
            insert into public.preview_links (version_id, owner_id, token_hash, expires_at, revoked_at, created_at)
            select ${versionId}::uuid, ${ownerId}::uuid, extensions.gen_random_bytes(32), now() + interval '7 days', now(), now() - interval '61 minutes'
            from generate_series(1, 10)
          `;
        } else if (shift === '45m') {
          await tx`
            insert into public.preview_links (version_id, owner_id, token_hash, expires_at, revoked_at, created_at)
            select ${versionId}::uuid, ${ownerId}::uuid, extensions.gen_random_bytes(32), now() + interval '7 days', now(), now() - interval '45 minutes'
            from generate_series(1, 10)
          `;
        } else if (shift === 'boundary') {
          await tx`
            insert into public.preview_links (version_id, owner_id, token_hash, expires_at, revoked_at, created_at)
            select ${versionId}::uuid, ${ownerId}::uuid, extensions.gen_random_bytes(32), now() + interval '7 days', now(), now() - interval '1 hour'
            from generate_series(1, 10)
          `;
        } else {
          await tx`
            insert into public.preview_links (version_id, owner_id, token_hash, expires_at, revoked_at, created_at)
            select ${versionId}::uuid, ${ownerId}::uuid, extensions.gen_random_bytes(32), now() + interval '7 days', now(), now() - interval '1 hour' + interval '1 second'
            from generate_series(1, 10)
          `;
        }
      };
      const attempt = async (): Promise<string | null> => {
        await asRole(tx, 'authenticated', ownerId);
        let code: string | null = null;
        try {
          await tx.savepoint(async (sp) => {
            await sp`select * from public.create_preview_link(${versionId}::uuid)`;
          });
        } catch (err) {
          if (!(err instanceof postgres.PostgresError)) throw err;
          code = err.code;
          assert.equal(err.message, 'preview_link_hour');
        }
        await tx.unsafe('reset role');
        return code;
      };
      const recent = async () => (await tx<{ n: number }[]>`
        select count(*)::int as n from public.preview_links
        where owner_id = ${ownerId}::uuid and created_at > now() - interval '1 hour'
      `)[0].n;
      await plant('61m');
      assert.equal(await attempt(), null);
      assert.equal(await recent(), 1);
      await plant('45m');
      assert.equal(await attempt(), 'P0001');
      assert.equal(await recent(), 10);
      await plant('boundary');
      assert.equal(await attempt(), null);
      assert.equal(await recent(), 1);
      await plant('inside');
      assert.equal(await attempt(), 'P0001');
      assert.equal(await recent(), 10);
    });
  });

  db('caps ten creates an hour across versions when earlier links are revoked', async (sql) => {
    const dbUrl = localDbUrl();
    if (!dbUrl) return;
    const ownerId = randomUUID();
    const gameId = `pl${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const clients = Array.from({ length: 4 }, (_, index) => postgres(dbUrl, {
      max: 1,
      idle_timeout: 30,
      connect_timeout: 3,
      connection: { application_name: `preview-hour-${index}` },
    }));
    const probe = postgres(dbUrl, { max: 1, idle_timeout: 1, connect_timeout: 3 });
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${`h${gameId.slice(2)}`})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage, tags)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, 'owner', 'Hour', 'pending', '{}')
      `;
      const versionRows = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values
          (${gameId}, 1, ${bundle('ef')}, 'passed'),
          (${gameId}, 2, ${bundle('12')}, 'passed'),
          (${gameId}, 3, ${bundle('34')}, 'passed'),
          (${gameId}, 4, ${bundle('56')}, 'passed')
        returning id
      `;
      const versions = versionRows.map((row) => row.id);
      assert.equal(versions.length, 4);
      await sql`
        insert into public.preview_links (version_id, owner_id, token_hash, expires_at, revoked_at)
        select ${versions[0]}::uuid, ${ownerId}::uuid, extensions.gen_random_bytes(32), now() + interval '7 days', now()
        from generate_series(1, 8)
      `;
      await Promise.all(clients.map((client) => client.unsafe(`set lock_timeout = '2s'`)));
      const pids = await Promise.all(clients.map(async (client) => {
        const [row] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
        return row.pid;
      }));
      assert.equal(new Set(pids).size, clients.length);
      let arrived = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const attempts = await Promise.allSettled(clients.map(async (client, index) => {
        arrived += 1;
        if (arrived === clients.length) release();
        await gate;
        await client.begin(async (tx) => {
          await asRole(tx, 'authenticated', ownerId);
          await tx`select * from public.create_preview_link(${versions[index]}::uuid)`;
        });
      }));
      const codes = attempts.map((attempt) => (attempt.status === 'fulfilled' ? 'ok' : pgCode(attempt.reason) ?? 'other')).sort();
      assert.deepEqual(codes, ['P0001', 'P0001', 'ok', 'ok']);
      const [counts] = await probe<{ hour: number; active: number }[]>`
        select
          count(*) filter (where created_at > now() - interval '1 hour')::int as hour,
          count(*) filter (where revoked_at is null and expires_at > now())::int as active
        from public.preview_links
        where owner_id = ${ownerId}::uuid
      `;
      assert.equal(counts.hour, 10);
      assert.equal(counts.active, 2);
      const [held] = await probe<{ ok: boolean }[]>`
        select pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended('preview_link:' || ${ownerId}::text, 0)
        ) as ok
      `;
      assert.equal(held.ok, true);
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 1 }).catch(() => {})));
      await probe.end({ timeout: 1 }).catch(() => {});
      await sql`delete from auth.users where id = ${ownerId}::uuid`;
    }
  });

  db('lets the owner list a link without reading token_hash', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      await asRole(tx, 'authenticated', ownerId);
      const [row] = await tx<{
        id: string; version_id: string; owner_id: string; view_count: number; revoked_at: Date | null;
      }[]>`
        select id, version_id, owner_id, expires_at, revoked_at, view_count, created_at
        from public.preview_links
      `;
      assert.equal(row.id, link.id);
      assert.equal(row.version_id, versionId);
      assert.equal(row.owner_id, ownerId);
      assert.equal(row.view_count, 0);
      assert.equal(row.revoked_at, null);
      assert.equal(await codeOf(tx, (sp) => sp`select token_hash from public.preview_links`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.preview_links`), '42501');
      const [hash] = await tx<{ hash_select: boolean; id_select: boolean }[]>`
        select
          has_column_privilege('authenticated', 'public.preview_links', 'token_hash', 'select') as hash_select,
          has_column_privilege('authenticated', 'public.preview_links', 'id', 'select') as id_select
      `;
      assert.equal(hash.hash_select, false);
      assert.equal(hash.id_select, true);
    });
  });

  db('denies service_role every table grant and every preview function', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      await asRole(tx, 'service_role', ownerId);
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.create_preview_link(${versionId}::uuid)`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select public.revoke_preview_link(${link.id}::uuid)`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select public.admin_revoke_preview_link(${link.id}::uuid)`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select * from public.resolve_preview_link(${link.token})`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select id from public.preview_links`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select token_hash from public.preview_links`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`
        insert into public.preview_links (version_id, owner_id, token_hash, expires_at)
        values (${versionId}::uuid, ${ownerId}::uuid, decode(${bundle('22')}, 'hex'), now() + interval '1 day')
      `), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`update public.preview_links set view_count = 0`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`delete from public.preview_links`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select event from public.preview_link_audit`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select private.preview_link_audit('created', ${link.id}::uuid)`), '42501');
      await tx.unsafe('reset role');
      const [priv] = await tx<{
        sel: boolean; ins: boolean; upd: boolean; del: boolean;
        create_fn: boolean; revoke_fn: boolean; admin_fn: boolean; resolve_fn: boolean; hash_col: boolean;
        audit_sel: boolean; audit_ins: boolean; audit_upd: boolean; audit_del: boolean;
        audit_fn: boolean; audit_trg: boolean;
      }[]>`
        select
          has_table_privilege('service_role', 'public.preview_links', 'select') as sel,
          has_table_privilege('service_role', 'public.preview_links', 'insert') as ins,
          has_table_privilege('service_role', 'public.preview_links', 'update') as upd,
          has_table_privilege('service_role', 'public.preview_links', 'delete') as del,
          has_function_privilege('service_role', 'public.create_preview_link(uuid, integer)', 'execute') as create_fn,
          has_function_privilege('service_role', 'public.revoke_preview_link(uuid)', 'execute') as revoke_fn,
          has_function_privilege('service_role', 'public.admin_revoke_preview_link(uuid)', 'execute') as admin_fn,
          has_function_privilege('service_role', 'public.resolve_preview_link(text)', 'execute') as resolve_fn,
          has_column_privilege('service_role', 'public.preview_links', 'token_hash', 'select') as hash_col,
          has_table_privilege('service_role', 'public.preview_link_audit', 'select') as audit_sel,
          has_table_privilege('service_role', 'public.preview_link_audit', 'insert') as audit_ins,
          has_table_privilege('service_role', 'public.preview_link_audit', 'update') as audit_upd,
          has_table_privilege('service_role', 'public.preview_link_audit', 'delete') as audit_del,
          has_function_privilege('service_role', 'private.preview_link_audit(text, uuid)', 'execute') as audit_fn,
          has_function_privilege('service_role', 'private.preview_link_audit_from_link()', 'execute') as audit_trg
      `;
      assert.deepEqual(priv, {
        sel: false, ins: false, upd: false, del: false,
        create_fn: false, revoke_fn: false, admin_fn: false, resolve_fn: false, hash_col: false,
        audit_sel: false, audit_ins: false, audit_upd: false, audit_del: false,
        audit_fn: false, audit_trg: false,
      });
      const [kept] = await tx<{ n: number; revoked_at: Date | null }[]>`
        select count(*)::int as n, max(revoked_at) as revoked_at
        from public.preview_links where owner_id = ${ownerId}::uuid
      `;
      assert.equal(kept.n, 1);
      assert.equal(kept.revoked_at, null);
    });
  });

  db('keeps an unapproved game with an active preview link out of public lists', async (sql) => {
    const dbUrl = localDbUrl();
    if (!dbUrl) return;
    process.env.DATABASE_URL ??= dbUrl;
    process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
    process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test';
    process.env.SUPABASE_SECRET_KEY ??= 'test';
    const { listGames, listGamesByIds, listTags, getGame, platformStats } = await import('../../src/lib/server/games.ts');
    const ownerId = randomUUID();
    const gameId = `pl${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const liveId = `lv${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const tag = `t${gameId.slice(2, 8)}`;
    const pendingTag = `p${gameId.slice(2, 8)}`;
    const liveTag = `l${gameId.slice(2, 8)}`;
    const creator = `c${gameId.slice(2)}`;
    const pendingCreator = `p${gameId.slice(2)}`;
    try {
      const before = await platformStats();
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${`h${gameId.slice(2)}`})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage, tags)
        values
          (${gameId}, ${gameId}, ${ownerId}::uuid, ${pendingCreator}, 'Unapproved Preview', 'pending', ${sql.array([tag, pendingTag])}),
          (${liveId}, ${liveId}, ${ownerId}::uuid, ${creator}, 'Live Control', 'live', ${sql.array([tag, liveTag])})
      `;
      const filler = `f${gameId.slice(2)}`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage, tags)
        select ${filler} || g::text, ${filler} || g::text, ${ownerId}::uuid, ${pendingCreator}, 'Pending tag', 'pending', ${[pendingTag]}
        from generate_series(1, 40) as g
      `;
      const [version] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${bundle('56')}, 'passed')
        returning id
      `;
      const link = await sql.begin((tx) => mint(tx, ownerId, version.id));
      assert.equal((await sql.begin((tx) => play(tx, link.token))).length, 1);
      const ids = (games: { id: string }[]) => games.map((game) => game.id).filter((id) => id === gameId || id === liveId).sort();
      assert.deepEqual(ids(await listGames({ creator, limit: 50 })), [liveId]);
      assert.deepEqual(ids(await listGames({ tag, limit: 50 })), [liveId]);
      assert.deepEqual(ids(await listGamesByIds([gameId, liveId])), [liveId]);
      assert.deepEqual(ids(await listGames({ creator, includeUnpublished: true, includeUnlisted: true, limit: 50 })), [liveId]);
      assert.deepEqual(ids(await listGames({ creator: pendingCreator, limit: 50 })), []);
      const tags = await listTags();
      assert.equal(tags.some((row) => row.tag === pendingTag), false);
      assert.equal(tags.find((row) => row.tag === liveTag)?.count, 1);
      assert.equal(await getGame(gameId), null);
      assert.equal((await getGame(liveId))?.id, liveId);
      const after = await platformStats();
      assert.ok(before);
      assert.ok(after);
      assert.equal(after.games, before.games + 1);
      assert.equal(after.live, before.live + 1);
      assert.equal(after.creators, before.creators + 1);
      const rpcs = await sql<{ name: string }[]>`
        select p.proname as name
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname ~* 'sitemap|search'
          and (
            has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute')
          )
      `;
      assert.equal(rpcs.length, 0);
      await sql.begin(async (tx) => {
        await asRole(tx, 'anon');
        assert.equal(await codeOf(tx, (sp) => sp`select id from public.games where id = ${gameId}`), '42501');
        assert.equal(await codeOf(tx, (sp) => sp`select id from public.games_awaiting_review where id = ${gameId}`), '42501');
        await asRole(tx, 'authenticated', ownerId);
        assert.equal(await codeOf(tx, (sp) => sp`select id from public.games where id = ${gameId}`), '42501');
      });
    } finally {
      await sql`delete from auth.users where id = ${ownerId}::uuid`;
    }
  });

  db('pins 404 for malformed link id, unvalidated game, and revoke RPC errors', async (sql) => {
    const dbUrl = localDbUrl();
    if (!dbUrl) return;
    process.env.DATABASE_URL ??= dbUrl;
    process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
    process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test';
    process.env.SUPABASE_SECRET_KEY ??= 'test';
    const { createPreviewLink, revokePreviewLink } = await import('../../src/lib/server/preview-links.ts');
    const ownerId = randomUUID();
    const gameId = `pl${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const unvalidatedGameId = `nv${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${`h${gameId.slice(2)}`})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage)
        values
          (${gameId}, ${gameId}, ${ownerId}::uuid, 'creator', 'Preview Game', 'pending'),
          (${unvalidatedGameId}, ${unvalidatedGameId}, ${ownerId}::uuid, 'creator', 'Unvalidated Game', 'pending')
      `;
      const [version] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${bundle('56')}, 'passed')
        returning id
      `;
      const link = await sql.begin((tx) => mint(tx, ownerId, version.id));

      const mockSupabase = {
        rpc: async () => ({ data: null, error: new Error('rpc failure') }),
      } as unknown as Parameters<typeof revokePreviewLink>[0]['supabase'];

      const malformedRes = await revokePreviewLink({
        supabase: mockSupabase,
        gameId,
        linkId: 'not-a-uuid',
        userId: ownerId,
      });
      assert.deepEqual(malformedRes, { kind: 'error', status: 404, message: 'Not found' });

      const noValidationRes = await createPreviewLink({
        supabase: mockSupabase,
        gameId: unvalidatedGameId,
        userId: ownerId,
        ttlHours: 24,
      });
      assert.deepEqual(noValidationRes, { kind: 'error', status: 404, message: 'Not found' });

      const rpcErrorRes = await revokePreviewLink({
        supabase: mockSupabase,
        gameId,
        linkId: link.id,
        userId: ownerId,
      });
      assert.deepEqual(rpcErrorRes, { kind: 'error', status: 404, message: 'Not found' });
    } finally {
      await sql`delete from auth.users where id = ${ownerId}::uuid`;
    }
  });
});

type AuditFact = { event: string; actor: string };

async function auditFacts(tx: Sql, uid: string, linkId: string): Promise<AuditFact[]> {
  await asRole(tx, 'authenticated', uid);
  const rows = await tx<{ event: string; link_id: string; actor: string }[]>`
    select event, link_id, actor from public.preview_link_audit order by event
  `;
  await tx.unsafe('reset role');
  return rows.filter((row) => row.link_id === linkId).map((row) => ({ event: row.event, actor: row.actor }));
}

describe('preview link audit', () => {
  db('logs each event once for the creator and leaves misses uncounted', async (sql) => {
    await rollback(sql, async (tx) => {
      const { ownerId, otherId, gameId, versionId } = await seed(tx);
      const link = await mint(tx, ownerId, versionId);
      const creator = { event: 'created', actor: ownerId };
      assert.deepEqual(await auditFacts(tx, ownerId, link.id), [creator]);

      assert.deepEqual(await play(tx, 'not-a-real-preview-token'), []);
      assert.equal(await views(tx, link.id), 0);
      assert.deepEqual(await auditFacts(tx, ownerId, link.id), [creator]);

      assert.equal((await play(tx, link.token)).length, 1);
      assert.equal(await views(tx, link.id), 1);
      assert.deepEqual(await auditFacts(tx, ownerId, link.id), [creator]);

      await tx`update public.game_validations set status = 'failed' where id = ${versionId}::uuid`;
      assert.deepEqual(await play(tx, link.token), []);
      assert.equal(await views(tx, link.id), 1);
      assert.deepEqual(await auditFacts(tx, ownerId, link.id), [creator]);
      await tx`update public.game_validations set status = 'passed' where id = ${versionId}::uuid`;

      await asRole(tx, 'authenticated', ownerId);
      await tx`select public.revoke_preview_link(${link.id}::uuid)`;
      const [first] = await tx<{ revoked_at: Date }[]>`select revoked_at from public.preview_links where id = ${link.id}::uuid`;
      await tx`select public.revoke_preview_link(${link.id}::uuid)`;
      const [second] = await tx<{ revoked_at: Date }[]>`select revoked_at from public.preview_links where id = ${link.id}::uuid`;
      await tx.unsafe('reset role');
      assert.equal(second.revoked_at.toISOString(), first.revoked_at.toISOString());
      assert.deepEqual(await play(tx, link.token), []);
      assert.equal(await views(tx, link.id), 1);
      assert.deepEqual(await auditFacts(tx, ownerId, link.id), [creator, { event: 'revoked', actor: ownerId }]);

      await tx`update public.preview_links set expires_at = now() where id = ${link.id}::uuid`;
      const unknown = await play(tx, 'not-a-real-preview-token');
      const expired = await play(tx, link.token);
      assert.deepEqual(unknown, expired);
      assert.deepEqual(expired, []);
      assert.equal(await views(tx, link.id), 1);
      assert.deepEqual(await play(tx, link.token), []);
      assert.equal(await views(tx, link.id), 1);
      assert.deepEqual(await auditFacts(tx, ownerId, link.id), [
        creator,
        { event: 'expired_hit', actor: ownerId },
        { event: 'revoked', actor: ownerId },
      ]);

      const probed = await mint(tx, ownerId, versionId);
      await tx`update public.preview_links set expires_at = now() where id = ${probed.id}::uuid`;
      await asRole(tx, 'authenticated', otherId);
      assert.deepEqual([...(await tx<{ version_id: string }[]>`select * from public.resolve_preview_link(${probed.token})`)], []);
      await tx.unsafe('reset role');
      assert.equal(await views(tx, probed.id), 0);
      assert.deepEqual(await auditFacts(tx, ownerId, probed.id), [
        { event: 'created', actor: ownerId },
        { event: 'expired_hit', actor: ownerId },
      ]);
      await tx`update public.preview_link_audit set at = timestamptz '2000-01-01+00' where link_id = ${probed.id}::uuid and event = 'expired_hit'`;
      assert.deepEqual(await play(tx, probed.token), []);
      assert.equal(await views(tx, probed.id), 0);
      const [keptHit] = await tx<{ at: Date }[]>`
        select at from public.preview_link_audit where link_id = ${probed.id}::uuid and event = 'expired_hit'
      `;
      assert.equal(keptHit.at.toISOString(), '2000-01-01T00:00:00.000Z');

      await tx`update public.game_validations set status = 'failed' where id = ${versionId}::uuid`;
      const aged = await mint(tx, ownerId, versionId);
      await tx`update public.preview_links set expires_at = now() where id = ${aged.id}::uuid`;
      assert.deepEqual(await play(tx, aged.token), await play(tx, 'not-a-real-preview-token'));
      assert.equal(await views(tx, aged.id), 0);
      assert.deepEqual(await auditFacts(tx, ownerId, aged.id), [
        { event: 'created', actor: ownerId },
        { event: 'expired_hit', actor: ownerId },
      ]);
      await tx`update public.game_validations set status = 'passed' where id = ${versionId}::uuid`;

      const adminId = randomUUID();
      await tx`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${adminId}::uuid, 'authenticated', 'authenticated', ${`${adminId}@example.test`}, '', now(), now())
      `;
      await tx`insert into public.profiles (id, handle, role) values (${adminId}::uuid, ${`a${gameId.slice(2)}`}, 'admin')`;
      const byAdmin = await mint(tx, ownerId, versionId);
      await asRole(tx, 'authenticated', adminId);
      await tx`select public.admin_revoke_preview_link(${byAdmin.id}::uuid)`;
      await tx`select public.admin_revoke_preview_link(${byAdmin.id}::uuid)`;
      await tx.unsafe('reset role');
      assert.equal(await views(tx, byAdmin.id), 0);
      assert.deepEqual(await play(tx, byAdmin.token), []);
      assert.deepEqual(await auditFacts(tx, ownerId, byAdmin.id), [
        { event: 'created', actor: ownerId },
        { event: 'revoked', actor: ownerId },
      ]);

      const columns = (await tx<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'preview_link_audit'
        order by column_name
      `).map((column) => column.column_name);
      assert.deepEqual(columns, ['actor', 'at', 'event', 'link_id']);

      for (const uid of [otherId, adminId]) {
        await asRole(tx, 'authenticated', uid);
        assert.deepEqual([...(await tx<{ event: string }[]>`select event from public.preview_link_audit`)], []);
      }
      await asRole(tx, 'anon');
      assert.equal(await codeOf(tx, (sp) => sp`select event from public.preview_link_audit`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`select private.preview_link_audit('created', ${link.id}::uuid)`), '42501');
      await asRole(tx, 'authenticated', ownerId);
      assert.equal(await codeOf(tx, (sp) => sp`select private.preview_link_audit('created', ${link.id}::uuid)`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`
        insert into public.preview_link_audit (event, link_id, actor)
        values ('created', ${link.id}::uuid, ${ownerId}::uuid)
      `), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`update public.preview_link_audit set event = 'created'`), '42501');
      assert.equal(await codeOf(tx, (sp) => sp`delete from public.preview_link_audit`), '42501');
      const seen = await auditFacts(tx, ownerId, link.id);
      assert.equal(seen.filter((row) => row.event === 'expired_hit').length, 1);
      assert.equal(seen.every((row) => row.actor === ownerId), true);
    });
  });
});
