-- IS-2: record_game_validation also stores games.input_support from the static report (report.inputSupport.class).
-- Same body as 20261015120700 plus the input_support update; signature and grants unchanged.
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

  insert into public.game_validations as gv (game_id, version, bundle_sha256, status, static_report, finished_at)
  values (p_game_id,
          (select coalesce(max(x.version), 0) + 1 from public.game_validations x where x.game_id = p_game_id),
          p_sha256, p_status, p_report, now())
  on conflict (game_id, bundle_sha256) where bundle_sha256 is not null do nothing
  returning gv.* into v;
  if v.id is null then return; end if;

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
