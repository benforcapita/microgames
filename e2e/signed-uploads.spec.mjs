// UP-2a: browser-direct asset uploads via signed Storage URLs.
// POST /api/games/<slug>/assets/sign mints a one-path signed upload URL (owner only, path rules +
// file-count cap + 4 MB version cap + rate limit). The browser PUTs bytes straight to Supabase;
// POST /api/games/<slug>/assets/finalize scans the stored bytes, re-checks the caps and writes the
// 'uploaded' row. Orphans (never finalized) are not assets and are not served by the CDN.
import { test, expect, request as pwRequest } from '@playwright/test';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 4721}`;
const CDN = `http://127.0.0.1:${process.env.E2E_CDN_PORT ?? 4722}`;
const sb = localSupabaseEnv();
const sql = postgres(sb.DATABASE_URL, { max: 2 });
const service = createClient(sb.PUBLIC_SUPABASE_URL, sb.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const gamesBucket = () => service.storage.from('games');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const wav = (n) => {
  const b = Buffer.alloc(n);
  b.write('RIFF', 0);
  b.writeUInt32LE(n - 8, 4);
  b.write('WAVE', 8);
  return b;
};
const SMALL_WAV = wav(256);

const ctx = () => pwRequest.newContext({ baseURL: WEB, extraHTTPHeaders: { Origin: WEB } });
const sign = (c, slug, body) => c.post(`/api/games/${slug}/assets/sign`, { data: body });
const finalize = (c, slug, body) => c.post(`/api/games/${slug}/assets/finalize`, { data: body });
const putSigned = (url, bytes, contentType) => fetch(url, { method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'true' }, body: bytes });
const assetUrl = (id, path) => `${CDN}/g/${id}/1/${path}`;

const RUN = Date.now().toString(36);

