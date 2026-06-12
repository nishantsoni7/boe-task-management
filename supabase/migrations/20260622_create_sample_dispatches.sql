-- Sample Requests: staff submit catalog sample requests → admin approves → dispatched → returned
CREATE TABLE IF NOT EXISTS sample_dispatches (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_type         TEXT NOT NULL,   -- fabric_catalog | metal_color_catalog | rope_catalog | wooden_swatches_catalog | other
  catalog_name         TEXT NOT NULL,
  client_name          TEXT NOT NULL,
  client_phone         TEXT,
  client_address       TEXT,
  requested_by         UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  approved_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at          TIMESTAMPTZ,
  rejected_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at          TIMESTAMPTZ,
  rejection_reason     TEXT,
  dispatched_at        TIMESTAMPTZ,
  expected_return_date DATE,
  returned_date        DATE,
  received_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at          TIMESTAMPTZ,
  received_note        TEXT,
  status               TEXT NOT NULL DEFAULT 'pending_approval',
  -- pending_approval | approved | rejected | dispatched | returned | lost
  notes                TEXT,
  last_followup_note   TEXT,
  last_followup_date   DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE sample_dispatches ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY "sample_dispatches_insert" ON sample_dispatches
  FOR INSERT TO authenticated WITH CHECK (requested_by = auth.uid());

CREATE POLICY "sample_dispatches_update" ON sample_dispatches
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_sample_dispatches_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sample_dispatches_updated_at
  BEFORE UPDATE ON sample_dispatches
  FOR EACH ROW EXECUTE FUNCTION set_sample_dispatches_updated_at();
