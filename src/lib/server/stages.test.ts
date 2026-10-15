import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CREATED_GAME_LOOKUP, PUBLIC_STAGES, STAGES, canViewGame, isPublicStage, stageAfterValidation, visibleStages, type Stage, type ValidationStatus } from './game-rules.ts';

describe('visibleStages (every list query goes through this)', () => {
  it('never returns pending or rejected for any public list', () => {
    const publicCalls = [{}, { stage: 'proving' as Stage }, { stage: 'live' as Stage }, { stage: 'pending' as Stage }, { stage: 'rejected' as Stage },
      { includeUnpublished: true }, { stage: 'pending' as Stage, includeUnpublished: true }];
    for (const opts of publicCalls) {
      const v = visibleStages(opts);
      assert.ok(!v.includes('pending') && !v.includes('rejected'), JSON.stringify(opts));
    }
  });
  it('defaults to the published stages', () => {
    assert.deepEqual(visibleStages(), ['proving', 'live']);
    assert.deepEqual(visibleStages({ stage: 'live' }), ['live']);
  });
  it('asking a public list for pending returns nothing (not everything)', () => {
    assert.deepEqual(visibleStages({ stage: 'pending' }), []);
    assert.deepEqual(visibleStages({ stage: 'rejected', ownerId: 'u1' }), []);
  });
  it('only an owner-scoped query may opt into unpublished games', () => {
    assert.deepEqual(visibleStages({ ownerId: 'u1', includeUnpublished: true }), [...STAGES]);
    assert.deepEqual(visibleStages({ ownerId: 'u1', stage: 'pending', includeUnpublished: true }), ['pending']);
    assert.deepEqual(visibleStages({ ownerId: 'u1' }), ['proving', 'live']);
  });
  it('isPublicStage matches PUBLIC_STAGES', () => {
    for (const s of STAGES) assert.equal(isPublicStage(s), (PUBLIC_STAGES as readonly string[]).includes(s));
  });
});

describe('stageAfterValidation (auto-publish, no moderation)', () => {
  const cases: [Stage, ValidationStatus, Stage][] = [
    ['pending', 'passed', 'proving'],
    ['pending', 'failed', 'rejected'],
    ['pending', 'queued', 'pending'],
    ['pending', 'running', 'pending'],
    ['pending', 'error', 'pending'],
    ['proving', 'failed', 'proving'],
    ['live', 'failed', 'live'],
    ['live', 'passed', 'live'],
    ['rejected', 'passed', 'rejected'],
  ];
  for (const [from, status, to] of cases) it(`${from} + ${status} -> ${to}`, () => assert.equal(stageAfterValidation(from, status), to));
});

describe('canViewGame (/play for pending games)', () => {
  const owner = 'owner-uuid';
  const game = (stage: Stage, ownerId: string | null = owner) => ({ stage, ownerId });
  it('published games are visible to everyone', () => {
    for (const s of ['proving', 'live'] as Stage[]) for (const v of [undefined, null, 'someone', owner]) assert.ok(canViewGame(game(s), v));
  });
  it('the owner can open their own pending or rejected game', () => {
    assert.ok(canViewGame(game('pending'), owner));
    assert.ok(canViewGame(game('rejected'), owner));
  });
  it('other users and anonymous visitors get 404 for pending/rejected', () => {
    for (const s of ['pending', 'rejected'] as Stage[]) {
      for (const v of [undefined, null, '', 'someone-else']) assert.equal(canViewGame(game(s), v), false, `${s} ${v}`);
      assert.equal(canViewGame(game(s, null), null), false, 'ownerless game, anonymous');
      assert.equal(canViewGame(game(s, null), 'x'), false, 'ownerless game, signed in');
    }
    assert.equal(canViewGame(null, owner), false);
  });
});

describe('createGame reads back unpublished rows', () => {
  it('CREATED_GAME_LOOKUP includes unpublished games, so a pending upload does not return null', () => {
    assert.deepEqual(CREATED_GAME_LOOKUP, { includeUnpublished: true });
    assert.ok(visibleStages({ ownerId: 'u', ...CREATED_GAME_LOOKUP }).includes('pending'));
  });
  it('createGame uses it for its final read (no bare getGame(id)!)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./games.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function createGame'), src.indexOf('export async function deleteGame'));
    assert.match(body, /return \(await getGame\(id, CREATED_GAME_LOOKUP\)\)!;/);
    assert.doesNotMatch(body, /getGame\(id\)/);
  });
});
