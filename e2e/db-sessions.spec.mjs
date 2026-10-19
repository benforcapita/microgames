import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

const env = localSupabaseEnv();
if (!['127.0.0.1', 'localhost'].includes(new URL(env.DATABASE_URL).hostname)) throw new Error('local Supabase only');
const sql = postgres(env.DATABASE_URL, { max: 1 });

const sessionIds = [];
const emails = [];

test.afterAll(async () => {
  try {
    if (sessionIds.length) await sql`delete from public.sessions where id in ${sql(sessionIds)}`;
    if (emails.length) await sql`delete from auth.users where email in ${sql(emails)}`;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
});

const GAME_ID = 'stk7wr01';
const GAME_TITLE = 'Stack Tower';
const MAX_FIRST_FRAME_MS = 60_000;
const MAX_SESSION_MS = 4 * 3_600_000;
const GUARD_FIRST_FRAME_MS = 59_998;
const GUARD_DURATION_MS = 240_000;

const parseMs = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
};

const clampFirstFrame = (value) => {
  const n = parseMs(value);
  if (n === null || n === Number.NEGATIVE_INFINITY) return null;
  if (n === Number.POSITIVE_INFINITY || n > MAX_FIRST_FRAME_MS) return MAX_FIRST_FRAME_MS;
  if (n < 0) return 0;
  return Math.round(n);
};

const clampDuration = (value) => {
  const n = parseMs(value);
  if (n === null || n === Number.NEGATIVE_INFINITY) return 0;
  if (n === Number.POSITIVE_INFINITY) return MAX_SESSION_MS;
  return Math.min(MAX_SESSION_MS, Math.max(0, Math.round(n)));
};

const telemetry = (page, type) =>
  page.waitForResponse((r) => r.url().endsWith('/api/telemetry') && r.request().postDataJSON()?.type === type);

const readSession = async (sessionId) => {
  const [row] = await sql`
    select id, game_id, user_id, created_at, first_frame_ms, started, completed, crashed, duration_ms
    from public.sessions where id = ${sessionId}`;
  return row ?? null;
};

const postTelemetry = (page, sessionId, type, value) =>
  page.request.post('/api/telemetry', { data: { sessionId, gameId: GAME_ID, type, value } });

async function playRun(page) {
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/telemetry')) {
      let body;
      try { body = req.postDataJSON(); } catch { return; }
      posts.push(body);
      if (body?.type === 'session_start' && typeof body.sessionId === 'string' && !sessionIds.includes(body.sessionId)) {
        sessionIds.push(body.sessionId);
      }
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
  return { sessionId, wallStart, posts };
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

function expectSessionRow(row, { userId, wallStart, firstFrameMs, durationMs }) {
  expect(row, 'sessions row for the run').toBeTruthy();
  expect(row.game_id).toBe(GAME_ID);
  expect(row.user_id).toBe(userId);
  expect(row.created_at instanceof Date).toBe(true);
  expect(row.created_at.getTime()).toBeGreaterThanOrEqual(wallStart - 5_000);
  expect(row.created_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  expect(row.first_frame_ms).toBe(firstFrameMs);
  expect(row.started).toBe(true);
  expect(row.completed).toBe(true);
  expect(row.crashed).toBe(false);
  expect(row.duration_ms).toBe(durationMs);
  expect(row.duration_ms).toBeGreaterThan(0);
  expect(row.duration_ms).toBeLessThanOrEqual(Date.now() - wallStart);
}

async function expectRecordedPlay(page, userId) {
  const { sessionId, wallStart, posts } = await playRun(page);

  const firstFrameMs = clampFirstFrame(posts.find((b) => b?.type === 'first_frame')?.value);
  expect(firstFrameMs, 'first_frame value the client sent').not.toBeNull();
  const heartbeatValues = posts.filter((b) => b?.type === 'heartbeat').map((b) => clampDuration(b.value));
  expect(heartbeatValues.length, 'heartbeats the client sent').toBeGreaterThan(0);
  const durationMs = Math.max(...heartbeatValues);

  expectSessionRow(await readSession(sessionId), { userId, wallStart, firstFrameMs, durationMs });

  const againFirstFrameMs = firstFrameMs === GUARD_FIRST_FRAME_MS ? GUARD_FIRST_FRAME_MS - 1 : GUARD_FIRST_FRAME_MS;
  expect((await postTelemetry(page, sessionId, 'first_frame', againFirstFrameMs)).status(), 'second first_frame accepted').toBe(204);
  expect((await postTelemetry(page, sessionId, 'heartbeat', GUARD_DURATION_MS)).status(), 'larger heartbeat accepted').toBe(204);
  expect((await postTelemetry(page, sessionId, 'heartbeat', 1)).status(), 'smaller heartbeat accepted').toBe(204);

  const guarded = await readSession(sessionId);
  expect(guarded.first_frame_ms, 'first_frame_ms keeps the first value').toBe(firstFrameMs);
  expect(guarded.duration_ms, 'duration_ms keeps the largest heartbeat').toBe(GUARD_DURATION_MS);
}

test('a guest play writes a sessions row with a null user_id', async ({ page }) => {
  test.setTimeout(120_000);
  await expectRecordedPlay(page, null);
});

test('a signed-in play writes a sessions row with the auth user id', async ({ page }) => {
  test.setTimeout(120_000);
  const handle = `mg7b${Date.now().toString(36)}`.slice(0, 32);
  emails.push(`${handle}@example.test`);
  await signUp(page, handle);
  const [profile] = await sql`select id from public.profiles where lower(handle) = lower(${handle})`;
  expect(profile, 'profile row for the new account').toBeTruthy();
  await expectRecordedPlay(page, profile.id);
});
