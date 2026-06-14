-- Phase 1: Generic permission framework + Sample Tracking authorization
--
-- Creates employee_permissions table and has_permission() helper.
-- Updates sample_dispatches RLS so users with samples_* permissions
-- can perform their assigned operational actions without being Admin.
--
-- Permissions introduced:
--   samples_dispatch  → can add dispatch/courier/tracking details (qr_submitted → dispatched)
--   samples_receive   → can verify receipt (dispatched → returned)
--   samples_lost      → can mark sample as lost with reason (dispatched → lost)
--   samples_close     → reserved; wired when a closed status is introduced

-- ── 1. employee_permissions table ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS employee_permissions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key TEXT        NOT NULL,
  granted_by     UUID        NOT NULL REFERENCES users(id),
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by     UUID        REFERENCES users(id),
  revoked_at     TIMESTAMPTZ,
  UNIQUE (user_id, permission_key)
);

-- ── 2. RLS on employee_permissions ───────────────────────────────────────────

ALTER TABLE employee_permissions ENABLE ROW LEVEL SECURITY;

-- Users can read their own active permissions (needed by the frontend)
CREATE POLICY "ep_select_own" ON employee_permissions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Only admins can insert, update, or delete permission records
CREATE POLICY "ep_insert_admin" ON employee_permissions
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

CREATE POLICY "ep_update_admin" ON employee_permissions
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

CREATE POLICY "ep_delete_admin" ON employee_permissions
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

-- ── 3. has_permission() helper ────────────────────────────────────────────────

-- Used inside RLS policies. SECURITY DEFINER so it runs as the DB owner
-- and cannot be bypassed by the calling user's row-level context.
CREATE OR REPLACE FUNCTION has_permission(uid UUID, pkey TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM employee_permissions
    WHERE user_id  = uid
      AND permission_key = pkey
      AND revoked_at IS NULL
  );
$$;

-- ── 4. Expand sample_dispatches SELECT policy ────────────────────────────────
--
-- Permission holders need to read all rows to act on them.
-- Admin and own-row visibility are unchanged.

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
    OR has_permission(auth.uid(), 'samples_dispatch')
    OR has_permission(auth.uid(), 'samples_receive')
    OR has_permission(auth.uid(), 'samples_lost')
    OR has_permission(auth.uid(), 'samples_close')
  );

-- ── 5. Add permission-scoped UPDATE policies on sample_dispatches ─────────────
--
-- The existing sample_dispatches_update_admin policy is kept unchanged —
-- admins continue to have unrestricted UPDATE access.
--
-- Three new policies grant the narrowest possible UPDATE window to
-- users with the matching permission key.

-- samples_dispatch: qr_submitted → dispatched
CREATE POLICY "sd_update_perm_dispatch" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    status = 'qr_submitted'
    AND has_permission(auth.uid(), 'samples_dispatch')
  )
  WITH CHECK (
    status = 'dispatched'
    AND has_permission(auth.uid(), 'samples_dispatch')
  );

-- samples_receive: dispatched → returned
CREATE POLICY "sd_update_perm_receive" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    status = 'dispatched'
    AND has_permission(auth.uid(), 'samples_receive')
  )
  WITH CHECK (
    status = 'returned'
    AND has_permission(auth.uid(), 'samples_receive')
  );

-- samples_lost: dispatched → lost
CREATE POLICY "sd_update_perm_lost" ON sample_dispatches
  FOR UPDATE TO authenticated
  USING (
    status = 'dispatched'
    AND has_permission(auth.uid(), 'samples_lost')
  )
  WITH CHECK (
    status = 'lost'
    AND has_permission(auth.uid(), 'samples_lost')
  );

-- samples_close: reserved for closing a completed lifecycle (no current status transition).
-- Defined here for completeness; UI/RLS will be wired when the closed status is introduced.
