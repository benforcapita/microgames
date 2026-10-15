-- SP-5b one-off cleanup for hosted rows already written before this deploy.
-- DO NOT run this from CI, from a laptop agent, or as part of `supabase db reset`.
-- Ben runs it once, by hand, on hosted Supabase after reviewing the preview select.
--
-- Preview (expect the stale SP-5 placeholders, status queued, no bundle hash,
-- sitting beside EF-1's real row):
--
-- select q.id, q.game_id, q.version, q.status, q.static_report
-- from public.game_validations q
-- where q.status = 'queued'
--   and q.bundle_sha256 is null
--   and exists (
--     select 1 from public.game_validations real
--     where real.game_id = q.game_id
--       and real.id <> q.id
--       and real.status <> 'queued'
--   );

delete from public.game_validations q
where q.status = 'queued'
  and q.bundle_sha256 is null
  and exists (
    select 1
    from public.game_validations real
    where real.game_id = q.game_id
      and real.id <> q.id
      and real.status <> 'queued'
  );

-- Any queued placeholder that is still the only row must not keep a fake pass.
update public.game_validations
set static_report = jsonb_build_object('status', 'queued')
where status = 'queued'
  and bundle_sha256 is null
  and static_report->>'status' in ('pass', 'fail', 'passed', 'failed', 'warn');
