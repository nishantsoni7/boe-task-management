-- ═══════════════════════════════════════════════════════════════════════════
-- 20270222000000  Attendance requests: one LIVE copy of an identical request
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY
-- ---
-- POST /api/attendance-requests already refuses or answers a repeat request
-- (double tap, retry after a lost response) by reading the employee's live
-- requests first. A read followed by an insert is not atomic: two requests that
-- arrive together can both pass the read. These partial unique indexes make the
-- database the backstop, for EXACT repeats only — the shapes the app treats as
-- "the same request":
--
--   late_arrival     one live request per employee per date
--   early_departure  one live request per employee per date
--   half_day         one live request per employee per date
--   full_day_leave   one live request per employee per (start, end)
--   time_out         one live request per employee per date and time window
--
-- "Live" = pending or approved. A cancelled (withdrawn or replaced) or rejected
-- request never blocks a new one. Overlapping-but-different requests (a leave
-- over other requests, overlapping time-out windows) stay checked by the app
-- (findConflict in src/lib/attendance/requests.ts); nothing here loosens or
-- tightens what the app allows, and a late arrival plus an early departure on
-- one day is still legitimate.
--
-- The application does not depend on these indexes: without them the retry path
-- still returns the existing request. The handler maps a 23505 on
-- attendance_requests_live_* to the same answer.
--
-- CORRECTIONS
-- -----------
-- A correction inserts a new row; attendance_requests_guard() retires the
-- original (status → cancelled) inside the BEFORE INSERT trigger, before the
-- unique check, so correcting a request without changing its date is unaffected.
-- (Verified on a private database; see the PR.)
--
-- PRODUCTION SAFETY
-- -----------------
-- Additive: five indexes, no table rewrite, no data change. CREATE UNIQUE INDEX
-- fails, changing nothing, if a live duplicate already exists. Check first:
--
--   select employee_id, request_type, start_date, count(*)
--     from public.attendance_requests
--    where status in ('pending', 'approved')
--      and request_type in ('late_arrival', 'early_departure', 'half_day')
--    group by 1, 2, 3 having count(*) > 1;
--   select employee_id, start_date, end_date, count(*)
--     from public.attendance_requests
--    where status in ('pending', 'approved') and request_type = 'full_day_leave'
--    group by 1, 2, 3 having count(*) > 1;
--   select employee_id, start_date, departure_time, return_time, count(*)
--     from public.attendance_requests
--    where status in ('pending', 'approved') and request_type = 'time_out'
--    group by 1, 2, 3, 4 having count(*) > 1;
--
-- ROLLBACK
-- --------
--   drop index if exists public.attendance_requests_live_late_arrival;
--   drop index if exists public.attendance_requests_live_early_departure;
--   drop index if exists public.attendance_requests_live_half_day;
--   drop index if exists public.attendance_requests_live_full_day_leave;
--   drop index if exists public.attendance_requests_live_time_out;

create unique index if not exists attendance_requests_live_late_arrival
  on public.attendance_requests (employee_id, start_date)
  where status in ('pending', 'approved') and request_type = 'late_arrival';

create unique index if not exists attendance_requests_live_early_departure
  on public.attendance_requests (employee_id, start_date)
  where status in ('pending', 'approved') and request_type = 'early_departure';

create unique index if not exists attendance_requests_live_half_day
  on public.attendance_requests (employee_id, start_date)
  where status in ('pending', 'approved') and request_type = 'half_day';

create unique index if not exists attendance_requests_live_full_day_leave
  on public.attendance_requests (employee_id, start_date, end_date)
  where status in ('pending', 'approved') and request_type = 'full_day_leave';

create unique index if not exists attendance_requests_live_time_out
  on public.attendance_requests (employee_id, start_date, departure_time, return_time)
  where status in ('pending', 'approved') and request_type = 'time_out';
