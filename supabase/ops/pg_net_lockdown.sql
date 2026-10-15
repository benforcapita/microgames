-- Post-deploy attempt to close anon, authenticated, and PUBLIC access to pg_net.
--
-- Run this as the CURRENT role. Do not SET ROLE. Do not assume supabase_admin.
-- On hosted project kmigfqhtvmvwopvpjlca the SQL role is postgres (pg_net 0.20.4).
-- postgres does not own these grants, so the statements below warn and leave
-- them in place. That is a GAP, not a crash. The hosted lockdown cannot be
-- applied from our side. The guard is that schema net is not exposed through
-- the API (Settings > API / pgrst.db_schemas). Engineering Lead is raising the
-- hosted fix with Ben.
--
-- When the current role is the grantor (local supabase_admin), this grants
-- postgres and service_role what dispatch needs, then revokes the rest:
--   GRANT USAGE on schema net
--   GRANT SELECT on net.http_request_queue
--   GRANT EXECUTE on net.http_post
--   REVOKE ALL on net.http_request_queue
--   REVOKE USAGE on schema net
--   REVOKE EXECUTE on every function in schema net
-- from public, anon, and authenticated.
-- http_post is security definer, owned by supabase_admin, so the worker still
-- inserts the queue row after PUBLIC loses INSERT.
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
begin
  if to_regnamespace('net') is null then
    raise warning 'pg_net lockdown: schema net is not installed; nothing to change';
    return;
  end if;

  begin
    grant usage on schema net to postgres, service_role;
  exception
    when others then
      raise warning 'pg_net lockdown: grant usage on schema net failed: %', sqlerrm;
  end;

  if to_regclass('net.http_request_queue') is not null then
    begin
      grant select on table net.http_request_queue to postgres, service_role;
    exception
      when others then
        raise warning 'pg_net lockdown: grant select on net.http_request_queue failed: %', sqlerrm;
    end;

    begin
      revoke all on table net.http_request_queue from public, anon, authenticated;
    exception
      when others then
        raise warning 'pg_net lockdown: revoke all on net.http_request_queue failed: %', sqlerrm;
    end;
  else
    raise warning 'pg_net lockdown: net.http_request_queue is missing';
  end if;

  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net'
      and p.proname = 'http_post'
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
