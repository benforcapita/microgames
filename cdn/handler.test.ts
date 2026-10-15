import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler } from './handler.mjs';
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
    const m = /\/storage\/v1\/object\/authenticated\/games\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (m && GAMES[m[1]]) return new Response(m[2] === 'index.html' ? `<!doctype html><canvas id="${m[1]}"></canvas>` : 'IMG', { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const handle = createHandler({ supabaseUrl: 'http://sb.local', secret: 'sb_secret_x', webOrigins: PORTAL, previewSecret: opts.previewSecret ?? SECRET, fetch: fakeFetch as typeof fetch, now: opts.now });
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
const tok = (id: string, extra: Partial<{ ttlS: number; nowS: number }> = {}, secret = SECRET) => mintPreviewToken(secret, id, extra)!;

describe('SP-6 CDN stage gate', () => {
  it('serves live and proving games', async () => {
    const { get } = harness();
    for (const id of ['live0001', 'prov0001']) {
      const r = await get(`/g/${id}/index.html`);
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
      const r = await get(`/g/${id}/index.html?embed=${encodeURIComponent(PORTAL)}&pt=${tok(id)}`);
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
    assert.equal((await get(`/g/pend0001/index.html?pt=${tok('pend0001')}`)).status, 404);
    assert.equal(mintPreviewToken('', 'pend0001'), null);
  });
  it('a token is useless for a live game it was not needed for, and does not unlock other ids', async () => {
    const { get } = harness();
    assert.equal((await get(`/g/live0001/index.html?pt=${tok('pend0001')}`)).status, 200); // live is public anyway
    assert.equal((await get(`/g/rejt0001/index.html?pt=${tok('pend0001')}`)).status, 404);
  });
  it('?source: CORS only for the portal origin, never *', async () => {
    const { get } = harness();
    const fromPortal = await get('/g/live0001/index.html?source', { origin: PORTAL });
    assert.equal(fromPortal.status, 200);
    assert.equal(fromPortal.headers['access-control-allow-origin'], PORTAL);
    assert.equal(fromPortal.headers.vary, 'Origin');
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:9999']) {
      const r = await get('/g/live0001/index.html?source', { origin });
      assert.equal(r.status, 200);
      assert.equal(r.headers['access-control-allow-origin'], undefined, origin);
    }
    const none = await get('/g/live0001/index.html?source');
    assert.equal(none.headers['access-control-allow-origin'], undefined);
    assert.equal((await get('/g/pend0001/index.html?source', { origin: PORTAL })).status, 404); // same stage rule
    assert.equal((await get(`/g/pend0001/index.html?source&pt=${tok('pend0001')}`, { origin: PORTAL })).headers['access-control-allow-origin'], PORTAL);
  });
  it('stays cookieless: never sets cookies', async () => {
    const { get } = harness();
    for (const p of ['/g/live0001/index.html', `/g/pend0001/index.html?pt=${tok('pend0001')}`, '/g/live0001/index.html?source'])
      assert.equal((await get(p, { cookie: 'sb-access-token=x' })).headers['set-cookie'], undefined);
  });
  it('caches the stage lookup for ~30s', async () => {
    let t = 1_000_000;
    const { get, calls } = harness({ now: () => t });
    await get('/g/live0001/index.html');
    await get('/g/live0001/index.html');
    assert.equal(calls.filter((c) => c.includes('/rest/v1/games')).length, 1);
    t += 31_000;
    await get('/g/live0001/index.html');
    assert.equal(calls.filter((c) => c.includes('/rest/v1/games')).length, 2);
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
