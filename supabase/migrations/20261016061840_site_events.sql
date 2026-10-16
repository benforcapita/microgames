-- Applied with Ben's OK (2026-10-16).
-- 1) Table: server-only, RLS on, no policies, no anon/authenticated grants. No IPs, no emails.
create table public.site_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event_type text not null check (event_type in ('page_view','game_launch','sign_up','error','upload')),
  user_id uuid references auth.users (id) on delete set null,
  game_id text references public.games (id) on delete set null,
  path text check (char_length(path) <= 512),
  details jsonb not null default '{}' check (pg_column_size(details) <= 4096)
);
create index site_events_time_idx on public.site_events (created_at desc);
create index site_events_type_time_idx on public.site_events (event_type, created_at desc);
alter table public.site_events enable row level security;
revoke all on public.site_events from anon, authenticated;

create table public.site_events_daily (
  day date not null,
  event_type text not null,
  game_id text not null default '',
  events bigint not null,
  users bigint not null,
  primary key (day, event_type, game_id)  -- game_id coalesced to '' below
);
alter table public.site_events_daily enable row level security;
revoke all on public.site_events_daily from anon, authenticated;

-- 2) Triggers: sign-ups (new profile) and upload results (validation finished).
create or replace function private.log_sign_up() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.site_events (event_type, user_id, details)
  values ('sign_up', new.id, '{}');
  return new;
exception when others then return new;  -- logging never blocks a sign-up
end $$;
create trigger site_events_sign_up after insert on public.profiles
  for each row execute function private.log_sign_up();

create or replace function private.log_upload_result() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('passed','failed','error') and old.status is distinct from new.status then
    insert into public.site_events (event_type, game_id, details)
    values ('upload', new.game_id,
      jsonb_build_object('status', new.status, 'version', new.version));
  end if;
  return new;
exception when others then return new;
end $$;
create trigger site_events_upload after update of status on public.game_validations
  for each row execute function private.log_upload_result();

-- 3) Nightly cleanup (pg_cron, free on Supabase): roll up yesterday, delete raw rows > 90 days.
create or replace function private.rollup_and_prune_site_events() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.site_events_daily (day, event_type, game_id, events, users)
  select created_at::date, event_type, coalesce(game_id,''), count(*), count(distinct user_id)
  from public.site_events
  where created_at >= current_date - 1 and created_at < current_date
  group by 1,2,3
  on conflict (day, event_type, game_id) do update
    set events = excluded.events, users = excluded.users;
  delete from public.site_events where created_at < now() - interval '90 days';
end $$;
select cron.schedule('site-events-nightly', '15 0 * * *',
  $$select private.rollup_and_prune_site_events()$$);  -- 00:15 UTC = 03:15 Israel
