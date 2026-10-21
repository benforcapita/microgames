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
grant select on table public.preview_links to authenticated;

create policy preview_links_owner_select
  on public.preview_links
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

create function public.create_preview_link(
  p_version_id uuid,
  p_ttl interval default interval '7 days'
)
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
begin
  if v_uid is null then
    raise exception 'preview_link_denied' using errcode = '42501';
  end if;
  if p_ttl is null or p_ttl <= interval '0' then
    raise exception 'preview_link_ttl' using errcode = '22023';
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

  v_token := rtrim(translate(pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  v_expires := pg_catalog.now() + p_ttl;
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
     and gv.status is distinct from 'failed'
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

revoke all on function public.create_preview_link(uuid, interval) from public, anon, authenticated, service_role;
revoke all on function public.revoke_preview_link(uuid) from public, anon, authenticated, service_role;
revoke all on function public.resolve_preview_link(text) from public, anon, authenticated, service_role;
grant execute on function public.create_preview_link(uuid, interval) to authenticated;
grant execute on function public.revoke_preview_link(uuid) to authenticated;
grant execute on function public.resolve_preview_link(text) to anon, authenticated;
