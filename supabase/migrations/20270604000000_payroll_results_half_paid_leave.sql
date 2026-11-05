-- Payroll: a payslip can hold HALF a paid leave.
--
-- THE DEFECT
-- The payroll rules give 0.5 paid leave to anyone present 11 to 15 days in a month
-- (PAID_LEAVE_TIERS) and can spend it on one half day (engine.ts, stage 2b), so
-- payroll_results.paid_leave_available and paid_leave_used can be 0.5. Both were created
-- as smallint ("always 1 in Phase 1", 20260612000000), and Postgres refuses 0.5 for a
-- smallint (22P02 invalid input syntax for type smallint). A payslip in that band could
-- not be saved: generation recorded the employee as failed (the reason was not kept), and
-- an attendance correction that landed in the band rolled itself back.
-- First seen for October 2026: two employees, with 15 and 14 days present, were left off the
-- run. No earlier month had anyone in the band.
--
-- THE CHANGE
-- numeric(3,1), the same shape as days_present (numeric(4,1), "0.5 increments").
-- Existing values are whole (0 or 1) and are kept exactly. Nothing else names these two
-- columns: no view, rule, policy, check constraint or index (the ALTER would stop with an
-- error if something did, and change nothing). The table holds a few dozen rows.
--
-- ROLLBACK
--   alter table public.payroll_results
--     alter column paid_leave_available type smallint using round(paid_leave_available)::smallint,
--     alter column paid_leave_used      type smallint using round(paid_leave_used)::smallint;
-- Safe only before any half has been stored: afterwards it would round 0.5 up to 1 and
-- change what a payslip says.

alter table public.payroll_results
  alter column paid_leave_available type numeric(3, 1) using paid_leave_available::numeric(3, 1),
  alter column paid_leave_used      type numeric(3, 1) using paid_leave_used::numeric(3, 1);

-- The file asserts its own result, so an apply that left a column whole-number aborts.
do $$
declare
  col         text;
  v_type      text;
  v_precision integer;
  v_scale     integer;
begin
  foreach col in array array['paid_leave_available', 'paid_leave_used'] loop
    select data_type, numeric_precision, numeric_scale
      into v_type, v_precision, v_scale
      from information_schema.columns
     where table_schema = 'public' and table_name = 'payroll_results' and column_name = col;

    if v_type is distinct from 'numeric' or v_precision is distinct from 3 or v_scale is distinct from 1 then
      raise exception 'PAID_LEAVE_HALF: payroll_results.% is % (%, %), expected numeric(3,1)',
        col, v_type, v_precision, v_scale;
    end if;
  end loop;
end $$;
