-- 20270426000000_vendor_management.sql
--
-- Vendor Management: a vendor base for outsourced manufacturing, and a visit log
-- that proves and records every visit to a vendor's factory.
--
--   * vendors              one row per vendor company (the profile)
--   * vendor_visits        append-only: who visited, when (server time), where (GPS),
--                          whom they met, what was discussed, what came of it
--   * vendor_visit_photos  the photographs of a visit (factory, person, product)
--
-- Design (mirrors Exhibition Leads, 20270305000000 / 20270308000000):
--   * Every table is read-only to the browser and gated by module_entry_open().
--   * Every write is a SECURITY DEFINER function that derives the actor from
--     auth.uid(); no function takes an actor id.
--   * A visit can never be edited or deleted (trigger). A correction is a new visit.
--   * `visited_at` is the server's clock; the browser cannot back-date a live visit.
--   * A vendor has a STAGE: potential (heard of) -> contacted (spoken to, or met at OUR factory) -> prospect
--     (a member of our team has been to THEIR factory: registered) -> the owner's decisions. Only potential /
--     contacted vendors may have an incomplete profile.
--   * Two kinds of meeting: site_visit (we went: photographs + GPS) and vendor_at_our_factory (they came:
--     no proof needed, and it never registers the vendor).
--   * A meeting that already happened may be typed in afterwards (entered_later) with no photographs or
--     location, only inside a catch-up window the owner controls (vendor_settings.past_entries_until); it
--     is always shown as "Added later" and never counts as proof.
--   * Photographs live in the PRIVATE bucket 'vendor-visit-photos', path
--     '{uploader uuid}/{uuid}.jpg', and are shown through short-lived signed links.
--   * Access: module key 'vendors'. `view` opens the module, adds vendors, edits
--     profiles and logs visits; Admin (role) also sees the Activity screen and
--     changes a vendor's status or archives it. Nobody holds `view` until an
--     administrator grants it to a named employee (no department rule).
--   * Every "day" is Asia/Kolkata.
--
-- ROLLBACK (nothing else references these objects):
--   drop policy if exists vendor_visit_photos_insert on storage.objects;
--   drop policy if exists vendor_visit_photos_select on storage.objects;
--   drop policy if exists vendor_visit_photos_delete on storage.objects;
--   delete from storage.buckets where id = 'vendor-visit-photos';  -- only once empty
--   drop table public.vendor_visit_photos, public.vendor_visits, public.vendors, public.vendor_settings;
--   drop function public.save_vendor(uuid, uuid, jsonb), public.log_vendor_visit(uuid, uuid, jsonb),
--     public.vendor_list(jsonb), public.get_vendor(uuid), public.vendor_activity(date, date),
--     public.set_vendor_status(uuid, text), public.archive_vendor(uuid, text), public.restore_vendor(uuid),
--     public.set_vendor_past_entries_until(date), public.vendor_profile_complete(public.vendors),
--     public.vendors_my_access(), public.vendors_can_read(),
--     public.vendor_photo_can_upload(text), public.vendor_photo_readable(text, text),
--     public.vendors_actor(), public.vendors_user_eligible(uuid), public.vendor_txt(jsonb, text, integer, text, boolean),
--     public.vendor_arr(jsonb, text, text[], text, integer), public.vendor_distance_m(numeric, numeric, numeric, numeric);
--   delete from public.role_permissions / module_permission_actions / permission_modules / app_modules
--     where the module key is 'vendors'.

do $$
begin
  if to_regclass('public.users') is null
     or to_regprocedure('public.module_entry_open(text)') is null
     or to_regprocedure('public.resolve_permission(uuid,text,text)') is null
     or to_regprocedure('public.set_updated_at()') is null
     or to_regprocedure('public.normalize_lead_phone(text)') is null then
    raise exception 'DEPENDENCY MISSING: users, module_entry_open, resolve_permission, set_updated_at and normalize_lead_phone must exist';
  end if;
end $$;

-- ═══ 1. Control Center registration ═════════════════════════════════════════
-- Mirrors src/lib/permissions/modules.ts exactly (npm run permissions:check).

insert into public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
values
  ('vendors', 'Vendors',
   'Outsourcing vendor base and a log of every vendor visit, with photographs and location.',
   '/vendors', 'live', null, 110)
on conflict (module_key) do nothing;

insert into public.permission_modules (module_key, display_name, description) values
  ('vendors', 'Vendors',
   'Outsourcing vendor base and a log of every vendor visit, with photographs and location.')
