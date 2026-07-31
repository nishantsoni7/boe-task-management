-- Assets & Access — master detail: purchase, warranty, condition, department.
--
-- Builds directly on 20260726000000 (asset_code + location) and 20260727000000
-- (the activity log). Nothing there is replaced; log_asset_edited() is EXTENDED
-- so the new fields are audited exactly like the five it already watches, and
-- the status vocabulary is widened for the repair/retire lifecycle that
-- 20260730000000 introduces.
--
-- Every column is nullable. Almost every existing asset has none of this
-- information and must keep loading exactly as it does today — "no purchase
-- date recorded" is a permanent, legitimate state, not a gap to be filled with
-- a guess. The UI's job is to say "Not recorded", not to fail.
--
-- WARRANTY STATUS IS NOT STORED. It is derived from warranty_expiry_date every
-- time it is displayed (src/lib/assets/warranty.ts). A stored status column
-- would be a second copy of a fact that changes by itself every midnight, and
-- would be wrong on any row nobody happened to touch that day.

-- ═══ 1. Columns ════════════════════════════════════════════════════════════
--
-- asset_type keeps its name and remains the asset's CATEGORY — it is surfaced
-- as "Category" in the UI. A second near-identical column would only create
-- two places to disagree.

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS brand                text,
  ADD COLUMN IF NOT EXISTS model                text,
  ADD COLUMN IF NOT EXISTS description          text,

  ADD COLUMN IF NOT EXISTS purchase_date        date,
  ADD COLUMN IF NOT EXISTS purchase_price       numeric(14,2),
  ADD COLUMN IF NOT EXISTS vendor               text,
  ADD COLUMN IF NOT EXISTS invoice_number       text,

  ADD COLUMN IF NOT EXISTS warranty_start_date  date,
  ADD COLUMN IF NOT EXISTS warranty_expiry_date date,
  ADD COLUMN IF NOT EXISTS warranty_type        text,
  ADD COLUMN IF NOT EXISTS warranty_remarks     text,

  ADD COLUMN IF NOT EXISTS condition            text,
  ADD COLUMN IF NOT EXISTS department           text;

-- ═══ 2. Constraints ════════════════════════════════════════════════════════
--
-- All NOT VALID. The columns did not exist a moment ago, so there is nothing
-- to verify; the constraint governs every future write from here on. The one
-- exception is the status check, which is NOT VALID for a real reason — see §2d.

-- 2a. A price is a quantity, never a negative one.
ALTER TABLE public.assets DROP CONSTRAINT IF EXISTS assets_purchase_price_non_negative;
ALTER TABLE public.assets
  ADD CONSTRAINT assets_purchase_price_non_negative
  CHECK (purchase_price IS NULL OR purchase_price >= 0) NOT VALID;

-- 2b. Warranty cannot end before it starts. Both sides stay optional: an asset
-- may have an expiry with no recorded start, which is the common case when the
-- only surviving paperwork is the warranty card itself.
ALTER TABLE public.assets DROP CONSTRAINT IF EXISTS assets_warranty_dates_ordered;
ALTER TABLE public.assets
  ADD CONSTRAINT assets_warranty_dates_ordered
  CHECK (
    warranty_start_date IS NULL
    OR warranty_expiry_date IS NULL
    OR warranty_expiry_date >= warranty_start_date
  ) NOT VALID;

-- 2c. Condition vocabulary. NULL means "not recorded", which is a different
-- fact from "good" and must stay tellable apart.
ALTER TABLE public.assets DROP CONSTRAINT IF EXISTS assets_condition_known;
ALTER TABLE public.assets
  ADD CONSTRAINT assets_condition_known
  CHECK (condition IS NULL OR condition IN ('new', 'good', 'fair', 'poor', 'damaged')) NOT VALID;

