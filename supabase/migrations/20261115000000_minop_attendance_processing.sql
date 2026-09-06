-- Stage 2 of the Minop biometric integration: additive columns only.
--
-- Two small, separate additions:
--
-- 1. Processing OUTCOME columns on the existing raw delivery table. The raw
--    transport fields from Stage 1 (raw_body, payload, body_sha256,
--    processing_status, error_text) describe what Minop sent and whether BOE
--    could read it as JSON at all — they stay untouched and immutable. These
--    new columns describe a SEPARATE, later question: what BOE's attendance
--    processor did with an already-received, well-formed delivery. Keeping
--    them apart means a re-run of the processor can never contradict what was
--    actually received.
--
-- 2. `attendance_records.source`, so a row this branch merges from a live
--    Minop punch can be told apart from a CSV-imported one. This is the
--    minimum needed to fix the current-day coverage signal in
--    employee-monthly-detail: that route's "how far did the company get this
--    month" read must stay scoped to CSV-imported rows, or one employee's
--    live Minop punch today would make every OTHER employee's missing CSV day
--    look imported rather than not-yet-uploaded.

ALTER TABLE public.minop_webhook_deliveries
  ADD COLUMN attendance_status text
    CHECK (attendance_status IN (
      'pending',
      'processed',
      'ignored_unsupported_type',
      'unmapped',
      'mapping_conflict',
      'inactive_employee',
      'payroll_locked',
      'malformed_event',
      'error'
    )),
  ADD COLUMN attendance_processed_at timestamptz,
  ADD COLUMN attendance_error text,
  ADD COLUMN mapped_user_id uuid REFERENCES public.users(id),
  ADD COLUMN punch_type text,
  ADD COLUMN punch_time_utc timestamptz;

-- Only a 'received' delivery is ever a processing candidate; a quarantined one
-- has no payload to process. `attendance_status` is therefore NULL exactly
-- when `processing_status <> 'received'`, and 'pending' the moment it is.
ALTER TABLE public.minop_webhook_deliveries
  ADD CONSTRAINT minop_webhook_deliveries_attendance_status_needs_payload
  CHECK (attendance_status IS NULL OR processing_status = 'received');

CREATE INDEX minop_webhook_deliveries_attendance_status_idx
  ON public.minop_webhook_deliveries (attendance_status)
  WHERE attendance_status IS NOT NULL;

COMMENT ON COLUMN public.minop_webhook_deliveries.attendance_status IS
  'Outcome of turning this already-received delivery into attendance. NULL for a quarantined delivery, which was never a candidate.';
COMMENT ON COLUMN public.minop_webhook_deliveries.mapped_user_id IS
  'The BOE employee this delivery''s PunchLog.UserId resolved to, when it resolved to exactly one active employee.';
COMMENT ON COLUMN public.minop_webhook_deliveries.punch_type IS
  'PunchLog.Type as received (e.g. CheckIn, CheckOut, BreakIn), independent of whether this branch currently acts on it.';
COMMENT ON COLUMN public.minop_webhook_deliveries.punch_time_utc IS
  'PunchLog.LogTime parsed as a UTC instant, once validated. Null if the delivery was never a valid candidate.';

ALTER TABLE public.attendance_records
  ADD COLUMN source text
    CHECK (source IS NULL OR source = 'minop');

COMMENT ON COLUMN public.attendance_records.source IS
  'Set to ''minop'' by the Minop attendance processor. NULL for every row written by CSV import or an admin correction, which remain the coverage signal for employees with no live device.';
