-- Employee designation level: the organisational hierarchy, and ONLY that.
--
-- WHAT THIS IS
-- ------------
-- BOE's employee-facing hierarchy has six rungs — Super Admin, Administrator,
-- Manager, Executive, Assistant, Trainee. Until now the app had nowhere to
-- record them: `users.role` is the authorization role, `users.team` is the
-- department and `users.position` is the job title. This column is the fourth,
-- separate fact.
--
-- WHAT THIS IS NOT — READ THIS BEFORE USING THE COLUMN
-- ---------------------------------------------------
-- It is NOT an authorization input, and nothing in the application or the
-- database reads it to decide anything. Access is decided exactly as it was
-- before this migration:
--
--   * `users.role` ('admin' | 'manager' | 'member') is what every RLS policy in
--     this schema tests, what `role_permissions` is keyed on (20260660), and
--     what `canAccessManagementModule` short-circuits on.
--   * module access is the permission engine's answer — employee overrides over
--     department over role over system default.
--
-- So a Manager in Design does not acquire Finance by being a Manager. The
-- hierarchy describes the organisation; Access Control decides the system. Any
-- future change that makes a policy or a resolver read this column is a
-- privilege-escalation change and must be designed as one.
--
-- NO BACKFILL, ON PURPOSE
-- -----------------------
-- Every existing row keeps `designation_level = NULL`, which reads as "Not
-- set". Mapping today's `admin`/`manager`/`member` onto the six rungs would be
-- a guess — a `member` may be an Executive, an Assistant or a Trainee, and an
-- `admin` may or may not be the organisation's Super Admin. An administrator
-- sets each person's level in Control Center › Employees. Because the column
-- grants nothing, an unset level costs no access.
--
-- PRODUCTION SAFETY
-- -----------------
-- Additive. One nullable column, one CHECK, one column-level SELECT grant. No
-- existing column, policy, function or row is touched, and no data is read or
-- written. Re-running is safe.
--
-- ROLLBACK
-- --------
--   ALTER TABLE public.users DROP COLUMN IF EXISTS designation_level;
-- restores the previous state exactly; nothing depends on the column.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS designation_level text;

-- The six rungs, stored as stable keys rather than display text so the label
-- can be reworded without a data migration. NULL is a first-class value and
-- means "not set" — see the note above about why nothing was backfilled.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_designation_level_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_designation_level_check
  CHECK (
    designation_level IS NULL
    OR designation_level IN (
      'super_admin',
      'administrator',
      'manager',
      'executive',
      'assistant',
      'trainee'
    )
  );

-- 20260813000000 revoked table-level SELECT on public.users from
-- `authenticated` and handed back a named column list, precisely so that a new
-- column is invisible until somebody grants it on purpose. This is that grant:
-- the level is shown to the employee on their own profile and beside every name
-- an administrator scans, so it is directory information, not an HR secret.
-- `monthly_salary`, `payroll_notes` and `performance_tracking_note` remain
-- ungranted.
GRANT SELECT (designation_level) ON public.users TO authenticated;

-- No INSERT/UPDATE grant. Every write to public.users in this codebase goes
-- through a service-role API route that verifies the caller is an admin, and
-- 20260813000000 withdrew the browser role's write privileges here deliberately.

COMMENT ON COLUMN public.users.designation_level IS
  'Organisational hierarchy rung (super_admin|administrator|manager|executive|assistant|trainee). Informational only — NOT an authorization input. Access is decided by users.role and the permission engine.';
