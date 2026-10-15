-- EF-2: when a game becomes stage = 'pending', ask the validate-game Edge Function
-- to run. EF-1 owns that function (migration 20261015120700). This file is
-- 20261015120800 so it sorts after SP-3 120500, RT-2 120600, and EF-1 120700.
-- Hosted already applied 20261015120200, so this timestamp stays after it.
--
-- pg_net ships as a shared library on the Supabase image. Enable it only when
-- the extension row is missing. Never drop it and never ALTER EXTENSION.
-- The function URL is private.settings key validate_game_url. This file does
-- not insert one. The hook secret is Vault name validate_game_hook_secret.
-- This file does not create that secret and does not store a service-role key.
-- Do not apply this file to hosted Supabase from a laptop or an agent.

-- Install into extensions, matching the other Supabase extensions. IF NOT EXISTS
-- leaves an already-installed shared pg_net row where it is.
create extension if not exists pg_net with schema extensions;

-- Take anon and authenticated off the queue and off http_post. pg_net is owned
-- by supabase_admin, so a non-superuser postgres role's REVOKE warns and does
-- not change those grants (Supabase platform constraint). Keep the statements:
-- they take effect when the migration role can revoke. Do not drop or alter
-- the extension. Grant postgres and service_role SELECT first so a real revoke
-- of the PUBLIC grant does not remove the only path those roles have.
do $$
declare
  fn regprocedure;
begin
  if to_regclass('net.http_request_queue') is not null then
    begin
      grant select on table net.http_request_queue to postgres, service_role;
    exception
      when insufficient_privilege then
        raise warning 'could not grant select on net.http_request_queue: %', sqlerrm;
    end;
    revoke select on table net.http_request_queue from public, anon, authenticated;
  end if;

  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net'
      and p.proname = 'http_post'
  loop
    execute format('revoke execute on function %s from anon, authenticated', fn);
  end loop;
end $$;

-- pg_cron is optional. If the shared library is not preloaded, keep the
-- re-callable sweeper and skip the schedule below.
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception
  when others then
    raise warning 'pg_cron not enabled (%). private.sweep_stuck_pending_games() is still callable.', sqlerrm;
end $$;

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, service_role;

-- Non-secret sweeper defaults. validate_game_url is not inserted: an empty or
-- missing URL makes dispatch a no-op. Operators set that key in place.
create table private.settings (
  key text primary key,
  value text not null
);

alter table private.settings enable row level security;
revoke all on table private.settings from public, anon, authenticated;

insert into private.settings (key, value) values
  ('validate_game_stuck_after', '2 minutes'),
  ('validate_game_max_attempts', '8')
on conflict (key) do nothing;

-- One row per game that has been handed to validate-game. The sweeper uses
-- last_dispatched_at to find pendings that never left 'pending'.
create table private.validation_dispatch (
  game_id text primary key references public.games (id) on delete cascade,
  attempts integer not null default 0,
  last_dispatched_at timestamptz,
  last_request_id bigint,
  last_reason text
);

alter table private.validation_dispatch enable row level security;
revoke all on table private.validation_dispatch from public, anon, authenticated;

-- Allow pending (so the trigger can fire) and rejected (so eight missed calls
-- can leave the proving grounds). If an earlier migration already allows both
-- (EF-1 / SP-3), leave that check alone.
do $$
declare
  def text;
begin
  select pg_get_constraintdef(oid) into def
  from pg_constraint
  where conrelid = 'public.games'::regclass
    and conname = 'games_stage_check';

  if def is null
     or position('pending' in def) = 0
     or position('rejected' in def) = 0 then
    alter table public.games drop constraint if exists games_stage_check;
    alter table public.games add constraint games_stage_check
      check (stage in ('pending', 'proving', 'live', 'rejected'));
  end if;
end $$;

