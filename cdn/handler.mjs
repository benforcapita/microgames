// Shared game-CDN request handler: used by scripts/game-cdn.mjs (local / Node) and cdn/api/g.mjs (Vercel).
// Reads bundles from the private Supabase Storage bucket with the secret key; must be served from its own
// cookieless origin, never the portal's.
import fs from 'node:fs';
import { frameAncestors } from './frame-ancestors.mjs';

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SECRET) throw new Error('game-cdn needs PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY');
const WEB_ORIGINS = process.env.MG_WEB_ORIGINS ?? 'http://localhost:* http://127.0.0.1:*';
const BOOT = fs.readFileSync(new URL('./boot.js', import.meta.url), 'utf8');

const LIB_HOSTS = 'https://cdn.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com https://ga.jspm.io';
const gameCsp = (ancestors) => [
  'sandbox allow-scripts allow-pointer-lock',
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${LIB_HOSTS}`,
  `style-src 'unsafe-inline' ${LIB_HOSTS} https://fonts.googleapis.com`,
  `font-src data: ${LIB_HOSTS} https://fonts.gstatic.com`,
  `img-src data: blob: ${LIB_HOSTS}`,
  'media-src data: blob:',
  `connect-src data: blob: ${LIB_HOSTS}`,
  'worker-src blob:',
  "form-action 'none'",
  "base-uri 'none'",
  `frame-ancestors ${ancestors}`,
].join('; ');

const ID_RE = /^[A-Za-z0-9_-]{6,16}$/;
const FILE_RE = /^(index\.html|thumb\.(png|jpg|webp))$/;
const MIME = { html: 'text/html; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

// Small TTL cache so popular games don't hit Storage on every play.
const TTL_MS = 30_000, MAX_ENTRIES = 300;
const cache = new Map();

async function fetchObject(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.body;
  const headers = { apikey: SECRET };
  if (SECRET.startsWith('eyJ')) headers.Authorization = `Bearer ${SECRET}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/games/${key}`, { headers });
  const body = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { body, expires: Date.now() + TTL_MS });
  return body;
}

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

export const handle = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://cdn');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const [, scope, id, file, ...rest] = url.pathname.split('/');
      if (scope !== 'g' || !ID_RE.test(id ?? '') || !FILE_RE.test(file ?? '') || rest.length) return send(res, 404, 'Not found');

      const body = await fetchObject(`${id}/${file}`);
      if (!body) return send(res, 404, 'Not found');

      if (file !== 'index.html') {
        return send(res, 200, body, {
          'Content-Type': MIME[file.split('.').pop()],
          'Content-Security-Policy': "default-src 'none'",
          'Cache-Control': 'public, max-age=300',
        });
      }
      if (url.searchParams.has('source')) {
        return send(res, 200, body, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Access-Control-Allow-Origin': '*',
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
      });
    } catch (err) {
      console.error('[game-cdn]', err);
      send(res, 502, 'Upstream error');
    }
  }
