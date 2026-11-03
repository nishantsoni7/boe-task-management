-- 20270529000000_sales_can_be_given_leads.sql
--
-- Sales: who can be given a lead is a choice per person, not only their job.
--
-- What the owner asked (2026-11-03): Nitish (a Manager, who reads every lead) and the dummy test account must not show in
-- the lead allocation lists. Until now anybody with a Sales job could be given a lead (20270527000000).
--   * Each person's job still decides by default: a Salesperson can be given leads; a Manager and a Lead manager cannot.
--   * Control Center, Access, Sales team can change that for one person: "Can be given leads", ticked or not. The choice
--     is kept in sales_lead_holding; no row means "what their job means".
--   * sales_lead_can_hold, the one place that decides, reads it, so the allot lists, Give to someone else, Move the due
--     leads and the import all follow. Leads somebody already holds stay with them: this only decides new allotments.
--
-- WRITE: set_sales_lead_holding only, Admin only. The new table carries no policy and no grant.
--
-- ROLLBACK: drop function public.set_sales_lead_holding(uuid, boolean); re-run the 20270527000000 definition of
--   sales_lead_can_hold and the 20270526000100 definition of list_sales_team; drop table public.sales_lead_holding.

-- ═══ 1. The choice, per person ═══════════════════════════════════════════════════════════════════════════════════

create table public.sales_lead_holding (
  user_id uuid primary key references public.users (id) on delete cascade,
  can_hold boolean not null,
  set_by uuid,
  set_at timestamptz not null default now()
);

alter table public.sales_lead_holding enable row level security;
revoke all on table public.sales_lead_holding from public, anon, authenticated;
grant all on table public.sales_lead_holding to service_role;

-- ═══ 2. The rule ═════════════════════════════════════════════════════════════════════════════════════════════════

-- Active, not an Admin account, a Sales job, and then the choice made for them, or else what the job means: a
-- Salesperson yes, a Manager (view_all) or a Lead manager (assign) no.
create or replace function public.sales_lead_can_hold(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.users u where u.id = p_uid and u.is_active and u.role <> 'admin')
     and public.resolve_permission(p_uid, 'sales', 'view')
     and coalesce(
       (select h.can_hold from public.sales_lead_holding h where h.user_id = p_uid),
       not (public.resolve_permission(p_uid, 'sales', 'view_all') or public.resolve_permission(p_uid, 'sales', 'assign'))
     );
$$;

-- Control Center, as in 20270526000100, with whether leads can be given to each person and the choice made for them.
create or replace function public.list_sales_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if not exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin' and u.is_active) then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id, 'name', u.full_name, 'is_admin', u.role = 'admin',
      'candidate', public.is_eligible_order_assignee(u.id),
      'view', public.resolve_permission(u.id, 'sales', 'view'),
      'view_all', public.resolve_permission(u.id, 'sales', 'view_all'),
      'create', public.resolve_permission(u.id, 'sales', 'create'),
      'edit', public.resolve_permission(u.id, 'sales', 'edit'),
      'assign', public.resolve_permission(u.id, 'sales', 'assign'),
      'juniors', coalesce((select jsonb_agg(a.subject_id) from public.sales_lead_access a where a.viewer_id = u.id), '[]'::jsonb),
      -- Whether leads can be given to them now, and the choice made for them (null: what their job means).
      'can_hold', public.sales_lead_can_hold(u.id),
      'hold_set', (select h.can_hold from public.sales_lead_holding h where h.user_id = u.id)
    ) order by u.full_name)
    from public.users u where u.is_active
  ), '[]'::jsonb);
end;
$$;
-- ═══ 3. Admin sets it ════════════════════════════════════════════════════════════════════════════════════════════

-- p_can_hold true or false keeps that choice; null goes back to what the person's job means.
create function public.set_sales_lead_holding(p_user uuid, p_can_hold boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if not exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin' and u.is_active) then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user) then raise exception 'SALES_NOT_FOUND'; end if;
  if p_can_hold is null then
    delete from public.sales_lead_holding h where h.user_id = p_user;
  else
    insert into public.sales_lead_holding (user_id, can_hold, set_by, set_at) values (p_user, p_can_hold, v_uid, now())
    on conflict (user_id) do update set can_hold = excluded.can_hold, set_by = excluded.set_by, set_at = excluded.set_at;
  end if;
  return jsonb_build_object('status', 'saved', 'can_hold', public.sales_lead_can_hold(p_user));
end;
$$;

-- ═══ 4. Who may call what ════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_lead_can_hold(uuid) from public, anon, authenticated;
revoke all on function public.set_sales_lead_holding(uuid, boolean) from public, anon;
grant execute on function public.set_sales_lead_holding(uuid, boolean) to authenticated;

-- ═══ 5. Self-checks ══════════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.sales_lead_holding'::regclass) then
    raise exception 'SALES_CAN_HOLD: row level security must be on for sales_lead_holding';
  end if;
  if has_table_privilege('authenticated', 'public.sales_lead_holding', 'SELECT')
     or has_table_privilege('authenticated', 'public.sales_lead_holding', 'INSERT') then
    raise exception 'SALES_CAN_HOLD: a browser must not reach sales_lead_holding';
  end if;
  if has_function_privilege('authenticated', 'public.sales_lead_can_hold(uuid)', 'EXECUTE') then
    raise exception 'SALES_CAN_HOLD: sales_lead_can_hold is internal';
  end if;
  if has_function_privilege('anon', 'public.set_sales_lead_holding(uuid, boolean)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.set_sales_lead_holding(uuid, boolean)', 'EXECUTE') then
    raise exception 'SALES_CAN_HOLD: set_sales_lead_holding must be for signed-in users only (it checks Admin itself)';
  end if;
  if has_function_privilege('anon', 'public.list_sales_team()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.list_sales_team()', 'EXECUTE') then
    raise exception 'SALES_CAN_HOLD: list_sales_team lost its grant';
  end if;
end $$;
