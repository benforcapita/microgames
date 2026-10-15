import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { gameCsp, CSP_SOURCES } from '../../../cdn/csp.mjs';
import { AST_BUDGET, analyzeGame, CONNECT_HOSTS, SCRIPT_HOSTS, STATIC_LIMITS, STYLE_HOSTS, type CheckLevel, type StaticReport } from './static-check.ts';

const FIXTURES = new URL('./fixtures/static-check/', import.meta.url);
const SEED = new URL('../../../seed/games/', import.meta.url);
const load = (name: string) => fs.readFileSync(new URL(name, FIXTURES));
const level = (r: StaticReport, id: string) => r.checks.find((c) => c.id === id)?.level;
const findings = (r: StaticReport, id: string) => r.checks.find((c) => c.id === id)?.findings ?? [];
const nonPass = (r: StaticReport) => Object.fromEntries(r.checks.filter((c) => c.level !== 'pass').map((c) => [c.id, c.level]));
const HOOKS = { 'contract-hooks': 'warn' } as const;

/** Every fixture with the exact non-pass checks it must produce. */
const CASES: Record<string, { status: CheckLevel; expect: Record<string, CheckLevel> }> = {
  'good-minimal-canvas.html': { status: 'pass', expect: {} },
  'good-allowlisted-cdn.html': { status: 'pass', expect: {} },
  'good-esm-importmap.html': { status: 'pass', expect: {} },
  'good-comments-ignored.html': { status: 'pass', expect: {} },
  'bad-remote-script.html': { status: 'fail', expect: { 'script-hosts': 'fail', ...HOOKS } },
  'bad-local-files.html': { status: 'fail', expect: { 'script-hosts': 'fail', 'style-hosts': 'fail', ...HOOKS } },
  'bad-insecure-http-cdn.html': { status: 'fail', expect: { 'script-hosts': 'fail', ...HOOKS } },
  'bad-style-host.html': { status: 'fail', expect: { 'style-hosts': 'fail', ...HOOKS } },
  'bad-import-host.html': { status: 'fail', expect: { 'script-hosts': 'fail', ...HOOKS } },
  'bad-not-a-game.html': { status: 'fail', expect: { 'game-markup': 'fail', ...HOOKS } },
  'bad-js-syntax.html': { status: 'fail', expect: { 'js-syntax': 'fail', ...HOOKS } },
  'warn-frames-forms.html': { status: 'warn', expect: { iframes: 'warn', forms: 'warn', ...HOOKS } },
  'warn-escape-popups-dialogs.html': { status: 'warn', expect: { popups: 'warn', 'top-navigation': 'warn', dialogs: 'warn', ...HOOKS } },
  'warn-network.html': { status: 'warn', expect: { network: 'warn', ...HOOKS } },
  'warn-comment-in-js-string.html': { status: 'warn', expect: { network: 'warn' } },
  'warn-eval.html': { status: 'warn', expect: { eval: 'warn' } },
  'warn-missing-hooks.html': { status: 'warn', expect: { ...HOOKS } },
};

describe('static-check fixtures', () => {
  it('covers at least 10 fixtures, all of them on disk', () => {
    const onDisk = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html')).sort();
    assert.ok(onDisk.length >= 10);
    assert.deepEqual(onDisk, Object.keys(CASES).sort());
  });
  for (const [name, { status, expect }] of Object.entries(CASES)) {
    it(`${name} -> ${status}`, () => {
      const r = analyzeGame(load(name));
      assert.deepEqual(nonPass(r), expect);
      assert.equal(r.status, status);
    });
  }
});

describe('allowlist comes from the CDN CSP (cdn/csp.mjs)', () => {
  it('derives hosts from CSP_SOURCES', () => {
    assert.deepEqual([...SCRIPT_HOSTS], CSP_SOURCES.script.map((u: string) => new URL(u).hostname));
    assert.deepEqual([...CONNECT_HOSTS], CSP_SOURCES.connect.map((u: string) => new URL(u).hostname));
    assert.ok(STYLE_HOSTS.includes('fonts.googleapis.com') && STYLE_HOSTS.includes('fonts.gstatic.com'));
  });
  it('keeps the production CSP header byte-identical to before the refactor', () => {
    const LIB = 'https://cdn.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com https://ga.jspm.io';
    const before = ['sandbox allow-scripts allow-pointer-lock', "default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' blob: ${LIB}`,
      `style-src 'unsafe-inline' ${LIB} https://fonts.googleapis.com`, `font-src data: ${LIB} https://fonts.gstatic.com`, `img-src data: blob: ${LIB}`,
      'media-src data: blob:', `connect-src data: blob: ${LIB}`, 'worker-src blob:', "form-action 'none'", "base-uri 'none'", 'frame-ancestors X'].join('; ');
    assert.equal(gameCsp('X'), before);
  });
});

