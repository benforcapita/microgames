// MG-9 behaviour proof against the local stack only. Skips when that stack is not running.
// Nothing may move a game from 'proving' to 'live' on its own: ratings, telemetry and the
// scheduled sweeper leave an eligible game in the Proving Grounds. Only a human stage write
// promotes it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import postgres from 'postgres';

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
let rateGame: typeof import('./games.ts').rateGame;
let unrateGame: typeof import('./games.ts').unrateGame;
let recordTelemetry: typeof import('./games.ts').recordTelemetry;
let getHealth: typeof import('./games.ts').getHealth;
let GRADUATION: typeof import('./config.ts').GRADUATION;

if (probeOk) {
  sql = (await import('./db.ts')).sql;
  ({ rateGame, unrateGame, recordTelemetry, getHealth } = await import('./games.ts'));
  ({ GRADUATION } = await import('./config.ts'));
}

const run = randomUUID().replace(/-/g, '').slice(0, 8);
const created: string[] = [];

function skip(t: { skip: (message?: string) => void }) {
  if (!probeOk || !sql) {
    t.skip('local supabase is not running');
    return true;
  }
  return false;
}

interface StageRow {
  stage: string;
  graduated_at: Date | null;
}

type Db = postgres.Sql | postgres.TransactionSql;

/** A proving game that already clears every health check — eligible, not yet promoted. */
async function seedEligibleProvingGame(tag: string, db: Db = sql): Promise<string> {
  const id = `mg9${tag}${run}`;
  if (db === sql) created.push(id);
  await db`
    insert into public.games (id, slug, title, creator, stage)
    values (${id}, ${id}, 'Eligible', 'mg9test', 'proving')`;
  await db`
    insert into public.sessions (id, game_id, first_frame_ms, started, completed, crashed, duration_ms)
    select gen_random_uuid(), ${id}, 100, true, true, false, 120000
    from generate_series(1, ${GRADUATION.minPlays})`;
  await db`
    insert into public.ratings (game_id, voter, stars)
    select ${id}, 'seed-' || g::text, 5 from generate_series(1, ${GRADUATION.minRatingsForRatingGate + 2}) g`;
  const health = await getHealth(id, db);
  assert.equal(health.eligible, true, 'fixture must report eligible');
  return id;
}

const stageOf = async (id: string, db: Db = sql) =>
  (await db<StageRow[]>`select stage, graduated_at from public.games where id = ${id}`)[0];

