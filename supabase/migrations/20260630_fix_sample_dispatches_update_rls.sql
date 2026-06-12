-- Replace the original open UPDATE policy with scoped policies.
--
-- The original policy ("sample_dispatches_update" USING (true) WITH CHECK (true)) was either
-- never applied to the live database or was dropped, causing RLS default-deny to silently
-- block all non-admin UPDATE operations (including Submit QR, Edit, and Reapply).
--
-- New model:
--   Admin        → can UPDATE any row to any state.
--   Requester    → four narrow transitions covering every requester-side action in the app:
--                    1. approved      → qr_submitted  (Submit QR)
--                    2. pending       → pending       (Edit own request fields)
--                    3. rejected      → pending       (Reapply after rejection)
--                    4. dispatched    → dispatched    (Save followup note, no status change)

DROP POLICY IF EXISTS "sample_dispatches_update"               ON sample_dispatches;
DROP POLICY IF EXISTS "sample_dispatches_update_admin"         ON sample_dispatches;
DROP POLICY IF EXISTS "sample_dispatches_update_qr_submit"     ON sample_dispatches;
DROP POLICY IF EXISTS "sample_dispatches_update_requester_edit" ON sample_dispatches;
DROP POLICY IF EXISTS "sample_dispatches_update_reapply"       ON sample_dispatches;
DROP POLICY IF EXISTS "sample_dispatches_update_followup"      ON sample_dispatches;

-- ── Admin ─────────────────────────────────────────────────────────────────────
CREATE POLICY "sample_dispatches_update_admin" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role = 'admin'
    )
  )
  WITH CHECK (true);

-- ── Requester: Submit QR (approved → qr_submitted) ────────────────────────────
CREATE POLICY "sample_dispatches_update_qr_submit" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING  (requested_by = auth.uid() AND status = 'approved')
  WITH CHECK (requested_by = auth.uid() AND status = 'qr_submitted');

-- ── Requester: Edit own pending request (no status change) ────────────────────
CREATE POLICY "sample_dispatches_update_requester_edit" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING  (requested_by = auth.uid() AND status = 'pending_approval')
  WITH CHECK (requested_by = auth.uid() AND status = 'pending_approval');

-- ── Requester: Reapply after rejection (rejected → pending_approval) ──────────
CREATE POLICY "sample_dispatches_update_reapply" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING  (requested_by = auth.uid() AND status = 'rejected')
  WITH CHECK (requested_by = auth.uid() AND status = 'pending_approval');

-- ── Requester: Save followup note on dispatched row (no status change) ────────
CREATE POLICY "sample_dispatches_update_followup" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING  (requested_by = auth.uid() AND status = 'dispatched')
  WITH CHECK (requested_by = auth.uid() AND status = 'dispatched');
