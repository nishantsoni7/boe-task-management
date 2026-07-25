-- Order Requests — record the BEFORE and AFTER value of every edited field.
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
--
-- The problem
-- -----------
-- edit_order_request (20260708, fixed by 20260709) records only WHICH fields an
-- edit touched:
--
--     details = {"changed_fields": ["total_product_value"]}
--
-- so the Complete Activity rail can only say "Updated: Total Product Value". The
-- assignee is the single exception — 20260708 stores previous_assigned_to /
-- new_assigned_to because a reassignment notification needed them.
--
-- That is not an audit trail. The values are unrecoverable after the fact: the
-- request row holds only the CURRENT value, and reconstructing the old one by
-- diffing an event label against today's row is exactly the derivation an audit
-- record exists to make unnecessary — it would report the wrong number the
-- moment a field is edited twice, and it cannot report anything at all for the
-- first edit of a field that has since changed again.
--
-- What this migration does
-- ------------------------
-- CREATE OR REPLACE of edit_order_request with the SAME signature and a
-- byte-for-byte identical contract in every respect that is not the activity
-- payload:
--   * identical authorization (admin OR current assignee), converted lock and
--     status whitelist;
--   * identical assignee resolution, eligibility check and business validation;
--   * identical editable column set (the same eight columns, nothing more);
--   * identical no-op behaviour — an unchanged form still writes nothing and
--     files no event;
--   * identical RETURN shape, so persistRequestForm's reassignment notification
--     keeps working unchanged.
--
-- The ONLY change is that the request_edited activity row now also carries a
-- `changes` array with the old and new value of each changed field, captured
-- from the PRE-UPDATE row (v_req, read under FOR UPDATE) in the same transaction
-- as the UPDATE it describes. Nothing is computed later or client-side.
--
-- Backward compatibility is deliberate and two-way:
--   * `changed_fields` and previous/new_assigned_to are STILL written, so any
--     existing reader keeps working and the payload is a strict superset;
--   * existing rows are NOT rewritten — history is immutable. They keep their
--     `changed_fields`-only payload and the renderer still handles them.
--
-- Payload shape (one element per changed field, in a stable field order):
--   {"changed_fields": ["total_product_value"],
--    "changes": [{"field":      "total_product_value",
--                 "label":      "Total Product Value",
--                 "value_type": "currency",
--                 "old_value":  240000,
--                 "new_value":  225000}]}
--
-- value_type is the RENDERING contract, recorded with the value so a reader
-- never has to infer a type from a field name:
--   currency    → a number, formatted as ₹ by the client
--   date        → an ISO date ('2026-07-31'), never a timestamp
--   user        → a user id, resolved to a display name by the client
--   lead_source → a STORED ENUM VALUE ('repeat_customer'), resolved to its
--                 user-facing label ('Repeat Customer') by the client
--   notes       → long free text (quoted and truncated for display)
--   text        → short free text
--
-- lead_source is deliberately NOT 'text'. The column stores the machine value
-- ('repeat_customer', 'website'), and every other surface — the record field,
-- the edit dropdown — renders it through LEAD_SOURCE_OPTIONS. Recording it as
-- plain text would make the audit rail the ONE place in the product that prints
-- "repeat_customer" at a reader, so the type says what the value is and the
-- client resolves the label the same way it does everywhere else.
-- A null old_value/new_value means the field was genuinely unset; the client
-- renders that as "Not set" and never as an empty string.
--
-- NOT stored here: anything that is not one of the eight editable columns. In
-- particular no storage path, no signed URL, no token and no hidden identifier —
-- attachment changes have their own events (main_pi_replaced,
-- reference_attachments_changed) and are never folded into a field edit.

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
  -- The before/after record. Built alongside v_changed from the SAME comparison,
  -- so the two can never disagree about what changed.
  v_changes     jsonb  := '[]'::jsonb;
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
  --    anything the client sent or was shown. It is also what makes the captured
  --    OLD values authoritative: no concurrent transaction can move the row
  --    between the read and the UPDATE.
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
  --    The OLD value always comes from v_req — the row as it stands BEFORE the
  --    UPDATE — and the NEW value is the same expression the UPDATE below
  --    assigns. Reading both from one place is what guarantees the audit record
  --    matches what was actually written: a future edit to the SET list that
  --    forgets this block changes the value without changing the record, which
  --    is why the two sit adjacent.
  --
  --    array_append(), NOT `v_changed || 'literal'` — an untyped literal against
  --    a text[] resolves to array||array and dies on 22P02 (the 20260708 defect
  --    fixed by 20260709). For the same reason v_changes is grown with
  --    jsonb_build_array(...) rather than relying on `jsonb_array || jsonb_object`
  --    wrapping its right-hand side.
  if v_client is distinct from v_req.client_name then
    v_changed := array_append(v_changed, 'client_name');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'client_name', 'label', 'Client', 'value_type', 'text',
      'old_value', to_jsonb(v_req.client_name), 'new_value', to_jsonb(v_client)));
  end if;

  if v_assignee is distinct from v_req.assigned_to then
    v_changed := array_append(v_changed, 'assigned_to');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'assigned_to', 'label', 'Assignee', 'value_type', 'user',
      'old_value', to_jsonb(v_req.assigned_to), 'new_value', to_jsonb(v_assignee)));
  end if;

  if p_confirm_date is distinct from v_req.confirm_date then
    v_changed := array_append(v_changed, 'confirm_date');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'confirm_date', 'label', 'Confirmation Date', 'value_type', 'date',
      'old_value', to_jsonb(v_req.confirm_date), 'new_value', to_jsonb(p_confirm_date)));
  end if;

  if p_due_date is distinct from v_req.due_date then
    v_changed := array_append(v_changed, 'due_date');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'due_date', 'label', 'Due Date', 'value_type', 'date',
      'old_value', to_jsonb(v_req.due_date), 'new_value', to_jsonb(p_due_date)));
  end if;

  if p_total_value is distinct from v_req.total_value then
    v_changed := array_append(v_changed, 'total_value');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'total_value', 'label', 'Total Order Value', 'value_type', 'currency',
      'old_value', to_jsonb(v_req.total_value), 'new_value', to_jsonb(p_total_value)));
  end if;

  if p_total_product_value is distinct from v_req.total_product_value then
    v_changed := array_append(v_changed, 'total_product_value');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'total_product_value', 'label', 'Total Product Value', 'value_type', 'currency',
      'old_value', to_jsonb(v_req.total_product_value), 'new_value', to_jsonb(p_total_product_value)));
  end if;

  if p_lead_source is distinct from v_req.lead_source then
    v_changed := array_append(v_changed, 'lead_source');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'lead_source', 'label', 'Lead Source', 'value_type', 'lead_source',
      'old_value', to_jsonb(v_req.lead_source), 'new_value', to_jsonb(p_lead_source)));
  end if;

  -- The stored notes are the trimmed/nullified form (v_notes), which is what the
  -- UPDATE writes — so the audit shows the value the record actually took, not
  -- the raw keystrokes. Full text, untruncated: the RECORD is the archive, and
  -- shortening for a narrow UI is the renderer's job, not the audit's.
  if v_notes is distinct from v_req.notes then
    v_changed := array_append(v_changed, 'notes');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'notes', 'label', 'Notes', 'value_type', 'notes',
      'old_value', to_jsonb(v_req.notes), 'new_value', to_jsonb(v_notes)));
  end if;

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
  --     edit, so this is the single record of it — one row per save, however many
  --     fields it touched, which is also what keeps the rail free of duplicate
  --     "Request edited" entries.
  --
  --     `changed_fields` and the assignee pair are kept alongside `changes` so
  --     the payload is a strict SUPERSET of what 20260708/20260709 wrote: an
  --     older reader still finds what it expects, and this row stays readable if
  --     the function is ever rolled back to the previous definition.
  insert into public.order_request_activity
    (order_request_id, event_type, actor_id, details)
  values (
    v_req.id, 'request_edited', v_actor,
    jsonb_build_object('changed_fields', to_jsonb(v_changed), 'changes', v_changes)
    || case when 'assigned_to' = any(v_changed)
            then jsonb_build_object(
                   'previous_assigned_to', v_prev_assignee,
                   'new_assigned_to',      v_req.assigned_to)
            else '{}'::jsonb
       end
  );

  -- 11. Stable structured result — UNCHANGED from 20260709. assignee_changed is
  --     what the client keys the existing assignment notification off, so the
  --     notification decision is made from committed database state rather than
  --     from pre-save form data.
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

-- CREATE OR REPLACE with an unchanged signature preserves existing grants; they
-- are re-asserted so this migration is self-contained.
revoke execute on function public.edit_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) from public, anon;
grant  execute on function public.edit_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) to authenticated;

comment on function public.edit_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) is
  'Edit an unconverted Order Request (admin or current assignee only). Records one request_edited activity row per save, carrying the OLD and NEW value of every changed field as captured before the update.';
