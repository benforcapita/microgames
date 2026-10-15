-- SP-5b one-off cleanup for hosted rows already written before this deploy.
-- DO NOT run this from CI, from a laptop agent, or as part of `supabase db reset`.
-- Ben runs it once, by hand, on hosted Supabase after reviewing the preview count.
--
-- Deletes a queued placeholder only when a later real verdict (passed, failed,
-- or error) exists for the same game. A queued row that is newer than every
-- verdict is left alone. A game that has any running row is left alone.

begin;

select count(*) as queued_rows_to_delete
from public.game_validations q
where q.status = 'queued'
  and q.bundle_sha256 is null
  and exists (
    select 1
    from public.game_validations real
    where real.game_id = q.game_id
      and real.id <> q.id
      and real.status in ('passed', 'failed', 'error')
      and real.created_at > q.created_at
  )
  and not exists (
    select 1
    from public.game_validations running
    where running.game_id = q.game_id
      and running.status = 'running'
  );

delete from public.game_validations q
where q.status = 'queued'
  and q.bundle_sha256 is null
  and exists (
    select 1
    from public.game_validations real
    where real.game_id = q.game_id
      and real.id <> q.id
      and real.status in ('passed', 'failed', 'error')
      and real.created_at > q.created_at
  )
  and not exists (
    select 1
    from public.game_validations running
    where running.game_id = q.game_id
      and running.status = 'running'
  );

-- Any queued placeholder that is still the only row must not keep a fake pass.
update public.game_validations
set static_report = jsonb_build_object('status', 'queued')
where status = 'queued'
  and bundle_sha256 is null
  and static_report->>'status' in ('pass', 'fail', 'passed', 'failed', 'warn');

commit;
