import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MG_UID_COOKIE,
  admitSessionStart,
  clientIp,
  secureCookie,
  createLimiter,
  createRatingGuard,
  newUid,
  parseUid,
  ratingGuard,
  sessionStartByIp,
  sessionStartByUid,
  telemetryByUid,
} from './abuse.ts';

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
