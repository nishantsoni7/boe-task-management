-- DAY CLOSE: THE OWNER'S PAYROLL DECISION ON A HELD DAY (owner, 2026-11-18).
--
-- A hold that the person never cleared (by finishing or moving the work) is decided by the owner at payroll, in
-- Attendance -> Monthly Review: "Count the day" (pay as normal) or "Mark absent" (applied through the existing
-- attendance correction, so it is versioned, carries the owner's name and recalculates the draft). A hold left
-- undecided counts as present: nothing is ever deducted without that click.
--
-- WHAT THIS ADDS to day_close_holds:
--   decision       'counted' | 'absent', null until decided
--   decided_by     who decided (an administrator)
--   decided_at     when
--   correction_id  the attendance correction "Mark absent" wrote (null for "Count the day")
--
-- REQUIRES 20270802000100. Safe to run again. Closed to the browser as before.
--
-- ROLLBACK
--   alter table public.day_close_holds drop constraint day_close_holds_decision_complete,
--     drop column correction_id, drop column decided_at, drop column decided_by, drop column decision;

do $$
begin
  if to_regclass('public.day_close_holds') is null then
    raise exception 'DEPENDENCY MISSING: day_close_holds (20270802000100)';
  end if;
end $$;

alter table public.day_close_holds
  add column if not exists decision      text check (decision in ('counted', 'absent')),
  add column if not exists decided_by    uuid references public.users(id),
  add column if not exists decided_at    timestamptz,
  add column if not exists correction_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'day_close_holds_decision_complete') then
    alter table public.day_close_holds add constraint day_close_holds_decision_complete
      check ((decision is null) = (decided_by is null) and (decision is null) = (decided_at is null)
             and (decision = 'absent' or correction_id is null));
  end if;
end $$;

-- Self-check
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'day_close_holds' and column_name = 'decision') then
    raise exception 'day_close_holds.decision was not added';
  end if;
  if has_table_privilege('authenticated', 'public.day_close_holds', 'select') then
    raise exception 'day_close_holds must stay closed to the browser';
  end if;
end $$;
