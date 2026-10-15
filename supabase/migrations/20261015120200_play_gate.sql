-- PG-3: attribute a play session to the signed-in user, and store play-gate events.
-- The free-game limit is a soft httpOnly cookie. This schema stores no IP addresses.
-- Same posture as 20261015000000_init.sql and 20261015000100_revoke_api_grants.sql:
-- RLS enabled, no policies, no grants for anon or authenticated. All access is via the server.

alter table public.sessions
  add column if not exists user_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sessions'::regclass
      and conname = 'sessions_user_id_fkey'
  ) then
    alter table public.sessions
      add constraint sessions_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete set null;
  end if;
end $$;

comment on column public.sessions.user_id is
  'Auth user at session_start. Null when the play was anonymous.';

create table if not exists public.gate_events (
  id bigserial primary key,
  game_id text references public.games (id) on delete cascade,
  kind text not null check (kind in ('shown', 'signup_click', 'login_click', 'converted')),
  created_at timestamptz not null default now()
);

-- Cover the new foreign keys. Existing unindexed FKs (games.forked_from, saves.game_id) are unchanged.
create index if not exists sessions_user_id_idx on public.sessions (user_id);
create index if not exists gate_events_game_id_idx on public.gate_events (game_id);

alter table public.sessions enable row level security;
alter table public.gate_events enable row level security;

revoke all on table public.sessions from anon, authenticated;
revoke all on table public.gate_events from anon, authenticated;

do $$
declare
  seq regclass;
begin
  seq := pg_get_serial_sequence('public.gate_events', 'id')::regclass;
  if seq is not null then
    execute format('revoke all on sequence %s from anon, authenticated', seq);
  end if;
end $$;
