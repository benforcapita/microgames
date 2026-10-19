import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REVIEW_NOTE_MAX, parseReviewInput, reviewTransition } from './admin-rules.ts';

describe('reviewTransition', () => {
  it('approve publishes a held or rejected game to proving, never to live', () => {
    assert.equal(reviewTransition('pending', 'approve'), 'proving');
    assert.equal(reviewTransition('rejected', 'approve'), 'proving');
    assert.equal(reviewTransition('proving', 'approve'), null);
    assert.equal(reviewTransition('live', 'approve'), null);
  });
  it('reject takes down anything that is not already rejected', () => {
    assert.equal(reviewTransition('pending', 'reject'), 'rejected');
    assert.equal(reviewTransition('proving', 'reject'), 'rejected');
    assert.equal(reviewTransition('live', 'reject'), 'rejected');
    assert.equal(reviewTransition('rejected', 'reject'), null);
  });
});

describe('parseReviewInput', () => {
  const form = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  it('needs a known decision', () => {
    assert.match(parseReviewInput(form({})).error ?? '', /approve or reject/);
    assert.match(parseReviewInput(form({ decision: 'publish' })).error ?? '', /approve or reject/);
  });
  it('approve may omit the note; whitespace collapses', () => {
    assert.deepEqual(parseReviewInput(form({ decision: 'approve' })).input, { decision: 'approve', note: null });
    assert.deepEqual(parseReviewInput(form({ decision: 'approve', note: '  nice \n work ' })).input, { decision: 'approve', note: 'nice work' });
  });
  it('reject requires a note and caps its length', () => {
    assert.match(parseReviewInput(form({ decision: 'reject', note: '   ' })).error ?? '', /note/);
    assert.deepEqual(parseReviewInput(form({ decision: 'reject', note: 'Crashes on load.' })).input, { decision: 'reject', note: 'Crashes on load.' });
    assert.match(parseReviewInput(form({ decision: 'reject', note: 'x'.repeat(REVIEW_NOTE_MAX + 1) })).error ?? '', /under/);
  });
});
