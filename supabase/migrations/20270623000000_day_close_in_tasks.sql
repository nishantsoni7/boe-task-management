-- 20270623000000_day_close_in_tasks.sql
--
-- Day Close moves INTO Task Management (owner, 2026-11-12): "My Day" duplicated Self Tasks, so the day's
-- plan is now the person's own tasks, and Day Close keeps only the rules around them.
--
--   * day_plan_items (20270622000000) is dropped. It was never used: nobody had been switched on.
--     The guard below refuses to drop it if it holds a single row.
--   * day_plans.planned_task_ids: the tasks that were due when the plan was filed, kept as they were,
--     so moving a task to another day cannot hide that it was in that day's plan.
--   * day_close_carryovers: at "Close my day", each task due that is not handed in gets a reason and the
--     day it will be done. One per plan and task. A closed day is a record (the existing guard).
--   * PROOF (owner, 2026-11-12: "proof needed on every completed task"): for a person switched on, a task
--     they finish (self task to Completed, or a delegated task to Pending approval) must carry proof posted
--     BY THEM on the task: a file on an update or status change, or a link (http/https) in an update.
--     Checked at COMMIT (a deferred constraint trigger), because change_task_status() writes the status
--     first and the history row with its attachment after, in the same transaction. Approving a submitted
--     task needs nothing more; a change made by somebody else, or by the service role, is not checked.
--
-- ROLLBACK:
--   drop trigger tasks_day_close_proof on public.tasks; drop function public.day_close_task_proof_check();
--   drop table public.day_close_carryovers; alter table public.day_plans drop column planned_task_ids;
--   (day_plan_items is not recreated: 20270622000000 has its definition if ever wanted.)

do $$
begin
  if to_regclass('public.day_plans') is null or to_regclass('public.task_activity_log') is null
     or to_regclass('public.task_attachments') is null then
    raise exception 'DEPENDENCY MISSING: day_plans (20270622000000), task_activity_log and task_attachments must exist';
  end if;
  if to_regclass('public.day_plan_items') is not null and exists (select 1 from public.day_plan_items) then
    raise exception 'day_plan_items holds rows: Day Close was used. Stop and decide before dropping it.';
  end if;
end $$;

-- ═══ 1. The plan is the person's tasks ══════════════════════════════════════

drop trigger if exists day_plan_items_closed_guard on public.day_plan_items;
drop table if exists public.day_plan_items;

alter table public.day_plans
  add column planned_task_ids uuid[] not null default '{}'::uuid[];

create table public.day_close_carryovers (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references public.day_plans(id),
  task_id     uuid not null references public.tasks(id),
  reason      text not null check (length(btrim(reason)) between 3 and 1000),
  next_date   date not null,
  created_at  timestamptz not null default now(),
  constraint day_close_carryovers_once unique (plan_id, task_id)
);
create index day_close_carryovers_task_idx on public.day_close_carryovers (task_id);

-- The closed-day guard (20270622000000) now covers the carry-overs instead of the items.
create or replace function public.day_close_closed_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_closed timestamptz;
begin
  if tg_table_name = 'day_plans' then
    if old.closed_at is not null then
      raise exception 'DAY_CLOSED: this day is closed and cannot change' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then
      raise exception 'DAY_PLAN_KEPT: a day plan is never deleted' using errcode = '42501';
    end if;
    return new;
  end if;
  select p.closed_at into v_closed from public.day_plans p where p.id = coalesce(new.plan_id, old.plan_id);
  if v_closed is not null then
    raise exception 'DAY_CLOSED: this day is closed and cannot change' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.day_close_closed_guard() from public, anon, authenticated;

create trigger day_close_carryovers_closed_guard
  before insert or update or delete on public.day_close_carryovers
  for each row execute function public.day_close_closed_guard();

alter table public.day_close_carryovers enable row level security;
revoke all on public.day_close_carryovers from public, anon, authenticated;

-- ═══ 2. Proof on a finished task ════════════════════════════════════════════

create or replace function public.day_close_task_proof_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- Only the person doing the work, finishing it now, and only while they are switched on.
  if v_actor is null or v_actor is distinct from new.assigned_to then
    return null;
  end if;
  if not (
    (new.status::text = 'completed' and old.status::text not in ('completed', 'pending_approval'))
    or (new.status::text = 'pending_approval' and old.status::text <> 'pending_approval')
  ) then
    return null;
  end if;
  if not exists (select 1 from public.day_close_members m where m.employee_id = new.assigned_to and m.active) then
    return null;
  end if;

  if exists (
       select 1 from public.task_activity_log l
       where l.task_id = new.id and l.actor_id = new.assigned_to
         and (l.attachment_url is not null or coalesce(l.note, '') ~* 'https?://[^[:space:]]+')
     )
     or exists (
       select 1 from public.task_attachments a
       join public.task_activity_log l on l.id = a.activity_log_id
       where l.task_id = new.id and l.actor_id = new.assigned_to
     ) then
    return null;
  end if;

  raise exception 'DAY_CLOSE_PROOF_REQUIRED: Add proof before finishing this task: post an update with a photo, a file or a link to the work.'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.day_close_task_proof_check() from public, anon, authenticated;

create constraint trigger tasks_day_close_proof
  after update of status on public.tasks
  deferrable initially deferred
  for each row
  when (new.status is distinct from old.status)
  execute function public.day_close_task_proof_check();

-- ═══ 3. Self-check ══════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.day_plan_items') is not null then
    raise exception 'day_plan_items must be gone';
  end if;
  if has_table_privilege('authenticated', 'public.day_close_carryovers', 'select') then
    raise exception 'day_close_carryovers must be closed to the browser';
  end if;
end $$;
