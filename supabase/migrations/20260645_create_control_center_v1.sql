-- BOE OS Admin Control Center V1
--
-- Two new tables:
--   app_modules     — module registry with visibility control
--   departments     — department master list (mirrors users.team values)
--
-- Visibility types on app_modules:
--   live             → visible to all authenticated users
--   admin_only       → visible only to role = 'admin'
--   department_only  → visible to admin + users whose team = allowed_department
--   hidden           → not shown in /modules (direct route still works)
--
-- users.team remains the source of truth for a user's department.
-- The Control Center writes to users.team via the existing /api/update-member route.
-- departments.department_key must match the values stored in users.team.

-- ─── 1. app_modules ──────────────────────────────────────────────────────────

CREATE TABLE public.app_modules (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key         text        UNIQUE NOT NULL,
  module_name        text        NOT NULL,
  description        text,
  route_path         text        NOT NULL,
  visibility_type    text        NOT NULL DEFAULT 'live'
                                 CHECK (visibility_type IN ('live', 'admin_only', 'department_only', 'hidden')),
  allowed_department text,
  sort_order         int         NOT NULL DEFAULT 100,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_modules ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read (needed by /modules to evaluate visibility client-side)
CREATE POLICY "app_modules_select" ON public.app_modules
  FOR SELECT TO authenticated USING (true);

-- Only admins can write
CREATE POLICY "app_modules_admin_insert" ON public.app_modules
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

CREATE POLICY "app_modules_admin_update" ON public.app_modules
  FOR UPDATE TO authenticated
  USING     (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK(EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

CREATE POLICY "app_modules_admin_delete" ON public.app_modules
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

-- Seed: all current modules
INSERT INTO public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
VALUES
  ('task_management',  'Task Management',  'Create, assign, and track tasks across the team.',         '/dashboard',      'live',            NULL,    10),
  ('sample_tracking',  'Sample Tracking',  'Request catalogs, track dispatch and returns.',            '/samples',        'live',            NULL,    20),
  ('assets_access',    'Assets & Access',  'Assigned devices and access records.',                     '/assets-access',  'live',            NULL,    30),
  ('attendance',       'Attendance',       'Employee attendance records, uploads, and leave history.', '/attendance',     'admin_only',      NULL,    40),
  ('payroll',          'Payroll',          'Payroll runs, salary breakdowns, and payslips.',           '/payroll',        'admin_only',      NULL,    50),
  ('showroom_qr',      'Showroom QR',      'QR-based showroom inquiries and quotations.',              '/showroom-admin', 'department_only', 'sales', 60),
  ('employee_records', 'Employee Records', 'Employee profiles, roles, and team assignments.',          '/admin/members',  'admin_only',      NULL,    70),
  ('performance',      'Performance',      'Daily performance scores and trends.',                     '/performance',    'live',            NULL,    80);

-- ─── 2. departments ───────────────────────────────────────────────────────────

CREATE TABLE public.departments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  department_key   text        UNIQUE NOT NULL,
  department_name  text        NOT NULL,
  is_active        boolean     NOT NULL DEFAULT true,
  sort_order       int         NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "departments_select" ON public.departments
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "departments_admin_insert" ON public.departments
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

CREATE POLICY "departments_admin_update" ON public.departments
  FOR UPDATE TO authenticated
  USING     (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK(EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

CREATE POLICY "departments_admin_delete" ON public.departments
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

-- Seed: mirrors the existing TEAMS constant in admin/members and attendance/employees
INSERT INTO public.departments (department_key, department_name, sort_order)
VALUES
  ('sales',       'Sales',       10),
  ('operations',  'Operations',  20),
  ('design',      'Design',      30),
  ('purchase',    'Purchase',    40),
  ('bdm',         'BDM',         50),
  ('management',  'Management',  60);
