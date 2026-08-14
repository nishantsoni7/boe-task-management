-- Sample Tracking: make effective `view` the PARENT GATE in the database.
--
-- WHY
-- ---
-- Access Control's "Module access" switch writes employee_permission_overrides.
-- Nothing in Sample Tracking read it. /samples had no route guard, the launcher
-- gated on app_modules.visibility_type ('live', therefore everyone), and these
-- policies keyed on ownership and on the four lifecycle actions — never on
-- `view`. An employee whose module access was switched OFF kept the card, kept
-- the route, and kept row access through `requested_by = auth.uid()`.
--
-- The frontend half of this fix ships in the same change (ModuleGuard + the
-- launcher). This file is the half the browser cannot talk its way past.
--
-- THE RULE
-- --------
--   effective `view` is evaluated FIRST. Ownership (`requested_by`) and the
--   lifecycle grants (dispatch / receive / mark_lost / close) are only reached
--   once it passes. A child action is not an entry ticket: it decides what
--   somebody who is already IN the module may do.
--
-- This is deliberately the shape that keeps Aditya's grants stored and DORMANT.
-- He holds dispatch, receive and mark_lost with view = false. After this
-- migration those rows still exist, still resolve, and still decide nothing —
-- and they light up again, unchanged, the moment an administrator switches his
-- module access back on. Nothing here grants him `view`.
--
-- SCOPE
-- -----
-- Additive and policy-only. It creates one helper function and REPLACES nine
-- policies with gated equivalents that are otherwise identical.
--
--   * No employee_permission_overrides row is inserted, updated or revoked.
--   * No role_permissions or department_permissions row is touched.
--   * No app_modules row is touched.
--   * No table, column, index or trigger is altered.
--   * The two ADMIN policies (sample_dispatches_update_admin, and the admin
--     branch of sample_dispatches_delete) are left exactly as they were, so
--     System Administrator behaviour is provably unchanged.
--
-- Idempotent: every statement is CREATE OR REPLACE or DROP ... IF EXISTS.

-- ── 1. The gate itself ──────────────────────────────────────────────────────
--
-- One function, so that "may this person be in Sample Tracking at all" has a
-- single definition instead of being re-typed into nine policies. STABLE, so
-- Postgres forbids it from writing; SECURITY DEFINER for the same reason
-- resolve_permission() is — it must read permission tables the caller's own RLS
-- would hide from them.
--
-- The admin branch mirrors the clause the SELECT policy already carried. It is
-- strictly redundant (role_permissions grants every action to 'admin', seeded
-- by 20260660), and it is kept anyway so that an admin can never be locked out
-- of the module by a permission-table edit.

CREATE OR REPLACE FUNCTION public.sample_tracking_module_open()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.role = 'admin'
    )
    OR public.resolve_permission(auth.uid(), 'sample_tracking', 'view');
$$;

COMMENT ON FUNCTION public.sample_tracking_module_open() IS
  'Parent authorization gate for Sample Tracking: admin, or effective sample_tracking:view. '
  'Ownership and the dispatch/receive/mark_lost/close grants are evaluated only after this passes.';

-- ── 2. SELECT — the gate, then the existing row scope ───────────────────────
--
-- The inner disjunction is character-for-character the policy from
-- 20260665_cutover_sample_tracking_rls_to_resolver.sql. Row scope does not
-- change: a requester still sees their own rows, a lifecycle holder still sees
-- every row. What changes is that neither is reachable without `view`.

DROP POLICY IF EXISTS "sample_dispatches_select" ON sample_dispatches;

CREATE POLICY "sample_dispatches_select" ON sample_dispatches
  FOR SELECT TO authenticated
  USING (
    public.sample_tracking_module_open()
    AND (
      requested_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM users
        WHERE users.id = auth.uid()
          AND users.role = 'admin'
      )
      OR resolve_permission(auth.uid(), 'sample_tracking', 'dispatch')
      OR resolve_permission(auth.uid(), 'sample_tracking', 'receive')
      OR resolve_permission(auth.uid(), 'sample_tracking', 'mark_lost')
      OR resolve_permission(auth.uid(), 'sample_tracking', 'close')
    )
  );

-- ── 3. INSERT — the gate, then the existing ownership check ─────────────────
--
-- Creating a sample request is module data. Somebody outside the module must
-- not be able to write a row they would then be unable to read.

DROP POLICY IF EXISTS "sample_dispatches_insert" ON sample_dispatches;

CREATE POLICY "sample_dispatches_insert" ON sample_dispatches
  FOR INSERT TO authenticated
  WITH CHECK (
    public.sample_tracking_module_open()
    AND requested_by = auth.uid()
  );

-- ── 4. Lifecycle UPDATEs — the child actions must not bypass the gate ───────
--
-- THIS IS THE CLAUSE THAT MAKES A CHILD GRANT DORMANT. Without it, `dispatch`
-- alone still moved a row from qr_submitted to dispatched even though its
-- holder could not open the module or read the row they were changing. Status
-- transitions and the per-action grants are otherwise untouched.

DROP POLICY IF EXISTS "sd_update_perm_dispatch" ON sample_dispatches;

CREATE POLICY "sd_update_perm_dispatch" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    public.sample_tracking_module_open()
    AND status = 'qr_submitted'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'dispatch')
  )
  WITH CHECK (
    public.sample_tracking_module_open()
    AND status = 'dispatched'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'dispatch')
  );

