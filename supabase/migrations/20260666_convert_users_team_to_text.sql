-- Department Assignment Migration — Phase 1.
--
-- users.team has been the fixed Postgres enum `user_team` (sales, operations,
-- design, purchase, bdm, management). Control Center's departments table
-- (department_key, text, admin-editable — 20260645_create_control_center_v1.sql)
-- lets admins create new departments (e.g. "hr", "marketing"), but those
-- could never be assigned to a person: the enum rejects any label it doesn't
-- know about ("invalid input value for enum user_team"). Full review in
-- docs/Module Docs/DEPARTMENT_ASSIGNMENT_MIGRATION_REVIEW.md.
--
-- This migration converts users.team from the enum to text so it can hold
-- any department_key Control Center creates, and replaces the enum's
-- input validation with a trigger that checks the new value against
-- departments.department_key (active departments only). A trigger is used
-- instead of a CHECK constraint because CHECK cannot safely query another
-- table.
--
-- First apply attempt (this same file, pre-policy-fix) failed safely against
-- production with:
--   ERROR: 0A000: cannot alter type of a column used in a policy definition
--   DETAIL: policy orders_operations_select on table orders depends on
--   column "team"
-- Postgres won't change a column's type while any RLS policy references it,
-- even though the comparison itself (a literal like users.team = 'operations')
-- works identically under enum or text. Verified via live `pg_policies`
-- inspection (read-only) that exactly 4 policies reference users.team, all
-- on orders/order_activity_log, none on Sample Tracking or anything else:
--   - orders_operations_select              (orders, SELECT)
--   - orders_operations_update               (orders, UPDATE)
--   - order_activity_log_operations_select   (order_activity_log, SELECT)
--   - order_activity_log_operations_insert   (order_activity_log, INSERT)
-- This migration now drops exactly those 4, converts the column, then
-- recreates them with byte-identical logic (copied verbatim from their
-- defining migrations, 20260655_create_orders.sql and
-- 20260656_create_order_activity_log.sql — the literal 'operations' compare
-- needs no cast adjustment, since an unadorned text literal binds directly
-- to a text column). No other policy on either table references team and
-- none of those are touched.
--
-- Scope, deliberately narrow:
--   - Only users.team, plus the 4 Orders/order_activity_log policies that
--     physically block the type change. Orders RLS *logic* is unchanged —
--     only dropped and recreated identically so the ALTER can run.
--   - tasks.team (a separate enum, task_team) is untouched — that coupling
--     (task creation copies the creator's users.team into the new task) is
--     a distinct, out-of-scope follow-up decision per the review.
--   - The user_team enum type itself is NOT dropped here, so a rollback is a
--     simple ALTER COLUMN back to the enum as long as no row has since been
--     assigned a value the enum doesn't know (see review §10 for the caveat).
--   - No FK added — a trigger-enforced text match against departments,
--     preserving the resolver's existing behavior (see below) rather than
--     introducing a new relational dependency.
--   - Sample Tracking (employee_permissions, has_permission(), sample_dispatches
--     RLS) is entirely unrelated to this column and is not touched.
--   - The centralized permission resolver (resolve_permission(),
--     resolve_effective_permissions*()) is not touched by this migration.
--
-- Resolver impact: resolve_effective_permissions() and
-- resolve_effective_permissions_for_user() (20260662_fix_permission_resolver_team_cast.sql)
-- already join `departments d ON d.department_key = u.team::text` — that
-- cast becomes a harmless no-op (text::text) once this migration lands. No
-- change to those functions is required for correctness; they are left
-- exactly as-is on purpose (removing the now-redundant cast is a separate,
-- optional cosmetic cleanup, not bundled into this migration to keep this
-- change minimal and reviewable).

-- All-or-nothing: everything from the policy drops through the trigger
-- creation runs in a single transaction, so a mid-migration failure can't
-- leave Orders RLS with its policies dropped and not recreated.
BEGIN;

-- ─── 1. Drop the RLS policies that depend on users.team ─────────────────────
-- Exact names and definitions confirmed via a live, read-only `pg_policies`
-- query before writing this section — not assumed from the migration files.

DROP POLICY IF EXISTS "orders_operations_select" ON public.orders;
DROP POLICY IF EXISTS "orders_operations_update" ON public.orders;
DROP POLICY IF EXISTS "order_activity_log_operations_select" ON public.order_activity_log;
DROP POLICY IF EXISTS "order_activity_log_operations_insert" ON public.order_activity_log;

-- ─── 2. Convert users.team from enum to text ─────────────────────────────────
-- users.team is NOT NULL with no default (confirmed via schema.json's
-- required-columns list, and reconfirmed via a live information_schema
-- query before writing this migration) — preserved as-is.
-- USING team::text carries every existing value across unchanged.

ALTER TABLE public.users
  ALTER COLUMN team TYPE text
  USING team::text;

-- public.user_team is intentionally NOT dropped here — see rollback note above.

-- ─── 3. Recreate the 4 dropped policies — identical logic, unchanged ────────
-- Copied verbatim from 20260655_create_orders.sql and
-- 20260656_create_order_activity_log.sql. No adjustment to the comparison
-- was needed: users.team = 'operations' binds the literal as text now that
-- the column is text, which is the same runtime behavior as before.

CREATE POLICY "orders_operations_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  );

CREATE POLICY "orders_operations_update" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  );

CREATE POLICY "order_activity_log_operations_select" ON public.order_activity_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  );

CREATE POLICY "order_activity_log_operations_insert" ON public.order_activity_log
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  );

-- ─── 4. Validation trigger — replaces the enum's input validation ───────────
-- users.team is NOT NULL — BOE users should always have a valid department.
-- Rejects NULL and blank/whitespace-only strings explicitly (rather than
-- silently letting them through) before checking against departments, since
-- the People-edit UI's pre-existing "— No department —" option sends an
-- empty string, and that should not be allowed to bypass the department
-- check any more than NULL should.

CREATE OR REPLACE FUNCTION public.validate_user_team_department()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.team IS NULL OR btrim(NEW.team) = '' THEN
    RAISE EXCEPTION 'users.team must be a valid active department key'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.departments d
    WHERE d.department_key = NEW.team
      AND d.is_active = true
  ) THEN
    RAISE EXCEPTION 'Invalid department key for users.team: %', NEW.team
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_user_team_department_trigger ON public.users;

CREATE TRIGGER validate_user_team_department_trigger
  BEFORE INSERT OR UPDATE OF team ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_user_team_department();

COMMIT;
