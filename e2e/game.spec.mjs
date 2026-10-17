import { test, expect } from '@playwright/test';
import { shotPath } from './shots.mjs';

const GAME_ID = 'stk7wr01'; // seed game "Stack Tower"
const CDN = `http://127.0.0.1:${process.env.E2E_CDN_PORT ?? 4722}`;

test('seed game loads in the sandboxed iframe and sends telemetry', async ({ page }) => {
  const events = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/telemetry') {
      try { events.push(JSON.parse(req.postData() ?? '{}')); } catch {}
    }
  });
  const waitTelemetry = (type) =>
    page.waitForResponse((r) => r.url().endsWith('/api/telemetry') && r.request().postDataJSON()?.type === type);

  const sessionStart = waitTelemetry('session_start');
  const firstFrame = waitTelemetry('first_frame');
  await page.goto(`/play/${GAME_ID}`);
  await expect(page).toHaveURL(/\/play\/stack-tower$/);
  await page.getByRole('button', { name: 'Play Stack Tower' }).click();

  // Iframe is served from the separate CDN origin with the locked-down sandbox.
  const frameEl = page.locator('iframe.mg-frame');
  await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
  const frameSrc = await frameEl.getAttribute('src');
  expect(frameSrc).toContain(`${CDN}/g/${GAME_ID}/index.html`);
  const cdnHtml = await (await page.request.get(frameSrc.split('#')[0])).text();
  expect(cdnHtml).not.toContain('window.__MG_PREVIEW=true');
  expect(cdnHtml).not.toContain('window.__MG_PREVIEW = true');

  // Game booted inside the frame (boot.js runtime injected, canvas rendered).
  const frame = page.frameLocator('iframe.mg-frame');
  await expect(frame.locator('canvas').first()).toBeVisible({ timeout: 30_000 });

  // Telemetry reached the portal API. Stack Tower never calls Meshground.ready(),
  // so the automatic first-frame event still arrives on its own.
  expect((await sessionStart).status()).toBe(204);
  expect((await firstFrame).status()).toBe(204);
  const typesBeforeReady = events.filter((e) => e.gameId === GAME_ID).map((e) => e.type);
  expect(typesBeforeReady).toContain('first_frame');
  expect(typesBeforeReady).not.toContain('ready');

  // Explicit ready() posts __MG_READY, which the portal records as ready telemetry. Once only.
  const readyEv = waitTelemetry('ready');
  const gameFrame = page.frames().find((f) => f.url().includes(`/g/${GAME_ID}/`) && f.url().includes('index.html'));
  expect(gameFrame, 'game iframe').toBeTruthy();
  await gameFrame.evaluate(() => {
    const mg = window.Meshground;
    if (typeof mg?.ready !== 'function') throw new Error('Meshground.ready is missing');
    mg.ready();
    mg.ready();
  });
  const readyRes = await readyEv;
  expect(readyRes.status()).toBe(204);
  const readyBody = readyRes.request().postDataJSON();
  expect(readyBody.type).toBe('ready');
  expect(readyBody.gameId).toBe(GAME_ID);
  expect(readyBody.value).toEqual(expect.any(Number));
  expect(readyBody.value).toBeGreaterThanOrEqual(0);

  // Input inside the game -> "start" telemetry.
  const startEv = waitTelemetry('start');
  await frameEl.click();
  expect((await startEv).status()).toBe(204);

  const types = events.filter((e) => e.gameId === GAME_ID).map((e) => e.type);
  expect(types).toEqual(expect.arrayContaining(['session_start', 'first_frame', 'start', 'ready']));
  expect(types.filter((t) => t === 'ready')).toHaveLength(1);
  expect(types.filter((t) => t === 'first_frame')).toHaveLength(1);
  console.log(`telemetry events: ${types.join(', ')}`);

  // Live play never enables preview capture, and the player drops snapshot messages.
  expect(await gameFrame.evaluate(() => window.__MG_PREVIEW === true)).toBe(false);
  const beforeSnapshot = events.length;
  await gameFrame.evaluate(() => parent.postMessage({ type: '__MG_SNAPSHOT', dataUrl: 'data:image/png;base64,aa', mime: 'image/png' }, '*'));
  await page.waitForTimeout(300);
  expect(events.length).toBe(beforeSnapshot);

  await page.waitForTimeout(500);
  await page.screenshot({ path: shotPath('mg-7-e2e-stack-tower.png') });
});
