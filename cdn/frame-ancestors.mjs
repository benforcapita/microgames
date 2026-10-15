// Per-request `frame-ancestors` for the game CDN. CSP host-sources can't express
// "meshgrounds-<anything>-benteam2.vercel.app", so the embedding origin is matched here and echoed
// back exactly. Pure: no env or fs access, so it is unit-testable and shared by Node + Vercel.

export const PREVIEW_ORIGIN_RE = /^https:\/\/meshgrounds-[a-z0-9-]+-benteam2\.vercel\.app$/;

/** Space-separated MG_WEB_ORIGINS -> tokens. */
export function parseOriginList(raw) {
  return typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : [];
}

const hasBadChars = (s) => /[\s\u0000-\u001f\u007f;,'"]/.test(s);

/** An exact `scheme://host[:port]` origin string, or null. No normalisation: input must already be canonical. */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value || hasBadChars(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.origin === value ? value : null;
}

/** Origin of a Referer URL, or null if malformed. */
export function refererOrigin(referer) {
  if (typeof referer !== 'string' || !referer || hasBadChars(referer)) return null;
  let url;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** The candidate if it is an exact (non-wildcard) allow-list entry or a preview origin, else null. */
export function matchEmbedder(candidate, allowList) {
  const origin = normalizeOrigin(candidate);
  if (!origin) return null;
  if (allowList.some((entry) => !entry.includes('*') && entry === origin)) return origin;
  return PREVIEW_ORIGIN_RE.test(origin) ? origin : null;
}

/**
 * Value for the `frame-ancestors` directive. Tries the Origin header, then the Referer's origin, then the
 * portal's `embed` hint (the portal iframe sends no Referer and navigations send no Origin). The first
 * candidate that matches is appended to the configured list; otherwise the configured list is returned
 * unchanged (the current safe default). A forged hint is harmless: the browser checks the real ancestor.
 *
 * @param {{ origin?: unknown, referer?: unknown, embed?: unknown, webOrigins?: string }} opts
 * @returns {string}
 */
export function frameAncestors({ origin, referer, embed, webOrigins } = {}) {
  const list = parseOriginList(webOrigins);
  const base = list.join(' ');
  for (const candidate of [origin, refererOrigin(referer), embed]) {
    const match = matchEmbedder(candidate, list);
    if (match) return list.includes(match) ? base : `${base} ${match}`.trim();
  }
  return base;
}
