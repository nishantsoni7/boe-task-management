-- Fix a defect in edit_order_request as shipped by 20260708000000.
--
-- The change-detection block built its field list with
--
--     v_changed := v_changed || 'client_name';
--
-- Against a text[] left-hand side, PostgreSQL resolves the untyped literal via
-- the `anyarray || anyarray` operator rather than `anyarray || anyelement`, so
-- 'client_name' was parsed as an ARRAY LITERAL and every call raised
--
--     22P02 malformed array literal: "client_name"
--     DETAIL: Array value must start with "{" or dimension information.
--
-- i.e. the function failed for admin and assignee alike, on every edit. It was
-- caught during verification because the test harness wrapped most calls in an
-- exception handler, which turned the failure into an ordinary assertion FAIL;
-- the one unguarded call surfaced the real SQLSTATE.
--
-- 20260708000000 is already applied, so it is left untouched (this repo never
-- edits an applied migration). This migration replaces the function body with
-- array_append(), which is unambiguous and cannot re-acquire the operator
-- resolution problem. Nothing else changes: the signature, the permission rule,
-- the status whitelist, the editable column set, the activity payload, and the
-- returned shape are all identical to 20260708. CREATE OR REPLACE with an
-- unchanged signature preserves existing grants; they are re-asserted below
-- anyway so this migration is self-contained.

