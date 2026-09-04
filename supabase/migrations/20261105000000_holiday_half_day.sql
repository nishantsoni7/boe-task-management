-- Full-day vs half-day company holidays.
--
-- A full-day holiday (unchanged) excludes a date from the working-day
-- calendar entirely — no employee is classified, charged, or counted present
-- or absent for it. A half-day holiday exempts only the declared half; the
-- other half remains a normal working obligation, evaluated by the real
-- attendance rules (late arrival, early checkout, absence — capped at half a
-- day, since only half a day was ever owed). See
-- src/lib/payroll/halfDayHoliday.ts and the half-day branch in
-- src/lib/payroll/engine.ts (buildWorkingDayCalendar / classifySingleDay).
--
-- ── Production safety ───────────────────────────────────────────────────────
-- Purely additive: two new nullable/defaulted columns and one CHECK
-- constraint on an existing table. No row is rewritten, no other table is
-- touched. Every existing holiday (e.g. Rakhi) gets holiday_type = 'full_day'
-- by the DEFAULT below and keeps behaving exactly as it does today — no
-- backfill needed.
--
-- ── Rollback ────────────────────────────────────────────────────────────────
-- Before any half-day holiday is recorded:
--   ALTER TABLE public.payroll_holidays DROP COLUMN half_session, DROP COLUMN holiday_type;
-- is complete and lossless — every row is still 'full_day' with the column
-- gone, identical to before this migration. AFTER a half-day holiday has been
-- recorded and payroll regenerated against it, dropping the columns does not
-- revert payroll_results — regenerate affected periods first (dropping the
-- columns then makes every holiday full_day again, which the engine has
-- always handled).

ALTER TABLE public.payroll_holidays
  ADD COLUMN IF NOT EXISTS holiday_type text NOT NULL DEFAULT 'full_day'
    CHECK (holiday_type IN ('full_day', 'half_day')),
  ADD COLUMN IF NOT EXISTS half_session text
    CHECK (half_session IN ('first_half', 'second_half'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_holidays_half_session_matches_type'
  ) THEN
    ALTER TABLE public.payroll_holidays
      ADD CONSTRAINT payroll_holidays_half_session_matches_type CHECK (
        (holiday_type = 'half_day' AND half_session IS NOT NULL) OR
        (holiday_type = 'full_day' AND half_session IS NULL)
      );
  END IF;
END $$;