on conflict (module_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view'
where pm.module_key = 'vendors'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'vendors'
on conflict (role, module_id, action_id) do nothing;

-- ═══ 2. Tables ══════════════════════════════════════════════════════════════

-- One row of settings: until when a visit that already happened may be entered without photographs or
-- location (the catch-up window while the module is new). Admin changes it; the default is 14 days from now.
create table public.vendor_settings (
  singleton          boolean primary key default true check (singleton),
  past_entries_until date not null
);
insert into public.vendor_settings (past_entries_until) values ((now() at time zone 'Asia/Kolkata')::date + 14);

-- A vendor goes through stages:
--   potential         heard about, nobody has been in touch
--   contacted         spoken to (phone, WhatsApp, or they came to our factory), not visited yet
--   prospect          a member of our team has been to their factory: registered
--   under_evaluation / approved / on_hold / rejected   the owner's decisions
-- Only a potential or contacted vendor may have an incomplete profile (just a name is enough); from
-- 'prospect' on, the complete profile is required by the CHECK below.
create table public.vendors (
  id                  uuid primary key default gen_random_uuid(),
  submission_id       uuid not null unique,
  company_name        text not null check (length(btrim(company_name)) between 1 and 160),
  contact_name        text check (contact_name is null or length(btrim(contact_name)) between 1 and 120),
  phone_e164          text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  address             text check (address is null or length(btrim(address)) between 5 and 500),
  city                text check (city is null or length(btrim(city)) between 1 and 80),
  latitude            numeric(9,6) check (latitude is null or latitude between -90 and 90),
  longitude           numeric(9,6) check (longitude is null or longitude between -180 and 180),
  -- What the vendor can do: raw/semi-finished pieces, complete finished furniture, or finishing only.
  capabilities        text[] not null default '{}'
                      check (cardinality(capabilities) <= 3
                             and capabilities <@ array['raw_pieces','finished_pieces','finishing_only']),
  categories          text[] not null default '{}'
                      check (categories <@ array['sofa_upholstery','chairs','tables','beds','storage_cabinets',
                                                 'outdoor','metal_fabrication','wood_carving_turning',
                                                 'polishing_finishing','other']),
  headcount           integer check (headcount is null or headcount between 0 and 5000),
  -- Who recommended this vendor, or how we heard of them (the reference being followed up).
  referred_by         text check (referred_by is null or length(referred_by) <= 200),
  notes               text check (notes is null or length(notes) <= 2000),
  status              text not null default 'prospect'
                      check (status in ('potential','contacted','prospect','under_evaluation','approved','on_hold','rejected')),
  created_by          uuid not null references public.users(id),
  created_at          timestamptz not null default now(),
  updated_by          uuid references public.users(id),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz,
  archived_by         uuid references public.users(id),
  archive_reason      text check (archive_reason is null or length(btrim(archive_reason)) between 3 and 500),
  constraint vendors_archive_all_or_none check (
    (archived_at is null and archived_by is null and archive_reason is null)
    or (archived_at is not null and archived_by is not null and archive_reason is not null)
  ),
  constraint vendors_complete_once_registered check (
    status in ('potential', 'contacted')
    or (contact_name is not null and phone_e164 is not null and address is not null
        and city is not null and cardinality(capabilities) >= 1)
  )
);

-- One ACTIVE vendor per mobile number: the second entry of the same factory is a visit to the first, not a
-- new vendor. Archiving frees the number. (A vendor with no number yet takes no part in this.)
create unique index vendors_one_active_phone on public.vendors (phone_e164) where archived_at is null;
create index vendors_city_idx on public.vendors (lower(city));
create index vendors_company_idx on public.vendors (lower(company_name));

create trigger vendors_set_updated_at
  before update on public.vendors
  for each row execute function public.set_updated_at();

-- Two kinds of meeting:
--   site_visit             one of us went to the vendor's factory (the proof event: photographs + GPS)
--   vendor_at_our_factory  the vendor came to ours (no photographs or GPS needed; does NOT register the vendor)
-- `entered_later` marks a record of something that already happened, typed in afterwards without proof; it
-- is allowed only inside the catch-up window and is always shown as "Added later".
create table public.vendor_visits (
  id                     uuid primary key default gen_random_uuid(),
  submission_id          uuid not null unique,
  vendor_id              uuid not null references public.vendors(id),
  visited_by             uuid not null references public.users(id),
  -- Server time for a live record; the day it happened (noon IST) for an entered-later one.
  visited_at             timestamptz not null default now(),
  kind                   text not null default 'site_visit' check (kind in ('site_visit', 'vendor_at_our_factory')),
  entered_later          boolean not null default false,
  person_met             text not null check (length(btrim(person_met)) between 1 and 120),
  discussion             text not null check (length(btrim(discussion)) between 3 and 2000),
  outcome                text not null
                         check (outcome in ('interested','follow_up_needed','sample_requested',
                                            'approved_to_start','not_suitable')),
  next_follow_up_on      date,
  -- Where the phone said it was when a live site visit was saved. 'unavailable' (denied / no signal) is
  -- shown plainly and never treated as verified. 'not_applicable': a meeting at our factory, or an
  -- entered-later record.
  location_source        text not null check (location_source in ('gps','unavailable','not_applicable')),
  latitude               numeric(9,6) check (latitude is null or latitude between -90 and 90),
  longitude              numeric(9,6) check (longitude is null or longitude between -180 and 180),
  accuracy_m             integer check (accuracy_m is null or accuracy_m between 0 and 100000),
  -- Metres from the vendor's recorded address point at the time of the visit (null when either is unknown).
  distance_m             integer check (distance_m is null or distance_m >= 0),
  created_at             timestamptz not null default now(),
  constraint vendor_visits_gps_complete check (
    (location_source = 'gps' and latitude is not null and longitude is not null)
    or (location_source in ('unavailable', 'not_applicable') and latitude is null and longitude is null)
  ),
  constraint vendor_visits_proof_rules check (
    (kind = 'site_visit' and not entered_later) or location_source = 'not_applicable'
  ),
  constraint vendor_visits_follow_up_when_needed check (outcome <> 'follow_up_needed' or next_follow_up_on is not null)
);
create index vendor_visits_vendor_idx on public.vendor_visits (vendor_id, visited_at desc);
create index vendor_visits_visitor_idx on public.vendor_visits (visited_by, visited_at desc);

create table public.vendor_visit_photos (
  id         uuid primary key default gen_random_uuid(),
  visit_id   uuid not null references public.vendor_visits(id),
  path       text not null unique check (path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
  kind       text not null check (kind in ('factory','person','product','other')),
  created_at timestamptz not null default now()
);
create index vendor_visit_photos_visit_idx on public.vendor_visit_photos (visit_id);

-- A visit and its photographs are a record: they are never edited or removed.
create or replace function public.vendor_visits_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'VENDOR_VISIT_IMMUTABLE: a vendor visit cannot be changed or removed; log a new visit instead'
    using errcode = '42501';
end;
$$;
create trigger vendor_visits_no_change
  before update or delete on public.vendor_visits
  for each row execute function public.vendor_visits_append_only();
create trigger vendor_visit_photos_no_change
  before update or delete on public.vendor_visit_photos
  for each row execute function public.vendor_visits_append_only();

-- ═══ 3. Eligibility and RLS ═════════════════════════════════════════════════

create or replace function public.vendors_user_eligible(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = p_uid
      and u.is_active
      and not coalesce(u.is_deleted, false)
      and (u.role = 'admin' or public.resolve_permission(u.id, 'vendors', 'view'))
  );
$$;
revoke all on function public.vendors_user_eligible(uuid) from public, anon, authenticated;

-- What a table policy may call: "is the signed-in caller eligible?"
create or replace function public.vendors_can_read()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and public.vendors_user_eligible(auth.uid());
$$;
revoke all on function public.vendors_can_read() from public, anon;
grant execute on function public.vendors_can_read() to authenticated;

create or replace function public.vendors_actor(out p_uid uuid, out p_is_admin boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  p_uid := auth.uid();
  if p_uid is null or not public.vendors_user_eligible(p_uid) then
    raise exception 'VENDORS_FORBIDDEN: Vendors is not available to this account'
      using errcode = '42501';
  end if;
  select (u.role = 'admin') into p_is_admin from public.users u where u.id = p_uid;
end;
$$;
revoke all on function public.vendors_actor() from public, anon, authenticated;

alter table public.vendors enable row level security;
alter table public.vendor_visits enable row level security;
alter table public.vendor_visit_photos enable row level security;

-- Read-only to the browser, twice over: the privileges below, and no insert / update / delete policy.
revoke all on public.vendors, public.vendor_visits, public.vendor_visit_photos from anon, authenticated, public;
grant select on public.vendors, public.vendor_visits, public.vendor_visit_photos to authenticated;
create policy vendors_select on public.vendors
  for select to authenticated using (public.vendors_can_read());
create policy vendor_visits_select on public.vendor_visits
  for select to authenticated using (public.vendors_can_read());
create policy vendor_visit_photos_select on public.vendor_visit_photos
  for select to authenticated using (public.vendors_can_read());

create policy vendors_module_entry_gate on public.vendors
  as restrictive for all to authenticated
  using (public.module_entry_open('vendors'))
  with check (public.module_entry_open('vendors'));
create policy vendor_visits_module_entry_gate on public.vendor_visits
  as restrictive for all to authenticated
  using (public.module_entry_open('vendors'))
  with check (public.module_entry_open('vendors'));
create policy vendor_visit_photos_module_entry_gate on public.vendor_visit_photos
  as restrictive for all to authenticated
  using (public.module_entry_open('vendors'))
  with check (public.module_entry_open('vendors'));

-- ═══ 4. Helpers ═════════════════════════════════════════════════════════════

-- Trimmed text from a jsonb object, length-checked. Empty becomes null.
create or replace function public.vendor_txt(
  p jsonb, p_key text, p_max integer, p_label text, p_required boolean default false
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := nullif(btrim(coalesce(p ->> p_key, '')), '');
begin
  if v is null then
    if p_required then
      raise exception 'VENDOR_INVALID: % is required', p_label using errcode = '22023';
    end if;
    return null;
  end if;
  if length(v) > p_max then
    raise exception 'VENDOR_INVALID: % is too long (max % characters)', p_label, p_max using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function public.vendor_txt(jsonb, text, integer, text, boolean) from public, anon, authenticated;

-- A text[] from a jsonb array, every value from the allowed list, at least p_min entries, no repeats.
create or replace function public.vendor_arr(
  p jsonb, p_key text, p_allowed text[], p_label text, p_min integer default 0
)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text[];
begin
  if jsonb_typeof(p -> p_key) = 'array' then
    select coalesce(array_agg(distinct e), '{}') into v from jsonb_array_elements_text(p -> p_key) e;
  else
    v := '{}';
  end if;
  if not (v <@ p_allowed) then
    raise exception 'VENDOR_INVALID: % has a value that is not on the list', p_label using errcode = '22023';
  end if;
  if cardinality(v) < p_min then
    raise exception 'VENDOR_INVALID: choose at least % for %', p_min, p_label using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function public.vendor_arr(jsonb, text, text[], text, integer) from public, anon, authenticated;

-- Great-circle distance in metres (haversine); null when any coordinate is unknown.
create or replace function public.vendor_distance_m(
  p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric
)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then null
    else round(2 * 6371000 * asin(least(1, sqrt(
      power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2)
      + cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8))
        * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2)
    ))))::integer
  end;
