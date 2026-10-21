insert into private.settings (key, value)
values ('categorization_pipeline_version', 'cat-v1')
on conflict (key) do nothing;

create or replace function private.cat_enqueue_run(
  p_game_id text,
  p_version int,
  p_bundle_sha256 text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline_version text;
  v_mode text;
begin
  select coalesce((select value from private.settings where key = 'categorization_pipeline_version'), 'cat-v1') into v_pipeline_version;
  select coalesce((select value from private.settings where key = 'categorization_mode'), 'shadow') into v_mode;

  insert into private.categorization_runs (
    game_id,
    version,
    bundle_sha256,
    pipeline_version,
    mode
  ) values (
    p_game_id,
    p_version,
    p_bundle_sha256,
    v_pipeline_version,
    v_mode
  )
  on conflict (game_id, bundle_sha256, pipeline_version) do nothing;
end;
$$;

create or replace function private.enqueue_categorization_on_pass()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'passed' and new.bundle_sha256 is not null and (TG_OP = 'INSERT' or old.status is distinct from 'passed' or old.bundle_sha256 is distinct from new.bundle_sha256) then
    begin
      perform private.cat_enqueue_run(new.game_id, new.version, new.bundle_sha256);
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_categorization_on_pass on public.game_validations;
create trigger enqueue_categorization_on_pass
  after insert or update of status, bundle_sha256 on public.game_validations
  for each row execute function private.enqueue_categorization_on_pass();

create or replace function private.cat_backfill_runs()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline_version text;
  v_mode text;
  v_count int;
begin
  select coalesce((select value from private.settings where key = 'categorization_pipeline_version'), 'cat-v1') into v_pipeline_version;
  select coalesce((select value from private.settings where key = 'categorization_mode'), 'shadow') into v_mode;

  with latest_passed as (
    select distinct on (gv.game_id)
      gv.game_id,
      gv.version,
      gv.bundle_sha256
    from public.game_validations gv
    where gv.status = 'passed'
      and gv.bundle_sha256 is not null
    order by gv.game_id, gv.created_at desc, gv.version desc
  ),
  inserted as (
    insert into private.categorization_runs (
      game_id,
      version,
      bundle_sha256,
      pipeline_version,
      mode
    )
    select
      lp.game_id,
      lp.version,
      lp.bundle_sha256,
      v_pipeline_version,
      v_mode
    from latest_passed lp
    on conflict (game_id, bundle_sha256, pipeline_version) do nothing
    returning 1
  )
  select count(*)::int into v_count from inserted;

  return v_count;
end;
$$;

revoke all on function private.cat_enqueue_run(text, int, text) from public, anon, authenticated;
revoke all on function private.enqueue_categorization_on_pass() from public, anon, authenticated;
revoke all on function private.cat_backfill_runs() from public, anon, authenticated;
grant execute on function private.cat_enqueue_run(text, int, text), private.enqueue_categorization_on_pass(), private.cat_backfill_runs()
  to postgres, service_role;