-- 2d. Status vocabulary, widened for the repair and retirement lifecycle.
--
-- 'returned' is retained ONLY because rows predating 20260722000000 may still
-- carry it (that migration corrected the ones it could safely reach). Nothing
-- writes it any more — the resting status after a return is 'available'.
--
-- NOT VALID is load-bearing here, unlike above: this constraint DOES cover
-- pre-existing rows, and a single stranded legacy value must not turn a
-- deployment into an outage. New writes are constrained; old rows are left to
-- be corrected deliberately.
ALTER TABLE public.assets DROP CONSTRAINT IF EXISTS assets_status_known;
ALTER TABLE public.assets
  ADD CONSTRAINT assets_status_known
  CHECK (status IN (
    'available', 'assigned', 'under_repair', 'returned', 'lost', 'retired', 'disposed'
  )) NOT VALID;

-- ═══ 3. Indexes for the list screen's filters ══════════════════════════════
-- assets(status) already has one from 20260640.

CREATE INDEX IF NOT EXISTS assets_asset_type_idx      ON public.assets (asset_type);
CREATE INDEX IF NOT EXISTS assets_condition_idx       ON public.assets (condition);
CREATE INDEX IF NOT EXISTS assets_warranty_expiry_idx ON public.assets (warranty_expiry_date);
CREATE INDEX IF NOT EXISTS assets_purchase_date_idx   ON public.assets (purchase_date);
CREATE INDEX IF NOT EXISTS assets_updated_at_idx      ON public.assets (updated_at DESC);
CREATE INDEX IF NOT EXISTS assets_department_idx      ON public.assets (department);

-- ═══ 4. The edit trigger learns the new fields ═════════════════════════════
--
-- Same contract as 20260727000000 §5: master details only, status excluded
-- (every status movement already has its own custody event), no changed field
-- means no row.
--
-- Warranty changes are split into their OWN event. "Warranty details updated"
-- is a thing an operator goes looking for, and burying it inside a generic
-- "Updated name, warranty expiry" line would make it unfindable. One save that
-- touches both writes both events, which is exactly what happened.
--
-- `department` and `location` are watched here, but the custody functions in
-- 20260730000000 set them as part of a movement that logs its own, far more
-- meaningful, event. Those functions suppress this trigger for the duration of
-- the movement via set_asset_activity_source('custody', …) — see §4b — so a
-- transfer produces one entry, not two.