$$;
revoke all on function public.vendor_distance_m(numeric, numeric, numeric, numeric) from public, anon, authenticated;

-- ═══ 5. The photographs' bucket ═════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vendor-visit-photos', 'vendor-visit-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Upload only into your own folder, one JPEG named by a uuid, while you may use the module.
create or replace function public.vendor_photo_can_upload(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid() is not null
     and p_name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$')
     and public.vendors_user_eligible(auth.uid());
$fn$;
revoke all on function public.vendor_photo_can_upload(text) from public, anon;
grant execute on function public.vendor_photo_can_upload(text) to authenticated;

-- Everyone who may use the module may look at a visit's photographs; before a photograph
-- is attached to a visit, only its uploader may.
create or replace function public.vendor_photo_readable(p_name text, p_owner_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_name is null or not public.vendors_user_eligible(v_uid) then
    return false;
  end if;
  if exists (select 1 from public.vendor_visit_photos ph where ph.path = p_name) then
    return true;
  end if;
  return p_owner_id is not null and p_owner_id = v_uid::text;
end;
$fn$;
revoke all on function public.vendor_photo_readable(text, text) from public, anon;
grant execute on function public.vendor_photo_readable(text, text) to authenticated;

drop policy if exists vendor_visit_photos_insert on storage.objects;
create policy vendor_visit_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vendor-visit-photos' and public.vendor_photo_can_upload(name));

drop policy if exists vendor_visit_photos_select on storage.objects;
create policy vendor_visit_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'vendor-visit-photos' and public.vendor_photo_readable(name, owner_id));

-- A client may remove only its own upload that no visit names: the clean-up of a save that
-- never completed. A photograph on a visit is never deleted by a client.
drop policy if exists vendor_visit_photos_delete on storage.objects;
create policy vendor_visit_photos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'vendor-visit-photos'
    and owner_id = auth.uid()::text
    and not exists (select 1 from public.vendor_visit_photos ph where ph.path = name)
  );

-- ═══ 6. Writes ══════════════════════════════════════════════════════════════

-- Settings are reached only through the functions below.
alter table public.vendor_settings enable row level security;
revoke all on public.vendor_settings from anon, authenticated, public;

-- Is this vendor's profile complete enough to be registered (a site visit made, a decision taken)?
create or replace function public.vendor_profile_complete(p_vendor public.vendors)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_vendor.contact_name is not null and p_vendor.phone_e164 is not null and p_vendor.address is not null
     and p_vendor.city is not null and cardinality(p_vendor.capabilities) >= 1;
$$;
revoke all on function public.vendor_profile_complete(public.vendors) from public, anon, authenticated;

