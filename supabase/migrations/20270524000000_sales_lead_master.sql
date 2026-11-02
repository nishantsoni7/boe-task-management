-- 20270524000000_sales_lead_master.sql
--
-- Sales, Lead Master: one register of every lead, who has it, and when it came in.
--
-- What the owner decided (2026-11-02), and what this file does about it:
--   * The contact number is held in ONE format (+<country><digits>, the same rule as Exhibition Leads:
--     normalize_lead_phone) and is UNIQUE across the whole register. Entering a number that is already there
--     creates nothing and returns the existing lead: its number, the day it was received, and who holds it. The
--     screen shows that as text for now; the link to the lead waits for the Lead Management module.
--   * The received date is filled in by the database (India date) and never changes.
--   * Adding a lead does NOT allot it. A new lead is "not allotted" (assigned_to is null). Allotting happens
--     afterwards, from the list: allot_sales_lead. Giving an unallotted lead its first name needs no question; the
--     screen asks before CHANGING a name that is already there. The database adds a second guard of its own: the
--     caller says who they saw holding the lead, and a change is refused if somebody else changed it meanwhile.
--   * The name chosen must be a person who counts as a sales candidate: is_eligible_order_assignee()
--     (20260697000000), the rule Orders already uses for "who can be a salesperson".
--
-- Rights (module `sales`): `view` already exists (20270515000000) and opens the module and reads every lead. This
-- file registers `create` (add a lead), `edit` (correct a lead's details) and `assign` (allot a lead and change who
-- holds it). `assign` is one of the protected actions, so a preset such as Manager never hands it out: it is granted
-- per person in Control Center. The Admin role holds all four; nothing is on by default. Mirrors
-- src/lib/permissions/modules.ts exactly (npm run permissions:check).
--
-- READ:  a signed-in person with Sales `view` (or Admin), through module_entry_open('sales').
-- WRITE: only the functions below. The tables carry no write policy and no write grant, so a browser cannot write.
--
-- No data is seeded: the repository is public and lead numbers belong in the database only.
--
-- ROLLBACK (nothing else reads these; the register itself is lost with them, so export it first):
--   drop function public.get_sales_lead(uuid), public.sales_leads_page(text, text, text, text, integer, integer),
--     public.allot_sales_lead(uuid, uuid, uuid), public.update_sales_lead(uuid, text, text, text, text, text, text, timestamptz),
--     public.create_sales_lead(text, text, text, text, text, text), public.sales_lead_phone_check(text),
--     public.sales_lead_json(public.sales_leads), public.sales_leads_require(text);
--   drop table public.sales_lead_events, public.sales_leads;
--   drop function public.sales_lead_events_append_only(), public.sales_leads_guard();
--   delete from public.employee_permission_overrides, role_permissions and module_permission_actions
--   where the module is 'sales' and the action is 'create', 'edit' or 'assign';
--   update public.app_modules and public.permission_modules set description = 'Sales module. Coming soon.'
--   where module_key = 'sales'.

-- ═══ 1. Registration ═════════════════════════════════════════════════════════

update public.app_modules
set description = 'Sales: the Lead Master, every lead and who holds it.'
where module_key = 'sales';

update public.permission_modules
set description = 'Sales: the Lead Master, every lead and who holds it.'
where module_key = 'sales';

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('create', 'edit', 'assign')
where pm.module_key = 'sales'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id
join public.permission_actions pa on pa.id = mpa.action_id
where pm.module_key = 'sales' and pa.action_key in ('create', 'edit', 'assign')
on conflict (role, module_id, action_id) do nothing;

-- ═══ 2. Tables ═══════════════════════════════════════════════════════════════

