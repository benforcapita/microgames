// Shared by the server (/api/events validation) and the browser (site-events sender).
// Isomorphic: no node: imports, so the client bundle can use the exact same detector.

const DECODE_PASSES = 3;

/** The string raw, then after each of up to 3 percent-decode passes. Malformed sequences are tolerated, never thrown. */
export function decodeVariants(s: string): string[] {
  const out = [s];
  let cur = s;
  for (let i = 0; i < DECODE_PASSES && /%[0-9a-f]{2}/i.test(cur); i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      next = cur.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
        try {
          return decodeURIComponent(m);
        } catch {
          return m.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
        }
      });
    }
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/** Strict dotted-quad IPv4 (each part 0-255, up to 3 digits). */
function isIPv4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Parse-based IPv6 check (RFC 4291 text forms): full, '::'-compressed, and IPv4-embedded (::ffff:1.2.3.4). */
export function isIPv6(s: string): boolean {
  if (!s.includes(':') || s.length > 45) return false;
  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groups = (h: string) => (h === '' ? [] : h.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...tail];
  let units = 0;
  for (let i = 0; i < all.length; i++) {
    const g = all[i];
    if (i === all.length - 1 && g.includes('.')) {
      if (!isIPv4(g)) return false;
      units += 2;
    } else if (/^[0-9a-f]{1,4}$/i.test(g)) units += 1;
    else return false;
  }
  return halves.length === 2 ? units <= 7 : units === 8;
}

const EMAIL = /[^\s@"'<>()[\]{},;:]+@[^\s@"'<>()[\]{},;:]+\.[^\s@"'<>()[\]{},;:.]{2,}/u;
// Obfuscated "@". Bracketed forms ("ben[at]example.com", "(at)", "{at}", "<at>") match any domain.
// A bare " at " also appears in stack traces ("at main.js:3"), so it needs " dot " or a common email TLD.
const DOT = String.raw`(?:\s*\.\s*|\s+dot\s+|\s*[[({<]\s*dot\s*[\])}>]\s*)`;
const EMAIL_BRACKET_AT = new RegExp(String.raw`[\p{L}\p{N}._%+-]+\s*[[({<]\s*at\s*[\])}>]\s*[\p{L}\p{N}-]+(?:${DOT}[\p{L}\p{N}-]+)+`, 'iu');
const EMAIL_WORD_AT = new RegExp(
  String.raw`[\p{L}\p{N}._%+-]+\s+at\s+[\p{L}\p{N}-]+(?:\s+dot\s+[\p{L}\p{N}-]+|(?:${DOT}[\p{L}\p{N}-]+)*\.(?:com|net|org|io|co|me|dev|app|ai|edu|gov|info|biz|il|uk|de|fr|es|it|nl|ru|in|jp|ca|au|us|br)\b)`,
  'iu',
);
const IPV4_DOTTED = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/;

function hasIpv6(s: string): boolean {
  // Candidate tokens: hex digits, colons, dots (for ::ffff:1.2.3.4); a %zone and surrounding dots are stripped.
  for (const raw of s.split(/[^0-9a-f:.%]+/i)) {
    if (!raw.includes(':')) continue;
    const token = raw.replace(/%.*$/, '').replace(/^\.+|\.+$/g, '');
    // Require a digit: words like "Foo::bar" parse as hex-only IPv6 ("::ba") but are not addresses.
    if (/\d/.test(token) && isIPv6(token)) return true;
  }
  return false;
}

/** A value that is exactly 8-10 digits in the IPv4 integer range (16777216 = 1.0.0.0 ... 4294967295). */
function isIpv4Int(v: string): boolean {
  if (!/^\d{8,10}$/.test(v)) return false;
  const n = Number(v);
  return n >= 16_777_216 && n <= 4_294_967_295;
}

/** URL parts where a bare integer can only be an address: whole path segments and whole query-param values. */
function urlParts(path: string): string[] {
  const [beforeHash] = path.split('#');
  const q = beforeHash.indexOf('?');
  const pathname = q < 0 ? beforeHash : beforeHash.slice(0, q);
  const query = q < 0 ? '' : beforeHash.slice(q + 1);
  const values = query ? query.split('&').map((kv) => kv.slice(kv.indexOf('=') + 1)) : [];
  return [...pathname.split('/'), ...values];
}

/**
 * Decimal-integer IPv4 ("3405803777") only when it is a whole path segment or query-param value.
 * Free text (messages, details) is not checked for this: 10-digit Unix timestamps are common there.
 */
export function hasUrlIntIpv4(path: string): boolean {
  return decodeVariants(path).some((v) => urlParts(v).some((part) => decodeVariants(part.replace(/\+/g, ' ')).some(isIpv4Int)));
}

/** Client side: replace such path segments with [redacted] (the client never sends a query string). */
export function redactUrlIntIpv4(pathname: string): string {
  return pathname.split('/').map((seg) => (decodeVariants(seg).some(isIpv4Int) ? REDACTED : seg)).join('/');
}

/** True if the string, raw or after up to 3 percent-decodes, holds an email (incl. "at" forms) or a dotted IPv4 / IPv6 address. */
export function containsPii(s: string): boolean {
  return decodeVariants(s).some(
    (v) => EMAIL.test(v) || EMAIL_BRACKET_AT.test(v) || EMAIL_WORD_AT.test(v) || IPV4_DOTTED.test(v) || hasIpv6(v),
  );
}

export const REDACTED = '[redacted]';

/**
 * Same detector, used to clean instead of reject: every whitespace-separated token that holds PII becomes
 * [redacted]; if PII still spans tokens (e.g. "ben at example dot com"), the whole string is redacted.
 */
export function redactPii(s: string): string {
  if (!containsPii(s)) return s;
  const out = s.replace(/\S+/g, (t) => (containsPii(t) ? REDACTED : t));
  return containsPii(out) ? REDACTED : out;
}

/* ---------- UTF-8 / code-point safe text ---------- */

const enc = new TextEncoder();
export const utf8Bytes = (s: string): number => enc.encode(s).length;

/** Lone surrogates (invalid UTF-16; Postgres jsonb rejects them) become U+FFFD. */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * Truncates to at most maxBytes of UTF-8 (and maxUnits UTF-16 units, if given) without splitting a code point.
 * A cut string ends with "…" inside the limit. Lone surrogates are made well-formed first.
 */
export function truncateText(input: string, maxBytes: number, maxUnits = Infinity): string {
  const s = wellFormed(input);
  if (s.length <= maxUnits && utf8Bytes(s) <= maxBytes) return s;
  const ELL = '…'; // 3 bytes, 1 unit
  let bytes = 0;
  let units = 0;
  let out = '';
  for (const cp of s) {
    const b = utf8Bytes(cp);
    if (bytes + b + 3 > maxBytes || units + cp.length + 1 > maxUnits) break;
    out += cp;
    bytes += b;
    units += cp.length;
  }
  return out + ELL;
}
