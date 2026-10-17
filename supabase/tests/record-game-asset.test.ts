// UP-3: private.record_game_asset is the one authoritative game_assets write. It locks the
// game's row, re-checks the file and byte caps inside the same statement as the write, and
// ignores 'rejected' rows for both caps. Runs only against a local stack.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { GAME_VERSION_MAX_BYTES, MAX_ASSET_FILES, assetWriteAddsCountedRow } from '../../src/lib/server/asset-upload.ts';

const supabaseDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261017190000_record_game_asset_cap_on_add';
// The caps are parameters of the function; the tests pass the same values the routes do.
const MAX_FILES = MAX_ASSET_FILES;
const MAX_BYTES = GAME_VERSION_MAX_BYTES;
const FN = `private.record_game_asset(text, integer, text, text, text, integer, text, text, text, integer, bigint)`;

describe('record_game_asset migration file', () => {
  it('sorts after every existing migration', () => {
    const names = readdirSync(join(supabaseDir, 'migrations')).sort();
    assert.equal(names.at(-1), `${MIGRATION}.sql`);
  });
});

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

async function connect(t: { skip: (message?: string) => void }, max = 1): Promise<postgres.Sql | undefined> {
  const dbUrl = localDbUrl();
  if (!dbUrl) {
    t.skip('refusing to run record_game_asset SQL against a non-local database');
    return undefined;
  }
  const sql = postgres(dbUrl, { connect_timeout: 3, max, idle_timeout: 1 });
  try {
    await sql`select 1`;
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    t.skip('local supabase is not running');
    return undefined;
  }
}

async function makeGame(sql: postgres.Sql, sizeBytes = 0): Promise<string> {
  const id = `rga-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    insert into public.games (id, slug, creator, title, stage, size_bytes)
    values (${id}, ${id}, 'stub', 'Record', 'proving', ${sizeBytes})
  `;
  return id;
}

type CallResult = {
  result: string;
  total_bytes: string | number | null;
  prev_status: string | null;
  prev_size_bytes: number | null;
};

const call = (
  sql: postgres.Sql,
  gameId: string,
  path: string,
  opts: {
    status?: string;
    sizeBytes?: number | null;
    rejectReason?: string | null;
    version?: number;
    maxFiles?: number;
    maxBytes?: number;
  } = {},
) => sql<CallResult[]>`
  select result, total_bytes, prev_status, prev_size_bytes
  from private.record_game_asset(
    ${gameId}, ${opts.version ?? 1}, ${path}, 'image', ${opts.status ?? 'uploaded'},
    ${opts.sizeBytes ?? 10}, ${opts.status === 'uploaded' || opts.status === undefined ? 'a'.repeat(64) : null},
    'creator', ${opts.rejectReason ?? null}, ${opts.maxFiles ?? MAX_FILES}, ${opts.maxBytes ?? MAX_BYTES})
`.then((rows) => rows[0]);

