-- 20270527000000_sales_review_fixes.sql
--
-- Sales, after the first full review (2026-11-03), and ClickUp's whole history.
--
-- What the owner asked, and what this file does about it:
--   * Who can be given a lead follows the Sales job set in Control Center (Sales `view`), no longer the Orders rule
--     ("in the Sales department, or the Orders assignee grant"). sales_lead_can_hold decides it in one place; Admin
--     accounts are left out because they see and work everything anyway. list_sales_lead_holders feeds every picker.
--   * Converted is checked like a step past Negotiation: a real contact, the requirement, the quantity and the expected
--     value (the owner's rule: value is required from Negotiation). A quotation and a timeline are not asked again.
--   * Only a step past the furthest stage a lead ever reached is checked, so Undo, and coming back out of Follow up later,
--     never ask for facts again.
--   * "Not interested" is logged as a call before the lead goes Dead, so the first call counts.
--   * An imported lead nobody has tried waits in My day, and on the Team page, for the day the import gave it, instead of
--     arriving all at once on the first day.
--   * The evening "not called yet" reminder no longer skips somebody who also got the morning manager alert.
--   * ClickUp's export carries only each task's latest comment, undated. import_sales_lead_history takes the full history
--     read from ClickUp's API (scripts/clickup-history.mjs): every comment with its own date and author, and the statuses a
--     task went through. Each is remembered by its ClickUp id, so running it twice adds nothing.
--
-- WRITE: only the functions below. The new table carries no policy and no grant, so a browser cannot read or write it.
--
-- ROLLBACK (the imported history stays on the leads; hide it with sales_lead_activities.undone_at if it must go):
--   drop function public.import_sales_lead_history(jsonb), public.list_sales_lead_holders();
--   re-run the 20270525000000 definitions of sales_lead_record, move_sales_lead, update_sales_lead_facts and
--   sales_my_day, and the 20270526000100 definitions of allot_sales_lead, reassign_due_sales_leads, import_sales_leads,
--   sales_team_overview and sales_lead_send_alerts;
--   drop function public.sales_lead_can_hold(uuid); drop table public.sales_lead_import_refs;
--   then restore the two check constraints in section 1 without 'not_interested' and 'clickup_status'.

-- ═══ 1. New values ══════════════════════════════════════════════════════════════════════════════════════════════

alter table public.sales_lead_activities
  drop constraint sales_lead_activities_outcome_check,
  add constraint sales_lead_activities_outcome_check
    check (outcome in ('interested', 'still_deciding', 'call_back', 'no_answer', 'sent', 'imported', 'not_interested'));

-- A status the task had in ClickUp, dated when it entered it. Detail is the ClickUp status name.
alter table public.sales_lead_events drop constraint sales_lead_events_kind_check;
alter table public.sales_lead_events add constraint sales_lead_events_kind_check
  check (kind in ('added', 'allotted', 'reassigned', 'edited', 'moved', 'enquired_again', 'imported', 'clickup_status'));

-- ═══ 2. What came from ClickUp, one row each, and who can hold a lead ══════════════════════════════════════════════

-- ref: 'comment:<ClickUp comment id>', 'status:<task id>:<status>:<epoch>', or 'latest:<task id>' for the one comment the
-- export carried. activity_id is the history entry it became, where it became one.
create table public.sales_lead_import_refs (
  ref text primary key check (length(ref) between 3 and 300),
  lead_id uuid not null references public.sales_leads (id),
  activity_id uuid references public.sales_lead_activities (id),
  at timestamptz
);
create index sales_lead_import_refs_lead_idx on public.sales_lead_import_refs (lead_id);
create index sales_lead_import_refs_activity_idx on public.sales_lead_import_refs (activity_id);

alter table public.sales_lead_import_refs enable row level security;
revoke all on table public.sales_lead_import_refs from public, anon, authenticated;
grant all on table public.sales_lead_import_refs to service_role;

-- Somebody with a Sales job: active, not an Admin account, and Sales `view` (Salesperson, Manager or Lead manager).
create function public.sales_lead_can_hold(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.users u where u.id = p_uid and u.is_active and u.role <> 'admin')
     and public.resolve_permission(p_uid, 'sales', 'view');
$$;

-- Everybody who can be given a lead, for the pickers: Lead Master, the Team page and the import.
create function public.list_sales_lead_holders()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sales_leads_require(null);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name) order by u.full_name)
    from public.users u
    where public.sales_lead_can_hold(u.id)
  ), '[]'::jsonb);
