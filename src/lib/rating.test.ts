import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ratingLabel } from './rating.ts';

describe('ratingLabel', () => {
  it("returns 'No ratings yet' when ratingCount is 0", () => {
    assert.equal(ratingLabel(null, 0), 'No ratings yet');
    assert.equal(ratingLabel(undefined, 0), 'No ratings yet');
    assert.equal(ratingLabel(4.5, 0), 'No ratings yet');
    assert.equal(ratingLabel(0, 0), 'No ratings yet');
  });

  it("returns 'No ratings yet' when avg is null or undefined or invalid", () => {
    assert.equal(ratingLabel(null, 5), 'No ratings yet');
    assert.equal(ratingLabel(undefined, 5), 'No ratings yet');
    assert.equal(ratingLabel(Number.NaN, 5), 'No ratings yet');
    assert.equal(ratingLabel(Infinity, 5), 'No ratings yet');
  });

  it("returns 'No ratings yet' for negative or non-positive counts", () => {
    assert.equal(ratingLabel(4.5, -1), 'No ratings yet');
    assert.equal(ratingLabel(4.5, -10), 'No ratings yet');
  });

  it('formats rating with one decimal place and star prefix', () => {
    assert.equal(ratingLabel(4.5, 12), '★ 4.5 · 12 ratings');
    assert.equal(ratingLabel(5, 100), '★ 5.0 · 100 ratings');
    assert.equal(ratingLabel(3.14159, 7), '★ 3.1 · 7 ratings');
    assert.equal(ratingLabel(4.86, 2), '★ 4.9 · 2 ratings');
    assert.equal(ratingLabel(0, 1), '★ 0.0 · 1 rating');
  });
});
