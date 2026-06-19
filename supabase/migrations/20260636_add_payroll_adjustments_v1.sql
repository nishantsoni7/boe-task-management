-- Payroll Adjustments V1
-- Extends payroll_pending_adjustments with the fields needed for the
-- month-scoped manual adjustment workflow (admin-only, pre-lock).
--
-- Existing columns kept as-is so generation code still compiles:
--   id, employee_id, applied_in_period_id, payroll_result_id,
--   description (used as note), amount, status, created_at

ALTER TABLE public.payroll_pending_adjustments
  ADD COLUMN IF NOT EXISTS adjustment_type text NOT NULL DEFAULT 'addition'
    CHECK (adjustment_type IN ('addition', 'deduction')),
  ADD COLUMN IF NOT EXISTS payroll_month   smallint,
  ADD COLUMN IF NOT EXISTS payroll_year    smallint,
  ADD COLUMN IF NOT EXISTS created_by      uuid REFERENCES public.users(id);

-- amount is now always stored as a positive value; adjustment_type decides direction.
-- Existing rows (if any) had amount as signed — make them consistent.
UPDATE public.payroll_pending_adjustments
  SET adjustment_type = 'deduction', amount = ABS(amount)
  WHERE amount < 0;
