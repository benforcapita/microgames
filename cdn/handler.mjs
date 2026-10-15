// Shared game-CDN request handler: used by scripts/game-cdn.mjs (local / Node) and cdn/api/g.mjs (Vercel).
// Reads bundles from the private Supabase Storage bucket with the secret key; must be served from its own
// cookieless origin, never the portal's.
//
// SP-6 stage gate: /g/<id>/* is served only while the game is 'proving' or 'live' (server-side lookup,
// cached ~30s). 'pending'/'rejected' (and unknown ids) are 404 unless the request carries `pt=<token>`
// minted by the portal for the owner (cdn/preview-token.mjs, secret CDN_PREVIEW_SECRET). The CDN stays
// cookieless: it never reads or sets cookies; the token travels in the query string.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { frameAncestors, matchEmbedder, parseOriginList } from './frame-ancestors.mjs';
import { verifyPreviewToken } from './preview-token.mjs';
import { gameCsp } from './csp.mjs';
import { injectHead } from './inject.mjs';

const BOOT = fs.readFileSync(new URL('./boot.js', import.meta.url), 'utf8');
export const PUBLIC_STAGES = new Set(['proving', 'live']);

// CSP sources live in ./csp.mjs (shared with the upload static analyzer).


const ID_RE = /^[A-Za-z0-9_-]{6,16}$/;
const FILE_RE = /^(index\.html|thumb(-[a-z0-9]{4,24})?\.(png|jpg|webp))$/;
const MIME = { html: 'text/html; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

// Boot only. The upload preview sets its own capture flag; do not add one here.
const inject = (html) => injectHead(html, BOOT);
// Changes whenever boot.js does, so a redeploy invalidates browser-cached game documents.
const BOOT_TAG = crypto.createHash('sha1').update(BOOT).digest('base64url').slice(0, 8);

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const ENCODERS = {
  // Quality 5 is ~4x smaller than raw HTML at a fraction of q11's CPU; each variant is encoded once per cache entry.
  br: (buf) => brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
  gzip: (buf) => gzip(buf, { level: 6 }),
};
const MIN_COMPRESS_BYTES = 1024;

/** Preferred encoding the client accepts (q=0 excluded), or null. */
export function pickEncoding(acceptEncoding) {
  const accepted = new Set(
    String(acceptEncoding ?? '')
      .toLowerCase()
      .split(',')
      .map((part) => part.trim().split(/\s*;\s*/))
      .filter(([name, q]) => name && !/^q=0(\.0*)?$/.test(q ?? ''))
      .map(([name]) => name),
  );
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : null;
}

/** ETag match per RFC 9110 (weak comparison, `*` matches anything). */
const etagMatches = (header, etag) => !!header && header.split(',').some((t) => { t = t.trim(); return t === '*' || t.replace(/^W\//, '') === etag; });

const base = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...base, ...headers });
  res.end(body);
}

/** Byte-bounded LRU with per-entry TTL. Entries refresh recency on hit; the oldest go first when over budget. */
function lruCache({ now, ttlMs, maxBytes }) {
  const map = new Map();
  let bytes = 0;
  const drop = (key) => {
    const e = map.get(key);
    if (e) (bytes -= e.size), map.delete(key);
  };
  const trim = () => { while (bytes > maxBytes && map.size > 1) drop(map.keys().next().value); };
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (e.expires <= now()) return drop(key), null;
      map.delete(key);
      map.set(key, e);
      return e;
    },
    set(key, value, size = 64) {
      drop(key);
      const e = { key, value, size, expires: now() + ttlMs };
      map.set(key, e);
      bytes += size;
      trim();
      return e;
    },
    /** Account for derived data (encoded variants) stored on an entry after it was cached. */
    grow(e, n) {
      if (map.get(e.key) !== e) return;
      e.size += n;
      bytes += n;
      trim();
    },
  };
}

