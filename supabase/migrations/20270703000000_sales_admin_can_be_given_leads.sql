-- 20270703000000_sales_admin_can_be_given_leads.sql
--
-- Sales: an Admin can be given leads, when somebody ticks it for them.
--
-- What the owner asked (2026-11-13, a screenshot of Control Center > Sales team where their own row only said "Admin:
-- everything"): "Option to give leads to admin (me also should be there)".
--   * sales_lead_can_hold, the one place that decides who can be given a lead, refused every Admin account
--     (`u.role <> 'admin'`, 20270529000000). Now an Admin counts only when the "Can be given leads" choice for them
--     (sales_lead_holding) is true. No choice, or false, is what it was: an Admin is never given a lead by accident.
--   * A person who is not an Admin is decided exactly as before (a Sales job, then the choice, then what the job means).
--   * Every list that reads this function follows: Allot to, Give to someone else, the import, the automatic allotment
--     (an Admin is Manual only until a level is chosen) and the alerts. An Admin already sees and works every lead, so
--     nothing else changes for them.
--
-- WRITE: nothing. This only re-issues one read-only function: no table, column or constraint changes.
--
-- ROLLBACK: re-run the 20270529000000 definition of public.sales_lead_can_hold(uuid). Leads already given to an Admin
--   stay with them (the Admin still reads and works them).

create or replace function public.sales_lead_can_hold(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    -- An Admin has no Sales job to read; the tick is the whole answer, and no tick is "no".
    when exists (select 1 from public.users u where u.id = p_uid and u.is_active and u.role = 'admin') then
      coalesce((select h.can_hold from public.sales_lead_holding h where h.user_id = p_uid), false)
    -- Everybody else: active, a Sales job, then the choice made for them, or else what the job means: a Salesperson
    -- yes, a Manager (view_all) or a Lead manager (assign) no.
    else
      exists (select 1 from public.users u where u.id = p_uid and u.is_active)
      and public.resolve_permission(p_uid, 'sales', 'view')
      and coalesce(
        (select h.can_hold from public.sales_lead_holding h where h.user_id = p_uid),
        not (public.resolve_permission(p_uid, 'sales', 'view_all') or public.resolve_permission(p_uid, 'sales', 'assign'))
      )
  end;
$$;

-- Same grants as before: internal, never called from a browser.
revoke all on function public.sales_lead_can_hold(uuid) from public, anon, authenticated;

do $$
begin
  if has_function_privilege('authenticated', 'public.sales_lead_can_hold(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.sales_lead_can_hold(uuid)', 'EXECUTE') then
    raise exception 'SALES_ADMIN_HOLD: sales_lead_can_hold is internal';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.sales_lead_can_hold(uuid)'::regprocedure) then
    raise exception 'SALES_ADMIN_HOLD: sales_lead_can_hold must stay security definer';
  end if;
end $$;