create table public.sales_leads (
  id uuid primary key default gen_random_uuid(),
  -- The number people say out loud ("Lead 12406"). Never reused, never edited.
  lead_no bigint generated always as identity unique,
  -- The day the lead was entered, in India. It stands for the day it was received.
  received_on date not null default ((now() at time zone 'Asia/Kolkata')::date),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  source text not null check (source in (
    'website', 'whatsapp', 'instagram', 'insta_promo', 'facebook_promo',
    'google_ads', 'campaign', 'reference', 'repeat_customer', 'others'
  )),
  name text check (name is null or length(name) between 1 and 120),
  email text check (email is null or (length(email) <= 120 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  location text check (location is null or length(location) between 1 and 120),
  requirement text check (requirement is null or length(requirement) between 1 and 4000),
  -- Null = not allotted yet. assigned_at is when the CURRENT holder was given the lead.
  assigned_to uuid references public.users (id) on delete set null,
  assigned_at timestamptz,
  assigned_by uuid references public.users (id) on delete set null,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The rule the owner asked for: one number, one lead.
create unique index sales_leads_phone_key on public.sales_leads (phone_e164);
create index sales_leads_received_idx on public.sales_leads (received_on desc, lead_no desc);
create index sales_leads_holder_idx on public.sales_leads (assigned_to, received_on desc);

create function public.sales_leads_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.lead_no is distinct from old.lead_no
     or new.received_on is distinct from old.received_on
     or new.created_at is distinct from old.created_at then
    raise exception 'SALES_LEAD_FIXED: the lead number and the received date never change';
  end if;
  return new;
end;
$$;

create trigger sales_leads_guard
  before update on public.sales_leads
  for each row execute function public.sales_leads_guard();

-- What happened to a lead. Append-only. The three people columns are plain ids with NO foreign key on purpose: a
-- foreign key's "on delete set null" is an UPDATE, which the append-only trigger below refuses, so removing a
-- person would be blocked by their own history. A removed person simply reads as a blank name.
create table public.sales_lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads (id),
  kind text not null check (kind in ('added', 'allotted', 'reassigned', 'edited')),
  from_user uuid,
  to_user uuid,
  -- For 'edited': which fields changed, e.g. 'phone, name'. Never the values.
  detail text check (detail is null or length(detail) <= 200),
  actor uuid,
  at timestamptz not null default now()
);
create index sales_lead_events_lead_idx on public.sales_lead_events (lead_id, at desc);

create function public.sales_lead_events_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'SALES_LEAD_EVENTS_APPEND_ONLY: a lead''s history is never changed';
end;
$$;

create trigger sales_lead_events_append_only
  before update or delete on public.sales_lead_events
  for each row execute function public.sales_lead_events_append_only();

do $$
declare t text;
begin
  foreach t in array array['sales_leads', 'sales_lead_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.module_entry_open(''sales''))', t || '_read', t);
  end loop;
end $$;

-- ═══ 3. Internal helpers (not callable from a browser) ═══════════════════════

-- Who is asking, after the module gate and, when given, the right. Raises SALES_FORBIDDEN (42501) otherwise.
create function public.sales_leads_require(p_action text default null)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.module_entry_open('sales') then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  if p_action is not null
     and not exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin')
     and not public.resolve_permission(v_uid, 'sales', p_action) then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- One lead as the screens read it, with the holder's name.
create function public.sales_lead_json(l public.sales_leads)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', l.id,
    'lead_no', l.lead_no,
    'received_on', l.received_on,
    'phone', l.phone_e164,
    'source', l.source,
    'name', l.name,
    'email', l.email,
    'location', l.location,
    'requirement', l.requirement,
    'assigned_to', l.assigned_to,
    'holder_name', (select u.full_name from public.users u where u.id = l.assigned_to),
    'assigned_at', l.assigned_at,
    -- What an edit says it started from (update_sales_lead refuses an edit made on an older version).
    'updated_at', l.updated_at
  );
$$;

-- ═══ 4. Reads ════════════════════════════════════════════════════════════════

-- The live check on the Add lead form: is this number valid, and is it already a lead?
create function public.sales_lead_phone_check(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text;
  v_row public.sales_leads;
begin
  perform public.sales_leads_require(null);
  v_phone := public.normalize_lead_phone(p_phone);
  if v_phone is null then return jsonb_build_object('state', 'invalid'); end if;
  select * into v_row from public.sales_leads where phone_e164 = v_phone;
  if v_row.id is null then return jsonb_build_object('state', 'free', 'phone', v_phone); end if;
  return jsonb_build_object('state', 'exists', 'phone', v_phone, 'lead', public.sales_lead_json(v_row));
end;
$$;

-- The list. p_period: today | week (last 7 days) | month (last 30 days) | all. p_holder: all | none | a user id.
-- Returns the page of leads, how many match, the four period counts (always the whole register), and who holds
-- how many of the leads the period / source / search select (the counts on the "Allotted to" chips).
create function public.sales_leads_page(
  p_period text default 'today',
  p_holder text default 'all',
  p_source text default null,
  p_q text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date;
  v_q text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(btrim(coalesce(p_q, '')), '[^0-9]', '', 'g');
  v_like text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- A number typed in any of its forms ("098765 43210", "+91 98765 43210") finds the one stored number.
  v_norm text := public.normalize_lead_phone(btrim(coalesce(p_q, '')));
  v_holder uuid := case when p_holder ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_holder::uuid end;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_periods jsonb;
  v_everyone integer;
  v_unallotted integer;
  v_holders jsonb;
  v_total integer;
  v_rows jsonb;
begin
  perform public.sales_leads_require(null);
  v_from := case p_period when 'today' then v_today when 'week' then v_today - 6 when 'month' then v_today - 29 else null end;

  select jsonb_build_object(
    'today', count(*) filter (where received_on = v_today),
    'week',  count(*) filter (where received_on >= v_today - 6),
    'month', count(*) filter (where received_on >= v_today - 29),
    'all',   count(*)
  ) into v_periods from public.sales_leads;

  with base as (
    select l.id, l.lead_no, l.received_on, l.assigned_to
    from public.sales_leads l
    where (v_from is null or l.received_on >= v_from)
      and (coalesce(p_source, '') = '' or l.source = p_source)
      and (v_q = ''
        or (length(v_digits) >= 3 and l.phone_e164 like '%' || v_digits || '%')
        or (v_norm is not null and l.phone_e164 = v_norm)
        or l.name ilike v_like or l.email ilike v_like or l.location ilike v_like or l.requirement ilike v_like)
  ),
  held as (
    select assigned_to, count(*)::integer as n from base where assigned_to is not null group by assigned_to
  ),
  shown as (
    select b.id, b.lead_no, b.received_on
    from base b
    where coalesce(p_holder, 'all') in ('all', '')
       or (p_holder = 'none' and b.assigned_to is null)
       or (v_holder is not null and b.assigned_to = v_holder)
  )
  select
    (select count(*) from base),
    (select count(*) from base where assigned_to is null),
    (select coalesce(jsonb_agg(jsonb_build_object('id', h.assigned_to, 'name', u.full_name, 'n', h.n) order by u.full_name), '[]'::jsonb)
       from held h join public.users u on u.id = h.assigned_to),
    (select count(*) from shown),
    (select coalesce(jsonb_agg(public.sales_lead_json(s) order by s.received_on desc, s.lead_no desc), '[]'::jsonb)
       from public.sales_leads s
       where s.id in (select x.id from shown x order by x.received_on desc, x.lead_no desc limit v_lim offset v_off))
  into v_everyone, v_unallotted, v_holders, v_total, v_rows;

  return jsonb_build_object(
    'periods', v_periods,
    'everyone', v_everyone,
    'unallotted', v_unallotted,
    'holders', v_holders,
    'total', v_total,
    'rows', v_rows
  );
end;
$$;

-- One lead with its history, newest first.
create function public.get_sales_lead(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_row public.sales_leads;
begin
  perform public.sales_leads_require(null);
  select * into v_row from public.sales_leads where id = p_id;
  if v_row.id is null then raise exception 'SALES_NOT_FOUND'; end if;
  return jsonb_build_object(
    'lead', public.sales_lead_json(v_row),
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'kind', e.kind, 'from_name', f.full_name, 'to_name', t.full_name,
        'detail', e.detail, 'actor_name', a.full_name, 'at', e.at
      ) order by e.at desc, e.id), '[]'::jsonb)
      from public.sales_lead_events e
      left join public.users f on f.id = e.from_user
      left join public.users t on t.id = e.to_user
      left join public.users a on a.id = e.actor
      where e.lead_id = p_id
    )
  );
