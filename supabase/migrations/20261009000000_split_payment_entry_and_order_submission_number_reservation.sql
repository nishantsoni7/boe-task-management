-- ═══════════════════════════════════════════════════════════════════════════
-- ONE PAYMENT, MANY DESTINATIONS — AND A NUMBER THE PI CAN BE PRINTED WITH
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20261008000000. Nothing before it is edited: 107 and 108 are
-- frozen by SHA-256 in participantAndOrderTotalSecurity.test.ts, and this file
-- is the forward-only correction that rule requires.
--
-- ── THE TWO THINGS THAT WERE MISSING ──────────────────────────────────────
--
-- 1. A REAL PAYMENT ARRIVES ONCE AND PAYS FOR SEVERAL THINGS. The allocation
--    spine has expressed that since 20260918000000 — many allocations, one
--    payment, each naming a PI Draft or a Confirmed Order — but nothing could
--    CREATE such a payment in one act. There were two doors, and each writes
--    exactly one destination:
--
--      record_pi_submission_payment()  one payment, allocated IN FULL to one PI
--      the Finance entry form          one payment, at most one direct linkage
--
--    So a ₹10,00,000 transfer covering two Orders and a PI Draft had to be
--    entered as one payment and then allocated twice more afterwards, through a
--    control the person entering it may not even hold. Between the insert and
--    the last allocation the money sat misclassified, and a failure anywhere in
--    that sequence left a payment attached to less than it paid for.
--
--    §1 is the missing door: ONE transaction that writes the payment and every
--    allocation, or writes nothing.
--
-- 2. THE ORDER NUMBER EXISTED ONLY AFTER IT WAS TOO LATE TO PRINT IT. The
--    number is allocated by orders_assign_display_number as the Order row is
--    inserted, which happens inside approve_order_submission(). The revised PI
--    the customer signs has to CARRY that number, and the only stage at which
--    its owner may replace the workbook is draft/needs_changes — before
--    approval, when no number exists.
--
--    §2–§7 close that gap with a RESERVATION: the PI Draft takes a real number
--    from the real cycle, early, atomically, and keeps it until the Order it
--    becomes is created with that exact number.
--
-- ── WHY A RESERVATION AND NOT A PREVIEW ───────────────────────────────────
--
-- `max(display_number) + 1` read outside a lock is the same number for every
-- reader who asks at the same time. Two salespeople would print the same number
-- on two customers' documents and only discover it at approval, when one of the
-- two commercial documents is already signed. A number that is shown is a
-- number that is spent: this file takes it from allocate_confirmed_order_number()
-- — the same FOR UPDATE on the same singleton cycle row that an Order creation
-- takes — and advances the cycle by it. Two reservations can no more collide
-- than two Orders can.
--
-- AND IT IS NEVER GIVEN BACK. An abandoned reservation leaves a gap in the
-- series. That is the intended outcome: a gap is a question somebody can answer
-- from the record, whereas a reused number is two different commercial documents
-- claiming to be the same Order, which nothing can answer afterwards.
--
-- ── WHAT THIS FILE DELIBERATELY DOES NOT DO ───────────────────────────────
--
--   * It does not make reservation MANDATORY. A PI approved without one is
--     numbered exactly as it is today, from the cycle, at insert. Requiring a
--     reservation would strand every PI already in flight and would rewrite an
--     approved business rule this file has no standing to change. What it does
--     enforce is the other direction: a reservation that EXISTS must be used,
--     and must have been followed by a revised workbook (§7).
--   * It invents no number format and no second series. There is one cycle,
--     one format (four digits, 0001–9999, format_confirmed_order_number), and
--     no legal entity, financial year or branch scopes it — checked against the
--     schema, not assumed. A reservation is a number from that one series.
--   * It creates no second allocation system. §1 writes its allocations through
--     allocate_payment_to_target_internal(), which is where the capacity lock,
--     the duplicate rule, the target eligibility test and the visibility test
--     already live.
--   * It does not revive Order Requests, and cannot: the allocation model has
--     no Order Request target, so §1 has no parameter that could name one.
--   * It touches no historical row. No Order is renumbered, no allocation is
--     rewritten, no payment is reclassified. §9 asserts all three.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ 0. Dependencies ═══════════════════════════════════════════════════════
--
-- Named individually so a missing one says which migration is absent rather
-- than failing later with an undefined-function error inside a function body.

do $$
begin
  if to_regprocedure('public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric)') is null then
    raise exception 'DEPENDENCY MISSING: 20260919000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.allocate_confirmed_order_number()') is null
     or to_regprocedure('public.format_confirmed_order_number(bigint)') is null then
    raise exception 'DEPENDENCY MISSING: 20260704000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.approve_order_submission(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260923000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.reset_confirmed_order_number_cycle(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260926000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.assert_order_submission_workbook_editor(uuid, uuid, text, boolean)') is null then
    raise exception 'DEPENDENCY MISSING: 20261003000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260905000000 must be applied before this migration';
  end if;
end $$;


-- ═══ 1. One payment, divided at the moment it is recorded ══════════════════
--
-- WHAT THE CALLER MAY SUPPLY: the payment-level facts a person actually knows
-- — who paid, how much, when, by what method, into which account, a reference,
-- a remark — and a LIST of destinations with an amount each. Nothing else. The
-- actor, the payment number, the status, every allocation's provenance, its
-- created_by and every audit row are DERIVED, so none of them can be forged.
--
-- THE STATUS IS pending_approval — Awaiting Verification — exactly as
-- record_pi_submission_payment() writes it. This file adds no verification
-- path, exempts nobody from one, and changes no approver's authority. Recording
-- that money arrived and deciding that it did are still two different acts by
-- two different people, and allocating at entry does not merge them.
--
-- A REMAINDER IS ALLOWED, AND IS THE ORDINARY CASE. Allocations may total less
-- than the payment; what is left is an unallocated balance that Finance's own
-- Allocate control spends later, under the same rules. An EMPTY list is
-- permitted too — that is the plain unallocated payment the Finance form
-- already writes, reachable here so one door serves the whole range.
--
-- WHY IT LOOPS OVER allocate_payment_to_target_internal() RATHER THAN INSERTING:
-- that function holds the capacity invariant under a lock on the parent payment,
-- refuses a target the caller cannot see, refuses an approved or rejected PI, a
-- cancelled Order and a deletion-claimed record, and refuses a second active
-- claim on the same target. Re-implementing any of that here would be the second
-- copy of a financial rule, which is how two copies come to disagree.
--
-- ORDER-REQUEST TARGETS CANNOT BE NAMED. There is no parameter for one, the
-- allocation table has no such column, and 20261007000000 refuses the linkage
-- from every caller. The retirement is not re-litigated here; it is simply
-- unreachable.
--
-- ATOMICITY IS STRUCTURAL, NOT COMPENSATING. There is no catch and no cleanup
-- path. If the fourth allocation fails, the three before it and the payment
-- itself are gone with it, and the caller is told which row failed and why. The
-- one state this function cannot produce is a payment presented as fully
-- allocated when it is not.

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

  v_client := nullif(btrim(coalesce(p_client_name, '')), '');
  if v_client is null then
    raise exception 'PAYMENT_CLIENT_REQUIRED: name the client this payment came from.'
      using errcode = 'P0001';
  end if;

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
  'Records ONE payment and divides it across any number of Confirmed Orders and PI Drafts in a single transaction — every row or none. Requires Finance module entry AND finance.allocate. Allocations may total less than the payment; the remainder is an ordinary unallocated balance. Each allocation is written through allocate_payment_to_target_internal(), so the capacity lock, the duplicate rule, target eligibility and target visibility are the canonical ones. Creates a pending_approval payment: it asserts that money was reported, never that it was verified. No Order Request can be named.';

revoke execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)
  from public, anon;
grant  execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)
  to authenticated;


-- ═══ 2. Where a reserved number lives ══════════════════════════════════════
--
-- ON THE PI DRAFT ITSELF, not in a side table. The reservation is a property of
-- one PI — it has one, or it has none — and a side table would need a uniqueness
-- rule, a liveness rule and a join on every screen to say the same thing a
-- column says by existing.
--
-- FOUR COLUMNS, and each answers a question the others cannot:
--
--   reserved_order_number            the number, in the ONE existing format
--   reserved_order_number_at         when it was taken — the audit anchor, and
--                                    the basis the §7 revised-PI test compares
--                                    against
--   reserved_order_number_by         who took it
--   reserved_number_workbook_sha256  THE WORKBOOK THAT WAS ON FILE AT THAT
--                                    MOMENT. This is what makes "the revised PI
--                                    was uploaded" a fact rather than a promise:
--                                    a PI whose workbook still hashes to this
--                                    has not been revised since the number was
--                                    shown, whatever anybody says. The same
--                                    idiom order_submission_exception_current()
--                                    already uses to decide whether a decision
--                                    still describes the record it was made
--                                    about.
--
--   reserved_order_number_used_at    when the Confirmed Order took it. Set once,
--                                    by approve_order_submission(), never
--                                    cleared.
--
-- NULLABLE, with no default and no backfill: every existing PI Draft has no
-- reservation, which is the truth about it, and every existing Order is
-- untouched.

