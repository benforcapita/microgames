create table public.preview_link_audit (
  event text not null,
  link_id uuid not null references public.preview_links (id) on delete cascade,
  actor uuid not null,
  at timestamptz not null default pg_catalog.now(),
  constraint preview_link_audit_event_chk check (event in ('created', 'revoked', 'expired_hit')),
  primary key (link_id, event)
);

create index preview_link_audit_actor_idx on public.preview_link_audit (actor, at desc);

alter table public.preview_link_audit enable row level security;

revoke all on table public.preview_link_audit from public, anon, authenticated, service_role;
grant select on table public.preview_link_audit to authenticated;

create policy preview_link_audit_owner_select
  on public.preview_link_audit
  for select
  to authenticated
  using (actor = (select auth.uid()));

create function private.preview_link_audit(p_event text, p_link_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.preview_link_audit (event, link_id, actor)
  select p_event, l.id, l.owner_id
    from public.preview_links as l
   where l.id = p_link_id
  on conflict (link_id, event) do nothing;
end;
$$;

revoke all on function private.preview_link_audit(text, uuid) from public, anon, authenticated, service_role;

create function private.preview_link_audit_from_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.preview_link_audit('created', new.id);
  elsif tg_op = 'UPDATE' and old.revoked_at is null and new.revoked_at is not null then
    perform private.preview_link_audit('revoked', new.id);
  end if;
  return new;
end;
$$;

revoke all on function private.preview_link_audit_from_link() from public, anon, authenticated, service_role;

create trigger preview_links_audit_row
  after insert or update of revoked_at on public.preview_links
  for each row
  execute function private.preview_link_audit_from_link();

create or replace function public.resolve_preview_link(p_token text)
returns table (version_id uuid, html_path text, title text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea := extensions.digest(p_token, 'sha256');
  v_id uuid;
begin
  select l.id into v_id
    from public.preview_links as l
   where l.token_hash = v_hash
     and l.expires_at <= pg_catalog.now();
  if found then
    perform private.preview_link_audit('expired_hit', v_id);
    return;
  end if;

  return query
  update public.preview_links as l
     set view_count = l.view_count + 1
    from public.game_validations as gv
    join public.games as g on g.id = gv.game_id
   where l.token_hash = v_hash
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

revoke all on function public.resolve_preview_link(text) from public, anon, authenticated, service_role;
grant execute on function public.resolve_preview_link(text) to anon, authenticated;
