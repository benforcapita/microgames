import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import postgres from 'postgres';
import { createHandler } from '../../../cdn/handler.mjs';
import { mintPreviewToken } from '../../../cdn/preview-token.mjs';
import { gameFrameSrc } from '../../client/frame-src.ts';
import type { BundleStorage } from './bundle-store.ts';

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
type ReplaceBundle = typeof import('./games.ts').replaceGameBundle;
type DeleteGame = typeof import('./games.ts').deleteGame;
type IpSubject = typeof import('./abuse.ts').sessionIpSubject;
type AdmitPreview = typeof import('./abuse.ts').admitPreviewPage;

let openPreviewLink: OpenPreview;
let listGames: ListGames;
let listGamesByIds: ListGamesByIds;
let listTags: ListTags;
let getGame: GetGame;
let replaceGameBundle: ReplaceBundle;
let deleteGame: DeleteGame;
let sessionIpSubject: IpSubject;
let admitPreviewPage: AdmitPreview;
let sql: postgres.Sql;

if (probeOk && dbUrl) {
  ({ openPreviewLink } = await import('./preview-play.ts'));
  ({ listGames, listGamesByIds, listTags, getGame, replaceGameBundle, deleteGame } = await import('./games.ts'));
  ({ sessionIpSubject, admitPreviewPage } = await import('./abuse.ts'));
  ({ sql } = await import('./db.ts'));
}

const sha = 'ab'.repeat(32);
const failedSha = 'ef'.repeat(32);

function htmlBytes(marker: string): Uint8Array {
  return new TextEncoder().encode(`<!doctype html><html><body>${marker}</body></html>`);
}

function memoryBundles(): BundleStorage & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async upload(path, bytes) {
      files.set(path, new Uint8Array(bytes));
      return { error: null };
    },
    async remove(paths) {
      for (const path of paths) files.delete(path);
      return { error: null };
    },
    async download(path) {
      const data = files.get(path);
      if (!data) return { data: null, error: { message: 'Object not found' } };
      return { data, error: null };
    },
  };
}

