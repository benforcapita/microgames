-- AD-1: admin role. profiles.role gates /admin (analytics + the manual-review queue) in the
-- portal. Nothing here changes RLS: the table stays server-only. Grant in the SQL editor:
--   update public.profiles set role = 'admin' where handle = '<handle>';
-- or locally with `npm run admin:grant -- <handle>`.

alter table public.profiles
  add column if not exists role text not null default 'user';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'admin'));
