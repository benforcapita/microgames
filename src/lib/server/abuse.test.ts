import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEVICE_RATING_MESSAGE,
  MG_UID_COOKIE,
  RATING_LIMIT_MESSAGE,
  RATING_WRITES_MAX,
  RATING_WRITES_WINDOW_MS,
  SELF_RATING_MESSAGE,
  admitSessionStart,
  authorizeRating,
  clientIp,
  createLimiter,
  createRatingGuard,
  createRatingWriteLimiter,
  newUid,
  parseUid,
  ratingGuard,
  ratingWritesByUser,
  secureCookie,
  sessionIpSubject,
  sessionStartByIp,
  sessionStartByUid,
  telemetryByUid,
} from './abuse.ts';

const TEST_SECRET = 'mg8b-a-test-secret-0000000000000';
process.env.MG_IP_HASH_SECRET = TEST_SECRET;

describe('session_start limiter', () => {
  it('allows repeated session_start from same uid+game within window once (simulate 50 hits -> 1 allowed)', () => {
    let now = 1_000_000;
    const limiter = createLimiter({ windowMs: 30 * 60_000, max: 1, now: () => now });
    const key = 'uid-123:game-456';
    let plays = 0;
    for (let i = 0; i < 50; i++) {
      if (limiter.hit(key)) {
        plays++;
      }
    }
    assert.equal(plays, 1);
  });

  it('allows again after window via injected now', () => {
    let now = 1_000_000;
    const windowMs = 30 * 60_000;
    const limiter = createLimiter({ windowMs, max: 1, now: () => now });
    const key = 'uid-123:game-456';

    assert.equal(limiter.hit(key), true);
    assert.equal(limiter.hit(key), false);

    now += windowMs;
    assert.equal(limiter.hit(key), true);
    assert.equal(limiter.hit(key), false);
  });

  it('keeps different uids and games independent', () => {
    const limiter = createLimiter({ windowMs: 30 * 60_000, max: 1 });
    assert.equal(limiter.hit('uid1:game1'), true);
    assert.equal(limiter.hit('uid1:game1'), false);

    assert.equal(limiter.hit('uid2:game1'), true);
    assert.equal(limiter.hit('uid1:game2'), true);
    assert.equal(limiter.hit('uid2:game2'), true);

    assert.equal(limiter.hit('uid2:game1'), false);
    assert.equal(limiter.hit('uid1:game2'), false);
    assert.equal(limiter.hit('uid2:game2'), false);
  });
});

describe('IP limiter', () => {
  it('caps at max', () => {
    const limiter = createLimiter({ windowMs: 60 * 60_000, max: 20 });
    const key = '127.0.0.1:game-1';
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      if (limiter.hit(key)) {
        allowed++;
      }
    }
    assert.equal(allowed, 20);
  });
});

describe('map eviction', () => {
  it('bounds map eviction and evicts oldest', () => {
    let now = 1000;
    const limiter = createLimiter({ windowMs: 60_000, max: 1, maxKeys: 3, now: () => now });

    assert.equal(limiter.hit('k1'), true);
    assert.equal(limiter.hit('k2'), true);
    assert.equal(limiter.hit('k3'), true);
    assert.equal(limiter.size, 3);

    assert.equal(limiter.hit('k4'), true);
    assert.equal(limiter.size, 3);

    assert.equal(limiter.hit('k2'), false);
    assert.equal(limiter.hit('k3'), false);
    assert.equal(limiter.hit('k4'), false);

    assert.equal(limiter.hit('k1'), true);
    assert.equal(limiter.size, 3);
    assert.equal(limiter.hit('k2'), true);
  });

  it('evicts expired keys', () => {
    let now = 1000;
    const limiter = createLimiter({ windowMs: 1000, max: 1, maxKeys: 10, now: () => now });
    assert.equal(limiter.hit('k1'), true);
    assert.equal(limiter.size, 1);

    now += 1500;
    assert.equal(limiter.hit('k2'), true);
    assert.equal(limiter.size, 1);
  });
});

describe('ratingGuard', () => {
  it('rejects second voter for same uid, allows same voter update, and allows different game', () => {
    const guard = createRatingGuard();
    const uid = 'device-uid-1';
    const game1 = 'game-1';
    const game2 = 'game-2';
    const voter1 = 'voter-alice';
    const voter2 = 'voter-bob';

    assert.equal(guard.allow(uid, game1, voter1), true);
    assert.equal(guard.allow(uid, game1, voter1), true);
    assert.equal(guard.allow(uid, game1, voter2), false);
    assert.equal(guard.allow(uid, game2, voter2), true);
    assert.equal(guard.allow('device-uid-2', game1, voter2), true);
  });

  it('caps map size to bounded limit', () => {
    const guard = createRatingGuard({ maxEntries: 2 });
    assert.equal(guard.allow('u1', 'g1', 'v1'), true);
    assert.equal(guard.allow('u2', 'g2', 'v2'), true);
    assert.equal(guard.size, 2);

    assert.equal(guard.allow('u3', 'g3', 'v3'), true);
    assert.equal(guard.size, 2);
  });
});

