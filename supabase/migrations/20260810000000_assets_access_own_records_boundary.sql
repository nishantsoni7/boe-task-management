-- Assets & Access — 'view' stops meaning "read the whole company's assets".
--
-- THE DEFECT. 20260723000000 §1 made 'view' a SYSTEM DEFAULT for every active
-- employee. It had to: My Assets embeds assets(...) through employee_assets,
-- and without a baseline read nobody could see the details of the laptop they
-- are holding. But five policies then treated that same 'view' as authority
-- over the WHOLE inventory:
--
--   assets_select              (20260723000000 §4)  every asset in the company
--   employee_assets_manage_select (20260721000000 §2) every assignment, i.e.
--                                                   who holds what, company-wide
--   asset_activity_log_select  (20260727000000 §2)  every asset's timeline
--   can_read_asset_records()   (20260728000000 §5)  transfers, service records,
--                                                   documents, and the private
--                                                   asset-documents bucket
--   asset_change_requests_insert_own (20260724000000 §2) file a request about
--                                                   ANY asset, not just yours
--
-- So one permission answered two unrelated questions — "may this person enter
-- the module and see their own records" and "may this person see everybody's"
-- — and every employee in the company got the second answer along with the
-- first. This migration separates them.
--
-- THE RULE, from here on:
--
--   'view'                                    → the module, and YOUR OWN rows
--   create | assign | edit | delete | manage  → the ORGANISATION-WIDE inventory
--
-- No new action key is introduced. Each of those five is an operation carried
-- out FROM the inventory screen, so holding any one of them and being unable
-- to read the screen would be a half-permission — which is precisely the shape
-- of bug 20260723000000 §5 already had to fix once. The application half of
-- this rule is src/lib/permissions/assetsAccess.ts and must keep saying the
-- same thing; deriveAssetsAccessCapabilities() and can_view_asset_inventory()
-- are the same sentence in two languages.
--
-- Forward-only. Nothing here edits an applied migration; every policy and
-- function is replaced by name.
--
-- NOT CHANGED, deliberately:
--   * employee_assets_own_select / employee_assets_own_accept (20260640) —
--     the self-service read and the acceptance path are exactly what must keep
--     working, and they are already scoped to employee_id = auth.uid().
--   * access_records stays admin-only. secret_value is still plaintext.
--   * asset_transfers / asset_service_records / asset_documents keep their
--     own-holder branches (from_employee_id/to_employee_id = auth.uid(),
--     holds_or_held_asset(asset_id)), so an employee still sees the history of
--     equipment they are accountable for and nothing else.
--   * every append-only guard, every custody RPC, every activity trigger.

-- ═══ 1. The predicates the rest of the file is written in ═════════════════

-- "May this person see the organisation-wide inventory."
--
-- SECURITY DEFINER for the same reason resolve_permission is: it reads tables
-- the caller holds no rights on. is_active is part of the test — a deactivated
-- account reads nothing, however its grants were left.
CREATE OR REPLACE FUNCTION public.can_view_asset_inventory()
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
            OR public.resolve_permission(auth.uid(), 'assets_access', 'create')
            OR public.resolve_permission(auth.uid(), 'assets_access', 'assign')
            OR public.resolve_permission(auth.uid(), 'assets_access', 'edit')
            OR public.resolve_permission(auth.uid(), 'assets_access', 'delete')
            OR public.resolve_permission(auth.uid(), 'assets_access', 'manage'))
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_view_asset_inventory() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_view_asset_inventory() TO authenticated;

-- "May this person ENTER the module at all." The weakest thing the module
-- grants: 'view', or any management capability (which implies it, so a grant
-- can never authorize an action on a module its holder cannot open).
CREATE OR REPLACE FUNCTION public.can_access_assets_module()
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
            OR public.resolve_permission(auth.uid(), 'assets_access', 'view'))
  )
  OR public.can_view_asset_inventory();
$$;

REVOKE EXECUTE ON FUNCTION public.can_access_assets_module() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_access_assets_module() TO authenticated;

-- "May this person work the change-request queue." Defined here, with the
-- other predicates, because §6b's policy is written in terms of it.
--
-- Replaces the admin-only guard from 20260724000000 §3. 'manage' is the review
-- grant: it is already the "custody corrections reserved for administration"
-- action, and reviewing an employee's request about their equipment is the
-- same job. This authorizes SEEING the queue and REJECTING — approving is
-- checked separately in §6d, because approving does something.
CREATE OR REPLACE FUNCTION public.can_review_asset_requests()
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
            OR public.resolve_permission(auth.uid(), 'assets_access', 'manage'))
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_review_asset_requests() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_review_asset_requests() TO authenticated;

