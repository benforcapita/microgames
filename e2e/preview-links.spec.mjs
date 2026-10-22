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

async function createValidatedGame(page, stamp = `sl3${Date.now().toString(36)}`) {
  const title = `SL3 ${stamp}`;
  await signUp(page, stamp);
  await page.locator('input[name="game"]').setInputFiles({ name: 'g.html', mimeType: 'text/html', buffer: Buffer.from(game) });
  await page.locator('input[name="title"]').fill(title);
  await page.locator('#thumb-file').setInputFiles({ name: 't.png', mimeType: 'image/png', buffer: png });
  await page.locator('input[name="agree"]').check();
  await page.getByRole('button', { name: 'Submit for validation' }).click();
  await page.waitForURL(/\/submissions\//, { timeout: 30_000 });
  const gameId = new URL(page.url()).pathname.split('/').pop();

  await sql`delete from public.game_validations where game_id = ${gameId}`;
  await sql`insert into public.game_validations (game_id, version, status, static_report, finished_at)
            values (${gameId}, 1, 'passed', '{"checks":[]}'::jsonb, now())`;

  await page.reload();
  return { gameId, stamp, title };
}

test('creator share links UI, active list, revoke, cap, and non-owner access control', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const stamp = `sl3${Date.now().toString(36)}`;
  const { gameId } = await createValidatedGame(page, stamp);

  const shareSection = page.locator('#share-links');
  await expect(shareSection).toBeVisible();
  const shareBtn = page.getByRole('button', { name: 'Share preview' });
  await expect(shareBtn).toBeVisible();
  const newLinkPanel = page.locator('#new-link-panel');
  await expect(newLinkPanel).toBeHidden();
  await shareSection.screenshot({ path: shotPath('sl-3-initial.png') });

  await shareBtn.click();
  const linkInput = page.locator('#created-link-url');
  await expect(linkInput).toBeVisible();
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]{40,}$/);
  const createdUrl = await linkInput.inputValue();
  await expect(page.getByText('This link is shown only once. Copy it now.')).toBeVisible();
  await shareSection.screenshot({ path: shotPath('sl-3-link-created.png') });

  const copyBtn = page.getByRole('button', { name: 'Copy' });
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(createdUrl);

  const list = page.getByRole('list', { name: 'Active preview links' });
  await expect(list).toBeVisible();
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list.getByText(/Expires/i)).toBeVisible();
  await shareSection.screenshot({ path: shotPath('sl-3-list.png') });

  const revokeBtn = list.getByRole('button', { name: 'Revoke' }).first();
  await revokeBtn.click();
  await expect(newLinkPanel).toBeHidden();
  await expect(linkInput).toHaveValue('');
  await expect(list.locator('li')).toHaveCount(0);

  const [dbRow] = await sql`
    select revoked_at from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})
    order by created_at desc
    limit 1
  `;
  expect(dbRow.revoked_at).not.toBeNull();
  await shareSection.screenshot({ path: shotPath('sl-3-after-revoke.png') });

  const siteOrigin = new URL(page.url()).origin;

  const countBeforeEvil = await sql`
    select count(*)::int as count from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})
  `;
  const evilOwnerPost = await page.request.post(`/api/submissions/${gameId}/preview-links`, {
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
  });
  expect(evilOwnerPost.status()).toBe(403);
  const countAfterEvil = await sql`
    select count(*)::int as count from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})
  `;
  expect(countAfterEvil[0].count).toBe(countBeforeEvil[0].count);

  const validOwnerPost = await page.request.post(`/api/submissions/${gameId}/preview-links`, {
    headers: { Origin: siteOrigin },
  });
  expect(validOwnerPost.status()).toBe(201);
  const cacheControl = validOwnerPost.headers()['cache-control'] ?? '';
  expect(cacheControl).toContain('no-store');

  const validOwnerData = await validOwnerPost.json();
  const evilOwnerRevoke = await page.request.post(`/api/submissions/${gameId}/preview-links/${validOwnerData.id}/revoke`, {
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
  });
  expect(evilOwnerRevoke.status()).toBe(403);

  const validOwnerRevoke = await page.request.post(`/api/submissions/${gameId}/preview-links/${validOwnerData.id}/revoke`, {
    headers: { Origin: siteOrigin },
  });
  expect(validOwnerRevoke.status()).toBe(200);

  for (let i = 0; i < 5; i++) {
    await shareBtn.click();
    await expect(list.locator('li')).toHaveCount(i + 1);
  }

  await shareBtn.click();
  const capMsg = page.getByText('You already have 5 active preview links. Revoke one to create another.');
  await expect(capMsg).toBeVisible();
  await shareSection.screenshot({ path: shotPath('sl-3-cap-message.png') });

  const ownerPost = await page.request.post(`/api/submissions/${gameId}/preview-links`, {
    headers: { Origin: siteOrigin },
  });
  expect(ownerPost.status()).toBe(409);
  const ownerPostData = await ownerPost.json();
  expect(ownerPostData.error).toBe('You already have 5 active preview links. Revoke one to create another.');

  const [activeLinkRow] = await sql`
    select id from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})
      and revoked_at is null
    limit 1
  `;
  const activeLinkId = activeLinkRow.id;

  const countBeforeNonOwner = await sql`
    select count(*)::int as count from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})
  `;

  const missingLinkRevoke = await page.request.post(`/api/submissions/${gameId}/preview-links/00000000-0000-0000-0000-000000000000/revoke`, {
    headers: { Origin: siteOrigin },
  });
  expect(missingLinkRevoke.status()).toBe(404);
  expect(await missingLinkRevoke.json()).toEqual({ error: 'Not found' });

  const malformedLinkRevoke = await page.request.post(`/api/submissions/${gameId}/preview-links/not-a-valid-uuid/revoke`, {
    headers: { Origin: siteOrigin },
  });
  expect(malformedLinkRevoke.status()).toBe(404);
  expect(await malformedLinkRevoke.json()).toEqual({ error: 'Not found' });

  const unvalidatedGameSlug = `unval-${stamp}`;
  const [unvalidatedGame] = await sql`
    insert into public.games (id, slug, owner_id, creator, title, stage)
    values (${unvalidatedGameSlug}, ${unvalidatedGameSlug}, (select owner_id from public.games where id = ${gameId}), 'creator', 'Unvalidated', 'pending')
    returning id
  `;
  try {
    const unvalidatedPost = await page.request.post(`/api/submissions/${unvalidatedGame.id}/preview-links`, {
      headers: { Origin: siteOrigin },
    });
    expect(unvalidatedPost.status()).toBe(404);
    expect(await unvalidatedPost.json()).toEqual({ error: 'Not found' });
  } finally {
    await sql`delete from public.games where id = ${unvalidatedGame.id}`;
  }

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  const otherStamp = `${stamp}u`;
  await signUp(otherPage, otherStamp);

  await otherPage.goto(`/submissions/${gameId}`);
  await expect(otherPage.locator('#share-links')).toHaveCount(0);
  await expect(otherPage.getByRole('button', { name: 'Share preview' })).toHaveCount(0);
  await otherPage.screenshot({ path: shotPath('sl-3-nonowner-user.png') });

  const otherPost = await otherPage.request.post(`/api/submissions/${gameId}/preview-links`, {
    headers: { Origin: siteOrigin },
  });
  expect(otherPost.status()).toBe(404);
  expect(await otherPost.json()).toEqual({ error: 'Not found' });

  const otherList = await otherPage.request.get(`/api/submissions/${gameId}/preview-links`);
  expect(otherList.status()).toBe(404);
  expect(await otherList.json()).toEqual({ error: 'Not found' });

  const nonExistentGameId = 'zzzzzzzz';
  const otherNonExistentPost = await otherPage.request.post(`/api/submissions/${nonExistentGameId}/preview-links`, {
    headers: { Origin: siteOrigin },
  });
  expect(otherNonExistentPost.status()).toBe(404);
  expect(await otherNonExistentPost.json()).toEqual(await otherPost.json());

  const otherRevoke = await otherPage.request.post(`/api/submissions/${gameId}/preview-links/${activeLinkId}/revoke`, {
    headers: { Origin: siteOrigin },
  });
  expect(otherRevoke.status()).toBe(404);
  expect(await otherRevoke.json()).toEqual({ error: 'Not found' });

  const countAfterOther = await sql`
    select count(*)::int as count from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})
  `;
  expect(countAfterOther[0].count).toBe(countBeforeNonOwner[0].count);

  const [activeAfterOther] = await sql`
    select revoked_at from public.preview_links where id = ${activeLinkId}
  `;
  expect(activeAfterOther.revoked_at).toBeNull();

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const adminStamp = `${stamp}a`;
  await signUp(adminPage, adminStamp);
  await sql`update public.profiles set role = 'admin' where handle = ${adminStamp}`;

  await adminPage.goto(`/submissions/${gameId}`);
  await expect(adminPage.locator('#share-links')).toHaveCount(0);
  await expect(adminPage.getByRole('button', { name: 'Share preview' })).toHaveCount(0);
  await adminPage.screenshot({ path: shotPath('sl-3-nonowner-admin.png') });

  const adminPost = await adminPage.request.post(`/api/submissions/${gameId}/preview-links`, {
    headers: { Origin: siteOrigin },
  });
  expect(adminPost.status()).toBe(404);
  expect(await adminPost.json()).toEqual({ error: 'Not found' });

  const adminList = await adminPage.request.get(`/api/submissions/${gameId}/preview-links`);
  expect(adminList.status()).toBe(404);
  expect(await adminList.json()).toEqual({ error: 'Not found' });

  const adminRevoke = await adminPage.request.post(`/api/submissions/${gameId}/preview-links/${activeLinkId}/revoke`, {
    headers: { Origin: siteOrigin },
  });
  expect(adminRevoke.status()).toBe(404);
  expect(await adminRevoke.json()).toEqual({ error: 'Not found' });

  const countAfterAdmin = await sql`
    select count(*)::int as count from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})
  `;
  expect(countAfterAdmin[0].count).toBe(countBeforeNonOwner[0].count);

  const [activeAfterAdmin] = await sql`
    select revoked_at from public.preview_links where id = ${activeLinkId}
  `;
  expect(activeAfterAdmin.revoked_at).toBeNull();

  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();

  await anonPage.goto(`/submissions/${gameId}`);
  await anonPage.waitForURL(/\/login/);
  await expect(anonPage.locator('#share-links')).toHaveCount(0);
  await expect(anonPage.getByRole('button', { name: 'Share preview' })).toHaveCount(0);
  await anonPage.screenshot({ path: shotPath('sl-3-nonowner-anon.png') });

  const anonPost = await anonPage.request.post(`/api/submissions/${gameId}/preview-links`, {
    headers: { Origin: siteOrigin },
  });
  expect(anonPost.status()).toBe(401);

  const anonList = await anonPage.request.get(`/api/submissions/${gameId}/preview-links`);
  expect(anonList.status()).toBe(401);

  const anonRevoke = await anonPage.request.post(`/api/submissions/${gameId}/preview-links/${activeLinkId}/revoke`, {
    headers: { Origin: siteOrigin },
  });
  expect(anonRevoke.status()).toBe(401);

  const countAfterAnon = await sql`
    select count(*)::int as count from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})
  `;
  expect(countAfterAnon[0].count).toBe(countBeforeNonOwner[0].count);

  await context.close();
  await otherContext.close();
  await adminContext.close();
  await anonContext.close();
});

