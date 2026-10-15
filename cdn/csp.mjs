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

/** The full CSP header for a game document, given the allowed frame-ancestors. */
export const gameCsp = (ancestors) =>
  [
    'sandbox allow-scripts allow-pointer-lock',
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CSP_SOURCES.script.join(' ')}`,
    `style-src 'unsafe-inline' ${CSP_SOURCES.style.join(' ')}`,
    `font-src data: ${CSP_SOURCES.font.join(' ')}`,
    `img-src data: blob: ${CSP_SOURCES.img.join(' ')}`,
    `media-src data: blob:${CSP_SOURCES.media.map((h) => ` ${h}`).join('')}`,
    `connect-src data: blob: ${CSP_SOURCES.connect.join(' ')}`,
    'worker-src blob:',
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
