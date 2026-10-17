import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler, isTraversal, IMMUTABLE } from './handler.mjs';
import { mintPreviewToken } from './preview-token.mjs';

const SECRET = 'test-preview-secret';
const PORTAL = 'http://127.0.0.1:4321';
const STAGES: Record<string, string> = { live0001: 'live', pend0001: 'pending' };
const FILES: Record<string, string> = {
  'index.html': '<!doctype html><html><head></head><body>lvl</body></html>',
  '1/sprites/hero.png': 'PNGDATA',
  '1/audio/jump.ogg': 'OGGDATA',
  '1/fonts/pixel.woff2': 'WOFF2',
  '1/data/level.json': '{"a":1}',
  '1/readme.txt': 'hi',
  '1/sprites/hidden.png': 'SECRET',
  '1/evil.php': '<?php',
  '1/page.svgz': 'x',
};

function harness() {
  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/rest/v1/games') {
      const id = (u.searchParams.get('id') ?? '').replace(/^eq\./, '');
      return new Response(JSON.stringify(STAGES[id] ? [{ stage: STAGES[id] }] : []));
    }
    if (u.pathname === '/rest/v1/game_validations') {
      const id = (u.searchParams.get('game_id') ?? '').replace(/^eq\./, '');
      return new Response(JSON.stringify(STAGES[id] ? [{ version: 1 }] : []), { status: 200 });
    }
    if (u.pathname === '/rest/v1/game_assets') {
      const id = (u.searchParams.get('game_id') ?? '').replace(/^eq\./, '');
      const version = (u.searchParams.get('version') ?? '').replace(/^eq\./, '');
      const assetPath = decodeURIComponent((u.searchParams.get('path') ?? '').replace(/^eq\./, ''));
      const status = id === 'live0001' && version === '1' && assetPath === 'sprites/hidden.png' ? 'rejected' : null;
      return new Response(JSON.stringify(status ? [{ status }] : []), { status: 200 });
    }
    const m = /\/storage\/v1\/object\/authenticated\/games\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (m && STAGES[m[1]] && FILES[m[2]] !== undefined) return new Response(FILES[m[2]]);
    return new Response('nope', { status: 404 });
  };
  const handle = createHandler({ supabaseUrl: 'http://sb.local', secret: 'sb_secret_x', webOrigins: PORTAL, previewSecret: SECRET, fetch: fakeFetch as typeof fetch });
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

describe('AS-3 versioned asset serving', () => {
  it('sets Content-Type from the extension allowlist', async () => {
    const { get } = harness();
    const cases: Record<string, string> = {
      'sprites/hero.png': 'image/png',
      'audio/jump.ogg': 'audio/ogg',
      'fonts/pixel.woff2': 'font/woff2',
      'data/level.json': 'application/json; charset=utf-8',
      'readme.txt': 'text/plain; charset=utf-8',
    };
    for (const [p, type] of Object.entries(cases)) {
      const r = await get(`/g/live0001/1/${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
    }
  });
  it('does not serve an object whose manifest row is rejected', async () => {
    const { get, calls } = harness();
    const hidden = await get('/g/live0001/1/sprites/hidden.png');
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body, 'Not found');
    assert.ok(!calls.some((c) => c.includes('hidden.png') && c.includes('/storage/')));
    const shown = await get('/g/live0001/1/sprites/hero.png');
    assert.equal(shown.status, 200);
    assert.equal(shown.body, 'PNGDATA');
  });
  it('404s extensions outside the allowlist (even if the object exists)', async () => {
    const { get, calls } = harness();
    for (const p of ['evil.php', 'page.svgz', 'noext', 'index.htm', 'x.exe', 'x.sh'])
      assert.equal((await get(`/g/live0001/1/${p}`)).status, 404, p);
    assert.ok(!calls.some((c) => c.includes('evil.php')), 'disallowed paths never reach Storage');
  });
  it('404s missing assets, unknown games and gated stages', async () => {
    const { get } = harness();
    assert.equal((await get('/g/live0001/1/missing.png')).status, 404);
    assert.equal((await get('/g/live0001/v2/sprites/hero.png')).status, 404);
    assert.equal((await get('/g/unknown01/1/sprites/hero.png')).status, 404);
    assert.equal((await get('/g/pend0001/1/sprites/hero.png')).status, 404);
  });
  it('keeps the preview token gate (private, no-store) for unreleased games', async () => {
    const { get } = harness();
    const r = await get(`/g/pend0001/1/sprites/hero.png?pt=${mintPreviewToken(SECRET, 'pend0001')}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
  it('sends nosniff and a long immutable cache on versioned assets', async () => {
    const { get } = harness();
    for (const p of ['sprites/hero.png', 'audio/jump.ogg', 'fonts/pixel.woff2', 'data/level.json', 'readme.txt']) {
      const r = await get(`/g/live0001/1/${p}`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
      assert.equal(r.headers['cache-control'], IMMUTABLE, p);
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    }
    assert.equal((await get('/g/live0001/1/missing.png')).headers['x-content-type-options'], 'nosniff');
  });
  it('injects the runtime into HTML only, never into assets', async () => {
    const { get } = harness();
    const html = await get('/g/live0001/1/index.html');
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(html.body, /__mgBoot/);
    assert.equal(html.headers['cache-control'], 'no-cache');
    assert.match(html.headers['content-security-policy'], /frame-ancestors/);
    for (const p of ['sprites/hero.png', 'data/level.json', 'readme.txt']) {
      const r = await get(`/g/live0001/1/${p}`);
      assert.doesNotMatch(r.body, /__mgBoot|<script/, p);
      assert.equal(r.body, `${FILES[`1/${p}`]}`);
    }
  });
  it('rejects .., backslash and encoded / double-encoded traversal', async () => {
    const { get, calls } = harness();
    const bad = [
      '/g/live0001/1/../1/readme.txt',
      '/g/live0001/../live0001/1/readme.txt',
      '/g/live0001/1/./readme.txt',
      '/g/live0001/1/sprites\\..\\readme.txt',
      '/g/live0001/1\\readme.txt',
      '/g/live0001/1/%2e%2e/1/readme.txt',
      '/g/live0001/1/%2E%2E/1/readme.txt',
      '/g/live0001/1/.%2e/readme.txt',
      '/g/live0001/1/sprites%2fhero.png',
      '/g/live0001/1/sprites%2Fhero.png',
      '/g/live0001/1/sprites%5chero.png',
      '/g/live0001/1/%252e%252e/readme.txt',
      '/g/live0001/1/sprites%252fhero.png',
      '/g/live0001/1/sprites%255chero.png',
      '/g/live0001/1/.hidden.txt',
      '/g/live0001/1//readme.txt',
      '/g/live0001/1/readme.txt%00.png',
    ];
    for (const p of bad) assert.equal((await get(p)).status, 404, p);
    assert.equal(calls.filter((c) => c.includes('/storage/')).length, 0, 'nothing reached Storage');
    assert.ok(isTraversal('/a/%252E%252e/b') && isTraversal('a\\b') && !isTraversal('/g/live0001/1/readme.txt'));
  });
  it('legacy index.html / thumb routes are unchanged', async () => {
    const { get } = harness();
    assert.equal((await get('/g/live0001/thumb.webp')).status, 404); // no such object here, still routed
    assert.equal((await get('/g/live0001/evil.js')).status, 404);
  });
});
