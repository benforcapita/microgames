import { parseCookieHeader } from '@supabase/ssr';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Auth user id from a JWT `sub`, or null for an anonymous visitor or an unusable claim. */
export function sessionUserId(sub: unknown): string | null {
  if (typeof sub !== 'string' || !UUID.test(sub)) return null;
  return sub.toLowerCase();
}

// The cookie name supabase-js/ssr use for the session: `sb-<ref>-auth-token`, plus
// its `.0`/`.1`/… chunk cookies. The PKCE neighbours (`-code-verifier`,
// `-flows-code-verifier`, `-flow-<id>-code-verifier`) cannot match the anchored tail.
const AUTH_COOKIE_NAME = /^(sb-[^=;\s]*auth-token)(?:\.\d+)?$/;

// The segment shape auth-js's decodeJWT accepts (BASE64URL_REGEX).
const JWT_SEGMENT = /^([a-z0-9_-]{4})*($|[a-z0-9_-]{3}$|[a-z0-9_-]{2}$)$/i;

/** Three base64url segments, header and payload decoding to JSON objects. */
function wellFormedJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => JWT_SEGMENT.test(part))) return false;
  return parts.slice(0, 2).every((segment) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded);
  });
}

/**
 * Mirrors what the ssr storage adapter hands auth-js: `base64-`-prefixed values are
 * base64url-decoded first; anything else is used raw (the legacy encoding). The
 * decoded text must be a session object whose access_token is a well-formed JWT.
 */
function parseableSessionValue(value: string): boolean {
  let json = value;
  if (value.startsWith('base64-')) {
    try {
      json = Buffer.from(value.slice('base64-'.length), 'base64url').toString('utf8');
    } catch {
      return false;
    }
  }
  let session: unknown;
  try {
    session = JSON.parse(json);
  } catch {
    return false;
  }
  if (typeof session !== 'object' || session === null || !('access_token' in session)) return false;
  const token: unknown = session.access_token;
  return typeof token === 'string' && wellFormedJwt(token);
}

/**
 * True when the request carries a Supabase auth cookie (including chunked cookies)
 * whose combined value parses to a session JSON holding a well-formed JWT — the
 * only case in which getClaims can possibly yield claims. PKCE code-verifier
 * cookies never count. "Parseable" is not "verified": a parseable cookie merely
 * reaches getClaims; the claims it returns remain the only source of user id.
 */
export function parseableAuthCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  const cookies = parseCookieHeader(cookieHeader);
  const bases = new Set<string>();
  for (const { name } of cookies) {
    const match = AUTH_COOKIE_NAME.exec(name);
    if (match) bases.add(match[1]);
  }
  for (const base of bases) {
    // ssr's combineChunks: a non-empty bare cookie wins outright; otherwise the
    // .0, .1, … chunks join in index order until the first missing or empty one.
    const bare = cookies.find((cookie) => cookie.name === base)?.value;
    let combined: string | null;
    if (bare) {
      combined = bare;
    } else {
      const chunks: string[] = [];
      for (let i = 0; ; i += 1) {
        const chunk = cookies.find((cookie) => cookie.name === `${base}.${i}`)?.value;
        if (!chunk) break;
        chunks.push(chunk);
      }
      combined = chunks.length ? chunks.join('') : null;
    }
    if (combined !== null && parseableSessionValue(combined)) return true;
  }
  return false;
}
