-- 20270816000000_quotation_start_contact_role.sql
--
-- Quotations: a quotation started from a lead also copies the lead's CONTACT ROLE (20270815000000: property_owner, architect,
-- interior_designer, fnb_consultant, other) into the quotation's client type, which uses the same five keys. A lead with no role
-- leaves the client type empty, as before. Nothing is typed again (owner, 20 Nov 2026).
--
-- quotation_start is re-created, the same as in 20270814000000 plus that one column. No table, column or data changes.
-- ROLLBACK: run quotation_start from 20270814000000_quotation_start_from_lead.sql again.

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sales_leads' and column_name = 'contact_role')
     or to_regprocedure('public.quotation_start(uuid, jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: sales_leads.contact_role (20270815000000) and quotation_start (20270814000000) must exist';
  end if;
end $$;

create or replace function public.quotation_start(p_lead uuid, p_data jsonb default '{}'::jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a record; l public.sales_leads; v_owner uuid; v_id uuid; v_no text; v_name text; v_note text; v_src text;
  v_want text := nullif(btrim(coalesce(p_data->>'owner_id', '')), '');
begin
  select * into a from public.quotation_actor();
  if not (a.p_create or a.p_admin) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may not start quotations' using errcode = '42501';
  end if;
  if not public.module_entry_open('sales') then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  select * into l from public.sales_leads where id = p_lead;
  if l.id is null or not public.sales_lead_visible(l.assigned_to, l.created_by) then
    raise exception 'SALES_NOT_FOUND' using errcode = 'P0002';
  end if;
  if l.stage = 'dead' then
    raise exception 'QUOTATION_LEAD_CLOSED: Lead % is marked Dead; reopen the lead on the Lead Board before making a quotation', l.lead_no using errcode = '22023';
  end if;

  v_owner := a.p_uid;
  if v_want is not null and v_want::uuid <> a.p_uid then
    if not (a.p_admin or (a.p_edit and a.p_view_all)) then
      raise exception 'QUOTATIONS_FORBIDDEN: only an administrator or the pricing desk may start a quotation for somebody else' using errcode = '42501';
    end if;
    if not public.quotation_can_own(v_want::uuid) then
      raise exception 'QUOTATION_INVALID: that person cannot own quotations' using errcode = '22023';
    end if;
    v_owner := v_want::uuid;
  end if;

  v_name := coalesce(nullif(btrim(l.name), ''), 'Lead ' || l.lead_no);
  v_note := 'From lead ' || l.lead_no || coalesce(' · ' || left(btrim(l.requirement), 800), '');
  v_src := coalesce(nullif(left(btrim(coalesce(p_data->>'source', '')), 120), ''), 'Sales lead');
  v_no := 'QT-' || public.quotation_initials(v_owner) || '-' || lpad(nextval('public.quotation_no_seq')::text, 5, '0');

  insert into public.quotations (quote_no, client_name, contact_name, contact_phone, client_email, delivery_city, project_type, client_type,
                                 internal_notes, gst_mode, source, lead_id, owner_id, created_by)
  values (v_no, left(v_name, 160), nullif(left(btrim(coalesce(l.name, '')), 120), ''), l.phone_e164, nullif(left(l.email, 160), ''),
          nullif(left(btrim(coalesce(l.location, '')), 80), ''), l.client_type, l.contact_role, v_note, 'igst', v_src, l.id, v_owner, a.p_uid)
  returning id into v_id;

  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (v_id, a.p_uid, 'created', jsonb_build_object('quote_no', v_no, 'lead_id', l.id, 'lead_no', l.lead_no)
                                    || case when v_owner <> a.p_uid then jsonb_build_object('for_owner', v_owner) else '{}'::jsonb end);
  return v_id;
exception
  when check_violation or not_null_violation or invalid_text_representation then
    raise exception 'QUOTATION_INVALID: %', sqlerrm using errcode = '22023';
end $$;
revoke all on function public.quotation_start(uuid, jsonb) from public, anon;
grant execute on function public.quotation_start(uuid, jsonb) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_start(uuid, jsonb)', 'EXECUTE') or not has_function_privilege('authenticated', 'public.quotation_start(uuid, jsonb)', 'EXECUTE') then
    raise exception 'QUOTATION_START: quotation_start must be callable by signed-in people only';
  end if;
  if pg_get_functiondef('public.quotation_start(uuid, jsonb)'::regprocedure) not like '%contact_role%' then
    raise exception 'QUOTATION_START: the new definition did not take';
  end if;
end $$;
