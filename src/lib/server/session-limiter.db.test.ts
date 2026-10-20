import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import {
  SESSION_START_IP_MAX,
  SESSION_START_IP_WINDOW_MS,
  admitSessionStart,
  sessionIpSubject,
} from './abuse.ts';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let isLocal = false;
try {
  const parsed = new URL(url);
  isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
} catch {
  isLocal = false;
}

if (isLocal) {
  process.env.MG_IP_HASH_SECRET ??= 'mg8b-b-test-secret-0000000000000';
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

const sqlA = postgres(url, { max: 2, prepare: false, connect_timeout: 3 });
const sqlB = postgres(url, { max: 2, prepare: false, connect_timeout: 3 });
const pools = Array.from({ length: 4 }, () => postgres(url, { max: 10, prepare: false, connect_timeout: 3 }));

const GAME = `mg8b-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const GAME2 = `mg8c-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const runOctet = randomInt(10, 250);
const runIps = new Set<string>();
let ipCounter = 1;
const nextIp = () => {
  const ip = `203.0.${runOctet}.${ipCounter++}`;
  runIps.add(ip);
  return ip;
};

const admit = (pool: postgres.Sql, a: { uid: string; ip: string; now?: number; gameId?: string }) =>
  pool.begin((tx) => admitSessionStart(tx, { uid: a.uid, ip: a.ip, gameId: a.gameId ?? GAME, now: a.now }));

const ipSubjects = (ips: string[]) =>
  ips.map((ip) => sessionIpSubject(ip, process.env.MG_IP_HASH_SECRET ?? '', new Date()));

async function rolledBack(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  let done = false;
  try {
    await sqlA.begin(async (tx) => {
      await fn(tx);
      done = true;
      throw new Error('ROLLBACK');
    });
  } catch (err) {
    if (!done || !(err instanceof Error) || err.message !== 'ROLLBACK') throw err;
  }
}

const subjectsAt = async (...ats: Date[]) => {
  const rows = await sqlA<{ subject: string }[]>`
    select distinct subject from public.session_admissions
    where kind = 'ip' and game_id = ${GAME} and created_at in ${sqlA(ats)}`;
  return rows.map((r) => r.subject);
};

function skip(t: { skip: (message?: string) => void }) {
  if (!probeOk) {
    t.skip('local supabase is not running');
    return true;
  }
  return false;
}

describe('shared session-start limiter (db)', () => {
  before(async () => {
    if (!probeOk) return;
    await sqlA`insert into public.games (id, slug, creator, title, stage)
               values (${GAME}, ${GAME}, 'mg8b', 'MG8b limiter test', 'live'),
                      (${GAME2}, ${GAME2}, 'mg8b', 'MG8b limiter test 2', 'live')`;
  });

  after(async () => {
    try {
      if (probeOk) {
        await sqlA`delete from public.session_admissions where game_id in (${GAME}, ${GAME2})`;
        await sqlA`delete from public.games where id in (${GAME}, ${GAME2})`;
      }
    } finally {
      await sqlA.end({ timeout: 1 }).catch(() => {});
      await sqlB.end({ timeout: 1 }).catch(() => {});
      await Promise.all(pools.map((p) => p.end({ timeout: 1 }).catch(() => {})));
    }
  });

  it('two independent pools share one ip budget and one uid budget', async (t) => {
    if (skip(t)) return;
    const ip = nextIp();
    for (let i = 0; i < 20; i++) {
      assert.equal(await admit(sqlA, { uid: randomUUID(), ip }), true, `ip admission ${i + 1}`);
    }
    assert.equal(await admit(sqlB, { uid: randomUUID(), ip }), false, '21st ip admission refused across pools');
    const u = randomUUID();
    assert.equal(await admit(sqlA, { uid: u, ip: nextIp() }), true);
    assert.equal(await admit(sqlB, { uid: u, ip: nextIp() }), false, '2nd uid admission refused across pools');
  });

  it('resets the uid window after 30 minutes and the ip window after 60 on the injected clock', async (t) => {
    if (skip(t)) return;
    const now = Date.now();
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const t0 = Math.min(Math.max(now - 30 * 60_000, dayStart + 60_000), dayStart + 86_400_000 - 62 * 60_000);
    const ip = nextIp();
    const u = randomUUID();
    assert.equal(await admit(sqlA, { uid: u, ip, now: t0 }), true);
    assert.equal(await admit(sqlA, { uid: u, ip, now: t0 + 29 * 60_000 }), false);
    assert.equal(await admit(sqlA, { uid: u, ip, now: t0 + 31 * 60_000 }), true);

    const ip2 = nextIp();
    for (let i = 0; i < 20; i++) assert.equal(await admit(sqlA, { uid: randomUUID(), ip: ip2, now: t0 }), true);
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip: ip2, now: t0 + 59 * 60_000 }), false);
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip: ip2, now: t0 + 61 * 60_000 }), true);
  });

  it('counts a hit at exactly the window edge as expired: refused at 60min-1ms, admitted at 60min', async (t) => {
    if (skip(t)) return;
    const ip = nextIp();
    const outcomes: boolean[] = [];
    await rolledBack(async (tx) => {
      const now = Date.now();
      const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
      const t0 = Math.min(Math.max(now - 2 * 60 * 60_000, dayStart + 60_000), dayStart + 22 * 60 * 60_000);
      for (let i = 0; i < SESSION_START_IP_MAX; i++) {
        outcomes.push(await admitSessionStart(tx, { uid: randomUUID(), ip, gameId: GAME, now: t0 }));
      }
      outcomes.push(
        await admitSessionStart(tx, { uid: randomUUID(), ip, gameId: GAME, now: t0 + SESSION_START_IP_WINDOW_MS - 1 }),
      );
      outcomes.push(
        await admitSessionStart(tx, { uid: randomUUID(), ip, gameId: GAME, now: t0 + SESSION_START_IP_WINDOW_MS }),
      );
    });
    assert.deepEqual(
      outcomes,
      [...Array.from({ length: SESSION_START_IP_MAX }, () => true), false, true],
      'one ms inside the window still counts all 20; at exactly 60 minutes the oldest hit is out',
    );
  });

  it('counts a uid hit at exactly 30 minutes as expired', async (t) => {
    if (skip(t)) return;
    const uid = randomUUID();
    const outcomes: boolean[] = [];
    await rolledBack(async (tx) => {
      const t0 = Date.now() - 60 * 60_000;
      outcomes.push(await admitSessionStart(tx, { uid, ip: nextIp(), gameId: GAME, now: t0 }));
      outcomes.push(await admitSessionStart(tx, { uid, ip: nextIp(), gameId: GAME, now: t0 + 30 * 60_000 - 1 }));
      outcomes.push(await admitSessionStart(tx, { uid, ip: nextIp(), gameId: GAME, now: t0 + 30 * 60_000 }));
    });
    assert.deepEqual(outcomes, [true, false, true]);
  });

  it('a uid-duplicate is refused before the ip hit, so it does not spend ip budget', async (t) => {
    if (skip(t)) return;
    const ip = nextIp();
    const u = randomUUID();
    assert.equal(await admit(sqlA, { uid: u, ip }), true);
    for (let i = 0; i < 20; i++) assert.equal(await admit(sqlA, { uid: u, ip }), false);
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip }), true, 'uid dups must not spend the ip budget');
  });

  it('an ip-cap refusal does not spend the uid slot', async (t) => {
    if (skip(t)) return;
    const ip = nextIp();
    for (let i = 0; i < 20; i++) assert.equal(await admit(sqlA, { uid: randomUUID(), ip }), true);
    const u = randomUUID();
    assert.equal(await admit(sqlA, { uid: u, ip }), false, 'ip cap refuses');
    assert.equal(await admit(sqlA, { uid: u, ip: nextIp() }), true, 'uid slot survives the refusal');
  });

  it('concurrent admissions on one key admit exactly once', async (t) => {
    if (skip(t)) return;
    const u = randomUUID();
    const ip = nextIp();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => admit(i % 2 ? sqlA : sqlB, { uid: u, ip })),
    );
    assert.equal(results.filter(Boolean).length, 1);
  });

  it('many devices on several ips racing across four pools admit exactly the ip cap per ip', async (t) => {
    if (skip(t)) return;
    const ips = Array.from({ length: 4 }, () => nextIp());
    const starts = ips.flatMap((ip) => Array.from({ length: 50 }, () => ({ uid: randomUUID(), ip })));
    const results = await Promise.all(starts.map((a, i) => admit(pools[i % pools.length], a)));
    for (const ip of ips) {
      assert.equal(
        results.filter((ok, i) => ok === true && starts[i].ip === ip).length,
        SESSION_START_IP_MAX,
        `starts admitted for ${ip}`,
      );
    }
    const perSubject = await sqlA<{ n: number }[]>`
      select count(*)::int as n from public.session_admissions
      where kind = 'ip' and game_id = ${GAME} and subject in ${sqlA(ipSubjects(ips))}
      group by subject order by n`;
    assert.deepEqual(
      perSubject.map((r) => r.n),
      [SESSION_START_IP_MAX, SESSION_START_IP_MAX, SESSION_START_IP_MAX, SESSION_START_IP_MAX],
    );
  });

  it('many parallel starts from one device admit exactly once and spend exactly one ip row', async (t) => {
    if (skip(t)) return;
    const uid = randomUUID();
    const ips = Array.from({ length: 100 }, () => nextIp());
    const results = await Promise.all(ips.map((ip, i) => admit(pools[i % pools.length], { uid, ip })));
    assert.equal(results.filter(Boolean).length, 1);
    const [uidRows] = await sqlA<{ n: number }[]>`
      select count(*)::int as n from public.session_admissions
      where kind = 'uid' and game_id = ${GAME} and subject = ${uid}`;
    assert.equal(uidRows?.n, 1);
    const [ipRows] = await sqlA<{ n: number }[]>`
      select count(*)::int as n from public.session_admissions
      where kind = 'ip' and game_id = ${GAME} and subject in ${sqlA(ipSubjects(ips))}`;
    assert.equal(ipRows?.n, 1, 'refused uid duplicates must not spend ip budget');
  });

  it('an ip that exhausts its hourly starts on one game is still admitted on another', async (t) => {
    if (skip(t)) return;
    const ip = nextIp();
    for (let i = 0; i < SESSION_START_IP_MAX; i++) {
      assert.equal(await admit(sqlA, { uid: randomUUID(), ip }), true, `start ${i + 1}`);
    }
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip }), false, 'budget spent');
    assert.equal(
      await admit(sqlA, { uid: randomUUID(), ip, gameId: GAME2 }),
      true,
      'a second game has its own ip budget',
    );
  });

  it('stores a daily-rotating hmac of the ip, never the ip itself', async (t) => {
    if (skip(t)) return;
    const ip = nextIp();
    const day1 = Date.UTC(2026, 9, 19, 12);
    const day1b = Date.UTC(2026, 9, 19, 20);
    const day2 = Date.UTC(2026, 9, 20, 12);
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip, now: day1 }), true);
    const first = await subjectsAt(new Date(day1));
    assert.equal(first.length, 1);
    const [h1 = ''] = first;
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.notEqual(h1, ip);
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip, now: day1b }), true);
    assert.deepEqual(await subjectsAt(new Date(day1), new Date(day1b)), first, 'same UTC day keeps the same hash');
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip, now: day2 }), true);
    const second = await subjectsAt(new Date(day2));
    assert.equal(second.length, 1);
    assert.notEqual(second[0], h1, 'hash rotates across UTC days');
  });

  it('concurrent admissions over a stale backlog never block or deadlock on the sweep', async (t) => {
    if (skip(t)) return;
    const stale = new Date(Date.now() - 2 * 60 * 60_000);
    await sqlA`
      insert into public.session_admissions (kind, subject, game_id, created_at)
      select 'ip', 'stale', ${GAME}, ${stale} from generate_series(1, 5000) g`;
    let held!: () => void;
    let release!: () => void;
    const locksHeld = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sweeper = sqlB.begin(async (tx) => {
      await tx`
        select id from public.session_admissions
        where created_at < ${new Date(Date.now() - 60 * 60_000)}
        order by id limit 500 for update`;
      held();
      await gate;
    });
    await locksHeld;
    const admitLocked = (pool: postgres.Sql, u: string, ip: string) =>
      pool.begin(async (tx) => {
        await tx`set local lock_timeout = '200ms'`;
        return admitSessionStart(tx, { uid: u, ip, gameId: GAME });
      });
    const n = 20;
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => admitLocked(i % 2 ? sqlA : sqlB, randomUUID(), nextIp())),
    );
    release();
    await sweeper;
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(
      failed.length,
      0,
      `admissions failed under contention: ${failed
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .slice(0, 3)
        .join(' | ')}`,
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value === true).length, n);
  });

  it('the sweep deletes rows older than 60 minutes and keeps every row inside it', async (t) => {
    if (skip(t)) return;
    const tag = `swp-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const counts = new Map<string, number>();
    await rolledBack(async (tx) => {
      const now = Date.now();
      await tx`delete from public.session_admissions where created_at < ${new Date(now - 60 * 60_000)}`;
      await tx`insert into public.session_admissions (kind, subject, game_id, created_at)
        select 'ip', ${tag} || '-2h-' || g, ${GAME}, ${new Date(now - 2 * 60 * 60_000)} from generate_series(1, 30) g`;
      await tx`insert into public.session_admissions (kind, subject, game_id, created_at)
        select 'ip', ${tag} || '-61m-' || g, ${GAME}, ${new Date(now - 61 * 60_000)} from generate_series(1, 20) g`;
      await tx`insert into public.session_admissions (kind, subject, game_id, created_at)
        select 'uid', ${tag} || '-59m-' || g, ${GAME}, ${new Date(now - 59 * 60_000)} from generate_series(1, 20) g`;
      await tx`insert into public.session_admissions (kind, subject, game_id, created_at)
        select 'ip', ${tag} || '-45m-' || g, ${GAME}, ${new Date(now - 45 * 60_000)} from generate_series(1, 20) g`;
      await tx`insert into public.session_admissions (kind, subject, game_id, created_at)
        values ('ip', ${tag} || '-edge60', ${GAME}, ${new Date(now - 60 * 60_000)})`;
      assert.equal(
        await admitSessionStart(tx, { uid: randomUUID(), ip: nextIp(), gameId: GAME, now }),
        true,
      );
      for (const prefix of [`${tag}-2h-%`, `${tag}-61m-%`, `${tag}-59m-%`, `${tag}-45m-%`, `${tag}-edge60`]) {
        const [r] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.session_admissions where subject like ${prefix}`;
        counts.set(prefix, r?.n ?? -1);
      }
    });
    assert.deepEqual(
      Object.fromEntries(counts),
      {
        [`${tag}-2h-%`]: 0,
        [`${tag}-61m-%`]: 0,
        [`${tag}-59m-%`]: 20,
        [`${tag}-45m-%`]: 20,
        [`${tag}-edge60`]: 1,
      },
    );
  });

  it('the sweep deletes at most 500 rows per hit', async (t) => {
    if (skip(t)) return;
    const tag = `old-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let remaining = -1;
    await rolledBack(async (tx) => {
      const now = Date.now();
      await tx`delete from public.session_admissions where created_at < ${new Date(now - 60 * 60_000)}`;
      await tx`insert into public.session_admissions (kind, subject, game_id, created_at)
        select 'ip', ${tag} || '-' || g, ${GAME}, ${new Date(now - 3 * 60 * 60_000)} from generate_series(1, 1200) g`;
      assert.equal(await admitSessionStart(tx, { uid: randomUUID(), ip: nextIp(), gameId: GAME, now }), true);
      const [r] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.session_admissions where subject like ${`${tag}-%`}`;
      remaining = r?.n ?? -1;
    });
    assert.equal(remaining, 200, 'one admission runs two hits, 500 swept rows each');
  });

  it('no raw ip lands in any public or private table', async (t) => {
    if (skip(t)) return;
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip: nextIp() }), true);
    assert.equal(await admit(sqlA, { uid: randomUUID(), ip: nextIp() }), true);
    const cols = await sqlA<{ s: string; t: string; c: string }[]>`
      select table_schema as s, table_name as t, column_name as c
      from information_schema.columns
      where table_schema in ('public', 'private')
        and data_type in ('text', 'character varying', 'character', 'inet', 'jsonb', 'json', 'name')`;
    const needles = [...runIps].map((ip) => `%${ip}%`);
    for (const { s, t, c } of cols) {
      const [r] = await sqlA<{ n: number }[]>`
        select count(*)::int as n from ${sqlA.unsafe(`"${s}"."${t}"`)}
        where ${sqlA.unsafe(`"${c}"`)}::text like any (${needles}::text[])`;
      assert.equal(r?.n ?? 0, 0, `${s}.${t}.${c} contains a raw test ip`);
    }
  });

  it('fails closed when the ip hash secret is unset, empty, or shorter than 32 chars', async (t) => {
    if (skip(t)) return;
    const prev = process.env.MG_IP_HASH_SECRET;
    try {
      for (const v of [undefined, '', 'x'.repeat(31)]) {
        if (v === undefined) delete process.env.MG_IP_HASH_SECRET;
        else process.env.MG_IP_HASH_SECRET = v;
        const [before] = await sqlA<{ n: number }[]>`
          select count(*)::int as n from public.session_admissions where game_id = ${GAME}`;
        await assert.rejects(
          () => admit(sqlA, { uid: randomUUID(), ip: nextIp() }),
          /MG_IP_HASH_SECRET/,
        );
        const [afterRows] = await sqlA<{ n: number }[]>`
          select count(*)::int as n from public.session_admissions where game_id = ${GAME}`;
        assert.equal(afterRows?.n, before?.n, 'no row may be written when the secret is unusable');
      }
    } finally {
      process.env.MG_IP_HASH_SECRET = prev ?? 'mg8b-b-test-secret-0000000000000';
    }
  });

  it('fails closed when the secret only reaches 32 chars padded with spaces', async (t) => {
    if (skip(t)) return;
    const prev = process.env.MG_IP_HASH_SECRET;
    try {
      process.env.MG_IP_HASH_SECRET = `  ${'x'.repeat(30)}  `;
      const [before] = await sqlA<{ n: number }[]>`
        select count(*)::int as n from public.session_admissions where game_id = ${GAME}`;
      await assert.rejects(
        () => admit(sqlA, { uid: randomUUID(), ip: nextIp() }),
        /MG_IP_HASH_SECRET/,
      );
      const [afterRows] = await sqlA<{ n: number }[]>`
        select count(*)::int as n from public.session_admissions where game_id = ${GAME}`;
      assert.equal(afterRows?.n, before?.n, 'no row may be written when the secret is unusable');
    } finally {
      process.env.MG_IP_HASH_SECRET = prev ?? 'mg8b-b-test-secret-0000000000000';
    }
  });

  it('fails closed on a whitespace-only secret of at least 32 chars', async (t) => {
    if (skip(t)) return;
    const prev = process.env.MG_IP_HASH_SECRET;
    try {
      for (const v of [' '.repeat(40), ' \t\n'.repeat(12)]) {
        process.env.MG_IP_HASH_SECRET = v;
        const [before] = await sqlA<{ n: number }[]>`
          select count(*)::int as n from public.session_admissions where game_id = ${GAME}`;
        await assert.rejects(
          () => admit(sqlA, { uid: randomUUID(), ip: nextIp() }),
          /MG_IP_HASH_SECRET/,
        );
        const [afterRows] = await sqlA<{ n: number }[]>`
          select count(*)::int as n from public.session_admissions where game_id = ${GAME}`;
        assert.equal(afterRows?.n, before?.n, 'no row may be written when the secret is unusable');
      }
    } finally {
      process.env.MG_IP_HASH_SECRET = prev ?? 'mg8b-b-test-secret-0000000000000';
    }
  });
});
