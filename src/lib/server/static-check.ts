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
import { GAME_VERSION_MAX_BYTES } from '../asset-limits.ts';

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
  /** IS-2: report-only input-support classification (never affects status). */
  inputSupport?: InputSupportReport;
}

/* ------------------------------------------------------------------ input support (IS-2) */

export type InputClass = 'mobile' | 'desktop' | 'both' | 'unknown';
export interface InputSignals { touch: boolean; pointer: boolean; controls: boolean; keyboard: boolean; mouse: boolean }
export interface InputSupportReport {
  class: InputClass;
  detected: InputClass;
  declared: 'mobile' | 'desktop' | 'both' | null;
  source: 'declared' | 'detected';
  signals: InputSignals;
}

// Simple alternations only (no nested quantifiers): each test is a single linear scan.
const RE_TOUCH = /\b(?:on)?touch(?:start|move|end|cancel)\b|\bTouchEvent\b|\bchangedTouches\b|\.touches\b|\bmaxTouchPoints\b/;
const RE_POINTER = /\b(?:on)?pointer(?:down|move|up|cancel)\b|\bPointerEvent\b/i;
const RE_KEYS = /\b(?:on)?key(?:down|up|press)\b/i;
const RE_MOUSE = /\b(?:on)?(?:mouse(?:down|up|move)|wheel)\b/i;
const RE_CONTROLS = /(?:^|[^a-z])(?:d-?pad|joystick|touch-?(?:controls?|buttons?|pad)|virtual-?(?:pad|joystick|buttons?|controls?)|on-?screen-?(?:controls?|buttons?)|mobile-?(?:controls?|buttons?))(?:$|[^a-z])/i;
const RE_DECLARE = /\binputSupport\s*:\s*['"`](mobile|desktop|both)['"`]/gi;
/** Cap on how much text the input scan reads, so huge files stay inside the time budget. */
export const INPUT_SCAN_CAP = 2 * 1024 * 1024;

const asDeclared = (v: string | undefined | null): 'mobile' | 'desktop' | 'both' | null => {
  const x = (v ?? '').trim().toLowerCase();
  return x === 'mobile' || x === 'desktop' || x === 'both' ? (x as 'mobile' | 'desktop' | 'both') : null;
};

/**
 * Classifies which devices a game supports from its markup and JS.
 * mobile signals: touch events, pointer events, on-screen controls. desktop signals: key events, mouse-only events
 * (mousedown/up/move, wheel). click is neutral: it fires on tap too.
 * Mobile + desktop -> 'both'; keys/mouse only -> 'desktop'; mobile only -> 'mobile'; nothing -> 'unknown'.
 * A declaration (Meshground.declare({ inputSupport }), else the meta tag; same order as boot.js) wins when the code is consistent with it
 * (its signals are present, or the code shows no input signals at all).
 */
export function classifyInputSupport(js: string, tags: { name: string; attrs: Map<string, string> }[]): InputSupportReport {
  const code = js.length > INPUT_SCAN_CAP ? js.slice(0, INPUT_SCAN_CAP) : js;
  let attrNames = '', attrIds = '';
  let meta: 'mobile' | 'desktop' | 'both' | null = null;
  for (const t of tags) {
    if (t.name === 'meta' && (t.attrs.get('name') ?? '').trim().toLowerCase().match(/^meshgrounds?:input-support$/)) /* new name + pre-rebrand name */ meta ??= asDeclared(t.attrs.get('content'));
    for (const [k, v] of t.attrs) {
      if (k.startsWith('on')) attrNames += ' ' + k.slice(2);
      if (k === 'id' || k === 'class' || k.startsWith('data-')) attrIds += ' ' + v;
    }
    if (attrNames.length + attrIds.length > INPUT_SCAN_CAP) break;
  }
  const evts = code + ' ' + attrNames;
  const signals: InputSignals = {
    touch: RE_TOUCH.test(evts),
    pointer: RE_POINTER.test(evts),
    controls: RE_CONTROLS.test(attrIds) || RE_CONTROLS.test(code),
    keyboard: RE_KEYS.test(evts),
    mouse: RE_MOUSE.test(evts),
  };
  const mobile = signals.touch || signals.pointer || signals.controls;
  const desktop = signals.keyboard || signals.mouse;
  const detected: InputClass = mobile && desktop ? 'both' : mobile ? 'mobile' : desktop ? 'desktop' : 'unknown';
  // Same precedence as the runtime (cdn/boot.js, #34): Meshground.declare() beats the meta tag.
  // boot.js keeps the LAST declare() call, so the static check does too.
  // Comments are stripped first (string/regex-aware, linear; only when the key appears at all), so a
  // commented-out declare() is ignored.
  let lastDeclare: string | undefined;
  if (code.includes('inputSupport')) for (const m of normalizeJs(code, true).matchAll(RE_DECLARE)) lastDeclare = m[1];
  const declared = asDeclared(lastDeclare) ?? meta;
  const consistent = declared !== null && (detected === 'unknown'
    || (declared === 'mobile' && mobile) || (declared === 'desktop' && desktop) || (declared === 'both' && mobile && desktop));
  return consistent ? { class: declared!, detected, declared, source: 'declared', signals } : { class: detected, detected, declared, source: 'detected', signals };
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

/** Same 4 MB whole-game cap as upload.ts `GAME_TOTAL_MAX_BYTES` via asset-limits.ts (dependency-free so Edge Functions stay safe). */
export const STATIC_LIMITS = { maxBytes: GAME_VERSION_MAX_BYTES, warnBytes: 1024 * 1024 };
const MAX_FINDINGS = 10;
/** Upper bound on per-handler parses when the combined handler parse fails (keeps the worst case linear). */
const MAX_HANDLER_PARSES = 200;
/**
 * Budget for the acorn/AST warning phase (the Edge Function has ~2s of CPU). Parsing can't be interrupted
 * mid-file, so the budget is enforced before each parse (bytes of JS still allowed) and during the walk
 * (wall time). acorn does roughly 3 MB/s here, so 1.25 MB keeps the phase near 600 ms with headroom for
 * slower edge CPUs. Past the budget we stop and emit one 'deep analysis skipped (too large)' warning.
 */
export const AST_BUDGET = { ms: 600, maxJsBytes: 1.25 * 1024 * 1024 };

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
      if (value.includes('&')) value = decodeEntities(value);
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

const ENTITIES: Record<string, string> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', sol: '/', colon: ':', lpar: '(', rpar: ')', period: '.', lsqb: '[', rsqb: ']', grave: '`', bsol: '\\', nbsp: ' ', tab: '\t', newline: '\n' };
/** Browsers decode character references in attribute values before running a handler or loading a src. */
function decodeEntities(v: string): string {
  return v.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,8}));?/g, (m, hex, dec, name) => {
    const cp = hex ? parseInt(hex, 16) : dec ? parseInt(dec, 10) : NaN;
    if (!Number.isNaN(cp)) return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\uFFFD';
    return ENTITIES[name.toLowerCase()] ?? m;
  });
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

class Budget {
  private readonly start = now();
  private readonly opts: { ms: number; maxJsBytes: number };
  private bytesLeft: number;
  skipped = false;
  constructor(opts: { ms: number; maxJsBytes: number }) {
    this.opts = opts;
    this.bytesLeft = opts.maxJsBytes;
  }
  remaining() {
    return this.skipped ? 0 : this.bytesLeft;
  }
  timeLeft() {
    return now() - this.start < this.opts.ms;
  }
  /** Reserve `len` bytes of parsing; false (and skipped) once the byte or time budget is exhausted. */
  take(len: number): boolean {
    if (this.skipped || len > this.bytesLeft || !this.timeLeft()) return !(this.skipped = true);
    this.bytesLeft -= len;
    return true;
  }
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function walk(root: N, facts: JsFacts, budget?: Budget) {
  const stack: N[] = [root];
  let steps = 0;
  while (stack.length) {
    if ((++steps & 4095) === 0 && budget && !budget.timeLeft()) {
      budget.skipped = true;
      return;
    }
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
        // parent["location"] / top['document'] = …
        if (node.computed && node.property?.type === 'Literal' && ['location', 'document', 'window'].includes(String(node.property.value))) {
          const obj = stripWindow(path(node.object));
          if (obj === 'top' || obj === 'parent') facts.topNav.push(`${path(node.object)}["${node.property.value}"]`);
        }
        const p = path(node);
        if (p) {
          const bare = stripWindow(p);
          // parent.postMessage is how games talk to the portal (boot.js telemetry), not navigation.
          if (/^(?:top|parent)\.(?:location|document|window)\b/.test(bare) || bare === 'top' || bare.startsWith('frameElement')) facts.topNav.push(p);
          const m = /(?:^|\.)Meshgrounds?\.(ready|onPause|onResume)\b/.exec(p);
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

/**
 * Parses all classic scripts as `{\n<code>\n}` blocks in one acorn call. Two blocks with unbalanced braces
 * could cancel out when concatenated, so the result is only trusted if the program's top level is exactly
 * one BlockStatement per script at the expected offsets; otherwise (or on a syntax error) the run is split
 * at the offending script and the rest is parsed again. Every parse draws from the byte budget, which keeps
 * the total work linear.
 */
function parseClassic(blocks: { idx: number; text: string }[], facts: JsFacts, errors: string[], budget: Budget) {
  let from = 0;
  while (from < blocks.length && !budget.skipped) {
    const offsets: number[] = [];
    let src = '';
    for (let k = from; k < blocks.length; k++) {
      offsets.push(src.length);
      src += `{\n${blocks[k].text}\n}\n`;
    }
    if (!budget.take(src.length)) return;
    const { ast, error, pos } = parseAt(src);
    if (ast) {
      const body = ast.body as N[];
      const aligned = body.length === offsets.length && body.every((b, k) => b.type === 'BlockStatement' && b.start === offsets[k]);
      if (aligned) {
        walk(ast, facts, budget);
        return;
      }
    }
    // Find the first script that is wrong on its own, record it, and continue after it.
    let bad = from;
    if (!ast && pos !== null) {
      let k = 0;
      while (k + 1 < offsets.length && offsets[k + 1] <= pos) k++;
      bad = from + k;
    } else {
      for (let k = 0; k < offsets.length; k++) {
        const b = body0(ast)[k];
        if (!b || b.type !== 'BlockStatement' || b.start !== offsets[k]) { bad = from + k; break; }
      }
    }
    if (bad > from) parseClassic(blocks.slice(from, bad), facts, errors, budget); // prefix parsed fine up to here
    const one = blocks[bad];
    if (!budget.take(one.text.length)) return;
    const single = parseJs(one.text, false);
    if (single.error) errors.push(`<script> #${one.idx + 1}: ${single.error ?? error}`);
    else if (single.ast) walk(single.ast, facts, budget);
    from = bad + 1;
  }
}
const body0 = (ast: N | null): N[] => (ast?.body as N[]) ?? [];

