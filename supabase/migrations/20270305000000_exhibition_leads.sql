-- Exhibition Leads — capture visitors at a trade fair and follow them up.
--
-- WHAT THIS IS
-- ------------
-- A small, isolated module: a quick-entry lead form, a per-person working list,
-- a follow-up trail, an Admin overview, and a fair-credit ranking. First
-- exhibition: Acetech Bangalore 2026 (9–11 October 2026, Bengaluru). It touches
-- nothing in tasks, orders, payments, attendance or performance scoring.
--
-- ACCESS MODEL
-- ------------
--   * The module is `exhibition_leads` on the permission engine. `view` opens it
--     and lets the holder add leads and work the leads they currently own.
--     Admin (users.role = 'admin') bypasses the engine, like every module.
--     Sales is granted at department level below; Control Center can change it.
--   * Every table is read-only to the browser and gated by module_entry_open().
--     EVERY WRITE GOES THROUGH A SECURITY DEFINER FUNCTION that derives the actor
--     from auth.uid(). No function takes an actor id from the caller.
--   * A salesperson sees and edits only leads they currently OWN. Admin sees all.
--   * collected_by (the ranking credit), exhibition_id, created_at and
--     submission_id never change after insert — a trigger enforces it even for
--     a privileged writer. owner_id changes only through reassign.
--
-- DUPLICATES AND RETRIES
-- ----------------------
--   * One ACTIVE lead per normalised mobile number per exhibition: a partial
--     unique index, so simultaneous submissions cannot both succeed. Archived
--     leads do not hold the number; restore re-checks it.
--   * submission_id is minted by the form and is UNIQUE. A retry of the same
--     submission returns the original row ('replayed') instead of a second one.
--   * A duplicate answer never carries another person's lead: for a lead owned
--     by someone else it returns the status only, no id, no name.
--
-- TIME
-- ----
-- Every "day" is Asia/Kolkata. created_at is server time (now()).
--
-- ROLLBACK
-- --------
-- drop function ... (all exhibition_lead* functions); drop table
-- public.exhibition_lead_events, public.exhibition_leads, public.exhibitions;
-- delete from public.department_permissions / role_permissions /
-- module_permission_actions / permission_modules / app_modules where
-- module_key = 'exhibition_leads'. Nothing else references these objects.

do $$
begin
  if to_regclass('public.users') is null
     or to_regprocedure('public.module_entry_open(text)') is null
     or to_regprocedure('public.resolve_permission(uuid,text,text)') is null
     or to_regprocedure('public.set_updated_at()') is null then
    raise exception 'DEPENDENCY MISSING: users, module_entry_open, resolve_permission and set_updated_at must exist';
  end if;
end $$;

-- ═══ 1. Control Center registration ═════════════════════════════════════════
-- Mirrors src/lib/permissions/modules.ts exactly (npm run permissions:check).

insert into public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
values
  ('exhibition_leads', 'Exhibition Leads',
   'Capture visitors at an exhibition and follow them up afterwards.',
   '/exhibition-leads', 'live', null, 100)
on conflict (module_key) do nothing;

insert into public.permission_modules (module_key, display_name, description) values
  ('exhibition_leads', 'Exhibition Leads',
   'Capture visitors at an exhibition and follow them up afterwards.')
