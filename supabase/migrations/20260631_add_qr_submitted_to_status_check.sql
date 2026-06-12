-- The live database has a CHECK constraint (sample_dispatches_status_check) on the status
-- column that was added manually and never captured in a migration.
-- It does not include 'qr_submitted', causing the Submit QR action to fail at the DB layer.
--
-- This migration drops the old constraint and recreates it with all current valid values.

ALTER TABLE sample_dispatches
  DROP CONSTRAINT IF EXISTS sample_dispatches_status_check;

ALTER TABLE sample_dispatches
  ADD CONSTRAINT sample_dispatches_status_check
  CHECK (status IN (
    'pending_approval',
    'approved',
    'qr_submitted',
    'dispatched',
    'returned',
    'lost',
    'rejected'
  ));
