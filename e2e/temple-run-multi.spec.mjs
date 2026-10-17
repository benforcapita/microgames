// UP-1: the multi-file variant of the Temple Dash fixture (e2e/fixtures/temple-run-multi/) drives
// the full creator path for a game with separate asset files — sign in, post the real /upload form,
// add every file through the game's Files page ("Add file", the creator flow), watch validation
// pass, then play the game and assert every single asset loads from the CDN's versioned folder with
// no failed responses, no console errors and no CSP violations.
//
// Validation transport is the same as e2e/temple-run.spec.mjs: the validate-game Edge Function's
// own module runs in-process against the real Storage bundle and the real record_game_validation
// RPC (the local stack has no edge-runtime), so the verdict and stage change are production code.
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { shotPath, SHOT_DIR } from './shots.mjs';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';
import { validateGame } from '../supabase/functions/validate-game/validate.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'temple-run-multi');
const CDN = `http://127.0.0.1:${process.env.E2E_CDN_PORT ?? 4722}`;

// The twelve separate files the game fetches, relative to the document's versioned URL.
const SPRITES = [
  'sprites/coin.png',
  'sprites/obstacle-bar.png',
  'sprites/obstacle-block.png',
  'sprites/runner-jump.png',
  'sprites/runner-run-a.png',
  'sprites/runner-run-b.png',
  'sprites/runner-slide.png',
  'sprites/tile-stone.png',
];
const SOUNDS = ['audio/music-loop.wav', 'audio/sfx-coin.wav', 'audio/sfx-hit.wav', 'audio/sfx-jump.wav'];
const ASSET_FILES = [...SOUNDS, ...SPRITES];

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

/** The game document inside the sandboxed, opaque-origin CDN iframe (at its versioned URL). */
function gameFrame(page, gameId) {
  const frame = page.frames().find((f) => f.url().includes(`/g/${gameId}/`) && f.url().includes('index.html'));
  expect(frame, 'game iframe on the CDN origin').toBeTruthy();
  return frame;
}

const status = (frame) => frame.evaluate(() => {
  const tr = window.templeRun;
  if (!tr) throw new Error('window.templeRun is missing: the game did not boot');
  return {
    assets: tr.assets, audio: tr.audio, state: tr.state, frames: tr.frames,
    score: tr.score, lane: tr.lane, paused: tr.paused,
  };
});

async function shot(page, name) {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: shotPath(`up-1-${name}`) });
  return shotPath(`up-1-${name}`);
}

