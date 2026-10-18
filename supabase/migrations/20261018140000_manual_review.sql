-- MR-1: manual review. A passing validation stays pending until a person sets stage to
-- 'proving' (or 'rejected', with review_note). Existing rows keep their stage: this file
-- does not update games.stage. Do not apply this file to hosted Supabase from an agent.

alter table public.games
  add column if not exists review_note text,
  add column if not exists reviewed_at timestamptz;

-- The portal writes this from MG_MANUAL_REVIEW ('1' or '0'). Re-applying the file must
-- not reset an operator's choice. Missing, or anything other than '0', means review is on.
insert into private.settings (key, value) values ('mg_manual_review', '1')
on conflict (key) do nothing;

create or replace function public.manual_review_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.value from private.settings s where s.key = 'mg_manual_review'),
    '1'
  ) is distinct from '0';
$$;

revoke all on function public.manual_review_enabled() from public, anon, authenticated;
grant execute on function public.manual_review_enabled() to service_role;

-- Latest body is 20261015160000, plus an optional p_manual_review flag.
-- Null uses manual_review_enabled() (the settings row). An explicit boolean is for tests.
-- Passed + hold stays pending. Passed + flag off moves to proving. Failed still rejects.
-- A game that is already proving or live is not demoted.
drop function if exists public.record_game_validation(text, text, text, jsonb);

create or replace function public.record_game_validation(
  p_game_id text,
  p_sha256 text,
  p_status text,
  p_report jsonb,
  p_manual_review boolean default null)
returns table (id uuid, status text, bundle_sha256 text, version int, stage text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  cur text;
  nxt text;
  hold boolean := coalesce(p_manual_review, public.manual_review_enabled());
  v public.game_validations%rowtype;
begin
  select g.stage into cur from public.games g where g.id = p_game_id for update;
  if not found then return; end if;

  if exists (
    select 1 from public.game_validations y
    where y.game_id = p_game_id and y.bundle_sha256 = p_sha256
  ) then
    delete from public.game_validations q
     where q.game_id = p_game_id
       and q.status = 'queued'
       and q.bundle_sha256 is null;
    return;
  end if;

  update public.game_validations gv
     set bundle_sha256 = p_sha256,
         status = p_status,
         static_report = p_report,
         finished_at = now()
   where gv.id = (
     select x.id
       from public.game_validations x
      where x.game_id = p_game_id
        and x.status = 'queued'
        and x.bundle_sha256 is null
      order by x.created_at desc
      limit 1
   )
  returning gv.* into v;

  if not found then
    insert into public.game_validations as gv (game_id, version, bundle_sha256, status, static_report, finished_at)
    values (p_game_id,
            (select coalesce(max(x.version), 0) + 1 from public.game_validations x where x.game_id = p_game_id),
            p_sha256, p_status, p_report, now())
    on conflict (game_id, bundle_sha256) where bundle_sha256 is not null do nothing
    returning gv.* into v;
    if not found then return; end if;
  end if;

  delete from public.game_validations q
   where q.game_id = p_game_id
     and q.id is distinct from v.id
     and q.status = 'queued'
     and q.bundle_sha256 is null;

  nxt := case when cur = 'pending' and p_status = 'passed' and hold then cur
              when cur = 'pending' and p_status = 'passed' then 'proving'
              when cur = 'pending' and p_status = 'failed' then 'rejected'
              else cur end;
  -- Automatic stage moves are not a human review, so they must not stamp reviewed_at.
  perform set_config('meshground.skip_review_stamp', '1', true);
  if nxt <> cur then update public.games set stage = nxt where public.games.id = p_game_id; end if;

  if p_report->'inputSupport'->>'class' in ('mobile', 'desktop', 'both', 'unknown') then
    update public.games set input_support = p_report->'inputSupport'->>'class' where public.games.id = p_game_id;
  end if;

  return query select v.id, v.status, v.bundle_sha256, v.version, nxt;
end;
$$;

revoke all on function public.record_game_validation(text, text, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.record_game_validation(text, text, text, jsonb, boolean) to service_role;

drop function if exists public.apply_stored_validation(text, text);

create or replace function public.apply_stored_validation(p_game_id text, p_sha256 text, p_manual_review boolean default null)
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
  hold boolean := coalesce(p_manual_review, public.manual_review_enabled());
begin
  select g.stage into cur from public.games g where g.id = p_game_id for update;
  if not found then return; end if;
  select gv.status into st from public.game_validations gv
   where gv.game_id = p_game_id and gv.bundle_sha256 = p_sha256
   order by gv.version desc limit 1;
  if st is null then return; end if;

  nxt := case when cur = 'pending' and st = 'passed' and hold then cur
              when cur = 'pending' and st = 'passed' then 'proving'
              when cur = 'pending' and st = 'failed' then 'rejected'
              else cur end;
  perform set_config('meshground.skip_review_stamp', '1', true);
  if nxt <> cur then update public.games set stage = nxt where public.games.id = p_game_id; end if;
  return query select nxt;
end;
$$;

revoke all on function public.apply_stored_validation(text, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_stored_validation(text, text, boolean) to service_role;

-- A human stage write is the review. Table-editor updates of stage to a public stage
-- (proving or live), including setting the same stage again, stamp reviewed_at.
-- So does a human rejection. record_game_validation sets meshground.skip_review_stamp
-- so an automatic pass or fail does not.
-- Graduation sets stage to live on purpose, and this stamp moves with it: assets
-- already public (updated_at <= reviewed_at) stay servable. An upload demotes a
-- proving game to pending first, so graduation cannot publish a file that has not
-- been reviewed.
create or replace function public.touch_game_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('meshground.skip_review_stamp', true) = '1' then
    return new;
  end if;
  if new.stage in ('proving', 'live') or (new.stage = 'rejected' and old.stage is distinct from 'rejected') then
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.touch_game_review() from public, anon, authenticated;

drop trigger if exists games_touch_review on public.games;
create trigger games_touch_review
  before update of stage on public.games
  for each row execute function public.touch_game_review();

-- Queue for the table editor. security_invoker so a caller cannot bypass RLS on games.
-- Studio connects as postgres and can read it. anon, authenticated, and public cannot.
-- Pending only: a passed game waiting for its first review, or a reviewed game sent back
-- to pending (an asset change). A still-public game is not queued. Bundles are not pinned.
create or replace view public.games_awaiting_review
with (security_invoker = true) as
select
  g.id,
  g.slug,
  g.title,
  g.creator as handle,
  g.created_at,
  ('/play/' || g.slug) as preview_link
from public.games g
where g.stage = 'pending'
  and (
    g.reviewed_at is not null
    or exists (
      select 1 from public.game_validations v
      where v.game_id = g.id and v.status = 'passed'
    )
  );

revoke all on table public.games_awaiting_review from public, anon, authenticated;
