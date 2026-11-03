-- 20270526000100_sales_go_live.sql
--
-- Sales, going live: everything the owner needs to retire ClickUp today.
--
-- What the owner decided (2026-11-03), and what this file does about it:
--   * ClickUp history comes in "as it is". import_sales_leads takes rows the browser has read from the export and keeps
--     each one's non-empty fields in sales_lead_imports, so nothing is lost even where BOE One has no column for it.
--     It is safe to run twice: a ClickUp task id already imported is skipped, so a broken import is simply run again.
--   * One number, one lead stays true. A second ClickUp task on a number that is already a lead does not make a new
--     lead: it goes on the existing lead as a note.
--   * ClickUp's two most-used reasons had no home in the agreed list, so "No requirement" and "Not relevant" join it.
--     Everything else maps to a reason that already exists, and the original words stay on the import row.
--   * Importing sends nobody a notification, and an imported lead does not go red until its planned day has passed.
--   * First call: the same working day. If it is not made, the salesperson is told that evening and manager level the
--     next morning (sales_lead_send_alerts, driven by /api/sales/alerts).
--   * The Team page reads sales_team_overview. It is for `view_all`, `assign` and Admin.
--   * Control Center names a senior's juniors (set_sales_lead_juniors) and shows who holds what (list_sales_team).
--     Both are Admin only. The rights themselves go through the existing Control Center permission route.
--
-- WRITE: only the functions below. The new table carries no policy and no grant, so a browser cannot read or write it.
--
-- ROLLBACK (loses the ClickUp originals, export them first):
--   drop function public.import_sales_leads(jsonb), public.sales_team_overview(date, text, uuid),
--     public.sales_lead_remind(uuid), public.reassign_due_sales_leads(uuid, uuid), public.list_sales_team(),
--     public.set_sales_lead_juniors(uuid, uuid[]), public.sales_lead_send_alerts(text), public.sales_lead_notify(uuid, uuid, text, text, text);
--   drop table public.sales_lead_imports;
--   drop trigger sales_leads_furthest on public.sales_leads; drop function public.sales_leads_furthest();
--   then re-run the 20270525 definitions of sales_lead_stuck, sales_leads_page, get_sales_lead, sales_board,
--   allot_sales_lead and record_sales_lead_enquiry, and of the three check constraints changed in section 1,
--   and drop the columns imported_at and furthest_rank.

-- ═══ 1. The lead grows ═══════════════════════════════════════════════════════

alter table public.sales_leads
  drop constraint sales_leads_dead_reason_check,
  add constraint sales_leads_dead_reason_check check (dead_reason in (
    'price_too_high', 'chose_another_supplier', 'not_responding', 'quantity_too_small', 'project_cancelled',
    'delivery_time', 'retail_enquiry', 'wrong_number', 'no_requirement', 'not_relevant', 'other'
  )),
  -- When it came from ClickUp. Null for a lead added in BOE One.
  add column imported_at timestamptz,
  -- How far the lead ever got: 1 New, 2 Under process, 3 Potential client, 4 Negotiation, 5 Converted. The Team page's
  -- funnel reads this, because a dead lead's stage no longer says how far it had come.
  add column furthest_rank smallint not null default 1 check (furthest_rank between 1 and 5);

create function public.sales_leads_furthest()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.furthest_rank := greatest(
    new.furthest_rank,
    case when tg_op = 'UPDATE' then old.furthest_rank else 1 end,
    case new.stage when 'under_process' then 2 when 'potential' then 3 when 'negotiation' then 4 when 'converted' then 5 else 1 end
  );
  return new;
end;
$$;

create trigger sales_leads_furthest
  before insert or update of stage on public.sales_leads
  for each row execute function public.sales_leads_furthest();

-- Fires the trigger for the leads already there. A lead back from a further stage has no way to say so: it counts from here.
update public.sales_leads set stage = stage;

alter table public.sales_lead_activities
  drop constraint sales_lead_activities_kind_check,
  add constraint sales_lead_activities_kind_check check (kind in ('call', 'whatsapp', 'meeting', 'email', 'quotation', 'sample', 'imported')),
  drop constraint sales_lead_activities_outcome_check,
  add constraint sales_lead_activities_outcome_check check (outcome in ('interested', 'still_deciding', 'call_back', 'no_answer', 'sent', 'imported'));

alter table public.sales_lead_events drop constraint sales_lead_events_kind_check;
alter table public.sales_lead_events add constraint sales_lead_events_kind_check
  check (kind in ('added', 'allotted', 'reassigned', 'edited', 'moved', 'enquired_again', 'imported'));

