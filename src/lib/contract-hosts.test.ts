// The game CDN's CSP (cdn/handler.mjs) is the source of truth for external hosts.
// The runtime contract and both creator prompts must list exactly those hosts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { CREATOR_PROMPTS } from './creator-prompts.ts';

const src = fs.readFileSync('cdn/handler.mjs', 'utf8');
const LIB = src.match(/const LIB_HOSTS = '([^']+)'/)![1];
const directive = (name: string) => {
  const line = src.match(new RegExp('`' + name + ' ([^`]+)`'))![1].replaceAll('${LIB_HOSTS}', LIB);
  return new Set(line.split(/\s+/).filter((t) => t.startsWith('https://')).map((t) => t.slice('https://'.length)));
};
const script = directive('script-src'), style = directive('style-src'), font = directive('font-src');
const minus = (a: Set<string>, b: Set<string>) => [...a].filter((h) => !b.has(h)).sort();
const HOST = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:net|com|sh|io)\b/g;

// "...: <lib hosts>; plus fonts.googleapis.com (stylesheets only) and fonts.gstatic.com (font files only)"
function parseAllowlist(text: string, where: string) {
  const m = text.match(/((?:[a-z0-9.-]+\.(?:net|com|sh|io), )*[a-z0-9.-]+\.(?:net|com|sh|io)); plus ([a-z0-9.-]+) \(stylesheets only\) and ([a-z0-9.-]+) \(font files only\)/);
  assert.ok(m, `${where}: host allowlist sentence not found`);
  return { lib: m[1].match(HOST)!.sort(), styleOnly: m[2], fontOnly: m[3] };
}

test('CSP sanity: scripts get no font hosts', () => {
  assert.deepEqual(minus(script, style), []);
  assert.equal(minus(style, script).length, 1);
  assert.equal(minus(font, script).length, 1);
});

const docs: [string, string][] = [
  ['docs/RUNTIME-CONTRACT.md contract item 1', fs.readFileSync('docs/RUNTIME-CONTRACT.md', 'utf8').split('## Creator prompts')[0]],
  ...CREATOR_PROMPTS.map((p): [string, string] => [`Prompt ${p.id.toUpperCase()}`, p.text]),
];
for (const [where, text] of docs) {
  test(`${where} lists exactly the CSP hosts`, () => {
    const { lib, styleOnly, fontOnly } = parseAllowlist(text, where);
    assert.deepEqual(lib, [...script].sort(), 'script/style/font hosts = script-src');
    assert.deepEqual([styleOnly], minus(style, script), 'stylesheet-only host = style-src extra');
    assert.deepEqual([fontOnly], minus(font, script), 'font-file-only host = font-src extra');
    const mentioned = new Set(text.match(HOST)!.filter((h) => !h.endsWith('vercel.app')));
    assert.deepEqual([...mentioned].sort(), [...new Set([...script, ...style, ...font])].sort(), 'no other hosts mentioned');
  });
}
