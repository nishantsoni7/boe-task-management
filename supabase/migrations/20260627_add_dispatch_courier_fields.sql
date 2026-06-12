-- Add courier and tracking fields to support QR-scan dispatch flow.
ALTER TABLE sample_dispatches
  ADD COLUMN IF NOT EXISTS courier_name    TEXT,
  ADD COLUMN IF NOT EXISTS tracking_number TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_note   TEXT;
