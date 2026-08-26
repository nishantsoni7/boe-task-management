-- ═══════════════════════════════════════════════════════════════════════════
-- One destination model for payment entry: PI Draft, Confirmed Order, Suspense
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR
-- ----------------
-- Both payment-entry forms are to offer exactly three destinations, and neither
-- is to ask a human to type the customer's name. Three things in the database
-- stood in the way, and this migration removes all three.
--
--   1. A PAYMENT REQUEST COULD NOT NAME A PI DRAFT. finance_payment_requests has
--      no order_submission_id, and the Payment Request form writes the row
--      directly with no allocation. The only way to record "this money is for
--      PI-123" was to record it as unallocated and allocate afterwards.
--
--   2. client_name WAS NOT NULL. A Suspense payment has no target, so there is
--      nothing to derive a customer from — and the alternatives were to keep
--      asking a human to type one, or to write something invented. Both were
--      refused.
--
--   3. A CONFIRMED-ORDER PAYMENT REQUEST PRODUCED NO ALLOCATION. It set
--      order_id on the payment row and approved to 'approved_linked'. Before
--      20261012000000 that column WAS the attribution; after it, it is
--      provenance worth ₹0 — so today an approved Confirmed-Order payment
--      request is attributed to nobody. This migration is what closes that
--      hole: the Order finally receives an allocation, at approval.
--
-- WHY AN INTENT TABLE AND NOT A COLUMN
-- ------------------------------------
-- A Payment Request is UNVERIFIED money. Somebody says it arrived; Finance has
-- not yet agreed. It must not create an active allocation, because an active
-- allocation is money the ledger treats as attributed — it would count toward
-- an Order's received total and toward the 40% approval gate before anyone had
-- checked the payment was real.
--
-- So the request records an INTENT: "when this is verified, allocate it here."
-- Intent is not allocation and this migration is careful to keep it that way —
-- a separate table, never read by any total, converted only by approval.
--
-- Reviving order_submission_id on the payment row would have been the smaller
-- diff and the wrong answer: it is the payment-row linkage model that PR #55
-- and 20261012000000 spent two changes removing, and it cannot express a
-- partial or split intention at all. A normalized table can, which is why the
-- shape below carries an amount per row and a status per row even though
-- today's form submits exactly one.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- -------------------------------
-- It does not weaken 20261012000000. Active finance_payment_allocations remain
-- the only source of financial attribution: no total, balance, classification
-- or gate added here reads an intent row, and §7's assertions prove it. It
-- creates no allocation for a pending request, drops no column, and rewrites no
-- business data.
--
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- §1. client_name becomes nullable
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NULL MEANS "no customer could be derived", which is a real and correct state
-- for exactly one destination: Suspense. It is not a shortcut for "unknown" and
-- the RPCs below refuse to leave it null for a targeted payment — a PI Draft or
-- Confirmed Order payment always resolves a real customer server-side or fails.
--
-- The precedent is 20260919000000 §1, which dropped NOT NULL from received_in
-- for the same reason and recorded it in the same words: NULL already means
-- exactly the right thing, and the alternatives — defaulting to a value nobody
-- stated, or widening a closed domain — were both worse.
--
-- READERS ARE UNAFFECTED. Every screen that prints a customer already handles a
-- blank one (a legacy row with an empty string reads the same way), and the
-- application ships one shared formatter for it (customerDisplayName) rather
-- than each surface inventing its own fallback.

alter table public.finance_payment_requests
  alter column client_name drop not null;

comment on column public.finance_payment_requests.client_name is
  'The customer this payment came from, DERIVED SERVER-SIDE from the payment''s target and never accepted from the client. NULLABLE since 20261013000000: a Suspense payment has no target and therefore no customer, and NULL says so rather than naming somebody who was never stated. Also NULL when a split payment''s targets name more than one distinct customer — see record_payment_with_allocations.';


-- ═══════════════════════════════════════════════════════════════════════════
-- §2. finance_payment_allocation_intents
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per target a PENDING payment request intends to pay for. Nothing
-- financial reads this table. It exists so that "which record is this money
-- for?" survives from submission to approval as structured data rather than as
-- prose in a note.
--
-- SHAPED FOR MORE THAN TODAY'S FORM. Today the Payment Request form submits one
-- destination and the intent takes the whole amount. The table carries an
-- amount per row and allows several rows per payment, so a future multi-target
-- request needs no second schema change — the same shape
-- finance_payment_allocations already has, deliberately, so the conversion in
-- §5 is a row-for-row mapping rather than a translation.

create table if not exists public.finance_payment_allocation_intents (
  id uuid primary key default gen_random_uuid(),

  -- CASCADE, because an intent is meaningless without its payment. A deleted
  -- payment takes its unconverted intentions with it; what it was actually
  -- ALLOCATED to is snapshotted separately by the deletion tombstone
  -- (20261011000000), which is the record that has to survive.
  payment_request_id uuid not null
    references public.finance_payment_requests(id) on delete cascade,

  target_type text not null
    check (target_type in ('pi_draft', 'confirmed_order')),

  -- Exactly one of these is set, enforced below. No order_request_id: that
  -- workflow is retired (20261007000000) and a new intent may never name one.
  order_submission_id uuid references public.order_submissions(id),
  order_id            uuid references public.orders(id),

  intended_amount numeric not null check (intended_amount > 0),

  status text not null default 'pending'
    check (status in ('pending', 'applied', 'cancelled')),

  -- What this intent became. Set together with applied_at, and only by §5.
  applied_allocation_id uuid references public.finance_payment_allocations(id),
  applied_at            timestamptz,
  cancelled_at          timestamptz,
  cancelled_reason      text,

  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),

  -- The project-wide test-data marker, stamped by the same trigger every other
  -- Finance table uses so the reset protocol sees this table too.
  is_test_data boolean not null default false,

  -- ── A non-suspense intent names EXACTLY ONE target, of its own kind ──
  constraint finance_payment_allocation_intents_one_target check (
    (target_type = 'pi_draft'
       and order_submission_id is not null and order_id is null)
    or
    (target_type = 'confirmed_order'
       and order_id is not null and order_submission_id is null)
  ),

  -- ── 'applied' and its evidence move together ──
  -- An intent that claims to have been applied must name the allocation it
  -- became. Without this, a half-written conversion could look complete.
  constraint finance_payment_allocation_intents_applied_pair check (
    (status = 'applied'
       and applied_allocation_id is not null and applied_at is not null)
    or
    (status <> 'applied'
       and applied_allocation_id is null and applied_at is null)
  ),

  constraint finance_payment_allocation_intents_cancelled_pair check (
    (status = 'cancelled' and cancelled_at is not null)
    or
    (status <> 'cancelled' and cancelled_at is null)
  )
);

comment on table public.finance_payment_allocation_intents is
  'What a PENDING payment request intends to pay for, per target. NOT AN ALLOCATION: no total, balance, classification or approval gate reads this table, and a row here contributes zero rupees to anything. approve_finance_payment_request converts each pending intent into a real active finance_payment_allocations row, exactly once, inside the approval transaction. 20261013000000.';

comment on column public.finance_payment_allocation_intents.intended_amount is
  'Rupees this payment intends for this target once verified. Positive, and the per-payment total may not exceed the payment amount (finance_payment_allocation_intents_enforce_capacity). Contributes to NO financial figure until it becomes an allocation.';
comment on column public.finance_payment_allocation_intents.status is
  'pending → awaiting Finance approval. applied → converted into applied_allocation_id. cancelled → the request was rejected or the intent withdrawn; kept for audit rather than deleted.';
comment on column public.finance_payment_allocation_intents.applied_allocation_id is
  'The active allocation this intent became. Set only by approve_finance_payment_request, together with applied_at, and never cleared — it is how a retry proves the work is already done.';

-- ── One PENDING intent per payment per target ────────────────────────────────
-- Mirrors the partial unique indexes finance_payment_allocations carries for
-- active rows, and for the same reason: two live claims on one target from one
-- payment is not a state the business has. Applied and cancelled rows are
-- excluded so a payment may intend, be rejected, and intend again.
create unique index if not exists finance_payment_allocation_intents_pending_pi_idx
  on public.finance_payment_allocation_intents (payment_request_id, order_submission_id)
  where status = 'pending' and order_submission_id is not null;