-- ═══ 2. assets — inventory, or the equipment you hold ══════════════════════
--
-- Same two-branch shape as 20260723000000 §4; only the first branch narrows.
-- The own-assignment branch is what keeps My Assets working for someone with
-- no management grant, and it is now the ONLY thing an ordinary employee has.

DROP POLICY IF EXISTS "assets_select" ON public.assets;

CREATE POLICY "assets_select" ON public.assets
  FOR SELECT TO authenticated
  USING (
    public.can_view_asset_inventory()
    OR EXISTS (
      SELECT 1 FROM public.employee_assets ea
       WHERE ea.asset_id = assets.id
         AND ea.employee_id = auth.uid()
    )
  );

-- ═══ 3. employee_assets — who holds what is management information ═════════
--
-- This is the policy that let one employee search another employee's assets.
-- employee_assets_own_select (20260640) still covers "my own assignments", and
-- Postgres ORs the two policies together, so nothing self-service breaks.

DROP POLICY IF EXISTS "employee_assets_manage_select"    ON public.employee_assets;
DROP POLICY IF EXISTS "employee_assets_inventory_select" ON public.employee_assets;

CREATE POLICY "employee_assets_inventory_select" ON public.employee_assets
  FOR SELECT TO authenticated
  USING (public.can_view_asset_inventory());

-- ═══ 4. asset_activity_log — an inventory tool, and only that ══════════════
--
-- Unchanged in intent from 20260727000000 §2 ("SELECT mirrors the assets_select
-- rule minus its own-assignment branch"); it simply mirrors the corrected rule
-- now. A timeline names past custodians, so it is not something to widen to
-- the person who currently happens to hold the device.

DROP POLICY IF EXISTS "asset_activity_log_select" ON public.asset_activity_log;

CREATE POLICY "asset_activity_log_select" ON public.asset_activity_log
  FOR SELECT TO authenticated
  USING (public.can_view_asset_inventory());

-- ═══ 5. The shared record-read predicate ═══════════════════════════════════
--
-- Drives asset_transfers_select, asset_service_records_select,
-- asset_documents_select and the asset-documents storage read (20260729000000).
-- Each of those already ORs an own-holder branch, so narrowing this one
-- function removes exactly the org-wide half and leaves self-service intact.
--
-- Body is now the inventory predicate. Kept as its own function rather than
-- replaced at four call sites: the name is what those policies read as, and a
-- future change should still land in one place.

CREATE OR REPLACE FUNCTION public.can_read_asset_records()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT public.can_view_asset_inventory();
$$;

REVOKE EXECUTE ON FUNCTION public.can_read_asset_records() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_read_asset_records() TO authenticated;

-- can_write_asset_records() (edit | manage) is NOT touched. It was already a
-- management-only predicate and never leaked anything to a plain viewer.

-- ═══ 6. Change requests ════════════════════════════════════════════════════

-- 6a. A request must be about an asset you actually have standing to name.
--
-- The old policy required only 'view', which every employee holds — so anyone
-- could file a request against any asset id in the company, and the reviewing
-- screen would show a request from someone with no connection to the asset.
-- Now: the whole inventory if you can see the whole inventory, otherwise the
-- equipment you hold or have held.
--
-- Everything else about the policy is retained verbatim: requested_by pinned
-- to the session, status pending, no review fields.

DROP POLICY IF EXISTS "asset_change_requests_insert_own" ON public.asset_change_requests;

CREATE POLICY "asset_change_requests_insert_own" ON public.asset_change_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
    AND status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_note IS NULL
    AND public.can_access_assets_module()
    AND asset_id IS NOT NULL
    AND (
      public.can_view_asset_inventory()
      OR public.holds_or_held_asset(asset_id)
    )
  );

-- 6b. Reviewers read the queue.
--
-- Was admin-only. A 'manage' holder now reviews as well (§6c), so the read has
-- to follow or the screen would be empty for exactly the people who work it.
-- A requester still reads their own rows and nobody else's.

DROP POLICY IF EXISTS "asset_change_requests_select" ON public.asset_change_requests;

