import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GRADUATION_DEFAULTS,
  MAX_FIRST_FRAME_MS,
  MAX_SESSION_MS,
  PUBLIC_STAGES,
  assessHealth,
  clampDurationMs,
  clampFirstFrameMs,
  normalizeTags,
  slugify,
  stagesForList,
  uniqueSlug,
  type HealthStats,
} from './game-rules.ts';

const G = GRADUATION_DEFAULTS;

function judge(patch: Partial<HealthStats> = {}, rules = G) {
  const stats: HealthStats = {
    plays: rules.minPlays,
    ffOk: 1,
    crashRate: 0,
    startRate: 1,
    completionRate: 1,
    medianMs: rules.minMedianSessionSec * 1000,
    avgRating: rules.minAvgRating,
    ratingCount: rules.minRatingsForRatingGate,
    ...patch,
  };
  const result = assessHealth(stats, rules);
  return {
    eligible: result.eligible,
    failed: result.checks.filter((c) => !c.pass).map((c) => c.key),
    checks: result.checks,
  };
}

describe('graduation thresholds', () => {
  it('passes when every metric sits on its threshold', () => {
    const result = judge({
      plays: G.minPlays,
      ffOk: G.minFirstFrameOkRate,
      crashRate: G.maxCrashRate,
      startRate: G.minStartRate,
      completionRate: G.minCompletionRate,
      medianMs: G.minMedianSessionSec * 1000,
      avgRating: G.minAvgRating,
      ratingCount: G.minRatingsForRatingGate,
    });
    assert.equal(result.eligible, true);
    assert.deepEqual(result.failed, []);
  });

  it('rejects a play count just below the minimum and accepts the minimum and one above', () => {
    assert.deepEqual(judge({ plays: G.minPlays - 1 }).failed, ['plays']);
    assert.equal(judge({ plays: G.minPlays }).eligible, true);
    assert.equal(judge({ plays: G.minPlays + 1 }).eligible, true);
  });

  it('rejects a first-frame rate just below the minimum and accepts the minimum and one step above', () => {
    assert.deepEqual(judge({ ffOk: G.minFirstFrameOkRate - 0.01 }).failed, ['first_frame']);
    assert.equal(judge({ ffOk: G.minFirstFrameOkRate }).eligible, true);
    assert.equal(judge({ ffOk: G.minFirstFrameOkRate + 0.01 }).eligible, true);
  });

  it('rejects a crash rate just above the maximum and accepts the maximum and one step below', () => {
    assert.deepEqual(judge({ crashRate: G.maxCrashRate + 0.01 }).failed, ['crash']);
    assert.equal(judge({ crashRate: G.maxCrashRate }).eligible, true);
    assert.equal(judge({ crashRate: G.maxCrashRate - 0.01 }).eligible, true);
  });

  it('rejects a start rate just below the minimum and accepts the minimum and one step above', () => {
    assert.deepEqual(judge({ startRate: G.minStartRate - 0.01 }).failed, ['start']);
    assert.equal(judge({ startRate: G.minStartRate }).eligible, true);
    assert.equal(judge({ startRate: G.minStartRate + 0.01 }).eligible, true);
  });

  it('rejects a completion rate just below the minimum and accepts the minimum and one step above', () => {
    assert.deepEqual(judge({ completionRate: G.minCompletionRate - 0.01 }).failed, ['completion']);
    assert.equal(judge({ completionRate: G.minCompletionRate }).eligible, true);
    assert.equal(judge({ completionRate: G.minCompletionRate + 0.01 }).eligible, true);
  });

  it('rejects a median session just under 60s and accepts 60s and one millisecond over', () => {
    const under = judge({ medianMs: G.minMedianSessionSec * 1000 - 1 });
    const at = judge({ medianMs: G.minMedianSessionSec * 1000 });
    const over = judge({ medianMs: G.minMedianSessionSec * 1000 + 1 });
    assert.deepEqual(under.failed, ['session']);
    assert.equal(under.checks.find((c) => c.key === 'session')?.value, 59.999);
    assert.equal(at.eligible, true);
    assert.equal(at.checks.find((c) => c.key === 'session')?.value, 60);
    assert.equal(over.eligible, true);
  });

  it('skips the rating gate just below the vote minimum, then enforces the star average at and above it', () => {
    const belowGate = judge({ ratingCount: G.minRatingsForRatingGate - 1, avgRating: 1 });
    assert.equal(belowGate.eligible, true);

    const low = judge({ ratingCount: G.minRatingsForRatingGate, avgRating: 2.9 });
    const exact = judge({ ratingCount: G.minRatingsForRatingGate, avgRating: G.minAvgRating });
    const high = judge({ ratingCount: G.minRatingsForRatingGate, avgRating: G.minAvgRating + 0.1 });
    assert.deepEqual(low.failed, ['rating']);
    assert.equal(exact.eligible, true);
    assert.equal(high.eligible, true);

    const aboveGateLow = judge({ ratingCount: G.minRatingsForRatingGate + 1, avgRating: 2.9 });
    const aboveGateOk = judge({ ratingCount: G.minRatingsForRatingGate + 1, avgRating: G.minAvgRating });
    assert.deepEqual(aboveGateLow.failed, ['rating']);
    assert.equal(aboveGateOk.eligible, true);
  });

  it('fails closed when a measured rate is missing', () => {
    assert.deepEqual(judge({ ffOk: null }).failed, ['first_frame']);
    assert.deepEqual(judge({ avgRating: null, ratingCount: G.minRatingsForRatingGate }).failed, ['rating']);
  });

  it('honors a custom play minimum', () => {
    const rules = { ...G, minPlays: 10 };
    assert.deepEqual(judge({ plays: 9 }, rules).failed, ['plays']);
    assert.equal(judge({ plays: 10 }, rules).eligible, true);
    assert.equal(judge({ plays: 11 }, rules).eligible, true);
  });
});