create or replace function public.edit_order_request(
  p_order_request_id    uuid,
  p_client_name         text,
  p_assigned_to         uuid    default null,
  p_confirm_date        date    default null,
  p_due_date            date    default null,
  p_total_value         numeric default null,
  p_total_product_value numeric default null,
  p_lead_source         text    default null,
  p_notes               text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_is_admin    boolean;
  v_is_assignee boolean;
  v_req         public.order_requests%rowtype;
  v_client      text;
  v_notes       text;
  v_assignee    uuid;
  -- Captured before the UPDATE, because `returning * into v_req` below replaces
  -- v_req with the post-update row and the old assignee would otherwise be lost.
  v_prev_assignee uuid;
  v_changed     text[] := '{}';
  v_now         timestamptz;
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to edit an order request'
      using errcode = '28000';
  end if;

  v_is_admin := exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  );

  -- 2. Lock the request FIRST: serializes double-clicks, and blocks a race with
  --    an admin converting, rejecting, or reassigning at the same moment. Every
  --    check below therefore runs against real committed state, never against
  --    anything the client sent or was shown.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 3. Authorization: admin, or the person the request is currently assigned to.
  --    coalesce() matters — an unassigned request has assigned_to IS NULL, and
  --    `null = v_actor` is NULL, which would otherwise fall through the IF.
  v_is_assignee := coalesce(v_req.assigned_to = v_actor, false);

  if not v_is_admin and not v_is_assignee then
    raise exception 'Only an admin or the current assignee may edit this order request'
      using errcode = '42501';
  end if;

  -- 4. A converted request is final. order_requests_guard_converted (20260699 §4)
  --    exempts admins, so this is the check that closes the door on them too —
  --    a converted request has produced a Confirmed Order and is permanent
  --    source history.
  if v_req.status = 'converted' or v_req.converted_order_id is not null then
    raise exception 'Order request % has been converted and can no longer be edited',
      v_req.request_number
      using errcode = '42501';
  end if;

  -- Restated as an explicit whitelist rather than relying on 'converted' being
  -- the only other value in order_requests_status_check, so a future status is
  -- excluded by default instead of silently becoming editable.
  if v_req.status not in ('submitted', 'needs_clarification', 'rejected') then
    raise exception 'An order request in status % cannot be edited', v_req.status
      using errcode = 'P0001';
  end if;

  -- 5. Assignee resolution.
  --    Non-admin: assigned_to is not theirs to change. A differing value is
  --    REJECTED, not quietly ignored, so a hand-rolled call cannot reassign a
  --    request and cannot mistake a discarded change for a successful one. The
  --    client sends the unchanged current value, so a normal save never trips
  --    this.
  if v_is_admin then
    v_assignee := p_assigned_to;
  else
    if p_assigned_to is distinct from v_req.assigned_to then
      raise exception 'Only an admin may change the assignee of an order request'
        using errcode = '42501';
    end if;
    v_assignee := v_req.assigned_to;
  end if;

  -- 6. Validate the assignee only when it actually changes — the same rule
  --    order_requests_validate_assignee (20260697) applies, restated here so the
  --    caller gets this function's own message instead of a raw trigger error.
  --    A legacy assignee that no longer qualifies is preserved untouched.
  if v_assignee is distinct from v_req.assigned_to
     and v_assignee is not null
     and not public.is_eligible_order_assignee(v_assignee) then
    raise exception 'Assignee must be an active Sales team member or an authorised Order Assignee.'
      using errcode = 'P0001';
  end if;

  -- 7. Business validation — identical to resubmit_order_request. The table's
  --    own CHECK/FK constraints still police lead_source, the user references,
  --    and the column types.
  v_client := btrim(coalesce(p_client_name, ''));
  if v_client = '' then
    raise exception 'Client name is required'
      using errcode = 'P0001';
  end if;

  if p_total_value is not null and p_total_value < 0 then
    raise exception 'Total Order Value must not be negative'
      using errcode = 'P0001';
  end if;

  if p_total_product_value is not null and p_total_product_value < 0 then
    raise exception 'Total Product Value must not be negative'
      using errcode = 'P0001';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  -- 8. Work out what genuinely changed, for the activity payload and so a no-op
  --    save is a true no-op: without this, saving an untouched form would bump
  --    updated_at and file an edit event, misreporting the request as edited.
  --
  --    array_append(), NOT `v_changed || 'literal'` — see the header note: the
  --    || form resolves to array||array and dies on 22P02.
  if v_client              is distinct from v_req.client_name         then v_changed := array_append(v_changed, 'client_name');         end if;
  if v_assignee            is distinct from v_req.assigned_to         then v_changed := array_append(v_changed, 'assigned_to');         end if;
  if p_confirm_date        is distinct from v_req.confirm_date        then v_changed := array_append(v_changed, 'confirm_date');        end if;
  if p_due_date            is distinct from v_req.due_date            then v_changed := array_append(v_changed, 'due_date');            end if;
  if p_total_value         is distinct from v_req.total_value         then v_changed := array_append(v_changed, 'total_value');         end if;
  if p_total_product_value is distinct from v_req.total_product_value then v_changed := array_append(v_changed, 'total_product_value'); end if;
  if p_lead_source         is distinct from v_req.lead_source         then v_changed := array_append(v_changed, 'lead_source');         end if;
  if v_notes               is distinct from v_req.notes               then v_changed := array_append(v_changed, 'notes');               end if;

  if array_length(v_changed, 1) is null then
    return jsonb_build_object(
      'order_request_id',     v_req.id,
      'request_number',       v_req.request_number,
      'status',               v_req.status,
      'updated_at',           v_req.updated_at,
      'assignee_changed',     false,
      'previous_assigned_to', v_req.assigned_to,
      'assigned_to',          v_req.assigned_to,
      'changed_fields',       to_jsonb(v_changed)
    );
  end if;

  -- 9. Apply exactly the eight editable columns. Everything else is absent from
  --    this SET list on purpose and therefore cannot move through this function:
  --    request_number, created_by, requested_by, status, clarification_note,
  --    rejection_reason, converted_order_id, converted_at, created_at,
  --    is_test_data. updated_at is left to the order_requests_set_updated_at
  --    trigger rather than written here, so the database owns it.
  v_prev_assignee := v_req.assigned_to;

  update public.order_requests
     set client_name         = v_client,
         assigned_to         = v_assignee,
         confirm_date        = p_confirm_date,
         due_date            = p_due_date,
         total_value         = p_total_value,
         total_product_value = p_total_product_value,
         lead_source         = p_lead_source,
         notes               = v_notes
   where id = p_order_request_id
  returning * into v_req;

  v_now := v_req.updated_at;

  -- 10. Activity. The AFTER UPDATE trigger writes nothing for a status-preserving
  --     edit, so this is the single record of it. A reassignment carries both
  --     sides, matching the payment_linked/_unlinked payload convention of
  --     naming the concrete ids involved.
  insert into public.order_request_activity
    (order_request_id, event_type, actor_id, details)
  values (
    v_req.id, 'request_edited', v_actor,
    jsonb_build_object('changed_fields', to_jsonb(v_changed))
    || case when 'assigned_to' = any(v_changed)
            then jsonb_build_object(
                   'previous_assigned_to', v_prev_assignee,
                   'new_assigned_to',      v_req.assigned_to)
            else '{}'::jsonb
       end
  );

  -- 11. Stable structured result. assignee_changed is what the client keys the
  --     existing assignment notification off, so the notification decision is
  --     made from committed database state rather than from pre-save form data.
  return jsonb_build_object(
    'order_request_id',     v_req.id,
    'request_number',       v_req.request_number,
    'status',               v_req.status,
    'updated_at',           v_now,
    'assignee_changed',     'assigned_to' = any(v_changed),
    'previous_assigned_to', v_prev_assignee,
    'assigned_to',          v_req.assigned_to,
    'changed_fields',       to_jsonb(v_changed)
  );
end;
$$;

revoke execute on function public.edit_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) from public, anon, authenticated;
grant  execute on function public.edit_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) to authenticated;
