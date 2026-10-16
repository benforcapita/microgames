// Single source of truth for the game CDN's Content-Security-Policy sources.
// Used by cdn/handler.mjs (to build the header) and src/lib/server/static-check.ts (to derive the
// upload allowlist), so the analyzer can never drift from what the CDN actually enforces.
// Runtime-neutral: plain data + string building, no Node/Deno APIs.

/** Library CDNs allowed for scripts, styles, fonts, images and connect. */
export const LIB_HOSTS = ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://esm.sh', 'https://cdnjs.cloudflare.com', 'https://ga.jspm.io'];

/** Per-directive host sources (keywords like 'unsafe-inline', data:, blob: are added in gameCsp). */
export const CSP_SOURCES = {
  script: [...LIB_HOSTS],
  style: [...LIB_HOSTS, 'https://fonts.googleapis.com'],
  font: [...LIB_HOSTS, 'https://fonts.gstatic.com'],
  img: [...LIB_HOSTS],
  media: [],
  connect: [...LIB_HOSTS],
};

/**
 * CSP source for a game's own versioned asset folder, e.g. `https://cdn.example/g/abc123/v1/`.
 * Path-scoped (trailing slash = prefix match), so it never covers another game or version. Returns '' when
 * any part fails validation, which leaves the policy exactly as it was without own assets.
 */
export function ownAssetSource(cdnOrigin, id, version) {
  let origin;
  try { origin = new URL(String(cdnOrigin)); } catch { return ''; }
  if (!/^https?:$/.test(origin.protocol) || origin.pathname !== '/' || origin.search || origin.username) return '';
  if (!/^[A-Za-z0-9_-]{6,16}$/.test(String(id)) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(String(version))) return '';
  return `${origin.origin}/g/${id}/${version}/`;
}

/** The full CSP header for a game document, given the allowed frame-ancestors and (optionally) its own asset folder. */
export const gameCsp = (ancestors, own = '') => {
  const o = own ? ` ${own}` : '';
  return [
    'sandbox allow-scripts allow-pointer-lock',
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CSP_SOURCES.script.join(' ')}${o}`,
    `style-src 'unsafe-inline' ${CSP_SOURCES.style.join(' ')}${o}`,
    `font-src data: ${CSP_SOURCES.font.join(' ')}${o}`,
    `img-src data: blob: ${CSP_SOURCES.img.join(' ')}${o}`,
    `media-src data: blob:${CSP_SOURCES.media.map((h) => ` ${h}`).join('')}${o}`,
    `connect-src data: blob: ${CSP_SOURCES.connect.join(' ')}${o}`,
    'worker-src blob:',
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
};
