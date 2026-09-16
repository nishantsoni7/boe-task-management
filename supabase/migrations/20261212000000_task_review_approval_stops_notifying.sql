-- ═══════════════════════════════════════════════════════════════════════════
-- Task approval — approving submitted work no longer writes a notification
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED. Prepared for review.
--
-- THE RULE (docs/BOE Master Context/05_Business_Rules.md → NOTIFICATION RULES)
--
--   submit   the assignee submits completed work    → the CREATOR is notified
--   approve  the creator approves it                → NOBODY is notified
--   return   the creator returns it to Working      → the ASSIGNEE is notified
--
-- transition_task_review() is the only writer of all three. This replaces it
-- with ONE change: the notification insert is skipped when p_action = 'approve'.
--
-- WHAT IS UNCHANGED, DELIBERATELY
--
--   * who may submit, approve or return; every refusal and its error code
--   * the status transition, completed_at, the stale-field clearing
--   * the task_activity_log row — approval stays in the permanent history, and
--     performance calculations read tasks/activity, never notifications
--   * the submit and return notifications, their recipient, title and link
--   * the quotation refusal and the not-delegated refusal
--   * signature, return shape, SECURITY DEFINER, search_path, grants
--
-- EXISTING APPROVAL NOTIFICATIONS ARE NOT DELETED. The application excludes
-- them from the feed, the unread count, mark-all-read and delete-all
-- (src/lib/notifications/taskNotificationPolicy.ts), which also covers the
-- window between the application deploying and this file being applied.
--
-- DRIFT GUARD. The replacement is written against the body in
-- 20261016000000_notifications_link_activity_log.sql. The guard below refuses
-- to replace a live function that no longer has that shape, so a production
-- definition changed by hand is reported rather than silently overwritten.
-- Transaction-compatible throughout: no explicit BEGIN/COMMIT.
--
-- Reversible by re-running step 3 of 20261016000000.


-- ═══ 1. Drift guard ═════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_oid      regprocedure;
  v_current  text;
  v_secdef   boolean;
  v_config   text[];
  v_search   text;
  v_schemas  text[];
  v_fragment text;
  v_missing  text;
  v_required text[] := ARRAY[
    'coalesce(v_task.task_type, ''general'') = ''quotation_request''',
    '''TASK_REVIEW_FORBIDDEN: Only the task creator can approve this task''',
    ''' approved and completed task''',
    ''' submitted task for approval''',
    ''' returned task to Working''',
    'insert into public.task_activity_log (task_id, actor_id, action, from_status, to_status, note)',
    'if v_recipient is not null and v_recipient <> v_uid then',
    'insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id)'
  ];
BEGIN
  v_oid := to_regprocedure('public.transition_task_review(uuid,text,text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_MISSING: public.transition_task_review(uuid,text,text) does not exist; apply 20260833000000 and 20261016000000 first.';
  END IF;

  SELECT pg_get_functiondef(p.oid), p.prosecdef, p.proconfig
    INTO v_current, v_secdef, v_config
    FROM pg_proc p
   WHERE p.oid = v_oid;

  IF position('p_action <> ''approve''' in v_current) > 0 THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_ALREADY_SILENT: the live function already skips the approval notification; inspect it before replacing it.';
  END IF;

  FOREACH v_fragment IN ARRAY v_required LOOP
    IF position(v_fragment in v_current) = 0 THEN
      v_missing := coalesce(v_missing || ', ', '') || v_fragment;
    END IF;
  END LOOP;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_DRIFTED: the live function is missing rules this replacement preserves: %. Capture it with pg_get_functiondef and rebase step 2 before applying.', v_missing;
  END IF;

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_DRIFTED: the live function is not SECURITY DEFINER.';
  END IF;

  SELECT c INTO v_search FROM unnest(v_config) AS c WHERE c LIKE 'search_path=%' LIMIT 1;
  IF v_search IS NULL THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_DRIFTED: the live function does not pin search_path.';
  END IF;

  SELECT array_agg(btrim(translate(e, '"''', '')) ORDER BY ord)
    INTO v_schemas
    FROM unnest(string_to_array(substr(v_search, length('search_path=') + 1), ','))
         WITH ORDINALITY AS t(e, ord);
  IF v_schemas IS DISTINCT FROM ARRAY['public', 'pg_temp'] THEN
    RAISE EXCEPTION 'TRANSITION_TASK_REVIEW_DRIFTED: the live function''s search_path is "%", expected exactly public, pg_temp.', v_search;
  END IF;
END
$do$;


-- ═══ 2. The function — 20261016000000's body, one condition changed ═════════

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
    -- Still resolved, and still the title the application's read-side
    -- exclusion names: it identifies rows written before this migration.
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

  -- One row, in the existing feed, addressed to the other party — for a
  -- submission or a return. An APPROVAL writes none (20261212000000): the task
  -- is complete, the activity row above records who approved it, and nobody is
  -- notified. The recipient and the body come from the locked row, never from
  -- the caller.
  if p_action <> 'approve' and v_recipient is not null and v_recipient <> v_uid then
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


-- ═══ 3. Grants — restated, not changed (20260833000000 lines 245-246) ═══════

revoke all    on function public.transition_task_review(uuid, text, text) from public, anon;
grant execute on function public.transition_task_review(uuid, text, text) to authenticated;