test('hourly preview link creation cap enforcement', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const stamp = `sl3h${Date.now().toString(36)}`;
  const { gameId } = await createValidatedGame(page, stamp);

  const shareSection = page.locator('#share-links');
  const shareBtn = page.getByRole('button', { name: 'Share preview' });
  const list = page.getByRole('list', { name: 'Active preview links' });

  for (let i = 0; i < 5; i++) {
    await shareBtn.click();
    await expect(list.locator('li')).toHaveCount(i + 1);
  }

  for (let i = 0; i < 5; i++) {
    const revokeBtn = list.getByRole('button', { name: 'Revoke' }).first();
    await revokeBtn.click();
    await expect(list.locator('li')).toHaveCount(4 - i);
  }

  for (let i = 0; i < 5; i++) {
    await shareBtn.click();
    await expect(list.locator('li')).toHaveCount(i + 1);
  }

  const revokeOne = list.getByRole('button', { name: 'Revoke' }).first();
  await revokeOne.click();
  await expect(list.locator('li')).toHaveCount(4);

  await shareBtn.click();
  const hourMsg = page.getByText("You've created 10 preview links in the last hour. Try again later.");
  await expect(hourMsg).toBeVisible();
  await shareSection.screenshot({ path: shotPath('sl-3-hour-cap.png') });

  const siteOrigin = new URL(page.url()).origin;
  const apiPost = await page.request.post(`/api/submissions/${gameId}/preview-links`, {
    headers: { Origin: siteOrigin },
  });
  expect(apiPost.status()).toBe(400);
  const data = await apiPost.json();
  expect(data.error).toBe("You've created 10 preview links in the last hour. Try again later.");

  await context.close();
});

