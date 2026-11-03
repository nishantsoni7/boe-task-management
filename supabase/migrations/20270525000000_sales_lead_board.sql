-- 20270525000000_sales_lead_board.sql
--
-- Sales, Lead Board: where a salesperson works a lead after it has been allotted in the Lead Master.
--
-- What the owner decided (2026-11-03), and what this file does about it:
--   * Every lead starts in the Lead Master. Only an allotted lead reaches a person's My day and Board.
--   * Stage says how far the sale has come: new, under_process, potential, negotiation, then converted or dead;
--     follow_up_later parks a lead until a date. Segment and Hot / Warm / Cold are separate facts about the lead, and
--     Domestic / Export comes from the phone number by itself.
--   * NO OPEN ALLOTTED LEAD CAN EXIST WITHOUT A NEXT STEP AND A DATE: a CHECK constraint, not a screen rule.
--   * Dead asks for a reason from a fixed list. Converted is a record only: no order number, no link to Orders.
--   * A stage checklist: moving FORWARD needs the facts of that stage (first contact; requirement and quantity;
--     quotation, expected value and timeline). Moving back never does. Imported leads stay where they are.
--   * Everyone sees their own leads. Admin, `view_all` (a manager) and `assign` (who allots) see all of them. A senior
--     can be given named juniors in sales_lead_access. THE LEAD MASTER FOLLOWS THE SAME RULE: this REVERSES 20270524's
--     "view reads every lead". A person who adds leads (`create`) also sees the leads they added until they are
--     allotted. The duplicate check still names the holder of a number, and shows nothing more than that.
--
-- WRITE: only the functions below. Working a lead (logging, moving) needs the holder, Admin or `assign`.
-- A person with `view_all` reads and does not work: the same meaning `view_all` has everywhere else in BOE One.
--
-- History stays append-only: a logged interaction is never edited. Undo marks it undone (undone_at, the only column
-- that can ever change) and puts back the state it replaced, and only for the person who logged it, for 10 minutes,
-- while it is still the latest thing that happened on the lead.
--
-- ROLLBACK (loses what has been logged, export it first):
--   drop function public.sales_board(text, text, text, text, text, text), public.sales_my_day(),
--     public.log_sales_lead_activity(uuid, text, text, text, text, date), public.sales_lead_no_answer(uuid),
--     public.sales_lead_message_sent(uuid, text), public.undo_sales_lead_activity(uuid),
--     public.move_sales_lead(uuid, text, text, text, text, text, date), public.update_sales_lead_facts(uuid, jsonb, timestamptz),
--     public.record_sales_lead_enquiry(uuid, text, text), public.sales_lead_record(public.sales_leads, text, text, text, text, date, boolean, integer),
--     public.sales_lead_for_work(uuid), public.sales_lead_row(public.sales_leads), public.sales_lead_stuck(public.sales_leads),
--     public.sales_lead_activities_guard();
--   drop table public.sales_lead_activities, public.sales_lead_access;
--   then re-run the 20270524 definitions of sales_lead_json, sales_leads_page, get_sales_lead, allot_sales_lead and its
--   two read policies, drop sales_lead_visible and sales_lead_sees_all, and drop the new columns of sales_leads;
--   delete the sales:view_all rows from employee_permission_overrides, role_permissions and module_permission_actions.

-- ═══ 1. Registration ═════════════════════════════════════════════════════════

update public.app_modules
set description = 'Sales: My day, the Lead Board and the Lead Master.'
where module_key = 'sales';

update public.permission_modules
set description = 'Sales: My day, the Lead Board and the Lead Master.'
where module_key = 'sales';

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view_all'
where pm.module_key = 'sales'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id
join public.permission_actions pa on pa.id = mpa.action_id
where pm.module_key = 'sales' and pa.action_key = 'view_all'
on conflict (role, module_id, action_id) do nothing;

-- ═══ 2. The lead grows ═══════════════════════════════════════════════════════

alter table public.sales_leads
  add column stage text not null default 'new' check (stage in (
    'new', 'under_process', 'potential', 'negotiation', 'follow_up_later', 'converted', 'dead'
  )),
  add column stage_changed_at timestamptz not null default now(),
  add column temperature text not null default 'warm' check (temperature in ('hot', 'warm', 'cold')),
  add column segment text check (segment in ('bulk', 'residential', 'reseller')),
  add column client_type text check (client_type in ('hotel', 'resort', 'restaurant', 'cafe', 'other')),
  add column quantity text check (quantity is null or length(quantity) between 1 and 200),
  add column timeline text check (timeline is null or length(timeline) between 1 and 200),
  add column expected_value_paise bigint check (expected_value_paise is null or expected_value_paise >= 0),
  add column next_step text check (next_step is null or length(next_step) between 1 and 120),
  add column next_due_on date,
  -- first_attempt_at stops the "Waiting" clock (a call nobody answered still counts); first_contact_at is a real reply.
  add column first_attempt_at timestamptz,
  add column first_contact_at timestamptz,
  add column last_activity_at timestamptz,
  add column last_kind text,
  add column no_answer_streak integer not null default 0 check (no_answer_streak >= 0),
  add column enquired_again_at timestamptz,
  add column dead_reason text check (dead_reason in (
    'price_too_high', 'chose_another_supplier', 'not_responding', 'quantity_too_small', 'project_cancelled',
    'delivery_time', 'retail_enquiry', 'wrong_number', 'other'
  )),
  add column dead_note text check (dead_note is null or length(dead_note) between 1 and 2000),
  add column closed_at timestamptz,
  -- +91 is India and nothing else starts with it: country codes never prefix one another.
  add column market text generated always as (case when phone_e164 like '+91%' then 'domestic' else 'export' end) stored;

