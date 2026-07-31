-- Assets & Access — permission model correction and custody authorization.
--
-- Runs immediately after 20260721000000 (the RLS cutover) and 20260722000000
-- (custody integrity), in the same push, and corrects both the grants that
-- migration seeded and the grants that pre-dated it.
--
-- Required end state, and what resolve_effective_permissions must return:
--
--   Nishant (admin)         view create edit delete manage   (role, unchanged)
--   Aditya                  view create                      (override)
--   Dhruv (manager)         view                             (system default)
--   every other employee    view                             (system default)
--
-- Two separate problems are corrected here:
--
--   1. 20260721000000 §3 seeds role_permissions for 'manager'
--      (view/create/edit/manage). Being a manager must not confer Asset
--      Inventory control — asset authority is granted per employee in Control
--      Center, or not at all. Section 2 removes that seed.
--
--   2. On 2026-07-16, between 18:18 and 18:31, ten employees were granted
--      create/edit/view (and manage, for Aditya) through Control Center. At
--      that moment nothing in this module consulted the permission engine —
--      the policies were still hardcoded to role='admin' — so those grants
--      were inert and could be set with no observable effect. 20260721000000
--      makes the engine live, which would silently turn all of them into real
--      write access. Section 3 reduces them to the intended set.
--
-- Every employee correction targets a stable users.id. No row is matched by
-- name, and no user record is modified.
--
-- NOT in scope: no other module's permissions are touched (every statement is
-- scoped to module_key = 'assets_access'), and access_records / the Access
-- Register stay admin-only and untouched.

-- ─── 1. Baseline: viewing the inventory is open to active staff ────────────
--
-- System Default level (1 of 4) — the weakest source, so a department rule or
-- an employee override can still deny it for an individual. This is what
-- gives "every active employee may view the asset inventory" without a row
-- per employee, and it matches what the database already allowed:
-- assets_select_all (20260640) was open to every authenticated user.

UPDATE public.module_permission_actions mpa
   SET default_allowed = true
  FROM public.permission_modules pm,
       public.permission_actions pa
 WHERE mpa.module_id = pm.id
   AND mpa.action_id = pa.id
   AND pm.module_key = 'assets_access'
   AND pa.action_key = 'view'
   AND mpa.default_allowed IS DISTINCT FROM true;

-- ─── 2. No role name grants this module ────────────────────────────────────
--
-- Removes the manager seed from 20260721000000 §3 — create, edit, manage and
-- delete, plus the view row, which is redundant now that section 1 gives view
-- to everyone.
--
-- DELETE rather than allowed = false, deliberately. role_permissions has no
-- revoked_at column (soft revocation exists only on
-- employee_permission_overrides), and a role row set to false is an active
-- role-level DENY that outranks the system default — writing false for 'view'
-- would strip inventory access from every manager. Deleting the rows lets
-- them fall through to the section 1 default, which is the intended result.
--
-- Scoped to role <> 'admin', so the admin's own role grants are untouched.
-- After this, the invariant is: nobody gets anything here from their role
-- name except the admin.

DELETE FROM public.role_permissions rp
 USING public.permission_modules pm
 WHERE rp.module_id = pm.id
   AND pm.module_key = 'assets_access'
   AND rp.role <> 'admin';

-- ─── 3. Correct the pre-cutover employee overrides ─────────────────────────
--
-- Soft revoke (revoked_at / revoked_by), never DELETE:
-- employee_permission_overrides is designed to keep grant history, and who
-- removed a capability is worth as much as who gave it.
-- resolve_effective_permissions already ignores rows with revoked_at set.
--
-- revoked_by is resolved to the acting administrator by role, not hardcoded.

-- 3a. Aditya (973b4337-9cae-4f66-8e7f-b158326cdc10): keep view + create,
--     revoke edit + manage. He is the one non-admin who may add assets; he
--     may not change or assign them. Editing and removal reach him through
--     the request workflow in 20260724000000 instead.

