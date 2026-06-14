-- Relax attendance_records.status constraint to support fingerprint Excel import values.
-- Existing data is untouched.

ALTER TABLE public.attendance_records
  DROP CONSTRAINT IF EXISTS attendance_records_status_check;

ALTER TABLE public.attendance_records
  ADD CONSTRAINT attendance_records_status_check
  CHECK (status IN ('present', 'checked_in', 'absent', 'half_day'));
