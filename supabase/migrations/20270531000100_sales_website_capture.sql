-- 20270531000100_sales_website_capture.sql
--
-- Sales: website leads arrive by themselves (owner's plan, Phase 2, approved 2026-11-03).
--
-- What the owner asked, and what this file does about it:
--   * The website form writes each enquiry to the "Website Leads" Google Sheet. A small script in that sheet sends the new
--     rows every five minutes to /api/sales/capture/website, which checks a secret key and calls capture_sales_leads with
--     the service role. Nobody copies a lead by hand any more.
--   * A new number becomes a lead in the Lead Master, Not allotted, with the form's name, email, location and message, and
--     the source Website (or Google Ads when the form says so). Whoever allots (Admin, `assign`) is told at once.
--     Phase 3 will allot it automatically.
--   * A number already in BOE One is a repeat enquiry: the message is added, the holder is told and calls today, a closed
--     or old lead comes back as New, and one nobody holds goes back to the Not allotted queue with the allotters told.
--   * Each form row is remembered by its key (sales_lead_import_refs, 'web:'), so a row sent twice counts once.
--
-- WRITE: capture_sales_leads only, service role only.
--
-- ROLLBACK: drop function public.capture_sales_leads(jsonb), public.sales_lead_tell_allotters(uuid, text, text, text);
--   Leads it created stay; the 'sales_lead_waiting' notices stay (20270531000000).

-- ═══ 1. Who allots ══════════════════════════════════════════════════════════════════════════════════════════════

-- Tell everybody who allots leads about one lead: Admin and `assign`, active.
create function public.sales_lead_tell_allotters(p_lead uuid, p_type text, p_title text, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare x record;
begin
  for x in
    select u.id from public.users u
    where u.is_active and (u.role = 'admin' or public.resolve_permission(u.id, 'sales', 'assign'))
  loop
    perform public.sales_lead_notify(x.id, p_lead, p_type, p_title, p_body);
  end loop;
end;
$$;

-- ═══ 2. The capture ═════════════════════════════════════════════════════════════════════════════════════════════

-- Rows as the sheet script sends them, up to 100 at a time:
--   { key, form_type, name, email, phone, location, message }
-- key identifies the form row (a hash of its number, email, name and message); without one the row itself is hashed.
create function public.capture_sales_leads(p_rows jsonb)
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
  v_failed jsonb := '[]'::jsonb;
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
        perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'New lead from the website',
          left(v_who || coalesce(': ' || v_msg, '') || '. Allot it in Lead Master.', 300));
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
        if v_row.assigned_to is not null then
          perform public.sales_lead_notify(v_row.assigned_to, v_lead, 'sales_lead_enquired_again', 'A lead enquired again',
            left(v_who || ' filled the website form again. Call today.', 300));
        else
          perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'A lead came back from the website',
            left(v_who || coalesce(': ' || v_msg, '') || '. Allot it in Lead Master.', 300));
        end if;
        v_repeat := v_repeat + 1;
      end if;

      insert into public.sales_lead_import_refs (ref, lead_id, at) values (v_ref, v_lead, now());
    exception
      when check_violation or not_null_violation or invalid_text_representation or string_data_right_truncation then
        v_failed := v_failed || jsonb_build_object('key', left(r ->> 'key', 80), 'why', 'details the database refused');
    end;
  end loop;

  return jsonb_build_object('created', v_created, 'repeat', v_repeat, 'already', v_already, 'failed', v_failed);
end;
$$;

-- ═══ 3. Who may call what ════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_lead_tell_allotters(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.capture_sales_leads(jsonb) from public, anon, authenticated;
grant execute on function public.capture_sales_leads(jsonb) to service_role;

-- ═══ 4. Self-checks ══════════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  if has_function_privilege('authenticated', 'public.capture_sales_leads(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.capture_sales_leads(jsonb)', 'EXECUTE') then
    raise exception 'SALES_CAPTURE: capture_sales_leads is for the service role only';
  end if;
  if not has_function_privilege('service_role', 'public.capture_sales_leads(jsonb)', 'EXECUTE') then
    raise exception 'SALES_CAPTURE: the capture route needs the service role';
  end if;
  if has_function_privilege('authenticated', 'public.sales_lead_tell_allotters(uuid, text, text, text)', 'EXECUTE') then
    raise exception 'SALES_CAPTURE: sales_lead_tell_allotters is internal';
  end if;
end $$;
