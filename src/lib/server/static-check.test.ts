import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { gameCsp, CSP_SOURCES } from '../../../cdn/csp.mjs';
import { analyzeGame, CONNECT_HOSTS, SCRIPT_HOSTS, STATIC_LIMITS, STYLE_HOSTS, type CheckLevel, type StaticReport } from './static-check.ts';

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
