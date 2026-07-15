-- Finance: harden the Payment Request activity log (Phase 2B security fix)
--
-- 20260674 populated finance_payment_request_activity_log from client-side
-- application code, gated by permissive INSERT RLS policies. A security review
-- found three problems with that approach:
--   1. Not atomic — the status update and the activity insert were two separate
--      PostgREST calls, so a mutation could commit while its log entry failed.
--   2. Fabrication — the "own insert" policy checked only actor_id = auth.uid()
--      and request ownership, NOT the event_type, so a salesperson could POST a
--      forged 'request_approved_linked' / 'request_rejected' /
--      'status_corrected_by_admin' row (any payload) onto their own request.
--   3. Direct client insert — authenticated had a table-level INSERT grant plus
--      those policies, usable outside the UI entirely.
--
-- Fix: derive every activity row from the REAL row transition inside a single
-- SECURITY DEFINER trigger that runs in the same transaction as the mutation.
--   * Atomic: if the trigger's insert fails, the business update rolls back.
--     A request can never change status without its matching event, and no
--     event can exist without a real committed transition.
--   * Trusted: actor_id is taken from auth.uid() in the trigger, never from the
--     client. event_type/payload are derived from OLD/NEW, never client-supplied.
--   * Locked down: INSERT/UPDATE/DELETE grants are revoked from authenticated
--     and anon, and both INSERT policies are dropped. No client role can insert,
--     spoof an actor, forge an event type, or create duplicate rows. SELECT
--     stays (the read-only timeline component needs it), so the two SELECT
--     policies from 20260674 remain untouched.
--
-- Scope note — ON DELETE CASCADE (defined in 20260674) is retained: the existing
-- admin Delete action (finance_payment_requests_admin_delete) hard-deletes a
-- request regardless of status, and ON DELETE RESTRICT would break it the moment
-- any request has activity (every request gets a request_submitted row on
-- creation). The deliberate consequence: DELETING A PAYMENT REQUEST ALSO
-- PERMANENTLY REMOVES ITS ACTIVITY HISTORY. The trail is append-only against
-- normal use, but not immutable against an admin deleting the parent request.
-- Making the trail survive deletion would require blocking or soft-deleting
-- requests, which is out of Phase 2B scope.
--
-- This migration touches only the Phase 2B activity log and a single trigger on
-- finance_payment_requests. It does not change any Finance mutation call site,
-- approval math, order numbering, or the proof storage design.

-- ── 1. Trigger function ───────────────────────────────────────────────────────
-- SECURITY DEFINER so it can write to the activity log even though the log's
-- INSERT grant is revoked below and RLS exposes no INSERT policy. Same pattern
-- the numbering helpers in 20260673 use. Owner (the migration role, which also
-- owns both tables) bypasses RLS, so the insert succeeds for the trigger while
-- staying impossible for every client role.

create or replace function public.log_finance_payment_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid  := auth.uid();
  v_event   text;
  v_payload jsonb := '{}'::jsonb;
begin
  if (tg_op = 'INSERT') then
    v_event := 'request_submitted';

  else
    -- Order-link transitions first (order_id may change with or without status).
    if (new.status = 'approved_linked' and old.status = 'approved_linked'
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

    -- Pure status transitions.
    elsif (new.status is distinct from old.status) then
      if (new.status = 'needs_clarification') then
        v_event := 'clarification_requested';
      elsif (old.status = 'needs_clarification' and new.status = 'pending_approval') then
        -- The submitter resubmitting vs. an admin walking the status back.
        v_event := case
          when v_actor is not null and v_actor = new.submitted_by
            then 'clarification_submitted'
          else 'status_corrected_by_admin'
        end;
      elsif (new.status = 'rejected') then
        v_event := 'request_rejected';
      elsif (new.status = 'approved_linked'
             and old.status in ('pending_approval', 'needs_clarification')) then
        v_event := 'request_approved_linked';
        v_payload := jsonb_build_object('order_id', new.order_id, 'order_number', new.order_number);
      elsif (new.status = 'approved_unlinked'
             and old.status in ('pending_approval', 'needs_clarification')) then
        v_event := 'request_approved_unlinked';
      else
        v_event := 'status_corrected_by_admin';
      end if;

      v_payload := v_payload || jsonb_build_object('from', old.status, 'to', new.status);

      -- admin_note carries the clarification/rejection/correction reason.
      if (new.admin_note is not null
          and v_event in ('clarification_requested', 'request_rejected', 'status_corrected_by_admin')) then
        v_payload := v_payload || jsonb_build_object('note', new.admin_note);
      end if;

    else
      -- No status change and no recognized order-link change: a plain field edit,
      -- an updated_at-only touch, or an order_id null-out from an order-deletion
      -- FK cascade (auth.uid() null). Nothing to record.
      return null;
    end if;
  end if;

  insert into public.finance_payment_request_activity_log
    (payment_request_id, actor_id, event_type, payload)
  values (new.id, v_actor, v_event, v_payload);

  return null;  -- AFTER trigger; return value is ignored.
end;
$$;

-- Not callable directly by any client role — only ever fired by the trigger.
revoke execute on function public.log_finance_payment_request_activity() from public, anon, authenticated;

-- ── 2. Trigger ────────────────────────────────────────────────────────────────

drop trigger if exists finance_payment_requests_log_activity on public.finance_payment_requests;

create trigger finance_payment_requests_log_activity
  after insert or update on public.finance_payment_requests
  for each row execute function public.log_finance_payment_request_activity();

-- ── 3. Remove client insert access ────────────────────────────────────────────
-- The trigger is now the only writer. Clients keep SELECT (for the read-only
-- timeline) and nothing else. Every other privilege — including the non-DML
-- Supabase defaults TRUNCATE/REFERENCES/TRIGGER — is revoked so the table is
-- strictly read-only for authenticated and anon.

revoke insert, update, delete, truncate, references, trigger
  on public.finance_payment_request_activity_log from authenticated, anon;

drop policy if exists "finance_payment_request_activity_log_own_insert"   on public.finance_payment_request_activity_log;
drop policy if exists "finance_payment_request_activity_log_admin_insert" on public.finance_payment_request_activity_log;
