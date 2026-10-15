// Cookieless static origin for user-submitted game bundles.
// Runs on a different origin than the portal so arbitrary game JS can never touch portal cookies,
// storage, or DOM — even when someone opens a bundle URL directly in a tab.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.MG_CDN_PORT ?? 4322);
const GAMES_DIR = path.join(path.resolve(process.env.MG_DATA_DIR ?? path.join(root, 'data')), 'games');
const WEB_ORIGINS = process.env.MG_WEB_ORIGINS ?? 'http://localhost:* http://127.0.0.1:*';
const BOOT = fs.readFileSync(path.join(root, 'cdn', 'boot.js'), 'utf8');

const LIB_HOSTS = 'https://cdn.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com https://ga.jspm.io';
const GAME_CSP = [
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
  `frame-ancestors ${WEB_ORIGINS}`,
].join('; ');

const ID_RE = /^[A-Za-z0-9_-]{6,16}$/;
const THUMB_RE = /^thumb\.(png|jpg|webp)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

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

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://cdn');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    const [, scope, id, file] = url.pathname.split('/');
    if (scope !== 'g' || !ID_RE.test(id ?? '')) return send(res, 404, 'Not found');

    if (file === 'index.html') {
      const p = path.join(GAMES_DIR, id, 'index.html');
      if (!fs.existsSync(p)) return send(res, 404, 'Not found');
      const html = fs.readFileSync(p, 'utf8');
      if (url.searchParams.has('source')) {
        return send(res, 200, html, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Access-Control-Allow-Origin': '*',
        });
      }
      return send(res, 200, inject(html), {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': GAME_CSP,
        'Cache-Control': 'no-cache',
      });
    }

    const thumb = file?.match(THUMB_RE);
    if (thumb) {
      const p = path.join(GAMES_DIR, id, file);
      if (!fs.existsSync(p)) return send(res, 404, 'Not found');
      return send(res, 200, fs.readFileSync(p), {
        'Content-Type': MIME[thumb[1]],
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'public, max-age=86400',
      });
    }
    send(res, 404, 'Not found');
  })
  .listen(PORT, () => console.log(`[game-cdn] serving ${GAMES_DIR} on http://localhost:${PORT}`));
