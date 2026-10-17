// UP-3: when the served-path copy fails, revertAssetRow undoes the reservation only while
// the row is still the one this call wrote — compare-and-set on content_sha256. A newer
// finalize that committed in between owns the row, and the failed revert must neither
// delete it nor write the displaced state back. Deterministic: the failing storage stub
// performs the newer committed write itself — through private.record_game_asset, exactly
// what a real concurrent finalize does — before reporting the copy failure, so no timing
// luck is involved. Runs only against a local stack.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import postgres from 'postgres';
import {
  GAME_VERSION_MAX_BYTES,
  MAX_ASSET_FILES,
  assessAssetUpload,
  saveFinalizedAsset,
  type AssetStorage,
  type AssetUploadDecision,
  type AssessAssetInput,
  type ExistingAsset,
} from './asset-upload.ts';

function localDbUrl(): string | undefined {
  const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  try {
    const host = new URL(raw).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') return undefined;
  } catch {
    return undefined;
  }
  return raw;
}

async function connect(t: { skip: (message?: string) => void }): Promise<postgres.Sql | undefined> {
  const dbUrl = localDbUrl();
  if (!dbUrl) {
    t.skip('refusing to run asset save SQL against a non-local database');
    return undefined;
  }
  const sql = postgres(dbUrl, { connect_timeout: 3, max: 2, idle_timeout: 1 });
  try {
    await sql`select 1`;
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    t.skip('local supabase is not running');
    return undefined;
  }
}

async function makeGame(sql: postgres.Sql): Promise<string> {
  // assetObjectPath accepts only 6–16 chars of the id-safe charset.
  const id = `acf${crypto.randomBytes(6).toString('hex')}`;
  await sql`
    insert into public.games (id, slug, creator, title, stage, size_bytes)
    values (${id}, ${id}, 'stub', 'Copyfail', 'proving', 100)
  `;
  return id;
}

const wav = (n: number, fill = 0): Uint8Array => {
  const b = new Uint8Array(n).fill(fill);
  const view = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, n - 8, true);
  b.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  return b;
};

const sha256 = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');

const storeDecision = (path: string, bytes: Uint8Array, extra: Partial<AssessAssetInput> = {}) => {
  const decision = assessAssetUpload({
    userId: 'owner',
    ownerId: 'owner',
    rawPath: path,
    adding: true,
    bytes,
    existing: null,
    codeBytes: 100,
    uploadedBytes: 0,
    fileCount: 1,
    rateAllowed: true,
    ...extra,
  });
  assert.equal(decision.kind, 'store');
  return decision as Extract<AssetUploadDecision, { kind: 'store' }>;
};

const okStorage: AssetStorage = {
  async upload() {
    return { error: null };
  },
  async remove() {
    return { error: null };
  },
};

const rowOf = async (sql: postgres.Sql, gameId: string, path: string) =>
  (
    await sql<{ status: string; size_bytes: number | null; content_sha256: string | null }[]>`
      select status, size_bytes, content_sha256
      from public.game_assets
      where game_id = ${gameId} and version = 1 and path = ${path}
    `
  )[0];

describe('saveFinalizedAsset copy-failure revert', () => {
  it('does not delete a newer committed row when the copy of a new file fails', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = await makeGame(sql);
    try {
      const bytes = wav(300);
      const newerBytes = wav(512, 9);
      const newerSha = sha256(newerBytes);
      const storage: AssetStorage = {
        // The reservation is already committed when this runs. A newer finalize commits
        // a different sha on the same row, then our copy reports its failure — the
        // deterministic version of "a second writer lands inside the copy window".
        async upload() {
          await sql`
            select result from private.record_game_asset(
              ${gameId}, 1, 'cf/guard.wav', 'audio', 'uploaded',
              ${newerBytes.byteLength}, ${newerSha}, 'creator', null, ${MAX_ASSET_FILES}, ${GAME_VERSION_MAX_BYTES})
          `;
          return { error: { message: 'injected copy failure' } };
        },
        async remove() {
          return { error: null };
        },
      };
      const saved = await saveFinalizedAsset(sql, storage, gameId, 1, storeDecision('cf/guard.wav', bytes), bytes);
      assert.deepEqual(saved, { ok: false, code: 'storage' });

      const row = await rowOf(sql, gameId, 'cf/guard.wav');
      assert.ok(row, 'the newer committed row must not be deleted by the failed revert');
      assert.equal(row.content_sha256, newerSha);
      assert.equal(row.size_bytes, newerBytes.byteLength);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('does not write the displaced state back over a newer committed row', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = await makeGame(sql);
    try {
      const path = 'cf/guard2.wav';
      const v1 = wav(400, 1);
      const v2 = wav(600, 2);
      const newerBytes = wav(700, 3);
      const newerSha = sha256(newerBytes);

      // v1 finalized normally first — the displaced row the revert would restore.
      const first = await saveFinalizedAsset(sql, okStorage, gameId, 1, storeDecision(path, v1), v1);
      assert.deepEqual(first, { ok: true });
      const before = await rowOf(sql, gameId, path);
      assert.equal(before?.content_sha256, sha256(v1));

      const existing: ExistingAsset = {
        path,
        expectedType: 'audio',
        status: 'uploaded',
        sizeBytes: v1.byteLength,
        source: 'creator',
      };
      const storage: AssetStorage = {
        async upload() {
          await sql`
            select result from private.record_game_asset(
              ${gameId}, 1, ${path}, 'audio', 'uploaded',
              ${newerBytes.byteLength}, ${newerSha}, 'creator', null, ${MAX_ASSET_FILES}, ${GAME_VERSION_MAX_BYTES})
          `;
          return { error: { message: 'injected copy failure' } };
        },
        async remove() {
          return { error: null };
        },
      };
      const saved = await saveFinalizedAsset(
        sql,
        storage,
        gameId,
        1,
        storeDecision(path, v2, { existing }),
        v2,
      );
      assert.deepEqual(saved, { ok: false, code: 'storage' });

      const row = await rowOf(sql, gameId, path);
      assert.equal(row?.status, 'uploaded');
      assert.equal(row?.content_sha256, newerSha, 'the revert must not clobber the newer committed sha');
      assert.equal(row?.size_bytes, newerBytes.byteLength);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });
});
