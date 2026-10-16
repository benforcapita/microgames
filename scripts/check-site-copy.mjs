// NM-1: strict site-copy guard. Fails (exit 1) on ANY money/payment term in user-rendered files:
//   src/pages (incl. API error messages), src/components, src/layouts, the browser-side src/lib/*.ts
//   (creator prompts etc.), the CDN shell (cdn/), public/, and with --dist the built output
//   (server render templates + string literals of every page chunk, and dist/client assets).
// Comments are not user-rendered and are skipped. Backend code (src/lib/server, supabase/, scripts/) is out of scope
// by design: payment/revenue logic stays there unchanged.
// Usage: npm run check:copy [-- --dist]
import fs from 'node:fs';
import path from 'node:path';
import { SITE_MONEY_TERM } from '../src/lib/money-claims.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const rel = (p) => path.relative(ROOT, p);
const walk = (dir, exts) => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && exts.some((e) => d.name.endsWith(e)))
  .map((d) => path.join(d.parentPath ?? d.path, d.name));

/** Blank out comments (keeping line numbers): HTML comments, block comments, and // line comments not inside a URL. */
export function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
}

export function scanText(text, file) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(SITE_MONEY_TERM)) hits.push({ file, line: i + 1, term: m[0], text: line.trim().slice(0, 160) });
  });
  return hits;
}

export const SOURCE_FILES = () => [
  ...walk(path.join(ROOT, 'src/pages'), ['.astro', '.ts']),
  ...walk(path.join(ROOT, 'src/components'), ['.astro', '.ts']),
  ...walk(path.join(ROOT, 'src/layouts'), ['.astro']),
  ...fs.readdirSync(path.join(ROOT, 'src/lib')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'money-claims.ts').map((f) => path.join(ROOT, 'src/lib', f)),
  ...walk(path.join(ROOT, 'cdn'), ['.mjs', '.js', '.html']).filter((f) => !/\.test\./.test(f)),
  ...walk(path.join(ROOT, 'public'), ['.md', '.txt', '.html', '.svg', '.json', '.xml']),
].filter((f) => !/\.test\.ts$/.test(f));

export function scanSources() {
  return SOURCE_FILES().flatMap((f) => scanText(stripComments(fs.readFileSync(f, 'utf8')), rel(f)));
}

/** Built output: page chunks (any chunk with a render template) and client assets. */
export function scanDist(dir = path.join(ROOT, 'dist')) {
  if (!fs.existsSync(dir)) throw new Error(`${rel(dir)} not found; run npm run build first`);
  const hits = [];
  for (const f of walk(path.join(dir, 'server'), ['.mjs'])) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('renderTemplate`')) continue; // not a page/component chunk
    hits.push(...scanText(stripComments(src), rel(f)));
  }
  for (const f of walk(path.join(dir, 'client'), ['.js', '.css', '.html', '.md', '.txt', '.svg'])) hits.push(...scanText(stripComments(fs.readFileSync(f, 'utf8')), rel(f)));
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const hits = [...scanSources(), ...(process.argv.includes('--dist') ? scanDist() : [])];
  for (const h of hits) console.error(`${h.file}:${h.line}  [${h.term}]  ${h.text}`);
  console.log(hits.length ? `site copy: ${hits.length} money/payment term(s) found (NM-1 strict mode)` : `site copy: clean (${SOURCE_FILES().length} source files${process.argv.includes('--dist') ? ' + dist' : ''})`);
  process.exit(hits.length ? 1 : 0);
}
