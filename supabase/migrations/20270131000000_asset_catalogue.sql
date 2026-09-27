-- Assets & Access — a managed asset catalogue: categories and products.
--
-- WHAT THIS IS
-- ------------
-- Until now an asset's CATEGORY was assets.asset_type, a free text column the
-- screens filled from a list of six values compiled into the app
-- (ASSET_CATEGORY_OPTIONS: laptop_desktop, monitor, mouse_keyboard, storage,
-- phone, other). Adding a seventh meant a deploy. There was no PRODUCT at all:
-- "Dell Latitude 5420" was typed again, by hand, into asset_name / brand /
-- model on every individual laptop.
--
-- This migration makes both a managed catalogue:
--
--   asset_categories  one row per category. Its primary key IS the value
--                     assets.asset_type already stores ('laptop_desktop'), and
--                     asset_type becomes a foreign key to it. The key never
--                     changes; renaming a category changes `name`, so every
--                     existing asset, change request and activity row keeps
--                     pointing at the same category and simply reads the new
--                     name. No asset row is rewritten.
--   asset_products    a reusable type or model WITHIN a category. An asset may
--                     name one through the new, NULLABLE assets.product_id.
--                     A product is never an individual item: it has no holder,
--                     no status and no code. Assets are still the items.
--
-- ONE catalogue, not two. ASSET_CATEGORY_OPTIONS stops being a source of truth
-- in the same change; the app reads this table.
--
-- BACKFILL — THE SMALLEST THAT KEEPS WHAT EXISTS
-- ----------------------------------------------
-- * The six fixed categories are inserted under their existing keys, with the
--   names the screens were already showing (tidied: "Laptop / Desktop").
-- * Any OTHER value found in assets.asset_type or
--   asset_change_requests.proposed_asset_type is inserted too, under its own
--   key, so the foreign keys can be added without touching a single row. On
--   production (checked read-only on 2026-09-27) there are none.
-- * NO products are created. The existing brand / model text is inconsistent
--   ("sandisk", "Sea gate", "One plus 7") and turning it into catalogue rows
--   would publish guesses as fact. Every existing asset keeps product_id NULL
--   and keeps its own asset_name / brand / model exactly as entered.
--
-- NOTHING IS EVER DELETED
-- -----------------------
-- There is no DELETE policy and no delete RPC, and every foreign key into the
-- catalogue is RESTRICT. Retiring an entry sets is_active = false: it stops
-- being offered for NEW assets, and every existing asset, request and history
-- row that names it still reads it by name. Reactivating is the same RPC.
--
-- WHO MAY CHANGE IT
-- -----------------
-- A new action, assets_access.manage_asset_catalogue ("Manage Asset
-- Catalogue"), PROTECTED and denied by default, shaped exactly like
-- manage_access_records (20261028000000):
--   * this migration grants it to NOBODY but the admin role row;
--   * an administrator grants it to a named person in Control Center;
--   * it confers NO other authority — no asset create / assign / edit /
--     delete / manage, no access records, no Control Center, no payroll;
--   * catalogue rows are written ONLY by the four SECURITY DEFINER RPCs below,
--     each of which checks can_manage_asset_catalogue() first. Clients hold no
--     INSERT / UPDATE / DELETE privilege on the tables at all, so a direct
--     PostgREST write is refused whatever the caller's grants.
--
-- AUDIT
-- -----
-- asset_catalogue_activity is append-only, written only by those RPCs in the
-- same transaction as the change, and records who and when — the pattern of
-- asset_activity_log (20260727000000). created_by / updated_by on the rows give
-- the same answer at a glance.
--
-- ROLLBACK
-- --------
-- Forward-only, like every migration here. Undoing it, if ever needed, is:
--   drop the two assets triggers and their functions, the RPCs and
--   can_manage_asset_catalogue(); drop the FKs assets_asset_type_fkey,
--   asset_change_requests_proposed_asset_type_fkey and the column
--   assets.product_id (after confirming no asset relies on it); drop the three
--   tables; delete the manage_asset_catalogue role / override /
--   module_permission_actions / permission_actions rows. assets.asset_type is
--   never modified here, so no asset data needs restoring.

-- ═══ 1. Register the action ═════════════════════════════════════════════════
--
-- is_system = false: a custom action like `assign` and `manage_access_records`.
-- Mirrors src/lib/permissions/modules.ts so `npm run permissions:check` stays
-- clean.

INSERT INTO public.permission_actions (action_key, display_name, is_system)
VALUES ('manage_asset_catalogue', 'Manage Asset Catalogue', false)
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO public.module_permission_actions (module_id, action_id, default_allowed)
SELECT pm.id, pa.id, false
FROM public.permission_modules pm
JOIN public.permission_actions pa ON pa.action_key = 'manage_asset_catalogue'
WHERE pm.module_key = 'assets_access'
ON CONFLICT (module_id, action_id) DO NOTHING;

INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'admin', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id
JOIN public.permission_actions  pa ON pa.id = mpa.action_id
WHERE pm.module_key = 'assets_access'
  AND pa.action_key = 'manage_asset_catalogue'
ON CONFLICT (role, module_id, action_id) DO NOTHING;

-- ═══ 2. The predicate ═══════════════════════════════════════════════════════
--
-- Same shape as can_manage_access_records(): an ACTIVE admin, or an active
-- holder of the explicit grant. Deliberately NOT implied by any asset action —
-- create / edit / manage let someone work with assets, not redefine what kinds
-- of asset exist.

CREATE OR REPLACE FUNCTION public.can_manage_asset_catalogue()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = auth.uid()
       AND is_active
       AND (role = 'admin'
            OR public.resolve_permission(auth.uid(), 'assets_access', 'manage_asset_catalogue'))
  );