UPDATE public.employee_permission_overrides eo
   SET revoked_at = now(),
       revoked_by = (SELECT id FROM public.users WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1)
  FROM public.permission_modules pm,
       public.permission_actions pa
 WHERE eo.module_id = pm.id
   AND eo.action_id = pa.id
   AND pm.module_key = 'assets_access'
   AND eo.user_id = '973b4337-9cae-4f66-8e7f-b158326cdc10'
   AND pa.action_key IN ('edit', 'manage')
   AND eo.revoked_at IS NULL;

-- 3b. Everyone else: revoke create / edit / manage, keep view.
--
--     Dhruv is in this list deliberately. Being a manager is not a source of
--     asset authority — he keeps view, like every other employee.
--
--     Listed by id, one per line, so the set is auditable at review time:
--       61f4a1f7 Dhruv            a3d157da Ashok Choudhary
--       fcf8bbf9 Jasvi            f8039454 Mohit Sharma
--       9322e802 Prerna           9b3bc075 Rakesh Prajapat
--       b37c5ae7 Saksham          742c9b96 Santosh Patel
--       fb6eec18 Shravi

UPDATE public.employee_permission_overrides eo
   SET revoked_at = now(),
       revoked_by = (SELECT id FROM public.users WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1)
  FROM public.permission_modules pm,
       public.permission_actions pa
 WHERE eo.module_id = pm.id
   AND eo.action_id = pa.id
   AND pm.module_key = 'assets_access'
   AND eo.user_id IN (
     '61f4a1f7-3c2a-435f-abca-f884301dcc96',  -- Dhruv
     'a3d157da-9eef-4d81-9aa6-84b4aa6061d6',  -- Ashok Choudhary
     'fcf8bbf9-0cc4-4a6e-ba64-1143b14ef4a2',  -- Jasvi
     'f8039454-9152-452d-8d33-261f58a471af',  -- Mohit Sharma
     '9322e802-7203-456d-8986-ca625f3a8b77',  -- Prerna
     '9b3bc075-0652-469a-a93f-698652f0e727',  -- Rakesh Prajapat
     'b37c5ae7-b03f-4dd8-ad4c-3a210caff1f8',  -- Saksham
     '742c9b96-7c1c-4366-8272-99293f7ffa28',  -- Santosh Patel
     'fb6eec18-f60c-4210-a712-f265f6732557'   -- Shravi
   )
   AND pa.action_key IN ('create', 'edit', 'manage')
   AND eo.revoked_at IS NULL;

-- 3c. Belt and braces: 'delete' is granted to no non-admin, by any route.
--     Nobody holds it today; this makes that an invariant of the migration
--     rather than an accident of the current data.

UPDATE public.employee_permission_overrides eo
   SET revoked_at = now(),
       revoked_by = (SELECT id FROM public.users WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1)
  FROM public.permission_modules pm,
       public.permission_actions pa,
       public.users u
 WHERE eo.module_id = pm.id
   AND eo.action_id = pa.id
   AND eo.user_id = u.id
   AND pm.module_key = 'assets_access'
   AND pa.action_key = 'delete'
   AND u.role <> 'admin'
   AND eo.allowed
   AND eo.revoked_at IS NULL;

-- ─── 4. assets SELECT: view-gated, and never blind to your own asset ───────
--
-- assets_select_all was `USING (true)` — every authenticated row, including
-- deactivated accounts. Replaced with the module's own 'view' permission so
-- an admin can actually deny someone, plus two guards that keep the module
-- working:
--
--   * users.is_active — a deactivated account reads nothing.
--   * the own-assignment branch — My Assets embeds assets(...) through
--     employee_assets. Without it, denying 'view' to one person would blank
--     the details of the very devices they are holding.

DROP POLICY IF EXISTS "assets_select_all" ON public.assets;

CREATE POLICY "assets_select" ON public.assets
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
       WHERE users.id = auth.uid()
         AND users.is_active
         AND (users.role = 'admin' OR public.resolve_permission(auth.uid(), 'assets_access', 'view'))
    )
    OR EXISTS (
      SELECT 1 FROM public.employee_assets ea
       WHERE ea.asset_id = assets.id
         AND ea.employee_id = auth.uid()
    )
  );

