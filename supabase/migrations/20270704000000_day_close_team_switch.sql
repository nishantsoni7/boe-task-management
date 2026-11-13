-- DAY CLOSE AND THE SCOREBOARD: ONE SWITCH FOR THE TEAM, STARTING OFF.
--
-- WHY (owner, 2026-11-13)
-- -----------------------
-- Day Close (plan, proof, close my day, strikes, leave locks) and the Scoreboard (the score, its cards,
-- the vote) are live for the team, but the team has not been introduced to them. Until the owner
-- introduces them nobody should be shown a red "your plan was due" message, struck, scored, asked for
-- proof or locked out of leave for a rule they were never told about.
--
-- WHAT THIS ADDS
--   1.  day_close_settings.team_live     boolean, NOT NULL, default false. The switch. The existing
--                                        row becomes false the moment this applies, so it starts PAUSED.
--   2.  day_close_settings.live_since    when the switch was last turned ON. Day Close days are counted
--                                        from there, so paused days are neither credit nor blame.
--   3.  day_close_task_proof_check()     restated with ONE added condition: no proof is asked for while
--                                        the switch is off. The rest is word for word 20270624000000.
--
-- WHO WRITES IT. Only the service-role route (changeMembers, action set_live), for an administrator.
-- The table is already closed to the browser (20270622000000); nothing here opens it.
--
-- WHAT STAYS THE SAME. Strikes already written, the member list, plans, carry-overs and every other
-- table are untouched. The nightly strike check, the nightly score record and the leave lock live in
-- the application and read the same switch.
--
-- IDEMPOTENT. Columns are added if not exists, the function is replaced, the block at the end raises
-- if any of it did not take.
--
-- ROLLBACK
--   alter table public.day_close_settings drop column live_since, drop column team_live;
--   then restore day_close_task_proof_check() from 20270624000000_day_close_in_tasks.sql.

-- ═══ 0. What this assumes already exists ═════════════════════════════════════

do $$
begin
  if to_regclass('public.day_close_settings') is null or to_regclass('public.day_close_members') is null then
    raise exception 'DEPENDENCY MISSING: day_close_settings and day_close_members (20270622000000)';
  end if;
  if to_regprocedure('public.day_close_task_proof_check()') is null then
    raise exception 'DEPENDENCY MISSING: day_close_task_proof_check() (20270624000000)';
  end if;
end $$;

-- ═══ 1. The switch ═══════════════════════════════════════════════════════════

alter table public.day_close_settings
  add column if not exists team_live  boolean not null default false,
  add column if not exists live_since timestamptz;

comment on column public.day_close_settings.team_live is
  'Day Close and the Scoreboard are live for the team. False = paused: no strip, no strikes, no scoring record, no proof rule, no leave lock.';
comment on column public.day_close_settings.live_since is
  'When team_live was last turned on. Day Close days count from here.';

-- ═══ 2. Proof on a finished task: not while paused ═══════════════════════════

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

-- ═══ 3. Self-check ═══════════════════════════════════════════════════════════

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'day_close_settings' and column_name in ('team_live', 'live_since')
    having count(*) = 2
  ) then
    raise exception 'day_close_settings must have team_live and live_since';
  end if;
  if (select count(*) from public.day_close_settings) <> 1 then
    raise exception 'day_close_settings must hold exactly one row';
  end if;
  if position('team_live' in pg_get_functiondef('public.day_close_task_proof_check()'::regprocedure)) = 0 then
    raise exception 'day_close_task_proof_check() must read the switch';
  end if;
  if has_table_privilege('authenticated', 'public.day_close_settings', 'select')
     or has_table_privilege('authenticated', 'public.day_close_settings', 'update') then
    raise exception 'day_close_settings must stay closed to the browser';
  end if;
end $$;
