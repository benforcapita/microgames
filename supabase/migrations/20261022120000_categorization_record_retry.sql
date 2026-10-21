create or replace function private.cat_claim_run(p_lease_seconds int default 600)
returns table (run_id bigint, lease_token uuid, game_id text, version int, bundle_sha256 text, mode text)
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
  v_attempts int;
begin
  if coalesce((select value from private.settings where key = 'categorization_enabled'), '') is distinct from 'true'
     or (select count(*) from private.categorization_runs
         where started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
        >= coalesce((select value::int from private.settings where key = 'categorization_daily_run_cap'), 0)
     or exists (select 1 from private.categorization_breaker b
                where b.provider in ('openrouter', 'typesafe') and b.open_until > now()) then
    return;
  end if;

  select r.id, r.attempts into v_id, v_attempts
  from private.categorization_runs r
  where (r.status = 'queued' and r.next_attempt_at <= now())
     or (r.status = 'running' and r.lease_until < now())
  order by r.next_attempt_at
  for update skip locked
  limit 1;
  if v_id is null then
    return;
  elsif v_attempts + 1 > coalesce((select value::int from private.settings where key = 'categorization_max_attempts'), 5) then
    update private.categorization_runs
    set status = 'failed', error_code = 'max_attempts', finished_at = now(),
        lease_token = null, lease_until = null
    where id = v_id;
    return;
  end if;

  return query
  update private.categorization_runs u
  set status = 'running',
      attempts = u.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      started_at = now()
  where u.id = v_id
  returning u.id, u.lease_token, u.game_id, u.version, u.bundle_sha256, u.mode;
end
$$;

create function private.cat_propose_categories(run_id bigint, lease_token uuid, p jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
  v_props jsonb;
  v_n int;
begin
  select (r.lease_token = cat_propose_categories.lease_token and r.lease_until > now())
    into v_ok
  from private.categorization_runs r
  where r.id = cat_propose_categories.run_id
  for update;
  if not coalesce(v_ok, false) then
    raise exception 'lease_lost' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('cat_propose_categories'));
  if (select count(*) from public.categories where status = 'proposed') > 50 then
    raise exception 'too_many_proposals' using errcode = 'P0001';
  end if;
  v_props := case
    when jsonb_typeof(p) = 'array' then p
    else coalesce(p -> 'proposed_categories', '[]'::jsonb)
  end;
  insert into public.categories (slug, description, status, is_safety)
  select s.slug, s.description, 'proposed', false
  from (
    select lower(btrim(e ->> 'slug')) as slug,
           btrim(coalesce(e ->> 'definition', e ->> 'name', '')) as description
    from jsonb_array_elements(v_props) as e
    limit 3
  ) s
  where s.slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    and s.description <> ''
  on conflict (slug) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

create function private.cat_record_result(run_id bigint, lease_token uuid, p jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.categorization_runs%rowtype;
  v_needs_review boolean;
  v_status text;
begin
  select r.* into v_run
  from private.categorization_runs r
  where r.id = cat_record_result.run_id
  for update;
  if v_run.id is null
     or v_run.lease_token is distinct from cat_record_result.lease_token
     or v_run.lease_until is null
     or v_run.lease_until <= now() then
    raise exception 'lease_lost' using errcode = 'P0001';
  end if;

  if v_run.mode = 'shadow' then
    insert into private.categorization_shadow_results (run_id, game_id, result)
    values (v_run.id, v_run.game_id, p)
    on conflict on constraint categorization_shadow_results_pkey do update set result = excluded.result, created_at = now();
    select exists (
      select 1
      from jsonb_array_elements(coalesce(p -> 'tags', '[]'::jsonb)) as t(tag)
      join public.categories c on c.slug = t.tag ->> 'slug'
      where c.is_safety and t.tag ->> 'status' = 'needs_review'
    ) into v_needs_review;
  else
    insert into public.game_tags as gt (game_id, bundle_sha256, category_slug, status, applies, confidence, model, version, evidence)
    select v_run.game_id, v_run.bundle_sha256,
           t.tag ->> 'slug',
           t.tag ->> 'status',
           (t.tag ->> 'applies')::boolean,
           (t.tag ->> 'confidence')::numeric,
           t.tag ->> 'model',
           t.tag ->> 'version',
           t.tag -> 'evidence'
    from jsonb_array_elements(coalesce(p -> 'tags', '[]'::jsonb)) as t(tag)
    join public.categories c on c.slug = t.tag ->> 'slug' and c.status = 'approved'
    on conflict (game_id, bundle_sha256, category_slug) do update
      set status = excluded.status,
          applies = excluded.applies,
          confidence = excluded.confidence,
          model = excluded.model,
          version = excluded.version,
          evidence = excluded.evidence,
          updated_at = now()
      where gt.status not in ('overridden', 'appealed');
    select exists (
      select 1
      from public.game_tags gt
      join public.categories c on c.slug = gt.category_slug
      where gt.game_id = v_run.game_id
        and gt.bundle_sha256 = v_run.bundle_sha256
        and c.is_safety
        and gt.status = 'needs_review'
    ) into v_needs_review;
  end if;

  v_status := case when v_needs_review then 'needs_review' else 'succeeded' end;
  update private.categorization_runs
  set status = v_status,
      finished_at = now(),
      usage = coalesce(p -> 'usage', '{}'::jsonb),
      lease_token = null,
      lease_until = null
  where id = v_run.id;

  update private.categorization_breaker b
  set consecutive_failures = 0, open_until = null
  where jsonb_typeof(p -> 'providers') = 'array'
    and b.provider in (select jsonb_array_elements_text(p -> 'providers'));
  return v_status;
end
$$;

create function private.cat_fail_run(run_id bigint, lease_token uuid, p_error_code text, p_retryable boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.categorization_runs%rowtype;
  v_max int;
  v_provider text;
  v_status text;
begin
  select r.* into v_run
  from private.categorization_runs r
  where r.id = cat_fail_run.run_id
  for update;
  if v_run.id is null
     or v_run.lease_token is distinct from cat_fail_run.lease_token
     or v_run.lease_until is null
     or v_run.lease_until <= now() then
    raise exception 'lease_lost' using errcode = 'P0001';
  end if;

  v_max := coalesce((select value::int from private.settings where key = 'categorization_max_attempts'), 5);
  if p_retryable and v_run.attempts < v_max then
    v_status := 'queued';
    update private.categorization_runs
    set status = 'queued',
        next_attempt_at = now() + make_interval(mins => (array[1, 4, 16, 60, 60])[least(v_run.attempts, 5)]),
        error_code = p_error_code,
        lease_token = null,
        lease_until = null
    where id = v_run.id;
  else
    v_status := 'failed';
    update private.categorization_runs
    set status = 'failed',
        finished_at = now(),
        error_code = p_error_code,
        lease_token = null,
        lease_until = null
    where id = v_run.id;
  end if;

  v_provider := case split_part(p_error_code, '_', 1)
    when 'haiku' then 'openrouter'
    when 'jev' then 'typesafe'
    else null
  end;

  if p_error_code in ('haiku_auth', 'haiku_credits', 'jev_auth') then
    insert into private.categorization_breaker (provider, consecutive_failures, open_until)
    values (v_provider, 0, now() + interval '15 minutes')
    on conflict (provider) do update set open_until = excluded.open_until;
  elsif p_retryable and v_provider is not null then
    insert into private.categorization_breaker (provider, consecutive_failures)
    values (v_provider, 1)
    on conflict (provider) do update
      set consecutive_failures = private.categorization_breaker.consecutive_failures + 1,
          open_until = case
            when private.categorization_breaker.consecutive_failures + 1 >= 5
            then now() + interval '15 minutes'
            else private.categorization_breaker.open_until
          end;
  end if;

  return v_status;
end
$$;

create function private.cat_purge_shadow_results()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  delete from private.categorization_shadow_results
  where created_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

create function private.cat_purge_tag_evidence()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  update public.game_tags
  set evidence = null
  where evidence is not null
    and updated_at < now() - interval '30 days';
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

revoke all on function private.cat_propose_categories(bigint, uuid, jsonb), private.cat_record_result(bigint, uuid, jsonb),
  private.cat_fail_run(bigint, uuid, text, boolean), private.cat_purge_shadow_results(), private.cat_purge_tag_evidence()
  from public, anon, authenticated;

grant execute on function private.cat_propose_categories(bigint, uuid, jsonb), private.cat_record_result(bigint, uuid, jsonb),
  private.cat_fail_run(bigint, uuid, text, boolean), private.cat_purge_shadow_results(), private.cat_purge_tag_evidence()
  to postgres, service_role;

do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception
  when others then
    raise warning 'pg_cron not enabled (%); purge functions remain callable', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'cat-purge-shadow-results') then
      perform cron.unschedule('cat-purge-shadow-results');
    end if;
    perform cron.schedule('cat-purge-shadow-results', '17 3 * * *', 'select private.cat_purge_shadow_results()');
    if exists (select 1 from cron.job where jobname = 'cat-purge-tag-evidence') then
      perform cron.unschedule('cat-purge-tag-evidence');
    end if;
    perform cron.schedule('cat-purge-tag-evidence', '23 3 * * *', 'select private.cat_purge_tag_evidence()');
  end if;
end $$;
