-- Manual attendance corrections — the override layer between the biometric
-- machine and payroll.
--
-- Why a separate table: public.attendance_records is written AND updated in
-- place by the fingerprint XLS import (src/app/api/attendance/import/route.ts).
-- A correction stored there would be silently overwritten by the next import of
-- the same month. The raw machine record therefore stays untouched, and payroll
-- resolves each day as:
--
--   raw attendance_records  →  current attendance_day_corrections row (if any)
--                           →  effective attendance  →  deductions  →  totals
--
-- History is never destroyed. Correcting a day again does not update the old
-- row: it marks it superseded and inserts a new current one, so every previous
-- correction — with its own before/after snapshot — remains readable.
--
-- ── Production safety ───────────────────────────────────────────────────────
-- Purely additive: one new table, its indexes and its policies. No existing
-- table is altered, no existing row is read or written, and attendance_records
-- is not referenced at all. Re-running is safe (IF NOT EXISTS / DROP POLICY IF
-- EXISTS throughout).
--
-- ── Rollback ────────────────────────────────────────────────────────────────
-- Before payroll has been regenerated:  DROP TABLE public.attendance_day_corrections;
-- is complete and lossless — no other table references it, and the payroll
-- engine treats an absent corrections list as "raw attendance only".
--
-- AFTER a correction has been saved, dropping the table does NOT revert payroll.
-- payroll_results and payroll_deduction_lines already hold figures computed from
-- the corrected attendance, and the record explaining them would be gone. To
-- roll back safely, first regenerate payroll for every affected period (which,
-- with the table dropped or emptied, recomputes from raw attendance), then drop.
-- Raw attendance_records is never touched either way, so regeneration always has
-- the original machine data to fall back to.

CREATE TABLE IF NOT EXISTS public.attendance_day_corrections (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  user_id                uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  attendance_date        date        NOT NULL,

  -- The effective punch pair for the day. Both are nullable: an admin may
  -- correct a day to "punch-out only" just as the machine may have recorded it.
  corrected_check_in_at  timestamptz,
  corrected_check_out_at timestamptz,

  -- How payroll must treat the day.
  --   auto      — classify the corrected punches with the normal rules
  --   full_day  — count a full paid present day, no attendance deduction
  --   half_day  — count a half day (the standard half-day deduction still applies)
  --   absent    — count a full absence
  day_treatment          text        NOT NULL DEFAULT 'auto'
                                     CHECK (day_treatment IN ('auto', 'full_day', 'half_day', 'absent')),

  -- Exemptions applied on top of 'auto'. PAYROLL_RULES_V1 already allows a
  -- payroll admin to waive these in genuine exception cases.
  waive_late_arrival     boolean     NOT NULL DEFAULT false,
  waive_early_checkout   boolean     NOT NULL DEFAULT false,
  waive_missing_punch    boolean     NOT NULL DEFAULT false,

  -- Mandatory. A correction with no stated reason is not auditable.
  -- NOTE: btrim() with no second argument strips SPACES ONLY, so this rejects
  -- '' and '   ' but not a tab or newline. Tightened in 20260808000000 — this
  -- line is left as applied so the file matches the database.
  remark                 text        NOT NULL CHECK (btrim(remark) <> ''),

  -- ── Audit snapshot: what changed, and what it cost ───────────────────────
  original_check_in_at        timestamptz,
  original_check_out_at       timestamptz,
  original_classification     text,
  revised_classification      text,
  original_deduction_amount   numeric(10, 2),
  revised_deduction_amount    numeric(10, 2),
  original_net_salary         numeric(12, 2),
  revised_net_salary          numeric(12, 2),

  payroll_period_id      uuid        REFERENCES public.payroll_periods(id),

  corrected_by           uuid        NOT NULL REFERENCES public.users(id),
  corrected_at           timestamptz NOT NULL DEFAULT now(),

  -- Version chain. is_current is the single active correction for the day.
  is_current             boolean     NOT NULL DEFAULT true,
  superseded_at          timestamptz,
  superseded_by          uuid        REFERENCES public.attendance_day_corrections(id),

  -- A corrected punch-out can never precede the corrected punch-in.
  CONSTRAINT attendance_day_corrections_punch_order CHECK (
    corrected_check_in_at IS NULL
    OR corrected_check_out_at IS NULL
    OR corrected_check_out_at > corrected_check_in_at
  ),

  -- Superseded rows must carry the timestamp, current rows must not.
  CONSTRAINT attendance_day_corrections_supersede_consistent CHECK (
    (is_current AND superseded_at IS NULL) OR (NOT is_current AND superseded_at IS NOT NULL)
  )
);

-- At most one active correction per employee per date. This is what makes
-- "duplicate active corrections" impossible rather than merely discouraged.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_day_corrections_current_unique
  ON public.attendance_day_corrections (user_id, attendance_date)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS attendance_day_corrections_user_date_idx
  ON public.attendance_day_corrections (user_id, attendance_date);

CREATE INDEX IF NOT EXISTS attendance_day_corrections_corrected_by_idx
  ON public.attendance_day_corrections (corrected_by);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Reads: admins see everything; an employee sees the corrections applied to
-- their own attendance, including the remark. Writes: none. Every insert and
-- supersede goes through the service-role route, which is the only place the
-- payroll lock and the recalculation are enforced together.

ALTER TABLE public.attendance_day_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_read_attendance_corrections" ON public.attendance_day_corrections;
CREATE POLICY "admins_read_attendance_corrections"
  ON public.attendance_day_corrections
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "users_read_own_attendance_corrections" ON public.attendance_day_corrections;
CREATE POLICY "users_read_own_attendance_corrections"
  ON public.attendance_day_corrections
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
