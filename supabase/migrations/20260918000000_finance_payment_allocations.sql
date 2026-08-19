-- Finance, Payment Phase 1 — the allocation spine.
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20260917000000.
--
-- ── WHAT THIS IS ──────────────────────────────────────────────────────────────
--
-- ONE CHILD TABLE. public.finance_payment_requests remains the only payment
-- ledger in this system, and nothing here changes that: an allocation holds no
-- client, no payment mode, no proof, no destination, no bank detail and no
-- amount the payment does not already own. It records ONE fact the ledger cannot
-- express today —
--
--     how much of THIS payment is claimed by THAT piece of business
--
-- — and it is the answer to two requirements the current shape makes
-- structurally impossible:
--
--   * a payment may eventually be divided across several PIs and Orders
--     (finance_payment_requests_one_link_target, 20260698000000, permits at most
--     one link target per payment, and `amount` is a single scalar);
--   * part of a payment may remain unallocated and be assigned later (there is
--     no residual anywhere — "unallocated" today means the whole payment is
--     unlinked).
--
-- THE UNALLOCATED BALANCE IS NEVER STORED. It is
--
--     finance_payment_requests.amount
--       - sum(finance_payment_allocations.allocated_amount) where status='active'
--
-- and it is derived at every read. A stored balance is a second fact that can
-- disagree with the first the moment anything writes one and not the other; the
-- capacity trigger in section 5 is what makes the derived figure trustworthy,
-- because it is the only thing that has to hold.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
--   * No second payment ledger. See above.
--   * No new payment status, and no allocation status pair either.
--     `pending_approval` remains the internal status for a payment awaiting
--     verification, and an ALLOCATION never records verification at all — that
--     is the parent payment's status, read through
--     finance_payment_status_is_verified() (section 5b). An unverified payment
--     may be allocated: Sales records the money, the payment and its allocation
--     read as Awaiting Verification, and Finance decides afterwards. Adding a sixth value would break the
--     exhaustiveness the two Finance pages rely on (REQUEST_STAGE_STATUSES and
--     CONFIRMED_PAYMENT_STATUSES in src/app/finance/paymentRouting.ts partition
--     the domain, and their tests assert it) and five deployed CHECK
--     constraints. "Awaiting Verification" is a label, not a state.
--   * No new value on payment_target_type. That column classifies the PARENT
--     PAYMENT's submission target and is frozen once the payment is approved;
--     PI targeting lives on the allocation, which is where a payment can name
--     more than one thing at once. order_submission is NOT added to it.
--   * No change to order_id, order_number, order_request_id, order_request_number
--     or payment_target_type — not one column is dropped, renamed, re-purposed
--     or re-derived. Every existing read keeps working unchanged.
--   * No change to Order approval eligibility. approve_order_submission() still
--     gates on the DECLARED advance (order_submission_advance_ready, Phase B),
--     and this file does not restate it, reference it, or write a single column
--     it reads. Payment does not gate approval yet.
--   * No PI-to-Order allocation movement. Order creation from a PI is outside
--     this phase, so there is no move event and no move path — see the note on
--     the transition guard in section 6.
--   * No UI, no payment-entry path against a PI (that is Phase 2), no proof
--     change, no Debit Note, no refund, no cancellation work.
--
-- ── ORDER OF OPERATIONS, AND WHY ──────────────────────────────────────────────
--
-- The table and its constraints are created FIRST, the backfill runs SECOND, and
-- every trigger is attached THIRD. That ordering is deliberate and load-bearing:
--
--   * stamp_test_data_flag() would overwrite is_test_data on every backfilled
--     row with the CURRENT cleanup setting, re-classifying historical records by
--     when this migration happened to run. The backfill instead copies the
--     parent payment's own flag, which is the truthful answer.
--   * the activity trigger would write an `allocation_created` audit row for
--     every backfilled allocation, claiming somebody made a decision today about
--     money that was linked months ago.
--
-- The backfill's own invariants are proved by the assertions in section 12
-- instead, which is the stronger check anyway: it reads the committed result.

-- ═════════════════════════════════════════════════════════════════════════════
-- §1. The table
-- ═════════════════════════════════════════════════════════════════════════════
--
-- allocated_amount is PLAIN `numeric`, not numeric(12,2), for the reason
-- 20260913000000 and 20260917000000 both record: a constrained scale silently
-- ROUNDS 1250.005 to 1250.01 and stores a figure nobody typed. Plain numeric
-- plus the scale CHECK below REFUSES it instead, for every caller including
-- direct SQL and the service role.
--
-- FK DELETION BEHAVIOUR IS `NO ACTION` ON ALL THREE PARENTS — the default, and
-- deliberately not CASCADE. The same choice, for the same reason, that
-- 20260915000000 §2 made for orders.source_order_submission_id: financial history
-- must not disappear as a side effect of somebody calling a deletion path.
--
--   * an active or reversed allocation REFUSES deletion of its PI or its Order,
--     for every role including the service role, because PostgreSQL will not let
--     a referenced row go while a referencing row names it;
--   * the parent PAYMENT is different, and section 8a is why: an UNVERIFIED
--     payment is a mistake rather than an event and has always been deletable
--     (20260700000000 / 20260705000000), so its allocations are released with it
--     by an explicit BEFORE DELETE trigger rather than by a blind cascade. A
--     VERIFIED payment is still undeletable, so its allocations can never go.

create table public.finance_payment_allocations (
  id uuid primary key default gen_random_uuid(),

  -- The payment this allocation spends part of. The ledger row is the money;
  -- this is a claim against it.
  payment_request_id uuid not null
    constraint finance_payment_allocations_payment_fk
    references public.finance_payment_requests(id),

  -- Exactly one of the two is set — see finance_payment_allocations_one_target.
  -- A PI submission before its Order exists, or the Confirmed Order itself.
  order_submission_id uuid
    constraint finance_payment_allocations_order_submission_fk
    references public.order_submissions(id),
  order_id uuid
    constraint finance_payment_allocations_order_fk
    references public.orders(id),

  allocated_amount numeric not null,

  -- 'reversed' is how an allocation ends. It is never deleted, so the reversal
  -- and its reason stay readable forever.
  status text not null default 'active',

  -- WHERE THIS MONEY WAS FIRST ALLOCATED, frozen at creation. The same idea
  -- payment_target_type records for the parent payment (20260715000000): the
  -- current target legitimately changes over an allocation's life, and
  -- classifying by current linkage would erase where it came from. In this phase
  -- the two always agree, because nothing moves an allocation yet.
  origin_target_type text not null,

  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),

  reversed_by uuid references public.users(id),
  reversed_at timestamptz,
  reversal_reason text,

  -- Cleanup classification, matching orders / order_requests /
  -- finance_payment_requests (20260706000000 §1.1). NOT NULL DEFAULT false, so
  -- a code path that forgets about it produces a PROTECTED record rather than a
  -- deletable one. An allocation's real eligibility is still its parent
  -- payment's — the flag is carried here so the cleanup preview and audit can
  -- read one consistent answer off every Finance table.
  is_test_data boolean not null default false,

  -- THE AMOUNT, IN FULL.
  --   <> NaN   numeric accepts 'NaN' and NaN sorts above every real number, so
  --            the range test alone would already admit it into a comparison
  --            nobody intended. Stated so a reader need not know that.
  --   > 0      an allocation of nothing is not an allocation. Zero is refused
  --            rather than stored as a no-op row that a sum would ignore.
  --   round(,2) rupees and paise. Excess precision is REFUSED, never rounded.
  constraint finance_payment_allocations_amount_valid check (
    allocated_amount <> 'NaN'::numeric
    and allocated_amount > 0
    and allocated_amount = round(allocated_amount, 2)
  ),

  -- EXACTLY ONE CURRENT TARGET. Not "at most one": an allocation that names
  -- nothing allocates nothing and would still count against the payment's
  -- balance, which is the worst of both readings.
  constraint finance_payment_allocations_one_target check (
    num_nonnulls(order_submission_id, order_id) = 1
  ),

  constraint finance_payment_allocations_status_known check (
    status in ('active', 'reversed')
  ),

  constraint finance_payment_allocations_origin_known check (
    origin_target_type in ('order_submission', 'confirmed_order')
  ),

  -- A CONFIRMED-ORDER ALLOCATION NEVER POINTS AT A PI. Stated in this one
  -- direction only, and deliberately: the converse must NOT be asserted, because
  -- the later phase that turns an approved PI into an Order re-points an
  -- order_submission-origin allocation onto order_id while its provenance stays
  -- 'order_submission'. Constraining that direction now would mean dropping a
  -- constraint on live financial rows later.
  constraint finance_payment_allocations_origin_matches_target check (
    origin_target_type <> 'confirmed_order' or order_id is not null
  ),

  -- A REVERSAL IS NEVER HALF-WRITTEN. An actor with no time, a time with no
  -- reason, or a blank reason is not something anyone can audit. And an active
  -- allocation may carry none of the three, so a reversal cannot be staged
  -- quietly and then switched on.
  constraint finance_payment_allocations_reversal_complete check (
    (status = 'active'
     and reversed_by is null
     and reversed_at is null
     and reversal_reason is null)
    or
    (status = 'reversed'
     and reversed_by is not null
     and reversed_at is not null
     and reversal_reason is not null
     and btrim(reversal_reason) <> '')
  ),

  constraint finance_payment_allocations_reversal_not_before_creation check (
    reversed_at is null or reversed_at >= created_at
  )
);

