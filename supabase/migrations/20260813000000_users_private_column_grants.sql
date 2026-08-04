-- public.users: column privileges for the two Admin-only HR fields.
--
-- The problem RLS cannot solve
-- ----------------------------
-- `monthly_salary` and `payroll_notes` live in the same row as everybody's
-- display name. Every employee legitimately needs to READ every other
-- employee's row — to render an assignee list, a task's owner, an order's
-- salesperson, an asset's custodian. Row-level security filters rows, so any
-- policy permissive enough to let those screens work is also permissive enough
-- to return the salary column. 20260812000000 closed the anon hole by scoping
-- the SELECT policy to `authenticated`; it could not, and did not, stop a
-- signed-in employee from reading a colleague's pay.
--
-- The control is therefore a COLUMN privilege, which is the only mechanism in
-- PostgreSQL that discriminates between columns of a row the caller may see.
--
-- Why the REVOKE has to come first
-- --------------------------------
-- A column-level GRANT is additive and a column-level REVOKE is meaningless
-- while the role still holds table-level SELECT: table-wide privilege satisfies
-- the check for every column, so `REVOKE SELECT (monthly_salary)` alone would
-- change nothing at all. Both `anon` and `authenticated` currently hold
-- table-level SELECT here (Supabase's default `GRANT ALL ON ALL TABLES`), so
-- the table-level grant is dropped and only the safe columns are handed back.
--
-- The visible consequence
-- -----------------------
-- `select('*')` on public.users from a browser client is now an ERROR, not a
-- wide read: Postgres expands `*` to every column and refuses the statement
-- because two of them are not granted. Every browser query must name its
-- columns. src/lib/users/safeColumns.ts holds the shared list and
-- src/lib/users/noStarSelect.test.ts fails if `select('*')` comes back.
--
-- What still reads salary, and why it keeps working
-- -------------------------------------------------
--   * `service_role` is untouched — payroll generation, the payroll engine and
--     the admin review routes read salary exactly as before.
--   * SECURITY DEFINER functions run as the owner, so the ~45 definer functions
--     that read public.users are unaffected. None of them reference either
--     private column (verified against pg_proc).
--   * RLS policies elsewhere that test `EXISTS (SELECT 1 FROM users WHERE
--     id = auth.uid() AND role = 'admin')` reference only `id` and `role`, both
--     of which stay granted.
--
-- Writes
-- ------
-- `anon` and `authenticated` also hold table-level INSERT/UPDATE/DELETE here,
-- and the "Users can update own profile" policy scopes UPDATE to your own row —
-- with no WITH CHECK, and therefore no column restriction. An employee could
-- raise their own `monthly_salary`, which payroll snapshots at generation time.
-- Every write to public.users in this codebase goes through a service-role API
-- route (verified: zero non-service-role insert/update/delete call sites), so
-- these grants are unused by the application and are withdrawn. The row policy
-- is deliberately left in place: if self-service profile editing is built later,
-- it should grant the specific columns, not re-open the table.
--
-- Production safety
-- -----------------
-- Privilege-only. No table, column, index, policy or row is altered, and no data
-- is read or written. Re-running is safe.
--
-- Rollback
-- --------
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO anon, authenticated;
-- restores the previous state exactly — and restores the exposure.

-- ─── SELECT ──────────────────────────────────────────────────────────────────

REVOKE SELECT ON public.users FROM anon, authenticated;

-- Everything except monthly_salary and payroll_notes. Listed explicitly rather
-- than derived, so adding a column to public.users does not silently grant it:
-- a new column is invisible to `authenticated` until someone adds it here,
-- which is the safe default for a table that holds HR data.
GRANT SELECT (
  id,
  full_name,
  email,
  phone,
  role,
  team,
  position,
  is_active,
  created_at,
  updated_at,
  employee_code,
  joining_date,
  office_timing,
  fingerprint_employee_code,
  payroll_active,
  employment_type,
  exit_date,
  performance_tracking_enabled,
  -- performance_tracking_note is deliberately absent. It records management's
  -- reason for holding someone out of performance tracking ("administrative/test
  -- account"), which is an Admin-only HR note in the same sense as payroll_notes.
  -- No browser query reads it — only the admin-gated Team Performance coverage
  -- route does, on the service role — so withholding it costs nothing.
  is_deleted,
  deleted_at,
  deleted_by,
  deletion_scheduled_at
) ON public.users TO authenticated;

-- `anon` gets nothing. The RLS policy from 20260812000000 already returns no
-- rows without a session; withdrawing the privilege as well means the employee
-- directory is closed by two independent mechanisms rather than one.

-- ─── Writes ──────────────────────────────────────────────────────────────────

REVOKE INSERT, UPDATE, DELETE ON public.users FROM anon, authenticated;
