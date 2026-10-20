import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOWLIST } from './assert-no-db-skips.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GUARD_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/ci/assert-no-db-skips.mjs')).href;

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

  it('unallowed skip: a DB test with skip directive stating local supabase is not running -> exit 1, stderr names it', () => {
    const tap = [
      'TAP version 13',
      'ok 1 - some test',
      'ok 2 - rateGame keeps an eligible game proving # SKIP local supabase is not running',
      '# tests 2',
    ].join('\n');

    const res = runFixture(tap);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /rateGame keeps an eligible game proving/);
    assert.match(res.stderr, /local supabase is not running/);
  });

  it('passing test with escaped skip in name and a subtest comment line with skip text -> exit 0', () => {
    const tap = [
      'TAP version 13',
      '# Subtest: unallowed skip: a DB test "rateGame keeps an eligible game proving # SKIP local supabase is not running" -> exit 1, stderr names it',
      'ok 1 - unallowed skip: a DB test "rateGame keeps an eligible game proving \\# SKIP local supabase is not running" -> exit 1, stderr names it',
      '# tests 1',
      '# pass 1',
    ].join('\n');

    const res = runFixture(tap);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^OK: 1 tests; allowed skips: /);
    assert.equal(res.stderr, '');
  });

  it('nested subtest indented with 4 spaces containing unallowed skip -> exit 1 and stderr names the test', () => {
    const tap = [
      'TAP version 13',
      '    # Subtest: nested db suite',
      '    ok 1 - some db setup',
      '    ok 2 - check table exists',
      '    ok 3 - rateGame keeps an eligible game proving # SKIP local supabase is not running',
      '    # tests 3',
      'ok 1 - nested db suite',
      '# tests 4',
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

  describe('ALLOWLIST contract and name matching mutants', () => {
    it('(d) ALLOWLIST matches exact literal expected [name, max] pairs', () => {
      const actualPairs: [string, number][] = ALLOWLIST.map((e) => [e.name, e.max]);
      const expectedPairs: [string, number][] = [
        ['byte-budget input is fully analysed with median < 0.75 x AST_BUDGET.ms (450 ms)', 1],
        ['a 3x linear slowdown is caught (relative, machine-speed independent)', 1],
        ['AS-5 game loads its own assets under the enforced CSP (Chromium)', 1],
      ];
      assert.deepStrictEqual(actualPairs, expectedPairs);
    });

    it('(a1) an allowlisted name with " extra" appended, skipped exits 1', () => {
      const baseName = ALLOWLIST[0].name;
      const mutatedName = `${baseName} extra`;
      const tap = [
        'TAP version 13',
        `ok 1 - ${mutatedName} # SKIP some reason`,
        '# tests 1',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, new RegExp(mutatedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('(a2) a strict prefix of an allowlisted name (cut off before the end), skipped exits 1', () => {
      const baseName = ALLOWLIST[0].name;
      const prefixName = baseName.slice(0, -6);
      const tap = [
        'TAP version 13',
        `ok 1 - ${prefixName} # SKIP some reason`,
        '# tests 1',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, new RegExp(prefixName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('(a3) a substring from the middle of an allowlisted name, skipped exits 1', () => {
      const baseName = ALLOWLIST[0].name;
      const middleName = baseName.slice(5, 35);
      const tap = [
        'TAP version 13',
        `ok 1 - ${middleName} # SKIP some reason`,
        '# tests 1',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, new RegExp(middleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('(b) a lowercase "# skip" directive on a non-allowlisted test exits 1, and stderr names the test', () => {
      const tap = [
        'TAP version 13',
        'ok 1 - unallowed test with lowercase directive # skip some reason',
        '# tests 1',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /unallowed test with lowercase directive/);
    });

    it('(c) AS-5 name "AS-5 game loads its own assets under the enforced CSP (Chromium)" skipped twice exits 1', () => {
      const as5Name = 'AS-5 game loads its own assets under the enforced CSP (Chromium)';
      const tap = [
        'TAP version 13',
        `ok 1 - ${as5Name} # SKIP reason one`,
        `ok 2 - ${as5Name} # SKIP reason two`,
        '# tests 2',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /AS-5 game loads its own assets under the enforced CSP \(Chromium\)/);
    });

    describe('(c) loop over every ALLOWLIST entry: max exits 0, max+1 exits 1', () => {
      for (const entry of ALLOWLIST) {
        it(`ALLOWLIST entry "${entry.name}": skipping exactly max (${entry.max}) times exits 0`, () => {
          const lines = ['TAP version 13'];
          for (let i = 1; i <= entry.max; i++) {
            lines.push(`ok ${i} - ${entry.name} # SKIP allowed reason ${i}`);
          }
          lines.push(`# tests ${entry.max}`);

          const res = runFixture(lines.join('\n'));
          assert.equal(res.status, 0);
          assert.match(res.stdout, new RegExp(`OK: ${entry.max} tests; allowed skips: `));
          assert.equal(res.stderr, '');
        });

        it(`ALLOWLIST entry "${entry.name}": skipping max+1 (${entry.max + 1}) times exits 1`, () => {
          const lines = ['TAP version 13'];
          for (let i = 1; i <= entry.max + 1; i++) {
            lines.push(`ok ${i} - ${entry.name} # SKIP exceeded reason ${i}`);
          }
          lines.push(`# tests ${entry.max + 1}`);

          const res = runFixture(lines.join('\n'));
          assert.equal(res.status, 1);
          assert.match(res.stderr, new RegExp(entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        });
      }
    });

    it('(e) a skipped test named "foo \\# bar" in the TAP (escaped hash) exits 1, and stderr contains "foo # bar"', () => {
      const tap = [
        'TAP version 13',
        'ok 1 - foo \\# bar # SKIP some reason',
        '# tests 1',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /foo # bar/);
    });

    it('(f) "not ok 1 - x # SKIP r" on a non-allowlisted test exits 1, and stderr names x', () => {
      const tap = [
        'TAP version 13',
        'not ok 1 - x # SKIP r',
        '# tests 1',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /\bx\b/);
    });
  });
});
