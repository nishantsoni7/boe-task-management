-- Employee objections against their own attendance or payroll.
--
-- WHAT THIS IS NOT
-- ----------------
-- It is not a correction. Nothing in this file can change a punch, a
-- classification, a deduction, a salary or an adjustment. An objection is an
-- employee saying "this looks wrong to me"; the actual correction still happens
-- through the existing admin workflow (attendance_day_corrections, written by
-- the admin correction route) and leaves its own audit trail there.
--
-- That separation is the whole design. The two tables that already exist —
-- attendance_day_corrections and payroll_pending_adjustments — could not be
-- reused for this precisely because a row in either one IS a change to pay. An
-- employee-writable row in those tables would let an employee move their own
-- money.
--
-- ONE TABLE FOR BOTH SUBJECTS
-- ---------------------------
-- Attendance and payroll objections share a table so the isolation rule is
-- written ONCE — one INSERT policy, one SELECT policy, one review function.
-- The defect this whole branch exists to fix came from one access rule being
-- restated in three places and drifting apart; this is the same lesson applied
-- to a new table.
--
-- Attendance is keyed by DATE rather than by an attendance_records id on
-- purpose: a working day with no punches has no attendance_records row at all
-- (the API synthesises it), and those are exactly the days an employee most
-- wants to dispute.

-- ─── 1. Table ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.employee_record_objections (
  id                uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Defaulted from the session and pinned by the INSERT policy's WITH CHECK,
  -- so a client cannot file an objection in someone else's name.
  employee_id       uuid        NOT NULL DEFAULT auth.uid()
                                REFERENCES public.users(id) ON DELETE CASCADE,

  -- Exactly one target, enforced below.
  attendance_date   date,
  payroll_result_id uuid        REFERENCES public.payroll_results(id) ON DELETE CASCADE,

  -- Mandatory. An objection with no stated reason is not reviewable.
  reason            text        NOT NULL CHECK (btrim(reason) <> ''),

  -- What the employee was looking at when they objected, composed by the
  -- server from that employee's own data — never accepted from the browser.
  -- Kept so a reviewed objection still reads sensibly after the underlying day
  -- has been corrected.
  subject_snapshot  text        NOT NULL,

  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'rejected')),

  reviewed_by       uuid        REFERENCES public.users(id),
  reviewed_at       timestamptz,
  review_note       text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT employee_record_objections_one_target CHECK (
    num_nonnulls(attendance_date, payroll_result_id) = 1
  )
);

COMMENT ON TABLE public.employee_record_objections IS
  'Employee-raised objections against their own attendance day or payroll result. Review-only: never mutates attendance, payroll or salary.';

-- ─── 2. One open objection per target ────────────────────────────────────────
--
-- Two partial indexes rather than one over a coalesced key: each states its own
-- rule plainly, and each can be read (and dropped) without reasoning about the
-- other. A resolved objection does not block a later one — an employee whose
-- first report was rejected may raise the matter again if it genuinely recurs.

CREATE UNIQUE INDEX IF NOT EXISTS employee_record_objections_one_pending_attendance
  ON public.employee_record_objections (employee_id, attendance_date)
  WHERE status = 'pending' AND attendance_date IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employee_record_objections_one_pending_payroll
  ON public.employee_record_objections (employee_id, payroll_result_id)
  WHERE status = 'pending' AND payroll_result_id IS NOT NULL;

-- The admin queue reads pending first, newest first.
CREATE INDEX IF NOT EXISTS employee_record_objections_status_created
  ON public.employee_record_objections (status, created_at DESC);

-- ─── 3. Row level security ───────────────────────────────────────────────────

ALTER TABLE public.employee_record_objections ENABLE ROW LEVEL SECURITY;

-- File as yourself, pending, with no review fields already filled in.
--
-- The payroll EXISTS clause is the load-bearing one: without it an employee
-- could set employee_id to themselves while pointing payroll_result_id at a
-- COLLEAGUE'S result, and then read that colleague's row back through the join
-- on their own objection. It makes "A cannot reference B" true in the database
-- and not merely in the route.
DROP POLICY IF EXISTS "employee_record_objections_insert_own" ON public.employee_record_objections;
CREATE POLICY "employee_record_objections_insert_own" ON public.employee_record_objections
  FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = auth.uid()
    AND status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_note IS NULL
    AND EXISTS (
      SELECT 1 FROM public.users
       WHERE users.id = auth.uid() AND users.is_active
    )
    AND (
      payroll_result_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.payroll_results r
         WHERE r.id = payroll_result_id
           AND r.employee_id = auth.uid()
      )
    )
  );

-- Read your own; an active admin reads all.
DROP POLICY IF EXISTS "employee_record_objections_select" ON public.employee_record_objections;
CREATE POLICY "employee_record_objections_select" ON public.employee_record_objections
  FOR SELECT TO authenticated
  USING (
    employee_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users
       WHERE users.id = auth.uid() AND users.is_active AND users.role = 'admin'
    )
  );

-- Deliberately NO update and NO delete policy, for anyone, matching
-- order_requests and asset_change_requests. With RLS enabled and no policy, the
-- action is denied — so an employee cannot approve, edit, withdraw or delete
-- their own objection after submitting it, and an admin cannot quietly rewrite
-- one either. The only way to change a row is the review function below.

-- ─── 4. Admin review ─────────────────────────────────────────────────────────
--
-- SECURITY DEFINER because there is no UPDATE policy to satisfy. It touches
-- exactly four columns on exactly one row of exactly one table: it cannot
-- reach attendance, payroll, salary, deductions or adjustments, and the
-- correction it may prompt is still made by an admin through the existing
-- correction workflow.

CREATE OR REPLACE FUNCTION public.review_employee_record_objection(
  p_objection_id uuid,
  p_status       text,
  p_review_note  text DEFAULT NULL
)
RETURNS public.employee_record_objections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.employee_record_objections;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to review an objection'
      USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = v_uid AND is_active AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'OBJECTION_FORBIDDEN: Only an administrator can review an objection'
      USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'OBJECTION_INVALID_STATUS: status must be approved or rejected'
      USING ERRCODE = '22023';
  END IF;

  -- Only a pending objection can be reviewed, and the row is locked so two
  -- admins reviewing at once cannot both win.
  SELECT * INTO v_row
    FROM public.employee_record_objections
   WHERE id = p_objection_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OBJECTION_NOT_FOUND: No such objection'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'OBJECTION_ALREADY_REVIEWED: This objection was already %', v_row.status
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.employee_record_objections
     SET status      = p_status,
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = NULLIF(btrim(coalesce(p_review_note, '')), '')
   WHERE id = p_objection_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.review_employee_record_objection(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_employee_record_objection(uuid, text, text) TO authenticated;

-- ─── 5. Grants ───────────────────────────────────────────────────────────────
-- RLS decides the rows; these decide the verbs. No UPDATE, no DELETE for
-- anyone: the review function is the only writer after INSERT.

GRANT SELECT, INSERT ON public.employee_record_objections TO authenticated;
