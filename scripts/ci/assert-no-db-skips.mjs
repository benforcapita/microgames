#!/usr/bin/env node
// Asserts that no database test suites were skipped in a node:test TAP or Playwright JSON file.
// Fails closed on missing/empty output, missing summary, or unallowed skips.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ALLOWLIST = [
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
    name: 'a swipe in the game then a tap on the × leaves fullscreen',
    max: 1,
    why: 'the default e2e project has no touch; playwright.fullscreen.config.mjs runs it',
  },
];

export const TODO_ALLOWLIST = [
  {
    name: 'the share-link caps return 429 for an eleventh create in an hour and a sixty-first open in a minute',
    prs: ['#114'],
  },
];

function todoBound(name, description, todos) {
  const entry = todos.find((item) => item.name === name);
  return !!entry && entry.prs.every((pr) => description.includes(pr));
}

function applySkip(name, reason, allowlist, allowed, errors) {
  const entry = allowlist.find((e) => e.name === name);
  if (entry && (allowed.get(entry.name) ?? 0) < entry.max) {
    allowed.set(entry.name, (allowed.get(entry.name) ?? 0) + 1);
  } else {
    errors.push(reason ? `${name}: ${reason}` : `${name}: skipped`);
  }
}

/**
 * Parses TAP content and asserts that no disallowed skips occurred and tests ran.
 * @param {string} content
 * @param {typeof ALLOWLIST} [allowlist]
 */
export function checkTap(content, allowlist = ALLOWLIST) {
  const allowed = new Map(allowlist.map((e) => [e.name, 0]));
  const errors = [];

  if (typeof content !== 'string' || !content.trim()) {
    return {
      ok: false,
      totalTests: 0,
      errors: ['Error: TAP file is empty'],
      allowed,
    };
  }

  const testMatches = [...content.matchAll(/^# tests (\d+)\r?$/gm)];
  const totalTests = testMatches.reduce((sum, m) => sum + Number(m[1]), 0);
  if (testMatches.length === 0 || totalTests <= 0) {
    errors.push('Error: No "# tests N" summary line with N > 0 found in TAP output');
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trimStart();
    if (!/^(not )?ok \d+ - /.test(line)) continue;

    const m = line.match(/^(?:not )?ok \d+ - (.*?)(?<!\\)#\s*SKIP\b\s*(.*)$/i);
    if (!m) continue;

    const name = m[1].replace(/\\([#\\])/g, '$1').trim() || '(unnamed)';
    const reason = m[2].trim();

    applySkip(name, reason, allowlist, allowed, errors);
  }

  return {
    ok: errors.length === 0,
    totalTests,
    errors,
    allowed,
  };
}

/**
 * Parses Playwright JSON test report and asserts that no disallowed skips or unexpected failures occurred and tests ran.
 * @param {string | object} content
 * @param {typeof ALLOWLIST} [allowlist]
 * @param {typeof TODO_ALLOWLIST} [todos]
 */
export function checkPlaywrightJson(content, allowlist = ALLOWLIST, todos = TODO_ALLOWLIST) {
  const allowed = new Map(allowlist.map((e) => [e.name, 0]));
  const errors = [];

  if (typeof content !== 'string' && (typeof content !== 'object' || content === null)) {
    return {
      ok: false,
      totalTests: 0,
      errors: ['Error: JSON report is empty'],
      allowed,
    };
  }

  let report;
  if (typeof content === 'string') {
    if (!content.trim()) {
      return {
        ok: false,
        totalTests: 0,
        errors: ['Error: JSON report is empty'],
        allowed,
      };
    }
    try {
      report = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        totalTests: 0,
        errors: [`Error: Failed to parse JSON report: ${err.message}`],
        allowed,
      };
    }
  } else {
    report = content;
  }

  if (!report || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.suites)) {
    return {
      ok: false,
      totalTests: 0,
      errors: ['Error: Invalid JSON report: missing "suites" array'],
      allowed,
    };
  }

  let totalTests = 0;

  function walkSuite(suite) {
    if (!suite || typeof suite !== 'object') return;
    if (Array.isArray(suite.suites)) {
      for (const childSuite of suite.suites) {
        walkSuite(childSuite);
      }
    }
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (!spec || typeof spec !== 'object') continue;
        const name = spec.title?.trim() || '(unnamed)';
        if (Array.isArray(spec.tests)) {
          for (const test of spec.tests) {
            if (!test || typeof test !== 'object') continue;
            totalTests++;
            const lastResult = Array.isArray(test.results) && test.results.length > 0
              ? test.results[test.results.length - 1]
              : undefined;
            const isSkipped = test.status === 'skipped' || lastResult?.status === 'skipped';
            if (test.status === 'unexpected') {
              errors.push(`${name}: unexpected`);
            }
            if (test.status === 'flaky') {
              errors.push(`${name}: flaky`);
            }
            if (isSkipped) {
              const annotations = Array.isArray(test.annotations) ? test.annotations : [];
              const todo = annotations.find((a) => a?.type === 'todo' && typeof a.description === 'string' && a.description.trim().length > 0);
              if (todo) {
                if (!todoBound(name, todo.description, todos)) {
                  errors.push(`${name}: todo is not bound to its pull request`);
                }
              } else {
                const skipAnnotation = annotations.find((a) => a?.type === 'skip' || a?.type === 'fixme');
                const reason = skipAnnotation?.description?.trim() || 'skipped';
                applySkip(name, reason, allowlist, allowed, errors);
              }
            }
          }
        }
      }
    }
  }

  for (const suite of report.suites) {
    walkSuite(suite);
  }
  if (Array.isArray(report.specs)) {
    walkSuite({ specs: report.specs });
  }

  if (totalTests <= 0) {
    errors.push('Error: No tests found in JSON report');
  }

  return {
    ok: errors.length === 0,
    totalTests,
    errors,
    allowed,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('Error: test output file (TAP or JSON report) path is required');
    process.exit(1);
  }

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Error: Cannot read test output file (TAP or JSON report): ${err.message}`);
    process.exit(1);
  }

  const trimmed = content.trimStart();
  const isJson = trimmed.startsWith('{') || file.endsWith('.json');
  const result = isJson
    ? checkPlaywrightJson(content, ALLOWLIST)
    : checkTap(content, ALLOWLIST);

  if (!result.ok) {
    for (const err of result.errors) {
      console.error(err);
    }
    process.exit(1);
  }

  const summary = ALLOWLIST.map((e) => `${e.name}: ${result.allowed.get(e.name) ?? 0}/${e.max}`).join(', ');
  console.log(`OK: ${result.totalTests} tests; allowed skips: ${summary}`);
}
