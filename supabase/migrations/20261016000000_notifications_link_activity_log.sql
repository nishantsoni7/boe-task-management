-- 116. NOT APPLIED.
--
-- Link a task notification to the EXACT activity row that caused it.
--
-- ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
--
-- A `notifications` row carries: id, user_id, task_id, entity_id, type, title,
-- body, is_read, is_push_sent, is_digest, created_at, read_at. Every task
-- notification stores the actor sentence in `title` and the task title in
-- `body`. So the notification feed can say WHAT happened, but never:
--
--   * one line of the comment somebody actually wrote
--   * the status a task moved FROM
--   * who acted, as an id rather than a name parsed out of prose
--
-- All three already exist, one table over: `task_activity_log` holds `note`,
-- `from_status`, `to_status` and `actor_id` for the very event the notification
-- announces. What has never existed is a link between the two rows. The only
-- thing joining them today is (task_id, created_at), and matching on a
-- timestamp is a guess dressed as data — two events on one task in the same
-- second would silently swap their details.
--
-- One nullable foreign key ends that. Future writers record the id they already
-- hold; the feed joins it in one bounded batch; historical rows keep the
-- fallbacks they have now.
--
-- ── WHY ON DELETE SET NULL, AND NOT THE CASCADE USED ELSEWHERE ──────────────
--
-- `task_attachments.activity_log_id` (20260619) uses ON DELETE CASCADE, and
-- that is right THERE: an attachment on a comment is meaningless once the
-- comment is gone.
--
-- It would be wrong here, and not theoretically. Activity rows ARE deleted, by
-- two live application paths:
--
--   /api/admin-delete-tasks      deletes task_activity_log for the tasks first,
--                                then the tasks (there is no cascade from
--                                `tasks`; the route does it by hand and says so)
--   /api/permanently-delete-user deletes activity rows for the user's tasks AND
--                                every row where they were the ACTOR
--
-- Under CASCADE, that second one is the problem: deleting the activity rows a
-- departing employee authored would delete OTHER PEOPLE'S notifications about
-- tasks that person once touched. Nobody asked for that and nothing would
-- report it.
--
-- Under SET NULL the notification survives with its link cleared, and the feed
-- renders exactly what it renders for every historical row — "Comment added",
-- "Status updated". A notification degrades; it does not vanish.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────
--
--   * NO BACKFILL. Nothing populates the column for existing rows. The only
--     way to would be the timestamp matching this exists to avoid.
--   * NO TRIGGER. Nothing infers a link at write time either, for the same
--     reason: a trigger that guesses is a guess that runs forever.
--   * NO NOT NULL, NO DEFAULT. Every existing row stays valid and unchanged.
--   * NO CHANGE TO `task_activity_log` — not one column, constraint or policy.
--   * NO CHANGE TO RLS. `notifications` carries no policy in this repository's
--     migrations, and every notification endpoint reads through the
--     service-role key with an explicit `.eq('user_id', caller)`. Authorization
--     for the new detail is therefore an APPLICATION concern and is enforced
--     there: the read path only ever looks up activity ids it collected from
--     the caller's own notification rows, so it cannot reach an activity row
--     the caller was not already being told about.
--   * NO CHANGE TO MIGRATION 115, or to any other applied migration.
--   * NO CHANGE TO `transition_task_review()`. That function creates the
--     activity row and the notification together and already holds the id in
--     `v_log_id`, so linking its three events is a one-line addition to its
--     INSERT — but it is a CREATE OR REPLACE of a live function, and this
--     repository's rule (learned the hard way on run_task_health_check) is that
--     a function is replaced from its VERIFIED PRODUCTION DEFINITION, never
--     from the repository's copy. That companion change is reported for
--     approval, not guessed at here.
--
-- Additive, idempotent, and reversible by dropping one column.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS activity_log_id uuid
  REFERENCES task_activity_log(id) ON DELETE SET NULL;

-- ── The one index, and an honest reason for it ───────────────────────────────
--
-- NOT for the read path. The feed batches on `task_activity_log.id` — the
-- primary key, already indexed — and never selects notifications BY
-- activity_log_id.
--
-- It is for the REFERENTIAL ACTION. Every delete of a `task_activity_log` row
-- makes Postgres find the notifications referencing it so it can null them, and
-- without an index that is a sequential scan of `notifications` per deleted
-- row. /api/permanently-delete-user deletes activity rows in bulk, so that is
-- not a hypothetical cost.
--
-- Partial, because every row written before this migration is null and always
-- will be: the index covers only rows that actually carry a link.
CREATE INDEX IF NOT EXISTS notifications_activity_log_id_idx
  ON notifications (activity_log_id)
  WHERE activity_log_id IS NOT NULL;

COMMENT ON COLUMN notifications.activity_log_id IS
  'The exact task_activity_log row this notification announces. Null for every row written before 20261016000000, and null again if that activity row is deleted — both render the historical fallbacks. Never inferred from a timestamp.';
