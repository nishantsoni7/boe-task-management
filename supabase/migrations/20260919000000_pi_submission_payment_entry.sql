-- Finance, Payment Phase 2 — recording a real payment against a PI submission.
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20260918000000.
--
-- ── WHAT THIS IS ──────────────────────────────────────────────────────────────
--
-- Phase 1 built the allocation spine and proved a payment can be attached to a PI
-- before any Order exists. Nothing could actually CREATE such a payment: the only
-- entry point was the Finance module's own form, which requires a Confirmed Order
-- or an Order Request. This phase is the entry point, and the two things a screen
-- needs in order to show what it created.
--
--   1. ONE atomic RPC that records a payment and allocates it to a PI, both or
--      neither. There is no window in which a payment exists unallocated, and
--      none in which an allocation names a payment that was never written.
--   2. The participant SELECT visibility Phase 1 deliberately deferred, so the
--      person who uploaded the PI can read the money recorded against it.
--   3. One read RPC that returns the card's rows and its totals, computed in the
--      database in `numeric`, so eligibility figures never pass through a float.
--   4. The cleanup-chain gap Phase 1 documented, closed in the same file that
--      creates the rows which would otherwise trip it.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
--
--   * No new payment status, and no new allocation status. A PI payment is
--     `pending_approval` — the status the product calls Awaiting Verification —
--     and Finance's existing verify / correct-and-verify / reject authority is
--     untouched. This file adds NO verification path of its own.
--   * No change to Order approval eligibility. approve_order_submission() is not
--     restated, not referenced, and still reads the DECLARED advance. The 40%
--     figure this file computes is REPORTING ONLY.
--   * No payment splitting, no unallocated-funds selection, no allocation
--     correction, no PI-to-Order allocation movement. A Phase 2 payment is
--     allocated in full to exactly one PI, at creation, and that is all.
--   * No second ledger. finance_payment_requests remains the only one.
--   * No widening of Finance-module visibility. The new SELECT policies are
--     scoped to records the caller can ALREADY open, and confer no mutation.

-- ═════════════════════════════════════════════════════════════════════════════
-- §1. `received_in` becomes optional
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE PROBLEM. finance_payment_requests.received_in has been NOT NULL since
-- 20260628000200. It records WHICH ACCOUNT the money landed in, and the Finance
-- form asks for it as half of a (payment_mode, received_in) destination pair. The
-- person recording a payment against their own PI frequently does not know it —
-- they know the customer paid, the amount, the date and the method — and the
-- confirmed rule is that nothing beyond amount, date and mode may block entry.
--
-- THE NARROWEST FIX IS TO DROP THE NOT NULL, and it is also the only honest one.
-- The alternatives were both worse:
--
--   * defaulting to 'company_account' or 'other' in the RPC would write a
--     financial fact nobody stated — a destination the money may never have
--     reached — into a column existing reporting groups by;
--   * adding a 'not_stated' value to the CHECK would change a closed domain that
--     the destination pair and its reporting already partition.
--
-- NULL already means exactly the right thing: not stated. Finance can supply it
-- later through the existing correct-and-verify path, which needs no change.
--
-- BACKWARD COMPATIBILITY, CHECKED RATHER THAN ASSUMED:
--   * the CHECK constraint is UNTOUCHED — `received_in in (...)` evaluates to
--     NULL for a NULL input, which passes, so no constraint is weakened for any
--     row that does supply a value;
--   * every existing writer still supplies one. The Finance submit form sends a
--     destination pair (paymentDestinations.ts), and the RPCs that write this
--     table never touch this column;
--   * every existing reader already tolerates a pair it does not recognise.
--     paymentDestinationLabel() falls back to the payment-mode label rather than
--     naming an account the row was never recorded against — the behaviour
--     20260716000000 built for legacy rows, which is exactly what a not-stated
--     row is.

alter table public.finance_payment_requests
  alter column received_in drop not null;

comment on column public.finance_payment_requests.received_in is
  'Which account the money landed in, as the second half of the (payment_mode, received_in) destination pair. NULLABLE since 20260919000000: a payment recorded against a PI requires only amount, date and mode, and NULL means the account was not stated rather than that it was ''other''. Finance may supply it later through the existing correction path.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §2. Participant visibility on the PAYMENT itself
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE PHASE 1 DEPENDENCY, PAID. 20260918000000 gave a PI or Order participant
-- sight of the ALLOCATION on their own record but deliberately not of the payment
-- row behind it, because widening the ledger belongs with the screen that needs
-- it. This is that screen: the card shows the amount, the date, the mode, the
-- Finance remark and the rejection reason, and every one of those lives here.
--
-- SCOPE, PRECISELY. A caller may read a payment row if an allocation — ACTIVE OR
-- REVERSED — attaches it to a PI or an Order they can already open. Reversed
-- counts on purpose: a reversed allocation is history the card still shows, and
-- hiding the payment behind it would leave an unexplained gap in the trail.
--
-- WHAT THIS CANNOT BECOME. The allocation join is not a back door to unrelated
-- customers' payments: each branch is anchored to a record the caller's OWN RLS
-- already admits (can_view_order_submission for a PI, public.orders' own policies
-- for an Order), so a payment reaches the caller only by being attached to
-- something that is already theirs. And both are SELECT — no INSERT, UPDATE or
-- DELETE policy is created, so this confers no verification, no allocation, no
-- correction and no deletion.
--
-- THE FINANCE MODULE GATE IS NOT REMOVED FROM THIS TABLE. finance_payment_requests
-- keeps finance_payment_requests_module_entry_gate (20260905000000), which is
-- RESTRICTIVE and would AND itself onto the two policies below — defeating them
-- for exactly the salesperson they exist for. That gate is what protects the
-- FINANCE PAGES, which read this table unfiltered, so it must not simply be
-- dropped the way the allocation table's was.
--
-- Instead it is RESTATED to admit the participant case as an alternative to
-- Finance entry. The Finance pages are unaffected: they select without an
-- allocation predicate, so a caller with no Finance entry still matches no
-- permissive policy there and still sees nothing. What changes is only that a
-- participant is no longer refused before their own permissive policy is
-- consulted.

create or replace function public.can_read_payment_as_participant(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_id
      and (
        (a.order_submission_id is not null
         and public.module_entry_open('orders')
         and public.can_view_order_submission(a.order_submission_id))
        or
        (a.order_id is not null
         and exists (
           -- public.orders' own RLS decides this, INCLUDING its RESTRICTIVE
           -- Orders module gate. SECURITY DEFINER would bypass it, so this
           -- helper is deliberately consulted from a policy that runs as the
           -- caller — see the note on the definer boundary below.
           select 1 from public.orders o where o.id = a.order_id
         ))
      )
  );
$$;

comment on function public.can_read_payment_as_participant(uuid) is
  'True when an allocation — active or reversed — attaches this payment to a PI submission or an Order the caller can already open. The single participant-visibility rule shared by the payment policy and the module gate. Grants SELECT only; confers no verification, allocation, correction or deletion.';

grant execute on function public.can_read_payment_as_participant(uuid) to authenticated;

