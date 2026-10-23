import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

function databaseUrl(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('DATABASE_URL' in value)) {
    throw new Error('local database url is missing');
  }
  const url = value.DATABASE_URL;
  if (typeof url !== 'string' || url.length === 0) throw new Error('local database url is missing');
  return url;
}

const sql = postgres(databaseUrl(localSupabaseEnv()), { max: 1, onnotice: () => {} });

function jsonError(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('error' in value) || typeof value.error !== 'string') {
    throw new Error('response has no error');
  }
  return value.error;
}

function jsonId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('response has no id');
  }
  return value.id;
}

async function asOwner(tx: postgres.TransactionSql, ownerId: string): Promise<void> {
  await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
  await tx.unsafe('set local role authenticated');
}

async function mint(link: { ownerId: string; versionId: string }): Promise<{ id: string; token: string }> {
  const [created] = await sql.begin(async (tx) => {
    await asOwner(tx, link.ownerId);
    return tx<{ id: string; token: string }[]>`select id, token from public.create_preview_link(${link.versionId}::uuid)`;
  });
  if (!created) throw new Error('preview link was not created');
  return created;
}

interface PreviewFixture {
  ownerId: string;
  title: string;
  token: string;
  versionId: string;
}

async function withPreview(run: (fx: PreviewFixture) => Promise<void>): Promise<void> {
  const ownerId = randomUUID();
  const stamp = randomBytes(4).toString('hex');
  const gameId = `p${stamp}`;
  const title = `Hidden ${stamp}`;
  const handle = `o${gameId}`;
  const sha = 'ab'.repeat(32);
  try {
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${ownerId}, '', now(), now())
    `;
    await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${handle})`;
    await sql`
      insert into public.games (id, slug, owner_id, creator, title, stage)
      values (${gameId}, ${gameId}, ${ownerId}::uuid, ${handle}, ${title}, 'pending')
    `;
    const [version] = await sql<{ id: string }[]>`
      insert into public.game_validations (game_id, version, bundle_sha256, status)
      values (${gameId}, 1, ${sha}, 'passed')
      returning id
    `;
    if (!version) throw new Error('validation row was not created');
    const link = await mint({ ownerId, versionId: version.id });
    await run({ ownerId, title, token: link.token, versionId: version.id });
  } finally {
    await sql`delete from auth.users where id = ${ownerId}::uuid`;
    await sql`delete from public.preview_page_hits`;
  }
}

function withoutDate(headers: Record<string, string>): Record<string, string> {
  const copy = { ...headers };
  delete copy.date;
  return copy;
}

function apiToken(): { token: string; hash: string; prefix: string } {
  const token = `mgp_${randomBytes(32).toString('base64url')}`;
  return { token, hash: createHash('sha256').update(token).digest('hex'), prefix: token.slice(0, 10) };
}

test.afterAll(async () => {
  await sql.end({ timeout: 1 });
});