comment on table public.finance_payment_allocations is
  'How much of one payment is claimed by one PI submission or one Confirmed Order. A CHILD of finance_payment_requests, which remains the only payment ledger — this table holds no money of its own, no client, no mode, no proof and no destination. The unallocated balance of a payment is DERIVED as amount minus the sum of its active allocations and is never stored. Rows are reversed, never deleted.';

comment on column public.finance_payment_allocations.payment_request_id is
  'The payment this allocation spends part of. NO ACTION FK: nothing deletes an allocation implicitly. Deleting an UNVERIFIED payment releases its allocations explicitly (finance_payment_requests_release_allocations); a verified payment cannot be deleted at all, so its allocations are permanent.';
comment on column public.finance_payment_allocations.order_submission_id is
  'The PI submission this money is allocated to, before any Order exists. Exactly one of this and order_id is set. NO ACTION FK: a PI naming an allocation cannot be deleted, and no deletion path silently discards the allocation.';
comment on column public.finance_payment_allocations.order_id is
  'The Confirmed Order this money is allocated to. Exactly one of this and order_submission_id is set. NO ACTION FK: an Order naming an allocation cannot be deleted, and no deletion path silently discards the allocation.';
comment on column public.finance_payment_allocations.allocated_amount is
  'Rupees of the parent payment claimed by this target, to two decimal places. Positive; excess precision is refused rather than rounded. The active total across a payment can never exceed the payment amount.';
comment on column public.finance_payment_allocations.status is
  'active | reversed. An allocation is never deleted; reversal keeps the row, its actor, its time and its reason. A reversed allocation can never become active again.';
comment on column public.finance_payment_allocations.origin_target_type is
  'Where this money was FIRST allocated: order_submission or confirmed_order. Frozen at creation and never re-derived, so provenance survives a later move onto an Order.';
comment on column public.finance_payment_allocations.is_test_data is
  'True only for allocations created during system testing. Stamped at INSERT from the cleanup setting and immutable thereafter, exactly as on orders / order_requests / finance_payment_requests.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §2. Indexes
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The two UNIQUE ones are the rule, not an optimisation: one payment may not
-- hold two ACTIVE claims against the same target. Partial on status='active', so
-- a reversed allocation never blocks a corrected re-allocation to the same
-- target — which is the whole point of reversing rather than editing.

create unique index finance_payment_allocations_unique_active_submission
  on public.finance_payment_allocations (payment_request_id, order_submission_id)
  where status = 'active' and order_submission_id is not null;

create unique index finance_payment_allocations_unique_active_order
  on public.finance_payment_allocations (payment_request_id, order_id)
  where status = 'active' and order_id is not null;

-- "What is allocated against this payment", the capacity trigger's own query and
-- the derived-balance read. Partial, because only active rows count.
create index finance_payment_allocations_payment_active_idx
  on public.finance_payment_allocations (payment_request_id)
  where status = 'active';

-- The whole history of a payment, reversals included.
create index finance_payment_allocations_payment_idx
  on public.finance_payment_allocations (payment_request_id);

-- "What is allocated to this PI / this Order" — the reads Phase 2 will make.
create index finance_payment_allocations_submission_idx
  on public.finance_payment_allocations (order_submission_id)
  where order_submission_id is not null;

create index finance_payment_allocations_order_idx
  on public.finance_payment_allocations (order_id)
  where order_id is not null;

create index finance_payment_allocations_status_idx
  on public.finance_payment_allocations (status);

-- Cleanup sweeps. Partial: almost every row is real.
create index finance_payment_allocations_test_data_idx
  on public.finance_payment_allocations (is_test_data)
  where is_test_data;

-- ═════════════════════════════════════════════════════════════════════════════
-- §3. Backfill — every payment already linked to a Confirmed Order
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT IS BACKFILLED, AND ONLY THIS: a payment whose status is 'approved_linked'
-- and which names an Order. Those are exactly the rows the deployed
-- finance_payment_requests_status_order_invariant (20260692000000) guarantees
-- carry a real Order linkage, and they are the ones every advance/received total
-- in the app already sums. One active allocation each, for the FULL payment
-- amount, against the SAME Order.
--
-- WHAT IS NOT BACKFILLED, deliberately:
--   * approved_unlinked payments — money received against nothing. There is no
--     target to allocate to; that is what makes them unallocated, and inventing
--     one would be inventing a business decision.
--   * order_request_id-linked payments — the Order Request path is a separate,
--     still-live linkage with its own conversion sweep
--     (convert_order_request_to_order, 20260682000000). Allocations do not model
--     Order Requests, and folding them in would make this table claim authority
--     over a flow this phase does not touch.
--   * pending_approval / needs_clarification / rejected payments — not yet money.
--
-- THE PAYMENT ROW IS NOT TOUCHED. Not its status, not order_id, not order_number,
-- not payment_target_type. Backward compatibility is the point: every existing
-- query keeps reading exactly what it read before, and the allocation is an
-- additional, parallel statement of the same fact.
--
-- IDEMPOTENT by the NOT EXISTS guard, so a re-run — or a repaired partial apply —
-- adds nothing twice.
--
-- created_by / created_at are the payment's own approval record, not now() and
-- not the migration runner: the allocation is asserting something that was
-- decided when the payment was linked, and dating it today would be a lie the
-- audit trail could not tell from a real decision.

insert into public.finance_payment_allocations (
  payment_request_id, order_id, allocated_amount,
  status, origin_target_type, created_by, created_at, is_test_data
)
select
  f.id,
  f.order_id,
  f.amount,
  'active',
  'confirmed_order',
  coalesce(f.approved_by, f.submitted_by),
  coalesce(f.approved_at, f.created_at),
  f.is_test_data
