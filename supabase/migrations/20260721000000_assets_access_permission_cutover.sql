-- Assets & Access — authorization cutover to the centralized permission engine.
--
-- Before this migration every write policy on assets/employee_assets was a
-- hardcoded users.role = 'admin' check (20260640, 20260641), so managers had
-- no asset authority at all and the only way to give them any would have been
-- another role literal. This replaces those checks with
-- resolve_permission(auth.uid(), 'assets_access', '<action>'), the same
-- resolver Sample Tracking was cut over to in 20260665, so Assets & Access is
-- now administered from Control Center → Access Control instead of from code.
--
-- Precedence is the engine's: Employee Override > Department > Role > System
-- Default. Admins keep an explicit role literal in every policy (matching
-- 20260665 and src/app/orders/layout.tsx) so an engine misconfiguration can
-- never lock admins out of their own inventory.
--
-- Action mapping — the UI half of this lives in
-- src/lib/permissions/assetsAccess.ts and must keep saying the same thing:
--   view    → read the whole inventory and who currently holds each asset
--   create  → add assets
--   edit    → change asset master details
--   delete  → permanently remove an asset
--   manage  → assign / mark returned / mark lost (writes to employee_assets)
-- All five were already registered for 'assets_access' by 20260660; no new
-- action or module is introduced here, so scripts/sync-permissions.ts stays
-- in sync without a registry change.
--
-- NOT in scope:
--   - access_records keeps its admin-only policies untouched. Its
--     secret_value column is still plaintext (see the security note in
--     20260640), so widening read access to managers would hand them every
--     stored password. That waits for the credential-storage rework.
--   - Employee self-service is untouched: assets_select_all,
--     employee_assets_own_select and employee_assets_own_accept are not
--     dropped or modified by this migration.
--   - Independent of Phase 3G. This module never used the legacy
--     employee_permissions / has_permission() path, so nothing here depends
--     on that retirement (see PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md §7).
--
-- Rollback: a forward migration restoring the five original policies verbatim
-- from 20260640 (assets_admin_insert, assets_admin_update,
-- employee_assets_admin_select/insert/update) and 20260641
-- (assets_admin_delete), plus a DELETE of the manager role_permissions rows
-- seeded in section 3.

-- ─── 1. assets ─────────────────────────────────────────────────────────────
-- Policies are renamed off the "admin" prefix because they are no longer
-- admin-only. Read stays open to all authenticated users, unchanged.

DROP POLICY IF EXISTS "assets_admin_insert" ON public.assets;

CREATE POLICY "assets_insert" ON public.assets
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'create')
  );

-- 'manage' is accepted here as well as 'edit': assigning, returning and
-- losing an asset all write assets.status alongside the employee_assets row,
-- so a manage-only grant would otherwise be a half-permission that fails at
-- the second statement. Editing master details still requires 'edit'; that
-- distinction is enforced in the UI, which is where the two flows diverge.
DROP POLICY IF EXISTS "assets_admin_update" ON public.assets;

CREATE POLICY "assets_update" ON public.assets
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'edit')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'manage')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'edit')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'manage')
  );

DROP POLICY IF EXISTS "assets_admin_delete" ON public.assets;

CREATE POLICY "assets_delete" ON public.assets
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'delete')
  );

-- ─── 2. employee_assets ────────────────────────────────────────────────────
-- Read is 'view' or 'manage' so a view-only grant still shows the current
-- custodian of each asset — an inventory that cannot name who holds what is
-- not usable. Writes require 'manage'.

DROP POLICY IF EXISTS "employee_assets_admin_select" ON public.employee_assets;

CREATE POLICY "employee_assets_manage_select" ON public.employee_assets
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'view')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'manage')
  );

DROP POLICY IF EXISTS "employee_assets_admin_insert" ON public.employee_assets;

CREATE POLICY "employee_assets_manage_insert" ON public.employee_assets
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'manage')
  );

DROP POLICY IF EXISTS "employee_assets_admin_update" ON public.employee_assets;

CREATE POLICY "employee_assets_manage_update" ON public.employee_assets
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'manage')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'manage')
  );

-- ─── 3. Manager role defaults ──────────────────────────────────────────────
-- Role level (2 of 4), so this is a default, not a ceiling: a department
-- grant or an employee override can still add or remove any of these for an
-- individual without touching code.
--
-- 'delete' is deliberately withheld. employee_assets.asset_id is
-- ON DELETE CASCADE (20260640), so deleting an asset destroys its entire
-- custody and acceptance history — that stays an admin decision.
--
-- Idempotent: re-running grants nothing new and never flips an existing row
-- (including a deliberate role-level deny) back to true.

INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'manager', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id
JOIN public.permission_actions   pa ON pa.id = mpa.action_id
WHERE pm.module_key = 'assets_access'
  AND pa.action_key IN ('view', 'create', 'edit', 'manage')
ON CONFLICT (role, module_id, action_id) DO NOTHING;