test('Temple Dash multi-file: upload, add files on the Files page, every asset loads on play', async ({ page }) => {
  test.setTimeout(240_000);
  const html = await readFile(path.join(FIXTURE, 'index.html'));
  const thumb = await readFile(path.join(FIXTURE, 'thumb.png'));
  const stamp = Date.now().toString(36);
  const title = `Temple Dash Files ${stamp}`;
  const handle = `trm${stamp}`.slice(0, 32);

  const consoleErrors = [];
  const responses = [];
  const requestFailures = [];
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(`${new URL(msg.location().url || 'about:blank').pathname}: ${msg.text()}`));
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => responses.push({ url: res.url(), status: res.status() }));
  page.on('requestfailed', (req) => requestFailures.push(`${req.url()} ${req.failure()?.errorText ?? 'failed'}`));

  await test.step('sign in on the local stack', async () => {
    await page.goto('/login?mode=signup&next=/upload');
    await page.locator('input[name="email"]').fill(`temple-run-multi-${stamp}@example.com`);
    await page.locator('input[name="password"]').fill('testpass1');
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.waitForURL(/\/onboarding/);
    await page.locator('input[name="handle"]').fill(handle);
    await page.getByRole('button', { name: 'Claim handle' }).click();
    await page.waitForURL(/\/upload$/);
    await expect(page.getByRole('heading', { name: 'Upload a game' })).toBeVisible();
  });

  await test.step('submit the real upload form', async () => {
    await page.locator('input[name="game"]').setInputFiles({ name: 'temple-dash-files.html', mimeType: 'text/html', buffer: html });
    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="tagline"]').fill('Three lanes, one temple, twelve files.');
    await page.locator('input[name="tags"]').fill('arcade, runner, endless');
    await page.locator('#thumb-file').setInputFiles({ name: 'thumb.png', mimeType: 'image/png', buffer: thumb });
    await page.locator('input[name="agree"]').check();
    await page.getByRole('button', { name: 'Submit for validation' }).click();
    await page.waitForURL(/\/submissions\/[A-Za-z0-9_-]+$/, { timeout: 60_000 });
  });

  const gameId = page.url().split('/').pop();
  expect(gameId).toMatch(/^[A-Za-z0-9_-]{6,16}$/);

  // Uploading the game does not also upload the files it references: the creator adds them on the
  // Files page afterwards, exactly like the "Add file" form on /games/<slug>/assets offers.
  const slug = await test.step('add every asset file through the Files page', async () => {
    await page.goto('/me');
    await page.getByRole('link', { name: 'Assets' }).click();
    await page.waitForURL(/\/games\/[^/]+\/assets$/);
    const slug = new URL(page.url()).pathname.split('/')[2];

    const addForm = page.locator('form.add');
    await expect(addForm).toBeVisible();
    for (const rel of ASSET_FILES) {
      const file = path.join(FIXTURE, 'assets', rel);
      const mimeType = rel.endsWith('.png') ? 'image/png' : 'audio/wav';
      await addForm.locator('input[name="path"]').fill(rel);
      await addForm.locator('input[name="file"]').setInputFiles({ name: path.basename(rel), mimeType, buffer: await readFile(file) });
      await addForm.getByRole('button', { name: 'Add file' }).click();
      await expect(page.locator('.flash.ok'), rel).toContainText(`Uploaded ${rel}.`);
    }
    // The manifest now lists all twelve files, each uploaded for the current version.
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(ASSET_FILES.length);
    await expect(page.locator('td.path')).toHaveText(ASSET_FILES.slice().sort());
    await expect(page.locator('tbody td:nth-child(3)')).toHaveText(ASSET_FILES.map(() => 'uploaded'));
    return slug;
  });

  await test.step('validation finishes with a pass', async () => {
    const result = await validateGame(validationStore(localSupabaseEnv()), gameId);
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    expect(result.body.status).toBe('passed');
    expect(result.body.failed).toEqual([]);
    expect(result.body.stage).toBe('proving');
  });

  // Only what happens from here on is judged: the play page, the game frame and its asset requests.
  responses.length = 0;
  consoleErrors.length = 0;
  requestFailures.length = 0;

  await test.step('every asset loads from the versioned CDN folder, no errors or CSP violations', async () => {
    await page.goto(`/play/${slug}`);
    await page.locator('#stage').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: `Play ${title}` }).click();

    const frameEl = page.locator('iframe.mg-frame');
    await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    // The iframe src stays the canonical /g/<id>/index.html; the CDN redirects it to the versioned
    // document, which is the URL every relative asset path resolves against.
    await expect(frameEl).toHaveAttribute('src', new RegExp(`^${CDN.replace(/[.]/g, '\\.')}/g/${gameId}/index\\.html\\?`));

    const frame = gameFrame(page, gameId);
    await expect.poll(() => frame.url(), { timeout: 15_000 })
      .toMatch(new RegExp(`^${CDN.replace(/[.]/g, '\\.')}/g/${gameId}/\\d+/index\\.html`));
    const versioned = new URL(frame.url()).pathname.match(/^\/g\/[^/]+\/(\d+)\/index\.html$/)?.[1];
    expect(versioned, 'the game document lives under its versioned path').toBeTruthy();

    // Belt and braces for CSP: console errors are collected for the whole page, and the frame itself
    // records every securitypolicyviolation event the document fires.
    await frame.evaluate(() => {
      const w = window;
      w.__cspViolations = w.__cspViolations ?? [];
      document.addEventListener('securitypolicyviolation', (e) => w.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });

    await expect(page.frameLocator('iframe.mg-frame').locator('canvas#view')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await status(frame)).frames, { timeout: 15_000 }).toBeGreaterThan(1);

    // All eight sprites were fetched and decoded; audio needs a first user input (contract rule 5).
    await expect.poll(async () => (await status(frame)).assets, { timeout: 15_000 })
      .toEqual({ total: SPRITES.length, loaded: SPRITES.length, failed: 0 });
    await frameEl.press('Space');
    await expect.poll(async () => (await status(frame)).audio, { timeout: 20_000 })
      .toEqual({ total: SOUNDS.length, decoded: SOUNDS.length, failed: 0, musicPlaying: true });
    expect((await status(frame)).state).toBe('running');

    // Every uploaded file produced a real 200 response under this game's versioned folder — the
    // path the browser derived from the document URL — and nothing else on the page failed.
    const assetResponses = (rel) => responses.filter((r) => new URL(r.url).pathname === `/g/${gameId}/${versioned}/${rel}`);
    for (const rel of ASSET_FILES) {
      const hits = assetResponses(rel);
      expect(hits.length, `${rel} was never fetched`).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.status, `${rel} -> ${hit.url}`).toBe(200);
    }
    const bad = responses.filter((r) => r.status >= 400);
    expect(bad, `failed responses: ${JSON.stringify(bad)}`).toEqual([]);
    expect(requestFailures).toEqual([]);
    expect(consoleErrors).toEqual([]);
    const cspViolations = await frame.evaluate(() => window.__cspViolations ?? []);
    expect(cspViolations).toEqual([]);
    console.log(`[temple-run-multi] ${responses.length} responses recorded, every one of ${ASSET_FILES.length} assets 200 on /g/${gameId}/${versioned}/…`);
    console.log(`[temple-run-multi] play page screenshot: ${await shot(page, 'play.png')}`);
  });
});