from public.finance_payment_requests f
where f.status = 'approved_linked'
  and f.order_id is not null
  and not exists (
    select 1
    from public.finance_payment_allocations a
    where a.payment_request_id = f.id
      and a.order_id = f.order_id
      and a.status = 'active'
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- §4. Test-data classification — the existing convention, reused verbatim
-- ═════════════════════════════════════════════════════════════════════════════
--
-- stamp_test_data_flag() and prevent_test_data_flag_change() are the deployed
-- functions from 20260706000000 §1.2/§1.3, attached unchanged. A caller-supplied
-- value is ignored, and the flag is immutable in BOTH directions afterwards —
-- not even the cleanup context is exempt, because cleanup deletes records, it
-- does not re-label them.
--
-- Attached AFTER the backfill: see the header. A backfilled row's flag is its
-- parent payment's, which is the truthful classification.

create trigger finance_payment_allocations_stamp_test_data
  before insert on public.finance_payment_allocations
  for each row execute function public.stamp_test_data_flag();

create trigger finance_payment_allocations_protect_test_data
  before update on public.finance_payment_allocations
  for each row execute function public.prevent_test_data_flag_change();

-- ═════════════════════════════════════════════════════════════════════════════
-- §5. Capacity — a payment can never be over-allocated
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE SINGLE INVARIANT THIS WHOLE PHASE RESTS ON:
--
--     sum(active allocated_amount) <= finance_payment_requests.amount
--
-- It cannot be a CHECK constraint — a CHECK sees one row and this is a statement
-- about a set — and it must not live only in the RPC, because a trigger fires on
-- EVERY write path: the RPC, a future RPC, a service-role script and direct SQL
-- alike.
--
-- THE LOCK IS THE POINT. `select ... for update` on the PARENT PAYMENT
-- serializes two concurrent allocations against the same payment, so the total
-- this function reads is the total that will still be true at COMMIT. Without
-- it, two sessions each allocating 60% of a payment would both read 0 allocated,
-- both pass, and both commit — the classic read-then-write race, and the one
-- failure mode that would silently corrupt the derived balance.
--
-- Locking the PAYMENT and not the allocation rows is also what makes the lock
-- order consistent with everything else in this schema: convert_order_request_to_order
-- and both link RPCs already take the business record first, then the payment.
-- Every writer here takes the payment first and the allocation second, so there
-- is no cycle to deadlock on.
--
-- SECURITY DEFINER because it reads finance_payment_requests, which the caller's
-- own RLS may hide, and because in_test_data_cleanup() and the other helpers on
-- this schema are revoked from authenticated. It writes nothing.

create or replace function public.finance_payment_allocations_enforce_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_amount    numeric;
  v_allocated numeric;
begin
  -- A row that is not claiming money cannot over-claim it. A reversal reduces
  -- the total and is always safe.
  if new.status <> 'active' then
    return new;
  end if;

  select f.amount into v_amount
  from public.finance_payment_requests f
  where f.id = new.payment_request_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: payment request % does not exist', new.payment_request_id
      using errcode = 'P0002';
  end if;

  -- Excluding this row by id makes the same statement correct for INSERT (where
  -- the row is not yet visible) and for UPDATE (where it is, and would otherwise
  -- be counted twice).
  select coalesce(sum(a.allocated_amount), 0) into v_allocated
  from public.finance_payment_allocations a
  where a.payment_request_id = new.payment_request_id
    and a.status = 'active'
    and a.id <> new.id;

  if v_allocated + new.allocated_amount > v_amount then
    raise exception
      'ALLOCATION_EXCEEDS_PAYMENT: allocating % would take the active allocated total to % against a payment of % (unallocated balance is %)',
      new.allocated_amount, v_allocated + new.allocated_amount, v_amount, v_amount - v_allocated
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.finance_payment_allocations_enforce_capacity() is
  'Refuses any allocation that would take a payment''s active allocated total above its amount. Locks the parent payment row FOR UPDATE first, so concurrent allocations against one payment serialize instead of both reading a stale total.';

revoke execute on function public.finance_payment_allocations_enforce_capacity()
  from public, anon, authenticated;

create trigger finance_payment_allocations_enforce_capacity
  before insert or update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_enforce_capacity();

-- ── 5a. The other half of the same invariant, on the payment ──────────────────
--
-- The trigger above stops the allocated total rising above the amount. This one
-- stops the AMOUNT falling below the allocated total — the same invariant seen
-- from the payment's side, and without it a correction could break it without
-- touching an allocation at all.
--
-- THIS IS THE LOAD-BEARING HALF, because an unverified payment may now be
-- allocated and an unverified payment's amount is still editable. Every route
-- that can change `amount` has to be covered, and a BEFORE ROW trigger is the
-- only construct that covers all of them at once:
--
--   * the SUBMITTER correcting their own pending or needs_clarification request
--     through finance_payment_requests_own_update (20260653/20260695000000) —
--     the common case, and the one a check inside an RPC would miss entirely,
--     because this path is a direct PostgREST PATCH with no RPC at all;
--   * an ADMIN, through finance_payment_requests_admin_update;
--   * a finance.manage holder, through finance_payment_requests_manager_correct
--     — the post-approval correction 20260901000000 deliberately allows;
--   * an approver deciding a pending request (finance_payment_requests_approver_decide);
--   * every SECURITY DEFINER RPC — approve_finance_payment_request, the four
--     link/unlink functions, convert_order_request_to_order — none of which
--     changes `amount` today, but none of which is exempt either;
--   * the SERVICE ROLE and direct SQL, which bypass RLS entirely and which no
--     policy can constrain.
--
-- A CHECK constraint could not express this (it is a statement about a set), and
-- an RLS WITH CHECK could not either (it sees one row and cannot sum a child
-- table). The trigger is the narrowest construct that is also complete.
--
-- Scoped to an actual amount CHANGE, so every other update on the table — status
-- transitions, verification, linkage, handover details, notes — passes straight
-- through and no existing write path pays for this. In particular a payment
-- moving pending -> approved -> rejected never touches its allocations.

create or replace function public.finance_payment_requests_guard_allocated_amount()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allocated numeric;
begin
  if new.amount is not distinct from old.amount then
    return new;
  end if;

  select coalesce(sum(a.allocated_amount), 0) into v_allocated
  from public.finance_payment_allocations a
  where a.payment_request_id = old.id
    and a.status = 'active';

  if new.amount < v_allocated then
    raise exception
      'PAYMENT_BELOW_ALLOCATED: payment % cannot be reduced to % — % is already allocated. Reverse an allocation first.',
      old.request_number, new.amount, v_allocated
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.finance_payment_requests_guard_allocated_amount() is
  'Refuses a payment amount correction that would drop it below the total already allocated. The payment-side half of the allocation capacity invariant; fires only when amount actually changes.';

revoke execute on function public.finance_payment_requests_guard_allocated_amount()
  from public, anon, authenticated;

drop trigger if exists finance_payment_requests_guard_allocated_amount
  on public.finance_payment_requests;

create trigger finance_payment_requests_guard_allocated_amount
  before update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_allocated_amount();

-- ── 5b. "Verified", stated once ──────────────────────────────────────────────
--
-- An allocation carries no verification state, so every future reader that needs
-- "how much VERIFIED money is allocated to this PI or Order" has to reach the
-- parent payment's status. This is that rule, written down once, so the later
-- phase that gates Order approval on received payment does not re-invent it —
-- the same service order_submission_advance_ready() performs for the advance
-- rule (20260913000000), and named here for the same reason.
--
-- The two approved statuses, and only those. `pending_approval` and
-- `needs_clarification` are money somebody has CLAIMED arrived and nobody has
-- confirmed; `rejected` is money that was refused. None of the three may ever be
-- counted, and a rejected payment that still carries allocations — which Phase 1
-- deliberately retains — is exactly the case this exists to exclude.
--
-- IMMUTABLE and taking the status as an ARGUMENT rather than an id: a caller
-- that already holds the locked payment row must be able to ask about the row it
-- is holding, not re-read it on behalf of whoever happens to be signed in. The
-- same distinction, for the same reason, 20260913000000 draws between
-- order_submission_advance_ready(text, numeric, text) and
-- order_submission_is_advance_ready(uuid).
--
-- IT AUTHORISES NOTHING and gates nothing today. Phase 1 changes no approval
-- rule; approve_order_submission() still reads the DECLARED advance and does not
-- call this.

create or replace function public.finance_payment_status_is_verified(p_status text)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(p_status in ('approved_unlinked', 'approved_linked'), false)
$$;

comment on function public.finance_payment_status_is_verified(text) is
  'Whether a payment status means the money has been CONFIRMED RECEIVED: approved_unlinked or approved_linked, and nothing else. The single definition of "verified" for any future total over finance_payment_allocations, which deliberately carries no verification state of its own. Decides nothing and authorises nothing.';

revoke execute on function public.finance_payment_status_is_verified(text) from public, anon;
grant  execute on function public.finance_payment_status_is_verified(text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §6. What may change about an allocation, and what may not
-- ═════════════════════════════════════════════════════════════════════════════
--
-- An allocation is a financial statement. The ONLY thing that may ever change
-- about it is that it stops applying — active -> reversed, once, with an actor,
-- a time and a reason. Everything else is frozen at creation, so "correcting" an
-- allocation means reversing it and making another, and both remain readable.
--
-- NOT SECURITY DEFINER and no exemption for anybody — not admin, not
-- finance.manage, not the service role, not the cleanup context. The same shape
-- and the same reasoning as prevent_test_data_flag_change (20260706000000 §1.3):
-- a rule that the strongest caller can bypass is a convention, not an invariant,
-- and this one is what makes the audit trail evidence.
--
-- PHASE 3 WILL HAVE TO RESTATE THIS FUNCTION, on purpose. Turning an approved PI
-- into an Order re-points its allocations from order_submission_id onto order_id,
-- which the target-immutability clause below refuses. That restatement is a
-- visible, reviewed change to one named function in its own migration — which is
-- exactly the trade this schema makes everywhere else (see the closed action sets
-- in 20260915000000 §10): a phase that produces a new kind of change says so in
-- a migration, rather than the schema having quietly permitted it all along.

create or replace function public.finance_payment_allocations_guard_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id                  is distinct from old.id
     or new.payment_request_id  is distinct from old.payment_request_id
     or new.order_submission_id is distinct from old.order_submission_id
     or new.order_id            is distinct from old.order_id
     or new.allocated_amount    is distinct from old.allocated_amount
     or new.origin_target_type  is distinct from old.origin_target_type
     or new.created_by          is distinct from old.created_by
     or new.created_at          is distinct from old.created_at
  then
    raise exception
      'ALLOCATION_IMMUTABLE: an allocation''s payment, target, amount, provenance and creation record cannot be changed. Reverse it and create another.'
      using errcode = '42501';
  end if;

  -- Reversal is terminal, in every direction. Neither the status nor the
  -- reversal record may be rewritten once it is written.
  if old.status = 'reversed' then
    if new.status is distinct from old.status then
      raise exception
        'ALLOCATION_REVERSAL_FINAL: a reversed allocation can never be made active again. Create a new allocation instead.'
        using errcode = '42501';
    end if;

    if new.reversed_by     is distinct from old.reversed_by
       or new.reversed_at     is distinct from old.reversed_at
       or new.reversal_reason is distinct from old.reversal_reason
    then
      raise exception
        'ALLOCATION_REVERSAL_IMMUTABLE: a recorded reversal cannot be rewritten.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.finance_payment_allocations_guard_transition() is
  'An allocation may only ever go active -> reversed. Payment, target, amount, provenance and creation record are immutable, a reversal is terminal, and a recorded reversal cannot be rewritten. No exemption for any role, including the service role.';

revoke execute on function public.finance_payment_allocations_guard_transition()
  from public, anon, authenticated;

-- TRIGGER NAME, DELIBERATELY NOT THE FUNCTION NAME. PostgreSQL fires same-timing
-- row triggers in NAME order, and this one has to run BEFORE
-- `..._enforce_capacity` — "is this change legal at all?" is a question that must
-- be answered before "does the amount still fit?". Named
-- `..._check_transition` so it sorts ahead of both `..._derive_reversal` and
-- `..._enforce_capacity`; under the obvious name `..._guard_transition` it would
-- sort last, and an attempt to reactivate a reversed allocation would be refused
-- with ALLOCATION_EXCEEDS_PAYMENT — true, but not the reason.
--
-- Running ahead of ..._derive_reversal is safe and checked: on the only
-- transition that exists (active -> reversed) every clause below is guarded on
-- old.status = 'reversed', so none of them reads a column derive_reversal is
-- about to write.
create trigger finance_payment_allocations_check_transition
  before update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_guard_transition();

-- ═════════════════════════════════════════════════════════════════════════════
-- §7. Reversal completeness, derived rather than trusted
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The CHECK in section 1 says a reversed row carries an actor, a time and a
-- non-blank reason. This says the ACTOR is the caller and the TIME is now, so a
-- direct PATCH cannot attribute a reversal to somebody else or backdate it.
-- Derived here rather than in the RPC for the reason every derivation on this
-- schema is a trigger: it has to hold on every write path, not just the polite one.
--
-- auth.uid() IS NULL — service role, direct SQL, a maintenance script — passes
-- through with whatever it supplied, exactly as every other guard on this schema
-- exempts that case. It has no session identity to derive from.

create or replace function public.finance_payment_allocations_derive_reversal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if new.status = 'reversed' and old.status = 'active' then
    -- A session reversal is attributed to the session, always. No client value
    -- reaches either column.
    if v_actor is not null then
      new.reversed_by := v_actor;
    end if;
    new.reversed_at := now();
    new.reversal_reason := nullif(btrim(coalesce(new.reversal_reason, '')), '');

    -- With no session there is nobody to attribute it to, and NOTHING is
    -- invented: reversed_by is left exactly as supplied, so a direct-SQL
    -- reversal that names no actor is refused by
    -- finance_payment_allocations_reversal_complete rather than quietly
    -- credited to whoever created the row.


    if new.reversal_reason is null then
      raise exception
        'ALLOCATION_REASON_REQUIRED: reversing an allocation requires a reason.'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.finance_payment_allocations_derive_reversal() is
  'On active -> reversed, pins reversed_by to the caller and reversed_at to now, and refuses a blank reason. Server-derived on every write path, so a direct PATCH cannot attribute or backdate a reversal.';

revoke execute on function public.finance_payment_allocations_derive_reversal()
  from public, anon, authenticated;

-- Name matters: PostgreSQL fires same-timing row triggers in NAME order, and
-- `..._derive_reversal` sorts after `..._check_transition` and before
-- `..._enforce_capacity`, so the legality of the change is settled first, this
-- normalises the row, and the capacity check then judges what was actually
-- written.
create trigger finance_payment_allocations_derive_reversal
  before update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_derive_reversal();

-- ═════════════════════════════════════════════════════════════════════════════
-- §8. An allocation is never deleted by accident
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The same three-layer stance 20260705000000 took for approved payments and
-- Confirmed Orders, and for the same reason: an allocation is a record of a
-- financial decision, so it is history rather than data.
--
--   layer 1  no DELETE policy exists (section 10), so PostgREST refuses it
--   layer 2  DELETE is REVOKED from anon and authenticated (section 10), so the
--            privilege check refuses it before any policy is consulted
--   layer 3  THIS TRIGGER, which fires for every path including the service role
--            and direct SQL.
--
-- And a fourth, upstream of all of them: the three foreign keys are NO ACTION,
-- so a PI or an Order that an allocation names cannot be deleted at all. There
-- is no deletion path that can reach an allocation by side effect.
--
-- TWO EXEMPTIONS, both transaction-local markers rather than identities, neither
-- settable by any client:
--
--   in_test_data_cleanup()          the authorized cleanup transaction
--                                   (20260705000000 §1), unchanged
--   in_payment_allocation_release() the parent payment is being deleted, and is
--                                   eligible to be — see 8a
--
-- The second is PINNED TO ONE PAYMENT ID rather than being a boolean, so even
-- inside a release the guard will only let go of the allocations belonging to
-- the payment actually being deleted.

create or replace function public.in_payment_allocation_release(p_payment_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(current_setting('boe.payment_allocation_release', true), ''), '')
         = p_payment_id::text
$$;

comment on function public.in_payment_allocation_release(uuid) is
  'True only inside a transaction where finance_payment_requests_release_allocations() is deleting THIS payment''s allocations. Transaction-local, pinned to one payment id, and not settable by any client.';

revoke execute on function public.in_payment_allocation_release(uuid)
  from public, anon, authenticated;

create or replace function public.finance_payment_allocations_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.in_test_data_cleanup() then
    return old;
  end if;

  if public.in_payment_allocation_release(old.payment_request_id) then
    return old;
  end if;

  raise exception
    'ALLOCATION_PERMANENT: allocation % is a financial record and cannot be deleted. Reverse it instead.',
    old.id
    using errcode = '42501';
end;
$$;

comment on function public.finance_payment_allocations_guard_delete() is
  'Refuses every deletion of an allocation, for every role including the service role. Exempt only inside an authorized Test Data Cleanup transaction, or while its own eligible parent payment is being deleted.';

revoke execute on function public.finance_payment_allocations_guard_delete()
  from public, anon, authenticated;

create trigger finance_payment_allocations_guard_delete
  before delete on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_guard_delete();

-- ── 8a. Deleting an UNVERIFIED payment releases its allocations ──────────────
--
-- THE RULE THIS PRESERVES IS NOT NEW. 20260705000000 states it plainly: an
-- unfinished record — an unapproved Payment Request — "represents a mistake
-- rather than an event" and stays deletable, while an approved payment is
-- permanent bank history. Phase 1 makes a pending payment allocatable, so that
-- rule now has to say something about its children, and the honest answer is
-- that they go with it: an allocation of money that was never confirmed
-- describes nothing that happened. Leaving it behind would be FALSE financial
-- history pointing at a payment that no longer exists.
--
-- WHY A TRIGGER AND NOT `ON DELETE CASCADE`. A cascade would fire for ANY
-- deletion of the parent row, including one this schema has not thought of yet.
-- An explicit BEFORE DELETE trigger runs only after
-- finance_payment_requests_guard_approved_delete has already refused every
-- verified payment, so the release is reachable exactly when the deletion itself
-- is legitimate — and it is stated in one readable place rather than implied by
-- a constraint clause.
--
-- TRIGGER NAME ORDER IS LOAD-BEARING, and is checked by the assertions in §13:
-- `finance_payment_requests_guard_approved_delete` sorts before
-- `finance_payment_requests_release_allocations` (g < r), so a verified payment
-- is refused BEFORE anything is released. If the two were ever reordered, this
-- would start releasing allocations for a delete that is then refused — harmless
-- because the whole transaction rolls back, but the ordering is asserted anyway
-- so nobody has to reason about it twice.

create or replace function public.finance_payment_requests_release_allocations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Transaction-local either way, so a failure between here and COMMIT cannot
  -- leak it. Cleared explicitly so nothing later in the SAME transaction — a
  -- multi-row delete, the cleanup executor — inherits an open door for a payment
  -- it is not currently deleting.
  perform set_config('boe.payment_allocation_release', old.id::text, true);

  delete from public.finance_payment_allocations
   where payment_request_id = old.id;

  perform set_config('boe.payment_allocation_release', '', true);

  return old;
end;
$$;

comment on function public.finance_payment_requests_release_allocations() is
  'Releases a payment''s allocations as part of deleting the payment itself. Reachable only after finance_payment_requests_guard_approved_delete has allowed the deletion, so a verified payment — and therefore its allocations — can never be removed this way.';

revoke execute on function public.finance_payment_requests_release_allocations()
  from public, anon, authenticated;

drop trigger if exists finance_payment_requests_release_allocations
  on public.finance_payment_requests;

create trigger finance_payment_requests_release_allocations
  before delete on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_release_allocations();

-- ═════════════════════════════════════════════════════════════════════════════
-- §9. Audit — the existing Finance trail, two new events
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Allocation events go into finance_payment_request_activity_log, the trail the
-- payment already has, keyed by payment_request_id. Not a new log table: an
-- allocation is something that happened TO A PAYMENT, and a reader asking "what
-- has happened to this money" must not have to consult two places.
--
-- The event set is a UNION of the DEPLOYED 20260716000000 set (verified against
-- that migration, which is the newest to touch this constraint) plus two —
-- never a retyped list, because a drop-and-recreate CHECK silently revokes
-- anything omitted and an empty table hides it until the first real write.
--
-- log_finance_payment_request_activity() is NOT restated. It is a trigger on
-- finance_payment_requests and this is a different table; the writer below is
-- its own function, so the deployed one keeps its exact body and its ACL.

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
    'cash_handover_recorded',
    'allocation_created',
    'allocation_reversed'
  ));

