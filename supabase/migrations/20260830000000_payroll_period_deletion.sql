-- Payroll — administrator permanent deletion of one complete payroll period.
--
-- WHY THIS EXISTS
-- ---------------
-- July 2026 is BOE's first month of real employee payroll visibility. The
-- periods before it hold testing and incorrect figures, and an employee opening
-- My Payroll cannot tell those apart from a real salary record. Hiding them in
-- the interface is not an answer: the rows would still be there, still readable
-- by anything that queries payroll, and still counted in totals.
--
-- So this adds ONE narrow door: public.delete_payroll_period(). It erases a
-- named period together with everything that belongs solely to it, in a single
-- transaction, and it refuses outright for any period that is locked, settled,
-- paid, or mid-generation.
--
-- WHAT IT IS NOT
-- --------------
-- It is not a way to make a calculation defect disappear. A period whose figures
-- are wrong is regenerated, not deleted; this is for payroll that should never
-- have existed as a salary record at all.
--
-- It is also not a cascade. Every FK into payroll_periods and payroll_results is
-- listed explicitly below and handled by name. Nothing here relies on ON DELETE
-- behaviour that a future migration could change without noticing.
--
-- ═══ 1. The audit event ════════════════════════════════════════════════════
--
-- The payroll is destroyed; the fact that an administrator destroyed it is not.
--
-- This table deliberately carries NO foreign key to payroll_periods. An audit
-- row whose parent has been deleted is the only kind of audit row this feature
-- can ever produce, so a reference that must survive its target cannot be a
-- reference the database enforces. payroll_period_id is stored as a plain uuid.
--
-- WHAT IS DELIBERATELY ABSENT: net salary, gross salary, deduction amounts,
-- adjustment amounts, payslip content, and the employee ids the period covered.
-- The audit answers "which payroll was deleted, by whom, when, why, and how
-- big was it" — it is not a backup of the salary data, and it must not become
-- one. Only counts are retained.

CREATE TABLE IF NOT EXISTS public.payroll_deletion_audit (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The deleted period. No FK, on purpose — see above.
  payroll_period_id       uuid        NOT NULL,
  payroll_month           smallint    NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
  payroll_year            smallint    NOT NULL CHECK (payroll_year >= 2020),

  -- 'draft' or 'generated'. A locked period can never reach this table.
  period_status           text        NOT NULL CHECK (period_status IN ('draft', 'generated')),

  deleted_by              uuid        NOT NULL REFERENCES public.users(id),
  -- Denormalised so the audit still reads if the account is later renamed.
  deleted_by_name         text,
  deleted_at              timestamptz NOT NULL DEFAULT now(),

  -- Mandatory, and non-blank. The reason is the point of the record.
  reason                  text        NOT NULL CHECK (btrim(reason) <> ''),

  -- Counts only. Never amounts.
  results_deleted         integer     NOT NULL DEFAULT 0 CHECK (results_deleted         >= 0),
  deduction_lines_deleted integer     NOT NULL DEFAULT 0 CHECK (deduction_lines_deleted >= 0),
  removed_counts          jsonb       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.payroll_deletion_audit IS
  'One row per permanently deleted payroll period. Counts and provenance only — never salary amounts.';
COMMENT ON COLUMN public.payroll_deletion_audit.payroll_period_id IS
  'The deleted period. Intentionally not a foreign key: the row must outlive its target.';
COMMENT ON COLUMN public.payroll_deletion_audit.removed_counts IS
  'Row counts per table removed or detached. Integers only — no monetary value is ever recorded here.';

CREATE INDEX IF NOT EXISTS payroll_deletion_audit_deleted_at_idx
  ON public.payroll_deletion_audit (deleted_at DESC);

ALTER TABLE public.payroll_deletion_audit ENABLE ROW LEVEL SECURITY;

-- Readable by administrators. There is deliberately no INSERT, UPDATE or DELETE
-- policy for any role: the only writer is the SECURITY DEFINER function below,
-- which makes the table append-only to every client, exactly as
-- payroll_period_status_events already is.
DROP POLICY IF EXISTS payroll_deletion_audit_admin_select ON public.payroll_deletion_audit;
CREATE POLICY payroll_deletion_audit_admin_select
  ON public.payroll_deletion_audit
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.is_active AND u.role = 'admin'
    )
  );