test('an unapproved game with an active preview link is absent from browse, search, categories, the sitemap, and the public API', async ({ request }) => {
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const stamp = randomBytes(4).toString('hex');
  const pendingId = `p${stamp}`;
  const liveId = `v${stamp}`;
  const title = `Hidden ${stamp}`;
  const liveTitle = `Shown ${stamp}`;
  const tag = `h${pendingId}`;
  const ownerHandle = `o${pendingId}`;
  const strangerHandle = `s${liveId}`;
  const sha = 'ab'.repeat(32);
  const token = apiToken();
  try {
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${ownerId}, '', now(), now())
    `;
    await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${ownerHandle})`;
    await sql`
      insert into public.games (id, slug, owner_id, creator, title, tags, stage)
      values (${pendingId}, ${pendingId}, ${ownerId}::uuid, ${ownerHandle}, ${title}, ${sql.array([tag])}, 'pending')
    `;
    const [version] = await sql<{ id: string }[]>`
      insert into public.game_validations (game_id, version, bundle_sha256, status)
      values (${pendingId}, 1, ${sha}, 'passed')
      returning id
    `;
    if (!version) throw new Error('validation row was not created');
    const link = await mint({ ownerId, versionId: version.id });
    const [resolved] = await sql<{ version_id: string }[]>`
      select version_id from public.resolve_preview_link(${link.token})
    `;
    expect(resolved?.version_id).toBe(version.id);

    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${strangerId}::uuid, 'authenticated', 'authenticated', ${strangerId}, '', now(), now())
    `;
    await sql`insert into public.profiles (id, handle) values (${strangerId}::uuid, ${strangerHandle})`;
    await sql`
      insert into public.games (id, slug, owner_id, creator, title, stage)
      values (${liveId}, ${liveId}, ${strangerId}::uuid, ${strangerHandle}, ${liveTitle}, 'live')
    `;
    await sql`
      insert into public.api_tokens (user_id, name, token_hash, prefix)
      values (${strangerId}::uuid, 'share', ${token.hash}, ${token.prefix})
    `;

    for (const path of ['/', '/games']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const body = await res.text();
      expect(body, path).toContain(liveTitle);
      expect(body, path).not.toContain(title);
      expect(body, path).not.toContain(`/play/${pendingId}`);
    }

    const search = await request.get(`/games?q=${encodeURIComponent(title)}`);
    expect(search.status()).toBe(200);
    const searchBody = await search.text();
    expect(searchBody).toContain('>Play</h1>');
    expect(searchBody).not.toContain(title);
    expect(searchBody).not.toContain(`/play/${pendingId}`);

    const category = await request.get(`/games?tag=${encodeURIComponent(tag)}`);
    expect(category.status()).toBe(200);
    const categoryBody = await category.text();
    expect(categoryBody).toContain(`No graduated games tagged #${tag} yet.`);
    expect(categoryBody).not.toContain(title);
    expect(categoryBody).not.toContain(`/play/${pendingId}`);

    const creator = await request.get(`/u/${ownerHandle}`);
    expect(creator.status(), 'creator').toBe(404);
    const creatorBody = await creator.text();
    expect(creatorBody).not.toContain(title);
    expect(creatorBody).not.toContain(`/play/${pendingId}`);

    for (const path of ['/sitemap.xml', '/sitemap']) {
      const res = await request.get(path);
      expect([200, 404], path).toContain(res.status());
      const body = await res.text();
      expect(body, path).not.toContain(title);
      expect(body, path).not.toContain(pendingId);
    }

    const bearer = { authorization: `Bearer ${token.token}` };
    const list = await request.get('/api/v1/games', { headers: bearer });
    expect(list.status()).toBe(200);
    const listBody = await list.text();
    expect(listBody).toContain(liveTitle);
    expect(listBody).not.toContain(title);
    expect(listBody).not.toContain(pendingId);

    const detail = await request.get(`/api/v1/games/${pendingId}`, { headers: bearer });
    expect(detail.status()).toBe(404);
    const detailBody = await detail.text();
    expect(detailBody).not.toContain(title);
    expect(detailBody).not.toContain(pendingId);

    for (const path of ['/api/v1/games', `/api/v1/games/${pendingId}`]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(401);
      const body = await res.text();
      expect(body, path).not.toContain(title);
      expect(body, path).not.toContain(pendingId);
    }
  } finally {
    await sql`delete from auth.users where id = ${ownerId}::uuid or id = ${strangerId}::uuid`;
  }
});

