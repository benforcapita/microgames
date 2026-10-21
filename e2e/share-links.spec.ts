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

function pending(description: string): { annotation: { type: string; description: string } } {
  return { annotation: { type: 'todo', description } };
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
    expect(searchBody).toContain('<h1>Play</h1>');
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

test.fixme(
  '/p is noindex and nofollow',
  pending('SL-2: /p noindex is not on main yet'),
  async () => {},
);
test.fixme(
  'a bad preview link, an expired preview link, and a revoked preview link return the same 404',
  pending('SL-2: identical preview 404s are not on main yet'),
  async () => {},
);
test.fixme(
  'the share-link caps return 429 for an eleventh create in an hour and a sixty-first open in a minute',
  pending('SL-3 and SL-2: share-link HTTP 429 is not on main yet'),
  async () => {},
);
test.fixme(
  'a preview response sends noindex, no-referrer, nosniff, and does not allow a shared cache',
  pending('SL-2: preview security headers are not on main yet'),
  async () => {},
);
test.fixme(
  'a preview token is redacted in /P/, %2f, and a JSON \\/p\\/ escape',
  pending('SL-2: preview token redaction is not on main yet'),
  async () => {},
);
