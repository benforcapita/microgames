-- EF-1: atomic "record verdict + auto-publish" for the validate-game Edge Function.
-- It locks the game, inserts the validation (unique on game_id + bundle_sha256) and moves the
-- stage only out of 'pending' (passed -> proving, failed -> rejected), mirroring
-- stageAfterValidation() in src/lib/server/game-rules.ts. It returns no row if the bundle was
-- already recorded, which is what makes the function idempotent.
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

  return query select v.id, v.status, v.bundle_sha256, v.version, nxt;
end;
$$;

revoke all on function public.record_game_validation(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_game_validation(text, text, text, jsonb) to service_role;

-- Same bundle re-validated while the game is pending again (e.g. re-set to pending without a new upload):
-- the stored verdict is reused (no new row) but its transition still applies. Locks the game like above.
create or replace function public.apply_stored_validation(p_game_id text, p_sha256 text)
returns table (stage text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  cur text;
  st text;
  nxt text;
begin
  select g.stage into cur from public.games g where g.id = p_game_id for update;
  if not found then return; end if;
  select gv.status into st from public.game_validations gv
   where gv.game_id = p_game_id and gv.bundle_sha256 = p_sha256
   order by gv.version desc limit 1;
  if st is null then return; end if;

  nxt := case when cur = 'pending' and st = 'passed' then 'proving'
              when cur = 'pending' and st = 'failed' then 'rejected'
              else cur end;
  if nxt <> cur then update public.games set stage = nxt where public.games.id = p_game_id; end if;
  return query select nxt;
end;
$$;

revoke all on function public.apply_stored_validation(text, text) from public, anon, authenticated;
grant execute on function public.apply_stored_validation(text, text) to service_role;