-- ═══ 2. delete_payroll_period ══════════════════════════════════════════════
--
-- AUTHORIZATION
--
-- Two independent gates, because either one alone is a single point of failure:
--
--   * EXECUTE is revoked from anon and authenticated, so no browser session can
--     reach this through PostgREST however the request is shaped. The only
--     caller is the service role, which means POST /api/payroll/delete, which
--     runs requireAdmin() on the bearer token.
--
--   * p_actor is checked against users.role = 'admin' here as well. The actor is
--     supplied by the route rather than read from auth.uid() because a
--     service-role call has no auth.uid() to read — so the id is verified rather
--     than trusted.
--
-- WHAT IS REFUSED, AND WHY
--
--   locked              A locked month is a finalised one. Reopening it is a
--                       deliberate, audited admin action that already exists
--                       (POST /api/payroll/unlock); deletion must not perform it
--                       silently as a side effect.
--   payment recorded    Money has been paid against these figures. The payroll
--                       is now evidence, not a draft.
--   result locked       Defensive: an individual result marked locked while its
--                       period is not.
--   generation running  Deleting the period a generation is writing into would
--                       race that run to the same rows.
--   carry-forward dep.  Another period's settlement carries a NON-ZERO balance
--                       traced to this one. Deleting would leave money whose
--                       origin cannot be explained. A zero-value pointer carries
--                       no money and is cleared instead (see §5 below).
--   identity mismatch   p_month/p_year must match the stored row. This is what
--                       makes a retried request safe: a stale period id that has
--                       been reused, or a client sending the wrong id for the
--                       month it displayed, is refused rather than deleting a
--                       payroll nobody chose.
--
-- ATOMICITY
--
-- One function body is one transaction. Any failure — a new FK added later, a
-- trigger, a constraint — rolls back every earlier delete, so there is no state
-- in which some of a period's results are gone and the rest survive, and no
-- state in which employees have lost visibility of a payroll that still exists.
--
-- ORDER OF OPERATIONS (children first, parent last):
--
--   1. notifications          payroll issue notifications for objections that
--                             are about to stop existing
--   2. employee_record_objections   objections raised against this period's results
--   3. payroll_settlement_events    audit rows of this period's settlements
--   4. payroll_settlements          this period's settlement records
--   5. payroll_settlements          OTHER periods' zero-value carry-forward
--                                   pointers into this one — cleared, not deleted
--   6. payroll_pending_adjustments  detached back to pending, NOT deleted
--   7. attendance_day_corrections   payroll_period_id cleared, NOT deleted
--   8. payroll_deduction_lines      every stored deduction/addition line
--   9. payroll_results              the employee payroll results
--  10. payroll_generation           this period's generation runs
--  11. payroll_period_status_events lock/unlock history for this period
--  12. payroll_periods              the period row itself
--
-- WHAT IS NEVER TOUCHED: attendance_records, attendance imports, users and
-- their salary configuration, payroll_settings (the global, versioned rules),
-- payroll_holidays, any other payroll period, and every notification whose
-- entity_id does not name an objection deleted by step 2.