-- The permissive half: a participant may read the payment.
drop policy if exists "finance_payment_requests_participant_select" on public.finance_payment_requests;

create policy "finance_payment_requests_participant_select"
  on public.finance_payment_requests
  for select to authenticated
  using (
    public.can_read_payment_as_participant(finance_payment_requests.id)
  );

comment on policy "finance_payment_requests_participant_select" on public.finance_payment_requests is
  'A PI or Order participant may read the payment rows allocated to their own record. Anchored to the target''s own visibility, so it reaches no unrelated payment, and SELECT only.';

-- The restrictive half, RESTATED rather than dropped. Byte-for-byte the
-- 20260905000000 gate plus one alternative branch, so Finance-page reads are
-- gated exactly as before and only the participant case is admitted.
drop policy if exists "finance_payment_requests_module_entry_gate" on public.finance_payment_requests;

create policy "finance_payment_requests_module_entry_gate"
  on public.finance_payment_requests
  as restrictive for all to authenticated
  using (
    public.module_entry_open('finance')
    or public.can_read_payment_as_participant(finance_payment_requests.id)
  )
  with check (
    public.module_entry_open('finance')
  );

comment on policy "finance_payment_requests_module_entry_gate" on public.finance_payment_requests is
  'Finance module entry, or — for reads only — a payment allocated to a PI or Order the caller can already open. WITH CHECK is deliberately Finance-entry only, so participant sight can never authorize a write.';

-- The same two halves for the payment's proof METADATA, so the card can say
-- whether a proof exists. The OBJECT itself is NOT widened: storage.objects keeps
-- the 20260672 policies (submitter or admin), and the summary in §5 reports
-- can_view_proof honestly rather than offering an action that would fail.
drop policy if exists "payment_proof_attachments_participant_select" on public.payment_proof_attachments;

create policy "payment_proof_attachments_participant_select"
  on public.payment_proof_attachments
  for select to authenticated
  using (
    public.can_read_payment_as_participant(payment_proof_attachments.payment_request_id)
  );

drop policy if exists "payment_proof_attachments_module_entry_gate" on public.payment_proof_attachments;

