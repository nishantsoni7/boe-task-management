-- Attendance V1: daily attendance records linked to public.users.
-- One record per employee per calendar date. No separate employees table.

CREATE TABLE IF NOT EXISTS public.attendance_records (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  attendance_date date        NOT NULL DEFAULT CURRENT_DATE,
  check_in_at     timestamptz,
  check_out_at    timestamptz,
  status          text        NOT NULL DEFAULT 'checked_in'
                              CHECK (status IN ('present', 'checked_in')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- One record per employee per day
  CONSTRAINT attendance_records_user_date_unique UNIQUE (user_id, attendance_date)
);

-- Auto-update updated_at on every write
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_records_set_updated_at ON public.attendance_records;
CREATE TRIGGER attendance_records_set_updated_at
  BEFORE UPDATE ON public.attendance_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Index for date-range queries (dashboard counts by date)
CREATE INDEX IF NOT EXISTS attendance_records_date_idx
  ON public.attendance_records (attendance_date);

-- Index for per-user lookups
CREATE INDEX IF NOT EXISTS attendance_records_user_idx
  ON public.attendance_records (user_id);

-- RLS: users can read their own records; all writes are via service-role API routes
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_attendance" ON public.attendance_records;
CREATE POLICY "users_read_own_attendance"
  ON public.attendance_records
  FOR SELECT
  USING (auth.uid() = user_id);
