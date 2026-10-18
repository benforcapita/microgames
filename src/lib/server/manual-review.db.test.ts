// MR-1 behavior against the local stack only. Skips when that stack is not running.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { servedBundleVersion } from '../../../cdn/served-version.mjs';

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
      await sql`delete from public.games where id in (${pendingId}, ${versionId}, ${legacyId})`;
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

  it('a new passed version does not replace the approved one until stage is set to proving again', async (t) => {
    if (skip(t)) return;
    await sql`
      insert into public.games (id, slug, title, creator, owner_id, stage)
      values (${versionId}, ${versionId}, 'Versioned', ${handle}, ${userId}, 'pending')`;
    await sql`select stage from public.record_game_validation(${versionId}, ${sha('11')}, 'passed', ${sql.json(passReport)})`;
    await sql`update public.games set stage = 'proving' where id = ${versionId}`;

    const before = await approvedVersion(versionId);
    assert.equal(before, 1);
    assert.equal((await getGame(versionId))?.stage, 'proving');

    const [second] = await sql<{ stage: string; version: number }[]>`
      select stage, version from public.record_game_validation(${versionId}, ${sha('22')}, 'passed', ${sql.json(passReport)})`;
    assert.equal(second?.stage, 'proving');
    assert.equal(second?.version, 2);
    assert.equal(await approvedVersion(versionId), 1, 'public version stays on the approved bundle');
    const waiting = await sql<{ id: string }[]>`select id from public.games_awaiting_review where id = ${versionId}`;
    assert.equal(waiting.length, 1);

    await sql`update public.games set stage = 'proving' where id = ${versionId}`;
    assert.equal(await approvedVersion(versionId), 2);
    const done = await sql`select id from public.games_awaiting_review where id = ${versionId}`;
    assert.equal(done.length, 0);
    assert.equal((await getGame(versionId))?.stage, 'proving');
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
      assert.ok(game?.reviewed_at);
    } finally {
      await sql`delete from public.games where id = ${id}`;
    }
  });
});

async function approvedVersion(gameId: string): Promise<number> {
  const [game] = await sql<{ reviewed_at: Date | null }[]>`
    select reviewed_at from public.games where id = ${gameId}`;
  const versions = await sql<{ version: number; status: string; finished_at: Date | null }[]>`
    select version::int as version, status, finished_at
    from public.game_validations
    where game_id = ${gameId}`;
  return servedBundleVersion({
    preview: false,
    reviewedAt: game?.reviewed_at ? game.reviewed_at.toISOString() : null,
    rows: versions.map((row) => ({
      version: row.version,
      status: row.status,
      finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    })),
  });
}