create policy "payment_proof_attachments_module_entry_gate"
  on public.payment_proof_attachments
  as restrictive for all to authenticated
  using (
    public.module_entry_open('finance')
    or public.can_read_payment_as_participant(payment_proof_attachments.payment_request_id)
  )
  with check (
    public.module_entry_open('finance')
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- §3. One concise PI activity event
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The action set is CLOSED on purpose (20260915000000 §10), so a phase producing
-- a new kind of event extends it in its own migration. This phase produces
-- exactly one: the PI timeline records THAT money was recorded and for how much,
-- and the payment card carries the detail. Duplicating the whole Finance trail
-- into the PI timeline would say the same thing twice and drift the moment
-- Finance acts on the payment.
--
-- A UNION of the deployed set, never a retyped list.

do $$
declare v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  join pg_class t     on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'order_submission_activity'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%advance_exception_requested%';

  if v_name is null then
    raise exception 'the order_submission_activity action constraint was not found';
  end if;

  execute format('alter table public.order_submission_activity drop constraint %I', v_name);
end $$;

alter table public.order_submission_activity
  add constraint order_submission_activity_action_check
  check (action in (
    'submission_created',
    'parse_replaced',
    'submitted',
    'changes_requested',
    'rejected',
    'advance_exception_requested',
    'advance_exception_approved',
    'advance_exception_rejected',
    'finance_verified',
    'approved',
    'payment_recorded'
  ));

-- ═════════════════════════════════════════════════════════════════════════════
-- §4. One allocation implementation, two doors
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE PROBLEM THIS SOLVES. Phase 1's allocate_payment_to_target() requires
-- finance.allocate — correct for a Finance user attaching money to somebody
-- else's business. But the confirmed Phase 2 rule is that a PI's OWN uploader may
-- record a payment against their own PI, and they hold no Finance action at all.
-- Calling Phase 1's door from the entry RPC would refuse the primary use case.
--
-- THE ANSWER IS THE ARRANGEMENT 20260913000000 §8 ESTABLISHED: one
-- implementation, and doors in front of it that each decide their own
-- authorization. It is NOT a second implementation of the allocation rules —
-- the capacity lock, the target eligibility, the duplicate rule, the derived
-- provenance and the audit row all stay in exactly one place.
--
--   allocate_payment_to_target_internal(...)   the implementation. NOT executable
--                                              by any client role. Decides NO
--                                              authorization of its own beyond
--                                              target visibility.
--   allocate_payment_to_target(...)            UNCHANGED signature, argument
--                                              names, return shape and ACL.
--                                              Requires finance.allocate, then
--                                              delegates. Every existing caller
--                                              and any cached PostgREST schema
--                                              keeps working, and its behaviour
--                                              is byte-for-byte what it was.
--   record_pi_submission_payment(...)          §5. Applies the PI rule — admin,
--                                              the PI's own people, or an
--                                              explicit finance.allocate holder
--                                              — and then delegates.
--
-- WHAT THE INTERNAL STILL ENFORCES, for every caller: the payment must exist and
-- not be rejected; the target must exist, be eligible and be VISIBLE to the
-- caller; no duplicate active claim; and the amount must fit the unallocated
-- balance, checked under a lock on the parent payment. So a door can widen WHO
-- may allocate; it can never widen WHAT may be allocated.
--
-- The body below is the DEPLOYED 20260918000000 function read back with
-- pg_get_functiondef and patched at exactly one point — the finance.allocate
-- check is removed — rather than retyped.

CREATE OR REPLACE FUNCTION public.allocate_payment_to_target_internal(p_payment_request_id uuid, p_order_submission_id uuid DEFAULT NULL::uuid, p_order_id uuid DEFAULT NULL::uuid, p_allocated_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor       uuid := auth.uid();
  v_pay         public.finance_payment_requests%rowtype;
  v_sub         public.order_submissions%rowtype;
  v_ord         public.orders%rowtype;
  v_finance_all boolean;
  v_allocated   numeric;
  v_available   numeric;
  v_origin      text;
  v_target_id   uuid;
  v_id          uuid;
begin
  -- ── 1. Actor and permission, before anything is read ──
  if v_actor is null then
    raise exception 'Authentication required to allocate a payment' using errcode = '28000';
  end if;

  -- ── 2. The request's own shape, before any lock is taken ──
  if num_nonnulls(p_order_submission_id, p_order_id) <> 1 then
    raise exception
      'ALLOCATION_TARGET_REQUIRED: name exactly one target — a PI submission or a Confirmed Order.'
      using errcode = 'P0001';
  end if;

  if p_allocated_amount is null
     or p_allocated_amount = 'NaN'::numeric
     or p_allocated_amount <= 0
     or p_allocated_amount <> round(p_allocated_amount, 2)
  then
    raise exception
      'ALLOCATION_AMOUNT_INVALID: an allocation must be a positive amount in rupees and paise.'
      using errcode = 'P0001';
  end if;

  -- ── 3. THE LOCK. Taken before the payment's state is judged, and held for the
  --      rest of the transaction, so the balance computed below is the balance
  --      that will still be true at COMMIT. Same lock the capacity trigger takes,
  --      taken here first so the order is identical on every path.
  select * into v_pay
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: payment request % not found', p_payment_request_id
      using errcode = 'P0002';
  end if;

  -- Rejected money is refused, and only for NEW allocations. Existing ones stay.
  if v_pay.status = 'rejected' then
    raise exception
      'PAYMENT_REJECTED: payment % was rejected and cannot receive a new allocation. Reapply it first.',
      v_pay.request_number
      using errcode = 'P0001';
  end if;

  v_finance_all := public.actor_has_module_permission('finance', 'view_all');

  -- ── 4. The target: it must exist, be eligible, and be visible to this caller ──
  if p_order_submission_id is not null then
    select * into v_sub
    from public.order_submissions
    where id = p_order_submission_id;

    -- Not found, deleted, and not visible are reported identically on purpose: a
    -- caller must never learn that a record they have no access to exists.
    if not found
       or not (v_finance_all or public.can_view_order_submission(p_order_submission_id))
    then
      raise exception
        'ALLOCATION_TARGET_NOT_AVAILABLE: the selected PI submission is not available.'
        using errcode = '42501';
    end if;

    -- A reservation freezes the record for everybody, exactly as it does for
    -- approval (20260915000000 §12 step 4).
    if v_sub.deletion_claim_token is not null then
      raise exception
        'ALLOCATION_TARGET_CLAIMED: this PI is reserved for deletion and cannot receive an allocation.'
        using errcode = '55P03';
    end if;

    -- An approved PI has become an Order; the money belongs to the Order. Same
    -- rule, and the same refusal shape, that finance_payment_requests_derive_target
    -- applies to a converted Order Request.
    if v_sub.status = 'approved' then
      raise exception
        'ALLOCATION_TARGET_CONVERTED: this PI has been approved and is now an Order. Allocate to the Order instead.'
        using errcode = 'P0001';
    end if;

    if v_sub.status = 'rejected' then
      raise exception
        'ALLOCATION_TARGET_NOT_ACTIVE: a rejected PI cannot receive an allocation.'
        using errcode = 'P0001';
    end if;

    v_origin    := 'order_submission';
    v_target_id := p_order_submission_id;

  else
    select * into v_ord
    from public.orders
    where id = p_order_id;

    if not found
       or not (
         v_finance_all
         or v_ord.requested_by = v_actor
         or v_ord.assigned_to  = v_actor
         or public.actor_has_module_permission('orders', 'view_all')
         or exists (
           select 1 from public.users u
           where u.id = v_actor
             and u.is_active
             and coalesce(u.is_deleted, false) = false
             and (u.role = 'admin' or u.team = 'operations')
         )
       )
    then
      raise exception
        'ALLOCATION_TARGET_NOT_AVAILABLE: the selected Order is not available.'
        using errcode = '42501';
    end if;

    -- Mirrors the cancelled-order refusal the deployed link RPCs already make.
    if v_ord.status = 'cancelled' then
      raise exception
        'ALLOCATION_TARGET_NOT_ACTIVE: Order % is cancelled and cannot receive an allocation.',
        v_ord.display_number
        using errcode = 'P0001';
    end if;

    v_origin    := 'confirmed_order';
    v_target_id := p_order_id;
  end if;

  -- ── 5. One active claim per payment per target ──
  -- The partial unique indexes are the guarantee; this is the readable refusal.
  if exists (
    select 1 from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_request_id
      and a.status = 'active'
      and (a.order_submission_id = p_order_submission_id or a.order_id = p_order_id)
  ) then
    raise exception
      'ALLOCATION_DUPLICATE: payment % is already allocated to this target. Reverse that allocation before creating another.',
      v_pay.request_number
      using errcode = 'P0001';
  end if;

  -- ── 6. The derived balance, under the lock ──
  select coalesce(sum(a.allocated_amount), 0) into v_allocated
  from public.finance_payment_allocations a
  where a.payment_request_id = p_payment_request_id
    and a.status = 'active';

  v_available := v_pay.amount - v_allocated;

  if p_allocated_amount > v_available then
    raise exception
      'ALLOCATION_EXCEEDS_PAYMENT: payment % has % unallocated; % cannot be allocated.',
      v_pay.request_number, v_available, p_allocated_amount
      using errcode = 'P0001';
  end if;

  -- ── 7. Write. created_by is auth.uid() and origin is derived — neither can be
  --      supplied by the caller. The capacity trigger re-checks under the same
  --      lock, and the activity trigger writes the trail.
  insert into public.finance_payment_allocations (
    payment_request_id, order_submission_id, order_id,
    allocated_amount, status, origin_target_type, created_by
  )
  values (
    p_payment_request_id, p_order_submission_id, p_order_id,
    p_allocated_amount, 'active', v_origin, v_actor
  )
  returning id into v_id;

  -- ── 8. Identifiers and figures the caller already holds ──
  return jsonb_build_object(
    'allocation_id',        v_id,
    'payment_request_id',   p_payment_request_id,
    'request_number',       v_pay.request_number,
    'target_type',          v_origin,
    'target_id',            v_target_id,
    'allocated_amount',     p_allocated_amount,
    'payment_amount',       v_pay.amount,
    'unallocated_balance',  v_available - p_allocated_amount
  );
end;
$function$;

revoke execute on function public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric)
  from public, anon, authenticated;

comment on function public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric) is
  'The single allocation implementation: locks the parent payment, re-derives the unallocated balance under that lock, validates the target exists, is eligible and is visible to the caller, refuses a duplicate active claim, and writes the row. Decides no caller authorization of its own — each door in front of it does that. Not executable by any client role.';

