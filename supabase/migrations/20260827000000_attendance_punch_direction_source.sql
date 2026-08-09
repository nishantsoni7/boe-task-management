-- Persist how a day's IN/OUT split was established.
--
-- WHY THIS COLUMN EXISTS
-- ----------------------
-- A working day with exactly one punch costs a flat missing-punch charge, and a
-- late-arrival deduction may be added on top — but only when something actually
-- STATED that the punch present was the arrival. Where the direction was worked
-- out from the clock alone, charging lateness means charging an employee on the
-- strength of a guess.
--
-- The two supported fingerprint exports differ exactly there:
--
--   Format A  puts arrivals and departures on separate rows. The machine states
--             the direction; the parser reads it.               → 'confirmed'
--   Format B  puts every punch of a day in one cell. With two or more punches
--             the first and last are the pair (nothing is decided → 'confirmed');
--             with exactly ONE there is nothing in the file but the time, so the
--             direction is derived from a divider.              → 'inferred'
--
-- The parser has known this since the single-punch fix, but payroll generation
-- runs days or weeks after the import, in a different request, reading
-- attendance_records. Without somewhere to put the distinction it was lost at
-- the database boundary and every stored row had to be treated as a guess. This
-- column is that somewhere, and nothing more.
--
-- WHY NULLABLE, WITH NO DEFAULT AND NO BACKFILL
-- ---------------------------------------------
-- Every row written before this migration came from a parser that filed a lone
-- punch as check_in_at whatever the clock said. Its direction is therefore
-- exactly as trustworthy as a guess — but we cannot say WHICH guess, because the
-- information was discarded rather than recorded wrongly.
--
-- So legacy rows stay NULL. A DEFAULT would stamp new rows the importer had not
-- actually classified, and a backfill would have to invent the very fact this
-- column exists to record. The application reads NULL as 'inferred'
-- (resolveDirectionSource in src/lib/attendance/punchDirection.ts), which is the
-- cautious reading and preserves today's behaviour for every existing row.
--
-- PRODUCTION SAFETY
-- -----------------
-- Purely additive: one nullable column and one CHECK constraint. No existing row
-- is read, rewritten or deleted. No default means no table rewrite. No policy,
-- grant, index or other column is touched, so RLS is unchanged and no new data
-- is exposed to anybody. Re-running is safe.
--
-- DEPLOYMENT ORDER IS NOT OPTIONAL: THIS MIGRATION MUST BE APPLIED FIRST.
--
-- Old application code + this column        SAFE. Nothing selects or writes it,
--                                           and NULL satisfies the constraint.
--
-- New application code + no column          BROKEN. The payroll and attendance
--                                           reads name punch_direction_source in
--                                           their select lists, and PostgREST
--                                           answers an unknown column with an
--                                           error (42703) rather than a null. So
--                                           payroll generation, Monthly Review,
--                                           attendance import and attendance
--                                           preview would all fail until this
--                                           lands.
--
-- Apply this to the target database BEFORE the application deploy that reads the
-- column reaches it. On this project that means running it against production
-- before the branch merges, since merging to main deploys.
--
-- ROLLBACK
-- --------
--   ALTER TABLE public.attendance_records
--     DROP CONSTRAINT IF EXISTS attendance_records_punch_direction_source_check;
--   ALTER TABLE public.attendance_records
--     DROP COLUMN IF EXISTS punch_direction_source;
-- Lossless for payroll: with the column gone every row reads as 'inferred'
-- again, which is exactly the behaviour that preceded it.

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS punch_direction_source text;

-- Added separately, and guarded, so a re-run cannot fail on a duplicate
-- constraint name. NULL passes a CHECK, so legacy rows need no exemption.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attendance_records'::regclass
      AND conname  = 'attendance_records_punch_direction_source_check'
  ) THEN
    ALTER TABLE public.attendance_records
      ADD CONSTRAINT attendance_records_punch_direction_source_check
      CHECK (punch_direction_source IN ('confirmed', 'inferred'));
  END IF;
END $$;

COMMENT ON COLUMN public.attendance_records.punch_direction_source IS
  'How the IN/OUT split for this day was established. '
  '''confirmed'' = the direction came from an explicit source marker (Format A''s '
  'separate IN/OUT rows) or from a complete punch pair, so nothing was decided by '
  'the parser. '
  '''inferred'' = a single unmarked punch (Format B) was classified using the '
  'temporary time-of-day divider; treat any time-based deduction drawn from it as '
  'provisional. '
  'NULL = a legacy record imported before this column existed, whose direction was '
  'not preserved; the application resolves it as ''inferred''.';
