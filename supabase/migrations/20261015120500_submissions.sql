-- SP-3 (Features v2 §3): submission pipeline stages + validation reports.
-- Additive and backward compatible: existing rows are 'proving'/'live'; the column default stays 'proving'
-- until SP-5 switches uploads to 'pending'. Ben's rule: a game that passes validation auto-publishes
-- (pending -> proving); a failing one becomes 'rejected'. No human moderation step, no Publish button.

alter table public.games drop constraint games_stage_check;
alter table public.games add constraint games_stage_check check (stage in ('pending', 'proving', 'live', 'rejected'));

create table public.game_validations (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references public.games (id) on delete cascade,
  version int not null default 1,
  -- sha256 of the bundle that was checked: lets the validator be idempotent (same bundle -> same row).
  bundle_sha256 text check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('queued', 'running', 'passed', 'failed', 'error')),
  static_report jsonb not null default '{}',
  run_report jsonb,
  screenshot_paths text[] not null default '{}',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index game_validations_game_idx on public.game_validations (game_id, created_at desc);
create unique index game_validations_bundle_key on public.game_validations (game_id, bundle_sha256) where bundle_sha256 is not null;

-- Same posture as every Meshgrounds table: server-only, RLS on with no policies, hidden from the Data API.
alter table public.game_validations enable row level security;
revoke all on table public.game_validations from anon, authenticated;