test('/p is noindex and nofollow', async ({ request }) => {
  const listed = await request.get('/games');
  expect(listed.status()).toBe(200);
  expect(listed.headers()['x-robots-tag'] ?? '').not.toContain('noindex');
  expect(await listed.text()).not.toContain('name="robots" content="noindex, nofollow"');

  const missing = await request.get(`/p/${randomBytes(32).toString('base64url')}`);
  expect(missing.status()).toBe(404);
  expect(missing.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(await missing.text()).toContain('name="robots" content="noindex, nofollow"');

  await withPreview(async (fx) => {
    const play = await request.get(`/p/${fx.token}`);
    expect(play.status()).toBe(200);
    expect(play.headers()['x-robots-tag']).toBe('noindex, nofollow');
    const body = await play.text();
    expect(body).toContain('name="robots" content="noindex, nofollow"');
    expect(body).toContain('Unreviewed, not yet approved');
    expect(body).not.toContain(fx.token);
  });
});

test('a bad preview link, an expired preview link, and a revoked preview link return the same 404', async ({ request }) => {
  await withPreview(async (fx) => {
    const expired = await mint({ ownerId: fx.ownerId, versionId: fx.versionId });
    await sql`update public.preview_links set expires_at = now() where id = ${expired.id}::uuid`;
    const revoked = await mint({ ownerId: fx.ownerId, versionId: fx.versionId });
    await sql.begin(async (tx) => {
      await asOwner(tx, fx.ownerId);
      await tx`select public.revoke_preview_link(${revoked.id}::uuid)`;
    });
    const bad = randomBytes(32).toString('base64url');
    const seen: { status: number; body: string; headers: Record<string, string> }[] = [];
    for (const path of [`/p/${bad}`, `/p/${expired.token}`, `/p/${revoked.token}`]) {
      const res = await request.get(path);
      seen.push({ status: res.status(), body: await res.text(), headers: withoutDate(res.headers()) });
    }
    const first = seen[0];
    if (!first) throw new Error('no preview responses');
    for (const item of seen) {
      expect(item.status).toBe(404);
      expect(item.body).toBe(first.body);
      expect(item.headers).toEqual(first.headers);
    }
    expect(first.body).toContain('This cartridge is missing.');
    expect(first.body).not.toContain(fx.title);
    for (const secret of [fx.token, expired.token, revoked.token, bad]) {
      expect(first.body).not.toContain(secret);
    }
  });
});

test('the share-link caps return 400 for an eleventh create in an hour and 429 for a sixty-first open in a minute', async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = randomBytes(4).toString('hex');
  const handle = `c${stamp}`;
  const email = `${handle}@example.test`;
  const gameId = `g${stamp}`;
  const hourMessage = "You've created 10 preview links in the last hour. Try again later.";
  let ownerId = '';
  try {
    await page.goto('/login?mode=signup&next=/me');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill('testpass1');
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.waitForURL(/\/onboarding/);
    await page.locator('input[name="handle"]').fill(handle);
    await page.getByRole('button', { name: 'Claim handle' }).click();
    await page.waitForURL(/\/me$/);
    const [profile] = await sql<{ id: string }[]>`select id from public.profiles where handle = ${handle}`;
    if (!profile) throw new Error('signed-up profile was not created');
    ownerId = profile.id;
    await sql`
      insert into public.games (id, slug, owner_id, creator, title, stage)
      values (${gameId}, ${gameId}, ${ownerId}::uuid, ${handle}, ${`Cap ${stamp}`}, 'pending')
    `;
    await sql`
      insert into public.game_validations (game_id, version, bundle_sha256, status)
      values (${gameId}, 1, ${'cd'.repeat(32)}, 'passed')
    `;
    const origin = new URL(page.url()).origin;
    const active: string[] = [];
    for (let n = 0; n < 10; n += 1) {
      if (active.length === 4) {
        const id = active.shift();
        if (!id) throw new Error('active preview link is missing');
        const revoked = await page.request.post(`/api/submissions/${gameId}/preview-links/${id}/revoke`, {
          headers: { Origin: origin },
        });
        expect(revoked.status(), `revoke before create ${n + 1}`).toBe(200);
      }
      const created = await page.request.post(`/api/submissions/${gameId}/preview-links`, {
        headers: { Origin: origin },
      });
      expect(created.status(), `create ${n + 1}`).toBe(201);
      active.push(jsonId(await created.json()));
    }
    const blocked = await page.request.post(`/api/submissions/${gameId}/preview-links`, {
      headers: { Origin: origin },
    });
    expect(blocked.status()).toBe(400);
    expect(jsonError(await blocked.json())).toBe(hourMessage);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.preview_links where owner_id = ${ownerId}::uuid
    `;
    if (!row) throw new Error('preview link count is missing');
    expect(row.n).toBe(10);

    await sql`delete from public.preview_page_hits`;
    for (let n = 0; n < 60; n += 1) {
      const opened = await page.request.get(`/p/${randomBytes(32).toString('base64url')}`);
      expect(opened.status(), `open ${n + 1}`).toBe(404);
    }
    const limited = await page.request.get(`/p/${randomBytes(32).toString('base64url')}`);
    expect(limited.status()).toBe(429);
    expect(await limited.text()).toBe('Too many requests');
    expect(limited.headers()['x-robots-tag']).toBe('noindex, nofollow');
  } finally {
    if (ownerId) await sql`delete from auth.users where id = ${ownerId}::uuid`;
    else await sql`delete from auth.users where email = ${email}`;
    await sql`delete from public.preview_page_hits`;
  }
});

test('a preview response sends noindex, no-referrer, nosniff, and does not allow a shared cache', async ({ request }) => {
  const listed = await request.get('/games');
  expect(listed.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  await withPreview(async (fx) => {
    const res = await request.get(`/p/${fx.token}`);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    const cache = headers['cache-control'] ?? '';
    expect(cache).toContain('private');
    expect(cache).toContain('no-store');
    expect(cache).not.toContain('public');
    const body = await res.text();
    expect(body).toContain('name="robots" content="noindex, nofollow"');
    expect(body).not.toContain(fx.token);
  });
});

test('a preview token is redacted in /P/, %2f, and a JSON \\/p\\/ escape', async ({ request }) => {
  await withPreview(async (fx) => {
    const stamp = randomBytes(4).toString('hex');
    try {
      const posted = await request.post('/api/events', {
        data: {
          type: 'error',
          path: `/P/${fx.token}`,
          details: {
            probe: stamp,
            encoded: `%2fp%2f${fx.token}`,
            escaped: `\\/p\\/${fx.token}`,
          },
        },
      });
      expect(posted.status()).toBe(204);
      expect(await posted.text()).not.toContain(fx.token);
      const [row] = await sql<{ path: string | null; details: { encoded?: string; escaped?: string } }[]>`
        select path, details from public.site_events where details->>'probe' = ${stamp}
      `;
      if (!row) throw new Error('stored event was not written');
      const stored = JSON.stringify(row);
      expect(stored).not.toContain(fx.token);
      expect(row.path).toBe(`/p/[redacted]`);
      expect(row.details.encoded).toBe(`%2fp%2f[redacted]`);
      expect(row.details.escaped).toBe(String.raw`\/p\/[redacted]`);
    } finally {
      await sql`delete from public.site_events where details->>'probe' = ${stamp}`;
    }
  });
});