CREATE POLICY "asset_change_requests_select" ON public.asset_change_requests
  FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.can_review_asset_requests()
  );

-- 6c. The reviewer guard the RPCs call, now written in terms of §1's
-- can_review_asset_requests() instead of a bare role literal.

CREATE OR REPLACE FUNCTION public.assert_asset_request_reviewer()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to review an asset request'
      USING ERRCODE = '28000';
  END IF;

  IF NOT public.can_review_asset_requests() THEN
    RAISE EXCEPTION 'ASSET_REQUEST_FORBIDDEN: You do not have permission to review asset requests'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_asset_request_reviewer() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assert_asset_request_reviewer() TO authenticated;

-- 6d. Approving is not a back door.
--
-- Approving an EDIT request performs an edit; approving a REMOVAL deletes the
-- asset master row. If review authority alone were enough, 'manage' would
-- silently become 'edit' and a delete right — the exact escalation the
-- permission split exists to prevent. So the approver must additionally hold
-- the authority the approval exercises. Rejecting needs nothing extra: it
-- changes no asset.
--
--   edit request   → admin OR resolve_permission('assets_access', 'edit')
--   remove request → ADMIN ONLY
--
-- REMOVAL IS ADMIN-ONLY AND MUST STAY THAT WAY. It is not gated on the
-- assets_access 'delete' permission, and the difference matters:
--
--   * 20260803000000 §3 states the BOE rule outright — "the assets_access
--     'delete' permission is grantable to a non-admin and was written for a
--     never-assigned inventory mistake. Erasing an accountability record is a
--     different decision and stays with the role that owns the module."
--   * The DELETE below runs inside a SECURITY DEFINER function, so it does NOT
--     pass through the assets_delete RLS policy. Gating it on 'delete' would
--     not be mirroring an existing authority — it would be a NEW privilege
--     path that no policy governs.
--   * Before this migration, removal approval was admin-only by way of
--     assert_asset_request_reviewer(). Widening review to 'manage' must not
--     quietly widen this with it.
--
-- A 'manage' reviewer therefore triages removal requests — they can read them
-- and reject them — and an administrator is the only one who can say yes.
--
-- What this is NOT: permanently_delete_asset() (20260803000000), which erases
-- an asset TOGETHER WITH its custody, movement, service, document and activity
-- history. That function is untouched here and remains admin-only. The DELETE
-- below is the ordinary one, still standing in front of
-- prevent_assigned_asset_delete(), so it can only ever remove an asset with no
-- history of any kind — a mistaken inventory entry. Removing an EMPLOYEE
-- ASSIGNMENT is a third, unrelated thing: that is return_asset() /
-- transfer_asset(), which close a custody period and never delete a row.
--
-- Nobody may review their own request, at any level. It was previously
-- unreachable (only admins reviewed, and admins raise no requests, having the
-- buttons already); with 'manage' able to both file and review, it has to be
-- stated.
--
-- The rest of the body is 20260727000000 §8's, unchanged — same logging, same
-- ordering, same set_asset_activity_source() bracketing around the UPDATE.

CREATE OR REPLACE FUNCTION public.approve_asset_change_request(
  p_request_id  uuid,
  p_review_note text DEFAULT NULL
)
RETURNS public.asset_change_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.assert_asset_request_reviewer();
  v_req public.asset_change_requests;
