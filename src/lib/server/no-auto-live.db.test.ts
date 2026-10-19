// MG-11 behaviour proof against the local stack only. Skips when that stack is not running.
// Nothing may move a game from 'proving' to 'live' on its own: ratings, telemetry and the
// scheduled sweeper leave an eligible game in the Proving Grounds. Only a human stage write
// promotes it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import postgres from 'postgres';
import { LIVE_STAGE_WRITE_PATTERNS } from './live-stage-writes.ts';

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
// Every id seeded inside a transaction: all of them must be gone at the end — any
// survivor means a callback committed what it was supposed to roll back (QA d1/d1b/d2).
const txSeeded: string[] = [];

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
  (db === sql ? created : txSeeded).push(id);
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
    // Leak check BEFORE deleting `created`: a test that loses its rollback commits its
    // fixtures (QA mutants d1/d1b/d2). d2's game even sits inside `created`, so counting
    // first is the only deterministic catch — the delete below would hide it otherwise.
    // The prefixes cover any hand-written tx insert; txSeeded covers every helper seed.
    const ids = txSeeded.length ? txSeeded : [''];
    const [g, s, r] = await Promise.all([
      sql`select count(*)::int n from public.games
          where id like 'mg9admin%' or id like 'mg9h%' or id like 'mg9tx%' or id in ${sql(ids)}`,
      sql`select count(*)::int n from public.sessions
          where game_id like 'mg9admin%' or game_id like 'mg9h%' or game_id like 'mg9tx%' or game_id in ${sql(ids)}`,
      sql`select count(*)::int n from public.ratings
          where game_id like 'mg9admin%' or game_id like 'mg9h%' or game_id like 'mg9tx%' or game_id in ${sql(ids)}`,
    ]);
    const leaked = { games: g[0]!.n, sessions: s[0]!.n, ratings: r[0]!.n };
    // Hygiene: drop leaked rows anyway so the stack stays clean for whatever runs next,
    // then fail. Cleaning up silently is not an option.
    await sql`delete from public.ratings
              where game_id like 'mg9admin%' or game_id like 'mg9h%' or game_id like 'mg9tx%' or game_id in ${sql(ids)}`;
    await sql`delete from public.sessions
              where game_id like 'mg9admin%' or game_id like 'mg9h%' or game_id like 'mg9tx%' or game_id in ${sql(ids)}`;
    await sql`delete from public.games
              where id like 'mg9admin%' or id like 'mg9h%' or id like 'mg9tx%' or id in ${sql(ids)}`;
    if (created.length) await sql`delete from public.games where id in ${sql(created)}`;
    const nonzero = Object.fromEntries(Object.entries(leaked).filter(([, n]) => n > 0));
    assert.deepEqual(nonzero, {}, 'committed rows survived the suite — a test lost its rollback');
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
});

