-- Exhibition management — Admin adds and maintains exhibitions.
--
-- WHAT THIS IS
-- ------------
-- 20270305000000 seeded one exhibition and gave Admin no way to add another, so
-- on a database without that row (or once the fair is over) the form could only
-- say "ask Admin" with nothing for Admin to do. This adds the missing door:
--
--   create_exhibition()      Admin adds an exhibition (name, city, dates).
--   update_exhibition()      Admin renames it, corrects its dates, or closes /
--                            re-opens it for new leads.
--   list_exhibitions_admin() Admin's list, with how many leads each holds.
--
-- RULES
-- -----
--   * Admin only, and the check is inside each function (exhibition_leads_actor()
--     resolves the caller from auth.uid(), no identity is a parameter).
--   * Closed (is_active = false) exhibitions take no NEW leads — create_exhibition_lead
--     already refuses them — but they stay readable, and so do their leads, their
--     ranking and their export. Closing never deletes or hides anything.
--   * Therefore every module user may now READ every exhibition row (the module
--     gate still applies). Before, a closed exhibition vanished from a
--     salesperson's list together with the leads they had collected at it.
--   * A name is unique (case and surrounding spaces ignored); the slug is derived
--     from it and made unique.
--   * An exhibition spans at most 31 days: the ranking draws one column per day.
--   * Nothing is ever deleted here.
--
-- ROLLBACK: drop the three functions; drop the exhibitions_span_max constraint
-- and exhibitions_name_unique index; drop column created_by; recreate the
-- exhibitions_select policy as `using (is_active)`.

do $$
begin
  if to_regclass('public.exhibitions') is null
     or to_regprocedure('public.exhibition_leads_actor()') is null then
    raise exception 'DEPENDENCY MISSING: 20270305000000_exhibition_leads.sql must be applied first';
  end if;
end $$;

alter table public.exhibitions
  add column created_by uuid references public.users(id);

alter table public.exhibitions
  add constraint exhibitions_span_max check (ends_on - starts_on <= 30);

create unique index exhibitions_name_unique on public.exhibitions (lower(btrim(name)));

-- Closed exhibitions stay readable (the restrictive module gate still applies).
drop policy exhibitions_select on public.exhibitions;
create policy exhibitions_select on public.exhibitions
  for select to authenticated using (true);

-- ═══ Functions ══════════════════════════════════════════════════════════════

