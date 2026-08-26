-- Migration 115: run_task_health_check stops writing notifications.
--
-- NOT APPLIED. This file has not been pushed. Its bytes are still the
-- repository's to correct, which is why it is absent from the FROZEN list in
-- src/lib/finance/participantAndOrderTotalSecurity.test.ts — it joins that list
-- on the day `supabase db push` runs it and not before.
--
-- APPLY ORDER: after 114, with 109-114 ahead of it. It depends on none of them
-- — it replaces one function body and touches no table, row, cron entry, grant
-- or ownership — but a file that lands in front of a lower-numbered one leaves
-- that one permanently behind the remote's last applied migration. Push
-- 109 … 114, then 115.
--
-- WHAT THE JOB IS. An hourly pg_cron function that walks open tasks and records
-- three things in the permanent activity history: an escalation when a task is
-- overdue with no action for 24 hours, an escalation when there has been no
-- update for 72 hours, and a stale flag when a completion task has sat in the
-- same status for 5+ days. All three are kept, byte for byte.
--
-- WHAT IT ALSO DID, AND NO LONGER DOES. Alongside those records it inserted
-- four kinds of `notifications` row — one `overdue` and three `escalation`
-- (24h, 48h, 72h). Nobody can act on any of them: an escalation is an
-- observation about a task, not a request that somebody do something. They were
-- also written with NO deduplication, unlike the activity-log writes right next
-- to them, which are each guarded by `IF NOT EXISTS`. So every hourly run added
-- another row for the same task, for as long as the condition held — roughly
-- 16,000 of them accumulated, and no screen has ever displayed one.
--
-- THE 24-HOUR AND 48-HOUR BRANCHES DID NOTHING ELSE. Removing their inserts
-- leaves `ELSIF … THEN` with an empty body, so the branches go too rather than
-- staying as dead conditionals. This is behaviour-preserving: in the original
-- chain a task with 48 <= hours < 72 took the 48h branch and a task with
-- 24 <= hours < 48 took the 24h branch, and in both cases the ONLY effect was
-- the notification. With the branches gone those tasks fall through the `IF`
-- and do nothing, which is what they now did anyway.
--
-- WHAT IS DELIBERATELY NOT CHANGED. The task selection and its
-- `status NOT IN ('completed', 'blocked')` filter; the overdue CONTINUE; the
-- waiting CONTINUE; every threshold (24h, 48h, 72h, 6 days, 5 days); the
-- `IF NOT EXISTS` dedup guards on the three activity writes; the stale
-- calculation and the `tasks` UPDATE it performs; `LANGUAGE plpgsql`;
-- `RETURNS void`; the signature; and SECURITY INVOKER, which is the default and
-- which pg_get_functiondef therefore does not print — its absence below is the
-- faithful copy, not an omission.
--
-- NO ownership, GRANT or REVOKE statement is included. CREATE OR REPLACE
-- preserves both for an existing signature, so restating them could only differ
-- from production, never match it more closely. No `SET search_path` is added
-- either: the production function reports no proconfig, and adding one would
-- change how it resolves names at runtime.
--
-- NO CRON CHANGE. The schedule is untouched; the job keeps firing exactly as
-- often as it does today, and does less each time.
--
-- NO HISTORICAL ROW IS DELETED. The ~16k rows already written stay. They are
-- invisible either way — src/lib/notifications.ts excludes these types by name
-- from the feed, the badge count, mark-all-read and delete-all — and they are
-- the only evidence of what this job has been doing. Removing them is a
-- separate decision and would need its own reviewed migration.
--
-- ROLLBACK: run docs/proposals/run_task_health_check.production.sql, which is
-- this function's pre-change definition captured verbatim.
--
-- REQUIRES: nothing. It replaces one function body and touches nothing else.

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

      IF NOT EXISTS (
        SELECT 1 FROM task_activity_log
        WHERE task_id = t.id
          AND action = 'escalated'
          AND note = 'Auto-escalated: overdue with no action for 24 hours'
      ) THEN
        INSERT INTO task_activity_log (task_id, actor_id, action, note)
        VALUES (
          t.id,
          t.created_by,
          'escalated',
          'Auto-escalated: overdue with no action for 24 hours'
        );
      END IF;

      CONTINUE;
    END IF;

    IF t.status = 'waiting' THEN
      CONTINUE;
    END IF;

    IF hours_since_update >= 72 THEN

      IF NOT EXISTS (
        SELECT 1 FROM task_activity_log
        WHERE task_id = t.id
          AND action = 'escalated'
          AND note = 'Auto-escalated: no update for 72 hours'
      ) THEN
        INSERT INTO task_activity_log (task_id, actor_id, action, note)
        VALUES (
          t.id,
          t.created_by,
          'escalated',
          'Auto-escalated: no update for 72 hours'
        );
      END IF;

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