-- Create (p_vendor_id null) or update a vendor profile. Create is idempotent on p_submission_id.
-- p.status on create: 'potential' | 'contacted' (only a name is needed) or 'prospect' (the default, a complete
-- profile). A second ACTIVE vendor with the same mobile (or, with no mobile, the same name and city) is not
-- created: the answer says which vendor holds it. Returns {status: created|saved|duplicate, id, company_name}.
create or replace function public.save_vendor(p_submission_id uuid, p_vendor_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_row     public.vendors;
  v_stage   text;
  v_relaxed boolean;
  v_company text;
  v_contact text;
  v_phone   text;
  v_address text;
  v_city    text;
  v_lat     numeric;
  v_lng     numeric;
  v_caps    text[];
  v_cats    text[];
  v_head    integer;
  v_ref     text;
  v_notes   text;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.vendors_actor() a;

  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'VENDOR_INVALID: nothing to save' using errcode = '22023';
  end if;

  if p_vendor_id is null then
    v_stage := coalesce(nullif(btrim(p ->> 'status'), ''), 'prospect');
    if v_stage not in ('potential', 'contacted', 'prospect') then
      raise exception 'VENDOR_INVALID: a new vendor starts as potential, contacted or prospect' using errcode = '22023';
    end if;
  else
    select * into v_row from public.vendors where id = p_vendor_id for update;
    if not found then
      raise exception 'VENDOR_NOT_FOUND: that vendor does not exist' using errcode = 'P0002';
    end if;
    if v_row.archived_at is not null then
      raise exception 'VENDOR_ARCHIVED: this vendor is archived; ask an administrator to restore it' using errcode = '22023';
    end if;
    v_stage := v_row.status;
  end if;
  -- Before a site visit only a name is required; from then on the whole profile is.
  v_relaxed := v_stage in ('potential', 'contacted');

  v_company := public.vendor_txt(p, 'company_name', 160, 'Company name', true);
  v_contact := public.vendor_txt(p, 'contact_name', 120, 'Contact person', not v_relaxed);
  v_address := public.vendor_txt(p, 'address', 500, 'Address', not v_relaxed);
  if v_address is not null and length(v_address) < 5 then
    raise exception 'VENDOR_INVALID: Address is too short; give the exact address of the factory' using errcode = '22023';
  end if;
  v_city    := public.vendor_txt(p, 'city', 80, 'City', not v_relaxed);
  v_ref     := public.vendor_txt(p, 'referred_by', 200, 'Who recommended them');
  v_notes   := public.vendor_txt(p, 'notes', 2000, 'Notes');
  v_caps    := public.vendor_arr(p, 'capabilities', array['raw_pieces','finished_pieces','finishing_only'],
                                 'What the vendor can do', case when v_relaxed then 0 else 1 end);
  v_cats    := public.vendor_arr(p, 'categories',
                 array['sofa_upholstery','chairs','tables','beds','storage_cabinets','outdoor',
                       'metal_fabrication','wood_carving_turning','polishing_finishing','other'],
                 'Product types');

  if nullif(btrim(coalesce(p ->> 'phone', '')), '') is null then
    if not v_relaxed then
      raise exception 'VENDOR_INVALID: Mobile number is required' using errcode = '22023';
    end if;
  else
    v_phone := public.normalize_lead_phone(p ->> 'phone');
    if v_phone is null then
      raise exception 'VENDOR_INVALID: Mobile number does not look right' using errcode = '22023';
    end if;
  end if;

  if nullif(btrim(coalesce(p ->> 'headcount', '')), '') is not null then
    if (p ->> 'headcount') !~ '^[0-9]{1,4}$' or (p ->> 'headcount')::integer > 5000 then
      raise exception 'VENDOR_INVALID: Number of people must be a whole number up to 5000' using errcode = '22023';
    end if;
    v_head := (p ->> 'headcount')::integer;
  end if;

  if nullif(btrim(coalesce(p ->> 'latitude', '')), '') is not null
     and nullif(btrim(coalesce(p ->> 'longitude', '')), '') is not null then
    begin
      v_lat := (p ->> 'latitude')::numeric;
      v_lng := (p ->> 'longitude')::numeric;
    exception when others then
      raise exception 'VENDOR_INVALID: Location is not valid' using errcode = '22023';
    end;
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'VENDOR_INVALID: Location is not valid' using errcode = '22023';
    end if;
  end if;

  if p_vendor_id is null then
    if p_submission_id is null then
      raise exception 'VENDOR_INVALID: a submission id is required' using errcode = '22023';
    end if;
    select * into v_row from public.vendors where submission_id = p_submission_id;
    if found then
      return jsonb_build_object('status', 'created', 'id', v_row.id, 'company_name', v_row.company_name);
    end if;
    if v_phone is not null then
      select * into v_row from public.vendors where phone_e164 = v_phone and archived_at is null;
    else
      select * into v_row from public.vendors
       where archived_at is null and lower(company_name) = lower(v_company)
         and coalesce(lower(city), '') = coalesce(lower(v_city), '');
    end if;
    if found then
      return jsonb_build_object('status', 'duplicate', 'id', v_row.id, 'company_name', v_row.company_name);
    end if;
    begin
      insert into public.vendors
        (submission_id, company_name, contact_name, phone_e164, address, city, latitude, longitude,
         capabilities, categories, headcount, referred_by, notes, status, created_by, updated_by)
      values
        (p_submission_id, v_company, v_contact, v_phone, v_address, v_city, v_lat, v_lng,
         v_caps, v_cats, v_head, v_ref, v_notes, v_stage, v_uid, v_uid)
      returning * into v_row;
    exception when unique_violation then
      select * into v_row from public.vendors where phone_e164 = v_phone and archived_at is null;
      if found then
        return jsonb_build_object('status', 'duplicate', 'id', v_row.id, 'company_name', v_row.company_name);
      end if;
      select * into v_row from public.vendors where submission_id = p_submission_id;
      if found then
        return jsonb_build_object('status', 'created', 'id', v_row.id, 'company_name', v_row.company_name);
      end if;
      raise;
    end;
    return jsonb_build_object('status', 'created', 'id', v_row.id, 'company_name', v_row.company_name);
  end if;

  -- Update.
  if v_phone is not null and exists (select 1 from public.vendors o
             where o.phone_e164 = v_phone and o.archived_at is null and o.id <> p_vendor_id) then
    raise exception 'VENDOR_DUPLICATE_PHONE: another vendor already uses this mobile number' using errcode = '23505';
  end if;
  update public.vendors set
    company_name = v_company, contact_name = v_contact, phone_e164 = v_phone, address = v_address, city = v_city,
    -- A location sent with the edit moves the pin; an edit without one leaves it.
    latitude = coalesce(v_lat, latitude), longitude = coalesce(v_lng, longitude),
    capabilities = v_caps, categories = v_cats, headcount = v_head, referred_by = v_ref, notes = v_notes,
    updated_by = v_uid
  where id = p_vendor_id;
  return jsonb_build_object('status', 'saved', 'id', p_vendor_id, 'company_name', v_company);
end;
$$;
revoke all on function public.save_vendor(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_vendor(uuid, uuid, jsonb) to authenticated;

-- Log one meeting with its photographs, atomically. Idempotent on p_submission_id (a retry returns the
-- original). p:
--   kind              'site_visit' (default: we went to them) | 'vendor_at_our_factory' (they came to us)
--   entered_later     true for something that already happened, typed in afterwards (needs visited_on, and the
--                     catch-up window must be open); no photographs or location are required or kept
--   visited_on        the day it happened (entered_later only; not in the future, at most 120 days back)
--   person_met, discussion, outcome, next_follow_up_on
--   latitude, longitude, accuracy_m   (a live site visit only)
--   photos            [{path, kind}]
-- A LIVE site visit needs at least one photograph, and a vendor's first live site visit a factory photograph.
-- A site visit REGISTERS the vendor: its profile must be complete, and a potential / contacted vendor becomes
-- a prospect. A meeting at our factory moves a potential vendor to contacted and registers nothing.
create or replace function public.log_vendor_visit(p_submission_id uuid, p_vendor_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid;
  v_admin    boolean;
  v_vendor   public.vendors;
  v_existing public.vendor_visits;
  v_visit    uuid;
  v_kind     text;
  v_later    boolean;
  v_on       date;
  v_when     timestamptz := now();
  v_person   text;
  v_disc     text;
  v_outcome  text;
  v_follow   date;
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_until    date;
  v_lat      numeric;
  v_lng      numeric;
  v_acc      integer;
  v_source   text := 'not_applicable';
  v_dist     integer;
  v_photo    jsonb;
  v_kinds    text[] := '{}';
  v_count    integer := 0;
  v_first    boolean;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.vendors_actor() a;

  if p_submission_id is null then
    raise exception 'VENDOR_INVALID: a submission id is required' using errcode = '22023';
  end if;
  select * into v_existing from public.vendor_visits where submission_id = p_submission_id;
  if found then
    if v_existing.visited_by <> v_uid then
      raise exception 'VENDORS_FORBIDDEN: not your visit' using errcode = '42501';
    end if;
    return jsonb_build_object('status', 'replayed', 'id', v_existing.id, 'vendor_id', v_existing.vendor_id);
  end if;

  select * into v_vendor from public.vendors where id = p_vendor_id for update;
  if not found then
    raise exception 'VENDOR_NOT_FOUND: that vendor does not exist' using errcode = 'P0002';
  end if;
  if v_vendor.archived_at is not null then
    raise exception 'VENDOR_ARCHIVED: this vendor is archived; ask an administrator to restore it' using errcode = '22023';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'VENDOR_INVALID: nothing to save' using errcode = '22023';
  end if;

  v_kind := coalesce(nullif(btrim(p ->> 'kind'), ''), 'site_visit');
  if v_kind not in ('site_visit', 'vendor_at_our_factory') then
    raise exception 'VENDOR_INVALID: the kind of meeting is not on the list' using errcode = '22023';
  end if;
  v_later := coalesce((p ->> 'entered_later')::boolean, false);

  if v_later then
    select past_entries_until into v_until from public.vendor_settings;
    if v_until is null or v_today > v_until then
      raise exception 'VENDOR_INVALID: adding visits that already happened is closed; log new visits as they happen' using errcode = '22023';
    end if;
    begin
      v_on := (p ->> 'visited_on')::date;
    exception when others then
      raise exception 'VENDOR_INVALID: give the day the visit happened' using errcode = '22023';
    end;
    if v_on is null then
      raise exception 'VENDOR_INVALID: give the day the visit happened' using errcode = '22023';
    end if;
    if v_on > v_today then
      raise exception 'VENDOR_INVALID: the day of a visit that already happened cannot be in the future' using errcode = '22023';
    end if;
    if v_on < v_today - 120 then
      raise exception 'VENDOR_INVALID: that day is too long ago (at most 120 days back)' using errcode = '22023';
    end if;
    v_when := least(now(), ((v_on + time '12:00') at time zone 'Asia/Kolkata'));
  end if;

  v_outcome := public.vendor_txt(p, 'outcome', 40, 'Outcome', true);
  if v_outcome not in ('interested','follow_up_needed','sample_requested','approved_to_start','not_suitable') then
    raise exception 'VENDOR_INVALID: Outcome is not on the list' using errcode = '22023';
  end if;
  v_person := public.vendor_txt(p, 'person_met', 120, 'Person met', true);
  v_disc   := public.vendor_txt(p, 'discussion', 2000, 'What was discussed', true);
  if length(v_disc) < 3 then
    raise exception 'VENDOR_INVALID: What was discussed is too short' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p ->> 'next_follow_up_on', '')), '') is not null then
    begin
      v_follow := (p ->> 'next_follow_up_on')::date;
    exception when others then
      raise exception 'VENDOR_INVALID: Next follow-up date is not valid' using errcode = '22023';
    end;
    if v_follow < v_today then
      raise exception 'VENDOR_INVALID: Next follow-up date cannot be in the past' using errcode = '22023';
    end if;
  end if;
  if v_outcome = 'follow_up_needed' and v_follow is null then
    raise exception 'VENDOR_INVALID: give the date of the next follow-up' using errcode = '22023';
  end if;
  if v_outcome in ('not_suitable', 'approved_to_start') then
    v_follow := null;
  end if;

  -- Where the phone was matters only for a LIVE site visit; anything else is stored as "not applicable".
  if v_kind = 'site_visit' and not v_later then
    v_source := 'unavailable';
    if nullif(btrim(coalesce(p ->> 'latitude', '')), '') is not null
       and nullif(btrim(coalesce(p ->> 'longitude', '')), '') is not null then
      begin
        v_lat := (p ->> 'latitude')::numeric;
        v_lng := (p ->> 'longitude')::numeric;
        v_acc := nullif(btrim(coalesce(p ->> 'accuracy_m', '')), '')::numeric::integer;
      exception when others then
        raise exception 'VENDOR_INVALID: Location is not valid' using errcode = '22023';
      end;
      if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
        raise exception 'VENDOR_INVALID: Location is not valid' using errcode = '22023';
      end if;
      v_lat := round(v_lat, 6);
      v_lng := round(v_lng, 6);
      v_source := 'gps';
      v_dist := public.vendor_distance_m(v_vendor.latitude, v_vendor.longitude, v_lat, v_lng);
    end if;
  end if;

  if jsonb_typeof(p -> 'photos') = 'array' then
    if jsonb_array_length(p -> 'photos') > 12 then
      raise exception 'VENDOR_INVALID: at most 12 photographs per visit' using errcode = '22023';
    end if;
    for v_photo in select * from jsonb_array_elements(p -> 'photos') loop
      if jsonb_typeof(v_photo) <> 'object'
         or (v_photo ->> 'kind') not in ('factory','person','product','other')
         or coalesce(v_photo ->> 'path', '') !~ ('^' || v_uid::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') then
        raise exception 'VENDOR_INVALID: a photograph is not valid' using errcode = '22023';
      end if;
      if not exists (select 1 from storage.objects o
                     where o.bucket_id = 'vendor-visit-photos' and o.name = v_photo ->> 'path') then
        raise exception 'VENDOR_INVALID: a photograph has not finished uploading' using errcode = '22023';
      end if;
      v_kinds := v_kinds || (v_photo ->> 'kind');
      v_count := v_count + 1;
    end loop;
  end if;

  if v_kind = 'site_visit' and not v_later then
    if v_count = 0 then
      raise exception 'VENDOR_INVALID: add at least one photograph of the visit' using errcode = '22023';
    end if;
    v_first := not exists (select 1 from public.vendor_visits
                            where vendor_id = p_vendor_id and kind = 'site_visit' and not entered_later);
    if v_first and not ('factory' = any(v_kinds)) then
      raise exception 'VENDOR_INVALID: the first visit to the factory needs at least one photograph of the factory' using errcode = '22023';
    end if;
  end if;

  -- A site visit registers the vendor, so the profile must be complete.
  if v_kind = 'site_visit' and v_vendor.status in ('potential', 'contacted')
     and not public.vendor_profile_complete(v_vendor) then
    raise exception 'VENDOR_INVALID: complete the vendor''s details (contact person, mobile, address, city, what they can do) before registering a site visit' using errcode = '22023';
  end if;

  insert into public.vendor_visits
    (submission_id, vendor_id, visited_by, visited_at, kind, entered_later, person_met,
     discussion, outcome, next_follow_up_on, location_source, latitude, longitude, accuracy_m, distance_m)
  values
    (p_submission_id, p_vendor_id, v_uid, v_when, v_kind, v_later, v_person,
     v_disc, v_outcome, v_follow, v_source, v_lat, v_lng, v_acc, v_dist)
  returning id into v_visit;

  if v_count > 0 then
    for v_photo in select * from jsonb_array_elements(p -> 'photos') loop
      insert into public.vendor_visit_photos (visit_id, path, kind)
      values (v_visit, v_photo ->> 'path', v_photo ->> 'kind');
    end loop;
  end if;

  -- Stage follows what happened.
  if v_kind = 'site_visit' and v_vendor.status in ('potential', 'contacted') then
    update public.vendors set status = 'prospect', updated_by = v_uid where id = p_vendor_id;
  elsif v_kind = 'vendor_at_our_factory' and v_vendor.status = 'potential' then
    update public.vendors set status = 'contacted', updated_by = v_uid where id = p_vendor_id;
  end if;

  -- The first good GPS fix at a vendor with no pinned address point pins it.
  if v_source = 'gps' and v_vendor.latitude is null and coalesce(v_acc, 0) <= 200 then
    update public.vendors set latitude = v_lat, longitude = v_lng where id = p_vendor_id;
  end if;

  return jsonb_build_object('status', 'logged', 'id', v_visit, 'vendor_id', p_vendor_id,
                            'kind', v_kind, 'entered_later', v_later,
                            'location_source', v_source, 'distance_m', v_dist);
end;
$$;
revoke all on function public.log_vendor_visit(uuid, uuid, jsonb) from public, anon;
grant execute on function public.log_vendor_visit(uuid, uuid, jsonb) to authenticated;

-- Change a vendor's standing. Admin: any stage. Anyone with access: only between potential and contacted
-- (the pre-visit stages); a vendor becomes a prospect by a site visit, and the owner decides the rest.
create or replace function public.set_vendor_status(p_vendor_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_row   public.vendors;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.vendors_actor() a;
  if p_status not in ('potential','contacted','prospect','under_evaluation','approved','on_hold','rejected') then
    raise exception 'VENDOR_INVALID: status is not on the list' using errcode = '22023';
  end if;
  select * into v_row from public.vendors where id = p_vendor_id and archived_at is null for update;
  if not found then
    raise exception 'VENDOR_NOT_FOUND: that vendor does not exist or is archived' using errcode = 'P0002';
  end if;
  if not v_admin and not (v_row.status in ('potential', 'contacted') and p_status in ('potential', 'contacted')) then
    raise exception 'VENDORS_FORBIDDEN: only an administrator can set this status' using errcode = '42501';
  end if;
  begin
    update public.vendors set status = p_status, updated_by = v_uid where id = p_vendor_id;
  exception when check_violation then
    raise exception 'VENDOR_INVALID: complete the vendor''s details before moving it to this stage' using errcode = '22023';
  end;
  return jsonb_build_object('id', p_vendor_id, 'status', p_status);
end;
$$;
revoke all on function public.set_vendor_status(uuid, text) from public, anon;
grant execute on function public.set_vendor_status(uuid, text) to authenticated;

-- Admin: until which day a visit that already happened may still be typed in.
create or replace function public.set_vendor_past_entries_until(p_until date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select a.p_is_admin into v_admin from public.vendors_actor() a;
  if not v_admin then
    raise exception 'VENDORS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  if p_until is null or p_until < v_today - 1 or p_until > v_today + 90 then
    raise exception 'VENDOR_INVALID: choose a day from yesterday to 90 days ahead' using errcode = '22023';
  end if;
  update public.vendor_settings set past_entries_until = p_until;
  return jsonb_build_object('past_entries_until', p_until, 'past_entries_open', v_today <= p_until);
end;
$$;
revoke all on function public.set_vendor_past_entries_until(date) from public, anon;
grant execute on function public.set_vendor_past_entries_until(date) to authenticated;

create or replace function public.archive_vendor(p_vendor_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.vendors_actor() a;
  if not v_admin then
    raise exception 'VENDORS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'VENDOR_INVALID: give a reason (3 to 500 characters)' using errcode = '22023';
  end if;
  update public.vendors
     set archived_at = now(), archived_by = v_uid, archive_reason = v_reason, updated_by = v_uid
   where id = p_vendor_id and archived_at is null;
  if not found then
    raise exception 'VENDOR_NOT_FOUND: that vendor does not exist or is already archived' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_vendor_id, 'archived', true);
end;
$$;
revoke all on function public.archive_vendor(uuid, text) from public, anon;
grant execute on function public.archive_vendor(uuid, text) to authenticated;

create or replace function public.restore_vendor(p_vendor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.vendors_actor() a;
  if not v_admin then
    raise exception 'VENDORS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  begin
    update public.vendors
       set archived_at = null, archived_by = null, archive_reason = null, updated_by = v_uid
     where id = p_vendor_id and archived_at is not null;
  exception when unique_violation then
    raise exception 'VENDOR_DUPLICATE_PHONE: another active vendor now uses this mobile number' using errcode = '23505';
  end;
  if not found then
    raise exception 'VENDOR_NOT_FOUND: that vendor does not exist or is not archived' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_vendor_id, 'archived', false);
end;
$$;
revoke all on function public.restore_vendor(uuid) from public, anon;
grant execute on function public.restore_vendor(uuid) to authenticated;

-- ═══ 7. Reads ═══════════════════════════════════════════════════════════════

-- Is the caller Admin, and is the catch-up window for past visits still open? (Decides what to SHOW; every
-- function re-checks.)
create or replace function public.vendors_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
  v_until date;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select a.p_is_admin into v_admin from public.vendors_actor() a;
  select past_entries_until into v_until from public.vendor_settings;
  return jsonb_build_object('is_admin', coalesce(v_admin, false),
                            'past_entries_until', v_until,
                            'past_entries_open', v_until is not null and v_today <= v_until);
end;
$$;
revoke all on function public.vendors_my_access() from public, anon;
grant execute on function public.vendors_my_access() to authenticated;

-- The vendor list. p_filter: q, statuses[], capabilities[], categories[], city, awaiting_visit (bool: met us,
-- not yet visited), archived (bool), sort (last_visit|name|newest|oldest_visit), limit (<= 1000), offset.
create or replace function public.vendor_list(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin    boolean;
  v_q        text := nullif(lower(btrim(coalesce(p_filter ->> 'q', ''))), '');
  v_status   text[];
  v_caps     text[];
  v_cats     text[];
  v_city     text := nullif(lower(btrim(coalesce(p_filter ->> 'city', ''))), '');
  v_await    boolean := coalesce((p_filter ->> 'awaiting_visit')::boolean, false);
  v_archived boolean := coalesce((p_filter ->> 'archived')::boolean, false);
  v_sort     text := coalesce(p_filter ->> 'sort', 'last_visit');
  v_limit    integer := least(greatest(coalesce((p_filter ->> 'limit')::integer, 50), 1), 1000);
  v_offset   integer := greatest(coalesce((p_filter ->> 'offset')::integer, 0), 0);
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_total    integer;
  v_counts   jsonb;
  v_wait     integer;
  v_terms    text[];
  v_rows     jsonb;
begin
  select a.p_is_admin into v_admin from public.vendors_actor() a;
  if v_archived and not v_admin then
    raise exception 'VENDORS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  if jsonb_typeof(p_filter -> 'statuses') = 'array' and jsonb_array_length(p_filter -> 'statuses') > 0 then
    v_status := array(select jsonb_array_elements_text(p_filter -> 'statuses'));
  end if;
  if jsonb_typeof(p_filter -> 'capabilities') = 'array' and jsonb_array_length(p_filter -> 'capabilities') > 0 then
    v_caps := array(select jsonb_array_elements_text(p_filter -> 'capabilities'));
  end if;
  if jsonb_typeof(p_filter -> 'categories') = 'array' and jsonb_array_length(p_filter -> 'categories') > 0 then
    v_cats := array(select jsonb_array_elements_text(p_filter -> 'categories'));
  end if;

  -- Every word typed must be found somewhere in the vendor (company, person, phone, city, address,
  -- product types, who recommended them): "teak jodhpur" finds a Jodhpur vendor that works in teak, in any order.
  if v_q is not null then
    v_terms := regexp_split_to_array(v_q, '\s+');
  end if;

  with pre as (
    select v.id, v.company_name, v.contact_name, v.phone_e164, v.city, v.status, v.referred_by,
           v.capabilities, v.categories, v.headcount, v.created_at, v.archived_at,
           (select count(*) from public.vendor_visits x where x.vendor_id = v.id) as visit_count,
           (select count(*) from public.vendor_visits x where x.vendor_id = v.id and x.kind = 'site_visit') as site_visit_count,
           (select count(*) from public.vendor_visits x where x.vendor_id = v.id and x.kind = 'vendor_at_our_factory') as inbound_count,
           (select max(x.visited_at) from public.vendor_visits x where x.vendor_id = v.id) as last_visit_at,
           (select u.full_name from public.vendor_visits x join public.users u on u.id = x.visited_by
             where x.vendor_id = v.id order by x.visited_at desc limit 1) as last_visited_by
      from public.vendors v
     where ((v.archived_at is not null) = v_archived)
       and (v_terms is null or not exists (
              select 1 from unnest(v_terms) t
               where position(t in lower(concat_ws(' ', v.company_name, v.contact_name, v.phone_e164,
                       v.city, v.address, v.referred_by, array_to_string(v.categories, ' ')))) = 0))
       and (v_caps is null or v.capabilities && v_caps)
       and (v_cats is null or v.categories && v_cats)
       and (v_city is null or lower(v.city) = v_city)
  ),
  -- The status filter is applied AFTER the counts below are taken, so every status tab can show how many
  -- vendors it would hold under the current search and filters.
  base as (
    select * from pre
     where (v_status is null or pre.status = any(v_status))
       and (not v_await or (pre.inbound_count > 0 and pre.site_visit_count = 0))
  )
  select (select count(*) from base),
         (select count(*) from pre where pre.inbound_count > 0 and pre.site_visit_count = 0),
         coalesce((select jsonb_object_agg(c.status, c.n) from (select status, count(*) as n from pre group by status) c), '{}'::jsonb),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'id', b.id, 'company_name', b.company_name, 'contact_name', b.contact_name,
                    'phone', b.phone_e164, 'city', b.city, 'status', b.status,
                    'referred_by', b.referred_by,
                    'capabilities', b.capabilities, 'categories', b.categories, 'headcount', b.headcount,
                    'created_at', b.created_at, 'archived', b.archived_at is not null,
                    'visit_count', b.visit_count, 'site_visit_count', b.site_visit_count,
                    'inbound_count', b.inbound_count,
                    'awaiting_site_visit', b.inbound_count > 0 and b.site_visit_count = 0,
                    'last_visit_at', b.last_visit_at, 'last_visited_by', b.last_visited_by,
                    'days_since_visit', case when b.last_visit_at is null then null
                       else v_today - (b.last_visit_at at time zone 'Asia/Kolkata')::date end
                  ) order by
                    case when v_sort = 'name' then lower(b.company_name) end asc,
                    case when v_sort = 'newest' then b.created_at end desc,
                    case when v_sort = 'oldest_visit' then coalesce(b.last_visit_at, 'epoch'::timestamptz) end asc,
                    case when v_sort not in ('name','newest','oldest_visit') then b.last_visit_at end desc nulls last,
                    b.created_at desc)
           from (select * from base order by
                    case when v_sort = 'name' then lower(company_name) end asc,
                    case when v_sort = 'newest' then created_at end desc,
                    case when v_sort = 'oldest_visit' then coalesce(last_visit_at, 'epoch'::timestamptz) end asc,
                    case when v_sort not in ('name','newest','oldest_visit') then last_visit_at end desc nulls last,
                    created_at desc
                  limit v_limit offset v_offset) b
         ), '[]'::jsonb)
    into v_total, v_wait, v_counts, v_rows;

  return jsonb_build_object('total', v_total, 'awaiting_count', v_wait, 'status_counts', v_counts, 'rows', v_rows);
