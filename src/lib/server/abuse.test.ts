import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MG_UID_COOKIE,
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
