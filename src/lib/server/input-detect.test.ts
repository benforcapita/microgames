// IS-2: input-support detection in the static check (report-only).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { analyzeGame, classifyInputSupport, INPUT_SCAN_CAP } from './static-check.ts';

const page = (js: string, body = '<canvas></canvas>', head = '') => `<!doctype html><html><head>${head}</head><body>${body}<script>${js}</script></body></html>`;
const cls = (html: string) => analyzeGame(html).inputSupport!;

describe('input support: classes', () => {
  it('touch events -> mobile', () => assert.equal(cls(page("c.addEventListener('touchstart', f)")).class, 'mobile'));
  it('pointer events -> mobile', () => assert.equal(cls(page("c.addEventListener('pointerdown', f)")).class, 'mobile'));
  it('on-screen controls -> mobile', () => {
    const r = cls(page('', '<canvas></canvas><div id="dpad"></div><button class="btn touch-controls">A</button>'));
    assert.equal(r.class, 'mobile');
    assert.ok(r.signals.controls);
  });
  it("'ontouchstart' in window / maxTouchPoints count as touch", () => {
    assert.ok(cls(page("if ('ontouchstart' in window) x()")).signals.touch);
    assert.ok(cls(page('if (navigator.maxTouchPoints > 0) x()')).signals.touch);
  });
  it('keys only -> desktop', () => assert.equal(cls(page("addEventListener('keydown', f); addEventListener('keyup', g)")).class, 'desktop'));
  it('click alone is neutral (fires on tap too) -> unknown', () => assert.equal(cls(page("b.onclick = f; b.addEventListener('click', g)")).class, 'unknown'));
  it('mouse only -> desktop', () => assert.equal(cls(page("c.addEventListener('mousedown', f)")).class, 'desktop'));
  it('inline handler attributes count (onkeydown / ontouchstart)', () => {
    assert.equal(cls(page('', '<body onkeydown="k(event)"><canvas ontouchstart="t()"></canvas>')).class, 'both');
  });
  it('mobile + desktop signals -> both', () => assert.equal(cls(page("addEventListener('keydown', f); c.onpointerdown = g")).class, 'both'));
  it('no input signals -> unknown', () => assert.equal(cls(page('requestAnimationFrame(function f(){ requestAnimationFrame(f) })')).class, 'unknown'));
});

describe('input support: declared flag wins when consistent', () => {
  it('meta declaration matching the code', () => {
    const r = cls(page("addEventListener('keydown', f); c.addEventListener('touchstart', g)", '<canvas></canvas>', '<meta name="meshgrounds:input-support" content="mobile">'));
    assert.deepEqual([r.class, r.source, r.detected], ['mobile', 'declared', 'both']);
  });
  it('Meshground.declare({ inputSupport }) with no detectable input is trusted', () => {
    const r = cls(page("Meshground?.declare?.({ inputSupport: 'both' })"));
    assert.deepEqual([r.class, r.source], ['both', 'declared']);
  });
  it('pre-rebrand games: the old meshgrounds meta tag is still read; the new name works too', () => {
    for (const name of ['meshground:input-support', 'meshgrounds:input-support']) {
      const r = cls(page('', '<canvas></canvas>', `<meta name="${name}" content="mobile">`));
      assert.deepEqual([r.class, r.source], ['mobile', 'declared'], name);
    }
  });
  it('contract hooks are recognised on both window.Meshground and the legacy window.Meshgrounds', () => {
    for (const api of ['Meshground', 'Meshgrounds']) {
      const js = `window.${api}?.ready?.(); ${api}.onPause(() => {}); ${api}.onResume(() => {});`;
      const c = analyzeGame(page(js, '<canvas></canvas>')).checks.find((x) => x.id === 'contract-hooks')!;
      assert.equal(c.level, 'pass', api);
    }
  });
  it('declaration contradicted by the code loses (declared mobile, keys only)', () => {
    const r = cls(page("addEventListener('keydown', f)", '<canvas></canvas>', '<meta name="meshgrounds:input-support" content="mobile">'));
    assert.deepEqual([r.class, r.source, r.declared], ['desktop', 'detected', 'mobile']);
  });
  it('declared both needs both kinds of signal', () => {
    assert.equal(cls(page("Meshground.declare({ inputSupport: 'both' }); addEventListener('keydown', f)")).class, 'desktop');
  });
  it('declare() in source beats the meta tag (same precedence as boot.js / #34)', () => {
    const r = cls(page("Meshground.declare({ inputSupport: 'desktop' }); addEventListener('keydown', f); c.ontouchstart = g", '<canvas></canvas>', '<meta name="meshgrounds:input-support" content="mobile">'));
    assert.deepEqual([r.declared, r.class, r.source], ['desktop', 'desktop', 'declared']);
  });
  it('with several declare() calls the LAST one wins (same as boot.js at runtime)', () => {
    const r = cls(page("Meshground.declare({ inputSupport: 'mobile' }); Meshground.declare({ inputSupport: 'desktop' }); addEventListener('keydown', f); c.ontouchstart = g"));
    assert.deepEqual([r.declared, r.class, r.source], ['desktop', 'desktop', 'declared']);
    const r2 = cls(page("Meshground.declare({ inputSupport: 'desktop' }); Meshground.declare({ inputSupport: 'both' }); addEventListener('keydown', f); c.ontouchstart = g"));
    assert.equal(r2.declared, 'both');
  });
  it('a declare() inside a comment is ignored (line and block comments)', () => {
    const js = "/* Meshground.declare({ inputSupport: 'mobile' }) */ Meshground.declare({ inputSupport: 'desktop' });\n// Meshground.declare({ inputSupport: 'both' })\naddEventListener('keydown', f); c.ontouchstart = g";
    const r = cls(page(js));
    assert.deepEqual([r.declared, r.class], ['desktop', 'desktop']);
    assert.equal(cls(page("// Meshground.declare({ inputSupport: 'mobile' })\naddEventListener('keydown', f)")).declared, null);
  });
  it('a // inside a string does not hide a later declare() on the same line', () => {
    const r = cls(page("const u = 'https://x.example'; Meshground.declare({ inputSupport: 'desktop' }); addEventListener('keydown', f)"));
    assert.equal(r.declared, 'desktop');
  });
  it('the meta tag applies when there is no declare() call', () => {
    const r = cls(page("addEventListener('keydown', f); c.ontouchstart = g", '<canvas></canvas>', '<meta name="meshgrounds:input-support" content="mobile">'));
    assert.deepEqual([r.declared, r.class], ['mobile', 'mobile']);
  });
  it('invalid declarations are ignored', () => assert.equal(cls(page("Meshground.declare({ inputSupport: 'tv' })")).class, 'unknown'));
});

