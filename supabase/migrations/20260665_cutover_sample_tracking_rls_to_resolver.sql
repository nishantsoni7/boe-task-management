-- Phase 3F: Behavioral Cutover — Sample Tracking RLS.
--
-- Replaces has_permission(...)/employee_permissions with the centralized
-- resolve_permission(auth.uid(), 'sample_tracking', '<action>') resolver as
-- the live authorization source for the 4 Sample Tracking policies that
-- currently call has_permission(). This is the first phase that changes
-- runtime enforcement — all prior phases (3A-3E + the pre-cutover backfill,
-- 20260634..20260664) were additive/read-only.
--
-- Exit criteria satisfied before this migration (see
-- docs/Module Docs/PERMISSIONS_MIGRATION_PHASE3A.md §6 and
-- PERMISSIONS_MIGRATION_PHASE3E.md "Post-backfill re-verification"):
--   - Centralized dispatch/receive/mark_lost/close actions registered (3B)
--   - Admin role_permissions defaults populated (3D)
--   - Legacy employee_permissions backfilled into employee_permission_overrides (20260664)
--   - Shadow verification: 52/52 matches, 0 mismatches (3E, re-confirmed
--     immediately before writing this migration)
--
-- Scope: ONLY the 4 policies below. Every other sample_dispatches policy
-- (sample_dispatches_insert, sample_dispatches_delete,
-- sample_dispatches_update_admin, sample_dispatches_update_qr_submit,
-- sample_dispatches_update_requester_edit, sample_dispatches_update_reapply,
-- sample_dispatches_update_followup) is untouched — none of them reference
-- has_permission() or employee_permissions.
--
-- Status guards are preserved byte-for-byte from 20260634 — only the
-- has_permission(auth.uid(), 'samples_*') calls are swapped for
-- resolve_permission(auth.uid(), 'sample_tracking', '<action>') calls.
-- No new "close" lifecycle transition is introduced: samples_close/`close`
-- was never wired to an UPDATE policy in the legacy system either — it only
-- ever gated row visibility (sample_dispatches_select) — so that stays a
-- SELECT-only concern here too.
--
-- Rollback: a new forward migration re-creating these same 4 policies with
-- the has_permission(...) expressions from 20260634 (see that file for the
-- exact original text). employee_permissions, has_permission(), and the
-- ep_* policies are not touched or removed by this migration and remain
-- fully intact for that rollback path.

-- ── 1. sample_dispatches_select ─────────────────────────────────────────────

DROP POLICY IF EXISTS "sample_dispatches_select" ON sample_dispatches;

CREATE POLICY "sample_dispatches_select" ON sample_dispatches
  FOR SELECT TO authenticated
  USING (
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
  );

-- ── 2. sd_update_perm_dispatch: qr_submitted → dispatched ───────────────────

DROP POLICY IF EXISTS "sd_update_perm_dispatch" ON sample_dispatches;

CREATE POLICY "sd_update_perm_dispatch" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    status = 'qr_submitted'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'dispatch')
  )
  WITH CHECK (
    status = 'dispatched'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'dispatch')
  );

-- ── 3. sd_update_perm_receive: dispatched → returned ────────────────────────

DROP POLICY IF EXISTS "sd_update_perm_receive" ON sample_dispatches;

CREATE POLICY "sd_update_perm_receive" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    status = 'dispatched'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'receive')
  )
  WITH CHECK (
    status = 'returned'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'receive')
  );

-- ── 4. sd_update_perm_lost: dispatched → lost ───────────────────────────────

DROP POLICY IF EXISTS "sd_update_perm_lost" ON sample_dispatches;

CREATE POLICY "sd_update_perm_lost" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    status = 'dispatched'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'mark_lost')
  )
  WITH CHECK (
    status = 'lost'
    AND resolve_permission(auth.uid(), 'sample_tracking', 'mark_lost')
  );
