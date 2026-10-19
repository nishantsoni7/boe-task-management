-- ═══════════════════════════════════════════════════════════════════════════
-- 20270322000000 — Correcting a pending payment that is already allocated
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE GAP. A payment recorded from a PI Draft (Add payment) is attached to that
-- PI by an ALLOCATION, written at entry. edit_payment_request only knew the
-- intent model: it refused such a payment (PAYMENT_EDIT_ALLOCATED), and the
-- form, finding no intent, drew it as a Suspense Entry. So the amount or date of
-- a PI payment recorded wrongly could not be corrected before it was verified.
--
-- THE CHANGE. Same function, same signature, same grants. Only an UNVERIFIED
-- payment with EXACTLY ONE active allocation is newly editable; a verified one
-- is still refused (PAYMENT_ALREADY_APPROVED) and a payment split across several
-- records is refused by name. The destination is locked to the allocation's
-- target. An allocation covering the whole payment follows a changed amount: it
-- is reversed with a reason (row kept: who, when, why) and a replacement is
-- created on the same target through allocate_payment_to_target_internal, all
-- in one transaction. The PI is locked before the payment, the project-wide order.
--
-- Everything below is the body deployed by 20261014000000 with those edits,
-- extracted by script and patched, not retyped.
--
-- ROLLBACK: re-emit the 20261014000000 body (create or replace). No data change
-- to undo; reversals already written are history and stay.

