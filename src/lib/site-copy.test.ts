// NM-1: strict site-copy mode (no money/payment terms anywhere user-visible; no allow-list, no negation).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { findMoneyClaims, findSiteMoneyTerms } from './money-claims.ts';
import { scanDist, scanSources, scanText, stripComments } from '../../scripts/check-site-copy.mjs';

describe('NM-1 strict site-copy terms', () => {
  it('flags the lines the old finder allowed (allow-list removed for site copy)', () => {
    for (const t of ['Live and monetized.', 'Invalid traffic is removed and payouts are clawed back.', 'Revenue sharing for creators is planned; details to come.',
      'This game has graduated and is monetized.', 'Your games · unmonetized · unlisted', 'We will never monetize your data.', 'No money is paid out', 'Monetized'])
      assert.ok(findSiteMoneyTerms(t).length >= 1, t);
  });
  it('flags every money/payment family', () => {
    for (const t of ['Get paid', 'payment details', 'weekly payout', 'ad revenue', 'earn more', 'your earnings', 'monetisation', 'make money', 'cash out',
      'side income', 'royalties', 'profit', '5 dollars', '$5 per play', '€10', '£3', 'pricing', 'clawback', '20 USD'])
      assert.ok(findSiteMoneyTerms(t).length >= 1, t);
  });
  it('does not flag player-facing ad mentions or unrelated words', () => {
    for (const t of ['Auto-pause during ads', 'rewarded ad revive', 'learn', 'earnest', 'display', 'payload', 'cashew', 'x = $$props', 'prove themselves'])
      assert.deepEqual(findSiteMoneyTerms(t), [], t);
  });
  it('the prompt finder is unchanged (still allows non-binding wording)', () => {
    assert.deepEqual(findMoneyClaims('Live and monetized.'), []);
  });
});

describe('NM-1 site-copy scanner', () => {
  it('skips comments but not URLs', () => {
    const src = "// payouts here\nconst a = 'https://x.example'; /* revenue */\n<!-- money -->\nok";
    assert.deepEqual(scanText(stripComments(src), 'f'), []);
    assert.equal(scanText(stripComments("const u = 'https://x.example/pay'"), 'f').length, 1);
  });
  it('reports file:line and the term', () => {
    assert.deepEqual(scanText('a\n<b>Monetized</b>', 'p.astro').map((h) => [h.file, h.line, h.term]), [['p.astro', 2, 'Monetized']]);
  });
  it('every user-rendered source file is clean', () => assert.deepEqual(scanSources(), []));
  it('dist scan: page chunks and client assets are checked, non-page chunks are not', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nm1-dist-'));
    fs.mkdirSync(path.join(d, 'server/chunks'), { recursive: true });
    fs.mkdirSync(path.join(d, 'client/_astro'), { recursive: true });
    fs.writeFileSync(path.join(d, 'server/chunks/page.mjs'), "return renderTemplate`<span>${live ? 'Monetized' : 'Proving'}</span>`;");
    fs.writeFileSync(path.join(d, 'server/chunks/backend.mjs'), "export const payoutCents = 1; // revenue logic stays");
    fs.writeFileSync(path.join(d, 'client/_astro/a.js'), "el.textContent = 'Revenue share soon';");
    const hits = scanDist(d).map((h) => `${path.basename(h.file)}:${h.term}`);
    assert.deepEqual(hits.sort(), ['a.js:Revenue', 'page.mjs:Monetized']);
    fs.rmSync(d, { recursive: true });
  });
  it('is wired into CI (source + built dist) and npm scripts', () => {
    const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    assert.match(ci, /npm run check:copy -- --dist/);
    assert.ok(ci.indexOf('npm run build') < ci.indexOf('check:copy'), 'runs after the build');
    assert.match(JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts['check:copy'], /check-site-copy\.mjs/);
  });
});
