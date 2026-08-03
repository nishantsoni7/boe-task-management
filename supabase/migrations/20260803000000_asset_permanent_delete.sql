-- Assets & Access — administrator permanent deletion of an entire asset.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
--
-- 20260722000000 §3 made assignment history permanent, and 20260729000000 §4
-- widened that to movement, service and document history. Both were right about
-- the ORDINARY delete: nobody erases a custody record as a side effect of
-- tidying the inventory, and RESTRICT on every child FK keeps that true even
-- for a psql session.
--
-- What neither allowed for is the administrator who means it — an asset entered
-- against the wrong company, a duplicate that was assigned and returned before
-- anyone noticed, a device that must leave the system entirely. For that person
-- the answer today is "no", with no way through, so the row and all of its
-- history stay forever.
--
-- This migration adds ONE narrow door: public.permanently_delete_asset(). It is
-- admin-only, it erases the asset together with everything that belongs solely
-- to it, and it does so in a single transaction. Everything else is untouched:
--
--   * the RESTRICT foreign keys stay RESTRICT — an ad-hoc DELETE on
--     public.assets is refused exactly as before;
--   * the append-only guards on asset_transfers and asset_activity_log still
--     refuse every DELETE except one issued by this function;
--   * approve_asset_change_request() still refuses to approve a REMOVAL request
--     for an asset with assignment history. A request is somebody ASKING; this
--     function is an administrator DECIDING, and only the second is an
--     exception to the history rule;
--   * retire / dispose (20260730000000 §6) remain the soft, reversible route
--     and are what an operator should reach for. Nothing about them changes.
--
-- Tasks, samples and every other module's audit rules are out of scope here.
--
-- ═══ 1. The purge scope flag ═══════════════════════════════════════════════
--
-- Three BEFORE triggers stand between this function and a complete deletion.
-- Rather than weaken any of them, they learn to recognise the one transaction
-- that is allowed through — and only for the ONE asset it names.
--
-- Same idiom as set_asset_edit_logging (20260728000000 §4b): a transaction-local
-- GUC, so it resets at COMMIT or ROLLBACK and can never leak onto the next
-- statement of a pooled connection.
--
-- Forging the GUC is not a way in. set_config() is executable by anyone, but
-- reaching a DELETE in the SAME transaction requires arbitrary SQL, which
-- PostgREST does not offer; and even then employee_assets, asset_transfers,
-- asset_service_records, asset_documents and asset_activity_log have no DELETE
-- policy for any role, so RLS refuses the child deletes regardless of what the
-- triggers think. The flag relaxes triggers only — never RLS, never the FKs.

