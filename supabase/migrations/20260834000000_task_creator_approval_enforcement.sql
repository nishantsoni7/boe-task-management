-- Delegated tasks are completed by their CREATOR, not by their assignee — the
-- ENFORCEMENT half.
--
-- 20260833000000 added transition_task_review(): the correct path exists, and
-- the frontend uses it. This file makes it the ONLY path.
--
-- ⚠ APPLY THIS ONLY AFTER THE NEW FRONTEND IS DEPLOYED AND VERIFIED.
--
-- This is the one file in the set that can BREAK a running deployment. A UI gate
-- is a suggestion: `authenticated` holds UPDATE on public.tasks, so the frontend
-- that shipped before this work calls `.update({ status: 'completed' })` for a
-- delegated task and PostgREST happily performs it. The trigger below starts
-- refusing exactly that call. Applied while the old frontend is still serving,
-- every delegated Mark Complete fails; applied after the new frontend is live,
-- nothing calls it any more and the trigger is invisible to users.
--
-- Rollout order, in full:
--   20260832000000  the `pending_approval` status value        (inert)
--   20260833000000  transition_task_review()                     (additive)
--   ————————————    deploy the frontend, verify Submit/Approve/Return
--   20260834000000  THIS FILE — enforcement                      (restrictive)
--
-- REQUIRES both earlier files. Re-runnable: `create or replace function` and
-- `drop trigger if exists` mean applying it twice is a no-op, and rolling it
-- back is `drop trigger tasks_enforce_review_path on public.tasks;` — which
-- returns the database to the 20260833 state without touching a single row.
--
-- Scope: two functions, one trigger, two comments. No table, no column, no row,
-- no RLS policy. Nothing outside Task Management is read or written.

-- ── 1. The review context ────────────────────────────────────────────────────
--
-- Same idiom, and the same honesty about what it is for, as
-- in_order_cancellation() (20260819000000 §2): this is NOT an authorization
-- check. Authorization lives inside transition_task_review(). This flag exists
-- so the trigger in §2 can tell a transition performed through the audited
-- function from a bare `.update({ status })` — a distinction no privilege can
-- express, because the function and the browser act as the same auth.uid().
--
-- It belongs in THIS file rather than with the RPC because the RPC only ever
-- WRITES the GUC (via set_config); this function, which reads it, has exactly
-- one caller: the trigger below.
--
-- Transaction-local (`is_local => true`), so it cannot outlive the statement
-- that set it, and no client can set it: `set_config` on a `boe.*` GUC is not
-- reachable through PostgREST.

create or replace function public.in_task_review()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('boe.task_review_context', true), '') = 'task_review';
$$;

revoke execute on function public.in_task_review() from public, anon, authenticated;

comment on function public.in_task_review() is
  'True only inside transition_task_review(). Transaction-local; not settable by any client. Read by tasks_enforce_review_path.';

-- ── 2. The bypass the UI cannot close ────────────────────────────────────────
--
-- A UI gate is a suggestion: `authenticated` holds UPDATE on public.tasks, so
-- until now any signed-in assignee could PATCH /rest/v1/tasks?id=eq.… with
-- {"status":"completed"} and skip the whole workflow. This trigger makes the
-- path a database rule.
--
-- The boundary, stated precisely:
--
--   WHO   only sessions that carry an identity (auth.uid() is not null). The
--         service role and direct psql are exempt, which is what keeps
--         /api/cancel-task, /api/restore-task, the task health-check cron and
--         any future backfill working unchanged. That is not a client bypass —
--         PostgREST always carries an identity, and holding the service-role
--         key already means holding everything.
--
--   WHAT  only tasks that are BOTH delegated (created_by <> assigned_to) and
--         ordinary (task_type <> 'quotation_request'). A self task and a
--         quotation request never reach a single check below.
--
--   WHICH only transitions that touch the review states: into 'completed',
--         into 'pending_approval', or out of 'pending_approval'. Every other
--         status change a client makes today — acknowledge, waiting, blocked,
--         resume working — passes untouched, and so does every non-status
--         update (title, note, priority, due date, urgency).
--
-- The delegation test reads OLD *and* NEW so the same statement cannot both
-- rewrite the ownership and complete the task. The separate ownership guard
-- closes the two-statement version of the same trick: no client session may
-- reassign a task or change who created it. Verified before writing it — no
-- code anywhere in the application updates tasks.assigned_to or
-- tasks.created_by; Copy & Assign inserts a NEW task
-- (/api/tasks/[id]/copy), which is an INSERT and unaffected.

create or replace function public.tasks_enforce_review_path()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_delegated boolean;
  v_ordinary  boolean;
begin
  if v_uid is null then
    return new;
  end if;

  if new.created_by  is distinct from old.created_by
     or new.assigned_to is distinct from old.assigned_to then
    raise exception
      'TASK_OWNERSHIP_IMMUTABLE: A task cannot be reassigned or re-attributed. Use Copy & Assign to create a new task.'
      using errcode = '42501';
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  v_ordinary := coalesce(old.task_type, 'general') <> 'quotation_request';
  v_delegated :=
       (old.created_by is not null and old.assigned_to is not null and old.created_by <> old.assigned_to)
    or (new.created_by is not null and new.assigned_to is not null and new.created_by <> new.assigned_to);

  if not (v_ordinary and v_delegated) then
    return new;
  end if;

  if public.in_task_review() then
    return new;
  end if;

  if new.status::text = 'completed' then
    raise exception
      'TASK_APPROVAL_REQUIRED: A delegated task is completed by its creator. Submit it for approval instead.'
      using errcode = '42501';
  end if;

  if new.status::text = 'pending_approval' then
    raise exception
      'TASK_REVIEW_PATH_REQUIRED: Submit for approval through the review action, which records who submitted it and tells the creator.'
      using errcode = '42501';
  end if;

  -- Leaving pending_approval is the creator's decision, made through the
  -- function. Cancellation is the one exception: it is a different decision,
  -- it belongs to the creator/admin, and it already runs through
  -- /api/cancel-task, which records a reason.
  if old.status::text = 'pending_approval' and new.status::text <> 'cancelled' then
    raise exception
      'TASK_REVIEW_PATH_REQUIRED: A task awaiting approval moves only when its creator approves or returns it.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.tasks_enforce_review_path() from public, anon, authenticated;

drop trigger if exists tasks_enforce_review_path on public.tasks;

create trigger tasks_enforce_review_path
  before update on public.tasks
  for each row execute function public.tasks_enforce_review_path();

comment on table public.tasks is
  'Task Management. A DELEGATED ORDINARY task (created_by <> assigned_to, task_type <> ''quotation_request'') reaches pending_approval or completed ONLY through transition_task_review() — enforced by tasks_enforce_review_path (20260834000000). Self tasks and quotation requests are unaffected and remain directly completable. Cancellation and restore run with the service role and are exempt.';
