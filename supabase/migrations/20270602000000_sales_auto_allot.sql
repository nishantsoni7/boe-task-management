-- 20270602000000_sales_auto_allot.sql
--
-- Sales: website leads are allotted by themselves (owner's plan, Phase 3, approved 2026-11-03 "Yes, build it").
--
-- The owner's rule, made universal:
--   * Each person has a level, set in Control Center, Sales team: Senior, Mid, Junior, Backup, or Manual only (never given
--     a lead automatically; also everybody nobody has placed yet). A daily limit of new leads (25; Backup 10), and an
--     "Export leads" tick.
--   * Premium is read from what the client wrote: 200 or more seats, covers or guests, 25 or more rooms, or ₹15 lakh or
--     more; or an expected value of ₹15 lakh or more typed later. The card shows it with its reason.
--   * Who can take a lead: can be given leads, not Manual only, punched in today (while nobody in the team has punched in
--     yet, everybody counts: early morning, or the machine sending late), and under their daily limit.
--   * A Premium lead tries Senior, then Mid, then Junior, then Backup. Any other lead goes to Senior, Mid and Junior
--     alike, and to Backup only when they are all full or away. An export number prefers somebody with the Export tick.
--     Then the fewest fresh leads (given in the last 7 days, still open, not called yet), then whoever was given a lead
--     longest ago.
--   * A returning customer stays with whoever holds them, as before. Only when that person can no longer be given leads
--     (left, or unticked) does the rule pick somebody.
--   * Only website leads are given at once, and only on the working days and hours set (Mon to Sat, 9:30 to 7 pm). A lead
--     nobody can take, or one that came in after hours, waits Not allotted and the allotters hear. The morning alert run
--     gives what waits, hand-added leads too; "Allot waiting leads now" in Lead Master does it at any time.
--   * The history says "Allotted to Ashok automatically: in today, 2 fresh leads". The holder gets "New lead for you"; the
--     allotters are not told about a lead that was given.
--   * The Team page lists a Premium lead a Junior or Backup was given this week, to hand to a Senior. Nothing moves itself.
--
-- WRITE: set_sales_auto_allot and set_sales_allot_person (Admin), allot_waiting_sales_leads (`assign`), and the website
--   capture and the morning run (service role). The two new tables carry no policy and no grant.
--
-- ROLLBACK: re-run the 20270531000100 definition of capture_sales_leads, the 20270527000000 definition of
--   sales_lead_send_alerts, the 20270530000000 definition of sales_lead_row and the 20270529000000 definition of
--   list_sales_team; then drop functions public.sales_premium_misplaced(), public.allot_waiting_sales_leads(),
--   public.set_sales_allot_person(uuid, text, boolean, integer), public.set_sales_auto_allot(boolean, integer[], time, time),
--   public.get_sales_auto_allot(), public.sales_lead_allot_waiting(), public.sales_lead_auto_allot(uuid),
--   public.sales_lead_pick(public.sales_leads), public.sales_auto_allot_open(boolean), public.sales_lead_premium(public.sales_leads);
--   drop index public.sales_lead_events_given_idx; drop tables public.sales_allot_people, public.sales_auto_allot.
--   Leads already given stay with their holders.

-- ═══ 1. The settings ════════════════════════════════════════════════════════════════════════════════════════════

-- One row: on or off, and the working days (1 Monday to 7 Sunday) and hours in India when a website lead is given at once.
create table public.sales_auto_allot (
  id boolean primary key default true check (id),
  is_on boolean not null default true,
  days integer[] not null default '{1,2,3,4,5,6}' check (days <@ '{1,2,3,4,5,6,7}'::integer[]),
  starts time not null default '09:30',
  ends time not null default '19:00',
  set_by uuid,
  set_at timestamptz not null default now(),
  check (starts < ends)
);
insert into public.sales_auto_allot default values;

-- Per person. No row = Manual only: nobody is given leads automatically before the owner places them.
create table public.sales_allot_people (
  user_id uuid primary key references public.users (id) on delete cascade,
  level text not null check (level in ('senior', 'mid', 'junior', 'backup', 'manual')),
  takes_export boolean not null default false,
  daily_limit integer not null default 25 check (daily_limit between 0 and 200),
  set_by uuid,
  set_at timestamptz not null default now()
);

alter table public.sales_auto_allot enable row level security;
alter table public.sales_allot_people enable row level security;
revoke all on table public.sales_auto_allot, public.sales_allot_people from public, anon, authenticated;
grant all on table public.sales_auto_allot, public.sales_allot_people to service_role;

-- The levels the owner gave (2026-11-03), by first name, only where exactly one active person has it.
insert into public.sales_allot_people (user_id, level, daily_limit)
select u.id, v.level, v.daily_limit
from (values ('mohit', 'senior', 25), ('ashok', 'senior', 25), ('prerna', 'mid', 25), ('saksham', 'mid', 25),
             ('shravi', 'junior', 25), ('namrata', 'backup', 10), ('dhruv', 'manual', 25)) as v(first_name, level, daily_limit)
join public.users u on u.is_active and lower(split_part(btrim(u.full_name), ' ', 1)) = v.first_name
where (select count(*) from public.users x where x.is_active and lower(split_part(btrim(x.full_name), ' ', 1)) = v.first_name) = 1;

-- Leads given to a person, newest first: the daily limit and "longest since a lead" read it.
create index sales_lead_events_given_idx on public.sales_lead_events (to_user, at desc) where kind = 'allotted';

-- ═══ 2. Premium ═════════════════════════════════════════════════════════════════════════════════════════════════

-- Why a lead is Premium, in a few words ("250 seats", "40 rooms", "₹20 lakh"), or null. Read from the requirement and
-- quantity the client wrote, or from the expected value somebody typed.
create function public.sales_lead_premium(l public.sales_leads)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_text text := lower(concat_ws(' ', l.requirement, l.quantity));
  v_n numeric;
  v_unit text;
  v_lakh numeric;
  v_rupees numeric;
begin
  if l.expected_value_paise >= 150000000 then
    return 'expected ₹' || trim_scale(round(l.expected_value_paise / 10000000.0, 1)) || ' lakh';
  end if;
  if v_text = '' then return null; end if;

  select replace(m.a[1], ',', '')::numeric, m.a[2] into v_n, v_unit
  from regexp_matches(v_text, '(\d[\d,]{0,6})\s*\+?\s*(?:-\s*)?(seats?|seater|seating|covers?|chairs?|pax|guests?|people|persons?)\M', 'g') as m(a)
  order by 1 desc limit 1;
  if v_n >= 200 then return v_n || ' ' || v_unit; end if;

  select replace(m.a[1], ',', '')::numeric, m.a[2] into v_n, v_unit
  from regexp_matches(v_text, '(\d[\d,]{0,5})\s*\+?\s*(?:-\s*)?(rooms?|keys?|suites?)\M', 'g') as m(a)
  order by 1 desc limit 1;
  if v_n >= 25 then return v_n || ' ' || v_unit; end if;

  -- Said in lakh or crore ("15 lakh", "1.5 cr"), or written out in rupees ("Rs 20,00,000").
  select max(m.a[1]::numeric * case when m.a[2] like 'c%' then 100 else 1 end) into v_lakh
  from regexp_matches(v_text, '(\d{1,4}(?:\.\d{1,2})?)\s*(lakhs?|lacs?|crores?|crs?)\M', 'g') as m(a);
  select max(replace(m.a[1], ',', '')::numeric) / 100000 into v_rupees
  from regexp_matches(v_text, '(?:₹|rs\.?|inr)\s*(\d[\d,]{5,12})', 'g') as m(a);
  v_lakh := greatest(v_lakh, v_rupees);
  if v_lakh >= 15 then return '₹' || trim_scale(round(v_lakh, 1)) || ' lakh'; end if;
  return null;
end;
$$;

-- ═══ 3. Who takes a lead ════════════════════════════════════════════════════════════════════════════════════════

-- Whether a website lead is given at once now. p_any_hour: the day alone (the morning run, which comes before 9:30 ends).
create function public.sales_auto_allot_open(p_any_hour boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select s.is_on
       and extract(isodow from now() at time zone 'Asia/Kolkata')::integer = any (s.days)
       and (p_any_hour or ((now() at time zone 'Asia/Kolkata')::time >= s.starts and (now() at time zone 'Asia/Kolkata')::time < s.ends))
    from public.sales_auto_allot s
  ), false);