/** Runs `fn` once per key at a time; concurrent callers share the in-flight promise. */
function coalesce(fn) {
  const inflight = new Map();
  return (key) => {
    let p = inflight.get(key);
    if (!p) {
      p = fn(key).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
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
  // TTL caches so popular games don't hit Storage/PostgREST on every play. The stage TTL is the access-control
  // window (keep it short). Bundle objects are write-once per game id, so they can live longer; the stage gate
  // still runs on every request, so a deleted or rejected game stops being served within TTL_MS.
  const TTL_MS = cfg.ttlMs ?? 30_000;
  const stages = lruCache({ now, ttlMs: TTL_MS, maxBytes: 300 * 64 });
  const objects = lruCache({ now, ttlMs: cfg.objectTtlMs ?? 5 * 60_000, maxBytes: cfg.cacheBytes ?? 96 * 1024 * 1024 });
  const headers = { apikey: SECRET };
  if (SECRET.startsWith('eyJ')) headers.Authorization = `Bearer ${SECRET}`;

  const loadObject = coalesce(async (key) => {
    const res = await doFetch(`${SUPABASE_URL}/storage/v1/object/authenticated/games/${key}`, { headers });
    if (!res.ok) return objects.set(key, null);
    const body = Buffer.from(await res.arrayBuffer());
    const etag = `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`;
    return objects.set(key, { body, etag, variants: new Map() }, body.length);
  });
  /** Cache entry for a bundle object; `entry.value` is null when Storage has no such object. */
  const fetchObject = async (key) => objects.get(key) ?? loadObject(key);

  /** A derived body (injected HTML, compressed bytes) memoized on the object's cache entry. */
  function variant(entry, name, make) {
    const { variants } = entry.value;
    let v = variants.get(name);
    if (!v) {
      v = Promise.resolve(make()).then((buf) => (objects.grow(entry, buf.length), buf));
      v.catch(() => variants.delete(name));
      variants.set(name, v);
    }
    return v;
  }

  const loadStage = coalesce(async (id) => {
    const res = await doFetch(`${SUPABASE_URL}/rest/v1/games?select=stage&id=eq.${encodeURIComponent(id)}`, { headers });
    if (!res.ok) throw new Error(`stage lookup failed: HTTP ${res.status}`);
    const rows = await res.json();
    return stages.set(id, Array.isArray(rows) && rows[0]?.stage ? String(rows[0].stage) : null).value;
  });
  /** The game's stage, or null if it doesn't exist. Throws on lookup errors (not cached, fail closed). */
  async function gameStage(id) {
    const hit = stages.get(id);
    return hit ? hit.value : loadStage(id);
  }

  /** 304 if the client already has `etag`, else 200 with the (possibly compressed) body. */
  async function sendCacheable(req, res, entry, { etag, name, make, compress, headers: h }) {
    if (etagMatches(req.headers['if-none-match'], etag)) return send(res, 304, undefined, { ETag: etag, ...h });
    const raw = make ? await variant(entry, name, make) : entry.value.body;
    const enc = compress && raw.length >= MIN_COMPRESS_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
    const vary = compress ? { Vary: [h.Vary, 'Accept-Encoding'].filter(Boolean).join(', ') } : {};
    if (!enc) return send(res, 200, raw, { ...h, ...vary, ETag: etag, 'Content-Length': raw.length });
    const body = await variant(entry, `${name}.${enc}`, () => ENCODERS[enc](raw));
    send(res, 200, body, { ...h, ...vary, ETag: etag, 'Content-Encoding': enc, 'Content-Length': body.length });
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

      const entry = await fetchObject(`${id}/${file}`);
      if (!entry.value) return send(res, 404, 'Not found');
      const { body, etag } = entry.value;

      if (file !== 'index.html') {
        // Thumbnails are write-once per path; images are already compressed.
        return sendCacheable(req, res, entry, {
          etag, name: 'raw', make: null, compress: false,
          headers: {
            'Content-Type': MIME[file.split('.').pop()],
            'Content-Security-Policy': "default-src 'none'",
            'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
            ...privateCache,
          },
        });
      }
      if (url.searchParams.has('source')) {
        // No wildcard CORS: only the portal origin may read the source cross-origin.
        const allowed = matchEmbedder(req.headers.origin, portalOrigins);
        return sendCacheable(req, res, entry, {
          etag, name: 'raw', make: null, compress: true,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Security-Policy': "sandbox; default-src 'none'",
            ...(allowed ? { 'Access-Control-Allow-Origin': allowed } : {}),
            Vary: 'Origin',
            ...privateCache,
          },
        });
      }
      // no-cache: the browser revalidates every play (the CSP depends on the embedder), but a repeat play or
      // Restart is a 304 instead of re-downloading up to 5 MB.
      return sendCacheable(req, res, entry, {
        etag: `"${etag.slice(1, -1)}.${BOOT_TAG}"`, name: 'game', make: () => Buffer.from(inject(body.toString('utf8'))), compress: true,
        headers: {
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
        },
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