end;
$$;
revoke all on function public.vendor_list(jsonb) from public, anon;
grant execute on function public.vendor_list(jsonb) to authenticated;

-- One vendor with every meeting (newest first), each with its visitor and photographs.
create or replace function public.get_vendor(p_vendor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin  boolean;
  v_vendor public.vendors;
begin
  select a.p_is_admin into v_admin from public.vendors_actor() a;
  select * into v_vendor from public.vendors where id = p_vendor_id;
  if not found or (v_vendor.archived_at is not null and not v_admin) then
    raise exception 'VENDOR_NOT_FOUND: that vendor does not exist' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'vendor', jsonb_build_object(
      'id', v_vendor.id, 'company_name', v_vendor.company_name, 'contact_name', v_vendor.contact_name,
      'phone', v_vendor.phone_e164, 'address', v_vendor.address, 'city', v_vendor.city,
      'latitude', v_vendor.latitude, 'longitude', v_vendor.longitude,
      'capabilities', v_vendor.capabilities, 'categories', v_vendor.categories,
      'headcount', v_vendor.headcount, 'referred_by', v_vendor.referred_by,
      'notes', v_vendor.notes, 'status', v_vendor.status,
      'created_at', v_vendor.created_at,
      'created_by_name', (select u.full_name from public.users u where u.id = v_vendor.created_by),
      'updated_at', v_vendor.updated_at,
      'archived', v_vendor.archived_at is not null, 'archive_reason', v_vendor.archive_reason,
      'profile_complete', public.vendor_profile_complete(v_vendor),
      'awaiting_site_visit',
        exists (select 1 from public.vendor_visits x where x.vendor_id = v_vendor.id and x.kind = 'vendor_at_our_factory')
        and not exists (select 1 from public.vendor_visits x where x.vendor_id = v_vendor.id and x.kind = 'site_visit')
    ),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'visited_at', x.visited_at, 'visited_by', x.visited_by,
               'visited_by_name', u.full_name, 'kind', x.kind, 'entered_later', x.entered_later,
               'recorded_at', x.created_at,
               'person_met', x.person_met,
               'discussion', x.discussion, 'outcome', x.outcome, 'next_follow_up_on', x.next_follow_up_on,
               'location_source', x.location_source, 'latitude', x.latitude, 'longitude', x.longitude,
               'accuracy_m', x.accuracy_m, 'distance_m', x.distance_m,
               'photos', coalesce((select jsonb_agg(jsonb_build_object('path', ph.path, 'kind', ph.kind)
                                                    order by ph.created_at, ph.id)
                                     from public.vendor_visit_photos ph where ph.visit_id = x.id), '[]'::jsonb)
             ) order by x.visited_at desc)
        from public.vendor_visits x
        join public.users u on u.id = x.visited_by
       where x.vendor_id = p_vendor_id
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_vendor(uuid) from public, anon;
grant execute on function public.get_vendor(uuid) to authenticated;

