create table public.session_admissions (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('uid', 'ip')),
  subject text not null,
  game_id text not null references public.games (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index session_admissions_window_idx
  on public.session_admissions (kind, subject, game_id, created_at);
create index session_admissions_created_idx on public.session_admissions (created_at);
alter table public.session_admissions enable row level security;
revoke all on public.session_admissions from anon, authenticated;
comment on column public.session_admissions.subject is
  'Device uid, or daily-rotating HMAC-SHA256(ip). Never a raw IP address.';
