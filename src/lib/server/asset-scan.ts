/**
 * Pure scan of uploaded HTML, CSS, and JS for local asset paths.
 * Rows are references only (`status = 'missing'`). Sizes are not known here.
 *
 * Hard cap for one game version (code plus assets): GAME_TOTAL_MAX_BYTES.
 * An individual asset over ASSET_WARN_BYTES is a warning, not a rejection.
 * whole game, code plus assets, under 4 MB; assets over 100 KB get a warning
 */
import { parse } from 'acorn';

/** Whole game version: HTML/code plus every asset combined. */
export const GAME_TOTAL_MAX_BYTES = 4194304;
/** Assets over this size get a warning. They are not rejected for size alone. */
export const ASSET_WARN_BYTES = 102400;
/** Manifest rows kept per game version. */
export const MAX_ASSETS_PER_GAME = 200;
export const ASSET_LIMIT_COPY =
  'whole game, code plus assets, under 4 MB; assets over 100 KB get a warning';

const PATH_MAX = 512;

export type ExpectedType = 'image' | 'audio' | 'font' | 'json' | 'text';
export type RejectReason = 'absolute' | 'dotdot' | 'backslash' | 'too_long';

export interface ScannedAsset {
  path: string;
  expectedType: ExpectedType;
}

export interface RejectedAsset {
  raw: string;
  reason: RejectReason;
}

export interface AssetScan {
  assets: ScannedAsset[];
  rejected: RejectedAsset[];
  truncated: boolean;
}

const TYPE_BY_EXT: Record<string, ExpectedType | 'bundle'> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  avif: 'image',
  ico: 'image',
  bmp: 'image',
  apng: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  opus: 'audio',
  weba: 'audio',
  mid: 'audio',
  midi: 'audio',
  aiff: 'audio',
  aif: 'audio',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  eot: 'font',
  json: 'json',
  txt: 'text',
  csv: 'text',
  tsv: 'text',
  xml: 'text',
  vtt: 'text',
  srt: 'text',
  md: 'text',
  text: 'text',
  html: 'bundle',
  htm: 'bundle',
  js: 'bundle',
  mjs: 'bundle',
  cjs: 'bundle',
  css: 'bundle',
};

type Classified =
  | { kind: 'asset'; path: string; expectedType: ExpectedType }
  | { kind: 'reject'; raw: string; reason: RejectReason }
  | { kind: 'skip' };

interface JsNode {
  type: string;
  value?: unknown;
  name?: string;
  computed?: boolean;
  operator?: string;
  expressions?: JsNode[];
  quasis?: { value?: { cooked?: string | null } }[];
  arguments?: JsNode[];
  callee?: JsNode;
  left?: JsNode;
  right?: JsNode;
  object?: JsNode;
  property?: JsNode;
  [key: string]: unknown;
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isNameChar = (c: number) =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58;

const ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  amp: '&',
  lt: '<',
  gt: '>',
  sol: '/',
  colon: ':',
  lpar: '(',
  rpar: ')',
  period: '.',
  lsqb: '[',
  rsqb: ']',
  grave: '`',
  bsol: '\\',
  nbsp: ' ',
  tab: '\t',
  newline: '\n',
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,8}));?/g, (whole, hex, dec, name) => {
    const cp = hex ? parseInt(hex, 16) : dec ? parseInt(dec, 10) : NaN;
    if (!Number.isNaN(cp)) return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\uFFFD';
    return ENTITIES[String(name).toLowerCase()] ?? whole;
  });
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** External, data:, and blob: URLs are not manifest rows. Any scheme is skipped. */
function isSkippedUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Strip `./`, query, and hash, then percent-decode.
 * Unsafe paths match the game_assets check: leading slash, `..`, backslash, or over 512 characters.
 */
