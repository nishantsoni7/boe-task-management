-- 116. NOT APPLIED.
--
-- Link a task notification to the EXACT activity row that caused it, and make
-- the one function that writes both rows record it.
--
-- ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
--
-- A `notifications` row carries: id, user_id, task_id, entity_id, type, title,
-- body, is_read, is_push_sent, is_digest, created_at, read_at. Every task
-- notification stores the actor sentence in `title` and the task title in
-- `body`. So the feed can say WHAT happened, but never:
--
--   * one line of the comment somebody actually wrote
--   * the status a task moved FROM
--   * who acted, as an id rather than a name parsed out of prose
--
-- All three exist one table over: `task_activity_log` holds `note`,
-- `from_status`, `to_status` and `actor_id` for the very event the notification
-- announces. What has never existed is a link. The only thing joining them
-- today is (task_id, created_at), and matching on a timestamp is a guess
-- dressed as data — two events on one task in the same second would silently
-- swap their details.
--
-- ── ORDER MATTERS, AND THIS IS WHY ──────────────────────────────────────────
--
-- Running the function replacement first produces:
--
--   ERROR 42703: column "activity_log_id" of relation "notifications"
--                does not exist
--
-- because the function body references a column that is not there yet. The
-- three steps below are therefore ordered, in one transaction:
--
--   1. add the column
--   2. add its foreign key and index
--   3. replace the function, which may now reference it
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
-- Under CASCADE that second one is the problem: deleting the activity rows a
-- departing employee authored would delete OTHER PEOPLE'S notifications about
-- tasks that person once touched. Nobody asked for that and nothing would
-- report it.
--
-- Under SET NULL the notification survives with its link cleared, and renders
-- exactly what it renders for every historical row — "Comment added", "Status
-- updated". A notification degrades; it does not vanish.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
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
--     for the new detail is an APPLICATION concern and is enforced there: the
--     read path only looks up activity ids collected from the caller's own
--     notification rows.
--   * NO CHANGE TO MIGRATION 115, or to any other applied migration.
--   * NO CHANGE TO THE FUNCTION'S SIGNATURE, VOLATILITY, SECURITY MODE,
--     search_path, GRANTS or BEHAVIOUR. See step 3.
--
-- Additive and idempotent. Reversible by dropping the column and re-running
-- 20260833000000's function body.


-- ═══ 1. The column ══════════════════════════════════════════════════════════
--
-- Nullable, no default. Added before anything references it.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS activity_log_id uuid;

COMMENT ON COLUMN notifications.activity_log_id IS
  'The exact task_activity_log row this notification announces. Null for every row written before 20261016000000, and null again if that activity row is deleted — both render the historical fallbacks. Never inferred from a timestamp.';


-- ═══ 2. The foreign key, and the index the referential action needs ═════════
--
-- The constraint is added separately from the column so this migration can be
-- read as the three steps it is, and so re-running it is safe: ADD CONSTRAINT
-- has no IF NOT EXISTS, so it is guarded by a catalog check rather than left to
-- fail on a second run.
--
-- `notifications_activity_log_id_fkey` is the name PostgreSQL would generate
-- for this constraint anyway; naming it explicitly is what makes the guard
-- above able to look for it.

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_activity_log_id_fkey'
      AND conrelid = 'public.notifications'::regclass
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_activity_log_id_fkey
      FOREIGN KEY (activity_log_id)
      REFERENCES public.task_activity_log(id)
      ON DELETE SET NULL;
  END IF;
END
$do$;

-- THE INDEX, AND AN HONEST REASON FOR IT.
--
-- NOT for the read path. The feed batches on `task_activity_log.id` — the
-- primary key, already indexed — and never selects notifications BY
-- activity_log_id.
--
-- It is for the REFERENTIAL ACTION. Every delete of a `task_activity_log` row
-- makes PostgreSQL find the notifications referencing it so it can null them,
-- and without an index that is a sequential scan of `notifications` per deleted
-- row. /api/permanently-delete-user deletes activity rows in bulk, so that is
-- not a hypothetical cost.
--
-- Partial, because every row written before this migration is null and always
-- will be: the index covers only rows that actually carry a link.

CREATE INDEX IF NOT EXISTS notifications_activity_log_id_idx
  ON public.notifications (activity_log_id)
  WHERE activity_log_id IS NOT NULL;


