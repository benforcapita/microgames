/**
 * Static analyzer for uploaded single-file games (Features v2, SP-4).
 *
 * Pure and runtime-neutral: no fs/path/Buffer/process, so it runs under Node (unit tests, Astro server)
 * and Deno (Supabase Edge Functions). Only standard globals (TextEncoder/TextDecoder/URL/JSON) plus acorn.
 *
 * Every scan is linear in the input size: the HTML is read by a single-pass tokenizer (no backtracking
 * regexes over the document), JS is parsed with acorn and walked once, CSS is scanned with indexOf loops.
 * The host allowlists come from the CDN CSP config (cdn/csp.mjs), the single source of truth.
 */
import { parse, type Node as AcornNode } from 'acorn';
import { CSP_SOURCES } from '../../../cdn/csp.mjs';

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface StaticCheck {
  id: string;
  label: string;
  level: CheckLevel;
  message: string;
  findings?: string[];
}

export interface StaticReport {
  status: CheckLevel;
  bytes: number;
  checks: StaticCheck[];
}

const hostsOf = (sources: readonly string[]) => sources.map((s) => new URL(s).hostname.toLowerCase());
/** Hosts allowed for <script src>, ES imports and import maps (CSP script-src). */
export const SCRIPT_HOSTS: readonly string[] = hostsOf(CSP_SOURCES.script);
/** Hosts allowed for stylesheets and fonts (CSP style-src + font-src). */
export const STYLE_HOSTS: readonly string[] = [...new Set([...hostsOf(CSP_SOURCES.style), ...hostsOf(CSP_SOURCES.font)])];
/** Hosts allowed for fetch/XHR/WebSocket/EventSource/beacon (CSP connect-src). */
export const CONNECT_HOSTS: readonly string[] = hostsOf(CSP_SOURCES.connect);
/** Hosts allowed for images/media (CSP img-src + media-src). */
export const MEDIA_HOSTS: readonly string[] = [...new Set([...hostsOf(CSP_SOURCES.img), ...hostsOf(CSP_SOURCES.media)])];

export const STATIC_LIMITS = { maxBytes: 5 * 1024 * 1024, warnBytes: 1024 * 1024 };
const MAX_FINDINGS = 10;
/** Upper bound on per-handler parses when the combined handler parse fails (keeps the worst case linear). */
const MAX_HANDLER_PARSES = 200;

/* ------------------------------------------------------------------ URLs */

const isRemote = (u: string) => /^(?:https?:|wss?:)?\/\//i.test(u);
const isInline = (u: string) => /^(?:data:|blob:|#|javascript:|about:)/i.test(u);

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url);
    return ['https:', 'http:', 'ws:', 'wss:'].includes(u.protocol) ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** allowed = https/wss on the allowlist; local = relative file (not self-contained); blocked = anything else remote. */
function classify(raw: string, hosts: readonly string[]): 'allowed' | 'local' | 'blocked' | 'inline' {
  const u = raw.trim();
  if (!u || isInline(u)) return 'inline';
  if (!isRemote(u)) return 'local';
  const host = hostOf(u);
  if (!host) return 'blocked';
  const secure = /^(?:https:|wss:)?\/\//i.test(u);
  return secure && hosts.includes(host) ? 'allowed' : 'blocked';
}

/* ------------------------------------------------------------------ HTML tokenizer (single pass) */