describe('MG-11: nothing promotes a game out of the Proving Grounds on its own (db)', () => {

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

  it('a metadata-only edit keeps an eligible game proving', async (t) => {
    if (skip(t)) return;
    // QA b7: a committed BEFORE UPDATE trigger doing new.stage := 'live' promoted a
    // proving game on exactly this kind of edit. Read the row back inside the same
    // transaction — that is where a trigger's effect is visible.
    await inTx(async (tx) => {
      const id = await seedEligibleProvingGame('meta', tx);
      await tx`update public.games set title = 'Retitled', review_note = 'looked again' where id = ${id}`;
      const row = await stageOf(id, tx);
      assert.equal(row?.stage, 'proving', 'a metadata edit must not promote the game');
      assert.equal(row?.graduated_at, null, 'a metadata edit must not stamp graduated_at');
    });
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

describe('MG-11: an unhealthy game is not eligible (db)', () => {
  /** A proving game with `plays` sessions, `crashed` of them crashed, and `votes` ratings at `stars`. */
  async function seedHealthGame(
    tx: postgres.TransactionSql,
    tag: string,
    { plays, crashed = 0, stars = 5, votes = GRADUATION.minRatingsForRatingGate + 2 }:
      { plays: number; crashed?: number; stars?: number; votes?: number },
  ): Promise<string> {
    const id = `mg9h${tag}${run}`;
    txSeeded.push(id);
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

describe('MG-11: the database catalog has no path to live (db)', () => {
  it('no trigger on public.games or function in a user schema writes the live stage', async (t) => {
    if (skip(t)) return;
    // Non-internal triggers bound to public.games, with the body of each trigger
    // function. A trigger function can promote without naming the table in its body,
    // so this query does not prefilter the function text.
    const triggers = await sql<{ tgname: string; fn: string; prosrc: string }[]>`
      select t.tgname, n.nspname || '.' || p.proname as fn, p.prosrc
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace rn on rn.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      join pg_namespace n on n.oid = p.pronamespace
      where rn.nspname = 'public' and c.relname = 'games' and not t.tgisinternal
      order by t.tgname`;
    // Functions in user schemas whose body mentions games + stage + the live literal.
    // pg_catalog, information_schema, pg_* and extension-owned schemas are out of
    // scope; everything else (public, private, auth, storage, …) is a schema an
    // agent could create a function in. The coarse text prefilter only narrows the
    // scan — the write-shape regexes below decide.
    const fns = await sql<{ fn: string; prosrc: string }[]>`
      select n.nspname || '.' || p.proname as fn, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname <> 'pg_catalog'
        and n.nspname <> 'information_schema'
        and n.nspname !~ '^pg_'
        and p.pronamespace not in (select extnamespace from pg_extension)
        and lower(p.prosrc) like '%games%'
        and lower(p.prosrc) like '%stage%'
        and lower(p.prosrc) like '%live%'
      order by fn`;
    t.diagnostic(
      `triggers on public.games: ${triggers.map((x) => `${x.tgname}→${x.fn}`).join(', ') || 'none'}`,
    );
    t.diagnostic(
      `user-schema functions matching the games+stage+live prefilter: ${fns.map((x) => x.fn).join(', ') || 'none'}`,
    );
    // Vacuity guard: the shipped schema always binds games_touch_review, so an empty
    // trigger list means the query is broken — this test must not pass on silence.
    assert.ok(
      triggers.some((x) => x.tgname === 'games_touch_review'),
      'expected to see trigger games_touch_review on public.games',
    );
    const hits: string[] = [];
    for (const x of triggers) {
      for (const p of LIVE_STAGE_WRITE_PATTERNS) {
        if (p.re.test(x.prosrc)) hits.push(`trigger ${x.tgname} (${x.fn}): ${p.name}`);
      }
    }
    for (const x of fns) {
      for (const p of LIVE_STAGE_WRITE_PATTERNS) {
        if (p.re.test(x.prosrc)) hits.push(`function ${x.fn}: ${p.name}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});

describe('MG-11: test isolation self-checks (db)', () => {
  it('inTx re-raises a failing assertion and leaves nothing committed', async (t) => {
    if (skip(t)) return;
    // QA d3/d3b: an inTx that swallows errors turns every rolled-back test into a
    // rubber stamp. The same error object must come back out…
    const boom = new assert.AssertionError({ message: 'boom' });
    const id = `mg9tx${run}`;
    await assert.rejects(
      inTx(async (tx) => {
        await tx`insert into public.games (id, slug, title, creator, stage)
                 values (${id}, ${id}, 'x', 'mg9test', 'proving')`;
        throw boom;
      }),
      (err) => err === boom,
      'inTx must propagate the inner error instead of swallowing it',
    );
    // …and the insert must be gone — the transaction rolled back, not committed.
    const [row] = await sql`select 1 from public.games where id = ${id}`;
    assert.equal(row, undefined, 'the rolled-back insert must not be committed');
  });
});
