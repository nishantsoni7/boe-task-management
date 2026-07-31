-- Assets & Access — permanent, append-only asset activity log.
--
-- One ledger per asset, covering its whole life: creation, master-detail
-- edits, custody movements, and change-request decisions. It is the backing
-- store for the asset detail page's timeline and, more importantly, the record
-- that makes an asset's history answerable after the fact.
--
-- Three properties, in the order they matter:
--
--   1. Nothing writes here from a client. There is no INSERT, UPDATE or DELETE
--      policy for any role including admin. Every row is written by a
--      SECURITY DEFINER function or trigger, in the same transaction as the
--      thing it describes, so a failed action leaves no trace of a success.
--   2. Nothing rewrites history. A guard trigger refuses UPDATE and DELETE
--      outright, binding the service role and direct SQL as well as PostgREST.
--   3. History outlives the asset. See the asset_id note below.
--
-- ─── Why asset_id is nullable, against the obvious design ──────────────────
--
-- The natural shape is `asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE
-- RESTRICT`. It cannot be used here, and the reason is worth stating plainly:
-- every asset gets an asset_created row the moment it exists, so RESTRICT
-- would make EVERY asset permanently undeletable. That would silently break
-- two shipped behaviours — the admin's ability to remove a mistaken inventory
-- entry (20260722000000 §3 deliberately allows exactly that, for an asset
-- nobody has ever held), and approved removal requests (20260724000000), which
-- would begin failing at the foreign key.
--
-- CASCADE is not an option either: it destroys the very record this table
-- exists to keep.
--
-- So asset_id is nullable with ON DELETE SET NULL, and the code and name are
-- snapshotted at write time. An approved removal leaves the asset's whole
-- history intact and readable; only the pointer to a row that no longer exists
-- is cleared. This is the same trade-off, for the same reason, that
-- asset_change_requests.asset_id already makes (20260724000000 §1).
--
-- Deletion protection itself is UNCHANGED by this migration: an asset with any
-- assignment history still cannot be deleted, by policy and by trigger.
--
-- ─── Event vocabulary ──────────────────────────────────────────────────────
--
-- event_type is plain text with no CHECK constraint, following
-- order_activity_log (20260656): later phases add repair, warranty and
-- document events, and none of them should need a migration to extend a list.
-- The vocabulary is closed in practice because only the functions below write.
--
--   asset_created              an asset row was inserted
--   asset_edited              master details changed (never status)
--   asset_assigned            custody opened          (assign_asset)
--   assignment_accepted       the employee accepted   (accept_employee_asset)
--   asset_returned            custody closed normally (return_asset)
--   asset_marked_lost         written off             (mark_asset_lost)
--   edit_requested            a non-admin asked for an edit
--   removal_requested         a non-admin asked for a removal
--   edit_request_approved     an admin approved an edit request
--   edit_request_rejected     an admin rejected an edit request
--   removal_request_approved  an admin approved a removal
--   removal_request_rejected  an admin rejected a removal
--
-- ─── event_at vs created_at ────────────────────────────────────────────────
--
-- event_at is now() — transaction time, the business instant of the event.
-- created_at is clock_timestamp() — the physical write instant, which unlike
-- now() advances WITHIN a transaction. An approved edit request writes two
-- rows (the approval and the resulting asset_edited) at the same event_at, so
-- created_at is what keeps them in the order they actually happened. The
-- timeline orders by event_at DESC, created_at DESC for exactly that reason.

-- ─── 1. Table ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.asset_activity_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable by necessity, not by preference — see the header.
  asset_id    uuid        REFERENCES public.assets(id) ON DELETE SET NULL,
  -- Captured at write time so the history still reads sensibly once the asset
  -- itself is gone.
  asset_code_snapshot text NOT NULL,
  asset_name_snapshot text NOT NULL,

  event_type  text        NOT NULL,

  -- Who performed the action. NULL for anything the database did on its own,
  -- or once that user record is removed.
  actor_id    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  -- The employee the event is ABOUT (custodian, requester), when different
  -- from the actor.
  employee_id uuid        REFERENCES public.users(id) ON DELETE SET NULL,

  event_at    timestamptz NOT NULL DEFAULT now(),

  -- A readable sentence written at event time, so the timeline does not depend
  -- on the client knowing every event_type ever used.
  summary     text        NOT NULL,
  details     jsonb,

  -- What triggered this, when it was not a direct action: e.g.
  -- ('asset_change_request', <request id>) on the edit an approval applied.
  source_type text,
  source_id   uuid,

  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The timeline query: one asset, newest first.
