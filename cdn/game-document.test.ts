// UP-1: the game document is served under its versioned path so relative asset URLs resolve into
// the game's own /g/<id>/<version>/ folder, and its CSP allows exactly that one folder as an extra
// origin. A <version> path segment that is not a plain integer is a 404 — validated at the URL
// boundary, before any PostgREST/Storage lookup (game_assets.version is an int column; a
// non-numeric eq. used to bubble up as a 502).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler } from './handler.mjs';
import { rewriteGameUrl } from './api/g.mjs';
import { mintPreviewToken, readPreviewGrant } from './preview-token.mjs';
import { CSP_SOURCES, previewDocumentPath } from './csp.mjs';

const SECRET = 'test-preview-secret';
const PORTAL = 'http://127.0.0.1:4321';
const CDN = 'http://cdn.test';
const STAGES: Record<string, string> = {
  live0001: 'live', prov0001: 'proving', pend0001: 'pending', prev0001: 'pending', cur00001: 'pending',
};
// A version other than 1 proves the URL comes from the real version lookup, not a hard-coded "1".
const VERSIONS: Record<string, number> = { live0001: 3, prov0001: 3, pend0001: 3, prev0001: 2, cur00001: 1 };
const FILES: Record<string, string> = {
  'live0001/index.html': '<!doctype html><html><head></head><body><canvas id="c"></canvas></body></html>',
  'live0001/thumb.webp': 'THUMB',
  'live0001/3/sprites/hero.png': 'PNGDATA',
  'live0001/3/audio/jump.wav': 'WAVDATA',
  'provgm01/index.html': '<!doctype html><html><body>p</body></html>',
  'pend0001/index.html': '<!doctype html><html><body>CURRENT-OBJECT</body></html>',
  'pend0001/3/index.html': '<!doctype html><html><body>ARCHIVE-V3</body></html>',
  'pend0001/3/game.js': 'owner-script',
  'prev0001/index.html': '<!doctype html><html><body>BUNDLE-V2-FAILED</body></html>',
  'prev0001/1/index.html': '<!doctype html><html><body>BUNDLE-V1</body></html>',
  'prev0001/1/game.js': 'paint();',
  'cur00001/index.html': '<!doctype html><html><body>BUNDLE-V1</body></html>',
};

function harness(opts: { cdnOrigin?: string } = {}) {
  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const eq = (name: string) => (u.searchParams.get(name) ?? '').replace(/^eq\./, '');
    if (u.pathname === '/rest/v1/games') {
      const id = eq('id');
      return Response.json(STAGES[id] ? [{ stage: STAGES[id] }] : []);
    }
    if (u.pathname === '/rest/v1/game_validations') {
      const v = VERSIONS[eq('game_id')];
      return Response.json(v ? [{ version: v }] : []);
    }
    if (u.pathname === '/rest/v1/game_assets') {
      // PostgREST coerces eq.<v> against the int column: a non-numeric value is a 400 — that 400 is
      // exactly what used to turn into a 502 before this validation moved to the path boundary.
      if (!/^\d+$/.test(eq('version'))) return new Response('invalid input syntax for type integer', { status: 400 });
      // A versioned asset is served only with a finalized 'uploaded' row; every fixture object counts.
      const id = eq('game_id');
      const key = `${id}/${eq('version')}/${decodeURIComponent(eq('path'))}`;
      if (FILES[key] === undefined || !STAGES[id]) return Response.json([]);
      const pub = STAGES[id] === 'live' || STAGES[id] === 'proving';
      return Response.json([{
        status: 'uploaded',
        content_at: '2026-10-18T00:00:00.000Z',
        games: { stage: STAGES[id], reviewed_at: pub ? '2026-10-18T01:00:00.000Z' : null },
      }]);
    }
    const m = /\/storage\/v1\/object\/authenticated\/games\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (m && FILES[`${m[1]}/${decodeURIComponent(m[2])}`] !== undefined) return new Response(FILES[`${m[1]}/${decodeURIComponent(m[2])}`]);
    return new Response('nope', { status: 404 });
  };
  const handle = createHandler({
    supabaseUrl: 'http://sb.local',
    secret: 'sb_secret_x',
    webOrigins: PORTAL,
    previewSecret: SECRET,
    cdnOrigin: opts.cdnOrigin ?? CDN,
    fetch: fakeFetch as typeof fetch,
  });
  const get = async (path: string, headers: Record<string, string> = {}) => {
    let status = 0, body = '';
    const out: Record<string, string> = {};
    const res = {
      writeHead(s: number, h: Record<string, string>) { status = s; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v); },
      end(b?: unknown) { body = b === undefined ? '' : String(b); },
    };
    await handle({ method: 'GET', url: path, headers } as never, res as never);
    return { status, body, headers: out };
  };
  return { get, calls };
}

