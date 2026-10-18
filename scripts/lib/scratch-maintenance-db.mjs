// Shared by the maintenance tests (scripts/asset-maintenance.test.ts and
// src/lib/server/asset-maintenance.db.test.ts): a scratch database on the same Postgres
// server holding only the tables runAssetMaintenance reads, so an empty 'games' bucket is
// testable without touching the real one — the Storage API owns the real storage.objects,
// and deleting its rows is both forbidden and shared with every other test.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

/**
 * Create `mg_scratch_<rand>` on the same server env.DATABASE_URL points at, with the
 * minimal schema the maintenance pass queries: storage.objects (empty => empty bucket)
 * and public.game_assets. Returns the connect URL, a live client, and drop().
 */
export async function scratchMaintenanceDb(env) {
  const admin = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 5 });
  const name = `mg_scratch_${randomBytes(6).toString('hex')}`;
  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${name}`;
  await admin.unsafe(`create database ${name}`);
  const sql = postgres(url.toString(), { max: 2, connect_timeout: 5 });
  try {
    await sql`create schema storage`;
    await sql`
      create table storage.objects (
        bucket_id text not null, name text not null, created_at timestamptz not null default now()
      )
    `;
    await sql`
      create table public.game_assets (
        game_id text not null, version integer not null, path text not null,
        status text not null, size_bytes integer, content_sha256 text,
        updated_at timestamptz not null default now()
      )
    `;
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