CREATE INDEX IF NOT EXISTS asset_activity_log_asset_id_idx
  ON public.asset_activity_log (asset_id, event_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS asset_activity_log_event_at_idx
  ON public.asset_activity_log (event_at DESC);

-- ─── 2. RLS: read-only, and only for the inventory audience ────────────────
--
-- SELECT mirrors the assets_select rule (20260723000000 §4) minus its
-- own-assignment branch: the timeline is an inventory tool, and My Assets does
-- not show one. There is deliberately no INSERT, UPDATE or DELETE policy for
-- anybody — the definer functions below are the only writers, and they run as
-- the table owner.

ALTER TABLE public.asset_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "asset_activity_log_select" ON public.asset_activity_log;

CREATE POLICY "asset_activity_log_select" ON public.asset_activity_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
       WHERE users.id = auth.uid()
         AND users.is_active
         AND (users.role = 'admin'
              OR public.resolve_permission(auth.uid(), 'assets_access', 'view'))
    )
  );

-- ─── 3. Append-only guard ──────────────────────────────────────────────────
--
-- The one permitted UPDATE is the foreign key's own ON DELETE SET NULL, which
-- Postgres performs as an ordinary UPDATE and which this trigger therefore
-- sees. It is recognised precisely: asset_id moving from a value to NULL with
-- every other column byte-identical. Anything else — including an admin, the
-- service role, or a psql session — is refused.

CREATE OR REPLACE FUNCTION public.prevent_asset_activity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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

DROP TRIGGER IF EXISTS asset_activity_log_immutable ON public.asset_activity_log;

CREATE TRIGGER asset_activity_log_immutable
  BEFORE UPDATE OR DELETE ON public.asset_activity_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_asset_activity_mutation();

-- ─── 4. Writers ────────────────────────────────────────────────────────────

-- users is RLS-protected, so a name lookup inside a trigger needs the owner's
-- privileges. Returns NULL for an unknown id rather than raising — a missing
-- display name must never fail the action being logged.
CREATE OR REPLACE FUNCTION public.asset_user_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT full_name FROM public.users WHERE id = p_user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.asset_user_display_name(uuid) FROM public, anon, authenticated;

