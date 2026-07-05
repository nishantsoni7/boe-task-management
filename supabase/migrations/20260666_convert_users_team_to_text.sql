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
-- Scope, deliberately narrow:
--   - Only users.team. tasks.team (a separate enum, task_team) is untouched —
--     that coupling (task creation copies the creator's users.team into the
--     new task) is a distinct, out-of-scope follow-up decision per the review.
--   - The user_team enum type itself is NOT dropped here, so a rollback is a
--     simple ALTER COLUMN back to the enum as long as no row has since been
--     assigned a value the enum doesn't know (see review §10 for the caveat).
--   - No FK added — a trigger-enforced text match against departments,
--     preserving the resolver's existing behavior (see below) rather than
--     introducing a new relational dependency.
--   - Sample Tracking (employee_permissions, has_permission(), sample_dispatches
--     RLS) is entirely unrelated to this column and is not touched.
--
-- Resolver impact: resolve_effective_permissions() and
-- resolve_effective_permissions_for_user() (20260662_fix_permission_resolver_team_cast.sql)
-- already join `departments d ON d.department_key = u.team::text` — that
-- cast becomes a harmless no-op (text::text) once this migration lands. No
-- change to those functions is required for correctness; they are left
-- exactly as-is on purpose (removing the now-redundant cast is a separate,
-- optional cosmetic cleanup, not bundled into this migration to keep this
-- change minimal and reviewable).

-- ─── 1. Convert users.team from enum to text ─────────────────────────────────
-- users.team is NOT NULL with no default (confirmed via schema.json's
-- required-columns list before writing this migration) — preserved as-is.
-- USING team::text carries every existing value across unchanged.

ALTER TABLE public.users
  ALTER COLUMN team TYPE text
  USING team::text;

-- public.user_team is intentionally NOT dropped here — see rollback note above.

-- ─── 2. Validation trigger — replaces the enum's input validation ───────────
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
