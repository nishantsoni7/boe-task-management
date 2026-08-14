-- Protected visibility actions — quotations, global Orders, global Finance.
--
-- Forward-only. 20260901000000 and 20260902000000 are applied and are NOT
-- touched here.
--
-- WHY THIS EXISTS
-- ---------------
-- Production testing found that `orders.view` does not mean what Access Control
-- says it means. 20260685000000 and 20260686000000 each added a PERMISSIVE
-- SELECT policy of the form
--
--     USING (resolve_permission(auth.uid(), 'orders', 'view'))
--
-- so ANY employee granted Order Management entry could read EVERY order in the
-- company, and every order's activity log. Those two migrations were fixing a
-- real defect at the time — a granted employee saw zero rows — but they fixed it
-- by opening the whole table rather than by adding an entry permission. Module
-- ENTRY and company-wide SIGHT are two different decisions and this migration
-- separates them.
--
-- Finance never had that shape: its SELECT policies are ownership-based
-- (20260628000200, 20260674, 20260699000000, 20260707000000). So the Finance
-- half of this migration is purely ADDITIVE, while the Orders half is a
-- NARROWING. Anyone holding `orders.view` today and not `orders.view_all`
-- loses company-wide sight and falls back to the three legacy ownership
-- policies from 20260655_create_orders.sql — admin, operations team, and
-- requester/assignee. That is the intended correction, and there are
-- deliberately NO compatibility grants for ordinary employees.
--
-- WHAT IT DOES
-- ------------
--   1. Registers three protected actions, all deny-by-default:
--        task_management.view_quotations
--        task_management.manage_quotations
--        orders.view_all  /  finance.view_all   (one action key, two modules)
--   2. Repoints the two blanket Orders SELECT policies at `view_all`.
--   3. Adds global Finance SELECT policies gated on `view_all`.
--
-- WHAT IT DOES NOT DO
-- -------------------
--   * It does not hide quotation task ROWS. A quotation request is assigned
--     work, and hiding the row would take an assignee's own task away from
--     them. Quotation gating is UI/route/API-enforced; see the limitation noted
--     in docs/Module Docs/ACCESS_CONTROL_V1.md. `view_quotations` is registered
--     and resolvable here so those layers have one authority to ask.
--   * It grants nothing to anybody. Every action is default_allowed = false and
--     no employee_permission_overrides or role_permissions row is written.
--   * It does not touch Attendance, Payroll, Meetings, Assets or Sample
--     Tracking, and it does not alter any function created by 20260901000000.
--   * It does not change INSERT/UPDATE/DELETE authorization anywhere. Edit
--     rules stay exactly where they are.
--
-- ADMIN AND FAIL-CLOSED
-- ---------------------
-- System Admin authority is unchanged: the legacy `orders_admin_select` policy
-- and `users.role = 'admin'` branches are untouched, so an admin keeps full
-- sight without needing either new action. Inactive and soft-deleted accounts
-- remain fail-closed through the existing actor_has_permission gate
-- (20260901000000) — nothing here weakens it.

-- ─── 1. Register the three protected actions ─────────────────────────────────
--
-- Mirrors src/lib/permissions/modules.ts, which is updated in the same change
-- so `npm run permissions:check` stays in sync. is_system = false: these are
-- custom actions, like can_be_order_assignee (20260697000000) and assets
-- `assign` (20260725000000).

insert into public.permission_actions (action_key, display_name, is_system)
values
  ('view_quotations',   'View Quotations & Prices', false),
  ('manage_quotations', 'Manage Quotations',        false),
  ('view_all',          'View All Records',         false)
on conflict (action_key) do nothing;

-- Quotation actions belong to Task Management. NOTE: the module_key is
-- 'task_management', not 'tasks'.
insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa
  on pa.action_key in ('view_quotations', 'manage_quotations')
where pm.module_key = 'task_management'
on conflict (module_id, action_id) do nothing;

-- One `view_all` action key, registered against BOTH Orders and Finance. The
-- engine scopes a grant by (module_id, action_id), so orders.view_all and
-- finance.view_all are independent rows that can never be granted as one.
insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view_all'
where pm.module_key in ('orders', 'finance')
on conflict (module_id, action_id) do nothing;

-- ─── 2. Orders — separate entry from company-wide sight ──────────────────────
--
-- Replaced rather than dropped: the policy NAME is kept so anyone reading
-- pg_policies sees one orders-permission-engine rule, not a retired one beside
-- a new one. PERMISSIVE policies OR together, so the three legacy ownership
-- policies continue to grant exactly what they granted before — this only
-- removes the company-wide branch for employees without `view_all`.

drop policy if exists "orders_permission_engine_select" on public.orders;

create policy "orders_permission_engine_select" on public.orders
  for select to authenticated
  using (
    resolve_permission(auth.uid(), 'orders', 'view_all')
  );

