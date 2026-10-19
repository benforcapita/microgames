#!/usr/bin/env node
// Asserts that no database test suites were skipped in a node:test TAP file.
// Fails closed on missing/empty TAP, missing summary, or unallowed skips.
import fs from 'node:fs';

const ALLOWLIST = [
  {
    reasonPrefix: 'CI=true: strict absolute timing',
    max: 2,
    why: 'CI-T2: strict absolute timing vs AST_BUDGET is not meaningful on shared CI runners',
  },
  {
    reasonPrefix: 'no Playwright Chromium available',
    max: 1,
    why: 'Non-DB browser test: skipped when Playwright Chromium is not installed (MG-7 installs Chromium)',
  },
];

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

if (!content.trim()) {
  console.error('Error: TAP file is empty');
  process.exit(1);
}

const testMatches = [...content.matchAll(/^# tests (\d+)$/gm)];
const totalTests = testMatches.reduce((sum, m) => sum + Number(m[1]), 0);
if (testMatches.length === 0 || totalTests <= 0) {
  console.error('Error: No "# tests N" summary line with N > 0 found in TAP output');
  process.exit(1);
}

const allowedCounts = new Map(ALLOWLIST.map((e) => [e, 0]));
const offending = [];

for (const rawLine of content.split('\n')) {
  const line = rawLine.trim();
  if (!/# SKIP\b/.test(line)) continue;
  const m = line.match(/^(?:(?:not )?ok(?:\s+\d+)?\s*-\s*)?(.*?)\s*# SKIP\b\s*(.*)$/);
  const name = m && m[1] ? m[1].trim() : '(unnamed)';
  const reason = m && m[2] ? m[2].trim() : '';

  const entry = ALLOWLIST.find((e) => reason.startsWith(e.reasonPrefix));
  if (entry && allowedCounts.get(entry) < entry.max) {
    allowedCounts.set(entry, allowedCounts.get(entry) + 1);
  } else {
    offending.push({ name, reason });
  }
}

if (offending.length > 0) {
  for (const { name, reason } of offending) {
    console.error(`${name}: ${reason}`);
  }
  process.exit(1);
}

const summary = ALLOWLIST.map((e) => `${e.reasonPrefix}: ${allowedCounts.get(e)}/${e.max}`).join(', ');
console.log(`OK: ${totalTests} tests; allowed skips: ${summary}`);