describe('static-check details', () => {
  it('never fails the three seed games', () => {
    for (const f of fs.readdirSync(SEED)) assert.notEqual(analyzeGame(fs.readFileSync(new URL(f, SEED))).status, 'fail', f);
  });
  it('reports the offending URLs', () => {
    assert.deepEqual(findings(analyzeGame(load('bad-remote-script.html')), 'script-hosts'), ['https://evil.example.com/miner.js']);
    assert.deepEqual(findings(analyzeGame(load('bad-local-files.html')), 'script-hosts').sort(), ['./levels.js', 'game.js']);
    assert.deepEqual(findings(analyzeGame(load('bad-import-host.html')), 'script-hosts'), [
      'https://my-backend.example.net/engine.mjs',
      'https://raw.githubusercontent.com/someone/repo/main/x.js',
    ]);
    assert.deepEqual(findings(analyzeGame(load('bad-style-host.html')), 'style-hosts'), [
      'https://use.typekit.net/abc1234.css',
      'https://example.org/theme.css',
      'https://images.example.org/bg.png',
    ]);
    assert.equal(findings(analyzeGame(load('warn-network.html')), 'network').length, 5);
    assert.deepEqual(findings(analyzeGame(load('warn-comment-in-js-string.html')), 'network'), ['https://evil.example.com/exfil?d=']);
  });
  it('still hides real HTML comments (markup level only)', () => {
    assert.equal(level(analyzeGame(load('good-comments-ignored.html')), 'script-hosts'), 'pass');
  });
  it('fails files over 5 MB without analysing them and warns over 1 MB', () => {
    const pad = (n: number) => `<!doctype html><canvas></canvas><script>/*${'x'.repeat(n)}*/</script>`;
    const huge = analyzeGame(pad(STATIC_LIMITS.maxBytes + 1));
    assert.equal(huge.status, 'fail');
    assert.deepEqual(huge.checks.map((c) => c.id), ['size']);
    assert.equal(level(analyzeGame(pad(STATIC_LIMITS.warnBytes + 1)), 'size'), 'warn');
  });
  it('fails non-UTF-8 bytes and stops early', () => {
    const r = analyzeGame(new Uint8Array([0x3c, 0x73, 0xff, 0xfe, 0x3e]));
    assert.equal(level(r, 'utf8'), 'fail');
    assert.equal(r.checks.length, 2);
  });
  it('rejects allowlisted look-alike hosts', () => {
    const r = analyzeGame('<canvas></canvas><script src="https://cdn.jsdelivr.net.evil.com/x.js"></script><script src="https://unpkg.com@evil.com/x.js"></script>');
    assert.equal(level(r, 'script-hosts'), 'fail');
    assert.equal(findings(r, 'script-hosts').length, 2);
  });
  it('ignores non-JS script blocks (shaders, JSON data)', () => {
    const r = analyzeGame('<canvas></canvas><script type="x-shader/x-vertex">void main() { gl_Position = vec4(0.); }</script><script type="application/json">{"a":1}</script>');
    assert.equal(level(r, 'js-syntax'), 'pass');
  });
});

