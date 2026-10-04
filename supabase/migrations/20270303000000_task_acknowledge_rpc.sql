-- Task Management: acknowledge_task() — Acknowledge and its two history rows in one transaction.
--
-- WHY. Acknowledge was written by the BROWSER as two separate calls from three screens
-- (Task Detail, My Tasks, Dashboard): an UPDATE on public.tasks (acknowledged_at, status =
-- 'working', last_update_at), then an INSERT of two rows into public.task_activity_log
-- ('acknowledged' and 'status_changed') whose error was never read. They are not one
-- transaction. When the second call fails (a dropped connection, a 5xx, a closed tab) the
-- task is Working and acknowledged, the permanent history has no row for either event, and
-- the page reports success. It is the defect change_task_status() (20270302000000) removes
-- for status changes; Acknowledge is the one transition that function deliberately does not
-- cover — it refuses a task that has not been acknowledged yet.
--
-- WHAT THIS ADDS. One function, acknowledge_task(p_task_id). The caller supplies ONLY the
-- task id. Who is acting comes from auth.uid(); what the task is, and whether it may be
-- acknowledged, is read from the LOCKED task row. The acknowledgement stamp, the move to
-- 'working' and BOTH history rows are one transaction: an acknowledged task always has its
-- history, and a refused call writes nothing.
--
-- RULES (all checked against the locked row, in this order):
--   * signed in                                     else 28000
--   * the task exists                               else P0002
--   * the caller is the ASSIGNEE                    else 42501  (a creator, an admin and
--                                                    anybody else are refused: the screens
--                                                    draw Acknowledge for the assignee only,
--                                                    and a SECURITY DEFINER door must not be
--                                                    wider than the screen that uses it)
--   * the caller is NOT the creator                 else 42501  (a self task has nobody to
--                                                    acknowledge to)
--   * not a quotation request                       else 42501  (same: no acknowledgement)
--   * not already acknowledged                      else 55000  (a double press, or a retry
--                                                    of a request whose answer was lost, is
--                                                    refused instead of writing a second pair
--                                                    of history rows)
--   * status is one the screens offer Acknowledge for — pending, started, working, waiting,
--     blocked. completed / cancelled / pending_approval are refused (55000).
--
-- WHAT IT DELIBERATELY DOES NOT DO.
--   * No notification is written. The acknowledgement notice stays where it is
--     (/api/notify-status-update, action 'acknowledged', called by the page after the answer
--     comes back), so the notification rules are untouched by this migration.
--   * The history is exactly what the browser used to write: an 'acknowledged' row and a
--     'status_changed' row (from the status the task held, to 'working'), both authored by
--     the caller, both without a note. Nothing about the history's shape changes.
--   * No table, column, policy, trigger or existing function is changed. A delegated task's
--     move to 'working' is not a review move, so tasks_enforce_review_path lets it through
--     exactly as it did for the bare UPDATE.
--
-- ROLLBACK: `drop function public.acknowledge_task(uuid);`
-- Re-runnable: `create or replace`, and the grants are idempotent.

do $$
begin
  if to_regclass('public.tasks') is null or to_regclass('public.task_activity_log') is null then
    raise exception 'ACKNOWLEDGE_TASK_PREREQUISITE: public.tasks and public.task_activity_log must exist';
  end if;
  if not exists (
    select 1 from pg_type t join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'task_status' and e.enumlabel = 'pending_approval') then
    raise exception 'ACKNOWLEDGE_TASK_PREREQUISITE: apply 20260832000000 (pending_approval) first';
  end if;
end $$;

create or replace function public.acknowledge_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_task     public.tasks%rowtype;
  v_from     public.task_status;
  v_now      timestamptz := now();
  v_ack_id   uuid;
  v_status_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required to acknowledge a task'
      using errcode = '28000';
  end if;

  select * into v_task from public.tasks where id = p_task_id for update;

  if not found then
    raise exception 'TASK_NOT_FOUND: That task no longer exists'
      using errcode = 'P0002';
  end if;

  if v_uid is distinct from v_task.assigned_to then
    raise exception 'TASK_ACK_FORBIDDEN: Only the person this task is assigned to can acknowledge it'
      using errcode = '42501';
  end if;

  if v_task.created_by is not null and v_task.created_by = v_uid then
    raise exception 'TASK_ACK_NOT_APPLICABLE: A task you assigned to yourself does not need acknowledging'
      using errcode = '42501';
  end if;

  if coalesce(v_task.task_type, 'general') = 'quotation_request' then
    raise exception 'TASK_ACK_NOT_APPLICABLE: A quotation request is not acknowledged'
      using errcode = '42501';
  end if;

  if v_task.acknowledged_at is not null then
    raise exception 'TASK_ALREADY_ACKNOWLEDGED: This task has already been acknowledged'
      using errcode = '55000';
  end if;

  if v_task.status::text not in ('pending', 'started', 'working', 'waiting', 'blocked') then
    raise exception 'TASK_ACK_WRONG_STATUS: A % task cannot be acknowledged', v_task.status::text
      using errcode = '55000';
  end if;

  v_from := v_task.status;

  update public.tasks
     set acknowledged_at = v_now,
         status          = 'working'::public.task_status,
         last_update_at  = v_now
   where id = p_task_id
   returning * into v_task;

  insert into public.task_activity_log (task_id, actor_id, action, note)
  values (p_task_id, v_uid, 'acknowledged', null)
  returning id into v_ack_id;

  insert into public.task_activity_log (task_id, actor_id, action, from_status, to_status, note)
  values (p_task_id, v_uid, 'status_changed', v_from, v_task.status, null)
  returning id into v_status_id;

  return jsonb_build_object(
    'id',                    v_task.id,
    'status',                v_task.status,
    'from_status',           v_from,
    'acknowledged_at',       v_task.acknowledged_at,
    'last_update_at',        v_task.last_update_at,
    'acknowledged_log_id',   v_ack_id,
    'status_changed_log_id', v_status_id
  );
end;
$$;

-- Supabase's default privileges grant EXECUTE to anon on new functions; PUBLIC is revoked too.
revoke all    on function public.acknowledge_task(uuid) from public, anon;
grant execute on function public.acknowledge_task(uuid) to authenticated;

comment on function public.acknowledge_task(uuid) is
  'The assignee''s Acknowledge as ONE transaction: acknowledged_at, status -> working, and the ''acknowledged'' and ''status_changed'' activity rows. Refuses non-assignees, the creator, quotation requests, an already-acknowledged task and finished / in-review tasks. Writes no notification.';

-- Executed self-check: the door is granted to signed-in users only.
do $$
declare
  v_acl aclitem[];
  v_oid oid := 'public.acknowledge_task(uuid)'::regprocedure;
begin
  select proacl into v_acl from pg_proc where oid = v_oid;
  if exists (
    select 1 from aclexplode(coalesce(v_acl, '{}'::aclitem[])) a
     where a.privilege_type = 'EXECUTE'
       and (a.grantee = 0 or a.grantee in (select r.oid from pg_roles r where r.rolname = 'anon'))
  ) then
    raise exception 'ACKNOWLEDGE_TASK_ACL: public or anon can execute acknowledge_task';
  end if;
  if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'ACKNOWLEDGE_TASK_ACL: authenticated cannot execute acknowledge_task';
  end if;
end $$;