create unique index if not exists finance_payment_allocation_intents_pending_order_idx
  on public.finance_payment_allocation_intents (payment_request_id, order_id)
  where status = 'pending' and order_id is not null;

-- Reading every intent of one payment is the common access path (approval, the
-- detail modal, the deletion snapshot).
create index if not exists finance_payment_allocation_intents_payment_idx
  on public.finance_payment_allocation_intents (payment_request_id);


-- ── Capacity: intents may not promise more than the payment is worth ─────────
--
-- A cross-row rule, so it is a trigger rather than a CHECK — the same shape and
-- the same reasoning as finance_payment_allocations_enforce_capacity
-- (20260918000000 §5), including the FOR UPDATE lock on the parent payment so
-- two concurrent inserts serialize instead of both reading a stale total.
--
-- Intents and allocations are counted TOGETHER against the payment. A payment
-- that already has an active allocation has that much less left to intend, or a
-- request could promise money it has already spent.

create or replace function public.finance_payment_allocation_intents_enforce_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_amount   numeric;
  v_intended numeric;
  v_active   numeric;
begin
  if new.status <> 'pending' then
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

  select coalesce(sum(i.intended_amount), 0) into v_intended
  from public.finance_payment_allocation_intents i
  where i.payment_request_id = new.payment_request_id
    and i.status = 'pending'
    and i.id <> new.id;

  select coalesce(sum(a.allocated_amount), 0) into v_active
  from public.finance_payment_allocations a
  where a.payment_request_id = new.payment_request_id
    and a.status = 'active';

  if v_intended + v_active + new.intended_amount > v_amount then
    raise exception
      'INTENT_EXCEEDS_PAYMENT: intending % would take this payment''s intended-and-allocated total to % against a payment of %',
      new.intended_amount, v_intended + v_active + new.intended_amount, v_amount
      using errcode = 'P0001';
  end if;

  return new;
end $$;

-- REVOKED, like every trigger function 20260918000000 created. PostgreSQL
-- refuses to call a trigger function outside a trigger anyway ("trigger
-- functions can only be called as triggers"), so this closes no hole — but a
-- Supabase project's `grant all on functions` default leaves a SECURITY DEFINER
-- function reachable by anon on paper, and a privilege with no purpose is one
-- fewer thing to reason about. The trigger itself is unaffected: the executor
-- invokes it, not a role holding EXECUTE.
revoke execute on function public.finance_payment_allocation_intents_enforce_capacity()
  from public, anon, authenticated;

comment on function public.finance_payment_allocation_intents_enforce_capacity() is
  'Refuses an intent that would take a payment''s pending-intent plus active-allocation total above its amount. Locks the parent payment FOR UPDATE first, so concurrent intents against one payment serialize.';

drop trigger if exists finance_payment_allocation_intents_enforce_capacity
  on public.finance_payment_allocation_intents;
create trigger finance_payment_allocation_intents_enforce_capacity
  before insert or update on public.finance_payment_allocation_intents
  for each row execute function public.finance_payment_allocation_intents_enforce_capacity();


-- ── Test-data stamping, if the project's marker exists ───────────────────────
-- Attached conditionally: the function is created by the reset protocol
-- (20261010000000) and this migration must not depend on a specific ordering
-- beyond its own numbering.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'stamp_is_test_data'
  ) then
    execute 'drop trigger if exists finance_payment_allocation_intents_stamp_test_data
               on public.finance_payment_allocation_intents';
    execute 'create trigger finance_payment_allocation_intents_stamp_test_data
               before insert on public.finance_payment_allocation_intents
               for each row execute function public.stamp_is_test_data()';
  end if;
end $$;


-- ── Row-level security ───────────────────────────────────────────────────────
--
-- READ follows the payment: whoever may see the payment row may see what it
-- intends. WRITE belongs to nobody — every insert and update below happens
-- inside a SECURITY DEFINER function, so there is deliberately no INSERT,
-- UPDATE or DELETE policy at all. A client that reaches this table directly
-- through PostgREST can read its own payments' intents and change nothing.

alter table public.finance_payment_allocation_intents enable row level security;

drop policy if exists finance_payment_allocation_intents_select
  on public.finance_payment_allocation_intents;
create policy finance_payment_allocation_intents_select
  on public.finance_payment_allocation_intents
  for select
  using (
    exists (
      select 1 from public.finance_payment_requests f
      where f.id = finance_payment_allocation_intents.payment_request_id
    )
  );

-- ── Table privileges: REVOKED BY NAME, not by omission ──────────────────────
--
-- A SUPABASE PROJECT GRANTS ALL ON EVERY NEW TABLE. The project bootstrap runs
--
--   alter default privileges in schema public
--     grant all on tables to anon, authenticated, service_role;
--
-- for the role the migration runner connects as, so `create table` above did
-- not produce an empty ACL: it produced
--
--   authenticated=arwdDxt/postgres
--
-- — INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER, already
-- granted, before this file says anything about privileges.
--
-- THE FIRST VERSION OF THIS BLOCK GOT IT WRONG, and §9f caught it in production:
--
--   revoke all ... from public, anon;          -- never names `authenticated`
--   grant select ... to authenticated;         -- an ADDITION on top of ALL
--
-- Revoking from PUBLIC and anon leaves the authenticated grant untouched, and
-- granting SELECT to a role that already holds everything narrows nothing. A
-- local database has no such default privileges, so the mistake was invisible
-- until it met a real project.
--
-- SO EVERY WRITE IS REVOKED BY NAME. This is the stance 20260918000000 §13 took
-- for finance_payment_allocations, and it is restated here rather than reasoned
-- about again: the privilege check refuses a client write BEFORE any policy is
-- consulted, and the SECURITY DEFINER doors in §3, §4 and §8 are the only way
-- in. Two independent refusals of every direct INSERT, UPDATE and DELETE.
--
-- IT READS THE SAME IN BOTH WORLDS. On a project the revokes narrow; on a bare
-- database they are no-ops and the grant is what gives authenticated its SELECT.
-- One statement set, one outcome, whatever the table inherited.
--
-- service_role KEEPS ITS DEFAULT ALL, exactly as it does on every other Finance
-- table. It is the server-side key that bypasses RLS by design; singling this
-- table out would break the tooling that reaches every other one.

revoke all on public.finance_payment_allocation_intents from public;

revoke insert, update, delete, truncate, references, trigger
  on public.finance_payment_allocation_intents from anon, authenticated;

-- ANON IS CLOSED OUTRIGHT, SELECT included. Nothing reads an intent
-- unauthenticated: the policy above is anchored to a payment row anon cannot
-- see, so the privilege has no purpose — and a privilege with no purpose is one
-- fewer thing a future policy edit can accidentally open.
revoke select on public.finance_payment_allocation_intents from anon;

grant select on public.finance_payment_allocation_intents to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §3. submit_payment_request — one protected door for the Payment Request form
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The form used to INSERT into finance_payment_requests directly. That was
-- workable while the only server-derived field was the Order's client name (the
-- enforce_finance_payment_request_client_name trigger, 20260688 §2) — but a
-- payment and its intent must be written together or not at all, and a client
-- cannot be trusted to do two writes atomically.
--
-- THE CUSTOMER IS NEVER ACCEPTED FROM THE CALLER. There is no p_client_name
-- parameter, deliberately: a caller cannot supply one to be overridden, because
-- a parameter that is ignored is a parameter somebody will eventually rely on.
-- The name is read from the target under this transaction, or the payment is a
-- Suspense payment and has none.
--
-- WHAT IT DOES NOT DO. It creates no allocation. A payment request is
-- unverified money; §5 converts its intent when Finance approves.

