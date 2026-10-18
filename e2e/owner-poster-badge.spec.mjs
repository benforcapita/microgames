// MR-2: on a pending game that passed validation (held for manual review), the owner's play page
// poster loads with the owner's preview token (200) while anon still gets 404, and the submission
// page shows the "Awaiting review" badge exactly once.
import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';
import { shotPath } from './shots.mjs';

const env = localSupabaseEnv();
if (!['127.0.0.1', 'localhost'].includes(new URL(env.DATABASE_URL).hostname)) throw new Error('local Supabase only');
const sql = postgres(env.DATABASE_URL, { max: 1 });
test.afterAll(async () => { await sql.end({ timeout: 1 }); });

const game = `<!doctype html><html><body style="margin:0"><canvas id="c" width="480" height="270"></canvas>
<script>const g=document.getElementById('c').getContext('2d');(function f(){g.fillStyle='#c4ff3d';g.fillRect(20,20,200,120);requestAnimationFrame(f);})();</script></body></html>`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('owner sees the pending poster (200), anon gets 404, and "Awaiting review" shows once', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const stamp = `mr2${Date.now().toString(36)}`;
  await page.goto('/login?mode=signup&next=/upload');
  await page.locator('input[name="email"]').fill(`${stamp}@example.com`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(stamp);
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/upload$/);

  await page.locator('input[name="game"]').setInputFiles({ name: 'g.html', mimeType: 'text/html', buffer: Buffer.from(game) });
  await page.locator('input[name="title"]').fill(`MR2 ${stamp}`);
  await page.locator('#thumb-file').setInputFiles({ name: 't.png', mimeType: 'image/png', buffer: png });
  await page.locator('input[name="agree"]').check();
  await page.getByRole('button', { name: 'Submit for validation' }).click();
  await page.waitForURL(/\/submissions\//, { timeout: 30_000 });
  const gameId = new URL(page.url()).pathname.split('/').pop();

  // The validator is not running locally: record the pass it would write. Manual review keeps the game pending.
  await sql`delete from public.game_validations where game_id = ${gameId}`;
  await sql`insert into public.game_validations (game_id, version, status, static_report, finished_at)
            values (${gameId}, 1, 'passed', '{"checks":[]}'::jsonb, now())`;
  const [row] = await sql`select slug, stage, thumb from public.games where id = ${gameId}`;
  expect(row.stage).toBe('pending');
  expect(row.thumb).toBeTruthy();

  // Submission page: the badge appears exactly once.
  await page.reload();
  await expect(page.locator('#submission .head').getByText('Awaiting review', { exact: true })).toHaveCount(1);
  await page.locator('#submission .head').screenshot({ path: shotPath('mr-2-submission-badge.png') });

  // Owner play page: the poster URL carries the preview token and the CDN serves it.
  await page.goto(`/play/${row.slug}`);
  const poster = page.locator('#stage img.preview-art');
  await expect(poster).toBeVisible();
  const src = await poster.getAttribute('src');
  expect(new URL(src).searchParams.get('pt')).toBeTruthy();
  await expect.poll(() => poster.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  expect((await page.request.get(src)).status()).toBe(200);
  await page.locator('#stage').screenshot({ path: shotPath('mr-2-owner-poster.png') });

  // Anon: the same poster without the token, and with no session, is 404.
  const anon = await browser.newContext();
  const bare = new URL(src); bare.search = '';
  expect((await anon.request.get(bare.toString())).status()).toBe(404);
  const anonPage = await anon.newPage();
  const anonPlay = await anonPage.goto(`/play/${row.slug}`);
  const anonImgs = anonPlay && anonPlay.status() === 200
    ? await anonPage.locator('img[src*="/g/"]').evaluateAll((els) => els.map((e) => e.getAttribute('src')))
    : [];
  for (const s of anonImgs) expect(new URL(s).searchParams.get('pt'), s).toBeNull();
  await anon.close();
});