function playCdn(files: Map<string, Uint8Array>, version: number | (() => number)) {
  const previewSecret = process.env.CDN_PREVIEW_SECRET ?? SECRET;
  const currentVersion = () => (typeof version === 'function' ? version() : version);
  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.pathname === '/rest/v1/games') return Response.json([{ stage: 'pending' }]);
    if (u.pathname === '/rest/v1/game_validations') return Response.json([{ version: currentVersion() }]);
    const prefix = '/storage/v1/object/authenticated/games/';
    if (u.pathname.startsWith(prefix)) {
      const body = files.get(decodeURIComponent(u.pathname.slice(prefix.length)));
      if (body) return new Response(new TextDecoder().decode(body));
    }
    return new Response('missing', { status: 404 });
  };
  const handle = createHandler({
    supabaseUrl: 'http://sb.local',
    secret: 'sb_secret_x',
    webOrigins: 'http://portal.test',
    previewSecret,
    cdnOrigin: 'http://cdn.test',
    fetch: fakeFetch,
  });
  return async (path: string) => {
    let status = 0;
    let body = '';
    const headers: Record<string, string> = {};
    const res = {
      writeHead(code: number, h: Record<string, string>) {
        status = code;
        for (const [key, value] of Object.entries(h)) headers[key.toLowerCase()] = value;
      },
      end(chunk?: unknown) { body = chunk === undefined ? '' : String(chunk); },
    };
    await handle({ method: 'GET', url: path, headers: {} } as never, res as never);
    return { status, body, headers };
  };
}

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
      assert.equal(play.version, 1);
      const parts = play.previewToken.split('.');
      assert.equal(parts.length, 3);
      assert.equal(Number(parts[1]), 1);
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

  it('serves the linked bundle after a later upload fails validation', async (t) => {
    if (!probeOk || !sql || !dbUrl) {
      t.skip('local supabase is not running');
      return;
    }
    const ownerId = randomUUID();
    const gameId = `pv${randomBytes(4).toString('hex')}`;
    const title = `Quarry ${gameId}`;
    const creator = `cr${gameId}`.slice(0, 32);
    const bundles = memoryBundles();
    const v1 = htmlBytes('BUNDLE-V1');
    const v2 = htmlBytes('BUNDLE-V2-FAILED');
    const v3 = htmlBytes('BUNDLE-V3-FAILED');
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${creator})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, ${creator}, ${title}, 'pending')
      `;
      const [version] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${sha}, 'passed')
        returning id
      `;
      bundles.files.set(`${gameId}/index.html`, v1);
      const replaced = await replaceGameBundle({ gameKey: gameId, ownerId, html: v2 }, bundles);
      assert.equal(replaced.ok, true);
      assert.equal(new TextDecoder().decode(bundles.files.get(`${gameId}/1/index.html`)), new TextDecoder().decode(v1));
      assert.equal(new TextDecoder().decode(bundles.files.get(`${gameId}/index.html`)), new TextDecoder().decode(v2));
      const again = await replaceGameBundle({ gameKey: gameId, ownerId, html: v3 }, bundles);
      assert.equal(again.ok, true);
      assert.equal(new TextDecoder().decode(bundles.files.get(`${gameId}/1/index.html`)), new TextDecoder().decode(v1));
      assert.equal(new TextDecoder().decode(bundles.files.get(`${gameId}/index.html`)), new TextDecoder().decode(v3));
      await sql`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 2, ${failedSha}, 'failed')
      `;
      const [link] = await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
        await tx.unsafe('set local role authenticated');
        return tx<{ token: string }[]>`select token from public.create_preview_link(${version.id}::uuid)`;
      });
      const play = await openPreviewLink({ token: link.token, ip: `lane-${gameId}` });
      assert.equal(play.kind, 'play');
      if (play.kind !== 'play') return;
      assert.equal(play.version, 1);
      const src = new URL(gameFrameSrc('http://cdn.test', play.gameId, 'http://portal.test', '{}', play.previewToken, play.version));
      assert.match(src.pathname, new RegExp(`^/g/${gameId}/1/~pt/[^/]+/index\\.html$`));
      assert.equal(src.searchParams.get('pt'), null);
      const get = playCdn(bundles.files, 2);
      const doc = await get(`${src.pathname}${src.search}`);
      assert.equal(doc.status, 200);
      assert.match(doc.body, /BUNDLE-V1/);
      assert.equal(doc.body.includes('BUNDLE-V2-FAILED'), false);
      assert.equal(doc.body.includes('BUNDLE-V3-FAILED'), false);
      const owner = mintPreviewToken(process.env.CDN_PREVIEW_SECRET ?? SECRET, gameId);
      const latest = await get(`/g/${gameId}/2/index.html?pt=${owner}`);
      assert.equal(latest.status, 200);
      assert.match(latest.body, /BUNDLE-V3-FAILED/);
      assert.equal(latest.body.includes('BUNDLE-V1'), false);
      const wrong = await get(`/g/${gameId}/2/index.html?pt=${encodeURIComponent(play.previewToken)}`);
      const unversioned = await get(`/g/${gameId}/index.html?pt=${encodeURIComponent(play.previewToken)}`);
      assert.equal(wrong.status, 404);
      assert.equal(unversioned.status, 404);
      assert.equal(wrong.body.includes('BUNDLE-V3-FAILED'), false);
      assert.equal(unversioned.body.includes('BUNDLE-V3-FAILED'), false);
      const blank = await openPreviewLink({ token: link.token, ip: `lane-${gameId}-secret`, previewSecret: '' });
      const unknown = await openPreviewLink({ token: token(), ip: `lane-${gameId}-miss` });
      assert.deepEqual(blank, { kind: 'miss' });
      assert.deepEqual(blank, unknown);
      await sql`update public.games set stage = 'rejected' where id = ${gameId}`;
      const rejected = await openPreviewLink({ token: link.token, ip: `lane-${gameId}-rej` });
      const rejectedMiss = await openPreviewLink({ token: token(), ip: `lane-${gameId}-rej-miss` });
      assert.deepEqual(rejected, { kind: 'miss' });
      assert.deepEqual(rejected, rejectedMiss);
      await sql`update public.games set stage = 'pending' where id = ${gameId}`;
      const restored = await openPreviewLink({ token: link.token, ip: `lane-${gameId}-back` });
      assert.equal(restored.kind, 'play');
      if (restored.kind === 'play') assert.equal(restored.version, 1);
      await sql`
        insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies)
        values (${gameId}, ${sha}, 'nsfw', 'confirmed', true)
      `;
      const tagged = await openPreviewLink({ token: link.token, ip: `lane-${gameId}-nsfw` });
      const taggedMiss = await openPreviewLink({ token: token(), ip: `lane-${gameId}-nsfw-miss` });
      assert.deepEqual(tagged, { kind: 'miss' });
      assert.deepEqual(tagged, taggedMiss);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql`delete from public.profiles where id = ${ownerId}::uuid`.catch(() => {});
      await sql`delete from auth.users where id = ${ownerId}::uuid`.catch(() => {});
    }
  });

  it('counts a valid preview open and stops the next one before resolving it', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const ownerId = randomUUID();
    const gameId = `lm${randomBytes(4).toString('hex')}`;
    const now = Date.UTC(2026, 9, 22, 8, 0, 0);
    const ip = `lane-${gameId}`;
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${gameId})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, ${gameId}, 'Limited', 'pending')
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
      for (let n = 0; n < 59; n += 1) {
        assert.equal((await openPreviewLink({ token: token(), ip, now })).kind, 'miss');
      }
      assert.equal((await openPreviewLink({ token: link.token, ip, now })).kind, 'play');
      const [opened] = await sql<{ view_count: number }[]>`
        select view_count from public.preview_links where id = ${link.id}::uuid
      `;
      assert.equal(opened.view_count, 1);
      assert.equal((await openPreviewLink({ token: link.token, ip, now })).kind, 'limited');
      const [row] = await sql<{ view_count: number }[]>`
        select view_count from public.preview_links where id = ${link.id}::uuid
      `;
      assert.equal(row.view_count, 1);
    } finally {
      const subject = sessionIpSubject(ip, process.env.MG_IP_HASH_SECRET ?? '', new Date(now));
      await sql`delete from public.preview_page_hits where subject = ${subject}`.catch(() => {});
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql`delete from public.profiles where id = ${ownerId}::uuid`.catch(() => {});
      await sql`delete from auth.users where id = ${ownerId}::uuid`.catch(() => {});
    }
  });

  it('admits exactly 60 of 120 parallel preview opens for one address', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const now = Date.UTC(2027, 4, 2, 3, 4, 5);
    const ip = `lane-lock-${randomBytes(4).toString('hex')}`;
    const subject = sessionIpSubject(ip, process.env.MG_IP_HASH_SECRET ?? '', new Date(now));
    try {
      await sql`delete from public.preview_page_hits where subject = ${subject}`;
      const results = await Promise.all(Array.from({ length: 120 }, () => openPreviewLink({ token: token(), ip, now })));
      assert.equal(results.filter((result) => result.kind === 'miss').length, 60);
      assert.equal(results.filter((result) => result.kind === 'limited').length, 60);
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.preview_page_hits where subject = ${subject}
      `;
      assert.equal(row.n, 60);
    } finally {
      await sql`delete from public.preview_page_hits where subject = ${subject}`.catch(() => {});
    }
  });

  it('refuses a preview admission when the address secret is missing or short', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const now = Date.UTC(2028, 1, 2, 1, 2, 3);
    const ip = `lane-weak-${randomBytes(4).toString('hex')}`;
    const weak = 'x'.repeat(31);
    const subject = sessionIpSubject(ip, weak, new Date(now));
    try {
      await assert.rejects(() => sql.begin((tx) => admitPreviewPage(tx, ip, now, '')), /MG_IP_HASH_SECRET/);
      await assert.rejects(() => sql.begin((tx) => admitPreviewPage(tx, ip, now, weak)), /MG_IP_HASH_SECRET/);
      const rows = await sql`select 1 from public.preview_page_hits where subject = ${subject}`;
      assert.equal(rows.length, 0);
    } finally {
      await sql`delete from public.preview_page_hits where subject = ${subject}`.catch(() => {});
    }
  });

  it('plays the passed v2 bundle after v1 was opened and tagged nsfw', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const ownerId = randomUUID();
    const gameId = `pv${randomBytes(4).toString('hex')}`;
    const creator = `cr${gameId}`.slice(0, 32);
    const bundles = memoryBundles();
    const v1 = htmlBytes('BUNDLE-V1');
    const v2 = htmlBytes('BUNDLE-V2');
    const passed2 = 'cd'.repeat(32);
    let current = 1;
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${creator})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, ${creator}, ${`Quarry ${gameId}`}, 'pending')
      `;
      const [version] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${sha}, 'passed')
        returning id
      `;
      bundles.files.set(`${gameId}/index.html`, v1);
      const mint = async (versionId: string) => {
        const [link] = await sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
          await tx.unsafe('set local role authenticated');
          return tx<{ token: string }[]>`select token from public.create_preview_link(${versionId}::uuid)`;
        });
        return link.token;
      };
      const firstToken = await mint(version.id);
      const first = await openPreviewLink({ token: firstToken, ip: `lane-${gameId}-v1` });
      assert.equal(first.kind, 'play');
      if (first.kind !== 'play') return;
      assert.equal(first.version, 1);
      const get = playCdn(bundles.files, () => current);
      const v1Src = new URL(gameFrameSrc('http://cdn.test', first.gameId, 'http://portal.test', '{}', first.previewToken, first.version));
      const opened = await get(`${v1Src.pathname}${v1Src.search}`);
      assert.equal(opened.status, 200);
      assert.match(opened.body, /BUNDLE-V1/);
      await sql`
        insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies)
        values (${gameId}, ${sha}, 'nsfw', 'confirmed', true)
      `;
      const killed = await openPreviewLink({ token: firstToken, ip: `lane-${gameId}-nsfw` });
      const unknown = await openPreviewLink({ token: token(), ip: `lane-${gameId}-miss` });
      assert.deepEqual(killed, { kind: 'miss' });
      assert.deepEqual(killed, unknown);
      const replaced = await replaceGameBundle({ gameKey: gameId, ownerId, html: v2 }, bundles);
      assert.equal(replaced.ok, true);
      const [next] = await sql<{ id: string }[]>`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 2, ${passed2}, 'passed')
        returning id
      `;
      current = 2;
      const secondToken = await mint(next.id);
      const second = await openPreviewLink({ token: secondToken, ip: `lane-${gameId}-v2` });
      assert.equal(second.kind, 'play');
      if (second.kind !== 'play') return;
      assert.equal(second.version, 2);
      const v2Src = new URL(gameFrameSrc('http://cdn.test', second.gameId, 'http://portal.test', '{}', second.previewToken, second.version));
      const passed = await get(`${v2Src.pathname}${v2Src.search}`);
      assert.equal(passed.status, 200);
      assert.match(passed.body, /BUNDLE-V2/);
      assert.equal(passed.body.includes('BUNDLE-V1'), false);
      const still = await get(`${v1Src.pathname}${v1Src.search}`);
      assert.equal(still.status, 200);
      assert.match(still.body, /BUNDLE-V1/);
      assert.equal(still.body.includes('BUNDLE-V2'), false);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql`delete from public.profiles where id = ${ownerId}::uuid`.catch(() => {});
      await sql`delete from auth.users where id = ${ownerId}::uuid`.catch(() => {});
    }
  });

  it('archives the latest validation, surfaces an archive upload error, and deletes every archive', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    const ownerId = randomUUID();
    const gameId = `ar${randomBytes(4).toString('hex')}`;
    const bundles = memoryBundles();
    const v1 = htmlBytes('ARCHIVE-V1');
    const v2 = htmlBytes('ARCHIVE-V2');
    const v3 = htmlBytes('ARCHIVE-V3');
    const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array());
    try {
      await sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
      `;
      await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${gameId})`;
      await sql`
        insert into public.games (id, slug, owner_id, creator, title, stage)
        values (${gameId}, ${gameId}, ${ownerId}::uuid, ${gameId}, 'Archive', 'pending')
      `;
      await sql`
        insert into public.game_validations (game_id, version, bundle_sha256, status)
        values (${gameId}, 1, ${sha}, 'passed'), (${gameId}, 2, ${'cd'.repeat(32)}, 'passed')
      `;
      bundles.files.set(`${gameId}/1/index.html`, v1);
      bundles.files.set(`${gameId}/index.html`, v2);
      const replaced = await replaceGameBundle({ gameKey: gameId, ownerId, html: v3 }, bundles);
      assert.equal(replaced.ok, true);
      assert.equal(decode(bundles.files.get(`${gameId}/1/index.html`)), decode(v1));
      assert.equal(decode(bundles.files.get(`${gameId}/2/index.html`)), decode(v2));
      assert.equal(decode(bundles.files.get(`${gameId}/index.html`)), decode(v3));

      const refused = memoryBundles();
      refused.files.set(`${gameId}/index.html`, v1);
      const upload = refused.upload.bind(refused);
      refused.upload = async (path, bytes, contentType) => (
        path === `${gameId}/2/index.html` ? { error: { message: 'archive refused' } } : upload(path, bytes, contentType)
      );
      await assert.rejects(
        () => replaceGameBundle({ gameKey: gameId, ownerId, html: v3 }, refused),
        /archive refused/,
      );
      assert.equal(decode(refused.files.get(`${gameId}/index.html`)), decode(v1));
      assert.equal(refused.files.has(`${gameId}/2/index.html`), false);

      const removed: string[] = [];
      const deleted = await deleteGame(gameId, ownerId, {
        async remove(paths) {
          removed.push(...paths);
          return { error: null };
        },
      });
      assert.equal(deleted, true);
      assert.ok(removed.includes(`${gameId}/index.html`));
      assert.ok(removed.includes(`${gameId}/1/index.html`));
      assert.ok(removed.includes(`${gameId}/2/index.html`));
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql`delete from public.profiles where id = ${ownerId}::uuid`.catch(() => {});
      await sql`delete from auth.users where id = ${ownerId}::uuid`.catch(() => {});
    }
  });
});
