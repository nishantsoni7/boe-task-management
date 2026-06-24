-- Audit log for attendance corrections applied via the import upload flow.
-- One row per corrected employee/date pair per import operation.

CREATE TABLE IF NOT EXISTS public.attendance_correction_log (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  attendance_date  date        NOT NULL,
  old_check_in_at  timestamptz,
  new_check_in_at  timestamptz,
  old_check_out_at timestamptz,
  new_check_out_at timestamptz,
  corrected_by     uuid        NOT NULL REFERENCES public.users(id),
  corrected_at     timestamptz NOT NULL DEFAULT now(),
  source_file_name text
);

CREATE INDEX IF NOT EXISTS attendance_correction_log_user_date_idx
  ON public.attendance_correction_log (user_id, attendance_date);

CREATE INDEX IF NOT EXISTS attendance_correction_log_corrected_by_idx
  ON public.attendance_correction_log (corrected_by);

-- Only service-role writes; admins can read
ALTER TABLE public.attendance_correction_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_read_correction_log" ON public.attendance_correction_log;
CREATE POLICY "admins_read_correction_log"
  ON public.attendance_correction_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('admin', 'manager')
    )
  );