-- Admin: who is visiting, how often and whether they were really there; which vendors have gone quiet; which
-- vendors have met us but still await a site visit; how much of the pipeline is still uncontacted.
-- "At the vendor" counts only LIVE site visits within 500 m of the vendor's address point; meetings at our
-- factory and visits entered later are counted on their own and never as proof.
create or replace function public.vendor_activity(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from  date := coalesce(p_from, (now() at time zone 'Asia/Kolkata')::date - 29);
  v_to    date := coalesce(p_to, (now() at time zone 'Asia/Kolkata')::date);
begin
  select a.p_is_admin into v_admin from public.vendors_actor() a;
  if not v_admin then
    raise exception 'VENDORS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  if v_to < v_from or v_to - v_from > 366 then
    raise exception 'VENDOR_INVALID: choose a period of at most a year' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'past_entries_until', (select past_entries_until from public.vendor_settings),
    'pipeline', (
      select jsonb_build_object(
        'potential', count(*) filter (where status = 'potential'),
        'contacted', count(*) filter (where status = 'contacted'),
        'registered', count(*) filter (where status not in ('potential', 'contacted')))
        from public.vendors where archived_at is null),
    'totals', (
      select jsonb_build_object(
        'visits', count(*) filter (where x.kind = 'site_visit'),
        'vendors_visited', count(distinct x.vendor_id) filter (where x.kind = 'site_visit'),
        'at_site', count(*) filter (where x.kind = 'site_visit' and not x.entered_later
                                      and x.distance_m is not null and x.distance_m <= 500),
        'no_location', count(*) filter (where x.kind = 'site_visit' and not x.entered_later
                                          and x.location_source = 'unavailable'),
        'at_our_factory', count(*) filter (where x.kind = 'vendor_at_our_factory'),
        'entered_later', count(*) filter (where x.entered_later))
        from public.vendor_visits x
       where (x.visited_at at time zone 'Asia/Kolkata')::date between v_from and v_to),
    'by_person', coalesce((
      select jsonb_agg(row_to_json(t)::jsonb order by t.visits desc, t.name)
        from (
          select u.id as user_id, u.full_name as name,
                 count(*) filter (where x.kind = 'site_visit') as visits,
                 count(distinct x.vendor_id) filter (where x.kind = 'site_visit') as vendors_visited,
                 count(*) filter (where x.kind = 'site_visit') - count(distinct x.vendor_id) filter (where x.kind = 'site_visit') as repeat_visits,
                 count(*) filter (where x.kind = 'site_visit' and not x.entered_later
                                    and x.distance_m is not null and x.distance_m <= 500) as at_site,
                 count(*) filter (where x.kind = 'site_visit' and not x.entered_later
                                    and x.location_source = 'unavailable') as no_location,
                 count(*) filter (where x.kind = 'vendor_at_our_factory') as at_our_factory,
                 count(*) filter (where x.entered_later) as entered_later,
                 min(x.visited_at) as first_visit, max(x.visited_at) as last_visit,
                 (select count(*) from public.vendors v
                   where v.created_by = u.id
                     and (v.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to) as vendors_added
            from public.vendor_visits x
            join public.users u on u.id = x.visited_by
           where (x.visited_at at time zone 'Asia/Kolkata')::date between v_from and v_to
           group by u.id, u.full_name
        ) t), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'visits', d.visits) order by d.day)
        from (select (x.visited_at at time zone 'Asia/Kolkata')::date as day, count(*) as visits
                from public.vendor_visits x
               where x.kind = 'site_visit'
                 and (x.visited_at at time zone 'Asia/Kolkata')::date between v_from and v_to
               group by 1) d), '[]'::jsonb),
    -- Registered live vendors that nobody has seen on site for 30 days (or ever), longest quiet first.
    'quiet_vendors', coalesce((
      select jsonb_agg(row_to_json(q)::jsonb order by q.days_since_visit desc nulls first)
        from (
          select v.id, v.company_name, v.city, v.status,
                 max(x.visited_at) as last_visit_at,
                 case when max(x.visited_at) is null then null
                      else v_today - (max(x.visited_at) at time zone 'Asia/Kolkata')::date end as days_since_visit
            from public.vendors v
            left join public.vendor_visits x on x.vendor_id = v.id and x.kind = 'site_visit'
           where v.archived_at is null and v.status in ('prospect','under_evaluation','approved')
           group by v.id
          having max(x.visited_at) is null
              or (v_today - (max(x.visited_at) at time zone 'Asia/Kolkata')::date) >= 30
           limit 100
        ) q), '[]'::jsonb),
    -- Vendors that have come to our factory but that none of us has visited yet: the chase list.
    'awaiting_site_visit', coalesce((
      select jsonb_agg(row_to_json(w)::jsonb order by w.first_met_at)
        from (
          select v.id, v.company_name, v.city, v.status,
                 min(x.visited_at) as first_met_at,
                 v_today - (min(x.visited_at) at time zone 'Asia/Kolkata')::date as days_waiting
            from public.vendors v
            join public.vendor_visits x on x.vendor_id = v.id and x.kind = 'vendor_at_our_factory'
           where v.archived_at is null
             and not exists (select 1 from public.vendor_visits y where y.vendor_id = v.id and y.kind = 'site_visit')
           group by v.id
           limit 100
        ) w), '[]'::jsonb),
    'follow_ups_due', coalesce((
      select jsonb_agg(row_to_json(f)::jsonb order by f.next_follow_up_on)
        from (
          select v.id as vendor_id, v.company_name, x.next_follow_up_on, u.full_name as visited_by_name
            from public.vendor_visits x
            join public.vendors v on v.id = x.vendor_id and v.archived_at is null
            join public.users u on u.id = x.visited_by
           where x.next_follow_up_on is not null
             and x.next_follow_up_on <= v_today + 7
             and x.visited_at = (select max(y.visited_at) from public.vendor_visits y where y.vendor_id = x.vendor_id)
           order by x.next_follow_up_on
           limit 100
        ) f), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.vendor_activity(date, date) from public, anon;
grant execute on function public.vendor_activity(date, date) to authenticated;

-- ═══ 8. Self-check ══════════════════════════════════════════════════════════

do $$
begin
  if (select public from storage.buckets where id = 'vendor-visit-photos') is distinct from false then
    raise exception 'VENDOR_PHOTO_ACL: the vendor-visit-photos bucket must be private';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename in ('vendors','vendor_visits','vendor_visit_photos','vendor_settings')
                and cmd in ('INSERT','UPDATE','DELETE','ALL') and permissive = 'PERMISSIVE') then
    raise exception 'VENDOR_RLS: the vendor tables must have no permissive write policy';
  end if;
  if (select count(*) from public.vendor_settings) <> 1 then
    raise exception 'VENDOR_SETTINGS: exactly one settings row is required';
  end if;
end $$;
