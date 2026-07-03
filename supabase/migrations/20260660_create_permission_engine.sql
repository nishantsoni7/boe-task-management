-- Centralized Permission Management System — foundation only.
--
-- Hierarchy (lowest → highest priority):
--   1. System Default   — module_permission_actions.default_allowed
--   2. Role             — role_permissions        (users.role, unconstrained text)
--   3. Department       — department_permissions   (departments.id)
--   4. Employee Override — employee_permission_overrides (users.id, highest priority)
--
-- This migration only creates the schema, seed data, and two read-only
-- resolver functions. It does not change behavior of any existing route,
-- policy, or table — nothing in the app calls these functions yet.
--
-- Distinct from (and does not modify) two existing, narrower mechanisms:
--   - app_modules / departments   (Control Center route-visibility toggles)
--   - employee_permissions / has_permission()  (ad hoc Sample Tracking grants)
-- Those keep working unchanged. This engine is the general-purpose
-- replacement future modules should build on.

-- ─── 1. permission_modules ────────────────────────────────────────────────────

CREATE TABLE public.permission_modules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key   text        UNIQUE NOT NULL,
  display_name text        NOT NULL,
  description  text,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.permission_modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "permission_modules_select" ON public.permission_modules
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "permission_modules_admin_write" ON public.permission_modules
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK(EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

DROP TRIGGER IF EXISTS permission_modules_set_updated_at ON public.permission_modules;
CREATE TRIGGER permission_modules_set_updated_at
  BEFORE UPDATE ON public.permission_modules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 2. permission_actions ────────────────────────────────────────────────────
-- Reusable, module-agnostic actions. Modules may also register custom
-- actions here (is_system = false) beyond the 8 system defaults.

CREATE TABLE public.permission_actions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_key   text        UNIQUE NOT NULL,
  display_name text        NOT NULL,
  is_system    boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.permission_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "permission_actions_select" ON public.permission_actions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "permission_actions_admin_write" ON public.permission_actions
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK(EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

-- ─── 3. module_permission_actions ─────────────────────────────────────────────
-- Which actions a module supports, and the System Default (level 1) for each.

CREATE TABLE public.module_permission_actions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id       uuid        NOT NULL REFERENCES public.permission_modules(id) ON DELETE CASCADE,
  action_id       uuid        NOT NULL REFERENCES public.permission_actions(id) ON DELETE CASCADE,
  default_allowed boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_id, action_id)
);

CREATE INDEX module_permission_actions_module_idx ON public.module_permission_actions (module_id);

ALTER TABLE public.module_permission_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "module_permission_actions_select" ON public.module_permission_actions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "module_permission_actions_admin_write" ON public.module_permission_actions
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK(EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

-- ─── 4. role_permissions (level 2) ────────────────────────────────────────────
-- role is plain text (matches users.role) — there is no roles table.

CREATE TABLE public.role_permissions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role       text        NOT NULL,
  module_id  uuid        NOT NULL REFERENCES public.permission_modules(id) ON DELETE CASCADE,
  action_id  uuid        NOT NULL REFERENCES public.permission_actions(id) ON DELETE CASCADE,
  allowed    boolean     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, module_id, action_id)
);

CREATE INDEX role_permissions_role_idx ON public.role_permissions (role);

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "role_permissions_admin_all" ON public.role_permissions
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK(EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

DROP TRIGGER IF EXISTS role_permissions_set_updated_at ON public.role_permissions;
CREATE TRIGGER role_permissions_set_updated_at
  BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 5. department_permissions (level 3) ──────────────────────────────────────

CREATE TABLE public.department_permissions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid        NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  module_id     uuid        NOT NULL REFERENCES public.permission_modules(id) ON DELETE CASCADE,
  action_id     uuid        NOT NULL REFERENCES public.permission_actions(id) ON DELETE CASCADE,
  allowed       boolean     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, module_id, action_id)
);

CREATE INDEX department_permissions_department_idx ON public.department_permissions (department_id);

