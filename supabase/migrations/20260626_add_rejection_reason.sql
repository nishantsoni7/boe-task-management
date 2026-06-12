-- Add rejection_reason to sample_dispatches (required when rejecting)
ALTER TABLE sample_dispatches
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
