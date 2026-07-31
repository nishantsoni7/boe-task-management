-- Assets & Access — split 'assign' out of 'manage'.
--
-- 'manage' had grown to mean three unrelated custody operations: assigning an
-- available asset, taking one back, and writing one off as lost. Handing
-- someone the ability to give a laptop to a colleague also handed them the
-- ability to declare it lost, which is not the same decision and not the same
-- level of trust.
--
-- Action meanings after this migration:
--
--   view    read the inventory and who currently holds each asset
--   create  add an asset
--   assign  give an AVAILABLE asset to an employee            ← new
--   edit    change asset master details directly
--   delete  remove an eligible, never-assigned asset
--   manage  return an assigned asset, mark one lost, and other
--           custody corrections reserved for administration
--
-- 'assign' is a custom action (is_system = false), the same shape as Sample
-- Tracking's dispatch / receive / mark_lost (20260660 §8, registered in
-- src/lib/permissions/modules.ts).
--
-- Grants nothing to anybody. default_allowed = false, no role seed, no
-- employee override — the only non-admin path to this permission is an
-- administrator enabling it per employee in Control Center → Access Control.
-- Admin keeps the established bypass, and gets the matching role row so its
-- effective-permission display stays complete (same as 20260663 did for
-- Sample Tracking's new actions).

-- ─── 1. Register the action ────────────────────────────────────────────────

INSERT INTO public.permission_actions (action_key, display_name, is_system)
VALUES ('assign', 'Assign Assets', false)
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO public.module_permission_actions (module_id, action_id, default_allowed)
SELECT pm.id, pa.id, false
FROM public.permission_modules pm
JOIN public.permission_actions pa ON pa.action_key = 'assign'
WHERE pm.module_key = 'assets_access'
ON CONFLICT (module_id, action_id) DO NOTHING;

-- Admin defaults, matching every other action on every other module.
INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'admin', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id
JOIN public.permission_actions   pa ON pa.id = mpa.action_id
WHERE pm.module_key = 'assets_access'
  AND pa.action_key = 'assign'
ON CONFLICT (role, module_id, action_id) DO NOTHING;

-- ─── 2. One guard, parameterised by action and message ─────────────────────
--
-- Replaces assert_asset_custody_manager(), which hardcoded 'manage' for all
-- three operations. The message is passed in so a refusal names the operation
-- the caller actually attempted — "You do not have permission to assign
-- assets", never a generic sentence about managing assignments.

CREATE OR REPLACE FUNCTION public.assert_asset_custody_permission(
  p_action  text,
  p_message text
)
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
       AND (role = 'admin' OR public.resolve_permission(v_uid, 'assets_access', p_action))
  ) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_DENIED: %', p_message
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_asset_custody_permission(text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assert_asset_custody_permission(text, text) TO authenticated;

-- ─── 3. assign_asset now requires 'assign', not 'manage' ───────────────────
--
-- Body is otherwise unchanged from 20260723000000: still one statement, still
-- atomic across employee_assets and assets.status, still takes assigned_by
-- from the session, still refuses anything that is not 'available' or that
-- already has an open custody period. Only the authorization line moves.
--
-- It deliberately does NOT accept 'manage'. Someone whose job is to take
-- assets back and write them off is not thereby entitled to hand them out;
-- if a person should do both, grant both.

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
  v_uid   uuid := public.assert_asset_custody_permission(
                    'assign', 'You do not have permission to assign assets');
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

-- ─── 4. return_asset keeps 'manage', with its own message ──────────────────
-- 'assign' alone is explicitly not enough to take an asset back.

CREATE OR REPLACE FUNCTION public.return_asset(p_asset_id uuid)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := public.assert_asset_custody_permission(
                         'manage', 'You do not have permission to return assets');
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

-- ─── 5. mark_asset_lost keeps 'manage', with its own message ───────────────

CREATE OR REPLACE FUNCTION public.mark_asset_lost(p_asset_id uuid)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := public.assert_asset_custody_permission(
                    'manage', 'You do not have permission to mark assets as lost');
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

-- ─── 6. Retire the old single-purpose guard ────────────────────────────────
-- Its only three callers were replaced above.

DROP FUNCTION IF EXISTS public.assert_asset_custody_manager();
