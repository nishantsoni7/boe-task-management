-- Payroll period foundation: monthly payroll run tracking.
-- No calculations, no salary logic, no attendance deductions.

CREATE TABLE public.payroll_periods (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_month  smallint    NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
  payroll_year   smallint    NOT NULL CHECK (payroll_year >= 2020),
  status         text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payroll_periods_month_year_unique UNIQUE (payroll_month, payroll_year)
);

ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read payroll periods"
  ON public.payroll_periods FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage payroll periods"
  ON public.payroll_periods FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
