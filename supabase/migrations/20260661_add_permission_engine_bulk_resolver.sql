-- Centralized Permission Management System — bulk resolver for the Permission
-- Management UI (Phase 2).
--
-- Additive only: does not modify resolve_effective_permissions(),
-- resolve_permission(), or any table from 20260660_create_permission_engine.sql.
-- Existing callers of those functions are unaffected.
--
-- Why this exists: the Permission Management UI needs one employee's
-- effective permissions across every module at once (to render a single
-- page). Calling resolve_effective_permissions() once per module would be
-- N+1 (one RPC round trip per module). This function does the same
-- precedence merge — Employee Override > Department > Role > System
-- Default — across all active modules in a single query/round trip.
--
-- IMPORTANT: this intentionally duplicates the precedence CASE/COALESCE
-- logic from resolve_effective_permissions() in 20260660 (Postgres has no
-- clean way to share a query fragment across two RETURNS TABLE functions
-- without an extra round trip, which would defeat the point of this
-- function). If the precedence hierarchy changes — e.g. Permission
-- Profiles are inserted between Department and Employee Override — update
-- BOTH this function and resolve_effective_permissions() together.

CREATE OR REPLACE FUNCTION public.resolve_effective_permissions_for_user(
  p_user_id uuid
)
RETURNS TABLE (module_key text, action_key text, allowed boolean, source text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_role          text;
  v_department_id uuid;
BEGIN
  SELECT u.role, d.id
    INTO v_role, v_department_id
  FROM public.users u
  LEFT JOIN public.departments d ON d.department_key = u.team
  WHERE u.id = p_user_id;

  RETURN QUERY
  -- Keep this precedence logic synchronized with resolve_effective_permissions() (20260660).
  SELECT
    pm.module_key,
    pa.action_key,
    COALESCE(eo.allowed, dp.allowed, rp.allowed, mpa.default_allowed, false) AS allowed,
    CASE
      WHEN eo.allowed IS NOT NULL THEN 'employee_override'
      WHEN dp.allowed IS NOT NULL THEN 'department'
      WHEN rp.allowed IS NOT NULL THEN 'role'
      ELSE 'system_default'
    END AS source
  FROM public.module_permission_actions mpa
  JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.is_active
  JOIN public.permission_actions pa ON pa.id = mpa.action_id
  LEFT JOIN public.role_permissions rp
    ON rp.module_id = mpa.module_id AND rp.action_id = mpa.action_id AND rp.role = v_role
  LEFT JOIN public.department_permissions dp
    ON dp.module_id = mpa.module_id AND dp.action_id = mpa.action_id AND dp.department_id = v_department_id
  LEFT JOIN public.employee_permission_overrides eo
    ON eo.module_id = mpa.module_id AND eo.action_id = mpa.action_id
    AND eo.user_id = p_user_id AND eo.revoked_at IS NULL
  ORDER BY pm.module_key, pa.action_key;
END;
$$;
