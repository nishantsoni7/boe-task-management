-- Payroll period lock audit fields.
-- locked_at: when the period was locked.
-- locked_by: which admin triggered the lock.

ALTER TABLE public.payroll_periods
  ADD COLUMN IF NOT EXISTS locked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by  uuid REFERENCES public.users(id);