-- Anything allotted before this file arrived gets its first step, or the rule below could not hold.
update public.sales_leads
set next_step = 'First call', next_due_on = (now() at time zone 'Asia/Kolkata')::date
where assigned_to is not null;

alter table public.sales_leads
  add constraint sales_leads_open_has_next_step check (
    assigned_to is null or stage in ('converted', 'dead') or (next_step is not null and next_due_on is not null)
  ),
  add constraint sales_leads_dead_has_reason check ((stage = 'dead') = (dead_reason is not null));

create index sales_leads_work_idx on public.sales_leads (assigned_to, stage, next_due_on);

alter table public.sales_lead_events drop constraint sales_lead_events_kind_check;
alter table public.sales_lead_events add constraint sales_lead_events_kind_check
  check (kind in ('added', 'allotted', 'reassigned', 'edited', 'moved', 'enquired_again'));

-- ═══ 3. New tables ═══════════════════════════════════════════════════════════

-- What was done with a lead and how it went. Append-only but for undone_at. `prior` is what Undo puts back.
create table public.sales_lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads (id),
  kind text not null check (kind in ('call', 'whatsapp', 'meeting', 'email', 'quotation', 'sample')),
  outcome text not null check (outcome in ('interested', 'still_deciding', 'call_back', 'no_answer', 'sent')),
  note text check (note is null or length(note) between 1 and 4000),
  next_step text,
  next_due_on date,
  prior jsonb not null,
  actor uuid,
  at timestamptz not null default now(),
  undone_at timestamptz
);
create index sales_lead_activities_lead_idx on public.sales_lead_activities (lead_id, at desc);
create index sales_lead_activities_actor_idx on public.sales_lead_activities (actor, at desc);

create function public.sales_lead_activities_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and old.undone_at is null and new.undone_at is not null
     and (to_jsonb(new) - 'undone_at') = (to_jsonb(old) - 'undone_at') then
    return new;
  end if;
  raise exception 'SALES_LEAD_ACTIVITIES_APPEND_ONLY: what was logged on a lead is never changed';
end;
$$;

create trigger sales_lead_activities_guard
  before update or delete on public.sales_lead_activities
  for each row execute function public.sales_lead_activities_guard();

-- A senior who may read a named junior's leads. Filled in by an administrator.
create table public.sales_lead_access (
  viewer_id uuid not null references public.users (id) on delete cascade,
  subject_id uuid not null references public.users (id) on delete cascade,
  granted_by uuid references public.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (viewer_id, subject_id),
  check (viewer_id <> subject_id)
);

do $$
declare t text;
begin
  foreach t in array array['sales_lead_activities', 'sales_lead_access'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ═══ 4. Who sees what ════════════════════════════════════════════════════════

create function public.sales_lead_sees_all(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.users u where u.id = p_uid and u.role = 'admin')
      or public.resolve_permission(p_uid, 'sales', 'view_all')
      or public.resolve_permission(p_uid, 'sales', 'assign');
$$;

create function public.sales_lead_visible(p_assigned uuid, p_created uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    p_assigned = auth.uid()
    or (p_assigned is null and p_created = auth.uid())
    or public.sales_lead_sees_all(auth.uid())
    or exists (select 1 from public.sales_lead_access a where a.viewer_id = auth.uid() and a.subject_id = p_assigned)
  );
$$;

drop policy sales_leads_read on public.sales_leads;
create policy sales_leads_read on public.sales_leads for select to authenticated
  using (public.module_entry_open('sales') and public.sales_lead_visible(assigned_to, created_by));

drop policy sales_lead_events_read on public.sales_lead_events;
create policy sales_lead_events_read on public.sales_lead_events for select to authenticated
  using (exists (select 1 from public.sales_leads l where l.id = lead_id));

grant select on table public.sales_lead_activities to authenticated;
create policy sales_lead_activities_read on public.sales_lead_activities for select to authenticated
  using (exists (select 1 from public.sales_leads l where l.id = lead_id));

create policy sales_lead_access_read on public.sales_lead_access for select to authenticated
  using (viewer_id = auth.uid());
grant select on table public.sales_lead_access to authenticated;

-- ═══ 5. Internal helpers (not callable from a browser) ═══════════════════════

-- The card goes red when nothing has happened for too long. New 1 day, Under process and Potential client 7,
-- Negotiation 3. Follow up later has no limit on purpose: a lead parked until December is not forgotten.
create function public.sales_lead_stuck(l public.sales_leads)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select l.assigned_to is not null and coalesce(
    greatest(l.assigned_at, l.last_activity_at, l.stage_changed_at, l.enquired_again_at) < now() - case l.stage
      when 'new' then interval '1 day'
      when 'under_process' then interval '7 days'
      when 'potential' then interval '7 days'
      when 'negotiation' then interval '3 days'
    end,
    false
  );
$$;

-- One lead as the screens read it, with no question asked: for rows a function has already filtered.
create function public.sales_lead_row(l public.sales_leads)
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
    'stuck', public.sales_lead_stuck(l)
  );