create or replace function public.submit_payment_request(
  p_destination     text,                     -- 'pi_draft' | 'confirmed_order' | 'suspense'
  p_target_id       uuid    default null,     -- the PI Draft or the Order; null for suspense
  p_amount          numeric default null,
  p_payment_date    date    default null,
  p_payment_mode    text    default null,
  p_proof_note      text    default null,
  p_sales_note      text    default null,
  -- ── The cash trail ──
  --
  -- Kept because it is a live business process, not because the account picker
  -- used to sit beside it: somebody collects cash today and hands it over
  -- tomorrow, and that is a financial accountability record with its own five
  -- columns since 20260716000000. WHAT DECIDES WHETHER IT IS RECORDED IS THE
  -- PAYMENT MODE, server-side — see §3.6. A caller that sends a collector on a
  -- bank transfer has it discarded, not honoured, because a form field the
  -- browser happened to leave filled in is not a fact about the money.
  p_collected_by    uuid    default null,
  p_collected_from  text    default null,
  p_handed_over_to  uuid    default null,
  p_handed_over_at  date    default null,
  p_collection_note text    default null
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
  v_client   text;
  v_sub      public.order_submissions%rowtype;
  v_ord      public.orders%rowtype;
  v_target_t text;
  v_payment  uuid;
  v_number   text;
  v_intent   uuid;
  v_cash     boolean;
begin
  -- ── 1. Actor and permission ──
  if v_actor is null then
    raise exception 'Authentication required to submit a payment request'
      using errcode = '28000';
  end if;

  if not public.module_entry_open('finance') then
    raise exception 'FINANCE_MODULE_CLOSED: the Finance module is not open to you.'
      using errcode = '42501';
  end if;

  -- ── 2. The shape of the request, before anything is read or written ──
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

  -- THE CANONICAL FIVE. The same domain finance_payment_requests' own CHECK
  -- carries since 20260628000200 — restated here so the caller is told which
  -- five, rather than being handed a constraint-violation message.
  if v_mode not in ('bank_transfer', 'cash', 'upi', 'cheque', 'other') then
    raise exception
      'PAYMENT_MODE_INVALID: choose Bank Transfer, Cash, UPI, Cheque or Other.'
      using errcode = 'P0001';
  end if;

  -- ── 3. Resolve the target, and with it the customer ──
  --
  -- Read under this transaction and taken as the truth. The eligibility rules
  -- are the ones allocate_payment_to_target_internal will apply again at
  -- approval; checking them now means a person is told at submission rather
  -- than days later when Finance tries to approve.
  if v_dest = 'pi_draft' then
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
        'PAYMENT_TARGET_NO_CLIENT: that PI Draft has no customer on file. Correct the PI before recording a payment against it.'
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
    -- SUSPENSE. No target, and therefore no customer. NULL is the honest value
    -- and §1 is what makes it storable; nothing is invented to fill the column.
    v_client   := null;
    v_target_t := null;
  end if;

  -- ── 3.6. The cash trail belongs to cash ──
  --
  -- The form shows these fields only for Cash; this decides it again, because a
  -- hidden field is not an authorization and a stale one is not a fact. Every
  -- other mode stores five NULLs — not "unknown", but "nobody carried this".
  v_cash := v_mode = 'cash';

  -- ── 4. The payment row ──
  --
  -- pending_approval, exactly as the form's direct insert wrote it. No order_id
  -- and no order_request_id are set for ANY destination: those columns are
  -- provenance since 20261012000000 and this migration does not start writing
  -- money into them again. What the payment is for lives in the intent.
  --
  -- received_in IS NULL, ALWAYS. The four-account picker that used to derive it
  -- alongside payment_mode is gone from this form, and there is no honest value
  -- to put here in its place: the column has been nullable since
  -- 20260919000000 and null means the receiving account was not stated. Nothing
  -- is invented to fill it.
  --
  -- order_number IS NULL TOO. It denormalises a Confirmed Order's number, and
  -- no destination here writes order_id — so a value in it would name a link
  -- the row does not have.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     proof_note, sales_note, status, submitted_by, payment_against,
     collected_by_user_id, collected_from_text,
     handed_over_to_user_id, handed_over_at, collection_handover_note)
  values
    (v_client, p_amount, p_payment_date, v_mode, null,
     nullif(btrim(coalesce(p_proof_note, '')), ''),
     nullif(btrim(coalesce(p_sales_note, '')), ''),
     'pending_approval', v_actor, 'new_order',
     case when v_cash then p_collected_by end,
     case when v_cash then nullif(btrim(coalesce(p_collected_from, '')), '') end,
     case when v_cash then p_handed_over_to end,
     case when v_cash then p_handed_over_at end,
     case when v_cash then nullif(btrim(coalesce(p_collection_note, '')), '') end)
  returning id, request_number into v_payment, v_number;

  -- ── 5. The intent, for a targeted destination ──
  if v_target_t is not null then
    insert into public.finance_payment_allocation_intents
      (payment_request_id, target_type, order_submission_id, order_id,
       intended_amount, created_by)
    values
      (v_payment, v_target_t,
       case when v_target_t = 'pi_draft'        then p_target_id end,
       case when v_target_t = 'confirmed_order' then p_target_id end,
       p_amount, v_actor)
    returning id into v_intent;
  end if;

  return jsonb_build_object(
    'payment_request_id', v_payment,
    'request_number',     v_number,
    'destination',        v_dest,
    'client_name',        v_client,
    'intent_id',          v_intent,
    'allocation_created', false
  );
end $$;

comment on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text) is
  'The one door the Payment Request form writes through. Validates the destination, resolves the target, DERIVES the customer from it server-side (NULL for Suspense — never invented), writes the pending payment and its allocation INTENT in one transaction, and creates no allocation. There is no client-name parameter on purpose. received_in is always NULL: the account picker is gone and nothing is invented in its place. The cash trail is stored only when payment_mode is cash, decided here rather than by which fields the form happened to draw.';

revoke execute on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)
  from public, anon;
grant execute on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §4. apply_payment_allocation_intents — the conversion, in one place
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Called by approval, under approval's lock on the payment row. Every pending
-- intent becomes an active allocation through
-- allocate_payment_to_target_internal — the SAME door Allocate Funds and the
-- split-entry form use, so the target is re-validated, the balance re-computed
-- under the payment lock, and a duplicate claim refused, by the code that
-- already owns those rules. Nothing here re-implements them.
--
-- IDEMPOTENT BY CONSTRUCTION. It converts rows whose status is 'pending', and
-- sets them to 'applied' in the same statement's transaction. A retry finds no
-- pending rows and creates nothing. The unique indexes in §2 and the allocator's
-- own ALLOCATION_DUPLICATE are the second and third lines of that defence.
--
-- ALL OR NOTHING. Any failure raises, and the caller's transaction — the whole
-- approval — rolls back: no allocation, no consumed intent, no half-approved
-- payment. That is why this does not catch anything.
--
-- ── THE CONVERSION ORDER, AND WHY IT CANNOT DOUBLE-COUNT ──────────────────────
--
-- The allocation is created FIRST and the intent is marked 'applied' second.
-- That order is forced: finance_payment_allocation_intents_applied_pair requires
-- an intent claiming 'applied' to name the allocation it became, and the id does
-- not exist until the allocator has returned it. So for the width of one
-- statement an intent row and its allocation row both exist.
--
-- NOTHING COUNTS BOTH, and the exclusion is explicit rather than incidental:
--
--   * finance_payment_allocations_enforce_capacity (20260918000000 §5) sums
--     ACTIVE ALLOCATIONS ONLY. It does not read this table at all, and §9's
--     apply-time assertion refuses to install a version that does — so the
--     intent being converted is excluded from the allocator's arithmetic by
--     construction, not by luck.
--
--   * finance_payment_allocation_intents_enforce_capacity sums pending intents
--     AND active allocations, but returns early for any row whose new status is
--     not 'pending'. The only intent write in this loop sets 'applied', so it
--     never re-enters the check that would have seen its own allocation.
--
--   * The POST-CONDITION below closes the loop: after each conversion the
--     payment's pending-intent-plus-active-allocation total is re-derived and
--     required to be within the payment amount. A future change that made
--     either trigger count both would fail here, in the transaction that caused
--     it, rather than silently over-allocating a payment.

