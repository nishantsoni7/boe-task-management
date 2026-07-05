-- Task Team Enum Migration — follow-up to Phase 1 (20260666_convert_users_team_to_text.sql).
--
-- Full review: docs/Module Docs/DEPARTMENT_ASSIGNMENT_MIGRATION_REVIEW.md and
-- the Task Team Enum Impact Review conducted after Phase 1 shipped (not a
-- separate doc — see that session's report). Option B was chosen there.
--
-- tasks.team has been the fixed Postgres enum `task_team` — a separate type
-- from user_team, but with the same original 6 values (sales, operations,
-- design, purchase, bdm, management). 5 task-creation call sites copy the
-- creating user's users.team verbatim into tasks.team:
--   - src/app/tasks/create/page.tsx
--   - src/app/tasks/assigned-by-me/page.tsx
--   - src/app/tasks/my/page.tsx
--   - src/app/tasks/create-self/page.tsx
--   - src/app/tasks/quotation-requests/new/page.tsx
-- Now that users.team is text and can hold any active departments.department_key
-- (Marketing/Admin/HR/etc.), those same 5 call sites will fail at the DB with
-- "invalid input value for enum task_team" the moment a user from a new
-- department tries to create any task — the same failure mode users.team had
-- before Phase 1, just relocated to task creation. This migration closes that
-- gap the same way: convert the column to text, validate against
-- departments.department_key via a trigger, keep the enum type for rollback
-- safety. No fallback/placeholder value is written anywhere — the column
-- keeps meaning "creator's real department," it just accepts any active one.
--
-- Pre-migration dependency check (read-only, run against production before
-- writing this file — mirrors the process from 20260666, where an
-- undiscovered RLS dependency caused a first failed attempt):
--   - pg_depend on tasks.team: exactly one dependent object, `idx_tasks_team`
--     (a plain index — Postgres auto-rebuilds this during ALTER COLUMN TYPE,
--     it does not block the change).
--   - pg_policies on tasks: exactly 4 policies ("Authenticated users can
--     create tasks", "Creator and assignee can update task", "Users can
--     delete tasks they created", "Users can see their tasks"), all gated
--     purely on created_by/assigned_to/delegated_by. None reference `team`.
--   - No views depend on tasks.team (checked via pg_rewrite/pg_depend join).
--   - Conclusion: unlike users.team, no DROP/CREATE POLICY step is needed
--     here — nothing blocks the ALTER. RLS logic is untouched by this file.
--
-- Scope, deliberately narrow:
--   - Only tasks.team. users.team, the permission resolver, and Sample
--     Tracking are entirely unrelated to this column and are not touched.
--   - task_team enum type is NOT dropped — same rollback posture as
--     user_team in 20260666.
--   - No application code is changed by this migration. The 5 creation call
--     sites already just pass `profile.team` (now text) straight through;
--     they need no code change to keep working once this column is text —
--     the enum was the only thing blocking them.
--   - No fallback/default value introduced anywhere — this migration does
--     not change what gets written, only what's allowed to be written.

BEGIN;

-- ─── 1. Convert tasks.team from enum to text ─────────────────────────────────
-- tasks.team is NOT NULL with no default (confirmed via a live
-- information_schema/pg_attribute query before writing this migration).
-- USING team::text carries every existing value across unchanged.

ALTER TABLE public.tasks
  ALTER COLUMN team TYPE text
  USING team::text;

-- public.task_team is intentionally NOT dropped here — see rollback note above.

-- ─── 2. Validation trigger — mirrors validate_user_team_department() ────────
-- tasks.team is NOT NULL — every task should carry a real, currently-active
-- department. Rejects NULL and blank/whitespace-only strings explicitly,
-- same as the users.team trigger, before checking against departments.

CREATE OR REPLACE FUNCTION public.validate_task_team_department()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.team IS NULL OR btrim(NEW.team) = '' THEN
    RAISE EXCEPTION 'tasks.team must be a valid active department key'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.departments d
    WHERE d.department_key = NEW.team
      AND d.is_active = true
  ) THEN
    RAISE EXCEPTION 'Invalid department key for tasks.team: %', NEW.team
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_task_team_department_trigger ON public.tasks;

CREATE TRIGGER validate_task_team_department_trigger
  BEFORE INSERT OR UPDATE OF team ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_task_team_department();

COMMIT;