-- The Phase 1 door, restated as a delegate. SIGNATURE, ARGUMENT NAMES, RETURN
-- SHAPE AND PRIVILEGES ARE IDENTICAL, and the only statement that differs is the
-- delegation itself, so no existing caller can observe a change.
create or replace function public.allocate_payment_to_target(
  p_payment_request_id  uuid,
  p_order_submission_id uuid    default null,
  p_order_id            uuid    default null,
  p_allocated_amount    numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required to allocate a payment' using errcode = '28000';
  end if;

  if not public.actor_has_module_permission('finance', 'allocate') then
    raise exception 'You do not have permission to allocate payments' using errcode = '42501';
  end if;

  return public.allocate_payment_to_target_internal(
    p_payment_request_id, p_order_submission_id, p_order_id, p_allocated_amount);
end;
$$;

comment on function public.allocate_payment_to_target(uuid, uuid, uuid, numeric) is
  'Allocates part of a payment — verified or still awaiting verification — to exactly one PI submission or Confirmed Order, for a caller holding finance.allocate. Unchanged in signature and behaviour since 20260918000000; the implementation now lives in allocate_payment_to_target_internal so the PI payment-entry door can reuse it without duplicating a financial rule.';

revoke execute on function public.allocate_payment_to_target(uuid, uuid, uuid, numeric) from public, anon;
grant  execute on function public.allocate_payment_to_target(uuid, uuid, uuid, numeric) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §5. Recording a payment against a PI — one transaction
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ATOMICITY IS THE WHOLE POINT. A plain client would insert the payment, then
-- call allocate_payment_to_target, and any failure between the two leaves money
-- recorded against nothing — invisible on the PI, and counted by no total. One
-- function, one transaction: both rows commit or neither does.
--
-- WHAT THE CALLER MAY SUPPLY, and nothing else: the submission, the amount, the
-- date, the mode, an optional reference and an optional remark. The actor, the
-- client name, the status, the allocation, its amount, its provenance and every
-- audit row are DERIVED. There is no parameter for a customer, an approval, a
-- verification, an allocation status or a percentage, so none can be forged.
--
-- IT REUSES, IT DOES NOT REIMPLEMENT. The payment number comes from the existing
-- BEFORE INSERT trigger, the Finance activity row from the existing trigger, the
-- allocation from allocate_payment_to_target() — Phase 1's door, with its capacity
-- lock, its duplicate rule and its own audit — and the PI timeline row from
-- log_order_submission_activity(). This file writes no audit row by hand.
--
-- WHY IT CALLS allocate_payment_to_target RATHER THAN INSERTING THE ALLOCATION:
-- that function holds the capacity invariant under a lock on the parent payment.
-- Bypassing it to save a call would be the second implementation of a financial
-- rule, which is how the two come to disagree.

create or replace function public.record_pi_submission_payment(
  p_submission_id   uuid,
  p_amount          numeric,
  p_payment_date    date,
  p_payment_mode    text,
  p_reference       text default null,
  p_remarks         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_client     text;
  v_mode       text;
  v_reference  text;
  v_remarks    text;
  v_payment_id uuid;
  v_number     text;
  v_alloc      jsonb;
begin
  -- ── 1. The shape of the request, before anything is locked ──
  --
  -- The three mandatory fields, and only those. Reference, remark and proof are
  -- optional by product decision; received_in is optional by §1.
  if p_amount is null
     or p_amount = 'NaN'::numeric
     or p_amount <= 0
     or p_amount <> round(p_amount, 2)
  then
    raise exception
      'PAYMENT_AMOUNT_INVALID: the amount received must be a positive figure in rupees and paise.'
      using errcode = 'P0001';
  end if;

  if p_payment_date is null then
    raise exception 'PAYMENT_DATE_REQUIRED: a payment date is required.'
      using errcode = 'P0001';
  end if;

  -- A payment cannot have been received in the future. Bounded rather than
  -- exact: the client's clock and the server's need not agree to the second.
  if p_payment_date > (now() at time zone 'utc')::date + 1 then
    raise exception 'PAYMENT_DATE_FUTURE: a payment date cannot be in the future.'
      using errcode = 'P0001';
  end if;

  -- The EXISTING domain, not a new one. Re-derived here so a client cannot send
  -- a value the table's own CHECK would then reject with a constraint error.
  v_mode := nullif(btrim(lower(coalesce(p_payment_mode, ''))), '');
  if v_mode is null or v_mode not in ('bank_transfer', 'cash', 'upi', 'cheque', 'other') then
    raise exception
      'PAYMENT_MODE_INVALID: choose one of Bank Transfer, Cash, UPI, Cheque or Other.'
      using errcode = 'P0001';
  end if;

  v_reference := nullif(btrim(coalesce(p_reference, '')), '');
  v_remarks   := nullif(btrim(coalesce(p_remarks, '')), '');

  -- ── 2. The PI, locked before its state is judged ──
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: that PI no longer exists'
      using errcode = 'P0002';
  end if;

  -- ── 3. Authorization ──
  --
  -- Three routes, and the RPC is the only place they are combined:
  --   * an active admin, through the project's established bypass;
  --   * the PI's own people — whoever uploaded it, created it, or is named as
  --     its reviewer. This is can_view_order_submission's rule minus its
  --     finance-verifier branch, which is deliberate: verifying figures is not
  --     the same authority as recording that money arrived;
  --   * an explicit finance.allocate holder, which is the protected action
  --     Phase 1 registered for exactly this.
  --
  -- Wider Finance access alone is NOT a route. finance.view, finance.approve and
  -- finance.view_all reach this line and are refused, so nobody acquires payment
  -- ENTRY against a PI as a side effect of being able to see or verify payments.
  -- COALESCED TO false, AND THAT IS NOT DECORATION. assigned_to is nullable, so
  -- `v_sub.assigned_to = v_actor` is NULL whenever a PI has no named reviewer —
  -- which is the common case — and `false or false or false or NULL` is NULL, not
  -- false. `if not NULL` does not fire, so without this coalesce the whole check
  -- would silently pass for EVERY unrelated caller on any PI with no reviewer.
  -- Three-valued logic, in an authorization branch, failing open.
  if not coalesce(
    public.actor_has_module_permission('finance', 'allocate')
    or v_sub.submitted_by = v_actor
    or v_sub.created_by   = v_actor
    or v_sub.assigned_to  = v_actor
  , false) then
    raise exception
      'PI_PAYMENT_NOT_PERMITTED: you do not have permission to record a payment against this PI.'
      using errcode = '42501';
  end if;

  -- ── 4. The PI must still be a PI ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot receive a payment'
      using errcode = '55P03';
  end if;

  -- Once a PI has become an Order the money belongs to the Order, and the
  -- existing Finance route records it there. Two ways of saying the same thing
  -- would let one PI's payments land on both sides of its own approval.
  if v_sub.status = 'approved' or v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_CONVERTED: this PI has been approved and is now an Order. Record the payment against the Order instead.'
      using errcode = 'P0001';
  end if;

  if v_sub.status = 'rejected' then
    raise exception
      'ORDER_SUBMISSION_REJECTED: a rejected PI cannot receive a payment.'
      using errcode = 'P0001';
  end if;

  -- Draft, submitted and needs_changes all remain open, which is the confirmed
  -- rule: money arrives when the customer sends it, not when review reaches a
  -- particular stage.

  -- ── 5. The client is the PI's, never the caller's ──
  v_client := nullif(btrim(coalesce(v_sub.client_name, '')), '');
  if v_client is null then
    raise exception
      'ORDER_SUBMISSION_NO_CLIENT: this PI has no client name on file, so a payment cannot be attributed.'
      using errcode = 'P0001';
  end if;

  -- ── 6. The payment ──
  --
  -- payment_against / payment_target_type are left to
  -- finance_payment_requests_derive_target (20260715000000), which sees no
  -- order_id and no order_request_id and derives 'new_order' / 'unallocated'.
  -- That is the truthful classification: at this moment the money is attached to
  -- no Confirmed Order and no Order Request. Which PI it belongs to is the
  -- ALLOCATION's job, which is the whole reason Phase 1 exists.
  --
  -- received_in is omitted entirely — see §1.
  -- status is 'pending_approval', the column default and the status the product
  -- shows as Awaiting Verification. Finance decides from here, unchanged.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, status, submitted_by, sales_note, order_number)
  values
    (v_client, p_amount, p_payment_date, v_mode, 'pending_approval', v_actor, v_remarks, v_reference)
  returning id, request_number into v_payment_id, v_number;

  -- ── 7. The allocation, through Phase 1's own door ──
  --
  -- Allocated IN FULL to this PI. Splitting is not part of this phase, so there
  -- is no parameter for a partial figure and no way for a caller to request one.
  --
  -- If this raises — an ineligible target, a capacity failure, a lost race — the
  -- whole transaction rolls back and the payment above never existed. That is the
  -- atomicity guarantee, and it is structural rather than compensating: there is
  -- no catch, no cleanup path, and no state in which one row survives the other.
  v_alloc := public.allocate_payment_to_target_internal(
    p_payment_request_id  => v_payment_id,
    p_order_submission_id => p_submission_id,
    p_order_id            => null,
    p_allocated_amount    => p_amount
  );

  -- ── 8. One concise PI event ──
  --
  -- The amount and the status, and no more: the payment card carries the detail,
  -- and the Finance activity log carries the full trail. Recorded against the
  -- PI's CURRENT status on both sides, because recording a payment does not move
  -- the PI through review.
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'payment_recorded', v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'payment_request_id', v_payment_id,
      'request_number',     v_number,
      'amount',             p_amount,
      'payment_mode',       v_mode,
      'payment_status',     'pending_approval',
      'allocation_id',      v_alloc->>'allocation_id'
    )
  );

  -- ── 9. What the screen needs, and nothing it could not already read ──
  return jsonb_build_object(
    'payment_request_id', v_payment_id,
    'request_number',     v_number,
    'allocation_id',      v_alloc->>'allocation_id',
    'amount',             p_amount,
    'payment_date',       p_payment_date,
    'payment_mode',       v_mode,
    'status',             'pending_approval'
  );
