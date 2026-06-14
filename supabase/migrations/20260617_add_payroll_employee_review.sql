-- Employee review window: track when an employee has acknowledged their payroll draft.
-- employee_reviewed_at: null = not yet reviewed, timestamptz = moment employee clicked "Mark as Reviewed".

ALTER TABLE public.payroll_results
  ADD COLUMN IF NOT EXISTS employee_reviewed_at timestamptz;
