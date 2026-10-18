import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  ASSET_REVIEW_HOLD,
  confirmPublicAssetChange,
  creatorsLiveStep,
  homeCreatorSentence,
  manualReviewEnabled,
  passPublishLine,
  uploadOutcome,
} from './manual-review.ts';
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
  it('publish copy follows the flag', () => {
    assert.match(passPublishLine(true), /reviewer/);
    assert.match(passPublishLine(false), /automatically/);
    assert.doesNotMatch(passPublishLine(false), /reviewer/);
    assert.match(uploadOutcome(true), /waits for review/);
    assert.match(uploadOutcome(false), /on its own/);
    assert.match(homeCreatorSentence(true), /After review/);
    assert.match(homeCreatorSentence(false), /right away/);
    assert.match(creatorsLiveStep(true).title, /review/);
    assert.match(creatorsLiveStep(false).body, /straight away/);
  });
  it('the portal and validate-game do not write or overwrite the database switch', () => {
    const files = [
      'src/middleware.ts',
      'src/lib/server/config.ts',
      'src/lib/server/asset-upload.ts',
      'src/lib/server/manual-review.ts',
      'src/lib/manual-review.ts',
      'supabase/functions/validate-game/validate.ts',
      'supabase/functions/validate-game/rest-store.ts',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /MG_MANUAL_REVIEW/, file);
      assert.doesNotMatch(source, /insert into private\.settings/i, file);
      assert.doesNotMatch(source, /manual-review-sync/, file);
    }
    assert.doesNotMatch(readFileSync('supabase/functions/validate-game/rest-store.ts', 'utf8'), /p_manual_review/);
  });
  it('asks before an asset upload only when the game would leave public', () => {
    let asked = '';
    assert.equal(confirmPublicAssetChange(false, () => { throw new Error('should not ask'); }), true);
    assert.equal(confirmPublicAssetChange(true, (message) => { asked = message; return false; }), false);
    assert.equal(asked, ASSET_REVIEW_HOLD);
    assert.equal(confirmPublicAssetChange(true, () => true), true);
  });
});
