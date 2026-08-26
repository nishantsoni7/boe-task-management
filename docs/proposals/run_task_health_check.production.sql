-- ═══════════════════════════════════════════════════════════════════════════
--  BASELINE — public.run_task_health_check() AS IT EXISTS IN PRODUCTION.
--
--  Captured from A1 (pg_get_functiondef) before the replacement migration
--  supabase/migrations/20261015000000_task_health_check_stops_notifying.sql.
--
--  THIS FILE IS THE ROLLBACK SCRIPT. Running it as-is restores the function
--  exactly as it was, notification inserts included. Nothing else needs undoing:
--  the migration touches no table, no row, no cron entry, no grant and no
--  ownership, so re-running this text is the whole reversal, and the next
--  scheduled fire resumes the old behaviour.
--
--  It is ALSO the reference the migration is diffed against —
--  src/lib/tasks/healthCheckMigrationAudit.test.ts reads both files and proves
--  that the only lines removed are the four notification inserts and the two
--  now-empty ELSIF branches, and that no line was added or altered.
--
--  DO NOT EDIT. A change here silently redefines what "unchanged" means.
-- ═══════════════════════════════════════════════════════════════════════════

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

      INSERT INTO notifications (user_id, task_id, type, title, body, is_push_sent)
      VALUES (
        t.created_by,
        t.id,
        'overdue',
        'Task overdue - no action taken',
        'This task passed its deadline 24 hours ago with no update.',
        true
      );

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

      INSERT INTO notifications (user_id, task_id, type, title, body, is_push_sent)
      VALUES (
        t.assigned_to,
        t.id,
        'escalation',
        'Task escalated to senior',
        'No update recorded for 72 hours.',
        true
      );

    ELSIF hours_since_update >= 48 THEN

      INSERT INTO notifications (user_id, task_id, type, title, body, is_push_sent)
      VALUES (
        t.assigned_to,
        t.id,
        'escalation',
        'Danger zone - task needs update',
        'No update recorded for 48 hours.',
        true
      );

    ELSIF hours_since_update >= 24 THEN

      INSERT INTO notifications (user_id, task_id, type, title, body, is_push_sent)
      VALUES (
        t.assigned_to,
        t.id,
        'escalation',
        'Caution - task update overdue',
        'No update recorded for 24 hours.',
        true
      );

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
