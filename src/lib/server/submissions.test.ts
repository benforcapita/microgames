import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  buildSubmissionView,
  dbFailureKind,
  handleSubmissionStatus,
  placeholderValidation,
  planGameUpload,
  type PendingGameInput,
  type SubmissionGame,
  type SubmissionStore,
  type ValidationRow,
} from './submissions.ts';

const HTML = '<html><body><canvas id="c"></canvas></body></html>';

function form(): FormData {
  const fd = new FormData();
  fd.set('title', 'Sky Loop');
  fd.set('license', 'MIT');
  fd.set('agree', 'on');
  fd.set('game', new File([HTML], 'game.html', { type: 'text/html' }));
  fd.set('tags', 'Arcade, Physics');
  return fd;
}

function game(patch: Partial<SubmissionGame> = {}): SubmissionGame {
  return {
    id: 'game1234',
    slug: 'sky-loop',
    title: 'Sky Loop',
    ownerId: 'owner-1',
    stage: 'pending',
    ...patch,
  };
}

function validation(patch: Partial<ValidationRow> = {}): ValidationRow {
  return {
    id: 'val-1',
    gameId: 'game1234',
    version: 1,
    status: 'running',
    staticReport: {
      checks: [
        { id: 'size', label: 'File size', level: 'pass', message: 'Under 5 MB.' },
        { id: 'hosts', name: 'Network allowlist', level: 'fail', message: 'fetch() calls https://evil.example.' },
      ],
    },
    runReport: {
      checks: [{ id: 'boot', name: 'First frame', level: 'warn', message: 'First frame took 2.4 s.' }],
      console: ['boot ok'],
      blocked_requests: ['https://evil.example/x'],
      timings: { firstFrameMs: 2400 },
    },
    screenshotPaths: ['game1234/validation/3s.png'],
    createdAt: '2026-10-15T09:00:00.000Z',
    finishedAt: null,
    ...patch,
  };
}