export function classifyAssetPath(raw: string): Classified {
  const original = raw.trim();
  if (!original) return { kind: 'skip' };
  if (isSkippedUrl(original)) return { kind: 'skip' };

  const cut = original.search(/[?#]/);
  let path = cut >= 0 ? original.slice(0, cut) : original;
  path = safeDecode(path).trim();
  if (!path || isSkippedUrl(path)) return { kind: 'skip' };
  if (path.includes('\\')) return { kind: 'reject', raw: original, reason: 'backslash' };
  if (path.startsWith('/')) return { kind: 'reject', raw: original, reason: 'absolute' };
  if (path.includes('..')) return { kind: 'reject', raw: original, reason: 'dotdot' };

  const normalized = path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (!normalized || isSkippedUrl(normalized)) return { kind: 'skip' };
  if (normalized.includes('\\')) return { kind: 'reject', raw: original, reason: 'backslash' };
  if (normalized.startsWith('/')) return { kind: 'reject', raw: original, reason: 'absolute' };
  if (normalized.includes('..')) return { kind: 'reject', raw: original, reason: 'dotdot' };
  if (charLength(normalized) > PATH_MAX) return { kind: 'reject', raw: original, reason: 'too_long' };

  const kind = TYPE_BY_EXT[extensionOf(normalized)];
  if (!kind || kind === 'bundle') return { kind: 'skip' };
  return { kind: 'asset', path: normalized, expectedType: kind };
}

function cssUrls(css: string): string[] {
  const out: string[] = [];
  const n = css.length;
  let i = 0;
  while (i < n) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (css.charCodeAt(i) === 117 || css.charCodeAt(i) === 85) {
      const word = css.slice(i, i + 4);
      if (word.toLowerCase() === 'url(') {
        let j = i + 4;
        while (j < n && isSpace(css.charCodeAt(j))) j++;
        const quote = css[j];
        let value = '';
        if (quote === '"' || quote === "'") {
          const end = css.indexOf(quote, j + 1);
          if (end < 0) break;
          value = css.slice(j + 1, end);
          j = end + 1;
        } else {
          const end = css.indexOf(')', j);
          if (end < 0) break;
          value = css.slice(j, end).trim();
          j = end;
        }
        while (j < n && css[j] !== ')') j++;
        if (value) out.push(value);
        i = j < n ? j + 1 : n;
        continue;
      }
    }
    i++;
  }
  return out;
}

function stringLiteral(node: JsNode | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && (node.expressions?.length ?? 0) === 0) {
    const cooked = node.quasis?.[0]?.value?.cooked;
    return typeof cooked === 'string' ? cooked : null;
  }
  return null;
}

function calleeName(node: JsNode | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Identifier' && node.name) return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier') {
    const objectName = node.object?.type === 'Identifier' ? node.object.name : undefined;
    const name = node.property.name;
    if (objectName && name && ['window', 'globalThis', 'self'].includes(objectName)) return name;
  }
  return null;
}

function isSrcAssignment(node: JsNode): boolean {
  if (node.type !== 'AssignmentExpression' || node.operator !== '=') return false;
  const left = node.left;
  if (!left || left.type !== 'MemberExpression') return false;
  if (!left.computed && left.property?.type === 'Identifier' && left.property.name === 'src') return true;
  if (left.computed && left.property?.type === 'Literal' && left.property.value === 'src') return true;
  return false;
}

function parseJs(code: string): JsNode | null {
  const shared = { ecmaVersion: 'latest' as const, allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true };
  try {
    return parse(code, { ...shared, sourceType: 'script' }) as unknown as JsNode;
  } catch {
    try {
      return parse(code, { ...shared, sourceType: 'module' }) as unknown as JsNode;
    } catch {
      return null;
    }
  }
}