-- 4b. A transaction-local suppression flag, in the same style as
-- set_asset_activity_source (20260727000000): is_local, so it resets at COMMIT
-- and can never leak onto the next statement of a pooled connection.
CREATE OR REPLACE FUNCTION public.set_asset_edit_logging(p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('boe.asset_edit_logging', CASE WHEN p_enabled THEN 'on' ELSE 'off' END, true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_asset_edit_logging(boolean) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_asset_edited()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_core     jsonb  := '[]'::jsonb;
  v_core_lbl text[] := ARRAY[]::text[];
  v_warr     jsonb  := '[]'::jsonb;
  v_warr_lbl text[] := ARRAY[]::text[];

  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);

  -- field, label, short label used in the summary sentence
  v_core_fields CONSTANT text[][] := ARRAY[
    ['asset_type',     'Type',           'type'],
    ['asset_name',     'Name',           'name'],
    ['serial_no',      'Serial No.',     'serial number'],
    ['specifications', 'Specifications', 'specifications'],
    ['location',       'Location',       'location'],
    ['department',     'Department',     'department'],
    ['brand',          'Brand',          'brand'],
    ['model',          'Model',          'model'],
    ['description',    'Description',    'description'],
    ['condition',      'Condition',      'condition'],
    ['purchase_date',  'Purchase Date',  'purchase date'],
    ['purchase_price', 'Purchase Price', 'purchase price'],
    ['vendor',         'Vendor',         'vendor'],
    ['invoice_number', 'Invoice No.',    'invoice number']
  ];
  v_warr_fields CONSTANT text[][] := ARRAY[
    ['warranty_start_date',  'Warranty Start',   'warranty start'],
    ['warranty_expiry_date', 'Warranty Expiry',  'warranty expiry'],
    ['warranty_type',        'Warranty Type',    'warranty type'],
    ['warranty_remarks',     'Warranty Remarks', 'warranty remarks']
  ];

  v_i   int;
  v_key text;
BEGIN
  -- Suppressed while a custody function is mid-movement.
  IF coalesce(nullif(current_setting('boe.asset_edit_logging', true), ''), 'on') = 'off' THEN
    RETURN NULL;
  END IF;

  FOR v_i IN 1 .. array_length(v_core_fields, 1) LOOP
    v_key := v_core_fields[v_i][1];
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      v_core := v_core || jsonb_build_object(
        'field', v_key, 'label', v_core_fields[v_i][2],
        'old', v_old -> v_key, 'new', v_new -> v_key
      );
      v_core_lbl := v_core_lbl || v_core_fields[v_i][3];
    END IF;
  END LOOP;

  FOR v_i IN 1 .. array_length(v_warr_fields, 1) LOOP
    v_key := v_warr_fields[v_i][1];
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      v_warr := v_warr || jsonb_build_object(
        'field', v_key, 'label', v_warr_fields[v_i][2],
        'old', v_old -> v_key, 'new', v_new -> v_key
      );
      v_warr_lbl := v_warr_lbl || v_warr_fields[v_i][3];
    END IF;
  END LOOP;

  IF jsonb_array_length(v_core) > 0 THEN
    PERFORM public.log_asset_activity(
      new.id, 'asset_edited',
      'Updated ' || array_to_string(v_core_lbl, ', '),
      auth.uid(), NULL,
      jsonb_build_object('changes', v_core, 'actor_name', public.asset_user_display_name(auth.uid()))
    );
  END IF;

  IF jsonb_array_length(v_warr) > 0 THEN
    PERFORM public.log_asset_activity(
      new.id, 'warranty_updated',
      'Updated ' || array_to_string(v_warr_lbl, ', '),
      auth.uid(), NULL,
      jsonb_build_object('changes', v_warr, 'actor_name', public.asset_user_display_name(auth.uid()))
    );
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_edited() FROM public, anon, authenticated;

-- The trigger itself is unchanged from 20260727000000; only the function body
-- above moved. Recreated defensively so this migration is self-contained.
DROP TRIGGER IF EXISTS assets_log_edited ON public.assets;
CREATE TRIGGER assets_log_edited
  AFTER UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.log_asset_edited();

-- ═══ 5. Shared read predicates for the record tables ═══════════════════════
--
-- "May this person read asset records at all." One function so the three tables
-- added by 20260729000000 cannot drift apart from each other or from the
-- policies in 20260721000000 / 20260723000000. SECURITY DEFINER for the same
-- reason resolve_permission is: it reads tables the caller may not hold rights
-- on.

CREATE OR REPLACE FUNCTION public.can_read_asset_records()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = auth.uid()
       AND is_active
       AND (role = 'admin'
            OR public.resolve_permission(auth.uid(), 'assets_access', 'view')
            OR public.resolve_permission(auth.uid(), 'assets_access', 'manage')
            OR public.resolve_permission(auth.uid(), 'assets_access', 'assign'))
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_read_asset_records() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_read_asset_records() TO authenticated;

-- "May this person CHANGE asset records." Edit-level authority: master details,
-- warranty, documents and historical service entries. 'manage' is accepted
-- alongside 'edit' so whoever runs the live repair round-trip is never blocked
-- from writing down what they just did.
CREATE OR REPLACE FUNCTION public.can_write_asset_records()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = auth.uid()
       AND is_active
       AND (role = 'admin'
            OR public.resolve_permission(auth.uid(), 'assets_access', 'edit')
            OR public.resolve_permission(auth.uid(), 'assets_access', 'manage'))
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_write_asset_records() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_write_asset_records() TO authenticated;

-- "Is this asset one the signed-in employee holds or has held?" — the
-- self-service half, so someone can see the movement, service and document
-- history of the equipment they are personally accountable for, and nothing
-- else.
CREATE OR REPLACE FUNCTION public.holds_or_held_asset(p_asset_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employee_assets
     WHERE asset_id = p_asset_id AND employee_id = auth.uid()
  );
$$;

REVOKE EXECUTE ON FUNCTION public.holds_or_held_asset(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.holds_or_held_asset(uuid) TO authenticated;
