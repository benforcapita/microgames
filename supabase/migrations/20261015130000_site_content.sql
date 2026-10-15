-- CM-1: editable site copy and featured games, managed in the Supabase table editor.
-- Server-only like every Meshgrounds table: RLS on, no policies, no anon/authenticated grants.
-- The portal reads through the server (service-role) client; see docs/CONTENT.md for keys and shapes.

create table public.site_content (
  key text not null,
  locale text not null default 'en',
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (key, locale)
);

create or replace function public.site_content_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger site_content_updated_at
  before update on public.site_content
  for each row execute function public.site_content_touch_updated_at();

create table public.featured_games (
  game_id text primary key references public.games (id) on delete cascade,
  position int not null,
  label text,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index featured_games_position_idx on public.featured_games (position);

alter table public.site_content enable row level security;
alter table public.featured_games enable row level security;
revoke all on table public.site_content, public.featured_games from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on function public.site_content_touch_updated_at() from public, anon, authenticated;

-- Public bucket for images referenced from site_content (banner art etc.). Reads are public by
-- bucket setting; there are deliberately no storage.objects policies, so only the service role
-- (dashboard / server) can write.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-media', 'site-media', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'])
on conflict (id) do nothing;