const directive = (csp: string, name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
const KNOWN_HOSTS = [...CSP_SOURCES.script, ...CSP_SOURCES.style, ...CSP_SOURCES.font];

describe('UP-1: the game document is served at its versioned URL', () => {
  it('redirects /g/<id>/index.html to the current version, keeping embed and token params', async () => {
    const { get } = harness();
    const embed = encodeURIComponent(PORTAL);
    const r = await get(`/g/live0001/index.html?embed=${embed}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `/g/live0001/3/index.html?embed=${embed}`);
    const doc = await get(r.headers.location);
    assert.equal(doc.status, 200);
    assert.match(doc.body, /__mgBoot/, 'the runtime is still injected');
  });

  it('the versioned document CSP allows its own /g/<id>/<v>/ folder — and no other origin', async () => {
    const { get } = harness();
    const r = await get('/g/live0001/3/index.html');
    assert.equal(r.status, 200);
    const csp = r.headers['content-security-policy'];
    const own = `${CDN}/g/live0001/3/`;
    for (const name of ['script-src', 'style-src', 'img-src', 'media-src', 'font-src', 'connect-src']) {
      const tokens = directive(csp, name).split(/\s+/).filter(Boolean);
      assert.ok(tokens.includes(own), `${name} allows the own folder: ${csp}`);
      // Every origin token is either the one own-asset path or a known library/font host — no
      // bare CDN origin, no other game path, no other site, no wildcard.
      for (const t of tokens.slice(1)) {
        if (t === own) continue;
        assert.ok(!/^https?:$/.test(t) && !t.startsWith(CDN), `${name} leaks CDN source ${t}`);
        if (/^https?:\/\//.test(t)) assert.ok(KNOWN_HOSTS.includes(t), `${name} has foreign origin ${t}`);
        assert.notEqual(t, '*');
      }
    }
    assert.equal(directive(csp, 'default-src'), "default-src 'none'");
  });

  it('a relative asset URL in the framed document resolves to a 200 on the versioned path', async () => {
    const { get } = harness();
    const doc = await get('/g/live0001/index.html');
    assert.equal(doc.status, 302);
    // The same resolution the browser applies to src="sprites/hero.png" inside the iframe document.
    const resolved = new URL('sprites/hero.png', `${CDN}${doc.headers.location}`);
    assert.equal(resolved.pathname, '/g/live0001/3/sprites/hero.png');
    const asset = await get(resolved.pathname + resolved.search);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['content-type'], 'image/png');
    assert.equal(asset.body, 'PNGDATA');
  });

  it('only the current version has a document; other versions 404 without a storage hit', async () => {
    const { get, calls } = harness();
    for (const p of ['/g/live0001/2/index.html', '/g/live0001/4/index.html', '/g/live0001/v3/index.html']) {
      assert.equal((await get(p)).status, 404, p);
    }
    assert.ok(!calls.some((c) => c.includes('/storage/') && /\/[24]\/index\.html|v3\/index\.html/.test(c)), calls.join(', '));
    assert.equal((await get('/g/live0001/3/index.html')).status, 200);
  });

  it('?source rides the redirect and still serves the raw bundle as text', async () => {
    const { get } = harness();
    const r = await get('/g/live0001/index.html?source');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/g/live0001/3/index.html?source');
    const src = await get(r.headers.location);
    assert.equal(src.status, 200);
    assert.equal(src.headers['content-type'], 'text/plain; charset=utf-8');
    assert.doesNotMatch(src.body, /__mgBoot/);
    assert.match(src.body, /canvas id="c"/);
  });

  it('a preview token keeps working through the redirect for an unpublished game', async () => {
    const { get } = harness();
    const pt = mintPreviewToken(SECRET, 'pend0001')!;
    const embed = encodeURIComponent(PORTAL);
    const r = await get(`/g/pend0001/index.html?embed=${embed}&pt=${pt}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `${previewDocumentPath('pend0001', 3, pt)}?embed=${embed}`);
    const doc = await get(r.headers.location);
    assert.equal(doc.status, 200);
    assert.equal(doc.headers['cache-control'], 'private, no-store');
    assert.match(doc.headers['content-security-policy'], new RegExp(`${CDN.replace(/\./g, '\\.')}/g/pend0001/3/`));
    const script = new URL('game.js', `${CDN}${r.headers.location}`);
    assert.equal(script.search, '');
    assert.equal(script.pathname, `/g/pend0001/3/~pt/${encodeURIComponent(pt)}/game.js`);
    const sibling = await get(script.pathname);
    assert.equal(sibling.status, 200);
    assert.equal(sibling.body, 'owner-script');
    assert.equal(sibling.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(sibling.headers['cache-control'], 'private, no-store');
    const dropped = new URL('game.js', `${CDN}/g/pend0001/3/index.html?embed=${embed}&pt=${pt}`);
    assert.equal(dropped.pathname, '/g/pend0001/3/game.js');
    assert.equal((await get(dropped.pathname)).status, 404);
    // Without a token the redirect target (and the redirect itself) stays 404.
    assert.equal((await get('/g/pend0001/index.html')).status, 404);
    assert.equal((await get('/g/pend0001/3/index.html')).status, 404);
  });

  it('a share token serves the pinned archive, including when that version is still current', async () => {
    const { get } = harness();
    const failed = mintPreviewToken(SECRET, 'prev0001', { version: 1 })!;
    const pinned = await get(`/g/prev0001/1/index.html?pt=${failed}`);
    assert.equal(pinned.status, 200);
    assert.match(pinned.body, /BUNDLE-V1/);
    assert.doesNotMatch(pinned.body, /BUNDLE-V2-FAILED/);
    assert.equal(pinned.headers['cache-control'], 'private, no-store');
    const owner = mintPreviewToken(SECRET, 'prev0001')!;
    const latest = await get(`/g/prev0001/2/index.html?pt=${owner}`);
    assert.equal(latest.status, 200);
    assert.match(latest.body, /BUNDLE-V2-FAILED/);
    assert.doesNotMatch(latest.body, /BUNDLE-V1/);
    for (const path of [
      `/g/prev0001/index.html?pt=${failed}`,
      `/g/prev0001/2/index.html?pt=${failed}`,
      `/g/prev0001/thumb.webp?pt=${failed}`,
      '/g/prev0001/1/index.html',
    ]) {
      const missed = await get(path);
      assert.equal(missed.status, 404, path);
      assert.equal(missed.body.includes('BUNDLE-V1'), false, path);
      assert.equal(missed.body.includes('BUNDLE-V2-FAILED'), false, path);
    }
    const stillCurrent = mintPreviewToken(SECRET, 'pend0001', { version: 3 })!;
    const archived = await get(`/g/pend0001/3/index.html?pt=${stillCurrent}`);
    assert.equal(archived.status, 200);
    assert.match(archived.body, /ARCHIVE-V3/);
    assert.doesNotMatch(archived.body, /CURRENT-OBJECT/);
    const first = mintPreviewToken(SECRET, 'cur00001', { version: 1 })!;
    const only = await get(`/g/cur00001/1/index.html?pt=${first}`);
    assert.equal(only.status, 200);
    assert.match(only.body, /BUNDLE-V1/);
  });

  it('a pinned path token serves sibling files of that version and nothing else', async () => {
    const { get } = harness();
    const token = mintPreviewToken(SECRET, 'prev0001', { version: 1 })!;
    const docPath = previewDocumentPath('prev0001', 1, token);
    const doc = await get(`${docPath}?embed=${encodeURIComponent(PORTAL)}`);
    assert.equal(doc.status, 200);
    assert.match(doc.body, /BUNDLE-V1/);
    assert.equal(doc.headers['cache-control'], 'private, no-store');
    assert.match(doc.headers['content-security-policy'], /\/g\/prev0001\/1\//);
    const script = new URL('game.js', `${CDN}${docPath}`);
    assert.equal(script.pathname, `/g/prev0001/1/~pt/${encodeURIComponent(token)}/game.js`);
    const painted = await get(script.pathname);
    assert.equal(painted.status, 200);
    assert.equal(painted.body, 'paint();');
    assert.equal(painted.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(`/g/prev0001/1/index.html?pt=${token}`)).status, 200);
    assert.equal((await get(`/g/prev0001/1/game.js?pt=${token}`)).status, 200);
    assert.equal((await get('/g/prev0001/1/game.js')).status, 404);
    for (const path of [
      `/g/prev0001/2/~pt/${encodeURIComponent(token)}/index.html`,
      `/g/prev0001/2/~pt/${encodeURIComponent(token)}/game.js`,
      `/g/prev0001/~pt/${encodeURIComponent(token)}/thumb.webp`,
      `/g/prev0001/1/~pt/${encodeURIComponent(token)}`,
      '/g/prev0001/1/~pt/%/index.html',
    ]) {
      const missed = await get(path);
      assert.equal(missed.status, 404, path);
      assert.equal(missed.body.includes('BUNDLE-V1'), false, path);
      assert.equal(missed.body.includes('BUNDLE-V2-FAILED'), false, path);
    }
    const rewritten = rewriteGameUrl(`/?__p=${encodeURIComponent(`prev0001/1/~pt/${token}/index.html`)}&embed=${encodeURIComponent(PORTAL)}`);
    assert.equal(rewritten, `${docPath}?embed=${encodeURIComponent(PORTAL)}`);
    assert.equal((await get(rewritten)).status, 200);
    assert.equal((await get('/g/live0001/3/~pt/not-a-token/sprites/hero.png')).status, 404);
    assert.equal((await get('/g/live0001/3/sprites/hero.png')).status, 200);
  });

  it('thumbnails keep their unversioned route — no redirect', async () => {
    const { get } = harness();
    const r = await get('/g/live0001/thumb.webp');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'THUMB');
  });
});

describe('UP-1: a non-numeric <version> is a 404, not a 502', () => {
  it('is rejected at the URL boundary: no PostgREST and no Storage lookup', async () => {
    const { get, calls } = harness();
    for (const p of [
      '/g/live0001/abc/x.png',
      '/g/live0001/sprites/hero.png', // the pre-fix repro: a document-relative request
      '/g/live0001/v1/game.js',
      '/g/live0001/1x/x.png',
      '/g/live0001/0/x.png',
      '/g/live0001/12345678901/x.png',
    ]) {
      assert.equal((await get(p)).status, 404, p);
    }
    assert.ok(!calls.some((c) => c.includes('/rest/v1/')), `PostgREST was hit: ${calls.join(' | ')}`);
    assert.ok(!calls.some((c) => c.includes('/storage/')), `Storage was hit: ${calls.join(' | ')}`);
  });

  it('a numeric version with no such object is still a plain 404, an existing one still 200', async () => {
    const { get, calls } = harness();
    assert.equal((await get('/g/live0001/9/missing.png')).status, 404);
    assert.equal((await get('/g/live0001/2/sprites/hero.png')).status, 404);
    assert.ok(calls.some((c) => c.includes('/rest/v1/game_assets') && c.includes('version=eq.9')), 'numeric versions still reach the manifest lookup');
    assert.equal((await get('/g/live0001/3/sprites/hero.png')).status, 200);
  });
});

function shareCdn(files: Record<string, string>, version: { current: number }) {
  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.pathname === '/rest/v1/games') return Response.json([{ stage: 'pending' }]);
    if (u.pathname === '/rest/v1/game_validations') return Response.json([{ version: version.current }]);
    const prefix = '/storage/v1/object/authenticated/games/';
    if (u.pathname.startsWith(prefix)) {
      const body = files[decodeURIComponent(u.pathname.slice(prefix.length))];
      if (body !== undefined) return new Response(body);
    }
    return new Response('missing', { status: 404 });
  };
  let clock = 1_700_000_000_000;
  const handle = createHandler({
    supabaseUrl: 'http://sb.local',
    secret: 'sb_secret_x',
    webOrigins: PORTAL,
    previewSecret: SECRET,
    cdnOrigin: CDN,
    fetch: fakeFetch,
    now: () => clock,
  });
  const get = async (path: string) => {
    let status = 0;
    let body = '';
    const res = {
      writeHead(s: number) { status = s; },
      end(b?: unknown) { body = b === undefined ? '' : String(b); },
    };
    await handle({ method: 'GET', url: path, headers: {} } as never, res as never);
    return { status, body };
  };
  return { get, advance(ms: number) { clock += ms; } };
}

