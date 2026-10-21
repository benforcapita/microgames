import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type RepoPath = string & { readonly __brand: 'RepoPath' };

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

type ChangedFile = {
  path: RepoPath;
  lines: ReadonlySet<number>;
};

type MutantStatus = 'Killed' | 'Survived' | 'NoCoverage' | 'CompileError' | 'RuntimeError' | 'Timeout' | 'Ignored' | 'Pending';

type Mutant = {
  id: string;
  file: RepoPath;
  mutator: string;
  replacement: string;
  status: MutantStatus;
  line: number;
};

type EquivalentMutant = {
  file: RepoPath;
  line: number;
  mutator: string;
  replacement: string;
};

type SurvivorJudgment = { kind: 'equivalent'; mutant: Mutant } | { kind: 'gap'; mutant: Mutant };

type SurvivorRecord = {
  file: string;
  line: number;
  mutator: string;
  replacement: string;
  status: MutantStatus;
  id: string;
};

type SurvivorArtifact = {
  error: string | null;
  gaps: SurvivorRecord[];
  equivalents: SurvivorRecord[];
};

type ClassifiedDiff = {
  targets: ChangedFile[];
  harness: RepoPath[];
  outside: RepoPath[];
};

type SummaryState = {
  baseRef: string;
  diffKnown: boolean;
  patterns: readonly string[];
  harness: readonly RepoPath[];
  outside: readonly RepoPath[];
  judgments: readonly SurvivorJudgment[];
  error: string | null;
};

export type ProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type TestSource = {
  path: string;
  source: string;
};

export type MutationRequest = {
  baseRef: string;
  reportDir: string;
  summaryPath: string | null;
  equivalentsPath: string;
  repoRoot: string;
};

export type MutationDeps = {
  gitDiff(baseRef: string): ProcessResult;
  readText(file: string): string | null;
  writeText(file: string, contents: string): void;
  testSources(): readonly TestSource[];
  stryker(configPath: string): ProcessResult;
};

export type MutationRun = {
  exitCode: number;
  summary: string;
};

type StrykerRunConfig = {
  testRunner: 'command';
  coverageAnalysis: 'off';
  commandRunner: { command: string };
  mutate: string[];
  incremental: true;
  incrementalFile: string;
  reporters: ['clear-text', 'json'];
  jsonReporter: { fileName: string };
  thresholds: { high: 100; low: 100; break: null };
  timeoutMS: 10000;
  timeoutFactor: 2;
  concurrency: 2;
  disableTypeChecks: true;
  cleanTempDir: 'always';
};

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const STRYKER_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 30 * 1000;
const repoRoot = path.resolve(import.meta.dirname, '../..');

function fail<T>(message: string): Parsed<T> {
  return { ok: false, message };
}

export function mutationBase(raw: string | undefined): string {
  if (raw === undefined) return 'origin/main';
  const trimmed = raw.trim();
  if (trimmed === '' || /^0+$/.test(trimmed)) return 'origin/main';
  return trimmed;
}