async function signup(c, tag) {
  const email = `up2a-${tag}-${RUN}@example.test`;
  const password = 'up2a-pass-123';
  let r = await c.post('/api/auth/login', { multipart: { mode: 'signup', email, password, next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'signup').toBe(303);
  r = await c.post('/api/profile', { multipart: { handle: `up2a${tag}${RUN}`.slice(0, 32), next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'handle').toBe(303);
  return { email, password };
}

async function uploadGame(c, title) {
  const r = await c.post('/api/games', {
    maxRedirects: 0,
    multipart: {
      title,
      license: 'MIT',
      agree: 'on',
      game: { name: 'g.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><body>up2a</body></html>') },
      thumb: { name: 't.png', mimeType: 'image/png', buffer: PNG },
    },
  });
  expect(r.status(), 'game upload').toBe(303);
  const seg = new URL(r.headers()['location'], WEB).pathname.split('/')[2];
  const [game] = await sql`select id, slug, stage from public.games where slug = ${seg} or id = ${seg}`;
  expect(game, 'game row').toBeTruthy();
  return game;
}

const objectExists = async (key) => !(await gamesBucket().download(key)).error;

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

test('UP-2a sign: anonymous 401, non-owner 404, owner 200', async () => {
  const owner = await ctx();
  await signup(owner, 'own');
  const game = await uploadGame(owner, `UP2a owner ${Date.now()}`);
  const other = await ctx();
  await signup(other, 'oth');
  const anon = await ctx();

  const body = { path: 'sfx/jump.wav', size: SMALL_WAV.length, contentType: 'audio/wav' };
  expect((await sign(anon, game.slug, body)).status()).toBe(401);
  expect((await sign(other, game.slug, body)).status()).toBe(404);
  const ok = await sign(owner, game.slug, body);
  expect(ok.status()).toBe(200);
  const data = await ok.json();
  expect(data.url).toContain(`/object/upload/sign/games/${game.id}/1/sfx/jump.wav`);
  expect(data.token).toBeTruthy();
  await Promise.all([owner, other, anon].map((c) => c.dispose()));
});

test('UP-2a signed URL writes exactly one path', async () => {
  const c = await ctx();
  await signup(c, 'one');
  const game = await uploadGame(c, `UP2a single ${Date.now()}`);
  const r = await sign(c, game.slug, { path: 'sfx/a.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
  const { url, token } = await r.json();

  expect((await putSigned(url, SMALL_WAV, 'audio/wav')).status).toBe(200);
  expect(await objectExists(`${game.id}/1/sfx/a.wav`)).toBe(true);

  // Same token, different object path -> the signature binds the path.
  const otherPath = url.replace('/sfx/a.wav', '/sfx/b.wav');
  const bad = await putSigned(otherPath, SMALL_WAV, 'audio/wav');
  expect([400, 403]).toContain(bad.status);
  expect(await objectExists(`${game.id}/1/sfx/b.wav`)).toBe(false);

  // The token cannot be replayed through the client API on another path either.
  const viaApi = await service.storage.from('games').uploadToSignedUrl('other/x.png', token, PNG);
  expect(viaApi.error).toBeTruthy();
  await c.dispose();
});

test('UP-2a finalize rejects a bad file and deletes the stored object', async () => {
  const c = await ctx();
  await signup(c, 'bad');
  const game = await uploadGame(c, `UP2a bad ${Date.now()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  const s = await sign(c, game.slug, { path: 'sprites/evil.png', size: SVG.length, contentType: 'image/png' });
  const { url } = await s.json();
  expect((await putSigned(url, SVG, 'image/png')).status).toBe(200);

  const f = await finalize(c, game.slug, { path: 'sprites/evil.png' });
  expect(f.status()).toBe(400);
  const body = await f.json();
  expect(['markup', 'type', 'extension', 'mismatch']).toContain(body.error);

  const key = `${game.id}/1/sprites/evil.png`;
  expect(await objectExists(key), 'unvetted bytes must be deleted').toBe(false);
  const [row] = await sql`select status from public.game_assets where game_id = ${game.id} and path = 'sprites/evil.png'`;
  expect(row?.status).toBe('rejected');
  expect((await fetch(assetUrl(game.id, 'sprites/evil.png'))).status, 'rejected object is never served').toBe(404);

  // Finalize for a path that was signed but never PUT -> 404, no row.
  const missing = await finalize(c, game.slug, { path: 'sfx/never.wav' });
  expect(missing.status()).toBe(404);
  await c.dispose();
});

test('UP-2a caps: file-count and 4 MB enforced at both sign and finalize', async () => {
  const c = await ctx();
  await signup(c, 'cap');
  const game = await uploadGame(c, `UP2a caps ${Date.now()}`);

  // Seat the game at 199 manifest rows so the next row is the 200th.
  await sql`
    insert into public.game_assets (game_id, version, path, expected_type, status, source)
    select ${game.id}, 1, 'fill-' || g::text || '.png', 'image', 'missing', 'scan'
    from generate_series(1, 199) g
  `;

  const ok = await sign(c, game.slug, { path: 'one.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
  expect(ok.status(), 'row 200 may still be signed').toBe(200);
  const second = await sign(c, game.slug, { path: 'two.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
  expect(second.status(), 'sign is per-path; a second pending path is still legal').toBe(200);

  const { url: url1 } = await ok.json();
  const { url: url2 } = await second.json();
  await putSigned(url1, SMALL_WAV, 'audio/wav');
  await putSigned(url2, SMALL_WAV, 'audio/wav');

  expect((await finalize(c, game.slug, { path: 'one.wav' })).status()).toBe(200); // row 200
  const capped = await finalize(c, game.slug, { path: 'two.wav' });
  expect(capped.status()).toBe(409);
  expect((await capped.json()).error).toBe('cap');
  expect(await objectExists(`${game.id}/1/two.wav`)).toBe(false);

  const denied = await sign(c, game.slug, { path: 'three.wav', size: 10, contentType: 'audio/wav' });
  expect(denied.status()).toBe(409);
  expect((await denied.json()).error).toBe('cap');

  // 4 MB cap on a second game (game A is at the file cap, so its failures would be 'cap' anyway).
  const gameB = await uploadGame(c, `UP2a sizecap ${Date.now()}`);
  const [g] = await sql`select size_bytes from public.games where id = ${gameB.id}`;
  const room = 4 * 1024 * 1024 - g.size_bytes;
  const declaredTooBig = await sign(c, gameB.slug, { path: 'big.wav', size: room + 1, contentType: 'audio/wav' });
  expect(declaredTooBig.status()).toBe(413);
  expect((await declaredTooBig.json()).error).toBe('too-big');

  // Lying about the size is caught at finalize on the real bytes.
  const lie = await sign(c, gameB.slug, { path: 'lie.wav', size: 100, contentType: 'audio/wav' });
  expect(lie.status(), 'declared small so signing passes').toBe(200);
  const { url: lieUrl } = await lie.json();
  const big = wav(room + 1024);
  await putSigned(lieUrl, big, 'audio/wav');
  const lieFin = await finalize(c, gameB.slug, { path: 'lie.wav' });
  expect(lieFin.status()).toBe(413);
  expect((await lieFin.json()).error).toBe('too-big');
  expect(await objectExists(`${gameB.id}/1/lie.wav`)).toBe(false);
  await c.dispose();
});

test('UP-2a orphan upload: PUT to a signed URL is not served until finalize', async () => {
  const c = await ctx();
  await signup(c, 'orph');
  const game = await uploadGame(c, `UP2a orphan ${Date.now()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  const s = await sign(c, game.slug, { path: 'sprites/orphan.png', size: PNG.length, contentType: 'image/png' });
  const { url } = await s.json();
  await putSigned(url, PNG, 'image/png');
  expect(await objectExists(`${game.id}/1/sprites/orphan.png`)).toBe(true);

  const res = await fetch(assetUrl(game.id, 'sprites/orphan.png'));
  expect(res.status, 'orphan bytes must not be served').toBe(404);
  const [count] = await sql`select count(*)::int as n from public.game_assets where game_id = ${game.id} and status = 'uploaded'`;
  expect(count.n, 'orphan does not count as an asset').toBe(0);
  await c.dispose();
});

test('UP-2a anon and authenticated roles cannot write the bucket; only signed URLs/service role can', async () => {
  const c = await ctx();
  const { email, password } = await signup(c, 'rls');
  const game = await uploadGame(c, `UP2a rls ${Date.now()}`);
  const victim = `${game.id}/1/rls.png`;
  const attacker = `${game.id}/1/attacker.png`;
  const PWNED = Buffer.from('PWNED-BYTES');

  // Seed an object as the service role so update/delete have a real target.
  expect((await gamesBucket().upload(victim, PNG, { contentType: 'image/png' })).error).toBeNull();

  const anon = createClient(sb.PUBLIC_SUPABASE_URL, sb.PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const authed = createClient(sb.PUBLIC_SUPABASE_URL, sb.PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const login = await authed.auth.signInWithPassword({ email, password });
  expect(login.error).toBeNull();

  for (const [name, client] of [['anon', anon], ['authenticated', authed]]) {
    expect((await client.storage.from('games').upload(attacker, PWNED, { contentType: 'image/png' })).error, `${name} insert`).toBeTruthy();
    expect((await client.storage.from('games').upload(victim, PWNED, { contentType: 'image/png', upsert: true })).error, `${name} overwrite`).toBeTruthy();
    expect((await client.storage.from('games').update(victim, PWNED, { contentType: 'image/png' })).error, `${name} update`).toBeTruthy();
    // remove() may report success while deleting nothing it cannot see — assert the object survives.
    await client.storage.from('games').remove([victim]);
    expect((await client.storage.from('games').createSignedUploadUrl(`${game.id}/1/mint.png`)).error, `${name} cannot mint`).toBeTruthy();
  }

  expect(await objectExists(attacker), 'no anon/authenticated object may land').toBe(false);
  const dl = await gamesBucket().download(victim);
  expect(dl.error).toBeNull();
  expect(Buffer.from(await dl.data.arrayBuffer()).equals(PNG), 'victim bytes untouched').toBe(true);

  // Allowed pairing: the service role (and, proven elsewhere, the signed URL) can write.
  const probe = `${game.id}/1/service-ok.png`;
  expect((await gamesBucket().upload(probe, PNG, { contentType: 'image/png' })).error).toBeNull();
  await gamesBucket().remove([probe]);
  await c.dispose();
});

test('UP-2a happy path: sign -> PUT -> finalize -> row -> CDN 200', async () => {
  const c = await ctx();
  await signup(c, 'happy');
  const game = await uploadGame(c, `UP2a happy ${Date.now()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  const s = await sign(c, game.slug, { path: 'sfx/jump.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
  expect(s.status()).toBe(200);
  const { url, objectPath } = await s.json();
  expect(objectPath).toBe(`${game.id}/1/sfx/jump.wav`);

  expect((await putSigned(url, SMALL_WAV, 'audio/wav')).status).toBe(200);

  const f = await finalize(c, game.slug, { path: 'sfx/jump.wav' });
  expect(f.status()).toBe(200);
  const done = await f.json();
  expect(done.path).toBe('sfx/jump.wav');
  expect(done.sizeBytes).toBe(SMALL_WAV.length);

  const [row] = await sql`select status, size_bytes, source from public.game_assets where game_id = ${game.id} and path = 'sfx/jump.wav'`;
  expect(row?.status).toBe('uploaded');
  expect(row?.size_bytes).toBe(SMALL_WAV.length);

  const res = await fetch(assetUrl(game.id, 'sfx/jump.wav'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('audio/wav');
  expect(Buffer.from(await res.arrayBuffer()).equals(SMALL_WAV)).toBe(true);
  await c.dispose();
});

test('UP-2a signed URL cannot replace a finalized asset without finalize', async () => {
  const c = await ctx();
  await signup(c, 'swap');
  const game = await uploadGame(c, `UP2a swap ${Date.now()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  // v1 through the whole flow: signed, uploaded, scanned, finalized.
  const v1 = wav(320);
  const s1 = await sign(c, game.slug, { path: 'sfx/beep.wav', size: v1.length, contentType: 'audio/wav' });
  const one = await s1.json();
  expect((await putSigned(one.url, v1, 'audio/wav')).status).toBe(200);
  expect((await finalize(c, game.slug, { path: 'sfx/beep.wav', uploadId: one.uploadId })).status()).toBe(200);
  const first = await fetch(assetUrl(game.id, 'sfx/beep.wav'));
  expect(Buffer.from(await first.arrayBuffer()).equals(v1)).toBe(true);

  // Sign the same path again and PUT hostile bytes — but never finalize.
  const v2 = wav(512);
  const s2 = await sign(c, game.slug, { path: 'sfx/beep.wav', size: v2.length, contentType: 'audio/wav' });
  expect(s2.status(), 're-signing a finalized path is allowed (replacement flow)').toBe(200);
  const two = await s2.json();
  expect((await putSigned(two.url, v2, 'audio/wav')).status).toBe(200);

  // The served object must still be the scanned v1 bytes — the row says 'uploaded', so whatever
  // sits at that storage key is what the CDN hands out. Read it directly: the CDN's object cache
  // can mask an overwrite for its TTL.
  const served = await gamesBucket().download(`${game.id}/1/sfx/beep.wav`);
  expect(served.error).toBeNull();
  expect(Buffer.from(await served.data.arrayBuffer()).equals(v1), 'served object still holds the finalized bytes').toBe(true);

  const still = await fetch(assetUrl(game.id, 'sfx/beep.wav'));
  expect(still.status).toBe(200);
  expect(Buffer.from(await still.arrayBuffer()).equals(v1), 'CDN must keep serving the finalized bytes').toBe(true);
  await c.dispose();
});
