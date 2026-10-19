// MR-1 behavior against the local stack only. Skips when that stack is not running.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
let listTags: typeof import('./games.ts').listTags;
let platformStats: typeof import('./games.ts').platformStats;
let readSubmission: typeof import('./submissions.ts').readSubmission;
let sqlSubmissionStore: typeof import('./submissions-db.ts').sqlSubmissionStore;
let readManualReview: typeof import('./manual-review.ts').readManualReview;
let getHealth: typeof import('./games.ts').getHealth;

if (probeOk) {
  sql = (await import('./db.ts')).sql;
  ({ getGame, listTags, platformStats, getHealth } = await import('./games.ts'));
  readSubmission = (await import('./submissions.ts')).readSubmission;
  sqlSubmissionStore = (await import('./submissions-db.ts')).sqlSubmissionStore;
  readManualReview = (await import('./manual-review.ts')).readManualReview;
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
    assert.match(shown.headers['cache-control'] ?? '', /max-age=60/);
    assert.doesNotMatch(shown.headers['cache-control'] ?? '', /immutable|31536000/);
    const doc = await cdnGet(assetId, '/g/' + assetId + '/index.html', bytes);
    assert.equal(doc.status, 302);
    assert.match(doc.headers.location ?? '', new RegExp(`/g/${assetId}/1/index\\.html$`));
    assert.equal((await cdnGet(assetId, '/g/' + assetId + '/1/index.html', bytes)).status, 200);
  });

  it('an already-proving game keeps its stage and is not put in the review queue', async (t) => {
    if (skip(t)) return;
    await sql`
      insert into public.games (id, slug, title, creator, stage)
      values (${legacyId}, ${legacyId}, 'Legacy', 'legacy', 'proving')`;
    const [row] = await sql<{ stage: string; reviewed_at: Date | null }[]>`
      select stage, reviewed_at from public.games where id = ${legacyId}`;
    assert.equal(row?.stage, 'proving');
    assert.ok(row?.reviewed_at, 'inserting a public stage stamps reviewed_at');
    const queued = await sql`select id from public.games_awaiting_review where id = ${legacyId}`;
    assert.equal(queued.length, 0);
  });

  it('a proving game is demoted on upload and returns to the review queue', async (t) => {
    if (skip(t)) return;
    const id = `mrprv${userId.replace(/-/g, '').slice(0, 8)}`;
    const bytes = new TextEncoder().encode('const extra = 1;\n');
    try {
      await sql`
        insert into public.games (id, slug, title, creator, owner_id, stage)
        values (${id}, ${id}, 'Proving', ${handle}, ${userId}, 'pending')`;
      await sql`select stage from public.record_game_validation(${id}, ${sha('b2')}, 'passed', ${sql.json(passReport)})`;
      await sql`update public.games set stage = 'proving' where id = ${id}`;
      const decision = assessAssetUpload({
        userId,
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
      assert.deepEqual(await saveFinalizedAsset(sql, storage, id, 1, decision, bytes), { ok: true });
      const [held] = await sql<{ stage: string }[]>`select stage from public.games where id = ${id}`;
      assert.equal(held?.stage, 'pending');
      assert.equal(await getGame(id), null);
      const [queued] = await sql<{ id: string }[]>`select id from public.games_awaiting_review where id = ${id}`;
      assert.equal(queued?.id, id);
      assert.equal((await cdnGet(id, '/g/' + id + '/1/sprites/extra.js', bytes)).status, 404);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });

  it('anon and authenticated cannot execute review or validation functions', async (t) => {
    if (skip(t)) return;
    const fns = [
      'public.record_game_validation(text, text, text, jsonb, boolean)',
      'public.apply_stored_validation(text, text, boolean)',
      'public.touch_game_review()',
      'public.manual_review_enabled()',
    ];
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const fn of fns) {
        const [row] = await sql<{ ok: boolean }[]>`
          select has_function_privilege(${role}, ${fn}, 'EXECUTE') as ok`;
        assert.equal(row?.ok, false, `${role} ${fn}`);
      }
    }
  });

  it('homepage stats ignore a pending game', async (t) => {
    if (skip(t)) return;
    const id = `mrf6${userId.replace(/-/g, '').slice(0, 8)}`;
    const creator = `mrstat${userId.replace(/-/g, '').slice(0, 8)}`;
    try {
      const before = await platformStats();
      await sql`
        insert into public.games (id, slug, title, creator, stage)
        values (${id}, ${id}, 'Pending stats', ${creator}, 'pending')`;
      await sql`insert into public.sessions (id, game_id) values (${randomUUID()}, ${id})`;
      const after = await platformStats();
      assert.deepEqual(after, before);
      const [live] = await sql<{ n: number }[]>`select count(*)::int as n from public.games where stage = 'live'`;
      assert.equal(after?.live, live?.n);
      assert.equal(after?.games, live?.n);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });

  it('the tag cloud omits a pending tag and keeps a live one', async (t) => {
    if (skip(t)) return;
    const suffix = userId.replace(/-/g, '').slice(0, 8);
    const pendingTag = `zzpend${suffix}`;
    const liveTag = `zzlive${suffix}`;
    const liveId = `mrf7l${suffix}`;
    const prefix = `mrf7${suffix}`;
    try {
      await sql`
        insert into public.games (id, slug, title, creator, stage, tags)
        values (${liveId}, ${liveId}, 'Live tag', 'legacy', 'live', ${[liveTag]})`;
      await sql`
        insert into public.games (id, slug, title, creator, stage, tags)
        select ${prefix} || g::text, ${prefix} || g::text, 'Pending tag', 'legacy', 'pending', ${[pendingTag]}
        from generate_series(1, 40) g`;
      const cloud = await listTags();
      assert.equal(cloud.some((row) => row.tag === pendingTag), false);
      const live = cloud.find((row) => row.tag === liveTag);
      assert.ok(live, 'live tag is in the cloud');
      assert.equal(live?.count, 1);
    } finally {
      await sql`delete from public.games where id = ${liveId} or id like ${prefix + '%'}`;
    }
  });

  it('validate-game reads manual_review_enabled(), not an env flag', async (t) => {
    if (skip(t)) return;
    const prev = process.env.MG_MANUAL_REVIEW;
    const offId = `mro0${userId.replace(/-/g, '').slice(0, 8)}`;
    const onId = `mro1${userId.replace(/-/g, '').slice(0, 8)}`;
    const rollback = new Error('rollback-settings');
    try {
      await sql.begin(async (tx) => {
        process.env.MG_MANUAL_REVIEW = '1';
        await tx`update private.settings set value = '0' where key = 'mg_manual_review'`;
        const [off] = await tx<{ enabled: boolean }[]>`select public.manual_review_enabled() as enabled`;
        assert.equal(off?.enabled, false);
        await tx`
          insert into public.games (id, slug, title, creator, stage)
          values (${offId}, ${offId}, 'Off', 'legacy', 'pending')`;
        const [published] = await tx<{ stage: string }[]>`
          select stage from public.record_game_validation(${offId}, ${sha('01')}, 'passed', ${tx.json(passReport)})`;
        assert.equal(published?.stage, 'proving');
        const [offGame] = await tx<{ reviewed_at: Date | null }[]>`
          select reviewed_at from public.games where id = ${offId}`;
        assert.ok(offGame?.reviewed_at, 'auto-publish stamps reviewed_at');

        process.env.MG_MANUAL_REVIEW = '0';
        await tx`update private.settings set value = '1' where key = 'mg_manual_review'`;
        const [on] = await tx<{ enabled: boolean }[]>`select public.manual_review_enabled() as enabled`;
        assert.equal(on?.enabled, true);
        await tx`
          insert into public.games (id, slug, title, creator, stage)
          values (${onId}, ${onId}, 'On', 'legacy', 'pending')`;
        const [held] = await tx<{ stage: string }[]>`
          select stage from public.record_game_validation(${onId}, ${sha('10')}, 'passed', ${tx.json(passReport)})`;
        assert.equal(held?.stage, 'pending');
        const [onGame] = await tx<{ reviewed_at: Date | null }[]>`
          select reviewed_at from public.games where id = ${onId}`;
        assert.equal(onGame?.reviewed_at, null);
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    } finally {
      if (prev === undefined) delete process.env.MG_MANUAL_REVIEW;
      else process.env.MG_MANUAL_REVIEW = prev;
    }
  });

  it('the portal reads the database setting and does not write it', async (t) => {
    if (skip(t)) return;
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const priv of ['INSERT', 'UPDATE']) {
        const [row] = await sql<{ ok: boolean }[]>`
          select has_table_privilege(${role}, 'private.settings', ${priv}) as ok`;
        assert.equal(row?.ok, false, `${role} ${priv}`);
      }
    }
    const rollback = new Error('rollback-settings');
    try {
      await sql.begin(async (tx) => {
        await tx`update private.settings set value = '0' where key = 'mg_manual_review'`;
        assert.equal(await readManualReview(tx), false);
        const [off] = await tx<{ value: string }[]>`
          select value from private.settings where key = 'mg_manual_review'`;
        assert.equal(off?.value, '0');
        await tx`update private.settings set value = '1' where key = 'mg_manual_review'`;
        assert.equal(await readManualReview(tx), true);
        const [on] = await tx<{ value: string }[]>`
          select value from private.settings where key = 'mg_manual_review'`;
        assert.equal(on?.value, '1');
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
  });

  it('a missing switch row means review is on, and reading it does not write the row', async (t) => {
    if (skip(t)) return;
    const [before] = await sql<{ value: string; mark: string }[]>`
      select value, xmin::text as mark from private.settings where key = 'mg_manual_review'`;
    assert.equal(await readManualReview(), true);
    const [after] = await sql<{ value: string; mark: string }[]>`
      select value, xmin::text as mark from private.settings where key = 'mg_manual_review'`;
    assert.equal(after?.value, before?.value);
    assert.equal(after?.mark, before?.mark, 'readManualReview must not update private.settings');

    const id = `mrmiss${userId.replace(/-/g, '').slice(0, 8)}`;
    const rollback = new Error('rollback-missing-switch');
    try {
      await sql.begin(async (tx) => {
        await tx`delete from private.settings where key = 'mg_manual_review'`;
        const [enabled] = await tx<{ enabled: boolean }[]>`select public.manual_review_enabled() as enabled`;
        assert.equal(enabled?.enabled, true);
        assert.equal(await readManualReview(tx), true);
        await tx`
          insert into public.games (id, slug, title, creator, stage)
          values (${id}, ${id}, 'Missing switch', 'legacy', 'pending')`;
        const [held] = await tx<{ stage: string }[]>`
          select stage from public.record_game_validation(${id}, ${sha('e4')}, 'passed', ${tx.json(passReport)})`;
        assert.equal(held?.stage, 'pending');
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
  });

  it('the sweeper leaves a held game and a demoted live game pending, and still rejects a stuck one at 8', async (t) => {
    if (skip(t)) return;
    const suffix = userId.replace(/-/g, '').slice(0, 8);
    const heldId = `swh${suffix}`;
    const demotedId = `swd${suffix}`;
    const stuckId = `sws${suffix}`;
    const sweeps = 10;
    const rollback = new Error('rollback-sweeper');
    try {
      await sql.begin(async (tx) => {
        // Insert the live game before any pass: a held pass sets skip_review_stamp
        // for the rest of this transaction, and that must not hide the live stamp.
        await tx`
          insert into public.games (id, slug, title, creator, stage, created_at)
          values (${demotedId}, ${demotedId}, 'Demoted', 'legacy', 'live', '1999-01-02')`;
        const [wasLive] = await tx<{ reviewed_at: Date | null }[]>`
          select reviewed_at from public.games where id = ${demotedId}`;
        assert.ok(wasLive?.reviewed_at, 'a live insert is a review');
        await tx`update public.games set stage = 'pending' where id = ${demotedId}`;
        await tx`
          insert into private.validation_dispatch (game_id, attempts, last_dispatched_at, last_reason)
          values (${demotedId}, 8, now() - interval '10 minutes', 'test')`;
        const [demotedVals] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.game_validations where game_id = ${demotedId}`;
        assert.equal(demotedVals?.n, 0, 'a demotion adds no validation row');

        await tx`
          insert into public.games (id, slug, title, creator, stage, created_at)
          values (${heldId}, ${heldId}, 'Held', 'legacy', 'pending', '1999-01-01')`;
        await tx`
          insert into private.validation_dispatch (game_id, attempts, last_dispatched_at, last_reason)
          values (${heldId}, 8, now() - interval '10 minutes', 'test')`;
        const [passed] = await tx<{ stage: string }[]>`
          select stage from public.record_game_validation(${heldId}, ${sha('c1')}, 'passed', ${tx.json(passReport)})`;
        assert.equal(passed?.stage, 'pending');
        const [reset] = await tx<{ attempts: number }[]>`
          select attempts from private.validation_dispatch where game_id = ${heldId}`;
        assert.equal(reset?.attempts, 0, 'a pass resets the dispatch attempts counter');
        await tx`update private.validation_dispatch set attempts = 5 where game_id = ${heldId}`;
        const [applied] = await tx<{ stage: string }[]>`
          select stage from public.apply_stored_validation(${heldId}, ${sha('c1')})`;
        assert.equal(applied?.stage, 'pending');
        const [resetAgain] = await tx<{ attempts: number }[]>`
          select attempts from private.validation_dispatch where game_id = ${heldId}`;
        assert.equal(resetAgain?.attempts, 0, 'applying a stored pass resets the counter too');
        await tx`
          update private.validation_dispatch
             set attempts = 8, last_dispatched_at = now() - interval '10 minutes'
           where game_id = ${heldId}`;

        await tx`
          insert into public.games (id, slug, title, creator, stage, created_at)
          values (${stuckId}, ${stuckId}, 'Stuck', 'legacy', 'pending', '1970-01-01')`;
        await tx`
          insert into private.validation_dispatch (game_id, attempts, last_dispatched_at, last_reason)
          values (${stuckId}, 7, now() - interval '10 minutes', 'test')`;

        const queued = async (id: string) =>
          (await tx<{ id: string }[]>`select id from public.games_awaiting_review where id = ${id}`).length;
        assert.equal(await queued(heldId), 1);
        assert.equal(await queued(demotedId), 1);
        assert.equal(await queued(stuckId), 0);

        await tx`select private.sweep_stuck_pending_games()`;
        const [retried] = await tx<{ stage: string; attempts: number }[]>`
          select g.stage, d.attempts
          from public.games g
          join private.validation_dispatch d on d.game_id = g.id
          where g.id = ${stuckId}`;
        assert.equal(retried?.stage, 'pending', 'seven attempts is a retry, not a rejection');
        assert.equal(retried?.attempts, 7);

        await tx`
          update private.validation_dispatch
             set attempts = 8, last_dispatched_at = now() - interval '10 minutes'
           where game_id = ${stuckId}`;

        for (let i = 0; i < sweeps; i++) await tx`select private.sweep_stuck_pending_games()`;

        const stages = async (id: string) =>
          (await tx<{ stage: string }[]>`select stage from public.games where id = ${id}`)[0]?.stage;
        assert.equal(await stages(heldId), 'pending');
        assert.equal(await stages(demotedId), 'pending');
        assert.equal(await queued(heldId), 1);
        assert.equal(await queued(demotedId), 1);
        const [heldAttempts] = await tx<{ attempts: number }[]>`
          select attempts from private.validation_dispatch where game_id = ${heldId}`;
        assert.equal(heldAttempts?.attempts, 8, 'the sweeper does not touch a game awaiting review');

        assert.equal(await stages(stuckId), 'rejected');
        assert.equal(await queued(stuckId), 0);
        const [errorRow] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.game_validations
          where game_id = ${stuckId} and status = 'error'`;
        assert.equal(errorRow?.n, 1);
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
  });

  it('manual review off still publishes a pass to proving and stamps reviewed_at', async (t) => {
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
      assert.ok(game?.reviewed_at);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });

  it('hosted-shaped public assets return 200 before and after the backfill', async (t) => {
    if (skip(t)) return;
    const suffix = userId.replace(/-/g, '').slice(0, 6);
    const liveId = `bfL${suffix}`;
    const provingId = `bfP${suffix}`;
    const paths = ['sprites/one.js', 'sprites/two.js', 'data/level.json'];
    const types = ['text', 'text', 'json'];
    const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations/20261018140000_manual_review.sql'), 'utf8');
    assert.match(migration, /update public\.game_assets\s+set content_at = updated_at\s+where status = 'uploaded'\s+and content_at is null/);
    assert.match(migration, /update public\.games\s+set reviewed_at = clock_timestamp\(\)\s+where stage in \('proving', 'live'\)\s+and reviewed_at is null/);
    try {
      for (const [id, stage] of [[liveId, 'live'], [provingId, 'proving']] as const) {
        await sql`
          insert into public.games (id, slug, title, creator, stage)
          values (${id}, ${id}, 'Hosted', 'legacy', ${stage})`;
        await sql`update public.games set reviewed_at = null where id = ${id}`;
        for (let i = 0; i < paths.length; i++) {
          await sql`
            insert into public.game_assets
              (game_id, version, path, expected_type, status, size_bytes, content_sha256, source, updated_at)
            values
              (${id}, 1, ${paths[i]}, ${types[i]}, 'uploaded', 12, ${sha('c' + i)}, 'creator', now())`;
        }
        await sql`update public.game_assets set content_at = null where game_id = ${id}`;
      }
      const before = await sql<{ id: string; path: string; status: string; stage: string; reviewed_at: Date | null; content_at: Date | null }[]>`
        select g.id, a.path, a.status, g.stage, g.reviewed_at, a.content_at
        from public.games g
        join public.game_assets a on a.game_id = g.id
        where g.id in (${liveId}, ${provingId})
        order by g.id, a.path`;
      assert.equal(before.length, 6);
      for (const row of before) {
        assert.equal(row.reviewed_at, null);
        assert.equal(row.content_at, null);
        assert.equal(hostedTodayStatus(row), 200, `${row.id} ${row.path}`);
      }

      await backfillPublicReview(sql);
      for (const row of before) {
        const shown = await cdnGet(row.id, `/g/${row.id}/1/${row.path}`, new TextEncoder().encode('hosted'));
        assert.equal(shown.status, 200, `${row.id} ${row.path}`);
        assert.match(shown.body, /hosted/);
      }
      const stamped = await sql<{ id: string; reviewed_at: Date }[]>`
        select id, reviewed_at from public.games where id in (${liveId}, ${provingId}) order by id`;
      assert.equal(stamped.length, 2);
      for (const row of stamped) assert.ok(row.reviewed_at);

      await backfillPublicReview(sql);
      const again = await sql<{ id: string; reviewed_at: Date }[]>`
        select id, reviewed_at from public.games where id in (${liveId}, ${provingId}) order by id`;
      assert.deepEqual(again.map((row) => row.reviewed_at.getTime()), stamped.map((row) => row.reviewed_at.getTime()));
      for (const row of before) {
        assert.equal((await cdnGet(row.id, `/g/${row.id}/1/${row.path}`, new TextEncoder().encode('hosted'))).status, 200);
      }
    } finally {
      await sql`delete from public.games where id in (${liveId}, ${provingId})`;
    }
  });

  it('a demoted legacy live game with no validation row waits for review', async (t) => {
    if (skip(t)) return;
    const id = `bfg5${userId.replace(/-/g, '').slice(0, 6)}`;
    const bytes = new TextEncoder().encode('const legacy = 1;\n');
    try {
      await sql`
        insert into public.games (id, slug, title, creator, owner_id, stage)
        values (${id}, ${id}, 'Legacy live', ${handle}, ${userId}, 'live')`;
      await sql`update public.games set reviewed_at = null where id = ${id}`;
      await sql`
        insert into public.game_assets
          (game_id, version, path, expected_type, status, size_bytes, content_sha256, source)
        values (${id}, 1, 'sprites/old.js', 'text', 'uploaded', ${bytes.byteLength}, ${sha('d1')}, 'creator')`;
      await sql`update public.game_assets set content_at = null where game_id = ${id}`;
      const [shape] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.game_validations where game_id = ${id}`;
      assert.equal(shape?.n, 0);
      await backfillPublicReview(sql);
      assert.equal((await cdnGet(id, `/g/${id}/1/sprites/old.js`, bytes)).status, 200);
      const decision = assessAssetUpload({
        userId,
        ownerId: userId,
        rawPath: 'sprites/new.js',
        adding: true,
        bytes,
        existing: null,
        codeBytes: 100,
        uploadedBytes: bytes.byteLength,
        fileCount: 1,
        rateAllowed: true,
      });
      assert.equal(decision.kind, 'store');
      if (decision.kind !== 'store') return;
      const storage: AssetStorage = {
        async upload() { return { error: null }; },
        async remove() { return { error: null }; },
      };
      assert.deepEqual(await saveFinalizedAsset(sql, storage, id, 1, decision, bytes), { ok: true });
      const [held] = await sql<{ stage: string; reviewed_at: Date | null }[]>`
        select stage, reviewed_at from public.games where id = ${id}`;
      assert.equal(held?.stage, 'pending');
      assert.ok(held?.reviewed_at);
      const [queued] = await sql<{ id: string }[]>`select id from public.games_awaiting_review where id = ${id}`;
      assert.equal(queued?.id, id);
      assert.equal((await cdnGet(id, `/g/${id}/1/sprites/new.js`, bytes)).status, 404);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });

  it('with review off, a new game serves its assets and reports eligibility without graduating', async (t) => {
    if (skip(t)) return;
    const id = `bfoff${userId.replace(/-/g, '').slice(0, 6)}`;
    const bytes = new TextEncoder().encode('const auto = 1;\n');
    const rollback = new Error('rollback-settings');
    try {
      await sql.begin(async (tx) => {
        await tx`update private.settings set value = '0' where key = 'mg_manual_review'`;
        await tx`
          insert into public.games (id, slug, title, creator, owner_id, stage)
          values (${id}, ${id}, 'Auto', ${handle}, ${userId}, 'pending')`;
        const [published] = await tx<{ stage: string }[]>`
          select stage from public.record_game_validation(${id}, ${sha('e1')}, 'passed', ${tx.json(passReport)})`;
        assert.equal(published?.stage, 'proving');
        const [stamped] = await tx<{ reviewed_at: Date | null }[]>`
          select reviewed_at from public.games where id = ${id}`;
        assert.ok(stamped?.reviewed_at);
        const decision = assessAssetUpload({
          userId,
          ownerId: userId,
          rawPath: 'sprites/auto.js',
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
        assert.deepEqual(await saveFinalizedAsset(tx, storage, id, 1, decision, bytes), { ok: true });
        const [still] = await tx<{ stage: string }[]>`select stage from public.games where id = ${id}`;
        assert.equal(still?.stage, 'proving');
        const shown = await cdnGet(id, `/g/${id}/1/sprites/auto.js`, bytes, tx);
        assert.equal(shown.status, 200);
        assert.match(shown.body, /const auto/);
        const plays = Number(process.env.MG_MIN_PLAYS || 100);
        await tx`
          insert into public.sessions (id, game_id, first_frame_ms, started, completed, crashed, duration_ms)
          select gen_random_uuid(), ${id}, 100, true, true, false, 120000
          from generate_series(1, ${plays})`;
        // MG-9: passing every check makes the game eligible; only a human stage write promotes it.
        assert.equal((await getHealth(id, tx)).eligible, true);
        const [eligible] = await tx<{ stage: string; graduated_at: Date | null }[]>`
          select stage, graduated_at from public.games where id = ${id}`;
        assert.equal(eligible?.stage, 'proving');
        assert.equal(eligible?.graduated_at, null);
        assert.equal((await cdnGet(id, `/g/${id}/1/sprites/auto.js`, bytes, tx)).status, 200);
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
  });

  it('approval during a new-file copy never publishes the unreviewed bytes', async (t) => {
    if (skip(t)) return;
    const id = `bnew${userId.replace(/-/g, '').slice(0, 6)}`;
    const bytes = new TextEncoder().encode('const fresh = 1;\n');
    try {
      await sql`
        insert into public.games (id, slug, title, creator, owner_id, stage)
        values (${id}, ${id}, 'Race new', ${handle}, ${userId}, 'pending')`;
      const decision = assessAssetUpload({
        userId, ownerId: userId, rawPath: 'sprites/fresh.js', adding: true, bytes,
        existing: null, codeBytes: 100, uploadedBytes: 0, fileCount: 0, rateAllowed: true,
      });
      assert.equal(decision.kind, 'store');
      if (decision.kind !== 'store') return;
      const storage: AssetStorage = {
        async upload() {
          await sql`update public.games set stage = 'live' where id = ${id}`;
          return { error: null };
        },
        async remove() { return { error: null }; },
      };
      assert.deepEqual(await saveFinalizedAsset(sql, storage, id, 1, decision, bytes), { ok: true });
      const [row] = await sql<{ stage: string; newer: boolean }[]>`
        select g.stage, (a.content_at > g.reviewed_at) as newer
        from public.games g
        join public.game_assets a on a.game_id = g.id and a.path = 'sprites/fresh.js'
        where g.id = ${id}`;
      assert.equal(row?.stage, 'live');
      assert.equal(row?.newer, true);
      assert.equal((await cdnGet(id, `/g/${id}/1/sprites/fresh.js`, bytes)).status, 404);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });

  it('approval during a replace never publishes the unreviewed bytes', async (t) => {
    if (skip(t)) return;
    const id = `brep${userId.replace(/-/g, '').slice(0, 6)}`;
    const v1 = new TextEncoder().encode('const v1 = 1;\n');
    const v2 = new TextEncoder().encode('const v2 = 2;\n');
    try {
      await sql`
        insert into public.games (id, slug, title, creator, owner_id, stage)
        values (${id}, ${id}, 'Race replace', ${handle}, ${userId}, 'pending')`;
      const first = assessAssetUpload({
        userId, ownerId: userId, rawPath: 'sprites/swap.js', adding: true, bytes: v1,
        existing: null, codeBytes: 100, uploadedBytes: 0, fileCount: 0, rateAllowed: true,
      });
      assert.equal(first.kind, 'store');
      if (first.kind !== 'store') return;
      const quiet: AssetStorage = {
        async upload() { return { error: null }; },
        async remove() { return { error: null }; },
      };
      assert.deepEqual(await saveFinalizedAsset(sql, quiet, id, 1, first, v1), { ok: true });
      await sql`update public.games set stage = 'live' where id = ${id}`;
      const warm = await cdnGet(id, `/g/${id}/1/sprites/swap.js`, v1);
      assert.equal(warm.status, 200);
      assert.match(warm.body, /const v1/);

      const [existing] = await sql<{ status: string; size_bytes: number; content_sha256: string }[]>`
        select status, size_bytes, content_sha256 from public.game_assets
        where game_id = ${id} and path = 'sprites/swap.js'`;
      assert.ok(existing);
      const replace = assessAssetUpload({
        userId, ownerId: userId, rawPath: 'sprites/swap.js', adding: false, bytes: v2,
        existing: {
          path: 'sprites/swap.js',
          expectedType: 'text',
          status: 'uploaded',
          sizeBytes: existing.size_bytes,
          source: 'creator',
        },
        codeBytes: 100, uploadedBytes: existing.size_bytes, fileCount: 1, rateAllowed: true,
      });
      assert.equal(replace.kind, 'store');
      if (replace.kind !== 'store') return;
      const racing: AssetStorage = {
        async upload() {
          await sql`update public.games set stage = 'live' where id = ${id}`;
          return { error: null };
        },
        async remove() { return { error: null }; },
      };
      assert.deepEqual(await saveFinalizedAsset(sql, racing, id, 1, replace, v2), { ok: true });
      const hidden = await cdnGet(id, `/g/${id}/1/sprites/swap.js`, v2);
      assert.equal(hidden.status, 404);
      assert.doesNotMatch(hidden.body, /const v2/);
      await sql`update public.games set stage = 'live' where id = ${id}`;
      const shown = await cdnGet(id, `/g/${id}/1/sprites/swap.js`, v2);
      assert.equal(shown.status, 200);
      assert.match(shown.body, /const v2/);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });
});

/** Production today serves an uploaded asset of a public game with no review cutoff. */
function hostedTodayStatus(row: { status: string; stage: string }): number {
  if (row.status !== 'uploaded') return 404;
  if (row.stage !== 'proving' && row.stage !== 'live') return 404;
  return 200;
}

async function backfillPublicReview(db: postgres.Sql): Promise<void> {
  await db`
    update public.game_assets
       set content_at = updated_at
     where status = 'uploaded'
       and content_at is null`;
  await db`
    update public.games
       set reviewed_at = clock_timestamp()
     where stage in ('proving', 'live')
       and reviewed_at is null`;
}

async function cdnGet(
  gameId: string,
  path: string,
  bytes: Uint8Array,
  db: postgres.Sql | postgres.TransactionSql = sql,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const fakeFetch = async (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/rest/v1/games') {
      const [row] = await db<{ stage: string }[]>`select stage from public.games where id = ${gameId}`;
      return Response.json(row ? [{ stage: row.stage }] : []);
    }
    if (u.pathname === '/rest/v1/game_validations') return Response.json([{ version: 1 }]);
    if (u.pathname === '/rest/v1/game_assets') {
      const assetPath = decodeURIComponent((u.searchParams.get('path') ?? '').replace(/^eq\./, ''));
      const [row] = await db<{ status: string; content_at: string | null; stage: string; reviewed_at: string | null }[]>`
        select a.status, a.content_at::text as content_at, g.stage, g.reviewed_at::text as reviewed_at
        from public.game_assets a
        join public.games g on g.id = a.game_id
        where a.game_id = ${gameId} and a.version = 1 and a.path = ${assetPath}`;
      return Response.json(row ? [{
        status: row.status,
        content_at: row.content_at,
        games: { stage: row.stage, reviewed_at: row.reviewed_at },
      }] : []);
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