-- ═══ 2. What came from ClickUp ═══════════════════════════════════════════════

-- One row per ClickUp task, whatever became of it. `raw` is the task's own non-empty fields, kept as exported.
create table public.sales_lead_imports (
  task_id text primary key check (length(task_id) between 1 and 40),
  lead_id uuid not null references public.sales_leads (id),
  outcome text not null check (outcome in ('created', 'merged')),
  raw jsonb not null,
  imported_by uuid,
  imported_at timestamptz not null default now()
);
create index sales_lead_imports_lead_idx on public.sales_lead_imports (lead_id);

alter table public.sales_lead_imports enable row level security;
revoke all on table public.sales_lead_imports from public, anon, authenticated;
grant all on table public.sales_lead_imports to service_role;

-- ═══ 3. Helpers ══════════════════════════════════════════════════════════════

-- As in 20270525, with one exception: an imported lead nobody has touched yet is waiting for the day the import gave
-- it, so it does not go red before that day. The first real entry after the import ends the exception.
create or replace function public.sales_lead_stuck(l public.sales_leads)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select l.assigned_to is not null
    and not (
      l.imported_at is not null
      and coalesce(l.last_activity_at, l.imported_at) <= l.imported_at
      and l.next_due_on >= (now() at time zone 'Asia/Kolkata')::date
    )
    and coalesce(
      greatest(l.assigned_at, l.last_activity_at, l.stage_changed_at, l.enquired_again_at, l.imported_at) < now() - case l.stage
        when 'new' then interval '1 day'
        when 'under_process' then interval '7 days'
        when 'potential' then interval '7 days'
        when 'negotiation' then interval '3 days'
      end,
      false
    );
$$;

-- One notification. entity_id is the lead, or null when the row is about a whole list. The phone alert follows from the
-- row itself (20270425000000).
create function public.sales_lead_notify(p_user uuid, p_lead uuid, p_type text, p_title text, p_body text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select p_user, null, p_lead, p_type::notification_type, p_title, p_body, true
  from public.users u
  where u.id = p_user and u.is_active;
$$;

-- ═══ 4. Reads ════════════════════════════════════════════════════════════════

-- The Lead Master list, as in 20270525. The one change: a closed lead nobody holds is history, not a lead waiting to be
-- allotted, so it no longer counts as "Not allotted".
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
    select l.id, l.lead_no, l.received_on, l.assigned_to, l.stage in ('converted', 'dead') as closed
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
       or (p_holder = 'none' and b.assigned_to is null and not b.closed)
       or (v_holder is not null and b.assigned_to = v_holder)
  )
  select
    (select j from periods),
    (select count(*) from base),
    (select count(*) from base where assigned_to is null and not closed),
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

-- One lead, as in 20270525, with what came from ClickUp.
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
    ),
    'clickup', (
      select coalesce(jsonb_agg(i.raw order by i.imported_at), '[]'::jsonb)
      from public.sales_lead_imports i where i.lead_id = p_id
    )
  );
end;
$$;

-- The board, as in 20270525. The one change: closed leads nobody holds are not counted as waiting to be allotted.
create or replace function public.sales_board(
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
    'waiting_allotment', case when v_all then (
      select count(*) from public.sales_leads l where l.assigned_to is null and l.stage not in ('converted', 'dead')
    ) end
  ) into v_result;

  return v_result;
end;
$$;

