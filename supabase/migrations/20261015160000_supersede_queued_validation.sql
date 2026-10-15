-- SP-5b: one game_validations row per upload attempt.
-- Body starts from 20261015150000 (IS-2 stores games.input_support from
-- report.inputSupport.class) and, when a queued row with no bundle hash is
-- still open, records the real verdict on that row. Other queued placeholders
-- for the game are removed. A bundle that already has a verdict stays
-- idempotent: no second row, no stage change, and leftover queued placeholders
-- are removed.
-- Do not apply this file to hosted Supabase from a laptop or an agent.
-- 20261015140100 sorted before the input_support update and is not used.

create or replace function public.record_game_validation(
  p_game_id text, p_sha256 text, p_status text, p_report jsonb)
returns table (id uuid, status text, bundle_sha256 text, version int, stage text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  cur text;
  nxt text;
  v public.game_validations%rowtype;
begin
  select g.stage into cur from public.games g where g.id = p_game_id for update;
  if not found then return; end if;

  if exists (
    select 1 from public.game_validations y
    where y.game_id = p_game_id and y.bundle_sha256 = p_sha256
  ) then
    delete from public.game_validations q
     where q.game_id = p_game_id
       and q.status = 'queued'
       and q.bundle_sha256 is null;
    return;
  end if;

  update public.game_validations gv
     set bundle_sha256 = p_sha256,
         status = p_status,
         static_report = p_report,
         finished_at = now()
   where gv.id = (
     select x.id
       from public.game_validations x
      where x.game_id = p_game_id
        and x.status = 'queued'
        and x.bundle_sha256 is null
      order by x.created_at desc
      limit 1
   )
  returning gv.* into v;

  if not found then
    insert into public.game_validations as gv (game_id, version, bundle_sha256, status, static_report, finished_at)
    values (p_game_id,
            (select coalesce(max(x.version), 0) + 1 from public.game_validations x where x.game_id = p_game_id),
            p_sha256, p_status, p_report, now())
    on conflict (game_id, bundle_sha256) where bundle_sha256 is not null do nothing
    returning gv.* into v;
    if not found then return; end if;
  end if;

  delete from public.game_validations q
   where q.game_id = p_game_id
     and q.id is distinct from v.id
     and q.status = 'queued'
     and q.bundle_sha256 is null;

  nxt := case when cur = 'pending' and p_status = 'passed' then 'proving'
              when cur = 'pending' and p_status = 'failed' then 'rejected'
              else cur end;
  if nxt <> cur then update public.games set stage = nxt where public.games.id = p_game_id; end if;

  -- IS-2: store the static check's input-support class (report-only; ignored unless it is a known value).
  if p_report->'inputSupport'->>'class' in ('mobile', 'desktop', 'both', 'unknown') then
    update public.games set input_support = p_report->'inputSupport'->>'class' where public.games.id = p_game_id;
  end if;

  return query select v.id, v.status, v.bundle_sha256, v.version, nxt;
end;
$$;

revoke all on function public.record_game_validation(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_game_validation(text, text, text, jsonb) to service_role;
