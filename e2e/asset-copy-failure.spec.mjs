// UP-3: reserve-then-copy means the game_assets row is written before the bytes reach the
// served object path. When that copy fails, the reservation must be undone exactly: a new
// path loses its row and its cap slot; a replaced path gets the displaced row back — every
// file-describing column — and keeps serving the old bytes. The failure is injected for
// exactly one storage.objects key via a per-invocation trigger (the mechanism QA #78 used);
// names are unique per call so --repeat-each and parallel workers share the DB safely.
import { randomBytes } from 'node:crypto';
import { test, expect, request as pwRequest } from '@playwright/test';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';
import { approveGame } from './approve-game.mjs';

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 4721}`;
const CDN = `http://127.0.0.1:${process.env.E2E_CDN_PORT ?? 4722}`;
const sb = localSupabaseEnv();
const sql = postgres(sb.DATABASE_URL, { max: 2 });
const service = createClient(sb.PUBLIC_SUPABASE_URL, sb.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const gamesBucket = () => service.storage.from('games');

const wav = (n, fill = 0) => {
  const b = Buffer.alloc(n, fill);
  b.write('RIFF', 0);
  b.writeUInt32LE(n - 8, 4);
  b.write('WAVE', 8);
  return b;
};
const SMALL_WAV = wav(256);
// The route answers copy failures with this fixed body — the storage error is server-side only.
const STORAGE_500 = { error: 'storage', message: 'The file could not be stored. Try again.', flash: { error: 'storage' } };

const ctx = () => pwRequest.newContext({ baseURL: WEB, extraHTTPHeaders: { Origin: WEB } });
const sign = (c, slug, body) => c.post(`/api/games/${slug}/assets/sign`, { data: body });
const finalize = (c, slug, body) => c.post(`/api/games/${slug}/assets/finalize`, { data: body });
const putSigned = (url, bytes, contentType) => fetch(url, { method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'true' }, body: bytes });
const legacyPost = (c, slug, path, bytes) =>
  c.post(`/api/games/${slug}/assets`, {
    maxRedirects: 0,
    multipart: { path, source: 'creator', file: { name: path.split('/').pop(), mimeType: 'audio/wav', buffer: bytes } },
  });
const assetUrl = (id, path) => `${CDN}/g/${id}/1/${path}`;

const uniq = () => randomBytes(5).toString('hex');

