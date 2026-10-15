-- Meshgrounds core schema.
-- All application access goes through the Astro server (postgres role / service role), so every
-- table has RLS enabled with no policies: the public PostgREST API cannot read or write anything.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text not null check (handle ~ '^[A-Za-z0-9_-]{2,32}$'),
  created_at timestamptz not null default now()
);
create unique index profiles_handle_key on public.profiles (lower(handle));

create table public.games (
  id text primary key,
  slug text not null unique,
  owner_id uuid references public.profiles (id) on delete cascade,
  creator text not null,
  title text not null,
  tagline text not null default '',
  description text not null default '',
  tags text[] not null default '{}',
  license text not null default 'MIT',
  stage text not null default 'proving' check (stage in ('proving', 'live')),
  forked_from text references public.games (id) on delete set null,
  size_bytes integer not null default 0,
  hue integer not null default 200,
  thumb text,
  created_at timestamptz not null default now(),
  graduated_at timestamptz
);
create index games_stage_idx on public.games (stage, created_at desc);
create index games_owner_idx on public.games (owner_id);
create index games_creator_idx on public.games (creator);
create index games_tags_idx on public.games using gin (tags);

create table public.sessions (
  id uuid primary key,
  game_id text not null references public.games (id) on delete cascade,
  created_at timestamptz not null default now(),
  first_frame_ms integer,
  started boolean not null default false,
  completed boolean not null default false,
  crashed boolean not null default false,
  duration_ms integer not null default 0
);
create index sessions_game_idx on public.sessions (game_id);

create table public.ratings (
  game_id text not null references public.games (id) on delete cascade,
  voter text not null,
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (game_id, voter)
);

create table public.saves (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id text not null references public.games (id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.sessions enable row level security;
alter table public.ratings enable row level security;
alter table public.saves enable row level security;

-- Private bucket for game bundles; served only through the sandboxed game CDN.
insert into storage.buckets (id, name, public, file_size_limit)
values ('games', 'games', false, 5242880)
on conflict (id) do nothing;
