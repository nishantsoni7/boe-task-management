-- Historical impact of the single-punch import defects — READ ONLY.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NOTHING IN THIS FILE WRITES. Every statement is a SELECT. There is no UPDATE,
-- no INSERT, no DELETE, no DDL and no call to a function that mutates. It is
-- safe to run against production, but it has NOT been run — producing it was
-- part of the single-punch fix; running it and acting on it is a separate,
-- separately approved step.
--
-- Do not use the output to edit attendance or payroll directly. Historical
-- repair is out of scope for this change, and a locked payroll period must not
-- be reopened on the strength of a query.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT WENT WRONG, AND THEREFORE WHAT IS FINDABLE
--
--   Format A  A day with a departure punch and no arrival punch was DROPPED by
--             the parser before it reached the database. There is no row to
--             find. Query 1 can only produce CANDIDATES, and says so.
--
--   Format B  A lone punch was filed as check_in_at whatever the clock said, so
--             an evening departure became an arrival. These rows exist and are
--             identifiable exactly — query 2.
--
--   Either    A missing punch-out stacked a late-arrival deduction computed from
--             a punch nobody established was an arrival. Query 3 finds the
--             payroll lines, and query 4 prices them.
--
-- IST NOTE: attendance timestamps are timestamptz stored as UTC. Every query
-- below converts with `AT TIME ZONE 'Asia/Kolkata'` before comparing a clock
-- time. Comparing the raw UTC value would shift every punch by 5h30m and put
-- the 14:00 boundary in the wrong place.


-- ─── 1. Format A: working days that may have been dropped as OUT-only ────────
--
-- A dropped day left NO trace, so this is deliberately a candidate list: dates
-- with no attendance row at all, for employees who were being imported in that
-- month, excluding Sundays, company holidays and pre-joining dates.
--
-- Most rows returned will be genuine absences. The ones worth checking are
-- those where the same employee has punches on the days either side. Confirming
-- any individual date requires the original XLS for that month — the parser
-- discarded the information, so the database cannot distinguish "absent" from
-- "punched out only" on its own.

WITH imported_months AS (
  -- Employee-months that actually have imported attendance. Without this the
  -- query invents absences for every employee in every month since 2020.
  SELECT DISTINCT
         user_id,
         date_trunc('month', attendance_date)::date AS month_start
  FROM   public.attendance_records
),
candidate_dates AS (
  SELECT im.user_id,
         d::date AS attendance_date
  FROM   imported_months im
  CROSS JOIN LATERAL generate_series(
           im.month_start,
           (im.month_start + interval '1 month - 1 day')::date,
           interval '1 day'
         ) AS d
)
SELECT u.employee_code,
       u.full_name,
       c.attendance_date,
       to_char(c.attendance_date, 'Dy')          AS weekday,
       prev.check_out_at IS NOT NULL             AS worked_day_before,
       next.check_in_at  IS NOT NULL             AS worked_day_after
FROM   candidate_dates c
JOIN   public.users u ON u.id = c.user_id
LEFT   JOIN public.attendance_records ar
         ON ar.user_id = c.user_id AND ar.attendance_date = c.attendance_date
LEFT   JOIN public.attendance_records prev
         ON prev.user_id = c.user_id AND prev.attendance_date = c.attendance_date - 1
LEFT   JOIN public.attendance_records next
         ON next.user_id = c.user_id AND next.attendance_date = c.attendance_date + 1
WHERE  ar.id IS NULL                                        -- no record at all
  AND  EXTRACT(DOW FROM c.attendance_date) <> 0             -- not a Sunday
  AND  NOT EXISTS (
         SELECT 1 FROM public.payroll_holidays h
         WHERE  h.holiday_date = c.attendance_date
       )
  AND  (u.joining_date IS NULL OR c.attendance_date >= u.joining_date)
  AND  COALESCE(u.payroll_active, true)
  AND  COALESCE(u.is_deleted, false) = false
  -- The interesting shape: present on both neighbouring days.
  AND  prev.id IS NOT NULL
  AND  next.id IS NOT NULL
ORDER  BY u.full_name, c.attendance_date;


-- ─── 2. Format B: a lone punch at or after 14:00 IST filed as an arrival ─────
--
-- These are definite, not candidates. Under the fixed parser every one of them
-- would be stored as check_out_at with check_in_at NULL, i.e. a missing
-- punch-IN rather than a missing punch-OUT.
--
-- `ist_punch` is the wall-clock time the employee actually punched.

SELECT u.employee_code,
       u.full_name,
       ar.attendance_date,
       (ar.check_in_at AT TIME ZONE 'Asia/Kolkata')::time AS ist_punch,
       ar.status,
       pp.payroll_month,
       pp.payroll_year,
       pp.status                                           AS period_status
