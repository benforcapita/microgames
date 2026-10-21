import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import postgres from 'postgres';

const SECRET = 'preview-play-test-secret-0000000000';
const rawUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function localUrl(): string | undefined {
  try {
    const host = new URL(rawUrl).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') return undefined;
  } catch {
    return undefined;
  }
  return rawUrl;
}

const dbUrl = localUrl();
if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
  process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
  process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-publishable';
  process.env.SUPABASE_SECRET_KEY ??= 'test-secret';
  process.env.CDN_PREVIEW_SECRET ??= SECRET;
  process.env.MG_IP_HASH_SECRET ??= SECRET;
}

let probeOk = false;
let probe: postgres.Sql | undefined;
if (dbUrl) {
  probe = postgres(dbUrl, { connect_timeout: 3, max: 1, onnotice: () => {} });
  try {
    await probe`select 1`;
    probeOk = true;
  } catch {
    probeOk = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

type OpenPreview = typeof import('./preview-play.ts').openPreviewLink;
type ListGames = typeof import('./games.ts').listGames;
type ListGamesByIds = typeof import('./games.ts').listGamesByIds;
type ListTags = typeof import('./games.ts').listTags;
type GetGame = typeof import('./games.ts').getGame;
type IpSubject = typeof import('./abuse.ts').sessionIpSubject;

let openPreviewLink: OpenPreview;
let listGames: ListGames;
let listGamesByIds: ListGamesByIds;
let listTags: ListTags;
let getGame: GetGame;
let sessionIpSubject: IpSubject;
let sql: postgres.Sql;

if (probeOk && dbUrl) {
  ({ openPreviewLink } = await import('./preview-play.ts'));
  ({ listGames, listGamesByIds, listTags, getGame } = await import('./games.ts'));
  ({ sessionIpSubject } = await import('./abuse.ts'));
  ({ sql } = await import('./db.ts'));
}

const sha = 'ab'.repeat(32);

function token(): string {
  return randomBytes(32).toString('base64url');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('preview play', () => {
  const ips = ['lane-a', 'lane-b'];

  after(async () => {
    if (!sql) return;
    const subjects = ips.map((ip) => sessionIpSubject(ip, process.env.MG_IP_HASH_SECRET ?? '', new Date()));
    await sql`delete from public.preview_page_hits where subject in ${sql(subjects)}`.catch(() => {});
    await sql.end({ timeout: 1 }).catch(() => {});
  });

  it('plays one version for a valid link and misses every dead link the same way', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const ownerId = randomUUID();
    const gameId = `pv${randomBytes(4).toString('hex')}`;
    const title = `Quarry ${gameId}`;
    const tag = `tg${gameId}`;
    const creator = `cr${gameId}`.slice(0, 32);
    const liveId = `lv${randomBytes(4).toString('hex')}`;
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${creator})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, tags, stage)
        values (${liveId}, ${liveId}, ${ownerId}::uuid, ${creator}, ${'Live ' + gameId}, '{}', 'live')
      `;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, tags, stage, forked_from)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, ${creator}, ${title}, ${[tag]}, 'pending', ${liveId})
      `;
      const [version] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${sha}, 'passed')
        returning id
      `;
      await sql`insert into public.featured_games (game_id, position, label, active) values (${gameId}, 0, 'hidden', true)`;
      const [link] = await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
        await tx.unsafe('set local role authenticated');
        return tx<{ id: string; token: string }[]>`select id, token from public.create_preview_link(${version.id}::uuid)`;
      });

      const listed = async () => {
        const [byCreator, byTag, optedIn, byFork, byId, direct, bySlug, tags] = await Promise.all([
          listGames({ creator, limit: 50 }),
          listGames({ tag, limit: 50 }),
          listGames({ creator, includeUnpublished: true, includeUnlisted: true, limit: 50 }),
          listGames({ forkedFrom: liveId, limit: 50 }),
          listGamesByIds([gameId, liveId]),
          getGame(gameId),
          getGame(gameId),
          listTags(),
        ]);
        return { byCreator, byTag, optedIn, byFork, byId, direct, bySlug, tags };
      };
      const before = await listed();
      const play = await openPreviewLink({ token: link.token, ip: 'lane-play' });
      const after = await listed();
      assert.equal(play.kind, 'play');
      if (play.kind !== 'play') return;
      assert.equal(play.gameId, gameId);
      assert.equal(play.title, title);
      assert.equal(play.previewToken.split('.').length, 2);
      for (const snap of [before, after]) {
        for (const rows of [snap.byCreator, snap.byTag, snap.optedIn, snap.byFork, snap.byId]) {
          assert.equal(rows.some((game) => game.id === gameId || game.title === title), false);
        }
        assert.equal(snap.direct, null);
        assert.equal(snap.bySlug, null);
        assert.equal(snap.tags.some((row) => row.tag === tag), false);
        assert.equal(snap.byId.some((game) => game.id === liveId), true);
      }

      const [expired] = await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
        await tx.unsafe('set local role authenticated');
        return tx<{ id: string; token: string }[]>`select id, token from public.create_preview_link(${version.id}::uuid)`;
      });
      await sql`update public.preview_links set expires_at = now() where id = ${expired.id}::uuid`;
      const [revoked] = await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
        await tx.unsafe('set local role authenticated');
        const rows = await tx<{ id: string; token: string }[]>`select id, token from public.create_preview_link(${version.id}::uuid)`;
        await tx`select public.revoke_preview_link(${rows[0].id}::uuid)`;
        return rows;
      });

      const miss = { kind: 'miss' as const };
      const samples: { kind: string }[] = [];
      for (const value of [token(), expired.token, revoked.token, 'x', 'not a token', 'z'.repeat(180)]) {
        samples.push(await openPreviewLink({ token: value, ip: `lane-${gameId}` }));
      }
      assert.deepEqual(samples, samples.map(() => miss));

      await sql`update public.games set stage = 'rejected' where id = ${gameId}`;
      assert.deepEqual(await openPreviewLink({ token: link.token, ip: `lane-${gameId}` }), miss);
      await sql`update public.games set stage = 'pending' where id = ${gameId}`;
      await sql`
        insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies)
        values (${gameId}, ${sha}, 'nsfw', 'confirmed', true)
      `;
      assert.deepEqual(await openPreviewLink({ token: link.token, ip: `lane-${gameId}` }), miss);
      await sql`delete from public.game_tags where game_id = ${gameId}`;
      assert.equal((await openPreviewLink({ token: link.token, ip: `lane-${gameId}-2` })).kind, 'play');

      const [views] = await sql<{ view_count: number }[]>`
        select view_count from public.preview_links where id = ${link.id}::uuid
      `;
      assert.equal(views.view_count, 2);
    } finally {
      await sql`delete from public.games where id in (${gameId}, ${liveId})`.catch(() => {});
      await sql`delete from public.profiles where id = ${ownerId}::uuid`.catch(() => {});
      await sql`delete from auth.users where id = ${ownerId}::uuid`.catch(() => {});
    }
  });

  it('allows 60 preview opens per hashed address each minute and stores no raw address', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const now = Date.UTC(2026, 9, 21, 12, 0, 0);
    const at = new Date(now);
    const subjectA = sessionIpSubject('lane-a', process.env.MG_IP_HASH_SECRET ?? '', at);
    const subjectB = sessionIpSubject('lane-b', process.env.MG_IP_HASH_SECRET ?? '', at);
    await sql`delete from public.preview_page_hits where subject in ${sql([subjectA, subjectB])}`;
    try {
      for (let n = 0; n < 60; n += 1) {
        assert.equal((await openPreviewLink({ token: token(), ip: 'lane-a', now })).kind, 'miss');
      }
      assert.equal((await openPreviewLink({ token: token(), ip: 'lane-a', now })).kind, 'limited');
      assert.equal((await openPreviewLink({ token: token(), ip: 'lane-b', now })).kind, 'miss');
      assert.equal((await openPreviewLink({ token: token(), ip: 'lane-a', now: now + 60_000 })).kind, 'miss');
      const rows = await sql<{ subject: string }[]>`
        select subject from public.preview_page_hits where subject in ${sql([subjectA, subjectB])}
      `;
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.match(row.subject, /^[0-9a-f]{64}$/);
        assert.equal(row.subject === 'lane-a' || row.subject === 'lane-b', false);
      }
    } finally {
      await sql`delete from public.preview_page_hits where subject in ${sql([subjectA, subjectB])}`;
    }
  });

  it('logs a failure without the link token', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const marker = `marker-${randomBytes(8).toString('hex')}`;
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      assert.equal((await openPreviewLink({ token: marker, ip: 'lane-log', now: Number.NaN })).kind, 'error');
      const flat = JSON.stringify(logs);
      assert.equal(flat.includes(marker), false);
      assert.match(flat, /preview play failed/);
    } finally {
      console.error = original;
    }
  });

  it('misses unknown, expired and malformed links in comparable time', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const ownerId = randomUUID();
    const gameId = `tm${randomBytes(4).toString('hex')}`;
    const ip = `lane-${gameId}`;
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${gameId})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, ${gameId}, 'Timed', 'pending')
      `;
      const [version] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${sha}, 'passed')
        returning id
      `;
      const [link] = await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
        await tx.unsafe('set local role authenticated');
        return tx<{ id: string; token: string }[]>`select id, token from public.create_preview_link(${version.id}::uuid)`;
      });
      await sql`update public.preview_links set expires_at = now() where id = ${link.id}::uuid`;
      const time = async (value: string) => {
        const samples: number[] = [];
        for (let n = 0; n < 5; n += 1) {
          const start = performance.now();
          assert.equal((await openPreviewLink({ token: value, ip })).kind, 'miss');
          samples.push(performance.now() - start);
        }
        return median(samples);
      };
      await time(token());
      await time(link.token);
      await time('x');
      const unknown = await time(token());
      const expired = await time(link.token);
      const malformed = await time('x');
      const fastest = Math.min(unknown, expired, malformed);
      const slowest = Math.max(unknown, expired, malformed);
      assert.ok(fastest > 0);
      assert.ok(slowest / fastest < 12);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql`delete from public.profiles where id = ${ownerId}::uuid`.catch(() => {});
      await sql`delete from auth.users where id = ${ownerId}::uuid`.catch(() => {});
    }
  });

  it('refuses anon and authenticated access to preview page hits', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const [row] = await sql<{ rls: boolean; policies: number }[]>`
      select c.relrowsecurity as rls,
             (select count(*)::int from pg_policies p
              where p.schemaname = 'public' and p.tablename = 'preview_page_hits') as policies
      from pg_class c
      where c.oid = 'public.preview_page_hits'::regclass
    `;
    assert.equal(row.rls, true);
    assert.equal(row.policies, 0);
    await sql.begin(async (tx) => {
      for (const role of ['anon', 'authenticated']) {
        await tx.unsafe(`set local role ${role}`);
        for (const query of [
          'select 1 from public.preview_page_hits limit 1',
          `insert into public.preview_page_hits (subject) values ('probe')`,
          'delete from public.preview_page_hits',
        ]) {
          let code = 'ok';
          try {
            await tx.savepoint(async (sp) => {
              await sp.unsafe(query);
            });
          } catch (err) {
            code = err instanceof postgres.PostgresError ? err.code : 'unknown';
          }
          assert.equal(code, '42501');
        }
        await tx.unsafe('reset role');
      }
    });
  });
});