alter table public.order_submissions
  add column if not exists reserved_order_number           text,
  add column if not exists reserved_order_number_at        timestamptz,
  add column if not exists reserved_order_number_by        uuid references public.users(id),
  add column if not exists reserved_number_workbook_sha256 text,
  add column if not exists reserved_order_number_used_at   timestamptz;

comment on column public.order_submissions.reserved_order_number is
  'The Confirmed Order number this PI Draft has reserved from the one numbering cycle, four digits, 0001-9999. NULL until reserve_order_number_for_submission() takes one. Never reused, never reassigned, never cleared: an abandoned reservation is a gap in the series, which is the safe outcome.';

comment on column public.order_submissions.reserved_number_workbook_sha256 is
  'The source_workbook_sha256 that was on file when the number was reserved. approve_order_submission() refuses a reserved PI whose workbook still hashes to this, because that is a PI whose revised copy — the one carrying the number — was never uploaded.';

comment on column public.order_submissions.reserved_order_number_used_at is
  'When the Confirmed Order created from this PI took the reserved number. Set once by approve_order_submission(); a non-null value with no Order would be a contradiction the §9 assertion refuses.';

-- ── 2a. The format, and the all-or-nothing rule ──
--
-- The SAME regex orders.display_number carries (20260704000000 §4), stated again
-- rather than referenced, because a reservation that could hold '17' or 'ORD-1'
-- would produce an Order the orders constraint then refuses — at approval, after
-- the customer has the document.
--
-- And a reservation is never half-written: a number with no time, a time with no
-- actor, or an actor with no number is not something anybody can audit. The
-- workbook hash is deliberately OUTSIDE this rule — a PI may legitimately have
-- had no workbook hash on file, and NULL there means "there was nothing to
-- compare", which §7 handles explicitly rather than by pretending.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_submissions'::regclass
      and conname  = 'order_submissions_reserved_number_format'
  ) then
    alter table public.order_submissions
      add constraint order_submissions_reserved_number_format
      check (
        reserved_order_number is null
        or (reserved_order_number ~ '^[0-9]{4}$' and reserved_order_number <> '0000')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_submissions'::regclass
      and conname  = 'order_submissions_reservation_complete'
  ) then
    alter table public.order_submissions
      add constraint order_submissions_reservation_complete
      check (
        num_nonnulls(reserved_order_number, reserved_order_number_at, reserved_order_number_by) in (0, 3)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_submissions'::regclass
      and conname  = 'order_submissions_reservation_used_needs_number'
  ) then
    alter table public.order_submissions
      add constraint order_submissions_reservation_used_needs_number
      check (reserved_order_number_used_at is null or reserved_order_number is not null);
  end if;
end $$;

-- ── 2b. TWO PI DRAFTS CAN NEVER HOLD THE SAME NUMBER ──
--
-- The rule the whole feature rests on, and it is an INDEX rather than a check in
-- a function, because a function's check is only as good as the lock around it
-- and an index needs no lock at all. Partial, so the unbounded majority of PI
-- Drafts — which hold no reservation — cost nothing.
--
-- It says nothing about public.orders; cross-table uniqueness cannot be an index.
-- §4, §5 and §6 are what keep the two sides apart, and §9 asserts the result.

create unique index if not exists order_submissions_reserved_order_number_uidx
  on public.order_submissions (reserved_order_number)
  where reserved_order_number is not null;

-- ── 2c. ONCE SHOWN, IT DOES NOT SILENTLY CHANGE ──
--
-- A number that has been printed on a customer's document is not an editable
-- field, for anybody, through any path — not an admin correction, not a
-- re-import, not a status change. There is no client-role UPDATE grant on this
-- table at all (20260908000000 §5), so this guard is aimed at the SECURITY
-- DEFINER functions that do write here: it makes a careless `update ... set` in
-- some future function a loud refusal instead of a rewritten commercial number.
--
-- Setting it from NULL is allowed exactly once, which is what lets §3 write it.
-- A no-op write of the same value passes, so every unrelated UPDATE on this
-- table — status, totals, client details — is unaffected.
--
-- Same idiom, and deliberately the same shape, as
-- prevent_order_source_submission_change() (20260915000000 §2) and
-- prevent_order_display_number_change (20260703000000 §8).

create or replace function public.prevent_reserved_order_number_change()
returns trigger
language plpgsql
as $$
begin
  if old.reserved_order_number is not null
     and new.reserved_order_number is distinct from old.reserved_order_number then
    raise exception
      'RESERVED_ORDER_NUMBER_IMMUTABLE: Order number % is reserved for this PI and cannot be changed or released',
      old.reserved_order_number
      using errcode = '42501';
  end if;

  -- The consumption stamp is equally one-way. Re-stamping it would let a second
  -- Order claim the same reservation looked unused.
  if old.reserved_order_number_used_at is not null
     and new.reserved_order_number_used_at is distinct from old.reserved_order_number_used_at then
    raise exception
      'RESERVED_ORDER_NUMBER_ALREADY_USED: the reserved number of this PI has already been taken by an Order'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.prevent_reserved_order_number_change()
  from public, anon, authenticated;

drop trigger if exists order_submissions_protect_reserved_number on public.order_submissions;
create trigger order_submissions_protect_reserved_number
  before update on public.order_submissions
  for each row execute function public.prevent_reserved_order_number_change();

-- ── 2d. The two actions a PI's history may now record ──
--
-- The action set is CLOSED (20261001000000) and a migration that logs a new
-- action must declare it in the same migration. These are §3's and §7's.
--
-- RE-EMITTED IN FULL rather than patched: the constraint has one home and a
-- reader should see the whole admitted set in one place.

alter table public.order_submission_activity
  drop constraint if exists order_submission_activity_action_check;

alter table public.order_submission_activity
  add constraint order_submission_activity_action_check
  check (action in (
    -- ── The twelve 20260921000000 left in force ──
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
    'payment_recorded',
    'payment_allocations_moved',

    -- ── Written by 20260923000000, which never declared it. APPLIED. ──
    'billing_percentage_set',

    -- ── 20260927000000: the same value, amended by an admin after submission ──
    'billing_percentage_amended_by_admin',

    -- ── 20260928000000: client and party details ──
    'client_details_updated',
    'client_details_amended_by_admin',

    -- ── 20260929000000: schedule and terms ──
    'schedule_terms_updated',
    'schedule_terms_amended_by_admin',

    -- ── 20260930000000: the owner's correction request and its answer ──
    'correction_requested',
    'correction_resolved',
    'correction_rejected',

    -- ── 20261002000000: product descriptive fields and ordering ──
    'product_details_updated',
    'product_details_amended_by_admin',

    -- ── 20261003000000: Change PI — the workbook replaced by an admin after
    -- the PI has left draft ──
    'workbook_replaced_by_admin',

    -- ── 20261009000000: the Order number, taken early and then taken up ──
    -- Two events, not one, because they are two facts a reader needs
    -- separately: WHEN the number was committed to (and therefore when it could
    -- first appear on a document), and WHEN the Order finally took it up.
    'order_number_reserved',
    'order_number_used'
  ));

comment on constraint order_submission_activity_action_check on public.order_submission_activity is
  'The CLOSED set of actions a PI''s history may record. A migration that logs a new action must extend this in the same migration — a rule 20260923000000 broke, which is why billing_percentage_set appears here rather than there.';


