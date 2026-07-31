-- Assets & Access — movement history, repair/service records, and documents.
--
-- Three record types an asset accumulates over its life, each with its own
-- lifecycle and each append-only or definer-written:
--
--   asset_transfers        every movement of custody, ever  (append-only)
--   asset_service_records  one row per repair/service event
--   asset_documents        invoice, warranty card, supporting files
--
-- employee_assets keeps its exact meaning — ONE custody period with its
-- one-time acceptance, and the answer to "who holds this right now".
-- asset_transfers is the permanent narrative around it, including movements
-- employee_assets cannot express: an asset handed to a company location, a
-- repair round-trip, a recovery after a write-off.
--
-- The RPCs that write all of this are in 20260730000000. This file is schema,
-- RLS, logging triggers and storage only.

-- ═══ 1. asset_transfers ════════════════════════════════════════════════════
--
-- ON DELETE RESTRICT, matching employee_assets (20260722000000 §3a): an asset
-- with movement history is not a mistaken inventory entry and cannot be
-- deleted. There is NO update policy and NO delete policy for anyone including
-- an admin — a correction is a NEW row naming the one it corrects, never an
-- edit of the original. That is what "permanent history" has to mean to be
-- worth anything.

CREATE TABLE IF NOT EXISTS public.asset_transfers (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid        NOT NULL REFERENCES public.assets(id) ON DELETE RESTRICT,

  event_type    text        NOT NULL CHECK (event_type IN (
                              'assigned',
                              'transferred',
                              'returned',
                              'marked_lost',
                              'recovered',
                              'sent_for_repair',
                              'returned_from_repair',
                              'retired',
                              'disposed',
                              'correction'
                            )),

  -- Either side may be a person OR a company location, and either may be
  -- absent: an initial assignment has no "from", a write-off has no "to".
  from_employee_id uuid     REFERENCES public.users(id) ON DELETE SET NULL,
  to_employee_id   uuid     REFERENCES public.users(id) ON DELETE SET NULL,
  from_location    text,
  to_location      text,
  -- Captured at movement time, so a later reorganisation never rewrites which
  -- department held what, back then.
  from_department  text,
  to_department    text,

  -- When the system recorded it, vs. when the handover physically happened.
  transfer_date  timestamptz NOT NULL DEFAULT now(),
  effective_date date,

  condition      text        CHECK (condition IS NULL OR condition IN ('new','good','fair','poor','damaged')),
  remarks        text,

  -- Names snapshotted at write time, so a movement still reads by name after a
  -- user record is removed and the FK above nulls the id.
  from_employee_name text,
  to_employee_name   text,

  performed_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  performed_by_name text,

  -- A correction names the entry it corrects instead of overwriting it.
  corrects_transfer_id uuid  REFERENCES public.asset_transfers(id),

  created_at     timestamptz NOT NULL DEFAULT now(),

  -- A move must have a direction. The three events that END custody without a
  -- destination, plus 'correction', are exempt.
  CONSTRAINT asset_transfers_has_direction CHECK (
    event_type IN ('marked_lost', 'retired', 'disposed', 'correction')
    OR to_employee_id IS NOT NULL
    OR to_location IS NOT NULL
    OR from_employee_id IS NOT NULL
    OR from_location IS NOT NULL
  ),

  -- A destination is a person or a place, never both.
  CONSTRAINT asset_transfers_single_destination CHECK (
    to_employee_id IS NULL OR to_location IS NULL
  )
);

