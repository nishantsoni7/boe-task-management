-- Assets & Access — admin-approved edit and removal requests.
--
-- Non-admins who can see the inventory can now ASK for a change instead of
-- making one. A request never touches the asset; only an admin approving it
-- does, and only through the two SECURITY DEFINER functions below.
--
-- Shape follows the module's existing conventions: explicit columns rather
-- than JSONB (the proposed values are the same four fields the Edit form
-- already has), a status CHECK rather than an enum, and authorization in the
-- body of a definer function rather than an UPDATE policy — the same pattern
-- as accept_employee_asset (20260722000000) and the Order Request RPCs
-- (20260708000000).
--
-- Deliberately NOT built: comments, multi-step approval, notifications,
-- cancellation, or any general-purpose approval framework. One table, two
-- functions.

-- ─── 1. asset_change_requests ──────────────────────────────────────────────
--
-- asset_id is nullable with ON DELETE SET NULL, which departs from the
-- obvious `not null references assets(id)`. It has to: an approved REMOVAL
-- deletes the asset, and the approval record must survive that. CASCADE would
-- silently destroy the very record that documents the decision, and RESTRICT
-- would make an approved removal impossible. asset_name_snapshot keeps the
-- history readable once the asset itself is gone.

CREATE TABLE public.asset_change_requests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  asset_id     uuid        REFERENCES public.assets(id) ON DELETE SET NULL,
  -- Captured at request time so a reviewed request still reads sensibly
  -- after the asset has been removed.
  asset_name_snapshot text NOT NULL,

  request_type text        NOT NULL CHECK (request_type IN ('edit', 'remove')),

  -- Defaulted from the session and pinned by the INSERT policy's WITH CHECK,
  -- so a client cannot file a request in someone else's name.
  requested_by uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(id),
  reason       text        NOT NULL CHECK (btrim(reason) <> ''),

  -- Proposed values for an edit. NULL means "leave this field alone".
  proposed_asset_type     text,
  proposed_asset_name     text,
  proposed_serial_no      text,
  proposed_specifications text,

  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected')),

  reviewed_by  uuid        REFERENCES public.users(id),
  reviewed_at  timestamptz,
  review_note  text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- A removal request carries no proposed values; an edit request must
  -- propose at least one, or there is nothing to approve.
  CONSTRAINT asset_change_requests_payload_matches_type CHECK (
    CASE request_type
      WHEN 'remove' THEN
        proposed_asset_type IS NULL AND proposed_asset_name IS NULL
        AND proposed_serial_no IS NULL AND proposed_specifications IS NULL
      WHEN 'edit' THEN
        proposed_asset_type IS NOT NULL OR proposed_asset_name IS NOT NULL
        OR proposed_serial_no IS NOT NULL OR proposed_specifications IS NOT NULL
    END
  ),

  -- A decision always records who made it and when.
  CONSTRAINT asset_change_requests_review_fields_complete CHECK (
    (status = 'pending'  AND reviewed_by IS NULL     AND reviewed_at IS NULL)
    OR
    (status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX asset_change_requests_asset_id_idx     ON public.asset_change_requests (asset_id);
CREATE INDEX asset_change_requests_requested_by_idx ON public.asset_change_requests (requested_by);
CREATE INDEX asset_change_requests_status_idx       ON public.asset_change_requests (status);
CREATE INDEX asset_change_requests_created_at_idx   ON public.asset_change_requests (created_at DESC);

-- One open request of each type per asset per person. Partial, so a rejected
-- or approved request never blocks a later one.
CREATE UNIQUE INDEX asset_change_requests_one_pending_per_asset_idx
  ON public.asset_change_requests (asset_id, requested_by, request_type)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS asset_change_requests_set_updated_at ON public.asset_change_requests;
CREATE TRIGGER asset_change_requests_set_updated_at
  BEFORE UPDATE ON public.asset_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 2. RLS ────────────────────────────────────────────────────────────────
--
-- There is NO update policy and NO delete policy, for anyone including the
-- admin. That is the point: a client cannot move a request from pending to
-- approved, cannot write reviewed_by/reviewed_at, and cannot erase a
-- decision. Review happens only through the definer functions in section 3.

ALTER TABLE public.asset_change_requests ENABLE ROW LEVEL SECURITY;

-- File a request as yourself, in the pending state, with no review fields.
CREATE POLICY "asset_change_requests_insert_own" ON public.asset_change_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
    AND status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_note IS NULL
    AND EXISTS (
      SELECT 1 FROM public.users
       WHERE users.id = auth.uid()
         AND users.is_active
         AND (users.role = 'admin' OR public.resolve_permission(auth.uid(), 'assets_access', 'view'))
    )
  );

-- Read your own; an admin reads all.
CREATE POLICY "asset_change_requests_select" ON public.asset_change_requests
  FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

-- ─── 3. Review functions ───────────────────────────────────────────────────

-- Shared guard: the caller must be a signed-in, active admin.
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

  IF NOT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = v_uid AND is_active AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'ASSET_REQUEST_FORBIDDEN: Only an administrator can approve this request'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_asset_request_reviewer() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assert_asset_request_reviewer() TO authenticated;

-- Approve: apply the change and record the decision in one statement, so the
-- asset can never move without the request moving with it.
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
  -- FOR UPDATE: two admins clicking Approve at once serialise here, and the
  -- second one finds the row already reviewed.
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

  IF v_req.asset_id IS NULL THEN
    RAISE EXCEPTION 'ASSET_REQUEST_ORPHANED: The asset this request refers to no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.request_type = 'edit' THEN
    -- Only the proposed fields move. A NULL proposal leaves the current
    -- value alone, which also means this door cannot blank a field.
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

  ELSE
    -- Removal. The custody-history rule is checked here so the admin gets a
    -- sentence they can act on; assets_prevent_assigned_delete
    -- (20260722000000) is still the guarantee and fires either way.
    IF EXISTS (SELECT 1 FROM public.employee_assets WHERE asset_id = v_req.asset_id) THEN
      RAISE EXCEPTION
        'ASSET_DELETE_BLOCKED: "%" has assignment history and cannot be removed', v_req.asset_name_snapshot
        USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.assets WHERE id = v_req.asset_id;
  END IF;

  -- Reached only when the change above succeeded. A blocked removal has
  -- already raised, so no request is ever marked approved without its effect.
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

REVOKE EXECUTE ON FUNCTION public.approve_asset_change_request(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.approve_asset_change_request(uuid, text) TO authenticated;

-- Reject: the asset is untouched; only the request moves.
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

  UPDATE public.asset_change_requests
     SET status      = 'rejected',
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = p_review_note
   WHERE id = p_request_id
  RETURNING * INTO v_req;

  RETURN v_req;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reject_asset_change_request(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.reject_asset_change_request(uuid, text) TO authenticated;
