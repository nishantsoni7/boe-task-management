-- Add audit fields for the lost-item workflow.
-- lost_by: who marked the sample as lost
-- lost_at: when it was marked lost
-- lost_note: optional reason / context

ALTER TABLE sample_dispatches
  ADD COLUMN IF NOT EXISTS lost_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lost_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lost_note TEXT;
