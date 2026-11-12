-- 20270622000000_quotation_versions.sql
--
-- Quotation versions (owner approved 2026-11-12, ~21:15 IST).
--
-- A VERSION is a frozen copy of the quotation exactly as the client received it: the client-facing document
-- (quotation_client_doc: header, room types and products with prices; never internal notes) plus its value before
-- GST. v1 is made automatically when the client link is first turned on; after that the salesperson sends a new
-- version with a short note (quotation_version_create). Versions are never changed or deleted (append-only trigger).
--
-- THE CLIENT LINK SHOWS THE LATEST SENT VERSION (owner, 2026-11-12), not the latest save, so a half-finished edit
-- never reaches the client; its issue date (and so its validity) is the date that version was sent. A quotation shared
-- before this migration has no version: its link keeps showing the saved copy until the next version is sent.
--
-- A new version is refused when nothing changed since the last one, when the link is off, and when the prices still
-- wait for the pricing desk (as turning the link on is, 20270617000000).
--
-- ROLLBACK: drop functions quotation_version_create, quotation_versions, quotation_version_get, quotation_client_doc;
-- re-create quotation_share (20270617000000) and quotation_public (20270614000000); drop table quotation_versions;
-- restore quotation_events_kind_check without 'version' (after removing 'version' events with the trigger disabled).

create table public.quotation_versions (
  id               uuid primary key default gen_random_uuid(),
  quotation_id     uuid not null references public.quotations(id) on delete cascade,
  version_no       integer not null check (version_no >= 1),
  doc              jsonb not null,
  value_before_gst bigint not null,
  note             text check (char_length(note) <= 300),
  created_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  unique (quotation_id, version_no)
);
alter table public.quotation_versions enable row level security;
revoke all on public.quotation_versions from anon, authenticated;

create or replace function public.quotation_versions_append_only()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  raise exception 'QUOTATION_VERSIONS_APPEND_ONLY';
end $$;
create trigger quotation_versions_append_only before update or delete on public.quotation_versions
  -- Depth 0 only: a direct change is refused, the cascade from deleting a whole quotation is not.
  for each row when (pg_trigger_depth() = 0)
  execute function public.quotation_versions_append_only();

alter table public.quotation_events drop constraint quotation_events_kind_check;
alter table public.quotation_events add constraint quotation_events_kind_check
  check (kind in ('created', 'saved', 'status', 'shared', 'unshared', 'opened', 'converted', 'price', 'version'));

-- What the client sees of a quotation, as it is saved now (the same fields quotation_public always returned).
create or replace function public.quotation_client_doc(p_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'client_name', q.client_name, 'project_name', q.project_name, 'contact_name', q.contact_name, 'gst_mode', q.gst_mode,
    'discount_pct', q.discount_pct, 'fabric_amount', q.fabric_amount, 'packing_amount', q.packing_amount,
    'transport_note', q.transport_note, 'valid_days', q.valid_days, 'notes', q.notes,
    'areas', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'style', x.style, 'multiplier', x.multiplier, 'unit_label', x.unit_label) order by x.position)
                       from public.quotation_areas x where x.quotation_id = q.id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('area_id', l.area_id, 'name', l.name, 'size_text', l.size_text, 'spec', l.spec,
                         'material', l.material, 'finish', l.finish, 'qty_per_unit', l.qty_per_unit, 'qty_fixed', l.qty_fixed,
                         'unit_price', l.unit_price, 'tax_rate', l.tax_rate, 'image_path', l.image_path, 'is_optional', l.is_optional,
                         'client_note', l.client_note) order by l.position)
                       from public.quotation_lines l where l.quotation_id = q.id), '[]'::jsonb))
  from public.quotations q where q.id = p_id
$$;
revoke all on function public.quotation_client_doc(uuid) from public, anon, authenticated;