-- ═══ 3. Taking the number ══════════════════════════════════════════════════
--
-- WHEN. While the PI is a DRAFT or has been RETURNED FOR CHANGES, and only then.
-- That is not an arbitrary stage: it is the ONLY stage at which the PI's own
-- owner may replace the workbook (assert_order_submission_workbook_editor,
-- 20261003000000 — past submission the answer is "active admin only"). Reserving
-- a number on a submitted PI would hand somebody a number and then refuse them
-- the upload it exists for.
--
-- WHO. Exactly the population that may replace that workbook at that stage:
-- the PI's owner, or an active admin, and in both cases somebody holding
-- orders.create. The question is asked by calling the existing authority rather
-- than by restating its rule, so the two can never drift; and the answer is
-- required to be `after_submission = false`, which is what closes the admin's
-- past-submission branch off from this door.
--
-- Note what is NOT a route. Finance authority is not: reserving a commercial
-- number is not a money decision. orders.approve_order is not: the approver's
-- act is approval, and approval already numbers the Order.
--
-- IDEMPOTENT, AND THAT IS A REQUIREMENT RATHER THAN A COURTESY. The person doing
-- this is looking at a number they are about to type into a document. A second
-- click, a refresh, a retried request over a connection that dropped after the
-- COMMIT — every one of them must answer with the number they already have. So
-- an existing reservation is RETURNED, flagged `already_reserved`, and nothing
-- is written. It is not an error, and it never takes a second number.
--
-- WHERE THE NUMBER COMES FROM. allocate_confirmed_order_number() — the same
-- allocator an Order INSERT reaches, taking the same FOR UPDATE on the same
-- singleton cycle row and advancing it in the same statement. A reservation is
-- therefore indistinguishable from an Order creation as far as the series is
-- concerned, which is precisely why two of them cannot collide: the second
-- caller blocks until the first COMMITs or ROLLs BACK, then re-reads.
--
-- AND IF THIS TRANSACTION ROLLS BACK, so does the advance. The cycle is an
-- ordinary table row bound to the caller's transaction, so a failed reservation
-- burns nothing.

create or replace function public.reserve_order_number_for_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_sub    public.order_submissions%rowtype;
  v_auth   jsonb;
  v_number text;
  v_now    timestamptz;
begin
  -- ── 1. The lock, before any mutable state is judged ──
  --
  -- Taken FIRST and held, so the status this function decides against is the
  -- status that will still be true at COMMIT, and so two concurrent calls on the
  -- SAME PI serialize here rather than both reaching the allocator.
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- ── 2. Already reserved: answer, do not act ──
  --
  -- BEFORE authorization is re-asked and before anything is written, because the
  -- honest answer to "what number does this PI have" does not depend on whether
  -- the asker could have been the one to take it. It is the number on the screen
  -- either way, and can_view_order_submission already governs whether this PI is
  -- readable at all.
  if v_sub.reserved_order_number is not null then
    return jsonb_build_object(
      'submission_id',         p_submission_id,
      'reserved_order_number', v_sub.reserved_order_number,
      'reserved_at',           v_sub.reserved_order_number_at,
      'already_reserved',      true,
      'used_at',               v_sub.reserved_order_number_used_at
    );
  end if;

  -- ── 3. Authorization, through the authority that already owns this stage ──
  --
  -- p_require_reason is false: a reason belongs to an admin amendment after
  -- submission, and this door refuses that case outright on the next line.
  v_auth := public.assert_order_submission_workbook_editor(p_submission_id, v_actor, null, false);

  if coalesce((v_auth->>'after_submission')::boolean, true) then
    raise exception
      'ORDER_NUMBER_RESERVATION_STAGE: an Order number can only be reserved while the PI is a draft or has been returned for changes (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  -- ── 4. The PI must still be able to become an Order ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot reserve an Order number'
      using errcode = '55P03';
  end if;

  -- Structurally unreachable behind step 3 — an approved or rejected PI is past
  -- draft — and stated anyway, because it is the rule the feature promises
  -- ("an already-converted draft cannot reserve") and a reader should find it
  -- written down rather than inferred from another function's stage test.
  if v_sub.order_id is not null or v_sub.status = 'approved' then
    raise exception
      'ORDER_SUBMISSION_CONVERTED: this PI has already become an Order and carries its number'
      using errcode = 'P0001';
  end if;

  if v_sub.status = 'rejected' then
    raise exception
      'ORDER_SUBMISSION_REJECTED: a rejected PI cannot reserve an Order number'
      using errcode = 'P0001';
  end if;

  -- ── 5. THERE MUST BE A WORKBOOK TO REVISE ──
  --
  -- The point of the number is to be added to the PI document and uploaded
  -- again. A PI with no workbook on file has nothing to add it to, and reserving
  -- against it would produce a record §7 could never let through: with no hash
  -- to compare, "the revised PI was uploaded" has no meaning.
  if coalesce(btrim(v_sub.source_workbook_path), '') = ''
     or v_sub.source_workbook_sha256 is null then
    raise exception
      'ORDER_NUMBER_RESERVATION_NO_WORKBOOK: upload the PI file first — the reserved number has to go into it'
      using errcode = 'P0001';
  end if;

  -- ── 6. The number, from the one cycle ──
  --
  -- Not client-callable and reached here only because this function is SECURITY
  -- DEFINER — the same arrangement assign_order_display_number() relies on. It
  -- raises ORDER_NUMBER_CYCLE_MISSING, _INVALID, _BEHIND, _EXHAUSTED and
  -- ORDER_NUMBER_IN_USE on its own terms, and every one of them aborts this
  -- transaction with the cycle untouched.
  v_number := public.allocate_confirmed_order_number();
  v_now    := now();

  -- ── 7. Write it, with the workbook it was taken against ──
  update public.order_submissions
     set reserved_order_number           = v_number,
         reserved_order_number_at        = v_now,
         reserved_order_number_by        = v_actor,
         reserved_number_workbook_sha256 = v_sub.source_workbook_sha256
   where id = p_submission_id;

  -- ── 8. The history ──
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'order_number_reserved', v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'reserved_order_number', v_number,
      'workbook_sha256',       v_sub.source_workbook_sha256,
      'workbook_name',         v_sub.source_workbook_name
    )
  );

  return jsonb_build_object(
    'submission_id',         p_submission_id,
    'reserved_order_number', v_number,
    'reserved_at',           v_now,
    'already_reserved',      false,
    'used_at',               null
  );
end;
$$;

comment on function public.reserve_order_number_for_submission(uuid) is
  'Reserves the next Confirmed Order number for a PI Draft, taken from the one numbering cycle under its own FOR UPDATE lock, so the number can be printed on the revised PI before approval. Permitted only while the PI is draft or needs_changes, and only to the population that may replace its workbook at that stage — its owner, or an active admin, holding orders.create. Idempotent: a PI that already holds a reservation gets that number back and no second one is taken. The number is never released or reused; an abandoned reservation is a gap in the series.';

revoke execute on function public.reserve_order_number_for_submission(uuid) from public, anon;
grant  execute on function public.reserve_order_number_for_submission(uuid) to authenticated;


-- ═══ 4. The allocator learns that some numbers are already spoken for ══════
--
-- RE-EMITTED IN FULL from 20260704000000 §5, which is the house rule for this
-- function: `create or replace` cannot change a signature, every previous phase
-- has restated it whole, and a reader comparing two versions should see the
-- entire thing rather than reconstruct it from a patch.
--
-- IT DIFFERS IN EXACTLY ONE PLACE: between the cycle read and the exhaustion
-- test, a bounded loop advances past any number a PI Draft currently holds.
-- Everything else — the lock, the CYCLE_BEHIND rule, the collision probe, the
-- advance, the four error names — is byte-for-byte what was applied.
--
-- WHY THE LOOP IS NORMALLY DEAD CODE. A reservation advances the cycle as it
-- takes its number, so the cycle is always ahead of every reservation and this
-- loop never iterates. It exists for the one path that can put the cycle behind
-- a reservation: set_next_confirmed_order_number(), where an admin names a
-- value directly. §5 closes that door too — this is the second lock on it.
--
-- WHY IT SKIPS RATHER THAN REFUSING. Refusing would stop Orders being created at
-- all until an admin intervened, which is a much worse failure than a gap in the
-- series. And handing out a reserved number would be worse still: the Order
-- would be created, and the PI holding that reservation could then NEVER be
-- approved — its number permanently taken by somebody else's record, discovered
-- only at the moment of approval, after the customer has the document.
--
-- THE BOUND IS THE SERIES ITSELF. Past 9999 the loop stops and the existing
-- exhaustion error is raised, so a pathological reservation set cannot spin.

create or replace function public.allocate_confirmed_order_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next    bigint;
  v_highest bigint;
  v_number  text;
