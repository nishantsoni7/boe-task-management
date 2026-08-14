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

-- ─── 3b. Orders — extend view_all to the operational child records ───────────
--
-- ADDITIVE. Every policy below is a NEW permissive policy beside the existing
-- ownership ones, which are not dropped, renamed or narrowed. PERMISSIVE
-- policies OR together, so an employee without view_all keeps exactly the
-- requester/creator/assignee/participant visibility they have today.
--
-- Audited surface — every table carrying operational order data. Confirmed by
-- reading each table's existing SELECT policies: all four are ownership-scoped
-- with no permission-engine branch, so before this section `orders.view_all`
-- would have shown all orders while their requests, activity, attachments and
-- amendments stayed invisible.
--
-- Deliberately SELECT only, and deliberately NOT extended to any Finance
-- table. An order request's linked payments live in finance_payment_requests
-- and payment_proof_attachments, which resolve 'finance' and are handled in
-- section 3c. orders.view_all cannot reach them.

create policy "order_requests_view_all_select" on public.order_requests
  for select to authenticated
  using (resolve_permission(auth.uid(), 'orders', 'view_all'));

comment on policy "order_requests_view_all_select" on public.order_requests is
  'Company-wide order request sight. Requires orders.view_all. SELECT only — order_requests has no UPDATE policy for any role by design.';

create policy "order_request_activity_view_all_select" on public.order_request_activity
  for select to authenticated
  using (resolve_permission(auth.uid(), 'orders', 'view_all'));

comment on policy "order_request_activity_view_all_select" on public.order_request_activity is
  'Company-wide order request activity sight. Requires orders.view_all.';

create policy "order_request_attachments_view_all_select" on public.order_request_attachments
  for select to authenticated
  using (resolve_permission(auth.uid(), 'orders', 'view_all'));

comment on policy "order_request_attachments_view_all_select" on public.order_request_attachments is
  'Company-wide order request attachment sight. Requires orders.view_all. These are operational documents (PI, reference files), not payment proofs — payment proofs are gated on finance.view_all.';

create policy "order_change_requests_view_all_select" on public.order_change_requests
  for select to authenticated
  using (resolve_permission(auth.uid(), 'orders', 'view_all'));

comment on policy "order_change_requests_view_all_select" on public.order_change_requests is
  'Company-wide amendment sight. Requires orders.view_all. Amending an order still requires orders.manage through assert_order_amender (20260901000000), which this does not touch.';

-- ─── 3c. Finance — supporting documents ──────────────────────────────────────
--
-- payment_proof_attachments is the third Finance surface. Sections 3 covered
-- the payment facts and the activity; without this an employee with
-- finance.view_all would see every payment and every note about it, but not
-- the proof of payment attached to it.

create policy "payment_proof_attachments_view_all_select" on public.payment_proof_attachments
  for select to authenticated
  using (resolve_permission(auth.uid(), 'finance', 'view_all'));

comment on policy "payment_proof_attachments_view_all_select" on public.payment_proof_attachments is
  'Company-wide payment proof sight. Requires finance.view_all — NOT orders.view_all, so company-wide order sight never reaches a payment document.';

-- ─── 3d. Task attachments — close a global read ──────────────────────────────
--
-- PRODUCTION-OBSERVED DEFECT. task_attachments carried
--
--     create policy "task_attachments_read" ... using (true)
--
-- so every authenticated account could read every attachment on every task in
-- the company — including files on quotation requests — regardless of whether
-- it could read the parent task. The comment in 20260619 explains the original
-- reasoning ("bucket is already public"), which is not an access-control
-- argument: a guessable storage URL being weak is a reason to fix the bucket,
-- not a reason to publish the index of every file.
--
-- The replacement mirrors the parent task boundary EXACTLY, as observed in
-- production on 2026-08-14:
--
--     auth.uid() = created_by OR auth.uid() = assigned_to OR auth.uid() = delegated_by
--
-- TWO PARENTS. task_attachments has both task_id and activity_log_id, with a
-- CHECK that at least one is set (20260619). A policy keyed only on task_id
-- would silently hide every attachment posted against an activity-log entry, so
-- both paths are authorized, the second by joining through
-- task_activity_log.task_id.
--
-- NO ADMIN BRANCH, deliberately. The production `tasks` SELECT policy has no
-- admin branch either: a System Admin has no company-wide task read through
-- RLS today. Adding one here would GRANT NEW authority — attachment sight for
-- tasks whose rows the admin cannot select — and would leave the child broader
-- than its parent, which is the exact defect being fixed. Admins keep every
-- attachment on every task they created, were assigned, or delegated, and admin
-- task tooling that needs more already runs with the service role. This removes
-- no access an admin legitimately has: it removes access nobody should have
-- had.
--
-- INSERT and DELETE are untouched: task_attachments_insert (created_by =
-- auth.uid()) and task_attachments_delete (created_by = auth.uid()) still
-- decide writes exactly as before.
--
-- Note: the EXISTS subqueries are themselves subject to the `tasks` RLS policy
-- for the calling user, so this is belt-and-braces — the ownership test is
-- written explicitly rather than relying on that behaviour.