$$;

COMMENT ON FUNCTION public.can_manage_asset_catalogue() IS
  'Admin, or an explicit assets_access.manage_asset_catalogue grant. Governs asset '
  'categories and products only. Grants no asset, access-record or Control Center authority.';

REVOKE EXECUTE ON FUNCTION public.can_manage_asset_catalogue() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_manage_asset_catalogue() TO authenticated;

-- ═══ 3. Tables ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.asset_categories (
  -- The value assets.asset_type stores. Immutable: see the header.
  key        text        PRIMARY KEY CHECK (btrim(key) <> ''),
  name       text        NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 60),
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- NULL for the backfilled categories: the system created them, not a person.
  created_by uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        REFERENCES public.users(id) ON DELETE SET NULL
);

-- One name per category across active AND inactive entries: re-adding
-- "Tablets" while a retired "Tablets" exists would give two rows nobody can
-- tell apart. The RPC turns this into "reactivate the existing one" advice.
CREATE UNIQUE INDEX IF NOT EXISTS asset_categories_name_key
  ON public.asset_categories (lower(name));

CREATE TABLE IF NOT EXISTS public.asset_products (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text        NOT NULL REFERENCES public.asset_categories(key)
                             ON UPDATE RESTRICT ON DELETE RESTRICT,
  name         text        NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 80),
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL
);

-- Unique WITHIN a category. The same model name under two categories is two
-- different things and allowed.
CREATE UNIQUE INDEX IF NOT EXISTS asset_products_category_name_key
  ON public.asset_products (category_key, lower(name));