create or replace function public.apply_payment_allocation_intents(p_payment_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent  record;
  v_alloc   jsonb;
  v_applied jsonb := '[]'::jsonb;
  v_count   int := 0;
  v_amount  numeric;
  v_pending numeric;
  v_active  numeric;
begin
  for v_intent in
    select *
    from public.finance_payment_allocation_intents
    where payment_request_id = p_payment_request_id
      and status = 'pending'
    order by created_at, id
    for update
  loop
    v_alloc := public.allocate_payment_to_target_internal(
      p_payment_request_id  => p_payment_request_id,
      p_order_submission_id => v_intent.order_submission_id,
      p_order_id            => v_intent.order_id,
      p_allocated_amount    => v_intent.intended_amount
    );

    update public.finance_payment_allocation_intents
       set status                = 'applied',
           applied_allocation_id = (v_alloc->>'allocation_id')::uuid,
           applied_at            = now()
     where id = v_intent.id;

    -- ── POST-CONDITION: this payment is not over its own amount ──
    --
    -- Re-derived from the tables rather than from a running total, so it holds
    -- whatever the two capacity triggers happen to do. If an intent and the
    -- allocation it became were ever counted together, this is where it stops.
    select f.amount into v_amount
    from public.finance_payment_requests f
    where f.id = p_payment_request_id;

    select coalesce(sum(i.intended_amount), 0) into v_pending
    from public.finance_payment_allocation_intents i
    where i.payment_request_id = p_payment_request_id
      and i.status = 'pending';

    select coalesce(sum(a.allocated_amount), 0) into v_active
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_request_id
      and a.status = 'active';

    if v_pending + v_active > v_amount then
      raise exception
        'INTENT_CONVERSION_DOUBLE_COUNTED: after converting intent %, this payment holds % pending and % allocated against an amount of %',
        v_intent.id, v_pending, v_active, v_amount
        using errcode = 'P0001';
    end if;

    v_count  := v_count + 1;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object(
      'intent_id',     v_intent.id,
      'target_type',   v_intent.target_type,
      'allocation_id', v_alloc->>'allocation_id',
      'amount',        v_intent.intended_amount
    ));
  end loop;

  return jsonb_build_object('applied_count', v_count, 'applied', v_applied);
end $$;

comment on function public.apply_payment_allocation_intents(uuid) is
  'Converts every PENDING allocation intent of one payment into an active allocation, through allocate_payment_to_target_internal so the target is re-validated and the balance re-checked by the canonical allocator. The allocation is created before the intent is marked applied (the applied_pair CHECK forces that order); nothing counts both, and a post-condition re-derives the pending-plus-allocated total after each conversion to prove it. Idempotent: a retry finds nothing pending. Raises on any failure so the caller''s transaction rolls the whole approval back. Executable by no role — approval calls it.';

revoke execute on function public.apply_payment_allocation_intents(uuid)
  from public, anon, authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- §5. approve_finance_payment_request — verification now attaches the money
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Restated from 20260901000000 with ONE addition: after the status transition,
-- pending intents are converted. Everything else is carried across unchanged —
-- the authorization, the peek-then-lock ordering, the Order Request
-- revalidation, the status rules, the result shape.
--
-- WHY THE CONVERSION COMES LAST. The payment must be verified money before any
-- of it is attributed; allocate_payment_to_target_internal reads the payment row
-- it is allocating against, and it should read the approved one.
--
-- WHAT CHANGES FOR A CONFIRMED-ORDER REQUEST. Before this migration it approved
-- to 'approved_linked' with order_id set and NO allocation — which, since
-- 20261012000000 made that column provenance, meant the Order received nothing.
-- Now it also receives a real allocation. The status and the column are left
-- exactly as they were: they are how the rest of the system recognises a
-- linked-origin payment, and changing them is not this migration's business.