describe('parseUid', () => {
  it('accepts valid UUIDs and returns lowercased', () => {
    const valid = 'c3f87532-6a68-4fbb-a796-7bbde10d2938';
    assert.equal(parseUid(valid), valid);
    assert.equal(parseUid(valid.toUpperCase()), valid);

    const generated = newUid();
    assert.equal(parseUid(generated), generated.toLowerCase());
  });

  it('rejects invalid uids', () => {
    assert.equal(parseUid(null), null);
    assert.equal(parseUid(undefined), null);
    assert.equal(parseUid(''), null);
    assert.equal(parseUid('   '), null);
    assert.equal(parseUid('not-a-uuid'), null);
    assert.equal(parseUid(12345), null);
    assert.equal(parseUid({}), null);
    assert.equal(parseUid('c3f87532-6a68-4fbb-a796-7bbde10d293'), null);
    assert.equal(parseUid('c3f87532-6a68-4fbb-a796-7bbde10d29388'), null);
    assert.equal(parseUid('g3f87532-6a68-4fbb-a796-7bbde10d2938'), null);
  });
});

describe('singletons', () => {
  it('exports expected singletons and constants', () => {
    assert.equal(MG_UID_COOKIE, 'mg_uid');
    assert.equal(typeof sessionStartByUid.hit, 'function');
    assert.equal(typeof sessionStartByIp.hit, 'function');
    assert.equal(typeof telemetryByUid.hit, 'function');
    assert.equal(typeof ratingGuard.allow, 'function');
    assert.equal(typeof ratingWritesByUser.hit, 'function');
    assert.equal(RATING_WRITES_MAX, 30);
    assert.equal(RATING_WRITES_WINDOW_MS, 60 * 60_000);
  });
});

