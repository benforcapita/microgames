// MR-1 behavior against the local stack only. Skips when that stack is not running.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { createHandler } from '../../../cdn/handler.mjs';
import {
  assessAssetUpload,
  saveFinalizedAsset,
  type AssetStorage,
} from './asset-upload.ts';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let isLocal = false;
try {
  const parsed = new URL(url);
  isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
} catch {
  isLocal = false;
}

if (isLocal) {
  process.env.DATABASE_URL = url;
  process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
  process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test';
  process.env.SUPABASE_SECRET_KEY ??= 'test';
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

let sql: typeof import('./db.ts').sql;
let getGame: typeof import('./games.ts').getGame;
let readSubmission: typeof import('./submissions.ts').readSubmission;
let sqlSubmissionStore: typeof import('./submissions-db.ts').sqlSubmissionStore;

if (probeOk) {
  sql = (await import('./db.ts')).sql;
  getGame = (await import('./games.ts')).getGame;
  readSubmission = (await import('./submissions.ts')).readSubmission;
  sqlSubmissionStore = (await import('./submissions-db.ts')).sqlSubmissionStore;
}

const userId = randomUUID();
const otherId = randomUUID();
const handle = `mr${userId.replace(/-/g, '').slice(0, 12)}`;
const pendingId = `mrpend${userId.replace(/-/g, '').slice(0, 8)}`;
const versionId = `mrver${userId.replace(/-/g, '').slice(0, 8)}`;
const legacyId = `mrleg${userId.replace(/-/g, '').slice(0, 8)}`;
const assetId = `mrast${userId.replace(/-/g, '').slice(0, 8)}`;
const sha = (n: string) => n.repeat(32);
const passReport = { status: 'pass', checks: [] as [] };

function skip(t: { skip: (message?: string) => void }) {
  if (!probeOk || !sql) {
    t.skip('local supabase is not running');
    return true;
  }
  return false;
}

describe('manual review (db)', () => {
  before(async () => {
    if (!probeOk || !sql) return;
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${userId}, 'authenticated', 'authenticated',
              ${`${handle}@example.com`}, '', now(), now())`;
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${otherId}, 'authenticated', 'authenticated',
              ${`o${handle}@example.com`}, '', now(), now())`;
    await sql`insert into public.profiles (id, handle) values (${userId}, ${handle}), (${otherId}, ${'o' + handle})`;
  });

  after(async () => {
    if (!sql) return;
    try {
      await sql`delete from public.games where id in (${pendingId}, ${versionId}, ${`${versionId}p`}, ${legacyId}, ${assetId})`;
      await sql`delete from public.profiles where id in (${userId}, ${otherId})`;
      await sql`delete from auth.users where id in (${userId}, ${otherId})`;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('anon, authenticated, and public cannot read games_awaiting_review', async (t) => {
    if (skip(t)) return;
    for (const role of ['anon', 'authenticated', 'public']) {
      const [row] = await sql<{ ok: boolean }[]>`
        select has_table_privilege(${role}, 'public.games_awaiting_review', 'SELECT') as ok`;
      assert.equal(row?.ok, false, role);
    }
    const [opts] = await sql<{ reloptions: string[] | null }[]>`
      select c.reloptions
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'games_awaiting_review'`;
    assert.ok(opts?.reloptions?.some((opt) => opt.startsWith('security_invoker=')), 'security_invoker');
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(
        () => sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select * from public.games_awaiting_review`;
        }),
        (err: unknown) => err instanceof Error && /permission denied/i.test(err.message),
      );
    }
  });

  it('a passed pending game is private, the owner can open it, and approving publishes it', async (t) => {
    if (skip(t)) return;
    await sql`
      insert into public.games (id, slug, title, creator, owner_id, stage)
      values (${pendingId}, ${pendingId}, 'Awaiting', ${handle}, ${userId}, 'pending')`;

    assert.equal(await getGame(pendingId), null);
    assert.equal(await getGame(pendingId, { viewerId: otherId }), null);
    assert.equal((await getGame(pendingId, { viewerId: userId }))?.title, 'Awaiting');

    const [recorded] = await sql<{ stage: string }[]>`
      select stage from public.record_game_validation(${pendingId}, ${sha('ab')}, 'passed', ${sql.json(passReport)})`;
    assert.equal(recorded?.stage, 'pending');
    const [unstamped] = await sql<{ reviewed_at: Date | null }[]>`
      select reviewed_at from public.games where id = ${pendingId}`;
    assert.equal(unstamped?.reviewed_at, null);

    const [queued] = await sql<{ preview_link: string; handle: string }[]>`
      select handle, preview_link from public.games_awaiting_review where id = ${pendingId}`;
    assert.equal(queued?.handle, handle);
    assert.equal(queued?.preview_link, `/play/${pendingId}`);

    await sql`update public.games set stage = 'proving' where id = ${pendingId}`;
    assert.equal((await getGame(pendingId))?.stage, 'proving');
    const stillQueued = await sql`select id from public.games_awaiting_review where id = ${pendingId}`;
    assert.equal(stillQueued.length, 0);

    await sql`update public.games set stage = 'rejected', review_note = ${'Needs a pause button.'} where id = ${pendingId}`;
    assert.equal(await getGame(pendingId), null);
    assert.equal(await getGame(pendingId, { viewerId: otherId }), null);
    const owner = await getGame(pendingId, { viewerId: userId });
    assert.equal(owner?.stage, 'rejected');
    assert.equal(owner?.reviewNote, 'Needs a pause button.');
    const submission = await readSubmission({ userId, gameId: pendingId, store: sqlSubmissionStore });
    assert.equal(submission.status, 200);
    if (submission.status === 200) {
      assert.equal(submission.view.headline, 'Rejected');
      assert.equal(submission.view.game.reviewNote, 'Needs a pause button.');
    }
    const hidden = await readSubmission({ userId: otherId, gameId: pendingId, store: sqlSubmissionStore });
    assert.equal(hidden.status, 404);
  });

  it('setting stage to the same public stage advances reviewed_at and does not demote the game', async (t) => {
    if (skip(t)) return;
    for (const stage of ['proving', 'live'] as const) {
      const id = stage === 'live' ? versionId : `${versionId}p`;
      await sql`
        insert into public.games (id, slug, title, creator, owner_id, stage)
        values (${id}, ${id}, 'Reviewed', ${handle}, ${userId}, ${stage})`;
      await sql`update public.games set reviewed_at = '2000-01-01T00:00:00Z' where id = ${id}`;
      await sql`update public.games set stage = ${stage} where id = ${id}`;
      const [row] = await sql<{ stage: string; reviewed_at: Date }[]>`
        select stage, reviewed_at from public.games where id = ${id}`;
      assert.ok(row);
      assert.equal(row.stage, stage);
      assert.ok(row.reviewed_at > new Date('2000-01-01T00:00:00Z'));
      if (stage !== 'live') await sql`delete from public.games where id = ${id}`;
    }
  });

  it('a failed validation does not stamp reviewed_at', async (t) => {
    if (skip(t)) return;
    const id = `mrfail${userId.replace(/-/g, '').slice(0, 8)}`;
    try {
      await sql`
        insert into public.games (id, slug, title, creator, stage)
        values (${id}, ${id}, 'Failed', 'legacy', 'pending')`;
      const [row] = await sql<{ stage: string }[]>`
        select stage from public.record_game_validation(${id}, ${sha('ff')}, 'failed', ${sql.json({ status: 'fail', checks: [] })})`;
      assert.equal(row?.stage, 'rejected');
      const [game] = await sql<{ reviewed_at: Date | null }[]>`select reviewed_at from public.games where id = ${id}`;
      assert.equal(game?.reviewed_at, null);
      const queued = await sql`select id from public.games_awaiting_review where id = ${id}`;
      assert.equal(queued.length, 0);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });

  it('an asset upload on a public game is hidden until a reviewer publishes it again', async (t) => {
    if (skip(t)) return;
    const bytes = new TextEncoder().encode('const extra = 1;\n');
    await sql`
      insert into public.games (id, slug, title, creator, owner_id, stage)
      values (${assetId}, ${assetId}, 'Assets', ${handle}, ${userId}, 'pending')`;
    await sql`select stage from public.record_game_validation(${assetId}, ${sha('aa')}, 'passed', ${sql.json(passReport)})`;
    await sql`update public.games set stage = 'live' where id = ${assetId}`;
    const [approved] = await sql<{ reviewed_at: Date }[]>`select reviewed_at from public.games where id = ${assetId}`;
    assert.ok(approved);
    assert.equal((await getGame(assetId))?.stage, 'live');

    const decision = assessAssetUpload({
      userId: userId,
      ownerId: userId,
      rawPath: 'sprites/extra.js',
      adding: true,
      bytes,
      existing: null,
      codeBytes: 100,
      uploadedBytes: 0,
      fileCount: 0,
      rateAllowed: true,
    });
    assert.equal(decision.kind, 'store');
    if (decision.kind !== 'store') return;
    const storage: AssetStorage = {
      async upload() { return { error: null }; },
      async remove() { return { error: null }; },
    };
    const saved = await saveFinalizedAsset(sql, storage, assetId, 1, decision, bytes);
    assert.deepEqual(saved, { ok: true });

    const [held] = await sql<{ stage: string; reviewed_at: Date }[]>`
      select stage, reviewed_at from public.games where id = ${assetId}`;
    assert.ok(held);
    assert.equal(held.stage, 'pending');
    assert.equal(held.reviewed_at.getTime(), approved.reviewed_at.getTime());
    assert.equal(await getGame(assetId), null);
    assert.equal(await getGame(assetId, { viewerId: otherId }), null);
    const [queued] = await sql<{ id: string }[]>`select id from public.games_awaiting_review where id = ${assetId}`;
    assert.equal(queued?.id, assetId);
    const [asset] = await sql<{ status: string }[]>`
      select status from public.game_assets where game_id = ${assetId} and path = 'sprites/extra.js'`;
    assert.equal(asset?.status, 'uploaded');

    const hidden = await cdnGet(assetId, '/g/' + assetId + '/1/sprites/extra.js', bytes);
    assert.equal(hidden.status, 404);
    assert.equal((await cdnGet(assetId, '/g/' + assetId + '/1/index.html', bytes)).status, 404);

    await sql`update public.games set reviewed_at = '2000-01-01T00:00:00Z' where id = ${assetId}`;
    await sql`update public.games set stage = 'live' where id = ${assetId}`;
    const [republished] = await sql<{ stage: string; reviewed_at: Date }[]>`
      select stage, reviewed_at from public.games where id = ${assetId}`;
    assert.ok(republished);
    assert.equal(republished.stage, 'live');
    assert.ok(republished.reviewed_at > new Date('2000-01-01T00:00:00Z'));
    assert.equal((await sql`select id from public.games_awaiting_review where id = ${assetId}`).length, 0);
    assert.equal((await getGame(assetId))?.stage, 'live');

    const shown = await cdnGet(assetId, '/g/' + assetId + '/1/sprites/extra.js', bytes);
    assert.equal(shown.status, 200);
    assert.match(shown.body, /const extra/);
    const doc = await cdnGet(assetId, '/g/' + assetId + '/index.html', bytes);
    assert.equal(doc.status, 302);
    assert.match(doc.headers.location ?? '', new RegExp(`/g/${assetId}/1/index\\.html$`));
    assert.equal((await cdnGet(assetId, '/g/' + assetId + '/1/index.html', bytes)).status, 200);
  });

  it('an already-proving game keeps its stage and is not backfilled into the queue', async (t) => {
    if (skip(t)) return;
    await sql`
      insert into public.games (id, slug, title, creator, stage)
      values (${legacyId}, ${legacyId}, 'Legacy', 'legacy', 'proving')`;
    const [row] = await sql<{ stage: string; reviewed_at: Date | null }[]>`
      select stage, reviewed_at from public.games where id = ${legacyId}`;
    assert.equal(row?.stage, 'proving');
    assert.equal(row?.reviewed_at, null);
    const queued = await sql`select id from public.games_awaiting_review where id = ${legacyId}`;
    assert.equal(queued.length, 0);
  });

  it('manual review off still publishes a pass to proving', async (t) => {
    if (skip(t)) return;
    const id = `mroff${userId.replace(/-/g, '').slice(0, 8)}`;
    try {
      await sql`
        insert into public.games (id, slug, title, creator, stage)
        values (${id}, ${id}, 'Auto', 'legacy', 'pending')`;
      const [row] = await sql<{ stage: string }[]>`
        select stage from public.record_game_validation(${id}, ${sha('33')}, 'passed', ${sql.json(passReport)}, false)`;
      assert.equal(row?.stage, 'proving');
      const [game] = await sql<{ reviewed_at: Date | null }[]>`select reviewed_at from public.games where id = ${id}`;
      assert.equal(game?.reviewed_at, null);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });
});

async function cdnGet(gameId: string, path: string, bytes: Uint8Array): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const fakeFetch = async (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/rest/v1/games') {
      const [row] = await sql<{ stage: string }[]>`select stage from public.games where id = ${gameId}`;
      return Response.json(row ? [{ stage: row.stage }] : []);
    }
    if (u.pathname === '/rest/v1/game_validations') return Response.json([{ version: 1 }]);
    if (u.pathname === '/rest/v1/game_assets') {
      const assetPath = decodeURIComponent((u.searchParams.get('path') ?? '').replace(/^eq\./, ''));
      const [row] = await sql<{ status: string }[]>`
        select status from public.game_assets
        where game_id = ${gameId} and version = 1 and path = ${assetPath}`;
      return Response.json(row ? [{ status: row.status }] : []);
    }
    if (u.pathname.includes('/storage/')) {
      const html = '<!doctype html><canvas id="c"></canvas>';
      return new Response(u.pathname.endsWith('/index.html') ? html : new TextDecoder().decode(bytes));
    }
    return new Response('no', { status: 404 });
  };
  const handle = createHandler({
    supabaseUrl: 'http://sb.local',
    secret: 'sb_secret_x',
    webOrigins: 'http://127.0.0.1:4321',
    fetch: fakeFetch as typeof fetch,
    ttlMs: 0,
  });
  let status = 0;
  let body = '';
  const headers: Record<string, string> = {};
  const res = {
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    },
    end(b?: unknown) { body = b === undefined ? '' : String(b); },
  };
  await handle({ method: 'GET', url: path, headers: {} } as never, res as never);
  return { status, body, headers };
}
