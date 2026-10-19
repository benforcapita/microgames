-- MCP-1: personal API tokens for the Meshground MCP server (/me#mcp). Only the SHA-256 of a
-- token is stored; the plaintext is shown once at creation. Same posture as every Meshground
-- table: server-only, RLS on with no policies, hidden from the Data API.

create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists api_tokens_user_idx on public.api_tokens (user_id, created_at desc);

alter table public.api_tokens enable row level security;
revoke all on table public.api_tokens from anon, authenticated;