-- The ONLY writer of allocation audit rows. SECURITY DEFINER, because
-- finance_payment_request_activity_log has had no client INSERT policy since
-- 20260675 removed both — the trail is append-only and trigger-written, and a
-- client can neither fabricate a row nor attribute one to somebody else.
--
-- AFTER, and returning null: the audit row is written inside the caller's
-- transaction, so if this insert fails the whole allocation rolls back. There is
-- no path that commits an allocation while silently losing its trail.
--
-- NOTHING IS RECORDED FOR A BACKFILLED ROW, because this trigger is created
-- after the backfill has already run. That is deliberate — see the header.

create or replace function public.log_finance_payment_allocation_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid;
  v_event   text;
  v_payload jsonb;
begin
  if tg_op = 'INSERT' then
    v_event := 'allocation_created';
    v_actor := new.created_by;
  elsif old.status = 'active' and new.status = 'reversed' then
    v_event := 'allocation_reversed';
    v_actor := new.reversed_by;
  else
    -- Nothing else can happen to an allocation (see the transition guard), and
    -- a no-op update is not an event.
    return null;
  end if;

  -- Identifiers, the figure, and the reason. No client name, no payment mode, no
  -- proof — the payment row and the target row already carry those, and a copy
  -- in the trail is a copy that can disagree.
  v_payload := jsonb_build_object(
    'allocation_id',      new.id,
    'target_type',        case when new.order_submission_id is not null
                               then 'order_submission' else 'confirmed_order' end,
    'target_id',          coalesce(new.order_submission_id, new.order_id),
    'allocated_amount',   new.allocated_amount,
    'origin_target_type', new.origin_target_type
  );

  if v_event = 'allocation_reversed' then
    v_payload := v_payload || jsonb_build_object(
      'reversal_reason', new.reversal_reason,
      'reversed_at',     new.reversed_at
    );
  end if;

  insert into public.finance_payment_request_activity_log
    (payment_request_id, actor_id, event_type, payload)
  values
    (new.payment_request_id, v_actor, v_event, v_payload);

  return null;