function parseAt(code: string): { ast: N | null; error: string | null; pos: number | null } {
  try {
    return { ast: parse(code, { ecmaVersion: 'latest', allowHashBang: true, allowAwaitOutsideFunction: true, sourceType: 'script' }) as N, error: null, pos: null };
  } catch (e) {
    const pos = (e as { pos?: number }).pos;
    return { ast: null, error: (e as Error).message, pos: typeof pos === 'number' ? pos : null };
  }
}

/* ------------------------------------------------------------------ lexical fallback (budget skipped) */

/** Cap on specifiers/findings collected by the lexical fallback; more than this is itself a hard fail. */
export const LEXICAL_CAP = 10_000;

const hexVal = (s: string) => (/^[0-9a-fA-F]+$/.test(s) ? parseInt(s, 16) : NaN);

/** Decodes one JS escape at code[i] === '\\'. Returns [decoded text, next index]. */
function unescapeAt(code: string, i: number): [string, number] {
  const c = code[i + 1];
  if (c === undefined) return ['', i + 1];
  if (c === 'x') {
    const v = hexVal(code.slice(i + 2, i + 4));
    return Number.isNaN(v) ? ['x', i + 2] : [String.fromCharCode(v), i + 4];
  }
  if (c === 'u') {
    if (code[i + 2] === '{') {
      const e = code.indexOf('}', i + 3);
      const v = e > 0 && e - i < 12 ? hexVal(code.slice(i + 3, e)) : NaN;
      return Number.isNaN(v) || v > 0x10ffff ? ['u', i + 2] : [String.fromCodePoint(v), e + 1];
    }
    const v = hexVal(code.slice(i + 2, i + 6));
    return Number.isNaN(v) ? ['u', i + 2] : [String.fromCharCode(v), i + 6];
  }
  if (c >= '0' && c <= '7') {
    // Legacy octal escape (sloppy-mode strings): \150 = 'h'. Up to 3 digits from 0-3, up to 2 from 4-7.
    const max = c <= '3' ? 3 : 2;
    let j = i + 1;
    while (j < i + 1 + max && code[j] >= '0' && code[j] <= '7') j++;
    return [String.fromCharCode(parseInt(code.slice(i + 1, j), 8)), j];
  }
  if (c === '\r' || c === '\n' || c === '\u2028' || c === '\u2029') return ['', i + 2]; // line continuation
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
  return [simple[c] ?? c, i + 2];
}

