-- Report pg_net privileges. Does not raise.
--
-- One row per role and privilege. status is PASS or GAP.
--   anon, authenticated, public (closed):
--     PASS = the privilege is absent, GAP = the privilege is still held.
--   postgres, service_role (dispatch still needs these):
--     PASS = the privilege is present, GAP = the privilege is missing.
--
-- Checked:
--   USAGE on schema net
--   SELECT on net.http_request_queue
--   INSERT on net.http_request_queue (closed roles; PUBLIC all-grant)
--   EXECUTE on every function in schema net (closed roles)
--   EXECUTE on net.http_post (postgres and service_role)
--
--   npm run check:pg-net
--   npm run check:pg-net -- --lockdown
--   npm run check:pg-net -- --strict
--   psql "$DATABASE_URL" -f supabase/ops/check_pg_net_privileges.sql
--
-- A missing schema, queue, or http_post is GAP.
-- Hosted remediation: Supabase support runs supabase/ops/pg_net_lockdown.sql
-- as supabase_admin. Then `npm run check:pg-net -- --strict` is a required
-- post-deploy step and must exit 0. Our postgres role cannot apply the
-- lockdown, so a GAP report after a postgres attempt is expected until support
-- has run the script.

with roles as (
  select *
  from (values
    ('anon'::text, 'closed'::text),
    ('authenticated', 'closed'),
    ('public', 'closed'),
    ('postgres', 'keep'),
    ('service_role', 'keep')
  ) as v(role_name, expectation)
),
present as (
  select
    to_regnamespace('net') is not null as has_schema,
    to_regclass('net.http_request_queue') is not null as has_queue
),
fn as (
  select
    p.oid,
    p.proname,
    'net.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as object_name
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'net'
),
checks as (
  select
    r.role_name,
    r.expectation,
    'USAGE'::text as privilege,
    'schema net'::text as object_name,
    case
      when not present.has_schema then r.expectation = 'closed'
      else has_schema_privilege(r.role_name, 'net', 'USAGE')
    end as held
  from roles r
  cross join present

  union all

  select
    r.role_name,
    r.expectation,
    'SELECT',
    'net.http_request_queue',
    case
      when not present.has_queue then r.expectation = 'closed'
      else has_table_privilege(r.role_name, 'net.http_request_queue', 'SELECT')
    end
  from roles r
  cross join present

  union all

  select
    r.role_name,
    r.expectation,
    'INSERT',
    'net.http_request_queue',
    case
      when not present.has_queue then true
      else has_table_privilege(r.role_name, 'net.http_request_queue', 'INSERT')
    end
  from roles r
  cross join present
  where r.expectation = 'closed'

  union all

  select
    r.role_name,
    r.expectation,
    'EXECUTE',
    f.object_name,
    has_function_privilege(r.role_name, f.oid, 'EXECUTE')
  from roles r
  join fn f on true
  where r.expectation = 'closed'
     or f.proname = 'http_post'

  union all

  select
    r.role_name,
    r.expectation,
    'EXECUTE',
    'net.http_post',
    r.expectation = 'closed'
  from roles r
  where not exists (select 1 from fn where proname = 'http_post')
)
select
  role_name,
  privilege,
  object_name,
  case
    when expectation = 'closed' and held then 'GAP'
    when expectation = 'closed' and not held then 'PASS'
    when expectation = 'keep' and held then 'PASS'
    else 'GAP'
  end as status
from checks
order by
  case role_name
    when 'anon' then 1
    when 'authenticated' then 2
    when 'public' then 3
    when 'postgres' then 4
    when 'service_role' then 5
    else 6
  end,
  privilege,
  object_name;