end;
$$;

comment on function public.log_finance_payment_allocation_activity() is
  'The only writer of allocation_created / allocation_reversed rows. Records the allocation id, its target type and id, the amount, the provenance and (on reversal) the reason, into the payment''s existing Finance activity trail. Server-derived; no client can insert an audit row.';

revoke execute on function public.log_finance_payment_allocation_activity()
  from public, anon, authenticated;

create trigger finance_payment_allocations_log_activity
  after insert or update on public.finance_payment_allocations
  for each row execute function public.log_finance_payment_allocation_activity();

-- ═════════════════════════════════════════════════════════════════════════════
-- §10. Privileges and RLS — deny by default
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The stance 20260908000000 took from the start and 20260818000000 learned the
-- hard way: REVOKE the write privileges outright, so the privilege check refuses
-- a client write BEFORE any policy is consulted, and let the two SECURITY DEFINER
-- RPCs in section 12 be the only doors. Two independent refusals of every direct
-- INSERT, UPDATE and DELETE.

revoke insert, update, delete, truncate, references, trigger
  on public.finance_payment_allocations from anon, authenticated;

-- ANON IS CLOSED OUTRIGHT, including SELECT. Supabase's project-level
-- `alter default privileges ... grant all on tables to anon, authenticated`
-- means a new table arrives with anon already holding SELECT; RLS plus policies
-- declared `to authenticated` make that inert, which is why the existing Finance
-- tables leave it. It is revoked here anyway: nothing reads an allocation
-- unauthenticated, so the privilege has no purpose, and a privilege with no
-- purpose is one fewer thing a future policy edit can accidentally open.
revoke select on public.finance_payment_allocations from anon;

grant select on public.finance_payment_allocations to authenticated;

alter table public.finance_payment_allocations enable row level security;

