-- 20270703000100_sales_comments_and_due_dates.sql
--
-- Sales, Lead Board: the lead panel becomes one comment box and an activity feed, and follow-up dates default to the
-- next working day (owner, 2026-11-13, after a clickable preview).
--
-- What the owner asked:
--   * "If the client does not respond, we move it to under process": a No answer, from any screen, moves a lead that
--     is still New to Under process (the first try has happened). Before, only a real contact moved it.
--   * "The due date should be by default set to the next working day, with an option to customise it": working days are
--     Monday to Saturday (rule 16 of the dossier); a Sunday is skipped. No answer and the WhatsApp quick message used
--     "tomorrow" (Sundays included); both now use the next working day.
--   * "Any kind of update, they just enter it into the comment box": one new write, add_sales_lead_comment. A comment
--     is an activity of its own kind `note` (outcome `note`). Two quick notes carry a meaning the database keeps:
--     `not_responding` counts as a try (outcome no_answer, the streak grows, nothing counts as contact) and `quotation`
--     is a logged quotation (kind quotation, so the Negotiation checklist is satisfied). Any other comment counts as
--     contact: the person writes when something happened. A New lead moves to Under process on all three.
--   * "An option to change the due date irrespective of the stage": change_sales_lead_due, for any open lead, with its
--     own history line (event kind `due_changed`, detail `old>new`). Not in the past; not for Converted or Dead.
--
-- WRITE: add_sales_lead_comment and change_sales_lead_due (whoever may work the lead, as log_sales_lead_activity). The
--   two table changes are CHECK lists: activity kind and outcome gain `note`, event kind gains `due_changed`.
--
-- ROLLBACK: re-run the 20270527000000 definitions of sales_lead_record, sales_lead_no_answer and (20270525000000)
--   sales_lead_message_sent; drop function public.change_sales_lead_due(uuid, date),
--   public.add_sales_lead_comment(uuid, text, text, date), public.sales_next_working_day(date); then put the three CHECK
--   lists back to their 20270527000000 values (only after deleting or re-labelling any `note` / `due_changed` rows).

-- ═══ 1. The three CHECK lists ═══════════════════════════════════════════════════════════════════════════════════════

alter table public.sales_lead_activities
  drop constraint sales_lead_activities_kind_check,
  add constraint sales_lead_activities_kind_check
    check (kind in ('call', 'whatsapp', 'meeting', 'email', 'quotation', 'sample', 'imported', 'note')),
  drop constraint sales_lead_activities_outcome_check,
  add constraint sales_lead_activities_outcome_check
    check (outcome in ('interested', 'still_deciding', 'call_back', 'no_answer', 'sent', 'imported', 'not_interested', 'note'));

alter table public.sales_lead_events drop constraint sales_lead_events_kind_check;
alter table public.sales_lead_events add constraint sales_lead_events_kind_check
  check (kind in ('added', 'allotted', 'reassigned', 'edited', 'moved', 'enquired_again', 'imported', 'clickup_status', 'due_changed'));

-- ═══ 2. The next working day ════════════════════════════════════════════════════════════════════════════════════════

-- The day after p_from, skipping a Sunday (Monday to Saturday are working days).
create function public.sales_next_working_day(p_from date)
returns date
language sql
immutable
set search_path = public, pg_temp
as $$
  select case extract(isodow from p_from + 1)::integer when 7 then p_from + 2 else p_from + 1 end;
$$;

-- ═══ 3. Re-issued: a No answer on a New lead is the first try, so the lead moves on (20270527000000 + that) ═════════

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
  -- A real contact, or a try nobody answered, takes a New lead to Under process. Not interested does not (it asks why).
  v_stage text := case when l.stage = 'new' and p_outcome <> 'not_interested' and (p_contact or p_outcome = 'no_answer')
                       then 'under_process' else l.stage end;
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

-- ═══ 4. Re-issued: No answer and the WhatsApp quick message come back on the next working day ═══════════════════════

create or replace function public.sales_lead_no_answer(p_id uuid)
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
    public.sales_next_working_day((now() at time zone 'Asia/Kolkata')::date), false, v_row.no_answer_streak + 1
  );
  select * into v_row from public.sales_leads where id = p_id;
  return jsonb_build_object('status', 'saved', 'activity_id', v_activity, 'streak', v_row.no_answer_streak, 'lead', public.sales_lead_row(v_row));
end;
$$;

create or replace function public.sales_lead_message_sent(p_id uuid, p_label text)
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
    public.sales_next_working_day((now() at time zone 'Asia/Kolkata')::date), false, v_row.no_answer_streak
  );
  select * into v_row from public.sales_leads where id = p_id;
  return jsonb_build_object('status', 'saved', 'activity_id', v_activity, 'lead', public.sales_lead_row(v_row));
end;
$$;

-- ═══ 5. A comment ═══════════════════════════════════════════════════════════════════════════════════════════════════

