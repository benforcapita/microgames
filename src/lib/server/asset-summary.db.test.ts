// AS-4: the submission page's asset warnings come from the real game_assets rows (local Supabase only).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import postgres from 'postgres';
import { summarizeAssets } from '../asset-limits.ts';

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

let sql: typeof import('./db.ts').sql;
let loadAssetSummaryInput: typeof import('./submissions-db.ts').loadAssetSummaryInput;
if (probeOk) {
  sql = (await import('./db.ts')).sql;
  loadAssetSummaryInput = (await import('./submissions-db.ts')).loadAssetSummaryInput;
}

describe('submission page asset summary reads the current version from game_assets', () => {
  const userId = randomUUID();
  const handle = `a4${userId.replace(/-/g, '').slice(0, 16)}`;
  const gameId = `a4${userId.replace(/-/g, '').slice(0, 12)}`;

  after(async () => {
    if (!sql) return;
    try {
      await sql`delete from public.games where id = ${gameId}`;
      await sql`delete from public.profiles where id = ${userId}`;
      await sql`delete from auth.users where id = ${userId}`;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('one missing file is warned, the total counts code + uploaded bytes, a 150 KB asset is flagged', async (t) => {
    if (!probeOk || !sql) {
      t.skip('local supabase is not running');
      return;
    }
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${userId}, 'authenticated', 'authenticated',
              ${`${handle}@example.com`}, '', now(), now())`;
    await sql`insert into public.profiles (id, handle) values (${userId}, ${handle})`;
    await sql`
      insert into public.games (id, slug, title, creator, owner_id, stage, size_bytes)
      values (${gameId}, ${gameId}, 'AS-4', ${handle}, ${userId}, 'pending', ${50_000})`;
    await sql`
      insert into public.game_assets (game_id, version, path, expected_type, status, size_bytes) values
        (${gameId}, 1, 'sprites/hero.png', 'image', 'uploaded', ${150 * 1024}),
        (${gameId}, 1, 'audio/jump.mp3', 'audio', 'missing', null),
        (${gameId}, 1, 'bad.png', 'image', 'rejected', null)`;

    const summary = summarizeAssets(await loadAssetSummaryInput(gameId));
    assert.deepEqual(summary.missing, ['audio/jump.mp3']);
    assert.equal(summary.totalBytes, 50_000 + 150 * 1024);
    assert.equal(summary.overTotal, false);
    assert.deepEqual(summary.large, [{ path: 'sprites/hero.png', sizeBytes: 150 * 1024 }]);
  });
});