end;
$$;

-- ═══ 5. Writes ═══════════════════════════════════════════════════════════════

-- Add a lead. A new lead is NOT allotted. Returns {status:'created', lead} or, when the number is already in the
-- register, {status:'duplicate', lead: <the lead that holds it>} and saves nothing. Two people adding the same
-- number at once cannot both win: the unique index decides, and the loser gets 'duplicate'.
create function public.create_sales_lead(
  p_phone text,
  p_source text,
  p_name text default null,
  p_email text default null,
  p_location text default null,
  p_requirement text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('create');
  v_phone text := public.normalize_lead_phone(p_phone);
  v_row public.sales_leads;
begin
  if v_phone is null then raise exception 'SALES_INVALID: Enter a valid mobile number'; end if;

  -- Look first: an INSERT ... ON CONFLICT draws a lead number before it finds the conflict, so every duplicate
  -- would leave a gap in the numbers people say aloud. The conflict clause below is only for two people adding
  -- the same new number in the same instant.
  select * into v_row from public.sales_leads where phone_e164 = v_phone;
  if v_row.id is not null then
    return jsonb_build_object('status', 'duplicate', 'lead', public.sales_lead_json(v_row));
  end if;

  insert into public.sales_leads (phone_e164, source, name, email, location, requirement, created_by)
  values (v_phone, p_source, nullif(btrim(p_name), ''), lower(nullif(btrim(p_email), '')),
          nullif(btrim(p_location), ''), nullif(btrim(p_requirement), ''), v_uid)
  on conflict (phone_e164) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.sales_leads where phone_e164 = v_phone;
    return jsonb_build_object('status', 'duplicate', 'lead', public.sales_lead_json(v_row));
  end if;

  insert into public.sales_lead_events (lead_id, kind, actor) values (v_row.id, 'added', v_uid);
  return jsonb_build_object('status', 'created', 'lead', public.sales_lead_json(v_row));
exception
  when check_violation then
    raise exception 'SALES_INVALID: Check the details and try again.';
end;
$$;

-- Correct a lead's details. Takes the whole form. A changed number is checked against the register again: if
-- another lead holds it, nothing is saved and that lead comes back as 'duplicate'. Who holds the lead is NOT
-- changed here (allot_sales_lead does that). p_expected_updated_at is the version the person started editing: if
-- the lead has been changed since (a detail edited, or a name allotted), nothing is saved and SALES_CHANGED comes
-- back, so one person's edit can never silently undo another's.
create function public.update_sales_lead(
  p_id uuid,
  p_phone text,
  p_source text,
  p_name text,
  p_email text,
  p_location text,
  p_requirement text,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('edit');
  v_phone text := public.normalize_lead_phone(p_phone);
  v_name text := nullif(btrim(p_name), '');
  v_email text := lower(nullif(btrim(p_email), ''));
  v_location text := nullif(btrim(p_location), '');
  v_requirement text := nullif(btrim(p_requirement), '');
  v_old public.sales_leads;
  v_new public.sales_leads;
  v_other public.sales_leads;
  v_changed text[] := '{}';
begin
  if v_phone is null then raise exception 'SALES_INVALID: Enter a valid mobile number'; end if;
  select * into v_old from public.sales_leads where id = p_id for update;
  if v_old.id is null then raise exception 'SALES_NOT_FOUND'; end if;
  if p_expected_updated_at is not null and v_old.updated_at is distinct from p_expected_updated_at then
    raise exception 'SALES_CHANGED: Somebody changed this lead while you were editing it. The latest version has been loaded.';
  end if;

  select * into v_other from public.sales_leads where phone_e164 = v_phone and id <> p_id;
  if v_other.id is not null then
    return jsonb_build_object('status', 'duplicate', 'lead', public.sales_lead_json(v_other));
  end if;

  if v_phone is distinct from v_old.phone_e164 then v_changed := array_append(v_changed, 'phone'); end if;
  if p_source is distinct from v_old.source then v_changed := array_append(v_changed, 'source'); end if;
  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if v_email is distinct from v_old.email then v_changed := array_append(v_changed, 'email'); end if;
  if v_location is distinct from v_old.location then v_changed := array_append(v_changed, 'location'); end if;
  if v_requirement is distinct from v_old.requirement then v_changed := array_append(v_changed, 'requirement'); end if;
  if cardinality(v_changed) = 0 then
    return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_old));
  end if;

  update public.sales_leads
  set phone_e164 = v_phone, source = p_source, name = v_name, email = v_email,
      location = v_location, requirement = v_requirement, updated_at = now()
  where id = p_id
  returning * into v_new;

  insert into public.sales_lead_events (lead_id, kind, detail, actor)
  values (p_id, 'edited', array_to_string(v_changed, ', '), v_uid);
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_new));
exception
  when check_violation then
    raise exception 'SALES_INVALID: Check the details and try again.';
  when unique_violation then
    -- Somebody took the number between the check above and the update.
    select * into v_other from public.sales_leads where phone_e164 = v_phone and id <> p_id;
    return jsonb_build_object('status', 'duplicate', 'lead', public.sales_lead_json(v_other));