$$;

-- The lead for one person: all of it if they may see it, otherwise only what the duplicate warning says. This is what
-- the Lead Master's number check, add and edit have always called, so they inherit the rule from this one place.
create or replace function public.sales_lead_json(l public.sales_leads)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.sales_lead_visible(l.assigned_to, l.created_by) then public.sales_lead_row(l)
  else jsonb_build_object(
    'id', l.id,
    'lead_no', l.lead_no,
    'received_on', l.received_on,
    'phone', l.phone_e164,
    'source', l.source,
    'assigned_to', l.assigned_to,
    'holder_name', (select u.full_name from public.users u where u.id = l.assigned_to),
    'assigned_at', l.assigned_at,
    'updated_at', l.updated_at
  ) end;
$$;

-- The lead, locked, for somebody allowed to work it: the holder, Admin or `assign`.
create function public.sales_lead_for_work(p_id uuid)
returns public.sales_leads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_row public.sales_leads;
begin
  select * into v_row from public.sales_leads where id = p_id for update;
  if v_row.id is null or not public.sales_lead_visible(v_row.assigned_to, v_row.created_by) then
    raise exception 'SALES_NOT_FOUND';
  end if;
  if v_row.assigned_to is null then raise exception 'SALES_INVALID: Allot this lead in the Lead Master first.'; end if;
  if v_row.assigned_to = v_uid
     or exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin')
     or public.resolve_permission(v_uid, 'sales', 'assign') then
    return v_row;
  end if;
  raise exception 'SALES_FORBIDDEN' using errcode = '42501';
end;
$$;

-- One entry in the log, and what it does to the lead. Everything Undo needs is kept on the entry. A real reply on a
-- New lead moves it to Under process, so the salesperson does not have to do that by hand as well.
create function public.sales_lead_record(
  l public.sales_leads, p_kind text, p_outcome text, p_note text, p_next_step text, p_next_due date,
  p_contact boolean, p_streak integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_stage text := case when p_contact and l.stage = 'new' then 'under_process' else l.stage end;
begin
  insert into public.sales_lead_activities (lead_id, kind, outcome, note, next_step, next_due_on, actor, prior)
  values (l.id, p_kind, p_outcome, nullif(btrim(p_note), ''), p_next_step, p_next_due, v_uid, jsonb_build_object(
    'stage', l.stage, 'stage_changed_at', l.stage_changed_at, 'next_step', l.next_step, 'next_due_on', l.next_due_on,
    'first_attempt_at', l.first_attempt_at, 'first_contact_at', l.first_contact_at, 'last_activity_at', l.last_activity_at,
    'last_kind', l.last_kind, 'no_answer_streak', l.no_answer_streak
  ))
  returning id into v_id;

  update public.sales_leads
  set stage = v_stage,
      stage_changed_at = case when v_stage <> l.stage then now() else stage_changed_at end,
      next_step = p_next_step,
      next_due_on = p_next_due,
      first_attempt_at = coalesce(first_attempt_at, now()),
      first_contact_at = case when p_contact then coalesce(first_contact_at, now()) else first_contact_at end,
      last_activity_at = now(),
      last_kind = p_kind,
      no_answer_streak = p_streak,
      updated_at = now()
  where id = l.id;

  if v_stage <> l.stage then
    insert into public.sales_lead_events (lead_id, kind, detail, actor) values (l.id, 'moved', l.stage || '>' || v_stage, v_uid);
  end if;
  return v_id;
end;
$$;

-- ═══ 6. Reads ════════════════════════════════════════════════════════════════

-- The Lead Master list, as in 20270524, now limited to the leads this person may see.
create or replace function public.sales_leads_page(
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
  v_uid uuid;
  v_all boolean;
  v_juniors uuid[];
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
  v_uid := public.sales_leads_require(null);
  v_all := public.sales_lead_sees_all(v_uid);
  select coalesce(array_agg(a.subject_id), '{}') into v_juniors from public.sales_lead_access a where a.viewer_id = v_uid;
  v_from := case p_period when 'today' then v_today when 'week' then v_today - 6 when 'month' then v_today - 29 else null end;

  with mine as (
    select l.* from public.sales_leads l
    where v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors) or (l.assigned_to is null and l.created_by = v_uid)
  ),
  periods as (
    select jsonb_build_object(
      'today', count(*) filter (where received_on = v_today),
      'week',  count(*) filter (where received_on >= v_today - 6),
      'month', count(*) filter (where received_on >= v_today - 29),
      'all',   count(*)
    ) as j from mine
  ),
  base as (
    select l.id, l.lead_no, l.received_on, l.assigned_to
    from mine l
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
    (select j from periods),
    (select count(*) from base),
    (select count(*) from base where assigned_to is null),
    (select coalesce(jsonb_agg(jsonb_build_object('id', h.assigned_to, 'name', u.full_name, 'n', h.n) order by u.full_name), '[]'::jsonb)
       from held h join public.users u on u.id = h.assigned_to),
    (select count(*) from shown),
    (select coalesce(jsonb_agg(public.sales_lead_row(s) order by s.received_on desc, s.lead_no desc), '[]'::jsonb)
       from public.sales_leads s
       where s.id in (select x.id from shown x order by x.received_on desc, x.lead_no desc limit v_lim offset v_off))
  into v_periods, v_everyone, v_unallotted, v_holders, v_total, v_rows;

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

-- One lead with everything that happened to it, for somebody who may see it. `can_work` is what the screen shows; the
-- writes decide again for themselves. A lead the person may not see is the same answer as a lead that does not exist.
create or replace function public.get_sales_lead(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_row public.sales_leads;
begin
  select * into v_row from public.sales_leads where id = p_id;
  if v_row.id is null or not public.sales_lead_visible(v_row.assigned_to, v_row.created_by) then
    raise exception 'SALES_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'lead', public.sales_lead_row(v_row),
    'can_work', v_row.assigned_to is not null and (
      v_row.assigned_to = v_uid
      or exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin')
      or public.resolve_permission(v_uid, 'sales', 'assign')
    ),
    'quotation_sent', exists (
      select 1 from public.sales_lead_activities a where a.lead_id = p_id and a.kind = 'quotation' and a.undone_at is null
    ),
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
    ),
    'activities', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'kind', x.kind, 'outcome', x.outcome, 'note', x.note, 'next_step', x.next_step,
        'next_due_on', x.next_due_on, 'actor_name', a.full_name, 'at', x.at
      ) order by x.at desc, x.id), '[]'::jsonb)
      from public.sales_lead_activities x
      left join public.users a on a.id = x.actor
      where x.lead_id = p_id and x.undone_at is null
    )
  );