-- public.game_validations belongs to EF-1 (#29), which sorts before this file
-- (20261015120700). The sweeper inserts the rejection row.
-- This migration does not create the table.

-- Posts one game id to validate-game. Returns the pg_net request id, or null
-- when the call could not be queued. A missing URL, a missing Vault secret, or
-- the known default secret skips the call and does not reject the game.
-- Never raises into the caller's transaction: a down function must not block
-- saving the game.
create or replace function private.dispatch_validate_game(p_game_id text, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
  v_known_default constant text := 'local-dev-validate-game';
begin
  select value into v_url from private.settings where key = 'validate_game_url';
  if v_url is null or length(btrim(v_url)) = 0 then
    raise warning 'validate-game dispatch skipped for %: validate_game_url is unset', p_game_id;
    return null;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'validate_game_hook_secret'
  limit 1;

  if v_secret is null or length(btrim(v_secret)) = 0 then
    raise warning 'validate-game dispatch skipped for %: vault secret validate_game_hook_secret is missing', p_game_id;
    return null;
  end if;

  if btrim(v_secret) = v_known_default then
    raise warning 'validate-game dispatch skipped for %: vault secret validate_game_hook_secret is the known default', p_game_id;
    return null;
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise warning 'validate-game dispatch skipped for %: shared pg_net extension is not installed', p_game_id;
    return null;
  end if;

  -- EF-1 reads camelCase gameId. The hook header is the Vault secret, not a service-role key.
  select net.http_post(
    url := v_url,
    body := jsonb_build_object('gameId', p_game_id, 'reason', p_reason),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-meshgrounds-hook', v_secret
    ),
    timeout_milliseconds := 5000
  ) into v_request_id;

  insert into private.validation_dispatch as d (game_id, attempts, last_dispatched_at, last_request_id, last_reason)
  values (p_game_id, 1, now(), v_request_id, p_reason)
  on conflict (game_id) do update
    set attempts = d.attempts + 1,
        last_dispatched_at = now(),
        last_request_id = excluded.last_request_id,
        last_reason = excluded.last_reason;

  return v_request_id;
exception
  when others then
    raise warning 'validate-game dispatch failed for %: %', p_game_id, sqlerrm;
    return null;
end;
$$;

create or replace function private.games_enqueue_validate_game()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- INSERT has no old row. UPDATE OF stage also fires when the column is set
  -- to the value it already had; skip that so a no-op write does not re-queue.
  if tg_op = 'UPDATE' and old.stage is not distinct from new.stage then
    return new;
  end if;
  perform private.dispatch_validate_game(new.id, 'stage_pending');
  return new;
end;
$$;

-- Insert, or an update that sets stage. The function queues only a transition
-- into 'pending'. Other column updates on an already-pending row do not call
-- the function; the sweeper retries those.
create trigger games_enqueue_validate_game
  after insert or update of stage on public.games
  for each row
  when (new.stage = 'pending')
  execute function private.games_enqueue_validate_game();

-- Eight unanswered calls is enough. Mark the game rejected and insert the
-- game_validations row SP-5's /submissions/[id] page reads. EF-1 creates that
-- table before this migration runs.
create or replace function private.reject_unavailable_validation(p_game_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
  v_reason text := 'validation unavailable, please re-upload';
begin
  update public.games
    set stage = 'rejected'
    where id = p_game_id and stage = 'pending';
  if not found then
    return;
  end if;

  update private.validation_dispatch
    set last_reason = v_reason
    where game_id = p_game_id;

  select coalesce(max(v.version), 0) + 1 into v_version
  from public.game_validations v
  where v.game_id = p_game_id;

  insert into public.game_validations (game_id, version, status, static_report, finished_at)
  values (
    p_game_id,
    v_version,
    'error',
    jsonb_build_object('reason', v_reason, 'status', 'error'),
    now()
  );
end;
$$;

-- Re-callable. Re-queues stuck pending games, and rejects those that already
-- used validate_game_max_attempts (local default 8). Returns how many were re-queued.
create or replace function private.sweep_stuck_pending_games()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_after interval;
  v_max integer;
  rec record;
  v_count integer := 0;
begin
  select value::interval into v_after
  from private.settings
  where key = 'validate_game_stuck_after';
  if v_after is null then
    v_after := interval '2 minutes';
  end if;

  select value::integer into v_max
  from private.settings
  where key = 'validate_game_max_attempts';
  if v_max is null then
    v_max := 8;
  end if;

  for rec in
    select g.id, coalesce(d.attempts, 0) as attempts
    from public.games g
    left join private.validation_dispatch d on d.game_id = g.id
    where g.stage = 'pending'
      and (
        coalesce(d.attempts, 0) >= v_max
        or d.last_dispatched_at is null
        or d.last_dispatched_at < now() - v_after
      )
    order by g.created_at
    limit 50
  loop
    if rec.attempts >= v_max then
      perform private.reject_unavailable_validation(rec.id);
    else
      perform private.dispatch_validate_game(rec.id, 'sweep');
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function private.dispatch_validate_game(text, text) from public, anon, authenticated;
revoke all on function private.games_enqueue_validate_game() from public, anon, authenticated;
revoke all on function private.reject_unavailable_validation(text) from public, anon, authenticated;
revoke all on function private.sweep_stuck_pending_games() from public, anon, authenticated;

grant execute on function private.dispatch_validate_game(text, text) to postgres, service_role;
grant execute on function private.games_enqueue_validate_game() to postgres, service_role;
grant execute on function private.reject_unavailable_validation(text) to postgres, service_role;
grant execute on function private.sweep_stuck_pending_games() to postgres, service_role;

-- pg_cron is optional. The sweeper above is what a manual or external retry calls.
-- Schedule it only when the extension is already available. Never touch pg_net here.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'sweep-stuck-pending-games') then
      perform cron.unschedule('sweep-stuck-pending-games');
    end if;
    perform cron.schedule(
      'sweep-stuck-pending-games',
      '* * * * *',
      'select private.sweep_stuck_pending_games()'
    );
  end if;
end $$;
