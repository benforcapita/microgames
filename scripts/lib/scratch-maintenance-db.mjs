// Shared by the maintenance tests (scripts/asset-maintenance.test.ts and
// src/lib/server/asset-maintenance.db.test.ts): a scratch database on the same Postgres
// server holding only the tables runAssetMaintenance reads, so an empty 'games' bucket is
// testable without touching the real one — the Storage API owns the real storage.objects,
// and deleting its rows is both forbidden and shared with every other test. The scratch
// database also carries private.clean_orphan_game_asset (cloned from the deployed
// definition) and the public.games row it locks, so a real run — not only a dry run —
// can exercise the whole pass against a private candidate universe.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

const CLEAN_FN = 'private.clean_orphan_game_asset(text,integer,text,text,integer,numeric,timestamptz)';

/**
 * Create `mg_scratch_<rand>` on the same server env.DATABASE_URL points at, with the
 * minimal schema the maintenance pass queries: storage.objects (empty => empty bucket)
 * and public.game_assets, plus public.games and a copy of the deployed
 * private.clean_orphan_game_asset so orphan rows can really be deleted. Returns the
 * connect URL, a live client, and drop().
 */
export async function scratchMaintenanceDb(env) {
  const admin = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 5 });
  const name = `mg_scratch_${randomBytes(6).toString('hex')}`;
  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${name}`;
  await admin.unsafe(`create database ${name}`);
  const sql = postgres(url.toString(), { max: 2, connect_timeout: 5 });
  try {
    // The deployed function definition, copied so the scratch database deletes rows the
    // same way the real one does (grants are irrelevant — tests connect as postgres).
    const [{ def }] = await admin`select pg_get_functiondef(${CLEAN_FN}::regprocedure) as def`;
    await sql`create schema storage`;
    await sql`create schema private`;
    await sql`
      create table storage.objects (
        bucket_id text not null, name text not null, created_at timestamptz not null default now()
      )
    `;
    await sql`
      create table public.games (
        id text primary key
      )
    `;
    await sql`
      create table public.game_assets (
        game_id text not null, version integer not null, path text not null,
        status text not null, size_bytes integer, content_sha256 text,
        updated_at timestamptz not null default now()
      )
    `;
    await sql.unsafe(def);
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => {});
    await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
    throw error;
  }
  return {
    name,
    url: url.toString(),
    sql,
    drop: async () => {
      await sql.end({ timeout: 1 }).catch(() => {});
      await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => {});
      await admin.end({ timeout: 1 }).catch(() => {});
    },
  };
}