-- ═══ 3. The function that writes both rows, now recording the link ══════════
--
-- transition_task_review() is the ONLY path by which a delegated ordinary task
-- reaches pending_approval or completed. It inserts the activity row and the
-- notification in ONE transaction and already captures the activity id in
-- `v_log_id` — it even returns it to the caller as `activity_id`. So linking
-- its three events (submit / approve / return) is one column and one value,
-- and it stays atomic: there is no window in which the notification exists
-- without its link.
--
-- ── WHERE THIS BODY CAME FROM, STATED PLAINLY ───────────────────────────────
--
-- From 20260833000000_task_creator_approval.sql — the migration that CREATED
-- this function — verified to be the last migration that defines it (20260832
-- and 20260834 reference it; neither replaces it).
--
-- It is NOT from `pg_get_functiondef` against production. No such capture
-- exists in this repository for this function; the only production definition
-- ever captured here is docs/proposals/run_task_health_check.production.sql,
-- which is a different function. If production has been hot-patched since
-- 20260833000000, the repository would not know.
--
-- SO THE REPLACEMENT REFUSES TO RUN BLIND. The guard below reads the CURRENT
-- definition out of the catalog and aborts unless it is the one this was based
-- on — specifically, unless it still contains the exact INSERT being changed
-- and does not already carry the new column. A drifted or already-patched
-- production function stops this migration with a message instead of being
-- silently overwritten.
--
-- ── THE DIFF IS TWO LINES ───────────────────────────────────────────────────
--
--   -    insert into public.notifications (user_id, task_id, type, title, body, is_push_sent)
--   -    values (v_recipient, p_task_id, 'task_acknowledged', v_title, v_task.title, true);
--   +    insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id)
--   +    values (v_recipient, p_task_id, 'task_acknowledged', v_title, v_task.title, true, v_log_id);
--
-- Nothing else. Every authorization check, every source-status check, the
-- `for update` lock, both set_config() calls, the stale-field clearing, the
-- returned jsonb and the grants are byte-for-byte what 20260833000000 wrote.
-- src/lib/notifications/activityLinkMigration.test.ts re-derives that diff
-- mechanically from the two files and fails if it is ever more than these
-- two lines.

DO $do$
DECLARE
  v_current text;
BEGIN
  SELECT pg_get_functiondef('public.transition_task_review(uuid, text, text)'::regprocedure)
    INTO v_current;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_MISSING: the function does not exist; 20260833000000 has not been applied';
  END IF;

  IF position('activity_log_id' in v_current) > 0 THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_ALREADY_LINKED: the live function already references activity_log_id; inspect it before replacing it';
  END IF;

  IF position('insert into public.notifications (user_id, task_id, type, title, body, is_push_sent)' in v_current) = 0 THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_DRIFTED: the live function is not the definition this migration was written against (20260833000000). Capture it with pg_get_functiondef and rebase this step before applying.';
  END IF;
END
$do$;