describe('telemetry clamping', () => {
  it('clamps negative samples to zero', () => {
    assert.equal(clampFirstFrameMs(-1), 0);
    assert.equal(clampFirstFrameMs(-0.4), 0);
    assert.equal(clampFirstFrameMs(-5), 0);
    assert.equal(clampDurationMs(-50), 0);
    assert.equal(clampDurationMs(-1e15), 0);
  });

  it('caps huge durations at four hours and first-frame times at sixty seconds', () => {
    assert.equal(MAX_SESSION_MS, 4 * 3600_000);
    assert.equal(MAX_FIRST_FRAME_MS, 60_000);
    assert.equal(clampDurationMs(MAX_SESSION_MS - 1), MAX_SESSION_MS - 1);
    assert.equal(clampDurationMs(MAX_SESSION_MS), MAX_SESSION_MS);
    assert.equal(clampDurationMs(MAX_SESSION_MS + 1), MAX_SESSION_MS);
    assert.equal(clampDurationMs(1e15), MAX_SESSION_MS);
    assert.equal(clampDurationMs(Number.POSITIVE_INFINITY), MAX_SESSION_MS);
    assert.equal(clampFirstFrameMs(Number.POSITIVE_INFINITY), MAX_FIRST_FRAME_MS);
    assert.equal(clampFirstFrameMs(1e12), MAX_FIRST_FRAME_MS);
    assert.equal(clampFirstFrameMs(1.6), 2);
    assert.equal(clampFirstFrameMs(1234.4), 1234);
  });

  it('handles invalid and non-finite samples', () => {
    for (const value of [Number.NaN, Number.NEGATIVE_INFINITY, null, 'abc', 'nope', undefined]) {
      assert.equal(clampFirstFrameMs(value), null, String(value));
    }
    for (const value of [Number.NaN, Number.NEGATIVE_INFINITY, 'nope', undefined]) {
      assert.equal(clampDurationMs(value), 0, String(value));
    }
    assert.equal(clampDurationMs(Number.NaN), 0);
  });
});

describe('tag normalization', () => {
  it('lowercases tags', () => {
    assert.deepEqual(normalizeTags('Action, PUZZLE'), ['action', 'puzzle']);
  });

  it('splits on whitespace and commas', () => {
    assert.deepEqual(normalizeTags('  action   puzzle  '), ['action', 'puzzle']);
    assert.deepEqual(normalizeTags('action,   puzzle'), ['action', 'puzzle']);
  });

  it('drops duplicates after normalization', () => {
    assert.deepEqual(normalizeTags('Action, action, ACTION'), ['action']);
    assert.deepEqual(normalizeTags('Foo-Bar, foo_bar, FOO-BAR'), ['foo-bar']);
  });

  it('drops empty strings', () => {
    assert.deepEqual(normalizeTags(''), []);
    assert.deepEqual(normalizeTags('   '), []);
    assert.deepEqual(normalizeTags(',,,'), []);
    assert.deepEqual(normalizeTags('action,, ,puzzle'), ['action', 'puzzle']);
  });
});

describe('submission stages stay off public lists', () => {
  it('shows proving and live games to everyone', () => {
    assert.deepEqual(stagesForList(), [...PUBLIC_STAGES]);
    assert.deepEqual(stagesForList({ stage: 'live' }), ['live']);
    assert.deepEqual(stagesForList({ stage: 'proving' }), ['proving']);
  });

  it('returns no rows when a public query asks for pending or rejected', () => {
    assert.deepEqual(stagesForList({ stage: 'pending' }), []);
    assert.deepEqual(stagesForList({ stage: 'rejected' }), []);
  });

  it('lets an owner see pending and rejected games', () => {
    assert.deepEqual(stagesForList({ ownerScoped: true }), ['pending', 'proving', 'live', 'rejected']);
    assert.deepEqual(stagesForList({ ownerScoped: true, stage: 'pending' }), ['pending']);
  });
});

describe('slug collisions', () => {
  it('gives two games with the same title different slugs', () => {
    const title = 'Same Title';
    const first = uniqueSlug(title, false, 'Aaaabbbb');
    const second = uniqueSlug(title, true, 'CcDdEeFf');
    const third = uniqueSlug(title, true, 'GgHhIiJj');
    assert.equal(first, 'same-title');
    assert.equal(second, 'same-title-ccdd');
    assert.equal(third, 'same-title-gghh');
    assert.notEqual(first, second);
    assert.notEqual(second, third);
  });

  it('folds case and surrounding whitespace into the same base slug', () => {
    assert.equal(slugify('Same Title'), slugify('  SAME   title '));
    assert.equal(uniqueSlug('  SAME   title ', true, 'Wxyz9999'), 'same-title-wxyz');
  });
});
