-- Payroll generation data model: result storage only.
-- No calculation logic, no UI, no API routes, no attendance changes.

-- ─── payroll_results ──────────────────────────────────────────────────────────
-- One row per employee per payroll period. Stores the final computed salary
-- outcome. monthly_salary is snapshotted at generation time so historical
-- records are unaffected by future salary changes.

CREATE TABLE public.payroll_results (
  id                        uuid           PRIMARY KEY DEFAULT gen_random_uuid(),

  payroll_period_id         uuid           NOT NULL REFERENCES public.payroll_periods(id),
  employee_id               uuid           NOT NULL REFERENCES public.users(id),

  -- Snapshot of salary at time of generation
  monthly_salary            numeric(12, 2) NOT NULL,

  -- Attendance summary (populated by calculation engine, all nullable until generated)
  working_days_in_month     smallint,
  days_present              numeric(4, 1),   -- 0.5 increments for half-days
  days_absent               numeric(4, 1),
  days_on_leave             numeric(4, 1),
  paid_leave_available      smallint,        -- always 1 in Phase 1
  paid_leave_used           smallint,

  -- Deduction totals in hours (populated by calculation engine)
  late_deduction_hours      numeric(6, 2),
  short_hours_deduction     numeric(6, 2),
  missing_punch_hours       numeric(6, 2),

  -- Whether unused paid leave absorbed late/short-hour deductions this month
  leave_absorbed_deductions boolean        NOT NULL DEFAULT false,

  -- Monetary totals (populated by calculation engine)
  gross_salary              numeric(12, 2),
  total_deductions          numeric(12, 2),
  pending_adjustment_total  numeric(12, 2) NOT NULL DEFAULT 0,
  net_salary                numeric(12, 2),

  status                    text           NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'locked')),
  admin_notes               text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payroll_results_period_employee_unique
    UNIQUE (payroll_period_id, employee_id)
);

ALTER TABLE public.payroll_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read payroll results"
  ON public.payroll_results FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage payroll results"
  ON public.payroll_results FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ─── payroll_deduction_lines ──────────────────────────────────────────────────
-- One row per deduction event (per day per type). Audit trail for why a given
-- amount was deducted. Cascades on delete so regenerating a result cleans its lines.

CREATE TABLE public.payroll_deduction_lines (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_result_id uuid          NOT NULL REFERENCES public.payroll_results(id) ON DELETE CASCADE,

  line_date         date          NOT NULL,
  deduction_type    text          NOT NULL
                      CHECK (deduction_type IN (
                        'late_arrival',
                        'early_checkout',
                        'missing_punch_in',
                        'missing_punch_out',
                        'absent',
                        'half_day',
                        'short_hours'
                      )),
  hours_deducted    numeric(5, 2) NOT NULL DEFAULT 0,
  amount_deducted   numeric(10, 2) NOT NULL DEFAULT 0,

  -- Manual override: admin waived this deduction (missing punch exemption, company-work exemption, etc.)
  is_overridden     boolean       NOT NULL DEFAULT false,
  override_reason   text,

  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_deduction_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read deduction lines"
  ON public.payroll_deduction_lines FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage deduction lines"
  ON public.payroll_deduction_lines FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ─── payroll_pending_adjustments ─────────────────────────────────────────────
-- Tracks carryover salary corrections across months.
-- A split adjustment (e.g. ₹2,000 across two months) is stored as two rows
-- at creation time so the second month's amount auto-appears without re-entry.
-- Positive amount = credit to employee. Negative amount = deduction.

CREATE TABLE public.payroll_pending_adjustments (
  id                    uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           uuid           NOT NULL REFERENCES public.users(id),

  -- Period this adjustment will be / was applied in (null = unscheduled/pending)
  applied_in_period_id  uuid           REFERENCES public.payroll_periods(id),

  -- Result row that consumed this adjustment (null until applied)
  payroll_result_id     uuid           REFERENCES public.payroll_results(id),

  description           text           NOT NULL,
  amount                numeric(10, 2) NOT NULL,  -- positive = add, negative = deduct

  status                text           NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'applied', 'cancelled')),

  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_pending_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read pending adjustments"
  ON public.payroll_pending_adjustments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage pending adjustments"
  ON public.payroll_pending_adjustments FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
