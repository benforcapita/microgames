#!/usr/bin/env node
/**
 * Generates this fixture's assets with the temple-run generator — the same pixel maps and
 * oscillators, run with `--out` pointed at this folder, so both fixtures share one source
 * of truth and produce identical bytes.
 *
 *   node e2e/fixtures/temple-run-multi/tools/make-assets.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = join(ROOT, '..', 'temple-run', 'tools', 'make-assets.mjs');
const result = spawnSync(process.execPath, [GENERATOR, '--out', ROOT], { stdio: 'inherit' });
process.exit(result.status ?? 1);