CREATE OR REPLACE FUNCTION public.delete_payroll_period(
  p_period_id uuid,
  p_month     smallint,
  p_year      smallint,
  p_reason    text,
  p_actor     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period          public.payroll_periods;
  v_reason          text := btrim(coalesce(p_reason, ''));
  v_result_ids      uuid[];
  v_objection_ids   uuid[];
  v_audit_id        uuid;
  v_n_notifications int := 0;
  v_n_objections    int := 0;
  v_n_settle_events int := 0;
  v_n_settlements   int := 0;
  v_n_cf_cleared    int := 0;
  v_n_adjustments   int := 0;
  v_n_corrections   int := 0;
  v_n_lines         int := 0;
  v_n_results       int := 0;
  v_n_generations   int := 0;
  v_n_status_events int := 0;
BEGIN
  -- ── Authorisation ─────────────────────────────────────────────────────────
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'PAYROLL_DELETE_DENIED: An administrator id is required to delete payroll'
      USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = p_actor AND is_active AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'PAYROLL_DELETE_DENIED: Only an administrator can delete a payroll period'
      USING ERRCODE = '42501';
  END IF;

  -- ── Mandatory reason ──────────────────────────────────────────────────────
  IF v_reason = '' THEN
    RAISE EXCEPTION 'PAYROLL_DELETE_REASON_REQUIRED: A reason is required to delete a payroll period'
      USING ERRCODE = '22023';
  END IF;

  -- ── The target, locked for the whole transaction ──────────────────────────
  -- FOR UPDATE so a concurrent lock, settlement or generation cannot change the
  -- period's state between these checks and the deletes below.
  SELECT * INTO v_period FROM public.payroll_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_DELETE_MISSING: This payroll period no longer exists'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ── Identity check — never delete by a broad month query ───────────────────
  IF p_month IS NULL OR p_year IS NULL
     OR v_period.payroll_month <> p_month OR v_period.payroll_year <> p_year THEN
    RAISE EXCEPTION
      'PAYROLL_DELETE_MISMATCH: This payroll period is %-%, not the one that was confirmed',
      v_period.payroll_year, v_period.payroll_month
      USING ERRCODE = '22023';
  END IF;

  -- ── Refusals ──────────────────────────────────────────────────────────────
  IF v_period.status = 'locked' THEN
    RAISE EXCEPTION
      'PAYROLL_DELETE_BLOCKED_LOCKED: This payroll is locked. Unlock it first if it really should be deleted.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payroll_settlements s
    WHERE s.payroll_period_id = p_period_id
      AND (s.amount_paid IS NOT NULL OR s.payment_date IS NOT NULL OR s.payment_recorded_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'PAYROLL_DELETE_BLOCKED_PAID: A payment has been recorded against this payroll. Settled payroll cannot be deleted.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payroll_results r
    WHERE r.payroll_period_id = p_period_id AND r.status = 'locked'
  ) THEN
    RAISE EXCEPTION
      'PAYROLL_DELETE_BLOCKED_RESULT_LOCKED: This payroll holds locked employee results. Unlock them first.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payroll_generation g
    WHERE g.payroll_period_id = p_period_id AND g.status = 'running'
  ) THEN
    RAISE EXCEPTION
      'PAYROLL_DELETE_BLOCKED_RUNNING: A payroll generation is still running for this period. Wait for it to finish.'
      USING ERRCODE = '55006';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payroll_settlements s
    WHERE s.carry_forward_source_period_id = p_period_id
      AND s.payroll_period_id <> p_period_id
      AND s.carry_forward_amount <> 0
  ) THEN
    RAISE EXCEPTION
      'PAYROLL_DELETE_BLOCKED_CARRY_FORWARD: A later payroll carries a balance forward from this one. Clear that carry-forward first.'
      USING ERRCODE = '42501';
  END IF;

  -- ── Collect the ids this deletion is scoped to ────────────────────────────
  SELECT coalesce(array_agg(r.id), '{}') INTO v_result_ids
  FROM public.payroll_results r WHERE r.payroll_period_id = p_period_id;

  SELECT coalesce(array_agg(o.id), '{}') INTO v_objection_ids
  FROM public.employee_record_objections o WHERE o.payroll_result_id = ANY (v_result_ids);

  -- ── 1. Notifications for objections that are about to disappear ───────────
  -- Scoped three ways: the entity must be one of THIS period's objections, and
  -- the type must be one of the two payroll-objection types. A task, finance,
  -- order, asset or attendance notification cannot match.
  DELETE FROM public.notifications n
   WHERE n.entity_id = ANY (v_objection_ids)
     AND n.type IN ('payroll_issue_raised', 'payroll_issue_reviewed');
  GET DIAGNOSTICS v_n_notifications = ROW_COUNT;

  -- ── 2. Objections against this period's results ───────────────────────────
  -- The FK is ON DELETE CASCADE, so step 9 would remove these anyway. Doing it
  -- explicitly is what makes the count truthful and keeps the ordering with
  -- step 1 obvious. An objection about an ATTENDANCE date carries a NULL
  -- payroll_result_id and is not matched here.
  DELETE FROM public.employee_record_objections o WHERE o.payroll_result_id = ANY (v_result_ids);
  GET DIAGNOSTICS v_n_objections = ROW_COUNT;

  -- ── 3–4. Settlement audit rows, then the settlements ──────────────────────
  DELETE FROM public.payroll_settlement_events e
   WHERE e.payroll_settlement_id IN (
     SELECT s.id FROM public.payroll_settlements s WHERE s.payroll_period_id = p_period_id
   );
  GET DIAGNOSTICS v_n_settle_events = ROW_COUNT;

  -- The BEFORE DELETE lock guard on this table re-reads the period's status; it
  -- passes because a locked period was already refused above, and the period row
  -- still exists at this point.
  DELETE FROM public.payroll_settlements s WHERE s.payroll_period_id = p_period_id;
  GET DIAGNOSTICS v_n_settlements = ROW_COUNT;

  -- ── 5. Other periods' zero-value carry-forward pointers ───────────────────
  -- These belong to a DIFFERENT payroll period and are not deleted. Only the
  -- provenance pointer into the period being erased is cleared, so the row stops
  -- referencing something that no longer exists. carry_forward_amount is not
  -- touched, and a non-zero one was refused outright above — no figure on any
  -- other payroll changes by so much as a rupee.
  UPDATE public.payroll_settlements s
     SET carry_forward_source_period_id = NULL
   WHERE s.carry_forward_source_period_id = p_period_id;
  GET DIAGNOSTICS v_n_cf_cleared = ROW_COUNT;

  -- ── 6. Adjustments: detached, not destroyed ───────────────────────────────
  -- A pending adjustment is an INPUT to payroll, not a product of it — an admin
  -- recording "₹5,000 advance, recover in July" before July was ever generated.
  -- Deleting the payroll must not delete that instruction, so the rows return to
  -- the state they were in before this period consumed them: pending, with no
  -- period or result attached. They stay pinned to their own payroll_month /
  -- payroll_year, so regenerating the month applies each exactly once and a
  -- different month cannot pick them up.
  UPDATE public.payroll_pending_adjustments a
     SET status              = 'pending',
         applied_in_period_id = NULL,
         payroll_result_id    = NULL
   WHERE a.applied_in_period_id = p_period_id
      OR a.payroll_result_id = ANY (v_result_ids);
  GET DIAGNOSTICS v_n_adjustments = ROW_COUNT;

  -- ── 7. Attendance corrections: pointer cleared, record kept ───────────────
  -- attendance_day_corrections is ATTENDANCE data. Every punch value, remark,
  -- treatment and approval on it survives untouched; only its reference to the
  -- payroll period being deleted is cleared, because the column is a nullable
  -- pointer and the period will not exist. Not one correction row is removed.
  UPDATE public.attendance_day_corrections c
     SET payroll_period_id = NULL
   WHERE c.payroll_period_id = p_period_id;
  GET DIAGNOSTICS v_n_corrections = ROW_COUNT;

  -- ── 8–9. The payroll itself ───────────────────────────────────────────────
  DELETE FROM public.payroll_deduction_lines l WHERE l.payroll_result_id = ANY (v_result_ids);
  GET DIAGNOSTICS v_n_lines = ROW_COUNT;

  DELETE FROM public.payroll_results r WHERE r.payroll_period_id = p_period_id;
  GET DIAGNOSTICS v_n_results = ROW_COUNT;

  -- ── 10. Generation runs — after the results that reference them ───────────
  DELETE FROM public.payroll_generation g WHERE g.payroll_period_id = p_period_id;
  GET DIAGNOSTICS v_n_generations = ROW_COUNT;

  -- ── 11. Lock/unlock history for this period ───────────────────────────────
  DELETE FROM public.payroll_period_status_events e WHERE e.payroll_period_id = p_period_id;
  GET DIAGNOSTICS v_n_status_events = ROW_COUNT;

  -- ── 12. The period ────────────────────────────────────────────────────────
  DELETE FROM public.payroll_periods p WHERE p.id = p_period_id;

  -- ── The audit event ───────────────────────────────────────────────────────
  -- Written inside the same transaction as the deletes, so the two commit or
  -- roll back together: there can be no audit row for a payroll that still
  -- exists, and no deleted payroll without one.
  INSERT INTO public.payroll_deletion_audit (
    payroll_period_id, payroll_month, payroll_year, period_status,
    deleted_by, deleted_by_name, reason,
    results_deleted, deduction_lines_deleted, removed_counts
  )
  VALUES (
    p_period_id, v_period.payroll_month, v_period.payroll_year, v_period.status,
    p_actor, (SELECT full_name FROM public.users WHERE id = p_actor), v_reason,
    v_n_results, v_n_lines,
    jsonb_build_object(
      'payroll_results',              v_n_results,
      'payroll_deduction_lines',      v_n_lines,
      'payroll_settlements',          v_n_settlements,
      'payroll_settlement_events',    v_n_settle_events,
      'payroll_generation',           v_n_generations,
      'payroll_period_status_events', v_n_status_events,
      'employee_record_objections',   v_n_objections,
      'notifications',                v_n_notifications,
      'adjustments_returned_to_pending',      v_n_adjustments,
      'attendance_corrections_detached',      v_n_corrections,
      'carry_forward_pointers_cleared',       v_n_cf_cleared
    )
  )
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'deleted',           true,
    'payroll_period_id', p_period_id,
    'payroll_month',     v_period.payroll_month,
    'payroll_year',      v_period.payroll_year,
    'period_status',     v_period.status,
    'audit_id',          v_audit_id,
    'results_deleted',   v_n_results,
    'removed_counts',    jsonb_build_object(
      'payroll_results',              v_n_results,
      'payroll_deduction_lines',      v_n_lines,
      'payroll_settlements',          v_n_settlements,
      'payroll_settlement_events',    v_n_settle_events,
      'payroll_generation',           v_n_generations,
      'payroll_period_status_events', v_n_status_events,
      'employee_record_objections',   v_n_objections,
      'notifications',                v_n_notifications,
      'adjustments_returned_to_pending', v_n_adjustments,
      'attendance_corrections_detached', v_n_corrections,
      'carry_forward_pointers_cleared',  v_n_cf_cleared
    )
  );
END;
$$;

-- No browser session may call this, whatever it sends. The service-role route
-- POST /api/payroll/delete is the only door, and it runs requireAdmin() first.
REVOKE ALL ON FUNCTION public.delete_payroll_period(uuid, smallint, smallint, text, uuid)
  FROM public, anon, authenticated;

COMMENT ON FUNCTION public.delete_payroll_period(uuid, smallint, smallint, text, uuid) IS
  'Admin-only. Erases one payroll period and every record owned solely by it, in one transaction. Refuses locked, settled, paid and mid-generation payroll. Attendance, employees, salaries and global settings are never touched.';