/** Runs `fn` in a transaction that is always rolled back — nothing is committed. */
async function inTx(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function assertStaysProving(id: string, via: string) {
  const row = await stageOf(id);
  assert.equal(row?.stage, 'proving', `${via} must not promote the game`);
  assert.equal(row?.graduated_at, null, `${via} must not stamp graduated_at`);
}

after(async () => {
  if (!sql) return;
  try {
    if (created.length) await sql`delete from public.games where id in ${sql(created)}`;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
});

describe('MG-9: nothing promotes a game out of the Proving Grounds on its own (db)', () => {

  it('rateGame keeps an eligible game proving', async (t) => {
    if (skip(t)) return;
    const id = await seedEligibleProvingGame('rate');
    await rateGame(id, 'new-voter', 4);
    await assertStaysProving(id, 'rateGame');
  });

  it('unrateGame keeps an eligible game proving', async (t) => {
    if (skip(t)) return;
    const id = await seedEligibleProvingGame('unrate');
    assert.equal(await unrateGame(id, 'seed-1'), true, 'a seeded rating is removed');
    await assertStaysProving(id, 'unrateGame');
    assert.equal((await getHealth(id)).eligible, true, 'still eligible after one removal');
  });

  it('recordTelemetry keeps an eligible game proving', async (t) => {
    if (skip(t)) return;
    const id = await seedEligibleProvingGame('tele');
    const [session] = await sql<{ id: string }[]>`select id from public.sessions where game_id = ${id} limit 1`;
    for (const type of ['start', 'complete', 'crash', 'heartbeat'] as const) {
      await recordTelemetry(session!.id, id, type, type === 'heartbeat' ? 90000 : 1);
      await assertStaysProving(id, `telemetry ${type}`);
    }
  });

  it('the stage-writing SQL paths keep an eligible game proving', async (t) => {
    if (skip(t)) return;
    const id = await seedEligibleProvingGame('cron');
    // The only scheduled stage writer: re-dispatches or auto-rejects *pending* games.
    await sql`select private.sweep_stuck_pending_games()`;
    await assertStaysProving(id, 'sweep_stuck_pending_games');
    // Validation results move pending games only; a proving game is untouched.
    const [recorded] = await sql<{ stage: string }[]>`
      select stage from public.record_game_validation(
        ${id}, ${'cd'.repeat(32)}, 'passed', ${sql.json({ status: 'pass', checks: [] })})`;
    assert.equal(recorded?.stage, 'proving');
    await assertStaysProving(id, 'record_game_validation');
  });

  it('a human stage write still promotes (the test can see success)', async (t) => {
    if (skip(t)) return;
    // Everything runs inside a rolled-back transaction: a committed live game with real
    // plays would be counted by platformStats()/homepage queries in other test files.
    await inTx(async (tx) => {
      const id = await seedEligibleProvingGame('admin', tx);
      await tx`update public.games set stage = 'live' where id = ${id}`;
      assert.equal((await stageOf(id, tx))?.stage, 'live');
    });
  });
});

describe('MG-9: an unhealthy game is not eligible (db)', () => {
  /** A proving game with `plays` sessions, `crashed` of them crashed, and `votes` ratings at `stars`. */
  async function seedHealthGame(
    tx: postgres.TransactionSql,
    tag: string,
    { plays, crashed = 0, stars = 5, votes = GRADUATION.minRatingsForRatingGate + 2 }:
      { plays: number; crashed?: number; stars?: number; votes?: number },
  ): Promise<string> {
    const id = `mg9h${tag}${run}`;
    await tx`
      insert into public.games (id, slug, title, creator, stage)
      values (${id}, ${id}, 'Health', 'mg9test', 'proving')`;
    await tx`
      insert into public.sessions (id, game_id, first_frame_ms, started, completed, crashed, duration_ms)
      select gen_random_uuid(), ${id}, 100, true, true, g <= ${crashed}, 120000
      from generate_series(1, ${plays}) g`;
    await tx`
      insert into public.ratings (game_id, voter, stars)
      select ${id}, 'seed-' || g::text, ${stars} from generate_series(1, ${votes}) g`;
    return id;
  }

  const failing = (health: { checks: { key: string; pass: boolean }[] }) =>
    health.checks.filter((c) => !c.pass).map((c) => c.key);

  it('a healthy game is eligible (the test can see success)', async (t) => {
    if (skip(t)) return;
    await inTx(async (tx) => {
      const id = await seedHealthGame(tx, 'ok', { plays: GRADUATION.minPlays });
      const health = await getHealth(id, tx);
      assert.equal(health.eligible, true);
      assert.deepEqual(failing(health), []);
    });
  });

  it('too few plays alone makes a game ineligible', async (t) => {
    if (skip(t)) return;
    await inTx(async (tx) => {
      const id = await seedHealthGame(tx, 'few', { plays: GRADUATION.minPlays - 1 });
      const health = await getHealth(id, tx);
      assert.equal(health.eligible, false);
      assert.deepEqual(failing(health), ['plays']);
    });
  });

  it('a high crash rate alone makes a game ineligible', async (t) => {
    if (skip(t)) return;
    await inTx(async (tx) => {
      const id = await seedHealthGame(tx, 'crash', {
        plays: GRADUATION.minPlays,
        crashed: Math.ceil(GRADUATION.minPlays * (GRADUATION.maxCrashRate + 0.05)),
      });
      const health = await getHealth(id, tx);
      assert.equal(health.eligible, false);
      assert.deepEqual(failing(health), ['crash']);
    });
  });

  it('a low community rating alone makes a game ineligible', async (t) => {
    if (skip(t)) return;
    await inTx(async (tx) => {
      const id = await seedHealthGame(tx, 'rate', { plays: GRADUATION.minPlays, stars: 1 });
      const health = await getHealth(id, tx);
      assert.equal(health.eligible, false);
      assert.deepEqual(failing(health), ['rating']);
    });
  });
});