test('an unapproved game with an active preview link is absent from public listings', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const stamp = `sl3b${Date.now().toString(36)}`;
  const { gameId, title } = await createValidatedGame(page, stamp);

  const shareBtn = page.getByRole('button', { name: 'Share preview' });
  await expect(shareBtn).toBeVisible();
  await shareBtn.click();
  await expect(page.locator('#created-link-url')).toBeVisible();

  const [gameRow] = await sql`
    select slug from public.games where id = ${gameId}
  `;
  const slug = gameRow.slug;

  const [liveGame] = await sql`
    select id, title, slug, tags, creator from public.games where stage = 'live' limit 1
  `;
  const originalLiveTags = liveGame.tags ?? [];

  const unapprovedTag = `sl3hidden${stamp}`;
  const liveTag = `sl3live${stamp}`;
  const provingControlSlug = `prvctrl-${stamp}`;

  const anonContext = await browser.newContext();
  const request = anonContext.request;

  try {
    await sql`update public.games set tags = array[${unapprovedTag}] where id = ${gameId}`;
    await sql`insert into public.featured_games (game_id, position, active) values (${gameId}, 0, true)`;

    await sql`update public.games set tags = array[${liveTag}] where id = ${liveGame.id}`;
    await sql`insert into public.featured_games (game_id, position, active) values (${liveGame.id}, 1, true)`;

    await sql`
      insert into public.games (id, slug, owner_id, creator, title, stage)
      values (${provingControlSlug}, ${provingControlSlug}, (select owner_id from public.games where id = ${gameId}), 'creator', 'Proving Control Game', 'proving')
    `;

    await expect.poll(async () => {
      const res = await request.get('/');
      const body = await res.text();
      const featuredIndex = body.indexOf('id="featured-title"');
      if (featuredIndex === -1) return false;
      const featuredSection = body.slice(featuredIndex, body.indexOf('</section>', featuredIndex));
      return featuredSection.includes(liveGame.title);
    }, { timeout: 90_000 }).toBe(true);

    await expect.poll(async () => {
      const res = await request.get('/games');
      const body = await res.text();
      return body.includes(liveTag);
    }, { timeout: 90_000 }).toBe(true);

    const realPages = [
      '/',
      '/games',
      `/games?tag=${encodeURIComponent(unapprovedTag)}`,
      '/proving',
      '/creators',
    ];

    for (const path of realPages) {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(title);
      expect(body).not.toContain(slug);
      if (path.startsWith('/games?tag=')) {
        expect(body).not.toContain(`/play/${slug}`);
        expect(body).toContain(`No graduated games tagged #${unapprovedTag} yet.`);
        expect(body).not.toContain(`>#${unapprovedTag}</a>`);
      } else {
        expect(body).not.toContain(unapprovedTag);
      }
      if (path === '/games') {
        expect(body).toContain(`>#${liveTag}</a>`);
      }
    }

    const liveTagRes = await request.get(`/games?tag=${encodeURIComponent(liveTag)}`);
    expect(liveTagRes.status()).toBe(200);
    const liveTagBody = await liveTagRes.text();
    expect(liveTagBody).toContain(liveGame.title);
    expect(liveTagBody).toContain(liveGame.slug);
    expect(liveTagBody).toContain(`>#${liveTag}</a>`);
    expect(liveTagBody).not.toContain(title);
    expect(liveTagBody).not.toContain(slug);

    const creatorsRes = await request.get('/creators');
    expect(creatorsRes.status()).toBe(200);
    const creatorsBody = await creatorsRes.text();
    expect(creatorsBody).toContain('Ship one file. Get played.');
    expect(creatorsBody).toContain('How a game goes live');
    expect(creatorsBody).not.toContain(title);
    expect(creatorsBody).not.toContain(slug);

    const provingRes = await request.get('/proving');
    expect(provingRes.status()).toBe(200);
    const provingBody = await provingRes.text();
    expect(provingBody).toContain('The Proving Grounds');
    expect(provingBody).toContain('Sign in to see your own games in the Proving Grounds.');
    expect(provingBody).not.toContain(title);
    expect(provingBody).not.toContain(slug);
    expect(provingBody).not.toContain('Proving Control Game');

    await page.goto('/proving');
    await expect(page.locator('.slide')).toContainText('Proving Control Game');
    await expect(page.locator('.slide')).not.toContainText(title);

    const ownerRes = await request.get(`/u/${stamp}`);
    expect(ownerRes.status()).toBe(404);
    const ownerBody = await ownerRes.text();
    expect(ownerBody).not.toContain(title);
    expect(ownerBody).not.toContain(slug);
    expect(ownerBody).not.toContain(unapprovedTag);

    const liveCreatorRes = await request.get(`/u/${liveGame.creator}`);
    expect(liveCreatorRes.status()).toBe(200);
    const liveCreatorBody = await liveCreatorRes.text();
    expect(liveCreatorBody).toContain(liveGame.title);

    const homeRes = await request.get('/');
    expect(homeRes.status()).toBe(200);
    const homeBody = await homeRes.text();
    const featuredIndex = homeBody.indexOf('id="featured-title"');
    if (featuredIndex !== -1) {
      const featuredSection = homeBody.slice(featuredIndex, homeBody.indexOf('</section>', featuredIndex));
      expect(featuredSection).not.toContain(slug);
    }

    const v1Res = await request.get('/api/v1/games');
    expect(v1Res.status()).toBe(401);

    const playRes = await request.get(`/play/${slug}`);
    expect(playRes.status()).toBe(404);

    const subRes = await request.get(`/submissions/${gameId}`, { maxRedirects: 0 });
    expect(subRes.status()).toBe(302);
    expect(subRes.headers().location).toContain('/login');

    const anonPage = await anonContext.newPage();
    await anonPage.goto('/games');
    await anonPage.screenshot({ path: shotPath('sl-3-public-games.png') });
  } finally {
    await sql`delete from public.featured_games where game_id in (${gameId}, ${liveGame.id})`;
    await sql`update public.games set tags = ${originalLiveTags} where id = ${liveGame.id}`;
    await sql`delete from public.games where id = ${provingControlSlug}`;
    await context.close();
    await anonContext.close();
  }
});

