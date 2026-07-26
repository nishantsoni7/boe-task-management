-- Finance — the cash trail behind a payment: collection and handover.
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
--
-- Verified against the linked project's migration history
-- (`supabase migration list --linked`) on 2026-07-27: this is the ONLY pending
-- migration — every version through 20260715000000 is present both locally and
-- remotely. Its prerequisite is therefore already in place, and §4/§5 below
-- rebuild the 20260715 versions of the two functions they replace.
--
-- ── The problem ───────────────────────────────────────────────────────────────
--
-- finance_payment_requests records WHERE money landed — the
-- (payment_mode, received_in) pair the form resolves to one of four BOE
-- accounts: HDFC, Canara, Paytm, PNB. Two of those four are not accounts money
-- was transferred into at all; they are cash somebody physically carried:
--
--   Paytm  (cash, cash_in_hand)  — cash collected internally.
--   PNB    (other, other)        — cash collected through an external source.
--
-- For those two, the operational facts that matter are WHO COLLECTED THE CASH,
-- from whom, and — for an external collection — who it was later handed over to
-- and when. The handover routinely happens on a LATER DAY: a salesperson
-- collects cash because nobody authorised is available, submits the payment
-- request the same day, and hands the money over the next.
--
-- None of that had a home in the schema. It was being written as free prose into
-- `sales_note`, by two separate mechanisms in the submission form:
--
--   * a conditional "Cash / handover note" input bound to sales_note, and
--   * an automatic ' | Payment mode: PNB' suffix appended on submission.
--
-- Consequences, all of them real: the collector is not queryable, the handover
-- cannot be recorded later without rewriting someone's sentence, "has this been
-- handed over yet?" is unanswerable, and a note edit silently destroys the trail.
--
-- ── What this migration establishes ───────────────────────────────────────────
--
-- Five nullable columns holding the cash trail as structured data, and nothing
-- else. Specifically it does NOT:
--
--   * rename, re-value, drop or re-purpose payment_mode or received_in. The
--     account is still stored exactly as it always has been, and every existing
--     reader (the approval RPCs' row snapshots, Received Payments, the Orders
--     module's paymentAccountLabel) keeps working unchanged;
--   * add or change any RLS policy. The cash trail lives on the payment request
--     row and is therefore governed by that row's existing policies — the
--     submitter sees their own, an admin sees all;
--   * backfill anything. There is no reliable way to parse a collector out of a
--     free-text note, and a fabricated collector is worse than a null one. Old
--     rows keep their prose in sales_note and carry nulls here;
--   * constrain the new columns by destination. A future correction that moves a
--     payment from PNB to HDFC clears them in the same UPDATE (the client always
--     sends all five keys), and tying a CHECK to the account pair would make the
--     legacy fallback — a row whose pair matches no account — unwritable.

-- ═════════════════════════════════════════════════════════════════════════════
-- §1. The columns
-- ═════════════════════════════════════════════════════════════════════════════
-- All nullable, no defaults: every existing row stays valid, and "not recorded"
-- and "recorded as empty" are the same state rather than two.
--
-- FK shape follows this table's OWN convention exactly — `submitted_by` and
-- `approved_by` are plain `references public.users(id)` with no ON DELETE, so a
-- user who appears in a financial record cannot be deleted out from under it.
-- (finance_payment_request_activity_log uses ON DELETE SET NULL; that is an
-- audit trail, where losing the actor is preferable to blocking a deletion. This
-- is the record itself.)
--
-- handed_over_at is a DATE, not a timestamptz: the business fact is which day
-- the cash changed hands, the form collects a day, and a timestamptz would
-- invent a time nobody recorded and re-render under the reader's timezone.

alter table public.finance_payment_requests
  add column if not exists collected_by_user_id     uuid references public.users(id),
  add column if not exists collected_from_text      text,
  add column if not exists handed_over_to_user_id   uuid references public.users(id),
  add column if not exists handed_over_at           date,
  add column if not exists collection_handover_note text;

comment on column public.finance_payment_requests.handed_over_to_user_id is
  'Cash destinations only. NULL until the handover happens, which is routinely a later day than the payment. Moves in lock-step with handed_over_at (finance_payment_requests_handover_pair).';

-- ═════════════════════════════════════════════════════════════════════════════
-- §2. The one structural rule: the handover pair moves together
-- ═════════════════════════════════════════════════════════════════════════════
-- "Handed over to Nishant" with no date, or a date with nobody named, is a
-- record nobody can act on. Both null (not handed over yet) and both set (handed
-- over) are the only two meaningful states, and this states that directly so it
-- holds for a raw PATCH as well as for the form.
--
-- Deliberately NOT constrained here: that handed_over_at is on or after
-- payment_date. It is a true invariant of a handover, but as a CHECK it would
-- also refuse a later, legitimate correction of payment_date on a row that
-- already carries a handover — a real edit blocked by a rule about a different
-- field. The form states it as an inline validation message instead
-- (collectionErrorFor in src/app/finance/paymentDestinations.ts), where it can
-- be explained rather than merely refused.

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_handover_pair;

alter table public.finance_payment_requests
  add constraint finance_payment_requests_handover_pair
  check (
    (handed_over_to_user_id is null and handed_over_at is null)
    or
    (handed_over_to_user_id is not null and handed_over_at is not null)
  );

-- NO INDEXES are created on the two new user columns, deliberately. Nothing
-- queries by them: the Finance list selects them and embeds the two names by FK,
-- and no screen filters or sorts on "cash collected by X" or "handed over to me".
-- The table's own convention already says this — `submitted_by` is indexed
-- because the list filters on it, `approved_by` is not indexed because nothing
-- does. An index for a screen that does not exist is a write cost with no reader;
-- add one alongside the query that needs it.

-- ═════════════════════════════════════════════════════════════════════════════
-- §3. Post-approval freeze — the five columns join the frozen set
-- ═════════════════════════════════════════════════════════════════════════════
-- Body is the 20260715 §5 version (itself the deployed 20260700 §2 body plus
-- payment_target_type) with the five new columns added to the comparison list.
-- Nothing else changes: admins and the service role stay exempt, and the guard
-- still only fires once the row is approved.
--
-- Why they belong in the frozen set: the cash trail is part of what an admin
-- approved. Once the money is confirmed received, a non-admin silently changing
-- who collected it — or who it was handed to — would rewrite an accountability
-- record after the fact. Correcting it after approval is an admin action, which
-- is exactly what this guard already means for every other field.

create or replace function public.finance_payment_requests_guard_approved()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- Service-role / direct SQL, and admins, are exempt.
  if v_actor is null then
    return new;
  end if;

  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return new;
  end if;

  if old.status not in ('approved_unlinked', 'approved_linked') then
    return new;
  end if;

  if new.client_name        is distinct from old.client_name
     or new.amount             is distinct from old.amount
     or new.payment_date       is distinct from old.payment_date
     or new.payment_mode       is distinct from old.payment_mode
     or new.received_in        is distinct from old.received_in
     or new.proof_note         is distinct from old.proof_note
     or new.sales_note         is distinct from old.sales_note
     or new.payment_against    is distinct from old.payment_against
     or new.payment_target_type is distinct from old.payment_target_type
     or new.status             is distinct from old.status
     or new.order_id           is distinct from old.order_id
     or new.order_number       is distinct from old.order_number
     or new.submitted_by       is distinct from old.submitted_by
     or new.approved_by        is distinct from old.approved_by
     or new.approved_at        is distinct from old.approved_at
     or new.created_at         is distinct from old.created_at
     or new.admin_note         is distinct from old.admin_note
     or new.collected_by_user_id     is distinct from old.collected_by_user_id
     or new.collected_from_text      is distinct from old.collected_from_text
     or new.handed_over_to_user_id   is distinct from old.handed_over_to_user_id
     or new.handed_over_at           is distinct from old.handed_over_at
     or new.collection_handover_note is distinct from old.collection_handover_note
  then
    raise exception 'Payment % has been approved and can no longer be edited', old.request_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- CREATE OR REPLACE preserves the live ACL; this restates the intended one so a
-- SECURITY DEFINER function can never quietly become client-callable.
revoke execute on function public.finance_payment_requests_guard_approved()
  from public, anon, authenticated;

-- The TRIGGER is deliberately NOT dropped and recreated. Its definition is
-- unchanged (before update, for each row, same function), 20260715 §5 already
-- installed it, and replacing the function body is enough to change what it
-- does. Recreating it would be churn that also removes the guard for the rest of
-- this transaction. §A of the assertions script proves it is still attached.

-- ═════════════════════════════════════════════════════════════════════════════
-- §4. Audit — two new event types
-- ═════════════════════════════════════════════════════════════════════════════
-- The list below is the DEPLOYED 20260715 §4 set plus two entries — a UNION,
-- never a retyped list, because a drop-and-recreate CHECK silently revokes
-- anything omitted and an empty table hides it until the first real write.
--
--   collection_details_updated — who collected the cash, or the collection note,
--                                changed on a pre-approval request.
--   cash_handover_recorded     — the handover itself was recorded, changed, or
--                                cleared. Separated from the above because it is
--                                the event the business actually waits for.

alter table public.finance_payment_request_activity_log
  drop constraint if exists finance_payment_request_activity_log_event_type_check;

alter table public.finance_payment_request_activity_log
  add constraint finance_payment_request_activity_log_event_type_check
  check (event_type in (
    'request_submitted',
    'order_linked',
    'order_unlinked',
    'order_link_changed',
    'order_request_linked',
    'order_request_unlinked',
    'target_changed',
    'status_changed',
    'collection_details_updated',
    'cash_handover_recorded'
  ));

-- Body is the deployed 20260715 §4 version with ONE structural change and one
-- addition.
--
-- Structural: the final `else return null` — "a plain field edit, nothing is
-- recorded" — becomes `v_event := null`, and the main INSERT is guarded on
-- v_event being non-null. Behaviour is identical for every existing caller; what
-- it buys is that the function no longer returns before reaching the new block.
--
-- Addition: a SECOND, independent insert for the cash trail. It is not another
-- branch of the if/elsif chain on purpose. The chain answers "what happened to
-- this request", one event per UPDATE; the cash trail is orthogonal to that —
-- a save can legitimately re-target a payment AND record its handover, and
-- folding the two together would mean whichever branch sorted first silently
-- swallowed the other. Two rows is the honest reading of two facts.
--
-- Noise control, three ways:
--   * it fires only when one of the five columns actually CHANGED
--     (is distinct from), so re-saving a form with the same values logs nothing;
--   * it is scoped to a row that was and still is PRE-APPROVAL, matching the
--     window in which these fields are editable at all;
--   * a handover change and a collection change in the same save produce one
--     row, not two — cash_handover_recorded wins and carries both.
--
-- Names, not just ids, are resolved into the payload at write time — SERVER
-- side, from public.users, never from anything the client sent. This function is
-- already SECURITY DEFINER, so the lookup is not a new privilege; denormalising
-- the name is the same choice order_request_number makes, for the same reason —
-- the trail has to stay readable when the row moves on. Each lookup is a scalar
-- subquery on a primary key, so a user row that is somehow absent yields NULL
-- rather than failing the UPDATE that triggered it.
--
-- Failure semantics are the existing ones and are what we want: this is an AFTER
-- trigger inside the caller's transaction, so if either insert fails the whole
-- UPDATE rolls back. There is no path that commits a payment change while
-- silently losing its audit row.
--
-- Deliberately unchanged: every existing branch, the request_submitted payload,
-- the conversion-transfer provenance payload, and the whole order_request_activity
-- block.

create or replace function public.log_finance_payment_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid  := auth.uid();
  v_event        text;
  v_payload      jsonb := '{}'::jsonb;
  v_cash_event   text;
  v_cash_payload jsonb;
  v_editable     boolean;
begin
  if (tg_op = 'INSERT') then
    v_event := 'request_submitted';
    -- Which target was chosen, and against what. Identifiers and numbers only —
    -- no amount, no proof, nothing the payment row does not already carry.
    v_payload := jsonb_build_object('payment_target_type', new.payment_target_type);
    if (new.order_request_id is not null) then
      v_payload := v_payload || jsonb_build_object(
        'order_request_id',     new.order_request_id,
        'order_request_number', new.order_request_number
      );
    end if;
    if (new.order_id is not null) then
      v_payload := v_payload || jsonb_build_object(
        'order_id',     new.order_id,
        'order_number', new.order_number
      );
    end if;

  -- Pre-approval target correction. Checked FIRST among the UPDATE branches so a
  -- two-column switch (Order Request -> Confirmed Order) reads as the single
  -- decision it was. Scoped to a row that was, and still is, in the submitter's
  -- hands, so it can never shadow an approval transition or an RPC linkage
  -- change (both of which act on approved_* rows).
  elsif (old.status in ('pending_approval', 'needs_clarification', 'rejected')
         and new.status in ('pending_approval', 'needs_clarification', 'rejected')
         and (new.payment_target_type is distinct from old.payment_target_type
              or new.order_request_id  is distinct from old.order_request_id
              or new.order_id          is distinct from old.order_id)) then
    v_event := 'target_changed';
    v_payload := jsonb_build_object(
      'from_target_type',         old.payment_target_type,
      'to_target_type',           new.payment_target_type,
      'from_order_request_id',     old.order_request_id,
      'from_order_request_number', old.order_request_number,
      'to_order_request_id',       new.order_request_id,
      'to_order_request_number',   new.order_request_number,
      'from_order_id',             old.order_id,
      'from_order_number',         old.order_number,
      'to_order_id',               new.order_id,
      'to_order_number',           new.order_number
    );
    -- A creator's edit can move the row back to pending_approval in the same
    -- statement. Recorded here rather than lost, since only one event is
    -- emitted per UPDATE.
    if (new.status is distinct from old.status) then
      v_payload := v_payload || jsonb_build_object(
        'from_status', old.status,
        'to_status',   new.status
      );
    end if;

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
    -- Conversion transfer: the payment was parked on an Order Request and this
    -- same UPDATE moved it onto the Order created from that request.
    if (old.order_request_id is not null) then
      v_payload := v_payload || jsonb_build_object(
        'from_order_request_id',     old.order_request_id,
        'from_order_request_number', old.order_request_number
      );
    end if;

  elsif (old.status = 'approved_linked' and new.status = 'approved_unlinked') then
    v_event := 'order_unlinked';
    v_payload := jsonb_build_object('order_id', old.order_id, 'order_number', old.order_number);

  -- Order-request link transitions on an approved payment: the two linkage RPCs.
  elsif (new.order_request_id is distinct from old.order_request_id) then
    if (new.order_request_id is not null) then
      v_event := 'order_request_linked';
      v_payload := jsonb_build_object(
        'order_request_id',     new.order_request_id,
        'order_request_number', new.order_request_number
      );
      if (old.order_request_id is not null) then
        v_payload := v_payload || jsonb_build_object(
          'from_order_request_id',     old.order_request_id,
          'from_order_request_number', old.order_request_number
        );
      end if;
    else
      v_event := 'order_request_unlinked';
      v_payload := jsonb_build_object(
        'order_request_id',     old.order_request_id,
        'order_request_number', old.order_request_number
      );
    end if;

  -- Any other status change: record the transition, do not infer the UI action.
  elsif (new.status is distinct from old.status) then
    v_event := 'status_changed';
    v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
    if (new.admin_note is not null) then
      v_payload := v_payload || jsonb_build_object('note', new.admin_note);
    end if;

  else
    -- No status change, no order-link change, no request-link change: a plain
    -- field edit or updated_at-only touch. Nothing is recorded HERE — the cash
    -- trail below is evaluated independently.
    v_event := null;
  end if;

  if (v_event is not null) then
    insert into public.finance_payment_request_activity_log
      (payment_request_id, actor_id, event_type, payload)
    values (new.id, v_actor, v_event, v_payload);
  end if;

  -- ── The cash trail ────────────────────────────────────────────────────────
  if (tg_op = 'UPDATE') then
    v_editable :=
      old.status in ('pending_approval', 'needs_clarification', 'rejected')
      and new.status in ('pending_approval', 'needs_clarification', 'rejected');

    if (v_editable) then
      if (new.handed_over_to_user_id is distinct from old.handed_over_to_user_id
          or new.handed_over_at      is distinct from old.handed_over_at) then
        v_cash_event := 'cash_handover_recorded';
      elsif (new.collected_by_user_id     is distinct from old.collected_by_user_id
             or new.collected_from_text      is distinct from old.collected_from_text
             or new.collection_handover_note is distinct from old.collection_handover_note) then
        v_cash_event := 'collection_details_updated';
      end if;
    end if;

    if (v_cash_event is not null) then
      -- One payload shape for both events: the full before/after of the trail,
      -- so a reader never has to correlate two rows to see what changed. Names
      -- are resolved here because a uuid in a timeline is unreadable.
      v_cash_payload := jsonb_build_object(
        'from_collected_by_id',   old.collected_by_user_id,
        'from_collected_by_name', (select u.full_name from public.users u where u.id = old.collected_by_user_id),
        'to_collected_by_id',     new.collected_by_user_id,
        'to_collected_by_name',   (select u.full_name from public.users u where u.id = new.collected_by_user_id),
        'from_collected_from',    old.collected_from_text,
        'to_collected_from',      new.collected_from_text,
        'from_handed_over_to_id',   old.handed_over_to_user_id,
        'from_handed_over_to_name', (select u.full_name from public.users u where u.id = old.handed_over_to_user_id),
        'to_handed_over_to_id',     new.handed_over_to_user_id,
        'to_handed_over_to_name',   (select u.full_name from public.users u where u.id = new.handed_over_to_user_id),
        'from_handed_over_at',    old.handed_over_at,
        'to_handed_over_at',      new.handed_over_at,
        'from_note',              old.collection_handover_note,
        'to_note',                new.collection_handover_note
      );

      insert into public.finance_payment_request_activity_log
        (payment_request_id, actor_id, event_type, payload)
      values (new.id, v_actor, v_cash_event, v_cash_payload);
    end if;
  end if;

  -- ── Request-side timeline, for the pre-approval half of the lifecycle ──────
  -- The Order Request has to show that a payment was associated with it FROM
  -- SUBMISSION, not only once Finance approved. Same payload convention the two
  -- linkage RPCs use (payment_id, request_number, amount, client_name), so one
  -- renderer covers both writers.
  if (v_event = 'request_submitted' and new.order_request_id is not null) then
    insert into public.order_request_activity
      (order_request_id, event_type, actor_id, details)
    values (
      new.order_request_id, 'payment_linked', v_actor,
      jsonb_build_object(
        'payment_id',     new.id,
        'request_number', new.request_number,
        'amount',         new.amount,
        'client_name',    new.client_name
      )
    );
  elsif (v_event = 'target_changed') then
    if (old.order_request_id is not null) then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, details)
      values (
        old.order_request_id, 'payment_unlinked', v_actor,
        jsonb_build_object(
          'payment_id',     new.id,
          'request_number', new.request_number,
          'amount',         new.amount,
          'reason',         'Payment target changed before approval'
        )
      );
    end if;
    if (new.order_request_id is not null) then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, details)
      values (
        new.order_request_id, 'payment_linked', v_actor,
        jsonb_build_object(
          'payment_id',     new.id,
          'request_number', new.request_number,
          'amount',         new.amount,
          'client_name',    new.client_name
        )
      );
    end if;
  end if;

  return null;  -- AFTER trigger; return value ignored.
end;
$$;

revoke execute on function public.log_finance_payment_request_activity()
  from public, anon, authenticated;
