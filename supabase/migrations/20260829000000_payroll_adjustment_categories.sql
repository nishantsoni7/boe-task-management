-- What a manual payroll adjustment IS, alongside which way it points.
--
-- WHAT THIS ADDS
-- --------------
--   public.payroll_pending_adjustments.adjustment_category text, nullable
--
-- WHY A COLUMN IS NEEDED AT ALL
-- -----------------------------
-- The table already has `adjustment_type`, but it holds only 'addition' or
-- 'deduction'. The salary-processing report has to state advance recovered,
-- previous salary pending, incentive, bonus, reimbursement and other additions
-- as SEPARATE lines, and five of those are all 'addition'. The only thing
-- currently distinguishing them is `description`, which is free text an admin
-- types — "Incentive", "incentive ", "Inc.", "as discussed". A report built by
-- matching prose would be wrong in a way nobody could see until they reconciled
-- it against a bank statement.
--
-- So the distinction becomes a value. This is the smallest change that supports
-- the required categories: one nullable column and one CHECK. No new table, no
-- change to how amounts are stored, and no change to how the engine reads a row
-- — `adjustment_type` still carries the direction and `amount` is still positive.
--
-- WHY NULLABLE, WITH NO DEFAULT AND NO BACKFILL
-- ---------------------------------------------
-- Every adjustment written before this column has no category, and none is
-- guessed for it. Reading "Bonus for Diwali" and stamping it `bonus` would be
-- inventing a fact: the admin who typed that was not choosing from this list,
-- and a description that merely CONTAINS a word is not a categorisation. A wrong
-- guess would silently move money between lines of a report people reconcile.
--
-- A DEFAULT would be the same mistake by another route — it would stamp every
-- future row that forgot to state a category as though it had stated one.
--
-- NULL therefore means "not stated". The application reports such a row under
-- the "Other addition" / "Other deduction" line matching its direction (see
-- reportingCategory in src/lib/payroll/adjustmentCategories.ts), which is a
-- presentation of an unknown rather than a rewrite of it. The row keeps its
-- NULL, and an admin can categorise it by editing it.
--
-- THE CHECK ENFORCES DIRECTION, NOT JUST MEMBERSHIP
-- -------------------------------------------------
-- An incentive cannot be a deduction and an advance recovery cannot be an
-- addition. A row whose category contradicted its own type would put a payment
-- onto the recovery line of a report — the amount and the label would disagree,
-- and the label is what a human reads. The constraint pairs the two so that
-- cannot be stored, by any path.
--
-- AUTHORIZATION
-- -------------
-- Unchanged. No policy is added, altered or dropped here. This is one more
-- column on rows whose visibility is already decided by the policies migration
-- 20260812000000 set: an employee reads their own adjustments, an admin reads
-- all. A category is a label on a row the caller could already read, so it
-- exposes nothing new to anybody.
--
-- PRODUCTION SAFETY
-- -----------------
-- Purely additive. One nullable column with no default, so no table rewrite and
-- no row is read, written or reclassified. Every statement is guarded, so
-- re-running is safe. Existing payroll is untouched and nothing is recalculated.
--
-- DEPLOYMENT ORDER
-- ----------------
-- Apply before the application code that selects adjustment_category. PostgREST
-- answers an unknown column with error 42703 rather than a null, so the
-- adjustments API and the salary-processing report would fail until this lands.
--
-- ROLLBACK
-- --------
--   ALTER TABLE public.payroll_pending_adjustments
--     DROP CONSTRAINT IF EXISTS payroll_pending_adjustments_category_check;
--   ALTER TABLE public.payroll_pending_adjustments
--     DROP COLUMN IF EXISTS adjustment_category;
-- Lossless for payroll: the engine never reads this column, so no salary figure
-- depends on it. The report falls back to the Other lines, which is exactly the
-- behaviour that preceded this migration.

-- ─── 1. The column ───────────────────────────────────────────────────────────

ALTER TABLE public.payroll_pending_adjustments
  ADD COLUMN IF NOT EXISTS adjustment_category text;

COMMENT ON COLUMN public.payroll_pending_adjustments.adjustment_category IS
  'What the adjustment is, alongside adjustment_type which says which way it points. NULL means not stated — every row predating this column — and is reported under the matching "Other" line rather than being guessed at. Never backfilled.';

-- ─── 2. Category and direction must agree ────────────────────────────────────
-- NULL passes: a legacy row has no category to contradict its type.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_pending_adjustments'::regclass
      AND conname  = 'payroll_pending_adjustments_category_check'
  ) THEN
    ALTER TABLE public.payroll_pending_adjustments
      ADD CONSTRAINT payroll_pending_adjustments_category_check
      CHECK (
        adjustment_category IS NULL
        OR (
          adjustment_type = 'addition'
          AND adjustment_category IN (
            'previous_salary_pending',
            'incentive',
            'bonus',
            'reimbursement',
            'other_addition'
          )
        )
        OR (
          adjustment_type = 'deduction'
          AND adjustment_category IN (
            'advance_recovery',
            'other_deduction'
          )
        )
      );
  END IF;
END $$;

-- ─── 3. Reporting reads this column by employee and month ────────────────────
-- The salary-processing report fetches one period's adjustments for a set of
-- employees. The existing indexes cover employee_id; this covers the month
-- scoping the report actually filters on.

CREATE INDEX IF NOT EXISTS payroll_pending_adjustments_period_idx
  ON public.payroll_pending_adjustments (payroll_year, payroll_month, employee_id);
