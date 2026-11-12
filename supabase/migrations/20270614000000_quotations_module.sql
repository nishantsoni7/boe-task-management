-- 20270614000000_quotations_module.sql
--
-- Quotations, phase 1: a quotation built from room types ("Boho room × 56 rooms") and product lines, with
-- pictures, prices and totals; a printable quotation; a client link that opens without signing in.
-- Planned with the owner on 2026-11-12 (plan + mockups in BOE-Development/temporary/quotation-module).
--
-- WHO DOES WHAT (Control Center → Access → Quotations; nobody but the Admin role is granted anything here)
--   view      open the module and see your OWN quotations.
--   create    start a quotation; edit and share your own.
--   edit      change quotations you may see (with view_all: anybody's).
--   view_all  see every salesperson's quotations (managers, the pricing desk).
-- Admin (role) holds all four.
--
-- SHAPE
--   quotations         one row per quotation; number QT-<initials>-<5 digits>, starting at 01001 so it never
--                      repeats a Base44 number (those reached QT-NS-00005 / QT-AK-00019 / QT-SS-00047).
--   quotation_areas    room types or areas, with a multiplier (56 rooms).
--   quotation_lines    products. Quantity = qty_fixed, or qty_per_unit × the area's multiplier.
--   quotation_events   append-only history (created, saved, status, shared, opened by the client).
-- Money is whole rupees (bigint). Totals are computed from the lines, never stored, so they cannot drift.
--
-- ACCESS. The four tables are closed to every client role: RLS on, no policy, no grant. Everything goes
-- through the SECURITY DEFINER functions below, each of which re-checks the caller (module entry, then the
-- action). The one function open to anon is quotation_public(token): it returns only what the client may
-- see (no internal notes, no owner phone, no cost) for a link the salesperson created and has not turned off.
--
-- PICTURES live in the PUBLIC bucket 'quotation-images' (the client link must show them without a session).
-- Paths are '{uploader uuid}/{uuid}.jpg': unguessable, carrying no price, client or name.
--
-- ROLLBACK: drop the four tables, the sequence and the quotation_* functions; drop the storage policies
-- quotation_images_*; empty and delete the bucket; delete the app_modules / permission_modules /
-- module_permission_actions / role_permissions / employee_permission_overrides rows for module_key 'quotations'.

do $$
begin
  if to_regclass('public.users') is null
     or to_regprocedure('public.module_entry_open(text)') is null
     or to_regprocedure('public.resolve_permission(uuid,text,text)') is null
     or to_regprocedure('public.set_updated_at()') is null then
    raise exception 'DEPENDENCY MISSING: users, module_entry_open, resolve_permission and set_updated_at must exist';
  end if;
end $$;

-- ═══ 1. Control Center registration (mirrors src/lib/permissions/modules.ts) ═══════════════════════════

insert into public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
values
  ('quotations', 'Quotations', 'Build quotations by room type, price them and share a client link.', '/quotations', 'live', null, 115)
on conflict (module_key) do nothing;

insert into public.permission_modules (module_key, display_name, description) values
  ('quotations', 'Quotations', 'Build quotations by room type, price them and share a client link.')
on conflict (module_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'create', 'edit', 'view_all')
where pm.module_key = 'quotations'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'quotations'
on conflict (role, module_id, action_id) do nothing;

-- ═══ 2. Tables ═════════════════════════════════════════════════════════════

create sequence public.quotation_no_seq start 1001;

create table public.quotations (
  id              uuid primary key default gen_random_uuid(),
  quote_no        text not null unique check (quote_no ~ '^QT-[A-Z]{1,3}-[0-9]{5,}$'),
  status          text not null default 'draft'
                  check (status in ('draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived')),
  client_name     text not null check (char_length(btrim(client_name)) between 1 and 160),
  project_name    text check (char_length(project_name) <= 160),
  contact_name    text check (char_length(contact_name) <= 120),
  contact_phone   text check (char_length(contact_phone) <= 20),
  contact_role    text check (char_length(contact_role) <= 60),
  client_type     text check (client_type in ('architect', 'interior_designer', 'property_owner', 'fnb_consultant', 'other')),
  supply_state    text check (char_length(supply_state) <= 60),
  gst_mode        text not null default 'igst' check (gst_mode in ('igst', 'cgst_sgst')),
  discount_pct    numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  fabric_amount   bigint not null default 0 check (fabric_amount >= 0 and fabric_amount <= 100000000000),
  packing_amount  bigint not null default 0 check (packing_amount >= 0 and packing_amount <= 100000000000),
  transport_note  text check (char_length(transport_note) <= 200),
  valid_days      integer not null default 7 check (valid_days between 1 and 90),
  notes           text check (char_length(notes) <= 2000),
  internal_notes  text check (char_length(internal_notes) <= 4000),
  source          text check (char_length(source) <= 120),
  share_token     text unique check (share_token ~ '^[0-9a-f]{32}$'),
  shared_at       timestamptz,
  sent_at         timestamptz,
  owner_id        uuid not null references public.users(id),
  created_by      uuid not null references public.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index quotations_owner_idx on public.quotations (owner_id, updated_at desc);
create index quotations_updated_idx on public.quotations (updated_at desc);
create trigger quotations_set_updated_at before update on public.quotations
  for each row execute function public.set_updated_at();

create table public.quotation_areas (
  id            uuid primary key default gen_random_uuid(),
  quotation_id  uuid not null references public.quotations(id) on delete cascade,
  position      integer not null check (position >= 0),
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  style         text check (char_length(style) <= 60),
  multiplier    integer not null default 1 check (multiplier between 1 and 100000),
  unit_label    text not null default 'rooms' check (char_length(unit_label) between 1 and 20)
);
create index quotation_areas_quotation_idx on public.quotation_areas (quotation_id, position);

create table public.quotation_lines (
  id             uuid primary key default gen_random_uuid(),
  quotation_id   uuid not null references public.quotations(id) on delete cascade,
  area_id        uuid references public.quotation_areas(id) on delete cascade,
  position       integer not null check (position >= 0),
  name           text not null check (char_length(btrim(name)) between 1 and 160),
  size_text      text check (char_length(size_text) <= 80),
  spec           text check (char_length(spec) <= 1000),
  material       text check (char_length(material) <= 120),
  finish         text check (char_length(finish) <= 120),
  category       text check (char_length(category) <= 60),
  qty_per_unit   numeric(10,2) check (qty_per_unit > 0 and qty_per_unit <= 100000),
  qty_fixed      numeric(10,2) check (qty_fixed > 0 and qty_fixed <= 1000000),
  unit_price     bigint check (unit_price >= 0 and unit_price <= 100000000000),
  tax_rate       numeric(4,2) not null default 18 check (tax_rate in (0, 5, 12, 18, 28)),
  image_path     text check (image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'),
  is_optional    boolean not null default false,
  client_note    text check (char_length(client_note) <= 500),
  internal_note  text check (char_length(internal_note) <= 1000),
  constraint quotation_lines_one_quantity check ((qty_per_unit is null) <> (qty_fixed is null))
);
create index quotation_lines_quotation_idx on public.quotation_lines (quotation_id, position);

create table public.quotation_events (
  id            bigserial primary key,
  quotation_id  uuid not null references public.quotations(id) on delete cascade,
  actor_id      uuid references public.users(id),
  kind          text not null check (kind in ('created', 'saved', 'status', 'shared', 'unshared', 'opened')),
  detail        jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);
create index quotation_events_quotation_idx on public.quotation_events (quotation_id, at desc);

-- Append-only history.
create or replace function public.quotation_events_append_only() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  raise exception 'QUOTATION_HISTORY_IS_APPEND_ONLY' using errcode = '42501';
end $$;
create trigger quotation_events_no_change before update or delete on public.quotation_events
  for each row when (pg_trigger_depth() = 0) execute function public.quotation_events_append_only();

-- Closed to every client role: only the functions below read or write.
alter table public.quotations       enable row level security;
alter table public.quotation_areas  enable row level security;
alter table public.quotation_lines  enable row level security;
alter table public.quotation_events enable row level security;
revoke all on public.quotations, public.quotation_areas, public.quotation_lines, public.quotation_events
  from public, anon, authenticated;
revoke all on sequence public.quotation_no_seq, public.quotation_events_id_seq from public, anon, authenticated;

-- ═══ 3. Access ═════════════════════════════════════════════════════════════

-- Internal: the signed-in actor and what they hold. Not callable by clients.
create or replace function public.quotation_actor(
  out p_uid uuid, out p_admin boolean, out p_create boolean, out p_edit boolean, out p_view_all boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  p_uid := auth.uid();
  if p_uid is not null then
    select (u.role = 'admin') into p_admin
    from public.users u where u.id = p_uid and u.is_active and not coalesce(u.is_deleted, false);
  end if;
  if p_uid is null or p_admin is null or not public.module_entry_open('quotations')
     or not (p_admin or public.resolve_permission(p_uid, 'quotations', 'view')) then
    raise exception 'QUOTATIONS_FORBIDDEN: Quotations is not available to this account' using errcode = '42501';
  end if;
  p_create   := p_admin or public.resolve_permission(p_uid, 'quotations', 'create');
  p_edit     := p_admin or public.resolve_permission(p_uid, 'quotations', 'edit');
  p_view_all := p_admin or public.resolve_permission(p_uid, 'quotations', 'view_all');
end $$;
revoke all on function public.quotation_actor() from public, anon, authenticated;

-- What the screens may SHOW. The functions decide what is allowed.
create or replace function public.quotation_my_access()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  return jsonb_build_object('create', a.p_create, 'edit', a.p_edit, 'view_all', a.p_view_all, 'admin', a.p_admin);
end $$;
revoke all on function public.quotation_my_access() from public, anon;
grant execute on function public.quotation_my_access() to authenticated;

-- Internal: may the actor see / change a quotation owned by p_owner and started by p_creator?
create or replace function public.quotation_sees(p_owner uuid, p_creator uuid, p_uid uuid, p_admin boolean, p_view_all boolean)
returns boolean language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(p_admin or p_view_all or p_owner = p_uid or p_creator = p_uid, false)
$$;
revoke all on function public.quotation_sees(uuid, uuid, uuid, boolean, boolean) from public, anon, authenticated;

create or replace function public.quotation_may_edit(p_owner uuid, p_creator uuid, p_uid uuid,
  p_admin boolean, p_create boolean, p_edit boolean, p_view_all boolean)
returns boolean language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(p_admin
      or ((p_create or p_edit) and (p_owner = p_uid or p_creator = p_uid))
      or (p_edit and p_view_all), false)
$$;
revoke all on function public.quotation_may_edit(uuid, uuid, uuid, boolean, boolean, boolean, boolean) from public, anon, authenticated;

-- Internal: two letters from a person's name for the quotation number (Nishant Soni → NS).
create or replace function public.quotation_initials(p_uid uuid)
returns text language sql stable set search_path = public, pg_temp
as $$
  select coalesce(nullif(upper(
    left(regexp_replace(split_part(btrim(u.full_name), ' ', 1), '[^A-Za-z]', '', 'g'), 1) ||
    left(regexp_replace(split_part(btrim(u.full_name), ' ', 2), '[^A-Za-z]', '', 'g'), 1)), ''), 'BO')
  from public.users u where u.id = p_uid
$$;
revoke all on function public.quotation_initials(uuid) from public, anon, authenticated;

-- May this caller upload a picture to their own folder? (create or edit)
create or replace function public.quotation_can_upload(p_name text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); a record;
begin
  if v_uid is null
     or p_name !~ ('^' || v_uid::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') then
    return false;
  end if;
  select * into a from public.quotation_actor();
  return a.p_create or a.p_edit;
exception when sqlstate '42501' then
  return false;
end $$;
revoke all on function public.quotation_can_upload(text) from public, anon;
grant execute on function public.quotation_can_upload(text) to authenticated;

-- ═══ 4. Pictures ═══════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quotation-images', 'quotation-images', true, 3145728, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists quotation_images_insert on storage.objects;
create policy quotation_images_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'quotation-images' and public.quotation_can_upload(name));

-- A client may remove only its own upload that no line names (clean-up of an abandoned picture).
drop policy if exists quotation_images_delete on storage.objects;
create policy quotation_images_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'quotation-images'
    and owner_id = auth.uid()::text
    and not exists (select 1 from public.quotation_lines l where l.image_path = name)
  );

-- ═══ 5. Reads ══════════════════════════════════════════════════════════════

-- Value before GST of one quotation, the same sum the screens make (src/lib/quotations/math.ts).
create or replace function public.quotation_value_before_gst(p_id uuid)
returns bigint language sql stable set search_path = public, pg_temp
as $$
  with s as (
    select coalesce(sum(round(coalesce(l.qty_fixed, l.qty_per_unit * coalesce(a.multiplier, 1)) * coalesce(l.unit_price, 0))), 0) as sub
    from public.quotation_lines l
    left join public.quotation_areas a on a.id = l.area_id
    where l.quotation_id = p_id and not l.is_optional
  )
  select (s.sub - round(s.sub * q.discount_pct / 100) + q.fabric_amount + q.packing_amount)::bigint
  from s, public.quotations q where q.id = p_id
$$;
revoke all on function public.quotation_value_before_gst(uuid) from public, anon, authenticated;

-- The list: 'mine' (own) or 'all' (needs view_all). Newest change first, at most 500.
create or replace function public.quotation_list(p_scope text default 'mine')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; v jsonb;
begin
  select * into a from public.quotation_actor();
  if p_scope not in ('mine', 'all') then raise exception 'QUOTATION_INVALID: scope' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(r order by r.updated_at desc), '[]'::jsonb) into v from (
    select q.id, q.quote_no, q.status, q.client_name, q.project_name, q.owner_id,
           (select u.full_name from public.users u where u.id = q.owner_id) as owner_name,
           q.created_at, q.updated_at, q.sent_at, q.valid_days, (q.share_token is not null) as shared,
           (select count(*) from public.quotation_lines l where l.quotation_id = q.id) as line_count,
           (select l.image_path from public.quotation_lines l where l.quotation_id = q.id and l.image_path is not null
              order by l.position limit 1) as first_image,
           public.quotation_value_before_gst(q.id) as value_before_gst,
           (select max(e.at) from public.quotation_events e where e.quotation_id = q.id and e.kind = 'opened') as last_opened_at
    from public.quotations q
    where (p_scope = 'all' and (a.p_admin or a.p_view_all))
       or q.owner_id = a.p_uid or q.created_by = a.p_uid
    order by q.updated_at desc
    limit 500
  ) r;
  return v;
end $$;
revoke all on function public.quotation_list(text) from public, anon;
grant execute on function public.quotation_list(text) to authenticated;

-- One quotation with its room types, lines and recent history.
create or replace function public.quotation_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'quotation', to_jsonb(q),
    'owner_name', (select u.full_name from public.users u where u.id = q.owner_id),
    'may_edit', public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all),
    'areas', coalesce((select jsonb_agg(to_jsonb(x) order by x.position) from public.quotation_areas x where x.quotation_id = p_id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.position) from public.quotation_lines l where l.quotation_id = p_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.at desc) from (
        select ev.kind, ev.detail, ev.at, (select u.full_name from public.users u where u.id = ev.actor_id) as actor_name
        from public.quotation_events ev where ev.quotation_id = p_id order by ev.at desc limit 30) e), '[]'::jsonb)
  );
