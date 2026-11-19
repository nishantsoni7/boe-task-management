-- 20270814000000_quotation_start_from_lead.sql
--
-- Quotations: a quotation STARTS FROM a Sales lead (owner, 20 Nov 2026: "One very important condition before making the
-- quotation should be linking it with the lead directly (from the sales module). No manual adding of information is required.
-- Details will automatically be fetched from there.").
--
--   quotation_start(lead, data) -> uuid
--     One atomic call: checks the caller may make quotations AND may see the lead (Sales module open, sales_lead_visible), then
--     writes the quotation already linked (quotations.lead_id) with the client's details COPIED from the lead:
--       client name   <- the lead's name (or "Lead 123" when the lead has none; the builder's Client card stays editable)
--       contact       <- the lead's name and phone
--       e-mail        <- the lead's e-mail (internal)
--       city          <- the lead's location (delivery_city)
--       project type  <- the lead's venue (hotel, resort, restaurant, cafe, other)
--       internal note <- "From lead 123 · <requirement>" (the first 800 characters)
--     A Dead lead is refused (reopen the lead first). The owner is the caller. data.owner_id puts it on somebody ELSE's page
--     (an Excel quotation the owner or the pricing desk received for a salesperson): only an administrator or the pricing desk
--     (edit + see all) may, and the person must be active and able to make quotations. The number carries the OWNER's initials.
--   quotation_makers() -> [{ id, full_name }]  administrator or pricing desk only: the people a quotation may be put on.
--
-- ADDITIVE: two new functions; no table, column, policy or data changes. quotation_create stays as it is until
-- 20270814000100_quotation_lead_required.sql (apply that one only after the code that calls quotation_start is live), so the code
-- and this migration can go out in this order without a gap. No backup is needed for this file.
--
-- ROLLBACK: drop function public.quotation_start(uuid, jsonb); drop function public.quotation_makers();

do $$
begin
  if to_regclass('public.sales_leads') is null
     or to_regprocedure('public.sales_lead_visible(uuid, uuid)') is null
     or to_regprocedure('public.quotation_actor()') is null
     or to_regprocedure('public.quotation_initials(uuid)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotations' and column_name = 'lead_id') then
    raise exception 'DEPENDENCY MISSING: sales_leads, sales_lead_visible, quotation_actor, quotation_initials and quotations.lead_id (20270811000000) must exist';
  end if;
end $$;

-- ─── Who may own a quotation ──────────────────────────────────────────────────────────────────────────────────
-- Internal: may this person OWN quotations (an active administrator, or an active person who may open Quotations and create or edit)?
create or replace function public.quotation_can_own(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = p_user and u.is_active and coalesce(u.is_deleted, false) = false
      and (u.role = 'admin'
           or (public.resolve_permission(u.id, 'quotations', 'view')
               and (public.resolve_permission(u.id, 'quotations', 'create') or public.resolve_permission(u.id, 'quotations', 'edit'))))
  )
$$;
revoke all on function public.quotation_can_own(uuid) from public, anon, authenticated;

create or replace function public.quotation_makers()
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if not (a.p_admin or (a.p_edit and a.p_view_all)) then
    raise exception 'QUOTATIONS_FORBIDDEN: only an administrator or the pricing desk may put a quotation on somebody''s page' using errcode = '42501';
  end if;
  return query
    select u.id, u.full_name from public.users u
    where public.quotation_can_own(u.id)
    order by (u.id = a.p_uid) desc, u.full_name;
end $$;
revoke all on function public.quotation_makers() from public, anon;
grant execute on function public.quotation_makers() to authenticated;

-- ─── Start from a lead ────────────────────────────────────────────────────────────────────────────────────────
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

  insert into public.quotations (quote_no, client_name, contact_name, contact_phone, client_email, delivery_city, project_type,
                                 internal_notes, gst_mode, source, lead_id, owner_id, created_by)
  values (v_no, left(v_name, 160), nullif(left(btrim(coalesce(l.name, '')), 120), ''), l.phone_e164, nullif(left(l.email, 160), ''),
          nullif(left(btrim(coalesce(l.location, '')), 80), ''), l.client_type, v_note, 'igst', v_src, l.id, v_owner, a.p_uid)
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

-- ─── Post-conditions ──────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.quotation_start(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.quotation_makers()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.quotation_can_own(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.quotation_start(uuid, jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.quotation_makers()', 'EXECUTE') then
    raise exception 'QUOTATION_START: quotation_start and quotation_makers must be callable by signed-in people only, and quotation_can_own by nobody';
  end if;
  if has_table_privilege('anon', 'public.quotations', 'SELECT') or has_table_privilege('authenticated', 'public.quotations', 'SELECT') then
    raise exception 'QUOTATION_START: public.quotations is open to a client role';
  end if;
end $$;
