import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

const env = localSupabaseEnv();
if (!['127.0.0.1', 'localhost'].includes(new URL(env.DATABASE_URL).hostname)) throw new Error('local Supabase only');
const sql = postgres(env.DATABASE_URL, { max: 1 });
test.afterAll(async () => { await sql.end({ timeout: 1 }).catch(() => {}); });

const GAME_ID = 'stk7wr01';
const GAME_TITLE = 'Stack Tower';

const telemetry = (page, type) =>
  page.waitForResponse((r) => r.url().endsWith('/api/telemetry') && r.request().postDataJSON()?.type === type);

const readSession = async (sessionId) => {
  const [row] = await sql`
    select id, game_id, user_id, created_at, first_frame_ms, started, completed, crashed, duration_ms
    from public.sessions where id = ${sessionId}`;
  return row ?? null;
};

async function playRun(page) {
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/telemetry')) {
      try { posts.push(req.postDataJSON()); } catch {}
    }
  });

  const wallStart = Date.now();
  const sessionStart = telemetry(page, 'session_start');
  const firstFrame = telemetry(page, 'first_frame');
  const heartbeat = telemetry(page, 'heartbeat');
  await page.goto(`/play/${GAME_ID}`);
  await page.getByRole('button', { name: `Play ${GAME_TITLE}` }).click();
  expect((await sessionStart).status()).toBe(204);
  expect((await firstFrame).status()).toBe(204);

  const frameEl = page.locator('iframe.mg-frame');
  const gameFrame = page.frames().find((f) => f.url().includes(`/g/${GAME_ID}/`) && f.url().includes('index.html'));
  expect(gameFrame, 'game iframe').toBeTruthy();

  const started = telemetry(page, 'start');
  await frameEl.click();
  expect((await started).status()).toBe(204);

  const completed = telemetry(page, 'complete');
  await gameFrame.evaluate(() => window.Meshground.gameOver(13));
  expect((await completed).status()).toBe(204);
  expect((await heartbeat).status()).toBe(204);

  const sessionId = posts.find((b) => b?.type === 'session_start')?.sessionId;
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
  return { sessionId, wallStart };
}

async function signUp(page, handle) {
  await page.goto('/login?mode=signup&next=/me');
  await page.locator('input[name="email"]').fill(`${handle}@example.test`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(handle);
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/me$/);
}

function expectSessionRow(row, { userId, wallStart }) {
  expect(row, 'sessions row for the run').toBeTruthy();
  expect(row.game_id).toBe(GAME_ID);
  expect(row.user_id).toBe(userId);
  expect(row.created_at instanceof Date).toBe(true);
  expect(row.created_at.getTime()).toBeGreaterThanOrEqual(wallStart - 5_000);
  expect(row.created_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  expect(row.first_frame_ms).not.toBeNull();
  expect(row.first_frame_ms).toBeGreaterThanOrEqual(0);
  expect(row.first_frame_ms).toBeLessThanOrEqual(60_000);
  expect(row.started).toBe(true);
  expect(row.completed).toBe(true);
  expect(row.crashed).toBe(false);
  expect(row.duration_ms).toBeGreaterThan(0);
  expect(row.duration_ms).toBeLessThanOrEqual(Date.now() - wallStart);
}

test('a guest play writes a sessions row with a null user_id', async ({ page }) => {
  test.setTimeout(120_000);
  const { sessionId, wallStart } = await playRun(page);
  expectSessionRow(await readSession(sessionId), { userId: null, wallStart });
});

test('a signed-in play writes a sessions row with the auth user id', async ({ page }) => {
  test.setTimeout(120_000);
  const handle = `mg7b${Date.now().toString(36)}`.slice(0, 32);
  await signUp(page, handle);
  const [profile] = await sql`select id from public.profiles where lower(handle) = lower(${handle})`;
  expect(profile, 'profile row for the new account').toBeTruthy();
  const { sessionId, wallStart } = await playRun(page);
  expectSessionRow(await readSession(sessionId), { userId: profile.id, wallStart });
});
