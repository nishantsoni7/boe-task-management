-- Restrict sample_dispatches SELECT to own rows for non-admin users.
-- Admin (role = 'admin' in users table) can read all rows.
-- All other authenticated users can only read rows they requested.

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
  );
