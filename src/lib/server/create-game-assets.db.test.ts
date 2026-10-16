// createGame must record scanned asset paths. Removing the scan call fails this test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import postgres from 'postgres';
import type { BundleStorage } from './bundle-store.ts';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let isLocal = false;
try {
  const parsed = new URL(url);
  isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
} catch {
  isLocal = false;
}

if (isLocal) {
  process.env.DATABASE_URL = url;
  process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
  process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test';
  process.env.SUPABASE_SECRET_KEY ??= 'test';
}

let probeOk = false;
if (isLocal) {
  const probe = postgres(url, { connect_timeout: 3, max: 1 });
  try {
    await probe`select 1`;
    probeOk = true;
  } catch {
    probeOk = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

let createGame: typeof import('./games.ts').createGame;
let sql: typeof import('./db.ts').sql;

if (probeOk) {
  const gamesMod = await import('./games.ts');
  const dbMod = await import('./db.ts');
  createGame = gamesMod.createGame;
  sql = dbMod.sql;
}

const storage: BundleStorage = {
  upload: async () => ({ error: null }),
  remove: async () => ({ error: null }),
};

const HTML = `<!doctype html><canvas></canvas>
<img src="./sprites/hero.png">
<style>body { background: url("./gfx/bg.webp"); }</style>
<script>fetch("./data/levels.json");</script>`;

describe('createGame records scanned assets', () => {
  const userId = randomUUID();
  const handle = `as${userId.replace(/-/g, '').slice(0, 16)}`;
  let gameId: string | null = null;

  after(async () => {
    if (!sql) return;
    try {
      if (gameId) await sql`delete from public.games where id = ${gameId}`;
      await sql`delete from public.profiles where id = ${userId}`;
      await sql`delete from auth.users where id = ${userId}`;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('writes missing scan rows for paths in the uploaded HTML', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${userId}, 'authenticated', 'authenticated',
              ${`${handle}@example.com`}, '', now(), now())`;
    await sql`insert into public.profiles (id, handle) values (${userId}, ${handle})`;

    const game = await createGame({
      ownerId: userId,
      creator: handle,
      title: `Scan ${handle}`,
      tagline: '',
      description: '',
      tags: [],
      license: 'MIT',
      forkedFrom: null,
      html: new TextEncoder().encode(HTML),
      stage: 'pending',
    }, storage);
    gameId = game.id;

    const rows = await sql<{ path: string; expected_type: string; status: string; source: string; version: number }[]>`
      select path, expected_type, status, source, version::int as version
      from public.game_assets
      where game_id = ${game.id}
      order by path`;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { path: 'data/levels.json', expected_type: 'json', status: 'missing', source: 'scan', version: 1 },
      { path: 'gfx/bg.webp', expected_type: 'image', status: 'missing', source: 'scan', version: 1 },
      { path: 'sprites/hero.png', expected_type: 'image', status: 'missing', source: 'scan', version: 1 },
    ]);
  });
});
