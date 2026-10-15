-- Restate private.dispatch_validate_game from the current main body
-- (20261015120800 after EF-2 #37). That file was edited in place; this version
-- sorts later so a database that already applied the pre-#37 body still
-- receives the warning wording. Do not edit 20261015120800.
--
-- Missing validate_game_url warns that the setting is not set. A whitespace-only
-- value warns that it is blank. Signature, security definer, search_path, and
-- grants match the current function. Sorts after 20261015160000 (open PR #43,
-- which replaces record_game_validation and does not touch this function).
-- Do not apply this file to hosted Supabase from a laptop or an agent.

create or replace function private.dispatch_validate_game(p_game_id text, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
  v_known_default constant text := 'local-dev-validate-game';
begin
  select value into v_url from private.settings where key = 'validate_game_url';
  if v_url is null then
    raise warning 'validate-game dispatch skipped for %: private.settings validate_game_url is not set', p_game_id;
    return null;
  end if;
  if length(btrim(v_url)) = 0 then
    raise warning 'validate-game dispatch skipped for %: private.settings validate_game_url is blank (empty or whitespace only)', p_game_id;
    return null;
  end if;

  -- Read on every dispatch. Rotate without redeploying: vault.update_secret
  -- on validate_game_hook_secret, and set EF-1's VALIDATE_GAME_HOOK_SECRET to
  -- the same value. The next call picks up the new secret.
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'validate_game_hook_secret'
  limit 1;

  if v_secret is null or length(btrim(v_secret)) = 0 then
    raise warning 'validate-game dispatch skipped for %: vault secret validate_game_hook_secret is missing', p_game_id;
    return null;
  end if;

  if btrim(v_secret) = v_known_default then
    raise warning 'validate-game dispatch skipped for %: vault secret validate_game_hook_secret is the known default', p_game_id;
    return null;
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise warning 'validate-game dispatch skipped for %: shared pg_net extension is not installed', p_game_id;
    return null;
  end if;

  -- EF-1 reads camelCase gameId. The hook header is the Vault secret, not a service-role key.
  select net.http_post(
    url := v_url,
    body := jsonb_build_object('gameId', p_game_id, 'reason', p_reason),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-meshgrounds-hook', v_secret
    ),
    timeout_milliseconds := 5000
  ) into v_request_id;

  insert into private.validation_dispatch as d (game_id, attempts, last_dispatched_at, last_request_id, last_reason)
  values (p_game_id, 1, now(), v_request_id, p_reason)
  on conflict (game_id) do update
    set attempts = d.attempts + 1,
        last_dispatched_at = now(),
        last_request_id = excluded.last_request_id,
        last_reason = excluded.last_reason;

  return v_request_id;
exception
  when others then
    raise warning 'validate-game dispatch failed for %: %', p_game_id, sqlerrm;
    return null;
end;
$$;

revoke all on function private.dispatch_validate_game(text, text) from public, anon, authenticated;
grant execute on function private.dispatch_validate_game(text, text) to postgres, service_role;
