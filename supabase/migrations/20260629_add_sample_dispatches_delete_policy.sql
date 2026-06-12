-- Allow permanent deletion of sample requests.
-- Admin: can delete any row regardless of status.
-- Requester: can only delete their own pending_approval requests.

CREATE POLICY "sample_dispatches_delete" ON sample_dispatches
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role = 'admin'
    )
    OR (
      requested_by = auth.uid()
      AND status = 'pending_approval'
    )
  );
