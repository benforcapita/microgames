create table public.preview_links (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.game_validations (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  view_count int not null default 0,
  created_at timestamptz not null default now(),
  constraint preview_links_token_hash_len check (octet_length(token_hash) = 32),
  constraint preview_links_view_count_nonneg check (view_count >= 0)
);

create index preview_links_owner_idx on public.preview_links (owner_id);
create index preview_links_version_idx on public.preview_links (version_id);

alter table public.preview_links enable row level security;

revoke all on table public.preview_links from public, anon, authenticated, service_role;
grant select (
  id,
  version_id,
  owner_id,
  expires_at,
  revoked_at,
  view_count,
  created_at
) on table public.preview_links to authenticated;

create policy preview_links_owner_select
  on public.preview_links
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

create function public.create_preview_link(p_version_id uuid)
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
  v_expires := pg_catalog.now() + interval '7 days';
  insert into public.preview_links as l (version_id, owner_id, token_hash, expires_at)
  values (p_version_id, v_uid, extensions.digest(v_token, 'sha256'), v_expires)
  returning l.id into v_id;
  return query select v_id, v_token, v_expires;
end;
$$;

create function public.revoke_preview_link(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'preview_link_denied' using errcode = '42501';
  end if;
  update public.preview_links as l
     set revoked_at = coalesce(l.revoked_at, pg_catalog.now())
   where l.id = p_id
     and l.owner_id = v_uid;
  if not found then
    raise exception 'preview_link_denied' using errcode = '42501';
  end if;
end;
$$;

alter table public.admin_actions drop constraint admin_actions_action_check;
alter table public.admin_actions add constraint admin_actions_action_check
  check (action in ('approve', 'reject', 'go_live', 'unlist', 'edit_metadata', 'revoke_preview'));

create function public.admin_revoke_preview_link(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_game_id text;
  v_revoked timestamptz;
begin
  if v_uid is null then
    raise exception 'preview_link_denied' using errcode = '42501';
  end if;
  select p.role into v_role
    from public.profiles as p
   where p.id = v_uid;
  if v_role is distinct from 'admin' then
    raise exception 'preview_link_denied' using errcode = '42501';
  end if;
  select gv.game_id, l.revoked_at into v_game_id, v_revoked
    from public.preview_links as l
    join public.game_validations as gv on gv.id = l.version_id
   where l.id = p_id
   for update of l;
  if not found then
    raise exception 'preview_link_denied' using errcode = '42501';
  end if;
  if v_revoked is not null then
    return;
  end if;
  update public.preview_links as l
     set revoked_at = pg_catalog.now()
   where l.id = p_id
  returning l.revoked_at into v_revoked;
  insert into public.admin_actions (action, game_id, before, after)
  values (
    'revoke_preview',
    v_game_id,
    pg_catalog.jsonb_build_object('preview_link_id', p_id, 'revoked_at', null),
    pg_catalog.jsonb_build_object('preview_link_id', p_id, 'revoked_at', v_revoked)
  );
end;
$$;

create function public.resolve_preview_link(p_token text)
returns table (version_id uuid, html_path text, title text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.preview_links as l
     set view_count = l.view_count + 1
    from public.game_validations as gv
    join public.games as g on g.id = gv.game_id
   where l.token_hash = extensions.digest(p_token, 'sha256')
     and l.version_id = gv.id
     and l.revoked_at is null
     and l.expires_at > pg_catalog.now()
     and gv.status = 'passed'
     and g.stage is distinct from 'rejected'
     and not exists (
       select 1
         from public.game_tags as t
        where t.game_id = g.id
          and t.bundle_sha256 = gv.bundle_sha256
          and t.category_slug = 'nsfw'
          and t.status = 'confirmed'
     )
  returning gv.id, g.id || '/' || gv.version::text || '/index.html', g.title;
end;
$$;

revoke all on function public.create_preview_link(uuid) from public, anon, authenticated, service_role;
revoke all on function public.revoke_preview_link(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_revoke_preview_link(uuid) from public, anon, authenticated, service_role;
revoke all on function public.resolve_preview_link(text) from public, anon, authenticated, service_role;
grant execute on function public.create_preview_link(uuid) to authenticated;
grant execute on function public.revoke_preview_link(uuid) to authenticated;
grant execute on function public.admin_revoke_preview_link(uuid) to authenticated;
grant execute on function public.resolve_preview_link(text) to anon, authenticated;
