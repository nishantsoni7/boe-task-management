-- 20270815000000_lead_contact_role_and_boq.sql
--
-- Sales leads: who the contact is, and "Waiting for BOQ" (owner approved 2026-11-20: "Yes, build it"; the last piece after the Lead
-- card on the quotation, the lead popup's quotations and the Lost reasons).
--
--   * sales_leads.contact_role: optional, one of the five roles a quotation's client type already uses (property_owner, architect,
--     interior_designer, fnb_consultant, other), so one list serves both. It is set in the popup's Edit details; nothing requires it.
--     update_sales_lead_facts takes it, and sales_lead_row (the lead as the screens read it) returns it.
--   * add_sales_lead_comment accepts the quick note tag 'boq' ("Waiting for BOQ"): the update is saved as any other note, the next
--     step becomes "Waiting for BOQ / drawings", and without a date the follow-up is 3 days on (a Sunday becomes Monday). It counts as
--     contact, like a plain note. It is not a stage: nothing moves except New to Under Process by the existing rule.
--
-- WRITE: ONE NULLABLE COLUMN ON public.sales_leads (existing leads keep null) and three functions replaced. A same-day verified backup first.
--
-- ROLLBACK: re-run the definitions of public.sales_lead_row (20270613000000), public.update_sales_lead_facts (20270527000000) and
--   public.add_sales_lead_comment (20270722000000); then alter table public.sales_leads drop column contact_role.

do $$
begin
  if to_regclass('public.sales_leads') is null or to_regprocedure('public.sales_lead_row(public.sales_leads)') is null
     or to_regprocedure('public.update_sales_lead_facts(uuid, jsonb, timestamp with time zone)') is null
     or to_regprocedure('public.add_sales_lead_comment(uuid, text, text, date, jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: sales_leads, sales_lead_row, update_sales_lead_facts and add_sales_lead_comment (5 arguments) must exist';
  end if;
end $$;

alter table public.sales_leads add column contact_role text
  check (contact_role is null or contact_role in ('property_owner', 'architect', 'interior_designer', 'fnb_consultant', 'other'));

-- ═══ The lead as the screens read it: one more key ═══
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
    'contact_role', l.contact_role,
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
    'premium', public.sales_lead_premium(l),
    'wa_tag', l.wa_tag,
    'wa_reason', l.wa_reason
  );
$$;

-- ═══ Edit details takes the role ═══
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
  foreach v_key in array array['name', 'email', 'location', 'requirement', 'quantity', 'timeline', 'segment', 'client_type', 'contact_role', 'temperature', 'expected_value_paise'] loop
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
        when 'contact_role' then v_new.contact_role := v_val;
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
      quantity = v_new.quantity, timeline = v_new.timeline, segment = v_new.segment, client_type = v_new.client_type, contact_role = v_new.contact_role,
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

-- ═══ An update can be tagged Waiting for BOQ ═══
create or replace function public.add_sales_lead_comment(
  p_id uuid, p_note text, p_tag text default null, p_next_due date default null, p_files jsonb default '[]'::jsonb
)
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
  v_files jsonb := coalesce(p_files, '[]'::jsonb);
  v_activity uuid;
begin
  if v_row.stage in ('converted', 'dead') then raise exception 'SALES_INVALID: Reopen this lead before adding an update.'; end if;
  if v_note is null then raise exception 'SALES_INVALID: Write what happened.'; end if;
  if length(v_note) > 4000 then raise exception 'SALES_INVALID: Keep the update under 4,000 characters.'; end if;
  if p_tag is not null and p_tag not in ('not_responding', 'quotation', 'boq') then raise exception 'SALES_INVALID: Unknown quick note.'; end if;
  -- Waiting for BOQ: the follow-up is 3 days on (a Sunday becomes Monday); every other note, the next working day.
  v_due := coalesce(p_next_due, case when p_tag = 'boq' then v_today + 3 + case when extract(isodow from v_today + 3) = 7 then 1 else 0 end
                                      else public.sales_next_working_day(v_today) end);
  if v_due < v_today then raise exception 'SALES_INVALID: The follow-up cannot be in the past.'; end if;

  if jsonb_typeof(v_files) <> 'array' then raise exception 'SALES_INVALID: Check the files and try again.'; end if;
  if jsonb_array_length(v_files) > 10 then raise exception 'SALES_INVALID: Attach up to 10 files to one update.'; end if;
  if exists (
    select 1 from jsonb_array_elements(v_files) f
    where jsonb_typeof(f) <> 'object'
       or coalesce(f->>'path', '') not like p_id::text || '/%'
       or length(coalesce(f->>'name', '')) not between 1 and 200
  ) then raise exception 'SALES_INVALID: Check the files and try again.'; end if;
  if (select count(distinct f->>'path') from jsonb_array_elements(v_files) f) <> jsonb_array_length(v_files) then
    raise exception 'SALES_INVALID: The same file is attached twice.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_files) f
    where not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'sales-lead-files' and o.name = f->>'path' and o.owner_id = auth.uid()::text
    )
  ) then raise exception 'SALES_INVALID: A file has not finished uploading. Try again.'; end if;

  v_activity := public.sales_lead_record(
    v_row,
    case when p_tag = 'quotation' then 'quotation' else 'note' end,
    case when v_not_responding then 'no_answer' when p_tag = 'quotation' then 'sent' else 'note' end,
    v_note,
    case p_tag when 'quotation' then 'Follow up on the quotation' when 'boq' then 'Waiting for BOQ / drawings' else 'Follow up' end,
    v_due,
    not v_not_responding,
    case when v_not_responding then v_row.no_answer_streak + 1 else 0 end
  );

  -- The size and the type come from the stored object, never from the browser.
  insert into public.sales_lead_attachments (lead_id, activity_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  select p_id, v_activity, o.name, f->>'name',
         coalesce(nullif(o.metadata->>'mimetype', ''), 'application/octet-stream'), (o.metadata->>'size')::bigint, auth.uid()
  from jsonb_array_elements(v_files) f
  join storage.objects o on o.bucket_id = 'sales-lead-files' and o.name = f->>'path';

  select * into v_row from public.sales_leads where id = p_id;
  return jsonb_build_object('status', 'saved', 'activity_id', v_activity, 'streak', v_row.no_answer_streak, 'lead', public.sales_lead_row(v_row));
exception
  when check_violation or not_null_violation or unique_violation then raise exception 'SALES_INVALID: Check the details and try again.';
end;
$$;

-- Same grants as before (create or replace keeps them); checked anyway.
do $$
begin
  if has_function_privilege('anon', 'public.add_sales_lead_comment(uuid, text, text, date, jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.add_sales_lead_comment(uuid, text, text, date, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.update_sales_lead_facts(uuid, jsonb, timestamp with time zone)', 'EXECUTE') then
    raise exception 'LEAD_ROLE_BOQ: a function lost or gained a grant';
  end if;
end $$;
