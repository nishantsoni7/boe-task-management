-- 20270710000000_sales_visit_meeting_stage.sql
--
-- Sales, Lead Board: a Visit / Meeting stage, and the ClickUp leads that were Important Bulk, Bulk or Potential
-- Customers move to Potential Clients (owner, 2026-11-13, with the round-3 preview approved).
--
-- What the owner asked:
--   * The stages, in this order: New, Under Process, Visit / Meeting, Potential Clients, Negotiation, Converted, Dead.
--     Visit / Meeting is new (key `visit_meeting`). The other names change on screen only; the keys stay. Follow up later
--     stays as a side option (the owner's list did not name it; kept, as offered).
--   * "All the leads which were transferred from ClickUp (from Important Bulk / Bulk / Potential Customers) to
--     Potential status." As offered: only OPEN leads still where the import put them. A lead a person has moved in BOE
--     One stays where they put it; Dead and Converted leads stay; leads already in Potential Clients are left alone.
--
-- Visit / Meeting is ranked like Under Process (2) for the furthest stage reached, the checks on a move, the Team
-- page's funnel and the red limit (7 days), so no stored rank changes. Moving into it needs nothing first, not even a
-- contact from New.
--
-- WRITE: stage CHECK widened; four functions re-issued from their latest definitions; one data step (section 3)
--   that moves leads and writes one history line each. THIS CHANGES DATA: back up first.
--
-- ROLLBACK: move any `visit_meeting` lead back to `under_process`; re-run the 20270526000100 definitions of
--   sales_leads_furthest and sales_lead_stuck, the 20270527000000 definition of move_sales_lead and the
--   20270601000000 definition of sales_board_page; restore the stage CHECK without `visit_meeting`. The ClickUp move
--   is found by its history lines: a `moved` event with detail 'under_process>potential', actor null, written at this
--   migration's transaction time; a lead still in Potential Clients with such a line goes back to `under_process`.

-- ═══ 1. The stage list ════════════════════════════════════════════════════════════════════════════════════════

alter table public.sales_leads drop constraint sales_leads_stage_check;
alter table public.sales_leads add constraint sales_leads_stage_check check (stage in (
  'new', 'under_process', 'visit_meeting', 'potential', 'negotiation', 'follow_up_later', 'converted', 'dead'
));

-- ═══ 2. Re-issued with Visit / Meeting (each the latest definition, the stage lines changed only) ══════════════

-- 20270526000100: the furthest stage a lead reached. Visit / Meeting counts as far as Under Process.
create or replace function public.sales_leads_furthest()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.furthest_rank := greatest(
    new.furthest_rank,
    case when tg_op = 'UPDATE' then old.furthest_rank else 1 end,
    case new.stage when 'under_process' then 2 when 'visit_meeting' then 2 when 'potential' then 3 when 'negotiation' then 4 when 'converted' then 5 else 1 end
  );
  return new;
end;
$$;

-- 20270526000100: a lead goes red after 7 days in Visit / Meeting, as in Under Process.
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
        when 'visit_meeting' then interval '7 days'
        when 'potential' then interval '7 days'
        when 'negotiation' then interval '3 days'
      end,
      false
    );
$$;

-- 20270527000000: moving a lead. Visit / Meeting is checked like Under Process and needs no contact first.
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
  v_rank integer := case p_to when 'new' then 1 when 'under_process' then 2 when 'visit_meeting' then 2 when 'potential' then 3 when 'negotiation' then 4 when 'converted' then 5 else 0 end;
  v_from_rank integer := case v_row.stage when 'new' then 1 when 'under_process' then 2 when 'visit_meeting' then 2 when 'potential' then 3 when 'negotiation' then 4 else 0 end;
  v_missing text[] := '{}';
  v_closing boolean := p_to in ('converted', 'dead');
  v_reopening boolean := v_row.stage in ('converted', 'dead') and p_to not in ('converted', 'dead');
  v_step text := coalesce(nullif(btrim(p_next_step), ''), v_row.next_step);
  v_due date := coalesce(p_next_due, v_row.next_due_on);
begin
  v_uid := auth.uid();
  if p_to not in ('new', 'under_process', 'visit_meeting', 'potential', 'negotiation', 'follow_up_later', 'converted', 'dead') then
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
    -- Visit / Meeting asks for nothing first (owner, 2026-11-13).
    if v_from_rank <= 1 and p_to <> 'visit_meeting' and v_row.first_contact_at is null then v_missing := array_append(v_missing, 'contact'); end if;
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

-- 20270601000000: one page of one column of the board.
create or replace function public.sales_board_page(
  p_stage text,
  p_offset integer default 0,
  p_limit integer default 40,
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
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 100);
  v_result jsonb;
