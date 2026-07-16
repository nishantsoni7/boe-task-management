-- Order Requests Phase 3C — reapplication after rejection.
--
-- Implements the transition:  rejected -> submitted
--
--   public.reapply_order_request(p_order_request_id, <editable business fields>)
--     Owner-only (created_by or requested_by). rejected -> submitted, updating
--     the permitted fields and clearing the active rejection reason (its
--     history survives permanently in activity).
--
-- Conversion, clarification, official Order numbering, payment linking, and
-- all Finance behaviour are untouched. A reapplied request re-enters the
-- normal submitted flow: convert_order_request_to_order,
-- request_order_request_clarification, and reject_order_request already
-- require status = 'submitted', so nothing further is needed to make it
-- reachable by them again — this migration adds no new checks there.
--
-- Editable field set is taken verbatim from resubmit_order_request
-- (20260683000000): client_name, requested_by, assigned_to, confirm_date,
-- due_date, total_value, lead_source, notes. No business reason surfaced
-- during review to use a narrower set for reapplication.

-- ── 1. Allow the new activity event ──────────────────────────────────────────

alter table public.order_request_activity
  drop constraint order_request_activity_event_type_check;

alter table public.order_request_activity
  add constraint order_request_activity_event_type_check
  check (event_type in (
    'request_submitted',
    'status_changed',
    'request_converted',
    'clarification_requested',
    'clarification_resubmitted',
    'request_rejected',
    'reapplication_submitted'
  ));

-- ── 2. Map rejected -> submitted to its own event ────────────────────────────
-- Narrow extension of the existing trigger (unchanged otherwise): the new
-- transition now produces one specific reapplication_submitted event instead
-- of a generic status_changed, so there is no redundant second entry for the
-- same reapplication. Carries no details, mirroring clarification_resubmitted:
-- the request's own row already holds the updated values, and the superseded
-- rejection_reason is already permanently preserved in the earlier
-- request_rejected activity row.

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

    elsif (old.status = 'submitted' and new.status = 'rejected') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'request_rejected', v_actor, old.status, new.status,
              jsonb_build_object('rejection_reason', new.rejection_reason));

    elsif (old.status = 'rejected' and new.status = 'submitted') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'reapplication_submitted', v_actor, old.status, new.status);

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

-- ── 3. Owner: reapply after rejection ────────────────────────────────────────
-- SECURITY DEFINER, matching resubmit_order_request: ownership is checked
-- against the project's existing requester definition (created_by OR
-- requested_by — assigned_to is deliberately NOT an owner), never by the
-- caller's own RLS. No broad direct-UPDATE policy is added or needed: the
-- Phase 3A/3B migrations already removed both the requester and admin generic
-- UPDATE policies on order_requests, so this SECURITY DEFINER RPC is the only
-- path that can move a rejected request anywhere.
--
-- Only the eight business fields are parameters, taken verbatim from
-- resubmit_order_request's signature. id, request_number, created_by, status,
-- rejection_reason, converted_order_id, converted_at and created_at are
-- simply not reachable through this signature.

create or replace function public.reapply_order_request(
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

  -- 2. Lock the request first: serializes double-clicks and blocks a race
  --    with a concurrent admin action (e.g. a second rejection attempt) or a
  --    second reapplication call on the same row.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 3. Ownership, checked against the CURRENT row (before any change), using
  --    the project's existing requester definition.
  if not (v_req.created_by = v_actor or v_req.requested_by = v_actor) then
    raise exception 'Only the requester may reapply this order request'
      using errcode = '42501';
  end if;

  -- 4. Only a rejected request may be reapplied. This also rejects a repeat
  --    reapplication (once already submitted, status is no longer
  --    'rejected'), and submitted, needs_clarification, or converted
  --    requests.
  if v_req.status <> 'rejected' then
    raise exception 'Only a rejected order request can be reapplied (% is %)',
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
  --    reapplication_submitted row. Clearing rejection_reason is safe: the
  --    reason is already preserved in the earlier request_rejected activity
  --    row. converted_order_id/converted_at are never touched here and stay
  --    null (order_requests_converted_consistency already enforces that for
  --    any non-converted status).
  update public.order_requests
     set client_name      = v_client,
         requested_by     = p_requested_by,
         assigned_to      = p_assigned_to,
         confirm_date     = p_confirm_date,
         due_date         = p_due_date,
         total_value      = p_total_value,
         lead_source      = p_lead_source,
         notes            = v_notes,
         status           = 'submitted',
         rejection_reason = null,
         updated_at       = v_now
   where id = p_order_request_id;

  return jsonb_build_object(
    'order_request_id', v_req.id,
    'request_number',   v_req.request_number,
    'status',           'submitted',
    'updated_at',        v_now
  );
end;
$$;

revoke execute on function public.reapply_order_request(uuid, text, uuid, uuid, date, date, numeric, text, text) from public, anon, authenticated;
grant  execute on function public.reapply_order_request(uuid, text, uuid, uuid, date, date, numeric, text, text) to authenticated;
