#!/usr/bin/env node
/**
 * Builds the uploadable single-file game: src/game.html + assets/** -> index.html.
 *
 *   node e2e/fixtures/temple-run/tools/build.mjs          # write index.html
 *   node e2e/fixtures/temple-run/tools/build.mjs --check  # fail if index.html is stale
 *
 * Meshground serves a game as one self-contained document from a cookieless origin whose
 * CSP allows data:, blob: and the library CDNs — never the game's own origin — so separate
 * asset files cannot be fetched by a document at /g/<id>/index.html. Every sprite and sound
 * is therefore inlined here as a data: URL. Deterministic: same inputs, same bytes.
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
  const mime = MIME[ext];
  if (!mime) throw new Error(`${rel}: unexpected asset type (want ${Object.keys(MIME).join(', ')})`);
  const bytes = readFileSync(file);
  if (bytes.length > ASSET_MAX_BYTES) throw new Error(`${rel}: ${bytes.length} bytes is over the 100 KB asset limit`);
  entries.push([rel, `data:${mime};base64,${bytes.toString('base64')}`]);
}
if (!entries.length) throw new Error('no assets found; run tools/make-assets.mjs first');

const source = readFileSync(join(ROOT, 'src', 'game.html'), 'utf8');
if (!source.includes(MARKER)) throw new Error(`src/game.html is missing the ${MARKER} placeholder`);

const table = `{\n${entries.map(([path, url]) => `    ${JSON.stringify(path)}: ${JSON.stringify(url)},`).join('\n')}\n  }`;
const html = source.replace(MARKER, table);
const bytes = Buffer.from(html, 'utf8');
if (bytes.length > GAME_MAX_BYTES) throw new Error(`index.html is ${bytes.length} bytes, over the 4 MB game limit`);

const check = process.argv.includes('--check');
if (check) {
  const current = readFileSync(OUT);
  if (!current.equals(bytes)) {
    console.error('index.html is stale: run node e2e/fixtures/temple-run/tools/build.mjs');
    process.exit(1);
  }
  console.log(`index.html up to date (${bytes.length} bytes, ${entries.length} inlined assets)`);
} else {
  writeFileSync(OUT, bytes);
  console.log(`index.html written: ${bytes.length} bytes, ${entries.length} inlined assets`);
}