CREATE OR REPLACE FUNCTION public.asset_purge_in_progress(p_asset_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- COALESCE, not a bare comparison: an unset GUC makes the equality NULL, and
  -- a security predicate that answers "unknown" must answer "no".
  SELECT COALESCE(
    p_asset_id IS NOT NULL
      AND NULLIF(current_setting('boe.asset_purge_id', true), '') = p_asset_id::text,
    false
  );
$$;

-- Left executable by PUBLIC on purpose. Two of the three callers below are
-- SECURITY INVOKER trigger functions, so an ordinary user's refused DELETE
-- evaluates this as themselves — revoking it would replace the readable
-- ASSET_TRANSFER_IMMUTABLE refusal with a raw privilege error. It reads one
-- session variable and discloses nothing.
COMMENT ON FUNCTION public.asset_purge_in_progress(uuid) IS
  'True only inside permanently_delete_asset() and only for the asset it is erasing.';

-- ═══ 2. The three guards learn the exception ═══════════════════════════════
--
-- Each keeps its previous behaviour verbatim for every other caller. The only
-- new line is the early return, placed first so the guard reads as "unless this
-- is the deliberate purge of this exact asset, refuse".

-- 2a. assets — was: any history at all blocks the delete (20260729000000 §4).
CREATE OR REPLACE FUNCTION public.prevent_assigned_asset_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.asset_purge_in_progress(old.id) THEN
    RETURN old;
  END IF;

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

-- 2b. asset_transfers — was: append-only, DELETE never (20260729000000 §1).
CREATE OR REPLACE FUNCTION public.prevent_asset_transfer_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.asset_purge_in_progress(old.asset_id) THEN
      RETURN old;
    END IF;
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

-- 2c. asset_activity_log — was: append-only, DELETE never (20260727000000 §3).
CREATE OR REPLACE FUNCTION public.prevent_asset_activity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.asset_purge_in_progress(old.asset_id) THEN
      RETURN old;
    END IF;
    RAISE EXCEPTION 'ASSET_ACTIVITY_IMMUTABLE: asset activity cannot be deleted'
      USING ERRCODE = '42501';
  END IF;

  IF old.asset_id IS NOT NULL
     AND new.asset_id IS NULL
     AND (to_jsonb(new) - 'asset_id') = (to_jsonb(old) - 'asset_id')
  THEN
    RETURN new;  -- the FK clearing its pointer after an asset was removed
  END IF;

  RAISE EXCEPTION 'ASSET_ACTIVITY_IMMUTABLE: asset activity cannot be modified'
    USING ERRCODE = '42501';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_asset_activity_mutation() FROM public, anon, authenticated;

-- ═══ 3. permanently_delete_asset ═══════════════════════════════════════════
--
-- AUTHORIZATION — administrator, and nothing else.
--
-- Not assert_asset_custody_permission('delete', …): the assets_access 'delete'
-- permission is grantable to a non-admin and was written for a never-assigned
-- inventory mistake. Erasing an accountability record is a different decision
-- and stays with the role that owns the module. A non-admin holding 'delete'
-- keeps exactly what they had — the ordinary DELETE, still refused by §2a for
-- anything with history.
--
-- DELETION ORDER — children first, then the asset. Every child FK is RESTRICT
-- or SET NULL and none of them is relied on here: the rows are removed
-- explicitly, so nothing is left pointing at a deleted asset and no SET NULL
-- ever fires to leave a detached husk behind.
--
--   1. notifications         asset_* types pointing at this asset
--   2. asset_change_requests edit/removal requests raised against it
--   3. asset_documents       metadata for its invoices and warranty cards
--   4. asset_service_records its repair and service history
--   5. asset_transfers       its movement history
--   6. employee_assets       its custody periods
--   7. asset_activity_log    LAST, so any entry written by 1–6 goes too
--   8. assets                the row itself
--
-- WHAT IS NOT TOUCHED — users, employees, access_records, task/finance/order
-- notifications, and any notification whose entity_id does not name this asset.
-- Steps 1–7 are each keyed on this asset's id and nothing else.
--
-- ATOMICITY — one function body is one transaction. A failure at any step
-- rolls back every earlier step, so there is no state in which the history is
-- gone but the asset survives, or the asset is gone but its history remains.

CREATE OR REPLACE FUNCTION public.permanently_delete_asset(p_asset_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_asset  public.assets;
  v_counts jsonb;
  v_n_notifications int;
  v_n_requests      int;
  v_n_documents     int;
  v_n_services      int;
  v_n_transfers     int;
  v_n_assignments   int;
  v_n_activity      int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to delete an asset' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = v_uid AND is_active AND role = 'admin'
  ) THEN
    RAISE EXCEPTION
      'ASSET_DELETE_DENIED: Only an administrator can permanently delete an asset'
      USING ERRCODE = '42501';
  END IF;

  -- Locked for the whole transaction, so a concurrent assignment or transfer
  -- cannot write a child row between the child deletes and the parent delete.
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_DELETE_MISSING: This asset no longer exists'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('boe.asset_purge_id', p_asset_id::text, true);

  -- 1. Its own notifications. `asset_` prefixed types only, so an `access_*`
  --    notification — whose entity_id is an access record, never an asset —
  --    and every task, finance and order notification are out of reach.
  DELETE FROM public.notifications n
   WHERE n.entity_id = p_asset_id
     AND left(n.type::text, 6) = 'asset_';
  GET DIAGNOSTICS v_n_notifications = ROW_COUNT;

  -- 2. Change requests. asset_id is ON DELETE SET NULL so these would otherwise
  --    survive as name-snapshot husks referring to an asset nobody can open.
  DELETE FROM public.asset_change_requests WHERE asset_id = p_asset_id;
  GET DIAGNOSTICS v_n_requests = ROW_COUNT;

  -- 3–6. The RESTRICT children, in an order that never matters to Postgres —
  --      none of them references another — but reads outermost-first.
  DELETE FROM public.asset_documents WHERE asset_id = p_asset_id;
  GET DIAGNOSTICS v_n_documents = ROW_COUNT;

  DELETE FROM public.asset_service_records WHERE asset_id = p_asset_id;
  GET DIAGNOSTICS v_n_services = ROW_COUNT;

  DELETE FROM public.asset_transfers WHERE asset_id = p_asset_id;
  GET DIAGNOSTICS v_n_transfers = ROW_COUNT;

  DELETE FROM public.employee_assets WHERE asset_id = p_asset_id;
  GET DIAGNOSTICS v_n_assignments = ROW_COUNT;

  -- 7. The timeline, last: asset_documents and asset_service_records log their
  --    own changes, so removing them ahead of this leaves nothing behind.
  DELETE FROM public.asset_activity_log WHERE asset_id = p_asset_id;
  GET DIAGNOSTICS v_n_activity = ROW_COUNT;

  -- 8. The asset. §2a lets it through for this transaction only.
  DELETE FROM public.assets WHERE id = p_asset_id;

  PERFORM set_config('boe.asset_purge_id', '', true);

  v_counts := jsonb_build_object(
    'asset_id',      p_asset_id,
    'asset_name',    v_asset.asset_name,
    'asset_code',    v_asset.asset_code,
    'notifications', v_n_notifications,
    'requests',      v_n_requests,
    'documents',     v_n_documents,
    'service',       v_n_services,
    'transfers',     v_n_transfers,
    'assignments',   v_n_assignments,
    'activity',      v_n_activity
  );

  RETURN v_counts;
END;
$$;

REVOKE ALL     ON FUNCTION public.permanently_delete_asset(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.permanently_delete_asset(uuid) TO authenticated;

COMMENT ON FUNCTION public.permanently_delete_asset(uuid) IS
  'Admin-only. Erases an asset and every record that belongs solely to it, in one transaction.';
