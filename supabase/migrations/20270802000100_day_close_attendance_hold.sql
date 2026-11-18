-- DAY CLOSE: THE ATTENDANCE HOLD, PROOF AS A WRITTEN LINE, AND THE SCOREBOARD'S OWN SWITCH.
--
-- WHY (owner, 2026-11-18)
-- -----------------------
-- One rule for staff: before you leave, every task due today (and anything overdue) is Done, or moved to a new
-- date with a reason. If somebody leaves without that, the next working day's punch-in is recorded but NOT
-- COUNTED ("on hold") until they close yesterday's work. The hold clears by itself the moment the work is
-- closed; the owner can lift it with a reason; a hold never cleared is the owner's call at payroll (an
-- attendance correction). NOTHING is deducted automatically.
--
-- WHAT THIS ADDS
--   1. day_close_holds                       one row per person per held day. Closed to the browser.
--   2. day_close_settings.scoreboard_live    the Scoreboard's own switch, default false (off), so Day Close
--                                            can go live without the Scoreboard.
--   3. day_close_task_proof_check()          restated with ONE added way to prove a task: an update with a
--                                            written line (10 characters or more). The rest is word for word
--                                            20270704000000.
--
-- REQUIRES 20270802000000 (the notification type) applied first, and 20270622000000, 20270624000000,
-- 20270704000000. Safe to run again.
--
-- ROLLBACK
--   drop table public.day_close_holds;
--   alter table public.day_close_settings drop column scoreboard_live;
--   then restore day_close_task_proof_check() from 20270704000000_day_close_team_switch.sql.

-- ═══ 0. What this assumes already exists ═════════════════════════════════════

do $$
begin
  if to_regclass('public.day_close_settings') is null or to_regclass('public.day_close_members') is null then
    raise exception 'DEPENDENCY MISSING: day_close_settings and day_close_members (20270622000000)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'day_close_settings' and column_name = 'team_live') then
    raise exception 'DEPENDENCY MISSING: day_close_settings.team_live (20270704000000)';
  end if;
end $$;

-- ═══ 1. The hold ═════════════════════════════════════════════════════════════

create table if not exists public.day_close_holds (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references public.users(id),
  -- The working day whose attendance is held.
  held_date        date not null,
  -- The day whose work was left open.
  cause_date       date not null,
  open_tasks       integer not null check (open_tasks > 0),
  created_at       timestamptz not null default now(),
  -- When the "your punch-in is not counted" message went out (once).
  punch_notice_at  timestamptz,
  -- Cleared: by the person closing the work (cleared_by null), or lifted by the owner (cleared_by + reason).
  cleared_at       timestamptz,
  cleared_by       uuid references public.users(id),
  clear_reason     text check (clear_reason is null or length(btrim(clear_reason)) between 3 and 500),
  constraint day_close_holds_one_per_day unique (employee_id, held_date),
  constraint day_close_holds_after_cause check (held_date > cause_date),
  constraint day_close_holds_lift_has_reason check (cleared_by is null or (cleared_at is not null and clear_reason is not null))
);
create index if not exists day_close_holds_open_idx on public.day_close_holds (employee_id, held_date) where cleared_at is null;

alter table public.day_close_holds enable row level security;
revoke all on public.day_close_holds from public, anon, authenticated;

-- ═══ 2. The Scoreboard's own switch ══════════════════════════════════════════

alter table public.day_close_settings add column if not exists scoreboard_live boolean not null default false;
comment on column public.day_close_settings.scoreboard_live is
  'The Scoreboard is shown to the team (only while team_live is also on). Off by default (owner, 2026-11-18).';

-- ═══ 3. Proof on a finished task: a written line counts too ══════════════════

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
  -- Paused: nobody is asked for proof for a rule they were not introduced to.
  if not exists (select 1 from public.day_close_settings s where s.singleton and s.team_live) then
    return null;
  end if;

  if exists (
       select 1 from public.task_activity_log l
       where l.task_id = new.id and l.actor_id = new.assigned_to
         and (l.attachment_url is not null
              or coalesce(l.note, '') ~* 'https?://[^[:space:]]+'
              -- 2026-11-18: one written line of what was done is proof too.
              or length(btrim(coalesce(l.note, ''))) >= 10)
     )
     or exists (
       select 1 from public.task_attachments a
       join public.task_activity_log l on l.id = a.activity_log_id
       where l.task_id = new.id and l.actor_id = new.assigned_to
     ) then
    return null;
  end if;

  raise exception 'DAY_CLOSE_PROOF_REQUIRED: Add proof before finishing this task: post an update saying what you did (one line is enough), or a photo, a file or a link.'
    using errcode = 'P0001';
end;
$$;

-- ═══ 4. Self-check ═══════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.day_close_holds') is null then
    raise exception 'day_close_holds was not created';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'day_close_settings' and column_name = 'scoreboard_live') then
    raise exception 'day_close_settings.scoreboard_live was not added';
  end if;
  if position('length(btrim' in pg_get_functiondef('public.day_close_task_proof_check()'::regprocedure)) = 0 then
    raise exception 'day_close_task_proof_check() must accept a written line';
  end if;
  if has_table_privilege('authenticated', 'public.day_close_holds', 'select')
     or has_table_privilege('anon', 'public.day_close_holds', 'select') then
    raise exception 'day_close_holds must stay closed to the browser';
  end if;
end $$;
