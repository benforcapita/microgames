create table public.game_assets (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references public.games (id) on delete cascade,
  version int not null default 1,
  path text not null check (char_length(path) between 1 and 512 and path !~ '(^/|\.\.|\\)'),
  expected_type text not null check (expected_type in ('image','audio','font','json','text')),
  status text not null default 'missing' check (status in ('missing','uploaded','rejected')),
  size_bytes int check (size_bytes >= 0 and size_bytes <= 4194304),
  content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source text not null default 'scan' check (source in ('scan','creator')),
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, version, path)
);
create index game_assets_game_idx on public.game_assets (game_id, version);
alter table public.game_assets enable row level security;
revoke all on public.game_assets from anon, authenticated;