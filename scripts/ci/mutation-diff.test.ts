import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { Minimatch, minimatch } from 'minimatch';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mutationBase, runMutation, type MutationDeps, type MutationRequest, type TestSource } from './mutation-diff.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./mutation-diff.ts', import.meta.url));
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-diff-'));
  tempDirs.push(dir);
  return dir;
}

function request(overrides: Partial<MutationRequest> = {}): MutationRequest {
  return {
    baseRef: 'origin/main',
    reportDir: 'reports',
    summaryPath: null,
    equivalentsPath: 'scripts/ci/mutation-equivalents.json',
    repoRoot: REPO_ROOT,
    ...overrides,
  };
}

function diffFor(file: string, lines: readonly string[]): string {
  const body = lines.map((line) => `+${line}`).join('\n');
  return [
    `diff --git a/${file} b/${file}`,
    `--- /dev/null`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    '',
  ].join('\n');
}

function report(file: string, mutants: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    thresholds: { high: 100, low: 100, break: null },
    files: {
      [file]: {
        language: 'typescript',
        source: 'export const value = 1;\n',
        mutants,
      },
    },
  });
}

function mutant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1',
    mutatorName: 'ArithmeticOperator',
    replacement: '-',
    status: 'Survived',
    location: { start: { line: 2, column: 3 }, end: { line: 2, column: 4 } },
    ...overrides,
  };
}

type Memory = {
  deps: MutationDeps;
  files: Map<string, string>;
  strykerCalls: string[];
};

function memory(options: { diff?: string; gitStatus?: number; tests?: readonly TestSource[]; strykerStatus?: number; report?: string | null }): Memory {
  const files = new Map<string, string>();
  const strykerCalls: string[] = [];
  const deps: MutationDeps = {
    gitDiff: () => ({ status: options.gitStatus ?? 0, stdout: options.diff ?? '', stderr: options.gitStatus ? 'fatal: bad revision' : '' }),
    readText: (file) => files.get(file) ?? null,
    writeText: (file, contents) => {
      files.set(file, contents);
    },
    testSources: () => options.tests ?? [],
    stryker: (configPath) => {
      strykerCalls.push(configPath);
      if (options.report !== null && options.report !== undefined) files.set('reports/mutation.json', options.report);
      return { status: options.strykerStatus ?? 0, stdout: '', stderr: options.strykerStatus ? 'stryker failed' : '' };
    },
  };
  return { deps, files, strykerCalls };
}

type SurvivorArtifact = {
  error: string | null;
  gaps: Array<{ file: string; line: number; status: string }>;
  equivalents: unknown[];
};

type StrykerConfig = {
  incremental: boolean;
  coverageAnalysis: string;
  concurrency: number;
  timeoutMS: number;
  mutate: string[];
  commandRunner: { command: string };
  thresholds: { break: null | number };
  reporters: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonRecord(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  assert.ok(isRecord(parsed));
  return parsed;
}

function artifact(files: Map<string, string>): SurvivorArtifact {
  const raw = files.get('reports/mutation-survivors.json');
  assert.ok(raw, 'survivor artifact was written');
  const parsed = jsonRecord(raw);
  assert.ok(Array.isArray(parsed.gaps));
  assert.ok(Array.isArray(parsed.equivalents));
  const gaps = parsed.gaps.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.file !== 'string' || typeof entry.line !== 'number' || typeof entry.status !== 'string') return [];
    return [{ file: entry.file, line: entry.line, status: entry.status }];
  });
  return { error: typeof parsed.error === 'string' || parsed.error === null ? parsed.error : 'invalid error', gaps, equivalents: parsed.equivalents };
}