drop policy if exists "task_attachments_read" on public.task_attachments;

create policy "task_attachments_read" on public.task_attachments
  for select to authenticated
  using (
    exists (
      select 1
      from public.tasks t
      where t.id = task_attachments.task_id
        and (
          auth.uid() = t.created_by
          or auth.uid() = t.assigned_to
          or auth.uid() = t.delegated_by
        )
    )
    or exists (
      select 1
      from public.task_activity_log l
      join public.tasks t on t.id = l.task_id
      where l.id = task_attachments.activity_log_id
        and (
          auth.uid() = t.created_by
          or auth.uid() = t.assigned_to
          or auth.uid() = t.delegated_by
        )
    )
  );

comment on policy "task_attachments_read" on public.task_attachments is
  'An attachment is readable only by someone who may read its parent task — created_by, assigned_to or delegated_by — resolved through task_id or through task_activity_log.task_id. Replaces a USING (true) policy that published every attachment in the company. task_management.view does NOT widen this.';

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

  -- 4e. Every view_all policy this migration is responsible for exists. Named
  --     individually so a dropped or renamed one fails loudly rather than
  --     leaving a table quietly outside the boundary.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and policyname in (
      'orders_permission_engine_select',
      'order_activity_log_permission_engine_select',
      'order_requests_view_all_select',
      'order_request_activity_view_all_select',
      'order_request_attachments_view_all_select',
      'order_change_requests_view_all_select',
      'finance_payment_requests_view_all_select',
      'finance_payment_request_activity_log_view_all_select',
      'payment_proof_attachments_view_all_select'
    );

  if v_count <> 9 then
    raise exception 'PROTECTED_VISIBILITY: expected 9 view_all policies, found %', v_count;
  end if;

  -- 4f. No Orders policy resolves plain 'view' for company-wide sight any more.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('orders', 'order_activity_log')
    and qual like '%''orders''::text, ''view''::text%';

  if v_count <> 0 then
    raise exception 'PROTECTED_VISIBILITY: % Orders policy(ies) still grant company-wide sight from plain view', v_count;
  end if;

  -- 4g. No Orders policy reaches a Finance table, and no Finance policy is
  --     satisfied by an Orders grant. This is the separation the owner asked
  --     to be proved rather than asserted.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('finance_payment_requests', 'finance_payment_request_activity_log', 'payment_proof_attachments')
    and qual like '%''orders''%';

  if v_count <> 0 then
    raise exception 'PROTECTED_VISIBILITY: % Finance policy(ies) can be satisfied by an Orders grant', v_count;
  end if;

  -- 4h. The task attachment global read is gone. A USING (true) policy stores
  --     qual as NULL, so this catches exactly the shape being replaced.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'task_attachments'
    and cmd in ('SELECT', 'ALL')
    and (qual is null or btrim(qual) = 'true');

  if v_count <> 0 then
    raise exception 'PROTECTED_VISIBILITY: task_attachments still has % globally-readable SELECT policy(ies)', v_count;
  end if;

  -- 4i. And the replacement really is scoped to the parent task.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'task_attachments'
    and policyname = 'task_attachments_read'
    and qual like '%assigned_to%'
    and qual like '%delegated_by%';

  if v_count <> 1 then
    raise exception 'PROTECTED_VISIBILITY: task_attachments_read is not scoped to the parent task';
  end if;

  -- 4j. Task attachment WRITE authority is untouched.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'task_attachments'
    and policyname in ('task_attachments_insert', 'task_attachments_delete');

  if v_count <> 2 then
    raise exception 'PROTECTED_VISIBILITY: task attachment write policies changed (found %)', v_count;
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
--   drop policy if exists "order_requests_view_all_select"            on public.order_requests;
--   drop policy if exists "order_request_activity_view_all_select"    on public.order_request_activity;
--   drop policy if exists "order_request_attachments_view_all_select" on public.order_request_attachments;
--   drop policy if exists "order_change_requests_view_all_select"     on public.order_change_requests;
--   drop policy if exists "payment_proof_attachments_view_all_select" on public.payment_proof_attachments;
--
--   -- Restoring the task attachment global read. Do this ONLY as part of a
--   -- deliberate rollback: it re-publishes every task attachment in the company.
--   drop policy if exists "task_attachments_read" on public.task_attachments;
--   create policy "task_attachments_read" on public.task_attachments
--     for select to authenticated using (true);
--
-- The three action registrations may be left in place: they grant nothing on
-- their own. Removing them would require deleting the module_permission_actions
-- rows first, then the permission_actions rows.
