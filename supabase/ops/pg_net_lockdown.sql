-- Post-deploy attempt to close anon, authenticated, and PUBLIC access to pg_net.
--
-- Run this as the CURRENT role. Do not SET ROLE. Do not assume supabase_admin.
-- On hosted project kmigfqhtvmvwopvpjlca the SQL role is postgres (pg_net 0.20.4).
-- postgres does not own these grants, so the statements below warn and leave
-- them in place. That is a GAP, not a crash.
--
-- Hosted remediation: Supabase support runs this file as supabase_admin.
-- Then `npm run check:pg-net -- --strict` is a required post-deploy step.
-- It exits non-zero while any row is GAP. Also confirm schema net is not
-- exposed through the API (Settings > API / pgrst.db_schemas).
--
-- When the current role is the grantor (local supabase_admin), this first
-- grants the keep set — the roles that really use pg_net:
--   - the pg_net background worker, which runs as pg_net.username (postgres
--     on the Supabase image, NOT supabase_admin): USAGE on schema net,
--     SELECT+DELETE on net.http_request_queue (its batch loop is a
--     DELETE ... RETURNING) and SELECT+INSERT+DELETE on net._http_response
--     (TTL cleanup and response writes). Without these the PUBLIC revoke
--     kills the worker: "permission denied for table http_request_queue",
--     restart loop, requests never drained;
--   - the dispatch path: private.dispatch_validate_game is security definer
--     as postgres and calls net.http_post (security definer as
--     supabase_admin). postgres and service_role keep USAGE on schema net,
--     SELECT on the queue and EXECUTE on net.http_post and
--     net.check_worker_is_up.
-- Then it revokes, from public, anon, and authenticated:
--   REVOKE USAGE on schema net
--   REVOKE ALL on every table in schema net (queue and _http_response)
--   REVOKE ALL on every sequence in schema net
--   REVOKE EXECUTE on every function in schema net
--
-- This file does not DROP or ALTER EXTENSION pg_net, and it does not raise
-- when the current role cannot change a grant.
--
-- Report (does not raise; one PASS/GAP row per role and privilege):
--   npm run check:pg-net -- --lockdown
--   psql "$DATABASE_URL" -f supabase/ops/check_pg_net_privileges.sql
-- Exit non-zero when any row is still GAP:
--   npm run check:pg-net -- --lockdown --strict

do $lockdown$
declare
  fn regprocedure;
  worker_role text;
begin
  if to_regnamespace('net') is null then
    raise warning 'pg_net lockdown: schema net is not installed; nothing to change';
    return;
  end if;

  -- Keep set first: the worker backend runs as pg_net.username, not
  -- supabase_admin; read it instead of guessing, postgres as safe fallback.
  worker_role := coalesce(nullif(current_setting('pg_net.username', true), ''), 'postgres');
  if not exists (select 1 from pg_roles where rolname = worker_role) then
    worker_role := 'postgres';
  end if;

  begin
    grant usage on schema net to postgres, service_role;
    execute format('grant usage on schema net to %I', worker_role);
  exception
    when others then
      raise warning 'pg_net lockdown: grant usage on schema net failed: %', sqlerrm;
  end;

  if to_regclass('net.http_request_queue') is not null then
    begin
      grant select on table net.http_request_queue to postgres, service_role;
      execute format('grant select, delete on table net.http_request_queue to %I', worker_role);
    exception
      when others then
        raise warning 'pg_net lockdown: grant on net.http_request_queue failed: %', sqlerrm;
    end;
  else
    raise warning 'pg_net lockdown: net.http_request_queue is missing';
  end if;

  if to_regclass('net._http_response') is not null then
    begin
      execute format('grant select, insert, delete on table net._http_response to %I', worker_role);
    exception
      when others then
        raise warning 'pg_net lockdown: grant on net._http_response failed: %', sqlerrm;
    end;
  end if;

  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net'
      and p.proname in ('http_post', 'check_worker_is_up')
  loop
    begin
      execute format('grant execute on function %s to postgres, service_role', fn);
    exception
      when others then
        raise warning 'pg_net lockdown: grant execute on % failed: %', fn, sqlerrm;
    end;
  end loop;

  begin
    revoke usage on schema net from public, anon, authenticated;
  exception
    when others then
      raise warning 'pg_net lockdown: revoke usage on schema net failed: %', sqlerrm;
  end;

  begin
    revoke all on all tables in schema net from public, anon, authenticated;
  exception
    when others then
      raise warning 'pg_net lockdown: revoke tables in schema net failed: %', sqlerrm;
  end;

  begin
    revoke all on all sequences in schema net from public, anon, authenticated;
  exception
    when others then
      raise warning 'pg_net lockdown: revoke sequences in schema net failed: %', sqlerrm;
  end;

  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net'
  loop
    begin
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    exception
      when others then
        raise warning 'pg_net lockdown: revoke execute on % failed: %', fn, sqlerrm;
    end;
  end loop;
end
$lockdown$;
