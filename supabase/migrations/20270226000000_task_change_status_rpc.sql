-- Task Management: change_task_status() — one protected, transactional path for the
-- assignee's ordinary status changes.
--
-- WHY. Mark Complete (self tasks and quotation requests), "Update Status"
-- (started / working / waiting / blocked) and the waiting-on detail were each written
-- by the BROWSER as two separate calls: an UPDATE on public.tasks, then an INSERT into
-- public.task_activity_log. They are not one transaction. When the second call fails
-- (a dropped connection, a 5xx, a closed tab) the task has already changed and the
-- permanent history has no row for it — and the page navigates away as if it had
-- succeeded. Reproduced locally (PR #282, scenario 6): task `completed`, zero activity
-- rows, no message. transition_task_review() already solved this for the
-- submit / approve / return moves; it cannot be reused here because it refuses
-- self-assigned tasks and every other status.
--
-- WHAT THIS ADDS. One function. The caller supplies a task id, the new status and, where
-- they apply, a reason, an attachment reference and the waiting-on subject. Everything
-- else — who is acting, what the task currently is, whether the change is allowed — is
-- read from the LOCKED task row. The status, the stale-field resets and the activity row
-- are one transaction: a changed task always has its history row, and a refused change
-- writes nothing.
--
-- WHAT IT DELIBERATELY DOES NOT DO.
--   * Delegated ordinary tasks never reach `completed` or `pending_approval` here. Those
--     are transition_task_review()'s alone (and tasks_enforce_review_path, 20260834,
--     still refuses a bare UPDATE). This function refuses them with a message that names
--     the other path.
--   * No notification is written. The status-update notification stays where it is
--     (/api/notify-status-update, called by the page with the activity row id this
--     function returns), so the notification rules are untouched by this migration.
--   * Cancellation and restore stay on /api/cancel-task and /api/restore-task.
--   * No table, column, policy, trigger or existing function is changed, and nothing in
--     the application calls this yet. It is inert until the page is switched over in a
--     separate change, so applying it cannot alter behaviour.
--
-- WHO. Only the assignee, exactly as the page offers it (Mark Complete and Update Status
-- are drawn for the assignee alone). A creator, an admin and anybody else are refused:
-- the old path was a bare table UPDATE whose reach is not tracked in migrations, and a
-- new SECURITY DEFINER door must not be wider than the screen that uses it.
--
-- ROLLBACK: `drop function public.change_task_status(uuid, text, text, text, text, uuid, text);`
-- Re-runnable: `create or replace`, and the grants are idempotent.

do $$
begin
  if to_regclass('public.tasks') is null or to_regclass('public.task_activity_log') is null then
    raise exception 'CHANGE_TASK_STATUS_PREREQUISITE: public.tasks and public.task_activity_log must exist';
  end if;
  if not exists (
    select 1 from pg_type t join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'task_status' and e.enumlabel = 'pending_approval') then
    raise exception 'CHANGE_TASK_STATUS_PREREQUISITE: apply 20260832000000 (pending_approval) first';
  end if;
end $$;

