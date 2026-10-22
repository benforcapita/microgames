drop function public.create_preview_link(uuid);

create function public.create_preview_link(p_version_id uuid, p_ttl_hours integer default 168)
returns table (id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_token text;
  v_expires timestamptz;
  v_id uuid;
  v_active integer;
  v_hour integer;
begin
  if v_uid is null then
    raise exception 'preview_link_denied' using errcode = '42501';
  end if;

  select g.owner_id into v_owner
    from public.game_validations as gv
    join public.games as g on g.id = gv.game_id
   where gv.id = p_version_id;
  if v_owner is distinct from v_uid then
    raise exception 'preview_link_denied' using errcode = '42501';
  end if;

  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'preview_link_ttl' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('preview_link:' || v_uid::text, 0)
  );

  select count(*)::integer into v_active
    from public.preview_links as l
   where l.owner_id = v_uid
     and l.revoked_at is null
     and l.expires_at > pg_catalog.now();
  if v_active >= 5 then
    raise exception 'preview_link_cap' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_hour
    from public.preview_links as l
   where l.owner_id = v_uid
     and l.created_at > pg_catalog.now() - interval '1 hour';
  if v_hour >= 10 then
    raise exception 'preview_link_hour' using errcode = 'P0001';
  end if;

  v_token := rtrim(translate(pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  v_expires := pg_catalog.now() + pg_catalog.make_interval(hours => p_ttl_hours);
  insert into public.preview_links as l (version_id, owner_id, token_hash, expires_at)
  values (p_version_id, v_uid, extensions.digest(v_token, 'sha256'), v_expires)
  returning l.id into v_id;
  return query select v_id, v_token, v_expires;
end;
$$;

revoke all on function public.create_preview_link(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.create_preview_link(uuid, integer) to authenticated;
