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

async function signUp(page, stamp) {
  await page.goto('/login?mode=signup&next=/me');
  await page.locator('input[name="email"]').fill(`${stamp}@example.com`);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(stamp);
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/me(#upload)?$/);
}
const PT = /[?&](?:amp;)?pt=/;

test('owner sees the pending poster (200), anon gets 404, and "Awaiting review" shows once', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = `mr2${Date.now().toString(36)}`;
  await signUp(page, stamp);

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
  const submissionHead = page.locator('#submission .head').filter({ hasText: 'Awaiting review' });
  await expect(submissionHead.getByText('Awaiting review', { exact: true })).toHaveCount(1);
  await submissionHead.screenshot({ path: shotPath('mr-2-submission-badge.png') });

  // Owner play page: the poster URL carries the preview token and the CDN serves it.
  await page.goto(`/play/${row.slug}`);
  const poster = page.locator('#stage img.preview-art');
  await expect(poster).toBeVisible();
  const src = await poster.getAttribute('src');
  expect(new URL(src).searchParams.get('pt')).toBeTruthy();
  await expect.poll(() => poster.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  // The tokened poster is the owner's alone: never storable by a shared cache, including the 304 revalidation.
  const owned = await page.request.get(src);
  expect(owned.status()).toBe(200);
  expect(owned.headers()['cache-control']).toBe('private, no-store');
  const revalidated = await page.request.get(src, {
    headers: { 'If-None-Match': owned.headers()['etag'], 'If-Modified-Since': new Date().toUTCString() },
  });
  expect(revalidated.status()).toBe(304);
  expect(revalidated.headers()['cache-control']).toBe('private, no-store');
  await page.locator('#stage').screenshot({ path: shotPath('mr-2-owner-poster.png') });

  // Anon: the same poster without the token is 404, and the pending play page is a 404 whose body carries no pt.
  const anon = await browser.newContext();
  const bare = new URL(src); bare.search = '';
  expect((await anon.request.get(bare.toString())).status()).toBe(404);
  const anonPage = await anon.newPage();
  const anonPending = await anonPage.goto(`/play/${row.slug}`);
  expect(anonPending.status()).toBe(404);
  expect(await anonPending.text()).not.toMatch(PT);

  // /me (owner dashboard): the pending thumbnail carries the owner's token and loads (200), privately.
  await page.goto('/me');
  const meThumb = page.locator(`a[href="/submissions/${gameId}"] img.art`);
  const meSrc = await meThumb.getAttribute('src');
  expect(new URL(meSrc).searchParams.get('pt')).toBeTruthy();
  await expect.poll(() => meThumb.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  const meRes = await page.request.get(meSrc);
  expect(meRes.status()).toBe(200);
  expect(meRes.headers()['cache-control']).toBe('private, no-store');
  await page.screenshot({ path: shotPath('mr-2-me-thumb.png'), fullPage: true });

  // Public stages: no viewer (anon, another user, the owner) gets a pt in the play page HTML,
  // and the poster keeps its public cache header.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signUp(otherPage, `${stamp}o`);
  // Another user's /me never lists this game and carries no token; anon /me is the login redirect.
  const otherMe = await otherPage.goto('/me');
  const otherMeHtml = await otherMe.text();
  expect(otherMeHtml).not.toContain(gameId);
  expect(otherMeHtml).not.toMatch(PT);
  await anonPage.goto('/me');
  expect(new URL(anonPage.url()).pathname).toBe('/login');
  const viewers = { anon: anonPage, other: otherPage, owner: page };
  for (const stage of ['proving', 'live']) {
    await sql`update public.games set stage = ${stage} where id = ${gameId}`;
    for (const [who, p] of Object.entries(viewers)) {
      const res = await p.goto(`/play/${row.slug}`);
      expect(res.status(), `${stage}/${who}`).toBe(200);
      expect(await res.text(), `${stage}/${who} HTML`).not.toMatch(PT);
      const publicSrc = await p.locator('#stage img.preview-art').getAttribute('src');
      expect(new URL(publicSrc).searchParams.get('pt'), `${stage}/${who}`).toBeNull();
      // The CDN caches a game's stage for up to 30 s, so the first public fetch can still see 'pending'.
      await expect.poll(async () => (await p.request.get(publicSrc)).status(), { timeout: 45_000 }).toBe(200);
      const cc = (await p.request.get(publicSrc)).headers()['cache-control'];
      expect(cc, `${stage}/${who} poster`).toMatch(/^public, max-age=3600/);
    }
    // Owner dashboard on a public stage: plain thumbnail URL, no token.
    const ownerMe = await page.goto('/me');
    expect(await ownerMe.text(), `${stage} /me`).not.toMatch(PT);
  }
  await other.close();
  await anon.close();
});
