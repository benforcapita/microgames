// Pure-function tests for the free-play gate. No Supabase client, database, or real secrets.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FREE_PLAY_COOKIE,
  FREE_PLAY_TTL_MS,
  decideGate,
  signFreePlayCookie,
  verifyFreePlayCookie,
  type FreePlayCookie,
} from './play-gate.ts';

const SECRET = 'test-only-play-gate-key';
const OTHER_SECRET = 'test-only-other-key';
const NOW = 1_700_000_000_000;
const GAME_A = 'stk7wr01';
const GAME_B = 'neon1an3';

function assertGrant(result: FreePlayCookie, gameId: string, exp?: number) {
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.gameId, gameId);
  if (exp !== undefined) assert.equal(result.exp, exp);
}

function assertRejected(result: FreePlayCookie, reason: 'missing' | 'malformed' | 'tampered' | 'expired') {
  assert.deepEqual(result, { ok: false, reason });
}

/** Flip one base64url character so the token still parses but the MAC cannot match. */
function flip(token: string, segment: 1 | 2): string {
  const parts = token.split('.');
  const chars = [...parts[segment]];
  const index = Math.min(3, chars.length - 1);
  chars[index] = chars[index] === 'A' ? 'B' : 'A';
  parts[segment] = chars.join('');
  return parts.join('.');
}

describe('free-play cookie', () => {
  test('names the cookie mg_free and round-trips the grant', () => {
    assert.equal(FREE_PLAY_COOKIE, 'mg_free');
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    assert.match(cookie, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(cookie.includes(SECRET), false);
    assertGrant(verifyFreePlayCookie(cookie, SECRET, NOW), GAME_A, NOW + 1_000);
  });

  test('is deterministic for the same grant and changes when the clock moves', () => {
    assert.equal(
      signFreePlayCookie(GAME_A, SECRET, NOW, 1_000),
      signFreePlayCookie(GAME_A, SECRET, NOW, 1_000),
    );
    assert.notEqual(
      signFreePlayCookie(GAME_A, SECRET, NOW, 1_000),
      signFreePlayCookie(GAME_A, SECRET, NOW + 1, 1_000),
    );
  });

  test('keeps header-unsafe game ids inside the signed payload', () => {
    const gameId = 'a;b\r\nSet-Cookie: evil';
    const cookie = signFreePlayCookie(gameId, SECRET, NOW, 1_000);
    assert.match(cookie, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assertGrant(verifyFreePlayCookie(cookie, SECRET, NOW), gameId);
  });

  test('rejects a flipped payload or signature', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    assertRejected(verifyFreePlayCookie(flip(cookie, 1), SECRET, NOW), 'tampered');
    assertRejected(verifyFreePlayCookie(flip(cookie, 2), SECRET, NOW), 'tampered');
  });

  test('rejects a payload signed by a different key', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    assertRejected(verifyFreePlayCookie(cookie, OTHER_SECRET, NOW), 'tampered');
  });

  test('rejects a payload grafted onto another signature', () => {
    const a = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    const b = signFreePlayCookie(GAME_B, SECRET, NOW, 1_000);
    const payloadA = a.split('.')[1];
    const signatureB = b.split('.')[2];
    assertRejected(verifyFreePlayCookie(`v1.${payloadA}.${signatureB}`, SECRET, NOW), 'tampered');
  });

  test('accepts a grant one millisecond before expiry and rejects it at expiry', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    assertGrant(verifyFreePlayCookie(cookie, SECRET, NOW + 999), GAME_A, NOW + 1_000);
    assertRejected(verifyFreePlayCookie(cookie, SECRET, NOW + 1_000), 'expired');
  });

  test('reports tamper even when the embedded expiry has already passed', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    assertRejected(verifyFreePlayCookie(flip(cookie, 1), SECRET, NOW + 5_000), 'tampered');
  });

  test('rejects missing and malformed cookies', () => {
    assertRejected(verifyFreePlayCookie(null, SECRET, NOW), 'missing');
    assertRejected(verifyFreePlayCookie(undefined, SECRET, NOW), 'missing');
    assertRejected(verifyFreePlayCookie('   ', SECRET, NOW), 'missing');

    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    const [version, payload, signature] = cookie.split('.');
    for (const bad of [
      'nope',
      `${version}.${payload}`,
      `v2.${payload}.${signature}`,
      `${version}.${payload}.${signature}.extra`,
      `${version}.ab c.${signature}`,
      `v1.${'a'.repeat(3_000)}.${'b'.repeat(40)}`,
    ]) {
      assertRejected(verifyFreePlayCookie(bad, SECRET, NOW), 'malformed');
    }
  });

  test('refuses an empty secret, an empty game id, and a non-positive ttl', () => {
    assert.throws(() => signFreePlayCookie(GAME_A, '', NOW), /secret/);
    assert.throws(() => signFreePlayCookie('', SECRET, NOW), /Game id/);
    assert.throws(() => signFreePlayCookie('x'.repeat(129), SECRET, NOW), /Game id/);
    assert.throws(() => signFreePlayCookie(GAME_A, SECRET, NOW, 0), /ttl/);
    assert.throws(() => verifyFreePlayCookie(null, SECRET, Number.NaN), /time/);
  });
});