end;
$$;

-- My day: the leads of the person asking that need something now. New leads nobody has tried yet, whatever their date,
-- and everything due today or earlier, including a parked lead whose date has come. The ranking is the screen's.
create function public.sales_my_day()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  return jsonb_build_object(
    'rows', (
      select coalesce(jsonb_agg(public.sales_lead_row(l)), '[]'::jsonb)
      from public.sales_leads l
      where l.assigned_to = v_uid and l.stage not in ('converted', 'dead')
        and (l.next_due_on <= v_today or (l.stage <> 'follow_up_later' and l.first_attempt_at is null))
    ),
    'done_today', (
      select count(distinct a.lead_id)
      from public.sales_lead_activities a
      where a.actor = v_uid and a.undone_at is null and (a.at at time zone 'Asia/Kolkata')::date = v_today
    ),
    'coming_up', (
      select count(*)
      from public.sales_leads l
      where l.assigned_to = v_uid and l.stage not in ('converted', 'dead')
        and l.next_due_on > v_today and l.next_due_on <= v_today + 7
        and (l.stage = 'follow_up_later' or l.first_attempt_at is not null)
    )
  );
end;
$$;

-- The board: the open leads this person may see, most urgent first in each stage, 60 to a stage, with the real count
-- and value of each stage whatever is loaded. p_holder: all | a user id.
create function public.sales_board(
  p_holder text default 'all',
  p_market text default null,
  p_segment text default null,
  p_temperature text default null,
  p_source text default null,
  p_q text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_all boolean := public.sales_lead_sees_all(v_uid);
  v_juniors uuid[];
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_q text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(btrim(coalesce(p_q, '')), '[^0-9]', '', 'g');
  v_like text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_holder uuid := case when p_holder ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_holder::uuid end;
  v_result jsonb;
begin
  select coalesce(array_agg(a.subject_id), '{}') into v_juniors from public.sales_lead_access a where a.viewer_id = v_uid;

  with mine as (
    select l.*, public.sales_lead_stuck(l) as is_stuck from public.sales_leads l
    where l.assigned_to is not null and (v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors))
  ),
  filtered as (
    select l.* from mine l
    where (v_holder is null or l.assigned_to = v_holder)
      and (coalesce(p_market, '') = '' or l.market = p_market)
      and (coalesce(p_segment, '') = '' or l.segment = p_segment)
      and (coalesce(p_temperature, '') = '' or l.temperature = p_temperature)
      and (coalesce(p_source, '') = '' or l.source = p_source)
      and (v_q = ''
        or (length(v_digits) >= 3 and l.phone_e164 like '%' || v_digits || '%')
        or l.name ilike v_like or l.location ilike v_like or l.requirement ilike v_like)
  ),
  shown as (
    select l.*, row_number() over (
      partition by l.stage
      order by
        case when l.stage in ('converted', 'dead') then 0 else 1 end,
        l.closed_at desc nulls last,
        case when l.stage = 'follow_up_later' then 3 when l.next_due_on < v_today then 0 when l.next_due_on = v_today then 1 else 2 end,
        case l.temperature when 'hot' then 0 when 'warm' then 1 else 2 end,
        l.expected_value_paise desc nulls last,
        l.next_due_on, l.lead_no
    ) as rn
    from filtered l
    where l.stage not in ('converted', 'dead') or l.closed_at >= now() - interval '30 days'
  ),
  open_leads as (
    select l.* from filtered l where l.stage not in ('converted', 'dead')
  )
  select jsonb_build_object(
    'stats', (
      select jsonb_build_object(
        'open', count(*),
        'value_paise', coalesce(sum(l.expected_value_paise), 0),
        'overdue', count(*) filter (where l.stage <> 'follow_up_later' and l.next_due_on < v_today),
        'due_today', count(*) filter (where l.stage <> 'follow_up_later' and l.next_due_on = v_today),
        'stuck', count(*) filter (where l.is_stuck)
      ) from open_leads l
    ),
    'stages', (
      select coalesce(jsonb_object_agg(g.stage, jsonb_build_object('n', g.n, 'value_paise', g.v)), '{}'::jsonb)
      from (select stage, count(*) as n, coalesce(sum(expected_value_paise), 0) as v from shown group by stage) g
    ),
    'rows', (
      select coalesce(jsonb_agg(public.sales_lead_row(
        (select x from public.sales_leads x where x.id = s.id)
      ) order by s.stage, s.rn), '[]'::jsonb)
      from shown s where s.rn <= 60
    ),
    'holders', (
      select coalesce(jsonb_agg(jsonb_build_object('id', h.assigned_to, 'name', u.full_name, 'n', h.n) order by u.full_name), '[]'::jsonb)
      from (select assigned_to, count(*)::integer as n from mine where stage not in ('converted', 'dead') group by assigned_to) h
      join public.users u on u.id = h.assigned_to
    ),
    -- Only somebody who can do something about the queue is told its size.
    'waiting_allotment', case when v_all then (select count(*) from public.sales_leads l where l.assigned_to is null) end
  ) into v_result;

  return v_result;