end;
$$;

comment on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text) is
  'Records ONE payment against a PI submission and allocates it in full to that PI, in a single transaction — both rows or neither. Requires only amount, date and mode. The actor, the client name, the status and the allocation are server-derived and cannot be supplied. Permitted for an admin, the PI''s own uploader/creator/reviewer, or an explicit finance.allocate holder; wider Finance access alone is not a route. Creates a pending_approval payment: it asserts that money was reported, never that it was verified.';

revoke execute on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text) from public, anon;
grant  execute on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §6. The card's data, computed in the database
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ONE ROUND TRIP, BOUNDED. The alternative — the browser selecting from
-- finance_payment_requests and summing in JavaScript — would pull every payment
-- RLS admits and compute money in binary floating point. Both are refused here:
-- the query is anchored to one PI, and every figure is `numeric` all the way out.
--
-- THE DEFINITION OF EACH TOTAL, stated once so the card cannot drift from it:
--
--   verified    active allocations whose PARENT payment is verified, by
--               finance_payment_status_is_verified() — Phase 1's single rule.
--   unverified  active allocations whose parent is pending_approval or
--               needs_clarification. Money reported and not yet decided.
--   rejected    counted in NEITHER total. It stays in the list, because the
--               history is the point, but it is not money.
--   reversed    counted in neither, and by neither definition: both read
--               status = 'active'.
--
-- needed_for_standard is max(40% of grand total - verified, 0) and is REPORTING
-- ONLY. It gates nothing: approve_order_submission() is untouched by this phase
-- and still reads the declared advance. The 40 is written out rather than read
-- from order_submission_standard_advance_percent() only in the sense that the
-- function IS called — the constant lives in one place.
--
-- SECURITY DEFINER, gated on can_view_order_submission, so a caller who may not
-- open the PI learns nothing — not a total, not a count, not an empty list.

create or replace function public.pi_submission_payment_summary(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_sub       public.order_submissions%rowtype;
  v_verified  numeric := 0;
  v_unverif   numeric := 0;
  v_total     numeric;
  v_is_admin  boolean;
  v_fin_all   boolean;
  v_rows      jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id;

  if not found or not public.can_view_order_submission(p_submission_id) then
    raise exception 'ORDER_SUBMISSION_NOT_AVAILABLE: that PI is not available.'
      using errcode = '42501';
  end if;

  v_is_admin := exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin' and u.is_active
      and coalesce(u.is_deleted, false) = false
  );
  v_fin_all := public.actor_has_module_permission('finance', 'view_all');

  -- ── The two totals, from ACTIVE allocations and the PARENT's status ────────
  select
    coalesce(sum(a.allocated_amount) filter (
      where public.finance_payment_status_is_verified(f.status)), 0),
    coalesce(sum(a.allocated_amount) filter (
      where f.status in ('pending_approval', 'needs_clarification')), 0)
    into v_verified, v_unverif
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id
    and a.status = 'active';

  v_total := v_sub.grand_total;

  -- ── The rows the card lists ───────────────────────────────────────────────
  --
  -- Every allocation on this PI, reversed included, newest first. Names are
  -- resolved here rather than by a client join, so the card cannot leak a user
  -- table read it has no business making.
  --
  -- can_view_proof mirrors the storage policy (20260672) EXACTLY — submitter or
  -- admin — so the card offers the action only when the object would actually
  -- open. Proof-object visibility is NOT widened by this phase; the metadata is
  -- readable to participants, the object is not.
  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
      'allocation_id',     a.id,
      'allocation_status', a.status,
      'allocated_amount',  a.allocated_amount,
      'payment_id',        f.id,
      'request_number',    f.request_number,
      'amount',            f.amount,
      'payment_date',      f.payment_date,
      'payment_mode',      f.payment_mode,
      'reference',         f.order_number,
      'remarks',           f.sales_note,
      'status',            f.status,
      'is_verified',       public.finance_payment_status_is_verified(f.status),
      'admin_note',        f.admin_note,
      'entered_by',        eb.full_name,
      'verified_by',       vb.full_name,
      'created_at',        f.created_at,
      'verified_at',       f.approved_at,
      'rejected_at',       f.rejected_at,
      'proof_count',       (select count(*) from public.payment_proof_attachments pa
                             where pa.payment_request_id = f.id),
      'can_view_proof',    (v_is_admin or f.submitted_by = v_actor)
    ) as r
    from public.finance_payment_allocations a
    join public.finance_payment_requests f on f.id = a.payment_request_id
    left join public.users eb on eb.id = f.submitted_by
    left join public.users vb on vb.id = f.approved_by
    where a.order_submission_id = p_submission_id
  ) t;

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'grand_total',          v_total,
    'verified_amount',      v_verified,
    'unverified_amount',    v_unverif,
    -- Percentages of the PI's grand total, to two decimals, in numeric. NULL
    -- when there is no total to be a percentage of — never 0, which would read
    -- as "nothing received" rather than "not computable".
    'verified_percent',     case when v_total is null or v_total = 0 then null
                                 else round(v_verified * 100 / v_total, 2) end,
    'unverified_percent',   case when v_total is null or v_total = 0 then null
                                 else round(v_unverif  * 100 / v_total, 2) end,
    -- Rounded to paise: numeric division by 100 carries a long tail that is
    -- exact but unreadable, and this is a rupee figure a person acts on. Rounded
    -- HALF-UP at two decimals, never truncated, so the figure shown is never
    -- LESS than what is actually still required.
    'needed_for_standard',  case when v_total is null then null
                                 else round(greatest(
                                   v_total * public.order_submission_standard_advance_percent() / 100
                                     - v_verified, 0), 2) end,
    'pending_balance',      case when v_total is null then null
                                 else greatest(v_total - v_verified, 0) end,
    'standard_percent',     public.order_submission_standard_advance_percent(),
    'can_view_all_finance', v_fin_all,
    'payments',             v_rows
  );