end;
$$;

-- ═══ 3. The rules that change ════════════════════════════════════════════════════════════════════════════════════════

-- "Not interested" is a real conversation, so it is logged, but it does not move a New lead to Under process first.
create or replace function public.sales_lead_record(
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
  v_stage text := case when p_contact and l.stage = 'new' and p_outcome <> 'not_interested' then 'under_process' else l.stage end;
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

create or replace function public.move_sales_lead(
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
  v_rank integer := case p_to when 'new' then 1 when 'under_process' then 2 when 'potential' then 3 when 'negotiation' then 4 when 'converted' then 5 else 0 end;
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

  -- Only a step past the furthest stage this lead ever reached is checked, so going back to where it has already been
  -- (Undo, or out of Follow up later) never asks again. Converted asks what Negotiation asks, but a quotation and a timeline.
  if v_rank > greatest(v_from_rank, v_row.furthest_rank) and v_rank >= 2 and not v_reopening then
    -- Unanswered calls are not contact. Only leaving New asks, so a lead imported further along is not held back.
    if v_from_rank <= 1 and v_row.first_contact_at is null then v_missing := array_append(v_missing, 'contact'); end if;
    if v_rank >= 3 and v_row.requirement is null then v_missing := array_append(v_missing, 'requirement'); end if;
    if v_rank >= 3 and v_row.quantity is null then v_missing := array_append(v_missing, 'quantity'); end if;
    if v_rank = 4 and not exists (
      select 1 from public.sales_lead_activities a where a.lead_id = p_id and a.kind = 'quotation' and a.undone_at is null
    ) then v_missing := array_append(v_missing, 'quotation'); end if;
    if v_rank >= 4 and v_row.expected_value_paise is null then v_missing := array_append(v_missing, 'value'); end if;
    if v_rank = 4 and v_row.timeline is null then v_missing := array_append(v_missing, 'timeline'); end if;
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

-- A lead in Negotiation or Converted keeps its expected value: the owner's rule is that it is required from Negotiation.
create or replace function public.update_sales_lead_facts(p_id uuid, p_facts jsonb, p_expected_updated_at timestamptz default null)
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

  if v_old.stage in ('negotiation', 'converted') and v_old.expected_value_paise is not null and v_new.expected_value_paise is null then
    raise exception 'SALES_INVALID: A lead in Negotiation keeps its expected value. Change it instead of clearing it.';
  end if;

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

create or replace function public.sales_my_day()
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
        -- A lead nobody has tried comes at once, unless it came from ClickUp: the import gave it a day, and it waits for it.
        and (l.next_due_on <= v_today or (l.stage <> 'follow_up_later' and l.first_attempt_at is null and l.imported_at is null))
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
        and (l.stage = 'follow_up_later' or l.first_attempt_at is not null or l.imported_at is not null)
    )
  );
end;
$$;

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
  if p_to is null or not public.sales_lead_can_hold(p_to) then
    raise exception 'SALES_INVALID: Choose somebody with a Sales job.';
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

create or replace function public.reassign_due_sales_leads(p_from uuid, p_to uuid)
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
  if p_to is null or p_to = p_from or not public.sales_lead_can_hold(p_to) then
    raise exception 'SALES_INVALID: Choose somebody with a Sales job.';
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

create or replace function public.import_sales_leads(p_rows jsonb)
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
  v_act uuid;
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
        if not public.sales_lead_can_hold(v_holder) then raise exception 'SALES_INVALID: not a sales candidate'; end if;
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
        values (v_lead, 'imported', 'imported', left(v_comment, 3900), '{}'::jsonb, v_at)
        returning id into v_act;
        -- Remembered, so the full history (import_sales_lead_history) can replace this copy dated by the export.
        insert into public.sales_lead_import_refs (ref, lead_id, activity_id, at) values ('latest:' || v_task, v_lead, v_act, v_at);
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