function jsPaths(code: string): string[] {
  const root = parseJs(code);
  if (!root) return [];
  const out: string[] = [];
  const stack: JsNode[] = [root];
  const skip = new Set(['type', 'start', 'end', 'loc', 'range']);
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (node.type === 'CallExpression' && calleeName(node.callee) === 'fetch') {
      const path = stringLiteral(node.arguments?.[0]);
      if (path !== null) out.push(path);
    } else if (node.type === 'NewExpression') {
      const name = calleeName(node.callee);
      if (name === 'Image' || name === 'Audio') {
        const path = stringLiteral(node.arguments?.[0]);
        if (path !== null) out.push(path);
      }
    } else if (isSrcAssignment(node)) {
      const path = stringLiteral(node.right);
      if (path !== null) out.push(path);
    }
    for (const key of Object.keys(node)) {
      if (skip.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          const child = value[i];
          if (child && typeof child === 'object' && typeof (child as JsNode).type === 'string') stack.push(child as JsNode);
        }
      } else if (value && typeof value === 'object' && typeof (value as JsNode).type === 'string') {
        stack.push(value as JsNode);
      }
    }
  }
  return out;
}

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
      const start = j;
      while (j < n && !isSpace(html.charCodeAt(j)) && html[j] !== '=' && html[j] !== '>' && html[j] !== '/') j++;
      const attr = lower.slice(start, j);
      if (j === start) {
        j++;
        continue;
      }
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && isSpace(html.charCodeAt(j))) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          if (end < 0) {
            j = n;
            break;
          }
          value = html.slice(j + 1, end);
          j = end + 1;
        } else {
          const valueStart = j;
          while (j < n && !isSpace(html.charCodeAt(j)) && html[j] !== '>') j++;
          value = html.slice(valueStart, j);
        }
      }
      if (value.includes('&')) value = decodeEntities(value);
      if (!attrs.has(attr)) attrs.set(attr, value);
      if (attr.startsWith('on') && attr !== 'once' && value) doc.handlers.push(value);
    }
    if (!closed) break;
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

function isJsScript(attrs: Map<string, string>): boolean {
  const type = (attrs.get('type') ?? '').trim().toLowerCase();
  return !type || type === 'module' || type === 'text/javascript' || type === 'application/javascript' || type === 'application/ecmascript';
}

function isPathAttr(name: string): boolean {
  return name === 'src' || name === 'href' || name.endsWith(':src') || name.endsWith(':href');
}

function collect(add: (raw: string) => void, source: string, kind: 'html' | 'css' | 'js'): void {
  if (kind === 'css') {
    for (const url of cssUrls(source)) add(url);
    return;
  }
  if (kind === 'js') {
    for (const path of jsPaths(source)) add(path);
    return;
  }
  const doc = tokenize(source);
  for (const tag of doc.tags) {
    for (const [name, value] of tag.attrs) {
      if (isPathAttr(name) && value) add(value);
      if (name === 'style' && value) for (const url of cssUrls(value)) add(url);
    }
  }
  for (const css of doc.styles) for (const url of cssUrls(css)) add(url);
  for (const script of doc.scripts) {
    if (isJsScript(script.attrs)) for (const path of jsPaths(script.text)) add(path);
  }
  for (const handler of doc.handlers) for (const path of jsPaths(handler)) add(path);
}

/** Scan one uploaded HTML document, stylesheet, or script. Order is first-seen. The manifest stops at MAX_ASSETS_PER_GAME. */
export function scanAssetSource(source: string, kind: 'html' | 'css' | 'js' = 'html'): AssetScan {
  const assets: ScannedAsset[] = [];
  const rejected: RejectedAsset[] = [];
  const seen = new Set<string>();
  const rejectedSeen = new Set<string>();
  let truncated = false;

  const add = (raw: string) => {
    const found = classifyAssetPath(raw);
    if (found.kind === 'skip') return;
    if (found.kind === 'reject') {
      const key = `${found.reason}\0${found.raw}`;
      if (rejectedSeen.has(key)) return;
      rejectedSeen.add(key);
      rejected.push({ raw: found.raw, reason: found.reason });
      return;
    }
    if (seen.has(found.path)) return;
    if (assets.length >= MAX_ASSETS_PER_GAME) {
      truncated = true;
      return;
    }
    seen.add(found.path);
    assets.push({ path: found.path, expectedType: found.expectedType });
  };

  collect(add, source, kind);
  return { assets, rejected, truncated };
}
