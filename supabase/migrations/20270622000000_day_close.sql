-- 20270622000000_day_close.sql
--
-- Day Close: the day's work is planned in the morning, every item is closed with proof or a reason, and the
-- day is closed before the person punches out on the attendance machine (owner, 2026-11-12).
--
--   * day_close_settings    one row: who reviews strikes and unlocks leave (the owner alone), and the times
--   * day_close_members     who takes part (the owner switches people on; nobody by default)
--   * day_plans             one row per person per IST date: filed at, closed at
--   * day_plan_items        the day's items: tasks assigned by somebody else that are due (copied in by the
--                           server) and the person's own items; each ends Done (proof) or Not done (reason)
--   * day_strikes           written by the nightly check: no plan / plan late / day not closed / closed after
--                           leaving. Strikes only, no money (owner, 2026-11-12). The reviewer upholds or waives.
--   * day_close_leave_locks a leave request sent while work was pending; only the reviewer may approve it
--
-- Design:
--   * Every table is CLOSED to the browser (no grant, RLS on, no policy). Every read and write goes through
--     /api/day-close/* and the attendance-request routes, which run on the service role and take the actor
--     from the bearer token (src/lib/dayClose/server.ts). Nothing here trusts a client-supplied person id.
--   * Proof photos live in the PRIVATE bucket 'day-proof', path '{employee uuid}/{uuid}.jpg', uploaded and
--     shown (short-lived signed links) by the server only.
--   * The judgement of a day (punch-out from the machine, holidays, leave) is in TypeScript, where the
--     machine-day rules already live (src/lib/dayClose/rules.ts); the database keeps the record and its shape.
--   * Every "day" is Asia/Kolkata.
--
-- ROLLBACK (nothing else references these objects):
--   delete from storage.buckets where id = 'day-proof';  -- only once empty
--   drop table public.day_close_leave_locks, public.day_strikes, public.day_plan_items, public.day_plans,
--     public.day_close_members, public.day_close_settings;
--   drop function public.day_close_closed_guard();

do $$
begin
  if to_regclass('public.users') is null
     or to_regclass('public.tasks') is null
     or to_regclass('public.attendance_requests') is null
     or to_regprocedure('public.set_updated_at()') is null then
    raise exception 'DEPENDENCY MISSING: users, tasks, attendance_requests and set_updated_at must exist';
  end if;
end $$;

-- ═══ 1. Settings and members ════════════════════════════════════════════════

create table public.day_close_settings (
  singleton            boolean primary key default true check (singleton),
  -- The one person who reviews strikes and approves leave while work is pending. Null until an
  -- administrator takes it (Team Today offers "Make me the reviewer").
  reviewer_id          uuid references public.users(id),
  -- Minutes after IST midnight. 10:30, 18:00 (office is 10:00 to 18:30).
  plan_due_minutes     integer not null default 630 check (plan_due_minutes between 0 and 1439),
  close_opens_minutes  integer not null default 1080 check (close_opens_minutes between 0 and 1439),
  updated_by           uuid references public.users(id),
  updated_at           timestamptz not null default now()
);
insert into public.day_close_settings (singleton) values (true) on conflict do nothing;

create table public.day_close_members (
  employee_id  uuid primary key references public.users(id),
  active       boolean not null default true,
  added_by     uuid references public.users(id),
  added_at     timestamptz not null default now(),
  removed_by   uuid references public.users(id),
  removed_at   timestamptz
);

-- ═══ 2. The day ═════════════════════════════════════════════════════════════

create table public.day_plans (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.users(id),
  work_date     date not null,
  submitted_at  timestamptz,
  closed_at     timestamptz,
  close_note    text check (close_note is null or length(close_note) <= 2000),
  created_at    timestamptz not null default now(),
  constraint day_plans_one_per_day unique (employee_id, work_date),
  constraint day_plans_closed_after_filed check (closed_at is null or submitted_at is not null)
);
create index day_plans_date_idx on public.day_plans (work_date);

create table public.day_plan_items (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null references public.day_plans(id) on delete cascade,
  employee_id       uuid not null references public.users(id),
  -- 'assigned': a task somebody else gave this person, due today or overdue, copied in by the server.
  -- 'own': written by the person.
  source            text not null check (source in ('assigned', 'own')),
  task_id           uuid references public.tasks(id),
  title             text not null check (length(btrim(title)) between 2 and 300),
  expected_output   text check (expected_output is null or length(expected_output) <= 500),
  status            text not null default 'open' check (status in ('open', 'done', 'not_done')),
  proof_url         text check (proof_url is null or (proof_url ~ '^https?://' and length(proof_url) <= 1000)),
  proof_photo_path  text check (proof_photo_path is null
                                or proof_photo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
  proof_note        text check (proof_note is null or length(proof_note) <= 1000),
  reason            text check (reason is null or length(btrim(reason)) between 3 and 1000),
  next_date         date,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  constraint day_plan_items_task_when_assigned check ((source = 'assigned') = (task_id is not null)),
  -- Done needs proof: a link or a photo, or (for an assigned task) the task itself having been submitted.
  constraint day_plan_items_done_has_proof check (
    status <> 'done' or source = 'assigned' or proof_url is not null or proof_photo_path is not null
  ),
  -- Not done needs a reason and the day it will be done.
  constraint day_plan_items_not_done_has_reason check (
    status <> 'not_done' or (reason is not null and next_date is not null)
  ),
  constraint day_plan_items_closed_when_resolved check ((status = 'open') = (closed_at is null))
);
-- A task is in a plan once. A full constraint (own items have no task, and NULLs never collide), so the
-- server's upsert can name it: on conflict (plan_id, task_id).
alter table public.day_plan_items add constraint day_plan_items_one_task_per_plan unique (plan_id, task_id);
create index day_plan_items_plan_idx on public.day_plan_items (plan_id, created_at);

-- A closed day is a record: its plan and items do not change any more.
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
create trigger day_plans_closed_guard
  before update or delete on public.day_plans
  for each row execute function public.day_close_closed_guard();
create trigger day_plan_items_closed_guard
  before insert or update or delete on public.day_plan_items
  for each row execute function public.day_close_closed_guard();

-- ═══ 3. Strikes ═════════════════════════════════════════════════════════════

create table public.day_strikes (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.users(id),
  work_date      date not null,
  kind           text not null check (kind in ('no_plan', 'plan_late', 'day_not_closed', 'closed_after_leaving')),
  -- What the check saw, in words and times (filed at, punch-out at, open items), for the reviewer.
  detail         jsonb not null default '{}'::jsonb,
  status         text not null default 'open' check (status in ('open', 'upheld', 'waived')),
  decided_by     uuid references public.users(id),
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 1000),
  created_at     timestamptz not null default now(),
  constraint day_strikes_once unique (employee_id, work_date, kind),
  constraint day_strikes_decision_complete check (
    (status = 'open' and decided_by is null and decided_at is null)
    or (status <> 'open' and decided_by is not null and decided_at is not null)
  ),
  constraint day_strikes_waive_has_note check (status <> 'waived' or length(btrim(coalesce(decision_note, ''))) >= 3)
);
create index day_strikes_open_idx on public.day_strikes (status, work_date desc);
create index day_strikes_employee_idx on public.day_strikes (employee_id, work_date desc);

-- ═══ 4. Leave while work is pending ═════════════════════════════════════════

create table public.day_close_leave_locks (
  request_id      uuid primary key references public.attendance_requests(id),
  employee_id     uuid not null references public.users(id),
  overdue_tasks   integer not null check (overdue_tasks >= 0),
  unclosed_days   integer not null check (unclosed_days >= 0),
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  released_by     uuid references public.users(id),
  released_at     timestamptz,
  constraint day_close_leave_locks_release_complete check ((released_by is null) = (released_at is null))
);

-- ═══ 5. Closed to the browser ═══════════════════════════════════════════════

alter table public.day_close_settings enable row level security;
alter table public.day_close_members enable row level security;
alter table public.day_plans enable row level security;
alter table public.day_plan_items enable row level security;
alter table public.day_strikes enable row level security;
alter table public.day_close_leave_locks enable row level security;

revoke all on public.day_close_settings, public.day_close_members, public.day_plans, public.day_plan_items,
  public.day_strikes, public.day_close_leave_locks from public, anon, authenticated;
revoke all on function public.day_close_closed_guard() from public, anon, authenticated;

-- ═══ 6. The proof photos' bucket ════════════════════════════════════════════
-- Private, JPEG only (the browser shrinks every photo first), 5 MB. No storage.objects policy: only the
-- service role (the /api/day-close/proof route) writes and signs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('day-proof', 'day-proof', false, 5242880, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ═══ 7. Self-check ══════════════════════════════════════════════════════════

do $$
begin
  if (select count(*) from public.day_close_settings) <> 1 then
    raise exception 'day_close_settings must hold exactly one row';
  end if;
  if has_table_privilege('authenticated', 'public.day_plans', 'select')
     or has_table_privilege('anon', 'public.day_strikes', 'select') then
    raise exception 'day close tables must be closed to the browser';
  end if;
end $$;