BEGIN
  SELECT * INTO v_req
  FROM public.asset_change_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_REQUEST_MISSING: This request no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'ASSET_REQUEST_REVIEWED: This request has already been reviewed'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.requested_by = v_uid THEN
    RAISE EXCEPTION 'ASSET_REQUEST_FORBIDDEN: You cannot approve your own request'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.asset_id IS NULL THEN
    RAISE EXCEPTION 'ASSET_REQUEST_ORPHANED: The asset this request refers to no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.request_type = 'edit' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.users
       WHERE id = v_uid AND is_active
         AND (role = 'admin' OR public.resolve_permission(v_uid, 'assets_access', 'edit'))
    ) THEN
      RAISE EXCEPTION 'ASSET_REQUEST_FORBIDDEN: Approving an edit request needs permission to edit assets'
        USING ERRCODE = '42501';
    END IF;

    PERFORM public.log_asset_activity(
      v_req.asset_id, 'edit_request_approved',
      'Edit request approved',
      v_uid, v_req.requested_by,
      jsonb_build_object(
        'request_id',     v_req.id,
        'requester_name', public.asset_user_display_name(v_req.requested_by),
        'actor_name',     public.asset_user_display_name(v_uid),
        'reason',         v_req.reason,
        'review_note',    p_review_note
      )
    );

    PERFORM public.set_asset_activity_source('asset_change_request', v_req.id);

    UPDATE public.assets
       SET asset_type     = COALESCE(v_req.proposed_asset_type,     asset_type),
           asset_name      = COALESCE(v_req.proposed_asset_name,     asset_name),
           serial_no       = COALESCE(v_req.proposed_serial_no,      serial_no),
           specifications  = COALESCE(v_req.proposed_specifications, specifications)
     WHERE id = v_req.asset_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASSET_REQUEST_ORPHANED: The asset this request refers to no longer exists'
        USING ERRCODE = '42501';
    END IF;

    PERFORM public.set_asset_activity_source(NULL, NULL);

  ELSE
    -- Admin, and nothing else. See the note above: 'delete' is grantable and
    -- was written for the ordinary policy-governed delete, which this is not.
    IF NOT EXISTS (
      SELECT 1 FROM public.users
       WHERE id = v_uid AND is_active AND role = 'admin'
    ) THEN
      RAISE EXCEPTION 'ASSET_REQUEST_FORBIDDEN: Only an administrator can approve a removal request'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (SELECT 1 FROM public.employee_assets WHERE asset_id = v_req.asset_id) THEN
      RAISE EXCEPTION
        'ASSET_DELETE_BLOCKED: "%" has assignment history and cannot be removed', v_req.asset_name_snapshot
        USING ERRCODE = '42501';
    END IF;

    PERFORM public.log_asset_activity(
      v_req.asset_id, 'removal_request_approved',
      'Removal request approved — asset removed from inventory',
      v_uid, v_req.requested_by,
      jsonb_build_object(
        'request_id',     v_req.id,
        'requester_name', public.asset_user_display_name(v_req.requested_by),
        'actor_name',     public.asset_user_display_name(v_uid),
        'reason',         v_req.reason,
        'review_note',    p_review_note
      )
    );

    DELETE FROM public.assets WHERE id = v_req.asset_id;
  END IF;

  UPDATE public.asset_change_requests
     SET status      = 'approved',
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = p_review_note
   WHERE id = p_request_id
  RETURNING * INTO v_req;

  RETURN v_req;
END;
$$;

REVOKE ALL   ON FUNCTION public.approve_asset_change_request(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.approve_asset_change_request(uuid, text) TO authenticated;

-- 6e. Rejecting your own request is refused for the same reason approving is.
--
-- Body is otherwise 20260727000000 §8's reject function, unchanged.

CREATE OR REPLACE FUNCTION public.reject_asset_change_request(
  p_request_id  uuid,
  p_review_note text DEFAULT NULL
)
RETURNS public.asset_change_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.assert_asset_request_reviewer();
  v_req public.asset_change_requests;
BEGIN
  SELECT * INTO v_req
  FROM public.asset_change_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_REQUEST_MISSING: This request no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'ASSET_REQUEST_REVIEWED: This request has already been reviewed'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.requested_by = v_uid THEN
    RAISE EXCEPTION 'ASSET_REQUEST_FORBIDDEN: You cannot review your own request'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.asset_change_requests
     SET status      = 'rejected',
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = p_review_note
   WHERE id = p_request_id
  RETURNING * INTO v_req;

  IF v_req.asset_id IS NOT NULL THEN
    PERFORM public.log_asset_activity(
      v_req.asset_id,
      CASE WHEN v_req.request_type = 'edit'
           THEN 'edit_request_rejected'
           ELSE 'removal_request_rejected' END,
      CASE WHEN v_req.request_type = 'edit'
           THEN 'Edit request rejected'
           ELSE 'Removal request rejected' END,
      v_uid, v_req.requested_by,
      jsonb_build_object(
        'request_id',     v_req.id,
        'requester_name', public.asset_user_display_name(v_req.requested_by),
        'actor_name',     public.asset_user_display_name(v_uid),
        'reason',         v_req.reason,
        'review_note',    p_review_note
      )
    );
  END IF;

  RETURN v_req;
END;
$$;

REVOKE ALL   ON FUNCTION public.reject_asset_change_request(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reject_asset_change_request(uuid, text) TO authenticated;