-- The Team page. Leads are counted from p_from by the day they were received. The two clocks only count what happened in
-- BOE One: ClickUp recorded neither when a lead was first called nor whether a follow-up was on time.
create function public.sales_team_overview(p_from date, p_market text default null, p_holder uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_now timestamp := now() at time zone 'Asia/Kolkata';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_result jsonb;
begin
  if not public.sales_lead_sees_all(v_uid) then raise exception 'SALES_FORBIDDEN' using errcode = '42501'; end if;

  with scope as (
    select l.*, public.sales_lead_stuck(l) as is_stuck, l.stage not in ('converted', 'dead') as is_open
    from public.sales_leads l
    where l.assigned_to is not null
      and (coalesce(p_market, '') = '' or l.market = p_market)
      and (p_holder is null or l.assigned_to = p_holder)
  ),
  received as (
    select * from scope where received_on >= p_from
  ),
  -- A first call counts once the day it was due has ended, or as soon as it has been made.
  first_calls as (
    select assigned_to,
      (first_attempt_at at time zone 'Asia/Kolkata')::date <= (assigned_at at time zone 'Asia/Kolkata')::date as same_day
    from scope
    where imported_at is null and (assigned_at at time zone 'Asia/Kolkata')::date >= p_from
      and (first_attempt_at is not null or (assigned_at at time zone 'Asia/Kolkata')::date < v_today)
  ),
  -- Done follow-ups, and the ones that are late right now: a follow-up nobody does must not flatter the number.
  followups as (
    select l.assigned_to, (a.at at time zone 'Asia/Kolkata')::date <= (a.prior ->> 'next_due_on')::date as on_time
    from public.sales_lead_activities a
    join scope l on l.id = a.lead_id
    where a.kind <> 'imported' and a.undone_at is null and a.prior ->> 'next_due_on' is not null
      and (a.at at time zone 'Asia/Kolkata')::date >= p_from
    union all
    select assigned_to, false from scope where is_open and stage <> 'follow_up_later' and next_due_on < v_today
  ),
  risk as (
    select l.*,
      case
        when l.first_attempt_at is null and (l.assigned_at at time zone 'Asia/Kolkata')::date < v_today then 'not_called'
        when l.is_stuck then 'stuck'
        when l.next_due_on <= v_today - 3 and l.stage <> 'follow_up_later' then 'overdue'
      end as problem
    from scope l where l.is_open
  ),
  -- Punches reach BOE One through the day. Before 11:00, or on a day nobody at all has punched, a missing punch proves
  -- nothing, so nobody is called absent.
  away as (
    select h.assigned_to, u.full_name, count(*) filter (where h.next_due_on <= v_today)::integer as due
    from scope h
    join public.users u on u.id = h.assigned_to
    where h.is_open and u.is_active and u.payroll_active
      and v_now::time >= time '11:00'
      and exists (select 1 from public.attendance_records r where r.attendance_date = v_today and r.check_in_at is not null)
      and not exists (select 1 from public.attendance_records r where r.user_id = h.assigned_to and r.attendance_date = v_today and r.check_in_at is not null)
    group by h.assigned_to, u.full_name
  )
  select jsonb_build_object(
    'tiles', jsonb_build_object(
      'leads', (select count(*) from received),
      'converted', (select count(*) from received where stage = 'converted'),
      'first_call_on_time', (select count(*) from first_calls where same_day),
      'first_call_total', (select count(*) from first_calls),
      'followups_on_time', (select count(*) from followups where on_time),
      'followups_total', (select count(*) from followups)
    ),
    'funnel', (
      select jsonb_agg(jsonb_build_object('rank', g, 'n', (select count(*) from received r where r.furthest_rank >= g)) order by g)
      from generate_series(1, 5) g
    ),
    'reasons', (
      select coalesce(jsonb_agg(jsonb_build_object('reason', x.dead_reason, 'n', x.n) order by x.n desc), '[]'::jsonb)
      from (select dead_reason, count(*)::integer as n from received where stage = 'dead' group by dead_reason) x
    ),
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', h.id, 'name', u.full_name,
        'leads', (select count(*) from received r where r.assigned_to = h.id),
        'open', (select count(*) from scope s where s.assigned_to = h.id and s.is_open),
        'first_call_on_time', (select count(*) from first_calls f where f.assigned_to = h.id and f.same_day),
        'first_call_total', (select count(*) from first_calls f where f.assigned_to = h.id),
        'followups_on_time', (select count(*) from followups f where f.assigned_to = h.id and f.on_time),
        'followups_total', (select count(*) from followups f where f.assigned_to = h.id),
        'stuck', (select count(*) from scope s where s.assigned_to = h.id and s.is_open and s.is_stuck),
        'converted', (select count(*) from received r where r.assigned_to = h.id and r.stage = 'converted')
      ) order by u.full_name), '[]'::jsonb)
      from (select distinct assigned_to as id from scope) h
      join public.users u on u.id = h.id
    ),
    'at_risk_total', (select count(*) from risk where problem is not null),
    'at_risk', (
      select coalesce(jsonb_agg(public.sales_lead_row((select x from public.sales_leads x where x.id = t.id)) || jsonb_build_object('problem', t.problem)
        order by t.pos), '[]'::jsonb)
      from (
        select r.id, r.problem, row_number() over (
          order by case r.temperature when 'hot' then 0 when 'warm' then 1 else 2 end, r.expected_value_paise desc nulls last,
            case r.problem when 'not_called' then 0 when 'stuck' then 1 else 2 end, r.next_due_on, r.lead_no
        ) as pos
        from risk r where r.problem is not null
      ) t where t.pos <= 30
    ),
    'absent', (
      select coalesce(jsonb_agg(jsonb_build_object('id', a.assigned_to, 'name', a.full_name, 'due', a.due) order by a.full_name), '[]'::jsonb)
      from away a where a.due > 0
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Control Center: everybody, what they hold in Sales, and whose leads they may read. Admin only.
create function public.list_sales_team()
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
      'juniors', coalesce((select jsonb_agg(a.subject_id) from public.sales_lead_access a where a.viewer_id = u.id), '[]'::jsonb)
    ) order by u.full_name)
    from public.users u where u.is_active
  ), '[]'::jsonb);
