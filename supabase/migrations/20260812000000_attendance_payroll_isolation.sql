-- Attendance & Payroll row isolation.
--
-- What was wrong
-- --------------
-- Five payroll tables carried a SELECT policy of `TO authenticated USING (true)`.
-- That is not a narrow gap: with RLS enabled and a permissive read policy, ANY
-- signed-in employee could read EVERY employee's salary, deduction ledger and
-- salary adjustments straight from PostgREST with their own access token — no
-- admin route, no UI, no privilege escalation required. Verified against the
-- linked database before this migration, not inferred from the migration files:
--
--   payroll_results              SELECT  USING (true)   ← every net salary
--   payroll_deduction_lines      SELECT  USING (true)   ← every deduction, per day
--   payroll_pending_adjustments  SELECT  USING (true)   ← every manual salary correction
--   payroll_periods              SELECT  USING (true)   ← every payroll month
--   payroll_generation           SELECT  USING (true)   ← run counters + failed employee ids
--
-- Two narrower defects came with it:
--
--   * attendance_correction_log granted READ to 'manager' as well as 'admin',
--     so being someone's manager was, by itself, correction-review access over
--     the whole company.
--   * public.users allowed SELECT to role `public` — which includes `anon` —
--     with `USING (is_active = true)` and no auth predicate at all. The anon
--     key alone therefore returned the entire employee directory, monthly_salary
--     column included.
--
-- The shape of the fix
-- --------------------
-- Every private payroll table gets an own-row read keyed on the one identity
-- the database can actually trust: auth.uid(). Admin keeps everything through
-- the pre-existing `FOR ALL` policies, which already cover SELECT — they are
-- left untouched so admin behaviour cannot drift as a side effect of this
-- change. Nothing here grants a single new write: no INSERT, UPDATE or DELETE
-- policy is added for any employee, so payroll generation, locking, unlocking
-- and attendance correction keep running exactly as they do today, through the
-- service-role routes.
--
-- Identity mapping this relies on
-- -------------------------------
-- public.users.id IS auth.users.id (same uuid, 20/20 rows, no orphan either
-- way at the time of writing) and attendance_records.user_id,
-- payroll_results.employee_id and attendance_day_corrections.user_id all
-- reference public.users(id). So `= auth.uid()` is the whole mapping. Note the
-- convention is NOT enforced by a foreign key from public.users to auth.users —
-- see the audit notes; that is a separate, pre-existing gap.
--
-- What is deliberately NOT changed
-- --------------------------------
--   * payroll_holidays keeps its readable-by-authenticated policy. A company
--     holiday calendar is not personal data, PAYROLL_RULES_V1 says employees
--     should be able to see it, and it carries nobody's salary.
--   * attendance_records gains an admin read policy it did not have. Admin
--     screens reach attendance through service-role routes today, so this
--     changes no UI; it makes the database, rather than a route, the place the
--     admin boundary is stated.
--   * The `Admins can manage …` FOR ALL policies are not redefined.
--
-- Production safety
-- -----------------
-- Policy-only. No table, column, index or row is altered, and no data is read
-- or written. Re-running is safe (DROP POLICY IF EXISTS throughout).
--
-- Rollback
-- --------
-- Recreate the five `USING (true)` SELECT policies and restore the manager
-- branch on attendance_correction_log. Doing so restores the vulnerability;
-- prefer fixing forward.

-- ─── payroll_results ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Authenticated users can read payroll results" ON public.payroll_results;

DROP POLICY IF EXISTS "employees_read_own_payroll_result" ON public.payroll_results;
CREATE POLICY "employees_read_own_payroll_result"
  ON public.payroll_results
  FOR SELECT
  TO authenticated
  USING (employee_id = auth.uid());

-- ─── payroll_deduction_lines ─────────────────────────────────────────────────
-- Keyed through the parent result rather than a denormalised employee column,
-- so a line can never outlive or contradict the ownership of the result it
-- explains. The subquery is itself subject to payroll_results' RLS, which is
-- exactly what makes a protected parent unable to expose unrestricted children.