interface Tag {
  name: string;
  attrs: Map<string, string>;
}
interface Script {
  attrs: Map<string, string>;
  text: string;
}
interface Doc {
  tags: Tag[];
  scripts: Script[];
  styles: string[];
  handlers: string[];
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isNameChar = (c: number) =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58;

/**
 * Tokenizes HTML in one forward pass. HTML comments are skipped only in markup context; script/style
 * bodies are raw text (so `<!--` inside a JS string can't hide code). An unterminated tag or comment ends
 * the scan at EOF. Every index only moves forward, so the cost is O(n).
 */
function tokenize(html: string): Doc {
  const lower = html.toLowerCase();
  const n = html.length;
  const doc: Doc = { tags: [], scripts: [], styles: [], handlers: [] };
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const c = html.charCodeAt(lt + 1);
    if (c === 33 || c === 63 || c === 47) {
      // <!doctype ...>, <?...>, </closing>: skip to '>'
      const gt = html.indexOf('>', lt + 2);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && isNameChar(html.charCodeAt(j))) j++;
    if (j === lt + 1) {
      i = lt + 1;
      continue;
    }
    const name = lower.slice(lt + 1, j);
    // Attributes: linear scan honouring quotes.
    const attrs = new Map<string, string>();
    let closed = false;
    while (j < n) {
      while (j < n && (isSpace(html.charCodeAt(j)) || html.charCodeAt(j) === 47)) j++;
      if (j >= n) break;
      if (html.charCodeAt(j) === 62) {
        closed = true;
        j++;
        break;
      }
      const a0 = j;
      while (j < n && !isSpace(html.charCodeAt(j)) && html[j] !== '=' && html[j] !== '>' && html[j] !== '/') j++;
      const an = lower.slice(a0, j);
      if (j === a0) {
        j++;
        continue;
      }
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && isSpace(html.charCodeAt(j))) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          if (e < 0) {
            j = n;
            break;
          }
          value = html.slice(j + 1, e);
          j = e + 1;
        } else {
          const v0 = j;
          while (j < n && !isSpace(html.charCodeAt(j)) && html[j] !== '>') j++;
          value = html.slice(v0, j);
        }
      }
      if (!attrs.has(an)) attrs.set(an, value);
      if (an.startsWith('on') && value) doc.handlers.push(value);
    }
    if (!closed) break; // unterminated tag at EOF
    doc.tags.push({ name, attrs });
    if (name === 'script' || name === 'style') {
      const close = lower.indexOf(`</${name}`, j);
      const end = close < 0 ? n : close;
      const text = html.slice(j, end);
      if (name === 'script') doc.scripts.push({ attrs, text });
      else doc.styles.push(text);
      if (close < 0) break;
      const gt = html.indexOf('>', close);
      i = gt < 0 ? n : gt + 1;
    } else i = j;
  }
  return doc;
}

/* ------------------------------------------------------------------ CSS (indexOf scans) */

function cssUrls(css: string): string[] {
  const out: string[] = [];
  const lower = css.toLowerCase();
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim();
  for (let i = lower.indexOf('url('); i >= 0; i = lower.indexOf('url(', i + 4)) {
    const e = css.indexOf(')', i + 4);
    if (e < 0) break;
    out.push(unquote(css.slice(i + 4, e)));
  }
  for (let i = lower.indexOf('@import'); i >= 0; i = lower.indexOf('@import', i + 7)) {
    let j = i + 7;
    while (j < css.length && isSpace(css.charCodeAt(j))) j++;
    const q = css[j];
    if (q === '"' || q === "'") {
      const e = css.indexOf(q, j + 1);
      if (e < 0) break;
      out.push(css.slice(j + 1, e));
    }
  }
  return out.filter(Boolean);
}

/* ------------------------------------------------------------------ JS (acorn + one walk) */

interface JsFacts {
  imports: string[];
  network: string[];
  evals: string[];
  popups: string[];
  topNav: string[];
  dialogs: string[];
  hooks: Set<string>;
}

type N = AcornNode & Record<string, any>;

const literal = (node: N | undefined): string | null => {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  // Templates and `'https://host/' + x` concatenations: the leading literal part is enough to know the host.
  if (node.type === 'TemplateLiteral') return node.quasis[0].value.cooked ?? null;
  if (node.type === 'BinaryExpression' && node.operator === '+') return literal(node.left);
  return null;
};
/** `a.b.c` -> 'a.b.c' for short identifier/member chains (max 6 links), else null. Iterative and bounded,
 * so a pathological `x.a.a.a…` chain can't make the walk quadratic or overflow the stack. */
const MAX_PATH = 6;
const path = (start: N | undefined): string | null => {
  const parts: string[] = [];
  let node = start;
  while (node && parts.length <= MAX_PATH) {
    if (node.type === 'ChainExpression') node = node.expression;
    else if (node.type === 'MemberExpression' && !node.computed) {
      parts.push(node.property.name);
      node = node.object;
    } else if (node.type === 'Identifier') return [node.name, ...parts.reverse()].join('.');
    else if (node.type === 'ThisExpression') return ['this', ...parts.reverse()].join('.');
    else return null;
  }
  return null;
};
const stripWindow = (p: string | null) => (p ?? '').replace(/^(?:window|globalThis|self)\./, '');

