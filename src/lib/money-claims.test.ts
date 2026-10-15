import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { findMoneyClaims, findPaymentPromises } from './money-claims.ts';

describe('findMoneyClaims', () => {
  it('flags % and $ amounts near revenue/payout/royalty (the old copy)', () => {
    assert.equal(findMoneyClaims('pay you 65% of the net revenue, with a $25 minimum payout.').length, 2);
    assert.equal(findMoneyClaims('<b class="big">10%</b><span>royalty from every fork</span>').length, 1);
    assert.equal(findMoneyClaims('<b>$25</b><span class="muted">minimum payout</span>').length, 1);
    assert.equal(findMoneyClaims('creators get 70 percent of ad revenue').length, 1);
  });
  it('ignores the soft copy and unrelated numbers', () => {
    assert.deepEqual(findMoneyClaims('We plan to share revenue with creators; details to come.'), []);
    assert.deepEqual(findMoneyClaims('Crash rate ≤ 5% · first frame under 3s for ≥ 90% of plays'), []);
  });
});

describe('findPaymentPromises', () => {
  it('flags binding payment promises (the old copy)', () => {
    for (const t of ['Ship one file. Get played. Get paid.', 'Clear the bar and you start earning', 'graduate and start earning', 'the creator starts earning.', 'upload your game and earn ad revenue.', 'and then we pay you your share.', 'Rewarded video earns several times more than banners.'])
      assert.equal(findPaymentPromises(t).length, 1, t);
  });
  it('allows future, non-binding wording and fraud rules', () => {
    assert.deepEqual(findPaymentPromises('Revenue sharing for creators is planned; details to come.'), []);
    assert.deepEqual(findPaymentPromises('Invalid traffic is removed and payouts are clawed back.'), []);
  });
});

// The rendered pages need a database, so this scans the page sources (the static copy) plus README/docs.
// scripts/smoke.mjs runs the same check against the rendered / and /creators on local Supabase.
describe('no creator revenue numbers in site copy', () => {
  const files = ['src/pages/index.astro', 'src/pages/creators.astro', 'src/pages/upload.astro', 'src/pages/play/[slug].astro', 'src/layouts/Layout.astro', 'README.md', 'public/EXCHANGE_SDK.md', ...fs.readdirSync('docs', { recursive: true }).map(String).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  for (const f of files) {
    it(f, () => {
      const text = fs.readFileSync(f, 'utf8');
      assert.deepEqual(findMoneyClaims(text), []);
      assert.deepEqual(findPaymentPromises(text), []);
    });
  }
  it('config no longer exports REVENUE', () => {
    assert.doesNotMatch(fs.readFileSync('src/lib/server/config.ts', 'utf8'), /REVENUE|creatorShare|forkRoyalty|minPayout/);
  });
});
