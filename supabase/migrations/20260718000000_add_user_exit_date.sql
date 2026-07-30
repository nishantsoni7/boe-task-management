-- Employee exit date.
--
-- Performance scoring needs to know the last day an employee was expected to
-- work, so days after they left are not counted as zero-score working days.
--
-- What already existed and was reused instead of being rebuilt:
--   users.joining_date        → start boundary                (20260608000100)
--   payroll_holidays          → company holidays              (20260613)
--   users.is_deleted/deleted_at → soft-delete exit instant    (20260605)
--   Sunday-as-weekly-off      → rule already in the payroll engine
--
-- The only missing piece is an exit date for an employee who has left but was
-- never soft-deleted: users.is_active can be false with no record of *when*
-- that happened. Scoring falls back to deleted_at when this column is null.
--
-- Additive and nullable. No backfill, no default, no behaviour change for any
-- existing row: null means "no exit recorded", which is how every current row
-- is already treated.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS exit_date date;

COMMENT ON COLUMN public.users.exit_date IS
  'Last working day. Dates after this are not counted as expected working days '
  'for performance scoring. Null means the employee has not left.';

-- Guard against data-entry inversion; existing rows are all null so this
-- validates trivially.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_exit_after_joining;

ALTER TABLE public.users
  ADD CONSTRAINT users_exit_after_joining
  CHECK (exit_date IS NULL OR joining_date IS NULL OR exit_date >= joining_date);