-- Append-only record of every catalogue change.
CREATE TABLE IF NOT EXISTS public.asset_catalogue_activity (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text        NOT NULL CHECK (entity_type IN ('category', 'product')),
  category_key text        NOT NULL,
  product_id   uuid,
  -- category_created | category_renamed | category_deactivated |
  -- category_reactivated | product_created | product_renamed |
  -- product_moved | product_deactivated | product_reactivated
  event_type   text        NOT NULL,
  summary      text        NOT NULL,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- No FK: history must outlive a removed user. The name is snapshotted.
  actor_id     uuid,
  actor_name   text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS asset_catalogue_activity_created_idx
  ON public.asset_catalogue_activity (created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_asset_catalogue_activity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'ASSET_CATALOGUE_IMMUTABLE: catalogue history cannot be changed or removed'
    USING ERRCODE = '42501';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_asset_catalogue_activity_mutation() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS asset_catalogue_activity_immutable ON public.asset_catalogue_activity;
CREATE TRIGGER asset_catalogue_activity_immutable
  BEFORE UPDATE OR DELETE ON public.asset_catalogue_activity
  FOR EACH ROW EXECUTE FUNCTION public.prevent_asset_catalogue_activity_mutation();

-- ═══ 4. Backfill — the categories that exist today ══════════════════════════

INSERT INTO public.asset_categories (key, name) VALUES
  ('laptop_desktop', 'Laptop / Desktop'),
  ('monitor',        'Monitor'),
  ('mouse_keyboard', 'Mouse / Keyboard'),
  ('storage',        'Storage'),
  ('phone',          'Phone'),
  ('other',          'Other')
ON CONFLICT (key) DO NOTHING;

-- Anything else already stored, kept under its own key so no row changes.
-- A generated name that collides with an existing one is qualified with its
-- key rather than merged: merging would silently re-categorise assets.
DO $$
DECLARE
  v_key  text;
  v_name text;
BEGIN
  FOR v_key IN
    SELECT DISTINCT t.k FROM (
      SELECT asset_type AS k FROM public.assets
      UNION
      SELECT proposed_asset_type FROM public.asset_change_requests WHERE proposed_asset_type IS NOT NULL
    ) t
    WHERE NOT EXISTS (SELECT 1 FROM public.asset_categories c WHERE c.key = t.k)
    ORDER BY 1
  LOOP
    v_name := left(initcap(regexp_replace(btrim(replace(v_key, '_', ' ')), '\s+', ' ', 'g')), 60);
    IF v_name = '' THEN v_name := 'Uncategorised'; END IF;
    IF EXISTS (SELECT 1 FROM public.asset_categories WHERE lower(name) = lower(v_name)) THEN
      v_name := left(v_name || ' (' || v_key || ')', 60);
    END IF;
    INSERT INTO public.asset_categories (key, name) VALUES (v_key, v_name);
    RAISE NOTICE 'ASSET_CATALOGUE: backfilled legacy category % as "%"', v_key, v_name;
  END LOOP;
END $$;

-- ═══ 5. Link assets to the catalogue ════════════════════════════════════════

ALTER TABLE public.assets DROP CONSTRAINT IF EXISTS assets_asset_type_fkey;
ALTER TABLE public.assets
  ADD CONSTRAINT assets_asset_type_fkey
  FOREIGN KEY (asset_type) REFERENCES public.asset_categories(key)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE public.asset_change_requests DROP CONSTRAINT IF EXISTS asset_change_requests_proposed_asset_type_fkey;
ALTER TABLE public.asset_change_requests
  ADD CONSTRAINT asset_change_requests_proposed_asset_type_fkey
  FOREIGN KEY (proposed_asset_type) REFERENCES public.asset_categories(key)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS product_id uuid
  REFERENCES public.asset_products(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS assets_product_id_idx ON public.assets (product_id);

-- ═══ 6. Keep an asset's category and product consistent ═════════════════════
--
-- BEFORE INSERT OR UPDATE OF asset_type, product_id. Every existing writer —
-- the create form, the edit form, approve_asset_change_request — reaches this
-- without being rewritten.
--
--   * A NEW choice must be active. An existing asset resting on a category or
--     product that has since been retired is untouched until someone changes
--     that field: retiring never breaks a save of some other field.
--   * A product must belong to the asset's category.
--   * Changing the category while leaving the product as it was clears the
--     product when it belonged to the old category. That is the only
--     consistent outcome, and it is what makes an approved category-change
--     request (which knows nothing about products) apply cleanly. The product
--     change is logged by §7 like any other.
--
-- SECURITY DEFINER so an invoker without SELECT on a retired row still gets
-- the right answer (see 20270117000000 for what an invoker guard costs).

CREATE OR REPLACE FUNCTION public.enforce_asset_catalogue_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cat_name   text;
  v_cat_active boolean;
  v_prod_cat   text;
  v_prod_name  text;
  v_prod_active boolean;
  v_type_changed boolean := TG_OP = 'INSERT' OR new.asset_type IS DISTINCT FROM old.asset_type;
  v_prod_changed boolean := TG_OP = 'INSERT' OR new.product_id IS DISTINCT FROM old.product_id;
BEGIN
  IF v_type_changed THEN
    SELECT name, is_active INTO v_cat_name, v_cat_active
      FROM public.asset_categories WHERE key = new.asset_type;
    -- A missing key is left to the foreign key, which names the constraint.
    IF FOUND AND NOT v_cat_active THEN
      RAISE EXCEPTION 'ASSET_CATEGORY_INACTIVE: The category "%" is no longer in use. Choose an active category', v_cat_name
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF new.product_id IS NOT NULL THEN
    SELECT category_key, name, is_active INTO v_prod_cat, v_prod_name, v_prod_active
      FROM public.asset_products WHERE id = new.product_id;

    IF FOUND AND v_prod_cat IS DISTINCT FROM new.asset_type THEN
      IF TG_OP = 'UPDATE' AND v_type_changed AND NOT v_prod_changed THEN
        new.product_id := NULL;
      ELSE
        RAISE EXCEPTION 'ASSET_PRODUCT_MISMATCH: The product "%" belongs to a different category', v_prod_name
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF FOUND AND v_prod_changed AND NOT v_prod_active THEN
      RAISE EXCEPTION 'ASSET_PRODUCT_INACTIVE: The product "%" is no longer in use. Choose an active product', v_prod_name
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN new;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_asset_catalogue_links() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS assets_enforce_catalogue_links ON public.assets;
CREATE TRIGGER assets_enforce_catalogue_links
  BEFORE INSERT OR UPDATE OF asset_type, product_id ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_catalogue_links();

-- ═══ 7. An asset's product change is part of its own history ════════════════
--
-- log_asset_edited (20260728000000) logs a fixed field list and product_id is
-- not on it. Rather than restate that function, this small trigger writes the
-- same asset_edited event, in the same shape ({changes: [{field, label, old,
-- new}]}), with product NAMES rather than ids so the timeline reads.

CREATE OR REPLACE FUNCTION public.log_asset_product_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old text;
  v_new text;
BEGIN
  IF coalesce(nullif(current_setting('boe.asset_edit_logging', true), ''), 'on') = 'off' THEN
    RETURN NULL;
  END IF;
  IF new.product_id IS NOT DISTINCT FROM old.product_id THEN
    RETURN NULL;
  END IF;

  SELECT name INTO v_old FROM public.asset_products WHERE id = old.product_id;
  SELECT name INTO v_new FROM public.asset_products WHERE id = new.product_id;

  PERFORM public.log_asset_activity(
    new.id, 'asset_edited', 'Updated product',
    auth.uid(), NULL,
    jsonb_build_object(
      'changes', jsonb_build_array(jsonb_build_object(
        'field', 'product_id', 'label', 'Product',
        'old', to_jsonb(v_old), 'new', to_jsonb(v_new)
      )),
      'actor_name', public.asset_user_display_name(auth.uid())
    )
  );
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_product_changed() FROM public, anon, authenticated;

-- AFTER UPDATE, not AFTER UPDATE OF product_id: §6 clears the product when
-- only asset_type was in the SET list, and a column-scoped trigger would miss
-- exactly that change. The function returns at once when the product is
-- unchanged.
DROP TRIGGER IF EXISTS assets_log_product_changed ON public.assets;
CREATE TRIGGER assets_log_product_changed
  AFTER UPDATE ON public.assets
  FOR EACH ROW
  WHEN (old.product_id IS DISTINCT FROM new.product_id)
  EXECUTE FUNCTION public.log_asset_product_changed();

-- ═══ 8. Row-level security ══════════════════════════════════════════════════
--
-- READ: anyone who may enter Assets & Access. Category and product names are
-- labels, not records — My Assets needs them to say "Phone" rather than a key.
-- The RESTRICTIVE module entry gate is added exactly as 20260905000000 lays it
-- on every other table of this module.
--
-- WRITE: nobody, directly. No INSERT / UPDATE / DELETE policy exists, and the
-- table privileges are revoked as well, so a PostgREST write fails before RLS
-- is even consulted. The RPCs below run as the table owner.
--
-- Catalogue HISTORY is readable by whoever manages the catalogue or the
-- inventory — the two audiences that act on it.

ALTER TABLE public.asset_categories         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_products           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_catalogue_activity ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.asset_categories, public.asset_products, public.asset_catalogue_activity FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.asset_categories, public.asset_products, public.asset_catalogue_activity
  FROM authenticated;
GRANT SELECT ON public.asset_categories, public.asset_products, public.asset_catalogue_activity TO authenticated;

DROP POLICY IF EXISTS "asset_categories_select" ON public.asset_categories;
CREATE POLICY "asset_categories_select" ON public.asset_categories
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "asset_products_select" ON public.asset_products;
CREATE POLICY "asset_products_select" ON public.asset_products
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "asset_catalogue_activity_select" ON public.asset_catalogue_activity;
CREATE POLICY "asset_catalogue_activity_select" ON public.asset_catalogue_activity
  FOR SELECT TO authenticated
  USING (public.can_manage_asset_catalogue() OR public.can_view_asset_inventory());

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['asset_categories', 'asset_products', 'asset_catalogue_activity'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_module_entry_gate', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (public.module_entry_open(%L)) WITH CHECK (public.module_entry_open(%L))',
      v_table || '_module_entry_gate', v_table, 'assets_access', 'assets_access'
    );
  END LOOP;
END $$;

-- ═══ 9. The write RPCs ══════════════════════════════════════════════════════
--
-- Every one: SECURITY DEFINER, pinned search_path, authorization FIRST, then a
-- row lock, then validation, then the write and its audit row in the same
-- transaction. Errors are prefixed so src/lib/assets/errors.ts can show the
-- sentence after the prefix verbatim.
--
-- Names are normalised the same way everywhere: trimmed, runs of whitespace
-- collapsed to one space. "  Dell   Latitude " and "Dell Latitude" are the same
-- name, and the duplicate check is case-insensitive.

CREATE OR REPLACE FUNCTION public.asset_catalogue_normalise_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
$$;

CREATE OR REPLACE FUNCTION public.assert_asset_catalogue_manager()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF NOT public.can_manage_asset_catalogue() THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_DENIED: You do not have permission to manage the asset catalogue'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_asset_catalogue_manager() FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_asset_catalogue_activity(
  p_entity_type  text,
  p_category_key text,
  p_product_id   uuid,
  p_event_type   text,
  p_summary      text,
  p_details      jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.asset_catalogue_activity
    (entity_type, category_key, product_id, event_type, summary, details, actor_id, actor_name)
  VALUES
    (p_entity_type, p_category_key, p_product_id, p_event_type, p_summary,
     coalesce(p_details, '{}'::jsonb), auth.uid(), public.asset_user_display_name(auth.uid()));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_catalogue_activity(text, text, uuid, text, text, jsonb) FROM public, anon, authenticated;

-- ── 9a. create_asset_category ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_asset_category(p_name text)
RETURNS public.asset_categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name     text := public.asset_catalogue_normalise_name(p_name);
  v_existing public.asset_categories;
  v_base     text;
  v_key      text;
  v_n        int := 1;
  v_row      public.asset_categories;
BEGIN
  PERFORM public.assert_asset_catalogue_manager();

  IF v_name = '' THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Enter a category name' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_name) > 60 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Keep the category name to 60 characters or fewer' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_existing FROM public.asset_categories WHERE lower(name) = lower(v_name);
  IF FOUND THEN
    IF v_existing.is_active THEN
      RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: A category named "%" already exists', v_existing.name
        USING ERRCODE = '23505';
    ELSE
      RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: An inactive category named "%" already exists. Reactivate it instead', v_existing.name
        USING ERRCODE = '23505';
    END IF;
  END IF;

  -- The key is derived once and never changes. Readable, unique, and never
  -- colliding with a legacy key.
  v_base := trim(both '_' from regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g'));
  IF v_base = '' THEN v_base := 'category'; END IF;
  v_base := left(v_base, 50);
  v_key := v_base;
  WHILE EXISTS (SELECT 1 FROM public.asset_categories WHERE key = v_key) LOOP
    v_n := v_n + 1;
    v_key := v_base || '_' || v_n;
  END LOOP;

  BEGIN
    INSERT INTO public.asset_categories (key, name, created_by, updated_by)
    VALUES (v_key, v_name, auth.uid(), auth.uid())
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: A category named "%" already exists', v_name
      USING ERRCODE = '23505';
  END;

  PERFORM public.log_asset_catalogue_activity(
    'category', v_row.key, NULL, 'category_created',
    'Added category "' || v_row.name || '"',
    jsonb_build_object('name', v_row.name));

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_asset_category(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_asset_category(text) TO authenticated;

-- ── 9b. update_asset_category — rename, retire, reactivate ─────────────────

CREATE OR REPLACE FUNCTION public.update_asset_category(
  p_key       text,
  p_name      text,
  p_is_active boolean
)
RETURNS public.asset_categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old  public.asset_categories;
  v_row  public.asset_categories;
  v_name text := public.asset_catalogue_normalise_name(p_name);
  v_dup  text;
BEGIN
  PERFORM public.assert_asset_catalogue_manager();

  SELECT * INTO v_old FROM public.asset_categories WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_MISSING: That category no longer exists' USING ERRCODE = 'P0001';
  END IF;

  IF p_is_active IS NULL THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Say whether the category is active' USING ERRCODE = 'P0001';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Enter a category name' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_name) > 60 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Keep the category name to 60 characters or fewer' USING ERRCODE = 'P0001';
  END IF;

  SELECT name INTO v_dup FROM public.asset_categories
   WHERE lower(name) = lower(v_name) AND key <> p_key;
  IF FOUND THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: A category named "%" already exists', v_dup
      USING ERRCODE = '23505';
  END IF;

  IF v_name = v_old.name AND p_is_active = v_old.is_active THEN
    RETURN v_old;
  END IF;

  BEGIN
    UPDATE public.asset_categories
       SET name = v_name, is_active = p_is_active, updated_at = now(), updated_by = auth.uid()
     WHERE key = p_key
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: A category named "%" already exists', v_name
      USING ERRCODE = '23505';
  END;

  IF v_name <> v_old.name THEN
    PERFORM public.log_asset_catalogue_activity(
      'category', p_key, NULL, 'category_renamed',
      'Renamed category "' || v_old.name || '" to "' || v_name || '"',
      jsonb_build_object('old_name', v_old.name, 'new_name', v_name));
  END IF;
  IF p_is_active <> v_old.is_active THEN
    PERFORM public.log_asset_catalogue_activity(
      'category', p_key, NULL,
      CASE WHEN p_is_active THEN 'category_reactivated' ELSE 'category_deactivated' END,
      CASE WHEN p_is_active THEN 'Reactivated category "' ELSE 'Retired category "' END || v_name || '"',
      jsonb_build_object('name', v_name));
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_asset_category(text, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.update_asset_category(text, text, boolean) TO authenticated;

-- ── 9c. create_asset_product ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_asset_product(
  p_category_key text,
  p_name         text
)
RETURNS public.asset_products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cat      public.asset_categories;
  v_name     text := public.asset_catalogue_normalise_name(p_name);
  v_existing public.asset_products;
  v_row      public.asset_products;
BEGIN
  PERFORM public.assert_asset_catalogue_manager();

  SELECT * INTO v_cat FROM public.asset_categories WHERE key = p_category_key FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_MISSING: That category no longer exists' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_cat.is_active THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: "%" is inactive. Reactivate it before adding products', v_cat.name
      USING ERRCODE = 'P0001';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Enter a product name' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Keep the product name to 80 characters or fewer' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_existing FROM public.asset_products
   WHERE category_key = p_category_key AND lower(name) = lower(v_name);
  IF FOUND THEN
    IF v_existing.is_active THEN
      RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: "%" already has a product named "%"', v_cat.name, v_existing.name
        USING ERRCODE = '23505';
    ELSE
      RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: "%" has an inactive product named "%". Reactivate it instead', v_cat.name, v_existing.name
        USING ERRCODE = '23505';
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.asset_products (category_key, name, created_by, updated_by)
    VALUES (p_category_key, v_name, auth.uid(), auth.uid())
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: "%" already has a product named "%"', v_cat.name, v_name
      USING ERRCODE = '23505';
  END;

  PERFORM public.log_asset_catalogue_activity(
    'product', p_category_key, v_row.id, 'product_created',
    'Added product "' || v_row.name || '" to "' || v_cat.name || '"',
    jsonb_build_object('name', v_row.name, 'category_name', v_cat.name));

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_asset_product(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_asset_product(text, text) TO authenticated;

-- ── 9d. update_asset_product — rename, move, retire, reactivate ────────────
--
-- Moving a product to another category is allowed only while NO asset names
-- it: an asset's category and product must agree, and silently re-categorising
-- assets is exactly what this catalogue must never do.

CREATE OR REPLACE FUNCTION public.update_asset_product(
  p_id           uuid,
  p_category_key text,
  p_name         text,
  p_is_active    boolean
)
RETURNS public.asset_products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old     public.asset_products;
  v_row     public.asset_products;
  v_name    text := public.asset_catalogue_normalise_name(p_name);
  v_cat     public.asset_categories;
  v_old_cat text;
  v_dup     text;
  v_in_use  int;
BEGIN
  PERFORM public.assert_asset_catalogue_manager();

  SELECT * INTO v_old FROM public.asset_products WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_MISSING: That product no longer exists' USING ERRCODE = 'P0001';
  END IF;

  IF p_is_active IS NULL THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Say whether the product is active' USING ERRCODE = 'P0001';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Enter a product name' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: Keep the product name to 80 characters or fewer' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_cat FROM public.asset_categories WHERE key = coalesce(p_category_key, v_old.category_key) FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_MISSING: That category no longer exists' USING ERRCODE = 'P0001';
  END IF;
  SELECT name INTO v_old_cat FROM public.asset_categories WHERE key = v_old.category_key;

  IF v_cat.key <> v_old.category_key THEN
    SELECT count(*) INTO v_in_use FROM public.assets WHERE product_id = p_id;
    IF v_in_use > 0 THEN
      RAISE EXCEPTION 'ASSET_CATALOGUE_IN_USE: "%" is used by % asset(s), so it cannot move to another category', v_old.name, v_in_use
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_cat.is_active THEN
      RAISE EXCEPTION 'ASSET_CATALOGUE_INVALID: "%" is inactive. Choose an active category', v_cat.name
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT name INTO v_dup FROM public.asset_products
   WHERE category_key = v_cat.key AND lower(name) = lower(v_name) AND id <> p_id;
  IF FOUND THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: "%" already has a product named "%"', v_cat.name, v_dup
      USING ERRCODE = '23505';
  END IF;

  IF v_name = v_old.name AND p_is_active = v_old.is_active AND v_cat.key = v_old.category_key THEN
    RETURN v_old;
  END IF;

  BEGIN
    UPDATE public.asset_products
       SET name = v_name, is_active = p_is_active, category_key = v_cat.key,
           updated_at = now(), updated_by = auth.uid()
     WHERE id = p_id
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_DUPLICATE: "%" already has a product named "%"', v_cat.name, v_name
      USING ERRCODE = '23505';
  END;

  IF v_name <> v_old.name THEN
    PERFORM public.log_asset_catalogue_activity(
      'product', v_cat.key, p_id, 'product_renamed',
      'Renamed product "' || v_old.name || '" to "' || v_name || '"',
      jsonb_build_object('old_name', v_old.name, 'new_name', v_name));
  END IF;
  IF v_cat.key <> v_old.category_key THEN
    PERFORM public.log_asset_catalogue_activity(
      'product', v_cat.key, p_id, 'product_moved',
      'Moved product "' || v_name || '" from "' || v_old_cat || '" to "' || v_cat.name || '"',
      jsonb_build_object('old_category_key', v_old.category_key, 'new_category_key', v_cat.key,
                         'old_category_name', v_old_cat, 'new_category_name', v_cat.name));
  END IF;
  IF p_is_active <> v_old.is_active THEN
    PERFORM public.log_asset_catalogue_activity(
      'product', v_cat.key, p_id,
      CASE WHEN p_is_active THEN 'product_reactivated' ELSE 'product_deactivated' END,
      CASE WHEN p_is_active THEN 'Reactivated product "' ELSE 'Retired product "' END || v_name || '"',
      jsonb_build_object('name', v_name));
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_asset_product(uuid, text, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.update_asset_product(uuid, text, text, boolean) TO authenticated;

-- ── 9e. asset_catalogue_usage — counts only ────────────────────────────────
--
-- The catalogue screen says "used by 4 assets" beside each entry, so a manager
-- can see what retiring it would affect. A delegated catalogue manager does NOT
-- hold inventory access and must not read asset rows to learn that, so this
-- returns COUNTS by category, product and status — no id, name, code or holder.

CREATE OR REPLACE FUNCTION public.asset_catalogue_usage()
RETURNS TABLE (category_key text, product_id uuid, status text, asset_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF NOT (public.can_manage_asset_catalogue() OR public.can_view_asset_inventory()) THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE_DENIED: You do not have permission to view catalogue usage'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT a.asset_type, a.product_id, a.status, count(*)
      FROM public.assets a
     GROUP BY a.asset_type, a.product_id, a.status;
END;
$$;

REVOKE ALL ON FUNCTION public.asset_catalogue_usage() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.asset_catalogue_usage() TO authenticated;

-- ═══ 10. Post-conditions ════════════════════════════════════════════════════
--
-- Read-only. A half-applied state fails the migration rather than looking
-- successful.

DO $$
DECLARE
  v_count int;
BEGIN
  -- 10a. Registered against Assets & Access, denied by default, and nowhere else.
  SELECT count(*) INTO v_count
  FROM public.module_permission_actions mpa
  JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key = 'assets_access'
  JOIN public.permission_actions  pa ON pa.id = mpa.action_id AND pa.action_key = 'manage_asset_catalogue'
  WHERE mpa.default_allowed = false;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: expected one denied-by-default registration, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.module_permission_actions mpa
  JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key <> 'assets_access'
  JOIN public.permission_actions  pa ON pa.id = mpa.action_id AND pa.action_key = 'manage_asset_catalogue';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: the action leaked onto % other module(s)', v_count;
  END IF;

  -- 10b. Granted to nobody but the admin role.
  SELECT count(*) INTO v_count
  FROM public.role_permissions rp
  JOIN public.permission_actions pa ON pa.id = rp.action_id AND pa.action_key = 'manage_asset_catalogue'
  WHERE rp.role <> 'admin' AND rp.allowed;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: % non-admin role rule(s) grant this action', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.department_permissions dp
  JOIN public.permission_actions pa ON pa.id = dp.action_id AND pa.action_key = 'manage_asset_catalogue'
  WHERE dp.allowed;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: % department rule(s) grant this action', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.employee_permission_overrides eo
  JOIN public.permission_actions pa ON pa.id = eo.action_id AND pa.action_key = 'manage_asset_catalogue'
  WHERE eo.allowed AND eo.revoked_at IS NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: this migration must grant the action to nobody, but % employee(s) hold it', v_count;
  END IF;

  -- 10c. The six categories that existed before are all present, and every
  --      asset and change request resolves to a category.
  SELECT count(*) INTO v_count FROM public.asset_categories
   WHERE key IN ('laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other');
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: expected the six existing categories, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.assets a
   WHERE NOT EXISTS (SELECT 1 FROM public.asset_categories c WHERE c.key = a.asset_type);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: % asset(s) have no category', v_count;
  END IF;

  -- 10d. No existing asset was given a product.
  SELECT count(*) INTO v_count FROM public.assets WHERE product_id IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: % asset(s) were given a product by the migration', v_count;
  END IF;

  -- 10e. No write policy exists for anybody on the catalogue tables, and
  --      authenticated holds no write privilege.
  SELECT count(*) INTO v_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname IN ('asset_categories', 'asset_products', 'asset_catalogue_activity')
    AND p.polpermissive
    AND p.polcmd <> 'r';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: % permissive write policy(ies) exist on the catalogue tables', v_count;
  END IF;

  IF has_table_privilege('authenticated', 'public.asset_categories', 'INSERT')
     OR has_table_privilege('authenticated', 'public.asset_categories', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.asset_products', 'INSERT')
     OR has_table_privilege('authenticated', 'public.asset_products', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.asset_catalogue_activity', 'INSERT') THEN
    RAISE EXCEPTION 'ASSET_CATALOGUE: authenticated still holds a write privilege on the catalogue';
  END IF;

  RAISE NOTICE 'ASSET_CATALOGUE: all post-conditions passed';
END $$;