const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** Inside string contents: quotes, backslashes, newlines and `(` are neutralised so no code pattern can match there. */
const QUOTES = /['"`\\\n\r(]/g;

/**
 * One linear pass that turns JS into a normalised form for the text scans: comments become a space,
 * string/template contents are escape-decoded (`\/`, `\xNN`, `\uNNNN`) and re-quoted with quotes,
 * backslashes, newlines and `(` inside neutralised, regex literals become `/r/`, and `\u` escapes in
 * identifiers are decoded. Plain code is copied in slices, so the cost is one charCodeAt per byte.
 * Returns two views: `src` keeps string contents (for specifiers/URLs); `bare` empties them (for code-only
 * patterns, so text inside a string can never look like a call).
 */
export function normalizeJsBoth(code: string): { src: string; bare: string } {
  const out: string[] = [];
  const bare: string[] = [];
  const n = code.length;
  let i = 0;
  let run = 0;
  const flush = (to: number) => {
    if (to > run) {
      const s = code.slice(run, to);
      out.push(s);
      bare.push(s);
    }
  };
  const both = (s: string) => {
    out.push(s);
    bare.push(s);
  };
  while (i < n) {
    const c = code.charCodeAt(i);
    // Fast path: only / " ' ` < \ can start something that needs rewriting.
    if (c !== 47 && c !== 34 && c !== 39 && c !== 96 && c !== 60 && c !== 92) {
      i++;
      continue;
    }
    if (c === 60) {
      if (code.startsWith('<!--', i)) {
        flush(i);
        const e = code.indexOf('\n', i + 4);
        i = e < 0 ? n : e;
        both(' ');
        run = i;
      } else i++;
      continue;
    }
    if (c === 92) {
      if (code[i + 1] === 'u') {
        flush(i);
        const [d, nx] = unescapeAt(code, i);
        both(d);
        i = run = nx;
      } else i += 2;
      continue;
    }
    if (c === 47) {
      const nx = code[i + 1];
      if (nx === '/' || nx === '*') {
        flush(i);
        const e = nx === '/' ? code.indexOf('\n', i + 2) : code.indexOf('*/', i + 2);
        i = e < 0 ? n : nx === '/' ? e : e + 2;
        both(' ');
        run = i;
        continue;
      }
      if (regexAllowedAt(code, i)) {
        let j = i + 1;
        let cls = false;
        while (j < n && code[j] !== '\n') {
          const d = code[j];
          if (d === '\\') j += 2;
          else if (d === '[') { cls = true; j++; }
          else if (d === ']') { cls = false; j++; }
          else if (d === '/' && !cls) break;
          else j++;
        }
        if (code[j] === '/') {
          flush(i);
          both('/r/');
          i = run = j + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    // String or template literal.
    flush(i);
    const q = code[i];
    let j = i + 1;
    let s = '';
    let seg = j;
    while (j < n) {
      const d = code[j];
      if (d === q) break;
      if (d === '\\') {
        s += code.slice(seg, j);
        const [dec, nx] = unescapeAt(code, j);
        s += dec;
        j = seg = nx;
      } else if (q !== '`' && d === '\n') break;
      else j++;
    }
    s += code.slice(seg, Math.min(j, n));
    out.push(q + s.replace(QUOTES, '\uFFFD') + q);
    bare.push(q + q);
    // A dynamic import inside a template substitution is code we didn't tokenise: surface it so it fails closed.
    if (q === '`' && s.includes('${') && /\bimport\s*\(/.test(s)) both(' import(\uFFFD) ');
    i = run = j + 1;
  }
  flush(n);
  return { src: out.join(''), bare: bare.join('') };
}
export const normalizeJs = (code: string, keepStrings = true) => normalizeJsBoth(code)[keepStrings ? 'src' : 'bare'];

/** Is a `/` at code[at] the start of a regex literal (vs division)? Looks back past whitespace only. */
function regexAllowedAt(code: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && isSpace(code.charCodeAt(j))) j--;
  if (j < 0) return true;
  const c = code.charCodeAt(j);
  if (isIdent(c)) {
    let k = j;
    while (k >= 0 && j - k < 12 && isIdent(code.charCodeAt(k))) k--;
    return REGEX_KEYWORDS.has(code.slice(k + 1, j + 1));
  }
  return REGEX_AFTER.has(code[j]);
}
const isIdent = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95 || c > 127;

interface LexFacts {
  imports: string[];
  unresolved: string[];
  network: string[];
  evals: string[];
  popups: string[];
  topNav: string[];
  dialogs: string[];
  hooks: Set<string>;
  capped: boolean;
}

const STR = `(['"\`])([^'"\`]{0,4096})`;
const LEX = {
  importCall: new RegExp(`(?<![\\w$.])import\\s*\\(\\s*${STR}\\1`, 'g'),
  importAny: /(?<![\w$.])import\s*\(/g,
  importBare: new RegExp(`(?<![\\w$.])import\\s*${STR}\\1`, 'g'),
  from: new RegExp(`(?<![\\w$.])from\\s*${STR}\\1`, 'g'),
  network: new RegExp(`(?<![\\w$])(?:fetch|sendBeacon|importScripts|WebSocket|EventSource|Worker|SharedWorker)\\s*\\(\\s*${STR}\\1`, 'g'),
  xhrOpen: /\.\s*open\s*\(\s*(['"`])[^'"`]{0,64}\1\s*,\s*(['"`])([^'"`]{0,4096})\2/g,
  evals: /(?<![\w$.])(?:eval\s*\(|(?:new\s+)?Function\s*\(|set(?:Timeout|Interval)\s*\(\s*['"`])/g,
  popups: /(?<![\w$.])(?:(?:window|self|globalThis)\s*\.\s*)?open\s*\(/g,
  topNav: /(?<![\w$.])(?:(?:window|self|globalThis)\s*\.\s*)?(?:top|parent)\s*\.\s*(?:location|document|window)(?![\w$])|(?<![\w$.])(?:window|self|globalThis)\s*\.\s*top(?![\w$])|(?<![\w$.])frameElement(?![\w$])/g,
  topNavIndex: /(?<![\w$.])(?:(?:window|self|globalThis)\s*\.\s*)?(?:top|parent)\s*\[\s*(['"`])(?:location|document|window)\1\s*\]/g,
  dialogs: /(?<![\w$.])(?:(?:window|self|globalThis)\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/g,
  hooks: /Meshgrounds?\s*\??\.\s*(ready|onPause|onResume)(?![\w$])/g,
};

/** Text-scan of normalised JS. Every collection is bounded by LEXICAL_CAP and built with loops (no spread). */
function lexicalScan(codes: string[], into: LexFacts) {
  // Each script/handler is normalised on its own (an unterminated string or template can't swallow the next
  // one), then all of them are scanned in one go, so 100k tiny handlers cost one regex pass, not 100k.
  const srcs: string[] = [];
  const bares: string[] = [];
  for (const code of codes) {
    const v = normalizeJsBoth(code);
    srcs.push(v.src);
    bares.push(v.bare);
  }
  const src = srcs.join('\n;\n');
  const bare = bares.join('\n;\n');
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void, text = src) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) re.lastIndex++;
      fn(m);
    }
  };
  const push = (list: string[], v: string) => {
    if (list.length < LEXICAL_CAP) list.push(v);
    else into.capped = true;
  };
  const spec = (list: string[], q: string, v: string) => {
    if (q === '`' && v.includes('${') && !/^(?:https?:|wss?:)?\/\/[^/$]+\//i.test(v)) push(into.unresolved, `\`${v.slice(0, 80)}\``);
    else push(list, v);
  };
  const literalStarts = new Set<number>();
  each(LEX.importCall, (m) => { literalStarts.add(m.index); spec(into.imports, m[1], m[2]); });
  each(LEX.importAny, (m) => {
    if (!literalStarts.has(m.index)) push(into.unresolved, src.slice(m.index, m.index + 60).replace(/\s+/g, ' '));
  });
  each(LEX.importBare, (m) => spec(into.imports, m[1], m[2]));
  each(LEX.from, (m) => spec(into.imports, m[1], m[2]));
  each(LEX.network, (m) => push(into.network, m[2]));
  each(LEX.xhrOpen, (m) => push(into.network, m[3]));
  each(LEX.evals, (m) => push(into.evals, m[0].replace(/\s+/g, '').replace(/\($|\(['"`]$/, '()')), bare);
  each(LEX.popups, () => push(into.popups, 'window.open()'), bare);
  each(LEX.topNav, (m) => push(into.topNav, m[0].replace(/\s+/g, '')), bare);
  each(LEX.topNavIndex, (m) => push(into.topNav, m[0].replace(/\s+/g, '')));
  each(LEX.dialogs, (m) => push(into.dialogs, m[0].replace(/\s+/g, '').replace(/\($/, '()')), bare);
  each(LEX.hooks, (m) => into.hooks.add(m[1]), bare);
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
    add('size', 'File size', 'fail', `${mb(bytes)} is over the ${STATIC_LIMITS.maxBytes / 1024 / 1024} MB limit.`);
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
  const budget = new Budget(AST_BUDGET);
  const classic: { idx: number; text: string }[] = [];
  const modules: { idx: number; text: string }[] = [];
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
    (type === 'module' ? modules : classic).push({ idx, text: s.text });
  });
  // All classic inline scripts go through ONE parse (each wrapped in its own block), so 270k tiny
  // <script>s cost one acorn call instead of 270k; see parseClassic for the boundary check.
  // Smallest scripts first, so one huge script can't stop the small ones from being parsed (their syntax
  // errors, evals, popups… stay exact). Whatever doesn't fit the byte budget is left to the text scan.
  const bySize = (a: { text: string }, b: { text: string }) => a.text.length - b.text.length;
  const fit: typeof classic = [];
  let room = budget.remaining();
  for (const c of [...classic].sort(bySize)) {
    if (c.text.length + 4 > room) { budget.skipped = true; break; }
    room -= c.text.length + 4;
    fit.push(c);
  }
  const over = budget.skipped;
  budget.skipped = false;
  parseClassic(fit.sort((a, b) => a.idx - b.idx), facts, syntaxErrors, budget);
  if (over) budget.skipped = true;
  for (const m of [...modules].sort(bySize)) {
    if (!budget.take(m.text.length)) break;
    const { ast, error } = parseJs(m.text, true);
    if (error) syntaxErrors.push(`<script> #${m.idx + 1}: ${error}`);
    if (ast) walk(ast, facts, budget);
  }
  // Inline event handlers: parse them all in one pass (each wrapped in its own function). If that fails
  // (one malformed handler), fall back to parsing a bounded number individually so cost stays linear.
  const handlerSrc = doc.handlers.length ? doc.handlers.map((h) => `(function(){${h}\n});`).join('\n') : '';
  if (handlerSrc && budget.take(handlerSrc.length)) {
    const combined = parseJs(handlerSrc, false, false);
    if (combined.ast) walk(combined.ast, facts, budget);
    else
      for (const h of doc.handlers.slice(0, MAX_HANDLER_PARSES)) {
        const { ast } = parseJs(h, false, false);
        if (ast) walk(ast, facts, budget);
      }
  }
  const lex: LexFacts = { imports: [], unresolved: [], network: [], evals: [], popups: [], topNav: [], dialogs: [], hooks: new Set(), capped: false };
  if (budget.skipped) {
    // Without the full AST every check keeps working from a normalised text scan (comments stripped,
    // escapes decoded) of every script AND every inline event handler. Findings are merged with whatever
    // the partial AST walk found; nothing is downgraded. An import that can't be resolved fails closed.
    const codes: string[] = [];
    for (const x of classic) codes.push(x.text);
    for (const x of modules) codes.push(x.text);
    for (const h of doc.handlers) codes.push(h);
    lexicalScan(codes, lex);
    const merge = (into: string[], from: string[]) => { for (let k = 0; k < from.length && into.length < LEXICAL_CAP; k++) into.push(from[k]); };
    merge(facts.imports, lex.imports);
    merge(facts.network, lex.network);
    merge(facts.evals, lex.evals);
    merge(facts.popups, lex.popups);
    merge(facts.topNav, lex.topNav);
    merge(facts.dialogs, lex.dialogs);
    for (const h of lex.hooks) facts.hooks.add(h);
    add('deep-analysis', 'Deep analysis', 'warn', 'deep analysis skipped (too large)',
      [`JavaScript over the ${Math.round(AST_BUDGET.maxJsBytes / 1024)} KB / ${AST_BUDGET.ms} ms analysis budget; checks fell back to a text scan.`]);
  }
  if (syntaxErrors.length) add('js-syntax', 'JavaScript syntax', 'fail', 'A script does not parse, so the game would break on load.', syntaxErrors);
  else add('js-syntax', 'JavaScript syntax', 'pass', budget.skipped ? 'Not fully checked; no syntax errors in the part that was parsed.' : `${doc.scripts.length} script(s) parse.`);

  // Script hosts: <script src>, ES imports, import maps (hard fail).
  const scriptRefs = [...scriptSrcs, ...facts.imports.filter((u) => isRemote(u) || /^\.{0,2}\//.test(u)), ...importMapUrls];
  const badScripts = scriptRefs.filter((u) => classify(u, SCRIPT_HOSTS) === 'blocked');
  const localScripts = scriptRefs.filter((u) => classify(u, SCRIPT_HOSTS) === 'local');
  // Fail closed: past the budget, an import we can't resolve (dynamic specifier, or too many to verify) is a fail.
  const unresolved = lex.capped ? [...lex.unresolved.slice(0, MAX_FINDINGS - 1), `more than ${LEXICAL_CAP} imports/URLs (not verifiable)`] : lex.unresolved;
  if (badScripts.length || localScripts.length || unresolved.length) {
    const parts = [];
    if (unresolved.length) parts.push('imports that could not be verified without deep analysis');
    if (badScripts.length) parts.push('scripts/imports from hosts outside the allowlist');
    if (localScripts.length) parts.push('references to local files (the game must be one self-contained file)');
    add('script-hosts', 'Script & import hosts', 'fail', `Found ${parts.join(' and ')}.`, [...badScripts, ...localScripts, ...unresolved.map((u) => `unresolved: ${u}`)]);
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
  add('top-navigation', 'Frame escape / top navigation', facts.topNav.length ? 'warn' : 'pass', facts.topNav.length ? 'Touching top/parent is blocked; use window.Meshground instead.' : 'None.', facts.topNav);
  add('dialogs', 'Blocking dialogs', facts.dialogs.length ? 'warn' : 'pass', facts.dialogs.length ? 'alert/confirm/prompt do nothing in the sandbox.' : 'None.', facts.dialogs);

  // Contract hooks (warn only).
  const missing = ['ready', 'onPause', 'onResume'].filter((h) => !facts.hooks.has(h));
  add('contract-hooks', 'Meshground hooks', missing.length ? 'warn' : 'pass',
    missing.length ? `Not calling ${missing.map((h) => `Meshground.${h}`).join(', ')} (runtime contract v1.1; guard with ?.).` : 'Calls ready, onPause and onResume.',
    missing.map((h) => `Meshground.${h}`));

  // Input support (IS-2): report-only, always 'pass'. Lexical, capped, so it never blows the time budget.
  const inputSupport = classifyInputSupport(doc.scripts.map((x) => x.text).join('\n') + '\n' + doc.handlers.join('\n'), doc.tags);
  const on = (Object.keys(inputSupport.signals) as (keyof InputSignals)[]).filter((k) => inputSupport.signals[k]);
  add('input-support', 'Input support', 'pass',
    `${inputSupport.class}${inputSupport.source === 'declared' ? ' (declared)' : ''}. Signals: ${on.length ? on.join(', ') : 'none'}.` +
      (inputSupport.declared && inputSupport.source === 'detected' ? ` Declared '${inputSupport.declared}' does not match the code.` : ''));

  if (budget.skipped) {
    // Only the hooks reminder is softened: a text scan can miss a hook call, and it is never a safety signal.
    // eval, popups, top-navigation, dialogs and syntax keep whatever level they earned.
    for (const c of checks) {
      if (c.id === 'contract-hooks' && c.level === 'warn') Object.assign(c, { level: 'pass', message: `Not fully checked (deep analysis skipped). ${c.message}` });
      else if (c.level === 'pass' && ['js-syntax', 'eval', 'popups', 'top-navigation', 'dialogs', 'network'].includes(c.id) && !c.message.startsWith('Text scan'))
        c.message = `Text scan only (deep analysis skipped): ${c.message}`;
    }
  }
  return { ...finish(checks, bytes), inputSupport };
}

function finish(checks: StaticCheck[], bytes: number): StaticReport {
  const status: CheckLevel = checks.some((c) => c.level === 'fail') ? 'fail' : checks.some((c) => c.level === 'warn') ? 'warn' : 'pass';
  return { status, bytes, checks };
}
