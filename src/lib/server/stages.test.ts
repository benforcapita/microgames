import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { describe, it } from 'node:test';
import { CREATED_GAME_LOOKUP, LISTABLE_STAGES, PUBLIC_STAGES, isListable, STAGES, canViewGame, isPublicStage, stageAfterValidation, visibleStages, type Stage, type ValidationStatus } from './game-rules.ts';

describe('visibleStages (every list query goes through this)', () => {
  it('never returns pending or rejected for any public list', () => {
    const publicCalls = [{}, { stage: 'proving' as Stage }, { stage: 'live' as Stage }, { stage: 'pending' as Stage }, { stage: 'rejected' as Stage },
      { includeUnpublished: true }, { stage: 'pending' as Stage, includeUnpublished: true }];
    for (const opts of publicCalls) {
      const v = visibleStages(opts);
      assert.ok(!v.includes('pending') && !v.includes('rejected'), JSON.stringify(opts));
    }
  });
  it('PV-1: public lists default to the listable stages only (live)', () => {
    assert.deepEqual(visibleStages(), ['live']);
    assert.deepEqual(visibleStages({ stage: 'live' }), ['live']);
    assert.deepEqual(visibleStages({ stage: 'proving' }), [], 'a public list asking for proving gets nothing');
    assert.deepEqual(visibleStages({ includeUnlisted: true }), ['live'], 'includeUnlisted without ownerId is ignored');
  });
  it('asking a public list for pending returns nothing (not everything)', () => {
    assert.deepEqual(visibleStages({ stage: 'pending' }), []);
    assert.deepEqual(visibleStages({ stage: 'rejected', ownerId: 'u1' }), []);
  });
  it('only an owner-scoped query may opt into unpublished games', () => {
    assert.deepEqual(visibleStages({ ownerId: 'u1', includeUnpublished: true }), [...STAGES]);
    assert.deepEqual(visibleStages({ ownerId: 'u1', stage: 'pending', includeUnpublished: true }), ['pending']);
    assert.deepEqual(visibleStages({ ownerId: 'u1' }), ['live']);
  });
  it('PV-1: only an owner-scoped query may opt into its own unlisted (proving) games', () => {
    assert.deepEqual(visibleStages({ ownerId: 'u1', includeUnlisted: true }), ['proving', 'live']);
    assert.deepEqual(visibleStages({ ownerId: 'u1', stage: 'proving', includeUnlisted: true }), ['proving']);
    assert.deepEqual(visibleStages({ ownerId: 'u1', stage: 'pending', includeUnlisted: true }), []);
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

describe('PV-1: isListable (the one listing predicate) = live AND headless passed', () => {
  it('only live games are listable; proving/pending/rejected never are', () => {
    assert.deepEqual([...LISTABLE_STAGES], ['live']);
    for (const s of STAGES) assert.equal(isListable({ stage: s }), s === 'live', s);
  });
  it('an explicit failed headless check unlists even a live game; a pass keeps it listed', () => {
    assert.equal(isListable({ stage: 'live', headlessPassed: false }), false);
    assert.equal(isListable({ stage: 'live', headlessPassed: true }), true);
    assert.equal(isListable({ stage: 'proving', headlessPassed: true }), false, 'headless pass alone does not list a proving game');
  });
  it('proving games stay playable by direct link (canViewGame) while unlisted', () => {
    assert.ok(canViewGame({ stage: 'proving', ownerId: 'o' }, null));
    assert.equal(isListable({ stage: 'proving' }), false);
  });
});

describe('PV-1: every list surface uses the predicate (no scattered stage filters)', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  it('games.ts: list/tag/stat/featured queries use LISTABLE_STAGES / visibleStages, never PUBLIC_STAGES', () => {
    const src = read('./games.ts');
    const listing = src.slice(src.indexOf('export async function listGames'), src.indexOf('export interface NewGame'));
    const getGameFn = listing.slice(listing.indexOf('export async function getGame'), listing.indexOf('export async function listTags'));
    assert.doesNotMatch(listing.replace(getGameFn, ''), /PUBLIC_STAGES/);
    assert.match(src, /listTags[\s\S]*?LISTABLE_STAGES/);
    assert.match(src, /export async function listGamesByIds\(ids: string\[\], device\?: DeviceKind\)[\s\S]*?LISTABLE_STAGES/);
  });
  it('pages: home has no proving row, /proving is owner-only, profile/related lists are listable-only, /play is noindex unless live', () => {
    const home = read('../../pages/index.astro');
    assert.doesNotMatch(home, /stage: 'proving'/);
    assert.doesNotMatch(home, /From the Proving Grounds/);
    const proving = read('../../pages/proving.astro');
    assert.match(proving, /userId \? await listGames\(\{ stage: 'proving', ownerId: userId, includeUnlisted: true/);
    const profile = read('../../pages/u/[creator].astro');
    assert.match(profile, /own \? \{ ownerId: user!\.id, includeUnlisted: true \}/);
    const play = read('../../pages/play/[slug].astro');
    assert.match(play, /noindex=\{!live\}/);
    assert.match(play, /if \(!live\) Astro\.response\.headers\.set\('X-Robots-Tag', 'noindex, nofollow'\)/);
    assert.match(play, /listGames\(\{ forkedFrom: game\.id, limit: 50, device \}\)/);
    assert.match(play, /listGames\(\{ creator: game\.creator, limit: 5, device \}\)/);
    assert.match(play, /isListable\(parentGame\)/);
    assert.match(read('../../layouts/Layout.astro'), /noindex && <meta name="robots" content="noindex, nofollow" \/>/);
    const me = read('../../pages/me.astro');
    assert.match(me, /const NO_STORE = 'private, no-store';/);
    assert.match(me, /Astro\.response\.headers\.set\('Cache-Control', NO_STORE\)/);
    assert.match(me, /const r = Astro\.redirect\('\/login\?next=\/me'\);\s*r\.headers\.set\('Cache-Control', NO_STORE\);\s*return r;/);
  });
});