describe('a share link plays the version it names', () => {
  it('keeps serving v1 after v2 passes, and does not play the cached v1 bytes for the v2 link', async () => {
    const id = 'cachegm1';
    const files: Record<string, string> = { [`${id}/index.html`]: '<!doctype html><html><body>BUNDLE-V1</body></html>' };
    const version = { current: 1 };
    const { get, advance } = shareCdn(files, version);
    const v1 = mintPreviewToken(SECRET, id, { version: 1 })!;
    const opened = await get(`/g/${id}/1/index.html?pt=${v1}`);
    assert.equal(opened.status, 200);
    assert.match(opened.body, /BUNDLE-V1/);
    files[`${id}/1/index.html`] = '<!doctype html><html><body>BUNDLE-V1</body></html>';
    files[`${id}/index.html`] = '<!doctype html><html><body>BUNDLE-V2</body></html>';
    version.current = 2;
    advance(31_000);
    const v2 = mintPreviewToken(SECRET, id, { version: 2 })!;
    const passed = await get(`/g/${id}/2/index.html?pt=${v2}`);
    assert.equal(passed.status, 200);
    assert.match(passed.body, /BUNDLE-V2/);
    assert.equal(passed.body.includes('BUNDLE-V1'), false);
    const again = await get(`/g/${id}/1/index.html?pt=${v1}`);
    assert.equal(again.status, 200);
    assert.match(again.body, /BUNDLE-V1/);
    assert.equal(again.body.includes('BUNDLE-V2'), false);
  });

  it('does not serve the current bundle when the pinned archive is missing', async () => {
    const id = 'missgm01';
    const files: Record<string, string> = { [`${id}/index.html`]: '<!doctype html><html><body>CURRENT-V2</body></html>' };
    const { get } = shareCdn(files, { current: 2 });
    const pinned = mintPreviewToken(SECRET, id, { version: 1 })!;
    const missed = await get(`/g/${id}/1/index.html?pt=${pinned}`);
    assert.equal(missed.status, 404);
    assert.equal(missed.body.includes('CURRENT-V2'), false);
  });

  it('rejects a share token with the version removed or swapped, and an expired share token', async () => {
    const { get } = harness();
    const nowS = Math.floor(Date.now() / 1000);
    const pinned = mintPreviewToken(SECRET, 'pend0001', { version: 3, nowS })!;
    const [exp, , sig] = pinned.split('.');
    const stripped = `${exp}.${sig}`;
    assert.equal(readPreviewGrant(SECRET, 'pend0001', stripped, nowS), null);
    const owner = mintPreviewToken(SECRET, 'pend0001', { nowS })!;
    assert.equal(readPreviewGrant(SECRET, 'pend0001', owner, nowS)?.kind, 'current');
    const asOwner = await get(`/g/pend0001/3/index.html?pt=${stripped}`);
    assert.equal(asOwner.status, 404);
    assert.equal(asOwner.body.includes('CURRENT-OBJECT'), false);
    assert.equal(asOwner.body.includes('ARCHIVE-V3'), false);
    const realOwner = await get(`/g/pend0001/3/index.html?pt=${owner}`);
    assert.equal(realOwner.status, 200);
    assert.match(realOwner.body, /CURRENT-OBJECT/);

    const v1 = mintPreviewToken(SECRET, 'prev0001', { version: 1, nowS })!;
    const [v1Exp, , v1Sig] = v1.split('.');
    const swapped = `${v1Exp}.2.${v1Sig}`;
    assert.equal(readPreviewGrant(SECRET, 'prev0001', swapped, nowS), null);
    const wrongVersion = await get(`/g/prev0001/2/index.html?pt=${swapped}`);
    assert.equal(wrongVersion.status, 404);
    assert.equal(wrongVersion.body.includes('BUNDLE-V2-FAILED'), false);
    const rightVersion = await get(`/g/prev0001/1/index.html?pt=${v1}`);
    assert.equal(rightVersion.status, 200);
    assert.match(rightVersion.body, /BUNDLE-V1/);

    const stale = mintPreviewToken(SECRET, 'cur00001', { version: 1, nowS: nowS - 601 })!;
    assert.equal(readPreviewGrant(SECRET, 'cur00001', stale, nowS), null);
    const expired = await get(`/g/cur00001/1/index.html?pt=${stale}`);
    assert.equal(expired.status, 404);
    assert.equal(expired.body.includes('BUNDLE-V1'), false);
    const live = mintPreviewToken(SECRET, 'cur00001', { version: 1, nowS })!;
    assert.equal((await get(`/g/cur00001/1/index.html?pt=${live}`)).status, 200);
  });
});