begin
  -- 1. Serialize on the cycle row. Transaction-scoped.
  select c.next_number into v_next
  from public.order_number_cycle c
  where c.id = true
  for update;

  if not found then
    raise exception 'ORDER_NUMBER_CYCLE_MISSING: Confirmed Order numbering is not configured'
      using errcode = 'P0001';
  end if;

  if v_next is null or v_next <= 0 then
    raise exception 'ORDER_NUMBER_CYCLE_INVALID: The configured next Order number is not a valid positive number'
      using errcode = 'P0001';
  end if;

  -- 1a. A NUMBER A PI DRAFT IS HOLDING IS NOT AVAILABLE. Reserved numbers are
  --     compared in their stored four-digit form, which is the form they were
  --     issued in and the form public.orders stores.
  while v_next <= 9999
        and exists (
          select 1 from public.order_submissions s
          where s.reserved_order_number = public.format_confirmed_order_number(v_next)
        )
  loop
    v_next := v_next + 1;
  end loop;

  -- 2. Exhaustion is its own failure, not a constraint violation. Reaching 9999
  --    is a business event that needs a human decision about the numbering
  --    scheme, so it must not surface as a cryptic check-constraint error.
  if v_next > 9999 then
    raise exception
      'ORDER_NUMBER_CYCLE_EXHAUSTED: Confirmed Order numbers are limited to 9999 and that limit has been reached'
      using errcode = 'P0001';
  end if;

  -- 3. Re-verify the business rule at allocation time, not only at save time.
  select coalesce(max(o.display_number::bigint), 0) into v_highest
  from public.orders o
  where o.display_number ~ '^[0-9]+$';

  if v_next <= v_highest then
    raise exception
      'ORDER_NUMBER_CYCLE_BEHIND: The configured next Order number (%) is not above the highest existing Order number (%)',
      public.format_confirmed_order_number(v_next),
      public.format_confirmed_order_number(v_highest)
      using errcode = 'P0001';
  end if;

  v_number := public.format_confirmed_order_number(v_next);

  -- 4. Explicit collision check on the padded value, so the failure is a clear
  --    message rather than a raw unique violation on orders_display_number_key.
  if exists (
    select 1 from public.orders o where o.display_number = v_number
  ) then
    raise exception 'ORDER_NUMBER_IN_USE: Order number % is already in use', v_number
      using errcode = 'P0001';
  end if;

  -- 5. Advance. Rolls back with the caller's transaction, so a failed conversion
  --    never burns a number.
  update public.order_number_cycle
     set next_number = v_next + 1
   where id = true;

  return v_number;
end;
$$;

revoke execute on function public.allocate_confirmed_order_number() from public, anon, authenticated;

comment on function public.allocate_confirmed_order_number() is
  'Internal. Allocates the next Confirmed Order number as four-digit text under a FOR UPDATE lock on the singleton cycle row and advances it, within the caller transaction. Skips any number a PI Draft currently holds as a reservation. Not client-callable — reached via the orders_assign_display_number trigger and reserve_order_number_for_submission().';


-- ═══ 5. The admin setter may not step back over a reservation ══════════════
--
-- RE-EMITTED IN FULL from 20260704000000 §6, for the same house-rule reason.
--
-- IT DIFFERS IN EXACTLY ONE PLACE: the "must be greater than the highest
-- existing Order number" rule now also considers the highest OUTSTANDING
-- RESERVATION. Authorization, the lock, the bounds and the collision probe are
-- byte-for-byte what was applied.
--
-- WHY. The existing rule reads public.orders, and a reserved number is not in
-- public.orders — it is a number that has been given to a customer's document
-- and not yet used. Without this an admin could set the cycle to 0007 while a PI
-- Draft holds 0009, and the next three Orders would walk straight into it. §4
-- would then skip 0009, so no duplicate could be created — but the admin's
-- stated intention would be silently altered, and a refusal that says WHY is a
-- far better answer than a silent correction.

