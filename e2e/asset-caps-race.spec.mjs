// UP-3: the per-version asset caps (200 files per game, code plus assets under 4 MB per
// version) are enforced atomically in Postgres. Concurrent /assets/finalize calls — and the
// legacy multipart POST /assets — take a per-game lock and re-check the caps inside the same
// transaction that writes the game_assets row, so N simultaneous admitted-looking uploads can
// never overshoot. Rows with status 'rejected' count toward neither cap.
import { randomBytes } from 'node:crypto';
import { test, expect, request as pwRequest } from '@playwright/test';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';
import { GAME_VERSION_MAX_BYTES } from '../src/lib/asset-limits.ts';

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

const ctx = () => pwRequest.newContext({ baseURL: WEB, extraHTTPHeaders: { Origin: WEB } });
const sign = (c, slug, body) => c.post(`/api/games/${slug}/assets/sign`, { data: body });
const finalize = (c, slug, body) => c.post(`/api/games/${slug}/assets/finalize`, { data: body });
const putSigned = (url, bytes, contentType) => fetch(url, { method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'true' }, body: bytes });
const assetUrl = (id, path) => `${CDN}/g/${id}/1/${path}`;

// Same reason as signed-uploads.spec: --repeat-each runs share module state and parallel
// workers collide on games_slug_key.
const uniq = () => randomBytes(5).toString('hex');

