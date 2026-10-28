-- 20270429000000_vendor_access_levels.sql
--
-- Vendors: real access levels in Control Center.
--
-- WHY. 20270426000000 registered ONE action, `view`, so Control Center could offer nothing between
-- "no access" and "everything a non-admin can do". Dhruv could not be made a Manager and a colleague (Nitish)
-- could not be given sight of what is happening without being allowed to add and edit.
--
-- THE ACTIONS (same keys every other module uses, so Viewer / Contributor / Manager / Custom just work):
--
--   view        open the module; read every vendor, visit, photograph and note          (Viewer)
--   create      add a vendor; log a visit                                               (Contributor)
--   edit        edit a vendor's profile; move it between Potential and Contacted        (Contributor)
--   approve     decide the later stages (prospect, under evaluation, approved, on hold, rejected); archive and
--               restore a vendor; change the date until which past visits may be entered;
--               see the Visit Activity screen                                           (Manager)
--   export      download the vendor list as a file                                      (Manager)
--   view_all    see the Visit Activity screen WITHOUT being able to decide anything. The protected company-wide
--               sight action: handed out per person ("Custom") or not at all.
--
-- The Admin role holds every action, as before.
--
-- WHAT STOPS BEING TRUE. Until now `view` also added vendors and logged visits. After this migration `view`
-- is read-only, so section 2 gives every person who holds an explicit `view` grant create + edit alongside it:
-- nobody (Dhruv) loses what they can do today. Move them to Viewer in Control Center to make them read-only.
--
-- DEFINERS RE-ISSUED (only the permission lines change): save_vendor, log_vendor_visit, set_vendor_status,
-- vendor_activity, vendors_actor, vendors_my_access. Every other function keeps calling vendors_actor(), whose
-- p_is_admin now means "may decide" (Admin role OR vendors.approve), so archive, restore, the past-entries date
-- and the archived list follow `approve` without being touched.
--
-- ROLLBACK: delete the five new module_permission_actions / role_permissions / override rows for module
-- 'vendors' (everything except `view`), then re-apply the six functions from 20270426000000 / 20270427000000.

do $$
begin
  if to_regprocedure('public.vendors_actor()') is null or to_regprocedure('public.vendor_activity(date,date)') is null then
    raise exception 'DEPENDENCY MISSING: 20270426000000_vendor_management must be applied first';
  end if;
  if (select count(*) from public.permission_actions where action_key in ('create','edit','approve','export','view_all')) <> 5 then
    raise exception 'DEPENDENCY MISSING: the standard actions create, edit, approve, export and view_all must exist';
  end if;
end $$;

-- ═══ 1. Register the actions (default off) ══════════════════════════════════
insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('create','edit','approve','export','view_all')
where pm.module_key = 'vendors'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'vendors'
on conflict (role, module_id, action_id) do nothing;

-- ═══ 2. Nobody loses what they can do today ═════════════════════════════════
-- Everyone with an explicit, active `view` grant also gets create + edit, so a Contributor stays a Contributor.
insert into public.employee_permission_overrides
  (user_id, module_id, action_id, allowed, granted_by, granted_at)
select epo.user_id, epo.module_id, pa.id, true, epo.granted_by, now()
from public.employee_permission_overrides epo
join public.permission_modules pm on pm.id = epo.module_id and pm.module_key = 'vendors'
join public.permission_actions pv on pv.id = epo.action_id and pv.action_key = 'view'
join public.permission_actions pa on pa.action_key in ('create', 'edit')
where epo.allowed
  and epo.revoked_at is null
on conflict (user_id, module_id, action_id) do nothing;

-- ═══ 3. Helpers ═════════════════════════════════════════════════════════════
-- Does the signed-in caller hold this action? (Admin role: always.) Internal: only definer functions call it.
create or replace function public.vendors_can(p_action text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.is_active
      and not coalesce(u.is_deleted, false)
      and (u.role = 'admin' or public.resolve_permission(u.id, 'vendors', p_action))
  );
$$;
revoke all on function public.vendors_can(text) from public, anon, authenticated;

create or replace function public.vendors_require(p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.vendors_can(p_action) then
    raise exception 'VENDORS_FORBIDDEN: your access level does not allow this' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.vendors_require(text) from public, anon, authenticated;

-- p_is_admin keeps its name so the functions that read it need no change; it now means "may decide":
-- the Admin role, or vendors.approve.
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
  p_is_admin := public.vendors_can('approve');
end;
$$;
revoke all on function public.vendors_actor() from public, anon, authenticated;

-- What the screens may SHOW (every function above re-checks).
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
                            'can_create', public.vendors_can('create'),
                            'can_edit', public.vendors_can('edit'),
                            'can_export', public.vendors_can('export'),
                            'can_see_activity', coalesce(v_admin, false) or public.vendors_can('view_all'),
                            'past_entries_until', v_until,
                            'past_entries_open', v_until is not null and v_today <= v_until);
end;
$$;
revoke all on function public.vendors_my_access() from public, anon;
grant execute on function public.vendors_my_access() to authenticated;