-- p_tag: null (a plain update), 'not_responding' (a try nobody answered) or 'quotation' (a quotation was shared).
-- p_next_due: the follow-up; null is the next working day.
create function public.add_sales_lead_comment(p_id uuid, p_note text, p_tag text default null, p_next_due date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_leads := public.sales_lead_for_work(p_id);
  v_note text := nullif(btrim(p_note), '');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_due date;
  v_not_responding boolean := coalesce(p_tag = 'not_responding', false);
  v_activity uuid;
begin
  if v_row.stage in ('converted', 'dead') then raise exception 'SALES_INVALID: Reopen this lead before adding an update.'; end if;
  if v_note is null then raise exception 'SALES_INVALID: Write what happened.'; end if;
  if length(v_note) > 4000 then raise exception 'SALES_INVALID: Keep the update under 4,000 characters.'; end if;
  if p_tag is not null and p_tag not in ('not_responding', 'quotation') then raise exception 'SALES_INVALID: Unknown quick note.'; end if;
  v_due := coalesce(p_next_due, public.sales_next_working_day(v_today));
  if v_due < v_today then raise exception 'SALES_INVALID: The follow-up cannot be in the past.'; end if;

  v_activity := public.sales_lead_record(
    v_row,
    case when p_tag = 'quotation' then 'quotation' else 'note' end,
    case when v_not_responding then 'no_answer' when p_tag = 'quotation' then 'sent' else 'note' end,
    v_note,
    case when p_tag = 'quotation' then 'Follow up on the quotation' else 'Follow up' end,
    v_due,
    not v_not_responding,
    case when v_not_responding then v_row.no_answer_streak + 1 else 0 end
  );
  select * into v_row from public.sales_leads where id = p_id;
  return jsonb_build_object('status', 'saved', 'activity_id', v_activity, 'streak', v_row.no_answer_streak, 'lead', public.sales_lead_row(v_row));
exception
  when check_violation then raise exception 'SALES_INVALID: Check the details and try again.';
end;
$$;

-- ═══ 6. The follow-up date, in any open stage ═══════════════════════════════════════════════════════════════════════

create function public.change_sales_lead_due(p_id uuid, p_due date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.sales_leads := public.sales_lead_for_work(p_id);
  v_before date;
begin
  if v_row.stage in ('converted', 'dead') then raise exception 'SALES_INVALID: A closed lead has no follow-up date. Reopen it first.'; end if;
  if p_due is null then raise exception 'SALES_INVALID: Choose a date.'; end if;
  if p_due < (now() at time zone 'Asia/Kolkata')::date then raise exception 'SALES_INVALID: The follow-up cannot be in the past.'; end if;
  if p_due is not distinct from v_row.next_due_on then
    return jsonb_build_object('status', 'unchanged', 'lead', public.sales_lead_row(v_row));
  end if;
  v_before := v_row.next_due_on;
  update public.sales_leads set next_due_on = p_due, updated_at = now() where id = p_id returning * into v_row;
  insert into public.sales_lead_events (lead_id, kind, detail, actor)
  values (p_id, 'due_changed', coalesce(v_before::text, '') || '>' || p_due::text, v_uid);
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_row(v_row));
end;
$$;

-- ═══ 7. Who may call what ═══════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_next_working_day(date) from public, anon, authenticated;
revoke all on function public.sales_lead_record(public.sales_leads, text, text, text, text, date, boolean, integer) from public, anon, authenticated;
revoke all on function public.add_sales_lead_comment(uuid, text, text, date) from public, anon;
revoke all on function public.change_sales_lead_due(uuid, date) from public, anon;
grant execute on function public.add_sales_lead_comment(uuid, text, text, date) to authenticated;
grant execute on function public.change_sales_lead_due(uuid, date) to authenticated;

-- ═══ 8. Self-checks ═════════════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  -- Monday to Saturday are working days: Friday to Saturday, Saturday to Monday, Sunday to Monday.
  if public.sales_next_working_day(date '2026-11-13') <> date '2026-11-14'
     or public.sales_next_working_day(date '2026-11-14') <> date '2026-11-16'
     or public.sales_next_working_day(date '2026-11-15') <> date '2026-11-16' then
    raise exception 'SALES_COMMENTS: the next working day skips a Sunday and nothing else';
  end if;
  if has_function_privilege('authenticated', 'public.sales_next_working_day(date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sales_lead_record(public.sales_leads, text, text, text, text, date, boolean, integer)', 'EXECUTE') then
    raise exception 'SALES_COMMENTS: the helpers are internal';
  end if;
  if has_function_privilege('anon', 'public.add_sales_lead_comment(uuid, text, text, date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.change_sales_lead_due(uuid, date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.add_sales_lead_comment(uuid, text, text, date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.change_sales_lead_due(uuid, date)', 'EXECUTE') then
    raise exception 'SALES_COMMENTS: the two writes are for signed-in people only (each checks the lead itself)';
  end if;
end $$;
