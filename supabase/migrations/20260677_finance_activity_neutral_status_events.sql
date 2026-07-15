-- Finance Phase 2B: use neutral status_changed for ambiguous transitions.
--
-- 20260675 derived a specific event type from every status transition. Review
-- found that a single database transition does not always prove which UI action
-- caused it:
--   * An admin using the "Correct Status" tool to move a request to
--     needs_clarification produced the same transition as the guided review's
--     "request clarification" action, and was mislabelled clarification_requested.
--   * When the admin is also the submitter, needs_clarification -> pending_approval
--     could be mislabelled clarification_submitted even though the correction tool
--     (not a genuine resubmission) caused it.
--
-- Fix: record the transition honestly rather than guessing intent. Specific event
-- types are kept ONLY where the transition uniquely establishes the action:
--   request_submitted   -> the row was first inserted
--   order_linked        -> approved_unlinked  -> approved_linked
--   order_unlinked      -> approved_linked    -> approved_unlinked
--   order_link_changed  -> approved_linked, order_id changed
-- Every other status transition (approval, rejection, clarification request or
-- response, or any admin correction) is recorded as the neutral status_changed
-- with { from_status, to_status, note? }. If a trusted, transactional action
-- context is added in a later phase, more specific labels can be reintroduced,
-- but this phase does not add an RPC layer merely to preserve descriptive labels.
--
-- Assumes 20260676 has removed the pre-existing test rows that used the retired
-- event types, so the tightened CHECK constraint validates cleanly.

-- ── 1. Redefine the trigger function ──────────────────────────────────────────
-- search_path is pinned (public, pg_temp) and every reference is schema-qualified
-- so a SECURITY DEFINER call can't be redirected via a shadowing object.

create or replace function public.log_finance_payment_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid  := auth.uid();
  v_event   text;
  v_payload jsonb := '{}'::jsonb;
begin
  if (tg_op = 'INSERT') then
    v_event := 'request_submitted';

  -- order_id transitions that uniquely prove a link action.
  elsif (new.status = 'approved_linked' and old.status = 'approved_linked'
         and new.order_id is distinct from old.order_id) then
    v_event := 'order_link_changed';
    v_payload := jsonb_build_object(
      'from_order_id',     old.order_id,
      'from_order_number', old.order_number,
      'to_order_id',       new.order_id,
      'to_order_number',   new.order_number
    );

  elsif (old.status = 'approved_unlinked' and new.status = 'approved_linked') then
    v_event := 'order_linked';
    v_payload := jsonb_build_object('order_id', new.order_id, 'order_number', new.order_number);

  elsif (old.status = 'approved_linked' and new.status = 'approved_unlinked') then
    v_event := 'order_unlinked';
    v_payload := jsonb_build_object('order_id', old.order_id, 'order_number', old.order_number);

  -- Any other status change: record the transition, do not infer the UI action.
  elsif (new.status is distinct from old.status) then
    v_event := 'status_changed';
    v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
    if (new.admin_note is not null) then
      v_payload := v_payload || jsonb_build_object('note', new.admin_note);
    end if;

  else
    -- No status change and no recognized order-link change: a plain field edit,
    -- an admin_note-only or updated_at-only touch, or an order_id null-out from an
    -- order-deletion FK cascade. Nothing is recorded.
    return null;
  end if;

  insert into public.finance_payment_request_activity_log
    (payment_request_id, actor_id, event_type, payload)
  values (new.id, v_actor, v_event, v_payload);

  return null;  -- AFTER trigger; return value ignored.
end;
$$;

-- Re-assert: not directly callable by any client role (CREATE OR REPLACE keeps
-- prior grants, but we restate it so the guarantee is visible in this migration).
revoke execute on function public.log_finance_payment_request_activity() from public, anon, authenticated;

-- ── 2. Tighten the event_type CHECK constraint ────────────────────────────────

alter table public.finance_payment_request_activity_log
  drop constraint finance_payment_request_activity_log_event_type_check;

alter table public.finance_payment_request_activity_log
  add constraint finance_payment_request_activity_log_event_type_check
  check (event_type in (
    'request_submitted',
    'order_linked',
    'order_unlinked',
    'order_link_changed',
    'status_changed'
  ));
