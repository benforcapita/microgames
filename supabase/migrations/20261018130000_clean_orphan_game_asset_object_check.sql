-- UP-4 QA fix (B1): the "is the served object gone" judgement moves into the delete
-- itself, in SQL, over the same connection and project as the delete.
--
-- Before this, the maintenance pass asked the Storage API whether the object exists and
-- then called this function. An under-privileged key (e.g. the publishable key — Storage
-- RLS hides every object and answers exactly {statusCode:'404', message:'Object not
-- found'}) or a key/URL for the wrong project makes every object look missing, so live
-- rows were deleted with no error. A Storage API answer can never again decide a row's
-- fate: the delete predicate now requires the object to be absent from storage.objects
-- over the same connection, under the same games-row lock, alongside the existing CAS
-- pins (status, sha, size, updated marker, still past the cutoff).
--
-- Signature, SECURITY DEFINER, search_path='' and grants are unchanged; the previous
-- migration (20261018120000) keeps its history.

create or replace function private.clean_orphan_game_asset(
  p_game_id text,
  p_version integer,
  p_path text,
  p_sha256 text,
  p_size_bytes integer,
  p_updated_at numeric,
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

  -- The row is deleted only when it still matches every pin the caller read AND the
  -- served object <game>/<version>/<path> is absent from storage.objects — checked here,
  -- over this connection, so a Storage credential that cannot see the object (RLS-hidden
  -- or a different project) cannot make a live row look orphaned.
  delete from public.game_assets a
  where a.game_id = p_game_id
    and a.version = p_version
    and a.path = p_path
    and a.status = 'uploaded'
    and a.content_sha256 = p_sha256
    and a.size_bytes is not distinct from p_size_bytes
    and extract(epoch from a.updated_at) = p_updated_at
    and a.updated_at < p_older_than
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'games'
        and o.name = concat(p_game_id, '/', p_version, '/', p_path)
    );
  get diagnostics v_deleted = row_count;
  return case when v_deleted = 1 then 'deleted' else 'skipped' end;
end;
$$;

revoke all on function private.clean_orphan_game_asset(text, integer, text, text, integer, numeric, timestamptz) from public, anon, authenticated;
grant execute on function private.clean_orphan_game_asset(text, integer, text, text, integer, numeric, timestamptz) to postgres, service_role;
