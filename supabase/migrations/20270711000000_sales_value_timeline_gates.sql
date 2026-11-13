-- 20270711000000_sales_value_timeline_gates.sql
--
-- Sales, Lead Board: what a move asks for first (owner, 2026-11-13, after using the popup).
--
--   * Potential Clients asked for the requirement and the QUANTITY. Now: the requirement and the approximate PROJECT
--     VALUE (expected_value_paise) instead of the quantity. "Do not ask for quantity. Instead ask for approximate
--     Project Value."
--   * Negotiation asked for a logged quotation, the value and the timeline (and the quantity, if not yet given). Now: the
--     logged quotation, the project value if still empty, and the expected timeline. No quantity.
--   * Converted asked for the contact, requirement, quantity and value. Now: no quantity.
--   * Quantity stays a fact of the lead (Client details), never asked for by a move.
--   * Nothing else changes: only a step past the furthest stage reached is checked, leaving New still needs a contact
--     (except into Visit / Meeting), Dead still asks why.
--
-- WRITE: nothing new. move_sales_lead is re-issued from its 20270710000000 definition with the fact lines changed only.
--   No table, column, constraint or data changes: a same-day verified backup is enough.
--
-- ROLLBACK: re-run the 20270710000000 definition of public.move_sales_lead.

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
    if v_rank = 4 and not exists (
      select 1 from public.sales_lead_activities a where a.lead_id = p_id and a.kind = 'quotation' and a.undone_at is null
    ) then v_missing := array_append(v_missing, 'quotation'); end if;
    -- The approximate project value from Potential Clients on (owner, 2026-11-13: "instead ask for approximate Project Value").
    if v_rank >= 3 and v_row.expected_value_paise is null then v_missing := array_append(v_missing, 'value'); end if;
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


-- Same grants as before (create or replace keeps them); checked anyway.
do $$
declare v_def text := pg_get_functiondef('public.move_sales_lead(uuid, text, text, text, text, text, date)'::regprocedure);
begin
  if position('''quantity''' in v_def) > 0 then
    raise exception 'SALES_GATES: a move still asks for the quantity';
  end if;
  if position('if v_rank >= 3 and v_row.expected_value_paise is null' in v_def) = 0 then
    raise exception 'SALES_GATES: Potential Clients does not ask for the project value';
  end if;
  if has_function_privilege('anon', 'public.move_sales_lead(uuid, text, text, text, text, text, date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.move_sales_lead(uuid, text, text, text, text, text, date)', 'EXECUTE') then
    raise exception 'SALES_GATES: move_sales_lead lost or gained a grant';
  end if;
end $$;
