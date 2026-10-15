-- IS-1: which input a game supports. 'unknown' until a declaration or the static check (IS-2) says otherwise.
alter table public.games
  add column if not exists input_support text not null default 'unknown';

alter table public.games drop constraint if exists games_input_support_check;
alter table public.games
  add constraint games_input_support_check check (input_support in ('mobile', 'desktop', 'both', 'unknown'));