function isRepoPath(value: string): value is RepoPath {
  if (value.length === 0 || value.length > 400) return false;
  if (!/^[A-Za-z0-9._@/-]+$/.test(value)) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isBaseRef(value: string): boolean {
  if (value.length === 0 || value.length > 200 || value.startsWith('-') || value.includes('..')) return false;
  if (!/^[A-Za-z0-9._/@~^-]+$/.test(value)) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isDeclaration(file: RepoPath): boolean {
  return file.endsWith('.d.ts');
}

function isTestFile(file: RepoPath): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function isUnitTest(file: RepoPath): boolean {
  if (!isTestFile(file) || /\.(?:db|browser)\.test\.[cm]?[jt]sx?$/.test(file)) return false;
  return file.startsWith('src/') || file.startsWith('cdn/') || file.startsWith('mcp/') || file.startsWith('scripts/');
}

function isHarness(file: RepoPath): boolean {
  return file.startsWith('scripts/ci/') && !isTestFile(file) && !isDeclaration(file) && CODE_FILE.test(file);
}

function isMutable(file: RepoPath): boolean {
  if (isDeclaration(file) || isTestFile(file) || isHarness(file) || !CODE_FILE.test(file)) return false;
  return file.startsWith('src/') || file.startsWith('cdn/') || file.startsWith('mcp/') || file.startsWith('scripts/');
}

function isOutsideCode(file: RepoPath): boolean {
  if (isDeclaration(file) || isTestFile(file) || isHarness(file) || isMutable(file)) return false;
  return CODE_FILE.test(file) || file.endsWith('.py');
}

function pathFromPlus(line: string): Parsed<RepoPath | null> {
  const raw = line.slice(4).trim();
  if (raw === '/dev/null') return { ok: true, value: null };
  if (raw.startsWith('"') || raw.endsWith('"')) return fail(`quoted diff path is not supported: ${raw}`);
  const relative = raw.startsWith('b/') ? raw.slice(2) : raw;
  if (!isRepoPath(relative)) return fail(`diff path is not a repo path: ${raw}`);
  return { ok: true, value: relative };
}

export function parseChangedFiles(diff: string): Parsed<ChangedFile[]> {
  const files: ChangedFile[] = [];
  let pathName: RepoPath | null = null;
  let lines = new Set<number>();
  let newLine = 0;
  let inHunk = false;
  let open = false;

  const flush = (): void => {
    if (pathName && lines.size > 0) files.push({ path: pathName, lines });
    pathName = null;
    lines = new Set();
    newLine = 0;
    inHunk = false;
    open = false;
  };

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('diff --git ')) {
      flush();
      open = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!open) return fail('diff has a +++ header outside a file');
      const parsed = pathFromPlus(line);
      if (!parsed.ok) return parsed;
      pathName = parsed.value;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      if (!open) return fail('diff has a hunk outside a file');
      const start = Number(hunk[1]);
      if (!Number.isInteger(start) || start < 0) return fail(`diff hunk has an invalid start line: ${line}`);
      newLine = start;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      if (pathName && newLine > 0) lines.add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith('-') || line.startsWith('\\')) continue;
    newLine += 1;
  }
  flush();
  return { ok: true, value: files };
}