CREATE INDEX IF NOT EXISTS asset_transfers_asset_id_idx      ON public.asset_transfers (asset_id, transfer_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_transfers_to_employee_idx   ON public.asset_transfers (to_employee_id);
CREATE INDEX IF NOT EXISTS asset_transfers_from_employee_idx ON public.asset_transfers (from_employee_id);
CREATE INDEX IF NOT EXISTS asset_transfers_event_type_idx    ON public.asset_transfers (event_type);

ALTER TABLE public.asset_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "asset_transfers_select" ON public.asset_transfers;
CREATE POLICY "asset_transfers_select" ON public.asset_transfers
  FOR SELECT TO authenticated
  USING (
    public.can_read_asset_records()
    OR from_employee_id = auth.uid()
    OR to_employee_id   = auth.uid()
  );

-- Append-only, enforced for every path including the service role and psql.
-- The one permitted UPDATE is a foreign key's own ON DELETE SET NULL, which
-- Postgres performs as an ordinary UPDATE — recognised precisely as "a user id
-- moved to NULL and nothing else changed". Same shape as the guard on
-- asset_activity_log (20260727000000 §3).
CREATE OR REPLACE FUNCTION public.prevent_asset_transfer_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ASSET_TRANSFER_IMMUTABLE: transfer history cannot be deleted'
      USING ERRCODE = '42501';
  END IF;

  v_old := to_jsonb(old) - 'from_employee_id' - 'to_employee_id' - 'performed_by';
  v_new := to_jsonb(new) - 'from_employee_id' - 'to_employee_id' - 'performed_by';

  IF v_old = v_new
     AND (new.from_employee_id IS NULL OR new.from_employee_id = old.from_employee_id)
     AND (new.to_employee_id   IS NULL OR new.to_employee_id   = old.to_employee_id)
     AND (new.performed_by     IS NULL OR new.performed_by     = old.performed_by)
  THEN
    RETURN new;  -- an FK clearing its pointer after a user was removed
  END IF;

  RAISE EXCEPTION 'ASSET_TRANSFER_IMMUTABLE: transfer history cannot be modified'
    USING ERRCODE = '42501';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_asset_transfer_mutation() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS asset_transfers_immutable ON public.asset_transfers;
CREATE TRIGGER asset_transfers_immutable
  BEFORE UPDATE OR DELETE ON public.asset_transfers
  FOR EACH ROW EXECUTE FUNCTION public.prevent_asset_transfer_mutation();

-- ═══ 2. asset_service_records ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.asset_service_records (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        uuid        NOT NULL REFERENCES public.assets(id) ON DELETE RESTRICT,

  service_type    text        NOT NULL CHECK (service_type IN ('repair', 'maintenance', 'inspection', 'upgrade')),
  issue           text,
  description     text,
  vendor          text,

  sent_date         date,
  returned_date     date,
  next_service_date date,

  -- Money is numeric, never a float and never text. Defaulted to 0 so a SUM
  -- over an asset's history is always a number, including for an open record
  -- whose cost is not known yet.
  cost            numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),

  remarks         text,
  condition_after text        CHECK (condition_after IS NULL OR condition_after IN ('new','good','fair','poor','damaged')),

  -- 'in_progress' — the asset is away at a vendor right now.
  -- 'completed'   — it came back, or the record was entered after the fact.
  status          text        NOT NULL DEFAULT 'completed'
                              CHECK (status IN ('in_progress', 'completed')),

  recorded_by     uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT asset_service_dates_ordered CHECK (
    sent_date IS NULL OR returned_date IS NULL OR returned_date >= sent_date
  ),
  -- An open record has not come back yet, by definition.
  CONSTRAINT asset_service_open_has_no_return CHECK (
    status <> 'in_progress' OR returned_date IS NULL
  )
);