function parseJs(code: string, module: boolean, retryAsModule = true): { ast: N | null; error: string | null } {
  const opts = { ecmaVersion: 'latest' as const, allowHashBang: true, allowAwaitOutsideFunction: true };
  try {
    return { ast: parse(code, { ...opts, sourceType: module ? 'module' : 'script' }) as N, error: null };
  } catch (e) {
    if (!module && retryAsModule) {
      // Classic scripts sometimes use top-level await or import syntax by mistake; module parse is stricter otherwise.
      try {
        return { ast: parse(code, { ...opts, sourceType: 'module' }) as N, error: null };
      } catch {}
    }
    return { ast: null, error: (e as Error).message };
  }
}

function walk(root: N, facts: JsFacts) {
  const stack: N[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration': {
        const s = literal(node.source);
        if (s !== null) facts.imports.push(s);
        break;
      }
      case 'ImportExpression': {
        const s = literal(node.source);
        if (s !== null) facts.imports.push(s);
        break;
      }
      case 'CallExpression':
      case 'NewExpression': {
        const callee = stripWindow(path(node.callee));
        const arg0 = literal(node.arguments[0]);
        if (callee === 'fetch' || callee === 'navigator.sendBeacon' || callee === 'importScripts') {
          if (arg0 !== null) facts.network.push(arg0);
        } else if (node.type === 'NewExpression' && (callee === 'WebSocket' || callee === 'EventSource' || callee === 'Worker' || callee === 'SharedWorker')) {
          if (arg0 !== null) facts.network.push(arg0);
        } else if (callee.endsWith('.open') && node.arguments.length >= 2 && callee !== 'open' && !/^(?:window|document)\.open$/.test(path(node.callee) ?? '')) {
          const url = literal(node.arguments[1]); // xhr.open(method, url)
          if (url !== null) facts.network.push(url);
        }
        if (callee === 'eval' || callee === 'Function' || callee === 'setTimeout' || callee === 'setInterval') {
          const isStringTimer = (callee === 'setTimeout' || callee === 'setInterval') && literal(node.arguments[0]) !== null;
          if (callee === 'eval' || callee === 'Function' || isStringTimer) facts.evals.push(isStringTimer ? `${callee}("…")` : node.type === 'NewExpression' ? 'new Function()' : `${callee}()`);
        }
        if (stripWindow(path(node.callee)) === 'open') facts.popups.push('window.open()');
        if (['alert', 'confirm', 'prompt'].includes(callee)) facts.dialogs.push(`${callee}()`);
        break;
      }
      case 'MemberExpression': {
        const p = path(node);
        if (p) {
          const bare = stripWindow(p);
          if (/^(?:top|parent)\.(?:location|document|window|postMessage)/.test(bare) || bare === 'top' || bare.startsWith('frameElement')) facts.topNav.push(p);
          const m = /(?:^|\.)Meshgrounds\.(ready|onPause|onResume)\b/.exec(p);
          if (m) facts.hooks.add(m[1]);
        }
        break;
      }
      case 'Identifier':
        if (node.name === 'frameElement') facts.topNav.push('frameElement');
        break;
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (let k = v.length - 1; k >= 0; k--) if (v[k] && typeof v[k].type === 'string') stack.push(v[k]);
      } else if (v && typeof v === 'object' && typeof v.type === 'string') stack.push(v);
    }
  }
}

/* ------------------------------------------------------------------ analyzer */

function decode(input: string | Uint8Array): { text: string | null; bytes: number } {
  if (typeof input === 'string') return { text: input, bytes: new TextEncoder().encode(input).length };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(input), bytes: input.byteLength };
  } catch {
    return { text: null, bytes: input.byteLength };
  }
}

