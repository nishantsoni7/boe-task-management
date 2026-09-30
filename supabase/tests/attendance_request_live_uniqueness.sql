-- Assertions for 20270222000000_attendance_request_live_uniqueness.sql.
--
-- Run on a DISPOSABLE database that already has the attendance-request schema
-- (20270215000000) and the live-uniqueness migration applied. It inserts a test
-- user and requests, prints one PASS/FAIL row per check, and never touches a
-- linked project. Every row must read PASS. Expected outcome on 2026-09-30 in a
-- private database: 19 of 19 PASS.
--
--   docker exec -i <db-container> psql -U postgres -d <disposable-db> -A -t < supabase/tests/attendance_request_live_uniqueness.sql
--
insert into public.users (id, full_name, role) values ('11111111-1111-1111-1111-111111111111','Asha','member');
create temp table res (n text, ok boolean, note text);
create or replace function pg_temp.try(n text, sql text, expect_fail boolean) returns void language plpgsql as $$
declare failed boolean := false; msg text;
begin
  begin execute sql; exception when others then failed := true; msg := sqlerrm; end;
  insert into res values (n, failed = expect_fail, coalesce(left(msg, 90), 'ok'));
end $$;
-- helper: insert shape
create or replace function pg_temp.ins(t text, d date, e date, dep time, ret time, half text, kind text, exp time default null) returns text language sql as $$
 select format($f$insert into public.attendance_requests (employee_id, request_type, start_date, end_date, expected_arrival_time, departure_time, return_time, half_session, work_kind, reason_code, shift_start_at, informed_before_shift) values ('11111111-1111-1111-1111-111111111111', %L, %L, %L, %L, %L, %L, %L, %L, 'personal', now(), true)$f$, t, d, e, exp, dep, ret, half, kind) $$;
select pg_temp.try('late #1', pg_temp.ins('late_arrival','2026-10-06','2026-10-06',null,null,null,null,'10:45'), false);
select pg_temp.try('late duplicate (different expected time) refused', pg_temp.ins('late_arrival','2026-10-06','2026-10-06',null,null,null,null,'11:15'), true);
select pg_temp.try('early same day allowed', pg_temp.ins('early_departure','2026-10-06','2026-10-06','17:00',null,null,null), false);
select pg_temp.try('early duplicate refused', pg_temp.ins('early_departure','2026-10-06','2026-10-06','16:00',null,null,null), true);
select pg_temp.try('time_out 13-14 allowed', pg_temp.ins('time_out','2026-10-06','2026-10-06','13:00','14:00',null,'personal'), false);
select pg_temp.try('time_out 15-15:30 (non-overlapping) allowed', pg_temp.ins('time_out','2026-10-06','2026-10-06','15:00','15:30',null,'company'), false);
select pg_temp.try('time_out 13-14 exact duplicate refused', pg_temp.ins('time_out','2026-10-06','2026-10-06','13:00','14:00',null,'personal'), true);
select pg_temp.try('half day first', pg_temp.ins('half_day','2026-10-07','2026-10-07',null,null,'first_half',null), false);
select pg_temp.try('half day second same date refused (one half per date)', pg_temp.ins('half_day','2026-10-07','2026-10-07',null,null,'second_half',null), true);
select pg_temp.try('leave 8-9 Oct', pg_temp.ins('full_day_leave','2026-10-08','2026-10-09',null,null,null,null), false);
select pg_temp.try('leave 8-9 Oct exact duplicate refused', pg_temp.ins('full_day_leave','2026-10-08','2026-10-09',null,null,null,null), true);
select pg_temp.try('leave 9-10 Oct (overlap, app-checked) not blocked by index', pg_temp.ins('full_day_leave','2026-10-09','2026-10-10',null,null,null,null), false);
-- cancelled / rejected never block
update public.attendance_requests set status='cancelled', cancelled_at=now(), cancel_reason='w' where request_type='late_arrival';
select pg_temp.try('late again after the first was withdrawn', pg_temp.ins('late_arrival','2026-10-06','2026-10-06',null,null,null,null,'10:45'), false);
-- correction of the same date: new row replaces the old in the trigger, must not collide
insert into public.attendance_requests (employee_id, request_type, start_date, end_date, expected_arrival_time, reason_code, shift_start_at, informed_before_shift)
  values ('11111111-1111-1111-1111-111111111111','late_arrival','2026-10-12','2026-10-12','10:30','personal', now(), true);
select pg_temp.try('correction (same date, new time) via replaces_request_id',
  $q$insert into public.attendance_requests (employee_id, request_type, start_date, end_date, expected_arrival_time, reason_code, shift_start_at, informed_before_shift, replaces_request_id)
     select employee_id,'late_arrival',start_date,end_date,'10:50','personal', now(), true, id from public.attendance_requests where start_date='2026-10-12' and status='pending'$q$, false);
select pg_temp.try('exactly one live late arrival on 12 Oct after the correction', $q$do $x$ begin if (select count(*) from public.attendance_requests where start_date='2026-10-12' and status in ('pending','approved'))<>1 then raise exception 'count wrong'; end if; end $x$$q$, false);
-- reviving a rejected request while an identical live one exists is refused (decision path)
select pg_temp.try('setup rejected', $q$insert into public.attendance_requests (employee_id, request_type, start_date, end_date, reason_code, shift_start_at, informed_before_shift, half_session)
  values ('11111111-1111-1111-1111-111111111111','half_day','2026-10-20','2026-10-20','personal', now(), true,'first_half')$q$, false);
select pg_temp.try('reject it', $q$update public.attendance_requests set status='rejected', decided_by='11111111-1111-1111-1111-111111111111', decided_at=now(), decision_note='no' where start_date='2026-10-20'$q$, false);
select pg_temp.try('new identical half day allowed while old is rejected', pg_temp.ins('half_day','2026-10-20','2026-10-20',null,null,'first_half',null), false);
select pg_temp.try('re-approving the rejected one now collides (mapped to 409 by the handler)', $q$update public.attendance_requests set status='approved', decision_note='reconsidered' where start_date='2026-10-20' and status='rejected'$q$, true);
select n, case when ok then 'PASS' else 'FAIL' end as result, note from res order by 1;