function strykerWouldMutate(pattern: string, file: string): boolean {
  const match = /^(.*?):(\d+)(?::\d+)?-(\d+)(?::\d+)?$/.exec(pattern);
  const filePattern = match?.[1];
  const start = match?.[2];
  const end = match?.[3];
  if (filePattern === undefined || start === undefined || end === undefined) return false;
  if (new Minimatch(pattern).hasMagic()) return false;
  const startLine = Number(start);
  const endLine = Number(end);
  if (startLine < 1 || startLine > endLine) return false;
  return minimatch(path.resolve(file), path.resolve(filePattern), { dot: false });
}

function configOf(files: Map<string, string>): StrykerConfig {
  const raw = files.get('reports/stryker.config.json');
  assert.ok(raw, 'stryker config was written');
  const parsed = jsonRecord(raw);
  const commandRunner = parsed.commandRunner;
  const thresholds = parsed.thresholds;
  assert.ok(isRecord(commandRunner) && typeof commandRunner.command === 'string');
  assert.ok(isRecord(thresholds) && (thresholds.break === null || typeof thresholds.break === 'number'));
  assert.ok(Array.isArray(parsed.mutate) && parsed.mutate.every((entry) => typeof entry === 'string'));
  assert.ok(Array.isArray(parsed.reporters) && parsed.reporters.every((entry) => typeof entry === 'string'));
  if (typeof parsed.incremental !== 'boolean') throw new Error('incremental');
  if (typeof parsed.coverageAnalysis !== 'string') throw new Error('coverageAnalysis');
  if (typeof parsed.concurrency !== 'number') throw new Error('concurrency');
  if (typeof parsed.timeoutMS !== 'number') throw new Error('timeoutMS');
  return {
    incremental: parsed.incremental,
    coverageAnalysis: parsed.coverageAnalysis,
    concurrency: parsed.concurrency,
    timeoutMS: parsed.timeoutMS,
    mutate: parsed.mutate,
    commandRunner: { command: commandRunner.command },
    thresholds: { break: thresholds.break },
    reporters: parsed.reporters,
  };
}

describe('mutationBase', () => {
  it('uses origin/main when the push has no previous sha', () => {
    assert.equal(mutationBase(undefined), 'origin/main');
    assert.equal(mutationBase(''), 'origin/main');
    assert.equal(mutationBase('0000000'), 'origin/main');
  });

  it('keeps an explicit base ref', () => {
    assert.equal(mutationBase('origin/feature'), 'origin/feature');
  });
});