-- ═══ 4. The write functions, with the level check added ═════════════════════
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
  v_lat     numeric;
  v_lng     numeric;
  v_caps    text[];
  v_product text;
  v_team    text;
  v_notes   text;
  v_area    text;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.vendors_actor() a;
  perform public.vendors_require(case when p_vendor_id is null then 'create' else 'edit' end);

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
  v_notes   := public.vendor_txt(p, 'notes', 2000, 'Notes');
  v_area    := public.vendor_txt(p, 'area', 80, 'Area');
  -- One spelling per area: typing "basni" when "Basni" exists reuses "Basni", so the filter never lists both.
  if v_area is not null then
    select coalesce((select x.area from public.vendors x where x.area is not null and lower(x.area) = lower(v_area)
                      order by x.created_at limit 1), v_area) into v_area;
  end if;
  v_caps    := public.vendor_arr(p, 'capabilities', array['raw_pieces','finished_pieces','finishing_only'],
                                 'What the vendor can do', case when v_relaxed then 0 else 1 end);
  v_product := nullif(btrim(coalesce(p ->> 'product_focus', '')), '');
  if v_product is not null and v_product not in ('chairs_and_other', 'other_only') then
    raise exception 'VENDOR_INVALID: Products is not on the list' using errcode = '22023';
  end if;
  v_team := nullif(btrim(coalesce(p ->> 'team_size', '')), '');
  if v_team is not null and v_team not in ('3-5', '6-10', '11-15', '16-20', '21+') then
    raise exception 'VENDOR_INVALID: Team size is not on the list' using errcode = '22023';
  end if;

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
       where archived_at is null and lower(company_name) = lower(v_company);
    end if;
    if found then
      return jsonb_build_object('status', 'duplicate', 'id', v_row.id, 'company_name', v_row.company_name);
    end if;
    begin
      insert into public.vendors
        (submission_id, company_name, contact_name, phone_e164, address, area, latitude, longitude,
         capabilities, product_focus, team_size, notes, status, created_by, updated_by)
      values
        (p_submission_id, v_company, v_contact, v_phone, v_address, v_area, v_lat, v_lng,
         v_caps, v_product, v_team, v_notes, v_stage, v_uid, v_uid)
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
    company_name = v_company, contact_name = v_contact, phone_e164 = v_phone, address = v_address, area = v_area,
    -- A location sent with the edit moves the pin; an edit without one leaves it.
    latitude = coalesce(v_lat, latitude), longitude = coalesce(v_lng, longitude),
    capabilities = v_caps, product_focus = v_product, team_size = v_team, notes = v_notes,
    updated_by = v_uid
  where id = p_vendor_id;
  return jsonb_build_object('status', 'saved', 'id', p_vendor_id, 'company_name', v_company);
end;
$$;

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
  perform public.vendors_require('create');

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
    raise exception 'VENDOR_INVALID: complete the vendor''s details (contact person, mobile, address, what they can do) before registering a site visit' using errcode = '22023';
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
  perform public.vendors_require('edit');
  if p_status not in ('potential','contacted','prospect','under_evaluation','approved','on_hold','rejected') then
    raise exception 'VENDOR_INVALID: status is not on the list' using errcode = '22023';
  end if;
  select * into v_row from public.vendors where id = p_vendor_id and archived_at is null for update;
  if not found then
    raise exception 'VENDOR_NOT_FOUND: that vendor does not exist or is archived' using errcode = 'P0002';
  end if;
  if not v_admin and not (v_row.status in ('potential', 'contacted') and p_status in ('potential', 'contacted')) then
    raise exception 'VENDORS_FORBIDDEN: only a manager can set this status' using errcode = '42501';
  end if;
  begin
    update public.vendors set status = p_status, updated_by = v_uid where id = p_vendor_id;
  exception when check_violation then
    raise exception 'VENDOR_INVALID: complete the vendor''s details before moving it to this stage' using errcode = '22023';
  end;
  return jsonb_build_object('id', p_vendor_id, 'status', p_status);
end;
$$;

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
  if not (v_admin or public.vendors_can('view_all')) then
    raise exception 'VENDORS_FORBIDDEN: not available to this account' using errcode = '42501';
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
          select v.id, v.company_name, v.status,
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
          select v.id, v.company_name, v.status,
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

-- ═══ 5. Self-assertions ═════════════════════════════════════════════════════
do $$
declare
  v_n integer;
begin
  select count(*) into v_n
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'vendors';
  if v_n <> 6 then
    raise exception 'vendors must register exactly 6 actions (got %)', v_n;
  end if;
  if exists (
    select 1 from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'vendors'
    where mpa.default_allowed
  ) then
    raise exception 'every vendors action must be deny-by-default';
  end if;
  if exists (
    select 1 from public.employee_permission_overrides epo
    join public.permission_modules pm on pm.id = epo.module_id and pm.module_key = 'vendors'
    join public.permission_actions pa on pa.id = epo.action_id
    where epo.allowed and pa.action_key in ('approve', 'export', 'view_all')
  ) then
    raise exception 'this migration must not hand out approve, export or view_all to anybody';
  end if;
end $$;
