import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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

let listGames: typeof import('./games.ts').listGames;
let listGamesByIds: typeof import('./games.ts').listGamesByIds;
let sql: typeof import('./db.ts').sql;

if (probeOk) {
  const gamesMod = await import('./games.ts');
  const dbMod = await import('./db.ts');
  listGames = gamesMod.listGames;
  listGamesByIds = gamesMod.listGamesByIds;
  sql = dbMod.sql;
}

const P = 'vt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const creator = `vis${P}`;

const liveBoth = `${P}-live-both`;
const liveDesk = `${P}-live-desk`;
const liveMob = `${P}-live-mob`;
const prov = `${P}-prov`;
const provDesk = `${P}-prov-desk`;
const pend = `${P}-pend`;
const rej = `${P}-rej`;

const all = [liveBoth, liveDesk, liveMob, prov, provDesk, pend, rej];
const fixtureSet = new Set(all);
const sortedFixtureIds = (games: { id: string }[]) =>
  games.map((g) => g.id).filter((id) => fixtureSet.has(id)).sort();

const liveThree = [liveBoth, liveDesk, liveMob].sort();
const liveMobile = [liveBoth, liveMob].sort();

describe('visibility (db-backed)', () => {
  before(async () => {
    if (!probeOk || !sql) return;
    await sql`delete from public.games where id like ${P + '%'}`;
    const rows = [
      { id: liveBoth, slug: liveBoth, creator, title: 'Live Both', stage: 'live', input_support: 'both', forked_from: null },
      { id: liveDesk, slug: liveDesk, creator, title: 'Live Desk', stage: 'live', input_support: 'desktop', forked_from: liveBoth },
      { id: liveMob, slug: liveMob, creator, title: 'Live Mob', stage: 'live', input_support: 'mobile', forked_from: null },
      { id: prov, slug: prov, creator, title: 'Prov Both', stage: 'proving', input_support: 'both', forked_from: null },
      { id: provDesk, slug: provDesk, creator, title: 'Prov Desk', stage: 'proving', input_support: 'desktop', forked_from: null },
      { id: pend, slug: pend, creator, title: 'Pend Both', stage: 'pending', input_support: 'both', forked_from: null },
      { id: rej, slug: rej, creator, title: 'Rej Both', stage: 'rejected', input_support: 'both', forked_from: null },
    ];
    // created_at: liveDesk is the newest, so a LIMIT applied before the mobile filter would waste a slot on it (see e).
    const age: Record<string, number> = { [liveDesk]: 0, [liveMob]: 1, [liveBoth]: 2 };
    for (const r of rows) {
      const created = new Date(Date.now() - (age[r.id] ?? 3) * 60_000);
      await sql`
        insert into public.games (id, slug, creator, title, stage, input_support, forked_from, created_at)
        values (${r.id}, ${r.slug}, ${r.creator}, ${r.title}, ${r.stage}, ${r.input_support}, ${r.forked_from}, ${created})
      `;
    }
  });

  after(async () => {
    if (!sql) return;
    try {
      await sql`delete from public.games where id like ${P + '%'}`;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('a) listGamesByIds(all) and listGamesByIds(all, "desktop") -> [liveBoth, liveDesk, liveMob]', async (t) => {
    if (!probeOk) {
      t.skip('local supabase is not running');
      return;
    }
    assert.deepEqual(sortedFixtureIds(await listGamesByIds(all)), liveThree);
    assert.deepEqual(sortedFixtureIds(await listGamesByIds(all, 'desktop')), liveThree);
  });

  it('b) listGamesByIds(all, "mobile") -> [liveBoth, liveMob]; listGamesByIds([], "mobile") -> []', async (t) => {
    if (!probeOk) {
      t.skip('local supabase is not running');
      return;
    }
    assert.deepEqual(sortedFixtureIds(await listGamesByIds(all, 'mobile')), liveMobile);
    assert.deepEqual(sortedFixtureIds(await listGamesByIds([], 'mobile')), []);
  });

  it('c) listGames({creator, limit:50}) -> live three; with device "mobile" -> [liveBoth, liveMob]; listGames({stage:"proving", creator}) -> []; listGames({forkedFrom: liveBoth, device:"mobile"}) -> []', async (t) => {
    if (!probeOk) {
      t.skip('local supabase is not running');
      return;
    }
    assert.deepEqual(sortedFixtureIds(await listGames({ creator, limit: 50 })), liveThree);
    assert.deepEqual(sortedFixtureIds(await listGames({ creator, limit: 50, device: 'mobile' })), liveMobile);
    assert.deepEqual(sortedFixtureIds(await listGames({ stage: 'proving', creator })), []);
    assert.deepEqual(sortedFixtureIds(await listGames({ forkedFrom: liveBoth, device: 'mobile' })), []);
  });

  it('d) owner-less callers cannot opt in: listGames({creator, includeUnpublished:true, includeUnlisted:true}) -> live three', async (t) => {
    if (!probeOk) {
      t.skip('local supabase is not running');
      return;
    }
    assert.deepEqual(sortedFixtureIds(await listGames({ creator, includeUnpublished: true, includeUnlisted: true })), liveThree);
  });

  it('e) the mobile filter runs in SQL, before LIMIT: newest-2 on mobile is still 2 games', async (t) => {
    if (!probeOk) {
      t.skip('local supabase is not running');
      return;
    }
    // Without the SQL filter, LIMIT 2 picks [liveDesk, liveMob] and the JS fallback drops liveDesk -> only 1 game.
    assert.deepEqual(sortedFixtureIds(await listGames({ creator, sort: 'new', limit: 2, device: 'mobile' })), liveMobile);
  });
});
