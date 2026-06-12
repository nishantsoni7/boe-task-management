-- Record who performed the dispatch action (QR scan flow or manual).
ALTER TABLE sample_dispatches
  ADD COLUMN IF NOT EXISTS dispatched_by UUID REFERENCES users(id) ON DELETE SET NULL;