end $$;
revoke all on function public.quotation_get(uuid) from public, anon;
grant execute on function public.quotation_get(uuid) to authenticated;

-- ═══ 6. Writes ═════════════════════════════════════════════════════════════

-- Start a quotation. p_data: client_name (required), project_name, contact_name, contact_phone, contact_role,
-- client_type, supply_state, source. Returns the new id.
create or replace function public.quotation_create(p_data jsonb)
returns uuid language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; v_id uuid; v_no text; v_state text := nullif(btrim(p_data->>'supply_state'), '');
begin
  select * into a from public.quotation_actor();
  if not (a.p_create or a.p_admin) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may not start quotations' using errcode = '42501';
  end if;
  v_no := 'QT-' || public.quotation_initials(a.p_uid) || '-' || lpad(nextval('public.quotation_no_seq')::text, 5, '0');
  insert into public.quotations (quote_no, client_name, project_name, contact_name, contact_phone, contact_role,
                                 client_type, supply_state, gst_mode, source, owner_id, created_by)
  values (v_no, btrim(p_data->>'client_name'), nullif(btrim(p_data->>'project_name'), ''),
          nullif(btrim(p_data->>'contact_name'), ''), nullif(btrim(p_data->>'contact_phone'), ''),
          nullif(btrim(p_data->>'contact_role'), ''), nullif(p_data->>'client_type', ''), v_state,
          case when lower(coalesce(v_state, '')) = 'rajasthan' then 'cgst_sgst' else 'igst' end,
          nullif(btrim(p_data->>'source'), ''), a.p_uid, a.p_uid)
  returning id into v_id;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail) values (v_id, a.p_uid, 'created', jsonb_build_object('quote_no', v_no));
  return v_id;