create or replace function public.approve_finance_payment_request(
  p_request_id uuid,
  p_admin_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_peek        public.finance_payment_requests%rowtype;
  v_req         public.finance_payment_requests%rowtype;
  v_order_req   public.order_requests%rowtype;
  v_order_id    uuid;
  v_number      text;
  v_status      text;
  v_now         timestamptz := now();
  v_intents     jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required to approve a payment request'
      using errcode = '28000';
  end if;

  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only an admin may approve a payment request'
      using errcode = '42501';
  end if;

  select * into v_peek
  from public.finance_payment_requests
  where id = p_request_id;

  if not found then
    raise exception 'Payment request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  if v_peek.order_request_id is not null then
    select * into v_order_req
    from public.order_requests
    where id = v_peek.order_request_id
    for update;
  end if;

  select * into v_req
  from public.finance_payment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  if v_req.status <> 'pending_approval' then
    raise exception 'Only a pending payment request can be approved (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  if v_req.order_request_id is distinct from v_peek.order_request_id then
    raise exception 'PAYMENT_TARGET_CHANGED: The target of payment % changed while it was being approved. Refresh and try again.',
      v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.payment_target_type = 'confirmed_order' then
    if v_req.order_id is null then
      raise exception 'Payment request % has no linked order to approve against', v_req.request_number
        using errcode = 'P0001';
    end if;

    select o.display_number into v_number
    from public.orders o
    where o.id = v_req.order_id;

    v_order_id := v_req.order_id;
    v_status   := 'approved_linked';
  else
    v_order_id := null;
    v_number   := null;
    v_status   := 'approved_unlinked';

    if v_req.order_request_id is not null then
      if v_order_req.id is null then
        raise exception 'ORDER_REQUEST_NOT_FOUND: Order Request % no longer exists. Correct the payment request before approving it.',
          coalesce(v_req.order_request_number, v_req.order_request_id::text)
          using errcode = 'P0001';
      end if;

      if v_order_req.finalized_at is null then
        raise exception 'ORDER_REQUEST_NOT_AVAILABLE: Order Request % is not a submitted request. Correct the payment request before approving it.',
          v_order_req.request_number
          using errcode = 'P0001';
      end if;

      if v_order_req.converted_order_id is not null or v_order_req.status = 'converted' then
        raise exception 'ORDER_REQUEST_CONVERTED: Order Request % has already been converted to a Confirmed Order. Re-target this payment at that Order before approving it.',
          v_order_req.request_number
          using errcode = 'P0001';
      end if;

      if v_order_req.status not in ('submitted', 'needs_clarification', 'rejected') then
        raise exception 'ORDER_REQUEST_NOT_ACTIVE: Order Request % is % and cannot hold an approved payment.',
          v_order_req.request_number, v_order_req.status
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  update public.finance_payment_requests
     set status       = v_status,
         order_id     = v_order_id,
         order_number = v_number,
         approved_by  = v_actor,
         approved_at  = v_now,
         admin_note   = p_admin_note,
         updated_at   = v_now
   where id = p_request_id;

  -- ── NEW: verification attaches the money ──
  --
  -- Inside this transaction and after the status is verified. A failure here —
  -- a PI deleted since submission, an Order cancelled, a balance no longer
  -- sufficient — raises out of approve_finance_payment_request entirely, so the
  -- status update above rolls back with it. There is no state in which the
  -- payment is approved and its intent half-converted.
  v_intents := public.apply_payment_allocation_intents(p_request_id);

  return jsonb_build_object(
    'request_id',            v_req.id,
    'request_number',        v_req.request_number,
    'status',                 v_status,
    'payment_target_type',    v_req.payment_target_type,
    'order_id',               v_order_id,
    'order_display_number',   v_number,
    'order_request_id',       v_req.order_request_id,
    'order_request_number',   v_req.order_request_number,
    'approved_at',            v_now,
    'allocations_applied',    coalesce(v_intents->'applied_count', to_jsonb(0)),
    'allocations',            coalesce(v_intents->'applied', '[]'::jsonb)
  );
end;
$$;

comment on function public.approve_finance_payment_request(uuid, text) is
  'Verifies a pending payment request and, in the same transaction, converts its pending allocation intents into active allocations (20261013000000). Every earlier rule is unchanged. A target that has become ineligible since submission fails the whole approval rather than approving money onto nothing.';

revoke execute on function public.approve_finance_payment_request(uuid, text) from public, anon;
grant execute on function public.approve_finance_payment_request(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §6. Rejection cancels intents; it never allocates
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A rejected request's intention did not happen. The rows are CANCELLED rather
-- than deleted, so "what did this payment claim to be for before it was
-- refused?" stays answerable — the same choice 20260918000000 made for reversed
-- allocations, for the same reason.
--
-- Attached as a trigger rather than folded into the reject RPC because there is
-- more than one way a request leaves pending_approval, and the intent must not
-- survive as 'pending' behind any of them. A row that moves to rejected keeps
-- no live claim on a target.

create or replace function public.finance_payment_requests_cancel_intents_on_reject()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    update public.finance_payment_allocation_intents
       set status           = 'cancelled',
           cancelled_at     = now(),
           cancelled_reason = 'payment request rejected'
     where payment_request_id = new.id
       and status = 'pending';
  end if;
  return new;
end $$;

revoke execute on function public.finance_payment_requests_cancel_intents_on_reject()
  from public, anon, authenticated;

comment on function public.finance_payment_requests_cancel_intents_on_reject() is
  'Cancels a rejected payment request''s pending allocation intents. Cancelled, not deleted: what the money claimed to be for stays auditable. Never creates an allocation.';

drop trigger if exists finance_payment_requests_cancel_intents_on_reject
  on public.finance_payment_requests;
create trigger finance_payment_requests_cancel_intents_on_reject
  after update of status on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_cancel_intents_on_reject();


-- ═══════════════════════════════════════════════════════════════════════════
-- §7. record_payment_with_allocations — the customer comes from the targets
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Restated from 20261009000000 with exactly two changes, both about the
-- customer. Everything else — the permission gates, the destination-pair
-- validation, the allocation-list shape checks, the atomic write through
-- allocate_payment_to_target_internal, the PI activity entries, the result
-- shape — is carried across unchanged.
--
--   1. p_client_name is ignored rather than required. The parameter stays so
--      that no caller breaks; the value is discarded so that no caller decides
--      whose money this is. PAYMENT_CLIENT_REQUIRED is gone.
--   2. The stored name is derived from the validated targets, or NULL.
--
-- SUSPENSE IS NOW EXPRESSIBLE WITHOUT TYPING ANYTHING. An empty allocation list
-- was always allowed — "that is the plain unallocated payment Finance has
-- always been able to record" — but it still demanded a typed customer. It no
-- longer does.
--
-- p_received_in is untouched and still optional. The Record Payment form stops
-- SENDING it (nullable since 20260919000000); nothing here fabricates a value.

create or replace function public.record_payment_with_allocations(
  p_amount       numeric,
  p_payment_date date,
  p_payment_mode text,
  p_client_name  text,
  p_received_in  text    default null,
  p_reference    text    default null,
  p_remarks      text    default null,
  p_allocations  jsonb   default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_client     text;
  v_mode       text;
  v_received   text;
  v_reference  text;
  v_remarks    text;
  v_payment_id uuid;
  v_number     text;
  v_count      integer;
  v_index      integer := 0;
  v_row        jsonb;
  v_kind       text;
  v_target     uuid;
  v_share      numeric;
  v_sum        numeric := 0;
  v_alloc      jsonb;
  v_results    jsonb := '[]'::jsonb;
begin
  -- ── 1. Authorization, before anything is read or written ──
  --
  -- TWO GATES, BOTH REQUIRED, BECAUSE THIS DOOR DOES TWO THINGS.
  --
  --   finance module entry  is what the RESTRICTIVE gate on
  --     finance_payment_requests demands of every write to that table
  --     (20260919000000 §2). A SECURITY DEFINER function bypasses RLS, so the
  --     gate is asked here explicitly rather than being silently skipped —
  --     this must not become a way around the policy the form obeys.
  --
  --   finance.allocate      is the protected action registered for allocating
  --     money (20260918000000), and it is what allocate_payment_to_target()
  --     requires of the person doing this after the fact. Entering the same
  --     allocations a minute earlier is the same act and needs the same
  --     authority. Wider Finance sight — finance.view, finance.view_all,
  --     finance.approve — reaches this line and is refused.
  --
  -- A person who may record a payment but not allocate one still has the
  -- Finance entry form, which is untouched. Nothing is taken away here.
  if not public.module_entry_open('finance') then
    raise exception 'PAYMENT_ENTRY_NOT_PERMITTED: you do not have access to Finance.'
      using errcode = '42501';
  end if;

  if not public.actor_has_module_permission('finance', 'allocate') then
    raise exception
      'PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED: you do not have permission to allocate payments.'
      using errcode = '42501';
  end if;

  -- ── 2. The payment-level facts ──
  --
  -- The same three mandatory fields the PI door requires, validated with the
  -- same rules and the same messages, plus the client the money is attributed
  -- to. A multi-destination payment has no single record to derive a client
  -- from — that is the whole point of it — so the payer is stated.
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

  -- Bounded rather than exact, for the same reason 20260919000000 bounds it:
  -- the browser's clock and the server's need not agree to the second.
  if p_payment_date > (now() at time zone 'utc')::date + 1 then
    raise exception 'PAYMENT_DATE_FUTURE: a payment date cannot be in the future.'
      using errcode = 'P0001';
  end if;

  v_mode := nullif(btrim(lower(coalesce(p_payment_mode, ''))), '');
  if v_mode is null or v_mode not in ('bank_transfer', 'cash', 'upi', 'cheque', 'other') then
    raise exception
      'PAYMENT_MODE_INVALID: choose one of Bank Transfer, Cash, UPI, Cheque or Other.'
      using errcode = 'P0001';
  end if;

  -- The EXISTING closed domain, and NULL still means "not stated" (20260919000000
  -- §1). A value outside it is refused here rather than surfacing as a raw check
  -- violation.
  v_received := nullif(btrim(lower(coalesce(p_received_in, ''))), '');
  if v_received is not null
     and v_received not in ('company_account', 'cash_in_hand', 'savings_account', 'other')
  then
    raise exception
      'PAYMENT_DESTINATION_INVALID: choose one of Company Account, Cash in Hand, Savings Account or Other.'
      using errcode = 'P0001';
  end if;

  -- ── THE CUSTOMER IS DERIVED, NEVER TYPED (20261013000000) ──
  --
  -- p_client_name is IGNORED. It stays in the signature so no caller breaks,
  -- and its value is discarded so no caller can steer what this row says about
  -- whose money it is. The name comes from the targets, resolved below, after
  -- the allocation list has been validated — a name derived from a target that
  -- turns out to be ineligible would be a name attached to a payment that never
  -- gets written.
  --
  -- A payment with no allocations is a Suspense entry: no target, therefore no
  -- customer, therefore NULL. That is what §1 of 20261013000000 made storable,
  -- and it replaces the PAYMENT_CLIENT_REQUIRED refusal that used to stand here
  -- and force somebody to type something.
  v_client := null;

  v_reference := nullif(btrim(coalesce(p_reference, '')), '');
  v_remarks   := nullif(btrim(coalesce(p_remarks, '')), '');

  -- ── 3. The SHAPE of the allocation list, before a single row is written ──
  --
  -- Every structural complaint is raised here, so a malformed list costs no
  -- payment row and no rollback: the caller learns the list is wrong before
  -- anything at all has happened.
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception
      'PAYMENT_ALLOCATIONS_INVALID: the allocation list must be an array.'
      using errcode = 'P0001';
  end if;

  v_count := jsonb_array_length(p_allocations);

  -- A BOUND, so one request cannot take an unbounded number of row locks. Twenty
  -- destinations is far beyond any real payment and well short of anything that
  -- would hold the cycle or the payment lock long enough to matter.
  if v_count > 20 then
    raise exception
      'PAYMENT_ALLOCATIONS_TOO_MANY: a payment may be divided at most 20 ways in one entry.'
      using errcode = 'P0001';
  end if;

  for v_row in select jsonb_array_elements(p_allocations) loop
    v_index := v_index + 1;

    if jsonb_typeof(v_row) <> 'object' then
      raise exception
        'PAYMENT_ALLOCATION_ROW_INVALID: row % is not an allocation.', v_index
        using errcode = 'P0001';
    end if;

    v_kind := nullif(btrim(lower(coalesce(v_row->>'kind', ''))), '');
    if v_kind is null or v_kind not in ('order', 'submission') then
      raise exception
        'PAYMENT_ALLOCATION_KIND_INVALID: row % must name a Confirmed Order or a PI Draft.', v_index
        using errcode = 'P0001';
    end if;

    -- A malformed uuid is a malformed REQUEST, not a missing record: said in
    -- its own words so it is never mistaken for "that target is not available",
    -- which is what a caller sees when a real id is refused.
    begin
      v_target := (v_row->>'id')::uuid;
    exception when others then
      v_target := null;
    end;

    if v_target is null then
      raise exception
        'PAYMENT_ALLOCATION_TARGET_INVALID: row % does not name a record.', v_index
        using errcode = 'P0001';
    end if;

    -- Numeric parsing is likewise a shape question. round(,2) is asserted here
    -- as well as inside the allocator so the message names the ROW.
    begin
      v_share := (v_row->>'amount')::numeric;
    exception when others then
      v_share := null;
    end;

    if v_share is null
       or v_share = 'NaN'::numeric
       or v_share <= 0
       or v_share <> round(v_share, 2)
    then
      raise exception
        'PAYMENT_ALLOCATION_AMOUNT_INVALID: row % must allocate a positive amount in rupees and paise.',
        v_index
        using errcode = 'P0001';
    end if;

    v_sum := v_sum + v_share;
  end loop;

  -- THE WHOLE MAY NOT EXCEED THE PART IT COMES FROM. The allocator re-checks
  -- this under the payment lock for every row it writes and is the actual
  -- guarantee; this states it up front so the caller is told the total is wrong
  -- rather than being told the last row would not fit.
  if v_sum > p_amount then
    raise exception
      'PAYMENT_ALLOCATIONS_EXCEED_AMOUNT: % allocated is more than the % received.',
      v_sum, p_amount
      using errcode = 'P0001';
  end if;

  -- ── 4. The payment ──
  --
  -- NO DIRECT LINKAGE IS WRITTEN, on purpose. order_id and order_request_id are
  -- left NULL, so finance_payment_requests_derive_target (20260715000000)
  -- classifies the row as it classifies a PI payment, and the ALLOCATIONS are
  -- the only statement about where this money went. Under the canonical rule
  -- (PR #49) active allocations are authoritative and the direct link is only a
  -- fallback when there are none — so writing one here would be a second, weaker
  -- claim beside the true one.
  --
  -- request_number comes from the existing BEFORE INSERT trigger and the Finance
  -- activity row from the existing trigger. This function writes neither by hand.
  -- ── The display customer, from the targets themselves ──
  --
  -- THE RULE, stated once and asserted in the suite:
  --   no targets                    -> NULL   (a Suspense entry has no customer)
  --   every target, one customer    -> that customer
  --   targets naming two or more    -> NULL   (no single customer is the truth)
  --
  -- NULL for the mixed case rather than a summary string: "Multiple customers"
  -- is a sentence about a payment, not the name of a customer, and writing it
  -- into client_name would make it searchable as one and countable as one. The
  -- payment's allocations already name every customer individually, so nothing
  -- is lost — the application's shared formatter reads the allocation set and
  -- says "Multiple customers" at the point of display, where a sentence belongs.
  --
  -- The list has already been validated above, so every id here resolves.
  select case when count(distinct name) = 1 then min(name) end into v_client
  from (
    select nullif(btrim(coalesce(
             case when btrim(lower(t->>'kind')) = 'submission'
                  then (select s.client_name from public.order_submissions s
                         where s.id = (t->>'id')::uuid)
                  else (select o.client_name from public.orders o
                         where o.id = (t->>'id')::uuid)
             end, '')), '') as name
    from jsonb_array_elements(p_allocations) as t
  ) names
  where name is not null;

  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     status, submitted_by, sales_note, order_number)
  values
    (v_client, p_amount, p_payment_date, v_mode, v_received,
     'pending_approval', v_actor, v_remarks, v_reference)
  returning id, request_number into v_payment_id, v_number;

  -- ── 5. The allocations, each through the canonical door ──
  --
  -- In the order the caller listed them, so a refusal names the row the person
  -- is looking at. The FIRST failure aborts everything: there is no partial
  -- success to report and no state in which some of this payment landed.
  --
  -- A second row naming a target an earlier row already took is refused by the
  -- allocator as ALLOCATION_DUPLICATE — one active claim per payment per target
  -- is the model's rule, guaranteed by its partial unique indexes, and this
  -- inherits it rather than deciding a different answer.
  v_index := 0;
  for v_row in select jsonb_array_elements(p_allocations) loop
    v_index := v_index + 1;
    v_kind   := btrim(lower(v_row->>'kind'));
    v_target := (v_row->>'id')::uuid;
    v_share  := (v_row->>'amount')::numeric;

    v_alloc := public.allocate_payment_to_target_internal(
      p_payment_request_id  => v_payment_id,
      p_order_submission_id => case when v_kind = 'submission' then v_target end,
      p_order_id            => case when v_kind = 'order'      then v_target end,
      p_allocated_amount    => v_share
    );

    -- ── 5a. The PI's own timeline, for a PI destination ──
    --
    -- The same event record_pi_submission_payment() writes, for the same reason:
    -- somebody reading a PI Draft's history must see that money arrived against
    -- it, whichever door recorded it. An Order destination needs no counterpart —
    -- the Finance activity trigger already logged the payment, and the Order
    -- screen reads its allocations directly.
    if v_kind = 'submission' then
      perform public.log_order_submission_activity(
        v_target, v_actor, 'payment_recorded',
        (select s.status from public.order_submissions s where s.id = v_target),
        (select s.status from public.order_submissions s where s.id = v_target),
        null,
        jsonb_build_object(
          'payment_request_id', v_payment_id,
          'request_number',     v_number,
          'amount',             v_share,
          'payment_amount',     p_amount,
          'payment_mode',       v_mode,
          'payment_status',     'pending_approval',
          'allocation_id',      v_alloc->>'allocation_id',
          'split_entry',        true
        )
      );
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row',              v_index,
      'kind',             v_kind,
      'target_id',        v_target,
      'allocation_id',    v_alloc->>'allocation_id',
      'allocated_amount', v_share
    ));
  end loop;

  -- ── 6. What the screen needs, and nothing it could not already read ──
  return jsonb_build_object(
    'payment_request_id',  v_payment_id,
    'request_number',      v_number,
    'amount',              p_amount,
    'payment_date',        p_payment_date,
    'payment_mode',        v_mode,
    'status',              'pending_approval',
    'allocation_count',    v_count,
    'allocated_total',     v_sum,
    'unallocated_balance', p_amount - v_sum,
    'allocations',         v_results
  );
end;
$$;

comment on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb) is
  'Records one payment and divides it across PI Drafts and Confirmed Orders in a single transaction. Since 20261013000000 the customer is DERIVED from the targets — one distinct customer becomes the stored name, no targets or several distinct customers store NULL — and p_client_name is ignored. received_in stays optional and is never fabricated.';