-- The single entry point for writing history. Snapshots the asset's code and
-- name, and picks up the optional source set by set_asset_activity_source().
--
-- Not granted to any client role: it is called from other SECURITY DEFINER
-- functions and from triggers, both of which run as this function's owner.
CREATE OR REPLACE FUNCTION public.log_asset_activity(
  p_asset_id    uuid,
  p_event_type  text,
  p_summary     text,
  p_actor_id    uuid    DEFAULT NULL,
  p_employee_id uuid    DEFAULT NULL,
  p_details     jsonb   DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_name text;
  v_id   uuid;
  v_source_type text := nullif(current_setting('boe.asset_activity_source_type', true), '');
  v_source_id   text := nullif(current_setting('boe.asset_activity_source_id',   true), '');
BEGIN
  SELECT asset_code, asset_name INTO v_code, v_name
  FROM public.assets WHERE id = p_asset_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_ACTIVITY_ORPHANED: cannot log % for an asset that does not exist', p_event_type
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.asset_activity_log (
    asset_id, asset_code_snapshot, asset_name_snapshot,
    event_type, actor_id, employee_id, summary, details,
    source_type, source_id
  )
  VALUES (
    p_asset_id, v_code, v_name,
    p_event_type, p_actor_id, p_employee_id, p_summary, p_details,
    v_source_type, v_source_id::uuid
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_activity(uuid, text, text, uuid, uuid, jsonb) FROM public, anon, authenticated;

-- Transaction-local provenance. The asset_edited trigger cannot know that the
-- UPDATE it is observing came from an approved change request, so the approval
-- function announces it here for the rest of the transaction (is_local = true,
-- so it resets at COMMIT and never leaks into the next statement on a pooled
-- connection).
CREATE OR REPLACE FUNCTION public.set_asset_activity_source(
  p_source_type text,
  p_source_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('boe.asset_activity_source_type', coalesce(p_source_type, ''), true);
  PERFORM set_config('boe.asset_activity_source_id',   coalesce(p_source_id::text, ''), true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_asset_activity_source(text, uuid) FROM public, anon, authenticated;

-- ─── 5. Creation and edits, logged by trigger ──────────────────────────────
--
-- Triggers rather than a create_asset()/update_asset() RPC pair, deliberately:
-- assets_insert and assets_update (20260721000000 / 20260723000000) still
-- allow a direct PostgREST write for whoever holds 'create' / 'edit', so an
-- RPC would only log the calls that chose to use it. A trigger logs every
-- path — the existing UI, the approval RPC's own UPDATE, and direct SQL —
-- without changing a single permission.

CREATE OR REPLACE FUNCTION public.log_asset_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_asset_activity(
    new.id,
    'asset_created',
    'Asset created',
    auth.uid(),
    NULL,
    jsonb_build_object(
      'asset_code',     new.asset_code,
      'asset_name',     new.asset_name,
      'asset_type',     new.asset_type,
      'serial_no',      new.serial_no,
      'specifications', new.specifications,
      'location',       new.location,
      'status',         new.status,
      'actor_name',     public.asset_user_display_name(auth.uid())
    )
  );
  RETURN NULL;  -- AFTER trigger; return value is ignored
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_created() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS assets_log_created ON public.assets;

CREATE TRIGGER assets_log_created
  AFTER INSERT ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.log_asset_created();

-- Master details only. status is excluded on purpose: every status movement is
-- already described by its own custody event, and logging it twice would make
-- the timeline read as if two things happened. asset_code cannot change
-- (20260726000000) and updated_at is not information.
--
-- No changed field means no row: a save that altered nothing is not an event.
CREATE OR REPLACE FUNCTION public.log_asset_edited()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changes jsonb  := '[]'::jsonb;
  v_labels  text[] := ARRAY[]::text[];
BEGIN
  IF new.asset_type IS DISTINCT FROM old.asset_type THEN
    v_changes := v_changes || jsonb_build_object('field', 'asset_type', 'label', 'Type',
                                                 'old', old.asset_type, 'new', new.asset_type);
    v_labels := v_labels || 'type';
  END IF;

  IF new.asset_name IS DISTINCT FROM old.asset_name THEN
    v_changes := v_changes || jsonb_build_object('field', 'asset_name', 'label', 'Name',
                                                 'old', old.asset_name, 'new', new.asset_name);
    v_labels := v_labels || 'name';
  END IF;

  IF new.serial_no IS DISTINCT FROM old.serial_no THEN
    v_changes := v_changes || jsonb_build_object('field', 'serial_no', 'label', 'Serial No.',
                                                 'old', old.serial_no, 'new', new.serial_no);
    v_labels := v_labels || 'serial number';
  END IF;

  IF new.specifications IS DISTINCT FROM old.specifications THEN
    v_changes := v_changes || jsonb_build_object('field', 'specifications', 'label', 'Specifications',
                                                 'old', old.specifications, 'new', new.specifications);
    v_labels := v_labels || 'specifications';
  END IF;

  IF new.location IS DISTINCT FROM old.location THEN
    v_changes := v_changes || jsonb_build_object('field', 'location', 'label', 'Location',
                                                 'old', old.location, 'new', new.location);
    v_labels := v_labels || 'location';
  END IF;

  IF jsonb_array_length(v_changes) = 0 THEN
    RETURN NULL;
  END IF;

  PERFORM public.log_asset_activity(
    new.id,
    'asset_edited',
    'Updated ' || array_to_string(v_labels, ', '),
    auth.uid(),
    NULL,
    jsonb_build_object(
      'changes',    v_changes,
      'actor_name', public.asset_user_display_name(auth.uid())
    )
  );
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_edited() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS assets_log_edited ON public.assets;

CREATE TRIGGER assets_log_edited
  AFTER UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.log_asset_edited();

-- ─── 6. Change requests: submission logged by trigger ──────────────────────
--
-- Submission is a plain client INSERT (asset_change_requests_insert_own), so
-- the same reasoning as section 5 applies: log it where it cannot be avoided.

CREATE OR REPLACE FUNCTION public.log_asset_change_requested()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := public.asset_user_display_name(new.requested_by);
BEGIN
  -- asset_id is nullable on that table; a request pointing at nothing has no
  -- asset timeline to appear on.
  IF new.asset_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF new.request_type = 'edit' THEN
    PERFORM public.log_asset_activity(
      new.asset_id, 'edit_requested',
      'Edit requested by ' || coalesce(v_name, 'an employee'),
      new.requested_by, new.requested_by,
      jsonb_build_object(
        'request_id',     new.id,
        'requester_name', v_name,
        'reason',         new.reason,
        'proposed',       jsonb_strip_nulls(jsonb_build_object(
          'asset_type',     new.proposed_asset_type,
          'asset_name',     new.proposed_asset_name,
          'serial_no',      new.proposed_serial_no,
          'specifications', new.proposed_specifications
        ))
      )
    );
  ELSE
    PERFORM public.log_asset_activity(
      new.asset_id, 'removal_requested',
      'Removal requested by ' || coalesce(v_name, 'an employee'),
      new.requested_by, new.requested_by,
      jsonb_build_object(
        'request_id',     new.id,
        'requester_name', v_name,
        'reason',         new.reason
      )
    );
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_asset_change_requested() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS asset_change_requests_log_submitted ON public.asset_change_requests;

CREATE TRIGGER asset_change_requests_log_submitted
  AFTER INSERT ON public.asset_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.log_asset_change_requested();

-- ─── 7. Custody functions ──────────────────────────────────────────────────
--
-- Each is replaced with its 20260725000000 body plus one activity write. The
-- authorization, locking, validation and state transitions are unchanged, and
-- the log write sits AFTER the guards, inside the same transaction — so a
-- refused action raises before reaching it and leaves nothing behind.

CREATE OR REPLACE FUNCTION public.assign_asset(
  p_asset_id    uuid,
  p_employee_id uuid
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := public.assert_asset_custody_permission(
                    'assign', 'You do not have permission to assign assets');
  v_asset public.assets;
  v_prev_status text;
  v_assignment  uuid;
  v_employee    text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_asset.status <> 'available' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not available to assign', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.employee_assets
     WHERE asset_id = p_asset_id AND status IN ('pending_acceptance', 'accepted')
  ) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already held by someone', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_employee_id AND is_active) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: That employee is not active'
      USING ERRCODE = '42501';
  END IF;

  v_prev_status := v_asset.status;

  INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
  VALUES (p_asset_id, p_employee_id, v_uid, 'pending_acceptance')
  RETURNING id INTO v_assignment;

  UPDATE public.assets SET status = 'assigned' WHERE id = p_asset_id
  RETURNING * INTO v_asset;

  v_employee := public.asset_user_display_name(p_employee_id);

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_assigned',
    'Assigned to ' || coalesce(v_employee, 'an employee'),
    v_uid, p_employee_id,
    jsonb_build_object(
      'assignment_id',   v_assignment,
      'employee_name',   v_employee,
      'actor_name',      public.asset_user_display_name(v_uid),
      'previous_status', v_prev_status,
      'new_status',      v_asset.status,
      'acceptance',      'pending_acceptance'
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL   ON FUNCTION public.assign_asset(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.assign_asset(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.return_asset(p_asset_id uuid)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := public.assert_asset_custody_permission(
                         'manage', 'You do not have permission to return assets');
  v_asset      public.assets;
  v_assignment uuid;
  v_holder     uuid;
  v_holder_name text;
  v_prev_status text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists'
      USING ERRCODE = '42501';
  END IF;

  -- employee_id is captured here, before the row is closed: after the UPDATE
  -- the assignment is history, and the timeline needs to name who held it.
  SELECT id, employee_id INTO v_assignment, v_holder
  FROM public.employee_assets
  WHERE asset_id = p_asset_id AND status IN ('pending_acceptance', 'accepted')
  FOR UPDATE;

  IF v_assignment IS NULL THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not currently assigned to anyone', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  v_prev_status := v_asset.status;

  UPDATE public.employee_assets
     SET status = 'returned', returned_at = now()
   WHERE id = v_assignment;

  UPDATE public.assets SET status = 'available' WHERE id = p_asset_id
  RETURNING * INTO v_asset;

  v_holder_name := public.asset_user_display_name(v_holder);

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_returned',
    'Returned by ' || coalesce(v_holder_name, 'the previous custodian'),
    v_uid, v_holder,
    jsonb_build_object(
      'assignment_id',   v_assignment,
      'employee_name',   v_holder_name,
      'actor_name',      public.asset_user_display_name(v_uid),
      'previous_status', v_prev_status,
      'new_status',      v_asset.status
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL   ON FUNCTION public.return_asset(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.return_asset(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_asset_lost(p_asset_id uuid)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := public.assert_asset_custody_permission(
                    'manage', 'You do not have permission to mark assets as lost');
  v_asset public.assets;
  v_holder uuid;
  v_holder_name text;
  v_prev_status text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_asset.status = 'lost' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already marked lost', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  -- NULL when the asset was sitting in a cupboard rather than with a person —
  -- an unassigned asset can be lost too, and the event records that honestly.
  SELECT employee_id INTO v_holder
  FROM public.employee_assets
  WHERE asset_id = p_asset_id AND status IN ('pending_acceptance', 'accepted')
  LIMIT 1;

  v_prev_status := v_asset.status;

  UPDATE public.employee_assets
     SET status = 'lost', lost_at = now()
   WHERE asset_id = p_asset_id
     AND status IN ('pending_acceptance', 'accepted');

  UPDATE public.assets SET status = 'lost' WHERE id = p_asset_id
  RETURNING * INTO v_asset;

  v_holder_name := public.asset_user_display_name(v_holder);

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_marked_lost',
    CASE WHEN v_holder_name IS NULL
         THEN 'Marked lost'
         ELSE 'Marked lost while held by ' || v_holder_name END,
    v_uid, v_holder,
    jsonb_build_object(
      'employee_name',   v_holder_name,
      'actor_name',      public.asset_user_display_name(v_uid),
      'previous_status', v_prev_status,
      'new_status',      v_asset.status
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL   ON FUNCTION public.mark_asset_lost(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mark_asset_lost(uuid) TO authenticated;

-- Acceptance. Body unchanged from 20260722000000 except for the log write,
-- which sits after the guarded UPDATE — a second Accept raises before it.
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

  IF NOT FOUND OR v_row.employee_id <> v_uid THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_DENIED: No pending assignment found for you'
      USING ERRCODE = '42501';
  END IF;

  IF v_row.status <> 'pending_acceptance' THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_INVALID: This assignment is already % and cannot be accepted', v_row.status
      USING ERRCODE = '42501';
  END IF;

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

  PERFORM public.log_asset_activity(
    v_row.asset_id, 'assignment_accepted',
    'Accepted by ' || coalesce(public.asset_user_display_name(v_uid), 'the custodian'),
    v_uid, v_uid,
    jsonb_build_object(
      'assignment_id', v_row.id,
      'employee_name', public.asset_user_display_name(v_uid),
      'actor_name',    public.asset_user_display_name(v_uid),
      'accepted_at',   v_row.accepted_at
    )
  );

  RETURN v_row;
END;
$$;

REVOKE ALL   ON FUNCTION public.accept_employee_asset(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.accept_employee_asset(uuid) TO authenticated;

-- ─── 8. Change-request decisions ───────────────────────────────────────────
--
-- Bodies are 20260724000000's, with three additions:
--   * the decision itself is logged;
--   * for an approved EDIT, set_asset_activity_source() marks the UPDATE that
--     follows, so the asset_edited row the trigger writes carries the request
--     id — approval and field differences, one transaction, two linked rows;
--   * for an approved REMOVAL the decision is logged BEFORE the DELETE, so it
--     is written while the asset still exists. The FK then clears asset_id and
--     the snapshots carry the record forward.

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

  IF v_req.asset_id IS NULL THEN
    RAISE EXCEPTION 'ASSET_REQUEST_ORPHANED: The asset this request refers to no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.request_type = 'edit' THEN
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

    -- Marks the asset_edited row the UPDATE below produces as this request's
    -- doing. Transaction-local; cleared again once the write is done.
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
    IF EXISTS (SELECT 1 FROM public.employee_assets WHERE asset_id = v_req.asset_id) THEN
      RAISE EXCEPTION
        'ASSET_DELETE_BLOCKED: "%" has assignment history and cannot be removed', v_req.asset_name_snapshot
        USING ERRCODE = '42501';
    END IF;

    -- Written while the asset still exists; the DELETE that follows only
    -- clears this row's asset_id (ON DELETE SET NULL), never the row.
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

  -- The asset is untouched, so this is the only trace the rejection leaves.
  -- An orphaned request (its asset already gone) has no timeline to write to.
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