-- ── NO RESTRICTIVE FINANCE MODULE GATE ON THIS TABLE, DELIBERATELY ───────────
--
-- The other three Finance tables carry one (20260905000000 §2), and the obvious
-- move was to copy it. It is the wrong shape HERE, and this is the one place in
-- the schema where that is true.
--
-- THE CONFIRMED BUSINESS RULE: a salesperson may see the money attached to a PI
-- or an Order THEY UPLOADED OR OWN — how much, and whether Finance has confirmed
-- it — WITHOUT holding Finance-module access. A RESTRICTIVE finance gate ANDs
-- itself onto every permissive policy below, so it would have hidden a person's
-- own record's payment from them unless somebody also granted them Finance,
-- which grants far more than the narrow sight the rule describes.
--
-- WHAT REPLACES IT: every permissive policy below carries its OWN complete
-- authority, so removing the blanket gate widens nothing. Read them as a set:
--
--   admin                 unchanged, matches finance_payment_requests_admin_select
--   finance.view_all      the existing protected company-wide Finance sight
--   payment submitter     you raised this payment
--   PI participant        gated on module_entry_open('orders') AND the PI
--                         module's own single visibility rule
--   Order participant     gated by public.orders' own RLS, which itself carries
--                         the RESTRICTIVE Orders module gate
--
-- The two participant branches therefore still require Order Management entry
-- and still resolve to "a record this person can already open". Somebody with
-- neither Finance nor Orders access reaches nothing at all.
--
-- WHAT THIS DOES NOT GRANT. Reading an allocation on your own PI or Order is
-- SELECT on one child row and nothing else. It confers no finance.allocate, no
-- finance.allocate_correct, no verification authority, no Finance page, and no
-- sight of any other customer's payment: the write privileges are revoked
-- outright below and both RPCs re-derive their own permission server-side.
--
-- REQUIRED PHASE 2 DEPENDENCY, STATED HERE SO IT IS NOT MISSED. The parent
-- table, public.finance_payment_requests, is NOT widened by this migration and
-- keeps its existing policies and its Finance module gate. So a PI owner without
-- Finance access can currently read the ALLOCATION (how much of a payment is
-- assigned to their record) but NOT the payment row behind it — which is where
-- payment_date, payment_mode, admin_note and the rejection reason live. Phase 2,
-- which builds the PI/Order payment card, MUST add the matching participant
-- SELECT policy to finance_payment_requests. It is deliberately not done here:
-- widening the payment ledger is a decision that belongs with the screen that
-- needs it, and doing it blind a phase early would expose payment rows that
-- nothing yet reads.

-- Admin, matching finance_payment_requests_admin_select.
create policy "finance_payment_allocations_admin_select"
  on public.finance_payment_allocations
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'admin'
    )
  );

-- Company-wide Finance sight, on the SAME protected action that already grants
-- it over the payments themselves (20260903000000). No new visibility action is
-- invented: whoever may read every payment may read how every payment is split.
create policy "finance_payment_allocations_view_all_select"
  on public.finance_payment_allocations
  for select to authenticated
  using (
    resolve_permission(auth.uid(), 'finance', 'view_all')
  );

-- The person who raised the payment. Mirrors finance_payment_requests_own_select
-- exactly — if you may read the payment because you submitted it, you may read
-- how it was split.
create policy "finance_payment_allocations_payment_owner_select"
  on public.finance_payment_allocations
  for select to authenticated
  using (
    exists (
      select 1 from public.finance_payment_requests r
      where r.id = finance_payment_allocations.payment_request_id
        and r.submitted_by = auth.uid()
    )
  );

-- PI PARTICIPANTS — the confirmed rule, and the reason this table has no blanket
-- Finance gate. Expressed through the PI module's OWN single visibility rule
-- (can_view_order_submission, 20260908000000/20260915000000) rather than a
-- restatement of it, so the two can never drift.
--
-- ANDed with module_entry_open('orders') because that helper is SECURITY DEFINER
-- and therefore does not itself include the RESTRICTIVE parent gate the
-- order_submissions table carries. Without this the policy would show an
-- allocation for a PI whose own row the caller cannot read, which would be a
-- widening rather than the narrow sight the rule describes.
--
-- FINANCE ACCESS IS NOT REQUIRED, and that is the whole point: a salesperson
-- sees the money on the PI they uploaded without being handed the Finance
-- module.
create policy "finance_payment_allocations_submission_participant_select"
  on public.finance_payment_allocations
  for select to authenticated
  using (
    finance_payment_allocations.order_submission_id is not null
    and public.module_entry_open('orders')
    and public.can_view_order_submission(finance_payment_allocations.order_submission_id)
  );

-- ORDER PARTICIPANTS — the same rule for a Confirmed Order. Deliberately a plain
-- EXISTS against public.orders and NOT a restatement of its four SELECT
-- policies: RLS applies to a table referenced inside a policy expression, so this
-- resolves to exactly "an Order this caller can already see" — admin,
-- operations, requester, assignee or orders.view_all — and it picks up the
-- RESTRICTIVE Orders module gate for free. It cannot widen when those policies
-- change, and it cannot be more permissive than public.orders itself.
create policy "finance_payment_allocations_order_participant_select"
  on public.finance_payment_allocations
  for select to authenticated
  using (
    finance_payment_allocations.order_id is not null
    and exists (
      select 1 from public.orders o
      where o.id = finance_payment_allocations.order_id
    )
  );

-- NO INSERT, UPDATE OR DELETE POLICY, for any role. With RLS enabled and no
-- policy for a command, PostgREST refuses it outright — and the revokes above
-- refuse it one layer earlier. Every mutation goes through section 12, which
-- re-derives finance.allocate / finance.allocate_correct server-side. Being able
-- to SEE an allocation therefore grants no authority to create, reverse, verify
-- or correct one.
--
-- NO EXISTING POLICY ON ANY OTHER TABLE IS CREATED, DROPPED, ALTERED OR WIDENED
-- by this migration. Finance, Orders and PI visibility are exactly what they
-- were.

-- ═════════════════════════════════════════════════════════════════════════════
-- §11. Two protected Finance actions
-- ═════════════════════════════════════════════════════════════════════════════
--
--   finance.allocate          create a valid allocation against a PI or an Order
--   finance.allocate_correct  reverse an active allocation
--
-- SEPARATE, AND SEPARATE FROM finance.approve, in all directions. Verifying that
-- money arrived, deciding which business it belongs to, and undoing that decision
-- are three authorities the business has chosen to keep assignable to different
-- people. finance.approve is NOT touched, NOT renamed and NOT re-scoped — it
-- remains the verification authority and will be relabelled as such in the UI in
-- a later phase.
--
-- default_allowed = false, and both are registered in PROTECTED_ACTIONS in
-- src/lib/permissions/levels.ts, so no Viewer / Contributor / Manager preset can
-- reach either. They are granted explicitly, per person, through Access Control,
-- or not at all — except for the project's established admin bypass, which
-- actor_has_module_permission supplies and which already requires an ACTIVE,
-- non-deleted account. NOTHING HERE GRANTS EITHER ACTION TO ANYBODY.

