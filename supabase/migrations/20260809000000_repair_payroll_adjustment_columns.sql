-- Repair: payroll_pending_adjustments is missing the columns 20260636 declared.
--
-- `supabase migration list` reports 20260636 as applied — the version row is in
-- supabase_migrations.schema_migrations — but adjustment_type, payroll_month,
-- payroll_year and created_by do not exist on the table. The version was
-- recorded without the DDL taking effect, so the schema and the migration
-- history disagree.
--
-- This was found by an API call failing with
--   "column payroll_pending_adjustments.adjustment_type does not exist"
-- and confirmed column by column against the live table.
--
-- What was broken by it, all of it pre-existing:
--   * POST/GET /api/payroll/adjustments — the entire manual adjustment feature,
--     which writes adjustment_type/payroll_month/payroll_year/created_by.
--   * GET /api/payroll/monthly-review/detail — selects adjustment_type.
-- Payroll generation itself survived only because store.fetchPendingAdjustments
-- selected `amount` alone, which is the same reading that made a manual
-- deduction increase net salary.
--
-- Re-applying 20260636's intent forward, idempotently, rather than editing an
-- already-recorded migration. Safe to run whether or not the columns exist.

ALTER TABLE public.payroll_pending_adjustments
  ADD COLUMN IF NOT EXISTS adjustment_type text NOT NULL DEFAULT 'addition',
  ADD COLUMN IF NOT EXISTS payroll_month   smallint,
  ADD COLUMN IF NOT EXISTS payroll_year    smallint,
  ADD COLUMN IF NOT EXISTS created_by      uuid REFERENCES public.users(id);

-- The direction check, added separately so a re-run cannot fail on a duplicate
-- constraint name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_pending_adjustments'::regclass
      AND conname  = 'payroll_pending_adjustments_adjustment_type_check'
  ) THEN
    ALTER TABLE public.payroll_pending_adjustments
      ADD CONSTRAINT payroll_pending_adjustments_adjustment_type_check
      CHECK (adjustment_type IN ('addition', 'deduction'));
  END IF;
END $$;

-- amount is stored positive with the direction in adjustment_type. Any row that
-- predates that convention still carries a signed amount, so normalise it —
-- the same statement 20260636 carried, and a no-op when there is nothing to fix.
UPDATE public.payroll_pending_adjustments
  SET adjustment_type = 'deduction', amount = ABS(amount)
  WHERE amount < 0;

-- Index for the month-scoped lookup the payroll engine now performs.
CREATE INDEX IF NOT EXISTS payroll_pending_adjustments_employee_period_idx
  ON public.payroll_pending_adjustments (employee_id, payroll_year, payroll_month)
  WHERE status = 'pending';