describe('decideGate', () => {
  test('issues a grant the first time an anonymous visitor launches a game', () => {
    const decision = decideGate(null, GAME_A, null, { secret: SECRET, now: NOW });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'first_game');
    assert.equal(decision.cookieStatus, 'missing');
    assert.equal(decision.clearCookie, false);
    assert.equal(decision.expiresAt, NOW + FREE_PLAY_TTL_MS);
    assert.equal(typeof decision.setCookie, 'string');
    assertGrant(verifyFreePlayCookie(decision.setCookie, SECRET, NOW), GAME_A, NOW + FREE_PLAY_TTL_MS);
  });

  test('lets an anonymous visitor replay the granted game without rotating the cookie', () => {
    const issued = decideGate(null, GAME_A, null, { secret: SECRET, now: NOW });
    const replay = decideGate(issued.setCookie, GAME_A, null, { secret: SECRET, now: NOW + 5_000 });
    assert.equal(replay.allow, true);
    assert.equal(replay.reason, 'same_game');
    assert.equal(replay.setCookie, null);
    assert.equal(replay.clearCookie, false);
    assert.equal(replay.expiresAt, NOW + FREE_PLAY_TTL_MS);
    assert.equal(replay.cookieStatus, 'ok');
  });

  test('blocks an anonymous visitor from a second game and keeps the original grant', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    const blocked = decideGate(cookie, GAME_B, null, { secret: SECRET, now: NOW });
    assert.equal(blocked.allow, false);
    assert.equal(blocked.reason, 'other_game');
    assert.equal(blocked.setCookie, null);
    assert.equal(blocked.clearCookie, false);
    assert.equal(blocked.expiresAt, NOW + 1_000);
    assert.equal(blocked.cookieStatus, 'ok');
    assertGrant(verifyFreePlayCookie(cookie, SECRET, NOW), GAME_A, NOW + 1_000);
  });

  test('treats game ids as case-sensitive', () => {
    const cookie = signFreePlayCookie('Game-A', SECRET, NOW, 1_000);
    const decision = decideGate(cookie, 'game-a', null, { secret: SECRET, now: NOW });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'other_game');
  });

  test('replaces an expired grant, including with a different game', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    const replay = decideGate(cookie, GAME_A, null, { secret: SECRET, now: NOW + 999 });
    assert.equal(replay.reason, 'same_game');

    const expired = decideGate(cookie, GAME_B, null, { secret: SECRET, now: NOW + 1_000 });
    assert.equal(expired.allow, true);
    assert.equal(expired.reason, 'first_game');
    assert.equal(expired.cookieStatus, 'expired');
    assert.equal(expired.expiresAt, NOW + 1_000 + FREE_PLAY_TTL_MS);
    assertGrant(verifyFreePlayCookie(expired.setCookie, SECRET, NOW + 1_000), GAME_B);
  });

  test('does not honor a tampered cookie as a grant', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    const tampered = flip(cookie, 1);
    const same = decideGate(tampered, GAME_A, null, { secret: SECRET, now: NOW });
    assert.equal(same.allow, true);
    assert.equal(same.reason, 'first_game');
    assert.equal(same.cookieStatus, 'tampered');
    assert.notEqual(same.setCookie, tampered);
    assertGrant(verifyFreePlayCookie(same.setCookie, SECRET, NOW), GAME_A);

    const other = decideGate(tampered, GAME_B, null, { secret: SECRET, now: NOW });
    assert.equal(other.reason, 'first_game');
    assert.equal(other.cookieStatus, 'tampered');
    assertGrant(verifyFreePlayCookie(other.setCookie, SECRET, NOW), GAME_B);
  });

  test('treats a malformed cookie as no grant', () => {
    const decision = decideGate('v1.not-a-grant', GAME_A, null, { secret: SECRET, now: NOW, ttlMs: 5_000 });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'first_game');
    assert.equal(decision.cookieStatus, 'malformed');
    assert.equal(decision.expiresAt, NOW + 5_000);
    assertGrant(verifyFreePlayCookie(decision.setCookie, SECRET, NOW), GAME_A, NOW + 5_000);
  });

  test('lets a signed-in visitor play any game and clears a stored grant', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    const decision = decideGate(cookie, GAME_B, { id: 'user-1' }, { secret: SECRET, now: NOW });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'signed_in');
    assert.equal(decision.setCookie, null);
    assert.equal(decision.clearCookie, true);
    assert.equal(decision.expiresAt, null);
    assert.equal(decision.cookieStatus, 'ok');
  });

  test('does not ask to clear a cookie the signed-in visitor does not have', () => {
    const decision = decideGate(null, GAME_B, { id: 'user-1' }, { secret: SECRET, now: NOW });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'signed_in');
    assert.equal(decision.clearCookie, false);
    assert.equal(decision.cookieStatus, 'missing');
  });

  test('still clears a tampered cookie once the visitor is signed in', () => {
    const cookie = signFreePlayCookie(GAME_A, SECRET, NOW, 1_000);
    const decision = decideGate(flip(cookie, 2), GAME_B, { id: 'user-1' }, { secret: SECRET, now: NOW });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'signed_in');
    assert.equal(decision.clearCookie, true);
    assert.equal(decision.setCookie, null);
    assert.equal(decision.cookieStatus, 'tampered');
  });

  test('treats a blank user id as anonymous', () => {
    const decision = decideGate(undefined, GAME_A, { id: '   ' }, { secret: SECRET, now: NOW, ttlMs: 50 });
    assert.equal(decision.reason, 'first_game');
    assert.equal(decision.expiresAt, NOW + 50);
  });

  test('fails closed without a secret or a game id', () => {
    assert.throws(() => decideGate(null, GAME_A, null, { secret: '', now: NOW }), /secret/);
    assert.throws(() => decideGate(null, '   ', null, { secret: SECRET, now: NOW }), /Game id/);
    assert.throws(() => decideGate(null, GAME_A, null, { secret: SECRET, now: NOW, ttlMs: -1 }), /ttl/);
  });
});