-- Area and line ids change on every save; two documents are the same when they match with those ids left out.
create or replace function public.quotation_doc_key(p_doc jsonb)
returns text language sql immutable set search_path = public, pg_temp
as $$
  select md5((p_doc - 'areas' - 'lines')::text
    || coalesce((select string_agg((a - 'id')::text, '|' order by ord) from jsonb_array_elements(p_doc->'areas') with ordinality t(a, ord)), '')
    || coalesce((select string_agg(jsonb_build_object('area', (select ar->>'name' from jsonb_array_elements(p_doc->'areas') ar where ar->>'id' = l->>'area_id'))::text
                                   || (l - 'area_id')::text, '|' order by ord) from jsonb_array_elements(p_doc->'lines') with ordinality t(l, ord)), ''))
$$;

-- Freeze the saved quotation as the next version (internal: callers check who may and when).
create or replace function public.quotation_version_add(p_id uuid, p_uid uuid, p_note text)
returns integer language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_doc jsonb := public.quotation_client_doc(p_id); v_no integer; v_last jsonb;
begin
  select coalesce(max(version_no), 0) + 1 into v_no from public.quotation_versions where quotation_id = p_id;
  select doc into v_last from public.quotation_versions where quotation_id = p_id order by version_no desc limit 1;
  if v_last is not null and public.quotation_doc_key(v_last) = public.quotation_doc_key(v_doc) then
    raise exception 'QUOTATION_INVALID: nothing has changed since v% was sent; save your changes first', v_no - 1 using errcode = '22023';
  end if;
  insert into public.quotation_versions (quotation_id, version_no, doc, value_before_gst, note, created_by)
  values (p_id, v_no, v_doc, public.quotation_value_before_gst(p_id), nullif(left(btrim(coalesce(p_note, '')), 300), ''), p_uid);
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, p_uid, 'version', jsonb_build_object('version_no', v_no, 'note', nullif(btrim(coalesce(p_note, '')), '')));
  return v_no;
end $$;
revoke all on function public.quotation_version_add(uuid, uuid, text) from public, anon, authenticated;

-- "Send as new version": the saved quotation becomes the next version and what the client's link shows.
create or replace function public.quotation_version_create(p_id uuid, p_note text default null)
returns integer language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then raise exception 'QUOTATIONS_FORBIDDEN: you may not send this quotation' using errcode = '42501'; end if;
  if q.status not in ('draft', 'sent', 'negotiating') then raise exception 'QUOTATION_LOCKED: a % quotation cannot be sent again', q.status using errcode = '55000'; end if;
  if q.share_token is null then raise exception 'QUOTATION_INVALID: turn the client link on first' using errcode = '22023'; end if;
  if (public.quotation_price_state(p_id)->>'blocked')::boolean then
    raise exception 'QUOTATION_LOCKED: these prices need the pricing desk''s approval before they are sent' using errcode = '55000';
  end if;
  return public.quotation_version_add(p_id, a.p_uid, p_note);
end $$;
revoke all on function public.quotation_version_create(uuid, text) from public, anon;
grant execute on function public.quotation_version_create(uuid, text) to authenticated;

-- The versions of a quotation, newest first (no documents).
create or replace function public.quotation_versions(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('version_no', v.version_no, 'note', v.note, 'value_before_gst', v.value_before_gst,
                     'created_at', v.created_at, 'by', (select u.full_name from public.users u where u.id = v.created_by)) order by v.version_no desc)
                   from public.quotation_versions v where v.quotation_id = p_id), '[]'::jsonb);
end $$;
revoke all on function public.quotation_versions(uuid) from public, anon;
grant execute on function public.quotation_versions(uuid) to authenticated;

-- One version's document; version 0 means the quotation as saved now (to compare unsent changes).
create or replace function public.quotation_version_get(p_id uuid, p_version_no integer)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_version_no = 0 then return public.quotation_client_doc(p_id); end if;
  return (select v.doc from public.quotation_versions v where v.quotation_id = p_id and v.version_no = p_version_no);