export function analyzeGame(input: string | Uint8Array): StaticReport {
  const { text, bytes } = decode(input);
  const checks: StaticCheck[] = [];
  const uniq = (xs: string[]) => [...new Set(xs)].slice(0, MAX_FINDINGS);
  const add = (id: string, label: string, level: CheckLevel, message: string, findings: string[] = []) =>
    checks.push({ id, label, level, message, ...(findings.length ? { findings: uniq(findings) } : {}) });

  // Hard fails (spec §3): size, UTF-8, markup, script/style hosts.
  const mb = (x: number) => `${(x / 1024 / 1024).toFixed(2)} MB`;
  if (bytes > STATIC_LIMITS.maxBytes) {
    add('size', 'File size', 'fail', `${mb(bytes)} is over the 5 MB limit.`);
    return finish(checks, bytes); // don't spend time analysing a file we must reject anyway
  }
  if (bytes > STATIC_LIMITS.warnBytes) add('size', 'File size', 'warn', `${mb(bytes)}. Aim for under 1 MB so it loads instantly.`);
  else add('size', 'File size', 'pass', `${(bytes / 1024).toFixed(1)} KB.`);

  if (text === null) {
    add('utf8', 'UTF-8 text', 'fail', 'The file is not valid UTF-8 text.');
    return finish(checks, bytes);
  }
  add('utf8', 'UTF-8 text', 'pass', 'Valid UTF-8.');

  const doc = tokenize(text);
  const hasCanvasTag = doc.tags.some((t) => t.name === 'canvas');
  if (!doc.scripts.length && !hasCanvasTag) add('game-markup', 'Looks like a game', 'fail', 'No <script> or <canvas> found.');
  else add('game-markup', 'Looks like a game', 'pass', [doc.scripts.length && '<script>', hasCanvasTag && '<canvas>'].filter(Boolean).join(' + ') + ' found.');

  // JS: parse every inline script (and event-handler attributes) once.
  const facts: JsFacts = { imports: [], network: [], evals: [], popups: [], topNav: [], dialogs: [], hooks: new Set() };
  const syntaxErrors: string[] = [];
  const importMapUrls: string[] = [];
  const scriptSrcs: string[] = [];
  doc.scripts.forEach((s, idx) => {
    const type = (s.attrs.get('type') ?? '').trim().toLowerCase();
    const src = s.attrs.get('src');
    if (src !== undefined) {
      scriptSrcs.push(src);
      return;
    }
    if (type === 'importmap') {
      try {
        const map = JSON.parse(s.text) as { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> };
        importMapUrls.push(...Object.values(map.imports ?? {}), ...Object.values(map.scopes ?? {}).flatMap((x) => Object.values(x)));
      } catch {
        syntaxErrors.push(`importmap #${idx + 1}: invalid JSON`);
      }
      return;
    }
    const isJs = type === '' || type === 'module' || type.includes('javascript') || type.includes('ecmascript');
    if (!isJs || !s.text.trim()) return; // data blocks (x-shader, json, …) are not executed
    const { ast, error } = parseJs(s.text, type === 'module');
    if (error) syntaxErrors.push(`<script> #${idx + 1}: ${error}`);
    if (ast) walk(ast, facts);
  });
  // Inline event handlers: parse them all in one pass (each wrapped in its own function). If that fails
  // (one malformed handler), fall back to parsing a bounded number individually so cost stays linear.
  if (doc.handlers.length) {
    const combined = parseJs(doc.handlers.map((h) => `(function(){${h}\n});`).join('\n'), false, false);
    if (combined.ast) walk(combined.ast, facts);
    else
      for (const h of doc.handlers.slice(0, MAX_HANDLER_PARSES)) {
        const { ast } = parseJs(h, false, false);
        if (ast) walk(ast, facts);
      }
  }
  if (syntaxErrors.length) add('js-syntax', 'JavaScript syntax', 'fail', 'A script does not parse, so the game would break on load.', syntaxErrors);
  else add('js-syntax', 'JavaScript syntax', 'pass', `${doc.scripts.length} script(s) parse.`);

  // Script hosts: <script src>, ES imports, import maps (hard fail).
  const scriptRefs = [...scriptSrcs, ...facts.imports.filter((u) => isRemote(u) || /^\.{0,2}\//.test(u)), ...importMapUrls];
  const badScripts = scriptRefs.filter((u) => classify(u, SCRIPT_HOSTS) === 'blocked');
  const localScripts = scriptRefs.filter((u) => classify(u, SCRIPT_HOSTS) === 'local');
  if (badScripts.length || localScripts.length) {
    const parts = [];
    if (badScripts.length) parts.push('scripts/imports from hosts outside the allowlist');
    if (localScripts.length) parts.push('references to local files (the game must be one self-contained file)');
    add('script-hosts', 'Script & import hosts', 'fail', `Found ${parts.join(' and ')}.`, [...badScripts, ...localScripts]);
  } else add('script-hosts', 'Script & import hosts', 'pass', scriptRefs.length ? 'All external scripts are on the allowlist.' : 'No external scripts.');

  // Style/font hosts: <link href> + CSS url()/@import (hard fail).
  const linkHrefs = doc.tags
    .filter((t) => t.name === 'link' && /\b(?:stylesheet|preload|modulepreload|prefetch|icon|manifest)\b/i.test(t.attrs.get('rel') ?? ''))
    .map((t) => t.attrs.get('href') ?? '')
    .filter(Boolean);
  const styleUrls = [...doc.styles.flatMap(cssUrls), ...doc.tags.flatMap((t) => cssUrls(t.attrs.get('style') ?? ''))];
  const styleRefs = [...linkHrefs, ...styleUrls.filter(isRemote)];
  const badStyles = styleRefs.filter((u) => classify(u, STYLE_HOSTS) === 'blocked');
  const localStyles = linkHrefs.filter((u) => classify(u, STYLE_HOSTS) === 'local');
  if (badStyles.length || localStyles.length)
    add('style-hosts', 'Stylesheet & font hosts', 'fail', 'Stylesheets/fonts must be inline or from the allowlist.', [...badStyles, ...localStyles]);
  else add('style-hosts', 'Stylesheet & font hosts', 'pass', styleRefs.length ? 'All stylesheets/fonts are on the allowlist.' : 'No external stylesheets.');

  // Network: fetch/XHR/WebSocket/EventSource/beacon/workers + remote media src (warn; CSP is the enforcement).
  const mediaSrcs = doc.tags
    .filter((t) => ['img', 'audio', 'video', 'source', 'track', 'embed', 'object', 'input'].includes(t.name))
    .flatMap((t) => [t.attrs.get('src'), t.attrs.get('data'), t.attrs.get('poster')])
    .filter((u): u is string => !!u && isRemote(u));
  const badNet = [
    ...facts.network.filter((u) => isRemote(u) && classify(u, CONNECT_HOSTS) !== 'allowed'),
    ...mediaSrcs.filter((u) => classify(u, MEDIA_HOSTS) !== 'allowed'),
  ];
  add('network', 'Network requests', badNet.length ? 'warn' : 'pass', badNet.length ? 'Requests to hosts outside the allowlist will be blocked by the CSP.' : 'No requests to non-allowlisted hosts.', badNet);

  add('eval', 'eval / new Function', facts.evals.length ? 'warn' : 'pass', facts.evals.length ? 'Dynamic code evaluation; make sure it never runs downloaded code.' : 'None.', facts.evals);

  // Sandbox-unsafe patterns (warn).
  const iframes = doc.tags.filter((t) => ['iframe', 'frame', 'frameset'].includes(t.name)).map((t) => `<${t.name}${t.attrs.get('src') ? ` src="${t.attrs.get('src')}"` : ''}>`);
  add('iframes', 'Nested frames', iframes.length ? 'warn' : 'pass', iframes.length ? 'Nested frames are blocked or broken in the game sandbox.' : 'None.', iframes);
  const forms = doc.tags.filter((t) => t.name === 'form' && t.attrs.has('action')).map((t) => `<form action="${t.attrs.get('action')}">`);
  add('forms', 'Form submission', forms.length ? 'warn' : 'pass', forms.length ? 'Forms that submit are blocked in the sandbox (no allow-forms).' : 'None.', forms);
  add('popups', 'Popups', facts.popups.length ? 'warn' : 'pass', facts.popups.length ? 'window.open() is blocked in the sandbox.' : 'None.', facts.popups);
  add('top-navigation', 'Frame escape / top navigation', facts.topNav.length ? 'warn' : 'pass', facts.topNav.length ? 'Touching top/parent is blocked; use window.Meshgrounds instead.' : 'None.', facts.topNav);
  add('dialogs', 'Blocking dialogs', facts.dialogs.length ? 'warn' : 'pass', facts.dialogs.length ? 'alert/confirm/prompt do nothing in the sandbox.' : 'None.', facts.dialogs);

  // Contract hooks (warn only).
  const missing = ['ready', 'onPause', 'onResume'].filter((h) => !facts.hooks.has(h));
  add('contract-hooks', 'Meshgrounds hooks', missing.length ? 'warn' : 'pass',
    missing.length ? `Not calling ${missing.map((h) => `Meshgrounds.${h}`).join(', ')} (runtime contract v1.1; guard with ?.).` : 'Calls ready, onPause and onResume.',
    missing.map((h) => `Meshgrounds.${h}`));

  return finish(checks, bytes);
}

function finish(checks: StaticCheck[], bytes: number): StaticReport {
  const status: CheckLevel = checks.some((c) => c.level === 'fail') ? 'fail' : checks.some((c) => c.level === 'warn') ? 'warn' : 'pass';
  return { status, bytes, checks };
}