DROP POLICY IF EXISTS "Authenticated users can read deduction lines" ON public.payroll_deduction_lines;

DROP POLICY IF EXISTS "employees_read_own_deduction_lines" ON public.payroll_deduction_lines;
CREATE POLICY "employees_read_own_deduction_lines"
  ON public.payroll_deduction_lines
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.payroll_results r
      WHERE r.id = payroll_deduction_lines.payroll_result_id
        AND r.employee_id = auth.uid()
    )
  );

-- ─── payroll_pending_adjustments ─────────────────────────────────────────────

DROP POLICY IF EXISTS "Authenticated users can read pending adjustments" ON public.payroll_pending_adjustments;

DROP POLICY IF EXISTS "employees_read_own_pending_adjustments" ON public.payroll_pending_adjustments;
CREATE POLICY "employees_read_own_pending_adjustments"
  ON public.payroll_pending_adjustments
  FOR SELECT
  TO authenticated
  USING (employee_id = auth.uid());

-- ─── payroll_periods ─────────────────────────────────────────────────────────
-- An employee needs the month, year and lock state to label their own payslip,
-- and nothing more. Visibility is therefore derived from having a result in the
-- period, not granted wholesale: a month an employee was not paid in does not
-- exist for them, so the period list cannot be used to count payroll runs or
-- infer that a month was reopened.

DROP POLICY IF EXISTS "Authenticated users can read payroll periods" ON public.payroll_periods;

DROP POLICY IF EXISTS "employees_read_own_payroll_periods" ON public.payroll_periods;
CREATE POLICY "employees_read_own_payroll_periods"
  ON public.payroll_periods
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.payroll_results r
      WHERE r.payroll_period_id = payroll_periods.id
        AND r.employee_id = auth.uid()
    )
  );

-- ─── payroll_generation ──────────────────────────────────────────────────────
-- A generation run carries failed_employee_ids and headcounts. It is an
-- operational record about the company, never about the reader, so employees
-- get nothing. Admin keeps it through "Admins can manage payroll generation".

DROP POLICY IF EXISTS "Authenticated users can read payroll generation" ON public.payroll_generation;

-- ─── attendance_records ──────────────────────────────────────────────────────
-- The own-row rule was already right; it was granted to role `public` rather
-- than `authenticated`. `auth.uid() = user_id` is NULL for anon so nothing
-- leaked, but the policy should say what it means.

DROP POLICY IF EXISTS "users_read_own_attendance" ON public.attendance_records;
CREATE POLICY "users_read_own_attendance"
  ON public.attendance_records
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "admins_read_all_attendance" ON public.attendance_records;
CREATE POLICY "admins_read_all_attendance"
  ON public.attendance_records
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

-- ─── attendance_correction_log ───────────────────────────────────────────────
-- The import diff log is an admin audit surface. A manager is not a payroll
-- reviewer in BOE, and holding the role was granting review over every
-- employee's corrected punches.

DROP POLICY IF EXISTS "admins_read_correction_log" ON public.attendance_correction_log;
CREATE POLICY "admins_read_correction_log"
  ON public.attendance_correction_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

-- ─── public.users ────────────────────────────────────────────────────────────
-- Requires a session. The predicate is unchanged for every signed-in user, so
-- no application read changes; what stops is the anon key returning the whole
-- employee directory — monthly_salary and payroll_notes included — to anyone
-- holding a key that ships in the client bundle by design.
--
-- This does NOT hide monthly_salary from a signed-in peer. RLS is row-level;
-- restricting a column needs a column privilege, and revoking SELECT on
-- monthly_salary would break every `select('*')` on users across the app. That
-- remains an open finding, recorded in the audit, not silently half-fixed here.

DROP POLICY IF EXISTS "Users can read all active users" ON public.users;
CREATE POLICY "Users can read all active users"
  ON public.users
  FOR SELECT
  TO authenticated
  USING (is_active = true);
