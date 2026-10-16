-- LG-2: site_events logs only errors (things that could break the site) and never tracks users.
-- Not applied to hosted by this PR; apply only with Ben's OK.
--
-- DECISION: the sign_up and upload triggers from 20261016061840_site_events.sql insert
-- 'sign_up' / 'upload' rows (with user ids). An 'error'-only check would make every such insert fail.
-- Both triggers swallow errors, but we do not rely on that: they are user tracking, so they are
-- dropped (with their functions) BEFORE the check is tightened. Sign-up and uploads no longer touch site_events.

drop trigger if exists site_events_sign_up on public.profiles;
drop trigger if exists site_events_upload on public.game_validations;
drop function if exists private.log_sign_up();
drop function if exists private.log_upload_result();

-- Remove everything that is not an error, and unlink errors from users.
delete from public.site_events where event_type <> 'error';
update public.site_events set user_id = null where user_id is not null;
delete from public.site_events_daily where event_type <> 'error';
update public.site_events_daily set users = 0 where users <> 0;

alter table public.site_events drop constraint if exists site_events_event_type_check;
alter table public.site_events add constraint site_events_event_type_check check (event_type = 'error');
-- Errors are never tied to a user.
alter table public.site_events add constraint site_events_no_user check (user_id is null);
