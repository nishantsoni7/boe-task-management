-- Order Requests — let the person who must answer a clarification actually answer it.
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20260712 and 20260713, which are also pending.
--
-- The problem
-- -----------
-- An admin can send a request back with `Request Clarification`. The salesperson
-- sees the status and the note — and can do nothing about it. Two separate
-- defects, one at each layer, and they share a cause:
--
--   1. resubmit_order_request (20260683, reshaped by 20260696) authorises with
--
--          if not (v_req.created_by = v_actor or v_req.requested_by = v_actor)
--
--      i.e. the project's `isPermittedRequester` rule. assigned_to is NOT in it.
--      When an ADMIN raises a request on a salesperson's behalf — the normal
--      case — created_by and requested_by are both the admin and assigned_to is
--      the only thing tying the salesperson to the record. The one person who
--      has to answer the clarification is the one person the function refuses.
--      The detail page's `canResubmit` used the identical rule, so the button
--      was not rendered either; fixing only the button would have produced a
--      42501 from the database.
--
--   2. There is nowhere to put an answer. resubmit_order_request takes the
--      editable business fields and nothing else, so the reviewer learns only
--      that *something* was resubmitted. The trigger's clarification_resubmitted
--      row carries no details at all (20260683 §"carries nothing").
--
-- What this migration does
-- ------------------------
--   §1  adds the `clarification_responded` activity event type;
--   §2  teaches the activity trigger to stand aside for exactly one transaction
--       when this function is the writer, so the exchange reads as one event
--       rather than a rich event followed by an empty one;
--   §3  adds respond_to_clarification() — ONE atomic RPC that authorises,
--       validates, applies the field edits, records the response with full
--       before/after audit values, and hands the request back for review.
--
-- What it deliberately does NOT do
-- --------------------------------
--   * resubmit_order_request and reapply_order_request are left EXACTLY as they
--     are. The rejection/reapply workflow is out of scope and is not weakened;
--     resubmit_order_request simply stops being the path the UI takes. Its rule
--     is the NARROWER one, so leaving it in place grants nobody anything.
--   * No RLS policy is touched. public.order_requests still has no UPDATE policy
--     for any role — every mutation goes through a SECURITY DEFINER RPC, and
--     this adds one more rather than opening the table.
--   * No status VALUE is introduced. The reviewer queue in this schema IS
--     'submitted' (order_requests_status_check, and canReview / the list filters
--     all key off it). "Back to pending approval" therefore means status =
--     'submitted'; inventing a 'pending_approval' value would break the CHECK,
--     every status filter, STATUS_META and the review guard at once.
--   * The admin's original clarification_requested activity row is never
--     updated or deleted. It is the other half of the exchange.

-- ── 1. Activity event types ───────────────────────────────────────────────────
-- Postgres cannot add a value to a CHECK in place, so the constraint is dropped
-- and re-created with the FULL list. Any value omitted here is silently REVOKED.
--
-- RULE (from 20260712): re-read the live constraint first and take the UNION.
-- This list is 20260712's list plus 'clarification_responded'. It is written as
-- a superset on purpose, so it is correct whether or not 20260712 has been
-- applied when this runs.
alter table public.order_request_activity
  drop constraint if exists order_request_activity_event_type_check;

alter table public.order_request_activity
  add constraint order_request_activity_event_type_check
  check (event_type in (
    'request_submitted',
    'status_changed',
    'request_converted',
    'clarification_requested',
    'clarification_resubmitted',
    'clarification_responded',          -- added by this migration
    'request_rejected',
    'reapplication_submitted',
    'payment_linked',
    'payment_unlinked',
    'request_edited',
    'attachments_uploaded',
    'main_pi_replaced',
    'reference_attachments_changed'
  ));

