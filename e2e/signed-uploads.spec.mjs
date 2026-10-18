// UP-2a: browser-direct asset uploads via signed Storage URLs.
// POST /api/games/<slug>/assets/sign mints a one-path signed upload URL (owner only, path rules +
// file-count cap + 4 MB version cap + rate limit). The browser PUTs bytes straight to Supabase;
// POST /api/games/<slug>/assets/finalize scans the stored bytes, re-checks the caps and writes the
// 'uploaded' row. Orphans (never finalized) are not assets and are not served by the CDN.
import { randomBytes } from 'node:crypto';
import { test, expect, request as pwRequest } from '@playwright/test';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';
import { GAME_VERSION_MAX_BYTES } from '../src/lib/asset-limits.ts';
import { approveGame } from './approve-game.mjs';

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

// Every title/email/handle gets its own random suffix: --repeat-each runs in the same worker
// share module state, and Date.now() slugs collide across parallel workers on games_slug_key.
const uniq = () => randomBytes(5).toString('hex');

async function signup(c, tag) {
  const id = `${tag}${uniq()}`;
  const email = `up2a-${id}@example.test`;
  const password = 'up2a-pass-123';
  let r = await c.post('/api/auth/login', { multipart: { mode: 'signup', email, password, next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'signup').toBe(303);
  r = await c.post('/api/profile', { multipart: { handle: `up2a${id}`.slice(0, 32), next: '/me' }, maxRedirects: 0 });
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
  const game = await uploadGame(owner, `UP2a owner ${uniq()}`);
  const other = await ctx();
  await signup(other, 'oth');
  const anon = await ctx();

  const body = { path: 'sfx/jump.wav', size: SMALL_WAV.length, contentType: 'audio/wav' };
  expect((await sign(anon, game.slug, body)).status()).toBe(401);
  expect((await sign(other, game.slug, body)).status()).toBe(404);
  const ok = await sign(owner, game.slug, body);
  expect(ok.status()).toBe(200);
  const data = await ok.json();
  // The signed URL writes a staging object, never the served path.
  expect(data.url).toContain(`/object/upload/sign/games/${game.id}/_staging/`);
  expect(data.url).not.toContain(`/${game.id}/1/sfx/jump.wav`);
  expect(data.token).toBeTruthy();
  expect(data.uploadId).toBeTruthy();
  await Promise.all([owner, other, anon].map((c) => c.dispose()));
});

test('UP-2a signed URL writes exactly one path', async () => {
  const c = await ctx();
  await signup(c, 'one');
  const game = await uploadGame(c, `UP2a single ${uniq()}`);
  const r = await sign(c, game.slug, { path: 'sfx/a.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
  const { url, token, uploadPath } = await r.json();
  expect(uploadPath).toMatch(new RegExp(`^${game.id}/_staging/`));

  expect((await putSigned(url, SMALL_WAV, 'audio/wav')).status).toBe(200);
  expect(await objectExists(uploadPath)).toBe(true);

  // Same token, different object path -> the signature binds the path.
  const otherPath = url.replace(`/${uploadPath.split('/').pop()}`, `/deadbeefdeadbeef`);
  const bad = await putSigned(otherPath, SMALL_WAV, 'audio/wav');
  expect([400, 403]).toContain(bad.status);
  expect(await objectExists(`${game.id}/_staging/deadbeefdeadbeef`)).toBe(false);

  // The token cannot be replayed through the client API on another path either.
  const viaApi = await service.storage.from('games').uploadToSignedUrl('other/x.png', token, PNG);
  expect(viaApi.error).toBeTruthy();
  await c.dispose();
});

test('UP-2a finalize rejects a bad file and deletes the stored object', async () => {
  const c = await ctx();
  await signup(c, 'bad');
  const game = await uploadGame(c, `UP2a bad ${uniq()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  const s = await sign(c, game.slug, { path: 'sprites/evil.png', size: SVG.length, contentType: 'image/png' });
  const { url, uploadId, uploadPath } = await s.json();
  expect((await putSigned(url, SVG, 'image/png')).status).toBe(200);

  const f = await finalize(c, game.slug, { path: 'sprites/evil.png', uploadId });
  expect(f.status()).toBe(400);
  const body = await f.json();
  expect(['markup', 'type', 'extension', 'mismatch']).toContain(body.error);

  expect(await objectExists(uploadPath), 'unvetted staged bytes must be deleted').toBe(false);
  expect(await objectExists(`${game.id}/1/sprites/evil.png`), 'no served object may be written').toBe(false);
  const [row] = await sql`select status from public.game_assets where game_id = ${game.id} and path = 'sprites/evil.png'`;
  expect(row?.status).toBe('rejected');
  expect((await fetch(assetUrl(game.id, 'sprites/evil.png'))).status, 'rejected object is never served').toBe(404);

  // Finalize for a path that was signed but never PUT -> 404, no row.
  const s2 = await sign(c, game.slug, { path: 'sfx/never.wav', size: 10, contentType: 'audio/wav' });
  const two = await s2.json();
  const missing = await finalize(c, game.slug, { path: 'sfx/never.wav', uploadId: two.uploadId });
  expect(missing.status()).toBe(404);
  await c.dispose();
});

test('UP-2a caps: file-count and 4 MB enforced at both sign and finalize', async () => {
  const c = await ctx();
  await signup(c, 'cap');
  const game = await uploadGame(c, `UP2a caps ${uniq()}`);

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

  const one = await ok.json();
  const two = await second.json();
  await putSigned(one.url, SMALL_WAV, 'audio/wav');
  await putSigned(two.url, SMALL_WAV, 'audio/wav');

  expect((await finalize(c, game.slug, { path: 'one.wav', uploadId: one.uploadId })).status()).toBe(200); // row 200
  const capped = await finalize(c, game.slug, { path: 'two.wav', uploadId: two.uploadId });
  expect(capped.status()).toBe(409);
  expect((await capped.json()).error).toBe('cap');
  expect(await objectExists(two.uploadPath), 'staged object deleted on cap').toBe(false);
  expect(await objectExists(`${game.id}/1/two.wav`)).toBe(false);

  const denied = await sign(c, game.slug, { path: 'three.wav', size: 10, contentType: 'audio/wav' });
  expect(denied.status()).toBe(409);
  expect((await denied.json()).error).toBe('cap');

  // 4 MB cap on a second game (game A is at the file cap, so its failures would be 'cap' anyway).
  const gameB = await uploadGame(c, `UP2a sizecap ${uniq()}`);
  const [g] = await sql`select size_bytes from public.games where id = ${gameB.id}`;
  const room = 4 * 1024 * 1024 - g.size_bytes;
  const declaredTooBig = await sign(c, gameB.slug, { path: 'big.wav', size: room + 1, contentType: 'audio/wav' });
  expect(declaredTooBig.status()).toBe(413);
  expect((await declaredTooBig.json()).error).toBe('too-big');

  // Lying about the size is caught at finalize on the real bytes.
  const lie = await sign(c, gameB.slug, { path: 'lie.wav', size: 100, contentType: 'audio/wav' });
  expect(lie.status(), 'declared small so signing passes').toBe(200);
  const lieJson = await lie.json();
  const big = wav(room + 1024);
  await putSigned(lieJson.url, big, 'audio/wav');
  const lieFin = await finalize(c, gameB.slug, { path: 'lie.wav', uploadId: lieJson.uploadId });
  expect(lieFin.status()).toBe(413);
  expect((await lieFin.json()).error).toBe('too-big');
  expect(await objectExists(lieJson.uploadPath), 'staged object deleted on reject').toBe(false);
  expect(await objectExists(`${gameB.id}/1/lie.wav`)).toBe(false);
  await c.dispose();
});

test('UP-2a orphan upload: PUT to a signed URL is not served until finalize', async () => {
  const c = await ctx();
  await signup(c, 'orph');
  const game = await uploadGame(c, `UP2a orphan ${uniq()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  const s = await sign(c, game.slug, { path: 'sprites/orphan.png', size: PNG.length, contentType: 'image/png' });
  const { url, uploadPath } = await s.json();
  await putSigned(url, PNG, 'image/png');
  expect(await objectExists(uploadPath)).toBe(true);

  const res = await fetch(assetUrl(game.id, 'sprites/orphan.png'));
  expect(res.status, 'orphan bytes must not be served').toBe(404);
  // The staging prefix is not a numeric version — the CDN cannot map it to a served object at all.
  const stagedRoute = await fetch(`${CDN}/g/${game.id}/${uploadPath.slice(game.id.length + 1)}`);
  expect(stagedRoute.status, 'staging path is outside the CDN route map').toBe(404);
  const [count] = await sql`select count(*)::int as n from public.game_assets where game_id = ${game.id} and status = 'uploaded'`;
  expect(count.n, 'orphan does not count as an asset').toBe(0);
  await c.dispose();
});

test('UP-2a anon and authenticated roles cannot write the bucket; only signed URLs/service role can', async () => {
  const c = await ctx();
  const { email, password } = await signup(c, 'rls');
  const game = await uploadGame(c, `UP2a rls ${uniq()}`);
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
  const game = await uploadGame(c, `UP2a happy ${uniq()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  const s = await sign(c, game.slug, { path: 'sfx/jump.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
  expect(s.status()).toBe(200);
  const { url, uploadId, uploadPath } = await s.json();
  expect(uploadPath).toMatch(new RegExp(`^${game.id}/_staging/`));

  expect((await putSigned(url, SMALL_WAV, 'audio/wav')).status).toBe(200);

  const f = await finalize(c, game.slug, { path: 'sfx/jump.wav', uploadId });
  expect(f.status()).toBe(200);
  const done = await f.json();
  expect(done.path).toBe('sfx/jump.wav');
  expect(done.sizeBytes).toBe(SMALL_WAV.length);

  const [row] = await sql`select status, size_bytes, source from public.game_assets where game_id = ${game.id} and path = 'sfx/jump.wav'`;
  expect(row?.status).toBe('uploaded');
  expect(row?.size_bytes).toBe(SMALL_WAV.length);
  expect(await objectExists(uploadPath), 'staged object is consumed').toBe(false);

  // The upload demoted the proving game. Approve after the row exists so reviewed_at
  // is not older than the asset.
  await approveGame(game.id, sql);
  const res = await fetch(assetUrl(game.id, 'sfx/jump.wav'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('audio/wav');
  expect(Buffer.from(await res.arrayBuffer()).equals(SMALL_WAV)).toBe(true);
  await c.dispose();
});

test('UP-2a signed URL cannot replace a finalized asset without finalize', async () => {
  const c = await ctx();
  await signup(c, 'swap');
  const game = await uploadGame(c, `UP2a swap ${uniq()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  // v1 through the whole flow: signed, uploaded, scanned, finalized.
  const v1 = wav(320);
  const s1 = await sign(c, game.slug, { path: 'sfx/beep.wav', size: v1.length, contentType: 'audio/wav' });
  const one = await s1.json();
  expect((await putSigned(one.url, v1, 'audio/wav')).status).toBe(200);
  expect((await finalize(c, game.slug, { path: 'sfx/beep.wav', uploadId: one.uploadId })).status()).toBe(200);
  await approveGame(game.id, sql);
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

test('UP-2a sign rejects control characters in the path with 400, before any storage/DB work', async () => {
  const c = await ctx();
  await signup(c, 'ctl');
  const game = await uploadGame(c, `UP2a ctl ${uniq()}`);

  // A NUL or other control character must get the same {error, message} 400 finalize and the
  // legacy multipart POST return — never a 500 from Postgres choking on the path parameter.
  for (const path of ['x.png\u0000.wav', '%00x.png', 'x\u001f.png']) {
    const r = await sign(c, game.slug, { path, size: SMALL_WAV.length, contentType: 'audio/wav' });
    expect(r.status(), JSON.stringify(path)).toBe(400);
    const body = await r.json();
    expect(body.error, JSON.stringify(path)).toBe('control');
    expect(body.message, JSON.stringify(path)).toBe('That path contains a NUL or a control character.');
  }

  // Nothing may be staged or written for the rejected paths.
  const staging = await gamesBucket().list(`${game.id}/_staging`);
  expect(staging.error).toBeNull();
  expect(staging.data ?? [], 'no staged object may be created').toEqual([]);
  const [count] = await sql`select count(*)::int as n from public.game_assets where game_id = ${game.id}`;
  expect(count.n, 'no asset row may be written').toBe(0);
  await c.dispose();
});

test('UP-2a finalize: anonymous 401, non-owner 404, staged object survives for the owner', async () => {
  const owner = await ctx();
  await signup(owner, 'fown');
  const game = await uploadGame(owner, `UP2a fown ${uniq()}`);
  const other = await ctx();
  await signup(other, 'foth');
  const anon = await ctx();

  const s = await sign(owner, game.slug, { path: 'sfx/keep.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
  expect(s.status()).toBe(200);
  const { url, uploadId, uploadPath } = await s.json();
  expect((await putSigned(url, SMALL_WAV, 'audio/wav')).status).toBe(200);
  expect(await objectExists(uploadPath)).toBe(true);

  // A valid uploadId is not a capability: the session decides who may finalize.
  const denied = await finalize(anon, game.slug, { path: 'sfx/keep.wav', uploadId });
  expect(denied.status(), 'signed-out finalize').toBe(401);
  const nonOwner = await finalize(other, game.slug, { path: 'sfx/keep.wav', uploadId });
  expect(nonOwner.status(), 'non-owner finalize').toBe(404);
  expect(await objectExists(uploadPath), "others' finalize attempts must leave the staged bytes alone").toBe(true);

  const own = await finalize(owner, game.slug, { path: 'sfx/keep.wav', uploadId });
  expect(own.status(), 'the owner can still finalize the same uploadId').toBe(200);
  expect(await objectExists(uploadPath), 'staged object is consumed by the real finalize').toBe(false);
  await Promise.all([owner, other, anon].map((c) => c.dispose()));
});

test('UP-2a finalize answers a fixed 500 and deletes the staged object on a DB failure', async () => {
  const c = await ctx();
  await signup(c, 'dbf');
  const game = await uploadGame(c, `UP2a dbfail ${uniq()}`);

  // Inject a real Postgres failure at the row write: a game_assets write for this game's
  // 'dbfail/' path raises. The route must still answer a fixed {error:'storage'} body — the DB
  // message is server-side only — and the staged object must be deleted on every exit path.
  // The function/trigger names and the condition are unique to this invocation: --repeat-each
  // and --workers run copies of this test concurrently on the same database.
  const fn = `mg_test_fail_${uniq()}`;
  await sql.unsafe(`create or replace function public.${fn}() returns trigger language plpgsql as $f$
    begin
      if new.game_id = '${game.id}' and new.path like 'dbfail/%' then raise exception 'injected test failure'; end if;
      return new;
    end
  $f$`);
  await sql.unsafe(`create trigger ${fn} before insert or update on public.game_assets
    for each row execute function public.${fn}()`);
  try {
    const s = await sign(c, game.slug, { path: 'dbfail/x.png', size: PNG.length, contentType: 'image/png' });
    expect(s.status()).toBe(200);
    const { url, uploadId, uploadPath } = await s.json();
    expect((await putSigned(url, PNG, 'image/png')).status).toBe(200);
    expect(await objectExists(uploadPath)).toBe(true);

    const f = await finalize(c, game.slug, { path: 'dbfail/x.png', uploadId });
    expect(f.status()).toBe(500);
    const body = await f.json().catch(() => null);
    expect(body, 'fixed error body — the real DB message is server-side only').toEqual({
      error: 'storage',
      message: 'The file could not be stored. Try again.',
      flash: { error: 'storage' },
    });
    expect(await objectExists(uploadPath), 'staged object must be deleted on a DB failure').toBe(false);
    const [row] = await sql`select status from public.game_assets where game_id = ${game.id} and path = 'dbfail/x.png'`;
    expect(row, 'no asset row may be written').toBeUndefined();
    expect((await fetch(assetUrl(game.id, 'dbfail/x.png'))).status, 'never served').toBe(404);
  } finally {
    await sql.unsafe(`drop trigger if exists ${fn} on public.game_assets`);
    await sql.unsafe(`drop function if exists public.${fn}()`);
    await c.dispose();
  }
});

test('UP-2a finalize re-checks the whole-version 4 MB cap', async () => {
  const c = await ctx();
  await signup(c, 'total');
  const game = await uploadGame(c, `UP2a total ${uniq()}`);
  const [g] = await sql`select size_bytes from public.games where id = ${game.id}`;
  const room = GAME_VERSION_MAX_BYTES - g.size_bytes;
  // Every file fits on its own, and every sign sees the version total still under the cap
  // (no finalized rows yet). Finalized one after another, they would take the version past
  // 4 MB — the cap must be re-checked against the version's real bytes at finalize.
  const size = Math.floor(room * 0.45);
  const staged = [];
  for (let i = 0; i < 4; i++) {
    const path = `bulk/f${i}.wav`;
    const s = await sign(c, game.slug, { path, size, contentType: 'audio/wav' });
    expect(s.status(), `sign ${path}`).toBe(200);
    const j = await s.json();
    expect((await putSigned(j.url, wav(size), 'audio/wav')).status).toBe(200);
    staged.push({ path, ...j });
  }

  const replies = [];
  for (const it of staged) replies.push(await finalize(c, game.slug, { path: it.path, uploadId: it.uploadId }));
  expect(replies[0].status(), 'first file fits').toBe(200);
  expect(replies[1].status(), 'second file still fits').toBe(200);
  for (const r of replies.slice(2)) {
    expect(r.status(), 'a finalize that would pass the version cap is refused').toBe(413);
    expect((await r.json()).error).toBe('too-big');
  }
  for (const it of staged.slice(2)) {
    expect(await objectExists(it.uploadPath), `staged object for ${it.path} must be deleted`).toBe(false);
    expect(await objectExists(`${game.id}/1/${it.path}`), `no served object for ${it.path}`).toBe(false);
    // A 'rejected' audit row is allowed; nothing may be counted as uploaded for that path.
    const [row] = await sql`select status from public.game_assets where game_id = ${game.id} and path = ${it.path}`;
    expect(row?.status ?? 'absent', `${it.path} must not be an uploaded asset`).not.toBe('uploaded');
    expect((await fetch(assetUrl(game.id, it.path))).status, `${it.path} is never served`).toBe(404);
  }
  const [count] = await sql`select count(*)::int as n from public.game_assets where game_id = ${game.id} and version = 1 and status = 'uploaded'`;
  expect(count.n, 'only the two admitted files count toward the version').toBe(2);
  await c.dispose();
});

test('an upload to an approved game is 404 for anon immediately, with no cache window', async () => {
  const c = await ctx();
  await signup(c, 'leak');
  const game = await uploadGame(c, `UP2a leak ${uniq()}`);
  await approveGame(game.id, sql);

  const warm = await fetch(`${CDN}/g/${game.id}/index.html`, { redirect: 'manual' });
  expect([200, 302]).toContain(warm.status);
  await warm.arrayBuffer().catch(() => {});

  const body = Buffer.from('const extra = 1;\n');
  const s = await sign(c, game.slug, { path: 'sprites/extra.js', size: body.length, contentType: 'text/javascript' });
  expect(s.status()).toBe(200);
  const signed = await s.json();
  expect((await putSigned(signed.url, body, 'text/javascript')).status).toBe(200);
  expect((await finalize(c, game.slug, { path: 'sprites/extra.js', uploadId: signed.uploadId })).status()).toBe(200);

  const hidden = await fetch(assetUrl(game.id, 'sprites/extra.js'));
  expect(hidden.status).toBe(404);
  const cache = hidden.headers.get('cache-control') ?? '';
  expect(cache).not.toContain('immutable');
  expect(cache).not.toContain('31536000');
  await c.dispose();
});
