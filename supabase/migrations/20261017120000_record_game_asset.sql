-- UP-3: race-safe asset caps.
--
-- The upload routes used to read usage, decide, and then write the game_assets row in
-- separate statements, so concurrent finalizes could all observe the same under-cap state
-- and each write a row (QA #76/#77: 8 concurrent finalizes at 199/200 files produced
-- 204-206 rows; 4 concurrent 1.8 MB finalizes put 7.5 MB on a 4 MB version). This function
-- is the one place a row is written: it takes a FOR UPDATE lock on the game's row (the
-- file cap counts rows across all of a game's versions, so the lock unit is the game),
-- recomputes usage inside the same statement, and writes only when both caps hold.
--
-- 'rejected' rows are an audit trail, not stored files: they count toward neither the
-- file cap nor the byte cap. A rejected path being revived as 'uploaded' does add one to
-- the counted rows, so it is still capped.
--
-- The caps arrive as parameters (the TypeScript constants in src/lib are the single source
-- of truth). The function lives in the private schema — PostgREST never exposes it — and
-- EXECUTE is service_role/postgres only, matching the other private functions.

create or replace function private.record_game_asset(
  p_game_id text,
  p_version integer,
  p_path text,
  p_expected_type text,
  p_status text,
  p_size_bytes integer,
  p_sha256 text,
  p_source text,
  p_reject_reason text,
  p_max_files integer,
  p_max_bytes bigint
)
returns table (
  result text,
  total_bytes bigint,
  prev_status text,
  prev_size_bytes integer,
  prev_sha256 text,
  prev_reject_reason text,
  prev_source text,
  prev_expected_type text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_code_bytes integer;
  v_prev public.game_assets%rowtype;
  v_file_count integer;
  v_adds integer;
  v_uploaded_bytes bigint;
  v_total bigint;
begin
  if p_status not in ('uploaded', 'rejected') then
    raise exception 'record_game_asset: unsupported status %', p_status;
  end if;

  -- Lock the games row for the rest of this statement: a second writer waits here and
  -- only then recomputes usage, so the check and the write cannot interleave.
  select g.size_bytes into v_code_bytes
  from public.games g
  where g.id = p_game_id
  for update of g;
  if not found then
    return query select 'not-found'::text, null::bigint, null::text, null::integer, null::text, null::text, null::text, null::text;
    return;
  end if;

  select a.* into v_prev
  from public.game_assets a
  where a.game_id = p_game_id and a.version = p_version and a.path = p_path;

  if p_status = 'uploaded' then
    -- Non-rejected rows on the game (any version) count toward the file cap. A new row,
    -- or a rejected row revived as uploaded, adds one.
    select count(*) into v_file_count
    from public.game_assets a
    where a.game_id = p_game_id and a.status <> 'rejected';
    v_adds := case when v_prev.id is null or v_prev.status = 'rejected' then 1 else 0 end;
    if v_file_count + v_adds > p_max_files then
      return query select 'cap'::text, null::bigint, null::text, null::integer, null::text, null::text, null::text, null::text;
      return;
    end if;

    -- The byte cap is per version: the game's code plus uploaded asset bytes, with the
    -- replaced row contributing its old size.
    select coalesce(sum(a.size_bytes), 0) into v_uploaded_bytes
    from public.game_assets a
    where a.game_id = p_game_id and a.version = p_version and a.status = 'uploaded';
    v_total := coalesce(v_code_bytes, 0)
      + v_uploaded_bytes
      - case when v_prev.status = 'uploaded' then coalesce(v_prev.size_bytes, 0) else 0 end
      + p_size_bytes;
    if v_total > p_max_bytes then
      return query select 'too-big'::text, v_total, null::text, null::integer, null::text, null::text, null::text, null::text;
      return;
    end if;
  end if;

  insert into public.game_assets
    (game_id, version, path, expected_type, status, size_bytes, content_sha256, source, reject_reason, updated_at)
  values
    (p_game_id, p_version, p_path, p_expected_type, p_status, p_size_bytes, p_sha256, p_source, p_reject_reason, now())
  on conflict (game_id, version, path) do update set
    status = excluded.status,
    size_bytes = excluded.size_bytes,
    content_sha256 = excluded.content_sha256,
    reject_reason = excluded.reject_reason,
    updated_at = now();

  -- 'ok' carries the displaced row so the caller can restore it if the storage write
  -- that follows this reservation fails (null prev_* = there was no row).
  return query select
    'ok'::text, null::bigint,
    v_prev.status, v_prev.size_bytes, v_prev.content_sha256, v_prev.reject_reason, v_prev.source, v_prev.expected_type;
end;
$$;

revoke all on function private.record_game_asset(text, integer, text, text, text, integer, text, text, text, integer, bigint) from public, anon, authenticated;
grant execute on function private.record_game_asset(text, integer, text, text, text, integer, text, text, text, integer, bigint) to postgres, service_role;