FROM   public.attendance_records ar
JOIN   public.users u ON u.id = ar.user_id
LEFT   JOIN public.payroll_periods pp
         ON pp.payroll_month = EXTRACT(MONTH FROM ar.attendance_date)::smallint
        AND pp.payroll_year  = EXTRACT(YEAR  FROM ar.attendance_date)::smallint
WHERE  ar.check_in_at  IS NOT NULL
  AND  ar.check_out_at IS NULL
  AND  (ar.check_in_at AT TIME ZONE 'Asia/Kolkata')::time >= TIME '14:00'
ORDER  BY u.full_name, ar.attendance_date;


-- ─── 3. Payroll lines where a missing punch stacked with a large lateness ────
--
-- The money symptom. A missing punch-out plus a late arrival on the same date is
-- legitimate when the arrival was real; it is the SIZE that marks the defect —
-- a "late arrival" of several hours is almost always an evening departure that
-- was read as an arrival.
--
-- The 3-hour threshold is a starting point, not a rule: 3 h of lateness means a
-- punch after 13:00, which is already implausible as an arrival. Lower it to
-- see more.

SELECT u.employee_code,
       u.full_name,
       pp.payroll_year,
       pp.payroll_month,
       pp.status                                        AS period_status,
       mp.line_date,
       mp.hours_deducted                                AS missing_punch_hours,
       la.hours_deducted                                AS late_hours,
       mp.amount_deducted + la.amount_deducted          AS combined_amount,
       ROUND(pr.monthly_salary / 26.0, 2)               AS per_day_rate,
       (mp.amount_deducted + la.amount_deducted)
         > (pr.monthly_salary / 26.0)                   AS exceeds_one_day_pay
FROM   public.payroll_deduction_lines mp
JOIN   public.payroll_deduction_lines la
         ON la.payroll_result_id = mp.payroll_result_id
        AND la.line_date         = mp.line_date
        AND la.deduction_type    = 'late_arrival'
JOIN   public.payroll_results pr ON pr.id = mp.payroll_result_id
JOIN   public.payroll_periods pp ON pp.id = pr.payroll_period_id
JOIN   public.users u            ON u.id  = pr.employee_id
WHERE  mp.deduction_type = 'missing_punch_out'
  AND  la.hours_deducted >= 3
ORDER  BY combined_amount DESC;


-- ─── 4. What it added up to, per payroll period ──────────────────────────────
--
-- The number to bring to a decision about historical repair: how much was
-- charged as late arrival on days that also carried a missing punch-out, split
-- by period, with the locked ones flagged. A locked period cannot be corrected
-- without an explicit unlock, which is an admin decision and out of scope here.

SELECT pp.payroll_year,
       pp.payroll_month,
       pp.status                                  AS period_status,
       COUNT(*)                                   AS affected_day_count,
       COUNT(DISTINCT pr.employee_id)             AS affected_employees,
       ROUND(SUM(la.amount_deducted), 2)          AS late_amount_on_missing_punch_days
FROM   public.payroll_deduction_lines mp
JOIN   public.payroll_deduction_lines la
         ON la.payroll_result_id = mp.payroll_result_id
        AND la.line_date         = mp.line_date
        AND la.deduction_type    = 'late_arrival'
JOIN   public.payroll_results pr ON pr.id = mp.payroll_result_id
JOIN   public.payroll_periods pp ON pp.id = pr.payroll_period_id
WHERE  mp.deduction_type = 'missing_punch_out'
GROUP  BY pp.payroll_year, pp.payroll_month, pp.status
ORDER  BY pp.payroll_year, pp.payroll_month;


-- ─── 5. Days already put right by an admin ───────────────────────────────────
--
-- Run before acting on anything above. A date with a current correction has
-- already been reviewed by a human and its payroll recomputed from the
-- correction, so it needs no repair whatever queries 2 and 3 say about the raw
-- row underneath it.

SELECT u.employee_code,
       u.full_name,
       adc.attendance_date,
       adc.day_treatment,
       adc.waive_missing_punch,
       adc.remark,
       adc.corrected_at
FROM   public.attendance_day_corrections adc
JOIN   public.users u ON u.id = adc.user_id
JOIN   public.attendance_records ar
         ON ar.user_id = adc.user_id
        AND ar.attendance_date = adc.attendance_date
WHERE  adc.is_current
  AND  ar.check_in_at  IS NOT NULL
  AND  ar.check_out_at IS NULL
  AND  (ar.check_in_at AT TIME ZONE 'Asia/Kolkata')::time >= TIME '14:00'
ORDER  BY u.full_name, adc.attendance_date;
