-- Add 'generated' as a valid payroll_periods status.
-- Previously only 'draft' and 'locked' were allowed; generation now transitions
-- the period to 'generated' so the status reflects actual engine output.

ALTER TABLE public.payroll_periods
  DROP CONSTRAINT IF EXISTS payroll_periods_status_check;

ALTER TABLE public.payroll_periods
  ADD CONSTRAINT payroll_periods_status_check
    CHECK (status IN ('draft', 'generated', 'locked'));