begin
  if p_stage is null or p_stage not in ('new', 'under_process', 'visit_meeting', 'potential', 'negotiation', 'follow_up_later', 'converted', 'dead') then
    raise exception 'SALES_INVALID: Choose a stage of the board.';
  end if;

  select coalesce(array_agg(a.subject_id), '{}') into v_juniors from public.sales_lead_access a where a.viewer_id = v_uid;

  with ranked as (
    select l.id, l.stage, l.next_due_on, row_number() over (
      order by
        case when l.stage in ('converted', 'dead') then 0 else 1 end,
        l.closed_at desc nulls last,
        case when l.stage = 'follow_up_later' then 3 when l.next_due_on < v_today then 0 when l.next_due_on = v_today then 1 else 2 end,
        case l.temperature when 'hot' then 0 when 'warm' then 1 else 2 end,
        l.expected_value_paise desc nulls last,
        l.next_due_on, l.lead_no
    ) as rn
    from public.sales_leads l
    where l.stage = p_stage
      and l.assigned_to is not null and (v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors))
      and (v_holder is null or l.assigned_to = v_holder)
      and (coalesce(p_market, '') = '' or l.market = p_market)
      and (coalesce(p_segment, '') = '' or l.segment = p_segment)
      and (coalesce(p_temperature, '') = '' or l.temperature = p_temperature)
      and (coalesce(p_source, '') = '' or l.source = p_source)
      and (v_q = ''
        or (length(v_digits) >= 3 and l.phone_e164 like '%' || v_digits || '%')
        or l.name ilike v_like or l.location ilike v_like or l.requirement ilike v_like)
      and (l.stage not in ('converted', 'dead') or l.closed_at >= now() - interval '30 days')
  )
  select jsonb_build_object(
    'n', (select count(*) from ranked),
    'overdue', (select count(*) from ranked r where r.stage not in ('follow_up_later', 'converted', 'dead') and r.next_due_on < v_today),
    'due_today', (select count(*) from ranked r where r.stage not in ('follow_up_later', 'converted', 'dead') and r.next_due_on = v_today),
    'rows', (
      select coalesce(jsonb_agg(public.sales_lead_row(x) order by r.rn), '[]'::jsonb)
      from ranked r
      join public.sales_leads x on x.id = r.id
      where r.rn > v_offset and r.rn <= v_offset + v_limit
    )
  ) into v_result;

  return v_result;
end;
$$;

-- ═══ 3. ClickUp leads from Important Bulk, Bulk and Potential Customers go to Potential Clients ══════════════════
-- The ClickUp status each lead came with is the detail of its `imported` history line ("important bulk (ak)": every
-- salesperson had their own copy, so the "(..)" is dropped, as statusFamily does in clickup.ts). Only open leads still
-- in Under Process, where the import put them, and never moved by a person since. One `moved` line each, by nobody
-- (the screens show it as done automatically).

do $$
declare v_n integer;
begin
  with picked as (
    select l.id from public.sales_leads l
    where l.imported_at is not null
      and l.stage = 'under_process'
      and exists (
        select 1 from public.sales_lead_events e
        where e.lead_id = l.id and e.kind = 'imported'
          and regexp_replace(lower(btrim(coalesce(e.detail, ''))), '\s*\([^)]*\)\s*$', '') in ('important bulk', 'bulk', 'potential customers')
      )
      and not exists (select 1 from public.sales_lead_events e where e.lead_id = l.id and e.kind = 'moved' and e.actor is not null)
  ), moved as (
    update public.sales_leads l
    set stage = 'potential', stage_changed_at = now(), updated_at = now()
    from picked p
    where l.id = p.id
    returning l.id
  ), logged as (
    insert into public.sales_lead_events (lead_id, kind, detail, actor)
    select m.id, 'moved', 'under_process>potential', null from moved m
    returning 1
  )
  select count(*) into v_n from logged;
  raise notice 'SALES_VISIT_STAGE: % ClickUp leads moved from Under Process to Potential Clients', v_n;
end $$;

-- ═══ 4. Self-checks (these fail the migration rather than let a half-applied state look fine) ═════════════════

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_leads_stage_check' and pg_get_constraintdef(oid) like '%visit_meeting%'
  ) then
    raise exception 'SALES_VISIT_STAGE: the stage list has no visit_meeting';
  end if;
  if position('visit_meeting' in pg_get_functiondef('public.sales_leads_furthest()'::regprocedure)) = 0
     or position('visit_meeting' in pg_get_functiondef('public.sales_lead_stuck(public.sales_leads)'::regprocedure)) = 0
     or position('visit_meeting' in pg_get_functiondef('public.move_sales_lead(uuid, text, text, text, text, text, date)'::regprocedure)) = 0
     or position('visit_meeting' in pg_get_functiondef('public.sales_board_page(text, integer, integer, text, text, text, text, text, text)'::regprocedure)) = 0 then
    raise exception 'SALES_VISIT_STAGE: a re-issued function does not know visit_meeting';
  end if;
  if has_function_privilege('anon', 'public.move_sales_lead(uuid, text, text, text, text, text, date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.move_sales_lead(uuid, text, text, text, text, text, date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.sales_board_page(text, integer, integer, text, text, text, text, text, text)', 'EXECUTE') then
    raise exception 'SALES_VISIT_STAGE: the browser functions lost or gained a grant';
  end if;
  if has_function_privilege('authenticated', 'public.sales_lead_stuck(public.sales_leads)', 'EXECUTE') then
    raise exception 'SALES_VISIT_STAGE: sales_lead_stuck is internal';
  end if;
end $$;
