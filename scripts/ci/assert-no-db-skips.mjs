#!/usr/bin/env node
// Asserts that no database test suites were skipped in a node:test TAP file.
// Fails closed on missing/empty TAP, missing summary, or unallowed skips.
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
    name: 'AS-5 game loads its own assets under the enforced CSP (Chromium)',
    max: 1,
    why: 'non-DB browser suite, no Chromium on the runner; Engineering Lead approved keeping it until #98 lands',
  },
];

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

    const entry = allowlist.find((e) => e.name === name);
    if (entry && (allowed.get(entry.name) ?? 0) < entry.max) {
      allowed.set(entry.name, (allowed.get(entry.name) ?? 0) + 1);
    } else {
      errors.push(`${name}: ${reason}`);
    }
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
    console.error('Error: TAP file path is required');
    process.exit(1);
  }

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Error: Cannot read TAP file: ${err.message}`);
    process.exit(1);
  }

  const result = checkTap(content, ALLOWLIST);
  if (!result.ok) {
    for (const err of result.errors) {
      console.error(err);
    }
    process.exit(1);
  }

  const summary = ALLOWLIST.map((e) => `${e.name}: ${result.allowed.get(e.name) ?? 0}/${e.max}`).join(', ');
  console.log(`OK: ${result.totalTests} tests; allowed skips: ${summary}`);
}
