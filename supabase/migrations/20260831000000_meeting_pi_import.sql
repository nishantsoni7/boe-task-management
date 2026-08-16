-- Meetings — importing a BOE Proforma Invoice as a New Order Review sheet.
--
-- WHAT THIS ADDS, AND WHY EACH PIECE IS NEEDED
-- --------------------------------------------
-- A BOE PI already describes exactly what a New Order Review walks through:
-- the products, their dimensions, and a photograph of each. Three of those
-- facts had nowhere to live on meeting_order_items, and the photograph had no
-- storage at all — the Meetings module was built with no bucket, deliberately.
--
--   dimensions text  — 100% populated on every genuine PI line in both sample
--                      workbooks. No existing column fits: current_stage means
--                      review stage, not size.
--   spec_note  text  — the operational instruction beside the photograph (a
--                      finish, a fabric, a marble choice). Present on a minority
--                      of lines. NOT put in `issue`, which means "blocker" and
--                      drives the completion warning — every imported product
--                      would have read as blocked.
--   image_path text  — object key inside the private bucket below. Never a URL:
--                      the bucket is private and reads go through a signed URL.
--
-- A `material_spec` column was proposed and is NOT here. Column G of the PI —
-- its supposed source — is empty in both sample workbooks, header included.
-- Adding a column with no evidence of a source would be inventing a field.
--
-- All three are NULLABLE and defaulted to NULL, so every existing row, the
-- manual Add Product form and the current spreadsheet import are unaffected.
--
-- ROLLBACK / CORRECTIVE FORWARD
-- -----------------------------
-- Forward-only (ADR-0003). Additive only: three nullable columns, one bucket,
-- one new function, and two functions replaced with backward-compatible bodies.
-- To retire: drop the three columns, the bucket policies, the bucket, and
-- set_meeting_item_image_path() in a later migration. The Meetings module
-- returns to its present behaviour with no data loss beyond the PI extras.

-- ═══ 1. The three columns ══════════════════════════════════════════════════

ALTER TABLE public.meeting_order_items
  ADD COLUMN IF NOT EXISTS dimensions text,
  ADD COLUMN IF NOT EXISTS spec_note  text,
  ADD COLUMN IF NOT EXISTS image_path text;

COMMENT ON COLUMN public.meeting_order_items.dimensions IS
  'Size/shape as written on the PI (column D). Presentation text, never parsed into numbers.';

COMMENT ON COLUMN public.meeting_order_items.spec_note IS
  'Short OPERATIONAL instruction from the PI — a finish, fabric or marble choice. Never a price, a total or any customer detail: the PI parser refuses commercial columns by construction.';

COMMENT ON COLUMN public.meeting_order_items.image_path IS
  'Object key within the private meeting-product-images bucket, shaped {meeting_order_id}/{sha256}.{ext}. NEVER a public URL — reads go through a signed URL. Several items may share one key when the PI reuses a photograph.';

