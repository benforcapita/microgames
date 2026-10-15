import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { analyzeGame, STATIC_LIMITS, type CheckLevel, type StaticReport } from './static-check.ts';

const FIXTURES = new URL('./fixtures/static-check/', import.meta.url);
const SEED = new URL('../../../seed/games/', import.meta.url);
const load = (name: string) => fs.readFileSync(new URL(name, FIXTURES));
const level = (r: StaticReport, id: string) => r.checks.find((c) => c.id === id)?.level;
const findings = (r: StaticReport, id: string) => r.checks.find((c) => c.id === id)?.findings ?? [];
const nonPass = (r: StaticReport) => Object.fromEntries(r.checks.filter((c) => c.level !== 'pass').map((c) => [c.id, c.level]));

/** Every fixture with the exact non-pass checks it must produce. */
const CASES: Record<string, { status: CheckLevel; expect: Record<string, CheckLevel> }> = {
  'good-minimal-canvas.html': { status: 'pass', expect: {} },
  'good-allowlisted-cdn.html': { status: 'pass', expect: {} },
  'good-esm-importmap.html': { status: 'pass', expect: {} },
  'good-comments-ignored.html': { status: 'pass', expect: {} },
  'bad-remote-script.html': { status: 'fail', expect: { 'script-hosts': 'fail' } },
  'bad-local-files.html': { status: 'fail', expect: { 'script-hosts': 'fail', 'style-hosts': 'fail' } },
  'bad-insecure-http-cdn.html': { status: 'fail', expect: { 'script-hosts': 'fail' } },
  'bad-style-host.html': { status: 'fail', expect: { 'style-hosts': 'fail' } },
  'bad-import-host.html': { status: 'fail', expect: { 'script-hosts': 'fail' } },
  'bad-not-a-game.html': { status: 'fail', expect: { 'game-markup': 'fail' } },
  'warn-frames-forms.html': { status: 'warn', expect: { iframes: 'warn', forms: 'warn' } },
  'warn-escape-popups-dialogs.html': { status: 'warn', expect: { popups: 'warn', 'top-navigation': 'warn', dialogs: 'warn' } },
  'warn-network.html': { status: 'warn', expect: { network: 'warn' } },
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
      assert.equal(r.status, status);
      assert.deepEqual(nonPass(r), expect);
    });
  }
});

describe('static-check details', () => {
  it('passes all three seed games', () => {
    for (const f of fs.readdirSync(SEED)) assert.equal(analyzeGame(fs.readFileSync(new URL(f, SEED))).status, 'pass', f);
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
  });
  it('fails files over 5 MB and warns over 1 MB', () => {
    const pad = (n: number) => `<!doctype html><canvas></canvas><script>/*${'x'.repeat(n)}*/</script>`;
    assert.equal(level(analyzeGame(pad(STATIC_LIMITS.maxBytes + 1)), 'size'), 'fail');
    const big = analyzeGame(pad(STATIC_LIMITS.warnBytes + 1));
    assert.equal(level(big, 'size'), 'warn');
    assert.equal(big.status, 'warn');
  });
  it('fails non-UTF-8 bytes and stops early', () => {
    const r = analyzeGame(new Uint8Array([0x3c, 0x73, 0xff, 0xfe, 0x3e]));
    assert.equal(r.status, 'fail');
    assert.equal(level(r, 'utf8'), 'fail');
    assert.equal(r.checks.length, 2);
  });
  it('accepts string input and counts UTF-8 bytes', () => {
    const r = analyzeGame('<canvas></canvas><script>const s = "★";</script>');
    assert.equal(r.status, 'pass');
    assert.equal(r.bytes, new TextEncoder().encode('<canvas></canvas><script>const s = "★";</script>').length);
  });
  it('does not flag allowlisted look-alike hosts as allowed', () => {
    const r = analyzeGame('<canvas></canvas><script src="https://cdn.jsdelivr.net.evil.com/x.js"></script><script src="https://unpkg.com@evil.com/x.js"></script>');
    assert.equal(level(r, 'script-hosts'), 'fail');
    assert.equal(findings(r, 'script-hosts').length, 2);
  });
});
