-- RT-2 (expand step): tie ratings to real accounts and record when they changed.
--   user_id  -> auth.users; nullable during expand, the app now writes it alongside voter.
--               A later contract migration can make it NOT NULL and move the PK to (game_id, user_id).
--   updated_at -> last time the stars changed (created_at now keeps the first-rated time).
--   counted  -> whether this rating counts toward graduation. RT-3 sets it false for accounts
--               younger than 24h and for raters without a real >=30s play.
alter table public.ratings
  add column user_id uuid references auth.users (id) on delete cascade,
  add column updated_at timestamptz not null default now(),
  add column counted boolean not null default true;

update public.ratings set updated_at = created_at;

-- Backfill: today voter is the auth user id as text.
update public.ratings r
   set user_id = u.id
  from auth.users u
 where r.voter ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and u.id = r.voter::uuid;

create index ratings_user_idx on public.ratings (user_id);
create index ratings_game_counted_idx on public.ratings (game_id) where counted;

-- Same pattern as the other tables: RLS on, no policies, no API grants.
alter table public.ratings enable row level security;
revoke all on table public.ratings from anon, authenticated;
