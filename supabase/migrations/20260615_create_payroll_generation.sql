-- Payroll generation: audit log of every generation run.
-- One row per POST /api/payroll/generate call.
-- Multiple runs against the same period are allowed (regeneration is idempotent at the
-- payroll_results level; each run produces a new generation row for traceability).

CREATE TABLE public.payroll_generation (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which period was being generated
  payroll_period_id     uuid        NOT NULL REFERENCES public.payroll_periods(id),

  -- Who triggered the run
  triggered_by          uuid        NOT NULL REFERENCES public.users(id),

  -- Lifecycle status of this generation run
  status                text        NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running', 'done', 'failed')),

  -- Counters written at completion
  employee_count        smallint    NOT NULL DEFAULT 0,
  skipped_count         smallint    NOT NULL DEFAULT 0,   -- skipped by engine guards
  failed_employee_ids   uuid[]      NOT NULL DEFAULT '{}', -- employees that errored

  error_message         text,        -- set when status = 'failed'
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_generation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read payroll generation"
  ON public.payroll_generation FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage payroll generation"
  ON public.payroll_generation FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- Index for listing runs per period
CREATE INDEX payroll_generation_period_idx
  ON public.payroll_generation (payroll_period_id, started_at DESC);

-- ─── Link payroll_results back to the generation run that produced them ────────
-- Nullable: results created before this migration have no generation link.
ALTER TABLE public.payroll_results
  ADD COLUMN IF NOT EXISTS payroll_generation_id uuid
    REFERENCES public.payroll_generation(id);
