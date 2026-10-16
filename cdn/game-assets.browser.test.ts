// AS-5 end-to-end: real Chromium, real CSP enforcement, real sandboxed iframe (opaque origin), local servers only.
// Skips cleanly when no Playwright browser is installed (CI only runs check/build).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fixtureHandler } from './fixtures/stub.ts';

let chromium: typeof import('@playwright/test').chromium | null = null;
try { ({ chromium } = await import('@playwright/test')); } catch { chromium = null; }
let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>> | null = null;
try { browser = chromium ? await chromium.launch({ args: ['--disable-site-isolation-trials'] }) : null; } catch { browser = null; }

describe('AS-5 game loads its own assets under the enforced CSP (Chromium)', { skip: browser ? false : 'no Playwright Chromium available' }, () => {
  const servers: http.Server[] = [];
  let cdn = '', player = '';
  const listen = (fn: http.RequestListener) => new Promise<string>((ok) => {
    const s = http.createServer(fn).listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    servers.push(s);
  });
  const requests: string[] = [];

  before(async () => {
    let handle: http.RequestListener = () => {};
    cdn = await listen((req, res) => { requests.push(`${req.method} ${req.url} origin=${req.headers.origin ?? '-'}`); handle(req, res); });
    player = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><iframe id="game" sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer"
        src="${cdn}/g/assetgm1/v1/index.html?embed=${encodeURIComponent(player)}"></iframe>`);
    });
    handle = fixtureHandler({ webOrigins: player, cdnOrigin: cdn }).handle as http.RequestListener;
  });
  after(async () => {
    await browser?.close();
    for (const s of servers) s.close();
  });

  it('loads own .js/.css/.png/.wasm; another game\'s asset is blocked by CSP', async () => {
    const page = await browser!.newPage();
    const violations: string[] = [];
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
    await page.goto(`${player}/`);
    const frame = await (await page.waitForSelector('#game')).contentFrame();
    await frame!.waitForFunction(() => (window as any).__as5 !== undefined, null, { timeout: 15_000 });
    const result = await frame!.evaluate(() => (window as any).__as5);
    const stolen = await frame!.evaluate(() => (window as any).__stolen === true);
    console.log('# browser result', JSON.stringify(result), 'stolen', stolen);
    console.log('# csp violations', JSON.stringify(violations));
    assert.deepEqual({ js: result.js, css: result.css, png: result.png, wasm: result.wasm }, { js: true, css: true, png: true, wasm: true }, JSON.stringify(result));
    assert.equal(result.otherFetch, 'blocked');
    assert.equal(result.otherScript, 'blocked');
    assert.equal(stolen, false);
    assert.ok(violations.some((v) => v.includes('othergm1')), 'CSP reported the cross-game load');
    assert.ok(!requests.some((r) => r.includes('/g/othergm1/')), `other game never requested: ${requests.join(' | ')}`);
    assert.ok(requests.some((r) => r.startsWith('GET /g/assetgm1/v1/add.wasm') && r.endsWith('origin=null')), 'wasm fetched in CORS mode from the opaque origin');
  });
});
