-- run_task_health_check stops writing "Auto-escalated" lines into task Activity.
--
-- The owner asked for the escalation feature to be removed: it "is not solving
-- any purpose and just sends comments and messages on repeat after certain
-- hours". What it really did, since 20261015000000 stopped its notifications,
-- was add two lines to a task's permanent Activity history, written under the
-- task CREATOR's name (so it read like a person had escalated their own task):
--
--   'Auto-escalated: overdue with no action for 24 hours'
--   'Auto-escalated: no update for 72 hours'
--
-- Both are gone from the function below. Nothing is deleted: every line the job
-- has already written stays in task_activity_log, and the app now hides them.
--
-- WHAT IS DELIBERATELY NOT CHANGED. The stale flag is a separate feature the
-- owner did not ask to remove: the `is_stale` / `stale_day_count` update, the
-- 'stale_flagged' line, their conditions and thresholds, the task selection, the
-- waiting skip, LANGUAGE plpgsql, RETURNS void, the signature, and SECURITY
-- INVOKER (the default, which pg_get_functiondef does not print) are all
-- carried over from 20261015000000 character for character.
--
-- WHY A BRANCH THAT ONLY SAYS CONTINUE IS STILL HERE. In the old function an
-- overdue task that had been silent for 24 hours wrote its line and then
-- skipped the rest of the loop, so it never reached the stale check. Dropping
-- that branch would let those tasks reach the stale check and be flagged as
-- stale when they were not before. The line it wrote is gone; the skip stays,
-- so the stale flag marks exactly the tasks it marked yesterday.
--
-- NO CRON CHANGE. The hourly schedule is untouched; it calls the same function,
-- which now does less. NO grant, revoke, owner or search_path statement:
-- CREATE OR REPLACE keeps the existing ones for an unchanged signature.
-- APPLY ORDER: either order with the code is safe. The code only hides old
-- lines; this file only stops new ones.
--
-- ROLLBACK: run the CREATE OR REPLACE statement in
-- 20261015000000_task_health_check_stops_notifying.sql (the function exactly as
-- it is before this change). The next hourly run then resumes writing the two
-- lines, once per task as before.
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
  days_same_status INTEGER;
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

      SELECT COUNT(*) INTO days_same_status
      FROM task_activity_log
      WHERE task_id = t.id
        AND action = 'status_changed'
        AND created_at > now() - INTERVAL '6 days';

      IF days_same_status = 0
         AND EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400 >= 5 THEN

        UPDATE tasks
        SET is_stale = true,
            stale_day_count =
              FLOOR(EXTRACT(EPOCH FROM (now() - t.last_update_at)) / 86400)
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

      END IF;
    END IF;

  END LOOP;
END;
$function$;
