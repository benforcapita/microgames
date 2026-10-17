-- UP-3b: the file cap denies only a write that ADDS a counted row.
--
-- The 20261017120000 check was `count + adds > max`, which also denied a write that adds
-- no row whenever the game already sat over the cap (v_file_count alone > max). Manifest
-- scans insert rows without going through this function, so existing data can be over
-- 200 across a game's versions — QA #78: a fill of a scanned 'missing' row on such a
-- game signed 200 and then finalized 409, stranding the staged upload. The rule the TS
-- pre-checks apply (assetWriteAddsCountedRow in src/lib/server/asset-upload.ts, pinned
-- to this function by a shared case-table test) is: a new row, or a 'rejected' audit row
-- revived as 'uploaded', adds a counted row and is capped; writing over an existing
-- counted row never is.
--
-- The games-row lock drops to FOR NO KEY UPDATE: the function only reads games.size_bytes,
-- and NO KEY UPDATE still serializes concurrent record_game_asset calls on the same row —
-- while no longer conflicting with the KEY SHARE lock an insert into a table that
-- references public.games takes (scan writes no longer wait behind an upload's lock).
--
-- Signature, grants and the rejected-row audit rules are unchanged.

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
  for no key update of g;
  if not found then
    return query select 'not-found'::text, null::bigint, null::text, null::integer, null::text, null::text, null::text, null::text;
    return;
  end if;

  select a.* into v_prev
  from public.game_assets a
  where a.game_id = p_game_id and a.version = p_version and a.path = p_path;

  if p_status = 'uploaded' then
    -- Non-rejected rows on the game (any version) count toward the file cap. A new row,
    -- or a rejected row revived as uploaded, adds one — only that write can be capped.
    -- A game can already be over the cap (scans bypass this function); replacing or
    -- filling an existing counted row stays allowed.
    select count(*) into v_file_count
    from public.game_assets a
    where a.game_id = p_game_id and a.status <> 'rejected';
    v_adds := case when v_prev.id is null or v_prev.status = 'rejected' then 1 else 0 end;
    if v_adds = 1 and v_file_count >= p_max_files then
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