describe('private.record_game_asset', () => {
  it('is a security-definer function only service_role and postgres may execute', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const [migration] = await sql<{ version: string }[]>`
        select version from supabase_migrations.schema_migrations where version = '20261017190000'
      `;
      assert.equal(migration?.version, '20261017190000');

      const [fn] = await sql<{ prosecdef: boolean; proacl: string[] | null; proconfig: string[] | null }[]>`
        select p.prosecdef, p.proacl, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'record_game_asset'
      `;
      assert.equal(fn?.prosecdef, true);
      // search_path is pinned to '' so unqualified names can never resolve somewhere the
      // caller's session controls (every name in the body is already schema-qualified).
      assert.deepEqual(fn?.proconfig, ['search_path=""']);
      // No grant may name PUBLIC (an acl item with an empty grantee). Only postgres and
      // service_role hold EXECUTE.
      assert.ok(fn?.proacl?.every((acl) => !acl.startsWith('=')), `proacl: ${JSON.stringify(fn?.proacl)}`);

      const [priv] = await sql<{ anon: boolean; authenticated: boolean; service: boolean }[]>`
        select has_function_privilege('anon', ${FN}, 'EXECUTE') as anon,
               has_function_privilege('authenticated', ${FN}, 'EXECUTE') as authenticated,
               has_function_privilege('service_role', ${FN}, 'EXECUTE') as service
      `;
      assert.deepEqual({ ...priv }, { anon: false, authenticated: false, service: true });
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('serializes concurrent writers: at 199 files exactly one of eight is admitted', async (t) => {
    const sql = await connect(t, 8);
    if (!sql) return;
    const gameId = await makeGame(sql);
    try {
      await sql`
        insert into public.game_assets (game_id, version, path, expected_type, status, source)
        select ${gameId}, 1, 'fill-' || g::text || '.png', 'image', 'missing', 'scan'
        from generate_series(1, 199) g
      `;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => call(sql, gameId, `race-${i}.png`)),
      );
      assert.equal(results.filter((r) => r?.result === 'ok').length, 1);
      assert.equal(results.filter((r) => r?.result === 'cap').length, 7);
      const [count] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.game_assets where game_id = ${gameId} and status <> 'rejected'
      `;
      assert.equal(count?.n, MAX_FILES);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('serializes concurrent writers: the 4 MB version cap cannot be overshot', async (t) => {
    const sql = await connect(t, 4);
    if (!sql) return;
    const codeBytes = 100;
    const gameId = await makeGame(sql, codeBytes);
    try {
      const room = MAX_BYTES - codeBytes;
      const each = Math.floor(room * 0.45);
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) => call(sql, gameId, `big-${i}.png`, { sizeBytes: each })),
      );
      assert.equal(results.filter((r) => r?.result === 'ok').length, 2);
      for (const r of results.filter((x) => x?.result !== 'ok')) {
        assert.equal(r?.result, 'too-big');
        assert.ok(Number(r?.total_bytes) > MAX_BYTES);
      }
      const [total] = await sql<{ total: number }[]>`
        select coalesce(sum(size_bytes), 0)::int as total
        from public.game_assets where game_id = ${gameId} and status = 'uploaded'
      `;
      assert.ok(codeBytes + (total?.total ?? 0) <= MAX_BYTES);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('bills a replace for the byte delta, crediting the displaced size', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const codeBytes = 100;
    const gameId = await makeGame(sql, codeBytes);
    try {
      // code + 3 assets ≈ 3.9 MiB — under the 4 MiB version cap. Replacing one file with
      // the same number of bytes must fit: the displaced row's old size is credited back
      // (QA #78 S6: crediting zero would double-count and wrongly answer too-big).
      const each = Math.floor(MAX_BYTES * 0.325);
      await sql`
        insert into public.game_assets (game_id, version, path, expected_type, status, size_bytes, source)
        select ${gameId}, 1, 'd-' || g::text || '.png', 'image', 'uploaded', ${each}, 'scan'
        from generate_series(1, 3) g
      `;
      assert.ok(codeBytes + 3 * each <= MAX_BYTES, 'fixture itself is under the cap');
      const same = await call(sql, gameId, 'd-1.png', { sizeBytes: each });
      assert.equal(same?.result, 'ok');
      assert.equal(same?.prev_status, 'uploaded');
      assert.equal(same?.prev_size_bytes, each);

      // A larger replace still counts only the delta: pushing the version over 4 MiB is
      // too-big, and the denied write leaves the displaced row untouched.
      const bigger = await call(sql, gameId, 'd-2.png', { sizeBytes: each * 2 });
      assert.equal(bigger?.result, 'too-big');
      assert.ok(Number(bigger?.total_bytes) > MAX_BYTES);
      const [row] = await sql<{ size_bytes: number }[]>`
        select size_bytes from public.game_assets where game_id = ${gameId} and path = 'd-2.png'
      `;
      assert.equal(row?.size_bytes, each);
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('ignores rejected rows for both caps, and a rejected write never hits them', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = await makeGame(sql);
    try {
      // Over the file cap and at the byte cap if they counted — they must not.
      await sql`
        insert into public.game_assets (game_id, version, path, expected_type, status, size_bytes, source)
        select ${gameId}, 1, 'rej-' || g::text || '.png', 'image', 'rejected', ${MAX_BYTES}, 'scan'
        from generate_series(1, 220) g
      `;
      const ok = await call(sql, gameId, 'new.png');
      assert.equal(ok?.result, 'ok');
      // Replacing the row just written reports the displaced state for a possible revert.
      const again = await call(sql, gameId, 'new.png', { sizeBytes: 20 });
      assert.equal(again?.result, 'ok');
      assert.equal(again?.prev_status, 'uploaded');
      assert.equal(again?.prev_size_bytes, 10);
      // Rejected writes skip the caps entirely.
      const rej = await call(sql, gameId, 'rejected-anyway.png', { status: 'rejected', sizeBytes: null, rejectReason: 'bad file' });
      assert.equal(rej?.result, 'ok');
      const [row] = await sql<{ status: string; reject_reason: string }[]>`
        select status, reject_reason from public.game_assets where game_id = ${gameId} and path = 'rejected-anyway.png'
      `;
      assert.equal(row?.status, 'rejected');
      assert.equal(row?.reject_reason, 'bad file');
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('denies the file cap only when the write would add a counted row', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      // The same case table the TS pre-checks (assessAssetUpload/assessAssetSign, which
      // share assetWriteAddsCountedRow) are pinned to — one rule for sign, finalize and
      // the legacy POST. `counted` is the number of non-rejected rows already on the
      // game besides the row being written; existing games can sit over the cap because
      // manifest scans bypass this function, so 'missing'/'uploaded' replaces must pass.
      for (const status of [null, 'missing', 'uploaded', 'rejected'] as const) {
        for (const counted of [MAX_FILES - 1, MAX_FILES, MAX_FILES + 100]) {
          const gameId = await makeGame(sql);
          try {
            await sql`
              insert into public.game_assets (game_id, version, path, expected_type, status, source)
              select ${gameId}, case when g % 2 = 0 then 1 else 2 end, 'f-' || g::text || '.png', 'image', 'missing', 'scan'
              from generate_series(1, ${counted}) g
            `;
            if (status !== null) {
              await sql`
                insert into public.game_assets (game_id, version, path, expected_type, status, source)
                values (${gameId}, 1, 'probe.png', 'image', ${status}, 'scan')
              `;
            }
            const res = await call(sql, gameId, 'probe.png');
            const expected = assetWriteAddsCountedRow(status) && counted >= MAX_FILES ? 'cap' : 'ok';
            assert.equal(res?.result, expected, `status=${status} counted=${counted}`);
            if (expected === 'cap') {
              // A denied write leaves the previous state untouched: no row, or the
              // rejected audit row it would have replaced.
              const kept: { status: string }[] = await sql`
                select status from public.game_assets
                where game_id = ${gameId} and version = 1 and path = 'probe.png'
              `;
              assert.equal(kept[0]?.status ?? null, status, `status=${status} counted=${counted}: cap must not write`);
            }
          } finally {
            await sql`delete from public.games where id = ${gameId}`.catch(() => {});
          }
        }
      }
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });

  it('caps a rejected row revived at the file cap, and reports a missing game', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const gameId = await makeGame(sql);
    try {
      await sql`
        insert into public.game_assets (game_id, version, path, expected_type, status, source)
        select ${gameId}, 1, 'fill-' || g::text || '.png', 'image', 'missing', 'scan'
        from generate_series(1, 200) g
      `;
      await sql`
        insert into public.game_assets (game_id, version, path, expected_type, status, source)
        values (${gameId}, 1, 'retry.png', 'image', 'rejected', 'scan')
      `;
      const revive = await call(sql, gameId, 'retry.png');
      assert.equal(revive?.result, 'cap');
      const replaced = await call(sql, gameId, 'fill-1.png');
      assert.equal(replaced?.result, 'ok');
      assert.equal(replaced?.prev_status, 'missing');
      const gone = await call(sql, 'no-such-game', 'x.png');
      assert.equal(gone?.result, 'not-found');
    } finally {
      await sql`delete from public.games where id = ${gameId}`.catch(() => {});
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  });
});
