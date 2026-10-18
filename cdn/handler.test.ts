import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { createHandler, pickEncoding } from './handler.mjs';
import { mintPreviewToken, verifyPreviewToken, PREVIEW_MAX_TTL_S } from './preview-token.mjs';

const SECRET = 'test-preview-secret';
const PORTAL = 'http://127.0.0.1:4321';
const GAMES: Record<string, string> = { live0001: 'live', prov0001: 'proving', pend0001: 'pending', rejt0001: 'rejected' };

function harness(opts: { previewSecret?: string; now?: () => number } = {}) {
  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/rest/v1/games') {
      const id = (u.searchParams.get('id') ?? '').replace(/^eq\./, '');
      return new Response(JSON.stringify(GAMES[id] ? [{ stage: GAMES[id] }] : []), { status: 200 });
    }
    if (u.pathname === '/rest/v1/game_validations') {
      const id = (u.searchParams.get('game_id') ?? '').replace(/^eq\./, '');
      return new Response(JSON.stringify(GAMES[id] ? [{ version: 1 }] : []), { status: 200 });
    }
    const m = /\/storage\/v1\/object\/authenticated\/games\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (m && GAMES[m[1]]) return new Response(m[2] === 'index.html' ? `<!doctype html><canvas id="${m[1]}"></canvas>` : 'IMG', { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const handle = createHandler({ supabaseUrl: 'http://sb.local', secret: 'sb_secret_x', webOrigins: PORTAL, previewSecret: opts.previewSecret ?? SECRET, fetch: fakeFetch as typeof fetch, now: opts.now });
  const get = async (path: string, headers: Record<string, string> = {}) => {
    let status = 0, body = '', raw: unknown;
    const out: Record<string, string> = {};
    const res = {
      writeHead(s: number, h: Record<string, string>) { status = s; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v); },
      end(b?: unknown) { raw = b; body = b === undefined ? '' : String(b); },
    };
    await handle({ method: 'GET', url: path, headers } as never, res as never);
    return { status, body, raw, headers: out };
  };
  return { get, calls };
}
const tok = (id: string, extra: Partial<{ ttlS: number; nowS: number }> = {}, secret = SECRET) => mintPreviewToken(secret, id, extra)!;