DROP POLICY IF EXISTS "sd_update_perm_receive" ON sample_dispatches;

CREATE POLICY "sd_update_perm_receive" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    public.sample_tracking_module_open()
    AND status = 'dispatched'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'receive')
  )
  WITH CHECK (
    public.sample_tracking_module_open()
    AND status = 'returned'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'receive')
  );

DROP POLICY IF EXISTS "sd_update_perm_lost" ON sample_dispatches;

CREATE POLICY "sd_update_perm_lost" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    public.sample_tracking_module_open()
    AND status = 'dispatched'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'mark_lost')
  )
  WITH CHECK (
    public.sample_tracking_module_open()
    AND status = 'lost'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'mark_lost')
  );

-- ── 5. Requester UPDATEs — same gate, same ownership and status rules ───────
--
-- These four are the requester's own workflow (submit QR, edit a pending
-- request, reapply after rejection, save a follow-up note). Each keeps its
-- exact ownership + status pair from 20260630_fix_sample_dispatches_update_rls;
-- only the gate is added. Somebody who cannot read the row must not be able to
-- write it blind.

DROP POLICY IF EXISTS "sample_dispatches_update_qr_submit" ON sample_dispatches;

CREATE POLICY "sample_dispatches_update_qr_submit" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING  (public.sample_tracking_module_open() AND requested_by = auth.uid() AND status = 'approved')
  WITH CHECK (public.sample_tracking_module_open() AND requested_by = auth.uid() AND status = 'qr_submitted');

DROP POLICY IF EXISTS "sample_dispatches_update_requester_edit" ON sample_dispatches;

CREATE POLICY "sample_dispatches_update_requester_edit" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING  (public.sample_tracking_module_open() AND requested_by = auth.uid() AND status = 'pending_approval')
  WITH CHECK (public.sample_tracking_module_open() AND requested_by = auth.uid() AND status = 'pending_approval');

DROP POLICY IF EXISTS "sample_dispatches_update_reapply" ON sample_dispatches;

CREATE POLICY "sample_dispatches_update_reapply" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING  (public.sample_tracking_module_open() AND requested_by = auth.uid() AND status = 'rejected')
  WITH CHECK (public.sample_tracking_module_open() AND requested_by = auth.uid() AND status = 'pending_approval');

DROP POLICY IF EXISTS "sample_dispatches_update_followup" ON sample_dispatches;

CREATE POLICY "sample_dispatches_update_followup" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING  (public.sample_tracking_module_open() AND requested_by = auth.uid() AND status = 'dispatched')
  WITH CHECK (public.sample_tracking_module_open() AND requested_by = auth.uid() AND status = 'dispatched');

-- ── 6. DELETE — gate the requester branch, leave the admin branch alone ─────

DROP POLICY IF EXISTS "sample_dispatches_delete" ON sample_dispatches;

CREATE POLICY "sample_dispatches_delete" ON sample_dispatches
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role = 'admin'
    )
    OR (
      public.sample_tracking_module_open()
      AND requested_by = auth.uid()
      AND status = 'pending_approval'
    )
  );

-- ── 7. Assertions ───────────────────────────────────────────────────────────
--
-- Read-only. They fail the migration rather than let a half-applied gate look
-- successful — the failure mode 20260723000000 exists to remember.

DO $$
DECLARE
  v_missing text;
  v_admin_update_changed boolean;
BEGIN
  -- Every policy that must carry the gate, carries it.
  SELECT string_agg(p.polname, ', ' ORDER BY p.polname)
    INTO v_missing
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname = 'sample_dispatches'
    AND p.polname IN (
      'sample_dispatches_select',
      'sample_dispatches_insert',
      'sd_update_perm_dispatch',
      'sd_update_perm_receive',
      'sd_update_perm_lost',
      'sample_dispatches_update_qr_submit',
      'sample_dispatches_update_requester_edit',
      'sample_dispatches_update_reapply',
      'sample_dispatches_update_followup',
      'sample_dispatches_delete'
    )
    AND COALESCE(pg_get_expr(p.polqual, p.polrelid), '') || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '')
        NOT LIKE '%sample_tracking_module_open%';

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Parent gate missing from sample_dispatches policies: %', v_missing;
  END IF;

  -- All ten still exist (a typo in a policy name would otherwise pass above by
  -- simply matching nothing).
  IF (
    SELECT count(*) FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'sample_dispatches'
      AND COALESCE(pg_get_expr(p.polqual, p.polrelid), '') || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '')
          LIKE '%sample_tracking_module_open%'
  ) <> 10 THEN
    RAISE EXCEPTION 'Expected exactly 10 gated policies on sample_dispatches';
  END IF;

  -- The admin UPDATE policy was not touched.
  SELECT pg_get_expr(p.polqual, p.polrelid) LIKE '%sample_tracking_module_open%'
    INTO v_admin_update_changed
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname = 'sample_dispatches'
    AND p.polname = 'sample_dispatches_update_admin';

  IF COALESCE(v_admin_update_changed, false) THEN
    RAISE EXCEPTION 'sample_dispatches_update_admin must remain unmodified';
  END IF;
END $$;