create or replace function public.edit_payment_request(
  p_payment_request_id uuid,
  p_destination     text,
  p_target_id       uuid    default null,
  p_amount          numeric default null,
  p_payment_date    date    default null,
  p_payment_mode    text    default null,
  p_proof_note      text    default null,
  p_sales_note      text    default null,
  -- ── The custody activities to ADD ──
  --
  -- NOT THE WHOLE TRAIL, AND NOT A REPLACEMENT FOR IT. A correction may add what
  -- has happened since; it can never rewrite what was already recorded, because
  -- there is no code path anywhere that updates a custody event
  -- (20261014000000 §2's immutability trigger refuses one for every role).
  -- Removing an activity is therefore possible only while it is UNSAVED, in the
  -- browser, before it has ever been sent.
  p_custody_events  jsonb   default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_dest     text := btrim(lower(coalesce(p_destination, '')));
  v_mode     text := btrim(lower(coalesce(p_payment_mode, '')));
  v_req      public.finance_payment_requests%rowtype;
  v_sub      public.order_submissions%rowtype;
  v_ord      public.orders%rowtype;
  v_client   text;
  v_target_t text;
  v_custody  jsonb;
  v_is_admin boolean;
  v_status   text;
  v_intent   uuid;
  v_pending  numeric;
  v_active   numeric;
  v_n        int;
  -- 20270322000000: a payment the PI page recorded already carries an ALLOCATION.
  v_alloc     public.finance_payment_allocations%rowtype;
  v_n_alloc   int := 0;
  v_follow    boolean := false;  -- the allocation follows the new amount
  v_old_amt   numeric;
  v_new_alloc uuid;
begin
  -- ── 1. Actor and module entry ──
  if v_actor is null then
    raise exception 'Authentication required to edit a payment request'
      using errcode = '28000';
  end if;

  if not public.module_entry_open('finance') then
    raise exception 'FINANCE_MODULE_CLOSED: the Finance module is not open to you.'
      using errcode = '42501';
  end if;

  -- ── 1b. THE TARGET'S LOCK COMES BEFORE THE PAYMENT'S (20270322000000) ──
  --
  -- allocate_payment_to_target_internal locks the PI first and the payment
  -- second, and so does the approval. A correction that re-creates an
  -- allocation takes them in the same order, or it could deadlock with an
  -- approval in flight. Read without a lock only to learn WHICH PI; every
  -- decision below is still made on the locked payment row.
  perform 1
  from public.order_submissions s
  where s.id = (
    select a.order_submission_id
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_request_id
      and a.status = 'active'
      and a.order_submission_id is not null
    limit 1
  )
  for update;

  -- ── 2. THE LOCK COMES BEFORE EVERY DECISION ──
  --
  -- Not a peek and then a lock: every rule below is read from the LOCKED row.
  -- approve_finance_payment_request takes the same lock on the same row before
  -- it re-reads the status, so an edit and an approval racing the same request
  -- serialize on this line. Whichever arrives second sees what the first
  -- committed and refuses by name — it cannot decide on a row it read earlier.
  select * into v_req
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: that payment request no longer exists.'
      using errcode = 'P0002';
  end if;

  -- ── 3. Approved money is not editable, and that is the race's answer ──
  if v_req.status in ('approved_linked', 'approved_unlinked') then
    raise exception
      'PAYMENT_ALREADY_APPROVED: payment % has been verified and can no longer be changed here.',
      v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.status not in ('pending_approval', 'needs_clarification', 'rejected') then
    raise exception 'PAYMENT_NOT_EDITABLE: payment % is % and cannot be corrected.',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- ── 4. The existing edit permission: the submitter, or an admin ──
  select exists (
    select 1 from public.users u where u.id = v_actor and u.role = 'admin'
  ) into v_is_admin;

  if not v_is_admin and v_req.submitted_by is distinct from v_actor then
    raise exception
      'PAYMENT_EDIT_NOT_PERMITTED: only the person who submitted this request, or an admin, may correct it.'
      using errcode = '42501';
  end if;

  -- ── 5. The shape of the correction ──
  if v_dest not in ('pi_draft', 'confirmed_order', 'suspense') then
    raise exception
      'PAYMENT_DESTINATION_INVALID: choose PI Draft, Confirmed Order or Suspense Entry.'
      using errcode = 'P0001';
  end if;

  if v_dest = 'suspense' then
    if p_target_id is not null then
      raise exception
        'PAYMENT_TARGET_FORBIDDEN: a Suspense Entry names no PI Draft and no Order.'
        using errcode = 'P0001';
    end if;
  elsif p_target_id is null then
    raise exception
      'PAYMENT_TARGET_REQUIRED: choose the PI Draft or Order this payment is for.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'PAYMENT_AMOUNT_INVALID: enter a positive amount in rupees and paise.'
      using errcode = 'P0001';
  end if;

  if p_payment_date is null then
    raise exception 'PAYMENT_DATE_REQUIRED: enter the date the payment was received.'
      using errcode = 'P0001';
  end if;

  -- THE FOUR CURRENT ACCOUNTS (20261014000000 §1). A correction may not put a
  -- retired mode back onto a payment; a row that already carries one and is
  -- corrected in some other respect keeps it, which is what
  -- finance_payment_requests_enforce_current_payment_mode allows and this agrees
  -- with — a legacy row is re-saved through the form under one of the four.
  if not public.payment_mode_is_current(v_mode) then
    raise exception
      'PAYMENT_MODE_INVALID: choose HDFC, PNB, Paytm or Canara.'
      using errcode = 'P0001';
  end if;

  -- ── 5b. A PAYMENT THAT ALREADY CARRIES AN ALLOCATION (20270322000000) ──
  --
  -- The PI page's Add payment (record_pi_submission_payment) and Record Payment
  -- write an ALLOCATION at entry, not an intent. This function used to refuse
  -- every such payment (PAYMENT_EDIT_ALLOCATED, below), so a wrong amount or date
  -- on a payment recorded from a PI could not be corrected at all.
  --
  -- WHAT IS ALLOWED, and nothing wider:
  --   * exactly ONE active allocation. A payment split across several records
  --     is refused by name: which part is wrong is a decision for Correct
  --     Allocation, not for an amount field.
  --   * the DESTINATION IS LOCKED. The correction must name the PI or Order the
  --     allocation already names; moving the money is Correct Allocation's job.
  --   * an allocation that covers the WHOLE payment follows a changed amount: it
  --     is REVERSED with a reason (the row is kept, with who and when) and a new
  --     allocation for the new amount is created on the SAME target, in this
  --     transaction. An allocation is immutable by design, so there is no other
  --     way to change its amount.
  --   * a PARTIAL allocation stays as it is; the amount may not fall below it.
  --   * the payment is still unverified (status checked above), so no verified
  --     money moves and no Order's gate is touched.
  select count(*) into v_n_alloc
  from public.finance_payment_allocations a
  where a.payment_request_id = p_payment_request_id and a.status = 'active';

  if v_n_alloc > 1 then
    raise exception
      'PAYMENT_EDIT_SPLIT_ALLOCATED: payment % is split across more than one PI or Order, so it cannot be corrected here. Ask Finance to correct its allocations first.',
      v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_n_alloc = 1 then
    select * into v_alloc
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_request_id and a.status = 'active'
    for update;

    if v_dest is distinct from (case when v_alloc.order_submission_id is not null then 'pi_draft' else 'confirmed_order' end)
       or p_target_id is distinct from coalesce(v_alloc.order_submission_id, v_alloc.order_id)
    then
      raise exception
        'PAYMENT_EDIT_DESTINATION_LOCKED: payment % is already attached to its PI or Order; to move it, ask Finance to correct the allocation.',
        v_req.request_number
        using errcode = 'P0001';
    end if;

    v_old_amt := v_req.amount;
    v_follow  := v_alloc.allocated_amount = v_old_amt and p_amount is distinct from v_old_amt;

    if not v_follow and p_amount < v_alloc.allocated_amount then
      raise exception
        'PAYMENT_BELOW_ALLOCATED: payment % cannot be reduced to % — % is already allocated.',
        v_req.request_number, p_amount, v_alloc.allocated_amount
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 6. Resolve the target, and with it the customer ──
  --
  -- The SAME eligibility rules §3 applies at submission, applied again to the
  -- record that is being moved TO. A correction onto a converted PI or a
  -- cancelled Order is refused here rather than days later at approval.
  if v_n_alloc = 1 then
    -- Destination locked: the customer stays exactly as it is on the payment.
    v_client   := v_req.client_name;
    v_target_t := null;

  elsif v_dest = 'pi_draft' then
    select * into v_sub from public.order_submissions where id = p_target_id;
    if not found then
      raise exception 'PAYMENT_TARGET_NOT_FOUND: that PI Draft no longer exists.'
        using errcode = 'P0002';
    end if;
    if v_sub.status = 'rejected' then
      raise exception 'PAYMENT_TARGET_NOT_ACTIVE: a rejected PI Draft cannot receive a payment.'
        using errcode = 'P0001';
    end if;
    if v_sub.order_id is not null then
      raise exception
        'PAYMENT_TARGET_CONVERTED: that PI has been approved and is now an Order. Choose the Order instead.'
        using errcode = 'P0001';
    end if;
    v_client   := nullif(btrim(coalesce(v_sub.client_name, '')), '');
    v_target_t := 'pi_draft';
    if v_client is null then
      raise exception
        'PAYMENT_TARGET_NO_CLIENT: that PI Draft has no customer on file. Correct the PI before pointing a payment at it.'
        using errcode = 'P0001';
    end if;

  elsif v_dest = 'confirmed_order' then
    select * into v_ord from public.orders where id = p_target_id;
    if not found then
      raise exception 'PAYMENT_TARGET_NOT_FOUND: that Order no longer exists.'
        using errcode = 'P0002';
    end if;
    if v_ord.status = 'cancelled' then
      raise exception 'PAYMENT_TARGET_NOT_ACTIVE: Order % is cancelled and cannot receive a payment.',
        v_ord.display_number using errcode = 'P0001';
    end if;
    v_client   := nullif(btrim(coalesce(v_ord.client_name, '')), '');
    v_target_t := 'confirmed_order';
    if v_client is null then
      raise exception
        'PAYMENT_TARGET_NO_CLIENT: that Order has no customer on file. Correct it on the Order Details page first.'
        using errcode = 'P0001';
    end if;

  else
    -- SUSPENSE. The customer goes back to NULL, because the record it was read
    -- from is no longer this payment's destination. Keeping the old name would
    -- leave the payment claiming a customer it is no longer for.
    v_client   := null;
    v_target_t := null;
  end if;

  -- ── 7. Re-applying, exactly as the form did it ──
  --
  -- A submitter correcting a request that was sent back or rejected is
  -- resubmitting it. An ADMIN correcting somebody else's does not silently
  -- resubmit on their behalf — the same distinction the form drew.
  v_status := v_req.status;
  if v_req.status in ('needs_clarification', 'rejected')
     and v_req.submitted_by = v_actor then
    v_status := 'pending_approval';
  end if;

  -- ── 8. The payment row ──
  --
  -- WHAT IS DELIBERATELY ABSENT: order_id, order_number, order_request_id,
  -- order_request_number, received_in, submitted_by, request_number, approved_by
  -- and approved_at. The linkage columns are provenance since 20261012000000 and
  -- an edit does not start writing money into them; received_in has no form
  -- asking for it and nothing to fabricate; the rest are not a correction's to
  -- make.
  --
  -- AND THE FIVE LEGACY CASH COLUMNS (20261014000000 §2). 20261013000000 wrote
  -- them here, clearing all five whenever the mode was not Cash. That is exactly
  -- the behaviour a custody trail must not have: correcting a PNB request to
  -- Paytm, or to a bank account, would silently destroy the record of who had
  -- physically been holding the money. They are HISTORY now — read by the same
  -- trail component, written by nothing — so this leaves them precisely as it
  -- found them, and new activities go to finance_payment_custody_events.
  if v_follow then
    -- Reversed BEFORE the amount changes: the payment's amount guard refuses an
    -- amount below what is still actively allocated.
    update public.finance_payment_allocations
       set status          = 'reversed',
           reversal_reason = format(
             'Payment corrected before verification: %s changed to %s.', v_old_amt, p_amount)
     where id = v_alloc.id;
  end if;

  update public.finance_payment_requests
     set client_name              = v_client,
         amount                   = p_amount,
         payment_date             = p_payment_date,
         payment_mode             = v_mode,
         proof_note               = nullif(btrim(coalesce(p_proof_note, '')), ''),
         sales_note               = nullif(btrim(coalesce(p_sales_note, '')), ''),
         status                   = v_status,
         updated_at               = now()
   where id = p_payment_request_id;

  -- The replacement allocation, on the SAME target, through the one shared
  -- implementation (eligibility, capacity and provenance are decided there). The
  -- payment already carries the new amount and the old allocation is reversed,
  -- so the capacity is clear.
  if v_follow then
    v_new_alloc := (public.allocate_payment_to_target_internal(
      p_payment_request_id, v_alloc.order_submission_id, v_alloc.order_id, p_amount)
      ->> 'allocation_id')::uuid;
  end if;

  -- ── 9. The intent, reconciled in the same transaction ──
  --
  -- CANCEL FIRST, THEN PLACE. Cancelling every pending intent that is not the
  -- new target is what makes each transition below one rule rather than six:
  --
  --   PI → another PI          the old intent is cancelled, the new one placed
  --   PI → Confirmed Order     the old intent is cancelled, the new one placed
  --   Order → PI               the old intent is cancelled, the new one placed
  --   PI / Order → Suspense    every intent is cancelled, none is placed
  --   Suspense → PI / Order    there was none to cancel; one is placed
  --   Suspense → Suspense      nothing to cancel, nothing to place
  --   the SAME target again    nothing matches the cancel, the amount is
  --                            updated in place — so a repeated identical
  --                            correction is a no-op and leaves one row
  --
  -- CANCELLED, NOT DELETED. §6 already treats a cancelled intent as the audit
  -- record of an intention that did not happen; a correction is the same kind
  -- of event as a rejection and is kept the same way.
  if v_n_alloc = 0 then
  update public.finance_payment_allocation_intents
     set status           = 'cancelled',
         cancelled_at     = now(),
         cancelled_reason = 'destination_changed'
   where payment_request_id = p_payment_request_id
     and status = 'pending'
     and (
       v_target_t is null
       or target_type is distinct from v_target_t
       or coalesce(order_submission_id, order_id) is distinct from p_target_id
     );

  if v_target_t is not null then
    -- The survivor, if the target did not change. The UPDATE re-fires the
    -- capacity trigger, which re-reads the payment amount THIS FUNCTION JUST
    -- WROTE — so lowering the amount below what is intended is refused here,
    -- by the rule that already owns that arithmetic.
    update public.finance_payment_allocation_intents
       set intended_amount = p_amount
     where payment_request_id = p_payment_request_id
       and status = 'pending'
       and target_type = v_target_t
       and coalesce(order_submission_id, order_id) = p_target_id
    returning id into v_intent;

    if v_intent is null then
      insert into public.finance_payment_allocation_intents
        (payment_request_id, target_type, order_submission_id, order_id,
         intended_amount, created_by)
      values
        (p_payment_request_id, v_target_t,
         case when v_target_t = 'pi_draft'        then p_target_id end,
         case when v_target_t = 'confirmed_order' then p_target_id end,
         p_amount, v_actor)
      returning id into v_intent;
    end if;
  end if;

  end if; -- v_n_alloc = 0: an allocated payment holds no intent to reconcile

  -- ── 10. Post-conditions, re-derived from the tables ──
  --
  -- Not a restatement of what the code above intended to do: a read of what it
  -- actually left behind. All three roll the whole correction back.
  select count(*) into v_n
  from public.finance_payment_allocation_intents
  where payment_request_id = p_payment_request_id and status = 'pending';

  if v_n > 1 then
    raise exception 'PAYMENT_EDIT_DUPLICATE_INTENT: this correction left % pending intents on one request', v_n
      using errcode = 'P0001';
  end if;
  if v_target_t is null and v_n_alloc = 0 and v_n <> 0 then
    raise exception 'PAYMENT_EDIT_SUSPENSE_INTENT: a Suspense Entry must hold no pending intent'
      using errcode = 'P0001';
  end if;
  if v_target_t is not null and v_n <> 1 then
    raise exception 'PAYMENT_EDIT_MISSING_INTENT: a targeted request must hold exactly one pending intent'
      using errcode = 'P0001';
  end if;

  -- AN EDIT ALLOCATES NOTHING. An unapproved payment has no active allocation
  -- before this runs and must have none after it; only approval converts.
  select coalesce(sum(a.allocated_amount), 0) into v_active
  from public.finance_payment_allocations a
  where a.payment_request_id = p_payment_request_id and a.status = 'active';

  if v_n_alloc = 0 and v_active <> 0 then
    raise exception
      'PAYMENT_EDIT_ALLOCATED: correcting a request must not attach money (found % allocated)', v_active
      using errcode = 'P0001';
  end if;

  -- An allocated payment ends with the SAME single allocation it began with, or
  -- with its replacement for the new amount: never more, never less.
  if v_n_alloc = 1 then
    select count(*), coalesce(sum(a.allocated_amount), 0) into v_n, v_active
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_request_id and a.status = 'active';

    if v_n <> 1
       or v_active <> (case when v_follow then p_amount else v_alloc.allocated_amount end)
    then
      raise exception
        'PAYMENT_EDIT_ALLOCATION_MISMATCH: payment % ended with % active allocation(s) totalling %',
        v_req.request_number, v_n, v_active
        using errcode = 'P0001';
    end if;
  end if;

  select coalesce(sum(i.intended_amount), 0) into v_pending
  from public.finance_payment_allocation_intents i
  where i.payment_request_id = p_payment_request_id and i.status = 'pending';

  if v_pending > p_amount then
    raise exception
      'INTENT_EXCEEDS_PAYMENT: this request now intends % against an amount of %', v_pending, p_amount
      using errcode = 'P0001';
  end if;

  -- ── 11. The custody activities this correction ADDS ──
  --
  -- LAST, and after every post-condition, for the same reason the conversion is
  -- last in approval: the events describe the payment as it now stands, and the
  -- mode they are stamped with is the one this function has just written. A
  -- request corrected from PNB to Paytm stamps the new activities Paytm and
  -- leaves the earlier ones saying PNB, which is what actually happened.
  --
  -- A CORRECTION AWAY FROM PNB/PAYTM IS NOT AN ERROR AND DELETES NOTHING. The
  -- internal door refuses new events on a mode nobody carries, so a form that
  -- still had rows in hand is told; the events already saved are untouched and
  -- stay visible as the history of a payment that used to be carried.
  if p_custody_events is not null and jsonb_typeof(p_custody_events) = 'array'
     and jsonb_array_length(p_custody_events) > 0 then
    v_custody := public.append_payment_custody_events_internal(
      p_payment_request_id, p_custody_events, v_actor);
  else
    v_custody := jsonb_build_object('appended', 0, 'requested', 0);
  end if;

  return jsonb_build_object(
    'payment_request_id', p_payment_request_id,
    'request_number',     v_req.request_number,
    'destination',        v_dest,
    'client_name',        v_client,
    'status',             v_status,
    'intent_id',          v_intent,
    'pending_intents',    v_n,
    'allocation_created', v_follow,
    'allocation_id',      v_new_alloc,
    'custody_events',     v_custody
  );
end $$;

comment on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb) is
  'Corrects a pending payment request, destination included, moving the row and its allocation intent in one transaction (20261013000000). Since 20270322000000 it also corrects an unverified payment that already carries exactly one allocation (a payment recorded from a PI): the destination is locked, the other fields change, and an allocation covering the whole payment is reversed with a reason and re-created for the new amount on the same target, in one transaction; a payment split across several records is refused by name. Locks the PI before the payment. A verified payment is still refused. Permission: the submitter, or an admin. Since 20261014000000 it also APPENDS custody activities and never rewrites one.';

revoke execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)
  from public, anon;
grant execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)
  to authenticated;

-- ── Assertion: the DEPLOYED body carries the new rules and the grants held ──
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  where p.oid = to_regprocedure('public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)');
  if v_def is null
     or v_def not like '%PAYMENT_EDIT_SPLIT_ALLOCATED%'
     or v_def not like '%PAYMENT_EDIT_DESTINATION_LOCKED%'
     or v_def not like '%allocate_payment_to_target_internal%'
     or v_def not like '%PAYMENT_ALREADY_APPROVED%'
  then
    raise exception 'edit_payment_request does not carry the allocated-payment correction';
  end if;
  if not has_function_privilege('authenticated', 'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)', 'execute')
  then
    raise exception 'edit_payment_request grants are wrong';
  end if;
end $$;
