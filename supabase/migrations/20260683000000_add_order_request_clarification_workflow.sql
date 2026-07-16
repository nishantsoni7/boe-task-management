-- Order Requests Phase 3A — admin clarification request and requester response.
--
-- Implements the loop:  submitted -> needs_clarification -> submitted
--
--   public.request_order_request_clarification(p_order_request_id, p_clarification_note)
--     Admin-only. submitted -> needs_clarification, storing a required note.
--
--   public.resubmit_order_request(p_order_request_id, <editable business fields>)
--     Requester-only. needs_clarification -> submitted, updating the permitted
--     fields and clearing the active note (its history survives in activity).
--
-- Rejection is NOT part of this phase: rejection_reason is never written here,
-- and no path can set status = 'rejected'. Conversion, payment linking, official
-- Order numbering, and all Finance behaviour are untouched.
--
-- ── Direct-update bypass fixed here ──────────────────────────────────────────
-- order_requests_requester_update (20260680000000) granted requesters a generic
-- UPDATE with:
--   USING      (created_by = auth.uid() OR requested_by = auth.uid())
--              AND status IN ('submitted','needs_clarification')
--   WITH CHECK (same) AND converted_order_id IS NULL AND converted_at IS NULL
--
-- Because 'needs_clarification' is inside that whitelist and clarification_note
-- is unconstrained, a normal requester could, straight through PostgREST:
--   * move their own request submitted -> needs_clarification (an admin-only
--     transition under the Phase 3A rules),
--   * move needs_clarification -> submitted with no validation at all, bypassing
--     resubmit_order_request and logging a generic status_changed instead of a
--     clarification_resubmitted event, and
--   * set or clear clarification_note at will — including wiping the admin's
--     question without answering it.
--
-- The policy is therefore dropped rather than narrowed: no application code
-- performs a requester UPDATE on order_requests (the page only SELECTs and
-- INSERTs), so removing it costs nothing, and every requester mutation now has
-- to go through resubmit_order_request, which validates state and records
-- activity. Admin policies are deliberately left exactly as they are, and the
-- requester's SELECT/INSERT rights are unchanged.

-- ── 1. Allow the two new activity events ─────────────────────────────────────

alter table public.order_request_activity
  drop constraint order_request_activity_event_type_check;

alter table public.order_request_activity
  add constraint order_request_activity_event_type_check
  check (event_type in (
    'request_submitted',
    'status_changed',
    'request_converted',
    'clarification_requested',
    'clarification_resubmitted'
  ));

-- ── 2. Map the clarification transitions to their own events ─────────────────
-- Narrow extension of the existing trigger: the two clarification transitions
-- now produce one specific event each instead of a generic status_changed, so
-- no transition is recorded twice. Everything else (request_submitted,
-- request_converted, and the status_changed fallback) is unchanged. Activity
-- stays entirely trigger-derived from real committed state — actor is always
-- auth.uid(), never client-supplied.
--
-- clarification_requested carries the admin's note in details, which is what
-- makes the note permanently traceable after resubmission clears the live field.
-- clarification_resubmitted carries nothing: the request's own row already holds
-- the updated values, and no snapshot belongs in the log.

create or replace function public.log_order_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_order_number text;
  v_linked_count integer;
begin
  if (tg_op = 'INSERT') then
    insert into public.order_request_activity
      (order_request_id, event_type, actor_id, from_status, to_status)
    values (new.id, 'request_submitted', v_actor, null, new.status);

  elsif (new.status is distinct from old.status) then
    if (new.status = 'converted') then
      select o.display_number into v_order_number
      from public.orders o
      where o.id = new.converted_order_id;

      select count(*) into v_linked_count
      from public.finance_payment_requests f
      where f.order_id = new.converted_order_id;

      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'request_converted', v_actor, old.status, new.status,
              jsonb_build_object(
                'converted_order_id',   new.converted_order_id,
                'order_display_number', v_order_number,
                'linked_payment_count', v_linked_count
              ));

    elsif (old.status = 'submitted' and new.status = 'needs_clarification') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'clarification_requested', v_actor, old.status, new.status,
              jsonb_build_object('clarification_note', new.clarification_note));

    elsif (old.status = 'needs_clarification' and new.status = 'submitted') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'clarification_resubmitted', v_actor, old.status, new.status);

    else
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'status_changed', v_actor, old.status, new.status);
    end if;

  -- else: a plain field edit / updated_at touch — nothing to record.
  end if;

  return null;  -- AFTER trigger; return value is ignored.
end;
$$;

revoke execute on function public.log_order_request_activity() from public, anon, authenticated;

-- ── 3. Close the direct-update bypass ────────────────────────────────────────

drop policy if exists "order_requests_requester_update" on public.order_requests;

-- ── 4. Admin: request clarification ──────────────────────────────────────────