describe('runMutation', () => {
  it('accepts a parent revision and passes it to git', () => {
    const seen: string[] = [];
    const box = memory({});
    const gitDiff = box.deps.gitDiff;
    box.deps.gitDiff = (baseRef) => {
      seen.push(baseRef);
      return gitDiff(baseRef);
    };
    const result = runMutation(request({ baseRef: 'HEAD~1' }), box.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(seen, ['HEAD~1']);
  });

  it('fails closed when the base ref could be a git option', () => {
    const box = memory({});
    const result = runMutation(request({ baseRef: '--output=/tmp/pwn' }), box.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /Invalid mutation base ref/);
    assert.deepEqual(box.strykerCalls, []);
    assert.equal(artifact(box.files).error === null, false);
  });

  it('fails closed when git diff fails and does not run Stryker', () => {
    const box = memory({ gitStatus: 1 });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /git diff exited 1/);
    assert.match(result.summary, /bad revision/);
    assert.deepEqual(box.strykerCalls, []);
  });

  it('passes without Stryker when the diff has no production lines', () => {
    const box = memory({
      diff: diffFor('scripts/ci/mutation-diff.ts', ['export const harness = 1;']),
    });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0);
    assert.match(result.summary, /No changed production lines to mutate/);
    assert.match(result.summary, /scripts\/ci\/mutation-diff\.ts/);
    assert.deepEqual(box.strykerCalls, []);
    assert.deepEqual(artifact(box.files).gaps, []);
  });

  it('names changed code the runner does not mutate', () => {
    const box = memory({ diff: diffFor('workers/categorizer/scan.py', ['def scan():', '    return 1']) });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0);
    assert.match(result.summary, /::warning::.*workers\/categorizer\/scan\.py/);
    assert.deepEqual(box.strykerCalls, []);
  });

  it('warns for changed SQL, Astro, admin, Supabase, worker, and Python files', () => {
    const unmutated = [
      'supabase/migrations/001_init.sql',
      'src/pages/index.astro',
      'admin/src/main.ts',
      'workers/categorizer/scan.py',
    ];
    const box = memory({
      diff: [
        ...unmutated.map((file) => diffFor(file, ['export const value = 1;'])),
        diffFor('src/lib/add.ts', ['export const value = 1;']),
        diffFor('README.md', ['# title']),
      ].join('\n'),
      report: report('src/lib/add.ts', [mutant({ status: 'Killed' })]),
    });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0);
    for (const file of unmutated) {
      assert.match(result.summary, new RegExp(`::warning::.*${file.replaceAll('/', '\\/')}`));
    }
    assert.doesNotMatch(result.summary, /::warning::.*src\/lib\/add\.ts/);
    assert.doesNotMatch(result.summary, /::warning::.*README\.md/);
    assert.equal(box.strykerCalls.length, 1);
  });

  it('mutates changed lines without reusing an incremental cache', () => {
    const box = memory({
      diff: [
        diffFor('src/lib/add.ts', ['export function add(left: number, right: number): number {', '  return left + right;', '}']).trimEnd(),
        diffFor('README.md', ['# title']).trimEnd(),
      ].join('\n'),
      tests: [
        { path: 'src/lib/add.test.ts', source: "import { add } from './add.ts';\n" },
        { path: 'src/lib/other.test.ts', source: "import { other } from './other.ts';\n" },
        { path: 'src/lib/add.db.test.ts', source: "import { add } from './add.ts';\n" },
        { path: 'cdn/use-add.test.ts', source: "import { add } from '../src/lib/add.ts';\n" },
      ],
      report: report('src/lib/add.ts', [mutant({ status: 'Killed', id: 'killed' })]),
    });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0);
    const config = configOf(box.files);
    assert.equal(config.incremental, false);
    assert.equal(box.files.get('reports/stryker.config.json')?.includes('incrementalFile'), false);
    assert.equal(config.coverageAnalysis, 'off');
    assert.equal(config.concurrency, 2);
    assert.equal(config.timeoutMS, 10000);
    assert.equal(config.thresholds.break, null);
    assert.deepEqual(config.reporters, ['clear-text', 'json']);
    assert.deepEqual(config.mutate, ['src/lib/add.ts:1-3']);
    assert.match(config.commandRunner.command, /src\/lib\/add\.test\.ts/);
    assert.match(config.commandRunner.command, /cdn\/use-add\.test\.ts/);
    assert.doesNotMatch(config.commandRunner.command, /other\.test\.ts/);
    assert.doesNotMatch(config.commandRunner.command, /add\.db\.test\.ts/);
    assert.match(result.summary, /No survivors on changed lines/);
  });

  it('fails on a survived mutant on a changed line and writes that survivor', () => {
    const box = memory({
      diff: diffFor('src/lib/add.ts', ['export function add(left: number, right: number): number {', '  return left + right;', '}']),
      tests: [{ path: 'src/lib/add.test.ts', source: "import { add } from './add.ts';\n" }],
      report: report('src/lib/add.ts', [
        mutant(),
        mutant({ id: 'elsewhere', location: { start: { line: 9, column: 1 }, end: { line: 9, column: 2 } } }),
        mutant({ id: 'killed', status: 'Killed' }),
        mutant({ id: 'slow', status: 'Timeout', replacement: '*' }),
      ]),
    });
    const summaryPath = 'summary.md';
    const result = runMutation(request({ summaryPath }), box.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /gap/);
    assert.match(result.summary, /ArithmeticOperator/);
    assert.match(result.summary, /1 non-equivalent survivor/);
    const body = artifact(box.files);
    assert.equal(body.error, null);
    assert.equal(body.gaps.length, 1);
    assert.equal(body.gaps[0]?.file, 'src/lib/add.ts');
    assert.equal(body.gaps[0]?.line, 2);
    assert.equal(body.gaps[0]?.status, 'Survived');
    assert.match(box.files.get(summaryPath) ?? '', /1 non-equivalent survivor/);
  });

  it('accepts a survived mutant that the equivalents file names and still fails an untested mutant', () => {
    const survived = mutant();
    const uncovered = mutant({ id: '2', status: 'NoCoverage', mutatorName: 'BlockStatement', replacement: '{}' });
    const box = memory({
      diff: diffFor('src/lib/add.ts', ['export function add(left: number, right: number): number {', '  return left + right;', '}']),
      report: report('src/lib/add.ts', [survived, uncovered]),
    });
    box.files.set(
      'scripts/ci/mutation-equivalents.json',
      JSON.stringify({
        equivalents: [
          {
            file: 'src/lib/add.ts',
            line: 2,
            mutator: 'ArithmeticOperator',
            replacement: '-',
            justification: 'The swapped operator is equivalent for this identity.',
          },
          {
            file: 'src/lib/add.ts',
            line: 2,
            mutator: 'BlockStatement',
            replacement: '{}',
            justification: 'Listed so the allowlist itself is valid; NoCoverage still fails.',
          },
        ],
      }),
    );
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 1);
    const body = artifact(box.files);
    assert.equal(body.gaps.length, 1);
    assert.equal(body.gaps[0]?.status, 'NoCoverage');
    assert.equal(body.equivalents.length, 1);
    assert.match(result.summary, /1 non-equivalent survivor\(s\)\. 1 equivalent survivor/);
  });

  it('passes when every changed-line survivor is listed as equivalent', () => {
    const box = memory({
      diff: diffFor('src/lib/add.ts', ['export function add(left: number, right: number): number {', '  return left + right;', '}']),
      report: report('src/lib/add.ts', [mutant()]),
    });
    box.files.set(
      'scripts/ci/mutation-equivalents.json',
      JSON.stringify({
        equivalents: [
          {
            file: 'src/lib/add.ts',
            line: 2,
            mutator: 'ArithmeticOperator',
            replacement: '-',
            justification: 'The swapped operator is equivalent for this identity.',
          },
        ],
      }),
    );
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(artifact(box.files).gaps, []);
    assert.equal(artifact(box.files).equivalents.length, 1);
  });

  it('fails when a changed line ignores a mutant', () => {
    const box = memory({
      diff: diffFor('src/lib/add.ts', ['export function add(left: number, right: number): number {', '  return left + right;', '}']),
      report: report('src/lib/add.ts', [mutant({ status: 'Ignored', replacement: '' })]),
    });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(artifact(box.files).error, null);
    assert.equal(artifact(box.files).gaps[0]?.status, 'Ignored');
    assert.equal(artifact(box.files).equivalents.length, 0);
  });

  it('fails when an allowlist entry has no justification', () => {
    const entry = { file: 'src/lib/add.ts', line: 2, mutator: 'ArithmeticOperator', replacement: '-' };
    const payloads = [entry, { ...entry, justification: '   ' }];
    for (const payload of payloads) {
      const box = memory({
        diff: diffFor('src/lib/add.ts', ['export function add(left: number, right: number): number {', '  return left + right;', '}']),
        report: report('src/lib/add.ts', [mutant()]),
      });
      box.files.set('scripts/ci/mutation-equivalents.json', JSON.stringify({ equivalents: [payload] }));
      const result = runMutation(request(), box.deps);
      assert.equal(result.exitCode, 1);
      assert.match(result.summary, /justification/);
      assert.deepEqual(artifact(box.files).gaps, []);
      assert.equal(artifact(box.files).equivalents.length, 0);
    }
  });

  it('does not waive an ignored mutant when the allowlist names a different replacement', () => {
    const box = memory({
      diff: diffFor('src/lib/add.ts', ['export function add(left: number, right: number): number {', '  return left + right;', '}']),
      report: report('src/lib/add.ts', [mutant({ status: 'Ignored', replacement: '' })]),
    });
    box.files.set(
      'scripts/ci/mutation-equivalents.json',
      JSON.stringify({
        equivalents: [
          {
            file: 'src/lib/add.ts',
            line: 2,
            mutator: 'ArithmeticOperator',
            replacement: 'other',
            justification: 'This entry names a different replacement.',
          },
        ],
      }),
    );
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(artifact(box.files).gaps[0]?.status, 'Ignored');
    assert.equal(artifact(box.files).equivalents.length, 0);
  });

  it('fails when the allowlist is invalid even if nothing is mutated', () => {
    const box = memory({ diff: diffFor('README.md', ['# title']) });
    box.files.set(
      'scripts/ci/mutation-equivalents.json',
      JSON.stringify({ equivalents: [{ file: 'src/lib/add.ts', line: 2, mutator: 'ArithmeticOperator', replacement: '-' }] }),
    );
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /justification/);
    assert.deepEqual(box.strykerCalls, []);
  });

  it('warns when an unmutated file is deleted or renamed', () => {
    const diff = [
      'diff --git a/supabase/migrations/foo.sql b/supabase/migrations/foo.sql',
      'index ab290eb..e69de29 100644',
      '--- a/supabase/migrations/foo.sql',
      '+++ b/supabase/migrations/foo.sql',
      '@@ -1 +0,0 @@',
      '-select 1;',
      'diff --git a/workers/categorizer/scan.py b/workers/categorizer/decide.py',
      'similarity index 100%',
      'rename from workers/categorizer/scan.py',
      'rename to workers/categorizer/decide.py',
      '',
    ].join('\n');
    const box = memory({ diff });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0, result.summary);
    assert.match(result.summary, /::warning::.*supabase\/migrations\/foo\.sql/);
    assert.match(result.summary, /::warning::.*workers\/categorizer\/scan\.py/);
    assert.match(result.summary, /::warning::.*workers\/categorizer\/decide\.py/);
    assert.deepEqual(box.strykerCalls, []);
  });

  it('accepts an ignored mutant only when the allowlist justifies it', () => {
    const box = memory({
      diff: diffFor('src/lib/add.ts', ['export function add(left: number, right: number): number {', '  return left + right;', '}']),
      report: report('src/lib/add.ts', [mutant({ status: 'Ignored', replacement: '' })]),
    });
    box.files.set(
      'scripts/ci/mutation-equivalents.json',
      JSON.stringify({
        equivalents: [
          {
            file: 'src/lib/add.ts',
            line: 2,
            mutator: 'ArithmeticOperator',
            replacement: '',
            justification: 'The disable comment guards a boundary the test cannot observe.',
          },
        ],
      }),
    );
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(artifact(box.files).gaps, []);
    assert.equal(artifact(box.files).equivalents.length, 1);
  });

  it('accepts a changed path that contains brackets', () => {
    const file = 'src/pages/[slug].ts';
    const box = memory({
      diff: diffFor(file, ['export const slug = 1;', 'export const other = 2;']),
      report: report(file, [mutant({ status: 'Killed', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } })]),
    });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0, result.summary);
    assert.doesNotMatch(result.summary, /not a repo path/);
    const pattern = configOf(box.files).mutate[0];
    assert.equal(pattern === undefined, false);
    assert.equal(strykerWouldMutate(pattern ?? '', file), true);
  });

  it('accepts a bracketed Astro route and warns that it is not mutated', () => {
    const file = 'src/pages/u/[creator].astro';
    const box = memory({ diff: diffFor(file, ['---', '---']) });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 0, result.summary);
    assert.doesNotMatch(result.summary, /not a repo path/);
    assert.match(result.summary, /::warning::.*src\/pages\/u\/\[creator\]\.astro/);
    assert.deepEqual(box.strykerCalls, []);
  });

  it('fails when Stryker exits without a report', () => {
    const box = memory({
      diff: diffFor('src/lib/add.ts', ['export const value = 1;']),
      strykerStatus: 1,
      report: null,
    });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /Stryker exited 1/);
    assert.match(result.summary, /stryker failed/);
    assert.deepEqual(artifact(box.files).gaps, []);
  });

  it('fails closed on a quoted diff path', () => {
    const box = memory({
      diff: ['diff --git a/src/lib/add.ts b/src/lib/add.ts', '--- /dev/null', '+++ "b/src/lib/add.ts"', '@@ -0,0 +1 @@', '+export const value = 1;', ''].join('\n'),
    });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /quoted diff path/);
    assert.deepEqual(box.strykerCalls, []);
  });

  it('uses the changed lines from a real git diff', () => {
    const dir = tempDir();
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Mutation Test',
      GIT_AUTHOR_EMAIL: 'mutation@example.com',
      GIT_COMMITTER_NAME: 'Mutation Test',
      GIT_COMMITTER_EMAIL: 'mutation@example.com',
    };
    const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv });
    assert.equal(git(['init', '-b', 'main']).status, 0);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/sample.ts'), 'alpha\nbeta\ngamma\n');
    assert.equal(git(['add', 'src/sample.ts']).status, 0);
    assert.equal(git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']).status, 0);
    fs.writeFileSync(path.join(dir, 'src/sample.ts'), 'alpha\nBETA\ngamma\ndelta\n');
    const diff = git(['diff', '-U0', '--no-color', '--diff-filter=ACMR', 'HEAD']);
    assert.equal(diff.status, 0);
    const box = memory({
      diff: diff.stdout,
      report: report('src/sample.ts', [
        mutant({ location: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } } }),
        mutant({ id: 'added', replacement: '""', location: { start: { line: 4, column: 1 }, end: { line: 4, column: 2 } } }),
      ]),
    });
    const result = runMutation(request(), box.deps);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(configOf(box.files).mutate, ['src/sample.ts:2-2', 'src/sample.ts:4-4']);
    assert.equal(artifact(box.files).gaps.length, 2);
  });
});

