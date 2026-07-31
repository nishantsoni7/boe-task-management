-- Assets & Access — the complete custody, repair and document operations.
--
-- Every operation that moves an asset is ONE function, and each writes all of
-- its consequences inside one transaction:
--
--   employee_assets      who holds it now
--   assets               where it rests, which department, what condition
--   asset_transfers      the permanent movement record
--   asset_activity_log   the audit entry
--
-- That grouping is the point. A failure anywhere rolls the whole movement back,
-- so the four records can never disagree about what happened.
--
-- The three functions that already existed (assign_asset, return_asset,
-- mark_asset_lost) are REPLACED here with the same authorization, the same
-- guards, the same activity event types and the same details keys — plus the
-- optional handover fields the brief asks for and the asset_transfers row.
-- Their old two-argument signatures are dropped so PostgREST resolves exactly
-- one function per name.
--
-- Authorization, unchanged from 20260725000000:
--   assign  give an AVAILABLE asset to an employee
--   manage  take one back, move one between holders, write one off, recover
--           one, send it for service, bring it back, retire, dispose, restore
--   edit    record a historical service entry, change master/warranty details,
--           upload and remove documents  (via can_write_asset_records)
--   admin   correct a historical service record
--
-- 'manage' covers transfer deliberately: a transfer ENDS somebody's custody,
-- which is the same decision as taking the asset back — not the same as handing
-- out something nobody holds.
--
-- Notifications are NOT written here. They are raised by /api/assets/notify
-- after the transaction commits, so a failed notification can never roll back a
-- movement that physically happened — the rule Orders and Finance already follow.

-- ═══ 0. Shared internals ═══════════════════════════════════════════════════