end;
$$;

-- Allot a lead, or change who holds it. p_expected_from is who the caller SAW holding it (null = not allotted): if
-- somebody has changed it since, nothing is saved and SALES_CHANGED comes back, so a stale screen can never
-- reassign a lead without the person having seen the name they are replacing. p_to must count as a sales candidate.
create function public.allot_sales_lead(p_id uuid, p_to uuid, p_expected_from uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('assign');
  v_row public.sales_leads;
begin
  if p_to is null or not public.is_eligible_order_assignee(p_to) then
    raise exception 'SALES_INVALID: Choose a person from the Sales team.';
  end if;
  select * into v_row from public.sales_leads where id = p_id for update;
  if v_row.id is null then raise exception 'SALES_NOT_FOUND'; end if;
  if v_row.assigned_to is distinct from p_expected_from then
    raise exception 'SALES_CHANGED: Somebody changed who holds this lead. The list has been refreshed.';
  end if;
  if v_row.assigned_to = p_to then
    return jsonb_build_object('status', 'unchanged', 'lead', public.sales_lead_json(v_row));
  end if;

  update public.sales_leads
  set assigned_to = p_to, assigned_at = now(), assigned_by = v_uid, updated_at = now()
  where id = p_id
  returning * into v_row;

  insert into public.sales_lead_events (lead_id, kind, from_user, to_user, actor)
  values (p_id, case when p_expected_from is null then 'allotted' else 'reassigned' end, p_expected_from, p_to, v_uid);
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_row));
end;
$$;

