import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GUARD_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/ci/assert-no-db-skips.mjs')).href;

const ALLOWLIST = [
  {
    name: 'byte-budget input is fully analysed with median < 0.75 x AST_BUDGET.ms (450 ms)',
    max: 1,
    why: 'CI-T2 strict timing on shared runners',
  },
  {
    name: 'a 3x linear slowdown is caught (relative, machine-speed independent)',
    max: 1,
    why: 'CI-T2 strict timing on shared runners',
  },
  {
    name: 'AS-5 game loads its own assets under the enforced CSP (Chromium)',
    max: 1,
    why: 'non-DB browser suite, no Chromium on the runner; Engineering Lead approved keeping it until #98 lands',
  },
];

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let fixtureIndex = 0;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-no-db-skips-test-'));
});

after(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, ['scripts/ci/assert-no-db-skips.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runFixture(tapContent: string): CliResult {
  const fixturePath = path.join(tempDir, `fixture-${++fixtureIndex}.tap`);
  fs.writeFileSync(fixturePath, tapContent, 'utf8');
  return runCli([fixturePath]);
}

describe('assert-no-db-skips guard', () => {
  it('clean run: summary "# tests 5", the 3 allowlisted skips by exact name, rest ok -> exit 0', () => {
    const tap = [
      'TAP version 13',
      `ok 1 - ${ALLOWLIST[0].name} # SKIP CI=true: strict timing`,
      `ok 2 - ${ALLOWLIST[1].name} # SKIP CI=true: strict timing`,
      `ok 3 - ${ALLOWLIST[2].name} # SKIP no Playwright Chromium available`,
      'ok 4 - some regular test passing',
      'ok 5 - another regular test passing',
      '# tests 5',
      '# pass 2',
      '# fail 0',
      '# skipped 3',
    ].join('\n');

    const res = runFixture(tap);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^OK: 5 tests; allowed skips: /);
    assert.equal(res.stderr, '');
  });

  it('unallowed skip: a DB test "rateGame keeps an eligible game proving # SKIP local supabase is not running" -> exit 1, stderr names it', () => {
    const tap = [
      'TAP version 13',
      'ok 1 - some test',
      'rateGame keeps an eligible game proving # SKIP local supabase is not running',
      '# tests 2',
    ].join('\n');

    const res = runFixture(tap);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /rateGame keeps an eligible game proving/);
    assert.match(res.stderr, /local supabase is not running/);
  });

  it('a DB test that copies an allowlisted REASON but has a different name -> exit 1 (proves name matching)', () => {
    const tap = [
      'TAP version 13',
      'ok 1 - some passing test',
      'ok 2 - rateGame keeps an eligible game proving # SKIP no Playwright Chromium available',
      '# tests 2',
    ].join('\n');

    const res = runFixture(tap);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /rateGame keeps an eligible game proving: no Playwright Chromium available/);
  });

  it('more allowed skips than permitted: the strict-timing test name appearing twice -> exit 1', () => {
    const timingTestName = 'byte-budget input is fully analysed with median < 0.75 x AST_BUDGET.ms (450 ms)';
    const tap = [
      'TAP version 13',
      `ok 1 - ${timingTestName} # SKIP CI=true: strict absolute timing`,
      `ok 2 - ${timingTestName} # SKIP CI=true: strict absolute timing`,
      '# tests 2',
    ].join('\n');

    const res = runFixture(tap);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /byte-budget input is fully analysed with median < 0\.75 x AST_BUDGET\.ms \(450 ms\)/);
  });

  describe('total test-count check', () => {
    it('no "# tests" line -> exit 1', () => {
      const tap = [
        'TAP version 13',
        'ok 1 - some test',
        'ok 2 - another test',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /No "# tests N" summary line with N > 0 found in TAP output/);
    });

    it('"# tests 0" -> exit 1', () => {
      const tap = [
        'TAP version 13',
        '# tests 0',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /No "# tests N" summary line with N > 0 found in TAP output/);
    });

    it('two summaries "# tests 3" and "# tests 2" with no skips -> exit 0 and stdout reports 5 tests', () => {
      const tap = [
        'TAP version 13',
        'ok 1 - run 1 test 1',
        'ok 2 - run 1 test 2',
        'ok 3 - run 1 test 3',
        '# tests 3',
        '# pass 3',
        'ok 1 - run 2 test 1',
        'ok 2 - run 2 test 2',
        '# tests 2',
        '# pass 2',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 0);
      assert.match(res.stdout, /5 tests/);
    });
  });

  function runCheckTapChild(content: string): { status: number | null; parsed: { ok: boolean } } {
    const code = `import { checkTap } from ${JSON.stringify(GUARD_URL)};
const content = process.env.TAP_CONTENT ?? '';
const { ok } = checkTap(content, []);
console.log(JSON.stringify({ ok }));`;

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TAP_CONTENT: content },
      encoding: 'utf8',
    });

    const raw = child.stdout.trim();
    if (!raw) {
      assert.fail(`Expected JSON on stdout but got empty output (status: ${child.status}, stderr: ${child.stderr})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      assert.fail(`Child stdout was not valid JSON: ${raw}`);
    }

    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { ok?: unknown }).ok !== 'boolean') {
      assert.fail(`Child JSON is missing boolean ok property: ${raw}`);
    }

    return {
      status: child.status,
      parsed: parsed as { ok: boolean },
    };
  }

  describe('empty allowlist: call checkTap(content, []) directly', () => {
    it('a TAP with any skip -> ok false', () => {
      const tap = [
        'TAP version 13',
        'ok 1 - any test # SKIP some reason',
        '# tests 1',
      ].join('\n');

      const res = runCheckTapChild(tap);
      assert.equal(res.status, 0);
      assert.equal(res.parsed.ok, false);
    });

    it('a TAP with no skips and tests > 0 -> ok true', () => {
      const tap = [
        'TAP version 13',
        'ok 1 - any test',
        '# tests 1',
      ].join('\n');

      const res = runCheckTapChild(tap);
      assert.equal(res.status, 0);
      assert.equal(res.parsed.ok, true);
    });
  });

  describe('file handling', () => {
    it('empty file -> exit 1', () => {
      const res = runFixture('');
      assert.equal(res.status, 1);
      assert.match(res.stderr, /TAP file is empty/);
    });

    it('missing file path -> exit 1', () => {
      const res = runCli([path.join(tempDir, 'non-existent-file.tap')]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Cannot read TAP file/);
    });

    it('no argument -> exit 1', () => {
      const res = runCli([]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /TAP file path is required/);
    });
  });
});
