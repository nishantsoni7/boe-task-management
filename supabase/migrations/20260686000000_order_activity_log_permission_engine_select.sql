-- Closes the read-access gap flagged (not fixed) by
-- 20260685000000_orders_permission_engine_select.sql: that migration let a
-- user with 'orders'/'view' access see every official Order row, but
-- order_activity_log kept its own, separate legacy SELECT policies (admin /
-- team='operations' / requester-or-assignee via a subquery on orders) with
-- no reference to the permission engine. A Test Sales User granted Order
-- Management view access can now see an Order's fields but its "Recent
-- Activity" timeline (src/app/orders/[id]/page.tsx, ~line 547) renders
-- empty for any order they didn't request/aren't assigned to.
--
-- Fix, additive only: one new PERMISSIVE SELECT policy, same shape as
-- orders_permission_engine_select. PERMISSIVE policies OR together, so this
-- can only ADD row visibility on top of the three existing SELECT policies
-- (order_activity_log_admin_select, order_activity_log_operations_select,
-- order_activity_log_sales_select) — none of which are touched, dropped, or
-- narrowed. The two existing INSERT policies (admin, operations) are
-- untouched and no INSERT/UPDATE/DELETE policy is added here — activity
-- rows stay written only by admin/operations app code (see
-- order_activity_log_admin_insert / order_activity_log_operations_insert in
-- 20260655_create_orders.sql), never by a plain 'orders' view grant.
--
-- Scope: this grants visibility into ALL activity rows for a user with
-- 'orders'/'view', not just rows for orders they own — deliberately, since
-- orders_permission_engine_select already grants that same population
-- visibility into every Order row. Restricting activity rows to a subset of
-- the Orders already visible to the same user would be a narrower rule than
-- the Orders table itself enforces, which isn't what was asked for.
--
-- resolve_permission() is the same SECURITY DEFINER resolver already used
-- for `orders` (20260685000000) and for sample_dispatches (20260665) — not
-- re-derived here. Its search_path remains unpinned, same pre-existing
-- characteristic noted in 20260685000000; not addressed in this migration
-- (shared function — a change there would also affect Sample Tracking).
--
-- Out of scope, reported not fixed: the Order detail page's other child
-- query, finance_payment_requests (linked payments), stays governed
-- entirely by existing Finance RLS (admin or submitted_by = self) —
-- Finance access is explicitly not to be broadened by this work.

CREATE POLICY "order_activity_log_permission_engine_select" ON public.order_activity_log
  FOR SELECT TO authenticated
  USING (
    resolve_permission(auth.uid(), 'orders', 'view')
  );