CREATE INDEX IF NOT EXISTS asset_service_records_asset_id_idx ON public.asset_service_records (asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_service_records_status_idx   ON public.asset_service_records (status);
CREATE INDEX IF NOT EXISTS asset_service_records_next_idx     ON public.asset_service_records (next_service_date);

DROP TRIGGER IF EXISTS asset_service_records_set_updated_at ON public.asset_service_records;
CREATE TRIGGER asset_service_records_set_updated_at
  BEFORE UPDATE ON public.asset_service_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.asset_service_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "asset_service_records_select" ON public.asset_service_records;
CREATE POLICY "asset_service_records_select" ON public.asset_service_records
  FOR SELECT TO authenticated
  USING (
    public.can_read_asset_records()
    OR public.holds_or_held_asset(asset_id)
  );

-- No INSERT/UPDATE/DELETE policy: every write goes through the definer
-- functions in 20260730000000, which is what keeps an asset's status and its
-- service record moving together.

-- Service records log themselves, so an entry appears on the timeline whichever
-- function wrote it.
CREATE OR REPLACE FUNCTION public.log_asset_service_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changes jsonb  := '[]'::jsonb;
  v_labels  text[] := ARRAY[]::text[];
  v_fields CONSTANT text[][] := ARRAY[
    ['service_type',      'Service Type',    'service type'],
    ['issue',             'Issue',           'issue'],
    ['description',       'Description',     'description'],
    ['vendor',            'Vendor',          'vendor'],
    ['sent_date',         'Sent Date',       'sent date'],
    ['returned_date',     'Returned Date',   'returned date'],
    ['cost',              'Cost',            'cost'],
    ['condition_after',   'Condition After', 'condition'],
    ['next_service_date', 'Next Service',    'next service date'],
    ['remarks',           'Remarks',         'remarks'],
    ['status',            'Record Status',   'record status']
  ];
  v_old jsonb;
  v_new jsonb;
  v_i   int;
  v_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_asset_activity(
      new.asset_id, 'service_record_added',
      CASE WHEN new.status = 'in_progress'
           THEN 'Service record opened'
           ELSE 'Service record added' END,
      new.recorded_by, NULL,
      jsonb_build_object(
        'service_record_id', new.id,
        'service_type',      new.service_type,
        'vendor',            new.vendor,
        'cost',              new.cost,
        'record_status',     new.status,
        'actor_name',        public.asset_user_display_name(new.recorded_by)
      )
    );
    RETURN NULL;
  END IF;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  FOR v_i IN 1 .. array_length(v_fields, 1) LOOP
    v_key := v_fields[v_i][1];
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      v_changes := v_changes || jsonb_build_object(
        'field', v_key, 'label', v_fields[v_i][2],
        'old', v_old -> v_key, 'new', v_new -> v_key
      );
      v_labels := v_labels || v_fields[v_i][3];
    END IF;
  END LOOP;

  IF jsonb_array_length(v_changes) = 0 THEN
    RETURN NULL;
  END IF;

  -- Closing an open record is the normal end of a repair round-trip and
  -- complete_asset_service() already logs 'asset_returned_from_repair' for it.
  -- Anything ELSE that moves a stored value is a correction to a historical
  -- record, which is precisely what has to be visible.
  IF old.status = 'in_progress' AND new.status = 'completed' THEN
    RETURN NULL;
  END IF;

  PERFORM public.log_asset_activity(
    new.asset_id, 'service_record_corrected',
    'Corrected ' || array_to_string(v_labels, ', ') || ' on a service record',
    auth.uid(), NULL,
    jsonb_build_object(
      'service_record_id', new.id,
      'changes',           v_changes,
      'actor_name',        public.asset_user_display_name(auth.uid())
    )
  );
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_service_change() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS asset_service_records_log_change ON public.asset_service_records;
CREATE TRIGGER asset_service_records_log_change
  AFTER INSERT OR UPDATE ON public.asset_service_records
  FOR EACH ROW EXECUTE FUNCTION public.log_asset_service_change();

-- ═══ 3. asset_documents ════════════════════════════════════════════════════
--
-- Metadata only. The bytes live in the private 'asset-documents' bucket, whose
-- policies key ownership off the asset id in the first path segment — the same
-- shape as Order Request attachments (20260711000000).
--
-- Removal is a SOFT delete, for two reasons. A document that was on the record
-- and then taken off it is part of the record's history, and the activity entry
-- naming it must still resolve to something. And the storage object is
-- deliberately left in place: this module has no tested storage-cleanup path,
-- and an orphaned metadata row would be worse than an unreferenced object.

CREATE TABLE IF NOT EXISTS public.asset_documents (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid        NOT NULL REFERENCES public.assets(id) ON DELETE RESTRICT,

  doc_type     text        NOT NULL CHECK (doc_type IN ('invoice', 'warranty_card', 'other')),

  file_name    text        NOT NULL CHECK (btrim(file_name) <> ''),
  storage_path text        NOT NULL UNIQUE,
  mime_type    text,
  file_size    bigint      CHECK (file_size IS NULL OR file_size >= 0),

  uploaded_by  uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),

  removed_at   timestamptz,
  removed_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  removal_note text,

  -- A removal always records who did it and when.
  CONSTRAINT asset_documents_removal_complete CHECK (
    (removed_at IS NULL AND removed_by IS NULL)
    OR removed_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS asset_documents_asset_id_idx ON public.asset_documents (asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_documents_doc_type_idx ON public.asset_documents (doc_type);

ALTER TABLE public.asset_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "asset_documents_select" ON public.asset_documents;
CREATE POLICY "asset_documents_select" ON public.asset_documents
  FOR SELECT TO authenticated
  USING (
    public.can_read_asset_records()
    OR public.holds_or_held_asset(asset_id)
  );

-- Upload is an ordinary insert — the client has just written the object and
-- knows its path — gated on the same authority that lets someone change an
-- asset's details. uploaded_by is pinned to the session so a client cannot file
-- a document in someone else's name.
DROP POLICY IF EXISTS "asset_documents_insert" ON public.asset_documents;
CREATE POLICY "asset_documents_insert" ON public.asset_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND removed_at IS NULL
    AND removed_by IS NULL
    AND public.can_write_asset_records()
  );

-- No UPDATE and no DELETE policy. Removal goes through remove_asset_document()
-- so it is always recorded, and a row can never be erased.

CREATE OR REPLACE FUNCTION public.log_asset_document_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text := CASE new.doc_type
                    WHEN 'invoice'       THEN 'Invoice'
                    WHEN 'warranty_card' THEN 'Warranty card'
                    ELSE 'Document'
                  END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The file NAME is what a reader needs. A storage path or a signed URL is
    -- never written into an audit row.
    PERFORM public.log_asset_activity(
      new.asset_id,
      CASE new.doc_type
        WHEN 'invoice'       THEN 'invoice_uploaded'
        WHEN 'warranty_card' THEN 'warranty_document_uploaded'
        ELSE 'document_uploaded'
      END,
      v_label || ' uploaded',
      new.uploaded_by, NULL,
      jsonb_build_object(
        'document_id', new.id,
        'file_name',   new.file_name,
        'doc_type',    new.doc_type,
        'actor_name',  public.asset_user_display_name(new.uploaded_by)
      )
    );
    RETURN NULL;
  END IF;

  IF old.removed_at IS NULL AND new.removed_at IS NOT NULL THEN
    PERFORM public.log_asset_activity(
      new.asset_id, 'document_removed',
      v_label || ' removed',
      new.removed_by, NULL,
      jsonb_build_object(
        'document_id', new.id,
        'file_name',   new.file_name,
        'doc_type',    new.doc_type,
        'reason',      new.removal_note,
        'actor_name',  public.asset_user_display_name(new.removed_by)
      )
    );
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_document_change() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS asset_documents_log_change ON public.asset_documents;
CREATE TRIGGER asset_documents_log_change
  AFTER INSERT OR UPDATE ON public.asset_documents
  FOR EACH ROW EXECUTE FUNCTION public.log_asset_document_change();

-- ═══ 4. Deletion protection extends to the new history ═════════════════════
--
-- 20260722000000 blocked deleting an asset with assignment history. Movement,
-- service and document history are the same kind of record and must block it
-- for the same reason — otherwise an asset that was never formally "assigned"
-- but was repaired twice and has its invoice on file would still be erasable.
--
-- asset_activity_log is deliberately NOT in this list: its FK is
-- ON DELETE SET NULL with a name/code snapshot (20260727000000), so an audit
-- row survives the deletion of a mistaken inventory entry that has no real
-- history. Everything that constitutes actual accountability blocks first.

CREATE OR REPLACE FUNCTION public.prevent_assigned_asset_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.employee_assets WHERE asset_id = old.id) THEN
    RAISE EXCEPTION
      'ASSET_DELETE_BLOCKED: "%" has assignment history and cannot be deleted', old.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.asset_transfers WHERE asset_id = old.id) THEN
    RAISE EXCEPTION
      'ASSET_DELETE_BLOCKED: "%" has movement history and cannot be deleted', old.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.asset_service_records WHERE asset_id = old.id) THEN
    RAISE EXCEPTION
      'ASSET_DELETE_BLOCKED: "%" has repair or service history and cannot be deleted', old.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.asset_documents WHERE asset_id = old.id) THEN
    RAISE EXCEPTION
      'ASSET_DELETE_BLOCKED: "%" has documents on file and cannot be deleted', old.asset_name
      USING ERRCODE = '42501';
  END IF;

  RETURN old;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_assigned_asset_delete() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS assets_prevent_assigned_delete ON public.assets;
