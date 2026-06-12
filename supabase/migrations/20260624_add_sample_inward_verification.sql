-- Add inward verification fields to sample_dispatches.
-- received_by must be different from requested_by (enforced in app layer).

ALTER TABLE sample_dispatches
  ADD COLUMN IF NOT EXISTS received_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS received_note TEXT;