$$;

-- The person the rule gives this lead to, and why in a few words; null when nobody can take it.
create function public.sales_lead_pick(l public.sales_leads, out who uuid, out why text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from timestamptz := ((now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata';
  v_premium text := public.sales_lead_premium(l);
  v_level text;
  v_in boolean;
  v_export boolean;
  v_fresh integer;
begin
  with team as (
    select u.id, p.level, p.takes_export, p.daily_limit,
      exists (select 1 from public.attendance_records r
              where r.user_id = u.id and r.attendance_date = v_today and r.check_in_at is not null) as is_in
    from public.users u
    join public.sales_allot_people p on p.user_id = u.id and p.level <> 'manual'
    where public.sales_lead_can_hold(u.id)
  ),
  free as (
    select t.*,
      (select count(*) from public.sales_leads f
       where f.assigned_to = t.id and f.stage not in ('converted', 'dead') and f.first_attempt_at is null
         and f.assigned_at >= now() - interval '7 days')::integer as fresh,
      (select max(e.at) from public.sales_lead_events e where e.to_user = t.id and e.kind = 'allotted') as last_given
    from team t
    where (t.is_in or not exists (select 1 from team x where x.is_in))
      and (select count(*) from public.sales_lead_events e
           where e.to_user = t.id and e.kind = 'allotted' and e.at >= v_from) < t.daily_limit
  )
  select f.id, f.level, f.is_in, f.takes_export, f.fresh into who, v_level, v_in, v_export, v_fresh
  from free f
  order by
    case when v_premium is not null then array_position(array['senior', 'mid', 'junior', 'backup'], f.level)
         else (f.level = 'backup')::integer end,
    (l.market = 'export' and f.takes_export) desc,
    f.fresh,
    f.last_given nulls first,
    f.id
  limit 1;

  if who is not null then
    why := left(concat_ws(', ',
      case when v_premium is not null then 'Premium (' || v_premium || ') to a ' || initcap(v_level) end,
      case when v_in then 'in today' else 'before anyone punched in' end,
      case when l.market = 'export' and v_export then 'takes export leads' end,
      v_fresh || case when v_fresh = 1 then ' fresh lead' else ' fresh leads' end
    ), 200);
  end if;
end;
$$;

-- Give one lead by the rule. Returns who holds it now, or null when nobody can take it (it then stays as it was).
create function public.sales_lead_auto_allot(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_leads;
  v_from uuid;
  v_to uuid;
  v_why text;
begin
  -- One at a time, so two leads arriving together are not both given to the same "fewest".
  perform pg_advisory_xact_lock(hashtext('sales_lead_auto_allot'));
  select * into v_row from public.sales_leads where id = p_id for update;
  if v_row.id is null or v_row.stage in ('converted', 'dead') then return null; end if;
  if v_row.assigned_to is not null and public.sales_lead_can_hold(v_row.assigned_to) then return v_row.assigned_to; end if;

  select p.who, p.why into v_to, v_why from public.sales_lead_pick(v_row) p;
  if v_to is null then return null; end if;
  v_from := v_row.assigned_to;

  update public.sales_leads
  set assigned_to = v_to, assigned_at = now(), assigned_by = null, updated_at = now(), is_history = false,
      next_step = coalesce(next_step, 'First call'),
      next_due_on = coalesce(next_due_on, (now() at time zone 'Asia/Kolkata')::date)
  where id = p_id
  returning * into v_row;

  -- clock_timestamp: after the "came in" line written in the same transaction, so the history reads in order.
  insert into public.sales_lead_events (lead_id, kind, from_user, to_user, detail, at)
  values (p_id, case when v_from is null then 'allotted' else 'reassigned' end, v_from, v_to, v_why, clock_timestamp());

  perform public.sales_lead_notify(v_to, p_id, 'sales_lead_allotted', 'New lead for you',
    left(coalesce(v_row.name, v_row.phone_e164) || coalesce(' (Premium: ' || public.sales_lead_premium(v_row) || ')', '')
      || '. Call today.', 300));
  return v_to;
end;
$$;

-- Give every waiting lead, oldest first, until nobody can take more. Old ClickUp and sheet leads nobody held are not
-- waiting; they come back when they enquire again. Returns how many were given.
create function public.sales_lead_allot_waiting()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  x record;
  v_n integer := 0;
begin
  for x in
    select l.id from public.sales_leads l
    where l.assigned_to is null and not l.is_history and l.stage not in ('converted', 'dead')
      and (l.imported_at is null or l.enquired_again_at > l.imported_at)
    order by l.received_on, l.lead_no
  loop
    -- Nobody could take this one, so nobody can take the next: they share one pool of people.
    exit when public.sales_lead_auto_allot(x.id) is null;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ═══ 4. Control Center and Lead Master ══════════════════════════════════════════════════════════════════════════

create function public.get_sales_auto_allot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active) then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('is_on', s.is_on, 'days', to_jsonb(s.days), 'starts', to_char(s.starts, 'HH24:MI'),
      'ends', to_char(s.ends, 'HH24:MI'), 'open_now', public.sales_auto_allot_open(false))
    from public.sales_auto_allot s
  );
end;
$$;

create function public.set_sales_auto_allot(p_on boolean, p_days integer[], p_starts time, p_ends time)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if not exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin' and u.is_active) then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  if p_on is null or p_days is null or cardinality(p_days) = 0 or not (p_days <@ '{1,2,3,4,5,6,7}'::integer[]) then
    raise exception 'SALES_INVALID: Choose at least one working day.';
  end if;
  if p_starts is null or p_ends is null or p_starts >= p_ends then
    raise exception 'SALES_INVALID: The day must start before it ends.';
  end if;
  update public.sales_auto_allot
  set is_on = p_on, days = (select array_agg(distinct d order by d) from unnest(p_days) d), starts = p_starts, ends = p_ends,
      set_by = v_uid, set_at = now();
  return public.get_sales_auto_allot();
end;
$$;

create function public.set_sales_allot_person(p_user uuid, p_level text, p_export boolean, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if not exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin' and u.is_active) then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user) then raise exception 'SALES_NOT_FOUND'; end if;
  if p_level is null or p_level not in ('senior', 'mid', 'junior', 'backup', 'manual') then
    raise exception 'SALES_INVALID: Choose a level.';
  end if;
  if p_limit is null or p_limit not between 0 and 200 then
    raise exception 'SALES_INVALID: The daily limit is a number from 0 to 200.';
  end if;
  insert into public.sales_allot_people (user_id, level, takes_export, daily_limit, set_by, set_at)
  values (p_user, p_level, coalesce(p_export, false), p_limit, v_uid, now())
  on conflict (user_id) do update
  set level = excluded.level, takes_export = excluded.takes_export, daily_limit = excluded.daily_limit,
      set_by = excluded.set_by, set_at = excluded.set_at;
  return jsonb_build_object('status', 'saved');
end;
$$;

-- "Allot waiting leads now", for whoever allots. Runs the rule whatever the hours say: it is pressed on purpose.
create function public.allot_waiting_sales_leads()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := public.sales_leads_require('assign');
begin
  return jsonb_build_object('allotted', public.sales_lead_allot_waiting());
end;
$$;

-- The Team page: Premium leads given this week to a Junior or Backup, to hand to a Senior if the owner wishes.
create function public.sales_premium_misplaced()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := public.sales_leads_require(null);
begin
  if not public.sales_lead_sees_all(v_uid) then raise exception 'SALES_FORBIDDEN' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(public.sales_lead_row(l) || jsonb_build_object('level', p.level) order by l.assigned_at desc)
    from public.sales_leads l
    join public.sales_allot_people p on p.user_id = l.assigned_to and p.level in ('junior', 'backup')
    where l.stage not in ('converted', 'dead') and l.assigned_at >= now() - interval '7 days'
      and public.sales_lead_premium(l) is not null
  ), '[]'::jsonb);
end;
$$;

-- ═══ 5. Re-issued: the lead as the screens see it, with Premium (20270530000000 + premium) ══════════════════════

create or replace function public.sales_lead_row(l public.sales_leads)
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
    'updated_at', l.updated_at,
    'stage', l.stage,
    'temperature', l.temperature,
    'segment', l.segment,
    'client_type', l.client_type,
    'market', l.market,
    'quantity', l.quantity,
    'timeline', l.timeline,
    'expected_value_paise', l.expected_value_paise,
    'next_step', l.next_step,
    'next_due_on', l.next_due_on,
    'first_attempt_at', l.first_attempt_at,
    'first_contact_at', l.first_contact_at,
    'last_activity_at', l.last_activity_at,
    'last_kind', l.last_kind,
    'no_answer_streak', l.no_answer_streak,
    'enquired_again_at', l.enquired_again_at,
    'dead_reason', l.dead_reason,
    'dead_note', l.dead_note,
    'closed_at', l.closed_at,
    'is_history', l.is_history,
    'stuck', public.sales_lead_stuck(l),
    'premium', public.sales_lead_premium(l)
  );