CREATE TRIGGER assets_prevent_assigned_delete
  BEFORE DELETE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.prevent_assigned_asset_delete();

-- ═══ 5. Private bucket for asset documents ═════════════════════════════════
--
-- Same shape as order-request-attachments (20260711000000): private, 10 MB per
-- file — the BOE product rule — and an explicit allow-list of safe types. No
-- executables, no macro-enabled Office formats, no application/octet-stream
-- (which would turn the gate into "any binary").
--
-- MUST stay equal to ASSET_DOCUMENT_MAX_BYTES in src/lib/assets/documents.ts —
-- one rule expressed in two places, with the bucket acting as the INDEPENDENT
-- backend boundary rather than the first line of defence.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'asset-documents',
  'asset-documents',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'image/jpeg','image/png','image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','text/csv'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The first path segment is ALWAYS the asset id — these policies read
-- ownership out of it, exactly as the Order Request policies do. Comparison is
-- done as TEXT rather than casting to uuid: a malformed first segment must read
-- as "not yours", never raise 22P02 out of a policy.

DROP POLICY IF EXISTS "asset_documents_storage_insert" ON storage.objects;
CREATE POLICY "asset_documents_storage_insert"
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'asset-documents'
    AND public.can_write_asset_records()
    AND EXISTS (
      SELECT 1 FROM public.assets a
       WHERE a.id::text = split_part(storage.objects.name, '/', 1)
    )
  );

DROP POLICY IF EXISTS "asset_documents_storage_select" ON storage.objects;
CREATE POLICY "asset_documents_storage_select"
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'asset-documents'
    AND (
      public.can_read_asset_records()
      OR EXISTS (
        SELECT 1 FROM public.employee_assets ea
         WHERE ea.asset_id::text = split_part(storage.objects.name, '/', 1)
           AND ea.employee_id = auth.uid()
      )
    )
  );

-- Deleting the OBJECT is admin-only, and is NOT what "Remove document" does —
-- that soft-deletes the metadata row and leaves the bytes alone. This policy
-- exists for genuine administrative cleanup, not for the product flow.
DROP POLICY IF EXISTS "asset_documents_storage_delete" ON storage.objects;
CREATE POLICY "asset_documents_storage_delete"
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'asset-documents'
    AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );
