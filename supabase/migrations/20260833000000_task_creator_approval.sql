-- Delegated tasks are completed by their CREATOR, not by their assignee — the
-- MECHANISM half.
--
-- Until now the assignee alone decided a delegated task was finished: the
-- browser called `.update({ status: 'completed', completed_at: now })` straight
-- against public.tasks, and `authenticated` holds the table UPDATE grant, so the
-- database accepted it from anyone RLS let touch the row. The person who asked
-- for the work had no say in whether it was actually done, and the completion
-- credit that feeds Performance was awarded on the assignee's own word.
--
--     working/waiting/blocked/…  --submit-->  pending_approval
--     pending_approval           --approve--> completed   (completed_at set HERE)
--     pending_approval           --return-->  working     (reason required)
--
-- ── This migration ADDS a capability. It REMOVES none. ───────────────────────
--
-- Deliberately no trigger, and deliberately nothing that can refuse an UPDATE.
-- The enforcement that makes this path the ONLY path is 20260834000000, a
-- separate file, because the two cannot land at the same time:
--
--   * enforcement before the new frontend  -> the deployed frontend still calls
--     `.update({ status: 'completed' })` for delegated tasks and every one of
--     those calls starts failing;
--   * the new frontend before this file    -> Submit for Approval calls an RPC
--     that does not exist and 404s.
--
-- So the rollout is: 20260832 (status) -> 20260833 (this: the RPC) -> deploy the
-- frontend -> 20260834 (enforcement). Between this file and 20260834 BOTH
-- frontends work: the new one submits through the RPC, and the old one keeps
-- completing delegated tasks directly, exactly as it does today. That overlap is
-- the point of the split, not an oversight.
--
-- REQUIRES 20260832000000 (the `pending_approval` status value) to be applied
-- first. PostgreSQL forbids USING an enum label in the transaction that added
-- it, which is why that value has its own file.
--
-- Scope: one function, its grants, its comment. No table, no column, no row, no
-- RLS policy, no trigger. Nothing outside Task Management is read or written.
--
-- ── What is deliberately NOT changed ─────────────────────────────────────────
--
--   * SELF tasks (created_by = assigned_to). One person, no one to approve to;
--     Mark Complete keeps working exactly as it does today.
--   * QUOTATION REQUESTS (task_type = 'quotation_request'). They have their own
--     completion wording and their own screens, and the requester/assignee
--     relationship there is not a delegation. transition_task_review() refuses
--     them outright.
--   * CANCELLATION and RESTORE, which run through /api/cancel-task and
--     /api/restore-task with the service role and are not touched here at all.
--   * The notification enum. These three events reuse `task_acknowledged`, the
--     value every other Task Management notification already carries (see
--     /api/notify-status-update and /api/restore-task). Task notifications are
--     whitelisted into the feed by TITLE, not by type — src/lib/notifications.ts
--     — so a new enum value would buy nothing and would have to be committed
--     before any code could reference it.

-- ── 1. The one protected path ────────────────────────────────────────────────
--
-- SECURITY DEFINER for two reasons, both structural:
--   * the notification is addressed to the OTHER party, and no client role may
--     insert a notifications row for somebody else;
--   * the task update, the activity row and the notification must be one
--     transaction, so a submitted task can never exist without the creator
--     having been told about it.
--
-- Every fact it acts on is read from the LOCKED task row. The caller supplies a
-- task id, an action and (for `return`) a reason — nothing else. Actor,
-- creator, assignee, recipient, task title and the actor's display name are all
-- derived server-side; a browser cannot name who it is, who to notify, or what
-- the task is called.
--
-- `for update` holds the row for the rest of the transaction, so two clicks on
-- Approve serialise: the second waits, then reads status = 'completed' and is
-- refused by the source-status check.
--
-- The two `set_config('boe.task_review_context', …)` calls bracketing the UPDATE
-- do nothing on their own — no code in THIS migration reads that GUC. They are
-- what 20260834000000's trigger will read to tell a transition made through this
-- function from a bare `.update({ status })`. Writing them here means the
-- function body does not have to change when enforcement arrives.

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
    insert into public.notifications (user_id, task_id, type, title, body, is_push_sent)
    values (v_recipient, p_task_id, 'task_acknowledged', v_title, v_task.title, true);
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

revoke all    on function public.transition_task_review(uuid, text, text) from public, anon;
grant execute on function public.transition_task_review(uuid, text, text) to authenticated;

comment on function public.transition_task_review(uuid, text, text) is
  'The ONLY path by which a delegated ordinary task reaches pending_approval or completed. submit = assignee, approve/return = creator. Actor is auth.uid(); recipient, title and body come from the locked task row. Made the ONLY path by tasks_enforce_review_path (20260834000000); until that file is applied this function is the correct path but not the sole one.';
