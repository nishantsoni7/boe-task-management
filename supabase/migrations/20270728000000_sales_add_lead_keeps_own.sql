-- 20270728000000_sales_add_lead_keeps_own.sql
--
-- Sales, Lead Master: a lead a salesperson adds themselves is theirs (owner, 2026-11-16: "when a salesperson adds its own
-- new lead from Lead Master, it should automatically get assigned to him. Currently it is not happening").
--
--   * create_sales_lead saved every new lead NOT allotted. Only somebody with the Assign right can allot, and a
--     salesperson has not got it, so a lead they typed in themselves sat in the Not allotted queue.
--   * Now the person who adds the lead keeps it when they work leads themselves:
--       - a SALESPERSON: an active, non-Admin person with Sales View who has neither View all nor Assign (a Manager and a
--         Lead manager have one of those), whatever the "Can be given leads" tick says (the dummy test account is
--         unticked and must still keep what it adds); or
--       - anybody ticked "Can be given leads" (sales_lead_can_hold: a Manager or Lead manager who also sells, an Admin).
--     A person with only Create (no View) cannot see a lead they hold, so they never keep one. An Admin who is not
--     ticked, a Manager and a Lead manager who are not ticked add a lead that stays Not allotted, as before.
--   * A kept lead is given in the same insert: holder, assigned_at, assigned_by = the adder, first step "First call"
--     due today (the open-lead CHECK needs both), and an "allotted" line in its history after the "added" line. Nobody
--     is notified: the holder is the person adding it.
--   * Everything else in the function is as in 20270524000000: the duplicate look first, the conflict clause for two
--     people adding one number at once, the same answer shape.
--
-- WRITE: nothing at apply time. This only re-issues one function (same signature, so the grants stay): no table, column,
--   constraint or data changes. Leads already added stay as they are. A same-day verified backup is enough.
--
-- ROLLBACK: re-run the 20270524000000 definition of public.create_sales_lead(text, text, text, text, text, text).
--   Leads already kept by the person who added them stay with them.

create or replace function public.create_sales_lead(
  p_phone text,
  p_source text,
  p_name text default null,
  p_email text default null,
  p_location text default null,
  p_requirement text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('create');
  v_phone text := public.normalize_lead_phone(p_phone);
  v_row public.sales_leads;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_keeps boolean;
begin
  if v_phone is null then raise exception 'SALES_INVALID: Enter a valid mobile number'; end if;

  -- Does the person adding it work leads themselves? (see the header)
  v_keeps := public.sales_lead_can_hold(v_uid)
    or (
      exists (select 1 from public.users u where u.id = v_uid and u.is_active and u.role <> 'admin')
      and public.resolve_permission(v_uid, 'sales', 'view')
      and not public.resolve_permission(v_uid, 'sales', 'view_all')
      and not public.resolve_permission(v_uid, 'sales', 'assign')
    );

  -- Look first: an INSERT ... ON CONFLICT draws a lead number before it finds the conflict, so every duplicate
  -- would leave a gap in the numbers people say aloud. The conflict clause below is only for two people adding
  -- the same new number in the same instant.
  select * into v_row from public.sales_leads where phone_e164 = v_phone;
  if v_row.id is not null then
    return jsonb_build_object('status', 'duplicate', 'lead', public.sales_lead_json(v_row));
  end if;

  insert into public.sales_leads (phone_e164, source, name, email, location, requirement, created_by,
                                  assigned_to, assigned_at, assigned_by, next_step, next_due_on)
  values (v_phone, p_source, nullif(btrim(p_name), ''), lower(nullif(btrim(p_email), '')),
          nullif(btrim(p_location), ''), nullif(btrim(p_requirement), ''), v_uid,
          case when v_keeps then v_uid end, case when v_keeps then now() end, case when v_keeps then v_uid end,
          case when v_keeps then 'First call' end, case when v_keeps then v_today end)
  on conflict (phone_e164) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.sales_leads where phone_e164 = v_phone;
    return jsonb_build_object('status', 'duplicate', 'lead', public.sales_lead_json(v_row));
  end if;

  insert into public.sales_lead_events (lead_id, kind, actor) values (v_row.id, 'added', v_uid);
  -- clock_timestamp: after the "added" line written in the same transaction, so the history reads in order.
  if v_keeps then
    insert into public.sales_lead_events (lead_id, kind, to_user, actor, at)
    values (v_row.id, 'allotted', v_uid, v_uid, clock_timestamp());
  end if;
  return jsonb_build_object('status', 'created', 'lead', public.sales_lead_json(v_row));
exception
  when check_violation then
    raise exception 'SALES_INVALID: Check the details and try again.';
end;
$$;

-- Same grants as before (create or replace keeps them); checked anyway.
do $$
declare v_def text := pg_get_functiondef('public.create_sales_lead(text, text, text, text, text, text)'::regprocedure);
begin
  if position('''First call''' in v_def) = 0 or position('v_keeps' in v_def) = 0 then
    raise exception 'SALES_ADD_KEEPS: create_sales_lead does not give a lead to the person who adds it';
  end if;
  if has_function_privilege('anon', 'public.create_sales_lead(text, text, text, text, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.create_sales_lead(text, text, text, text, text, text)', 'EXECUTE') then
    raise exception 'SALES_ADD_KEEPS: create_sales_lead lost or gained a grant';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.create_sales_lead(text, text, text, text, text, text)'::regprocedure) then
    raise exception 'SALES_ADD_KEEPS: create_sales_lead must stay security definer';
  end if;
end $$;