$$;

-- ═══ 6. Re-issued: Control Center's Sales team (20270529000000 + level, export, daily limit) ═════════════════════

create or replace function public.list_sales_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if not exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin' and u.is_active) then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id, 'name', u.full_name, 'is_admin', u.role = 'admin',
      'candidate', public.is_eligible_order_assignee(u.id),
      'view', public.resolve_permission(u.id, 'sales', 'view'),
      'view_all', public.resolve_permission(u.id, 'sales', 'view_all'),
      'create', public.resolve_permission(u.id, 'sales', 'create'),
      'edit', public.resolve_permission(u.id, 'sales', 'edit'),
      'assign', public.resolve_permission(u.id, 'sales', 'assign'),
      'juniors', coalesce((select jsonb_agg(a.subject_id) from public.sales_lead_access a where a.viewer_id = u.id), '[]'::jsonb),
      -- Whether leads can be given to them now, and the choice made for them (null: what their job means).
      'can_hold', public.sales_lead_can_hold(u.id),
      'hold_set', (select h.can_hold from public.sales_lead_holding h where h.user_id = u.id),
      -- Automatic allotment: no row is Manual only.
      'level', coalesce(p.level, 'manual'),
      'takes_export', coalesce(p.takes_export, false),
      'daily_limit', coalesce(p.daily_limit, 25)
    ) order by u.full_name)
    from public.users u
    left join public.sales_allot_people p on p.user_id = u.id
    where u.is_active
  ), '[]'::jsonb);