function classify(files: readonly ChangedFile[]): ClassifiedDiff {
  const targets: ChangedFile[] = [];
  const harness: RepoPath[] = [];
  const outside: RepoPath[] = [];
  for (const file of files) {
    if (file.lines.size === 0) continue;
    if (isHarness(file.path)) {
      harness.push(file.path);
      continue;
    }
    if (isMutable(file.path)) {
      targets.push(file);
      continue;
    }
    if (isOutsideCode(file.path)) outside.push(file.path);
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  harness.sort((left, right) => left.localeCompare(right));
  outside.sort((left, right) => left.localeCompare(right));
  return { targets, harness, outside };
}

function rangesFor(lines: ReadonlySet<number>): Array<{ start: number; end: number }> {
  const sorted = [...lines].filter((line) => Number.isInteger(line) && line > 0).sort((left, right) => left - right);
  const first = sorted[0];
  if (first === undefined) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let start = first;
  let previous = first;
  for (const line of sorted.slice(1)) {
    if (line === previous + 1) {
      previous = line;
      continue;
    }
    ranges.push({ start, end: previous });
    start = line;
    previous = line;
  }
  ranges.push({ start, end: previous });
  return ranges;
}

function mutatePatterns(files: readonly ChangedFile[]): string[] {
  const patterns: string[] = [];
  for (const file of files) {
    for (const range of rangesFor(file.lines)) patterns.push(`${file.path}:${range.start}-${range.end}`);
  }
  return patterns;
}

function candidatePaths(resolved: string): string[] {
  if (CODE_FILE.test(resolved)) return [resolved];
  return [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.mts`, `${resolved}.cts`, `${resolved}.js`, `${resolved}.mjs`, `${resolved}.cjs`];
}

function importedRepoPaths(testPath: RepoPath, source: string): RepoPath[] {
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
  const found: RepoPath[] = [];
  const fromDir = path.posix.dirname(testPath);
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith('.')) continue;
    const resolved = path.posix.normalize(path.posix.join(fromDir, specifier));
    for (const candidate of candidatePaths(resolved)) {
      if (isRepoPath(candidate)) found.push(candidate);
    }
  }
  return found;
}

function testsFor(targets: readonly RepoPath[], tests: readonly TestSource[]): RepoPath[] {
  const hits = new Set<RepoPath>();
  for (const test of tests) {
    if (!isRepoPath(test.path) || !isUnitTest(test.path)) continue;
    const imported = importedRepoPaths(test.path, test.source);
    for (const target of targets) {
      if (imported.includes(target)) hits.add(test.path);
    }
  }
  return [...hits].sort((left, right) => left.localeCompare(right));
}

function testCommand(tests: readonly RepoPath[]): string {
  if (tests.length === 0) return 'node --test';
  const quoted = tests.map((test) => `'${test}'`).join(' ');
  return `node --experimental-strip-types --disable-warning=ExperimentalWarning --import ./scripts/register-ts.mjs --test ${quoted}`;
}

function buildConfig(patterns: readonly string[], command: string, reportDir: string): StrykerRunConfig {
  return {
    testRunner: 'command',
    coverageAnalysis: 'off',
    commandRunner: { command },
    mutate: [...patterns],
    incremental: true,
    incrementalFile: `${reportDir}/stryker-incremental.json`,
    reporters: ['clear-text', 'json'],
    jsonReporter: { fileName: `${reportDir}/mutation.json` },
    thresholds: { high: 100, low: 100, break: null },
    timeoutMS: 10000,
    timeoutFactor: 2,
    concurrency: 2,
    disableTypeChecks: true,
    cleanTempDir: 'always',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(text: string): Parsed<unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'invalid json';
    return fail(`invalid json: ${message}`);
  }
}

function isMutantStatus(value: string): value is MutantStatus {
  switch (value) {
    case 'Killed':
    case 'Survived':
    case 'NoCoverage':
    case 'CompileError':
    case 'RuntimeError':
    case 'Timeout':
    case 'Ignored':
    case 'Pending':
      return true;
    default:
      return false;
  }
}

function repoPathFromReport(fileKey: string, reportRoot: string): Parsed<RepoPath> {
  let relative = fileKey.replaceAll('\\', '/');
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(fileKey)) {
    relative = path.relative(reportRoot, fileKey).replaceAll('\\', '/');
  }
  if (relative.startsWith('./')) relative = relative.slice(2);
  if (!isRepoPath(relative)) return fail(`mutant file path is outside the repo: ${fileKey}`);
  return { ok: true, value: relative };
}

function readPosition(value: unknown): Parsed<number> {
  if (!isRecord(value)) return fail('mutant location is missing a position');
  const line = value.line;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return fail('mutant line is invalid');
  return { ok: true, value: line };
}

function parseMutant(value: unknown, file: RepoPath): Parsed<Mutant> {
  if (!isRecord(value)) return fail('mutant entry is not an object');
  const id = value.id;
  const mutator = value.mutatorName;
  const status = value.status;
  const replacement = value.replacement ?? '';
  if (typeof id !== 'string' || id.length === 0) return fail('mutant id is invalid');
  if (typeof mutator !== 'string' || mutator.length === 0) return fail('mutant mutator is invalid');
  if (typeof status !== 'string' || !isMutantStatus(status)) return fail(`mutant status is invalid: ${String(status)}`);
  if (typeof replacement !== 'string') return fail('mutant replacement is invalid');
  if (!isRecord(value.location)) return fail('mutant location is invalid');
  const line = readPosition(value.location.start);
  if (!line.ok) return line;
  const end = readPosition(value.location.end);
  if (!end.ok) return end;
  return { ok: true, value: { id, file, mutator, replacement, status, line: line.value } };
}

function parseMutationReport(text: string, reportRoot: string): Parsed<Mutant[]> {
  const json = readJson(text);
  if (!json.ok) return json;
  if (!isRecord(json.value)) return fail('mutation report is not an object');
  if (typeof json.value.schemaVersion !== 'string' || !isRecord(json.value.thresholds) || !isRecord(json.value.files)) {
    return fail('mutation report is missing schemaVersion, thresholds, or files');
  }
  const mutants: Mutant[] = [];
  for (const [fileKey, fileResult] of Object.entries(json.value.files)) {
    const file = repoPathFromReport(fileKey, reportRoot);
    if (!file.ok) return file;
    if (!isRecord(fileResult) || !Array.isArray(fileResult.mutants)) return fail(`mutation report file is invalid: ${fileKey}`);
    for (const entry of fileResult.mutants) {
      const mutant = parseMutant(entry, file.value);
      if (!mutant.ok) return mutant;
      mutants.push(mutant.value);
    }
  }
  return { ok: true, value: mutants };
}

function emptyEquivalents(): Parsed<EquivalentMutant[]> {
  return { ok: true, value: [] };
}

function parseEquivalents(text: string): Parsed<EquivalentMutant[]> {
  const json = readJson(text);
  if (!json.ok) return json;
  if (!isRecord(json.value) || !Array.isArray(json.value.equivalents)) {
    return fail('equivalents file must be an object with an equivalents array');
  }
  const entries: EquivalentMutant[] = [];
  for (const entry of json.value.equivalents) {
    if (!isRecord(entry)) return fail('equivalent entry must be an object');
    const file = entry.file;
    const line = entry.line;
    const mutator = entry.mutator;
    const replacement = entry.replacement;
    if (typeof file !== 'string' || !isRepoPath(file)) return fail('equivalent file is invalid');
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return fail('equivalent line is invalid');
    if (typeof mutator !== 'string' || mutator.length === 0) return fail('equivalent mutator is invalid');
    if (typeof replacement !== 'string') return fail('equivalent replacement is invalid');
    entries.push({ file, line, mutator, replacement });
  }
  return { ok: true, value: entries };
}

function isListed(mutant: Mutant, equivalents: readonly EquivalentMutant[]): boolean {
  return equivalents.some(
    (entry) => entry.file === mutant.file && entry.line === mutant.line && entry.mutator === mutant.mutator && entry.replacement === mutant.replacement,
  );
}

function judgeMutants(mutants: readonly Mutant[], changed: ReadonlyMap<RepoPath, ReadonlySet<number>>, equivalents: readonly EquivalentMutant[]): SurvivorJudgment[] {
  const judgments: SurvivorJudgment[] = [];
  for (const mutant of mutants) {
    const lines = changed.get(mutant.file);
    if (!lines || !lines.has(mutant.line)) continue;
    switch (mutant.status) {
      case 'Killed':
      case 'Timeout':
      case 'Ignored':
        break;
      case 'Survived':
        judgments.push(isListed(mutant, equivalents) ? { kind: 'equivalent', mutant } : { kind: 'gap', mutant });
        break;
      case 'NoCoverage':
      case 'CompileError':
      case 'RuntimeError':
      case 'Pending':
        judgments.push({ kind: 'gap', mutant });
        break;
      default: {
        const exhaustive: never = mutant.status;
        throw new Error(`unhandled mutant status: ${String(exhaustive)}`);
      }
    }
  }
  judgments.sort((left, right) => compareMutants(left.mutant, right.mutant));
  return judgments;
}

function compareMutants(left: Mutant, right: Mutant): number {
  return left.file.localeCompare(right.file) || left.line - right.line || left.mutator.localeCompare(right.mutator) || left.replacement.localeCompare(right.replacement) || left.id.localeCompare(right.id);
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', "'");
}

function recordOf(judgment: SurvivorJudgment): SurvivorRecord {
  return {
    file: judgment.mutant.file,
    line: judgment.mutant.line,
    mutator: judgment.mutant.mutator,
    replacement: judgment.mutant.replacement,
    status: judgment.mutant.status,
    id: judgment.mutant.id,
  };
}

function renderSummary(state: SummaryState): string {
  const lines = ['## Mutation survivors', '', `Diff base: \`${cell(state.baseRef)}\`.`, ''];
  if (state.error) lines.push(state.error, '');
  if (state.diffKnown && state.patterns.length === 0) lines.push('No changed production lines to mutate.', '');
  if (state.patterns.length > 0) {
    lines.push(`Mutating ${state.patterns.length} changed line range(s).`, '');
    for (const pattern of state.patterns) lines.push(`- \`${cell(pattern)}\``);
    lines.push('');
  }
  if (state.harness.length > 0) {
    lines.push('CI harness files are not mutated:', '');
    for (const file of state.harness) lines.push(`- \`${cell(file)}\``);
    lines.push('');
  }
  if (state.outside.length > 0) {
    lines.push('Changed code outside this runner:', '');
    for (const file of state.outside) lines.push(`- \`${cell(file)}\``);
    lines.push('');
  }
  const gaps = state.judgments.filter((judgment) => judgment.kind === 'gap');
  const equivalents = state.judgments.filter((judgment) => judgment.kind === 'equivalent');
  if (state.judgments.length === 0) {
    lines.push('No survivors on changed lines.', '');
  } else {
    lines.push('| Judgment | File | Line | Mutator | Replacement | Status |', '| --- | --- | --- | --- | --- | --- |');
    for (const judgment of state.judgments) {
      const mutant = judgment.mutant;
      lines.push(`| ${judgment.kind} | \`${cell(mutant.file)}\` | ${mutant.line} | ${cell(mutant.mutator)} | \`${cell(mutant.replacement)}\` | ${mutant.status} |`);
    }
    lines.push('', `${gaps.length} non-equivalent survivor(s). ${equivalents.length} equivalent survivor(s).`, '');
  }
  return lines.join('\n');
}

function artifactFor(judgments: readonly SurvivorJudgment[], error: string | null): SurvivorArtifact {
  return {
    error,
    gaps: judgments.filter((judgment) => judgment.kind === 'gap').map(recordOf),
    equivalents: judgments.filter((judgment) => judgment.kind === 'equivalent').map(recordOf),
  };
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  return trimmed.split('\n').slice(-40).join('\n');
}

function changedLines(files: readonly ChangedFile[]): Map<RepoPath, ReadonlySet<number>> {
  const map = new Map<RepoPath, Set<number>>();
  for (const file of files) {
    const existing = map.get(file.path) ?? new Set<number>();
    for (const line of file.lines) existing.add(line);
    map.set(file.path, existing);
  }
  return map;
}

function finish(request: MutationRequest, deps: MutationDeps, exitCode: number, state: SummaryState): MutationRun {
  const summary = renderSummary(state);
  deps.writeText(`${request.reportDir}/mutation-survivors.json`, `${JSON.stringify(artifactFor(state.judgments, state.error), null, 2)}\n`);
  if (request.summaryPath) {
    const existing = deps.readText(request.summaryPath) ?? '';
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    deps.writeText(request.summaryPath, `${existing}${separator}${summary}\n`);
  }
  return { exitCode, summary };
}

function emptyState(baseRef: string, error: string | null, diffKnown: boolean): SummaryState {
  return { baseRef, diffKnown, patterns: [], harness: [], outside: [], judgments: [], error };
}

export function runMutation(request: MutationRequest, deps: MutationDeps): MutationRun {
  if (!isBaseRef(request.baseRef)) {
    return finish(request, deps, 1, emptyState(request.baseRef, `Invalid mutation base ref: ${request.baseRef}`, false));
  }
  const diff = deps.gitDiff(request.baseRef);
  if (diff.status !== 0) {
    const detail = tail(`${diff.stderr}\n${diff.stdout}`);
    const message = detail === '' ? `git diff exited ${String(diff.status)}` : `git diff exited ${String(diff.status)}\n${detail}`;
    return finish(request, deps, 1, emptyState(request.baseRef, message, false));
  }
  const parsed = parseChangedFiles(diff.stdout);
  if (!parsed.ok) return finish(request, deps, 1, emptyState(request.baseRef, parsed.message, false));
  const classified = classify(parsed.value);
  const patterns = mutatePatterns(classified.targets);
  const baseState = {
    baseRef: request.baseRef,
    diffKnown: true,
    patterns,
    harness: classified.harness,
    outside: classified.outside,
  };
  if (patterns.length === 0) {
    return finish(request, deps, 0, { ...baseState, judgments: [], error: null });
  }
  const equivalentsText = deps.readText(request.equivalentsPath);
  const equivalents = equivalentsText === null || equivalentsText.trim() === '' ? emptyEquivalents() : parseEquivalents(equivalentsText);
  if (!equivalents.ok) return finish(request, deps, 1, { ...baseState, judgments: [], error: equivalents.message });
  const tests = testsFor(classified.targets.map((file) => file.path), deps.testSources());
  const configPath = `${request.reportDir}/stryker.config.json`;
  deps.writeText(configPath, `${JSON.stringify(buildConfig(patterns, testCommand(tests), request.reportDir), null, 2)}\n`);
  const stryker = deps.stryker(configPath);
  const reportText = deps.readText(`${request.reportDir}/mutation.json`);
  if (reportText === null) {
    const detail = tail(`${stryker.stderr}\n${stryker.stdout}`);
    const message = stryker.status === 0 ? 'Stryker did not write a mutation report.' : `Stryker exited ${String(stryker.status)}.`;
    return finish(request, deps, 1, { ...baseState, judgments: [], error: detail === '' ? message : `${message}\n${detail}` });
  }
  const report = parseMutationReport(reportText, request.repoRoot);
  if (!report.ok) return finish(request, deps, 1, { ...baseState, judgments: [], error: report.message });
  const judgments = judgeMutants(report.value, changedLines(classified.targets), equivalents.value);
  const gaps = judgments.filter((judgment) => judgment.kind === 'gap');
  const strykerError = stryker.status === 0 ? null : `Stryker exited ${String(stryker.status)}.`;
  const exitCode = gaps.length > 0 || strykerError !== null ? 1 : 0;
  return finish(request, deps, exitCode, { ...baseState, judgments, error: strykerError });
}

function runProcess(command: string, args: readonly string[], cwd: string, timeout: number): ProcessResult {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
  const stderr = `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
  return { status: result.status, stdout: result.stdout ?? '', stderr };
}

function listUnitTests(root: string): TestSource[] {
  const found: TestSource[] = [];
  for (const dir of ['src', 'cdn', 'mcp', 'scripts']) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const parent = entry.parentPath;
      const absoluteFile = path.join(parent, entry.name);
      const relative = path.relative(root, absoluteFile).replaceAll('\\', '/');
      if (!isRepoPath(relative) || !isUnitTest(relative)) continue;
      found.push({ path: relative, source: fs.readFileSync(absoluteFile, 'utf8') });
    }
  }
  return found;
}

function realDeps(root: string): MutationDeps {
  const resolve = (file: string): string => (path.isAbsolute(file) ? file : path.resolve(root, file));
  return {
    gitDiff(baseRef: string): ProcessResult {
      return runProcess('git', ['diff', '-U0', '--no-color', '--diff-filter=ACMR', `${baseRef}...HEAD`], root, GIT_TIMEOUT_MS);
    },
    readText(file: string): string | null {
      try {
        return fs.readFileSync(resolve(file), 'utf8');
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    writeText(file: string, contents: string): void {
      const absolute = resolve(file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents);
    },
    testSources(): TestSource[] {
      return listUnitTests(root);
    },
    stryker(configPath: string): ProcessResult {
      const bin = path.join(root, 'node_modules/@stryker-mutator/core/bin/stryker.js');
      return runProcess(process.execPath, [bin, 'run', configPath], root, STRYKER_TIMEOUT_MS);
    },
  };
}

function main(): number {
  const request = {
    baseRef: mutationBase(process.env.MUTATION_BASE),
    reportDir: process.env.MUTATION_REPORT_DIR ?? 'reports',
    summaryPath: process.env.GITHUB_STEP_SUMMARY ?? null,
    equivalentsPath: process.env.MUTATION_EQUIVALENTS ?? 'scripts/ci/mutation-equivalents.json',
    repoRoot,
  };
  const result = runMutation(request, realDeps(repoRoot));
  process.stdout.write(`${result.summary}\n`);
  return result.exitCode;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  process.exit(main());
}