describe('clientIp', () => {
  it('on Vercel, 25 distinct client IPs behind one socket are each counted (not collapsed by the IP cap)', () => {
    const byIp = createLimiter({ windowMs: 60 * 60_000, max: 20 });
    const byUid = createLimiter({ windowMs: 30 * 60_000, max: 1 });
    let counted = 0;
    for (let i = 1; i <= 25; i++) {
      const headers = new Headers({ 'x-vercel-forwarded-for': `203.0.113.${i}` });
      const ip = clientIp(headers, '10.0.0.1', true);
      assert.equal(ip, `203.0.113.${i}`);
      if (admitSessionStart(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ip, 'g1', byUid, byIp)) counted++;
    }
    assert.equal(counted, 25);
  });

  it('falls back to x-real-ip on Vercel, then the socket', () => {
    assert.equal(clientIp(new Headers({ 'x-real-ip': '198.51.100.7' }), '10.0.0.1', true), '198.51.100.7');
    assert.equal(clientIp(new Headers(), '10.0.0.1', true), '10.0.0.1');
  });

  it('never trusts raw X-Forwarded-For, and ignores Vercel headers off Vercel', () => {
    const forged = new Headers({
      'x-forwarded-for': '1.2.3.4',
      'x-vercel-forwarded-for': '5.6.7.8',
      'x-real-ip': '9.9.9.9',
    });
    assert.equal(clientIp(forged, '127.0.0.1', false), '127.0.0.1');
    assert.equal(clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4' }), '10.0.0.1', true), '10.0.0.1');
    assert.equal(clientIp(new Headers(), undefined, false), 'unknown');
  });
});

describe('secureCookie', () => {
  it('is Secure in production or on Vercel even over http, and over https anywhere', () => {
    assert.equal(secureCookie('http:', true, false), true);
    assert.equal(secureCookie('http:', false, true), true);
    assert.equal(secureCookie('https:', false, false), true);
    assert.equal(secureCookie('http:', false, false), false);
  });
});

describe('sessionIpSubject', () => {
  const ip = '203.0.113.44';
  const noon = new Date(Date.UTC(2026, 9, 19, 12));

  it('is stable within a UTC day and rotates across UTC days', () => {
    const day = sessionIpSubject(ip, 's1', noon);
    assert.equal(sessionIpSubject(ip, 's1', new Date(Date.UTC(2026, 9, 19, 23, 59))), day);
    assert.notEqual(sessionIpSubject(ip, 's1', new Date(Date.UTC(2026, 9, 20, 0, 30))), day);
  });

  it('differs per ip and per secret, is 64-hex, and never exposes the ip', () => {
    const a = sessionIpSubject(ip, 's1', noon);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(sessionIpSubject('198.51.100.9', 's1', noon), a);
    assert.notEqual(sessionIpSubject(ip, 's2', noon), a);
    assert.equal(a.includes(ip), false);
  });
});

describe('admitSessionStart ip keys', () => {
  it('spends the ip budget under the hashed subject, never the raw ip', () => {
    const byIp = createLimiter({ windowMs: 60_000, max: 1 });
    const byUid = createLimiter({ windowMs: 60_000, max: 1 });
    const devA = '00000000-0000-4000-8000-0000000000aa';
    const devB = '00000000-0000-4000-8000-0000000000bb';
    assert.equal(admitSessionStart(devA, '203.0.113.7', 'g', byUid, byIp), true);
    assert.equal(byIp.check('203.0.113.7:g'), true, 'raw ip must not be a limiter key');
    assert.equal(
      admitSessionStart(devB, '203.0.113.7', 'g', byUid, byIp),
      false,
      'the same ip still dedupes through the hashed subject',
    );
  });

  it('an ip that exhausts its hourly starts on one game is still admitted on another', () => {
    const byIp = createLimiter({ windowMs: 60 * 60_000, max: 20 });
    const byUid = createLimiter({ windowMs: 30 * 60_000, max: 1 });
    const dev = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let i = 0; i < 20; i++) {
      assert.equal(admitSessionStart(dev(i), '203.0.113.21', 'g1', byUid, byIp), true, `start ${i + 1}`);
    }
    assert.equal(admitSessionStart(dev(20), '203.0.113.21', 'g1', byUid, byIp), false, 'g1 budget spent');
    assert.equal(admitSessionStart(dev(21), '203.0.113.21', 'g2', byUid, byIp), true, 'g2 has its own budget');
    assert.equal(admitSessionStart(dev(22), '203.0.113.22', 'g1', byUid, byIp), true, 'other ip unaffected');
  });

  it('fails closed when MG_IP_HASH_SECRET is unset, empty, or shorter than 32 chars', () => {
    const prev = process.env.MG_IP_HASH_SECRET;
    const dev = '00000000-0000-4000-8000-0000000000aa';
    try {
      for (const v of [undefined, '', 'x'.repeat(31)]) {
        if (v === undefined) delete process.env.MG_IP_HASH_SECRET;
        else process.env.MG_IP_HASH_SECRET = v;
        assert.throws(
          () => admitSessionStart(dev, '203.0.113.7', 'g'),
          (e: unknown) =>
            e instanceof Error &&
            /MG_IP_HASH_SECRET/.test(e.message) &&
            !e.message.includes('203.0.113.7') &&
            (v === undefined || v === '' || !e.message.includes(v)),
        );
      }
    } finally {
      process.env.MG_IP_HASH_SECRET = prev ?? TEST_SECRET;
    }
  });

  it('accepts a 32-char MG_IP_HASH_SECRET', () => {
    const prev = process.env.MG_IP_HASH_SECRET;
    process.env.MG_IP_HASH_SECRET = 'x'.repeat(32);
    try {
      const byIp = createLimiter({ windowMs: 60_000, max: 1 });
      const byUid = createLimiter({ windowMs: 60_000, max: 1 });
      assert.equal(admitSessionStart('00000000-0000-4000-8000-0000000000aa', '203.0.113.7', 'g', byUid, byIp), true);
    } finally {
      process.env.MG_IP_HASH_SECRET = prev ?? TEST_SECRET;
    }
  });
});

describe('admitSessionStart', () => {
  it('an IP-cap drop does not consume the device 30-min dedupe slot', () => {
    let t = 0;
    const now = () => t;
    const byIp = createLimiter({ windowMs: 60 * 60_000, max: 1, now });
    const byUid = createLimiter({ windowMs: 30 * 60_000, max: 1, now });
    const devA = '00000000-0000-4000-8000-00000000000a';
    const devB = '00000000-0000-4000-8000-00000000000b';
    assert.equal(admitSessionStart(devA, '1.1.1.1', 'g', byUid, byIp), true);
    // IP cap now full: device B is dropped by the IP limiter...
    assert.equal(admitSessionStart(devB, '1.1.1.1', 'g', byUid, byIp), false);
    // ...but its device slot is untouched, so from another IP it is still counted.
    assert.equal(byUid.check(`${devB}:g`), true);
    assert.equal(admitSessionStart(devB, '2.2.2.2', 'g', byUid, byIp), true);
    // and then deduped within the window
    assert.equal(admitSessionStart(devB, '3.3.3.3', 'g', byUid, byIp), false);
  });

  it('a device duplicate does not consume IP budget', () => {
    const byIp = createLimiter({ windowMs: 60_000, max: 2 });
    const byUid = createLimiter({ windowMs: 60_000, max: 1 });
    const dev = '00000000-0000-4000-8000-0000000000aa';
    assert.equal(admitSessionStart(dev, '1.1.1.1', 'g', byUid, byIp), true);
    for (let i = 0; i < 10; i++) assert.equal(admitSessionStart(dev, '1.1.1.1', 'g', byUid, byIp), false);
    assert.equal(admitSessionStart('00000000-0000-4000-8000-0000000000bb', '1.1.1.1', 'g', byUid, byIp), true);
  });
});

