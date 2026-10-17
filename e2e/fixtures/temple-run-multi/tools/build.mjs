#!/usr/bin/env node
/**
 * Builds the uploadable game document: src/game.html + the asset list -> index.html.
 *
 *   node e2e/fixtures/temple-run-multi/tools/build.mjs          # write index.html
 *   node e2e/fixtures/temple-run-multi/tools/build.mjs --check  # fail if index.html is stale
 *
 * Unlike e2e/fixtures/temple-run, nothing is inlined: ASSETS[path] below maps each path to
 * itself, so the game fetches every sprite and sound as a separate file, relative to the
 * document's versioned URL on the game CDN (/g/<id>/<version>/<path>). The same relative
 * path is what the creator types into the game's Files page when uploading each file.
 * Deterministic: same inputs, same bytes.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = join(ROOT, 'assets');
const OUT = join(ROOT, 'index.html');
const MARKER = '/*__MG_ASSETS__*/{}';
const ASSET_MAX_BYTES = 100 * 1024;
const GAME_MAX_BYTES = 4 * 1024 * 1024;

const MIME = { '.png': 'image/png', '.wav': 'audio/wav' };

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(ASSET_DIR);
const entries = [];
for (const file of files) {
  const rel = relative(ASSET_DIR, file).split(sep).join(posix.sep);
  const ext = rel.slice(rel.lastIndexOf('.'));
  if (!MIME[ext]) throw new Error(`${rel}: unexpected asset type (want ${Object.keys(MIME).join(', ')})`);
  if (statSync(file).size > ASSET_MAX_BYTES) throw new Error(`${rel}: ${statSync(file).size} bytes is over the 100 KB asset limit`);
  entries.push(rel);
}
if (!entries.length) throw new Error('no assets found; run tools/make-assets.mjs first');

const source = readFileSync(join(ROOT, 'src', 'game.html'), 'utf8');
if (!source.includes(MARKER)) throw new Error(`src/game.html is missing the ${MARKER} placeholder`);

const table = `{\n${entries.map((path) => `    ${JSON.stringify(path)}: ${JSON.stringify(path)},`).join('\n')}\n  }`;
const html = source.replace(MARKER, table);
const bytes = Buffer.from(html, 'utf8');
if (bytes.length > GAME_MAX_BYTES) throw new Error(`index.html is ${bytes.length} bytes, over the 4 MB game limit`);

const check = process.argv.includes('--check');
if (check) {
  const current = readFileSync(OUT);
  if (!current.equals(bytes)) {
    console.error('index.html is stale: run node e2e/fixtures/temple-run-multi/tools/build.mjs');
    process.exit(1);
  }
  console.log(`index.html up to date (${bytes.length} bytes, ${entries.length} separate assets)`);
} else {
  writeFileSync(OUT, bytes);
  console.log(`index.html written: ${bytes.length} bytes, ${entries.length} separate assets`);
}
