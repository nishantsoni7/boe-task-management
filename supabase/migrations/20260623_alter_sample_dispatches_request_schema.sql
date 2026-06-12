-- Migrate sample_dispatches from dispatch schema → request/approval schema.
-- Safe to run on tables with existing data.

-- ── 1. Add new columns ───────────────────────────────────────────────────────

ALTER TABLE sample_dispatches
  ADD COLUMN IF NOT EXISTS requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

-- ── 2. Migrate data from old columns before dropping them ────────────────────

-- sent_by → requested_by (preserve who sent as who requested)
UPDATE sample_dispatches
  SET requested_by = sent_by
  WHERE requested_by IS NULL AND sent_by IS NOT NULL;

-- sent_date → dispatched_at for records that were already 'sent'
-- (old 'sent' status = already dispatched in the new model)
UPDATE sample_dispatches
  SET dispatched_at = sent_date::TIMESTAMPTZ
  WHERE sent_date IS NOT NULL AND status = 'sent';

-- ── 3. Remap old status values to new status vocabulary ─────────────────────

-- 'sent' in the old schema means the sample was already out → 'dispatched'
UPDATE sample_dispatches SET status = 'dispatched' WHERE status = 'sent';
-- 'returned' and 'lost' are unchanged

-- ── 4. Apply new default for status ─────────────────────────────────────────

ALTER TABLE sample_dispatches ALTER COLUMN status SET DEFAULT 'pending_approval';

-- ── 5. Make requested_by NOT NULL now that existing rows are backfilled ──────
-- Any rows where sent_by was NULL will have requested_by = NULL.
-- Set a sentinel fallback so NOT NULL can be enforced without breaking data.
-- (If sent_by was already nullable and some rows are NULL, this is safe.)
ALTER TABLE sample_dispatches ALTER COLUMN requested_by SET NOT NULL;

-- ── 6. Drop insert policy BEFORE dropping sent_by (policy depends on it) ────

DROP POLICY IF EXISTS "sample_dispatches_insert" ON sample_dispatches;

-- ── 7. Drop old columns ──────────────────────────────────────────────────────

ALTER TABLE sample_dispatches
  DROP COLUMN IF EXISTS sent_by,
  DROP COLUMN IF EXISTS sent_date,
  DROP COLUMN IF EXISTS client_company,
  DROP COLUMN IF EXISTS client_email;

-- ── 8. Recreate insert policy using requested_by ─────────────────────────────

CREATE POLICY "sample_dispatches_insert" ON sample_dispatches
  FOR INSERT TO authenticated WITH CHECK (requested_by = auth.uid());