end;
$$;

-- ═══ 5. Writes ═══════════════════════════════════════════════════════════════

-- Allot, as in 20270525, and tell the person. A person allotting to themselves needs no telling.
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

  if p_to <> v_uid and v_row.stage not in ('converted', 'dead') then
    perform public.sales_lead_notify(p_to, p_id, 'sales_lead_allotted', 'New lead for you',
      coalesce(v_row.name, v_row.phone_e164) || '. Call today.');
  end if;
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_row));
end;
$$;

-- A repeat enquiry, as in 20270525, and tell whoever holds the lead.
create or replace function public.record_sales_lead_enquiry(p_id uuid, p_source text, p_note text default null)
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

  if v_row.assigned_to is not null and v_row.assigned_to <> v_uid then
    perform public.sales_lead_notify(v_row.assigned_to, p_id, 'sales_lead_enquired_again', 'A lead enquired again',
      coalesce(v_row.name, v_row.phone_e164) || ' came back. Call today.');
  end if;
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_row));
end;
$$;

-- ClickUp import, up to 500 tasks at a time. Rows arrive already mapped (src/lib/salesLeads/clickup.ts); the database
-- still decides what is valid. A row that cannot be saved is reported and the rest carry on. Nobody is notified.
create function public.import_sales_leads(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('assign');
  r jsonb;
  v_task text;
  v_phone text;
  v_lead uuid;
  v_holder uuid;
  v_stage text;
  v_open boolean;
  v_at timestamptz;
  v_comment text;
  v_tried boolean;
  v_checked uuid[] := '{}';
  v_created integer := 0;
  v_merged integer := 0;
  v_already integer := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'SALES_INVALID: Send up to 500 rows at a time.';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_task := nullif(btrim(r ->> 'task_id'), '');
    v_phone := public.normalize_lead_phone(r ->> 'phone');
    if v_task is null or v_phone is null then
      v_failed := v_failed || jsonb_build_object('task_id', v_task, 'why', 'no valid number');
      continue;
    end if;
    if exists (select 1 from public.sales_lead_imports i where i.task_id = v_task) then
      v_already := v_already + 1;
      continue;
    end if;

    begin
      v_holder := nullif(r ->> 'holder_id', '')::uuid;
      if v_holder is not null and not v_holder = any (v_checked) then
        if not public.is_eligible_order_assignee(v_holder) then raise exception 'SALES_INVALID: not a sales candidate'; end if;
        v_checked := array_append(v_checked, v_holder);
      end if;
      v_stage := r ->> 'stage';
      v_open := v_stage not in ('converted', 'dead');
      v_at := (r ->> 'updated_at')::timestamptz;
      v_comment := nullif(btrim(r ->> 'latest_comment'), '');

      select l.id into v_lead from public.sales_leads l where l.phone_e164 = v_phone for update;

      if v_lead is not null then
        insert into public.sales_lead_imports (task_id, lead_id, outcome, raw, imported_by)
        values (v_task, v_lead, 'merged', r -> 'raw', v_uid);
        insert into public.sales_lead_activities (lead_id, kind, outcome, note, prior, at)
        values (v_lead, 'imported', 'imported',
          left(concat_ws(': ', 'Also in ClickUp as ' || coalesce(r ->> 'clickup_status', 'another task'), v_comment), 3900), '{}'::jsonb, v_at);
        v_merged := v_merged + 1;
        continue;
      end if;

      v_tried := v_stage <> 'new' or coalesce((r ->> 'comment_count')::integer, 0) > 0;
      insert into public.sales_leads (
        received_on, phone_e164, source, name, email, location, requirement,
        assigned_to, assigned_at, assigned_by, created_by, created_at,
        stage, stage_changed_at, temperature, segment, client_type,
        next_step, next_due_on, first_attempt_at, first_contact_at, last_activity_at, last_kind,
        dead_reason, dead_note, closed_at, imported_at, furthest_rank
      ) values (
        ((r ->> 'created_at')::timestamptz at time zone 'Asia/Kolkata')::date, v_phone, r ->> 'source',
        nullif(btrim(r ->> 'name'), ''), lower(nullif(btrim(r ->> 'email'), '')), nullif(btrim(r ->> 'location'), ''), nullif(btrim(r ->> 'requirement'), ''),
        v_holder, case when v_holder is null then null when v_tried then v_at else now() end, case when v_holder is not null then v_uid end, v_uid, (r ->> 'created_at')::timestamptz,
        v_stage, v_at, r ->> 'temperature', nullif(r ->> 'segment', ''), nullif(r ->> 'client_type', ''),
        case when v_open then coalesce(nullif(btrim(r ->> 'next_step'), ''), 'Call back') end,
        case when v_open then coalesce((r ->> 'next_due_on')::date, (now() at time zone 'Asia/Kolkata')::date) end,
        case when v_tried then v_at end,
        case when v_tried and v_stage <> 'new' and coalesce((r ->> 'comment_count')::integer, 0) > 0 then v_at end,
        case when v_tried then v_at end,
        case when v_tried then 'update' end,
        case when v_stage = 'dead' then r ->> 'dead_reason' end,
        case when v_stage = 'dead' then nullif(btrim(r ->> 'dead_note'), '') end,
        case when v_open then null else v_at end,
        now(),
        -- A dead lead somebody had talked to got at least as far as Under process.
        case when v_stage = 'dead' and coalesce((r ->> 'comment_count')::integer, 0) > 0 then 2 else 1 end
      )
      returning id into v_lead;

      insert into public.sales_lead_imports (task_id, lead_id, outcome, raw, imported_by)
      values (v_task, v_lead, 'created', r -> 'raw', v_uid);
      insert into public.sales_lead_events (lead_id, kind, detail, actor)
      values (v_lead, 'imported', left(coalesce(r ->> 'clickup_status', ''), 200), v_uid);
      if v_comment is not null then
        insert into public.sales_lead_activities (lead_id, kind, outcome, note, prior, at)
        values (v_lead, 'imported', 'imported', left(v_comment, 3900), '{}'::jsonb, v_at);
      end if;
      v_created := v_created + 1;
    exception
      when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow or invalid_datetime_format
        or string_data_right_truncation or raise_exception then
        v_failed := v_failed || jsonb_build_object('task_id', v_task, 'why', 'details the database refused');
      when unique_violation then
        v_already := v_already + 1;
    end;
  end loop;

  return jsonb_build_object('created', v_created, 'merged', v_merged, 'already', v_already, 'failed', v_failed);
end;
$$;

-- A manager nudges the holder of one lead. Once a day per lead, so a double press does not ring a phone twice.
create function public.sales_lead_remind(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_row public.sales_leads;
  v_from timestamptz := ((now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata';
begin
  if not public.sales_lead_sees_all(v_uid) then raise exception 'SALES_FORBIDDEN' using errcode = '42501'; end if;
  select * into v_row from public.sales_leads where id = p_id;
  if v_row.id is null then raise exception 'SALES_NOT_FOUND'; end if;
  if v_row.assigned_to is null or v_row.stage in ('converted', 'dead') then
    raise exception 'SALES_INVALID: Only an open, allotted lead can be chased.';
  end if;
  if exists (
    select 1 from public.notifications n
    where n.entity_id = p_id and n.type::text = 'sales_lead_reminder' and n.created_at >= v_from
  ) then
    return jsonb_build_object('status', 'already');
  end if;
  perform public.sales_lead_notify(v_row.assigned_to, p_id, 'sales_lead_reminder', 'Please update this lead',
    coalesce(v_row.name, v_row.phone_e164) || ' needs you today.');
  return jsonb_build_object('status', 'sent');
end;
$$;

-- Somebody is away: what is due from them today or earlier goes to another person. Their other leads stay with them.
create function public.reassign_due_sales_leads(p_from uuid, p_to uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('assign');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_moved integer;
begin
  if p_to is null or p_to = p_from or not public.is_eligible_order_assignee(p_to) then
    raise exception 'SALES_INVALID: Choose a person from the Sales team.';
  end if;
  with moved as (
    update public.sales_leads l
    set assigned_to = p_to, assigned_at = now(), assigned_by = v_uid, updated_at = now()
    where l.assigned_to = p_from and l.stage not in ('converted', 'dead') and l.next_due_on <= v_today
    returning l.id
  ), logged as (
    insert into public.sales_lead_events (lead_id, kind, from_user, to_user, actor)
    select id, 'reassigned', p_from, p_to, v_uid from moved
    returning 1
  )
  select count(*) into v_moved from logged;

  if v_moved > 0 and p_to <> v_uid then
    perform public.sales_lead_notify(p_to, null, 'sales_lead_allotted', 'Leads moved to you',
      v_moved || case when v_moved = 1 then ' lead needs' else ' leads need' end || ' you today. Open My day.');
  end if;
  return jsonb_build_object('status', 'saved', 'moved', v_moved);
end;
$$;

-- Control Center: whose leads a senior may read. Replaces the whole list. Admin only.
create function public.set_sales_lead_juniors(p_viewer uuid, p_juniors uuid[])
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
  if not exists (select 1 from public.users u where u.id = p_viewer) then raise exception 'SALES_NOT_FOUND'; end if;
  delete from public.sales_lead_access a where a.viewer_id = p_viewer and not a.subject_id = any (coalesce(p_juniors, '{}'));
  insert into public.sales_lead_access (viewer_id, subject_id, granted_by)
  select p_viewer, j, v_uid from unnest(coalesce(p_juniors, '{}')) j where j <> p_viewer
  on conflict (viewer_id, subject_id) do nothing;
  return jsonb_build_object('status', 'saved');
end;
$$;

-- The two daily alerts. Service role only: /api/sales/alerts calls it. Nothing goes out on a Sunday, and nobody gets the
-- same alert twice in a day however often the scheduler fires.
--   morning: each person's follow-ups for the day, then manager level hears of first calls missed yesterday.
--   evening: each person hears of new leads they have not called today.
create function public.sales_lead_send_alerts(p_slot text)
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
          where n.user_id = l.assigned_to and n.type::text = 'sales_first_call_missed' and n.created_at >= v_from
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

-- ═══ 6. Who may call what ════════════════════════════════════════════════════

revoke all on function public.sales_leads_furthest() from public, anon, authenticated;
revoke all on function public.sales_lead_stuck(public.sales_leads) from public, anon, authenticated;
revoke all on function public.sales_lead_notify(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.sales_lead_send_alerts(text) from public, anon, authenticated;
grant execute on function public.sales_lead_send_alerts(text) to service_role;

do $$
declare v_fn text;
begin
  foreach v_fn in array array[
    'public.import_sales_leads(jsonb)', 'public.sales_team_overview(date, text, uuid)', 'public.list_sales_team()',
    'public.sales_lead_remind(uuid)', 'public.reassign_due_sales_leads(uuid, uuid)', 'public.set_sales_lead_juniors(uuid, uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end $$;

-- ═══ 7. Self-checks (these fail the migration rather than let a half-applied state look fine) ═══

do $$
declare v_fn text;
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.sales_lead_imports'::regclass) then
    raise exception 'SALES_GO_LIVE: row level security must be on for the imports table';
  end if;
  if has_table_privilege('authenticated', 'public.sales_lead_imports', 'SELECT')
     or has_table_privilege('authenticated', 'public.sales_lead_imports', 'INSERT') then
    raise exception 'SALES_GO_LIVE: a browser must not reach the imports table';
  end if;
  foreach v_fn in array array[
    'public.import_sales_leads(jsonb)', 'public.sales_team_overview(date, text, uuid)', 'public.list_sales_team()',
    'public.sales_lead_remind(uuid)', 'public.reassign_due_sales_leads(uuid, uuid)', 'public.set_sales_lead_juniors(uuid, uuid[])',
    'public.sales_lead_send_alerts(text)', 'public.sales_lead_notify(uuid, uuid, text, text, text)'
  ] loop
    if has_function_privilege('anon', to_regprocedure(v_fn)::oid, 'EXECUTE') then
      raise exception 'SALES_GO_LIVE: anon can execute %', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['public.sales_lead_send_alerts(text)', 'public.sales_lead_notify(uuid, uuid, text, text, text)'] loop
    if has_function_privilege('authenticated', to_regprocedure(v_fn)::oid, 'EXECUTE') then
      raise exception 'SALES_GO_LIVE: an internal function must not be callable from a browser: %', v_fn;
    end if;
  end loop;
end $$;