-- ═══ 6. Who may call what ════════════════════════════════════════════════════

revoke all on function public.sales_leads_require(text) from public, anon, authenticated;
revoke all on function public.sales_lead_json(public.sales_leads) from public, anon, authenticated;
revoke all on function public.sales_leads_guard() from public, anon, authenticated;
revoke all on function public.sales_lead_events_append_only() from public, anon, authenticated;

revoke all on function public.sales_lead_phone_check(text) from public, anon;
revoke all on function public.sales_leads_page(text, text, text, text, integer, integer) from public, anon;
revoke all on function public.get_sales_lead(uuid) from public, anon;
revoke all on function public.create_sales_lead(text, text, text, text, text, text) from public, anon;
revoke all on function public.update_sales_lead(uuid, text, text, text, text, text, text, timestamptz) from public, anon;
revoke all on function public.allot_sales_lead(uuid, uuid, uuid) from public, anon;

grant execute on function public.sales_lead_phone_check(text) to authenticated;
grant execute on function public.sales_leads_page(text, text, text, text, integer, integer) to authenticated;
grant execute on function public.get_sales_lead(uuid) to authenticated;
grant execute on function public.create_sales_lead(text, text, text, text, text, text) to authenticated;
grant execute on function public.update_sales_lead(uuid, text, text, text, text, text, text, timestamptz) to authenticated;
grant execute on function public.allot_sales_lead(uuid, uuid, uuid) to authenticated;

-- ═══ 7. Self-checks (these fail the migration rather than let a half-applied state look fine) ═══

do $$
declare v_fn text;
begin
  if (select count(*)
      from public.role_permissions rp
      join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key = 'sales' and rp.role = 'admin' and rp.allowed) <> 4 then
    raise exception 'SALES_LEAD_MASTER: the Sales module needs its four Admin role rows (view, create, edit, assign)';
  end if;
  if exists (
    select 1
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    where pm.module_key = 'sales' and mpa.default_allowed
  ) then
    raise exception 'SALES_LEAD_MASTER: no Sales action may be on by default';
  end if;
  if exists (
    select 1 from pg_class c
    where c.oid in ('public.sales_leads'::regclass, 'public.sales_lead_events'::regclass) and not c.relrowsecurity
  ) then
    raise exception 'SALES_LEAD_MASTER: row level security must be on for both tables';
  end if;
  if has_table_privilege('authenticated', 'public.sales_leads', 'INSERT')
     or has_table_privilege('authenticated', 'public.sales_leads', 'UPDATE')
     or has_table_privilege('authenticated', 'public.sales_leads', 'DELETE')
     or has_table_privilege('authenticated', 'public.sales_lead_events', 'INSERT') then
    raise exception 'SALES_LEAD_MASTER: a browser must not be able to write the register';
  end if;
  foreach v_fn in array array[
    'public.sales_lead_phone_check(text)', 'public.sales_leads_page(text, text, text, text, integer, integer)',
    'public.get_sales_lead(uuid)', 'public.create_sales_lead(text, text, text, text, text, text)',
    'public.update_sales_lead(uuid, text, text, text, text, text, text, timestamptz)', 'public.allot_sales_lead(uuid, uuid, uuid)'
  ] loop
    if has_function_privilege('anon', to_regprocedure(v_fn)::oid, 'EXECUTE') then
      raise exception 'SALES_LEAD_MASTER: anon can execute %', v_fn;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.sales_leads_require(text)'::regprocedure, 'EXECUTE') then
    raise exception 'SALES_LEAD_MASTER: the internal gate must not be callable from a browser';
  end if;
end $$;