describe('SP-6 CDN stage gate', () => {
  it('serves live and proving games', async () => {
    const { get } = harness();
    for (const id of ['live0001', 'prov0001']) {
      const r = await get(`/g/${id}/1/index.html`);
      assert.equal(r.status, 200, id);
      assert.match(r.body, new RegExp(`canvas id="${id}"`));
      assert.equal((await get(`/g/${id}/thumb.webp`)).status, 200);
    }
  });
  it('pending and rejected are 404 without a token (html, thumb and source)', async () => {
    const { get } = harness();
    for (const id of ['pend0001', 'rejt0001']) {
      for (const f of ['index.html', 'thumb.webp', 'index.html?source']) assert.equal((await get(`/g/${id}/${f}`)).status, 404, `${id}/${f}`);
    }
    assert.equal((await get('/g/unknown01/index.html')).status, 404);
  });
  it('pending and rejected are 200 with a valid owner token, and not publicly cacheable', async () => {
    const { get } = harness();
    for (const id of ['pend0001', 'rejt0001']) {
      const r = await get(`/g/${id}/1/index.html?embed=${encodeURIComponent(PORTAL)}&pt=${tok(id)}`);
      assert.equal(r.status, 200, id);
      assert.equal(r.headers['cache-control'], 'private, no-store');
      assert.equal((await get(`/g/${id}/thumb.webp?pt=${tok(id)}`)).status, 200);
    }
  });
  it('expired, too-long, tampered, wrong-game and wrong-secret tokens are 404', async () => {
    const { get } = harness();
    const nowS = Math.floor(Date.now() / 1000);
    const valid = tok('pend0001');
    const [exp, sig] = valid.split('.');
    const bad = [
      tok('pend0001', { nowS: nowS - 700, ttlS: 600 }), // expired 100s ago
      `${Number(exp) + 1}.${sig}`, // exp changed
      `${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, // sig changed
      tok('rejt0001'), // minted for another game
      tok('pend0001', {}, 'other-secret'),
      `${nowS + 3600}.${sig}`, // claims an hour
      '', 'garbage', `${exp}.`,
    ];
    for (const t of bad) assert.equal((await get(`/g/pend0001/index.html?pt=${encodeURIComponent(t)}`)).status, 404, t);
  });
  it('tokens never verify without CDN_PREVIEW_SECRET', async () => {
    const { get } = harness({ previewSecret: '' });
    assert.equal((await get(`/g/pend0001/1/index.html?pt=${tok('pend0001')}`)).status, 404);
    assert.equal(mintPreviewToken('', 'pend0001'), null);
  });
  it('a token is useless for a live game it was not needed for, and does not unlock other ids', async () => {
    const { get } = harness();
    assert.equal((await get(`/g/live0001/1/index.html?pt=${tok('pend0001')}`)).status, 200); // live is public anyway
    assert.equal((await get(`/g/rejt0001/index.html?pt=${tok('pend0001')}`)).status, 404);
  });
  it('?source: CORS only for the portal origin, never *', async () => {
    const { get } = harness();
    const fromPortal = await get('/g/live0001/1/index.html?source', { origin: PORTAL });
    assert.equal(fromPortal.status, 200);
    assert.equal(fromPortal.headers['access-control-allow-origin'], PORTAL);
    assert.equal(fromPortal.headers.vary, 'Origin, Accept-Encoding');
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:9999']) {
      const r = await get('/g/live0001/1/index.html?source', { origin });
      assert.equal(r.status, 200);
      assert.equal(r.headers['access-control-allow-origin'], undefined, origin);
    }
    const none = await get('/g/live0001/1/index.html?source');
    assert.equal(none.headers['access-control-allow-origin'], undefined);
    assert.equal((await get('/g/pend0001/1/index.html?source', { origin: PORTAL })).status, 404); // same stage rule
    assert.equal((await get(`/g/pend0001/1/index.html?source&pt=${tok('pend0001')}`, { origin: PORTAL })).headers['access-control-allow-origin'], PORTAL);
  });
  it('stays cookieless: never sets cookies', async () => {
    const { get } = harness();
    for (const p of ['/g/live0001/1/index.html', `/g/pend0001/1/index.html?pt=${tok('pend0001')}`, '/g/live0001/1/index.html?source'])
      assert.equal((await get(p, { cookie: 'sb-access-token=x' })).headers['set-cookie'], undefined);
  });
  it('caches the stage lookup for ~30s', async () => {
    let t = 1_000_000;
    const { get, calls } = harness({ now: () => t });
    await get('/g/live0001/1/index.html');
    await get('/g/live0001/1/index.html');
    assert.equal(calls.filter((c) => c.includes('/rest/v1/games')).length, 1);
    t += 31_000;
    await get('/g/live0001/1/index.html');
    assert.equal(calls.filter((c) => c.includes('/rest/v1/games')).length, 2);
  });
});

describe('CDN delivery performance', () => {
  const BIG = `<!doctype html><html><head></head><body><canvas></canvas><script>${'const block = "stack";\n'.repeat(400)}</script></body></html>`;
  function bigHarness() {
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fakeFetch = async (url: string) => {
      calls.push(url);
      if (url.includes('/rest/v1/game_validations')) return new Response(JSON.stringify([{ version: 1 }]));
      if (url.includes('/rest/v1/games')) return new Response(JSON.stringify([{ stage: 'live' }]));
      await gate;
      return new Response(url.endsWith('index.html') ? BIG : 'IMG');
    };
    const handle = createHandler({ supabaseUrl: 'http://sb.local', secret: 'sb_secret_x', webOrigins: PORTAL, fetch: fakeFetch as typeof fetch });
    const get = async (path: string, headers: Record<string, string> = {}) => {
      let status = 0, raw: unknown;
      const out: Record<string, string> = {};
      const res = {
        writeHead(s: number, h: Record<string, string>) { status = s; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v); },
        end(b?: unknown) { raw = b; },
      };
      await handle({ method: 'GET', url: path, headers } as never, res as never);
      return { status, raw: raw as Buffer | undefined, headers: out };
    };
    return { get, calls, release };
  }

  it('compresses game HTML with brotli or gzip per Accept-Encoding, and varies on it', async () => {
    const { get, release } = bigHarness();
    release();
    const br = await get('/g/live0001/1/index.html', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.match(br.headers.vary, /Accept-Encoding/);
    const html = zlib.brotliDecompressSync(br.raw!).toString('utf8');
    assert.match(html, /window\.__mgBoot/);
    assert.ok(br.raw!.length < html.length / 4, `${br.raw!.length} vs ${html.length}`);

    const gz = await get('/g/live0001/1/index.html', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(gz.raw!).toString('utf8'), html);

    const plain = await get('/g/live0001/1/index.html', { 'accept-encoding': 'br;q=0, identity' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.raw!.toString('utf8'), html);
    assert.equal(Number(plain.headers['content-length']), plain.raw!.length);
  });

  it('never compresses images', async () => {
    const { get, release } = bigHarness();
    release();
    const r = await get('/g/live0001/thumb.webp', { 'accept-encoding': 'br' });
    assert.equal(r.headers['content-encoding'], undefined);
    assert.match(r.headers['cache-control'], /max-age=3600/);
  });

  it('answers If-None-Match with 304 and no body (game HTML and thumbnails)', async () => {
    const { get, release } = bigHarness();
    release();
    for (const path of ['/g/live0001/1/index.html', '/g/live0001/thumb.webp']) {
      const first = await get(path);
      assert.ok(first.headers.etag, path);
      const again = await get(path, { 'if-none-match': first.headers.etag });
      assert.equal(again.status, 304, path);
      assert.equal(again.raw, undefined);
      assert.equal(again.headers.etag, first.headers.etag);
      assert.equal((await get(path, { 'if-none-match': '"stale"' })).status, 200);
    }
    // The CSP still rides on the 304 so the browser refreshes it for this embedder.
    const html = await get('/g/live0001/1/index.html');
    const revalidated = await get('/g/live0001/1/index.html', { 'if-none-match': html.headers.etag });
    assert.match(revalidated.headers['content-security-policy'], /frame-ancestors/);
  });

  it('game HTML ETag differs from the raw source ETag (boot.js is part of the document)', async () => {
    const { get, release } = bigHarness();
    release();
    const game = await get('/g/live0001/1/index.html');
    const source = await get('/g/live0001/1/index.html?source');
    assert.notEqual(game.headers.etag, source.headers.etag);
  });

  it('coalesces concurrent cache misses into one Storage fetch', async () => {
    const { get, calls, release } = bigHarness();
    const pending = Array.from({ length: 5 }, () => get('/g/live0001/1/index.html', { 'accept-encoding': 'br' }));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await Promise.all(pending);
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(calls.filter((c) => c.includes('/storage/')).length, 1);
    assert.equal(calls.filter((c) => c.includes('/rest/v1/games')).length, 1);
  });

  it('pickEncoding prefers br, then gzip, and honours q=0', () => {
    assert.equal(pickEncoding('gzip, br'), 'br');
    assert.equal(pickEncoding('gzip'), 'gzip');
    assert.equal(pickEncoding('br;q=0, gzip;q=0.5'), 'gzip');
    assert.equal(pickEncoding('identity'), null);
    assert.equal(pickEncoding(undefined), null);
  });
});

describe('MR-1 reviewed bundle version', () => {
  function reviewHarness(reviewedAt: string) {
    const fakeFetch = async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/rest/v1/games') {
        return Response.json([{ stage: 'proving', reviewed_at: reviewedAt }]);
      }
      if (u.pathname === '/rest/v1/game_validations') {
        return Response.json([
          { version: 2, status: 'passed', finished_at: '2026-10-18T01:00:00.000Z' },
          { version: 1, status: 'passed', finished_at: '2026-10-17T00:00:00.000Z' },
        ]);
      }
      if (u.pathname.includes('/storage/')) return new Response('<!doctype html><canvas id="c"></canvas>');
      return new Response('no', { status: 404 });
    };
    const handle = createHandler({ supabaseUrl: 'http://sb.local', secret: 'sb_secret_x', webOrigins: PORTAL, previewSecret: SECRET, fetch: fakeFetch as typeof fetch });
    const get = async (path: string) => {
      let status = 0;
      const out: Record<string, string> = {};
      const res = {
        writeHead(s: number, h: Record<string, string>) { status = s; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v); },
        end() {},
      };
      await handle({ method: 'GET', url: path, headers: {} } as never, res as never);
      return { status, headers: out };
    };
    return { get };
  }

  it('serves the approved version and 404s a newer pass until reviewed_at moves past it', async () => {
    const held = reviewHarness('2026-10-18T00:00:00.000Z');
    const redir = await held.get('/g/revhold1/index.html');
    assert.equal(redir.status, 302);
    assert.match(redir.headers.location ?? '', /\/g\/revhold1\/1\/index\.html$/);
    assert.equal((await held.get('/g/revhold1/2/index.html')).status, 404);
    assert.equal((await held.get('/g/revhold1/1/index.html')).status, 200);
    const withToken = await held.get(`/g/revhold1/index.html?pt=${tok('revhold1')}`);
    assert.match(withToken.headers.location ?? '', /\/g\/revhold1\/1\/index\.html/);

    const published = reviewHarness('2026-10-18T02:00:00.000Z');
    const next = await published.get('/g/revhold1/index.html');
    assert.match(next.headers.location ?? '', /\/g\/revhold1\/2\/index\.html$/);
    assert.equal((await published.get('/g/revhold1/2/index.html')).status, 200);
  });
});

describe('preview tokens', () => {
  it('expiry is capped at 10 minutes', () => {
    const nowS = 1_000_000;
    const t = mintPreviewToken(SECRET, 'g1', { ttlS: 99_999, nowS })!;
    assert.equal(Number(t.split('.')[0]) - nowS, PREVIEW_MAX_TTL_S);
    assert.ok(verifyPreviewToken(SECRET, 'g1', t, nowS + 599));
    assert.ok(!verifyPreviewToken(SECRET, 'g1', t, nowS + 600));
  });
});
