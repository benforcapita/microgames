import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOWLIST, checkPlaywrightJson } from './assert-no-db-skips.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GUARD_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/ci/assert-no-db-skips.mjs')).href;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface PlaywrightResultFixture {
  workerIndex?: number;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration?: number;
  errors?: unknown[];
}

interface PlaywrightAnnotationFixture {
  type: string;
  description?: string;
}

interface PlaywrightTestFixture {
  timeout?: number;
  annotations?: PlaywrightAnnotationFixture[];
  expectedStatus?: string;
  projectId?: string;
  projectName?: string;
  results?: PlaywrightResultFixture[];
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
}

interface PlaywrightSpecFixture {
  title: string;
  ok?: boolean;
  tests: PlaywrightTestFixture[];
}

interface PlaywrightSuiteFixture {
  title: string;
  file?: string;
  suites?: PlaywrightSuiteFixture[];
  specs?: PlaywrightSpecFixture[];
}

interface PlaywrightReportFixture {
  config: {
    rootDir: string;
    configFile: string;
    workers?: number;
  };
  suites: PlaywrightSuiteFixture[];
  errors: unknown[];
  stats: {
    startTime: string;
    duration: number;
    expected: number;
    skipped: number;
    unexpected: number;
    flaky: number;
  };
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

function runJsonFixture(content: string | PlaywrightReportFixture): CliResult {
  const fixturePath = path.join(tempDir, `fixture-${++fixtureIndex}.json`);
  const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(fixturePath, raw, 'utf8');
  return runCli([fixturePath]);
}

function createPlaywrightReport(suites: PlaywrightSuiteFixture[]): PlaywrightReportFixture {
  return {
    config: {
      rootDir: REPO_ROOT,
      configFile: 'playwright.config.ts',
      workers: 1,
    },
    suites,
    errors: [],
    stats: {
      startTime: '2026-10-20T10:00:00.000Z',
      duration: 1200,
      expected: 0,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
    },
  };
}

function createExpectedTest(): PlaywrightTestFixture {
  return {
    timeout: 30000,
    annotations: [],
    expectedStatus: 'passed',
    projectId: 'chromium',
    projectName: 'chromium',
    results: [
      {
        workerIndex: 0,
        status: 'passed',
        duration: 100,
        errors: [],
      },
    ],
    status: 'expected',
  };
}

function createSkippedTest(reason = 'skipped'): PlaywrightTestFixture {
  return {
    timeout: 30000,
    annotations: [{ type: 'skip', description: reason }],
    expectedStatus: 'skipped',
    projectId: 'chromium',
    projectName: 'chromium',
    results: [
      {
        workerIndex: 0,
        status: 'skipped',
        duration: 0,
        errors: [],
      },
    ],
    status: 'skipped',
  };
}

function createUnexpectedTest(): PlaywrightTestFixture {
  return {
    timeout: 30000,
    annotations: [],
    expectedStatus: 'passed',
    projectId: 'chromium',
    projectName: 'chromium',
    results: [
      {
        workerIndex: 0,
        status: 'failed',
        duration: 50,
        errors: [{ message: 'Assertion failed' }],
      },
    ],
    status: 'unexpected',
  };
}

describe('assert-no-db-skips guard', () => {
  it('clean run: summary "# tests 4", the 2 allowlisted skips by exact name, rest ok -> exit 0', () => {
    const tap = [
      'TAP version 13',
      `ok 1 - ${ALLOWLIST[0].name} # SKIP CI=true: strict timing`,
      `ok 2 - ${ALLOWLIST[1].name} # SKIP CI=true: strict timing`,
      'ok 3 - some regular test passing',
      'ok 4 - another regular test passing',
      '# tests 4',
      '# pass 2',
      '# fail 0',
      '# skipped 2',
    ].join('\n');

    const res = runFixture(tap);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^OK: 4 tests; allowed skips: /);
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

    it('(c) a still-allowlisted name skipped twice exits 1', () => {
      const allowlistedName = ALLOWLIST[0].name;
      const tap = [
        'TAP version 13',
        `ok 1 - ${allowlistedName} # SKIP reason one`,
        `ok 2 - ${allowlistedName} # SKIP reason two`,
        '# tests 2',
      ].join('\n');

      const res = runFixture(tap);
      assert.equal(res.status, 1);
      assert.match(res.stderr, new RegExp(allowlistedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('AS-5 name "AS-5 game loads its own assets under the enforced CSP (Chromium)" skipped exits 1', () => {
      const as5Name = 'AS-5 game loads its own assets under the enforced CSP (Chromium)';
      const tap = [
        'TAP version 13',
        `ok 1 - ${as5Name} # SKIP no Playwright Chromium available`,
        '# tests 1',
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

  describe('Playwright JSON report guard', () => {
    it('all expected -> exit 0 with the count printed', () => {
      const report = createPlaywrightReport([
        {
          title: 'e2e/db-sessions.spec.mjs',
          suites: [
            {
              title: 'session suite',
              specs: [
                {
                  title: 'session creates and reads back',
                  tests: [createExpectedTest()],
                },
                {
                  title: 'session deletes on logout',
                  tests: [createExpectedTest()],
                },
              ],
            },
          ],
        },
      ]);

      const res = runJsonFixture(report);
      assert.equal(res.status, 0);
      assert.match(res.stdout, /^OK: 2 tests; allowed skips: /);
      assert.equal(res.stderr, '');
    });

    it('one skipped spec -> exit 1 and stderr names its title', () => {
      const specTitle = 'unallowed skipped spec in e2e';
      const report = createPlaywrightReport([
        {
          title: 'e2e/db-sessions.spec.mjs',
          suites: [
            {
              title: 'session suite',
              specs: [
                {
                  title: specTitle,
                  tests: [createSkippedTest('local db unavailable')],
                },
              ],
            },
          ],
        },
      ]);

      const res = runJsonFixture(report);
      assert.equal(res.status, 1);
      assert.match(res.stderr, new RegExp(specTitle));
    });

    it('a skipped spec nested 2 suites deep -> exit 1', () => {
      const deepSpecTitle = 'spec nested two suites deep';
      const report = createPlaywrightReport([
        {
          title: 'top suite',
          suites: [
            {
              title: 'middle suite',
              suites: [
                {
                  title: 'innermost suite',
                  specs: [
                    {
                      title: deepSpecTitle,
                      tests: [createSkippedTest('deep skip reason')],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);

      const res = runJsonFixture(report);
      assert.equal(res.status, 1);
      assert.match(res.stderr, new RegExp(deepSpecTitle));
    });

    it('an empty suites array / zero tests -> exit 1', () => {
      const report = createPlaywrightReport([]);

      const res = runJsonFixture(report);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /No tests found in Playwright JSON report/);
    });

    it('an unexpected (failed) test -> exit 1', () => {
      const failingSpecTitle = 'failing e2e test';
      const report = createPlaywrightReport([
        {
          title: 'e2e/db-sessions.spec.mjs',
          suites: [
            {
              title: 'session suite',
              specs: [
                {
                  title: failingSpecTitle,
                  tests: [createUnexpectedTest()],
                },
              ],
            },
          ],
        },
      ]);

      const res = runJsonFixture(report);
      assert.equal(res.status, 1);
      assert.match(res.stderr, new RegExp(failingSpecTitle));
      assert.match(res.stderr, /unexpected/);
    });

    it('a skipped spec whose title is an allowlisted name skipped once -> exit 0, and twice -> exit 1', () => {
      const allowlistedName = ALLOWLIST[0].name;

      const reportOnce = createPlaywrightReport([
        {
          title: 'e2e/timing.spec.mjs',
          suites: [
            {
              title: 'timing suite',
              specs: [
                {
                  title: allowlistedName,
                  tests: [createSkippedTest('CI strict timing')],
                },
              ],
            },
          ],
        },
      ]);

      const resOnce = runJsonFixture(reportOnce);
      assert.equal(resOnce.status, 0);
      assert.match(resOnce.stdout, /^OK: 1 tests; allowed skips: /);
      assert.equal(resOnce.stderr, '');

      const reportTwice = createPlaywrightReport([
        {
          title: 'e2e/timing.spec.mjs',
          suites: [
            {
              title: 'timing suite',
              specs: [
                {
                  title: allowlistedName,
                  tests: [createSkippedTest('CI strict timing 1')],
                },
                {
                  title: allowlistedName,
                  tests: [createSkippedTest('CI strict timing 2')],
                },
              ],
            },
          ],
        },
      ]);

      const resTwice = runJsonFixture(reportTwice);
      assert.equal(resTwice.status, 1);
      assert.match(resTwice.stderr, new RegExp(allowlistedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('malformed JSON that starts with "{" -> exit 1 (do not fall back to treating it as passing TAP)', () => {
      const malformed = '{\n  "suites": [ broken JSON';

      const resJson = runJsonFixture(malformed);
      assert.equal(resJson.status, 1);
      assert.match(resJson.stderr, /Failed to parse Playwright JSON/);

      // Even if saved in a .tap file, starting with "{" must be treated as JSON and exit 1
      const resTap = runFixture(malformed);
      assert.equal(resTap.status, 1);
      assert.match(resTap.stderr, /Failed to parse Playwright JSON/);
    });

    it('test whose last result status is skipped is treated as skipped -> exit 1', () => {
      const specTitle = 'test with last result status skipped';
      const report = createPlaywrightReport([
        {
          title: 'e2e/db-sessions.spec.mjs',
          suites: [
            {
              title: 'session suite',
              specs: [
                {
                  title: specTitle,
                  tests: [
                    {
                      timeout: 30000,
                      annotations: [],
                      expectedStatus: 'passed',
                      status: 'expected',
                      results: [
                        {
                          status: 'skipped',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);

      const res = runJsonFixture(report);
      assert.equal(res.status, 1);
      assert.match(res.stderr, new RegExp(specTitle));
    });

    it('checkPlaywrightJson pure function returns expected shape and allowed map', () => {
      const allowlistedName = ALLOWLIST[0].name;
      const report = createPlaywrightReport([
        {
          title: 'e2e/timing.spec.mjs',
          suites: [
            {
              title: 'suite',
              specs: [
                {
                  title: allowlistedName,
                  tests: [createSkippedTest('reason')],
                },
              ],
            },
          ],
        },
      ]);

      const result = checkPlaywrightJson(JSON.stringify(report));
      assert.equal(result.ok, true);
      assert.equal(result.totalTests, 1);
      assert.equal(result.errors.length, 0);
      assert.equal(result.allowed.get(allowlistedName), 1);
    });
  });
});
