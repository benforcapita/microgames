/**
 * Static analyzer for uploaded single-file games (Features v2, SP-4).
 * Pure: no database, storage, network, or environment access. Input is the raw .html bytes or text.
 * The CDN CSP is the real enforcement for network access; these checks give creators early, explainable feedback.
 */

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface StaticCheck {
  id: string;
  label: string;
  level: CheckLevel;
  /** Human-readable reason; for warn/fail it names what was found. */
  message: string;
  /** Offending URLs / snippets (deduped, capped). */
  findings?: string[];
}

export interface StaticReport {
  status: CheckLevel;
  bytes: number;
  checks: StaticCheck[];
}

/** Script/module hosts allowed by the CDN CSP (`cdn/handler.mjs` LIB_HOSTS). */
export const SCRIPT_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh', 'cdnjs.cloudflare.com', 'ga.jspm.io'] as const;
/** Style/font hosts: library hosts plus Google Fonts. */
export const STYLE_HOSTS = [...SCRIPT_HOSTS, 'fonts.googleapis.com', 'fonts.gstatic.com'] as const;

export const STATIC_LIMITS = { maxBytes: 5 * 1024 * 1024, warnBytes: 1024 * 1024 };

const MAX_FINDINGS = 10;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'ws:' || u.protocol === 'wss:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const isRemote = (url: string) => /^(https?:|wss?:)?\/\//i.test(url.trim());
const isInline = (url: string) => /^(data:|blob:|#|javascript:void)/i.test(url.trim());

/** Classifies a referenced URL: allowed (on the allowlist, https), local (relative file, not self-contained), or blocked. */
function classify(url: string, hosts: readonly string[]): 'allowed' | 'local' | 'blocked' | 'inline' {
  const u = url.trim();
  if (!u || isInline(u)) return 'inline';
  if (!isRemote(u)) return 'local';
  const host = hostOf(u);
  if (!host) return 'blocked';
  const secure = /^(https:)?\/\//i.test(u);
  return secure && hosts.includes(host) ? 'allowed' : 'blocked';
}

const uniq = (xs: string[]) => [...new Set(xs)].slice(0, MAX_FINDINGS);
const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((v) => v !== undefined);
const snippet = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);

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
  const add = (id: string, label: string, level: CheckLevel, message: string, findings?: string[]) =>
    checks.push({ id, label, level, message, ...(findings?.length ? { findings: uniq(findings) } : {}) });

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (bytes > STATIC_LIMITS.maxBytes) add('size', 'File size', 'fail', `${mb(bytes)} is over the 5 MB limit.`);
  else if (bytes > STATIC_LIMITS.warnBytes) add('size', 'File size', 'warn', `${mb(bytes)}. Aim for under 1 MB so it loads instantly.`);
  else add('size', 'File size', 'pass', `${(bytes / 1024).toFixed(1)} KB.`);

  if (text === null) {
    add('utf8', 'UTF-8 text', 'fail', 'The file is not valid UTF-8 text.');
    return finish(checks, bytes);
  }
  add('utf8', 'UTF-8 text', 'pass', 'Valid UTF-8.');

  // Comments can't execute; ignore them so commented-out code doesn't trigger findings.
  const html = text.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const inlineJs = scripts.filter((m) => !attr(`<s ${m[1]}>`, 'src')).map((m) => m[2]).join('\n');
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).join('\n');

  const hasScript = /<script\b/i.test(html);
  const hasCanvas = /<canvas\b/i.test(html) || /createElement\(\s*['"`]canvas['"`]\s*\)/.test(inlineJs);
  if (!hasScript && !hasCanvas) add('game-markup', 'Looks like a game', 'fail', 'No <script> or <canvas> found.');
  else add('game-markup', 'Looks like a game', 'pass', [hasScript && '<script>', hasCanvas && '<canvas>'].filter(Boolean).join(' + ') + ' found.');

  // External script tags.
  const scriptSrcs = scripts.map((m) => attr(`<s ${m[1]}>`, 'src')).filter((s): s is string => !!s);
  // ES module imports (static and dynamic) inside inline scripts.
  const importUrls = [
    ...[...inlineJs.matchAll(/\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...inlineJs.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]),
  ];
  // Import maps can point bare specifiers at hosts.
  const importMapUrls = scripts
    .filter((m) => /type\s*=\s*["']?importmap/i.test(m[1]))
    .flatMap((m) => [...m[2].matchAll(/["']((?:https?:)?\/\/[^"']+)["']/g)].map((x) => x[1]));
  const scriptRefs = [...scriptSrcs, ...importUrls.filter((u) => isRemote(u) || /^\.{0,2}\//.test(u)), ...importMapUrls];
  const badScripts = scriptRefs.filter((u) => classify(u, SCRIPT_HOSTS) === 'blocked');
  const localScripts = scriptRefs.filter((u) => classify(u, SCRIPT_HOSTS) === 'local');
  if (badScripts.length || localScripts.length) {
    const parts = [];
    if (badScripts.length) parts.push('scripts/imports from hosts outside the allowlist');
    if (localScripts.length) parts.push('references to local files (the game must be one self-contained file)');
    add('script-hosts', 'Script & import hosts', 'fail', `Found ${parts.join(' and ')}.`, [...badScripts, ...localScripts]);
  } else add('script-hosts', 'Script & import hosts', 'pass', scriptRefs.length ? 'All external scripts are on the allowlist.' : 'No external scripts.');

  // Stylesheets / fonts: <link href> and CSS @import / url() to remote hosts.
  const linkHrefs = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((m) => /\srel\s*=\s*["']?[^"'>]*(stylesheet|preload|modulepreload|prefetch|preconnect|icon)/i.test(m[0]))
    .map((m) => attr(m[0], 'href'))
    .filter((s): s is string => !!s);
  const cssUrls = [
    ...[...styles.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/gi)].map((m) => m[1]),
    ...[...styles.matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^'")\s]+)/gi)].map((m) => m[1]),
  ];
  const styleRefs = [...linkHrefs, ...cssUrls];
  const badStyles = styleRefs.filter((u) => classify(u, STYLE_HOSTS) === 'blocked');
  const localStyles = linkHrefs.filter((u) => classify(u, STYLE_HOSTS) === 'local');
  if (badStyles.length || localStyles.length)
    add('style-hosts', 'Stylesheet & font hosts', 'fail', 'Stylesheets/fonts must be inline or from the allowlist.', [...badStyles, ...localStyles]);
  else add('style-hosts', 'Stylesheet & font hosts', 'pass', styleRefs.length ? 'All stylesheets/fonts are on the allowlist.' : 'No external stylesheets.');

  // Sandbox-unsafe patterns (warn: the sandbox blocks them, but the game will misbehave).
  const iframes = [...html.matchAll(/<iframe\b[^>]*>/gi)].map((m) => snippet(m[0]));
  add('iframes', 'Nested frames', iframes.length ? 'warn' : 'pass', iframes.length ? 'Nested <iframe>s are blocked or broken in the game sandbox.' : 'None.', iframes);

  const forms = [...html.matchAll(/<form\b[^>]*\saction\s*=[^>]*>/gi)].map((m) => snippet(m[0]));
  add('forms', 'Form submission', forms.length ? 'warn' : 'pass', forms.length ? 'Forms that submit are blocked in the sandbox (no allow-forms).' : 'None.', forms);

  const js = inlineJs + '\n' + [...html.matchAll(/\son\w+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]).join('\n');
  const popups = [...js.matchAll(/\bwindow\.open\s*\(|(?<![\w.])open\s*\(\s*['"`]https?:/g)].map((m) => snippet(m[0]));
  add('popups', 'Popups', popups.length ? 'warn' : 'pass', popups.length ? 'window.open() is blocked in the sandbox.' : 'None.', popups);

  const topNav = [...js.matchAll(/\b(?:window\.)?(?:top|parent)\s*\.\s*(?:location|document|window)\b|\bwindow\.top\b|\bframeElement\b/g)].map((m) => snippet(m[0]));
  add('top-navigation', 'Frame escape / top navigation', topNav.length ? 'warn' : 'pass', topNav.length ? 'Touching top/parent is blocked; use window.Meshgrounds instead.' : 'None.', topNav);

  const dialogs = [...js.matchAll(/(?<![\w.$])(?:window\.)?(alert|confirm|prompt)\s*\(/g)].map((m) => `${m[1]}()`);
  add('dialogs', 'Blocking dialogs', dialogs.length ? 'warn' : 'pass', dialogs.length ? 'alert/confirm/prompt do nothing in the sandbox.' : 'None.', dialogs);

  // Network calls to non-allowlisted hosts (warn; CSP connect-src is the real enforcement).
  const netUrls = [
    ...[...js.matchAll(/\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]),
    ...[...js.matchAll(/\.open\s*\(\s*['"`][A-Z]+['"`]\s*,\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]),
    ...[...js.matchAll(/new\s+(?:WebSocket|EventSource)\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]),
    ...[...js.matchAll(/sendBeacon\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]),
  ].filter(isRemote);
  const badNet = netUrls.filter((u) => classify(u, SCRIPT_HOSTS) !== 'allowed');
  add('network', 'Network requests', badNet.length ? 'warn' : 'pass', badNet.length ? 'Requests to hosts outside the allowlist will be blocked by the CSP.' : 'No requests to non-allowlisted hosts.', badNet);

  return finish(checks, bytes);
}

function finish(checks: StaticCheck[], bytes: number): StaticReport {
  const status: CheckLevel = checks.some((c) => c.level === 'fail') ? 'fail' : checks.some((c) => c.level === 'warn') ? 'warn' : 'pass';
  return { status, bytes, checks };
}
