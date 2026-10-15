import { test, expect } from '@playwright/test';

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
  expect(await frameEl.getAttribute('src')).toContain(`${CDN}/g/${GAME_ID}/index.html`);

  // Game booted inside the frame (boot.js runtime injected, canvas rendered).
  const frame = page.frameLocator('iframe.mg-frame');
  await expect(frame.locator('canvas').first()).toBeVisible({ timeout: 30_000 });

  // Telemetry reached the portal API.
  expect((await sessionStart).status()).toBe(204);
  expect((await firstFrame).status()).toBe(204);

  // Input inside the game -> "start" telemetry.
  const startEv = waitTelemetry('start');
  await frameEl.click();
  expect((await startEv).status()).toBe(204);

  const types = events.filter((e) => e.gameId === GAME_ID).map((e) => e.type);
  expect(types).toEqual(expect.arrayContaining(['session_start', 'first_frame', 'start']));
  console.log(`telemetry events: ${types.join(', ')}`);

  await page.waitForTimeout(500);
  await page.screenshot({ path: 'docs/pr-assets/mg-7-e2e-stack-tower.png' });
});
