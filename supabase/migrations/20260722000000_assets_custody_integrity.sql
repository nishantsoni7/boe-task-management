-- Assets & Access — custody integrity: return lifecycle, acceptance hardening,
-- and permanent protection of assignment history.
--
-- Three defects this closes, all in the V1 schema from 20260640:
--
--   1. A returned asset was a dead end. "Mark Returned" set assets.status =
--      'returned' and nothing anywhere ever set it back, while the Assign
--      action only renders for 'available' — so every returned asset became
--      permanently unassignable. 'returned' is an event in an asset's life,
--      not a resting state of the asset itself; the resting state after a
--      normal return is 'available'.
--
--   2. Acceptance was a raw client UPDATE. employee_assets_own_accept only
--      constrained employee_id and the new status, leaving accepted_at,
--      assigned_at, assigned_by, asset_id, returned_at and lost_at freely
--      writable by the accepting employee. An employee could backdate their
--      own acceptance — the exact record the module exists to make trustworthy.
--
--   3. Deleting an asset destroyed its custody history silently.
--      employee_assets.asset_id was ON DELETE CASCADE, and the UI only
--      checked for an ACTIVE assignment, so an asset that had been assigned,
--      accepted and returned looked deletable and took every acceptance
--      record with it.
--
-- Layering follows 20260705: RLS decides who may ask, a BEFORE DELETE trigger
-- is the actual guarantee (it also binds the service role and direct SQL), and
-- the app just stops offering what the database refuses.
--
-- NOT in scope (deliberately, per the task): no return-condition capture, no
-- transfer operation, no service/repair lifecycle, no archive/retire, no asset
-- activity log, and no change to the permission cutover in 20260721000000 —
-- the assets_delete / employee_assets_manage_* policies are left exactly as
-- that migration created them.

-- ─── 1. Return lifecycle: 'returned' is not a resting asset status ─────────
--
-- One-time correction of rows already stranded by defect 1. The active-
-- assignment guard is belt-and-braces: an asset with status 'returned' should
-- never also hold a live assignment, and if some row does, it is left alone
-- rather than silently freed for reassignment.
--
-- employee_assets.status keeps 'returned' — that IS the right value there.
-- Only the assets-side resting status changes.

UPDATE public.assets a
   SET status = 'available'
 WHERE a.status = 'returned'
   AND NOT EXISTS (
     SELECT 1 FROM public.employee_assets ea
      WHERE ea.asset_id = a.id
        AND ea.status IN ('pending_acceptance', 'accepted')
   );

-- ─── 2. Acceptance hardening ───────────────────────────────────────────────
--
-- The broad employee UPDATE policy is REPLACED, not narrowed: there is no
-- column-level WITH CHECK that can express "only these two columns may move",
-- so acceptance becomes a SECURITY DEFINER RPC with the authorization in its
-- body, and employees lose direct UPDATE on employee_assets entirely. This
-- mirrors how Order Requests handles the same problem (20260708).
--
-- After this migration employees hold exactly one privilege on the table:
-- employee_assets_own_select (unchanged). Reads still work, writes do not.

DROP POLICY IF EXISTS "employee_assets_own_accept" ON public.employee_assets;

-- accepted_at is set by the database, never supplied by the caller — that is
-- the whole point. The signature takes the assignment id and nothing else, so
-- there is no parameter through which a timestamp could arrive.
CREATE OR REPLACE FUNCTION public.accept_employee_asset(p_assignment_id uuid)
RETURNS public.employee_assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.employee_assets;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to accept an asset'
      USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row
  FROM public.employee_assets
  WHERE id = p_assignment_id;

  -- Deliberately one message for "no such assignment" and "not yours": a
  -- member must not be able to probe which assignment ids exist by reading
  -- back two different errors.
  IF NOT FOUND OR v_row.employee_id <> v_uid THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_DENIED: No pending assignment found for you'
      USING ERRCODE = '42501';
  END IF;

  -- Already accepted / returned / lost: fail without touching the row, so a
  -- second Accept can never move accepted_at forward.
  IF v_row.status <> 'pending_acceptance' THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_INVALID: This assignment is already % and cannot be accepted', v_row.status
      USING ERRCODE = '42501';
  END IF;

  -- Only these two columns are written. asset_id, employee_id, assigned_by,
  -- assigned_at, returned_at and lost_at are absent from the SET list, so
  -- this function has no way to alter them. The WHERE clause repeats both
  -- guards so a concurrent accept or return cannot slip between the check
  -- above and the write.
  UPDATE public.employee_assets
     SET status      = 'accepted',
         accepted_at = now()
   WHERE id          = p_assignment_id
     AND employee_id = v_uid
     AND status      = 'pending_acceptance'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_CONFLICT: This assignment changed while you were accepting it'
      USING ERRCODE = '40001';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL   ON FUNCTION public.accept_employee_asset(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.accept_employee_asset(uuid) TO authenticated;

-- ─── 3. Assignment history is permanent ────────────────────────────────────
--
-- 3a. Structural: the FK stops being a shredder.
--
-- ON DELETE CASCADE meant "deleting an asset deletes every record of who held
-- it". RESTRICT states the real rule in the schema itself, so the guarantee
-- survives even if the trigger below is ever dropped.

ALTER TABLE public.employee_assets
  DROP CONSTRAINT IF EXISTS employee_assets_asset_id_fkey;

ALTER TABLE public.employee_assets
  ADD CONSTRAINT employee_assets_asset_id_fkey
  FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE RESTRICT;

-- 3b. Behavioural: a clear refusal instead of a raw FK violation, on every
-- path — PostgREST, the service role, and direct SQL alike.
--
-- ANY assignment row blocks the delete, whatever its status. A returned or
-- lost assignment is precisely the history worth keeping; only an asset that
-- was never assigned to anyone (a mistaken inventory entry) may be removed.
-- No admin exemption: an admin's delete right is about never-assigned rows,
-- not about erasing custody records.

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

  RETURN old;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_assigned_asset_delete() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS assets_prevent_assigned_delete ON public.assets;

CREATE TRIGGER assets_prevent_assigned_delete
  BEFORE DELETE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.prevent_assigned_asset_delete();