function memory(row: SubmissionGame | null, latest: ValidationRow | null | 'missing'): SubmissionStore & { reads: number } {
  return {
    reads: 0,
    async getGame(id) {
      return row && row.id === id ? row : null;
    },
    async latestValidation() {
      this.reads += 1;
      if (latest === 'missing') {
        const err = new Error('relation "game_validations" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
      return latest;
    },
  };
}

describe('upload creates a pending game', () => {
  it('redirects the owner to /submissions/:id and enqueues validation', async () => {
    const created: PendingGameInput[] = [];
    const queued: string[] = [];
    const result = await planGameUpload({
      user: { id: 'owner-1' },
      profile: { handle: 'ada' },
      form: form(),
      findGame: async () => null,
      createGame: async (input) => {
        created.push(input);
        return { id: 'game1234' };
      },
      enqueueValidation: async (gameId, report) => {
        queued.push(gameId);
        assert.equal(report.status, 'pass');
        assert.equal(report.checks.length, 0);
        assert.equal(report.bytes, HTML.length);
      },
    });

    assert.equal(result.type, 'redirect');
    if (result.type !== 'redirect') return;
    assert.equal(result.location, '/submissions/game1234');
    assert.equal(result.stage, 'pending');
    assert.equal(created.length, 1);
    assert.equal(created[0].stage, 'pending');
    assert.equal(created[0].creator, 'ada');
    assert.deepEqual(created[0].tags, ['arcade', 'physics']);
    assert.deepEqual(queued, ['game1234']);
  });

  it('does not create a game when the visitor is logged out or the file is rejected', async () => {
    let created = 0;
    const loggedOut = await planGameUpload({
      user: null,
      profile: null,
      form: form(),
      findGame: async () => null,
      createGame: async () => {
        created += 1;
        return { id: 'x' };
      },
      enqueueValidation: async () => {},
    });
    assert.equal(loggedOut.type, 'errors');
    if (loggedOut.type === 'errors') assert.equal(loggedOut.status, 401);

    const bad = await planGameUpload({
      user: { id: 'owner-1' },
      profile: { handle: 'ada' },
      form: new FormData(),
      findGame: async () => null,
      createGame: async () => {
        created += 1;
        return { id: 'x' };
      },
      enqueueValidation: async () => {},
    });
    assert.equal(bad.type, 'errors');
    if (bad.type === 'errors') assert.equal(bad.status, 400);
    assert.equal(created, 0);
  });

  it('still opens the status page when game_validations is missing, and refuses a stage check failure', async () => {
    const missing = await planGameUpload({
      user: { id: 'owner-1' },
      profile: { handle: 'ada' },
      form: form(),
      findGame: async () => null,
      createGame: async () => ({ id: 'game1234' }),
      enqueueValidation: async () => {
        const err = new Error('relation "game_validations" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      },
    });
    assert.equal(missing.type, 'redirect');

    const rejected = await planGameUpload({
      user: { id: 'owner-1' },
      profile: { handle: 'ada' },
      form: form(),
      findGame: async () => null,
      createGame: async () => {
        const err = new Error('new row for relation "games" violates check constraint "games_stage_check"') as Error & { code: string };
        err.code = '23514';
        throw err;
      },
      enqueueValidation: async () => {
        throw new Error('should not enqueue');
      },
    });
    assert.deepEqual(rejected, {
      type: 'errors',
      status: 503,
      errors: ['This database does not accept pending submissions yet. Apply the submissions migration, then upload again.'],
    });
  });

  it('writes stage pending in the games insert', () => {
    const src = readFileSync(new URL('./games.ts', import.meta.url), 'utf8');
    assert.match(src, /const stage = input\.stage \?\? 'pending'/);
    assert.match(src, /thumb, stage\)/);
  });
});

describe('submission status endpoint', () => {
  it('returns check results to the owner and hides the game from everyone else', async () => {
    const store = memory(game(), validation());
    const res = await handleSubmissionStatus({ userId: 'owner-1', gameId: 'game1234', store });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.game.title, 'Sky Loop');
    assert.equal(body.game.stage, 'pending');
    assert.equal(body.validation.status, 'running');
    assert.equal(body.terminal, false);
    assert.equal(body.published, false);
    assert.deepEqual(
      body.validation.checks.map((c: { id: string; level: string; source: string }) => [c.id, c.level, c.source]),
      [['size', 'pass', 'static'], ['hosts', 'fail', 'static'], ['boot', 'warn', 'run']],
    );
    assert.deepEqual(body.validation.blockedRequests, ['https://evil.example/x']);
    assert.equal(body.validation.timings.firstFrameMs, 2400);
    assert.equal(body.publish, undefined);
    assert.equal(body.canPublish, undefined);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const stranger = await handleSubmissionStatus({ userId: 'other', gameId: 'game1234', store });
    assert.equal(stranger.status, 404);
    const hidden = (await stranger.json()) as { error?: string; title?: string; game?: unknown };
    assert.equal(hidden.error, 'Not found');
    assert.equal(hidden.title, undefined);
    assert.equal(hidden.game, undefined);

    const anon = await handleSubmissionStatus({ userId: null, gameId: 'game1234', store });
    assert.equal(anon.status, 401);

    const missing = await handleSubmissionStatus({ userId: 'owner-1', gameId: 'nope', store });
    assert.equal(missing.status, 404);
  });

  it('keeps polling after a pass until the stage leaves pending, with no publish action', () => {
    const pending = buildSubmissionView(game(), validation({ status: 'passed', finishedAt: '2026-10-15T09:05:00.000Z' }));
    assert.equal(pending.terminal, false);
    assert.equal(pending.published, false);
    assert.equal(pending.headline, 'Passed');
    assert.match(pending.detail, /Publishing to the Proving Grounds/);
    assert.equal('publish' in pending, false);

    const live = buildSubmissionView(game({ stage: 'proving' }), validation({ status: 'passed' }));
    assert.equal(live.terminal, true);
    assert.equal(live.published, true);

    const failed = buildSubmissionView(game({ stage: 'rejected' }), validation({ status: 'failed' }));
    assert.equal(failed.terminal, true);
    assert.equal(failed.published, false);
    assert.match(failed.detail, /Nothing was published/);
  });

  it('serves a spec-shaped placeholder when game_validations does not exist', async () => {
    const store = memory(game(), 'missing');
    const res = await handleSubmissionStatus({ userId: 'owner-1', gameId: 'game1234', store });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.validation.mocked, true);
    assert.equal(body.validation.status, 'queued');
    assert.equal(body.validation.checks[0].level, 'warn');
    assert.match(body.validation.checks[0].message, /game_validations/);
    assert.equal(body.terminal, false);

    const again = await handleSubmissionStatus({ userId: 'owner-1', gameId: 'game1234', store });
    const second = await again.json();
    assert.equal(second.stamp, body.stamp);
    assert.equal(dbFailureKind(Object.assign(new Error('games_stage_check'), { code: '23514' })), 'stage_rejected');
    assert.equal(placeholderValidation('game1234').mocked, true);
  });
});

describe('submission page', () => {
  it('has no publish control', () => {
    const page = readFileSync(new URL('../../pages/submissions/[id].astro', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../../pages/api/submissions/[id].ts', import.meta.url), 'utf8');
    assert.doesNotMatch(page, /<button|\/publish|Publish to/);
    assert.match(page, /\/api\/submissions\//);
    assert.match(route, /handleSubmissionStatus/);
    assert.doesNotMatch(route, /publish/i);
  });
});
