insert into private.settings (key, value) values
  ('categorization_enabled', 'false'),
  ('categorization_mode', 'shadow'),
  ('categorization_daily_run_cap', '50'),
  ('categorization_max_attempts', '5')
on conflict (key) do nothing;

create table private.categorization_runs (
  id bigint generated always as identity primary key,
  game_id text not null references public.games (id) on delete cascade,
  version int not null,
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  pipeline_version text not null,
  mode text not null check (mode in ('shadow', 'active')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'needs_review', 'failed', 'cancelled')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  error_code text check (error_code ~ '^[a-z0-9_]{1,64}$'),
  usage jsonb not null default '{}'::jsonb check (pg_column_size(usage) <= 2048),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (game_id, bundle_sha256, pipeline_version)
);

create index categorization_runs_ready_idx on private.categorization_runs (next_attempt_at)
  where status in ('queued', 'running');

create table private.categorization_shadow_results (
  run_id bigint primary key references private.categorization_runs (id) on delete cascade,
  game_id text not null,
  result jsonb not null check (pg_column_size(result) <= 16384),
  created_at timestamptz not null default now()
);

create table private.categorization_breaker (
  provider text primary key check (provider in ('openrouter', 'typesafe')),
  consecutive_failures int not null default 0,
  open_until timestamptz
);

alter table private.categorization_runs enable row level security;
alter table private.categorization_shadow_results enable row level security;
alter table private.categorization_breaker enable row level security;

revoke all on table private.categorization_runs, private.categorization_shadow_results, private.categorization_breaker
  from public, anon, authenticated;

create function private.cat_claim_run(p_lease_seconds int default 600)
returns table (
  run_id bigint,
  lease_token uuid,
  game_id text,
  version int,
  bundle_sha256 text,
  mode text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_token uuid;
begin
  if coalesce((select value from private.settings where key = 'categorization_enabled'), '') is distinct from 'true'
     or (
       select count(*)
       from private.categorization_runs
       where started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
     ) >= coalesce((select value::int from private.settings where key = 'categorization_daily_run_cap'), 0)
     or exists (select 1 from private.categorization_breaker where open_until > now()) then
    return;
  end if;

  select r.id into v_id
  from private.categorization_runs r
  where (r.status = 'queued' and r.next_attempt_at <= now())
     or (r.status = 'running' and r.lease_until < now())
  order by r.next_attempt_at
  for update skip locked
  limit 1;
  if v_id is null then
    return;
  end if;

  if (select attempts from private.categorization_runs where id = v_id) + 1
     > coalesce((select value::int from private.settings where key = 'categorization_max_attempts'), 5) then
    update private.categorization_runs
    set status = 'failed', error_code = 'max_attempts', finished_at = now(),
        lease_token = null, lease_until = null
    where id = v_id;
    return;
  end if;

  v_token := gen_random_uuid();
  return query
  update private.categorization_runs u
  set status = 'running',
      attempts = u.attempts + 1,
      lease_token = v_token,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      started_at = now()
  where u.id = v_id
  returning u.id, u.lease_token, u.game_id, u.version, u.bundle_sha256, u.mode;
end
$$;

create function private.cat_heartbeat(run_id bigint, lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  update private.categorization_runs u
  set lease_until = now() + interval '10 minutes'
  where u.id = cat_heartbeat.run_id
    and u.lease_token = cat_heartbeat.lease_token
    and u.lease_until > now()
  returning true into v_ok;
  return coalesce(v_ok, false);
end
$$;

create function private.cat_get_context(run_id bigint, lease_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'title', g.title,
    'tagline', g.tagline,
    'description', g.description,
    'creator_tags', g.tags,
    'screenshot_paths_count', coalesce((
      select cardinality(gv.screenshot_paths)
      from public.game_validations gv
      where gv.game_id = r.game_id and gv.version = r.version and gv.bundle_sha256 = r.bundle_sha256
      order by gv.created_at desc
      limit 1
    ), 0),
    'asset_manifest', coalesce((
      select jsonb_agg(jsonb_build_object(
        'path', a.path,
        'expected_type', a.expected_type,
        'size_bytes', a.size_bytes,
        'content_sha256', a.content_sha256,
        'status', a.status
      ) order by a.path)
      from public.game_assets a
      where a.game_id = r.game_id and a.version = r.version and a.status = 'uploaded'
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug', c.slug,
        'definition', c.description,
        'kind', case when c.is_safety then 'safety' else 'content' end,
        'confirm_threshold', c.confirm_threshold,
        'reject_threshold', c.reject_threshold
      ) order by c.slug)
      from public.categories c
      where c.status = 'approved'
    ), '[]'::jsonb)
  ) into v
  from private.categorization_runs r
  join public.games g on g.id = r.game_id
  where r.id = cat_get_context.run_id
    and r.lease_token = cat_get_context.lease_token
    and r.lease_until > now();
  if v is null then
    raise exception 'lease_lost' using errcode = 'P0001';
  end if;
  return v;
end
$$;

revoke all on function private.cat_claim_run(int) from public, anon, authenticated;
revoke all on function private.cat_heartbeat(bigint, uuid) from public, anon, authenticated;
revoke all on function private.cat_get_context(bigint, uuid) from public, anon, authenticated;
grant execute on function private.cat_claim_run(int), private.cat_heartbeat(bigint, uuid), private.cat_get_context(bigint, uuid)
  to postgres, service_role;