async function signup(c, tag) {
  const id = `${tag}${uniq()}`;
  const email = `up3-${id}@example.test`;
  const password = 'up3-pass-123';
  let r = await c.post('/api/auth/login', { multipart: { mode: 'signup', email, password, next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'signup').toBe(303);
  r = await c.post('/api/profile', { multipart: { handle: `up3${id}`.slice(0, 32), next: '/me' }, maxRedirects: 0 });
  expect(r.status(), 'handle').toBe(303);
}

async function uploadGame(c, title) {
  const r = await c.post('/api/games', {
    maxRedirects: 0,
    multipart: {
      title,
      license: 'MIT',
      agree: 'on',
      game: { name: 'g.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><body>up3</body></html>') },
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
const versionTotal = async (id) => {
  const [row] = await sql`
    select (select size_bytes from public.games where id = ${id})
      + coalesce(sum(size_bytes), 0)::int as total
    from public.game_assets where game_id = ${id} and status = 'uploaded'
  `;
  return Number(row.total);
};

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

test('UP-3 race: concurrent finalizes cannot slip past the 200-file cap', async () => {
  const c = await ctx();
  await signup(c, 'rcap');
  const game = await uploadGame(c, `UP3 racecap ${uniq()}`);
  await sql`update public.games set stage = 'proving' where id = ${game.id}`;

  // 199 non-rejected rows already on the game: exactly one free slot.
  await sql`
    insert into public.game_assets (game_id, version, path, expected_type, status, source)
    select ${game.id}, 1, 'fill-' || g::text || '.png', 'image', 'missing', 'scan'
    from generate_series(1, 199) g
  `;

  const N = 8;
  const staged = [];
  for (let i = 0; i < N; i++) {
    const path = `race/r${i}.wav`;
    const s = await sign(c, game.slug, { path, size: SMALL_WAV.length, contentType: 'audio/wav' });
    expect(s.status(), `sign ${path} — sign is a pre-check, it does not reserve a slot`).toBe(200);
    staged.push({ path, ...(await s.json()) });
  }
  await Promise.all(staged.map((it) => putSigned(it.url, SMALL_WAV, 'audio/wav')));
  const fins = await Promise.all(staged.map((it) => finalize(c, game.slug, { path: it.path, uploadId: it.uploadId })));

  const winners = staged.filter((_, i) => fins[i].status() === 200);
  const losers = staged.filter((_, i) => fins[i].status() !== 200);
  expect(winners.length, 'one free slot admits exactly one of the concurrent uploads').toBe(1);
  for (const r of fins.filter((f) => f.status() !== 200)) {
    expect(r.status(), 'a losing finalize answers the cap code').toBe(409);
    expect((await r.json()).error).toBe('cap');
  }

  const [rows] = await sql`
    select count(*)::int as n,
           count(*) filter (where status = 'uploaded')::int as uploaded,
           count(*) filter (where status <> 'rejected')::int as counted
    from public.game_assets where game_id = ${game.id}
  `;
  expect(rows.n, 'total rows stay at the cap').toBe(200);
  expect(rows.counted, 'non-rejected rows stay at the cap').toBe(200);
  expect(rows.uploaded, 'exactly one race file was admitted').toBe(1);

  for (const it of staged) expect(await objectExists(it.uploadPath), `staged ${it.path} is deleted either way`).toBe(false);
  for (const it of losers) {
    expect(await objectExists(`${game.id}/1/${it.path}`), `${it.path} must never reach the served path`).toBe(false);
    const [row] = await sql`select status from public.game_assets where game_id = ${game.id} and path = ${it.path}`;
    expect(row, `${it.path} gets no row at all`).toBeUndefined();
    expect((await fetch(assetUrl(game.id, it.path))).status, `${it.path} is never served`).toBe(404);
  }
  await c.dispose();
});

test('UP-3 race: concurrent finalizes cannot slip past the 4 MB version cap', async () => {
  const c = await ctx();
  await signup(c, 'rmb');
  const game = await uploadGame(c, `UP3 racemb ${uniq()}`);
  const [g] = await sql`select size_bytes from public.games where id = ${game.id}`;
  const room = GAME_VERSION_MAX_BYTES - g.size_bytes;
  const each = Math.floor(room * 0.45);

  const N = 4;
  const staged = [];
  for (let i = 0; i < N; i++) {
    const path = `big/b${i}.wav`;
    const s = await sign(c, game.slug, { path, size: each, contentType: 'audio/wav' });
    expect(s.status(), `sign ${path}`).toBe(200);
    staged.push({ path, ...(await s.json()) });
  }
  await Promise.all(staged.map((it, i) => putSigned(it.url, wav(each, i + 1), 'audio/wav')));
  const fins = await Promise.all(staged.map((it) => finalize(c, game.slug, { path: it.path, uploadId: it.uploadId })));

  const winners = fins.filter((r) => r.status() === 200);
  expect(winners.length, 'each file is 0.45*room: exactly two fit').toBe(2);
  for (const r of fins.filter((f) => f.status() !== 200)) {
    expect(r.status(), 'a losing finalize answers 413').toBe(413);
    expect((await r.json()).error).toBe('too-big');
  }
  expect(await versionTotal(game.id), 'code plus uploaded assets stays within 4 MB').toBeLessThanOrEqual(GAME_VERSION_MAX_BYTES);
  for (const it of staged) expect(await objectExists(it.uploadPath)).toBe(false);
  for (const it of staged.filter((_, i) => fins[i].status() !== 200)) {
    expect(await objectExists(`${game.id}/1/${it.path}`), `${it.path} must never reach the served path`).toBe(false);
  }
  await c.dispose();
});

test('UP-3 race: the legacy multipart POST cannot slip past the 4 MB cap', async () => {
  const c = await ctx();
  await signup(c, 'rleg');
  const game = await uploadGame(c, `UP3 racelegacy ${uniq()}`);
  const [g] = await sql`select size_bytes from public.games where id = ${game.id}`;
  const room = GAME_VERSION_MAX_BYTES - g.size_bytes;
  const each = Math.floor(room * 0.45);

  const posts = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      c.post(`/api/games/${game.slug}/assets`, {
        maxRedirects: 0,
        multipart: {
          path: `big/l${i}.wav`,
          source: 'creator',
          file: { name: `l${i}.wav`, mimeType: 'audio/wav', buffer: wav(each, i + 1) },
        },
      }),
    ),
  );
  const locations = posts.map((r) => ({ status: r.status(), location: r.headers()['location'] ?? '' }));
  expect(locations.every((l) => l.status === 303), JSON.stringify(locations)).toBe(true);
  expect(locations.filter((l) => l.location.includes('uploaded=')).length, 'exactly two uploads fit').toBe(2);
  expect(locations.filter((l) => l.location.includes('error=too-big')).length, 'the losers flash too-big').toBe(2);
  expect(await versionTotal(game.id)).toBeLessThanOrEqual(GAME_VERSION_MAX_BYTES);
  await c.dispose();
});

test('UP-3 rejected rows do not count toward the 200-file or 4 MB caps', async () => {
  const c = await ctx();
  await signup(c, 'rrej');
  const game = await uploadGame(c, `UP3 rejected ${uniq()}`);

  // 220 rejected rows — over the file cap on their own — each carrying 4 MB of size_bytes.
  // A rejected row is an audit trail, not an asset: it must not consume file or byte budget.
  await sql`
    insert into public.game_assets (game_id, version, path, expected_type, status, size_bytes, source)
    select ${game.id}, 1, 'rej-' || g::text || '.png', 'image', 'rejected', ${GAME_VERSION_MAX_BYTES}, 'scan'
    from generate_series(1, 220) g
  `;

  const s = await sign(c, game.slug, { path: 'ok/a.wav', size: SMALL_WAV.length, contentType: 'audio/wav' });
  expect(s.status(), 'rejected rows must not fill the 200-file cap or the byte cap at sign').toBe(200);
  const { url, uploadId } = await s.json();
  expect((await putSigned(url, SMALL_WAV, 'audio/wav')).status).toBe(200);

  const f = await finalize(c, game.slug, { path: 'ok/a.wav', uploadId });
  expect(f.status(), 'rejected rows must not count at finalize either').toBe(200);
  const [row] = await sql`select status from public.game_assets where game_id = ${game.id} and path = 'ok/a.wav'`;
  expect(row?.status).toBe('uploaded');

  // And a rejected path can still be retried: flipping it to uploaded is what counts, not the row.
  const s2 = await sign(c, game.slug, { path: 'rej-1.png', size: 512, contentType: 'image/png' });
  expect(s2.status(), 're-signing a rejected path is allowed').toBe(200);
  await c.dispose();
});
