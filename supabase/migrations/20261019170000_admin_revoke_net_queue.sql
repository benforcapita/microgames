-- MGA-7a: meshgrounds_admin must not reach pg_net (schema net), above all
-- net.http_request_queue: its rows carry the validate-game hook header, and an
-- INSERT there makes the pg_net worker send an HTTP request.
--
-- Why this is not a plain "revoke ... from meshgrounds_admin": the role holds no
-- direct grant on net. Its access comes only from PUBLIC, which supabase_admin
-- grants when it creates pg_net 0.20.4:
--   schema net               =U/supabase_admin          (PUBLIC USAGE)
--   net.http_request_queue   =arwdDxtm/supabase_admin   (PUBLIC ALL)
-- Postgres has no deny entries, so the only fix is to take those two PUBLIC
-- grants away. Only their grantor can: supabase_admin (or a superuser). The
-- postgres role that runs migrations, locally and on hosted kmigfqhtvmvwopvpjlca,
-- is neither, and a REVOKE from it is a silent no-op.
--
-- So this file does three things, and is safe to run more than once, as any role:
--  1. If the current role can act as the grantor: first make sure the roles that
--     really use pg_net keep what they need through explicit grants (the same keep
--     set as supabase/ops/pg_net_lockdown.sql: postgres and service_role get USAGE
--     on schema net and SELECT on the queue; http_post/http_get already name
--     postgres, anon, authenticated, service_role and supabase_functions_admin),
--     then revoke from PUBLIC exactly two things: USAGE on schema net and ALL on
--     net.http_request_queue. It also revokes anything granted to
--     meshgrounds_admin directly. Nothing else in net changes (no function ACL,
--     no _http_response, no sequence); without USAGE on the schema the role
--     cannot name any of them.
--     Why that is safe for validate-game: private.dispatch_validate_game is
--     security definer as postgres (explicit USAGE + EXECUTE on http_post), and
--     net.http_post is security definer as supabase_admin, which writes the queue
--     row. The pg_net worker runs as supabase_admin. Losing PUBLIC on the queue
--     also takes direct queue access away from anon and authenticated (wanted).
--  2. Otherwise (postgres, local and hosted): change nothing and say so.
--  3. Fail closed either way: while meshgrounds_admin can still use schema net
--     or any of SELECT/INSERT/UPDATE/DELETE on the queue, force it back to
--     NOLOGIN and raise a WARNING. Ben must not run
--     ALTER ROLE meshgrounds_admin LOGIN ... until the check in the MGA-7a PR
--     returns all false.
--
-- Hosted: this file is applied by Ben only, after his OK, and BEFORE the role
-- gets LOGIN (MGA-7). Applied as postgres it only enforces NOLOGIN; the PUBLIC
-- revoke still needs supabase_admin (Supabase support runs this file, or
-- supabase/ops/pg_net_lockdown.sql, which covers the same two revokes).
-- Never DROP or ALTER EXTENSION pg_net here.

do $mga7a$
declare
  can_grant boolean;
  still_open boolean;
begin
  if to_regnamespace('net') is null then
    raise notice 'MGA-7a: schema net is not installed; nothing to revoke';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'meshgrounds_admin') then
    raise notice 'MGA-7a: role meshgrounds_admin does not exist; nothing to revoke';
    return;
  end if;

  -- Grantor check: superuser, or member of the role that owns schema net and the queue.
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
    -- Keep set first, so the PUBLIC revoke never takes these away.
    grant usage on schema net to postgres, service_role;
    if to_regclass('net.http_request_queue') is not null then
      grant select on table net.http_request_queue to postgres, service_role;
      revoke all on table net.http_request_queue from public, meshgrounds_admin;
    end if;
    revoke usage on schema net from public, meshgrounds_admin;
    revoke all on all tables in schema net from meshgrounds_admin;
    revoke all on all sequences in schema net from meshgrounds_admin;
    revoke all on all functions in schema net from meshgrounds_admin;
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
    raise warning 'MGA-7a: meshgrounds_admin can still reach schema net through PUBLIC; role kept NOLOGIN. Run this file as supabase_admin before ALTER ROLE meshgrounds_admin LOGIN.';
  end if;
end
$mga7a$;