-- ═══ 2. Private bucket for product photographs ═════════════════════════════
--
-- Modelled on order-request-attachments (20260711000000): private, with the
-- size and type limits enforced AT THE BUCKET, so they hold regardless of what
-- any client believes. 2 MB is the post-compression ceiling — the browser
-- compresses before upload, and the largest raw photograph in the sample files
-- was 786 KB, so this is headroom rather than a constraint on real PIs.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'meeting-product-images',
  'meeting-product-images',
  false,       -- private: no anonymous or public read, ever
  2097152,     -- 2 MB per image (2 × 1024 × 1024)
  ARRAY[
    'image/jpeg',
    'image/jpg',   -- some cameras and older tools emit this variant
    'image/png'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ═══ 3. Storage object policies ════════════════════════════════════════════
--
-- The object key starts with the meeting_order id, so authorization is the
-- meeting's own rule: `can_view_meeting` to read, `can_edit_meeting` to write.
-- No new permission is introduced — a photograph is exactly as visible as the
-- review it belongs to.
--
-- o.id::text = split_part(name, '/', 1), never a uuid CAST of the path. A
-- malformed object name must fail the predicate quietly, not raise 22P02 and
-- break the whole query. This is the convention 20260711000000 established.

DROP POLICY IF EXISTS "meeting_product_images_select" ON storage.objects;
CREATE POLICY "meeting_product_images_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'meeting-product-images'
    AND EXISTS (
      SELECT 1 FROM public.meeting_orders o
      WHERE o.id::text = split_part(storage.objects.name, '/', 1)
        AND public.can_view_meeting(o.meeting_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS "meeting_product_images_insert" ON storage.objects;
CREATE POLICY "meeting_product_images_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'meeting-product-images'
    AND EXISTS (
      SELECT 1 FROM public.meeting_orders o
      WHERE o.id::text = split_part(storage.objects.name, '/', 1)
        AND public.can_edit_meeting(o.meeting_id, auth.uid(), false)
    )
  );

-- Deleting is for the import's own cleanup after a failed confirmation. Same
-- authority as writing; there is no separate grant.
DROP POLICY IF EXISTS "meeting_product_images_delete" ON storage.objects;
CREATE POLICY "meeting_product_images_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'meeting-product-images'
    AND EXISTS (
      SELECT 1 FROM public.meeting_orders o
      WHERE o.id::text = split_part(storage.objects.name, '/', 1)
        AND public.can_edit_meeting(o.meeting_id, auth.uid(), false)
    )
  );

-- No UPDATE policy. An image is written once under its content hash; changing
-- the bytes at a key would make the hash a lie.

-- ═══ 4. Add a SKU line — extended with the three PI fields ═════════════════
--
-- The old 10-argument signature is DROPPED before the new one is created.
-- Adding defaulted parameters without dropping would leave both overloads
-- resident, and a 10-argument call would then match both — PostgreSQL raises
-- "function is not unique" and every existing caller breaks. Dropping first is
-- what keeps this backward compatible in practice.
--
-- The three new parameters are last and default to NULL, so the manual Add
-- Product form calls it exactly as before.

DROP FUNCTION IF EXISTS public.add_meeting_order_item(
  uuid, text, text, numeric, text, text, text, text, text, date
);

CREATE OR REPLACE FUNCTION public.add_meeting_order_item(
  p_order_id               uuid,
  p_sku                    text,
  p_product_name           text,
  p_quantity               numeric DEFAULT NULL,
  p_current_stage          text    DEFAULT NULL,
  p_responsible_department text    DEFAULT NULL,
  p_issue                  text    DEFAULT NULL,
  p_latest_update          text    DEFAULT NULL,
  p_status                 text    DEFAULT 'open',
  p_next_follow_up_date    date    DEFAULT NULL,
  p_dimensions             text    DEFAULT NULL,
  p_spec_note              text    DEFAULT NULL,
  p_image_path             text    DEFAULT NULL
)
RETURNS public.meeting_order_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.meeting_orders;
  v_uid   uuid;
  v_item  public.meeting_order_items;
BEGIN
  SELECT * INTO v_order FROM public.meeting_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_ORDER_MISSING: This order is no longer part of the meeting'
      USING ERRCODE = '42501';
  END IF;

  v_uid := public.assert_meeting_editor(v_order.meeting_id);

  IF btrim(COALESCE(p_sku, '')) = '' OR btrim(COALESCE(p_product_name, '')) = '' THEN
    RAISE EXCEPTION 'MEETING_ITEM_FIELDS_REQUIRED: SKU and product name are required'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_status, 'open') NOT IN ('open', 'waiting', 'resolved') THEN
    RAISE EXCEPTION 'MEETING_ITEM_STATUS_INVALID: Unknown status "%"', p_status USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.meeting_order_items (
    meeting_order_id, sku, product_name, quantity, current_stage,
    responsible_department, issue, latest_update, status, next_follow_up_date,
    dimensions, spec_note, image_path, created_by
  ) VALUES (
    p_order_id, btrim(p_sku), btrim(p_product_name), p_quantity,
    NULLIF(btrim(COALESCE(p_current_stage, '')), ''),
    NULLIF(btrim(COALESCE(p_responsible_department, '')), ''),
    NULLIF(btrim(COALESCE(p_issue, '')), ''),
    NULLIF(btrim(COALESCE(p_latest_update, '')), ''),
    COALESCE(p_status, 'open'), p_next_follow_up_date,
    NULLIF(btrim(COALESCE(p_dimensions, '')), ''),
    NULLIF(btrim(COALESCE(p_spec_note, '')), ''),
    NULLIF(btrim(COALESCE(p_image_path, '')), ''),
    v_uid
  )
  RETURNING * INTO v_item;

  PERFORM public.record_meeting_history(
    v_order.meeting_id, v_order.id, v_item.id,
    v_order.order_number, v_item.sku, v_item.product_name, 'item_added', v_uid,
    p_new_update    := v_item.latest_update,
    p_new_status    := v_item.status,
    p_new_follow_up := v_item.next_follow_up_date
  );

  RETURN v_item;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'MEETING_ITEM_DUPLICATE: "%" is already listed under %', btrim(p_sku), v_order.order_number
      USING ERRCODE = '23505';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_meeting_order_item(uuid, text, text, numeric, text, text, text, text, text, date, text, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.add_meeting_order_item(uuid, text, text, numeric, text, text, text, text, text, date, text, text, text) TO authenticated;

-- ═══ 5. Spreadsheet import — same signature, three more optional keys ══════
--
-- The signature is UNCHANGED (uuid, jsonb), so nothing about how it is called
-- moves. It simply reads three more keys when a row carries them. A row from
-- the existing meeting-review template has none of them and behaves exactly as
-- before — a blank key leaves the column alone, the same rule the rest of this
-- function already follows.

CREATE OR REPLACE FUNCTION public.import_meeting_rows(
  p_meeting_id uuid,
  p_rows       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid := public.assert_meeting_editor(p_meeting_id);
  v_row   jsonb;
  v_order public.meeting_orders;
  v_item  public.meeting_order_items;
  v_before public.meeting_order_items;
  v_meeting_type text;
  v_order_type   text;
  v_number text;
  v_sku    text;
  v_name   text;
  v_update text;
  v_follow date;
  v_orders_created int := 0;
  v_orders_matched int := 0;
  v_items_created  int := 0;
  v_items_updated  int := 0;
  v_seen_orders    uuid[] := ARRAY[]::uuid[];
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'MEETING_IMPORT_INVALID: Expected a list of rows' USING ERRCODE = '22023';
  END IF;

  SELECT meeting_type INTO v_meeting_type FROM public.meetings WHERE id = p_meeting_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_number := btrim(COALESCE(v_row ->> 'order_number', ''));
    v_sku    := btrim(COALESCE(v_row ->> 'sku', ''));
    v_name   := btrim(COALESCE(v_row ->> 'product_name', ''));

    IF v_number = '' OR v_sku = '' OR v_name = '' THEN
      RAISE EXCEPTION 'MEETING_IMPORT_ROW_INVALID: Every row needs an order number, a SKU and a product name'
        USING ERRCODE = '22023';
    END IF;

    v_order_type := COALESCE(NULLIF(v_row ->> 'order_type', ''), v_meeting_type);
    IF v_order_type NOT IN ('new_order', 'repair_order') THEN
      RAISE EXCEPTION 'MEETING_IMPORT_TYPE_INVALID: Unknown order type "%"', v_order_type USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_order
    FROM public.meeting_orders
    WHERE meeting_id = p_meeting_id AND order_number_key = upper(v_number)
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.meeting_orders (
        meeting_id, order_number, order_type, customer_name, expected_dispatch_date, created_by
      ) VALUES (
        p_meeting_id, v_number, v_order_type,
        NULLIF(btrim(COALESCE(v_row ->> 'customer_name', '')), ''),
        NULLIF(v_row ->> 'expected_dispatch_date', '')::date,
        v_uid
      )
      RETURNING * INTO v_order;

      v_orders_created := v_orders_created + 1;
      v_seen_orders := v_seen_orders || v_order.id;
      PERFORM public.record_meeting_history(
        p_meeting_id, v_order.id, NULL, v_order.order_number, NULL, NULL, 'order_added', v_uid,
        p_detail := 'Order added by spreadsheet import'
      );
    ELSE
      UPDATE public.meeting_orders
         SET customer_name          = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'customer_name', '')), ''), customer_name),
             expected_dispatch_date = COALESCE(NULLIF(v_row ->> 'expected_dispatch_date', '')::date, expected_dispatch_date)
       WHERE id = v_order.id
      RETURNING * INTO v_order;

      IF NOT (v_order.id = ANY (v_seen_orders)) THEN
        v_orders_matched := v_orders_matched + 1;
        v_seen_orders := v_seen_orders || v_order.id;
      END IF;
    END IF;

    v_update := NULLIF(btrim(COALESCE(v_row ->> 'latest_update', '')), '');
    v_follow := NULLIF(v_row ->> 'next_follow_up_date', '')::date;

    SELECT * INTO v_before
    FROM public.meeting_order_items
    WHERE meeting_order_id = v_order.id AND sku_key = upper(v_sku)
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.meeting_order_items (
        meeting_order_id, sku, product_name, quantity, current_stage,
        responsible_department, issue, latest_update, next_follow_up_date,
        dimensions, spec_note, image_path, created_by
      ) VALUES (
        v_order.id, v_sku, v_name,
        NULLIF(v_row ->> 'quantity', '')::numeric,
        NULLIF(btrim(COALESCE(v_row ->> 'current_stage', '')), ''),
        NULLIF(btrim(COALESCE(v_row ->> 'responsible_department', '')), ''),
        NULLIF(btrim(COALESCE(v_row ->> 'issue', '')), ''),
        v_update, v_follow,
        NULLIF(btrim(COALESCE(v_row ->> 'dimensions', '')), ''),
        NULLIF(btrim(COALESCE(v_row ->> 'spec_note', '')), ''),
        NULLIF(btrim(COALESCE(v_row ->> 'image_path', '')), ''),
        v_uid
      )
      RETURNING * INTO v_item;

      v_items_created := v_items_created + 1;
      PERFORM public.record_meeting_history(
        p_meeting_id, v_order.id, v_item.id, v_order.order_number, v_item.sku, v_item.product_name,
        'import', v_uid,
        p_new_update    := v_item.latest_update,
        p_new_status    := v_item.status,
        p_new_follow_up := v_item.next_follow_up_date,
        p_detail        := 'Added by spreadsheet import'
      );
    ELSE
      -- A blank key still leaves the value alone, including for the three new
      -- columns. Re-importing a PI therefore refreshes what it states and never
      -- erases what a reviewer has since typed.
      UPDATE public.meeting_order_items
         SET product_name  = v_name,
             quantity      = COALESCE(NULLIF(v_row ->> 'quantity', '')::numeric, quantity),
             current_stage = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'current_stage', '')), ''), current_stage),
             responsible_department = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'responsible_department', '')), ''), responsible_department),
             issue         = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'issue', '')), ''), issue),
             latest_update = COALESCE(v_update, latest_update),
             next_follow_up_date = COALESCE(v_follow, next_follow_up_date),
             dimensions    = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'dimensions', '')), ''), dimensions),
             spec_note     = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'spec_note', '')), ''), spec_note),
             image_path    = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'image_path', '')), ''), image_path)
       WHERE id = v_before.id
      RETURNING * INTO v_item;

      v_items_updated := v_items_updated + 1;

      IF v_update IS NOT NULL
         OR v_item.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN
        PERFORM public.record_meeting_history(
          p_meeting_id, v_order.id, v_item.id, v_order.order_number, v_item.sku, v_item.product_name,
          'import', v_uid,
          p_previous_update    := v_before.latest_update,
          p_new_update         := v_update,
          p_previous_follow_up := CASE WHEN v_item.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN v_before.next_follow_up_date END,
          p_new_follow_up      := CASE WHEN v_item.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN v_item.next_follow_up_date  END,
          p_detail             := 'Updated by spreadsheet import'
        );
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'orders_created', v_orders_created,
    'orders_matched', v_orders_matched,
    'items_created',  v_items_created,
    'items_updated',  v_items_updated
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.import_meeting_rows(uuid, jsonb) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.import_meeting_rows(uuid, jsonb) TO authenticated;