revoke execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)
  from public, anon;
grant execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §8. edit_payment_request — correcting a pending request, destination included
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS. §3 records what a request is FOR as a pending allocation
-- intent rather than in the payment row's linkage columns. That left the edit
-- form with no safe way to re-point a request: a client UPDATE could move
-- order_id without moving the intent, and the payment would then approve onto a
-- record it no longer claimed to be for. Delete-and-resubmit is not a correction
-- workflow — it destroys the request number, the submission timestamp, the
-- activity trail and any attached proof. So the correction becomes a protected
-- RPC that moves the row and its intent together, or moves neither.
--
-- THE PERMISSION IS THE ONE THAT ALREADY EXISTS, restated rather than invented:
-- the submitter, or an admin, and only while the request is unapproved. That is
-- exactly what finance_payment_requests_own_update,
-- finance_payment_requests_admin_update and
-- finance_payment_requests_guard_pending_decision (20260901000000) already
-- allow. This function is SECURITY DEFINER, so it re-derives that rule itself
-- instead of inheriting it — and the guard trigger still fires underneath,
-- which is the second reading of the same rule.
--
-- THE CUSTOMER IS STILL NEVER TYPED. There is no p_client_name parameter here
-- either, for the reason §3 gives: a parameter that is ignored is a parameter
-- somebody will eventually rely on. Changing the destination RE-DERIVES the
-- customer from the new record, and a Suspense correction sets it to NULL.
--
-- IT CREATES NO ALLOCATION, EVER. An edit moves intentions. The post-condition
-- at the end says so in the database rather than in this comment.
--
-- PROOF FILES ARE NOT ITS BUSINESS. payment_proof_attachments rows key on
-- payment_request_id, which this never changes, and no storage object is
-- touched: an edited request keeps exactly the proof it had.

