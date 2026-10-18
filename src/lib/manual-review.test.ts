import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { manualReviewEnabled } from './manual-review.ts';
import { stageAfterValidation } from './server/game-rules.ts';

describe('MG_MANUAL_REVIEW', () => {
  it('defaults on', () => {
    assert.equal(manualReviewEnabled(undefined), true);
    assert.equal(manualReviewEnabled(''), true);
    assert.equal(manualReviewEnabled('  '), true);
    assert.equal(manualReviewEnabled('1'), true);
    assert.equal(manualReviewEnabled('true'), true);
    assert.equal(manualReviewEnabled('on'), true);
  });
  it('turns off only for 0, false, off, or no', () => {
    for (const raw of ['0', 'false', 'off', 'no', ' FALSE ', 'Off']) assert.equal(manualReviewEnabled(raw), false, raw);
  });
  it('a pass stays pending while the flag is on, and publishes when it is off', () => {
    assert.equal(stageAfterValidation('pending', 'passed', manualReviewEnabled(undefined)), 'pending');
    assert.equal(stageAfterValidation('pending', 'passed', manualReviewEnabled('0')), 'proving');
  });
});