-- At risk: an imported lead nobody has tried is "not called" only once the day the import gave it has passed.
create or replace function public.sales_team_overview(p_from date, p_market text default null, p_holder uuid default null)
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
        when l.first_attempt_at is null and (l.assigned_at at time zone 'Asia/Kolkata')::date < v_today
          and (l.imported_at is null or l.next_due_on < v_today) then 'not_called'
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

-- The evening reminder looks only for its own earlier message today, not the morning one sent to manager level.
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

-- ═══ 4. ClickUp's full history ═══════════════════════════════════════════════════════════════════════════════════

-- For tasks already imported: every comment with its own date and author, and the statuses ClickUp kept, each with the
-- day it entered it. Rows come from the history file read from ClickUp's API, up to 300 tasks and 3,000 comments a call:
--   [{ task_id, comments: [{ id, at, author, text }], statuses: [{ status, at, current }] }]
-- The copy of the latest comment that the CSV import dated by "Date Updated" is hidden once the real one arrives, and
-- the lead's clocks move to ClickUp's real dates while nothing has been done to it in BOE One yet. Nobody is notified.
create function public.import_sales_lead_history(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('assign');
  r jsonb;
  c jsonb;
  s jsonb;
  v_task text;
  v_lead uuid;
  v_ref text;
  v_text text;
  v_at timestamptz;
  v_now_at timestamptz;
  v_act uuid;
  v_texts text[];
  v_added integer;
  v_added_s integer;
  v_comments integer := 0;
  v_statuses integer := 0;
  v_already integer := 0;
  v_missing integer := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 300 then
    raise exception 'SALES_INVALID: Send up to 300 tasks at a time.';
  end if;
  if (select coalesce(sum(jsonb_array_length(coalesce(x -> 'comments', '[]'::jsonb))), 0) from jsonb_array_elements(p_rows) x) > 3000 then
    raise exception 'SALES_INVALID: Send up to 3,000 comments at a time.';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_task := nullif(btrim(r ->> 'task_id'), '');
    v_lead := null;
    select i.lead_id into v_lead from public.sales_lead_imports i where i.task_id = v_task;
    if v_lead is null then
      v_missing := v_missing + 1;
      continue;
    end if;

    begin
      v_added := 0;
      v_added_s := 0;
      v_texts := '{}';
      v_now_at := null;

      for c in select value from jsonb_array_elements(coalesce(r -> 'comments', '[]'::jsonb)) loop
        v_text := left(nullif(btrim(c ->> 'text'), ''), 3900);
        if nullif(c ->> 'id', '') is null or v_text is null then continue; end if;
        v_texts := array_append(v_texts, v_text);
        v_ref := left('comment:' || (c ->> 'id'), 300);
        if exists (select 1 from public.sales_lead_import_refs x where x.ref = v_ref) then
          v_already := v_already + 1;
          continue;
        end if;
        v_at := (c ->> 'at')::timestamptz;
        insert into public.sales_lead_activities (lead_id, kind, outcome, note, prior, at)
        values (v_lead, 'imported', 'imported', left(concat_ws(': ', left(nullif(btrim(c ->> 'author'), ''), 80), v_text), 4000), '{}'::jsonb, v_at)
        returning id into v_act;
        insert into public.sales_lead_import_refs (ref, lead_id, activity_id, at) values (v_ref, v_lead, v_act, v_at);
        v_added := v_added + 1;
      end loop;

      for s in select value from jsonb_array_elements(coalesce(r -> 'statuses', '[]'::jsonb)) loop
        if nullif(btrim(s ->> 'status'), '') is null or nullif(s ->> 'at', '') is null then continue; end if;
        v_at := (s ->> 'at')::timestamptz;
        if (s ->> 'current')::boolean is true then v_now_at := v_at; end if;
        v_ref := left('status:' || v_task || ':' || lower(btrim(s ->> 'status')) || ':' || floor(extract(epoch from v_at))::bigint, 300);
        if exists (select 1 from public.sales_lead_import_refs x where x.ref = v_ref) then
          v_already := v_already + 1;
          continue;
        end if;
        insert into public.sales_lead_events (lead_id, kind, detail, at)
        values (v_lead, 'clickup_status', left(lower(btrim(s ->> 'status')), 200), v_at);
        insert into public.sales_lead_import_refs (ref, lead_id, at) values (v_ref, v_lead, v_at);
        v_added_s := v_added_s + 1;
      end loop;

      if cardinality(v_texts) > 0 then
        update public.sales_lead_activities a
        set undone_at = now()
        where a.lead_id = v_lead and a.kind = 'imported' and a.undone_at is null
          and (
            a.id = (select x.activity_id from public.sales_lead_import_refs x where x.ref = 'latest:' || v_task)
            or (a.note = any (v_texts) and not exists (select 1 from public.sales_lead_import_refs x where x.activity_id = a.id))
          );
      end if;

      if not exists (select 1 from public.sales_lead_activities a where a.lead_id = v_lead and a.kind <> 'imported') then
        update public.sales_leads l
        set first_attempt_at = case when l.first_attempt_at is null then null else coalesce(h.first_at, l.first_attempt_at) end,
            first_contact_at = case when l.first_contact_at is null then null else coalesce(h.first_at, l.first_contact_at) end,
            last_activity_at = case when l.last_activity_at is null then null else coalesce(h.last_at, l.last_activity_at) end,
            stage_changed_at = coalesce(v_now_at, l.stage_changed_at),
            updated_at = now()
        from (
          select min(x.at) as first_at, max(x.at) as last_at
          from public.sales_lead_import_refs x
          where x.lead_id = v_lead and x.ref like 'comment:%'
        ) h
        where l.id = v_lead and (h.first_at is not null or v_now_at is not null);
      end if;

      v_comments := v_comments + v_added;
      v_statuses := v_statuses + v_added_s;
    exception
      when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow
        or invalid_datetime_format or string_data_right_truncation or invalid_parameter_value then
        v_failed := v_failed || jsonb_build_object('task_id', v_task, 'why', 'details the database refused');
    end;
  end loop;

  return jsonb_build_object('comments', v_comments, 'statuses', v_statuses, 'already', v_already,
    'not_imported', v_missing, 'failed', v_failed);
end;
$$;

-- ═══ 5. Who may call what ════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_lead_can_hold(uuid) from public, anon, authenticated;
revoke all on function public.list_sales_lead_holders() from public, anon;
grant execute on function public.list_sales_lead_holders() to authenticated;
revoke all on function public.import_sales_lead_history(jsonb) from public, anon;
grant execute on function public.import_sales_lead_history(jsonb) to authenticated;

-- ═══ 6. Self-checks (these fail the migration rather than let a half-applied state look fine) ══════════════════════

do $$
declare v_fn text;
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.sales_lead_import_refs'::regclass) then
    raise exception 'SALES_REVIEW_FIXES: row level security must be on for the import refs table';
  end if;
  if has_table_privilege('authenticated', 'public.sales_lead_import_refs', 'SELECT')
     or has_table_privilege('authenticated', 'public.sales_lead_import_refs', 'INSERT') then
    raise exception 'SALES_REVIEW_FIXES: a browser must not reach the import refs table';
  end if;
  if has_function_privilege('authenticated', 'public.sales_lead_can_hold(uuid)', 'EXECUTE') then
    raise exception 'SALES_REVIEW_FIXES: sales_lead_can_hold is internal';
  end if;
  foreach v_fn in array array[
    'public.list_sales_lead_holders()', 'public.import_sales_lead_history(jsonb)', 'public.allot_sales_lead(uuid, uuid, uuid)',
    'public.reassign_due_sales_leads(uuid, uuid)', 'public.import_sales_leads(jsonb)', 'public.move_sales_lead(uuid, text, text, text, text, text, date)',
    'public.update_sales_lead_facts(uuid, jsonb, timestamptz)', 'public.sales_my_day()', 'public.sales_team_overview(date, text, uuid)'
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') then raise exception 'SALES_REVIEW_FIXES: % is open to anon', v_fn; end if;
    if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then raise exception 'SALES_REVIEW_FIXES: % lost its grant', v_fn; end if;
  end loop;
  if has_function_privilege('authenticated', 'public.sales_lead_send_alerts(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.sales_lead_send_alerts(text)', 'EXECUTE') then
    raise exception 'SALES_REVIEW_FIXES: the alert job is for the service role only';
  end if;
end $$;