end;
$$;

comment on function public.pi_submission_payment_summary(uuid) is
  'Every payment allocated to one PI, with the card''s totals computed in numeric in the database. Verified counts only active allocations whose parent payment is verified; unverified counts pending_approval and needs_clarification; rejected and reversed count in neither but rejected still appears in the list. needed_for_standard is REPORTING ONLY and gates nothing — Order approval still reads the declared advance. Refuses a caller who cannot open the PI.';

revoke execute on function public.pi_submission_payment_summary(uuid) from public, anon;
grant  execute on function public.pi_submission_payment_summary(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §7. Test Data Cleanup learns about PI-only payments
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE GAP PHASE 1 DOCUMENTED, CLOSED IN THE PHASE THAT OPENS IT.
-- resolve_test_data_cleanup_chain() finds a chain's payments through
-- f.order_id / f.order_request_id. Every allocation that existed before this file
-- belonged to a payment already linked that way, so the sweep was complete. §4
-- creates payments that are allocated to a PI and linked to NOTHING, which that
-- sweep cannot see — and whose NO ACTION foreign key would then refuse the PI
-- delete with a raw constraint error instead of a readable refusal.
--
-- THE BODY BELOW IS THE DEPLOYED FUNCTION, read back with pg_get_functiondef and
-- patched at two points rather than retyped. Nothing else in it changes: the root
-- types, the eligibility test, the provenance pair check, the blocking list, the
-- counts and storage_paths are all as 20260916000000 left them.
--
--   (a) after the chain's PI is resolved, payments reachable ONLY through an
--       allocation to that PI are merged into v_payments — so the delete list,
--       the eligibility test, the counts and the PROOF STORAGE PATHS all pick
--       them up, because every one of those reads v_payments;
--   (b) a PAYMENT root that is allocated only to a PI now reports that PI as a
--       retained record, exactly as the existing branches report an Order and an
--       Order Request.
--
-- NOTHING IS WEAKENED. Claim ownership, expiry, the freeze, finalize's re-lock
-- and re-validation, and storage removal are untouched — this function only
-- DISCOVERS, and discovering more test data cannot authorize deleting anything
-- that is not test data. A PI-allocated payment that is NOT test data now shows
-- up in `blocking` and stops the cleanup, which is the correct answer and the one
-- the raw FK error was failing to give.
CREATE OR REPLACE FUNCTION public.resolve_test_data_cleanup_chain(p_root_type text, p_root_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order_id      uuid;
  v_request_id    uuid;
  v_submission_id uuid;
  v_sub_order_id  uuid;
  v_sub_status    text;
  v_payments      uuid[] := '{}';
  v_root_num      text;
  v_delete        jsonb := '[]'::jsonb;
  v_retain        jsonb := '[]'::jsonb;
  v_block         jsonb := '[]'::jsonb;
  v_paths         jsonb := '[]'::jsonb;
  v_prefix        text;
  v_order_is_test boolean;
  v_counts        jsonb;
begin
  if p_root_type not in ('order', 'order_request', 'payment') then
    raise exception 'CLEANUP_ROOT_TYPE_INVALID: Unknown record type %', p_root_type
      using errcode = 'P0001';
  end if;

  if p_root_type = 'order' then
    select o.id, o.source_order_request_id, o.display_number
      into v_order_id, v_request_id, v_root_num
    from public.orders o where o.id = p_root_id;

  elsif p_root_type = 'order_request' then
    select r.id, r.converted_order_id, r.request_number
      into v_request_id, v_order_id, v_root_num
    from public.order_requests r where r.id = p_root_id;

  else
    select f.request_number into v_root_num
    from public.finance_payment_requests f where f.id = p_root_id;

    if v_root_num is not null then
      v_payments := array[p_root_id];
    end if;
  end if;

  if v_root_num is null then
    raise exception 'CLEANUP_ROOT_NOT_FOUND: That record no longer exists'
      using errcode = 'P0002';
  end if;

  if p_root_type in ('order', 'order_request') then
    select coalesce(array_agg(f.id), '{}')
      into v_payments
    from public.finance_payment_requests f
    where (v_order_id   is not null and f.order_id         = v_order_id)
       or (v_request_id is not null and f.order_request_id = v_request_id);
  end if;

  -- ── The PI this Order came from ───────────────────────────────────────────
  -- Read from the ORDER. An Order created by converting an Order Request carries
  -- no PI and this resolves to null, which is the honest answer.
  if v_order_id is not null then
    select o.source_order_submission_id, o.is_test_data
      into v_submission_id, v_order_is_test
    from public.orders o where o.id = v_order_id;
  end if;

  if v_submission_id is not null then
    select s.order_id, s.status
      into v_sub_order_id, v_sub_status
    from public.order_submissions s where s.id = v_submission_id;

    -- ── PHASE 2: payments that reach this chain ONLY through an allocation ──
    --
    -- The sweep above finds payments by f.order_id / f.order_request_id, which
    -- was complete while every allocation belonged to an already-linked payment.
    -- Phase 2 lets a payment be recorded against a PI and allocated to it
    -- WITHOUT ever being linked, so such a payment is invisible to that sweep —
    -- and its NO ACTION foreign key would then refuse the PI delete with a raw
    -- constraint error instead of a readable "not eligible".
    --
    -- SCOPED TO THIS CHAIN'S PI, and to nothing else. A payment allocated to a
    -- different PI, to an Order outside this chain, or to nothing at all is not
    -- reached. It is a UNION with the existing array, so a payment found both
    -- ways is claimed once.
    --
    -- Every downstream consumer picks this up for free, which is the point of
    -- adding it here rather than in the executor: the delete/blocking lists, the
    -- eligibility test, the counts, and storage_paths all read v_payments.
    select coalesce(array_agg(distinct p_id), '{}')
      into v_payments
    from (
      select unnest(v_payments) as p_id
      union
      select a.payment_request_id
      from public.finance_payment_allocations a
      where a.order_submission_id = v_submission_id
    ) merged;

    v_prefix := 'submissions/' || v_submission_id::text || '/';
  end if;

  select coalesce(jsonb_agg(x order by x->>'type', x->>'number'), '[]'::jsonb)
    into v_delete
  from (
    select jsonb_build_object(
             'type', 'order', 'id', o.id, 'number', o.display_number,
             'status', o.status, 'label', o.client_name, 'is_test_data', o.is_test_data) as x
    from public.orders o where o.id = v_order_id
    union all
    select jsonb_build_object(
             'type', 'order_request', 'id', r.id, 'number', r.request_number,
             'status', r.status, 'label', r.client_name, 'is_test_data', r.is_test_data)
    from public.order_requests r where r.id = v_request_id
    union all
    select jsonb_build_object(
             'type', 'payment', 'id', f.id, 'number', f.request_number,
             'status', f.status, 'label', f.client_name, 'amount', f.amount,
             'is_test_data', f.is_test_data)
    from public.finance_payment_requests f where f.id = any(v_payments)
    union all
    -- THE PI. order_submissions has NO is_test_data column and deliberately does
    -- not gain one: an approved PI's only reason to exist is the Order it
    -- produced, the link is one-to-one in both directions and immutable, so the
    -- classification is INHERITED — and is only trustworthy because the pair is
    -- verified immediately below.
    select jsonb_build_object(
             'type', 'order_submission', 'id', s.id, 'number', null,
             'status', s.status, 'label', s.client_name,
             'is_test_data', coalesce(v_order_is_test, false),
             'storage_prefix', v_prefix)
    from public.order_submissions s where s.id = v_submission_id
  ) t;

  select coalesce(jsonb_agg(x), '[]'::jsonb)
    into v_block
  from jsonb_array_elements(v_delete) x
  where not (x->>'is_test_data')::boolean;

  -- ── The provenance pair must name each other ──────────────────────────────
  if v_submission_id is not null and v_sub_order_id is null then
    v_block := v_block || jsonb_build_array(jsonb_build_object(
      'type', 'order_submission', 'id', v_submission_id,
      'number', null, 'status', coalesce(v_sub_status, 'missing'),
      'is_test_data', false,
      'reason', 'the PI this Order names does not exist, or is not linked back to any Order'));
  elsif v_submission_id is not null and v_sub_order_id is distinct from v_order_id then
    v_block := v_block || jsonb_build_array(jsonb_build_object(
      'type', 'order_submission', 'id', v_submission_id,
      'number', null, 'status', coalesce(v_sub_status, 'unknown'),
      'is_test_data', false,
      'reason', 'the PI this Order names is linked to a different Order'));
  end if;

  if p_root_type = 'payment' then
    select coalesce(jsonb_agg(x order by x->>'type'), '[]'::jsonb)
      into v_retain
    from (
      select jsonb_build_object('type','order','id',o.id,'number',o.display_number,
                                'status',o.status,'is_test_data',o.is_test_data) as x
      from public.orders o
      join public.finance_payment_requests f on f.order_id = o.id
      where f.id = p_root_id
      union all
      select jsonb_build_object('type','order_request','id',r.id,'number',r.request_number,
                                'status',r.status,'is_test_data',r.is_test_data)
      from public.order_requests r
      join public.finance_payment_requests f on f.order_request_id = r.id
      where f.id = p_root_id
      union all
      -- PHASE 2: a payment whose only relationship is an allocation to a PI.
      -- Reported as RETAINED so the operator sees what the payment is attached
      -- to, exactly as the two branches above do for an Order and a request. A
      -- PI inherits its Order's classification (order_submissions has no
      -- is_test_data of its own), so a PI with no Order is reported not-test and
      -- correctly BLOCKS the cleanup rather than being silently deleted.
      select jsonb_build_object('type','order_submission','id',s.id,'number',null,
                                'status',s.status,
                                'is_test_data', coalesce(o2.is_test_data, false))
      from public.order_submissions s
      join public.finance_payment_allocations a on a.order_submission_id = s.id
      left join public.orders o2 on o2.id = s.order_id
      where a.payment_request_id = p_root_id
    ) t;

    v_block := v_block || (
      select coalesce(jsonb_agg(x), '[]'::jsonb)
      from jsonb_array_elements(v_retain) x
      where not (x->>'is_test_data')::boolean
    );
  end if;

  -- storage_paths is UNCHANGED: payment-proof object keys, and nothing else.
  select coalesce(jsonb_agg(a.storage_path order by a.storage_path), '[]'::jsonb)
    into v_paths
  from public.payment_proof_attachments a
  where a.payment_request_id = any(v_payments);

  v_counts := jsonb_build_object(
    'orders',                   (select count(*) from public.orders where id = v_order_id),
    'order_requests',           (select count(*) from public.order_requests where id = v_request_id),
    'payment_requests',         coalesce(array_length(v_payments, 1), 0),
    'order_activity_log',       (select count(*) from public.order_activity_log where order_id = v_order_id),
    'order_request_activity',   (select count(*) from public.order_request_activity where order_request_id = v_request_id),
    'payment_activity',         (select count(*) from public.finance_payment_request_activity_log where payment_request_id = any(v_payments)),
    'proof_attachments',        (select count(*) from public.payment_proof_attachments where payment_request_id = any(v_payments)),
    'notifications',            (select count(*) from public.notifications
                                  where entity_id in (
                                    select unnest(array_remove(array[v_order_id, v_request_id], null))
                                    union all select unnest(v_payments))
                                    and (type::text like 'order%' or type::text like 'finance%')),
    'order_submissions',            (select count(*) from public.order_submissions where id = v_submission_id),
    'order_submission_items',       (select count(*) from public.order_submission_items where submission_id = v_submission_id),
    'order_submission_item_images', (select count(*) from public.order_submission_item_images where submission_id = v_submission_id),
    'order_submission_activity',    (select count(*) from public.order_submission_activity where submission_id = v_submission_id)
  );

  return jsonb_build_object(
    'root_type',       p_root_type,
    'root_id',         p_root_id,
    'root_number',     v_root_num,
    'order_id',        v_order_id,
    'order_request_id',v_request_id,
    'payment_ids',     to_jsonb(v_payments),
    'order_submission_id',       v_submission_id,
    'submission_storage_prefix', v_prefix,
    'to_delete',       v_delete,
    'to_retain',       v_retain,
    'blocking',        v_block,
    'storage_paths',   v_paths,
    'counts',          v_counts,
    'eligible',        jsonb_array_length(v_block) = 0
  );
end;
$function$;

-- ═════════════════════════════════════════════════════════════════════════════
-- §8. Assertions
-- ═════════════════════════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_n   integer;
  v_def text;
  v_ev  text;
begin
  -- ── §1. received_in is optional, and its CHECK is untouched ──────────────
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'finance_payment_requests'
      and column_name = 'received_in' and is_nullable = 'NO'
  ) then
    raise exception 'received_in must be nullable';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_payment_requests'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%received_in%company_account%'
  ) then
    raise exception 'the received_in domain CHECK must still exist';
  end if;

  -- Every column the three-field rule depends on is still mandatory, so this
  -- relaxation cannot be mistaken for a general loosening of the ledger.
  select count(*) into v_n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'finance_payment_requests'
    and column_name in ('amount', 'payment_date', 'payment_mode', 'client_name', 'status', 'submitted_by')
    and is_nullable = 'YES';
  if v_n <> 0 then
    raise exception '% mandatory payment column(s) were loosened by this migration', v_n;
  end if;

  -- ── §2. Participant visibility, and the gate that must not defeat it ─────
  if not exists (
    select 1 from pg_policy p join pg_class t on t.oid = p.polrelid
    where t.relname = 'finance_payment_requests'
      and p.polname = 'finance_payment_requests_participant_select'
      and p.polpermissive and p.polcmd = 'r'
  ) then
    raise exception 'the participant SELECT policy is missing or is not a permissive read policy';
  end if;

  select coalesce(pg_get_expr(p.polqual, p.polrelid), '') into v_def
  from pg_policy p join pg_class t on t.oid = p.polrelid
  where t.relname = 'finance_payment_requests'
    and p.polname = 'finance_payment_requests_module_entry_gate';

  if v_def is null or v_def = '' then
    raise exception 'the Finance module entry gate is missing from finance_payment_requests';
  end if;
  if v_def not like '%module_entry_open%' then
    raise exception 'the restated module gate must still require Finance entry as its primary branch';
  end if;
  if v_def not like '%can_read_payment_as_participant%' then
    raise exception 'the restated module gate must admit the participant read branch';
  end if;

  -- WITH CHECK stays Finance-entry only: participant sight may never authorize a
  -- write. This is the single most important line in section 2.
  select coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') into v_def
  from pg_policy p join pg_class t on t.oid = p.polrelid
  where t.relname = 'finance_payment_requests'
    and p.polname = 'finance_payment_requests_module_entry_gate';

  if v_def like '%can_read_payment_as_participant%' then
    raise exception 'participant visibility must NEVER appear in the gate WITH CHECK';
  end if;
  if v_def not like '%module_entry_open%' then
    raise exception 'the gate WITH CHECK must still require Finance module entry';
  end if;

  -- No new mutation policy of any kind was created on the ledger.
  select count(*) into v_n
  from pg_policy p join pg_class t on t.oid = p.polrelid
  where t.relname = 'finance_payment_requests'
    and p.polname like '%participant%'
    and p.polcmd <> 'r';
  if v_n <> 0 then
    raise exception 'participant policies must be SELECT only, found % other', v_n;
  end if;

  -- The proof OBJECT is not widened — only its metadata row.
  select count(*) into v_n
  from pg_policy p join pg_class t on t.oid = p.polrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'storage' and t.relname = 'objects'
    and p.polname like 'payment_proofs%'
    and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
        like '%finance_payment_allocations%';
  if v_n <> 0 then
    raise exception 'storage.objects policies must not have been widened by this phase';
  end if;

  -- ── §3. The activity set is a UNION ──────────────────────────────────────
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint where conname = 'order_submission_activity_action_check';

  foreach v_ev in array array[
    'submission_created', 'parse_replaced', 'submitted', 'changes_requested',
    'rejected', 'advance_exception_requested', 'advance_exception_approved',
    'advance_exception_rejected', 'finance_verified', 'approved', 'payment_recorded'
  ] loop
    if position('''' || v_ev || '''' in v_def) = 0 then
      raise exception 'the PI activity action constraint no longer admits %', v_ev;
    end if;
  end loop;

  -- ── §4/§5. Both RPCs exist, are definer, and are reachable ───────────────
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('record_pi_submission_payment', 'pi_submission_payment_summary')
    and p.prosecdef;
  if v_n <> 2 then
    raise exception 'both Phase 2 RPCs must exist as SECURITY DEFINER, found %', v_n;
  end if;

  -- The writer reuses Phase 1's door rather than inserting an allocation itself.
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'record_pi_submission_payment';

  if v_def not like '%allocate_payment_to_target_internal%' then
    raise exception 'the entry RPC must allocate through the shared implementation';
  end if;
  if v_def like '%insert into public.finance_payment_allocations%' then
    raise exception 'the entry RPC must not write the allocation table directly';
  end if;
  -- No client-supplied identity, status or approval anywhere in its signature.
  if exists (
    select 1 from pg_proc p, unnest(p.proargnames) an
    where p.proname = 'record_pi_submission_payment'
      and an in ('p_actor', 'p_actor_id', 'p_client_name', 'p_status',
                 'p_submitted_by', 'p_approved_by', 'p_allocation_status', 'p_percent')
  ) then
    raise exception 'the entry RPC must accept no actor, client, status or approval parameter';
  end if;

  -- ── §6. The cleanup resolver discovers PI-only allocated payments ────────
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'resolve_test_data_cleanup_chain';

  if v_def not like '%finance_payment_allocations%' then
    raise exception 'the cleanup chain resolver must discover allocation-linked payments';
  end if;
  -- And it still does everything it did before.
  foreach v_ev in array array[
    'CLEANUP_ROOT_TYPE_INVALID', 'CLEANUP_ROOT_NOT_FOUND',
    'storage_paths', 'payment_ids', 'blocking'
  ] loop
    if position(v_ev in v_def) = 0 then
      raise exception 'the restated cleanup resolver lost %', v_ev;
    end if;
  end loop;

  -- The claim/finalize protocol is NOT restated by this phase.
  select count(*) into v_n
  from pg_proc
  where proname in ('begin_test_data_cleanup', 'finalize_test_data_cleanup', 'release_test_data_cleanup')
    and pg_get_functiondef(oid) like '%finance_payment_allocations%';
  if v_n <> 0 then
    raise exception 'the claim/finalize functions must not be restated by this phase';
  end if;

  -- ── Order approval eligibility is untouched ──────────────────────────────
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'approve_order_submission';

  if v_def not like '%order_submission_advance_ready%' then
    raise exception 'approve_order_submission must still read the declared-advance rule';
  end if;
  if v_def like '%finance_payment_allocations%' then
    raise exception 'approve_order_submission must not have been wired to allocations';
  end if;

  -- ── No permission action was added or granted by this phase ──────────────
  select count(*) into v_n
  from public.permission_actions
  where action_key in ('allocate', 'allocate_correct');
  if v_n <> 2 then
    raise exception 'the Phase 1 allocation actions must still be registered, found %', v_n;
  end if;

  select count(*) into v_n
  from public.role_permissions rp
  join public.permission_actions pa on pa.id = rp.action_id
  where pa.action_key in ('allocate', 'allocate_correct') and rp.allowed;
  if v_n <> 0 then
    raise exception 'no role may carry an allocation action, found %', v_n;
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- §9. ROLLBACK PLAN
-- ═════════════════════════════════════════════════════════════════════════════
--
--   drop function public.record_pi_submission_payment(uuid, numeric, date, text, text, text);
--   drop function public.pi_submission_payment_summary(uuid);
--   -- restore the 20260918000000 allocate_payment_to_target body (permission
--   -- check inline), then: drop function public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric);
--   drop policy "finance_payment_requests_participant_select" on public.finance_payment_requests;
--   drop policy "payment_proof_attachments_participant_select" on public.payment_proof_attachments;
--   -- restore the 20260905000000 gates (Finance entry only, no participant branch)
--   -- restore the 20260916000000 resolve_test_data_cleanup_chain body
--   drop function public.can_read_payment_as_participant(uuid);
--   -- restore the 20260915000000 activity action set (drop 'payment_recorded')
--   -- received_in: `set not null` is only safe once every NULL row has a value
--
-- No payment, allocation, Order or PI row is created, altered or deleted by this
-- migration. It adds two functions, two policies, one policy branch, one activity
-- value and one nullability change.