test('creator picks a link lifetime, and share is refused once no version can open', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const stamp = `sl5${Date.now().toString(36)}`;
  const { gameId } = await createValidatedGame(page, stamp);
  const siteOrigin = new URL(page.url()).origin;
  const lifetime = (id) => sql`
    select extract(epoch from expires_at - created_at)::int as seconds from public.preview_links where id = ${id}::uuid`;

  const shareSection = page.locator('#share-links');
  const ttl = page.getByLabel('Link lasts');
  await expect(ttl).toHaveValue('24');
  await expect(page.locator('#share-version')).toHaveText('Anyone with the link can play version 1 without an account until the link expires.');

  await ttl.selectOption({ label: '1 hour' });
  await page.getByRole('button', { name: 'Share preview' }).click();
  const list = page.getByRole('list', { name: 'Active preview links' });
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list.locator('li').first()).toContainText('Version 1 · Expires in 1 hour · 0 views');
  const [created] = await sql`
    select id from public.preview_links
    where version_id in (select id from public.game_validations where game_id = ${gameId})`;
  expect((await lifetime(created.id))[0].seconds).toBe(3600);
  await shareSection.screenshot({ path: shotPath('sl-5-one-hour.png') });

  await page.reload();
  await expect(list.locator('li').first()).toContainText(/Version 1 · Expires in (60 min|1 hour) · 0 views/);

  const week = await page.request.post(`/api/submissions/${gameId}/preview-links`, { headers: { Origin: siteOrigin }, data: { ttlHours: 168 } });
  expect(week.status()).toBe(201);
  const weekBody = await week.json();
  expect(weekBody.version).toBe(1);
  expect((await lifetime(weekBody.id))[0].seconds).toBe(7 * 24 * 3600);

  const countBefore = await sql`select count(*)::int as n from public.preview_links where owner_id = (select owner_id from public.games where id = ${gameId})`;
  for (const ttlHours of [12, 0, 720, 'forever']) {
    const bad = await page.request.post(`/api/submissions/${gameId}/preview-links`, { headers: { Origin: siteOrigin }, data: { ttlHours } });
    expect(bad.status()).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Choose how long the link lasts.' });
  }

  await sql`update public.game_validations set status = 'failed' where game_id = ${gameId}`;
  await page.reload();
  await expect(page.locator('#share-blocked')).toHaveText('This version failed its checks. Upload a fixed version to share it.');
  await expect(page.getByRole('button', { name: 'Share preview' })).toBeDisabled();
  await expect(ttl).toBeDisabled();
  await shareSection.screenshot({ path: shotPath('sl-5-failed.png') });
  const failed = await page.request.post(`/api/submissions/${gameId}/preview-links`, { headers: { Origin: siteOrigin } });
  expect(failed.status()).toBe(409);
  expect(await failed.json()).toEqual({ error: 'This version failed its checks. Upload a fixed version to share it.' });

  await sql`update public.game_validations set status = 'passed' where game_id = ${gameId}`;
  await sql`update public.games set stage = 'proving' where id = ${gameId}`;
  await page.reload();
  await expect(page.locator('#share-links')).toHaveCount(0);
  const live = await page.request.post(`/api/submissions/${gameId}/preview-links`, { headers: { Origin: siteOrigin } });
  expect(live.status()).toBe(409);
  expect(await live.json()).toEqual({ error: 'This game is already public. Share its page instead.' });

  await sql`update public.games set stage = 'rejected' where id = ${gameId}`;
  await page.reload();
  await expect(page.locator('#share-links')).toHaveCount(0);
  const rejected = await page.request.post(`/api/submissions/${gameId}/preview-links`, { headers: { Origin: siteOrigin } });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toEqual({ error: 'This game was rejected. Upload a fixed version to share it.' });

  const countAfter = await sql`select count(*)::int as n from public.preview_links where owner_id = (select owner_id from public.games where id = ${gameId})`;
  expect(countAfter[0].n).toBe(countBefore[0].n);
  await context.close();
});