create or replace function public.edit_payment_request(
  p_payment_request_id uuid,
  p_destination     text,
  p_target_id       uuid    default null,
  p_amount          numeric default null,
  p_payment_date    date    default null,
  p_payment_mode    text    default null,
  p_proof_note      text    default null,
  p_sales_note      text    default null,
  p_collected_by    uuid    default null,
  p_collected_from  text    default null,
  p_handed_over_to  uuid    default null,
  p_handed_over_at  date    default null,
  p_collection_note text    default null
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
  v_cash     boolean;
  v_is_admin boolean;
  v_status   text;
  v_intent   uuid;
  v_pending  numeric;
  v_active   numeric;
  v_n        int;
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

  if v_mode not in ('bank_transfer', 'cash', 'upi', 'cheque', 'other') then
    raise exception
      'PAYMENT_MODE_INVALID: choose Bank Transfer, Cash, UPI, Cheque or Other.'
      using errcode = 'P0001';
  end if;

  -- ── 6. Resolve the target, and with it the customer ──
  --
  -- The SAME eligibility rules §3 applies at submission, applied again to the
  -- record that is being moved TO. A correction onto a converted PI or a
  -- cancelled Order is refused here rather than days later at approval.
  if v_dest = 'pi_draft' then
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

  v_cash := v_mode = 'cash';

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
  update public.finance_payment_requests
     set client_name              = v_client,
         amount                   = p_amount,
         payment_date             = p_payment_date,
         payment_mode             = v_mode,
         proof_note               = nullif(btrim(coalesce(p_proof_note, '')), ''),
         sales_note               = nullif(btrim(coalesce(p_sales_note, '')), ''),
         collected_by_user_id     = case when v_cash then p_collected_by end,
         collected_from_text      = case when v_cash then nullif(btrim(coalesce(p_collected_from, '')), '') end,
         handed_over_to_user_id   = case when v_cash then p_handed_over_to end,
         handed_over_at           = case when v_cash then p_handed_over_at end,
         collection_handover_note = case when v_cash then nullif(btrim(coalesce(p_collection_note, '')), '') end,
         status                   = v_status,
         updated_at               = now()
   where id = p_payment_request_id;

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
  if v_target_t is null and v_n <> 0 then
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

  if v_active <> 0 then
    raise exception
      'PAYMENT_EDIT_ALLOCATED: correcting a request must not attach money (found % allocated)', v_active
      using errcode = 'P0001';
  end if;

  select coalesce(sum(i.intended_amount), 0) into v_pending
  from public.finance_payment_allocation_intents i
  where i.payment_request_id = p_payment_request_id and i.status = 'pending';

  if v_pending > p_amount then
    raise exception
      'INTENT_EXCEEDS_PAYMENT: this request now intends % against an amount of %', v_pending, p_amount
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'payment_request_id', p_payment_request_id,
    'request_number',     v_req.request_number,
    'destination',        v_dest,
    'client_name',        v_client,
    'status',             v_status,
    'intent_id',          v_intent,
    'pending_intents',    v_n,
    'allocation_created', false
  );
end $$;

comment on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text) is
  'Corrects a pending payment request, destination included, moving the row and its allocation intent in one transaction. Locks the payment FIRST so an edit racing an approval serializes and the loser is told by name (PAYMENT_ALREADY_APPROVED). Re-derives the customer from the new target — there is no client-name parameter — and sets it NULL for Suspense. Cancels intents rather than deleting them, leaves exactly one pending intent for a targeted destination and none for Suspense, and creates no allocation. Permission is the existing one: the submitter, or an admin, while the request is unapproved.';

revoke execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)
  from public, anon;
grant execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §9. Apply-time assertions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Read back from the catalogue, not from this file: what matters is what the
-- database ended up holding.

do $$
declare
  v_def  text;
  v_n    int;
  v_name text;