async function signup(c, tag) {
  const id = `${tag}${uniq()}`;
  const email = `up3cf-${id}@example.test`;
  const password = 'up3cf-pass-123';
  let r = await c.post('/api/auth/login', { multipart: { mode: 'signup', email, password, next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'signup').toBe(303);
  r = await c.post('/api/profile', { multipart: { handle: `up3cf${id}`.slice(0, 32), next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'handle').toBe(303);
}

async function uploadGame(c, title) {
  const r = await c.post('/api/games', {
    maxRedirects: 0,
    multipart: {
      title,
      license: 'MIT',
      agree: 'on',
      game: { name: 'g.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><body>up3cf</body></html>') },
      thumb: { name: 't.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') },
    },
  });
  expect(r.status(), 'game upload').toBe(303);
  const seg = new URL(r.headers()['location'], WEB).pathname.split('/')[2];
  const [game] = await sql`select id, slug, stage from public.games where slug = ${seg} or id = ${seg}`;
  expect(game, 'game row').toBeTruthy();
  return game;
}

const objectExists = async (key) => !(await gamesBucket().download(key)).error;
const countedRows = async (id) =>
  (await sql`select count(*)::int as n from public.game_assets where game_id = ${id} and status <> 'rejected'`)[0].n;

// A storage.objects write to `key` raises — the served-path copy fails exactly there.
// Staged objects, other games and other paths are unaffected.
const failOnObject = async (fn, key) => {
  await sql.unsafe(`create or replace function public.${fn}() returns trigger language plpgsql as $f$
    begin
      if new.bucket_id = 'games' and new.name = '${key}' then raise exception 'injected test failure'; end if;
      return new;
    end
  $f$`);
  await sql.unsafe(`drop trigger if exists ${fn} on storage.objects;
    create trigger ${fn} before insert or update on storage.objects for each row execute function public.${fn}()`);
};
const clearFail = async (fn) => {
  await sql.unsafe(`drop trigger if exists ${fn} on storage.objects`);
  await sql.unsafe(`drop function if exists public.${fn}()`);
};

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

test('UP-3 copy failure on a new file: fixed 500, no row, freed slot, staged gone, CDN 404', async () => {
  const c = await ctx();
  await signup(c, 'cfn');
  const game = await uploadGame(c, `UP3 copyfail new ${uniq()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;
  const fn = `mg_cf_${uniq()}`;
  const before = await countedRows(game.id);
  try {
    await failOnObject(fn, `${game.id}/1/cf/new.wav`);
    const s = await sign(c, game.slug, { path: 'cf/new.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
    expect(s.status()).toBe(200);
    const { url, uploadId, uploadPath } = await s.json();
    expect((await putSigned(url, SMALL_WAV, 'audio/wav')).status).toBe(200);

    const f = await finalize(c, game.slug, { path: 'cf/new.wav', uploadId });
    expect(f.status()).toBe(500);
    expect(await f.json(), 'fixed body — the real storage error is server-side only').toEqual(STORAGE_500);

    const [row] = await sql`select status from public.game_assets where game_id = ${game.id} and path = 'cf/new.wav'`;
    expect(row, 'the reservation is undone: no row may remain').toBeUndefined();
    expect(await objectExists(`${game.id}/1/cf/new.wav`), 'no served object may be written').toBe(false);
    expect(await objectExists(uploadPath), 'the staged object is deleted on the failure path').toBe(false);
    expect(await countedRows(game.id), 'the reserved cap slot is freed').toBe(before);
    expect((await fetch(assetUrl(game.id, 'cf/new.wav'))).status, 'never served').toBe(404);

    // The legacy multipart POST goes through the same reserve/copy/restore path.
    const legacy = await legacyPost(c, game.slug, 'cf/new.wav', wav(300, 8));
    expect(legacy.status()).toBe(303);
    expect(legacy.headers()['location'] ?? '').toContain('error=storage');
    const [row2] = await sql`select status from public.game_assets where game_id = ${game.id} and path = 'cf/new.wav'`;
    expect(row2, 'legacy: no row may remain either').toBeUndefined();
    expect(await objectExists(`${game.id}/1/cf/new.wav`)).toBe(false);
    expect(await countedRows(game.id)).toBe(before);
  } finally {
    await clearFail(fn);
    await c.dispose();
  }
});

test('UP-3 copy failure on a replace: the displaced row is restored exactly and old bytes are served', async () => {
  const c = await ctx();
  await signup(c, 'cfr');
  const game = await uploadGame(c, `UP3 copyfail replace ${uniq()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;
  const fn = `mg_cf_${uniq()}`;
  const servedKey = `${game.id}/1/cf/rep.wav`;
  const rowOf = async () =>
    (await sql`select * from public.game_assets where game_id = ${game.id} and path = 'cf/rep.wav'`)[0];
  // The restore contract: the row that described the displaced file survives — same id and
  // created_at (a delete+reinsert would mint new ones), and every file-describing column
  // back to what it was. updated_at is the row's last-write stamp: the revert is itself a
  // write and stamps now() by design, so it is the one column the contract does not pin.
  const describeRow = (row) => {
    const { updated_at, ...rest } = row;
    return rest;
  };
  try {
    // v1 through the whole flow: signed, uploaded, scanned, finalized, served.
    const v1 = wav(400, 1);
    const v2 = wav(600, 2);
    const s1 = await sign(c, game.slug, { path: 'cf/rep.wav', size: v1.length, contentType: 'audio/wav' });
    const one = await s1.json();
    expect((await putSigned(one.url, v1, 'audio/wav')).status).toBe(200);
    expect((await finalize(c, game.slug, { path: 'cf/rep.wav', uploadId: one.uploadId })).status()).toBe(200);
    await approveGame(game.id, sql);
    const before = await rowOf();
    const cdnBefore = await fetch(assetUrl(game.id, 'cf/rep.wav'));
    expect(cdnBefore.status).toBe(200);
    expect(Buffer.from(await cdnBefore.arrayBuffer()).equals(v1)).toBe(true);

    await failOnObject(fn, servedKey);
    const s2 = await sign(c, game.slug, { path: 'cf/rep.wav', size: v2.length, contentType: 'audio/wav' });
    const two = await s2.json();
    expect((await putSigned(two.url, v2, 'audio/wav')).status).toBe(200);
    const f = await finalize(c, game.slug, { path: 'cf/rep.wav', uploadId: two.uploadId });
    expect(f.status()).toBe(500);
    expect(await f.json()).toEqual(STORAGE_500);

    const after = await rowOf();
    expect(describeRow(after), 'status, size, sha, type, source, reject_reason and row identity are restored').toEqual(
      describeRow(before),
    );
    // The failed replace demoted the game again. Approve after the revert so reviewed_at
    // is not older than the restored row's updated_at.
    await approveGame(game.id, sql);
    // The served object was never touched: storage and the CDN still hand out v1 bytes,
    // byte-identical (storage read first — the CDN object cache can mask an overwrite).
    const stored = await gamesBucket().download(servedKey);
    expect(stored.error).toBeNull();
    expect(Buffer.from(await stored.data.arrayBuffer()).equals(v1), 'served object still holds the v1 bytes').toBe(true);
    const cdnAfter = await fetch(assetUrl(game.id, 'cf/rep.wav'));
    expect(cdnAfter.status).toBe(200);
    expect(Buffer.from(await cdnAfter.arrayBuffer()).equals(v1), 'CDN keeps serving the v1 bytes').toBe(true);
    expect(await objectExists(two.uploadPath), 'the staged object is deleted on the failure path').toBe(false);

    // The legacy multipart POST restores the same row the same way.
    const snapshot = describeRow(await rowOf());
    const legacy = await legacyPost(c, game.slug, 'cf/rep.wav', wav(700, 3));
    expect(legacy.status()).toBe(303);
    expect(legacy.headers()['location'] ?? '').toContain('error=storage');
    expect(describeRow(await rowOf()), 'legacy replace restores the row too').toEqual(snapshot);
    const storedAfterLegacy = await gamesBucket().download(servedKey);
    expect(Buffer.from(await storedAfterLegacy.data.arrayBuffer()).equals(v1), 'v1 bytes still in storage').toBe(true);
  } finally {
    await clearFail(fn);
    await c.dispose();
  }
});