describe('mutation cli', () => {
  it('exits 0 and writes an empty survivor list when HEAD has no diff', () => {
    const dir = tempDir();
    const summary = path.join(dir, 'summary.md');
    const reportDir = path.join(dir, 'reports');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MUTATION_BASE: 'HEAD',
        MUTATION_REPORT_DIR: reportDir,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Diff base: `HEAD`/);
    assert.match(result.stdout, /No changed production lines to mutate/);
    const written = fs.readFileSync(path.join(reportDir, 'mutation-survivors.json'), 'utf8');
    assert.match(written, /"gaps": \[\]/);
    assert.match(fs.readFileSync(summary, 'utf8'), /No changed production lines/);
  });

  it('runs the mutation job three times in one workflow', () => {
    const yaml = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.match(yaml, /name: mutation \(\$\{\{ matrix\.run \}\}\)/);
    assert.match(yaml, /fail-fast: false/);
    assert.match(yaml, /run: \[1, 2, 3\]/);
    assert.match(yaml, /timeout-minutes: 15/);
    assert.match(yaml, /mutation-survivors-\$\{\{ matrix\.run \}\}/);
    assert.match(yaml, /reports\/mutation-survivors\.json/);
    assert.match(yaml, /contents: read/);
    assert.match(yaml, /actions: write/);
    assert.doesNotMatch(yaml, /stryker-incremental/);
    assert.doesNotMatch(yaml, /restore-keys/);
  });
});