end;
$$;

-- ═══ 7. Re-issued: the morning run gives what waits (20270527000000 + the waiting leads) ═══════════════════════

create or replace function public.sales_lead_send_alerts(p_slot text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from timestamptz := ((now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata';
  v_sent integer := 0;
  v_n integer;
  v_missed integer;
  x record;
begin
  if p_slot not in ('morning', 'evening') then raise exception 'SALES_INVALID: Unknown slot.'; end if;
  if extract(dow from v_today) = 0 then return 0; end if;

  -- Leads that came in after hours, or that nobody could take, are given before the day's alerts count them.
  if p_slot = 'morning' and public.sales_auto_allot_open(true) then
    perform public.sales_lead_allot_waiting();
  end if;

  if p_slot = 'morning' then
    for x in
      select l.assigned_to as id, count(*)::integer as n, count(*) filter (where l.next_due_on < v_today)::integer as late
      from public.sales_leads l
      where l.assigned_to is not null and l.stage not in ('converted', 'dead') and l.next_due_on <= v_today
        and not exists (
          select 1 from public.notifications n
          where n.user_id = l.assigned_to and n.type::text = 'sales_followups_due' and n.created_at >= v_from
        )
      group by l.assigned_to
    loop
      perform public.sales_lead_notify(x.id, null, 'sales_followups_due',
        x.n || case when x.n = 1 then ' follow-up today' else ' follow-ups today' end,
        case when x.late > 0 then x.late || ' overdue. Open My day.' else 'Open My day.' end);
      v_sent := v_sent + 1;
    end loop;

    select count(*) into v_missed from public.sales_leads l
    where l.assigned_to is not null and l.stage not in ('converted', 'dead') and l.imported_at is null
      and l.first_attempt_at is null and (l.assigned_at at time zone 'Asia/Kolkata')::date < v_today;
    if v_missed > 0 then
      for x in
        select u.id from public.users u
        where u.is_active
          and (u.role = 'admin' or public.resolve_permission(u.id, 'sales', 'view_all') or public.resolve_permission(u.id, 'sales', 'assign'))
          and not exists (
            select 1 from public.notifications n
            where n.user_id = u.id and n.type::text = 'sales_first_call_missed' and n.created_at >= v_from
          )
      loop
        perform public.sales_lead_notify(x.id, null, 'sales_first_call_missed',
          v_missed || case when v_missed = 1 then ' lead has not had its first call' else ' leads have not had their first call' end,
          'Open the Team page to see who holds them.');
        v_sent := v_sent + 1;
      end loop;
    end if;
  else
    for x in
      select l.assigned_to as id, count(*)::integer as n
      from public.sales_leads l
      where l.assigned_to is not null and l.stage not in ('converted', 'dead') and l.first_attempt_at is null
        and (l.imported_at is null or l.next_due_on <= v_today)
        and not exists (
          select 1 from public.notifications n
          where n.user_id = l.assigned_to and n.type::text = 'sales_first_call_missed' and n.created_at >= v_from + interval '12 hours'
        )
      group by l.assigned_to
    loop
      v_n := x.n;
      perform public.sales_lead_notify(x.id, null, 'sales_first_call_missed',
        v_n || case when v_n = 1 then ' new lead not called yet' else ' new leads not called yet' end,
        'Call today. Open My day.');
      v_sent := v_sent + 1;
    end loop;
  end if;
  return v_sent;
end;
$$;

-- ═══ 8. Re-issued: the website capture gives the lead at once (20270531000100 + the rule) ═══════════════════════

create or replace function public.capture_sales_leads(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_phone text;
  v_ref text;
  v_row public.sales_leads;
  v_lead uuid;
  v_msg text;
  v_email text;
  v_name text;
  v_who text;
  v_source text;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_closed boolean;
  v_created integer := 0;
  v_repeat integer := 0;
  v_already integer := 0;
  v_allotted integer := 0;
  v_failed jsonb := '[]'::jsonb;
  -- Given at once in working hours; otherwise the allotters hear what happens next.
  v_open boolean := public.sales_auto_allot_open(false);
  v_note text := case
    when v_open then 'Nobody is free to take it now: allot it in Lead Master.'
    when (select s.is_on from public.sales_auto_allot s) then 'It will be allotted automatically next working morning.'
    else 'Allot it in Lead Master.'
  end;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'SALES_INVALID: Send up to 100 rows at a time.';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_lead_phone(r ->> 'phone');
    if v_phone is null then
      v_failed := v_failed || jsonb_build_object('key', left(r ->> 'key', 80), 'why', 'no valid number');
      continue;
    end if;
    v_ref := 'web:' || coalesce(left(nullif(btrim(r ->> 'key'), ''), 200), md5(r::text));
    if exists (select 1 from public.sales_lead_import_refs x where x.ref = v_ref) then
      v_already := v_already + 1;
      continue;
    end if;

    begin
      v_msg := left(nullif(btrim(r ->> 'message'), ''), 4000);
      v_name := left(nullif(btrim(r ->> 'name'), ''), 120);
      v_email := lower(nullif(btrim(r ->> 'email'), ''));
      if v_email is not null and (length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then v_email := null; end if;
      v_source := case when lower(coalesce(r ->> 'form_type', '')) like '%google ads%' then 'google_ads' else 'website' end;
      v_who := coalesce(v_name, v_phone);

      select * into v_row from public.sales_leads l where l.phone_e164 = v_phone for update;

      if v_row.id is null then
        insert into public.sales_leads (phone_e164, source, name, email, location, requirement)
        values (v_phone, v_source, v_name, v_email, left(nullif(btrim(r ->> 'location'), ''), 120), v_msg)
        returning id into v_lead;
        insert into public.sales_lead_events (lead_id, kind, detail) values (v_lead, 'added', 'website form');
        if v_open and public.sales_lead_auto_allot(v_lead) is not null then
          v_allotted := v_allotted + 1;
        else
          perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'New lead from the website',
            left(v_who || '. ' || v_note || coalesce(' ' || v_msg, ''), 300));
        end if;
        v_created := v_created + 1;
      else
        v_lead := v_row.id;
        v_closed := v_row.stage in ('converted', 'dead');
        update public.sales_leads l
        set stage = case when v_closed then 'new' else l.stage end,
            stage_changed_at = case when v_closed then now() else l.stage_changed_at end,
            dead_reason = case when v_closed then null else l.dead_reason end,
            dead_note = case when v_closed then null else l.dead_note end,
            closed_at = case when v_closed then null else l.closed_at end,
            next_step = case when l.assigned_to is null then l.next_step when v_closed then 'Call back' else l.next_step end,
            next_due_on = case when l.assigned_to is null then l.next_due_on when v_closed then v_today else least(l.next_due_on, v_today) end,
            is_history = false,
            name = coalesce(l.name, v_name),
            email = coalesce(l.email, v_email),
            location = coalesce(l.location, left(nullif(btrim(r ->> 'location'), ''), 120)),
            requirement = case
              when v_msg is null then l.requirement
              when l.requirement is null then v_msg
              when position(left(v_msg, 200) in l.requirement) > 0 then l.requirement
              else left(l.requirement || E'\n\n' || v_msg, 4000)
            end,
            enquired_again_at = now(),
            updated_at = now()
        where l.id = v_lead
        returning * into v_row;
        insert into public.sales_lead_events (lead_id, kind, detail) values (v_lead, 'enquired_again', 'website form');
        if v_row.assigned_to is not null and public.sales_lead_can_hold(v_row.assigned_to) then
          perform public.sales_lead_notify(v_row.assigned_to, v_lead, 'sales_lead_enquired_again', 'A lead enquired again',
            left(v_who || ' filled the website form again. Call today.', 300));
        elsif v_open and public.sales_lead_auto_allot(v_lead) is not null then
          v_allotted := v_allotted + 1;
        else
          perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'A lead came back from the website',
            left(v_who || '. ' || v_note || coalesce(' ' || v_msg, ''), 300));
        end if;
        v_repeat := v_repeat + 1;
      end if;

      insert into public.sales_lead_import_refs (ref, lead_id, at) values (v_ref, v_lead, now());
    exception
      when check_violation or not_null_violation or invalid_text_representation or string_data_right_truncation then
        v_failed := v_failed || jsonb_build_object('key', left(r ->> 'key', 80), 'why', 'details the database refused');
    end;
  end loop;

  return jsonb_build_object('created', v_created, 'repeat', v_repeat, 'already', v_already, 'allotted', v_allotted,
    'failed', v_failed);
end;
$$;

-- ═══ 9. Who may call what ═══════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_lead_premium(public.sales_leads) from public, anon, authenticated;
revoke all on function public.sales_auto_allot_open(boolean) from public, anon, authenticated;
revoke all on function public.sales_lead_pick(public.sales_leads) from public, anon, authenticated;
revoke all on function public.sales_lead_auto_allot(uuid) from public, anon, authenticated;
revoke all on function public.sales_lead_allot_waiting() from public, anon, authenticated;
revoke all on function public.get_sales_auto_allot() from public, anon;
revoke all on function public.set_sales_auto_allot(boolean, integer[], time, time) from public, anon;
revoke all on function public.set_sales_allot_person(uuid, text, boolean, integer) from public, anon;
revoke all on function public.allot_waiting_sales_leads() from public, anon;
revoke all on function public.sales_premium_misplaced() from public, anon;
grant execute on function public.get_sales_auto_allot(), public.set_sales_auto_allot(boolean, integer[], time, time),
  public.set_sales_allot_person(uuid, text, boolean, integer), public.allot_waiting_sales_leads(),
  public.sales_premium_misplaced() to authenticated;

-- ═══ 10. Self-checks ════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_fn text;
  v_lead public.sales_leads;
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.sales_auto_allot'::regclass)
     or not (select c.relrowsecurity from pg_class c where c.oid = 'public.sales_allot_people'::regclass) then
    raise exception 'SALES_AUTO_ALLOT: row level security must be on for both new tables';
  end if;
  if has_table_privilege('authenticated', 'public.sales_auto_allot', 'SELECT')
     or has_table_privilege('authenticated', 'public.sales_allot_people', 'SELECT') then
    raise exception 'SALES_AUTO_ALLOT: a browser must not reach the settings tables';
  end if;
  if (select count(*) from public.sales_auto_allot) <> 1 then raise exception 'SALES_AUTO_ALLOT: one settings row'; end if;

  foreach v_fn in array array['public.sales_lead_premium(public.sales_leads)', 'public.sales_auto_allot_open(boolean)',
    'public.sales_lead_pick(public.sales_leads)', 'public.sales_lead_auto_allot(uuid)', 'public.sales_lead_allot_waiting()'] loop
    if has_function_privilege('authenticated', v_fn, 'EXECUTE') then raise exception 'SALES_AUTO_ALLOT: % is internal', v_fn; end if;
  end loop;
  foreach v_fn in array array['public.get_sales_auto_allot()', 'public.set_sales_auto_allot(boolean, integer[], time, time)',
    'public.set_sales_allot_person(uuid, text, boolean, integer)', 'public.allot_waiting_sales_leads()',
    'public.sales_premium_misplaced()', 'public.list_sales_team()'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'SALES_AUTO_ALLOT: % must be for signed-in users only', v_fn;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.capture_sales_leads(jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.capture_sales_leads(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sales_lead_send_alerts(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.sales_lead_send_alerts(text)', 'EXECUTE') then
    raise exception 'SALES_AUTO_ALLOT: the capture and the alerts are for the service role only';
  end if;

  -- What counts as Premium.
  v_lead := jsonb_populate_record(null::public.sales_leads, '{"requirement": "New restaurant, 250 seats, 40 tables"}');
  if public.sales_lead_premium(v_lead) is distinct from '250 seats' then raise exception 'SALES_AUTO_ALLOT: 250 seats is Premium'; end if;
  v_lead := jsonb_populate_record(null::public.sales_leads, '{"requirement": "Hotel project with 40 rooms and a cafe for 60 pax"}');
  if public.sales_lead_premium(v_lead) is distinct from '40 rooms' then raise exception 'SALES_AUTO_ALLOT: 40 rooms is Premium'; end if;
  v_lead := jsonb_populate_record(null::public.sales_leads, '{"requirement": "Budget around 1.5 cr"}');
  if public.sales_lead_premium(v_lead) is distinct from '₹150 lakh' then raise exception 'SALES_AUTO_ALLOT: 1.5 cr is Premium'; end if;
  v_lead := jsonb_populate_record(null::public.sales_leads, '{"requirement": "Cafe, 60 chairs, 12 rooms, budget 8 lakh", "quantity": "Above 100+"}');
  if public.sales_lead_premium(v_lead) is not null then raise exception 'SALES_AUTO_ALLOT: a small cafe is not Premium'; end if;
  v_lead := jsonb_populate_record(null::public.sales_leads, '{"expected_value_paise": 200000000}');
  if public.sales_lead_premium(v_lead) is distinct from 'expected ₹20 lakh' then raise exception 'SALES_AUTO_ALLOT: an expected ₹20 lakh is Premium'; end if;
end $$;

do $$
begin
  if (select count(*) from public.sales_allot_people) < 7 then
    raise notice 'SALES_AUTO_ALLOT: % of 7 people placed by first name; place the rest in Control Center, Sales team',
      (select count(*) from public.sales_allot_people);
  end if;
end $$;
