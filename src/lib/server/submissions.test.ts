import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  VALIDATION_ENQUEUE_ERROR,
  buildSubmissionView,
  coerceQueuedStaticReport,
  handleSubmissionStatus,
  planGameUpload,
  preferValidation,
  type PendingGameInput,
  type SubmissionGame,
  type SubmissionStore,
  type ValidationRow,
} from './submissions.ts';

const HTML = '<html><body><canvas id="c"></canvas></body></html>';

/** Minimal PNG header: 64×36, under the thumbnail dimension cap. */
function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  bytes[19] = 64;
  bytes[23] = 36;
  return bytes;
}

function form(): FormData {
  const fd = new FormData();
  fd.set('title', 'Sky Loop');
  fd.set('license', 'MIT');
  fd.set('agree', 'on');
  fd.set('game', new File([HTML], 'game.html', { type: 'text/html' }));
  fd.set('thumb', new File([new Uint8Array(pngBytes())], 'shot.png', { type: 'image/png' }));
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

function memory(row: SubmissionGame | null, latest: ValidationRow | null): SubmissionStore & { reads: number } {
  return {
    reads: 0,
    async getGame(id) {
      return row && row.id === id ? row : null;
    },
    async latestValidation() {
      this.reads += 1;
      return latest;
    },
  };
}

describe('upload creates a pending game', () => {
  it('redirects the owner to /submissions/:id without writing a validation row', async () => {
    const created: PendingGameInput[] = [];
    let enqueued = 0;
    const result = await planGameUpload({
      user: { id: 'owner-1' },
      profile: { handle: 'ada' },
      form: form(),
      findGame: async () => null,
      createGame: async (input) => {
        created.push(input);
        return { id: 'game1234' };
      },
      enqueueValidation: async () => {
        enqueued += 1;
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
    // The optional hook may run, but it receives no static report to fake a pass.
    assert.equal(enqueued, 1);
  });

  it('does not require an app-level validation insert', async () => {
    const result = await planGameUpload({
      user: { id: 'owner-1' },
      profile: { handle: 'ada' },
      form: form(),
      findGame: async () => null,
      createGame: async () => ({ id: 'game1234' }),
    });
    assert.equal(result.type, 'redirect');
    if (result.type !== 'redirect') return;
    assert.equal(result.location, '/submissions/game1234');
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

  it('propagates a rejected games insert', async () => {
    const insertError = Object.assign(new Error('new row for relation "games" violates check constraint "games_stage_check"'), { code: '23514' });
    let enqueued = 0;
    await assert.rejects(
      () => planGameUpload({
        user: { id: 'owner-1' },
        profile: { handle: 'ada' },
        form: form(),
        findGame: async () => null,
        createGame: async () => {
          throw insertError;
        },
        enqueueValidation: async () => {
          enqueued += 1;
        },
      }),
      (err) => err === insertError,
    );
    assert.equal(enqueued, 0);
  });

  it('rolls the game back when enqueue fails instead of throwing a 500', async () => {
    const enqueueError = Object.assign(new Error('relation "game_validations" does not exist'), { code: '42P01' });
    const rolledBack: string[] = [];
    const result = await planGameUpload({
      user: { id: 'owner-1' },
      profile: { handle: 'ada' },
      form: form(),
      findGame: async () => null,
      createGame: async () => ({ id: 'game1234' }),
      enqueueValidation: async () => {
        throw enqueueError;
      },
      rollbackUpload: async (gameId) => {
        rolledBack.push(gameId);
      },
    });
    assert.equal(result.type, 'errors');
    if (result.type !== 'errors') return;
    assert.equal(result.status, 503);
    assert.deepEqual(result.errors, [VALIDATION_ENQUEUE_ERROR]);
    assert.deepEqual(rolledBack, ['game1234']);
  });

  it('still returns 503 when rolling the upload back fails', async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const result = await planGameUpload({
        user: { id: 'owner-1' },
        profile: { handle: 'ada' },
        form: form(),
        findGame: async () => null,
        createGame: async () => ({ id: 'game1234' }),
        enqueueValidation: async () => {
          throw new Error('enqueue down');
        },
        rollbackUpload: async () => {
          throw new Error('storage delete failed');
        },
      });
      assert.equal(result.type, 'errors');
      if (result.type !== 'errors') return;
      assert.equal(result.status, 503);
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /Failed to roll back pending game game1234/);
  });

  it('writes stage pending in the games insert and does not insert a validation placeholder', () => {
    const src = readFileSync(new URL('./games.ts', import.meta.url), 'utf8');
    const db = readFileSync(new URL('./submissions-db.ts', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../../pages/api/games/index.ts', import.meta.url), 'utf8');
    assert.match(src, /const stage = input\.stage \?\? 'pending'/);
    assert.match(src, /thumb, stage\)/);
    assert.doesNotMatch(db, /insert into game_validations/);
    assert.doesNotMatch(route, /enqueueValidation/);
    assert.doesNotMatch(db, /status: 'pass'/);
    assert.match(route, /rollbackUpload/);
  });
});

describe('queued validation rows', () => {
  it('keeps a queued placeholder at null or queued and strips a fake pass', () => {
    assert.equal(coerceQueuedStaticReport(null), null);
    assert.equal(coerceQueuedStaticReport('queued'), 'queued');
    assert.deepEqual(coerceQueuedStaticReport({ status: 'queued' }), { status: 'queued' });
    assert.deepEqual(coerceQueuedStaticReport({}), {});
    assert.deepEqual(
      coerceQueuedStaticReport({ status: 'pass', bytes: 48, checks: [] }),
      { status: 'queued' },
    );
    assert.deepEqual(
      coerceQueuedStaticReport({
        status: 'pass',
        checks: [{ id: 'size', name: 'File size', level: 'pass', message: 'ok' }],
      }),
      { status: 'queued' },
    );
  });

  it('does not show a fake pass on the status page while the row is queued', () => {
    const view = buildSubmissionView(game(), validation({
      status: 'queued',
      staticReport: {
        status: 'pass',
        checks: [{ id: 'size', name: 'File size', level: 'pass', message: 'Under 5 MB.' }],
      },
      runReport: null,
      finishedAt: null,
    }));
    assert.equal(view.phase, 'queued');
    assert.equal(view.headline, 'Queued');
    assert.equal(view.terminal, false);
    assert.equal(view.published, false);
    assert.deepEqual(view.validation?.checks, []);
    assert.doesNotMatch(view.detail, /Published|Every required check passed/);
  });

  it('polls the real verdict when a stale queued row sits beside it', () => {
    const queued = validation({
      id: 'queued-row',
      version: 1,
      status: 'queued',
      staticReport: { status: 'pass', checks: [] },
      createdAt: '2026-10-15T09:06:00.000Z',
    });
    const real = validation({
      id: 'real-row',
      version: 2,
      status: 'passed',
      staticReport: { status: 'fail', checks: [{ id: 'hosts', name: 'Hosts', level: 'fail', message: 'no' }] },
      createdAt: '2026-10-15T09:05:00.000Z',
      finishedAt: '2026-10-15T09:05:30.000Z',
    });
    const picked = preferValidation([queued, real]);
    assert.equal(picked?.id, 'real-row');
    const view = buildSubmissionView(game({ stage: 'proving' }), picked);
    assert.equal(view.phase, 'passed');
    assert.equal(view.published, true);
    assert.equal(view.validation?.version, 2);

    const onlyQueued = preferValidation([queued]);
    assert.equal(onlyQueued?.id, 'queued-row');
    assert.equal(preferValidation([]), null);
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

  it('returns no validation row while the owner is still waiting', async () => {
    const store = memory(game(), null);
    const res = await handleSubmissionStatus({ userId: 'owner-1', gameId: 'game1234', store });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.validation, null);
    assert.equal(body.phase, 'waiting');
    assert.equal(body.terminal, false);
    assert.equal(body.mocked, undefined);
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
