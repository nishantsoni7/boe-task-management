-- 20270625000000_scoreboard.sql
--
-- The BOE Scoreboard (owner, 2026-11-12): one score out of 100 a month, seen twice a day, rewarded monthly.
-- It replaces the Performance numbers; there is no separate module.
--
--   * scoreboard_targets  what the owner sets on the 1st, per person and month: the track (general / sales),
--                         the sales target in rupees (before GST), and one role target (a number and what
--                         counts: tasks finished, or vendor visits)
--   * scoreboard_daily    each person's month-to-date score as it stood at the end of a day. Written once by
--                         the nightly run and NEVER changed (owner: "a frozen month never changes"); the next
--                         morning's "change since yesterday" is read from here
--
-- The score itself is worked out in TypeScript from records that already exist (src/lib/scoreboard/score.ts):
-- tasks and their history, machine punches, leave requests, Day Close strikes, approved PIs, lead allotment.
-- Both tables are closed to the browser; every read and write goes through /api/scoreboard/*, which run on the
-- service role with the actor from the bearer token.
--
-- ROLLBACK (nothing else references these objects):
--   drop table public.scoreboard_daily, public.scoreboard_targets; drop function public.scoreboard_daily_frozen();

do $$
begin
  if to_regclass('public.users') is null then
    raise exception 'DEPENDENCY MISSING: users';
  end if;
end $$;

create table if not exists public.scoreboard_targets (
  month          date not null check (extract(day from month) = 1),
  employee_id    uuid not null references public.users(id),
  track          text not null default 'general' check (track in ('general', 'sales')),
  -- Sales: confirmed sales (approved PIs, before GST) the person should reach this month, in rupees.
  sales_target   numeric(14,2) check (sales_target is null or sales_target > 0),
  -- One role target: how many, and what counts.
  role_target    integer check (role_target is null or role_target between 1 and 10000),
  role_kind      text check (role_kind is null or role_kind in ('tasks_done', 'vendor_visits')),
  role_label     text check (role_label is null or length(btrim(role_label)) between 2 and 80),
  updated_by     uuid references public.users(id),
  updated_at     timestamptz not null default now(),
  primary key (month, employee_id),
  constraint scoreboard_targets_role_complete check (
    (role_target is null and role_kind is null) or (role_target is not null and role_kind is not null)
  )
);

create table if not exists public.scoreboard_daily (
  employee_id   uuid not null references public.users(id),
  score_date    date not null,
  month         date not null,
  track         text not null check (track in ('general', 'sales')),
  score         integer check (score is null or score between 0 and 100),
  earned        numeric(7,2) not null,
  possible      numeric(7,2) not null,
  parts         jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (employee_id, score_date)
);
create index if not exists scoreboard_daily_month_idx on public.scoreboard_daily (month, score_date);

-- A written day is a record: it never changes and is never removed.
create or replace function public.scoreboard_daily_frozen()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'SCOREBOARD_FROZEN: a day''s score is written once and never changed' using errcode = '42501';
end;
$$;
revoke all on function public.scoreboard_daily_frozen() from public, anon, authenticated;
drop trigger if exists scoreboard_daily_no_change on public.scoreboard_daily;
create trigger scoreboard_daily_no_change
  before update or delete on public.scoreboard_daily
  for each row execute function public.scoreboard_daily_frozen();

alter table public.scoreboard_targets enable row level security;
alter table public.scoreboard_daily enable row level security;
revoke all on public.scoreboard_targets, public.scoreboard_daily from public, anon, authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.scoreboard_daily', 'select')
     or has_table_privilege('anon', 'public.scoreboard_targets', 'select') then
    raise exception 'scoreboard tables must be closed to the browser';
  end if;
end $$;