create or replace function public.change_task_status(
  p_task_id            uuid,
  p_status             text,
  p_reason             text default null,
  p_attachment_url     text default null,
  p_waiting_on_type    text default null,
  p_waiting_on_user_id uuid default null,
  p_waiting_on_text    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_task      public.tasks%rowtype;
  v_from      text;
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_wtext     text := nullif(btrim(coalesce(p_waiting_on_text, '')), '');
  v_attach    text := nullif(btrim(coalesce(p_attachment_url, '')), '');
  v_now       timestamptz := now();
  v_quote     boolean;
  v_self      boolean;
  v_delegated boolean;
  v_log_id    uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required to change a task status'
      using errcode = '28000';
  end if;

  -- `cancelled` and `pending_approval` are not changed here: one has its own audited
  -- route, the other belongs to the review function. Everything else must be one of the
  -- statuses the page offers.
  if p_status = 'cancelled' then
    raise exception 'TASK_STATUS_NOT_HERE: A task is cancelled through Cancel task, not through a status change'
      using errcode = '22023';
  end if;
  if p_status = 'pending_approval' then
    raise exception 'TASK_STATUS_NOT_HERE: Submitting for approval goes through the review path, not through a status change'
      using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('pending', 'started', 'working', 'waiting', 'blocked', 'completed') then
    raise exception 'TASK_STATUS_INVALID: status must be pending, started, working, waiting, blocked or completed'
      using errcode = '22023';
  end if;

  select * into v_task from public.tasks where id = p_task_id for update;

  if not found then
    raise exception 'TASK_NOT_FOUND: That task no longer exists'
      using errcode = 'P0002';
  end if;

  v_from      := v_task.status::text;
  v_quote     := coalesce(v_task.task_type, 'general') = 'quotation_request';
  v_self      := v_task.created_by is not null and v_task.created_by = v_task.assigned_to;
  v_delegated := v_task.created_by is not null
                 and v_task.assigned_to is not null
                 and v_task.created_by <> v_task.assigned_to
                 and not v_quote;

  if v_uid is distinct from v_task.assigned_to then
    raise exception 'TASK_STATUS_FORBIDDEN: Only the person this task is assigned to can change its status'
      using errcode = '42501';
  end if;

  if v_from in ('completed', 'cancelled') then
    raise exception 'TASK_STATUS_FINISHED: A % task cannot change status', v_from
      using errcode = '55000';
  end if;

  if v_from = 'pending_approval' then
    raise exception 'TASK_STATUS_IN_REVIEW: This task is awaiting its creator''s decision and cannot change status'
      using errcode = '55000';
  end if;

  -- A delegated ordinary task is completed by its creator's approval and by nothing else.
  if v_delegated and p_status = 'completed' then
    raise exception 'TASK_STATUS_USE_REVIEW: A task assigned by someone else is submitted for approval, not completed directly'
      using errcode = '42501';
  end if;

  -- The acknowledgement gate the page applies: an accepted assignment comes first. A
  -- self task and a quotation request have nobody to acknowledge to.
  if not v_self and not v_quote and v_task.acknowledged_at is null then
    raise exception 'TASK_NOT_ACKNOWLEDGED: Acknowledge this task before changing its status'
      using errcode = '42501';
  end if;

  -- A repeat of the same status is refused rather than written: it would add a second,
  -- identical history row for one intended change (a double press, or a retry of a
  -- request whose answer was lost).
  if p_status = v_from then
    raise exception 'TASK_STATUS_UNCHANGED: This task is already %', v_from
      using errcode = '55000';
  end if;

  if v_reason is not null and length(v_reason) > 1000 then
    raise exception 'TASK_REASON_TOO_LONG: Keep the reason under 1000 characters'
      using errcode = '22023';
  end if;

  -- `waiting` needs to say what the task is waiting on, exactly as the page requires.
  if p_status = 'waiting' then
    if p_waiting_on_type is null or p_waiting_on_type not in ('team_member', 'external') then
      raise exception 'TASK_WAITING_DETAIL_REQUIRED: Say whether the task is waiting on a team member or on someone outside'
        using errcode = '22023';
    end if;
    if p_waiting_on_type = 'team_member' then
      if p_waiting_on_user_id is null
         or not exists (select 1 from public.users u where u.id = p_waiting_on_user_id) then
        raise exception 'TASK_WAITING_DETAIL_REQUIRED: Choose the team member the task is waiting on'
          using errcode = '22023';
      end if;
    else
      if v_wtext is null then
        raise exception 'TASK_WAITING_DETAIL_REQUIRED: Say who the task is waiting on'
          using errcode = '22023';
      end if;
      if length(v_wtext) > 500 then
        raise exception 'TASK_WAITING_DETAIL_TOO_LONG: Keep it under 500 characters'
          using errcode = '22023';
      end if;
    end if;
  end if;

  -- The same stale-field rules the page applied: a blocker or a waiting-on subject must
  -- not outlive the state that explained it.
  update public.tasks
     set status         = p_status::public.task_status,
         last_update_at = v_now,
         completed_at   = case when p_status = 'completed' then v_now else completed_at end,
         blocker_reason = case when p_status = 'blocked' then v_reason
                               when v_from   = 'blocked' then null
                               else blocker_reason end,
         waiting_on_type = case when p_status = 'waiting' then p_waiting_on_type
                                when v_from   = 'waiting' then null
                                else waiting_on_type end,
         waiting_on_user_id = case when p_status = 'waiting' and p_waiting_on_type = 'team_member' then p_waiting_on_user_id
                                   when p_status = 'waiting' or v_from = 'waiting' then null
                                   else waiting_on_user_id end,
         waiting_on_text = case when p_status = 'waiting' and p_waiting_on_type = 'external' then v_wtext
                                when p_status = 'waiting' or v_from = 'waiting' then null
                                else waiting_on_text end
   where id = p_task_id
   returning * into v_task;

  insert into public.task_activity_log (task_id, actor_id, action, from_status, to_status, note, attachment_url)
  values (p_task_id, v_uid, 'status_changed', v_from::public.task_status, v_task.status, v_reason, v_attach)
  returning id into v_log_id;

  return jsonb_build_object(
    'id',                 v_task.id,
    'status',             v_task.status,
    'from_status',        v_from,
    'completed_at',       v_task.completed_at,
    'last_update_at',     v_task.last_update_at,
    'blocker_reason',     v_task.blocker_reason,
    'waiting_on_type',    v_task.waiting_on_type,
    'waiting_on_user_id', v_task.waiting_on_user_id,
    'waiting_on_text',    v_task.waiting_on_text,
    'activity_log_id',    v_log_id
  );
end;
$$;

revoke all    on function public.change_task_status(uuid, text, text, text, text, uuid, text) from public, anon;
grant execute on function public.change_task_status(uuid, text, text, text, text, uuid, text) to authenticated;

comment on function public.change_task_status(uuid, text, text, text, text, uuid, text) is
  'The assignee''s status change as ONE transaction: status, stale-field resets and the status_changed activity row. Refuses delegated completion (transition_task_review owns it), cancelled, pending_approval, repeats and non-assignees. Writes no notification.';