create or replace function public.request_order_request_clarification(
  p_order_request_id  uuid,
  p_clarification_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_req   public.order_requests%rowtype;
  v_note  text;
  v_now   timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may request clarification on an order request'
      using errcode = '42501';
  end if;

  -- 3. Reject a blank note before touching any row.
  v_note := btrim(coalesce(p_clarification_note, ''));
  if v_note = '' then
    raise exception 'A clarification note is required'
      using errcode = 'P0001';
  end if;

  -- 4. Lock the request: serializes double-clicks and blocks a race with a
  --    concurrent conversion (the loser re-reads and fails the status check).
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Only a submitted request may be sent back for clarification. This also
  --    rejects an already-needs_clarification request (no repeat), and rejected
  --    or converted requests (immutable through this workflow).
  if v_req.status <> 'submitted' then
    raise exception 'Only a submitted order request can be sent back for clarification (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 6. Status + note only. rejection_reason and the conversion fields are never
  --    written here; the converted_consistency CHECK keeps the latter null for
  --    any non-converted status. The AFTER UPDATE trigger writes the single
  --    clarification_requested activity row.
  update public.order_requests
     set status             = 'needs_clarification',
         clarification_note = v_note,
         updated_at         = v_now
   where id = p_order_request_id;

  return jsonb_build_object(
    'order_request_id',   v_req.id,
    'request_number',     v_req.request_number,
    'status',             'needs_clarification',
    'clarification_note', v_note,
    'updated_at',         v_now
  );
end;
$$;

revoke execute on function public.request_order_request_clarification(uuid, text) from public, anon, authenticated;
grant  execute on function public.request_order_request_clarification(uuid, text) to authenticated;

-- ── 5. Requester: update and resubmit ────────────────────────────────────────
-- Ownership rule is taken verbatim from the existing policies rather than
-- invented: order_requests_requester_select/-_insert treat "the requester" as
-- created_by OR requested_by. assigned_to is NOT an owner and cannot resubmit.
--
-- requested_by stays editable, consistent with submission (the create form lets
-- the submitter pick any requested_by) and with the Phase 2A decision to leave
-- it mutable: changing it requires already owning the request, so it grants the
-- caller no privilege they lack. created_by is immutable at the database level
-- via order_requests_protect_created_by, so ownership can never be forged here.
--
-- Only the eight business fields are parameters. id, request_number, created_by,
-- rejection_reason, converted_order_id, converted_at, created_at and the
-- administrative statuses are simply not reachable through this signature.

create or replace function public.resubmit_order_request(
  p_order_request_id uuid,
  p_client_name      text,
  p_requested_by     uuid,
  p_assigned_to      uuid    default null,
  p_confirm_date     date    default null,
  p_due_date         date    default null,
  p_total_value      numeric default null,
  p_lead_source      text    default null,
  p_notes            text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_req    public.order_requests%rowtype;
  v_client text;
  v_notes  text;
  v_now    timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required'
      using errcode = '28000';
  end if;

  -- 2. Lock the request first: serializes double-clicks and blocks a race with
  --    an admin converting or re-clarifying at the same moment.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 3. Ownership, checked against the CURRENT row (before any change), using the
  --    project's existing requester definition.
  if not (v_req.created_by = v_actor or v_req.requested_by = v_actor) then
    raise exception 'Only the requester may resubmit this order request'
      using errcode = '42501';
  end if;

  -- 4. Only a request actually awaiting clarification may be resubmitted. This
  --    rejects a repeat resubmission, a submitted request, and rejected or
  --    converted requests.
  if v_req.status <> 'needs_clarification' then
    raise exception 'Only an order request awaiting clarification can be resubmitted (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 5. Validate the required business fields (the table's own CHECK/FK
  --    constraints still police lead_source, the user references, and types).
  v_client := btrim(coalesce(p_client_name, ''));
  if v_client = '' then
    raise exception 'Client name is required'
      using errcode = 'P0001';
  end if;

  if p_requested_by is null then
    raise exception 'Requested By is required'
      using errcode = 'P0001';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  -- 6. Apply the permitted edits and hand the request back for review in one
  --    statement, so the AFTER UPDATE trigger writes exactly one
  --    clarification_resubmitted row. Clearing clarification_note is safe: the
  --    note is already preserved in the clarification_requested activity row.
  update public.order_requests
     set client_name        = v_client,
         requested_by       = p_requested_by,
         assigned_to        = p_assigned_to,
         confirm_date       = p_confirm_date,
         due_date           = p_due_date,
         total_value        = p_total_value,
         lead_source        = p_lead_source,
         notes              = v_notes,
         status             = 'submitted',
         clarification_note = null,
         updated_at         = v_now
   where id = p_order_request_id;

  return jsonb_build_object(
    'order_request_id', v_req.id,
    'request_number',   v_req.request_number,
    'status',           'submitted',
    'updated_at',       v_now
  );
end;
$$;

revoke execute on function public.resubmit_order_request(uuid, text, uuid, uuid, date, date, numeric, text, text) from public, anon, authenticated;
grant  execute on function public.resubmit_order_request(uuid, text, uuid, uuid, date, date, numeric, text, text) to authenticated;
