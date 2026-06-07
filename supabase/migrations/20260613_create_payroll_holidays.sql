-- Payroll holidays: company-defined non-working days stored per date.
-- Used by the payroll calculation engine to skip deductions on these days.
-- Sundays are excluded in code; this table covers festival and government holidays.

CREATE TABLE public.payroll_holidays (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date  date        NOT NULL,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payroll_holidays_date_unique UNIQUE (holiday_date)
);

-- Index on holiday_date for range lookups during payroll generation
CREATE INDEX payroll_holidays_date_idx
  ON public.payroll_holidays (holiday_date);

ALTER TABLE public.payroll_holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read holidays"
  ON public.payroll_holidays FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage holidays"
  ON public.payroll_holidays FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
