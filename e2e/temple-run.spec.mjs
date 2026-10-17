// E2E-1: the whole creator path for the Temple Dash fixture (e2e/fixtures/temple-run/), driven the way a
// person does it — sign in, post the real /upload form, watch validation finish, then play the published
// game in the shared player and use its fullscreen button.
//
// Validation transport: `pending -> proving` is normally done by the `validate-game` Edge Function, which
// pg_net calls. The local stack starts without edge-runtime and without `private.settings.validate_game_url`
// (see .cursor/skills/verify-meshgrounds/features/upload-submission.md), so nothing would ever pick the job
// up here. This spec therefore runs the Edge Function's own module (supabase/functions/validate-game) in
// process against the real Storage bundle and the real `record_game_validation` RPC: the verdict and the
// stage transition are the production ones, only the HTTP hop is missing. Every assertion afterwards is
// about what the pages actually show.
import { mkdirSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { shotPath, SHOT_DIR } from './shots.mjs';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';
import { validateGame } from '../supabase/functions/validate-game/validate.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'temple-run');
const CDN = `http://127.0.0.1:${process.env.E2E_CDN_PORT ?? 4722}`;
// The ticket asks for these two screenshots at a fixed place; they are also copied into the usual
// gitignored e2e screenshot directory so `vmg.sh down` collects them as evidence.
const OUT_DIR = process.env.TEMPLE_RUN_SHOT_DIR ?? '/workspace/e2e1-shots';

const SPRITES = 8; // assets/sprites/*.png
const SOUNDS = 4; // assets/audio/*.wav (one music loop + three effects)

/** The Edge Function's Store, backed by the local stack's REST + Storage APIs (same calls as its index.ts). */
function validationStore(env) {
  const key = env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const rest = async (query, init = {}) => {
    const res = await fetch(`${env.PUBLIC_SUPABASE_URL}/rest/v1/${query}`, {
      ...init,
      headers: { ...headers, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!res.ok) throw new Error(`${query}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };
  const eq = (value) => `eq.${encodeURIComponent(value)}`;
  return {
    async gameStage(gameId) {
      const [row] = await rest(`games?select=stage&id=${eq(gameId)}`);
      return row?.stage ?? null;
    },
    async bundle(gameId) {
      const res = await fetch(`${env.PUBLIC_SUPABASE_URL}/storage/v1/object/games/${gameId}/index.html`, { headers });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    },
    async findValidation(gameId, sha256) {
      const [row] = await rest(`game_validations?select=id,status,bundle_sha256,version&game_id=${eq(gameId)}&bundle_sha256=${eq(sha256)}`);
      return row ?? null;
    },
    async recordValidation({ gameId, sha256, status, report }) {
      const [row] = await rest('rpc/record_game_validation', {
        method: 'POST',
        body: JSON.stringify({ p_game_id: gameId, p_sha256: sha256, p_status: status, p_report: report }),
      });
      return row ? { row, stage: row.stage } : null;
    },
    async applyStoredVerdict(gameId, sha256) {
      const [row] = await rest('rpc/apply_stored_validation', {
        method: 'POST',
        body: JSON.stringify({ p_game_id: gameId, p_sha256: sha256 }),
      });
      return row?.stage ?? null;
    },
  };
}

/** The game document inside the sandboxed, opaque-origin CDN iframe. */
function gameFrame(page, gameId) {
  const frame = page.frames().find((f) => f.url().includes(`/g/${gameId}/index.html`));
  expect(frame, 'game iframe on the CDN origin').toBeTruthy();
  return frame;
}

const status = (frame) => frame.evaluate(() => {
  const tr = window.templeRun;
  if (!tr) throw new Error('window.templeRun is missing: the game did not boot');
  return {
    assets: tr.assets, audio: tr.audio, state: tr.state, frames: tr.frames,
    score: tr.score, gold: tr.gold, lane: tr.lane, airborne: tr.airborne, sliding: tr.sliding, speed: tr.speed,
  };
});

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file });
  await copyFile(file, shotPath(`e2e-1-${name}`));
  return file;
}

test('Temple Dash: upload form -> validation passes -> plays on the CDN -> fullscreen', async ({ page, context }) => {
  test.setTimeout(240_000);
  const html = await readFile(path.join(FIXTURE, 'index.html'));
  const thumb = await readFile(path.join(FIXTURE, 'thumb.png'));
  const stamp = Date.now().toString(36);
  const title = `Temple Dash ${stamp}`;
  // Local-stack-only test account, exactly like the other upload specs: an @example.com address that
  // only exists in this throwaway Supabase project.
  const handle = `tr${stamp}`.slice(0, 32);

  const consoleErrors = [];
  const responses = [];
  const requestFailures = [];
  const telemetry = [];
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(`${new URL(msg.location().url || 'about:blank').pathname}: ${msg.text()}`));
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    responses.push({ url: res.url(), status: res.status() });
    if (new URL(res.url()).pathname === '/api/telemetry') {
      let type = 'unparsed';
      try { type = res.request().postDataJSON()?.type ?? 'none'; } catch { /* a beacon Blob body */ }
      telemetry.push(`${res.status()} ${type}`);
    }
  });
  page.on('requestfailed', (req) => requestFailures.push(`${req.url()} ${req.failure()?.errorText ?? 'failed'}`));

  await test.step('sign in on the local stack', async () => {
    await page.goto('/login?mode=signup&next=/upload');
    await page.locator('input[name="email"]').fill(`temple-run-${stamp}@example.com`);
    await page.locator('input[name="password"]').fill('testpass1');
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.waitForURL(/\/onboarding/);
    await page.locator('input[name="handle"]').fill(handle);
    await page.getByRole('button', { name: 'Claim handle' }).click();
    await page.waitForURL(/\/upload$/);
    await expect(page.getByRole('heading', { name: 'Upload a game' })).toBeVisible();
  });

  await test.step('submit the real upload form', async () => {
    await page.locator('input[name="game"]').setInputFiles({ name: 'temple-dash.html', mimeType: 'text/html', buffer: html });
    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="tagline"]').fill('Three lanes, one temple, no brakes.');
    await page.locator('textarea[name="description"]').fill('Swipe or use the arrow keys to switch lanes, jump the blocks and slide under the bars.');
    await page.locator('input[name="tags"]').fill('arcade, runner, endless');
    await page.locator('#thumb-file').setInputFiles({ name: 'thumb.png', mimeType: 'image/png', buffer: thumb });
    await page.locator('input[name="agree"]').check();

    // A self-contained game references no separate files, so the upload scanner must find nothing missing.
    const warnings = page.locator('#asset-warnings');
    await expect(warnings).toBeVisible();
    await expect(warnings).toContainText(/Whole game: \d+\.\d KB \([\d,]+ bytes\) of 4 MB/);
    await expect(warnings).not.toContainText('not uploaded yet');
    await expect(warnings.getByRole('listitem')).toHaveCount(0);

    await page.getByRole('button', { name: 'Submit for validation' }).click();
    await page.waitForURL(/\/submissions\/[A-Za-z0-9_-]+$/, { timeout: 60_000 });
  });

  const gameId = page.url().split('/').pop();
  expect(gameId).toMatch(/^[A-Za-z0-9_-]{6,16}$/);

  await test.step('validation finishes with a pass and no missing-asset warnings', async () => {
    await expect(page.locator('#submission .badge.pending')).toHaveText('Pending');

    const result = await validateGame(validationStore(localSupabaseEnv()), gameId);
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    expect(result.body.status).toBe('passed');
    expect(result.body.failed).toEqual([]);
    expect(result.body.stage).toBe('proving');

    // The page polls on its own; no reload from the test.
    await expect(page.locator('#submission .badge.phase')).toHaveText(/Passed|Published/, { timeout: 60_000 });
    await expect(page.locator('#submission .badge.proving')).toHaveText('Proving Grounds');

    const checks = page.locator('.panel', { has: page.getByRole('heading', { name: 'Static checks' }) }).locator('.checks li');
    await expect(checks.first()).toBeVisible();
    const marks = await page.locator('.panel .checks .mark').allInnerTexts();
    expect(marks.length).toBeGreaterThanOrEqual(10);
    expect(marks.filter((m) => m !== 'pass')).toEqual([]);

    const warnings = page.locator('#asset-warnings');
    await expect(warnings).not.toContainText('not uploaded yet');
    await expect(warnings.getByRole('listitem')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open in the Proving Grounds' })).toBeVisible();
  });

  const playHref = await page.getByRole('link', { name: 'Open in the Proving Grounds' }).getAttribute('href');
  expect(playHref).toMatch(/^\/play\/temple-dash-/);

  // Only what happens from here on is judged: the play page, the game frame and its assets.
  responses.length = 0;
  consoleErrors.length = 0;
  requestFailures.length = 0;
  telemetry.length = 0;

  await test.step('first frame renders inside the sandboxed CDN iframe', async () => {
    await page.goto(playHref);
    await expect(page.locator('#stage')).toBeVisible();
    await page.getByRole('button', { name: `Play ${title}` }).click();

    const frameEl = page.locator('iframe.mg-frame');
    await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    expect(await frameEl.getAttribute('src')).toContain(`${CDN}/g/${gameId}/index.html`);
    await expect(page.frameLocator('iframe.mg-frame').locator('canvas#view')).toBeVisible({ timeout: 30_000 });

    const frame = gameFrame(page, gameId);
    await expect.poll(async () => (await status(frame)).frames, { timeout: 15_000 }).toBeGreaterThan(1);
    // A real first frame: the canvas has been painted with more than one colour.
    const painted = await frame.evaluate(() => {
      const canvas = document.getElementById('view');
      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let min = 255, max = 0, opaque = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0) opaque++;
        min = Math.min(min, data[i]);
        max = Math.max(max, data[i]);
      }
      return { width: canvas.width, height: canvas.height, opaque, spread: max - min };
    });
    expect(painted.width).toBeGreaterThan(300);
    expect(painted.opaque).toBeGreaterThan(painted.width * painted.height * 0.5);
    expect(painted.spread).toBeGreaterThan(30);
  });

  await test.step('every sprite and the music loop load', async () => {
    const frame = gameFrame(page, gameId);
    await expect.poll(async () => (await status(frame)).assets, { timeout: 15_000 })
      .toEqual({ total: SPRITES, loaded: SPRITES, failed: 0 });

    // Audio only starts after real user input (runtime contract rule 5); a key press is that input.
    await page.locator('iframe.mg-frame').press('Space');
    await expect.poll(async () => (await status(frame)).audio, { timeout: 20_000 })
      .toEqual({ total: SOUNDS, decoded: SOUNDS, failed: 0, musicPlaying: true });
    expect((await status(frame)).state).toBe('running');
  });

  await test.step('keyboard and touch controls move the runner', async () => {
    const frame = gameFrame(page, gameId);
    const frameEl = page.locator('iframe.mg-frame');
    const read = () => status(frame);

    const restart = async () => {
      if ((await read()).state === 'running') return;
      await frameEl.press('KeyR');
      await expect.poll(async () => (await read()).state, { timeout: 5_000 }).toBe('running');
    };
    /**
     * Runs one control check inside a live run. The runner dies when it hits something, which can happen
     * between the key press and the read, so a crashed attempt is restarted and tried again. A control
     * that does nothing while the run is still going fails immediately — the retry never hides that.
     */
    const control = async (label, fn) => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        await restart();
        if (await fn()) return;
        const after = await read();
        if (after.state === 'running') throw new Error(`${label}: no effect during a live run (${JSON.stringify(after)})`);
      }
      throw new Error(`${label}: the runner crashed on every one of 4 attempts`);
    };

    await control('ArrowRight moves one lane right', async () => {
      await frameEl.press('ArrowRight');
      return (await read()).lane === 2;
    });
    await control('ArrowLeft moves back to the middle lane', async () => {
      await frameEl.press('ArrowLeft');
      return (await read()).lane === 1;
    });
    await control('ArrowUp jumps and lands again', async () => {
      await frameEl.press('ArrowUp');
      if (!(await read()).airborne) return false;
      await expect.poll(async () => (await read()).airborne, { timeout: 5_000 }).toBe(false);
      return true;
    });
    await control('ArrowDown slides', async () => {
      await frameEl.press('ArrowDown');
      return (await read()).sliding;
    });

    // The same controls by touch: real touch input, dispatched through CDP at the frame's coordinates.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const box = await frameEl.boundingBox();
    const y = box.y + box.height / 2;
    const mid = box.x + box.width / 2;
    const swipe = async (to) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mid, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (mid + to) / 2, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await control('a right swipe moves one lane right', async () => {
      await swipe(mid + 180);
      return (await read()).lane === 2;
    });
    await control('a left swipe moves back to the middle lane', async () => {
      await swipe(mid - 180);
      return (await read()).lane === 1;
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

    // Distance scores and the pace rises while a run is going.
    await control('score and speed climb while running', async () => {
      const before = await read();
      await page.waitForTimeout(600);
      const after = await read();
      return after.state === 'running' && after.score > before.score && after.speed > before.speed;
    });
    await restart();
    console.log(`[temple-run] play page screenshot: ${await shot(page, 'play.png')}`);
  });

  await test.step('hitting an obstacle ends the run, the score reaches the portal, and restart works', async () => {
    const frame = gameFrame(page, gameId);
    const frameEl = page.locator('iframe.mg-frame');
    // Standing in one lane, the runner eventually hits a block or a bar: that is the game over.
    await expect.poll(async () => (await status(frame)).state, { timeout: 60_000 }).toBe('over');
    await expect(page.frameLocator('iframe.mg-frame').locator('#card-title')).toHaveText('GAME OVER');
    await expect(page.frameLocator('iframe.mg-frame').locator('#card-score')).toHaveText(/\d+ PTS/);
    // Meshground.gameOver(score) travelled to the portal: it records one completion for the session
    // (the player only counts the first) and shows the best score beside the toolbar.
    await expect.poll(() => telemetry, { timeout: 15_000 }).toContain('204 complete');
    await expect(page.locator('#best')).toHaveText(/^Your best: \d+$/);

    await frameEl.press('KeyR');
    await expect.poll(async () => (await status(frame)).state, { timeout: 5_000 }).toBe('running');
    await expect(page.frameLocator('iframe.mg-frame').locator('#card')).toBeHidden();
  });

  await test.step("the shared player's fullscreen button works", async () => {
    const frame = gameFrame(page, gameId);
    const button = page.locator('#fullscreen');
    await expect(button).toHaveText('⛶ Fullscreen');
    await button.click();
    await expect(button).toHaveText('⛶ Exit fullscreen');
    await expect(button).toHaveAttribute('aria-label', 'Exit fullscreen');
    expect(await page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('stage');
    const exit = page.locator('#stage [data-fullscreen-exit]');
    await expect(exit).toBeVisible();
    // Same game instance, now filling the viewport and still drawing frames.
    const stage = await page.locator('#stage').evaluate((el) => el.getBoundingClientRect().width);
    expect(stage).toBeGreaterThan((page.viewportSize()?.width ?? 0) * 0.9);
    const framesBefore = (await status(frame)).frames;
    await expect.poll(async () => (await status(frame)).frames, { timeout: 10_000 }).toBeGreaterThan(framesBefore);
    console.log(`[temple-run] fullscreen screenshot: ${await shot(page, 'fullscreen.png')}`);

    await exit.click();
    await expect(button).toHaveText('⛶ Fullscreen');
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  });

  await test.step('no failed requests and no console errors', async () => {
    // Every response recorded since the play page opened, including the game document on the CDN origin.
    const gameDocument = responses.filter((r) => r.url.startsWith(`${CDN}/g/${gameId}/index.html`));
    expect(gameDocument.map((r) => r.status)).toContain(200);
    const bad = responses.filter((r) => r.status >= 400);
    expect(bad, `failed responses: ${JSON.stringify(bad)}`).toEqual([]);
    expect(requestFailures).toEqual([]);
    expect(consoleErrors).toEqual([]);
    console.log(`[temple-run] ${responses.length} responses recorded, none >= 400`);
  });
});
