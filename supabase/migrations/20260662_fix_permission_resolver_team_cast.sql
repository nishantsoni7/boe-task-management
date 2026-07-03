-- Fix a runtime bug found while verifying the Permission Management UI
-- (Phase 2): users.team is the enum type user_team, not text, but both
-- resolve_effective_permissions() (20260660) and
-- resolve_effective_permissions_for_user() (20260661) join it against
-- departments.department_key (text) with no cast:
--
--   LEFT JOIN public.departments d ON d.department_key = u.team
--
-- Postgres has no `text = user_team` operator, so every call errored with
-- "operator does not exist: text = user_team" (42883). This was a latent
-- bug in 20260660 itself — nothing called it until Phase 2 did — not
-- something introduced by the bulk resolver. Fixing forward with
-- CREATE OR REPLACE rather than editing the original migration files, to
-- keep their history accurate; both functions are otherwise unchanged.

CREATE OR REPLACE FUNCTION public.resolve_effective_permissions(
  p_user_id    uuid,
  p_module_key text
)
RETURNS TABLE (action_key text, allowed boolean, source text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_module_id     uuid;
  v_role          text;
  v_department_id uuid;
BEGIN
  SELECT id INTO v_module_id
  FROM public.permission_modules
  WHERE module_key = p_module_key AND is_active;

  IF v_module_id IS NULL THEN
    RETURN;
  END IF;

  SELECT u.role, d.id
    INTO v_role, v_department_id
  FROM public.users u
  LEFT JOIN public.departments d ON d.department_key = u.team::text
  WHERE u.id = p_user_id;

  RETURN QUERY
  SELECT
    pa.action_key,
    COALESCE(eo.allowed, dp.allowed, rp.allowed, mpa.default_allowed, false) AS allowed,
    CASE
      WHEN eo.allowed IS NOT NULL THEN 'employee_override'
      WHEN dp.allowed IS NOT NULL THEN 'department'
      WHEN rp.allowed IS NOT NULL THEN 'role'
      ELSE 'system_default'
    END AS source
  FROM public.module_permission_actions mpa
  JOIN public.permission_actions pa ON pa.id = mpa.action_id
  LEFT JOIN public.role_permissions rp
    ON rp.module_id = mpa.module_id AND rp.action_id = mpa.action_id AND rp.role = v_role
  LEFT JOIN public.department_permissions dp
    ON dp.module_id = mpa.module_id AND dp.action_id = mpa.action_id AND dp.department_id = v_department_id
  LEFT JOIN public.employee_permission_overrides eo
    ON eo.module_id = mpa.module_id AND eo.action_id = mpa.action_id
    AND eo.user_id = p_user_id AND eo.revoked_at IS NULL
  WHERE mpa.module_id = v_module_id;
END;
$$;

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
  LEFT JOIN public.departments d ON d.department_key = u.team::text
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
