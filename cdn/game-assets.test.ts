import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IMMUTABLE, SHORT_CACHE } from './handler.mjs';
import { gameCsp, ownAssetSource } from './csp.mjs';
import { fixtureHandler } from './fixtures/stub.ts';

const CDN = 'https://cdn.example';
function client(opts: { cdnOrigin?: string } = { cdnOrigin: CDN }) {
  const { handle, calls } = fixtureHandler(opts);
  const req = async (path: string, headers: Record<string, string> = {}, method = 'GET') => {
    let status = 0, body = '';
    const out: Record<string, string> = {};
    const res = {
      writeHead(s: number, h: Record<string, string>) { status = s; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v); },
      end(b?: unknown) { body = b === undefined ? '' : String(b); },
    };
    await handle({ method, url: path, headers } as never, res as never);
    return { status, body, headers: out };
  };
  return { req, calls };
}
const directive = (csp: string, name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

describe('AS-5 game assets', () => {
  it('serves js, mjs, css and wasm with the right type and nosniff', async () => {
    const { req } = client();
    for (const [p, type] of [['game.js', 'text/javascript; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'], ['add.wasm', 'application/wasm'], ['sprite.png', 'image/png']]) {
      const r = await req(`/g/assetgm1/1/${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
      assert.doesNotMatch(r.body, /__mgBoot/, p);
    }
    assert.equal((await req('/g/assetgm1/1/missing.mjs')).status, 404);
    assert.equal((await req('/g/assetgm1/1/x.php')).status, 404);
  });

  it('game CSP allows only its own /g/<game>/<version>/ for script, style, img, media, font, connect', async () => {
    const { req } = client();
    const r = await req('/g/assetgm1/1/index.html');
    assert.equal(r.status, 200);
    const csp = r.headers['content-security-policy'];
    const own = `${CDN}/g/assetgm1/1/`;
    for (const d of ['script-src', 'style-src', 'img-src', 'media-src', 'font-src', 'connect-src']) {
      const tokens = directive(csp, d).split(/\s+/);
      assert.ok(tokens.includes(own), `${d} has own path`);
      assert.ok(!tokens.some((t) => t.startsWith(CDN) && t !== own), `${d} has no other CDN source`);
      assert.ok(!tokens.includes('*') && !tokens.includes(`${CDN}/`) && !tokens.includes(CDN) && !tokens.includes("'self'"), d);
    }
    assert.equal(directive(csp, 'default-src'), "default-src 'none'");
    assert.ok(!csp.includes('othergm1'));
    // frame-ancestors is unchanged from the AS-3 policy
    assert.equal(directive(csp, 'frame-ancestors'), directive(gameCsp("'self'"), 'frame-ancestors').replace("'self'", directive(csp, 'frame-ancestors').slice(16)));
    assert.equal(csp.replaceAll(` ${own}`, ''), gameCsp(directive(csp, 'frame-ancestors').slice(16)));
  });

  it('without an own-asset source the policy is byte-identical to before', () => {
    assert.equal(gameCsp("'none'"), gameCsp("'none'", ''));
    assert.doesNotMatch(gameCsp("'none'"), /\/g\//);
  });

  it('own-asset source is derived from Host when no CDN origin is configured, and dropped if Host is bogus', async () => {
    const { req } = client({});
    const ok = await req('/g/assetgm1/1/index.html', { host: 'cdn.local:4322', 'x-forwarded-proto': 'https' });
    assert.match(ok.headers['content-security-policy'], /script-src [^;]* https:\/\/cdn\.local:4322\/g\/assetgm1\/1\//);
    const bad = await req('/g/assetgm1/1/index.html', { host: 'evil.example/ x' });
    assert.doesNotMatch(bad.headers['content-security-policy'], /\/g\/assetgm1/);
    assert.equal(ownAssetSource('https://cdn.example', 'assetgm1', '..'), '');
    assert.equal(ownAssetSource('javascript:alert(1)', 'assetgm1', '1'), '');
    assert.equal(ownAssetSource('https://cdn.example/sub', 'assetgm1', '1'), '');
    assert.equal(ownAssetSource('https://cdn.example', 'assetgm1', '1'), 'https://cdn.example/g/assetgm1/1/');
  });

  it('CORS: Access-Control-Allow-Origin: null only for the sandbox origin on asset GET/HEAD', async () => {
    const { req } = client();
    for (const method of ['GET', 'HEAD']) {
      const r = await req('/g/assetgm1/1/add.wasm', { origin: 'null' }, method);
      assert.equal(r.status, 200, method);
      assert.equal(r.headers['access-control-allow-origin'], 'null', method);
      assert.match(r.headers.vary, /Origin/);
    }
    for (const origin of ['https://evil.example', 'http://127.0.0.1:4321']) assert.equal((await req('/g/assetgm1/1/add.wasm', { origin })).headers['access-control-allow-origin'], undefined, origin);
    assert.equal((await req('/g/assetgm1/1/add.wasm')).headers['access-control-allow-origin'], undefined);
    // never on the game document, never on other methods, never as a wildcard
    assert.equal((await req('/g/assetgm1/1/index.html', { origin: 'null' })).headers['access-control-allow-origin'], undefined);
    assert.equal((await req('/g/assetgm1/1/add.wasm', { origin: 'null' }, 'POST')).status, 405);
    assert.equal((await req('/g/assetgm1/1/add.wasm', { origin: 'null' }, 'OPTIONS')).headers['access-control-allow-origin'], undefined);
  });

  it('live assets are immutable for a year; proving assets get a short cache', async () => {
    const { req } = client();
    assert.equal((await req('/g/assetgm1/1/game.js')).headers['cache-control'], IMMUTABLE);
    const proving = await req('/g/provgm01/1/game.js');
    assert.equal(proving.status, 200);
    assert.equal(proving.headers['cache-control'], SHORT_CACHE);
    assert.doesNotMatch(proving.headers['cache-control'], /immutable|31536000/);
  });
});