-- ── 2. Activity trigger — one event for one exchange ──────────────────────────
-- The body below is 20260711's verbatim, with ONE change: the
-- needs_clarification → submitted branch is skipped when the transaction-local
-- flag `boe.clarification_response` is set.
--
-- Why a flag rather than letting both rows land: respond_to_clarification()
-- writes a clarification_responded row carrying the answer, the changed fields
-- and their before/after values. The trigger's clarification_resubmitted row
-- carries nothing. Both would appear at the same timestamp, and the reader would
-- see a detailed event immediately followed by a contentless duplicate of the
-- same transition.
--
-- The flag is set with is_local => true, so it is scoped to the transaction and
-- reverts on COMMIT or ROLLBACK — it cannot leak into the next statement on a
-- pooled connection. current_setting(..., true) returns NULL rather than raising
-- when the setting was never set, which is the case for every other writer.
--
-- The legacy path is unaffected: resubmit_order_request does not set the flag,
-- so it still produces clarification_resubmitted exactly as before, and existing
-- history rows are untouched.
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
    -- request_submitted fires only for a row born operational — finalized_at
    -- non-null, i.e. the defaulted OLD-client insert. A NEW-client draft
    -- (finalized_at NULL) logs nothing here; finalize_order_request() emits its
    -- activity once the Main PI is verified.
    if new.finalized_at is not null then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'request_submitted', v_actor, null, new.status);
    end if;

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
      -- respond_to_clarification() records this transition itself, with the
      -- response and the audit values attached. Anything else still gets the
      -- plain row.
      if coalesce(current_setting('boe.clarification_response', true), '') <> '1' then
        insert into public.order_request_activity
          (order_request_id, event_type, actor_id, from_status, to_status)
        values (new.id, 'clarification_resubmitted', v_actor, old.status, new.status);
      end if;

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