end;
$$;

-- ═══ 7. Writes ═══════════════════════════════════════════════════════════════

-- Who can be given a lead, and the rule that an allotted lead always has a next step: the first call, today.
create or replace function public.allot_sales_lead(p_id uuid, p_to uuid, p_expected_from uuid default null)
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
  set assigned_to = p_to, assigned_at = now(), assigned_by = v_uid, updated_at = now(),
      next_step = coalesce(next_step, case when stage in ('converted', 'dead') then null else 'First call' end),
      next_due_on = coalesce(next_due_on, case when stage in ('converted', 'dead') then null else (now() at time zone 'Asia/Kolkata')::date end)
  where id = p_id
  returning * into v_row;

  insert into public.sales_lead_events (lead_id, kind, from_user, to_user, actor)
  values (p_id, case when p_expected_from is null then 'allotted' else 'reassigned' end, p_expected_from, p_to, v_uid);
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_row));
end;
$$;

-- Log what happened. A next step and its date are required, and that is the whole point.
create function public.log_sales_lead_activity(
  p_id uuid, p_kind text, p_outcome text, p_note text, p_next_step text, p_next_due date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_leads := public.sales_lead_for_work(p_id);
  v_step text := nullif(btrim(p_next_step), '');
  v_activity uuid;
begin
  if v_row.stage in ('converted', 'dead') then raise exception 'SALES_INVALID: Reopen this lead before logging on it.'; end if;
  if v_step is null or p_next_due is null then raise exception 'SALES_INVALID: Choose the next step and when.'; end if;
  if p_next_due < (now() at time zone 'Asia/Kolkata')::date then raise exception 'SALES_INVALID: The next step cannot be in the past.'; end if;
  if p_outcome = 'no_answer' then raise exception 'SALES_INVALID: Use the No answer button for this.'; end if;
  v_activity := public.sales_lead_record(v_row, p_kind, p_outcome, p_note, v_step, p_next_due, true, 0);
  select * into v_row from public.sales_leads where id = p_id;
  return jsonb_build_object('status', 'saved', 'activity_id', v_activity, 'lead', public.sales_lead_row(v_row));
exception
  when check_violation then raise exception 'SALES_INVALID: Check the details and try again.';
end;
$$;

-- One tap: nobody answered. The next try is tomorrow and the same step stands. The screen asks what next at three.
create function public.sales_lead_no_answer(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_leads := public.sales_lead_for_work(p_id);
  v_activity uuid;
begin
  if v_row.stage in ('converted', 'dead') then raise exception 'SALES_INVALID: Reopen this lead before logging on it.'; end if;
  v_activity := public.sales_lead_record(
    v_row, 'call', 'no_answer', null, v_row.next_step,
    (now() at time zone 'Asia/Kolkata')::date + 1, false, v_row.no_answer_streak + 1
  );
  select * into v_row from public.sales_leads where id = p_id;
  return jsonb_build_object('status', 'saved', 'activity_id', v_activity, 'streak', v_row.no_answer_streak, 'lead', public.sales_lead_row(v_row));
end;
$$;

-- A quick WhatsApp message was opened. BOE One cannot see whether it was sent, so it counts as an attempt and not as a
-- reply: the stage stays, and the same step comes back tomorrow.
create function public.sales_lead_message_sent(p_id uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_leads := public.sales_lead_for_work(p_id);
  v_activity uuid;
begin
  if v_row.stage in ('converted', 'dead') then raise exception 'SALES_INVALID: Reopen this lead before logging on it.'; end if;
  v_activity := public.sales_lead_record(
    v_row, 'whatsapp', 'sent', left(btrim(p_label), 80), v_row.next_step,
    (now() at time zone 'Asia/Kolkata')::date + 1, false, v_row.no_answer_streak
  );
  select * into v_row from public.sales_leads where id = p_id;
  return jsonb_build_object('status', 'saved', 'activity_id', v_activity, 'lead', public.sales_lead_row(v_row));
end;
$$;

-- Take back the last entry. See the header for the three limits.
create function public.undo_sales_lead_activity(p_activity uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_a public.sales_lead_activities;
  v_row public.sales_leads;
  v_stage_was text;
  p jsonb;
begin
  select * into v_a from public.sales_lead_activities where id = p_activity;
  if v_a.id is null or v_a.undone_at is not null or v_a.actor is distinct from v_uid then raise exception 'SALES_NOT_FOUND'; end if;
  v_row := public.sales_lead_for_work(v_a.lead_id);
  if v_a.at < now() - interval '10 minutes' then
    raise exception 'SALES_CHANGED: This can no longer be undone. Log what really happened instead.';
  end if;
  if exists (
    select 1 from public.sales_lead_activities a
    where a.lead_id = v_a.lead_id and a.undone_at is null and a.at > v_a.at
  ) or exists (
    select 1 from public.sales_lead_events e
    where e.lead_id = v_a.lead_id and e.kind = 'moved' and e.at > v_a.at
  ) then
    raise exception 'SALES_CHANGED: Something else has happened on this lead since. It can no longer be undone.';
  end if;

  p := v_a.prior;
  v_stage_was := v_row.stage;
  update public.sales_lead_activities set undone_at = now() where id = p_activity;
  update public.sales_leads
  set stage = p ->> 'stage',
      stage_changed_at = (p ->> 'stage_changed_at')::timestamptz,
      next_step = p ->> 'next_step',
      next_due_on = (p ->> 'next_due_on')::date,
      first_attempt_at = (p ->> 'first_attempt_at')::timestamptz,
      first_contact_at = (p ->> 'first_contact_at')::timestamptz,
      last_activity_at = (p ->> 'last_activity_at')::timestamptz,
      last_kind = p ->> 'last_kind',
      no_answer_streak = (p ->> 'no_answer_streak')::integer,
      updated_at = now()
  where id = v_row.id
  returning * into v_row;
  -- The entry had moved a New lead on by itself, so taking it back is a move too.
  if v_row.stage <> v_stage_was then
    insert into public.sales_lead_events (lead_id, kind, detail, actor)
    values (v_row.id, 'moved', v_stage_was || '>' || v_row.stage, v_uid);
  end if;
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_row(v_row));
end;
$$;

-- Move a lead. p_expected_from is the stage the screen showed: a stale board cannot move a lead it is out of date on.
-- Moving forward needs that stage's facts, and every stage before it. When a fact is missing nothing moves and
-- {status:'needs', missing:[...]} comes back, so the screen asks for just that fact instead of showing an error.
create function public.move_sales_lead(
  p_id uuid, p_to text, p_expected_from text,
  p_reason text default null, p_note text default null, p_next_step text default null, p_next_due date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_row public.sales_leads := public.sales_lead_for_work(p_id);
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_rank integer := case p_to when 'new' then 1 when 'under_process' then 2 when 'potential' then 3 when 'negotiation' then 4 else 0 end;
  v_from_rank integer := case v_row.stage when 'new' then 1 when 'under_process' then 2 when 'potential' then 3 when 'negotiation' then 4 else 0 end;
  v_missing text[] := '{}';
  v_closing boolean := p_to in ('converted', 'dead');
  v_reopening boolean := v_row.stage in ('converted', 'dead') and p_to not in ('converted', 'dead');
  v_step text := coalesce(nullif(btrim(p_next_step), ''), v_row.next_step);
  v_due date := coalesce(p_next_due, v_row.next_due_on);
begin
  v_uid := auth.uid();
  if p_to not in ('new', 'under_process', 'potential', 'negotiation', 'follow_up_later', 'converted', 'dead') then
    raise exception 'SALES_INVALID: Choose a stage.';
  end if;
  if v_row.stage is distinct from p_expected_from then
    raise exception 'SALES_CHANGED: This lead has moved since you opened it. The board has been refreshed.';
  end if;
  if v_row.stage = p_to then return jsonb_build_object('status', 'unchanged', 'lead', public.sales_lead_row(v_row)); end if;

  if p_to = 'dead' and p_reason is null then raise exception 'SALES_INVALID: Choose why this lead is dead.'; end if;
  if p_to = 'dead' and p_reason = 'other' and nullif(btrim(p_note), '') is null then
    raise exception 'SALES_INVALID: Say why this lead is dead.';
  end if;
  if p_to = 'follow_up_later' and (p_next_due is null or p_next_due <= v_today) then
    raise exception 'SALES_INVALID: Choose the day to come back to this lead.';
  end if;

  -- Only a step forward is checked, so nothing that happened before these rules can trap a lead.
  if v_rank > v_from_rank and v_rank >= 2 and not v_reopening then
    -- Unanswered calls are not contact. Only leaving New asks, so a lead imported further along is not held back.
    if v_from_rank <= 1 and v_row.first_contact_at is null then v_missing := array_append(v_missing, 'contact'); end if;
    if v_rank >= 3 and v_row.requirement is null then v_missing := array_append(v_missing, 'requirement'); end if;
    if v_rank >= 3 and v_row.quantity is null then v_missing := array_append(v_missing, 'quantity'); end if;
    if v_rank >= 4 and not exists (
      select 1 from public.sales_lead_activities a where a.lead_id = p_id and a.kind = 'quotation' and a.undone_at is null
    ) then v_missing := array_append(v_missing, 'quotation'); end if;
    if v_rank >= 4 and v_row.expected_value_paise is null then v_missing := array_append(v_missing, 'value'); end if;
    if v_rank >= 4 and v_row.timeline is null then v_missing := array_append(v_missing, 'timeline'); end if;
    if cardinality(v_missing) > 0 then
      return jsonb_build_object('status', 'needs', 'missing', to_jsonb(v_missing), 'lead', public.sales_lead_row(v_row));
    end if;
  end if;

  update public.sales_leads
  set stage = p_to,
      stage_changed_at = now(),
      next_step = case when v_closing then null else coalesce(v_step, 'Call back') end,
      next_due_on = case when v_closing then null else coalesce(v_due, v_today) end,
      dead_reason = case when p_to = 'dead' then p_reason end,
      dead_note = case when p_to = 'dead' then nullif(btrim(p_note), '') end,
      closed_at = case when v_closing then now() end,
      no_answer_streak = case when v_closing or v_reopening then 0 else no_answer_streak end,
      updated_at = now()
  where id = p_id
  returning * into v_row;

  insert into public.sales_lead_events (lead_id, kind, detail, actor)
  values (p_id, 'moved', p_expected_from || '>' || p_to, v_uid);
  return jsonb_build_object('status', 'moved', 'lead', public.sales_lead_row(v_row));
exception
  when check_violation then raise exception 'SALES_INVALID: Check the details and try again.';
end;
$$;

-- The facts a salesperson learns: a name, how many, when. Only the keys present in p_facts change. The phone number and
-- the source stay with update_sales_lead and its `edit` right.
create function public.update_sales_lead_facts(p_id uuid, p_facts jsonb, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.sales_leads := public.sales_lead_for_work(p_id);
  v_new public.sales_leads;
  v_key text;
  v_changed text[] := '{}';
  v_val text;
begin
  if p_expected_updated_at is not null and v_old.updated_at is distinct from p_expected_updated_at then
    raise exception 'SALES_CHANGED: Somebody changed this lead while you were editing it. The latest version has been loaded.';
  end if;
  v_new := v_old;
  foreach v_key in array array['name', 'email', 'location', 'requirement', 'quantity', 'timeline', 'segment', 'client_type', 'temperature', 'expected_value_paise'] loop
    if p_facts ? v_key then
      v_val := nullif(btrim(p_facts ->> v_key), '');
      case v_key
        when 'name' then v_new.name := v_val;
        when 'email' then v_new.email := lower(v_val);
        when 'location' then v_new.location := v_val;
        when 'requirement' then v_new.requirement := v_val;
        when 'quantity' then v_new.quantity := v_val;
        when 'timeline' then v_new.timeline := v_val;
        when 'segment' then v_new.segment := v_val;
        when 'client_type' then v_new.client_type := v_val;
        when 'temperature' then v_new.temperature := coalesce(v_val, v_old.temperature);
        when 'expected_value_paise' then v_new.expected_value_paise := v_val::bigint;
      end case;
      v_changed := array_append(v_changed, v_key);
    end if;
  end loop;

  update public.sales_leads
  set name = v_new.name, email = v_new.email, location = v_new.location, requirement = v_new.requirement,
      quantity = v_new.quantity, timeline = v_new.timeline, segment = v_new.segment, client_type = v_new.client_type,
      temperature = v_new.temperature, expected_value_paise = v_new.expected_value_paise, updated_at = now()
  where id = p_id
  returning * into v_new;

  if cardinality(v_changed) > 0 then
    insert into public.sales_lead_events (lead_id, kind, detail, actor)
    values (p_id, 'edited', array_to_string(v_changed, ', '), auth.uid());
  end if;
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_row(v_new));
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'SALES_INVALID: Check the details and try again.';
end;
$$;

-- A number that is already a lead enquired again. It comes back to the top of its holder's day; a closed lead reopens as
-- New. Whoever can add a lead can record this, because that is who meets the duplicate warning.
create function public.record_sales_lead_enquiry(p_id uuid, p_source text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('create');
  v_row public.sales_leads;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_closed boolean;
begin
  select * into v_row from public.sales_leads where id = p_id for update;
  if v_row.id is null then raise exception 'SALES_NOT_FOUND'; end if;
  v_closed := v_row.stage in ('converted', 'dead');

  update public.sales_leads
  set stage = case when v_closed then 'new' else stage end,
      stage_changed_at = case when v_closed then now() else stage_changed_at end,
      dead_reason = case when v_closed then null else dead_reason end,
      dead_note = case when v_closed then null else dead_note end,
      closed_at = case when v_closed then null else closed_at end,
      next_step = case when assigned_to is null then next_step when v_closed then 'Call back' else next_step end,
      next_due_on = case when assigned_to is null then next_due_on when v_closed then v_today else least(next_due_on, v_today) end,
      enquired_again_at = now(),
      updated_at = now()
  where id = p_id
  returning * into v_row;

  insert into public.sales_lead_events (lead_id, kind, detail, actor)
  values (p_id, 'enquired_again', left(concat_ws(': ', p_source, nullif(btrim(p_note), '')), 200), v_uid);
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_row));
end;
$$;

-- ═══ 8. Who may call what ════════════════════════════════════════════════════

revoke all on function public.sales_lead_sees_all(uuid) from public, anon, authenticated;
revoke all on function public.sales_lead_stuck(public.sales_leads) from public, anon, authenticated;
revoke all on function public.sales_lead_row(public.sales_leads) from public, anon, authenticated;
revoke all on function public.sales_lead_json(public.sales_leads) from public, anon, authenticated;
revoke all on function public.sales_lead_for_work(uuid) from public, anon, authenticated;
revoke all on function public.sales_lead_record(public.sales_leads, text, text, text, text, date, boolean, integer) from public, anon, authenticated;
revoke all on function public.sales_lead_activities_guard() from public, anon, authenticated;

-- The read policies call this one as the browser's own role.
revoke all on function public.sales_lead_visible(uuid, uuid) from public, anon;
grant execute on function public.sales_lead_visible(uuid, uuid) to authenticated;

do $$
declare v_fn text;
begin
  foreach v_fn in array array[
    'public.sales_my_day()', 'public.sales_board(text, text, text, text, text, text)',
    'public.log_sales_lead_activity(uuid, text, text, text, text, date)', 'public.sales_lead_no_answer(uuid)',
    'public.sales_lead_message_sent(uuid, text)', 'public.undo_sales_lead_activity(uuid)',
    'public.move_sales_lead(uuid, text, text, text, text, text, date)', 'public.update_sales_lead_facts(uuid, jsonb, timestamptz)',
    'public.record_sales_lead_enquiry(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end $$;

-- ═══ 9. Self-checks (these fail the migration rather than let a half-applied state look fine) ═══

do $$
declare v_fn text;
begin
  if (select count(*)
      from public.role_permissions rp
      join public.permission_modules pm on pm.id = rp.module_id
      where pm.module_key = 'sales' and rp.role = 'admin' and rp.allowed) <> 5 then
    raise exception 'SALES_LEAD_BOARD: the Sales module needs its five Admin role rows (view, create, edit, assign, view_all)';
  end if;
  if exists (
    select 1
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    where pm.module_key = 'sales' and mpa.default_allowed
  ) then
    raise exception 'SALES_LEAD_BOARD: no Sales action may be on by default';
  end if;
  if exists (
    select 1 from pg_class c
    where c.oid in ('public.sales_lead_activities'::regclass, 'public.sales_lead_access'::regclass) and not c.relrowsecurity
  ) then
    raise exception 'SALES_LEAD_BOARD: row level security must be on for the new tables';
  end if;
  if has_table_privilege('authenticated', 'public.sales_lead_activities', 'INSERT')
     or has_table_privilege('authenticated', 'public.sales_lead_activities', 'UPDATE')
     or has_table_privilege('authenticated', 'public.sales_lead_access', 'INSERT')
     or has_table_privilege('authenticated', 'public.sales_lead_access', 'DELETE') then
    raise exception 'SALES_LEAD_BOARD: a browser must not be able to write these tables';
  end if;
  foreach v_fn in array array[
    'public.sales_my_day()', 'public.sales_board(text, text, text, text, text, text)',
    'public.log_sales_lead_activity(uuid, text, text, text, text, date)', 'public.sales_lead_no_answer(uuid)',
    'public.sales_lead_message_sent(uuid, text)', 'public.undo_sales_lead_activity(uuid)',
    'public.move_sales_lead(uuid, text, text, text, text, text, date)', 'public.update_sales_lead_facts(uuid, jsonb, timestamptz)',
    'public.record_sales_lead_enquiry(uuid, text, text)', 'public.sales_lead_visible(uuid, uuid)'
  ] loop
    if has_function_privilege('anon', to_regprocedure(v_fn)::oid, 'EXECUTE') then
      raise exception 'SALES_LEAD_BOARD: anon can execute %', v_fn;
    end if;
  end loop;
  foreach v_fn in array array[
    'public.sales_lead_for_work(uuid)', 'public.sales_lead_row(public.sales_leads)', 'public.sales_lead_sees_all(uuid)',
    'public.sales_lead_record(public.sales_leads, text, text, text, text, date, boolean, integer)'
  ] loop
    if has_function_privilege('authenticated', to_regprocedure(v_fn)::oid, 'EXECUTE') then
      raise exception 'SALES_LEAD_BOARD: an internal function must not be callable from a browser: %', v_fn;
    end if;
  end loop;
end $$;
