import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BAYES_PRIOR_VOTES, bayesianRating, compareByBayes } from './game-rules.ts';

const g = (title: string, avgRating: number | null, ratingCount: number) => ({ title, avgRating, ratingCount });

describe('bayesianRating', () => {
  it('uses C = 10 and the formula (C*m + sum) / (C + n)', () => {
    assert.equal(BAYES_PRIOR_VOTES, 10);
    assert.equal(bayesianRating(5, 1, 4), (10 * 4 + 5) / 11);
    assert.equal(bayesianRating(4.8, 200, 4), (10 * 4 + 4.8 * 200) / 210);
  });
  it('returns the global mean for unrated games', () => {
    assert.equal(bayesianRating(null, 0, 3.7), 3.7);
    assert.equal(bayesianRating(5, 0, 3.7), 3.7);
  });
  it('converges to the raw average as votes grow', () => {
    assert.ok(Math.abs(bayesianRating(4.2, 100_000, 3) - 4.2) < 0.001);
  });
});

describe('compareByBayes (sort=rated ordering)', () => {
  it('ranks 200 × 4.8★ above a single 5★', () => {
    const sorted = [g('one-vote', 5, 1), g('crowd', 4.8, 200)].sort(compareByBayes(3.5));
    assert.deepEqual(sorted.map((x) => x.title), ['crowd', 'one-vote']);
  });
  it('orders a mixed list and puts unrated games at the global mean', () => {
    const m = 3.5;
    const games = [g('unrated', null, 0), g('meh-many', 2.5, 300), g('great-few', 5, 3), g('good-many', 4.4, 80), g('bad-one', 1, 1)];
    const order = games.sort(compareByBayes(m)).map((x) => x.title);
    assert.deepEqual(order, ['good-many', 'great-few', 'unrated', 'bad-one', 'meh-many']);
  });
  it('breaks ties by vote count', () => {
    const order = [g('few', 3.5, 2), g('many', 3.5, 50)].sort(compareByBayes(3.5)).map((x) => x.title);
    assert.deepEqual(order, ['many', 'few']);
  });
});