on conflict (module_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view'
where pm.module_key = 'exhibition_leads'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'exhibition_leads'
on conflict (role, module_id, action_id) do nothing;

-- The Sales department may use the module. This is an ordinary department rule:
-- Control Center can remove it, and an employee override can still win.
insert into public.department_permissions (department_id, module_id, action_id, allowed)
select d.id, pm.id, pa.id, true
from public.departments d
join public.permission_modules pm on pm.module_key = 'exhibition_leads'
join public.permission_actions pa on pa.action_key = 'view'
where d.department_key = 'sales'
on conflict (department_id, module_id, action_id) do nothing;

-- ═══ 2. Tables ══════════════════════════════════════════════════════════════

create table public.exhibitions (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name       text not null check (length(btrim(name)) between 1 and 120),
  city       text,
  starts_on  date not null,
  ends_on    date not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  constraint exhibitions_dates_ordered check (ends_on >= starts_on)
);

insert into public.exhibitions (slug, name, city, starts_on, ends_on)
values ('acetech-bangalore-2026', 'Acetech Bangalore 2026', 'Bengaluru', date '2026-10-09', date '2026-10-11')
on conflict (slug) do nothing;

create table public.exhibition_leads (
  id                uuid primary key default gen_random_uuid(),
  exhibition_id     uuid not null references public.exhibitions(id),
  -- Minted by the form; makes a retry of one entry idempotent.
  submission_id     uuid not null unique,
  -- md5 of the saved details. A retry must carry the SAME details; a reused id
  -- with different ones is refused, never answered with the old row as if it
  -- were the new one.
  submission_fingerprint text not null,
  contact_name      text not null check (length(btrim(contact_name)) between 1 and 120),
  -- Canonical '+<digits>' — see normalize_lead_phone().
  phone_e164        text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  client_type       text not null check (client_type in (
                      'architect_designer','property_owner','consultant','other')),
  -- "Other" must say what: the message is required exactly when client_type = 'other'.
  client_type_other text check (client_type_other is null or length(btrim(client_type_other)) between 1 and 200),
  requirements      text[] not null check (
                      cardinality(requirements) between 1 and 2
                      and requirements <@ array['restaurant_cafe','hotel']::text[]),
  company_name      text check (company_name is null or length(company_name) <= 160),
  project_city      text check (project_city is null or length(project_city) <= 80),
  buying_timeline   text check (buying_timeline is null or buying_timeline in (
                      'within_1_month','1_3_months','3_6_months','later','not_sure')),
  -- Lead Type: mandatory, no default — the salesperson judges every lead.
  lead_type         text not null check (lead_type in (
                      'hot','warm','long_term','mismatched_retail')),
  status            text not null default 'new' check (status in (
                      'new','contacted','quotation_sent','follow_up','converted','not_proceeding')),
  next_follow_up_on date,
  initial_note      text check (initial_note is null or length(initial_note) <= 2000),
  -- Immutable: the fair-ranking credit.
  collected_by      uuid not null references public.users(id),
  owner_id          uuid not null references public.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,
  archived_by       uuid references public.users(id),
  archive_reason    text check (archive_reason is null or length(archive_reason) between 3 and 500),
  -- A closed lead has no live schedule; a Follow-up lead always has one.
  constraint exhibition_leads_other_has_message
    check ((client_type = 'other') = (client_type_other is not null)),
  constraint exhibition_leads_terminal_has_no_schedule
    check (status not in ('converted','not_proceeding') or next_follow_up_on is null),
  constraint exhibition_leads_follow_up_has_date
    check (status <> 'follow_up' or next_follow_up_on is not null),
  constraint exhibition_leads_archive_consistent
    check ((archived_at is null) = (archive_reason is null) and (archived_at is null) = (archived_by is null))
);

-- One ACTIVE lead per number per exhibition. Atomic: the second concurrent
-- insert blocks on this index and then sees the first row.
create unique index exhibition_leads_one_active_phone
  on public.exhibition_leads (exhibition_id, phone_e164)
  where archived_at is null;

-- "My Leads" and the Admin list: exhibition + newest first.
create index exhibition_leads_owner_idx
  on public.exhibition_leads (owner_id, exhibition_id, created_at desc);
create index exhibition_leads_exhibition_created_idx
  on public.exhibition_leads (exhibition_id, created_at desc);

create trigger exhibition_leads_set_updated_at
  before update on public.exhibition_leads
  for each row execute function public.set_updated_at();

create table public.exhibition_lead_events (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.exhibition_leads(id),
  event_type text not null check (event_type in (
               'created','details_edited','status_changed','follow_up_changed',
               'note','reassigned','archived','restored')),
  actor_id   uuid not null references public.users(id),
  note       text check (note is null or length(note) <= 2000),
  -- Field NAMES and ids/dates only — never a phone number.
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index exhibition_lead_events_lead_idx
  on public.exhibition_lead_events (lead_id, created_at desc);

-- ═══ 3. Guard triggers ══════════════════════════════════════════════════════

create or replace function public.exhibition_leads_guard_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id            is distinct from old.id
     or new.collected_by  is distinct from old.collected_by
     or new.exhibition_id is distinct from old.exhibition_id
     or new.created_at    is distinct from old.created_at
     or new.submission_id is distinct from old.submission_id then
    raise exception 'EXHIBITION_LEADS_IMMUTABLE: collector, exhibition, creation time and submission id cannot change'
      using errcode = '42501';
  end if;
  if new.owner_id is distinct from old.owner_id
     and coalesce(current_setting('exhibition_leads.reassigning', true), '') <> 'on' then
    raise exception 'EXHIBITION_LEADS_IMMUTABLE: the owner changes only through reassignment'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger exhibition_leads_guard_immutable
  before update on public.exhibition_leads
  for each row execute function public.exhibition_leads_guard_immutable();

create or replace function public.exhibition_lead_events_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'EXHIBITION_LEADS_APPEND_ONLY: the activity history cannot be changed'
    using errcode = '42501';
end;
$$;

-- Trigger functions are never called directly; Supabase's default privileges
-- would otherwise leave them executable by anon and authenticated.
revoke all on function public.exhibition_leads_guard_immutable() from public, anon, authenticated;
revoke all on function public.exhibition_lead_events_append_only() from public, anon, authenticated;

create trigger exhibition_lead_events_append_only
  before update or delete on public.exhibition_lead_events
  for each row execute function public.exhibition_lead_events_append_only();

-- ═══ 4. Row-level security: read-only to the browser ════════════════════════

alter table public.exhibitions           enable row level security;
alter table public.exhibition_leads      enable row level security;
alter table public.exhibition_lead_events enable row level security;

revoke all on public.exhibitions, public.exhibition_leads, public.exhibition_lead_events
  from anon, authenticated, public;
grant select on public.exhibitions, public.exhibition_leads, public.exhibition_lead_events
  to authenticated;

create policy exhibitions_select on public.exhibitions
  for select to authenticated using (is_active);

create policy exhibition_leads_select on public.exhibition_leads
  for select to authenticated
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- Visible exactly when the parent lead is (its own RLS applies to the subquery).
create policy exhibition_lead_events_select on public.exhibition_lead_events
  for select to authenticated
  using (exists (select 1 from public.exhibition_leads l where l.id = lead_id));

-- The parent gate, AND-ed with the policies above (20260905000000).
create policy exhibitions_module_entry_gate on public.exhibitions
  as restrictive for all to authenticated
  using (public.module_entry_open('exhibition_leads'))
  with check (public.module_entry_open('exhibition_leads'));
create policy exhibition_leads_module_entry_gate on public.exhibition_leads
  as restrictive for all to authenticated
  using (public.module_entry_open('exhibition_leads'))
  with check (public.module_entry_open('exhibition_leads'));
create policy exhibition_lead_events_module_entry_gate on public.exhibition_lead_events
  as restrictive for all to authenticated
  using (public.module_entry_open('exhibition_leads'))
  with check (public.module_entry_open('exhibition_leads'));

-- ═══ 5. Helpers ═════════════════════════════════════════════════════════════

-- Canonical '+<digits>' or NULL when the number cannot be valid.
--   '+…' / '00…'      international, as typed (E.164: 8–15 digits, no leading 0)
--   10 digits         Indian national number → +91
--   0 + 10 digits     Indian trunk form → +91
--   91 + 10 digits    Indian number without '+'
-- An Indian number must be 10 digits starting 6–9; nothing else is checked for
-- other countries (no ten-digit rule on international numbers).
create or replace function public.normalize_lead_phone(p_raw text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := regexp_replace(coalesce(p_raw, ''), '[\s().\-]', '', 'g');
  d text;
begin
  if v = '' then return null; end if;
  if left(v, 1) = '+' then
    d := substr(v, 2);
  elsif left(v, 2) = '00' then
    d := substr(v, 3);
  elsif v ~ '^[0-9]{10}$' then
    d := '91' || v;
  elsif v ~ '^0[0-9]{10}$' then
    d := '91' || substr(v, 2);
  elsif v ~ '^91[0-9]{10}$' then
    d := v;
  else
    return null;
  end if;
  if d !~ '^[0-9]+$' then return null; end if;
  -- "+91 0 98765 43210": a trunk zero after the country code.
  if d ~ '^910[0-9]{10}$' then d := '91' || substr(d, 4); end if;
  if d !~ '^[1-9][0-9]{7,14}$' then return null; end if;
  if left(d, 2) = '91' and d !~ '^91[6-9][0-9]{9}$' then return null; end if;
  return '+' || d;
end;
$$;

revoke all on function public.normalize_lead_phone(text) from public, anon;
grant execute on function public.normalize_lead_phone(text) to authenticated;

-- Internal: who may use the module and be given leads. Not callable by clients.
create or replace function public.exhibition_leads_user_eligible(p_uid uuid)
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
      and (u.role = 'admin' or public.resolve_permission(u.id, 'exhibition_leads', 'view'))
  );
$$;

revoke all on function public.exhibition_leads_user_eligible(uuid) from public, anon, authenticated;

-- Internal: the signed-in actor, or an exception. Returns (uid, is_admin).
create or replace function public.exhibition_leads_actor(out p_uid uuid, out p_is_admin boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  p_uid := auth.uid();
  if p_uid is null or not public.exhibition_leads_user_eligible(p_uid) then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Exhibition Leads is not available to this account'
      using errcode = '42501';
  end if;
  select (u.role = 'admin') into p_is_admin from public.users u where u.id = p_uid;
end;
$$;

revoke all on function public.exhibition_leads_actor() from public, anon, authenticated;

create or replace function public.exhibition_leads_text_array(p_filter jsonb, p_key text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when jsonb_typeof(p_filter -> p_key) = 'array'
         and jsonb_array_length(p_filter -> p_key) > 0
    then array(select jsonb_array_elements_text(p_filter -> p_key))
  end;
$$;

revoke all on function public.exhibition_leads_text_array(jsonb, text) from public, anon, authenticated;

-- The ONE filter, shared by the list, the counts, the summary and the export so
-- they can never disagree. Categories combine with AND; values inside one
-- category with OR. A non-admin is forced to their own, active leads whatever
-- the filter says.
create or replace function public.exhibition_leads_filtered(
  p_uid uuid, p_is_admin boolean, p_filter jsonb
)
returns setof public.exhibition_leads
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_exh      uuid := nullif(p_filter ->> 'exhibition_id', '')::uuid;
  v_from     date := nullif(p_filter ->> 'date_from', '')::date;
  v_to       date := nullif(p_filter ->> 'date_to', '')::date;
  v_search   text := nullif(btrim(coalesce(p_filter ->> 'search', '')), '');
  v_like     text;
  v_digits   text;
  v_mine     boolean := not p_is_admin or coalesce(p_filter ->> 'scope', 'mine') = 'mine';
  v_arch     text := case when p_is_admin then coalesce(p_filter ->> 'archived', 'active') else 'active' end;
  v_types    text[] := public.exhibition_leads_text_array(p_filter, 'client_types');
  v_reqs     text[] := public.exhibition_leads_text_array(p_filter, 'requirements');
  v_cities   text[] := public.exhibition_leads_text_array(p_filter, 'cities');
  v_times    text[] := public.exhibition_leads_text_array(p_filter, 'timelines');
  v_ltypes   text[] := public.exhibition_leads_text_array(p_filter, 'lead_types');
  v_stats    text[] := public.exhibition_leads_text_array(p_filter, 'statuses');
  v_fups     text[] := public.exhibition_leads_text_array(p_filter, 'follow_ups');
  v_colls    uuid[] := case when p_is_admin then public.exhibition_leads_text_array(p_filter, 'collector_ids')::uuid[] end;
  v_owners   uuid[] := case when p_is_admin then public.exhibition_leads_text_array(p_filter, 'owner_ids')::uuid[] end;
begin
  if v_search is not null then
    v_like   := '%' || replace(replace(replace(lower(v_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits := regexp_replace(v_search, '\D', '', 'g');
    if length(v_digits) < 3 then v_digits := null; end if;
  end if;

  return query
  select l.*
  from public.exhibition_leads l
  where (v_exh is null or l.exhibition_id = v_exh)
    and (not v_mine or l.owner_id = p_uid)
    and (v_arch = 'all'
         or (v_arch = 'archived' and l.archived_at is not null)
         or (v_arch <> 'archived' and l.archived_at is null))
    and (v_from is null or l.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata'))
    and (v_to   is null or l.created_at <  ((v_to + 1)::timestamp at time zone 'Asia/Kolkata'))
    and (v_search is null
         or lower(l.contact_name) like v_like
         or lower(coalesce(l.company_name, '')) like v_like
         or (v_digits is not null and l.phone_e164 like '%' || v_digits || '%'))
    and (v_types  is null or l.client_type = any (v_types))
    and (v_reqs   is null or l.requirements && v_reqs)
    and (v_cities is null or lower(coalesce(l.project_city, '')) = any (select lower(c) from unnest(v_cities) c))
    and (v_times  is null or l.buying_timeline = any (v_times))
    and (v_ltypes is null or l.lead_type = any (v_ltypes))
    and (v_stats  is null or l.status = any (v_stats))
    and (v_fups   is null or (
          l.archived_at is null
          and l.status not in ('converted', 'not_proceeding')
          and (
            ('due_today'     = any (v_fups) and l.next_follow_up_on = v_today)
            or ('overdue'    = any (v_fups) and l.next_follow_up_on < v_today)
            or ('not_scheduled' = any (v_fups) and l.next_follow_up_on is null)
          )))
    and (v_colls  is null or l.collected_by = any (v_colls))
    and (v_owners is null or l.owner_id = any (v_owners));
end;
$$;

revoke all on function public.exhibition_leads_filtered(uuid, boolean, jsonb) from public, anon, authenticated;

-- One lead as JSON, with names resolved.
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

-- ═══ 6. Reads ═══════════════════════════════════════════════════════════════

-- One call returns the page, the matching total, the per-day counts and the
-- summary figures — all from the FULL matching set, never the loaded page.
create or replace function public.exhibition_leads_page(
  p_filter jsonb default '{}'::jsonb, p_limit integer default 25, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_limit   integer := greatest(0, least(coalesce(p_limit, 25), 100));
  v_offset  integer := greatest(0, coalesce(p_offset, 0));
  v_exh     uuid;
  v_result  jsonb;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  p_filter := coalesce(p_filter, '{}'::jsonb);
  v_exh := nullif(p_filter ->> 'exhibition_id', '')::uuid;

  with f as materialized (
    select * from public.exhibition_leads_filtered(v_uid, v_admin, p_filter)
  ),
  page as (
    select * from f order by created_at desc, id desc limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'date_counts', coalesce((
      select jsonb_agg(jsonb_build_object('date', d, 'count', n) order by d desc)
      from (select (created_at at time zone 'Asia/Kolkata')::date d, count(*) n from f group by 1) x), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(public.exhibition_lead_json(p.id) order by p.created_at desc, p.id desc) from page p), '[]'::jsonb),
    'summary', jsonb_build_object(
      'active_valid', (select count(*) from f where archived_at is null),
      'hot', (select count(*) from f where archived_at is null and lead_type = 'hot'),
      'overdue', (select count(*) from f
                   where archived_at is null
                     and status not in ('converted', 'not_proceeding')
                     and next_follow_up_on < v_today)
    ),
    'mine', jsonb_build_object(
      -- "My Leads" is what I currently own; "collected" is what I originally took.
      'owned_today', (select count(*) from public.exhibition_leads l
                       where l.owner_id = v_uid and l.archived_at is null
                         and (v_exh is null or l.exhibition_id = v_exh)
                         and l.created_at >= (v_today::timestamp at time zone 'Asia/Kolkata')
                         and l.created_at <  ((v_today + 1)::timestamp at time zone 'Asia/Kolkata')),
      'owned_total', (select count(*) from public.exhibition_leads l
                       where l.owner_id = v_uid and l.archived_at is null
                         and (v_exh is null or l.exhibition_id = v_exh)),
      'collected_total', (select count(*) from public.exhibition_leads l
                           where l.collected_by = v_uid and l.archived_at is null
                             and (v_exh is null or l.exhibition_id = v_exh))
    ),
    'cities', coalesce((
      select jsonb_agg(c order by c) from (
        select distinct l.project_city c from public.exhibition_leads l
        where l.project_city is not null
          and (v_admin or l.owner_id = v_uid)
          and (v_exh is null or l.exhibition_id = v_exh)) y), '[]'::jsonb),
    'today', v_today
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.exhibition_leads_page(jsonb, integer, integer) from public, anon;
grant execute on function public.exhibition_leads_page(jsonb, integer, integer) to authenticated;

create or replace function public.get_exhibition_lead(p_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_lead  public.exhibition_leads;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  select * into v_lead from public.exhibition_leads l where l.id = p_lead_id;
  if not found or not (v_admin or v_lead.owner_id = v_uid) then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Lead not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'lead', public.exhibition_lead_json(v_lead.id),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'note', e.note, 'detail', e.detail,
        'created_at', e.created_at, 'actor_id', e.actor_id,
        'actor_name', (select u.full_name from public.users u where u.id = e.actor_id))
        order by e.created_at desc, e.id desc)
      from public.exhibition_lead_events e where e.lead_id = v_lead.id), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_exhibition_lead(uuid) from public, anon;
grant execute on function public.get_exhibition_lead(uuid) to authenticated;

-- Admin: people for the reassign picker and the collector/owner filters.
create or replace function public.exhibition_lead_people(p_exhibition_id uuid default null)
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
    select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name, 'eligible', el.ok)
                     order by u.full_name)
    from public.users u
    cross join lateral (select public.exhibition_leads_user_eligible(u.id) ok) el
    where el.ok
       or exists (select 1 from public.exhibition_leads l
                  where (l.collected_by = u.id or l.owner_id = u.id)
                    and (p_exhibition_id is null or l.exhibition_id = p_exhibition_id))
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.exhibition_lead_people(uuid) from public, anon;
grant execute on function public.exhibition_lead_people(uuid) to authenticated;

-- Admin: the fair ranking. FULL exhibition data, independent of list filters.
-- Credit goes to the immutable collector; day = server created_at in IST;
-- only ACTIVE leads inside the exhibition's own dates count.
create or replace function public.exhibition_lead_ranking(p_exhibition_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
  v_exh   public.exhibitions;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select a.p_is_admin into v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  select * into v_exh from public.exhibitions e where e.id = p_exhibition_id;
  if not found then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Exhibition not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'exhibition', jsonb_build_object('id', v_exh.id, 'name', v_exh.name,
                                     'starts_on', v_exh.starts_on, 'ends_on', v_exh.ends_on),
    'today', v_today,
    'is_final', v_today > v_exh.ends_on,
    'days', (select jsonb_agg(d::date order by d) from generate_series(v_exh.starts_on, v_exh.ends_on, interval '1 day') d),
    'rows', coalesce((
      with credit as (
        select l.collected_by, (l.created_at at time zone 'Asia/Kolkata')::date d, count(*) n
        from public.exhibition_leads l
        where l.exhibition_id = v_exh.id
          and l.archived_at is null
          and (l.created_at at time zone 'Asia/Kolkata')::date between v_exh.starts_on and v_exh.ends_on
        group by 1, 2
      ),
      people as (
        select u.id, u.full_name from public.users u
        where (u.role <> 'admin' and public.exhibition_leads_user_eligible(u.id))
           or u.id in (select collected_by from credit)
      )
      select jsonb_agg(jsonb_build_object(
          'user_id', p.id,
          'name', p.full_name,
          'per_day', coalesce((select jsonb_object_agg(c.d::text, c.n) from credit c where c.collected_by = p.id), '{}'::jsonb),
          'total', coalesce((select sum(c.n) from credit c where c.collected_by = p.id), 0))
        order by coalesce((select sum(c.n) from credit c where c.collected_by = p.id), 0) desc, p.full_name)
      from people p), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.exhibition_lead_ranking(uuid) from public, anon;
grant execute on function public.exhibition_lead_ranking(uuid) to authenticated;

-- Admin: the export. Pages of the SAME filtered set, so an export is never
-- narrower or wider than the list that produced it.
create or replace function public.export_exhibition_leads(
  p_filter jsonb default '{}'::jsonb, p_limit integer default 1000, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(public.exhibition_lead_json(f.id) || jsonb_build_object(
        'exhibition_name', (select e.name from public.exhibitions e where e.id = f.exhibition_id))
        order by f.created_at desc, f.id desc)
    from (
      select * from public.exhibition_leads_filtered(v_uid, v_admin, coalesce(p_filter, '{}'::jsonb))
      order by created_at desc, id desc
      limit greatest(1, least(coalesce(p_limit, 1000), 1000)) offset greatest(0, coalesce(p_offset, 0))
    ) f), '[]'::jsonb);
end;
$$;

revoke all on function public.export_exhibition_leads(jsonb, integer, integer) from public, anon;
grant execute on function public.export_exhibition_leads(jsonb, integer, integer) to authenticated;

-- ═══ 7. Writes ══════════════════════════════════════════════════════════════

create or replace function public.create_exhibition_lead(
  p_submission_id   uuid,
  p_exhibition_id   uuid,
  p_contact_name    text,
  p_phone           text,
  p_client_type     text,
  p_requirements    text[],
  p_company_name    text default null,
  p_project_city    text default null,
  p_buying_timeline text default null,
  p_lead_type       text default null,
  p_note            text default null,
  p_client_type_other text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_phone   text;
  v_name    text := btrim(coalesce(p_contact_name, ''));
  v_company text := nullif(btrim(coalesce(p_company_name, '')), '');
  v_city    text := nullif(btrim(coalesce(p_project_city, '')), '');
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_lead    text := nullif(btrim(coalesce(p_lead_type, '')), '');
  v_other   text := nullif(btrim(coalesce(p_client_type_other, '')), '');
  v_id      uuid;
  v_fp      text;
  v_existing public.exhibition_leads;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;

  if p_submission_id is null then
    raise exception 'EXHIBITION_LEADS_INVALID: A submission id is required' using errcode = '22023';
  end if;
  if v_name = '' then
    raise exception 'EXHIBITION_LEADS_INVALID: Enter the contact name' using errcode = '22023';
  end if;
  v_phone := public.normalize_lead_phone(p_phone);
  if v_phone is null then
    raise exception 'EXHIBITION_LEADS_INVALID: Enter a valid mobile number' using errcode = '22023';
  end if;
  if p_client_type is null or p_client_type not in
     ('architect_designer','property_owner','consultant','other') then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose a client type' using errcode = '22023';
  end if;
  if p_client_type = 'other' then
    if v_other is null then
      raise exception 'EXHIBITION_LEADS_INVALID: Say what kind of client this is' using errcode = '22023';
    end if;
  else
    v_other := null;
  end if;
  if length(coalesce(v_other, '')) > 200 then
    raise exception 'EXHIBITION_LEADS_INVALID: The client description is too long' using errcode = '22023';
  end if;
  if p_requirements is null or cardinality(p_requirements) = 0 then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose at least one requirement' using errcode = '22023';
  end if;
  if not (p_requirements <@ array['restaurant_cafe','hotel']::text[]) then
    raise exception 'EXHIBITION_LEADS_INVALID: Unknown requirement' using errcode = '22023';
  end if;
  if length(v_name) > 120 or length(coalesce(v_company, '')) > 160
     or length(coalesce(v_city, '')) > 80 or length(coalesce(v_note, '')) > 2000 then
    raise exception 'EXHIBITION_LEADS_INVALID: A field is too long' using errcode = '22023';
  end if;
  if p_buying_timeline is not null and p_buying_timeline not in
     ('within_1_month','1_3_months','3_6_months','later','not_sure') then
    raise exception 'EXHIBITION_LEADS_INVALID: Unknown buying timeline' using errcode = '22023';
  end if;
  if v_lead is null then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose a lead type' using errcode = '22023';
  end if;
  if v_lead not in ('hot','warm','long_term','mismatched_retail') then
    raise exception 'EXHIBITION_LEADS_INVALID: Unknown lead type' using errcode = '22023';
  end if;
  if not exists (select 1 from public.exhibitions e where e.id = p_exhibition_id and e.is_active) then
    raise exception 'EXHIBITION_LEADS_INVALID: Unknown exhibition' using errcode = '22023';
  end if;

  v_fp := md5(concat_ws('|', p_exhibition_id, v_name, v_phone, p_client_type,
                        array_to_string(array(select r from unnest(p_requirements) r order by r), ','),
                        coalesce(v_company, ''), coalesce(v_city, ''), coalesce(p_buying_timeline, ''),
                        coalesce(v_lead, ''), coalesce(v_other, ''), coalesce(v_note, '')));

  -- Retry of an entry we already stored: answer with it, change nothing — and
  -- only when it really is the same entry.
  select * into v_existing from public.exhibition_leads l where l.submission_id = p_submission_id;
  if found then
    if v_existing.collected_by <> v_uid then
      raise exception 'EXHIBITION_LEADS_INVALID: Submission id already used' using errcode = '22023';
    end if;
    if v_existing.submission_fingerprint <> v_fp then
      raise exception 'EXHIBITION_LEADS_SUBMISSION_CONFLICT: This submission id was already saved with different details'
        using errcode = '22023';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'lead_id', v_existing.id);
  end if;

  -- DO NOTHING covers both unique indexes; whichever fired is told apart below.
  insert into public.exhibition_leads
    (exhibition_id, submission_id, submission_fingerprint, contact_name, phone_e164, client_type, client_type_other,
     requirements, company_name, project_city, buying_timeline, lead_type, initial_note, collected_by, owner_id)
  values
    (p_exhibition_id, p_submission_id, v_fp, v_name, v_phone, p_client_type, v_other,
     p_requirements, v_company, v_city, p_buying_timeline, v_lead, v_note, v_uid, v_uid)
  on conflict do nothing
  returning id into v_id;

  if v_id is not null then
    insert into public.exhibition_lead_events (lead_id, event_type, actor_id)
    values (v_id, 'created', v_uid);
    return jsonb_build_object('outcome', 'created', 'lead_id', v_id);
  end if;

  -- Same submission won a race against us.
  select * into v_existing from public.exhibition_leads l where l.submission_id = p_submission_id;
  if found then
    if v_existing.collected_by <> v_uid or v_existing.submission_fingerprint <> v_fp then
      raise exception 'EXHIBITION_LEADS_SUBMISSION_CONFLICT: This submission id was already saved with different details'
        using errcode = '22023';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'lead_id', v_existing.id);
  end if;

  -- The number is already held by an active lead.
  select * into v_existing from public.exhibition_leads l
   where l.exhibition_id = p_exhibition_id and l.phone_e164 = v_phone and l.archived_at is null;
  if found and (v_admin or v_existing.owner_id = v_uid) then
    return jsonb_build_object('outcome', 'duplicate', 'lead_id', v_existing.id, 'mine', true);
  end if;
  -- Someone else's lead: the fact only. No id, no name, no detail.
  return jsonb_build_object('outcome', 'duplicate', 'mine', false);
end;
$$;

revoke all on function public.create_exhibition_lead(uuid, uuid, text, text, text, text[], text, text, text, text, text, text) from public, anon;
grant execute on function public.create_exhibition_lead(uuid, uuid, text, text, text, text[], text, text, text, text, text, text) to authenticated;

-- Edit details / status / follow-up date and/or add a note, in one transaction.
-- p_changes may hold: contact_name, phone, client_type, client_type_other, requirements,
-- company_name, project_city, buying_timeline, lead_type, status,
-- next_follow_up_on (null clears). Unknown keys are refused.
create or replace function public.update_exhibition_lead(
  p_lead_id uuid, p_changes jsonb default '{}'::jsonb, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_old     public.exhibition_leads;
  v_new     public.exhibition_leads;
  v_key     text;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_fields  text[] := '{}';
  v_terminal boolean;
  v_changed boolean := false;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  p_changes := coalesce(p_changes, '{}'::jsonb);
  if jsonb_typeof(p_changes) <> 'object' then
    raise exception 'EXHIBITION_LEADS_INVALID: Changes must be an object' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('contact_name','phone','client_type','client_type_other','requirements','company_name',
                     'project_city','buying_timeline','lead_type','status','next_follow_up_on') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown field' using errcode = '22023';
    end if;
  end loop;
  if length(coalesce(v_note, '')) > 2000 then
    raise exception 'EXHIBITION_LEADS_INVALID: The note is too long' using errcode = '22023';
  end if;

  select * into v_old from public.exhibition_leads l where l.id = p_lead_id for update;
  if not found or not (v_admin or v_old.owner_id = v_uid) then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Lead not found' using errcode = 'P0002';
  end if;
  if v_old.archived_at is not null then
    raise exception 'EXHIBITION_LEADS_ARCHIVED: An archived lead cannot be changed' using errcode = '55000';
  end if;

  v_new := v_old;

  if p_changes ? 'contact_name' then
    v_new.contact_name := btrim(coalesce(p_changes ->> 'contact_name', ''));
    if v_new.contact_name = '' or length(v_new.contact_name) > 120 then
      raise exception 'EXHIBITION_LEADS_INVALID: Enter the contact name' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'phone' then
    v_new.phone_e164 := public.normalize_lead_phone(p_changes ->> 'phone');
    if v_new.phone_e164 is null then
      raise exception 'EXHIBITION_LEADS_INVALID: Enter a valid mobile number' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'client_type' then
    v_new.client_type := p_changes ->> 'client_type';
    if v_new.client_type is null or v_new.client_type not in
       ('architect_designer','property_owner','consultant','other') then
      raise exception 'EXHIBITION_LEADS_INVALID: Choose a client type' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'client_type_other' then
    v_new.client_type_other := nullif(btrim(coalesce(p_changes ->> 'client_type_other', '')), '');
  end if;
  -- The message exists exactly when the type is Other, and is then required.
  if v_new.client_type = 'other' then
    if v_new.client_type_other is null then
      raise exception 'EXHIBITION_LEADS_INVALID: Say what kind of client this is' using errcode = '22023';
    end if;
    if length(v_new.client_type_other) > 200 then
      raise exception 'EXHIBITION_LEADS_INVALID: The client description is too long' using errcode = '22023';
    end if;
  else
    v_new.client_type_other := null;
  end if;
  if p_changes ? 'requirements' then
    if jsonb_typeof(p_changes -> 'requirements') <> 'array' then
      raise exception 'EXHIBITION_LEADS_INVALID: Choose at least one requirement' using errcode = '22023';
    end if;
    v_new.requirements := array(select jsonb_array_elements_text(p_changes -> 'requirements'));
    if cardinality(v_new.requirements) = 0 then
      raise exception 'EXHIBITION_LEADS_INVALID: Choose at least one requirement' using errcode = '22023';
    end if;
    if not (v_new.requirements <@ array['restaurant_cafe','hotel']::text[]) then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown requirement' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'company_name' then
    v_new.company_name := nullif(btrim(coalesce(p_changes ->> 'company_name', '')), '');
    if length(coalesce(v_new.company_name, '')) > 160 then
      raise exception 'EXHIBITION_LEADS_INVALID: The company name is too long' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'project_city' then
    v_new.project_city := nullif(btrim(coalesce(p_changes ->> 'project_city', '')), '');
    if length(coalesce(v_new.project_city, '')) > 80 then
      raise exception 'EXHIBITION_LEADS_INVALID: The city is too long' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'buying_timeline' then
    v_new.buying_timeline := nullif(p_changes ->> 'buying_timeline', '');
    if v_new.buying_timeline is not null and v_new.buying_timeline not in
       ('within_1_month','1_3_months','3_6_months','later','not_sure') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown buying timeline' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'lead_type' then
    v_new.lead_type := nullif(btrim(coalesce(p_changes ->> 'lead_type', '')), '');
    if v_new.lead_type is null then
      raise exception 'EXHIBITION_LEADS_INVALID: Choose a lead type' using errcode = '22023';
    end if;
    if v_new.lead_type not in ('hot','warm','long_term','mismatched_retail') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown lead type' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'status' then
    v_new.status := p_changes ->> 'status';
    if v_new.status is null or v_new.status not in
       ('new','contacted','quotation_sent','follow_up','converted','not_proceeding') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown status' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'next_follow_up_on' then
    begin
      v_new.next_follow_up_on := nullif(p_changes ->> 'next_follow_up_on', '')::date;
    exception when others then
      raise exception 'EXHIBITION_LEADS_INVALID: Enter a valid follow-up date' using errcode = '22023';
    end;
  end if;

  v_terminal := v_new.status in ('converted', 'not_proceeding');
  if v_terminal then
    -- Closing a lead retires its schedule; the change stays in the history.
    v_new.next_follow_up_on := null;
  end if;
  if v_new.status = 'follow_up' and v_new.next_follow_up_on is null then
    raise exception 'EXHIBITION_LEADS_FOLLOW_UP_DATE_REQUIRED: Choose the next follow-up date for a Follow-up lead'
      using errcode = '22023';
  end if;
  if v_new.next_follow_up_on is distinct from v_old.next_follow_up_on
     and v_new.next_follow_up_on is not null and v_new.next_follow_up_on < v_today then
    raise exception 'EXHIBITION_LEADS_INVALID: The follow-up date cannot be in the past' using errcode = '22023';
  end if;
  if v_old.status in ('converted', 'not_proceeding') and v_new.status = v_old.status
     and p_changes ? 'next_follow_up_on' and nullif(p_changes ->> 'next_follow_up_on', '') is not null then
    raise exception 'EXHIBITION_LEADS_INVALID: A closed lead has no follow-up date; change its status first'
      using errcode = '22023';
  end if;

  if v_new.contact_name is distinct from v_old.contact_name then v_fields := array_append(v_fields, 'contact_name'::text); end if;
  if v_new.phone_e164   is distinct from v_old.phone_e164   then v_fields := array_append(v_fields, 'phone'::text); end if;
  if v_new.client_type  is distinct from v_old.client_type  then v_fields := array_append(v_fields, 'client_type'::text); end if;
  if v_new.client_type_other is distinct from v_old.client_type_other then v_fields := array_append(v_fields, 'client_type_other'::text); end if;
  if v_new.requirements is distinct from v_old.requirements then v_fields := array_append(v_fields, 'requirements'::text); end if;
  if v_new.company_name is distinct from v_old.company_name then v_fields := array_append(v_fields, 'company_name'::text); end if;
  if v_new.project_city is distinct from v_old.project_city then v_fields := array_append(v_fields, 'project_city'::text); end if;
  if v_new.buying_timeline is distinct from v_old.buying_timeline then v_fields := array_append(v_fields, 'buying_timeline'::text); end if;
  if v_new.lead_type    is distinct from v_old.lead_type    then v_fields := array_append(v_fields, 'lead_type'::text); end if;

  v_changed := cardinality(v_fields) > 0
    or v_new.status is distinct from v_old.status
    or v_new.next_follow_up_on is distinct from v_old.next_follow_up_on;

  if v_changed then
    begin
      update public.exhibition_leads l
         set contact_name = v_new.contact_name, phone_e164 = v_new.phone_e164,
             client_type = v_new.client_type, client_type_other = v_new.client_type_other, requirements = v_new.requirements,
             company_name = v_new.company_name, project_city = v_new.project_city,
             buying_timeline = v_new.buying_timeline, lead_type = v_new.lead_type,
             status = v_new.status, next_follow_up_on = v_new.next_follow_up_on
       where l.id = v_old.id;
    exception when unique_violation then
      raise exception 'EXHIBITION_LEADS_DUPLICATE_PHONE: Another active lead already has this number'
        using errcode = '23505';
    end;

    if cardinality(v_fields) > 0 then
      insert into public.exhibition_lead_events (lead_id, event_type, actor_id, detail)
      values (v_old.id, 'details_edited', v_uid, jsonb_build_object('fields', to_jsonb(v_fields)));
    end if;
    if v_new.status is distinct from v_old.status then
      insert into public.exhibition_lead_events (lead_id, event_type, actor_id, detail)
      values (v_old.id, 'status_changed', v_uid, jsonb_build_object('from', v_old.status, 'to', v_new.status));
    end if;
    if v_new.next_follow_up_on is distinct from v_old.next_follow_up_on then
      insert into public.exhibition_lead_events (lead_id, event_type, actor_id, detail)
      values (v_old.id, 'follow_up_changed', v_uid,
              jsonb_build_object('from', v_old.next_follow_up_on, 'to', v_new.next_follow_up_on));
    end if;
  end if;

  if v_note is not null then
    insert into public.exhibition_lead_events (lead_id, event_type, actor_id, note)
    values (v_old.id, 'note', v_uid, v_note);
    -- Touch the row so the list's "latest note" ordering and updated_at move.
    update public.exhibition_leads l set updated_at = now() where l.id = v_old.id;
  end if;

  return jsonb_build_object('outcome', case when v_changed or v_note is not null then 'updated' else 'unchanged' end,
                            'lead_id', v_old.id);
end;
$$;

revoke all on function public.update_exhibition_lead(uuid, jsonb, text) from public, anon;
grant execute on function public.update_exhibition_lead(uuid, jsonb, text) to authenticated;

create or replace function public.reassign_exhibition_lead(p_lead_id uuid, p_new_owner uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_old   public.exhibition_leads;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  if length(coalesce(v_note, '')) > 2000 then
    raise exception 'EXHIBITION_LEADS_INVALID: The note is too long' using errcode = '22023';
  end if;
  select * into v_old from public.exhibition_leads l where l.id = p_lead_id for update;
  if not found then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Lead not found' using errcode = 'P0002';
  end if;
  if v_old.archived_at is not null then
    raise exception 'EXHIBITION_LEADS_ARCHIVED: Restore the lead before reassigning it' using errcode = '55000';
  end if;
  if p_new_owner is null or not public.exhibition_leads_user_eligible(p_new_owner) then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose an active user with Exhibition Leads access' using errcode = '22023';
  end if;
  if p_new_owner = v_old.owner_id then
    return jsonb_build_object('outcome', 'unchanged', 'lead_id', v_old.id);
  end if;

  perform set_config('exhibition_leads.reassigning', 'on', true);
  update public.exhibition_leads l set owner_id = p_new_owner where l.id = v_old.id;
  perform set_config('exhibition_leads.reassigning', 'off', true);

  insert into public.exhibition_lead_events (lead_id, event_type, actor_id, note, detail)
  values (v_old.id, 'reassigned', v_uid, v_note,
          jsonb_build_object('from_owner', v_old.owner_id, 'to_owner', p_new_owner));
  return jsonb_build_object('outcome', 'reassigned', 'lead_id', v_old.id);
end;
$$;

revoke all on function public.reassign_exhibition_lead(uuid, uuid, text) from public, anon;
grant execute on function public.reassign_exhibition_lead(uuid, uuid, text) to authenticated;

create or replace function public.archive_exhibition_lead(p_lead_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid;
  v_admin  boolean;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    public.exhibition_leads;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'EXHIBITION_LEADS_INVALID: Give a reason (3–500 characters)' using errcode = '22023';
  end if;
  select * into v_old from public.exhibition_leads l where l.id = p_lead_id for update;
  if not found then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Lead not found' using errcode = 'P0002';
  end if;
  if v_old.archived_at is not null then
    return jsonb_build_object('outcome', 'unchanged', 'lead_id', v_old.id);
  end if;
  update public.exhibition_leads l
     set archived_at = now(), archived_by = v_uid, archive_reason = v_reason
   where l.id = v_old.id;
  insert into public.exhibition_lead_events (lead_id, event_type, actor_id, note)
  values (v_old.id, 'archived', v_uid, v_reason);
  return jsonb_build_object('outcome', 'archived', 'lead_id', v_old.id);
end;
$$;

revoke all on function public.archive_exhibition_lead(uuid, text) from public, anon;
grant execute on function public.archive_exhibition_lead(uuid, text) to authenticated;

create or replace function public.restore_exhibition_lead(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_old   public.exhibition_leads;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  if not v_admin then
    raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only' using errcode = '42501';
  end if;
  select * into v_old from public.exhibition_leads l where l.id = p_lead_id for update;
  if not found then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Lead not found' using errcode = 'P0002';
  end if;
  if v_old.archived_at is null then
    return jsonb_build_object('outcome', 'unchanged', 'lead_id', v_old.id);
  end if;
  begin
    update public.exhibition_leads l
       set archived_at = null, archived_by = null, archive_reason = null
     where l.id = v_old.id;
  exception when unique_violation then
    -- A replacement lead took the number while this one was archived.
    raise exception 'EXHIBITION_LEADS_RESTORE_CONFLICT: Another active lead already has this number'
      using errcode = '23505';
  end;
  insert into public.exhibition_lead_events (lead_id, event_type, actor_id)
  values (v_old.id, 'restored', v_uid);
  return jsonb_build_object('outcome', 'restored', 'lead_id', v_old.id);
end;
$$;

revoke all on function public.restore_exhibition_lead(uuid) from public, anon;
grant execute on function public.restore_exhibition_lead(uuid) to authenticated;

-- ═══ 8. Executed self-checks ════════════════════════════════════════════════

do $$
declare
  v_fn text;
begin
  -- Browser-callable functions: authenticated yes, anon/public no.
  foreach v_fn in array array[
    'public.exhibition_leads_page(jsonb,integer,integer)',
    'public.get_exhibition_lead(uuid)',
    'public.exhibition_lead_people(uuid)',
    'public.exhibition_lead_ranking(uuid)',
    'public.export_exhibition_leads(jsonb,integer,integer)',
    'public.create_exhibition_lead(uuid,uuid,text,text,text,text[],text,text,text,text,text,text)',
    'public.update_exhibition_lead(uuid,jsonb,text)',
    'public.reassign_exhibition_lead(uuid,uuid,text)',
    'public.archive_exhibition_lead(uuid,text)',
    'public.restore_exhibition_lead(uuid)'
  ] loop
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'EXHIBITION_LEADS_ACL: wrong execute grants on %', v_fn;
    end if;
  end loop;
  -- Internal helpers: nobody but the owner.
  foreach v_fn in array array[
    'public.exhibition_leads_user_eligible(uuid)',
    'public.exhibition_leads_actor()',
    'public.exhibition_leads_filtered(uuid,boolean,jsonb)',
    'public.exhibition_lead_json(uuid)',
    'public.exhibition_leads_guard_immutable()',
    'public.exhibition_lead_events_append_only()',
    'public.exhibition_leads_text_array(jsonb,text)'
  ] loop
    if has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'EXHIBITION_LEADS_ACL: internal helper is callable by clients: %', v_fn;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.exhibition_leads', 'INSERT')
     or has_table_privilege('authenticated', 'public.exhibition_leads', 'UPDATE')
     or has_table_privilege('authenticated', 'public.exhibition_leads', 'DELETE')
     or has_table_privilege('authenticated', 'public.exhibition_lead_events', 'INSERT')
     or has_table_privilege('anon', 'public.exhibition_leads', 'SELECT') then
    raise exception 'EXHIBITION_LEADS_ACL: a client role can write or anonymously read the tables';
  end if;
  -- Number-format variants collapse to one key.
  if public.normalize_lead_phone('98765 43210') is distinct from '+919876543210'
     or public.normalize_lead_phone('+91 98765-43210') is distinct from '+919876543210'
     or public.normalize_lead_phone('09876543210') is distinct from '+919876543210'
     or public.normalize_lead_phone('919876543210') is distinct from '+919876543210'
     or public.normalize_lead_phone('0091 98765 43210') is distinct from '+919876543210'
     or public.normalize_lead_phone('+44 20 7946 0958') is distinct from '+442079460958'
     or public.normalize_lead_phone('12345') is not null then
    raise exception 'EXHIBITION_LEADS_PHONE: normalize_lead_phone failed its self-check';
  end if;
end $$;
