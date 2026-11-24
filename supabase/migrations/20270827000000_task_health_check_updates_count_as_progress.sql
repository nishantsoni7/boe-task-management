-- run_task_health_check: an update on a task counts as progress, and a task that
-- shows progress stops being flagged stale.
--
-- THE BUG. The hourly job flagged a started/working task as stale when it had
-- no `status_changed` row in the last 6 days. A comment, a "Send Update" or an
-- attached file is written as a `note_added` row, so the job could not see them:
-- a task being discussed daily was flagged "same status for 5+ days with no
-- progress". Reported on "513 Bharghav" (Working since 17 Nov, five updates in
-- the following days, flagged 24 Nov 12:30 IST two minutes after one of them).
-- Its `stale_day_count` read 0 at the same time, because that figure was taken
-- from `last_update_at`, which a comment moves, while the flag was decided from
-- the status history alone.
--
-- A SECOND BUG, WHICH THE FIRST HIDES. Nothing ever took the flag down: the job
-- only ever set `is_stale = true`, and no code or trigger sets it back. A task
-- flagged wrongly stayed flagged however much was written on it afterwards, so
-- fixing the test alone would not repair "513 Bharghav".
--
-- WHAT CHANGES, in the stale block only:
--   1. Progress is the newest `status_changed` OR `note_added` row of the task.
--      The task is stale when there is none, or the newest is older than 6 days,
--      and the task itself is at least 5 days old (that clause is unchanged).
--   2. `stale_day_count` is the whole days since that progress row (or since the
--      task was created when there is none), so the figure and the flag agree.
--   3. A started/working task that is flagged but no longer meets the test is
--      un-flagged: `is_stale = false`, `stale_day_count = 0`.
-- `days_same_status` is replaced by `last_progress_at`; nothing else in the
-- DECLARE section moves.
--
-- WHAT IS DELIBERATELY NOT CHANGED. The task selection and its
-- `status NOT IN ('completed', 'blocked')` filter; the overdue-and-silent
-- CONTINUE; the waiting CONTINUE; the 6-day window and the 5-day age clause
-- (the stored line says "5+ days", which a 6-day silence satisfies, and it is
-- the exact text an existing row is deduplicated on, so it is not reworded); the
-- `stale_flagged` activity line, written once per task and guarded as before;
-- `LANGUAGE plpgsql`; `RETURNS void`; the signature; and SECURITY INVOKER (the
-- default, which pg_get_functiondef does not print). No notification, no
-- `escalated` line, no cron entry, no grant or ownership statement.
--
-- WHO IS COUNTED. Anyone's update: the assignee's or the creator's. This matches
-- the rest of the app, where either person's comment moves `last_update_at` and
-- the "needs update" views. Editing a task's description is also a `note_added`
-- row, so it counts as an update too.
--
-- WHAT IS NOT TOUCHED. A flag on a task that is waiting, blocked, completed or
-- cancelled (the loop skips those tasks, as it always did, so nothing takes
-- their flag down; at the time of writing 156 of the 169 flagged tasks were
-- completed or cancelled). The `stale_flagged` line already in a task's Activity
-- stays: nothing is deleted.
--
-- FIRST RUN AFTER APPLYING. The next hourly run re-evaluates the 13 working tasks
-- that carry the flag today: those with an update or status change in the last 6
-- days are un-flagged, the rest keep it with a day count measured from their last
-- progress. The flag columns are derived, so there is nothing to back up.
--
-- NO CRON CHANGE. The schedule is untouched; it calls the same function.
-- APPLY ORDER: this file replaces one function body and depends on nothing; no
-- application code changes with it, so it may be applied before or after the merge.
--
-- ROLLBACK: run the CREATE OR REPLACE statement in
-- 20270610000000_task_health_check_stops_escalating.sql (the function exactly as it
-- is before this change). The next hourly run flags by the old rule again.
--
-- REQUIRES: nothing. It replaces one function body and touches no table, row,
-- cron entry, grant or ownership.

CREATE OR REPLACE FUNCTION public.run_task_health_check()
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  t RECORD;
  hours_since_update NUMERIC;
  last_progress_at TIMESTAMPTZ;
BEGIN
  FOR t IN
    SELECT * FROM tasks
    WHERE status NOT IN ('completed', 'blocked')
  LOOP

    hours_since_update := EXTRACT(EPOCH FROM (now() - t.last_update_at)) / 3600;

    IF t.due_date IS NOT NULL
       AND now() > t.due_date
       AND hours_since_update >= 24 THEN
      CONTINUE;
    END IF;

    IF t.status = 'waiting' THEN
      CONTINUE;
    END IF;

    IF t.type = 'completion'
       AND t.status IN ('started', 'working') THEN

      SELECT MAX(created_at) INTO last_progress_at
      FROM task_activity_log
      WHERE task_id = t.id
        AND action IN ('status_changed', 'note_added');

      IF (last_progress_at IS NULL OR last_progress_at < now() - INTERVAL '6 days')
         AND EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400 >= 5 THEN

        UPDATE tasks
        SET is_stale = true,
            stale_day_count =
              FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(last_progress_at, t.created_at))) / 86400)
        WHERE id = t.id;

        IF NOT EXISTS (
          SELECT 1 FROM task_activity_log
          WHERE task_id = t.id
            AND action = 'stale_flagged'
            AND note = 'Auto-flagged: same status for 5+ days with no progress'
        ) THEN
          INSERT INTO task_activity_log (task_id, actor_id, action, note)
          VALUES (
            t.id,
            t.created_by,
            'stale_flagged',
            'Auto-flagged: same status for 5+ days with no progress'
          );
        END IF;

      ELSIF t.is_stale THEN

        UPDATE tasks
        SET is_stale = false,
            stale_day_count = 0
        WHERE id = t.id;

      END IF;
    END IF;

  END LOOP;
END;
$function$;