create or replace function public.set_next_confirmed_order_number(p_next_number bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_highest  bigint;
  v_reserved bigint;
  v_floor    bigint;
  v_prev     bigint;
  v_number   text;
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to set the Confirmed Order number cycle'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may set the Confirmed Order number cycle'
      using errcode = '42501';
  end if;

  -- 3. Degenerate inputs the bigint parameter type cannot catch on its own.
  if p_next_number is null then
    raise exception 'ORDER_NUMBER_INVALID: A next Order number is required'
      using errcode = 'P0001';
  end if;

  if p_next_number <= 0 then
    raise exception 'ORDER_NUMBER_INVALID: The next Order number must be a positive whole number'
      using errcode = 'P0001';
  end if;

  if p_next_number > 9999 then
    raise exception
      'ORDER_NUMBER_TOO_HIGH: Confirmed Order numbers are four digits, so the next Order number cannot be above 9999'
      using errcode = 'P0001';
  end if;

  -- 4. Lock the cycle row before reading it, so an admin save and a concurrent
  --    conversion cannot interleave into a lost update.
  select c.next_number into v_prev
  from public.order_number_cycle c
  where c.id = true
  for update;

  if not found then
    raise exception 'ORDER_NUMBER_CYCLE_MISSING: Confirmed Order numbering is not configured'
      using errcode = 'P0001';
  end if;

  -- 5. The business rule, computed from real Order data under the held lock —
  --    and now from live reservations too. Both are numbers that have been
  --    ISSUED; only one of them is in public.orders yet.
  select coalesce(max(o.display_number::bigint), 0) into v_highest
  from public.orders o
  where o.display_number ~ '^[0-9]+$';

  select coalesce(max(s.reserved_order_number::bigint), 0) into v_reserved
  from public.order_submissions s
  where s.reserved_order_number ~ '^[0-9]+$';

  v_floor := greatest(v_highest, v_reserved);

  if p_next_number <= v_floor then
    if v_reserved > v_highest then
      raise exception
        'ORDER_NUMBER_TOO_LOW: The next Order number must be greater than the highest Order number already issued (%), which is reserved by a PI Draft that has not been approved yet',
        public.format_confirmed_order_number(v_reserved)
        using errcode = 'P0001';
    end if;

    raise exception
      'ORDER_NUMBER_TOO_LOW: The next Order number must be greater than the highest existing Order number (%)',
      public.format_confirmed_order_number(v_highest)
      using errcode = 'P0001';
  end if;

  v_number := public.format_confirmed_order_number(p_next_number);

  -- 6. Defence in depth. Unreachable while the check above dominates, but it
  --    keeps the guarantee true if a future path ever creates an Order outside
  --    the numeric range that max()::bigint would skip.
  if exists (
    select 1 from public.orders o where o.display_number = v_number
  ) then
    raise exception 'ORDER_NUMBER_IN_USE: Order number % is already in use', v_number
      using errcode = 'P0001';
  end if;

  update public.order_number_cycle
     set next_number   = p_next_number,
         configured_at = now(),
         configured_by = v_actor
   where id = true;

  return jsonb_build_object(
    'next_number',              p_next_number,
    'next_number_display',      v_number,
    'previous_next_number',     v_prev,
    'highest_existing_number',  v_highest,
    'highest_existing_display', public.format_confirmed_order_number(v_highest),
    'highest_reserved_number',  v_reserved,
    'highest_reserved_display', public.format_confirmed_order_number(v_reserved)
  );
end;
$$;

revoke execute on function public.set_next_confirmed_order_number(bigint) from public, anon;
grant  execute on function public.set_next_confirmed_order_number(bigint) to authenticated;

comment on function public.set_next_confirmed_order_number(bigint) is
  'Admin-only. Sets the next Confirmed Order number (1-9999). Requires the value to exceed both the highest existing numeric Order number and the highest number a PI Draft currently holds as a reservation. Never modifies an existing Order and never releases a reservation.';


-- ═══ 6. The Order takes the number its PI was promised ═════════════════════
--
-- RE-EMITTED IN FULL from 20260703000000 §7.
--
-- THE SECURITY PROPERTY THAT MUST NOT MOVE, and does not: a caller can never
-- seed their own number. The original is unconditional — "whatever display_number
-- a caller supplies is discarded and replaced" — precisely because RLS permits a
-- direct PostgREST insert into public.orders, and a "fill it in only when NULL"
-- variant would let a sales user POST an Order carrying a hand-picked number.
--
-- NEW.display_number IS STILL IGNORED HERE. What this version adds is a second
-- SOURCE for the replacement value, and that source is not the caller either: it
-- is a reservation on the PI this Order is being created from, which was itself
-- issued by the cycle. The caller chooses a PI, not a number, and can only
-- choose a PI they were already able to have approved.
--
-- THREE CONDITIONS, ALL REQUIRED, before a reservation is honoured:
--
--   * the row names a source PI (source_order_submission_id), which only
--     approve_order_submission() sets and which is immutable thereafter
--     (20260915000000 §2);
--   * in_pi_submission_approval() is open FOR THAT PI — the transaction-local
--     marker approve_order_submission() sets at its step 12. A bare INSERT that
--     names a PI cannot reach the reservation, because it cannot set the marker;
--   * the reservation is unused. reserved_order_number_used_at is stamped by the
--     approval itself and is one-way (§2c), and
--     orders_source_order_submission_id_uidx already makes a second Order from
--     the same PI impossible — so this is the third independent guarantee that
--     one reservation produces one Order.
--
-- WITH NO RESERVATION, NOTHING CHANGES. The allocator runs exactly as it always
-- has, which is what keeps every PI already in flight approvable.

create or replace function public.assign_order_display_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved text;
begin
  if new.source_order_submission_id is not null
     and public.in_pi_submission_approval(new.source_order_submission_id)
  then
    select s.reserved_order_number into v_reserved
    from public.order_submissions s
    where s.id = new.source_order_submission_id
      and s.reserved_order_number is not null
      and s.reserved_order_number_used_at is null;

    if v_reserved is not null then
      -- The unique index on display_number would refuse a collision anyway; this
      -- says which number and why, and refuses BEFORE the Order exists rather
      -- than as an opaque constraint violation. §4 and §5 are what make it
      -- unreachable.
      if exists (select 1 from public.orders o where o.display_number = v_reserved) then
        raise exception
          'ORDER_NUMBER_RESERVATION_IN_USE: Order number % was reserved for this PI but is already in use',
          v_reserved
          using errcode = 'P0001';
      end if;

      new.display_number := v_reserved;
      return new;
    end if;
  end if;

  new.display_number := public.allocate_confirmed_order_number();
  return new;
end;
$$;

revoke execute on function public.assign_order_display_number() from public, anon, authenticated;

comment on function public.assign_order_display_number() is
  'BEFORE INSERT on public.orders. Replaces any caller-supplied display_number with a number the caller cannot choose: the unused reservation held by the PI this Order is being approved from, when the approval marker for that PI is open, and otherwise the next number from the cycle.';


-- ═══ 7. Approval honours the reservation, and requires the revised PI ══════
--
-- RE-EMITTED IN FULL from 20260923000000 §4, which is the house rule for this
-- function: every phase that has touched it has restated it whole, and a reader
-- comparing two versions should see the entire thing.
--
-- IT DIFFERS FROM 20260923000000's VERSION IN FIVE PLACES, all of them inside
-- `if v_sub.reserved_order_number is not null`, and every one of them dead code
-- for a PI that holds no reservation:
--
--   1. one new declaration, v_reserved
--   2. step 10a — the revised-PI test, the already-in-use test and the
--      already-used test
--   3. step 14's UPDATE also stamps reserved_order_number_used_at
--   4. an 'order_number_used' entry in the PI's history
--   5. the reservation echoed in both return shapes
--
-- WHAT IS NOT CHANGED, and is worth saying because this function is where the
-- money rules live: the permission gate, the lock, the finance-verification
-- test, the payment gate and its two routes, the exception-currency rule, the
-- blocking-diagnostics test, the workbook tests, the item and image tests, the
-- Order INSERT's column list, the allocation MOVE and its stranded-money
-- refusal, and the approval marker. All byte-for-byte what was applied.
--
-- THE NUMBER ITSELF IS NOT WRITTEN HERE. The INSERT still supplies no
-- display_number and still receives one from orders_assign_display_number — §6
-- is where the reservation reaches the row. Setting it here would be the second
-- place a number can be assigned, and the trigger exists precisely so there is
-- only one.
create or replace function public.approve_order_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := public.assert_order_submission_actor();
  v_sub          public.order_submissions%rowtype;
  v_order_id     uuid;
  v_number       text;
  v_now          timestamptz;
  v_item_count   integer;
  v_bad          integer;
  v_bad_row      integer;
  v_client       text;
  v_verified     numeric;
  v_unverified   numeric;
  v_required     numeric;
  v_shortfall    numeric;
  v_route        text;
  v_exception_current boolean;
  v_moved_count  integer := 0;
  v_moved_amount numeric := 0;
  v_stranded     integer;
  v_reserved     text;
begin
  -- ── 1. Authorization, server-side, before anything is read ──
  if not public.actor_has_module_permission('orders', 'approve_order') then
    raise exception 'You do not have permission to approve order submissions'
      using errcode = '42501';
  end if;

  -- ── 2. The lock, before any mutable state is judged ──
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- ── 3. Already approved: answer with what exists ──
  if v_sub.status = 'approved' and v_sub.order_id is not null then
    select o.display_number into v_number
    from public.orders o where o.id = v_sub.order_id;

    return jsonb_build_object(
      'submission_id',         p_submission_id,
      'order_id',              v_sub.order_id,
      'display_number',        v_number,
      'already_approved',      true,
      'reserved_order_number', v_sub.reserved_order_number,
      'used_reservation',      v_sub.reserved_order_number_used_at is not null
    );
  end if;

  -- ── 4. A deletion reservation freezes the record for everybody ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be approved'
      using errcode = '55P03';
  end if;

  -- ── 5. Only a submitted PI can be approved ──
  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can be approved (this one is %)', v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_ALREADY_LINKED: this PI is already linked to an Order'
      using errcode = 'P0001';
  end if;

  -- ── 6. Finance verification must be CURRENT ──
  --
  -- SEPARATE FROM, AND NOT A SUBSTITUTE FOR, VERIFIED PAYMENT. This is the
  -- Finance check on the PI's FIGURES (20260915000000 §11): somebody with
  -- finance authority has read the commercial summary and signed off on it. It
  -- says nothing about money arriving, it is not set by verifying a payment, and
  -- verifying a payment does not set it. Both are required; neither stands in
  -- for the other. And because it goes stale the moment the record moves, a PI
  -- corrected after the check must be checked again.
  if not public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED: this PI has not been verified by finance for the submission under review'
      using errcode = 'P0001';
  end if;

  -- ── 6a. The total the requirement is a percentage of ──
  --
  -- Moved up from step 9 verbatim — same code, same message — because step 7 now
  -- needs it. Nothing else about the check changed.
  if v_sub.grand_total is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored grand total'
      using errcode = 'P0001';
  end if;

  -- ── 7. The PAYMENT gate, live, under locks ──
  --
  -- Parent payments first, then allocations, both in id order. See the header.
  perform 1
  from public.finance_payment_requests f
  where f.id in (
    select a.payment_request_id
    from public.finance_payment_allocations a
    where a.order_submission_id = p_submission_id
  )
  order by f.id
  for update;

  perform 1
  from public.finance_payment_allocations a
  where a.order_submission_id = p_submission_id
  order by a.id
  for update;

  v_verified   := public.order_submission_verified_payment(p_submission_id);
  v_unverified := public.order_submission_unverified_payment(p_submission_id);
  v_required   := public.order_submission_required_payment(v_sub.grand_total);
  v_shortfall  := public.order_submission_payment_shortfall(v_sub.grand_total, v_verified);

  -- WHICH ROUTE, decided in the order the business decides it: money first, then
  -- the decision that stands in for money. A PI that meets the requirement needs
  -- no exception even if it once asked for one.
  --
  -- AN APPROVED EXCEPTION MUST STILL BE AN APPROVAL OF *THIS* PI. The decision
  -- was taken against a grand total, a workbook and a set of collection terms;
  -- if any of them has moved since, the approver agreed to something else.
  -- order_submission_exception_current() is the whole rule, and a decision with
  -- no recorded basis — every pre-Phase-3 one — is never current, because it was
  -- a decision about a declared advance rather than about verified payment.
  v_exception_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  if v_verified >= v_required then
    v_route := 'standard';
  elsif v_exception_current then
    v_route := 'exception';
  else
    v_route := null;
  end if;

  if v_route is null then
    -- ONE REASON, THE MOST ACTIONABLE ONE, in business language and never a
    -- database error. A pending or refused decision is somebody's next step and
    -- is said first; otherwise the figure is what is missing.
    if v_sub.advance_exception_status = 'pending' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_PENDING: The reduced-payment exception is still pending.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'rejected' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REJECTED: The reduced-payment exception was rejected. Update the PI before resubmitting.'
        using errcode = 'P0001';
    end if;

    -- APPROVED, BUT NOT OF THIS PI. Said in its own words, because "not enough
    -- payment" would send the salesperson to collect money when what is actually
    -- needed is for the approver to look again.
    if v_sub.advance_exception_status = 'approved' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_STALE: The reduced-payment approval was given for different commercial terms and must be approved again.'
        using errcode = 'P0001';
    end if;

    -- UNVERIFIED MONEY IS NAMED, NEVER COUNTED. Somebody reading "₹4,00,000 more
    -- is required" while looking at a ₹4,00,000 payment they entered this
    -- morning would conclude the system had lost it. It has not; Finance has
    -- not decided it yet, and an approved exception would not change that either.
    if v_unverified > 0 then
      raise exception
        'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION: Payment is awaiting Finance verification. % more verified payment is required for standard approval, or Admin approval is required to proceed below 40%%.',
        '₹' || to_char(v_shortfall, 'FM999999999990.00')
        using errcode = 'P0001';
    end if;

    raise exception
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT: % more verified payment is required for standard approval. Admin approval is required to proceed below 40%%.',
      '₹' || to_char(v_shortfall, 'FM999999999990.00')
      using errcode = 'P0001';
  end if;

  -- ── 8. No blocking diagnostics ──
  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) in this PI must be fixed before it can be approved',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  -- ── 9. The fields an Order cannot be built without ──
  v_client := nullif(btrim(coalesce(v_sub.client_name, '')), '');
  if v_client is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  -- ── 10. The workbook: shape, then existence, then type ──
  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

  if v_sub.source_workbook_path !~
     ('^submissions/' || p_submission_id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the workbook is not stored under submissions/%/original/', p_submission_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: the PI workbook is missing from storage, or is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  -- ── 10a. A RESERVED NUMBER MUST HAVE BEEN PUT INTO A REVISED PI ──
  --
  -- 20261009000000. This is the only clause in this function that is new, and it
  -- fires ONLY for a PI that holds a reservation. A PI without one is approved
  -- exactly as it always has been, numbered from the cycle at insert — which is
  -- what keeps every record already in flight approvable and changes no rule for
  -- anybody who has not opted into the new flow.
  --
  -- WHAT IT ACTUALLY CHECKS, and why that is the honest test. The point of
  -- reserving early is that the number goes onto the commercial document and the
  -- revised document comes back. `reserved_number_workbook_sha256` is the hash of
  -- the workbook that was on file at the moment the number was handed over
  -- (20261009000000 §2). If the live hash still equals it, the file nobody has
  -- replaced is the file that does not carry the number — no assertion by any
  -- person is needed or accepted, and no separate "revised" flag can be ticked
  -- without the upload it stands for. The same idiom
  -- order_submission_exception_current() uses to decide whether a decision still
  -- describes the record it was made about.
  --
  -- A NULL live hash is refused for the same reason a matching one is: it is not
  -- evidence that a revised workbook exists. The reservation function guarantees
  -- a non-null hash at reservation time, so this is reachable only if the
  -- workbook was later replaced by something that recorded none.
  if v_sub.reserved_order_number is not null then
    if v_sub.source_workbook_sha256 is null
       or v_sub.source_workbook_sha256 is not distinct from v_sub.reserved_number_workbook_sha256 then
      raise exception
        'ORDER_SUBMISSION_REVISED_PI_MISSING: Order number % was reserved for this PI, but the revised PI carrying that number has not been uploaded. Upload it before approving.',
        v_sub.reserved_order_number
        using errcode = 'P0001';
    end if;

    -- Belt and braces on the one thing this whole mechanism exists to prevent.
    -- The BEFORE INSERT trigger raises the same refusal, and the unique index on
    -- display_number would refuse the row in any case; this one reports it before
    -- the Order is attempted, naming the PI's own number.
    if exists (select 1 from public.orders o where o.display_number = v_sub.reserved_order_number) then
      raise exception
        'ORDER_NUMBER_RESERVATION_IN_USE: Order number % was reserved for this PI but is already in use',
        v_sub.reserved_order_number
        using errcode = 'P0001';
    end if;

    if v_sub.reserved_order_number_used_at is not null then
      raise exception
        'ORDER_SUBMISSION_CONVERTED: the number reserved for this PI has already been taken by an Order'
        using errcode = 'P0001';
    end if;

    v_reserved := v_sub.reserved_order_number;
  end if;

  -- ── 11. The product lines still satisfy the submission invariants ──
  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and (
      select count(*) from public.order_submission_item_images m
      where m.item_id = i.id and m.role = 'representative'
    ) <> 1;

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) do not have exactly one representative image (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and m.storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || m.item_id::text
         || '/' || m.role || '/' || m.position::text || '-' || m.sha256
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % image path(s) do not name this submission and their own product line',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(m.anchor_row) into v_bad, v_bad_row
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = m.storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % image(s) are missing from storage or are not a PNG, JPEG or WEBP (first anchored at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── 12. Everything holds. Open the approval context. ──
  v_now := now();
  perform set_config('boe.pi_submission_approval_id', p_submission_id::text, true);

  -- ── 13. Exactly one Order ──
  --   due_date             the submission's own due_date, CARRIED ACROSS
  --                        UNCHANGED. It was already validated once — by the
  --                        parser on save or by 20260922000000's backfill, both
  --                        applying src/lib/orders/dueDate.ts — so it is copied,
  --                        never re-derived. NULL stays NULL: a submission with
  --                        no due date makes an Order with no due date, and
  --                        dispatch_commitment is still never read here.
  insert into public.orders (
    client_name, requested_by, confirm_date, due_date, total_value, total_product_value,
    billing_percentage,
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    coalesce(v_sub.order_confirmation_date, v_now::date),
    v_sub.due_date,
    v_sub.grand_total,
    v_sub.gross_product_amount,
    -- The declaration the PI carried, verbatim. Never recomputed, never
    -- defaulted: an undeclared PI produces an undeclared Order.
    v_sub.billing_percentage,
    v_actor,
    'running',
    p_submission_id
  )
  returning id, display_number into v_order_id, v_number;

  -- ── 14. The submission becomes approved, and names its Order ──
  --
  -- AND THE RESERVATION IS SPENT IN THE SAME STATEMENT. One-way (20261009000000
  -- §2c): a second Order can never find this reservation unused. The CASE leaves
  -- it NULL for a PI that held none, so an unreserved approval writes nothing
  -- new here.
  update public.order_submissions
     set status      = 'approved',
         approved_by = v_actor,
         approved_at = v_now,
         order_id    = v_order_id,
         reserved_order_number_used_at =
           case when reserved_order_number is not null then v_now end
   where id = p_submission_id;

  -- ── 14a. The money follows the record. It is MOVED, never copied. ──
  --
  -- ONE UPDATE. No INSERT, no DELETE, no second allocation, no payment row and
  -- no touch of finance_payment_requests: the SAME rows, keeping their ids, their
  -- payment_request_id, their amounts, their created_by, their created_at and
  -- their origin_target_type, simply stop naming the PI and start naming the
  -- Order. Everything a person could audit about where the money came from
  -- survives, because nothing about it is rewritten.
  --
  -- ACTIVE ROWS ONLY. A reversed allocation is history that belongs to the PI it
  -- was reversed against, and moving it would rewrite that history — the §5 guard
  -- refuses it in any case.
  --
  -- WHY IT IS SAFE HERE AND NOWHERE ELSE. The Order exists (step 13), so
  -- orders.source_order_submission_id is written and the §5 guard can tie the
  -- destination to this PI; the approval marker is open (step 12); and the whole
  -- thing is inside the transaction that creates the Order, so a failure at any
  -- later point leaves neither an Order, nor a number, nor a moved allocation.
  --
  -- THE CAPACITY TRIGGER STILL RUNS on every one of these rows and still passes:
  -- the amount is unchanged, so the payment's active allocated total is unchanged.
  with moved as (
    update public.finance_payment_allocations
       set order_submission_id = null,
           order_id            = v_order_id
     where order_submission_id = p_submission_id
       and status = 'active'
    returning allocated_amount
  )
  select count(*), coalesce(sum(allocated_amount), 0)
    into v_moved_count, v_moved_amount
  from moved;

  -- NOTHING MAY BE LEFT BEHIND. §4c's lock order is what guarantees it: every
  -- writer that can create an allocation against this PI takes the submission
  -- lock we have held since step 2, so none can have landed since. This is the
  -- proof rather than the mechanism — if the guarantee ever stopped holding, an
  -- Order would be created with money stranded on a PI that no longer counts it,
  -- and that must be a loud refusal rather than a silent loss.
  select count(*) into v_stranded
  from public.finance_payment_allocations
  where order_submission_id = p_submission_id and status = 'active';

  if v_stranded > 0 then
    raise exception
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED: % allocation(s) still name this PI after conversion; no Order may be created over stranded money',
      v_stranded
      using errcode = 'P0001';
  end if;

  -- ── 15. Both trails ──
  --
  -- The approval event now records WHY it was allowed. Not a separate event: the
  -- route is not a thing that happened, it is the reason the thing that happened
  -- was permitted, and a reader of one row should not have to correlate two.
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'approved', 'submitted', 'approved', null,
    jsonb_build_object(
      'order_id',             v_order_id,
      'order_display_number', v_number,
      'item_count',           v_item_count,
      'payment_route',        v_route,
      'verified_payment',     v_verified,
      'required_payment',     v_required,
      'grand_total',          v_sub.grand_total
    )
  );

  -- THE NUMBER BEING TAKEN UP, as its own event. Separate from 'approved'
  -- because it answers a different question: not "was this approved" but "did
  -- the Order come out carrying the number the customer was already given". A
  -- reader auditing a commercial document goes to this row.
  if v_reserved is not null then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'order_number_used', 'approved', 'approved', null,
      jsonb_build_object(
        'order_id',              v_order_id,
        'reserved_order_number', v_reserved,
        'order_display_number',  v_number,
        'reserved_at',           v_sub.reserved_order_number_at,
        'reserved_by',           v_sub.reserved_order_number_by
      )
    );
  end if;

  -- The move, on the PI, as its own event — because it is its own fact, and the
  -- PI's reader needs to know the money is no longer counted here.
  if v_moved_count > 0 then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'payment_allocations_moved', 'approved', 'approved', null,
      jsonb_build_object(
        'order_id',           v_order_id,
        'allocation_count',   v_moved_count,
        'allocated_total',    v_moved_amount
      )
    );
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_pi_submission',
    jsonb_build_object(
      'order_submission_id',       p_submission_id,
      'item_count',                v_item_count,
      'payment_route',             v_route,
      'moved_allocation_count',    v_moved_count,
      'moved_allocated_total',     v_moved_amount
    )
  );

  -- ── 16. Close the context before returning ──
  perform set_config('boe.pi_submission_approval_id', '', true);

  -- ── 17. Identifiers only. Nothing the caller could not already read. ──
  return jsonb_build_object(
    'submission_id',    p_submission_id,
    'order_id',         v_order_id,
    'display_number',   v_number,
    'already_approved', false,
    'payment_route',    v_route,
    'moved_allocations', v_moved_count,
    -- The number the PI was promised, echoed back so the caller can see that the
    -- Order took it rather than having to compare two reads.
    'reserved_order_number', v_reserved,
    'used_reservation',      v_reserved is not null
  );