describe('authorizeRating', () => {
  const owner = 'user-owner';
  const fan = 'user-fan';
  const other = 'user-other';

  function fresh(now?: () => number) {
    return { guard: createRatingGuard(), writes: createRatingWriteLimiter(now) };
  }

  it('refuses the owner with 403 and does not take the device slot or an hourly write', () => {
    const { guard, writes } = fresh();
    const denied = authorizeRating(owner, owner, 'device-1', 'game-1', guard, writes);
    assert.equal(denied.ok, false);
    if (denied.ok) return;
    assert.equal(denied.status, 403);
    assert.equal(denied.message, SELF_RATING_MESSAGE);
    assert.equal(denied.message, "You can't rate your own game.");
    assert.equal(guard.size, 0);
    assert.equal(writes.check(owner), true);

    const fanOnSameDevice = authorizeRating(owner, fan, 'device-1', 'game-1', guard, writes);
    assert.equal(fanOnSameDevice.ok, true);
  });

  it('allows a rating when the game has no owner', () => {
    const { guard, writes } = fresh();
    assert.deepEqual(authorizeRating(null, fan, 'device-1', 'game-1', guard, writes), { ok: true });
  });

  it('allows the same voter to update and rejects a second account on that device without spending their hourly writes', () => {
    const { guard, writes } = fresh();
    assert.equal(authorizeRating(owner, fan, 'device-1', 'game-1', guard, writes).ok, true);
    assert.equal(authorizeRating(owner, fan, 'device-1', 'game-1', guard, writes).ok, true);

    const conflict = authorizeRating(owner, other, 'device-1', 'game-1', guard, writes);
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.status, 409);
    assert.equal(conflict.message, DEVICE_RATING_MESSAGE);
    assert.equal(conflict.message, 'Already rated from this device');
    assert.equal(writes.check(other), true);

    assert.equal(authorizeRating(owner, other, 'device-2', 'game-1', guard, writes).ok, true);
  });

  it('caps rating writes at 30 per user per hour across games, then allows again after the window', () => {
    let now = 1_000_000;
    const { guard, writes } = fresh(() => now);
    for (let i = 0; i < RATING_WRITES_MAX; i++) {
      const decision = authorizeRating(owner, fan, `device-${i}`, `game-${i}`, guard, writes);
      assert.equal(decision.ok, true, `write ${i + 1}`);
    }
    const blocked = authorizeRating(owner, fan, 'device-extra', 'game-extra', guard, writes);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.status, 429);
    assert.equal(blocked.message, RATING_LIMIT_MESSAGE);
    assert.equal(blocked.message, 'Too many ratings');

    const otherUser = authorizeRating(owner, other, 'device-other', 'game-other', guard, writes);
    assert.equal(otherUser.ok, true);

    now += RATING_WRITES_WINDOW_MS - 1;
    const still = authorizeRating(owner, fan, 'device-late', 'game-late', guard, writes);
    assert.equal(still.ok, false);
    if (!still.ok) assert.equal(still.status, 429);

    now += 1;
    assert.equal(authorizeRating(owner, fan, 'device-next', 'game-next', guard, writes).ok, true);
  });

  it('counts star updates toward the same hourly cap', () => {
    const { guard, writes } = fresh();
    for (let i = 0; i < RATING_WRITES_MAX; i++) {
      assert.equal(authorizeRating(null, fan, 'device-1', 'game-1', guard, writes).ok, true);
    }
    const blocked = authorizeRating(null, fan, 'device-1', 'game-1', guard, writes);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.status, 429);
  });

  it('does not let repeated self-ratings consume the hourly cap', () => {
    const { guard, writes } = fresh();
    for (let i = 0; i < RATING_WRITES_MAX + 5; i++) {
      const denied = authorizeRating(owner, owner, 'device-1', 'game-1', guard, writes);
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.status, 403);
    }
    for (let i = 0; i < RATING_WRITES_MAX; i++) {
      assert.equal(authorizeRating('someone-else', owner, `device-${i}`, `game-${i}`, guard, writes).ok, true);
    }
    const blocked = authorizeRating('someone-else', owner, 'device-x', 'game-x', guard, writes);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.status, 429);
  });
});