ALTER TABLE public.department_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "department_permissions_admin_all" ON public.department_permissions
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK(EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

DROP TRIGGER IF EXISTS department_permissions_set_updated_at ON public.department_permissions;
CREATE TRIGGER department_permissions_set_updated_at
  BEFORE UPDATE ON public.department_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 6. employee_permission_overrides (level 4 — highest priority) ───────────
-- Deliberately separate from the existing employee_permissions table
-- (which is Sample Tracking-specific and keyed by a free-text permission_key).
-- Same soft-revoke shape for consistency, not a full audit log.

CREATE TABLE public.employee_permission_overrides (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  module_id   uuid        NOT NULL REFERENCES public.permission_modules(id) ON DELETE CASCADE,
  action_id   uuid        NOT NULL REFERENCES public.permission_actions(id) ON DELETE CASCADE,
  allowed     boolean     NOT NULL,
  granted_by  uuid        NOT NULL REFERENCES public.users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  uuid        REFERENCES public.users(id),
  revoked_at  timestamptz,
  UNIQUE (user_id, module_id, action_id)
);

CREATE INDEX employee_permission_overrides_user_idx ON public.employee_permission_overrides (user_id);

ALTER TABLE public.employee_permission_overrides ENABLE ROW LEVEL SECURITY;

-- Mirrors employee_permissions: users can read their own active overrides,
-- only admins can write. Admin reads-all go through the service-role
-- client, same convention as /api/admin/user-permissions.
CREATE POLICY "epo_select_own" ON public.employee_permission_overrides
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "epo_admin_write" ON public.employee_permission_overrides
  FOR ALL TO authenticated
  USING     (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK(EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

-- ─── 7. Resolver functions ─────────────────────────────────────────────────────
-- SECURITY DEFINER, same convention as has_permission() — runs as DB owner
-- so it can read every level regardless of the caller's own RLS visibility.

-- Effective permission resolver: merges all 4 levels for every action a
-- module supports, and reports which level ("source") decided each one.
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
  LEFT JOIN public.departments d ON d.department_key = u.team
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

-- Central single-permission check: hasPermission(userId, moduleId, action).
-- Thin wrapper over resolve_effective_permissions so precedence logic
-- lives in exactly one place.
CREATE OR REPLACE FUNCTION public.resolve_permission(
  p_user_id    uuid,
  p_module_key text,
  p_action_key text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT allowed FROM public.resolve_effective_permissions(p_user_id, p_module_key)
     WHERE action_key = p_action_key),
    false
  );
$$;

-- ─── 8. Seed data ──────────────────────────────────────────────────────────────
-- Metadata only — mirrors app_modules' existing module_key values so the two
-- registries don't drift, but this table is independent and nothing reads it
-- yet, so no existing behavior changes.

INSERT INTO public.permission_actions (action_key, display_name, is_system) VALUES
  ('view',    'View',    true),
  ('create',  'Create',  true),
  ('edit',    'Edit',    true),
  ('delete',  'Delete',  true),
  ('approve', 'Approve', true),
  ('export',  'Export',  true),
  ('manage',  'Manage',  true),
  ('admin',   'Admin',   true);

INSERT INTO public.permission_modules (module_key, display_name, description) VALUES
  ('task_management',  'Task Management',  'Create, assign, and track tasks across the team.'),
  ('sample_tracking',  'Sample Tracking',  'Request catalogs, track dispatch and returns.'),
  ('assets_access',    'Assets & Access',  'Assigned devices and access records.'),
  ('attendance',       'Attendance',       'Employee attendance records, uploads, and leave history.'),
  ('payroll',          'Payroll',          'Payroll runs, salary breakdowns, and payslips.'),
  ('showroom_qr',      'Showroom QR',      'QR-based showroom inquiries and quotations.'),
  ('employee_records', 'Employee Records', 'Employee profiles, roles, and team assignments.'),
  ('performance',      'Performance',      'Daily performance scores and trends.'),
  ('finance',          'Finance',          'Payment requests and financial records.');

-- Supported actions per module. default_allowed = false everywhere
-- (System Default level denies by default; Role/Department/Employee
-- Override levels are what grant access).
INSERT INTO public.module_permission_actions (module_id, action_id, default_allowed)
SELECT pm.id, pa.id, false
FROM public.permission_modules pm
JOIN public.permission_actions pa ON pa.action_key = ANY(
  CASE pm.module_key
    WHEN 'task_management'  THEN ARRAY['view','create','edit','delete','export','manage']
    WHEN 'sample_tracking'  THEN ARRAY['view','create','edit','delete','approve','export','manage']
    WHEN 'assets_access'    THEN ARRAY['view','create','edit','delete','manage']
    WHEN 'attendance'       THEN ARRAY['view','create','edit','delete','approve','export','manage']
    WHEN 'payroll'          THEN ARRAY['view','edit','approve','export','manage','admin']
    WHEN 'showroom_qr'      THEN ARRAY['view','create','edit','manage']
    WHEN 'employee_records' THEN ARRAY['view','create','edit','delete','export','manage','admin']
    WHEN 'performance'      THEN ARRAY['view','create','edit','export','manage']
    WHEN 'finance'          THEN ARRAY['view','create','edit','delete','approve','export','manage']
  END
);

-- Role level: admin retains full access to every registered module/action,
-- matching the existing app-wide "admin can do everything" convention.
-- manager/member have no rows here, so they fall through to System Default
-- (deny) until explicitly granted — this is additive-only and does not
-- change what admins, managers, or members can currently do anywhere,
-- since no existing route consults this engine yet.
INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'admin', module_id, action_id, true
FROM public.module_permission_actions;
