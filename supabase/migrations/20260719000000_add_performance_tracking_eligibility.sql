-- Performance tracking eligibility.
--
-- WHY A NEW COLUMN RATHER THAN REUSING AN EXISTING ONE
--
-- Every existing candidate was inspected first and rejected for a concrete reason:
--
--   users.payroll_active     Means "include in payroll". Turning it off to hide
--                            someone from Performance would silently change what
--                            the payroll engine pays. Two unrelated decisions
--                            must not share one switch.
--   users.employment_type    'permanent' | 'contract'. Says nothing about whether
--                            the person submits daily operational data.
--   users.is_active          Already excludes people from the team query, but it
--                            also removes them from Members, permissions and
--                            View As. The brief requires excluded users to keep
--                            all of that.
--   users.role               An admin can still be an operational employee, and a
--                            'member' can still be a test account. Role is the
--                            wrong axis.
--   employee_permissions /
--   department_permissions   Module access, not reporting eligibility. Removing
--                            Performance module access would stop someone seeing
--                            their own report, which is not what is wanted.
--   is_test_data (orders,
--   order_requests,
--   finance_payment_requests)  Row-level test markers on business documents.
--                            No equivalent exists on users.
--
-- So there is no existing field that means "counts as an operational employee for
-- Performance reporting". This adds the smallest explicit one.
--
-- WHAT IT DOES NOT DO
--
-- Excluded users keep their account, role, module access, task history, activity
-- history and View As availability. This column is read by the Performance
-- reporting layer only.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS performance_tracking_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS performance_tracking_note    text;

COMMENT ON COLUMN public.users.performance_tracking_enabled IS
  'Include this user in Performance team reporting (rankings, team average, '
  'coverage, adoption). Default true so every operational employee is measured. '
  'Set false for administrative or test accounts that do not submit daily '
  'operational data. Read only by the Performance layer — does not affect '
  'payroll, permissions, task workflows, Members or View As.';

COMMENT ON COLUMN public.users.performance_tracking_note IS
  'Auditable reason for performance_tracking_enabled = false. Shown to admins '
  'only in the Performance Coverage panel; never exposed to ordinary employees.';

-- No index. This table holds 20 rows and is read once per Performance request as
-- part of a full scan that already happens for is_active. A partial index on a
-- near-uniform boolean over 20 rows would never be chosen by the planner.

-- ── Initial exclusions, by exact primary key ────────────────────────────────────
--
-- Identified by UUID, not by display name. Nothing in the application matches on
-- names, so renaming any of these accounts cannot change who is measured. Each
-- UPDATE is a no-op if the id is absent, which keeps the migration safe to replay
-- against any other environment.
--
-- Guarded by `performance_tracking_enabled` so a later manual re-enable is not
-- silently undone if this migration is ever replayed.

-- Nishant — owner/administrator account (employee_code TEST-001). Creates and
-- delegates work across every department and holds 283 assigned tasks, but does
-- not submit daily operational data, so a "score" for this account is not a
-- measurement of anyone's work. Left in place because it is the live admin login.
UPDATE public.users
   SET performance_tracking_enabled = false,
       performance_tracking_note    = 'Administrator/owner account. Does not submit daily operational data; task activity is administrative rather than measurable delivery.'
 WHERE id = '6507df9f-cdeb-4ebd-849f-8498c165d596'
   AND performance_tracking_enabled;

-- Namrata — administrative/test account. No employee_code, no employment_type,
-- no EOD submissions at all, 9 assigned tasks.
UPDATE public.users
   SET performance_tracking_enabled = false,
       performance_tracking_note    = 'Administrative/test account. No employee code, no employment type and no EOD submissions; not an operational employee.'
 WHERE id = 'c725dcae-aee2-4891-875b-433f8eb6c03d'
   AND performance_tracking_enabled;

-- The seven permission-test fixtures created for the department/permission work.
-- They have no employee_code, no joining_date, no tasks and no EOD history. Left
-- in the database because the permission engine's department coverage is verified
-- through them, but they are not operational employees: the brief's rule is that
-- *operational employees* default to included, and these are fixtures.
--
-- Reversible from the employee configuration screen if the owner disagrees.
UPDATE public.users
   SET performance_tracking_enabled = false,
       performance_tracking_note    = 'Permission-test fixture account, not an operational employee. Retained for department/permission verification.'
 WHERE id IN (
         'eadf65b1-98c1-4c63-ba0f-816cc171f81e',  -- Test Admin Dept User (DUMMY)
         'be0a101a-6bfb-495b-8e95-30a7c104be04',  -- Test Design User (DUMMY)
         '47b9bdc8-c73b-44f2-a675-aa3290a4e470',  -- Test HR User (DUMMY)
         '27e2f32b-f12b-4a6a-aebd-c44d2ce1db7f',  -- Test Management User (DUMMY)
         '57b11e89-a90b-407d-b92b-c4b0354f77fa',  -- Test Marketing User (DUMMY)
         'f4df0228-319c-4baa-947d-a3f709a0e8a3',  -- Test Operations User (DUMMY)
         'ac5e5888-cb72-4f9c-ab36-5b4d32efe54c'   -- Test Sales User (DUMMY)
       )
   AND performance_tracking_enabled;

-- ── Rollback ───────────────────────────────────────────────────────────────────
-- ALTER TABLE public.users DROP COLUMN IF EXISTS performance_tracking_note;
-- ALTER TABLE public.users DROP COLUMN IF EXISTS performance_tracking_enabled;
-- Nothing else depends on either column. Roll the application code back at the
-- same time — the Performance routes SELECT both.
