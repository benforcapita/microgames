-- Meshgrounds tables are server-only (RLS on, no policies). Also hide them from the PostgREST / GraphQL
-- schema for anon + authenticated (advisor lints 0026/0027). Only touches Meshgrounds tables.
revoke all on table public.profiles, public.games, public.sessions, public.ratings, public.saves from anon, authenticated;