-- ═══ 6. Attaching an uploaded image to an item ═════════════════════════════
--
-- The narrowest possible door, and the reason it exists: Storage and PostgreSQL
-- cannot share a transaction, so the images are uploaded AFTER the rows are
-- committed and their keys written back. That write needs a route, and
-- meeting_order_items has no UPDATE policy for anyone.
--
-- This sets ONE column on ONE row, behind the same editor check as every other
-- meeting write. It is not a general item-update RPC and must not become one:
-- every other field still moves through save_meeting_item_update(), which
-- writes history. An image key is not a discussion event, so it writes none.

CREATE OR REPLACE FUNCTION public.set_meeting_item_image_path(
  p_item_id    uuid,
  p_image_path text
)
RETURNS public.meeting_order_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item  public.meeting_order_items;
  v_order public.meeting_orders;
  v_path  text := NULLIF(btrim(COALESCE(p_image_path, '')), '');
BEGIN
  SELECT * INTO v_item FROM public.meeting_order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_ITEM_MISSING: This product line no longer exists' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.meeting_orders WHERE id = v_item.meeting_order_id;
  PERFORM public.assert_meeting_editor(v_order.meeting_id);

  -- The key must live under THIS order's folder. Without this check an editor
  -- could point an item at another meeting's photograph, and the storage SELECT
  -- policy — which authorizes on the folder — would then happily serve it.
  IF v_path IS NOT NULL AND split_part(v_path, '/', 1) <> v_order.id::text THEN
    RAISE EXCEPTION 'MEETING_IMAGE_PATH_INVALID: That image does not belong to this order'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.meeting_order_items
     SET image_path = v_path
   WHERE id = p_item_id
  RETURNING * INTO v_item;

  RETURN v_item;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_meeting_item_image_path(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.set_meeting_item_image_path(uuid, text) TO authenticated;

-- ═══ 7. Privileges ═════════════════════════════════════════════════════════
--
-- The three new columns inherit meeting_order_items' existing posture: the
-- table has no INSERT/UPDATE/DELETE policy and no client write grant, so they
-- are reachable only through the definer functions above. Re-stated here so a
-- future permissive policy still cannot write them.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meeting_order_items FROM authenticated, anon;
