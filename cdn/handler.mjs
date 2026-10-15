// Shared game-CDN request handler: used by scripts/game-cdn.mjs (local / Node) and cdn/api/g.mjs (Vercel).
// Reads bundles from the private Supabase Storage bucket with the secret key; must be served from its own
// cookieless origin, never the portal's.
//
// SP-6 stage gate: /g/<id>/* is served only while the game is 'proving' or 'live' (server-side lookup,
// cached ~30s). 'pending'/'rejected' (and unknown ids) are 404 unless the request carries `pt=<token>`
// minted by the portal for the owner (cdn/preview-token.mjs, secret CDN_PREVIEW_SECRET). The CDN stays
// cookieless: it never reads or sets cookies; the token travels in the query string.
import fs from 'node:fs';
import { frameAncestors, matchEmbedder, parseOriginList } from './frame-ancestors.mjs';
import { verifyPreviewToken } from './preview-token.mjs';
import { gameCsp } from './csp.mjs';

const BOOT = fs.readFileSync(new URL('./boot.js', import.meta.url), 'utf8');
export const PUBLIC_STAGES = new Set(['proving', 'live']);

// CSP sources live in ./csp.mjs (shared with the upload static analyzer).


const ID_RE = /^[A-Za-z0-9_-]{6,16}$/;
const FILE_RE = /^(index\.html|thumb(-[a-z0-9]{4,24})?\.(png|jpg|webp))$/;
const MIME = { html: 'text/html; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

// Boot only. The upload preview sets its own capture flag; do not add one here.
function inject(html) {
  const tag = `<script>${BOOT}</script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + tag);
  const lead = html.match(/^\s*(<!doctype[^>]*>)?\s*(<html[^>]*>)?/i)[0];
  return lead + tag + html.slice(lead.length);
}

const base = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...base, ...headers });
  res.end(body);
}

/**
 * @param {{ supabaseUrl: string, secret: string, webOrigins?: string, previewSecret?: string,
 *           fetch?: typeof fetch, now?: () => number, ttlMs?: number }} cfg
 */
export function createHandler(cfg) {
  const SUPABASE_URL = cfg.supabaseUrl.replace(/\/$/, '');
  const SECRET = cfg.secret;
  const WEB_ORIGINS = cfg.webOrigins ?? 'http://localhost:* http://127.0.0.1:*';
  const PREVIEW_SECRET = cfg.previewSecret || '';
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? Date.now;
  // Small TTL caches so popular games don't hit Storage/PostgREST on every play.
  const TTL_MS = cfg.ttlMs ?? 30_000, MAX_ENTRIES = 300;
  const objects = new Map();
  const stages = new Map();
  const headers = { apikey: SECRET };
  if (SECRET.startsWith('eyJ')) headers.Authorization = `Bearer ${SECRET}`;
  const remember = (map, key, value) => {
    if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value);
    map.set(key, { value, expires: now() + TTL_MS });
    return value;
  };
  const cached = (map, key) => {
    const hit = map.get(key);
    return hit && hit.expires > now() ? hit : null;
  };

  async function fetchObject(key) {
    const hit = cached(objects, key);
    if (hit) return hit.value;
    const res = await doFetch(`${SUPABASE_URL}/storage/v1/object/authenticated/games/${key}`, { headers });
    return remember(objects, key, res.ok ? Buffer.from(await res.arrayBuffer()) : null);
  }

  /** The game's stage, or null if it doesn't exist. Throws on lookup errors (not cached, fail closed). */
  async function gameStage(id) {
    const hit = cached(stages, id);
    if (hit) return hit.value;
    const res = await doFetch(`${SUPABASE_URL}/rest/v1/games?select=stage&id=eq.${encodeURIComponent(id)}`, { headers });
    if (!res.ok) throw new Error(`stage lookup failed: HTTP ${res.status}`);
    const rows = await res.json();
    return remember(stages, id, Array.isArray(rows) && rows[0]?.stage ? String(rows[0].stage) : null);
  }

  const portalOrigins = parseOriginList(WEB_ORIGINS);

  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://cdn');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const [, scope, id, file, ...rest] = url.pathname.split('/');
      if (scope !== 'g' || !ID_RE.test(id ?? '') || !FILE_RE.test(file ?? '') || rest.length) return send(res, 404, 'Not found');

      const stage = await gameStage(id);
      const preview = !PUBLIC_STAGES.has(stage ?? '') && stage !== null && verifyPreviewToken(PREVIEW_SECRET, id, url.searchParams.get('pt'));
      if (!stage || (!PUBLIC_STAGES.has(stage) && !preview)) return send(res, 404, 'Not found');
      const privateCache = preview ? { 'Cache-Control': 'private, no-store' } : null;

      const body = await fetchObject(`${id}/${file}`);
      if (!body) return send(res, 404, 'Not found');

      if (file !== 'index.html') {
        return send(res, 200, body, {
          'Content-Type': MIME[file.split('.').pop()],
          'Content-Security-Policy': "default-src 'none'",
          'Cache-Control': 'public, max-age=300',
          ...privateCache,
        });
      }
      if (url.searchParams.has('source')) {
        // No wildcard CORS: only the portal origin may read the source cross-origin.
        const allowed = matchEmbedder(req.headers.origin, portalOrigins);
        return send(res, 200, body, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          ...(allowed ? { 'Access-Control-Allow-Origin': allowed } : {}),
          Vary: 'Origin',
          ...privateCache,
        });
      }
      return send(res, 200, inject(body.toString('utf8')), {
        'Content-Type': MIME.html,
        'Content-Security-Policy': gameCsp(frameAncestors({
          origin: req.headers.origin,
          referer: req.headers.referer,
          embed: url.searchParams.get('embed'),
          webOrigins: WEB_ORIGINS,
        })),
        'Cache-Control': 'no-cache',
        Vary: 'Origin, Referer',
        ...privateCache,
      });
    } catch (err) {
      console.error('[game-cdn]', err instanceof Error ? err.message : err);
      send(res, 502, 'Upstream error');
    }
  };
}

let defaultHandler = null;
/** Env-configured handler (scripts/game-cdn.mjs and cdn/api/g.mjs). */
export const handle = (req, res) => {
  if (!defaultHandler) {
    const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
    const secret = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !secret) throw new Error('game-cdn needs PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY');
    defaultHandler = createHandler({ supabaseUrl, secret, webOrigins: process.env.MG_WEB_ORIGINS, previewSecret: process.env.CDN_PREVIEW_SECRET });
  }
  return defaultHandler(req, res);
};