-- The current custody period, or NULL when nobody holds the asset. Takes the
-- LATEST open row if more than one somehow exists: every function here closes
-- the previous period in the same transaction that opens the next, so that
-- should be impossible, but the most recent assignment is the truthful answer
-- and an arbitrary pick would be a coin toss.
CREATE OR REPLACE FUNCTION public.current_asset_custody(p_asset_id uuid)
RETURNS public.employee_assets
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT * FROM public.employee_assets
   WHERE asset_id = p_asset_id
     AND status IN ('pending_acceptance', 'accepted')
   ORDER BY assigned_at DESC
   LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.current_asset_custody(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.current_asset_custody(uuid) TO authenticated;

-- An employee's department, as recorded on their user row right now. Captured
-- onto the movement at the moment of the movement, so a later reorganisation
-- never rewrites which department held what, back then.
CREATE OR REPLACE FUNCTION public.asset_employee_department(p_employee_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT team FROM public.users WHERE id = p_employee_id;
$$;

REVOKE EXECUTE ON FUNCTION public.asset_employee_department(uuid) FROM public, anon, authenticated;

-- One place that writes a movement row, so every function records the same
-- shape and no caller can forget the actor's name snapshot.
CREATE OR REPLACE FUNCTION public.record_asset_transfer(
  p_asset_id         uuid,
  p_event_type       text,
  p_from_employee_id uuid    DEFAULT NULL,
  p_to_employee_id   uuid    DEFAULT NULL,
  p_from_location    text    DEFAULT NULL,
  p_to_location      text    DEFAULT NULL,
  p_from_department  text    DEFAULT NULL,
  p_to_department    text    DEFAULT NULL,
  p_effective_date   date    DEFAULT NULL,
  p_condition        text    DEFAULT NULL,
  p_remarks          text    DEFAULT NULL,
  p_performed_by     uuid    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := COALESCE(p_performed_by, auth.uid());
  v_id    uuid;
BEGIN
  INSERT INTO public.asset_transfers (
    asset_id, event_type,
    from_employee_id, to_employee_id, from_location, to_location,
    from_department, to_department,
    effective_date, condition, remarks,
    from_employee_name, to_employee_name,
    performed_by, performed_by_name
  ) VALUES (
    p_asset_id, p_event_type,
    p_from_employee_id, p_to_employee_id,
    NULLIF(btrim(COALESCE(p_from_location, '')), ''),
    NULLIF(btrim(COALESCE(p_to_location,   '')), ''),
    NULLIF(btrim(COALESCE(p_from_department, '')), ''),
    NULLIF(btrim(COALESCE(p_to_department,   '')), ''),
    p_effective_date,
    NULLIF(btrim(COALESCE(p_condition, '')), ''),
    NULLIF(btrim(COALESCE(p_remarks,   '')), ''),
    public.asset_user_display_name(p_from_employee_id),
    public.asset_user_display_name(p_to_employee_id),
    v_actor, public.asset_user_display_name(v_actor)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_asset_transfer(uuid, text, uuid, uuid, text, text, text, text, date, text, text, uuid)
  FROM public, anon, authenticated;

-- Statuses from which an asset can no longer move under its own workflow.
CREATE OR REPLACE FUNCTION public.assert_asset_movable(p_asset public.assets)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_asset.status = 'lost' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is marked lost. Record a recovery before moving it', p_asset.asset_name
      USING ERRCODE = '42501';
  END IF;
  IF p_asset.status IN ('retired', 'disposed') THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" has been % and can no longer be moved', p_asset.asset_name, p_asset.status
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ═══ 1. assign_asset ═══════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.assign_asset(uuid, uuid);

CREATE OR REPLACE FUNCTION public.assign_asset(
  p_asset_id       uuid,
  p_employee_id    uuid,
  p_effective_date date DEFAULT NULL,
  p_condition      text DEFAULT NULL,
  p_remarks        text DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := public.assert_asset_custody_permission(
                          'assign', 'You do not have permission to assign assets');
  v_asset       public.assets;
  v_prev_status text;
  v_prev_loc    text;
  v_assignment  uuid;
  v_employee    text;
  v_dept        text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  IF v_asset.status <> 'available' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not available to assign', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF public.current_asset_custody(p_asset_id) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already held by someone', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_employee_id AND is_active) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: That employee is not active' USING ERRCODE = '42501';
  END IF;

  v_prev_status := v_asset.status;
  v_prev_loc    := v_asset.location;
  v_dept        := public.asset_employee_department(p_employee_id);

  INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
  VALUES (p_asset_id, p_employee_id, v_uid, 'pending_acceptance')
  RETURNING id INTO v_assignment;

  -- The edit trigger is suppressed for this UPDATE: the asset moving to a
  -- person is described by the custody event below, and a second "Updated
  -- location, department" entry beside it would read as two things happening.
  PERFORM public.set_asset_edit_logging(false);
  UPDATE public.assets
     SET status     = 'assigned',
         location   = NULL,
         department = v_dept
   WHERE id = p_asset_id
  RETURNING * INTO v_asset;
  PERFORM public.set_asset_edit_logging(true);

  v_employee := public.asset_user_display_name(p_employee_id);

  PERFORM public.record_asset_transfer(
    p_asset_id, 'assigned',
    NULL, p_employee_id,
    v_prev_loc, NULL,
    NULL, v_dept,
    p_effective_date, p_condition, p_remarks, v_uid
  );

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
      'acceptance',      'pending_acceptance',
      'department',      v_dept,
      'effective_date',  p_effective_date,
      'condition',       NULLIF(btrim(COALESCE(p_condition, '')), ''),
      'remarks',         NULLIF(btrim(COALESCE(p_remarks, '')), '')
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL     ON FUNCTION public.assign_asset(uuid, uuid, date, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assign_asset(uuid, uuid, date, text, text) TO authenticated;

-- ═══ 2. transfer_asset ═════════════════════════════════════════════════════
--
-- Covers all four directions the module needs: employee → employee,
-- employee → location, location → employee, location → location.
--
-- The outgoing custody period is CLOSED as 'returned' rather than deleted or
-- rewritten. That row is the permanent record that the previous holder had it,
-- and 20260722000000 exists precisely to stop such rows from disappearing.

CREATE OR REPLACE FUNCTION public.transfer_asset(
  p_asset_id       uuid,
  p_to_employee_id uuid DEFAULT NULL,
  p_to_location    text DEFAULT NULL,
  p_effective_date date DEFAULT NULL,
  p_condition      text DEFAULT NULL,
  p_remarks        text DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := public.assert_asset_custody_permission(
                        'manage', 'You do not have permission to transfer assets');
  v_asset     public.assets;
  v_custody   public.employee_assets;
  v_to_loc    text := NULLIF(btrim(COALESCE(p_to_location, '')), '');
  v_from_loc  text;
  v_from_dept text;
  v_to_dept   text;
  v_from_name text;
  v_to_name   text;
  v_prev_status text;
BEGIN
  IF (p_to_employee_id IS NULL) = (v_to_loc IS NULL) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: Choose either an employee or a company location to transfer to, not both'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_asset_movable(v_asset);

  IF v_asset.status = 'under_repair' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is away for service. Close the service record before transferring it', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  -- Captured BEFORE the update, so the movement records where the asset came
  -- from rather than where it ended up.
  v_prev_status := v_asset.status;
  v_from_loc    := v_asset.location;
  v_from_dept   := v_asset.department;

  SELECT * INTO v_custody FROM public.employee_assets
   WHERE asset_id = p_asset_id AND status IN ('pending_acceptance', 'accepted')
   FOR UPDATE;

  IF FOUND THEN
    IF v_custody.employee_id = p_to_employee_id THEN
      RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already held by that employee', v_asset.asset_name
        USING ERRCODE = '42501';
    END IF;
    v_from_name := public.asset_user_display_name(v_custody.employee_id);
    UPDATE public.employee_assets
       SET status = 'returned', returned_at = now()
     WHERE id = v_custody.id;
  END IF;

  PERFORM public.set_asset_edit_logging(false);

  IF p_to_employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_to_employee_id AND is_active) THEN
      RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: That employee is not active' USING ERRCODE = '42501';
    END IF;

    v_to_dept := public.asset_employee_department(p_to_employee_id);
    v_to_name := public.asset_user_display_name(p_to_employee_id);

    INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
    VALUES (p_asset_id, p_to_employee_id, v_uid, 'pending_acceptance');

    UPDATE public.assets
       SET status = 'assigned', location = NULL, department = v_to_dept
     WHERE id = p_asset_id
    RETURNING * INTO v_asset;
  ELSE
    -- Handed back to the company: it rests at a named place and is available
    -- for the next person.
    UPDATE public.assets
       SET status = 'available', location = v_to_loc, department = NULL
     WHERE id = p_asset_id
    RETURNING * INTO v_asset;
  END IF;

  PERFORM public.set_asset_edit_logging(true);

  PERFORM public.record_asset_transfer(
    p_asset_id, 'transferred',
    v_custody.employee_id, p_to_employee_id,
    -- Only a location the asset genuinely came FROM. An asset held by a person
    -- has no from_location, and recording one would invent a place.
    CASE WHEN v_custody.employee_id IS NULL THEN v_from_loc ELSE NULL END,
    v_to_loc,
    v_from_dept, v_to_dept,
    p_effective_date, p_condition, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_transferred',
    'Transferred from ' || coalesce(v_from_name, v_from_loc, 'the company')
                        || ' to ' || coalesce(v_to_name, v_to_loc, 'the company'),
    v_uid, p_to_employee_id,
    jsonb_build_object(
      'from_employee_name', v_from_name,
      'to_employee_name',   v_to_name,
      'from_location',      CASE WHEN v_custody.employee_id IS NULL THEN v_from_loc ELSE NULL END,
      'to_location',        v_to_loc,
      'from_department',    v_from_dept,
      'to_department',      v_to_dept,
      'previous_status',    v_prev_status,
      'new_status',         v_asset.status,
      'effective_date',     p_effective_date,
      'condition',          NULLIF(btrim(COALESCE(p_condition, '')), ''),
      'remarks',            NULLIF(btrim(COALESCE(p_remarks, '')), ''),
      'actor_name',         public.asset_user_display_name(v_uid)
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL     ON FUNCTION public.transfer_asset(uuid, uuid, text, date, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.transfer_asset(uuid, uuid, text, date, text, text) TO authenticated;

-- ═══ 3. return_asset ═══════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.return_asset(uuid);

CREATE OR REPLACE FUNCTION public.return_asset(
  p_asset_id       uuid,
  p_condition      text DEFAULT NULL,
  p_remarks        text DEFAULT NULL,
  p_location       text DEFAULT NULL,
  p_effective_date date DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := public.assert_asset_custody_permission(
                          'manage', 'You do not have permission to return assets');
  v_asset       public.assets;
  v_custody     public.employee_assets;
  v_holder_name text;
  v_prev_status text;
  v_prev_dept   text;
  v_loc         text := NULLIF(btrim(COALESCE(p_location, '')), '');
  v_cond        text := NULLIF(btrim(COALESCE(p_condition, '')), '');
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_custody FROM public.employee_assets
   WHERE asset_id = p_asset_id AND status IN ('pending_acceptance', 'accepted')
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not currently assigned to anyone', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  v_prev_status := v_asset.status;
  v_prev_dept   := v_asset.department;
  v_holder_name := public.asset_user_display_name(v_custody.employee_id);

  UPDATE public.employee_assets
     SET status = 'returned', returned_at = now()
   WHERE id = v_custody.id;

  PERFORM public.set_asset_edit_logging(false);
  UPDATE public.assets
     SET status     = 'available',
         location   = COALESCE(v_loc, location),
         department = NULL,
         condition  = COALESCE(v_cond, condition)
   WHERE id = p_asset_id
  RETURNING * INTO v_asset;
  PERFORM public.set_asset_edit_logging(true);

  PERFORM public.record_asset_transfer(
    p_asset_id, 'returned',
    v_custody.employee_id, NULL,
    NULL, v_loc,
    v_prev_dept, NULL,
    p_effective_date, v_cond, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_returned',
    'Returned by ' || coalesce(v_holder_name, 'the previous custodian'),
    v_uid, v_custody.employee_id,
    jsonb_build_object(
      'assignment_id',   v_custody.id,
      'employee_name',   v_holder_name,
      'actor_name',      public.asset_user_display_name(v_uid),
      'previous_status', v_prev_status,
      'new_status',      v_asset.status,
      'to_location',     v_loc,
      'condition',       v_cond,
      'effective_date',  p_effective_date,
      'remarks',         NULLIF(btrim(COALESCE(p_remarks, '')), '')
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL     ON FUNCTION public.return_asset(uuid, text, text, text, date) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.return_asset(uuid, text, text, text, date) TO authenticated;

-- ═══ 4. mark_asset_lost / recover_lost_asset ═══════════════════════════════

DROP FUNCTION IF EXISTS public.mark_asset_lost(uuid);

CREATE OR REPLACE FUNCTION public.mark_asset_lost(
  p_asset_id uuid,
  p_remarks  text DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := public.assert_asset_custody_permission(
                          'manage', 'You do not have permission to mark assets as lost');
  v_asset       public.assets;
  v_custody     public.employee_assets;
  v_holder_name text;
  v_prev_status text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  IF v_asset.status = 'lost' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already marked lost', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF v_asset.status IN ('retired', 'disposed') THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" has been % and can no longer be marked lost', v_asset.asset_name, v_asset.status
      USING ERRCODE = '42501';
  END IF;

  v_prev_status := v_asset.status;

  SELECT * INTO v_custody FROM public.employee_assets
   WHERE asset_id = p_asset_id AND status IN ('pending_acceptance', 'accepted')
   FOR UPDATE;

  IF FOUND THEN
    v_holder_name := public.asset_user_display_name(v_custody.employee_id);
    UPDATE public.employee_assets
       SET status = 'lost', lost_at = now()
     WHERE id = v_custody.id;
  END IF;

  PERFORM public.set_asset_edit_logging(false);
  UPDATE public.assets SET status = 'lost' WHERE id = p_asset_id
  RETURNING * INTO v_asset;
  PERFORM public.set_asset_edit_logging(true);

  PERFORM public.record_asset_transfer(
    p_asset_id, 'marked_lost',
    v_custody.employee_id, NULL,
    CASE WHEN v_custody.employee_id IS NULL THEN v_asset.location ELSE NULL END, NULL,
    v_asset.department, NULL,
    NULL, NULL, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_marked_lost',
    CASE WHEN v_holder_name IS NULL
         THEN 'Marked lost'
         ELSE 'Marked lost while held by ' || v_holder_name END,
    v_uid, v_custody.employee_id,
    jsonb_build_object(
      'assignment_id',   v_custody.id,
      'employee_name',   v_holder_name,
      'actor_name',      public.asset_user_display_name(v_uid),
      'previous_status', v_prev_status,
      'new_status',      'lost',
      'remarks',         NULLIF(btrim(COALESCE(p_remarks, '')), '')
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL     ON FUNCTION public.mark_asset_lost(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.mark_asset_lost(uuid, text) TO authenticated;

-- A lost asset that turns up. It comes back either to a person — a fresh
-- custody period, which must still be accepted — or to a company location.
CREATE OR REPLACE FUNCTION public.recover_lost_asset(
  p_asset_id       uuid,
  p_to_employee_id uuid DEFAULT NULL,
  p_to_location    text DEFAULT NULL,
  p_condition      text DEFAULT NULL,
  p_remarks        text DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := public.assert_asset_custody_permission(
                      'manage', 'You do not have permission to recover lost assets');
  v_asset   public.assets;
  v_to_loc  text := NULLIF(btrim(COALESCE(p_to_location, '')), '');
  v_cond    text := NULLIF(btrim(COALESCE(p_condition, '')), '');
  v_to_name text;
  v_to_dept text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  IF v_asset.status <> 'lost' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not marked lost, so there is nothing to recover', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.set_asset_edit_logging(false);

  IF p_to_employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_to_employee_id AND is_active) THEN
      RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: That employee is not active' USING ERRCODE = '42501';
    END IF;

    v_to_dept := public.asset_employee_department(p_to_employee_id);
    v_to_name := public.asset_user_display_name(p_to_employee_id);

    INSERT INTO public.employee_assets (asset_id, employee_id, assigned_by, status)
    VALUES (p_asset_id, p_to_employee_id, v_uid, 'pending_acceptance');

    UPDATE public.assets
       SET status = 'assigned', location = NULL,
           department = v_to_dept, condition = COALESCE(v_cond, condition)
     WHERE id = p_asset_id
    RETURNING * INTO v_asset;
  ELSE
    UPDATE public.assets
       SET status = 'available',
           location = COALESCE(v_to_loc, location),
           department = NULL,
           condition = COALESCE(v_cond, condition)
     WHERE id = p_asset_id
    RETURNING * INTO v_asset;
  END IF;

  PERFORM public.set_asset_edit_logging(true);

  PERFORM public.record_asset_transfer(
    p_asset_id, 'recovered',
    NULL, p_to_employee_id,
    NULL, v_to_loc,
    NULL, v_to_dept,
    NULL, v_cond, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_recovered',
    'Recovered to ' || coalesce(v_to_name, v_to_loc, 'the company'),
    v_uid, p_to_employee_id,
    jsonb_build_object(
      'to_employee_name', v_to_name,
      'to_location',      v_to_loc,
      'previous_status',  'lost',
      'new_status',       v_asset.status,
      'condition',        v_cond,
      'remarks',          NULLIF(btrim(COALESCE(p_remarks, '')), ''),
      'actor_name',       public.asset_user_display_name(v_uid)
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL     ON FUNCTION public.recover_lost_asset(uuid, uuid, text, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.recover_lost_asset(uuid, uuid, text, text, text) TO authenticated;

-- ═══ 5. Repair round-trip ══════════════════════════════════════════════════
--
-- Custody is deliberately NOT ended when an asset goes for service. The person
-- it is charged to is still accountable for it while a vendor has it; the
-- asset's own status says where it physically is. That is why send/return for
-- repair writes movement rows but never touches employee_assets.

CREATE OR REPLACE FUNCTION public.send_asset_for_repair(
  p_asset_id     uuid,
  p_service_type text DEFAULT 'repair',
  p_issue        text DEFAULT NULL,
  p_description  text DEFAULT NULL,
  p_vendor       text DEFAULT NULL,
  p_sent_date    date DEFAULT NULL,
  p_remarks      text DEFAULT NULL
)
RETURNS public.asset_service_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := public.assert_asset_custody_permission(
                       'manage', 'You do not have permission to send assets for repair');
  v_asset    public.assets;
  v_record   public.asset_service_records;
  v_custody  public.employee_assets;
  v_vendor   text := NULLIF(btrim(COALESCE(p_vendor, '')), '');
  v_sent     date := COALESCE(p_sent_date, current_date);
  v_prev     text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_asset_movable(v_asset);

  IF v_asset.status = 'under_repair' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already away for service', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  v_prev    := v_asset.status;
  v_custody := public.current_asset_custody(p_asset_id);

  INSERT INTO public.asset_service_records (
    asset_id, service_type, issue, description, vendor, sent_date,
    remarks, status, recorded_by
  ) VALUES (
    p_asset_id, p_service_type,
    NULLIF(btrim(COALESCE(p_issue, '')), ''),
    NULLIF(btrim(COALESCE(p_description, '')), ''),
    v_vendor, v_sent,
    NULLIF(btrim(COALESCE(p_remarks, '')), ''),
    'in_progress', v_uid
  )
  RETURNING * INTO v_record;

  PERFORM public.set_asset_edit_logging(false);
  UPDATE public.assets SET status = 'under_repair' WHERE id = p_asset_id;
  PERFORM public.set_asset_edit_logging(true);

  PERFORM public.record_asset_transfer(
    p_asset_id, 'sent_for_repair',
    v_custody.employee_id, NULL,
    CASE WHEN v_custody.employee_id IS NULL THEN v_asset.location ELSE NULL END,
    v_vendor,
    v_asset.department, NULL,
    v_sent, NULL, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_sent_for_repair',
    CASE WHEN v_vendor IS NULL
         THEN 'Sent for service'
         ELSE 'Sent for service to ' || v_vendor END,
    v_uid, v_custody.employee_id,
    jsonb_build_object(
      'service_record_id', v_record.id,
      'service_type',      p_service_type,
      'vendor',            v_vendor,
      'issue',             NULLIF(btrim(COALESCE(p_issue, '')), ''),
      'sent_date',         v_sent,
      'previous_status',   v_prev,
      'new_status',        'under_repair',
      'actor_name',        public.asset_user_display_name(v_uid)
    )
  );

  RETURN v_record;
END;
$$;

REVOKE ALL     ON FUNCTION public.send_asset_for_repair(uuid, text, text, text, text, date, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.send_asset_for_repair(uuid, text, text, text, text, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_asset_service(
  p_service_id        uuid,
  p_returned_date     date    DEFAULT NULL,
  p_cost              numeric DEFAULT NULL,
  p_condition_after   text    DEFAULT NULL,
  p_remarks           text    DEFAULT NULL,
  p_next_service_date date    DEFAULT NULL
)
RETURNS public.asset_service_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := public.assert_asset_custody_permission(
                      'manage', 'You do not have permission to close a service record');
  v_record  public.asset_service_records;
  v_asset   public.assets;
  v_custody public.employee_assets;
  v_cond    text := NULLIF(btrim(COALESCE(p_condition_after, '')), '');
  v_next    text;
BEGIN
  SELECT * INTO v_record FROM public.asset_service_records WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_SERVICE_MISSING: This service record no longer exists' USING ERRCODE = '42501';
  END IF;

  IF v_record.status <> 'in_progress' THEN
    RAISE EXCEPTION 'ASSET_SERVICE_INVALID: This service record is already closed' USING ERRCODE = '42501';
  END IF;

  IF p_cost IS NOT NULL AND p_cost < 0 THEN
    RAISE EXCEPTION 'ASSET_SERVICE_INVALID: A service cost cannot be negative' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_asset FROM public.assets WHERE id = v_record.asset_id FOR UPDATE;

  UPDATE public.asset_service_records
     SET status            = 'completed',
         returned_date     = COALESCE(p_returned_date, current_date),
         cost              = COALESCE(p_cost, cost),
         condition_after   = COALESCE(v_cond, condition_after),
         next_service_date = COALESCE(p_next_service_date, next_service_date),
         remarks           = COALESCE(NULLIF(btrim(COALESCE(p_remarks, '')), ''), remarks)
   WHERE id = p_service_id
  RETURNING * INTO v_record;

  -- Back to wherever it belongs: with its holder if custody stayed open, on
  -- the shelf otherwise. Never blindly 'available' — that would silently
  -- release an asset somebody is still accountable for.
  v_custody := public.current_asset_custody(v_record.asset_id);
  v_next    := CASE WHEN v_custody.id IS NOT NULL THEN 'assigned' ELSE 'available' END;

  PERFORM public.set_asset_edit_logging(false);
  UPDATE public.assets
     SET status    = v_next,
         condition = COALESCE(v_cond, condition)
   WHERE id = v_record.asset_id;
  PERFORM public.set_asset_edit_logging(true);

  PERFORM public.record_asset_transfer(
    v_record.asset_id, 'returned_from_repair',
    NULL, v_custody.employee_id,
    v_record.vendor,
    CASE WHEN v_custody.id IS NULL THEN v_asset.location ELSE NULL END,
    NULL, v_asset.department,
    v_record.returned_date, v_cond, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    v_record.asset_id, 'asset_returned_from_repair',
    CASE WHEN v_record.vendor IS NULL
         THEN 'Returned from service'
         ELSE 'Returned from service by ' || v_record.vendor END,
    v_uid, v_custody.employee_id,
    jsonb_build_object(
      'service_record_id', v_record.id,
      'service_type',      v_record.service_type,
      'vendor',            v_record.vendor,
      'cost',              v_record.cost,
      'returned_date',     v_record.returned_date,
      'condition',         v_cond,
      'next_service_date', v_record.next_service_date,
      'previous_status',   'under_repair',
      'new_status',        v_next,
      'actor_name',        public.asset_user_display_name(v_uid)
    )
  );

  RETURN v_record;
END;
$$;

REVOKE ALL     ON FUNCTION public.complete_asset_service(uuid, date, numeric, text, text, date) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.complete_asset_service(uuid, date, numeric, text, text, date) TO authenticated;

-- A service that already happened, entered after the fact. Records history
-- only — it never moves the asset, because the asset is already back.
CREATE OR REPLACE FUNCTION public.add_asset_service_record(
  p_asset_id          uuid,
  p_service_type      text,
  p_issue             text    DEFAULT NULL,
  p_description       text    DEFAULT NULL,
  p_vendor            text    DEFAULT NULL,
  p_sent_date         date    DEFAULT NULL,
  p_returned_date     date    DEFAULT NULL,
  p_cost              numeric DEFAULT 0,
  p_condition_after   text    DEFAULT NULL,
  p_remarks           text    DEFAULT NULL,
  p_next_service_date date    DEFAULT NULL
)
RETURNS public.asset_service_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_record public.asset_service_records;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to add a service record' USING ERRCODE = '28000';
  END IF;

  -- Recording history is an 'edit'-level act; 'manage' is accepted too so a
  -- custody manager is never blocked from writing down what they just did.
  IF NOT public.can_write_asset_records() THEN
    RAISE EXCEPTION 'ASSET_SERVICE_DENIED: You do not have permission to add service records'
      USING ERRCODE = '42501';
  END IF;

  IF p_cost IS NOT NULL AND p_cost < 0 THEN
    RAISE EXCEPTION 'ASSET_SERVICE_INVALID: A service cost cannot be negative' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.assets WHERE id = p_asset_id) THEN
    RAISE EXCEPTION 'ASSET_SERVICE_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.asset_service_records (
    asset_id, service_type, issue, description, vendor,
    sent_date, returned_date, cost, condition_after, remarks,
    next_service_date, status, recorded_by
  ) VALUES (
    p_asset_id, p_service_type,
    NULLIF(btrim(COALESCE(p_issue, '')), ''),
    NULLIF(btrim(COALESCE(p_description, '')), ''),
    NULLIF(btrim(COALESCE(p_vendor, '')), ''),
    p_sent_date, p_returned_date, COALESCE(p_cost, 0),
    NULLIF(btrim(COALESCE(p_condition_after, '')), ''),
    NULLIF(btrim(COALESCE(p_remarks, '')), ''),
    p_next_service_date, 'completed', v_uid
  )
  RETURNING * INTO v_record;

  RETURN v_record;
END;
$$;

REVOKE ALL     ON FUNCTION public.add_asset_service_record(uuid, text, text, text, text, date, date, numeric, text, text, date) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.add_asset_service_record(uuid, text, text, text, text, date, date, numeric, text, text, date) TO authenticated;

-- Correcting a historical record. Admin only, and the change is recorded by
-- log_asset_service_change() as 'service_record_corrected' with both sides of
-- every field that moved — corrected in the open, never quietly.
CREATE OR REPLACE FUNCTION public.correct_asset_service_record(
  p_service_id        uuid,
  p_service_type      text    DEFAULT NULL,
  p_issue             text    DEFAULT NULL,
  p_description       text    DEFAULT NULL,
  p_vendor            text    DEFAULT NULL,
  p_sent_date         date    DEFAULT NULL,
  p_returned_date     date    DEFAULT NULL,
  p_cost              numeric DEFAULT NULL,
  p_condition_after   text    DEFAULT NULL,
  p_remarks           text    DEFAULT NULL,
  p_next_service_date date    DEFAULT NULL
)
RETURNS public.asset_service_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := public.assert_asset_request_reviewer();
  v_record public.asset_service_records;
BEGIN
  IF p_cost IS NOT NULL AND p_cost < 0 THEN
    RAISE EXCEPTION 'ASSET_SERVICE_INVALID: A service cost cannot be negative' USING ERRCODE = '42501';
  END IF;

  -- A NULL parameter means "leave this field alone", so this door can correct a
  -- value but never blank one. Clearing a field is deliberately not offered.
  UPDATE public.asset_service_records
     SET service_type      = COALESCE(p_service_type, service_type),
         issue             = COALESCE(p_issue, issue),
         description       = COALESCE(p_description, description),
         vendor            = COALESCE(p_vendor, vendor),
         sent_date         = COALESCE(p_sent_date, sent_date),
         returned_date     = COALESCE(p_returned_date, returned_date),
         cost              = COALESCE(p_cost, cost),
         condition_after   = COALESCE(p_condition_after, condition_after),
         remarks           = COALESCE(p_remarks, remarks),
         next_service_date = COALESCE(p_next_service_date, next_service_date)
   WHERE id = p_service_id
  RETURNING * INTO v_record;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_SERVICE_MISSING: This service record no longer exists' USING ERRCODE = '42501';
  END IF;

  RETURN v_record;
END;
$$;

REVOKE ALL     ON FUNCTION public.correct_asset_service_record(uuid, text, text, text, text, date, date, numeric, text, text, date) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.correct_asset_service_record(uuid, text, text, text, text, date, date, numeric, text, text, date) TO authenticated;

-- ═══ 6. Retire / dispose / restore ═════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.retire_asset(
  p_asset_id uuid,
  p_dispose  boolean DEFAULT false,
  p_remarks  text    DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := public.assert_asset_custody_permission(
                     'manage', 'You do not have permission to retire assets');
  v_asset  public.assets;
  v_target text := CASE WHEN p_dispose THEN 'disposed' ELSE 'retired' END;
  v_prev   text;
  v_loc    text;
  v_dept   text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  IF v_asset.status = v_target THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already %', v_asset.asset_name, v_target
      USING ERRCODE = '42501';
  END IF;

  IF public.current_asset_custody(p_asset_id) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is still held by an employee. Take it back before retiring it', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF v_asset.status = 'under_repair' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is away for service. Close the service record first', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  v_prev := v_asset.status;
  v_loc  := v_asset.location;
  v_dept := v_asset.department;

  PERFORM public.set_asset_edit_logging(false);
  UPDATE public.assets SET status = v_target, department = NULL WHERE id = p_asset_id
  RETURNING * INTO v_asset;
  PERFORM public.set_asset_edit_logging(true);

  PERFORM public.record_asset_transfer(
    p_asset_id, v_target,
    NULL, NULL, v_loc, NULL, v_dept, NULL,
    NULL, NULL, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    p_asset_id,
    CASE WHEN p_dispose THEN 'asset_disposed' ELSE 'asset_retired' END,
    CASE WHEN p_dispose THEN 'Disposed' ELSE 'Retired from service' END,
    v_uid, NULL,
    jsonb_build_object(
      'previous_status', v_prev,
      'new_status',      v_target,
      'remarks',         NULLIF(btrim(COALESCE(p_remarks, '')), ''),
      'actor_name',      public.asset_user_display_name(v_uid)
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL     ON FUNCTION public.retire_asset(uuid, boolean, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.retire_asset(uuid, boolean, text) TO authenticated;

-- Bringing a retired asset back into service. Deliberately narrow: it goes to
-- the shelf, never straight to a person, so the normal Assign flow — and its
-- acceptance step — still applies.
CREATE OR REPLACE FUNCTION public.restore_asset(
  p_asset_id uuid,
  p_remarks  text DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := public.assert_asset_custody_permission(
                    'manage', 'You do not have permission to restore assets');
  v_asset public.assets;
  v_prev  text;
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  IF v_asset.status NOT IN ('retired', 'disposed') THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not retired, so there is nothing to restore', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  v_prev := v_asset.status;

  PERFORM public.set_asset_edit_logging(false);
  UPDATE public.assets SET status = 'available' WHERE id = p_asset_id
  RETURNING * INTO v_asset;
  PERFORM public.set_asset_edit_logging(true);

  PERFORM public.record_asset_transfer(
    p_asset_id, 'correction',
    NULL, NULL, NULL, v_asset.location, NULL, NULL,
    NULL, NULL, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_restored',
    'Restored to service',
    v_uid, NULL,
    jsonb_build_object(
      'previous_status', v_prev,
      'new_status',      'available',
      'remarks',         NULLIF(btrim(COALESCE(p_remarks, '')), ''),
      'actor_name',      public.asset_user_display_name(v_uid)
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL     ON FUNCTION public.restore_asset(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.restore_asset(uuid, text) TO authenticated;

-- ═══ 7. Documents ══════════════════════════════════════════════════════════
--
-- Upload is an ordinary INSERT under asset_documents_insert. Removal is not: it
-- must always be recorded, so it goes through here and soft-deletes.

CREATE OR REPLACE FUNCTION public.remove_asset_document(
  p_document_id uuid,
  p_note        text DEFAULT NULL
)
RETURNS public.asset_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_doc public.asset_documents;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to remove a document' USING ERRCODE = '28000';
  END IF;

  IF NOT public.can_write_asset_records() THEN
    RAISE EXCEPTION 'ASSET_DOCUMENT_DENIED: You do not have permission to remove asset documents'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_doc FROM public.asset_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_DOCUMENT_MISSING: This document no longer exists' USING ERRCODE = '42501';
  END IF;

  IF v_doc.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'ASSET_DOCUMENT_INVALID: This document has already been removed' USING ERRCODE = '42501';
  END IF;

  UPDATE public.asset_documents
     SET removed_at   = now(),
         removed_by   = v_uid,
         removal_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_document_id
  RETURNING * INTO v_doc;

  RETURN v_doc;
END;
$$;

REVOKE ALL     ON FUNCTION public.remove_asset_document(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.remove_asset_document(uuid, text) TO authenticated;
