-- UP-4: guarded delete for orphaned 'uploaded' game_assets rows.
--
-- finalize reserves the manifest row (private.record_game_asset) before copying the bytes
-- to the served object path. If the process dies between the two, the row stays 'uploaded'
-- with no object behind it: the CDN 404s the file while the row keeps counting toward the
-- file and byte caps. The maintenance pass (src/lib/server/asset-maintenance.ts, run by
-- scripts/asset-maintenance.mjs) finds rows 'uploaded' and untouched past the stale-age
-- cutoff, checks the object is really absent through the Storage API, and calls this
-- function to remove the row. Storage.objects itself is never touched by SQL — Supabase
-- Storage forbids direct deletes there; objects are removed only through the API.
--
-- The row is DELETED, matching UP-3's copy-failure revert (revertAssetRow deletes when the
-- reservation displaced nothing; whatever preceded it is unrecoverable here anyway). The
-- delete is compare-and-set under the same FOR NO KEY UPDATE games-row lock
-- record_game_asset takes: the row must still be 'uploaded' with the exact sha/size/updated
-- marker the caller read, and must predate p_older_than. A live finalize that committed in
-- between owns the row, so nothing is removed; a reservation inside the active window
-- (updated_at < p_older_than fails) is never a victim either.

create or replace function private.clean_orphan_game_asset(
  p_game_id text,
  p_version integer,
  p_path text,
  p_sha256 text,
  p_size_bytes integer,
  p_updated_at timestamptz,
  p_older_than timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_game_id text;
  v_deleted integer;
begin
  -- Serialize with record_game_asset on the games row: a live finalize holds this lock
  -- while it reserves, so a cleanup that gets the lock sees only committed writes.
  select g.id into v_game_id
  from public.games g
  where g.id = p_game_id
  for no key update of g;
  if not found then
    return 'not-found';
  end if;

  delete from public.game_assets a
  where a.game_id = p_game_id
    and a.version = p_version
    and a.path = p_path
    and a.status = 'uploaded'
    and a.content_sha256 = p_sha256
    and a.size_bytes is not distinct from p_size_bytes
    and a.updated_at = p_updated_at
    and a.updated_at < p_older_than;
  get diagnostics v_deleted = row_count;
  return case when v_deleted = 1 then 'deleted' else 'skipped' end;
end;
$$;

revoke all on function private.clean_orphan_game_asset(text, integer, text, text, integer, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function private.clean_orphan_game_asset(text, integer, text, text, integer, timestamptz, timestamptz) to postgres, service_role;