create or replace function public.create_exhibition(
  p_name text, p_city text, p_starts_on date, p_ends_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_name  text := btrim(coalesce(p_name, ''));
  v_city  text := nullif(btrim(coalesce(p_city, '')), '');
  v_base  text;
  v_slug  text;
  v_n     integer := 1;
  v_id    uuid;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  if v_name = '' or length(v_name) > 120 then
    raise exception 'EXHIBITION_LEADS_INVALID: Enter the exhibition name (up to 120 characters)' using errcode = '22023';
  end if;
  if length(coalesce(v_city, '')) > 80 then
    raise exception 'EXHIBITION_LEADS_INVALID: The city is too long' using errcode = '22023';
  end if;
  if p_starts_on is null or p_ends_on is null then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose the first and last day' using errcode = '22023';
  end if;
  if p_ends_on < p_starts_on then
    raise exception 'EXHIBITION_LEADS_INVALID: The last day cannot be before the first day' using errcode = '22023';
  end if;
  if p_ends_on - p_starts_on > 30 then
    raise exception 'EXHIBITION_LEADS_INVALID: An exhibition can run for at most 31 days' using errcode = '22023';
  end if;

  v_base := left(btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-'), 56);
  if length(v_base) < 2 then v_base := coalesce(nullif(v_base, ''), 'x') || '-fair'; end if;
  v_slug := v_base;
  while exists (select 1 from public.exhibitions e where e.slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;

  begin
    insert into public.exhibitions (slug, name, city, starts_on, ends_on, created_by)
    values (v_slug, v_name, v_city, p_starts_on, p_ends_on, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'EXHIBITION_LEADS_INVALID: An exhibition with this name already exists' using errcode = '22023';
  end;

  return jsonb_build_object('id', v_id, 'slug', v_slug);
end;
$$;

revoke all on function public.create_exhibition(text, text, date, date) from public, anon;
grant execute on function public.create_exhibition(text, text, date, date) to authenticated;

create or replace function public.update_exhibition(
  p_id uuid, p_name text, p_city text, p_starts_on date, p_ends_on date, p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
  v_name  text := btrim(coalesce(p_name, ''));
  v_city  text := nullif(btrim(coalesce(p_city, '')), '');
  v_old   public.exhibitions;
begin
  select a.p_is_admin into v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  select * into v_old from public.exhibitions e where e.id = p_id for update;
  if not found then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Exhibition not found' using errcode = 'P0002';
  end if;
  if v_name = '' or length(v_name) > 120 then
    raise exception 'EXHIBITION_LEADS_INVALID: Enter the exhibition name (up to 120 characters)' using errcode = '22023';
  end if;
  if length(coalesce(v_city, '')) > 80 then
    raise exception 'EXHIBITION_LEADS_INVALID: The city is too long' using errcode = '22023';
  end if;
  if p_starts_on is null or p_ends_on is null then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose the first and last day' using errcode = '22023';
  end if;
  if p_ends_on < p_starts_on then
    raise exception 'EXHIBITION_LEADS_INVALID: The last day cannot be before the first day' using errcode = '22023';
  end if;
  if p_ends_on - p_starts_on > 30 then
    raise exception 'EXHIBITION_LEADS_INVALID: An exhibition can run for at most 31 days' using errcode = '22023';
  end if;
  if p_is_active is null then
    raise exception 'EXHIBITION_LEADS_INVALID: Say whether it is open for new leads' using errcode = '22023';
  end if;

  begin
    update public.exhibitions e
       set name = v_name, city = v_city, starts_on = p_starts_on, ends_on = p_ends_on, is_active = p_is_active
     where e.id = p_id;
  exception when unique_violation then
    raise exception 'EXHIBITION_LEADS_INVALID: An exhibition with this name already exists' using errcode = '22023';
  end;
  return jsonb_build_object('id', p_id);
end;
$$;

revoke all on function public.update_exhibition(uuid, text, text, date, date, boolean) from public, anon;
grant execute on function public.update_exhibition(uuid, text, text, date, date, boolean) to authenticated;

create or replace function public.list_exhibitions_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
begin
  select a.p_is_admin into v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', e.id, 'slug', e.slug, 'name', e.name, 'city', e.city,
        'starts_on', e.starts_on, 'ends_on', e.ends_on, 'is_active', e.is_active,
        'leads', (select count(*) from public.exhibition_leads l where l.exhibition_id = e.id and l.archived_at is null),
        'archived', (select count(*) from public.exhibition_leads l where l.exhibition_id = e.id and l.archived_at is not null))
      order by e.starts_on desc, e.name)
    from public.exhibitions e), '[]'::jsonb);
end;
$$;

revoke all on function public.list_exhibitions_admin() from public, anon;
grant execute on function public.list_exhibitions_admin() to authenticated;

-- A lead now carries its exhibition's name, so a list that spans exhibitions can
-- say which one each lead belongs to. Same function, one more key; still callable
-- by nobody but the other definer functions.
create or replace function public.exhibition_lead_json(p_lead_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_lead.id,
    'exhibition_id', p_lead.exhibition_id,
    'exhibition_name', (select e.name from public.exhibitions e where e.id = p_lead.exhibition_id),
    'contact_name', p_lead.contact_name,
    'phone', p_lead.phone_e164,
    'client_type', p_lead.client_type,
    'client_type_other', p_lead.client_type_other,
    'requirements', to_jsonb(p_lead.requirements),
    'company_name', p_lead.company_name,
    'project_city', p_lead.project_city,
    'buying_timeline', p_lead.buying_timeline,
    'lead_type', p_lead.lead_type,
    'status', p_lead.status,
    'next_follow_up_on', p_lead.next_follow_up_on,
    'initial_note', p_lead.initial_note,
    'collected_by', p_lead.collected_by,
    'collected_by_name', (select u.full_name from public.users u where u.id = p_lead.collected_by),
    'owner_id', p_lead.owner_id,
    'owner_name', (select u.full_name from public.users u where u.id = p_lead.owner_id),
    'created_at', p_lead.created_at,
    'updated_at', p_lead.updated_at,
    'archived_at', p_lead.archived_at,
    'archive_reason', p_lead.archive_reason,
    'latest_note', (
      select e.note from public.exhibition_lead_events e
      where e.lead_id = p_lead.id and e.event_type = 'note'
      order by e.created_at desc, e.id desc limit 1),
    'latest_note_at', (
      select e.created_at from public.exhibition_lead_events e
      where e.lead_id = p_lead.id and e.event_type = 'note'
      order by e.created_at desc, e.id desc limit 1)
  )
  from public.exhibition_leads p_lead where p_lead.id = p_lead_id;
$$;

revoke all on function public.exhibition_lead_json(uuid) from public, anon, authenticated;

-- ═══ Executed self-check ════════════════════════════════════════════════════
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.create_exhibition(text,text,date,date)',
    'public.update_exhibition(uuid,text,text,date,date,boolean)',
    'public.list_exhibitions_admin()'
  ] loop
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'EXHIBITION_MANAGEMENT_ACL: wrong execute grants on %', v_fn;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.exhibition_lead_json(uuid)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.exhibition_lead_json(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'EXHIBITION_MANAGEMENT_ACL: exhibition_lead_json became callable by clients';
  end if;
  if has_table_privilege('authenticated', 'public.exhibitions', 'INSERT')
     or has_table_privilege('authenticated', 'public.exhibitions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.exhibitions', 'DELETE') then
    raise exception 'EXHIBITION_MANAGEMENT_ACL: exhibitions became writable by clients';
  end if;
end $$;