comment on policy "orders_permission_engine_select" on public.orders is
  'Company-wide order sight. Requires the protected orders.view_all action; orders.view alone grants module entry only, never every row.';

drop policy if exists "order_activity_log_permission_engine_select" on public.order_activity_log;

create policy "order_activity_log_permission_engine_select" on public.order_activity_log
  for select to authenticated
  using (
    resolve_permission(auth.uid(), 'orders', 'view_all')
  );

comment on policy "order_activity_log_permission_engine_select" on public.order_activity_log is
  'Company-wide order activity sight. Requires orders.view_all, matching the orders table policy.';

-- ─── 3. Finance — add global sight, additively ───────────────────────────────
--
-- New policies, no existing Finance policy touched. Someone without
-- `finance.view_all` keeps exactly the ownership-scoped visibility they have
-- today; someone with it sees every payment request and its activity.
--
-- Deliberately SELECT only. finance.view_all must not imply create, edit,
-- approve, manage, delete or export — those stay on their own actions, decided
-- by 20260901000000.

create policy "finance_payment_requests_view_all_select" on public.finance_payment_requests
  for select to authenticated
  using (
    resolve_permission(auth.uid(), 'finance', 'view_all')
  );

comment on policy "finance_payment_requests_view_all_select" on public.finance_payment_requests is
  'Company-wide payment sight. Requires the protected finance.view_all action. SELECT only — it confers no mutation authority.';

create policy "finance_payment_request_activity_log_view_all_select" on public.finance_payment_request_activity_log
  for select to authenticated
  using (
    resolve_permission(auth.uid(), 'finance', 'view_all')
  );

comment on policy "finance_payment_request_activity_log_view_all_select" on public.finance_payment_request_activity_log is
  'Company-wide payment activity sight. Requires finance.view_all, matching the payment requests policy.';

-- ─── 4. Post-conditions ──────────────────────────────────────────────────────

do $$
declare
  v_count int;
begin
  -- 4a. All four module/action registrations landed.
  select count(*) into v_count
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  join public.permission_actions  pa on pa.id = mpa.action_id
  where (pm.module_key = 'task_management' and pa.action_key in ('view_quotations', 'manage_quotations'))
     or (pm.module_key in ('orders', 'finance') and pa.action_key = 'view_all');

  if v_count <> 4 then
    raise exception 'PROTECTED_VISIBILITY: expected 4 module/action registrations, found %', v_count;
  end if;

  -- 4b. Every one of them is deny-by-default.
  select count(*) into v_count
  from public.module_permission_actions mpa
  join public.permission_actions pa on pa.id = mpa.action_id
  where pa.action_key in ('view_quotations', 'manage_quotations', 'view_all')
    and mpa.default_allowed;

  if v_count <> 0 then
    raise exception 'PROTECTED_VISIBILITY: % new action(s) are allowed by default', v_count;
  end if;

  -- 4c. Nobody has been granted any of them. This migration registers
  --     authority; it never hands it out.
  select count(*) into v_count
  from public.employee_permission_overrides eo
  join public.permission_actions pa on pa.id = eo.action_id
  where pa.action_key in ('view_quotations', 'manage_quotations', 'view_all')
    and eo.allowed and eo.revoked_at is null;

  if v_count <> 0 then
    raise exception 'PROTECTED_VISIBILITY: % employee override(s) already grant a new action', v_count;
  end if;

  -- 4d. No ROLE default grants them either — that is what would quietly
  --     re-open company-wide sight to a whole role.
  select count(*) into v_count
  from public.role_permissions rp
  join public.permission_actions pa on pa.id = rp.action_id
  where pa.action_key in ('view_quotations', 'manage_quotations', 'view_all')
    and rp.allowed;

  if v_count <> 0 then
    raise exception 'PROTECTED_VISIBILITY: % role default(s) grant a new action', v_count;
  end if;
end $$;

-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--
-- To restore the previous behaviour exactly:
--
--   drop policy if exists "finance_payment_request_activity_log_view_all_select"
--     on public.finance_payment_request_activity_log;
--   drop policy if exists "finance_payment_requests_view_all_select"
--     on public.finance_payment_requests;
--
--   drop policy if exists "orders_permission_engine_select" on public.orders;
--   create policy "orders_permission_engine_select" on public.orders
--     for select to authenticated
--     using (resolve_permission(auth.uid(), 'orders', 'view'));
--
--   drop policy if exists "order_activity_log_permission_engine_select"
--     on public.order_activity_log;
--   create policy "order_activity_log_permission_engine_select"
--     on public.order_activity_log
--     for select to authenticated
--     using (resolve_permission(auth.uid(), 'orders', 'view'));
--
-- The three action registrations may be left in place: they grant nothing on
-- their own. Removing them would require deleting the module_permission_actions
-- rows first, then the permission_actions rows.
