-- Fixes a production visibility defect introduced by
-- 20260684000000_register_orders_permission_module.sql: an employee granted
-- Order Management ('orders','view') access through Control Center ->
-- Access Control could now open the module (route guard in
-- src/app/orders/layout.tsx + the /modules launcher card check this
-- permission), but the `orders` table itself was still governed only by
-- the pre-existing, narrower legacy RLS from 20260655_create_orders.sql:
--   - orders_admin_select      (role = 'admin')
--   - orders_operations_select (team = 'operations')
--   - orders_sales_select      (requested_by = auth.uid() OR assigned_to = auth.uid())
-- None of those reference the permission engine. A user granted 'orders'
-- access who is not admin/operations and not the requester/assignee of any
-- row (e.g. the Test Sales User in this defect report) saw zero rows and
-- zero dashboard totals despite having "access" at the app-code layer.
--
-- Fix, additive only: one new PERMISSIVE SELECT policy. PERMISSIVE
-- policies OR together, so this can only ever ADD row visibility on top of
-- the three existing SELECT policies above — none of which are touched,
-- dropped, or narrowed. INSERT/UPDATE/DELETE policies (orders_admin_insert,
-- orders_sales_insert, orders_admin_update, orders_operations_update,
-- orders_admin_delete) are untouched, so create/edit/status-change/delete
-- authorization is unchanged; conversion (convert_order_request_to_order)
-- and Finance payment-linking are separate SECURITY DEFINER RPCs that
-- authorize internally and are unaffected by SELECT policy changes here.
--
-- resolve_permission(p_user_id, p_module_key, p_action_key) is the same
-- SECURITY DEFINER resolver already used inside RLS for sample_dispatches
-- (see 20260665_cutover_sample_tracking_rls_to_resolver.sql) — reused here
-- rather than re-deriving the employee_override > department > role >
-- system_default precedence a second time. It takes an explicit p_user_id
-- (not auth.uid() internally) and, being SECURITY DEFINER, reads
-- users/permission_modules/role_permissions/department_permissions/
-- employee_permission_overrides as the function owner, bypassing their own
-- RLS — none of those tables reference `orders`, so this introduces no
-- recursion. Its proconfig has no pinned search_path (same as when it was
-- first introduced in 20260660 and already used unpinned in 20260665) —
-- pre-existing characteristic, not changed here.
--
-- A user with no 'orders' grant (system_default deny) who is also not
-- admin/operations/requester/assignee still matches zero SELECT policies
-- and gets zero rows, from the app, from direct PostgREST, and by guessing
-- a detail URL — RLS is default-deny per row when no policy matches.

CREATE POLICY "orders_permission_engine_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    resolve_permission(auth.uid(), 'orders', 'view')
  );
