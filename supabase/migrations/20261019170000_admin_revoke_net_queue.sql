-- MGA-7a: meshgrounds_admin must not reach pg_net (schema net), above all
-- net.http_request_queue: its rows carry the validate-game hook header, and an
-- INSERT there makes the pg_net worker send an HTTP request.
--
-- Why this is not a plain "revoke ... from meshgrounds_admin": the role holds no
-- direct grant on net. Its access comes only from PUBLIC, which supabase_admin
-- grants when it creates pg_net 0.20.4:
--   schema net               =U/supabase_admin          (PUBLIC USAGE)
--   net.http_request_queue   =arwdDxtm/supabase_admin   (PUBLIC ALL)
-- Postgres has no deny entries, so the only fix is to take the PUBLIC grants
-- away. Only their grantor can: supabase_admin (or a superuser). The postgres
-- role that runs migrations, locally and on hosted kmigfqhtvmvwopvpjlca, is
-- neither, and a REVOKE from it is a silent no-op.
--
-- So this file does three things, and is safe to run more than once, as any
-- role:
--  1. If the current role can act as the grantor: first make sure the roles
--     that really use pg_net keep what they need through explicit grants,
--     then revoke every privilege in schema net from public, anon,
--     authenticated and meshgrounds_admin — the same locked-down end state as
--     supabase/ops/pg_net_lockdown.sql, never a mix.
--     The keep set is measured against the real worker, not assumed:
--     - the pg_net background worker runs as pg_net.username (postgres on the
--       Supabase image, NOT supabase_admin). Its loop is
--         DELETE FROM net._http_response ... USING (SELECT ctid ...)
--         WITH rows AS (SELECT id FROM net.http_request_queue ...)
--         DELETE FROM net.http_request_queue ... RETURNING ...
--         INSERT INTO net._http_response (...)
--       so it needs USAGE on schema net, SELECT+DELETE on the queue and
--       SELECT+INSERT+DELETE on net._http_response. Without this keep set the
--       PUBLIC revoke strips exactly those privileges, the worker dies in a
--       restart loop on "permission denied for table http_request_queue" and
--       every validate-game request stays queued forever;
--     - the dispatch path keeps working without PUBLIC: the hook trigger
--       calls private.dispatch_validate_game (security definer, owned by
--       postgres), which calls net.http_post (security definer, owned by
--       supabase_admin). postgres and service_role keep USAGE on schema net,
--       SELECT on the queue and EXECUTE on net.http_post and
--       net.check_worker_is_up.
--  2. Otherwise (postgres, local and hosted): change nothing and say so.
--  3. Fail closed either way: while meshgrounds_admin can still use schema
--     net or any of SELECT/INSERT/UPDATE/DELETE on the queue, force it back
--     to NOLOGIN and raise a WARNING. Ben must not run
--     ALTER ROLE meshgrounds_admin LOGIN ... until the check in the MGA-7a
--     PR returns all false.
--
-- Hosted: this file is applied by Ben only, after his OK, and BEFORE the role
-- gets LOGIN (MGA-7). Applied as postgres it only enforces NOLOGIN; the
-- PUBLIC revoke still needs supabase_admin (Supabase support runs this file,
-- or supabase/ops/pg_net_lockdown.sql, which applies the same lockdown).
-- Never DROP or ALTER EXTENSION pg_net here.

do $mga7a$
declare
  can_grant boolean;
  still_open boolean;
  worker_role text;
  fn regprocedure;
begin
  if to_regnamespace('net') is null then
    raise notice 'MGA-7a: schema net is not installed; nothing to revoke';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'meshgrounds_admin') then
    raise notice 'MGA-7a: role meshgrounds_admin does not exist; nothing to revoke';
    return;
  end if;

  -- Grantor check: superuser, or member of the role that owns schema net and
  -- the objects in it (they all share supabase_admin as owner).
  select r.rolsuper
         or (pg_has_role(current_user, n.nspowner, 'MEMBER')
             and (to_regclass('net.http_request_queue') is null
                  or pg_has_role(current_user,
                                 (select relowner from pg_class
                                   where oid = to_regclass('net.http_request_queue')),
                                 'MEMBER')))
    into can_grant
  from pg_roles r, pg_namespace n
  where r.rolname = current_user and n.nspname = 'net';

  if can_grant then
    -- Keep set first, so a failure partway through can only ever leave the
    -- worker over-privileged, never dead.
    -- The worker backend runs as pg_net.username, not supabase_admin; read it
    -- instead of guessing, with postgres as the safe fallback.
    worker_role := coalesce(nullif(current_setting('pg_net.username', true), ''), 'postgres');
    if not exists (select 1 from pg_roles where rolname = worker_role) then
      worker_role := 'postgres';
    end if;

    grant usage on schema net to postgres, service_role;
    execute format('grant usage on schema net to %I', worker_role);
    if to_regclass('net.http_request_queue') is not null then
      grant select on table net.http_request_queue to postgres, service_role;
      execute format('grant select, delete on table net.http_request_queue to %I', worker_role);
    end if;
    if to_regclass('net._http_response') is not null then
      execute format('grant select, insert, delete on table net._http_response to %I', worker_role);
    end if;
    for fn in
      select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'net' and p.proname in ('http_post', 'check_worker_is_up')
    loop
      execute format('grant execute on function %s to postgres, service_role', fn);
    end loop;

    -- Then close every path into net for the roles that must not reach it —
    -- the same end state as supabase/ops/pg_net_lockdown.sql.
    revoke usage on schema net from public, anon, authenticated;
    revoke all on all tables in schema net from public, anon, authenticated;
    revoke all on all sequences in schema net from public, anon, authenticated;
    for fn in
      select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'net'
    loop
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    end loop;
    revoke all on all tables in schema net from meshgrounds_admin;
    revoke all on all sequences in schema net from meshgrounds_admin;
    revoke all on all functions in schema net from meshgrounds_admin;
    revoke usage on schema net from meshgrounds_admin;
  else
    raise notice 'MGA-7a: % cannot revoke the PUBLIC grants on schema net (grantor is supabase_admin); grants unchanged', current_user;
  end if;

  still_open :=
    has_schema_privilege('meshgrounds_admin', 'net', 'USAGE')
    or (to_regclass('net.http_request_queue') is not null and (
         has_table_privilege('meshgrounds_admin', 'net.http_request_queue', 'SELECT')
      or has_table_privilege('meshgrounds_admin', 'net.http_request_queue', 'INSERT')
      or has_table_privilege('meshgrounds_admin', 'net.http_request_queue', 'UPDATE')
      or has_table_privilege('meshgrounds_admin', 'net.http_request_queue', 'DELETE')));

  if still_open then
    alter role meshgrounds_admin nologin;
    raise warning 'MGA-7a: meshgrounds_admin can still reach schema net (through PUBLIC or a direct grant); role kept NOLOGIN. Run this file as supabase_admin before ALTER ROLE meshgrounds_admin LOGIN.';
  end if;
end
$mga7a$;