create or replace function public.transition_task_review(
  p_task_id uuid,
  p_action  text,
  p_note    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_task       public.tasks%rowtype;
  v_from       text;
  v_note       text := nullif(btrim(coalesce(p_note, '')), '');
  v_actor_name text;
  v_recipient  uuid;
  v_title      text;
  v_log_id     uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required to review a task'
      using errcode = '28000';
  end if;

  if p_action not in ('submit', 'approve', 'return') then
    raise exception 'TASK_REVIEW_INVALID_ACTION: action must be submit, approve or return'
      using errcode = '22023';
  end if;

  select * into v_task from public.tasks where id = p_task_id for update;

  if not found then
    raise exception 'TASK_NOT_FOUND: That task no longer exists'
      using errcode = 'P0002';
  end if;

  v_from := v_task.status::text;

  -- Quotation requests keep their own completion workflow, untouched.
  if coalesce(v_task.task_type, 'general') = 'quotation_request' then
    raise exception 'TASK_REVIEW_NOT_APPLICABLE: A quotation request is completed through its own workflow'
      using errcode = '42501';
  end if;

  -- A self-created, self-assigned task has nobody to approve to and stays
  -- directly completable.
  if v_task.created_by is null
     or v_task.assigned_to is null
     or v_task.created_by = v_task.assigned_to then
    raise exception 'TASK_REVIEW_NOT_DELEGATED: Only a task assigned to someone else goes through creator approval'
      using errcode = '42501';
  end if;

  select u.full_name into v_actor_name from public.users u where u.id = v_uid;
  v_actor_name := coalesce(nullif(btrim(v_actor_name), ''), 'Someone');

  if p_action = 'submit' then
    if v_uid <> v_task.assigned_to then
      raise exception 'TASK_REVIEW_FORBIDDEN: Only the assignee can submit this task for approval'
        using errcode = '42501';
    end if;
    -- The same acknowledgement gate the old Mark Complete carried: a completion
    -- record always follows an accepted assignment.
    if v_task.acknowledged_at is null then
      raise exception 'TASK_NOT_ACKNOWLEDGED: Acknowledge this task before submitting it for approval'
        using errcode = '42501';
    end if;
    -- Exactly the statuses Mark Complete used to be offered from.
    if v_from not in ('pending', 'started', 'working', 'waiting', 'blocked') then
      raise exception 'TASK_REVIEW_INVALID_SOURCE: A task in % cannot be submitted for approval', v_from
        using errcode = '55000';
    end if;
    v_recipient := v_task.created_by;
    v_title     := v_actor_name || ' submitted task for approval';

  elsif p_action = 'approve' then
    if v_uid <> v_task.created_by then
      raise exception 'TASK_REVIEW_FORBIDDEN: Only the task creator can approve this task'
        using errcode = '42501';
    end if;
    if v_from <> 'pending_approval' then
      raise exception 'TASK_REVIEW_INVALID_SOURCE: Only a task awaiting approval can be approved (this one is %)', v_from
        using errcode = '55000';
    end if;
    v_recipient := v_task.assigned_to;
    v_title     := v_actor_name || ' approved and completed task';

  else -- return
    if v_uid <> v_task.created_by then
      raise exception 'TASK_REVIEW_FORBIDDEN: Only the task creator can return this task'
        using errcode = '42501';
    end if;
    if v_from <> 'pending_approval' then
      raise exception 'TASK_REVIEW_INVALID_SOURCE: Only a task awaiting approval can be returned (this one is %)', v_from
        using errcode = '55000';
    end if;
    if v_note is null then
      raise exception 'TASK_RETURN_REASON_REQUIRED: Say what needs to be corrected before returning the task'
        using errcode = '22023';
    end if;
    -- Same ceiling the cancellation reason and the activity note already live
    -- with; long enough for a real correction, short enough not to be an essay
    -- nobody reads.
    if length(v_note) > 1000 then
      raise exception 'TASK_RETURN_REASON_TOO_LONG: Keep the reason under 1000 characters'
        using errcode = '22023';
    end if;
    v_recipient := v_task.assigned_to;
    v_title     := v_actor_name || ' returned task to Working';
  end if;

  perform set_config('boe.task_review_context', 'task_review', true);

  update public.tasks
     set status = case p_action
                    when 'submit'  then 'pending_approval'::public.task_status
                    when 'approve' then 'completed'::public.task_status
                    else                'working'::public.task_status
                  end,
         -- The ONLY place completed_at is set for a delegated ordinary task.
         completed_at = case when p_action = 'approve' then now() else null end,
         last_update_at = now(),
         -- Same stale-field rules the ordinary status change applies: none of
         -- the three targets is 'waiting' or 'blocked', so a leftover blocker
         -- or waiting-on subject would outlive the state that explained it.
         blocker_reason    = case when v_from = 'blocked' then null else blocker_reason    end,
         waiting_on_type   = case when v_from = 'waiting' then null else waiting_on_type   end,
         waiting_on_user_id= case when v_from = 'waiting' then null else waiting_on_user_id end,
         waiting_on_text   = case when v_from = 'waiting' then null else waiting_on_text   end
   where id = p_task_id
   returning * into v_task;

  perform set_config('boe.task_review_context', '', true);

  insert into public.task_activity_log (task_id, actor_id, action, from_status, to_status, note)
  values (p_task_id, v_uid, 'status_changed', v_from::public.task_status, v_task.status, v_note)
  returning id into v_log_id;

  -- One row, in the existing feed, addressed to the other party. The recipient
  -- and the body come from the locked row, never from the caller.
  if v_recipient is not null and v_recipient <> v_uid then
    insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id)
    values (v_recipient, p_task_id, 'task_acknowledged', v_title, v_task.title, true, v_log_id);
  end if;

  return jsonb_build_object(
    'id',                 v_task.id,
    'status',             v_task.status,
    'completed_at',       v_task.completed_at,
    'last_update_at',     v_task.last_update_at,
    'blocker_reason',     v_task.blocker_reason,
    'waiting_on_type',    v_task.waiting_on_type,
    'waiting_on_user_id', v_task.waiting_on_user_id,
    'waiting_on_text',    v_task.waiting_on_text,
    'from_status',        v_from,
    'activity_id',        v_log_id,
    'actor_name',         v_actor_name,
    'note',               v_note
  );
end;
$$;


-- Unchanged from 20260833000000: same signature, so the existing grants and the
-- comment still apply. Restated here because CREATE OR REPLACE does not alter
-- them and a reader should not have to go looking to confirm that.
revoke all    on function public.transition_task_review(uuid, text, text) from public, anon;
grant execute on function public.transition_task_review(uuid, text, text) to authenticated;

comment on function public.transition_task_review(uuid, text, text) is
  'The ONLY path by which a delegated ordinary task reaches pending_approval or completed. submit = assignee, approve/return = creator. Actor is auth.uid(); recipient, title and body come from the locked task row. Since 20261016000000 the notification also records activity_log_id = the activity row written in the same transaction.';