exception
  when check_violation or not_null_violation or invalid_text_representation then
    raise exception 'QUOTATION_INVALID: %', sqlerrm using errcode = '22023';
end $$;
revoke all on function public.quotation_create(jsonb) from public, anon;
grant execute on function public.quotation_create(jsonb) to authenticated;

-- Save the whole quotation in one go: header fields, room types and lines (the builder sends everything).
-- p_doc: { expected_updated_at, header: {...}, areas: [{key, name, style, multiplier, unit_label}],
--          lines: [{area_key, name, size_text, spec, material, finish, category, qty_per_unit | qty_fixed,
--                   unit_price, tax_rate, image_path, is_optional, client_note, internal_note}] }
-- Refuses a stale save (somebody else saved after you loaded) with QUOTATION_STALE.
create or replace function public.quotation_save(p_id uuid, p_doc jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  a record; q public.quotations; h jsonb := coalesce(p_doc->'header', '{}'::jsonb);
  v jsonb; ord bigint; v_area uuid; keys jsonb := '{}'::jsonb; n_areas int := 0; n_lines int := 0;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then raise exception 'QUOTATIONS_FORBIDDEN: you may not change this quotation' using errcode = '42501'; end if;
  if q.status in ('confirmed', 'lost', 'archived') then
    raise exception 'QUOTATION_LOCKED: a % quotation cannot be changed; reopen it first', q.status using errcode = '22023';
  end if;
  if p_doc ? 'expected_updated_at' and q.updated_at <> (p_doc->>'expected_updated_at')::timestamptz then
    raise exception 'QUOTATION_STALE: this quotation was saved by somebody else after you opened it' using errcode = '40001';
  end if;
  if jsonb_typeof(coalesce(p_doc->'areas', '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_doc->'lines', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_doc->'areas', '[]'::jsonb)) > 40 or jsonb_array_length(coalesce(p_doc->'lines', '[]'::jsonb)) > 600 then
    raise exception 'QUOTATION_INVALID: at most 40 room types and 600 lines' using errcode = '22023';
  end if;

  update public.quotations set
    client_name    = btrim(coalesce(h->>'client_name', client_name)),
    project_name   = nullif(btrim(h->>'project_name'), ''),
    contact_name   = nullif(btrim(h->>'contact_name'), ''),
    contact_phone  = nullif(btrim(h->>'contact_phone'), ''),
    contact_role   = nullif(btrim(h->>'contact_role'), ''),
    client_type    = nullif(h->>'client_type', ''),
    supply_state   = nullif(btrim(h->>'supply_state'), ''),
    gst_mode       = coalesce(nullif(h->>'gst_mode', ''), gst_mode),
    discount_pct   = coalesce((h->>'discount_pct')::numeric, 0),
    fabric_amount  = coalesce((h->>'fabric_amount')::bigint, 0),
    packing_amount = coalesce((h->>'packing_amount')::bigint, 0),
    transport_note = nullif(btrim(h->>'transport_note'), ''),
    valid_days     = coalesce((h->>'valid_days')::int, valid_days),
    notes          = nullif(btrim(h->>'notes'), ''),
    internal_notes = nullif(btrim(h->>'internal_notes'), '')
  where id = p_id
  returning * into q;

  delete from public.quotation_lines where quotation_id = p_id;
  delete from public.quotation_areas where quotation_id = p_id;

  for v, ord in select t.v, t.ord from jsonb_array_elements(coalesce(p_doc->'areas', '[]'::jsonb)) with ordinality as t(v, ord) loop
    insert into public.quotation_areas (quotation_id, position, name, style, multiplier, unit_label)
    values (p_id, ord - 1, btrim(v->>'name'), nullif(btrim(v->>'style'), ''), coalesce((v->>'multiplier')::int, 1),
            coalesce(nullif(btrim(v->>'unit_label'), ''), 'rooms'))
    returning id into v_area;
    if coalesce(v->>'key', '') <> '' then keys := keys || jsonb_build_object(v->>'key', v_area); end if;
    n_areas := n_areas + 1;
  end loop;

  for v, ord in select t.v, t.ord from jsonb_array_elements(coalesce(p_doc->'lines', '[]'::jsonb)) with ordinality as t(v, ord) loop
    v_area := null;
    if coalesce(v->>'area_key', '') <> '' then
      if not keys ? (v->>'area_key') then raise exception 'QUOTATION_INVALID: a line names a room type that is not in the quotation' using errcode = '22023'; end if;
      v_area := (keys->>(v->>'area_key'))::uuid;
    end if;
    insert into public.quotation_lines (quotation_id, area_id, position, name, size_text, spec, material, finish, category,
      qty_per_unit, qty_fixed, unit_price, tax_rate, image_path, is_optional, client_note, internal_note)
    values (p_id, v_area, ord - 1, btrim(v->>'name'), nullif(btrim(v->>'size_text'), ''), nullif(btrim(v->>'spec'), ''),
      nullif(btrim(v->>'material'), ''), nullif(btrim(v->>'finish'), ''), nullif(btrim(v->>'category'), ''),
      (v->>'qty_per_unit')::numeric, (v->>'qty_fixed')::numeric, (v->>'unit_price')::bigint,
      coalesce((v->>'tax_rate')::numeric, 18), nullif(v->>'image_path', ''), coalesce((v->>'is_optional')::boolean, false),
      nullif(btrim(v->>'client_note'), ''), nullif(btrim(v->>'internal_note'), ''));
    n_lines := n_lines + 1;
  end loop;

  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, a.p_uid, 'saved', jsonb_build_object('areas', n_areas, 'lines', n_lines, 'value_before_gst', public.quotation_value_before_gst(p_id)));
  return jsonb_build_object('updated_at', q.updated_at, 'value_before_gst', public.quotation_value_before_gst(p_id));
exception
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format then
    raise exception 'QUOTATION_INVALID: %', sqlerrm using errcode = '22023';
end $$;
revoke all on function public.quotation_save(uuid, jsonb) from public, anon;
grant execute on function public.quotation_save(uuid, jsonb) to authenticated;

-- Move a quotation: draft, sent, negotiating, confirmed, lost, archived. Reopening a confirmed one is Admin only.
create or replace function public.quotation_set_status(p_id uuid, p_status text, p_note text default null)
returns text language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then raise exception 'QUOTATIONS_FORBIDDEN: you may not change this quotation' using errcode = '42501'; end if;
  if p_status not in ('draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived') then
    raise exception 'QUOTATION_INVALID: status' using errcode = '22023';
  end if;
  if q.status = 'confirmed' and p_status <> 'confirmed' and not a.p_admin then
    raise exception 'QUOTATIONS_FORBIDDEN: only an administrator can reopen a confirmed quotation' using errcode = '42501';
  end if;
  if p_status = 'lost' and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'QUOTATION_INVALID: say why it was lost' using errcode = '22023';
  end if;
  if q.status = p_status then return q.status; end if;
  update public.quotations set status = p_status,
    sent_at = case when p_status = 'sent' then coalesce(sent_at, now()) else sent_at end
  where id = p_id;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, a.p_uid, 'status', jsonb_build_object('from', q.status, 'to', p_status, 'note', nullif(btrim(coalesce(p_note, '')), '')));
  return p_status;
end $$;
revoke all on function public.quotation_set_status(uuid, text, text) from public, anon;
grant execute on function public.quotation_set_status(uuid, text, text) to authenticated;

-- Turn the client link on (returns the token; the same token while it stays on) or off.
-- Turning it on for a draft marks the quotation Sent: a link is how it reaches the client.
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
  v_token := coalesce(q.share_token, replace(gen_random_uuid()::text, '-', ''));
  update public.quotations set share_token = v_token, shared_at = coalesce(shared_at, now()),
    status = case when status = 'draft' then 'sent' else status end,
    sent_at = case when status = 'draft' then coalesce(sent_at, now()) else sent_at end
  where id = p_id;
  if q.share_token is null then
    insert into public.quotation_events (quotation_id, actor_id, kind) values (p_id, a.p_uid, 'shared');
  end if;
  return v_token;
end $$;
revoke all on function public.quotation_share(uuid, boolean) from public, anon;
grant execute on function public.quotation_share(uuid, boolean) to authenticated;

-- The client's view of a shared quotation. Open to anon. Only client-safe fields; null for an unknown, turned
-- off or archived link. Records "opened" at most once every 30 minutes per quotation.
create or replace function public.quotation_public(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare q public.quotations;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return null; end if;
  select * into q from public.quotations where share_token = p_token and status <> 'archived';
  if q.id is null then return null; end if;
  if not exists (select 1 from public.quotation_events e where e.quotation_id = q.id and e.kind = 'opened' and e.at > now() - interval '30 minutes') then
    insert into public.quotation_events (quotation_id, actor_id, kind) values (q.id, auth.uid(), 'opened');
  end if;
  return jsonb_build_object(
    'quote_no', q.quote_no, 'status', q.status, 'client_name', q.client_name, 'project_name', q.project_name,
    'contact_name', q.contact_name, 'gst_mode', q.gst_mode, 'discount_pct', q.discount_pct,
    'fabric_amount', q.fabric_amount, 'packing_amount', q.packing_amount, 'transport_note', q.transport_note,
    'valid_days', q.valid_days, 'notes', q.notes, 'issued_at', coalesce(q.sent_at, q.created_at),
    'salesperson', (select u.full_name from public.users u where u.id = q.owner_id),
    'areas', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'style', x.style, 'multiplier', x.multiplier, 'unit_label', x.unit_label) order by x.position)
                       from public.quotation_areas x where x.quotation_id = q.id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('area_id', l.area_id, 'name', l.name, 'size_text', l.size_text, 'spec', l.spec,
                         'material', l.material, 'finish', l.finish, 'qty_per_unit', l.qty_per_unit, 'qty_fixed', l.qty_fixed,
                         'unit_price', l.unit_price, 'tax_rate', l.tax_rate, 'image_path', l.image_path, 'is_optional', l.is_optional,
                         'client_note', l.client_note) order by l.position)
                       from public.quotation_lines l where l.quotation_id = q.id), '[]'::jsonb)
  );
end $$;
revoke all on function public.quotation_public(text) from public;
grant execute on function public.quotation_public(text) to anon, authenticated;

-- Self-check: the registration rows and the closed tables.
do $$
begin
  if (select count(*) from public.role_permissions rp join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key = 'quotations' and rp.role = 'admin' and rp.allowed) <> 4 then
    raise exception 'QUOTATIONS_MODULE: the Admin role needs its four rows (view, create, edit, view_all)';
  end if;
  if has_table_privilege('anon', 'public.quotations', 'select') or has_table_privilege('authenticated', 'public.quotations', 'select') then
    raise exception 'QUOTATIONS_MODULE: the quotations table must stay closed to client roles';
  end if;
end $$;