end;
$$;

-- The grants are on the function NAME and SIGNATURE, which have not changed, so
-- CREATE OR REPLACE keeps them. Restated so an environment that somehow lost
-- them is repaired by re-running this migration.
revoke all on function public.approve_order_submission(uuid) from public;
grant execute on function public.approve_order_submission(uuid) to authenticated;

comment on function public.approve_order_submission(uuid) is
  'Approves a submitted PI and creates exactly one Confirmed Order from it, moving its active payment allocations onto the Order. Where the PI holds a reserved Order number, the Order is created with that exact number and approval is refused unless the workbook has been replaced since the number was issued — the revised PI carrying it. Where it holds none, the Order is numbered from the cycle exactly as before.';


-- ═══ 8. The cycle reset gains the gate a reservation needs ═════════════════
--
-- RE-EMITTED IN FULL from 20260926000000 §2.
--
-- IT DIFFERS IN EXACTLY ONE PLACE: a new gate 3a, between the approval-in-flight
-- gate and the allocation gate, plus its figure on the evidence record. The
-- admin gate, the claim gate, the empty-register gate, the lock, the idempotent
-- already-at-1 answer and the permanent audit row are byte-for-byte what was
-- applied.
create or replace function public.reset_confirmed_order_number_cycle(p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_email      text;
  v_claim      public.test_data_cleanup_claims%rowtype;
  v_prev       bigint;
  v_orders     bigint;
  v_pending    bigint;
  v_allocs     bigint;
  v_reserved   bigint;
  v_reset_id   uuid;
  v_evidence   jsonb;
begin
  -- ── Gate 0: an active admin ──
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.users u
    where u.id = v_actor
      and u.role = 'admin'
      and u.is_active
      and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'ORDER_NUMBER_RESET_FORBIDDEN: Only an active admin may reset the Confirmed Order number cycle'
      using errcode = '42501';
  end if;

  -- Recorded on the audit row. Read separately from the gate above, because an
  -- admin whose email is null is still an admin.
  select u.email into v_email from public.users u where u.id = v_actor;

  -- ── THE LOCK, BEFORE ANY GATE IS READ ──
  --
  -- The same row allocate_confirmed_order_number() takes FOR UPDATE before it
  -- hands out a number. Holding it here is what makes the four readings below
  -- true at the moment of the write rather than merely true when they were
  -- taken.
  select c.next_number into v_prev
  from public.order_number_cycle c
  where c.id = true
  for update;

  if not found then
    raise exception 'ORDER_NUMBER_CYCLE_MISSING: Confirmed Order numbering is not configured'
      using errcode = 'P0001';
  end if;

  -- ── Gate 1: a valid, finalized cleanup claim ── (and, with it, gate 5)
  if p_claim_token is null then
    raise exception 'ORDER_NUMBER_RESET_NO_CLAIM: a finalized Test Data Cleanup claim is required'
      using errcode = '42501';
  end if;

  select * into v_claim
  from public.test_data_cleanup_claims
  where claim_token = p_claim_token;

  if not found then
    raise exception 'ORDER_NUMBER_RESET_CLAIM_INVALID: that cleanup claim is not valid'
      using errcode = '42501';
  end if;

  if v_claim.finalized_at is null then
    raise exception 'ORDER_NUMBER_RESET_CLAIM_UNFINISHED: that cleanup has not been finalized, so its storage removal is not proven complete'
      using errcode = '42501';
  end if;

  -- ── Gate 2: not one Order row remains ──
  --
  -- Deliberately `public.orders` entire, with no is_test_data filter. A
  -- cancelled real Order is a row like any other, and once one exists this gate
  -- closes permanently — which is the point. The register is either empty or it
  -- is not.
  select count(*) into v_orders from public.orders;
  if v_orders <> 0 then
    raise exception
      'ORDER_NUMBER_RESET_ORDERS_EXIST: % Order(s) still exist; the cycle may only restart against an empty register',
      v_orders
      using errcode = '42501';
  end if;

  -- ── Gate 3: no PI approval could be in flight ──
  select count(*) into v_pending
  from public.order_submissions s
  where s.status in ('submitted', 'approved')
     or s.order_id is not null;

  if v_pending <> 0 then
    raise exception
      'ORDER_NUMBER_RESET_APPROVAL_PENDING: % PI submission(s) are submitted or approved; an approval allocates a number and must not race this reset',
      v_pending
      using errcode = '42501';
  end if;

  -- ── Gate 3a: NO PI DRAFT IS HOLDING A NUMBER ── (20261009000000)
  --
  -- Gate 3 asks about submitted and approved PIs, because those are the ones an
  -- approval could be in flight for. A reservation is taken EARLIER than that —
  -- while the PI is still a draft — so gate 3 does not see it, and a reset would
  -- walk the cycle back to 1 underneath a number somebody has already printed on
  -- a customer's document. The next Order would then be created as 0001 and the
  -- PI holding 0001 could never be approved.
  --
  -- Deliberately every reservation, used or not. A used one belongs to an Order,
  -- and gate 2 has already refused if any Order exists; an unused one is a live
  -- promise. Neither is compatible with restarting the register.
  select count(*) into v_reserved
  from public.order_submissions s
  where s.reserved_order_number is not null;

  if v_reserved <> 0 then
    raise exception
      'ORDER_NUMBER_RESET_RESERVATIONS_EXIST: % PI Draft(s) hold a reserved Order number; the cycle may only restart when none is outstanding',
      v_reserved
      using errcode = '42501';
  end if;

  -- ── Gate 4: no payment allocation still points at an Order or a PI ──
  select count(*) into v_allocs
  from public.finance_payment_allocations a
  where a.order_id is not null or a.order_submission_id is not null;

  if v_allocs <> 0 then
    raise exception
      'ORDER_NUMBER_RESET_ALLOCATIONS_REMAIN: % payment allocation(s) still point at an Order or a PI',
      v_allocs
      using errcode = '42501';
  end if;

  -- ── Already at 1: answer, do not act ──
  --
  -- IDEMPOTENT, and audited as such. A second call after a successful one is a
  -- person checking, not a person deciding, and it must not write a second
  -- decision — but it must also not report a failure for a state that is
  -- exactly what was asked for.
  if v_prev = 1 then
    return jsonb_build_object(
      'reset', false, 'already_at_start', true,
      'next_number', 1, 'next_display_number', public.format_confirmed_order_number(1));
  end if;

  v_evidence := jsonb_build_object(
    'claim_token_matched',   true,
    'claim_finalized_at',    v_claim.finalized_at,
    'claim_root_type',       v_claim.root_type,
    'orders_remaining',      v_orders,
    'submissions_in_flight', v_pending,
    'allocations_remaining', v_allocs,
    'reservations_remaining', v_reserved,
    'storage_prefix',        v_claim.storage_prefix);

  update public.order_number_cycle
     set next_number   = 1,
         configured_at = now(),
         configured_by = v_actor
   where id = true;

  insert into public.order_number_cycle_resets (
    performed_by, performed_by_email, claim_id,
    previous_number, new_number, evidence
  ) values (
    v_actor, v_email, v_claim.id, v_prev, 1, v_evidence
  ) returning id into v_reset_id;

  return jsonb_build_object(
    'reset',               true,
    'already_at_start',    false,
    'reset_id',            v_reset_id,
    'previous_number',     v_prev,
    'next_number',         1,
    'next_display_number', public.format_confirmed_order_number(1),
    'evidence',            v_evidence);
end;
$$;

comment on function public.reset_confirmed_order_number_cycle(uuid) is
  'Admin-only. Returns the Confirmed Order number cycle to 1 so the next real Order is 0001. Requires a FINALIZED Test Data Cleanup claim, an entirely empty public.orders, no submitted or approved PI, NO PI DRAFT HOLDING A RESERVED ORDER NUMBER, and no payment allocation still pointing at an Order or a PI. Locks the cycle row first, so a concurrent approval or reservation cannot race it. Deletes nothing. Idempotent, and permanently audited in order_number_cycle_resets.';

revoke execute on function public.reset_confirmed_order_number_cycle(uuid) from public, anon;
grant  execute on function public.reset_confirmed_order_number_cycle(uuid) to authenticated;


-- ═══ 9. Assertions, taken against the real database at apply time ══════════
--
-- The migration refuses ITSELF rather than shipping a partial or a dangerous
-- state. Every block below runs inside the same transaction as everything above,
-- so a failure here rolls the whole file back and the database is exactly as it
-- was.
--
-- A CENSUS BEFORE AND AFTER is deliberately not needed: this file inserts no
-- row, deletes no row and updates no business column. What it asserts instead is
-- that it has not — that not one Order was renumbered, not one allocation
-- rewritten, and not one PI given a reservation by the act of applying this.

do $$
declare
  v_bad     bigint;
  v_missing text[] := array[]::text[];
  v_fn      text;
  v_def     text;
  v_action  text;
begin
  -- ── 9a. Nothing was created with a reservation ──
  --
  -- The columns are new and nullable with no default and no backfill, so every
  -- existing PI must hold NULL. A non-zero count here would mean this file wrote
  -- to live records, which it must never do.
  select count(*) into v_bad
  from public.order_submissions
  where reserved_order_number is not null
     or reserved_order_number_at is not null
     or reserved_order_number_by is not null
     or reserved_number_workbook_sha256 is not null
     or reserved_order_number_used_at is not null;

  if v_bad <> 0 then
    raise exception
      'ASSERTION FAILED: % PI submission(s) carry reservation data after a migration that writes none', v_bad;
  end if;

  -- ── 9b. Historical Order numbers are untouched ──
  --
  -- Every Order still carries a well-formed four-digit number, and no two share
  -- one. Asserted rather than assumed, because §4, §5 and §6 all rewrite the
  -- functions that produce these values and this is the invariant they exist to
  -- keep.
  select count(*) into v_bad
  from public.orders
  where display_number !~ '^[0-9]{4}$' or display_number = '0000';

  if v_bad <> 0 then
    raise exception 'ASSERTION FAILED: % Order(s) do not carry a four-digit number', v_bad;
  end if;

  select count(*) into v_bad
  from (select display_number from public.orders group by display_number having count(*) > 1) d;

  if v_bad <> 0 then
    raise exception 'ASSERTION FAILED: % Order number(s) are held by more than one Order', v_bad;
  end if;

  -- ── 9c. The guarantees that hold the two sides of the series apart ──
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'order_submissions_reserved_order_number_uidx'
      and c.relkind = 'i'
  ) then
    raise exception 'ASSERTION FAILED: the reserved-number unique index was not created';
  end if;

  if not exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'order_submissions_reserved_order_number_uidx'
      and i.indisunique
      and i.indpred is not null
  ) then
    raise exception 'ASSERTION FAILED: the reserved-number index is not unique, or is not partial';
  end if;

  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.order_submissions'::regclass
      and t.tgname  = 'order_submissions_protect_reserved_number'
      and t.tgenabled <> 'D'
  ) then
    raise exception 'ASSERTION FAILED: the reserved-number immutability trigger is missing or disabled';
  end if;

  -- The trigger that hands a number to a new Order must still be the ONLY thing
  -- that does, and must still be enabled. A disabled one would let a caller-
  -- supplied number through, which is the hole 20260703000000 §7 was written to
  -- close.
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.orders'::regclass
      and t.tgname  = 'orders_assign_display_number'
      and t.tgenabled <> 'D'
  ) then
    raise exception 'ASSERTION FAILED: orders_assign_display_number is missing or disabled';
  end if;

  -- ── 9d. Every function this file installs exists, and none is client-callable
  --        that should not be ──
  foreach v_fn in array array[
    'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)',
    'public.reserve_order_number_for_submission(uuid)',
    'public.allocate_confirmed_order_number()',
    'public.set_next_confirmed_order_number(bigint)',
    'public.assign_order_display_number()',
    'public.approve_order_submission(uuid)',
    'public.reset_confirmed_order_number_cycle(uuid)',
    'public.prevent_reserved_order_number_change()'
  ]
  loop
    if to_regprocedure(v_fn) is null then
      v_missing := array_append(v_missing, v_fn);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'ASSERTION FAILED: not installed: %', array_to_string(v_missing, ', ');
  end if;

  -- The allocator and the trigger function stay unreachable from a browser.
  -- Granting either would let a client take a number outside any workflow.
  if has_function_privilege('authenticated', 'public.allocate_confirmed_order_number()', 'execute')
     or has_function_privilege('anon', 'public.allocate_confirmed_order_number()', 'execute')
  then
    raise exception 'ASSERTION FAILED: allocate_confirmed_order_number is executable by a client role';
  end if;

  if has_function_privilege('authenticated', 'public.assign_order_display_number()', 'execute')
     or has_function_privilege('anon', 'public.assign_order_display_number()', 'execute')
  then
    raise exception 'ASSERTION FAILED: assign_order_display_number is executable by a client role';
  end if;

  -- And the two new doors ARE reachable by an authenticated caller, which is
  -- what makes them doors. Their own bodies decide who gets through.
  if not has_function_privilege('authenticated',
        'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)', 'execute')
     or not has_function_privilege('authenticated',
        'public.reserve_order_number_for_submission(uuid)', 'execute')
  then
    raise exception 'ASSERTION FAILED: a new RPC is not executable by authenticated';
  end if;

  if has_function_privilege('anon',
        'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)', 'execute')
     or has_function_privilege('anon',
        'public.reserve_order_number_for_submission(uuid)', 'execute')
  then
    raise exception 'ASSERTION FAILED: a new RPC is executable by anon';
  end if;

  -- ── 9e. The action set admits everything any installed function logs ──
  --
  -- The same check 20261001000000 makes, extended by the two actions this file
  -- writes. A migration that logs an action the constraint refuses would fail at
  -- the first real use rather than here.
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.order_submission_activity'::regclass
    and conname  = 'order_submission_activity_action_check';

  if v_def is null then
    raise exception 'ASSERTION FAILED: the activity action constraint is missing';
  end if;

  v_missing := array[]::text[];
  foreach v_action in array array[
    'submission_created', 'parse_replaced', 'submitted', 'changes_requested', 'rejected',
    'advance_exception_requested', 'advance_exception_approved', 'advance_exception_rejected',
    'finance_verified', 'approved', 'payment_recorded', 'payment_allocations_moved',
    'billing_percentage_set', 'billing_percentage_amended_by_admin',
    'client_details_updated', 'client_details_amended_by_admin',
    'schedule_terms_updated', 'schedule_terms_amended_by_admin',
    'correction_requested', 'correction_resolved', 'correction_rejected',
    'product_details_updated', 'product_details_amended_by_admin',
    'workbook_replaced_by_admin',
    'order_number_reserved', 'order_number_used'
  ]
  loop
    if position('''' || v_action || '''' in v_def) = 0 then
      v_missing := array_append(v_missing, v_action);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'ASSERTION FAILED: the action constraint does not admit: %',
      array_to_string(v_missing, ', ');
  end if;

  -- ── 9f. THE RETIREMENT IS NOT REOPENED ──
  --
  -- 20261007000000's four guards must all still be installed and enabled. This
  -- file adds a payment-entry door, and a payment-entry door is exactly the kind
  -- of thing that could quietly reopen a retired workflow — so the guards are
  -- re-asserted here rather than assumed.
  foreach v_action in array array[
    'order_requests_refuse_new',
    'order_requests_refuse_conversion',
    'orders_refuse_request_provenance'
  ]
  loop
    if not exists (
      select 1 from pg_trigger t where t.tgname = v_action and t.tgenabled <> 'D'
    ) then
      raise exception 'ASSERTION FAILED: the Order Request retirement guard % is missing or disabled', v_action;
    end if;
  end loop;

  raise notice '20261009000000 applied: split payment entry, and a reservable Order number.';
end $$;