insert into public.permission_actions (action_key, display_name, is_system)
values
  ('allocate',         'Allocate Payments',           false),
  ('allocate_correct', 'Correct Payment Allocations', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa
  on pa.action_key in ('allocate', 'allocate_correct')
where pm.module_key = 'finance'
on conflict (module_id, action_id) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- §12. The two doors
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Written the way every write path on this schema is written: an authenticated
-- actor, the authoritative permission helper, the parent payment locked BEFORE
-- any state is judged, every authoritative value derived server-side, and a small
-- fixed JSON result carrying nothing the caller could not already read.
--
-- NOT ONE EXISTING RPC SIGNATURE CHANGES. approve_finance_payment_request,
-- link_/unlink_finance_payment_to/from_order, link_/unlink_finance_payment_to/from_order_request,
-- convert_order_request_to_order, verify_pi_finance_check and
-- approve_order_submission are neither restated nor referenced.
--
-- WHAT THE CALLER MAY NOT SUPPLY, at all: the actor, the origin classification,
-- the client name, the payment amount, the payment status, the target's status,
-- the reversal actor and the reversal time. Every one of those is read from the
-- locked row or derived from auth.uid().

-- ── 12A. Create an allocation ────────────────────────────────────────────────
--
-- AN UNVERIFIED PAYMENT MAY BE ALLOCATED. That is the confirmed workflow: Sales
-- records money against a PI or an Order, the payment and its allocation read as
-- Awaiting Verification, and Finance then verifies, corrects-and-verifies, or
-- rejects it. Requiring verification first would invert the sequence and leave
-- the salesperson nowhere to say what the money was for.
--
-- VERIFICATION IS A PROPERTY OF THE PAYMENT, NEVER OF THE ALLOCATION. The
-- allocation says how much of a payment belongs to a piece of business; whether
-- that money has been confirmed is the parent's `status`, and it is read through
-- finance_payment_status_is_verified() (section 5b). There is deliberately no
-- pending/verified pair of allocation statuses: two places recording one fact is
-- how they come to disagree, and 'active'/'reversed' already means something
-- else entirely — whether the allocation still applies at all.
--
-- ONLY 'rejected' IS REFUSED, and only for a NEW allocation. Rejected money was
-- refused, so nothing further should be attached to it. Allocations already on a
-- rejected payment are RETAINED — untouched, still readable, and simply not
-- verified — because a rejection is frequently corrected and reapplied
-- (20260695000000 returns the payment to pending_approval), and destroying the
-- allocation would make the salesperson re-state what the money was for.
--
-- THE MOVING-AMOUNT PROBLEM THIS RAISES IS CLOSED IN SECTION 5a. A pending
-- payment's amount can still be edited by its submitter, so the capacity
-- invariant is enforced from the payment's side as well — every path that
-- lowers an amount below what is already allocated is refused.
--
-- VISIBILITY IS CHECKED ON THE TARGET. finance.allocate is a protected action
-- whose entire purpose is attaching money to business records, so it is the
-- authority over the payment side; what still has to be proved is that this
-- caller may see the PI or the Order they are naming. Company-wide Finance sight
-- is accepted as an alternative on that branch, so a Finance allocator does not
-- also need Order Management access to do their job.

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

  if not public.actor_has_module_permission('finance', 'allocate') then
    raise exception 'You do not have permission to allocate payments' using errcode = '42501';
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
$$;

comment on function public.allocate_payment_to_target(uuid, uuid, uuid, numeric) is
  'Allocates part of a payment — verified or still awaiting verification — to exactly one PI submission or Confirmed Order, for a caller holding finance.allocate. Verification is the parent payment''s status and is never copied onto the allocation; only a rejected payment refuses a new allocation. Locks the payment, re-derives the unallocated balance under that lock, validates the target exists, is eligible and is visible to the caller, and refuses a duplicate active claim. The actor and the provenance are server-derived; no client value reaches either. Creates no payment and changes no payment column.';

revoke execute on function public.allocate_payment_to_target(uuid, uuid, uuid, numeric) from public, anon;
grant  execute on function public.allocate_payment_to_target(uuid, uuid, uuid, numeric) to authenticated;

-- ── 12B. Reverse an allocation ───────────────────────────────────────────────
--
-- Reversal is the ONLY way an allocation ends, and it keeps the row. The reason
-- is mandatory and is what makes the trail worth having — "the money moved" with
-- no statement of why is not an audit record.
--
-- IDEMPOTENT BY CONSTRUCTION, matching approve_order_submission: a repeated call
-- on an already-reversed allocation returns the existing reversal and writes
-- nothing. A double click is not a second decision, and the trail does not claim
-- two people reversed one allocation.

create or replace function public.reverse_payment_allocation(
  p_allocation_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_alloc  public.finance_payment_allocations%rowtype;
  v_pay    public.finance_payment_requests%rowtype;
  v_reason text;
  v_now    timestamptz;
begin
  if v_actor is null then
    raise exception 'Authentication required to reverse an allocation' using errcode = '28000';
  end if;

  if not public.actor_has_module_permission('finance', 'allocate_correct') then
    raise exception 'You do not have permission to correct payment allocations' using errcode = '42501';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception
      'ALLOCATION_REASON_REQUIRED: reversing an allocation requires a reason.'
      using errcode = 'P0001';
  end if;

  -- Read the allocation WITHOUT a lock first, only to learn which payment to
  -- lock. The payment is locked before the allocation, so the lock order is
  -- identical to allocate_payment_to_target's and to the capacity trigger's, and
  -- two callers acting on one payment queue instead of deadlocking.
  select * into v_alloc
  from public.finance_payment_allocations
  where id = p_allocation_id;

  if not found then
    raise exception 'ALLOCATION_NOT_FOUND: allocation % not found', p_allocation_id
      using errcode = 'P0002';
  end if;

  select * into v_pay
  from public.finance_payment_requests
  where id = v_alloc.payment_request_id
  for update;

  -- Re-read the allocation under the payment's lock: the row it judges is the row
  -- it writes against.
  select * into v_alloc
  from public.finance_payment_allocations
  where id = p_allocation_id
  for update;

  if v_alloc.status = 'reversed' then
    return jsonb_build_object(
      'allocation_id',        v_alloc.id,
      'payment_request_id',   v_alloc.payment_request_id,
      'allocated_amount',     v_alloc.allocated_amount,
      'reversed_at',          v_alloc.reversed_at,
      'reversal_reason',      v_alloc.reversal_reason,
      'already_reversed',     true
    );
  end if;

  update public.finance_payment_allocations
     set status          = 'reversed',
         reversal_reason = v_reason
   where id = p_allocation_id
  returning reversed_at into v_now;

  return jsonb_build_object(
    'allocation_id',       p_allocation_id,
    'payment_request_id',  v_alloc.payment_request_id,
    'request_number',      v_pay.request_number,
    'allocated_amount',    v_alloc.allocated_amount,
    'reversed_at',         v_now,
    'reversal_reason',     v_reason,
    'unallocated_balance', v_pay.amount - coalesce((
      select sum(a.allocated_amount)
      from public.finance_payment_allocations a
      where a.payment_request_id = v_alloc.payment_request_id
        and a.status = 'active'
    ), 0),
    'already_reversed',    false
  );
end;
$$;

comment on function public.reverse_payment_allocation(uuid, text) is
  'Reverses one active allocation for a caller holding finance.allocate_correct, keeping the row and recording the actor, the time and a mandatory non-blank reason. Locks the parent payment before the allocation, matching every other writer''s lock order. Idempotent: an already-reversed allocation is answered, not re-reversed.';

revoke execute on function public.reverse_payment_allocation(uuid, text) from public, anon;
grant  execute on function public.reverse_payment_allocation(uuid, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §13. Assertions
-- ═════════════════════════════════════════════════════════════════════════════
--
-- These FAIL THE MIGRATION rather than let a partial apply look successful — the
-- failure mode 20260723000000 exists to remember. Read-only.

do $$
declare
  v_n        integer;
  v_bad      text;
  v_expected integer;
begin
  -- ── The backfill covered exactly the eligible set, and nothing else ────────
  select count(*) into v_expected
  from public.finance_payment_requests f
  where f.status = 'approved_linked' and f.order_id is not null;

  select count(*) into v_n
  from public.finance_payment_allocations a
  where a.status = 'active';

  if v_n <> v_expected then
    raise exception
      'backfill: expected % active allocations (one per approved_linked payment), found %',
      v_expected, v_n;
  end if;

  -- Every eligible payment has exactly one active allocation, for its FULL
  -- amount, against the SAME Order, with confirmed_order provenance.
  select string_agg(f.request_number, ', ') into v_bad
  from public.finance_payment_requests f
  where f.status = 'approved_linked'
    and f.order_id is not null
    and not exists (
      select 1
      from public.finance_payment_allocations a
      where a.payment_request_id = f.id
        and a.status             = 'active'
        and a.order_id           = f.order_id
        and a.allocated_amount   = f.amount
        and a.origin_target_type = 'confirmed_order'
        and a.order_submission_id is null
    );

  if v_bad is not null then
    raise exception 'backfill: these linked payments have no matching active allocation: %', v_bad;
  end if;

  -- No eligible payment picked up two.
  select string_agg(x.request_number, ', ') into v_bad
  from (
    select f.request_number
    from public.finance_payment_requests f
    join public.finance_payment_allocations a
      on a.payment_request_id = f.id and a.status = 'active'
    group by f.id, f.request_number
    having count(*) > 1
  ) x;

  if v_bad is not null then
    raise exception 'backfill: these payments have more than one active allocation: %', v_bad;
  end if;

  -- Nothing outside the eligible set was backfilled.
  select count(*) into v_n
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where f.status <> 'approved_linked' or f.order_id is null;

  if v_n <> 0 then
    raise exception 'backfill: % allocation(s) exist against payments that are not linked to an Order', v_n;
  end if;

  -- ── The capacity invariant holds across the whole table ───────────────────
  select string_agg(x.request_number, ', ') into v_bad
  from (
    select f.request_number
    from public.finance_payment_requests f
    join public.finance_payment_allocations a
      on a.payment_request_id = f.id and a.status = 'active'
    group by f.id, f.request_number, f.amount
    having sum(a.allocated_amount) > f.amount
  ) x;

  if v_bad is not null then
    raise exception 'capacity: these payments are over-allocated: %', v_bad;
  end if;
end $$;

do $$
declare
  v_def text;
  v_n   integer;
  v_ev  text;
begin
  -- ── The activity CHECK is a UNION: every deployed value survived ──────────
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  join pg_class t     on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'finance_payment_request_activity_log'
    and c.conname = 'finance_payment_request_activity_log_event_type_check';

  if v_def is null then
    raise exception 'the Finance activity event_type constraint is missing';
  end if;

  foreach v_ev in array array[
    'request_submitted', 'order_linked', 'order_unlinked', 'order_link_changed',
    'order_request_linked', 'order_request_unlinked', 'target_changed',
    'status_changed', 'collection_details_updated', 'cash_handover_recorded',
    'allocation_created', 'allocation_reversed'
  ] loop
    if position('''' || v_ev || '''' in v_def) = 0 then
      raise exception 'the Finance activity event_type constraint no longer admits %', v_ev;
    end if;
  end loop;

  -- ── Every trigger this migration relies on is attached ────────────────────
  select count(*) into v_n
  from pg_trigger g
  join pg_class t on t.oid = g.tgrelid
  join pg_namespace ns on ns.oid = t.relnamespace
  where ns.nspname = 'public'
    and t.relname  = 'finance_payment_allocations'
    and not g.tgisinternal;

  if v_n <> 7 then
    raise exception 'expected 7 triggers on finance_payment_allocations, found %', v_n;
  end if;

  if not exists (
    select 1 from pg_trigger g
    join pg_class t on t.oid = g.tgrelid
    where t.relname = 'finance_payment_requests'
      and g.tgname  = 'finance_payment_requests_guard_allocated_amount'
  ) then
    raise exception 'the payment-side allocated-amount guard is not attached';
  end if;

  -- ── Deny by default: no write policy, and no write privilege ──────────────
  select count(*) into v_n
  from pg_policy p
  join pg_class t on t.oid = p.polrelid
  where t.relname = 'finance_payment_allocations'
    and p.polcmd in ('a', 'w', 'd');   -- INSERT / UPDATE / DELETE

  if v_n <> 0 then
    raise exception 'finance_payment_allocations must have no INSERT/UPDATE/DELETE policy, found %', v_n;
  end if;

  select count(*) into v_n
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name   = 'finance_payment_allocations'
    and grantee      in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');

  if v_n <> 0 then
    raise exception 'anon/authenticated still hold % write privilege(s) on finance_payment_allocations', v_n;
  end if;

  -- anon holds nothing at all, SELECT included.
  select count(*) into v_n
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name   = 'finance_payment_allocations'
    and grantee      = 'anon';

  if v_n <> 0 then
    raise exception 'anon must hold no privilege on finance_payment_allocations, found %', v_n;
  end if;

  -- NO restrictive policy of any kind. A RESTRICTIVE policy ANDs onto every
  -- permissive one, which is exactly what would defeat the two participant
  -- branches for somebody without Finance access.
  select count(*) into v_n
  from pg_policy p join pg_class t on t.oid = p.polrelid
  where t.relname = 'finance_payment_allocations' and p.polpermissive = false;

  if v_n <> 0 then
    raise exception
      'finance_payment_allocations must carry no RESTRICTIVE policy — it would defeat participant visibility (found %)', v_n;
  end if;

  -- All five permissive SELECT policies are present. Named individually, because
  -- a count would pass while the participant branches were missing.
  foreach v_ev in array array[
    'finance_payment_allocations_admin_select',
    'finance_payment_allocations_view_all_select',
    'finance_payment_allocations_payment_owner_select',
    'finance_payment_allocations_submission_participant_select',
    'finance_payment_allocations_order_participant_select'
  ] loop
    if not exists (
      select 1 from pg_policy p join pg_class t on t.oid = p.polrelid
      where t.relname = 'finance_payment_allocations'
        and p.polname = v_ev and p.polcmd = 'r' and p.polpermissive
    ) then
      raise exception 'the permissive SELECT policy % is missing', v_ev;
    end if;
  end loop;

  -- ── Financial history never disappears by cascade ────────────────────────
  -- All three parents are NO ACTION ('a'), so no deletion path can reach an
  -- allocation implicitly.
  -- Named individually: created_by and reversed_by are also foreign keys, and a
  -- bare count over the table would pass while a target FK cascaded.
  select count(*) into v_n
  from pg_constraint
  where conrelid = 'public.finance_payment_allocations'::regclass
    and contype = 'f'
    and conname in ('finance_payment_allocations_payment_fk',
                    'finance_payment_allocations_order_submission_fk',
                    'finance_payment_allocations_order_fk')
    and confdeltype = 'a';

  if v_n <> 3 then
    raise exception
      'the payment, PI and Order foreign keys must all be NO ACTION so nothing cascades into financial history (found %)', v_n;
  end if;

  -- And nothing on this table cascades or nulls on delete, at all.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_payment_allocations'::regclass
      and contype = 'f' and confdeltype <> 'a'
  ) then
    raise exception 'no foreign key on finance_payment_allocations may cascade or set null on delete';
  end if;

  -- The one explicit release path, and its ordering relative to the guard that
  -- refuses a verified payment. Name order decides which runs first.
  if not exists (
    select 1 from pg_trigger g join pg_class t on t.oid = g.tgrelid
    where t.relname = 'finance_payment_requests'
      and g.tgname  = 'finance_payment_requests_release_allocations'
  ) then
    raise exception 'the payment-side allocation release trigger is not attached';
  end if;

  if 'finance_payment_requests_guard_approved_delete'
     >= 'finance_payment_requests_release_allocations' then
    raise exception
      'the approved-delete guard must sort BEFORE the release trigger, or a verified payment would release before being refused';
  end if;

  -- ── Both actions are registered against Finance, and granted to nobody ────
  select count(*) into v_n
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  join public.permission_actions  pa on pa.id = mpa.action_id
  where pm.module_key = 'finance'
    and pa.action_key in ('allocate', 'allocate_correct');

  if v_n <> 2 then
    raise exception 'expected finance.allocate and finance.allocate_correct to be registered, found %', v_n;
  end if;

  select count(*) into v_n
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  join public.permission_actions  pa on pa.id = mpa.action_id
  where pm.module_key = 'finance'
    and pa.action_key in ('allocate', 'allocate_correct')
    and mpa.default_allowed;

  if v_n <> 0 then
    raise exception 'the allocation actions must not be default_allowed';
  end if;

  -- ── Nothing was granted to any role or employee by this migration ─────────
  select count(*) into v_n
  from public.role_permissions rp
  join public.permission_actions pa on pa.id = rp.action_id
  where pa.action_key in ('allocate', 'allocate_correct');

  if v_n <> 0 then
    raise exception 'this migration must grant the allocation actions to no role, found % row(s)', v_n;
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- §14. ROLLBACK PLAN
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Reversible while no allocation has been created outside the backfill, which is
-- the whole of Phase 1. In order:
--
--   drop trigger finance_payment_requests_guard_allocated_amount on public.finance_payment_requests;
--   drop trigger finance_payment_requests_release_allocations       on public.finance_payment_requests;
--   drop function public.finance_payment_requests_guard_allocated_amount();
--   drop function public.finance_payment_requests_release_allocations();
--   -- the delete guard refuses its own table's removal path, so stand it down first
--   drop trigger finance_payment_allocations_guard_delete on public.finance_payment_allocations;
--   drop table public.finance_payment_allocations;   -- takes its 6 other triggers with it
--   drop function public.allocate_payment_to_target(uuid, uuid, uuid, numeric);
--   drop function public.reverse_payment_allocation(uuid, text);
--   drop function public.finance_payment_allocations_enforce_capacity();
--   drop function public.finance_payment_allocations_guard_transition();
--   drop function public.finance_payment_allocations_derive_reversal();
--   drop function public.finance_payment_allocations_guard_delete();
--   drop function public.log_finance_payment_allocation_activity();
--   drop function public.in_payment_allocation_release(uuid);
--   drop function public.finance_payment_status_is_verified(text);
--   -- restore the deployed 20260716000000 event set (drop the two new values)
--   -- delete the two module_permission_actions rows, and the two
--   --   permission_actions rows if nothing else references them
--
-- No payment row, no Order, no PI, no policy on any other table and no existing
-- function needs restoring: none of them was modified.