describe('input support: report-only', () => {
  it('always a pass-level check; never changes status', () => {
    for (const js of ['', "addEventListener('keydown', f)", "c.ontouchstart = f"]) {
      const r = analyzeGame(page(js));
      const c = r.checks.find((x) => x.id === 'input-support')!;
      assert.equal(c.level, 'pass');
      assert.notEqual(r.status, 'fail');
    }
  });
  it('a declaration mismatch is noted in the message', () => {
    const c = analyzeGame(page("addEventListener('keydown', f)", '<canvas></canvas>', '<meta name="meshgrounds:input-support" content="mobile">')).checks.find((x) => x.id === 'input-support')!;
    assert.match(c.message, /Declared 'mobile' does not match/);
  });
  it('scans at most INPUT_SCAN_CAP chars of JS and stays fast on 5 MB', () => {
    const big = 'x'.repeat(INPUT_SCAN_CAP) + " addEventListener('keydown', f)";
    assert.equal(classifyInputSupport(big, []).class, 'unknown');
    const t = performance.now();
    classifyInputSupport('a.b '.repeat(1_250_000), []);
    assert.ok(performance.now() - t < 1000, 'classifier under 1 s on 5 MB (loose bound; it is a few linear regex scans)');
  });
});

describe('input support: seed games', () => {
  const seed = (f: string) => analyzeGame(fs.readFileSync(new URL(`../../../seed/games/${f}`, import.meta.url))).inputSupport!.class;
  it('neon-lanes: keys + pointer -> both', () => assert.equal(seed('neon-lanes.html'), 'both'));
  it('stack-tower: keys + pointer -> both', () => assert.equal(seed('stack-tower.html'), 'both'));
  it('prism-pop: pointer only -> mobile', () => assert.equal(seed('prism-pop.html'), 'mobile'));
});

describe('input support: stored by validate-game', () => {
  it('migration 20261015150000 sets games.input_support from report.inputSupport.class', () => {
    const sql = fs.readFileSync(new URL('../../../supabase/migrations/20261015150000_record_input_support.sql', import.meta.url), 'utf8');
    assert.match(sql, /create or replace function public\.record_game_validation/);
    assert.match(sql, /set input_support = p_report->'inputSupport'->>'class'/);
    assert.match(sql, /in \('mobile', 'desktop', 'both', 'unknown'\)/);
  });
});