begin
  -- ── 9a. client_name is nullable, and its neighbours were not disturbed ──
  select is_nullable into v_def
  from information_schema.columns
  where table_schema = 'public' and table_name = 'finance_payment_requests'
    and column_name = 'client_name';
  if v_def is distinct from 'YES' then
    raise exception 'finance_payment_requests.client_name must be nullable (found is_nullable=%)', v_def;
  end if;

  foreach v_name in array array['amount', 'payment_date', 'payment_mode', 'status'] loop
    select is_nullable into v_def
    from information_schema.columns
    where table_schema = 'public' and table_name = 'finance_payment_requests'
      and column_name = v_name;
    if v_def is distinct from 'NO' then
      raise exception
        'finance_payment_requests.% must stay NOT NULL — this migration relaxes client_name and nothing else', v_name;
    end if;
  end loop;

  -- The payment-mode domain is UNCHANGED. Five values, and no 'card'.
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.finance_payment_requests'::regclass
    and pg_get_constraintdef(oid) like '%payment_mode%';
  if v_def is null then
    raise exception 'the payment_mode domain CHECK must still exist';
  end if;
  foreach v_name in array array['bank_transfer', 'cash', 'upi', 'cheque', 'other'] loop
    if position(v_name in v_def) = 0 then
      raise exception 'the payment_mode CHECK lost the value %', v_name;
    end if;
  end loop;
  if position('card' in v_def) > 0 then
    raise exception 'payment_mode must NOT accept ''card'' — the canonical list is five values';
  end if;

  -- ── 9b. The intent table exists with the shape the model needs ──
  if to_regclass('public.finance_payment_allocation_intents') is null then
    raise exception 'finance_payment_allocation_intents was not created';
  end if;

  foreach v_name in array array[
    'id', 'payment_request_id', 'target_type', 'order_submission_id', 'order_id',
    'intended_amount', 'status', 'applied_allocation_id', 'applied_at',
    'cancelled_at', 'created_by', 'created_at'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'finance_payment_allocation_intents'
        and column_name = v_name
    ) then
      raise exception 'finance_payment_allocation_intents is missing %', v_name;
    end if;
  end loop;

  -- NO ORDER-REQUEST COLUMN, ever. That workflow is retired and a new intent
  -- must not be able to name one.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'finance_payment_allocation_intents'
      and column_name = 'order_request_id'
  ) then
    raise exception 'an intent must never be able to name a retired Order Request';
  end if;

  foreach v_name in array array[
    'finance_payment_allocation_intents_one_target',
    'finance_payment_allocation_intents_applied_pair',
    'finance_payment_allocation_intents_cancelled_pair'
  ] loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.finance_payment_allocation_intents'::regclass
        and conname = v_name
    ) then
      raise exception 'the intent table is missing constraint %', v_name;
    end if;
  end loop;

  -- ── 9c. INTENT IS NOT ALLOCATION ──
  --
  -- The claim this whole migration rests on, checked against the definitions
  -- rather than asserted in a comment: no financial object may read the intent
  -- table. If a later revision starts summing intents into a total, this fails.
  for v_name in
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'order_linked_payment_total',
        'order_submission_verified_payment',
        'order_submission_unverified_payment',
        'pi_submission_payment_summary',
        'allocate_payment_to_target_internal'
      )
  loop
    if pg_get_functiondef(('public.' || v_name)::regproc) ~* 'finance_payment_allocation_intents' then
      raise exception
        'INTENT LEAKED INTO A FINANCIAL FIGURE: %() reads finance_payment_allocation_intents. Only approval may convert an intent.',
        v_name;
    end if;
  end loop;

  if pg_get_viewdef('public.finance_received_payments'::regclass, true)
       ~* 'finance_payment_allocation_intents' then
    raise exception
      'INTENT LEAKED INTO THE PROJECTION: finance_received_payments reads the intent table';
  end if;

  -- AND THE ALLOCATOR'S CAPACITY RULE MUST NOT READ IT EITHER.
  --
  -- This is what makes §4's conversion order safe rather than lucky. The
  -- allocation is created while its intent is still 'pending' — the applied_pair
  -- CHECK forces that order — so if finance_payment_allocations_enforce_capacity
  -- ever started summing intents alongside allocations, every conversion of a
  -- full-amount intent would refuse itself. It counts allocations only, and this
  -- refuses to install a version that does not.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finance_payment_allocations_enforce_capacity'
  ) then
    if pg_get_functiondef('public.finance_payment_allocations_enforce_capacity()'::regprocedure)
         ~* 'finance_payment_allocation_intents' then
      raise exception
        'DOUBLE COUNT: the allocation capacity rule reads the intent table. An intent and the allocation it becomes coexist for the width of one statement (see §4).';
    end if;
  end if;

  -- …and the conversion must still assert its own post-condition.
  select pg_get_functiondef('public.apply_payment_allocation_intents(uuid)'::regprocedure) into v_def;
  if v_def !~* 'INTENT_CONVERSION_DOUBLE_COUNTED' then
    raise exception 'the conversion must re-derive the pending-plus-allocated total after each intent';
  end if;

  -- ── 9d. 20261012000000 is not weakened ──
  -- The direct-link fallback must still be absent from both objects.
  select pg_get_functiondef('public.order_linked_payment_total(uuid)'::regprocedure) into v_def;
  if v_def ~* 'order_id\s*=\s*p_order_id\s+then\s+\S*amount' then
    raise exception 'the direct-link fallback returned to order_linked_payment_total';
  end if;
  select pg_get_viewdef('public.finance_received_payments'::regclass, true) into v_def;
  if v_def ~* 'order_id\s+IS\s+NOT\s+NULL\s+THEN\s+\S*amount' then
    raise exception 'the direct-link fallback returned to finance_received_payments';
  end if;

  -- ── 9e. The Link/Unlink surface stays gone ──
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'link_finance_payment_to_order', 'link_finance_payment_to_order_request',
      'unlink_finance_payment_from_order', 'unlink_finance_payment_from_order_request'
    );
  if v_n <> 0 then
    raise exception '% Link/Unlink function(s) came back', v_n;
  end if;

  -- ── 9f. Exposure ──
  -- The submission door is callable by a signed-in user; the conversion is
  -- callable by nobody; the intent table is readable and not writable.
  if not has_function_privilege('authenticated',
        'public.submit_payment_request(text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)', 'execute') then
    raise exception 'authenticated cannot call submit_payment_request';
  end if;
  if has_function_privilege('anon',
        'public.submit_payment_request(text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)', 'execute') then
    raise exception 'anon must not call submit_payment_request';
  end if;
  if has_function_privilege('authenticated',
        'public.apply_payment_allocation_intents(uuid)', 'execute') then
    raise exception 'apply_payment_allocation_intents must be callable by no client role — approval calls it';
  end if;

  -- The two trigger functions, for the same reason 20260918000000 gave: a
  -- project's `grant all on functions` default would otherwise leave a
  -- SECURITY DEFINER function reachable by anon on paper.
  foreach v_name in array array[
    'public.finance_payment_allocation_intents_enforce_capacity()',
    'public.finance_payment_requests_cancel_intents_on_reject()'
  ] loop
    if has_function_privilege('authenticated', v_name, 'execute')
       or has_function_privilege('anon', v_name, 'execute') then
      raise exception 'the trigger function % must not be executable by a client role', v_name;
    end if;
  end loop;

  -- THE CHECK THAT CAUGHT THE REAL BUG. It is widened here, not softened: the
  -- first version of §2 revoked from PUBLIC and anon and never named
  -- `authenticated`, so a Supabase project's default `grant all on tables`
  -- survived and this refused the migration. That was correct. Every write
  -- privilege is now named, so the next omission cannot slip through a gap
  -- between the three that used to be listed.
  foreach v_name in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('authenticated', 'public.finance_payment_allocation_intents', v_name) then
      raise exception
        'the intent table must be read-only for authenticated (holds %) — revoke it BY NAME: a Supabase project grants ALL on every new table, so revoking from PUBLIC and anon alone leaves this behind. Writes go through the SECURITY DEFINER doors.',
        v_name;
    end if;
  end loop;

  -- …and the read it IS supposed to have must still be there, or the detail and
  -- review modals silently stop being able to say what a payment is for.
  if not has_table_privilege('authenticated', 'public.finance_payment_allocation_intents', 'select') then
    raise exception 'authenticated must keep SELECT on the intent table — the RLS policy is what narrows it, not the absence of the privilege';
  end if;

  -- ANON HOLDS NOTHING AT ALL, read included.
  foreach v_name in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('anon', 'public.finance_payment_allocation_intents', v_name) then
      raise exception 'anon must hold no privilege on the intent table (holds %)', v_name;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class
           where oid = 'public.finance_payment_allocation_intents'::regclass) then
    raise exception 'RLS must be enabled on finance_payment_allocation_intents';
  end if;

  -- ── The correction door: exposed, definer-safe, and customer-free ──
  if not has_function_privilege('authenticated', 'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)', 'execute') then
    raise exception 'authenticated cannot call edit_payment_request';
  end if;
  if has_function_privilege('anon', 'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)', 'execute') then
    raise exception 'anon must not call edit_payment_request';
  end if;

  select pg_get_functiondef('public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text)'::regprocedure) into v_def;
  if v_def !~* 'security definer' then
    raise exception 'edit_payment_request must be SECURITY DEFINER — it re-derives the edit permission itself';
  end if;
  if v_def !~* 'search_path' then
    raise exception 'edit_payment_request must pin its search_path';
  end if;
  if v_def ~* 'p_client_name' then
    raise exception 'edit_payment_request must not accept a customer name — it re-derives one';
  end if;
  if v_def !~* 'for update' then
    raise exception 'edit_payment_request must lock the payment row before it decides anything';
  end if;
  -- The columns a correction may never write. order_id and its friends are
  -- provenance since 20261012000000; received_in has no form asking for it.
  foreach v_name in array array['order_id', 'order_request_id', 'received_in', 'submitted_by'] loop
    if (regexp_match(v_def, '\m' || v_name || '\s*=', 'i')) is not null
       and v_def !~* ('coalesce\(order_submission_id, order_id\)') then
      raise exception 'edit_payment_request must not assign %', v_name;
    end if;
  end loop;

  -- ── 9g. record_payment_with_allocations no longer demands a typed customer ──
  select pg_get_functiondef(
    'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)'::regprocedure
  ) into v_def;
  -- The RAISE, not the mention: a comment that records the refusal was removed
  -- is history worth keeping, and must not read as the refusal still being here.
  if v_def ~* 'raise\s+exception\s+''PAYMENT_CLIENT_REQUIRED' then
    raise exception 'record_payment_with_allocations still refuses an empty customer name';
  end if;
  if v_def !~* 'order_submissions' or v_def !~* 'public\.orders' then
    raise exception 'record_payment_with_allocations must derive the customer from its targets';
  end if;

  -- ── 9h. Approval converts, and the deletion protocol is intact ──
  select pg_get_functiondef('public.approve_finance_payment_request(uuid, text)'::regprocedure) into v_def;
  if v_def !~* 'apply_payment_allocation_intents' then
    raise exception 'approval must convert pending intents';
  end if;

  foreach v_name in array array[
    'begin_finance_payment_deletion', 'finalize_finance_payment_deletion',
    'allocate_payment_to_targets', 'finance_payment_status_is_verified'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
    ) then
      raise exception 'this migration lost %', v_name;
    end if;
  end loop;

  raise notice 'PAYMENT ENTRY DESTINATION MODEL — apply-time assertions passed';
end $$;