-- ─── 5. assets UPDATE: 'edit' only ─────────────────────────────────────────
--
-- 20260721000000 accepted 'edit' OR 'manage' here, because assign / return /
-- mark-lost each write assets.status alongside the employee_assets row, and a
-- client doing both statements needed both permissions.
--
-- Section 6 removes that need: custody now happens inside SECURITY DEFINER
-- functions authorized by 'manage' alone, which do both writes in one
-- statement. So a direct client UPDATE is exactly one thing — editing an
-- asset's master details — and it requires exactly 'edit'.

DROP POLICY IF EXISTS "assets_update" ON public.assets;

CREATE POLICY "assets_update" ON public.assets
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'edit')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
    OR public.resolve_permission(auth.uid(), 'assets_access', 'edit')
  );

-- ─── 6. Custody operations: atomic, and authorized by 'manage' alone ───────
--
-- Assign, return and mark-lost each change TWO tables. The page performed
-- them as two independent PostgREST calls in a Promise.all, so a failure on
-- the second left the database describing something that never happened — an
-- assignment row with the asset still reading 'available', or an asset marked
-- lost with its assignment still open. It also forced a 'manage' holder to
-- also hold 'edit', purely because of where assets.status lives.
--
-- One definer function per operation fixes both: a single statement, so it
-- either all lands or none of it does, and one authorization check —
-- admin OR 'manage' — with no 'edit' anywhere in sight.

CREATE OR REPLACE FUNCTION public.assert_asset_custody_manager()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required for asset custody changes'
      USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = v_uid
       AND is_active
       AND (role = 'admin' OR public.resolve_permission(v_uid, 'assets_access', 'manage'))
  ) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_DENIED: You do not have permission to manage asset assignments'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_asset_custody_manager() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assert_asset_custody_manager() TO authenticated;

-- Assign: open a custody period and put the asset into 'assigned'.
CREATE OR REPLACE FUNCTION public.assign_asset(
  p_asset_id    uuid,
  p_employee_id uuid
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := public.assert_asset_custody_manager();
  v_asset public.assets;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_asset.status <> 'available' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not available to assign', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.employee_assets
     WHERE asset_id = p_asset_id AND status IN ('pending_acceptance', 'accepted')
  ) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already held by someone', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_employee_id AND is_active) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: That employee is not active'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
  VALUES (p_asset_id, p_employee_id, v_uid, 'pending_acceptance');

  UPDATE public.assets SET status = 'assigned' WHERE id = p_asset_id
  RETURNING * INTO v_asset;

  RETURN v_asset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assign_asset(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assign_asset(uuid, uuid) TO authenticated;

-- Return: close the custody period and put the asset back on the shelf.
-- 'returned' belongs to the assignment; the asset itself becomes 'available'
-- (see 20260722000000 §1 for why anything else strands it).
CREATE OR REPLACE FUNCTION public.return_asset(p_asset_id uuid)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := public.assert_asset_custody_manager();
  v_asset      public.assets;
  v_assignment uuid;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists'
      USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_assignment
  FROM public.employee_assets
  WHERE asset_id = p_asset_id AND status IN ('pending_acceptance', 'accepted')
  FOR UPDATE;

  IF v_assignment IS NULL THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not currently assigned to anyone', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.employee_assets
     SET status = 'returned', returned_at = now()
   WHERE id = v_assignment;

  UPDATE public.assets SET status = 'available' WHERE id = p_asset_id
  RETURNING * INTO v_asset;

  RETURN v_asset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.return_asset(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.return_asset(uuid) TO authenticated;

-- Mark lost: the asset goes to 'lost', and any open custody period closes
-- with it. An unassigned asset can be lost too — it may never have left the
-- cupboard — so an open assignment is not required here.
CREATE OR REPLACE FUNCTION public.mark_asset_lost(p_asset_id uuid)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := public.assert_asset_custody_manager();
  v_asset public.assets;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_asset.status = 'lost' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already marked lost', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.employee_assets
     SET status = 'lost', lost_at = now()
   WHERE asset_id = p_asset_id
     AND status IN ('pending_acceptance', 'accepted');

  UPDATE public.assets SET status = 'lost' WHERE id = p_asset_id
  RETURNING * INTO v_asset;

  RETURN v_asset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_asset_lost(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.mark_asset_lost(uuid) TO authenticated;