end $$;
revoke all on function public.quotation_version_get(uuid, integer) from public, anon;
grant execute on function public.quotation_version_get(uuid, integer) to authenticated;

-- quotation_share as in 20270617000000, plus: turning the link on for the first time freezes v1.
create or replace function public.quotation_share(p_id uuid, p_on boolean default true)
returns text language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; v_token text;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then raise exception 'QUOTATIONS_FORBIDDEN: you may not share this quotation' using errcode = '42501'; end if;
  if not p_on then
    if q.share_token is not null then
      update public.quotations set share_token = null where id = p_id;
      insert into public.quotation_events (quotation_id, actor_id, kind) values (p_id, a.p_uid, 'unshared');
    end if;
    return null;
  end if;
  if q.status = 'archived' then raise exception 'QUOTATION_LOCKED: an archived quotation cannot be shared' using errcode = '22023'; end if;
  if not exists (select 1 from public.quotation_lines l where l.quotation_id = p_id) then
    raise exception 'QUOTATION_INVALID: add at least one product before sharing' using errcode = '22023';
  end if;
  if q.share_token is null and (public.quotation_price_state(p_id)->>'blocked')::boolean then
    raise exception 'QUOTATION_LOCKED: these prices need the pricing desk''s approval before the client link is turned on' using errcode = '55000';
  end if;
  v_token := coalesce(q.share_token, replace(gen_random_uuid()::text, '-', ''));
  update public.quotations set share_token = v_token, shared_at = coalesce(shared_at, now()),
    status = case when status = 'draft' then 'sent' else status end,
    sent_at = case when status = 'draft' then coalesce(sent_at, now()) else sent_at end
  where id = p_id;
  if q.share_token is null then
    insert into public.quotation_events (quotation_id, actor_id, kind) values (p_id, a.p_uid, 'shared');
    if not exists (select 1 from public.quotation_versions v where v.quotation_id = p_id) then
      perform public.quotation_version_add(p_id, a.p_uid, 'First sent');
    end if;
  end if;
  return v_token;
end $$;
revoke all on function public.quotation_share(uuid, boolean) from public, anon;
grant execute on function public.quotation_share(uuid, boolean) to authenticated;

-- quotation_public as in 20270614000000, but showing the latest SENT version (with its version number and send date)
-- when there is one; the saved copy otherwise.
create or replace function public.quotation_public(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare q public.quotations; v record;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return null; end if;
  select * into q from public.quotations where share_token = p_token and status <> 'archived';
  if q.id is null then return null; end if;
  if not exists (select 1 from public.quotation_events e where e.quotation_id = q.id and e.kind = 'opened' and e.at > now() - interval '30 minutes') then
    insert into public.quotation_events (quotation_id, actor_id, kind) values (q.id, auth.uid(), 'opened');
  end if;
  select qv.doc, qv.version_no, qv.created_at into v from public.quotation_versions qv where qv.quotation_id = q.id order by qv.version_no desc limit 1;
  return coalesce(v.doc, public.quotation_client_doc(q.id)) || jsonb_build_object(
    'quote_no', q.quote_no, 'status', q.status,
    'issued_at', coalesce(v.created_at, q.sent_at, q.created_at),
    'version_no', v.version_no,
    'salesperson', (select u.full_name from public.users u where u.id = q.owner_id));
end $$;
revoke all on function public.quotation_public(text) from public;
grant execute on function public.quotation_public(text) to anon, authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.quotation_versions', 'select') then
    raise exception 'QUOTATION_VERSIONS: the versions table must stay closed to client roles';
  end if;
  if has_function_privilege('authenticated', 'public.quotation_version_add(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.quotation_client_doc(uuid)', 'execute')
     or has_function_privilege('anon', 'public.quotation_version_create(uuid, text)', 'execute') then
    raise exception 'QUOTATION_VERSIONS: internal functions must stay closed';
  end if;
end $$;
