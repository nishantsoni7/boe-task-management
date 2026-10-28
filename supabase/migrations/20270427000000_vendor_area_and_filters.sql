-- 20270427000000_vendor_area_and_filters.sql
--
-- Vendors: an Area (the locality in Jodhpur, e.g. Basni) and the filters the owner asked for on the vendor list:
-- capability, team size, area, products and registered / not registered.
--
--   * vendors.area            free text, one spelling per area (save_vendor reuses an existing spelling)
--   * vendor_list             also filters on team_sizes[] and areas[], returns each vendor's area, and returns the
--                             list of areas in use (for the Area filter and the form's suggestions)
--   * save_vendor, get_vendor carry the area
--
-- Re-issues three functions from 20270426000000 with only those changes; the LATEST definition wins.
--
-- ROLLBACK: re-apply the three functions from 20270426000000, then
--   drop index if exists public.vendors_area_idx;  alter table public.vendors drop column area;

do $$
begin
  if to_regclass('public.vendors') is null or to_regprocedure('public.vendor_list(jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: 20270426000000_vendor_management must be applied first';
  end if;
end $$;

alter table public.vendors
  add column if not exists area text check (area is null or length(btrim(area)) between 1 and 80);
create index if not exists vendors_area_idx on public.vendors (lower(area));

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
revoke all on function public.save_vendor(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_vendor(uuid, uuid, jsonb) to authenticated;

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
  v_products text[];
  v_team_sizes text[];
  v_areas    text[];
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
  if jsonb_typeof(p_filter -> 'products') = 'array' and jsonb_array_length(p_filter -> 'products') > 0 then
    v_products := array(select jsonb_array_elements_text(p_filter -> 'products'));
  end if;
  if jsonb_typeof(p_filter -> 'team_sizes') = 'array' and jsonb_array_length(p_filter -> 'team_sizes') > 0 then
    v_team_sizes := array(select jsonb_array_elements_text(p_filter -> 'team_sizes'));
  end if;
  if jsonb_typeof(p_filter -> 'areas') = 'array' and jsonb_array_length(p_filter -> 'areas') > 0 then
    v_areas := array(select jsonb_array_elements_text(p_filter -> 'areas'));
  end if;

  -- Every word typed must be found somewhere in the vendor (company, person, phone, city, address,
  -- product types, who recommended them): "teak jodhpur" finds a Jodhpur vendor that works in teak, in any order.
  if v_q is not null then
    v_terms := regexp_split_to_array(v_q, '\s+');
  end if;

  with pre as (
    select v.id, v.company_name, v.contact_name, v.phone_e164, v.status,
           v.area, v.capabilities, v.product_focus, v.team_size, v.created_at, v.archived_at,
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
                       v.address, v.area, v.notes))) = 0))
       and (v_caps is null or v.capabilities && v_caps)
       and (v_products is null or v.product_focus = any(v_products))
       and (v_team_sizes is null or v.team_size = any(v_team_sizes))
       and (v_areas is null or v.area = any(v_areas))
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
                    'phone', b.phone_e164, 'area', b.area, 'status', b.status,
                    'capabilities', b.capabilities, 'product_focus', b.product_focus, 'team_size', b.team_size,
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

  -- The areas in use, for the Area filter and the suggestions in the vendor form (every active vendor, whatever the filter).
  return jsonb_build_object('total', v_total, 'awaiting_count', v_wait, 'status_counts', v_counts, 'rows', v_rows,
    'areas', coalesce((select jsonb_agg(s.a order by s.a)
                         from (select distinct area as a from public.vendors where area is not null and archived_at is null) s), '[]'::jsonb));
end;
$$;
revoke all on function public.vendor_list(jsonb) from public, anon;
grant execute on function public.vendor_list(jsonb) to authenticated;

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
      'phone', v_vendor.phone_e164, 'address', v_vendor.address, 'area', v_vendor.area,
      'latitude', v_vendor.latitude, 'longitude', v_vendor.longitude,
      'capabilities', v_vendor.capabilities, 'product_focus', v_vendor.product_focus, 'team_size', v_vendor.team_size,
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

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendors' and column_name = 'area') then
    raise exception 'VENDOR_AREA: the area column is missing';
  end if;
  if position('v_team_sizes' in pg_get_functiondef('public.vendor_list(jsonb)'::regprocedure)) = 0 then
    raise exception 'VENDOR_AREA: vendor_list was not updated';
  end if;
end $$;
