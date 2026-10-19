-- MGA-1 / AD-1: the admin app reaches the database only through the meshgrounds_admin
-- role, every admin change lands in the append-only admin_actions audit table, and
-- admin_auth_failures is the shared lockout counter for admin sign-in (LLD Rev 2 §8).
-- Not applied to hosted Supabase by an agent; Ben applies it after approving AD-1.
-- This file is safe to apply more than once (guards below).

-- §8.1 audit. before/after hold only the changed games columns from the admin
-- allowlist (stage, review_note, reviewed_at, graduated_at, title, slug, tagline,
-- tags); the writer builds them. No request data, IPs, user agents or emails.
create table if not exists public.admin_actions (
  id         bigint generated always as identity primary key,
  action     text not null check (action in ('approve','reject','go_live','unlist','edit_metadata')),
  game_id    text not null,          -- no FK: the audit row must outlive a deleted game
  before     jsonb not null check (pg_column_size(before) <= 8192),
  after      jsonb not null check (pg_column_size(after)  <= 8192),
  created_at timestamptz not null default now()
);
create index if not exists admin_actions_game_idx on public.admin_actions (game_id, created_at desc);
create index if not exists admin_actions_time_idx on public.admin_actions (created_at desc);
alter table public.admin_actions enable row level security;
revoke all on public.admin_actions from public, anon, authenticated;

-- §8.3 lockout state: an id and a time only. No username, IP or user agent.
-- Locked = 5 or more rows newer than 15 minutes; a success deletes all rows and each
-- failure deletes rows older than 1 hour (the admin app does that, not this file).
create table if not exists public.admin_auth_failures (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);
alter table public.admin_auth_failures enable row level security;
revoke all on public.admin_auth_failures from public, anon, authenticated;

-- §8.2 the role. Postgres has no CREATE ROLE IF NOT EXISTS; the pg_roles guard makes
-- this file re-runnable. NOLOGIN and no password: Ben enables LOGIN and sets the
-- password in AD-7.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'meshgrounds_admin') then
    create role meshgrounds_admin nologin noinherit nobypassrls nosuperuser nocreatedb nocreaterole
      connection limit 10;
  end if;
end
$$;

alter role meshgrounds_admin set statement_timeout = '5s';
alter role meshgrounds_admin set search_path = public;

grant usage on schema public to meshgrounds_admin;

grant select on public.games, public.games_awaiting_review, public.sessions, public.ratings,
                public.site_events, public.game_validations, public.game_assets
  to meshgrounds_admin;
grant select (id, created_at) on public.profiles to meshgrounds_admin;
grant update (stage, review_note, reviewed_at, graduated_at, title, slug, tagline, tags)
  on public.games to meshgrounds_admin;
grant select, insert on public.admin_actions to meshgrounds_admin;
grant select, insert, delete on public.admin_auth_failures to meshgrounds_admin;

-- Every Meshgrounds table has RLS on with no policies, so the grants above would still
-- return zero rows. These policies, scoped to meshgrounds_admin only, open exactly the
-- listed reads, the allowlisted games update, and the audit/lockout appends.
drop policy if exists admin_read on public.games;
create policy admin_read on public.games            for select to meshgrounds_admin using (true);
drop policy if exists admin_write on public.games;
create policy admin_write on public.games           for update to meshgrounds_admin using (true) with check (true);
drop policy if exists admin_read on public.sessions;
create policy admin_read on public.sessions         for select to meshgrounds_admin using (true);
drop policy if exists admin_read on public.ratings;
create policy admin_read on public.ratings          for select to meshgrounds_admin using (true);
drop policy if exists admin_read on public.site_events;
create policy admin_read on public.site_events      for select to meshgrounds_admin using (true);
drop policy if exists admin_read on public.profiles;
create policy admin_read on public.profiles         for select to meshgrounds_admin using (true);
drop policy if exists admin_read on public.game_validations;
create policy admin_read on public.game_validations for select to meshgrounds_admin using (true);
drop policy if exists admin_read on public.game_assets;
create policy admin_read on public.game_assets      for select to meshgrounds_admin using (true);
drop policy if exists admin_read on public.admin_actions;
create policy admin_read on public.admin_actions    for select to meshgrounds_admin using (true);
drop policy if exists admin_insert on public.admin_actions;
create policy admin_insert on public.admin_actions  for insert to meshgrounds_admin with check (true);
drop policy if exists admin_all on public.admin_auth_failures;
create policy admin_all on public.admin_auth_failures for all to meshgrounds_admin using (true) with check (true);

-- Nothing else: no grants on auth, private, storage, saves, site_content, or any
-- function. The games_touch_review trigger is security definer and keeps stamping
-- reviewed_at when this role moves a game to proving or live.
