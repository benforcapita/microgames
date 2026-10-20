create table public.categories (
  slug text primary key check (slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  description text not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'retired')),
  is_safety boolean not null default false,
  confirm_threshold numeric not null default 0.85 check (confirm_threshold between 0 and 1),
  reject_threshold numeric not null default 0.15 check (reject_threshold between 0 and 1),
  created_at timestamptz not null default now(),
  check (reject_threshold < confirm_threshold)
);

create table public.game_tags (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references public.games (id) on delete cascade,
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  category_slug text not null references public.categories (slug),
  status text not null check (status in ('confirmed', 'rejected', 'needs_review', 'appealed', 'overridden')),
  applies boolean,
  confidence numeric check (confidence between 0 and 1),
  model text,
  version text,
  evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, bundle_sha256, category_slug),
  check (
    (status = 'confirmed' and applies is true)
    or (status = 'rejected' and applies is false)
    or (status = 'needs_review' and applies is null)
    or (status = 'appealed' and applies is not null)
    or (status = 'overridden' and applies is not null)
  )
);

alter table public.categories enable row level security;
alter table public.game_tags enable row level security;
revoke all on table public.categories, public.game_tags from anon, authenticated;

insert into public.categories (slug, description, status, is_safety, confirm_threshold, reject_threshold) values
  ('nsfw', 'sexual content or nudity, graphic gore, or strong sexual themes', 'approved', true, 0.80, 0.05),
  ('kid_safe', 'suitable for ages 7+, with no realistic violence, gore, sexual content, gambling or profanity, and no open chat with strangers', 'approved', true, 0.95, 0.20);
