create table public.preview_page_hits (
  id bigint generated always as identity primary key,
  subject text not null,
  created_at timestamptz not null default now()
);

create index preview_page_hits_window_idx on public.preview_page_hits (subject, created_at);

alter table public.preview_page_hits enable row level security;

revoke all on public.preview_page_hits from public, anon, authenticated;
revoke all on sequence public.preview_page_hits_id_seq from public, anon, authenticated;