describe('static-check scales linearly on large valid JS (acorn-bound)', () => {
  // Valid, dense JS must be fully parsed by acorn. That is O(n) but not free (~0.1-0.5 s per MB depending on
  // node density), so for these cases assert linear growth (4x input -> < 6x time) and a 1 MB budget.
  const time = (input: string) => { const t0 = performance.now(); analyzeGame(input); return performance.now() - t0; };
  const CASES: Record<string, (bytes: number) => string> = {
    'many fetch() calls': (b) => '<canvas></canvas><script>' + "fetch('https://x.example/a');".repeat(Math.floor(b / 29)) + '</script>',
    'long member chain x.a.a.a…': (b) => '<script>x' + '.a'.repeat(Math.floor(b / 2)) + ';</script>',
    'many Meshgrounds.* members': (b) => '<script>' + 'Meshgrounds.ready;'.repeat(Math.floor(b / 18)) + '</script>',
  };
  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: 4 MB < 6x the 1 MB time, 1 MB < 500 ms`, () => {
      time(make(256 * 1024)); // warm up the JIT
      const one = time(make(1024 * 1024));
      const four = time(make(4 * 1024 * 1024));
      assert.ok(one < 500, `1 MB: ${one.toFixed(0)} ms`);
      assert.ok(four < one * 6, `1 MB ${one.toFixed(0)} ms vs 4 MB ${four.toFixed(0)} ms`);
    });
  }
});

describe('static-check is linear on adversarial input (5 MB, < 500 ms each)', () => {
  const FIVE_MB = STATIC_LIMITS.maxBytes;
  const fill = (prefix: string, unit: string, suffix = '') => {
    const body = unit.repeat(Math.floor((FIVE_MB - prefix.length - suffix.length) / unit.length));
    return prefix + body + suffix;
  };
  const CASES: Record<string, string> = {
    'repeated `import a,` in a module': fill('<script type="module">', 'import a,'),
    'repeated `import a,` unterminated script': fill('<script>', 'import a,'),
    'unclosed `<link rel=stylesheet `': fill('', '<link rel=stylesheet '),
    'unclosed `<link rel=stylesheet ` after a valid tag': fill('<canvas>', '<link rel=stylesheet href=x '),
    'many `<!--` without close': fill('<canvas>', '<!--'),
    'many `<script` openers': fill('', '<script'),
    'many attributes on one tag': fill('<div ', 'a=b '),
    'unterminated quoted attribute': fill('<div a="', 'x'),
    'CSS `url(` without close': fill('<style>', 'url('),
    'CSS `@import` repeated': fill('<style>', '@import '),
    'many inline handlers': fill('', '<b onclick="a(">'),
    'deeply nested parens': fill('<script>', '('),
    'deeply nested arrays': fill('<script>x=', '[', '</script>'),
    'many `<` characters': fill('', '<'),
  };
  for (const [name, input] of Object.entries(CASES)) {
    it(name, () => {
      assert.ok(new TextEncoder().encode(input).length <= FIVE_MB);
      const t0 = performance.now();
      analyzeGame(input);
      const ms = performance.now() - t0;
      assert.ok(ms < 500, `${name}: ${ms.toFixed(0)} ms`);
    });
  }
});

describe('Edge CPU budget: AST phase is capped, hard fails stay unconditional', () => {
  const MB = 1024 * 1024;
  const fill = (unit: string, size: number) => unit.repeat(Math.floor(size / unit.length));
  const timed = (html: string) => {
    const t0 = performance.now();
    const r = analyzeGame(html);
    return { r, ms: performance.now() - t0 };
  };
  const warns = (r: StaticReport) => r.checks.filter((c) => c.level === 'warn').map((c) => c.id);

  it('member chain at 4.9 MB finishes under 1 s total', () => {
    const { r, ms } = timed(`<canvas></canvas><script>x${fill('.a', 4.9 * MB)}</script>`);
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    assert.notEqual(r.status, 'fail');
  });
  it('270k inline <script> blocks at 4.9 MB finish under 1 s total', () => {
    const html = '<script>a</script>'.repeat(272_000); // 18 bytes each, 4.9 MB
    assert.ok(html.length >= 4.89e6 && html.length <= STATIC_LIMITS.maxBytes, String(html.length));
    const { r, ms } = timed(html);
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    assert.notEqual(r.status, 'fail');
  });
  it('JS just under the byte budget is fully analysed in under 1 s', () => {
    const { r, ms } = timed(`<canvas></canvas><script>${fill('var a=b+c*d(e,f);', AST_BUDGET.maxJsBytes - 64)}</script>`);
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    assert.equal(level(r, 'deep-analysis'), undefined);
  });
  it('over budget: exactly one warning "deep analysis skipped (too large)", never a fail', () => {
    const { r } = timed(`<canvas></canvas><script>${fill('var a=b+c*d(e,f);', 3 * MB)}</script>`);
    const deep = r.checks.find((c) => c.id === 'deep-analysis');
    assert.equal(deep?.level, 'warn');
    assert.equal(deep?.message, 'deep analysis skipped (too large)');
    assert.deepEqual(warns(r).filter((id) => id !== 'size'), ['deep-analysis']);
    assert.equal(r.status, 'warn');
  });
  it('over budget: a non-allowlisted import is still a hard fail (lexical fallback)', () => {
    const big = fill('var a=b+c*d(e,f);', 3 * MB);
    const r = analyzeGame(`<canvas></canvas><script type="module">import x from "https://evil.example/x.js";${big}</script>`);
    assert.equal(level(r, 'script-hosts'), 'fail');
    assert.ok(findings(r, 'script-hosts').includes('https://evil.example/x.js'));
    const r2 = analyzeGame(`<canvas></canvas><script src="https://evil.example/a.js"></script><script>${big}</script>`);
    assert.equal(level(r2, 'script-hosts'), 'fail');
  });
  it('size, UTF-8 and markup fails do not depend on the AST phase', () => {
    assert.equal(level(analyzeGame('x'.repeat(STATIC_LIMITS.maxBytes + 1)), 'size'), 'fail');
    assert.equal(level(analyzeGame(new Uint8Array([0x3c, 0xff, 0xfe])), 'utf8'), 'fail');
    assert.equal(level(analyzeGame(`<p>${fill('hello ', 3 * MB)}</p>`), 'game-markup'), 'fail');
  });
});

describe('inline scripts are parsed in one pass, with exact per-script errors', () => {
  it('two scripts with unbalanced braces that cancel out are still a syntax fail', () => {
    const r = analyzeGame('<canvas></canvas><script>function f(){</script><script>}</script>');
    assert.equal(level(r, 'js-syntax'), 'fail');
  });
  it('reports the right script among many', () => {
    const blocks = Array.from({ length: 500 }, (_, i) => (i === 321 ? '<script>let = ;</script>' : `<script>var v${i}=${i};</script>`)).join('');
    const r = analyzeGame(`<canvas></canvas>${blocks}`);
    assert.equal(level(r, 'js-syntax'), 'fail');
    assert.ok(findings(r, 'js-syntax').some((f) => f.startsWith('<script> #322:')), findings(r, 'js-syntax').join(' | '));
  });
  it('separate scripts may reuse let/const names (each is its own block)', () => {
    const r = analyzeGame('<canvas></canvas><script>let a=1;</script><script>let a=2;</script>');
    assert.equal(level(r, 'js-syntax'), 'pass');
  });
  it('a classic script using import syntax still falls back to a module parse', () => {
    const r = analyzeGame('<canvas></canvas><script>var a=1;</script><script>import "https://cdn.jsdelivr.net/npm/three/+esm"; a++;</script><script>var b;</script>');
    assert.equal(level(r, 'js-syntax'), 'pass');
  });
  it('warnings from every script are still collected', () => {
    const r = analyzeGame('<canvas></canvas><script>eval("1")</script><script>alert(1)</script>');
    assert.equal(level(r, 'eval'), 'warn');
    assert.equal(level(r, 'dialogs'), 'warn');
  });
});

describe('top-navigation: parent.postMessage is not navigation', () => {
  for (const name of ['stack-tower.html', 'neon-lanes.html', 'prism-pop.html']) {
    it(`seed ${name} has no top-navigation warning`, () => {
      const r = analyzeGame(fs.readFileSync(new URL(name, SEED)));
      assert.equal(level(r, 'top-navigation'), 'pass', JSON.stringify(findings(r, 'top-navigation')));
    });
  }
  it('postMessage passes; real escapes still warn', () => {
    assert.equal(level(analyzeGame('<canvas></canvas><script>parent.postMessage({t:1},"*");window.parent.postMessage(1,"*")</script>'), 'top-navigation'), 'pass');
    for (const js of ['top.location="x"', 'parent.location.href="x"', 'window.top.document', 'frameElement.remove()'])
      assert.equal(level(analyzeGame(`<canvas></canvas><script>${js}</script>`), 'top-navigation'), 'warn', js);
  });
});