-- ── 3. respond_to_clarification() ─────────────────────────────────────────────
-- Answer a clarification and hand the request back for review, atomically.
--
-- AUTHORIZATION — the rule this migration exists to fix:
--     admin  OR  created_by  OR  requested_by  OR  assigned_to
-- The first three are resubmit_order_request's existing rule, preserved so
-- nobody who could resubmit before loses the ability. assigned_to is the
-- addition: the person the work actually sits with. Nobody else is included —
-- this is not `isRequestParticipant` plus admin by accident, it is that set
-- stated explicitly, and an unrelated authenticated user still gets 42501.
--
-- A non-admin still cannot move assigned_to. That check is copied from
-- edit_order_request (20260713 §5) deliberately: a request may not change hands
-- as a side effect of answering a question, and a differing value is REJECTED
-- rather than ignored so a hand-rolled call cannot mistake a discarded change
-- for a successful one.
--
-- ORDERING is the atomicity guarantee. Every check runs, and the whole audit
-- payload is built, BEFORE the single UPDATE. The UPDATE moves the fields, the
-- status and clarification_note together, and the activity row is written in the
-- same transaction. There is no interleaving in which the note is cleared but
-- the response is unrecorded, or the status moves but the edits do not.
--
-- Attachment changes stay in their own route (edit_order_request_attachments).
-- The client applies those FIRST and only calls this on success, so the request
-- is never handed back with half its documents updated.
create or replace function public.respond_to_clarification(
  p_order_request_id    uuid,
  p_response            text,
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
  v_actor     uuid := auth.uid();
  v_is_admin  boolean;
  v_req       public.order_requests%rowtype;
  v_response  text;
  v_client    text;
  v_notes     text;
  v_assignee  uuid;
  v_changed   text[] := '{}';
  v_changes   jsonb  := '[]'::jsonb;
  v_now       timestamptz := now();
begin
  -- 1. Authentication.
  if v_actor is null then
    raise exception 'Authentication required'
      using errcode = '28000';
  end if;

  select (u.role = 'admin') into v_is_admin
  from public.users u
  where u.id = v_actor;
  v_is_admin := coalesce(v_is_admin, false);

  -- 2. Lock the request FIRST. This serialises a double-click into one winner
  --    and one status failure, and blocks the race with an admin converting or
  --    re-clarifying at the same moment.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 3. Authorisation, against the CURRENT row, before anything about it is
  --    revealed through an error message.
  if not (v_is_admin
          or v_req.created_by   = v_actor
          or v_req.requested_by = v_actor
          or v_req.assigned_to  = v_actor) then
    raise exception 'You do not have permission to respond to this clarification'
      using errcode = '42501';
  end if;

  -- 4. The request must STILL be awaiting clarification. This is the stale-state
  --    gate: it rejects a second submission from a double-click that got past
  --    the client guard, a request an admin has since converted or rejected, and
  --    a browser tab left open across someone else's change.
  if v_req.status <> 'needs_clarification' then
    raise exception 'Order request % is no longer awaiting clarification (it is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- A converted request is immutable regardless of status bookkeeping.
  if v_req.converted_order_id is not null then
    raise exception 'Order request % has been converted and can no longer be changed',
      v_req.request_number
      using errcode = 'P0001';
  end if;

  -- 5. The response is REQUIRED and may not be whitespace. This is the whole
  --    point of the event, so an empty answer is refused here as well as in the
  --    client — a resubmission with nothing said would leave the reviewer
  --    exactly where they started.
  v_response := btrim(coalesce(p_response, ''));
  if v_response = '' then
    raise exception 'A response to the clarification is required'
      using errcode = 'P0001';
  end if;

  -- 6. Assignee resolution — identical rule to edit_order_request.
  if v_is_admin then
    v_assignee := p_assigned_to;
  else
    if p_assigned_to is distinct from v_req.assigned_to then
      raise exception 'Only an admin may change the assignee of an order request'
        using errcode = '42501';
    end if;
    v_assignee := v_req.assigned_to;
  end if;

  if v_assignee is distinct from v_req.assigned_to
     and v_assignee is not null
     and not public.is_eligible_order_assignee(v_assignee) then
    raise exception 'Assignee must be an active Sales team member or an authorised Order Assignee.'
      using errcode = 'P0001';
  end if;

  -- 7. Business validation — the same rules edit_order_request applies.
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

  -- 8. Work out what genuinely changed, in the 20260713 audit shape.
  --
  --    Unlike edit_order_request, an EMPTY change set is NOT a no-op here: the
  --    response itself is the point, and answering a question without altering
  --    a field is the normal case. So this only builds the payload — the
  --    resubmission happens either way, and changed_fields is simply [].
  --
  --    array_append(), not `v_changed || 'literal'` — an untyped literal against
  --    text[] resolves to array||array and dies on 22P02 (the 20260708 defect
  --    fixed by 20260709). Old values come from v_req (read under FOR UPDATE),
  --    new values are the same expressions the UPDATE below assigns, so the
  --    audit cannot disagree with what was written.
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

  if v_notes is distinct from v_req.notes then
    v_changed := array_append(v_changed, 'notes');
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'notes', 'label', 'Notes', 'value_type', 'notes',
      'old_value', to_jsonb(v_req.notes), 'new_value', to_jsonb(v_notes)));
  end if;

  -- 9. Stand the trigger's contentless row down for THIS transaction only, then
  --    apply everything in one statement. Order matters: the flag must be set
  --    before the UPDATE fires the AFTER trigger.
  perform set_config('boe.clarification_response', '1', true);

  update public.order_requests
     set client_name         = v_client,
         assigned_to         = v_assignee,
         confirm_date        = p_confirm_date,
         due_date            = p_due_date,
         total_value         = p_total_value,
         total_product_value = p_total_product_value,
         lead_source         = p_lead_source,
         notes               = v_notes,
         status              = 'submitted',
         clarification_note  = null,
         updated_at          = v_now
   where id = p_order_request_id;

  -- 10. The one event that describes the whole exchange, written in the same
  --     transaction as the change it reports.
  --
  --     previous_clarification_note is stored because the live column is now
  --     NULL and the reader needs to see what was ASKED next to what was
  --     ANSWERED. It duplicates the admin's own clarification_requested row by
  --     design — that row is the question, this is the exchange — and it is the
  --     reviewer's own text, not third-party or sensitive data. No storage path,
  --     no signed URL, no token and no hidden identifier is recorded here.
  insert into public.order_request_activity
    (order_request_id, event_type, actor_id, from_status, to_status, details)
  values (
    p_order_request_id, 'clarification_responded', v_actor,
    'needs_clarification', 'submitted',
    jsonb_build_object(
      'clarification_response',      v_response,
      'previous_clarification_note', v_req.clarification_note,
      'changed_fields',              to_jsonb(v_changed),
      'changes',                     v_changes
    )
  );

  return jsonb_build_object(
    'order_request_id', v_req.id,
    'request_number',   v_req.request_number,
    'status',           'submitted',
    'updated_at',       v_now,
    'changed_fields',   to_jsonb(v_changed)
  );
end;
$$;

revoke execute on function public.respond_to_clarification(uuid, text, text, uuid, date, date, numeric, numeric, text, text) from public, anon, authenticated;
grant  execute on function public.respond_to_clarification(uuid, text, text, uuid, date, date, numeric, numeric, text, text) to authenticated;
