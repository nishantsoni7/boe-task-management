-- ═══════════════════════════════════════════════════════════════════════════
-- ONE PAYMENT, MANY DESTINATIONS — AND A PI THAT CARRIES ITS ORDER NUMBER
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
--    §2–§8 close that gap: a PI Draft takes a real number from the real cycle
--    as soon as it has a workbook, the revised workbook must be shown to
--    ACTUALLY CONTAIN that number, and the Confirmed Order is created with it.
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
-- ── WHY THE HASH ALONE WAS NOT ENOUGH ─────────────────────────────────────
--
-- An earlier form of this file proved only that a DIFFERENT file had been
-- uploaded since the number was issued. That is evidence of an upload, not of a
-- number: a salesperson who corrected a typo elsewhere in the workbook and
-- re-uploaded it satisfied the test with a document that still carried the wrong
-- number — or none.
--
-- The number is now READ OUT OF THE REVISED WORKBOOK and compared. It is read by
-- the parser that already exists and by no other: the import route downloads the
-- stored bytes, parses them SERVER-SIDE (its own §11, "THE TRUSTED PARSE") and
-- hands the result to replace_order_submission_parse(), which is the only writer
-- of order_submissions.source_order_number and is executable by the service role
-- alone. A browser sends a submission id and a storage path; it cannot state
-- what the workbook says. So this comparison reads a server-parsed fact, and
-- there is no second Excel parser anywhere in this file.
--
-- ── WHAT THIS FILE DELIBERATELY DOES NOT DO ───────────────────────────────
--
--   * It re-emits ONE deployed function. An earlier form restated five —
--     allocate_confirmed_order_number, set_next_confirmed_order_number,
--     assign_order_display_number, approve_order_submission and
--     reset_confirmed_order_number_cycle — roughly 950 lines of code that was
--     already applied and already correct, for the sake of a clause or two in
--     each. Every one of those clauses is now a TRIGGER instead (§6, §7b, §8),
--     which is both smaller and STRICTLY WIDER: a trigger on the table catches
--     every writer, including the service role and a raw UPDATE, where a rule
--     inside one function catches only that function's callers.
--
--     assign_order_display_number() is the one exception and cannot be a
--     trigger, because it IS the trigger — the function that decides what
--     number a new Order gets. It is 8 lines long and is restated whole.
--
--   * It invents no number format and no second series. There is one cycle, one
--     format (four digits, 0001–9999, format_confirmed_order_number), and no
--     legal entity, financial year or branch scopes it — checked against the
--     schema, not assumed.
--   * It creates no second allocation system. §1 writes its allocations through
--     allocate_payment_to_target_internal(), which is where the capacity lock,
--     the duplicate rule, the target eligibility test and the visibility test
--     already live.
--   * It does not revive Order Requests, and cannot: the allocation model has
--     no Order Request target, so §1 has no parameter that could name one.
--   * It touches no historical row. No Order is renumbered, no allocation is
--     rewritten, no payment is reclassified, and NO PI DRAFT THAT EXISTS TODAY
--     IS GIVEN A NUMBER. §9 asserts all four.
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
  if to_regprocedure('public.approve_order_submission(uuid)') is null
     or to_regprocedure('public.in_pi_submission_approval(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260915000000 / 20260923000000 must be applied before this migration';
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
  if to_regprocedure('public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: 20260908000000 must be applied before this migration';
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
-- FIVE COLUMNS, and each answers a question the others cannot:
--
--   reserved_order_number            the number, in the ONE existing format
--   reserved_order_number_at         when it was taken — the audit anchor
--   reserved_order_number_by         who it was taken for
--   reserved_number_workbook_sha256  THE WORKBOOK THAT WAS ON FILE AT THAT
--                                    MOMENT. Half of the revised-PI test: a PI
--                                    whose workbook still hashes to this has not
--                                    been re-parsed since the number was issued,
--                                    so whatever source_order_number says is
--                                    what it said BEFORE the number existed.
--   reserved_order_number_used_at    when the Confirmed Order took it. Set once,
--                                    never cleared.
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
  'The Confirmed Order number this PI Draft has reserved from the one numbering cycle, four digits, 0001-9999. NULL until a reservation is taken. Never reused, never reassigned, never cleared: an abandoned reservation is a gap in the series, which is the safe outcome.';

comment on column public.order_submissions.reserved_number_workbook_sha256 is
  'The source_workbook_sha256 that was on file when the number was reserved. Half of the revised-PI test: while the live hash still equals this, the workbook has not been re-parsed since the number was issued, so its parsed number cannot yet be the reserved one.';

comment on column public.order_submissions.reserved_order_number_used_at is
  'When the Confirmed Order created from this PI took the reserved number. Set once by the orders consumption trigger; a non-null value with no Order would be a contradiction the §9 assertion refuses.';

-- ── 2a. WHICH DRAFTS THE WORKFLOW IS MANDATORY FOR ──
--
-- THE REQUESTED WORKFLOW IS NOT OPTIONAL: a PI Draft created from here on takes
-- its number as soon as it has a workbook, and cannot be submitted or approved
-- until the revised workbook carries it. But a draft that ALREADY EXISTS was
-- created under the old rule, may already be under review, and may already have
-- a signed document in front of a customer. Forcing the new rule onto it would
-- strand it.
--
-- THE GRANDFATHERING IS PURE DDL, AND THAT IS THE POINT. The column is added
-- NOT NULL DEFAULT false — which fills every existing row with false without
-- rewriting the table (PostgreSQL 11+) and, crucially, without this migration
-- executing a single UPDATE against live data. The default is THEN changed to
-- true, so every row inserted after this migration carries the obligation and
-- every row that predates it does not.
--
-- There is no backfill, no heuristic and no cutoff timestamp to get wrong: the
-- two populations are separated by the one event that actually distinguishes
-- them, which is whether the row existed when this ran.

alter table public.order_submissions
  add column if not exists reservation_required boolean not null default false;

alter table public.order_submissions
  alter column reservation_required set default true;

comment on column public.order_submissions.reservation_required is
  'Whether this PI Draft must hold a reserved Order number and a revised workbook carrying it before it can be submitted or approved. TRUE for every draft created after 20261009000000; FALSE for every draft that predates it, which reserves through the controlled compatibility action instead. Set by the column default and never written by hand.';

-- ── 2b. The format, and the all-or-nothing rule ──
--
-- The SAME regex orders.display_number carries (20260704000000 §4), stated again
-- rather than referenced, because a reservation that could hold '17' or 'ORD-1'
-- would produce an Order the orders constraint then refuses — at approval, after
-- the customer has the document.
--
-- And a reservation is never half-written: a number with no time, a time with no
-- actor, or an actor with no number is not something anybody can audit. The
-- workbook hash is deliberately OUTSIDE this rule — §5 requires one at the
-- moment it reserves, but a NULL is a possible past state and the refusal for it
-- belongs to §3, which says what it means, rather than to a constraint that can
-- only say "no".

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

-- ── 2c. TWO PI DRAFTS CAN NEVER HOLD THE SAME NUMBER ──
--
-- The rule the whole feature rests on, and it is an INDEX rather than a check in
-- a function, because a function's check is only as good as the lock around it
-- and an index needs no lock at all. Partial, so the unbounded majority of PI
-- Drafts — which hold no reservation — cost nothing.
--
-- It says nothing about public.orders; cross-table uniqueness cannot be an index.
-- §6 and §7 are what keep the two sides apart, and §9 asserts the result.

create unique index if not exists order_submissions_reserved_order_number_uidx
  on public.order_submissions (reserved_order_number)
  where reserved_order_number is not null;

-- ── 2d. ONCE SHOWN, IT DOES NOT SILENTLY CHANGE ──
--
-- A number that has been printed on a customer's document is not an editable
-- field, for anybody, through any path — not an admin correction, not a
-- re-import, not a status change. There is no client-role UPDATE grant on this
-- table at all (20260908000000 §5), so this guard is aimed at the SECURITY
-- DEFINER functions that do write here: it makes a careless `update ... set` in
-- some future function a loud refusal instead of a rewritten commercial number.
--
-- Setting it from NULL is allowed exactly once, which is what lets §5 write it.
-- A no-op write of the same value passes, so every unrelated UPDATE on this
-- table — status, totals, client details — is unaffected.
--
-- reservation_required is frozen in the same trigger and for the same reason: it
-- decides whether the workflow is mandatory for this record, and a path that
-- could turn it off would be a path that skips the whole feature.
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

  if new.reservation_required is distinct from old.reservation_required then
    raise exception
      'RESERVATION_OBLIGATION_IMMUTABLE: whether a PI must carry a reserved Order number is decided when it is created and cannot be changed'
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

-- ── 2e. The three actions a PI's history may now record ──
--
-- The action set is CLOSED (20261001000000) and a migration that logs a new
-- action must declare it in the same migration. These are §5's and §7b's.
--
-- RE-EMITTED IN FULL rather than patched: the constraint has one home and a
-- reader should see the whole admitted set in one place. This is the sanctioned
-- extension point 20260915000000 §10 describes, and submissionSchema.test.ts
-- forgives exactly this statement and nothing else.

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
    -- Three events, not one, because they are three facts a reader needs
    -- separately: WHEN the number was committed to (and therefore when it could
    -- first appear on a document), WHEN the revised document carrying it was
    -- accepted, and WHEN the Order finally took it up.
    'order_number_reserved',
    'order_number_revised_pi_verified',
    'order_number_used'
  ));

comment on constraint order_submission_activity_action_check on public.order_submission_activity is
  'The CLOSED set of actions a PI''s history may record. A migration that logs a new action must extend this in the same migration — a rule 20260923000000 broke, which is why billing_percentage_set appears here rather than there.';


-- ═══ 3. Does the revised PI actually carry the number ══════════════════════
--
-- THE RULE, IN ONE PLACE, BECAUSE IT IS ASKED IN TWO. The submit gate (§8) and
-- the Order-creation gate (§7) must give the same answer to the same record, and
-- the only way to guarantee that is for there to be one answer. Both call this.
--
-- IT RETURNS THE REFUSAL, NOT A BOOLEAN. A boolean would force each caller to
-- compose its own message, which is how two callers come to disagree about WHY
-- something was refused — and "the revised PI is missing" and "the revised PI
-- has the wrong number on it" send a person to two completely different actions.
-- NULL means it passes.
--
-- WHERE THE NUMBER COMES FROM, and why it can be trusted:
-- order_submissions.source_order_number is cell B20 of the Master sheet, read by
-- the ONE parser this project has (src/lib/pi/masterSheetParser.ts,
-- HEADER_CELLS.sourceOrderNumber). It is written by exactly one function —
-- replace_order_submission_parse() — which is revoked from public, anon AND
-- authenticated, and is reached only by /api/orders/import/process-draft. That
-- route downloads the stored workbook, parses the bytes it actually holds, and
-- refuses to take any header value from the request body. A browser cannot state
-- what the workbook says; it can only ask for the stored bytes to be re-read.

create or replace function public.normalize_order_number_reference(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  -- Surrounding whitespace and case, and NOTHING ELSE. Internal whitespace is
  -- collapsed to a single space rather than removed, so '00 42' stays '00 42'
  -- and is refused: it is not what a reader of the document sees when they read
  -- '0042'. An empty result is NULL, because a cell holding only spaces has
  -- said nothing.
  select nullif(upper(btrim(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g'))), '')
$$;

comment on function public.normalize_order_number_reference(text) is
  'The one normalization applied before an Order number read out of a workbook is compared: surrounding whitespace trimmed, internal whitespace runs collapsed to one space, upper-cased, and blank resolved to NULL. Deliberately does NOT strip leading zeros — they are part of the identifier (20260704000000 §4), so 42 is not 0042 and a document printed with 42 carries the wrong number.';

create or replace function public.order_submission_revised_pi_refusal(
  p_reserved      text,
  p_reserved_sha  text,
  p_current_sha   text,
  p_reference     text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_found    text := public.normalize_order_number_reference(p_reference);
  v_expected text := public.normalize_order_number_reference(p_reserved);
begin
  -- No reservation, nothing to prove. Callers ask this only when there IS one,
  -- but a function that answered differently depending on being asked correctly
  -- would be a trap.
  if v_expected is null then
    return null;
  end if;

  -- ── 1. HAS THE WORKBOOK BEEN RE-PARSED AT ALL SINCE THE NUMBER WAS ISSUED ──
  --
  -- KEPT, and not merely as a courtesy. source_order_number is only ever written
  -- by a parse, so while the hash is unchanged the reference on the row is the
  -- one that was read BEFORE the number existed. If the old workbook happened to
  -- carry '0042' — an older PI copied from, which is the ordinary case for B20 —
  -- a match here would be pure coincidence and would let an unrevised document
  -- through. So this is asked FIRST and independently.
  --
  -- A PARSE THAT FAILED LANDS HERE TOO, and correctly: a failed parse replaces
  -- nothing (the import route's §12 leaves the workbook in storage and writes no
  -- header), so the hash does not move and this is the refusal the person sees.
  if p_current_sha is null or p_current_sha = p_reserved_sha then
    return format(
      'ORDER_SUBMISSION_REVISED_PI_MISSING: Order number %s is reserved for this PI, but no revised PI has been uploaded since it was issued. Put %s into the PI and upload it with Change PI.',
      v_expected, v_expected);
  end if;

  -- ── 2. DOES THE REVISED WORKBOOK NAME A NUMBER AT ALL ──
  if v_found is null then
    return format(
      'ORDER_SUBMISSION_REVISED_PI_NO_NUMBER: the revised PI does not carry an Order number. Put %s into the PI and upload it again.',
      v_expected);
  end if;

  -- ── 3. IS IT THE RIGHT ONE ──
  --
  -- EXACT EQUALITY, after §3's normalization and nothing more. Not a prefix, not
  -- a substring, not a numeric comparison: '42', '0042A', 'PI-0042' and
  -- '0042/2026' are every one of them a different string from '0042', and a
  -- commercial document that says any of them does not say 0042.
  if v_found <> v_expected then
    return format(
      'ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH: the revised PI carries Order number %s, but %s is reserved for it. Correct the PI and upload it again.',
      v_found, v_expected);
  end if;

  return null;
end;
$$;

comment on function public.order_submission_revised_pi_refusal(text, text, text, text) is
  'The single rule deciding whether a PI Draft holding a reserved Order number has had a revised workbook uploaded that actually carries it. Returns the refusal message, or NULL when it passes. Asked by the submit gate and by the Order-creation gate, so the two can never disagree. The reference it reads is the server-parsed B20 of the stored workbook; nothing a browser sends reaches it.';

revoke execute on function public.order_submission_revised_pi_refusal(text, text, text, text)
  from public, anon;
grant  execute on function public.order_submission_revised_pi_refusal(text, text, text, text)
  to authenticated;


-- ═══ 4. Taking the number ══════════════════════════════════════════════════
--
-- TWO DOORS ONTO ONE IMPLEMENTATION, the arrangement 20260919000000 already uses
-- for allocation:
--
--   reserve_order_number_internal()      the act. Decides no authorization of
--                                        its own; every door in front of it
--                                        does. Not executable by any role.
--   reserve_order_number_for_submission() the CLIENT door, for a legacy draft
--                                        that predates the automatic rule.
--   §5's trigger                          the AUTOMATIC door, for every draft
--                                        created after this migration.
--
-- The automatic door cannot reuse the client door, because it fires under the
-- service role where auth.uid() is NULL — the same reason
-- log_order_submission_activity takes an explicit actor rather than reading
-- auth.uid(). So the act is separated from the authorization, and each caller
-- supplies an actor it has already validated.
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

create or replace function public.reserve_order_number_internal(
  p_submission_id uuid,
  p_actor         uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub    public.order_submissions%rowtype;
  v_number text;
  v_now    timestamptz;
begin
  -- The row is expected to be locked, or to be NEW inside a trigger, by the
  -- caller. Read without a second lock for the same reason
  -- assert_order_submission_workbook_editor reads without one: taking the FIRST
  -- lock here would move it after the caller's own reads and break that ordering.
  select * into v_sub from public.order_submissions where id = p_submission_id;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- ── Already reserved: answer, do not act ──
  if v_sub.reserved_order_number is not null then
    return jsonb_build_object(
      'submission_id',         p_submission_id,
      'reserved_order_number', v_sub.reserved_order_number,
      'reserved_at',           v_sub.reserved_order_number_at,
      'already_reserved',      true,
      'used_at',               v_sub.reserved_order_number_used_at
    );
  end if;

  -- ── The PI must still be able to become an Order ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot reserve an Order number'
      using errcode = '55P03';
  end if;

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

  -- ── THERE MUST BE A WORKBOOK TO REVISE ──
  --
  -- The point of the number is to be added to the PI document and uploaded
  -- again. A PI with no workbook on file has nothing to add it to, and the hash
  -- captured below would be NULL — which §3 reads as "not revised yet" forever.
  if coalesce(btrim(v_sub.source_workbook_path), '') = ''
     or v_sub.source_workbook_sha256 is null then
    raise exception
      'ORDER_NUMBER_RESERVATION_NO_WORKBOOK: upload the PI file first — the reserved number has to go into it'
      using errcode = 'P0001';
  end if;

  v_number := public.allocate_confirmed_order_number();
  v_now    := now();

  update public.order_submissions
     set reserved_order_number           = v_number,
         reserved_order_number_at        = v_now,
         reserved_order_number_by        = p_actor,
         reserved_number_workbook_sha256 = v_sub.source_workbook_sha256
   where id = p_submission_id;

  -- NO ACTIVITY ROW IS WRITTEN HERE. §5c's AFTER trigger writes exactly one, for
  -- every door, by watching the column itself — so the automatic path and this
  -- one cannot record the reservation differently, and neither can record it
  -- twice.
  return jsonb_build_object(
    'submission_id',         p_submission_id,
    'reserved_order_number', v_number,
    'reserved_at',           v_now,
    'already_reserved',      false,
    'used_at',               null
  );
end;
$$;

comment on function public.reserve_order_number_internal(uuid, uuid) is
  'The single reservation implementation: answers with an existing reservation, refuses a PI that can no longer become an Order or has no workbook, takes the next number from the cycle under its FOR UPDATE lock and records it against the workbook hash of the moment. Decides no caller authorization of its own — each door in front of it does that. Not executable by any client role.';

revoke execute on function public.reserve_order_number_internal(uuid, uuid)
  from public, anon, authenticated;

-- ── 4a. The client door — for a draft that predates the automatic rule ──────
--
-- WHEN. While the PI is a DRAFT or has been RETURNED FOR CHANGES, and only then.
-- That is not an arbitrary stage: it is the ONLY stage at which the PI's own
-- owner may replace the workbook (assert_order_submission_workbook_editor,
-- 20261003000000 — past submission the answer is "active admin only").
-- Reserving a number on a submitted PI would hand somebody a number and then
-- refuse them the upload it exists for.
--
-- WHO. Exactly the population that may replace that workbook at that stage: the
-- PI's owner, or an active admin, and in both cases somebody holding
-- orders.create. The question is asked by CALLING the existing authority rather
-- than by restating its rule, so the two can never drift; and the answer is
-- required to be `after_submission = false`, which closes the admin's
-- past-submission branch off from this door.
--
-- Note what is NOT a route. Finance authority is not: reserving a commercial
-- number is not a money decision. orders.approve_order is not: the approver's
-- act is approval, and approval already numbers the Order.
--
-- IT IS A COMPATIBILITY ACTION, NOT THE MAIN PATH. A draft created after this
-- migration has its number before anybody could press this, and pressing it
-- returns that number. The screens offer it only where there is something to do.

create or replace function public.reserve_order_number_for_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_sub   public.order_submissions%rowtype;
  v_auth  jsonb;
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

  -- The marker §5c reads to tell a click from the automatic path. Transaction-
  -- local (the third argument is true), so it cannot outlive this call.
  perform set_config('boe.order_number_reserved_by_hand', p_submission_id::text, true);

  -- ── 2. Already reserved: answer without re-asking authorization ──
  --
  -- The honest answer to "what number does this PI have" does not depend on
  -- whether the asker could have been the one to take it. It is the number on
  -- the screen either way, and can_view_order_submission already governs whether
  -- this PI is readable at all.
  if v_sub.reserved_order_number is not null then
    return public.reserve_order_number_internal(p_submission_id, v_actor);
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

  return public.reserve_order_number_internal(p_submission_id, v_actor);
end;
$$;

comment on function public.reserve_order_number_for_submission(uuid) is
  'Reserves the next Confirmed Order number for a PI Draft that predates 20261009000000, so the number can be printed on the revised PI before approval. Permitted only while the PI is draft or needs_changes, and only to the population that may replace its workbook at that stage — its owner, or an active admin, holding orders.create. Idempotent: a PI that already holds a reservation gets that number back and no second one is taken. A draft created after 20261009000000 reserves automatically and never needs this.';

revoke execute on function public.reserve_order_number_for_submission(uuid) from public, anon;
grant  execute on function public.reserve_order_number_for_submission(uuid) to authenticated;


-- ═══ 5. Every new draft takes its number automatically ═════════════════════
--
-- THE WORKFLOW IS NOT OPTIONAL FOR A NEW DRAFT, and it must not depend on
-- somebody remembering to press a button. The moment a PI Draft has a workbook
-- it has everything a reservation needs, and that is the moment it takes one.
--
-- A TRIGGER RATHER THAN A CLAUSE IN replace_order_submission_parse(). Three
-- reasons, and the third is the one that decides it:
--
--   * that function is ~400 lines of applied, correct code, and re-emitting it
--     to add six lines is exactly what this migration was asked to stop doing;
--   * a trigger catches EVERY writer, including the service role and any future
--     import path, where a clause inside one function catches only its callers;
--   * BEFORE, so the columns are set on NEW in the same write. An AFTER trigger
--     would need a second UPDATE of the row it is already updating, which would
--     re-enter this trigger and every other one on the table.
--
-- WHY IT FIRES ON THE WORKBOOK AND NOT ON CREATION. create_order_submission
-- makes an EMPTY draft — no workbook, no hash — and a number reserved there
-- would be recorded against a NULL hash, which §3 reads as "never revised" for
-- the rest of that PI's life. The obligation is set at creation
-- (reservation_required); the number is taken when it can be recorded honestly.
--
-- THE ACTOR IS THE PI'S OWN CREATOR, not auth.uid(). The parse runs as the
-- service role, where auth.uid() is NULL, and a reservation attributed to
-- nobody would be an audit row that answers none of its own questions. The
-- person whose PI it is caused this, so they are who it is recorded against —
-- and `automatic: true` in the activity metadata says it was not a click.

create or replace function public.order_submissions_auto_reserve_order_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_number text;
begin
  -- Every condition, stated positively, in the order that makes a reader's
  -- question cheapest to answer.
  if not new.reservation_required then return new; end if;
  if new.reserved_order_number is not null then return new; end if;
  if new.source_workbook_sha256 is null then return new; end if;
  if coalesce(btrim(new.source_workbook_path), '') = '' then return new; end if;
  if new.order_id is not null then return new; end if;
  if new.deletion_claim_token is not null then return new; end if;
  if new.status not in ('draft', 'needs_changes') then return new; end if;

  -- The same allocator, the same lock, the same series. A failure here — an
  -- exhausted or misconfigured cycle — aborts the parse that triggered it, which
  -- is correct: a PI that cannot be numbered must not be silently stored as one
  -- that will never be approvable.
  v_number := public.allocate_confirmed_order_number();

  new.reserved_order_number           := v_number;
  new.reserved_order_number_at        := now();
  new.reserved_order_number_by        := new.created_by;
  new.reserved_number_workbook_sha256 := new.source_workbook_sha256;

  -- NO ACTIVITY ROW HERE EITHER, and on an INSERT it would not even be possible:
  -- order_submission_activity.submission_id is a foreign key onto a row that
  -- does not exist until this BEFORE trigger returns. §5c writes it afterwards.
  return new;
end;
$$;

revoke execute on function public.order_submissions_auto_reserve_order_number()
  from public, anon, authenticated;

-- BEFORE the immutability guard, alphabetically and therefore in fire order:
-- 'order_submissions_auto_reserve_order_number' sorts before
-- 'order_submissions_protect_reserved_number'. It does not matter which runs
-- first — the guard only refuses a CHANGE to a non-null OLD value, and OLD is
-- null on every row this trigger acts on — but the order is stated so a reader
-- does not have to work it out.
drop trigger if exists order_submissions_auto_reserve_order_number on public.order_submissions;
create trigger order_submissions_auto_reserve_order_number
  before insert or update on public.order_submissions
  for each row execute function public.order_submissions_auto_reserve_order_number();

-- ── 5c. ONE AUDIT ROW PER RESERVATION, WHATEVER DOOR TOOK IT ───────────────
--
-- WATCHING THE COLUMN RATHER THAN THE CALLERS. There are two doors — the
-- automatic trigger above and reserve_order_number_for_submission() — and if
-- each wrote its own activity row they could disagree about what a reservation
-- looks like in the trail, or both write one, or a third door added later write
-- none. A reservation is `reserved_order_number` becoming non-null, so that is
-- what this watches.
--
-- AFTER, so the submission row exists: order_submission_activity.submission_id
-- is a foreign key onto it, and on an INSERT the row is not there until the
-- BEFORE triggers have returned.
--
-- WHETHER IT WAS A CLICK is a transaction-local marker the client door sets —
-- the same idiom in_pi_submission_approval() uses, and for the same reason: no
-- privilege and no column can express "this write came through that function".
-- Absent means automatic, which is the safe default: a reservation nobody can
-- prove was requested by hand is recorded as one the system took.

create or replace function public.order_submissions_log_reservation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_marker text := current_setting('boe.order_number_reserved_by_hand', true);
begin
  if new.reserved_order_number is null then return null; end if;
  if tg_op = 'UPDATE' and old.reserved_order_number is not null then return null; end if;

  perform public.log_order_submission_activity(
    new.id, new.reserved_order_number_by, 'order_number_reserved',
    new.status, new.status, null,
    jsonb_build_object(
      'reserved_order_number', new.reserved_order_number,
      'automatic',             coalesce(v_marker, '') <> new.id::text,
      'workbook_name',         new.source_workbook_name
    )
  );

  return null;
end;
$$;

revoke execute on function public.order_submissions_log_reservation()
  from public, anon, authenticated;

drop trigger if exists order_submissions_log_reservation on public.order_submissions;
create trigger order_submissions_log_reservation
  after insert or update on public.order_submissions
  for each row execute function public.order_submissions_log_reservation();


-- ═══ 6. The cycle can never step back over a reservation ═══════════════════
--
-- THIS ONE TRIGGER REPLACES THREE RE-EMITTED FUNCTIONS. An earlier form of this
-- migration restated allocate_confirmed_order_number(),
-- set_next_confirmed_order_number() and reset_confirmed_order_number_cycle() in
-- full — roughly 400 lines of applied, correct code — so that each could learn
-- one new rule: do not put the cycle at or below a number a PI Draft is holding.
--
-- The rule belongs to the CYCLE ROW, not to the three functions that happen to
-- write it. Stated here, it is:
--
--   * smaller — one guard instead of three copies of one idea;
--   * stricter — it also catches a raw UPDATE by the service role, a psql
--     session, a future admin tool, and any function nobody has written yet.
--     None of the three re-emissions covered any of those;
--   * impossible to drift, because there is only one of it.
--
-- WHAT IT MAKES UNREACHABLE. allocate_confirmed_order_number() hands out
-- next_number and advances; with this in force, next_number is never at or below
-- a live reservation, so the allocator can never hand out a number a PI Draft
-- holds. set_next_confirmed_order_number() and
-- reset_confirmed_order_number_cycle() are refused before they can create that
-- state. All three keep every rule they already had — none is touched.
--
-- THE COMPARISON IS NUMERIC, deliberately. Reservations are stored as
-- four-digit text and compared as bigint here, because "greater than" is the
-- question and '0009' > '00010' is true as text and false as a number.

create or replace function public.order_number_cycle_respects_reservations()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_reserved bigint;
  v_count    bigint;
begin
  -- Only when the value actually moves. A no-op write, or a touch of
  -- configured_at alone, is not a numbering decision.
  if tg_op = 'UPDATE' and new.next_number is not distinct from old.next_number then
    return new;
  end if;

  select count(*), coalesce(max(s.reserved_order_number::bigint), 0)
    into v_count, v_reserved
  from public.order_submissions s
  where s.reserved_order_number ~ '^[0-9]+$';

  if v_count = 0 then
    return new;
  end if;

  if new.next_number <= v_reserved then
    raise exception
      'ORDER_NUMBER_CYCLE_BEHIND_RESERVATION: % PI Draft(s) hold reserved Order numbers up to %; the next Order number cannot be set to % — it would hand out a number that is already on a customer''s document',
      v_count,
      public.format_confirmed_order_number(v_reserved),
      public.format_confirmed_order_number(new.next_number)
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.order_number_cycle_respects_reservations()
  from public, anon, authenticated;

drop trigger if exists order_number_cycle_respects_reservations on public.order_number_cycle;
create trigger order_number_cycle_respects_reservations
  before insert or update on public.order_number_cycle
  for each row execute function public.order_number_cycle_respects_reservations();

comment on function public.order_number_cycle_respects_reservations() is
  'Refuses any write that would put the Confirmed Order number cycle at or below a number a PI Draft currently holds. Enforced on the TABLE rather than inside allocate_confirmed_order_number(), set_next_confirmed_order_number() and reset_confirmed_order_number_cycle(), so it also binds the service role, a raw UPDATE and any writer that does not exist yet — and so none of those three applied functions has to be restated.';


-- ═══ 7. The Order takes the number its PI was promised ═════════════════════
--
-- RE-EMITTED IN FULL from 20260703000000 §7 — the ONLY function in this file
-- that is. It cannot be a trigger, because it IS the trigger: the BEFORE INSERT
-- function that decides what number a new Order gets. Eight lines became
-- twenty-two.
--
-- THE SECURITY PROPERTY THAT MUST NOT MOVE, and does not: a caller can never
-- seed their own number. The original is unconditional — "whatever display_number
-- a caller supplies is discarded and replaced" — precisely because RLS permits a
-- direct PostgREST insert into public.orders, and a "fill it in only when NULL"
-- variant would let a sales user POST an Order carrying a hand-picked number.
--
-- NEW.display_number IS STILL IGNORED. What this version adds is a second SOURCE
-- for the replacement value, and that source is not the caller either: it is a
-- reservation on the PI this Order is being created from, which was itself
-- issued by the cycle. The caller chooses a PI, not a number.
--
-- AND THE VALIDATION LIVES HERE RATHER THAN IN approve_order_submission().
-- That function is ~450 lines of applied code and this needs to add twenty; more
-- importantly, EVERY Confirmed Order is an INSERT into public.orders, so a check
-- here binds any path that ever creates one — including one written next year
-- that forgets to ask. approve_order_submission() is not touched by this
-- migration at all: the refusals below are raised inside its INSERT, abort its
-- transaction, and reach its caller unchanged.

create or replace function public.assign_order_display_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub     public.order_submissions%rowtype;
  v_refusal text;
begin
  if new.source_order_submission_id is not null then
    select * into v_sub
    from public.order_submissions
    where id = new.source_order_submission_id;

    if found and (v_sub.reserved_order_number is not null or v_sub.reservation_required) then
      -- ── AN ORDER FROM SUCH A PI COMES ONLY FROM AN AUDITED APPROVAL ──
      --
      -- in_pi_submission_approval() is the transaction-local marker
      -- approve_order_submission() sets at its step 12. A bare INSERT naming a
      -- reserved PI cannot set it, so it cannot take that PI's number and leave
      -- the PI permanently unapprovable.
      if not public.in_pi_submission_approval(new.source_order_submission_id) then
        raise exception
          'ORDER_FROM_RESERVED_PI_REQUIRES_APPROVAL: an Order for this PI can only be created by approving it'
          using errcode = '42501';
      end if;

      -- ── THE OBLIGATION, for a draft created after 20261009000000 ──
      if v_sub.reserved_order_number is null then
        raise exception
          'ORDER_SUBMISSION_RESERVATION_REQUIRED: this PI has no reserved Order number, and one is required before it can become an Order'
          using errcode = 'P0001';
      end if;

      if v_sub.reserved_order_number_used_at is not null then
        raise exception
          'ORDER_SUBMISSION_CONVERTED: the number reserved for this PI has already been taken by an Order'
          using errcode = 'P0001';
      end if;

      -- ── THE REVISED PI MUST CARRY THE NUMBER ──
      --
      -- §3's rule, which the submit gate (§8) has already applied once. Asked
      -- again here because a PI can be corrected between submission and
      -- approval, and because this is the last moment at which refusing costs
      -- nothing.
      v_refusal := public.order_submission_revised_pi_refusal(
        v_sub.reserved_order_number,
        v_sub.reserved_number_workbook_sha256,
        v_sub.source_workbook_sha256,
        v_sub.source_order_number);

      if v_refusal is not null then
        raise exception '%', v_refusal using errcode = 'P0001';
      end if;

      -- The unique index on display_number would refuse a collision anyway; this
      -- says which number and why, before the Order exists. §6 is what makes it
      -- unreachable.
      if exists (select 1 from public.orders o where o.display_number = v_sub.reserved_order_number) then
        raise exception
          'ORDER_NUMBER_RESERVATION_IN_USE: Order number % was reserved for this PI but is already in use',
          v_sub.reserved_order_number
          using errcode = 'P0001';
      end if;

      new.display_number := v_sub.reserved_order_number;
      return new;
    end if;
  end if;

  new.display_number := public.allocate_confirmed_order_number();
  return new;
end;
$$;

revoke execute on function public.assign_order_display_number() from public, anon, authenticated;

comment on function public.assign_order_display_number() is
  'BEFORE INSERT on public.orders. Replaces any caller-supplied display_number with a number the caller cannot choose: the unused reservation held by the PI this Order is being approved from — refusing unless the approval marker is open for that PI and the revised workbook actually carries the reserved number — and otherwise the next number from the cycle.';

-- ── 7b. The reservation is spent, and the trail says so ────────────────────
--
-- AFTER INSERT, because the Order must exist before anything can record that it
-- took the number. One UPDATE of one row, guarded so it can only ever move
-- NULL → now(): prevent_reserved_order_number_change() refuses a second stamp,
-- and orders_source_order_submission_id_uidx already makes a second Order from
-- the same PI impossible. Three independent guarantees that one reservation
-- produces one Order.
--
-- approve_order_submission() updates the same submission row a moment later
-- (its step 14, status/approved_by/order_id). That write does not touch
-- reserved_order_number_used_at, so the guard sees an unchanged value and passes.

create or replace function public.orders_consume_reserved_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub public.order_submissions%rowtype;
begin
  if new.source_order_submission_id is null then return null; end if;

  select * into v_sub
  from public.order_submissions
  where id = new.source_order_submission_id;

  if not found or v_sub.reserved_order_number is null then return null; end if;
  if v_sub.reserved_order_number_used_at is not null then return null; end if;

  update public.order_submissions
     set reserved_order_number_used_at = now()
   where id = new.source_order_submission_id;

  -- TWO EVENTS, because they answer two questions. A reader auditing a
  -- commercial document asks "did the Order come out carrying the number the
  -- customer was already given"; a reader auditing the workflow asks "was the
  -- revised document ever actually checked". Neither answers the other.
  --
  -- WHAT IS RECORDED OF THE WORKBOOK: that its parsed reference matched, and
  -- nothing else. Not the hash, not the file name, not the cell — the fact the
  -- trail needs is that the check was made and passed.
  perform public.log_order_submission_activity(
    v_sub.id, new.created_by, 'order_number_revised_pi_verified',
    v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'reserved_order_number', v_sub.reserved_order_number,
      'revised_pi_matched',    true
    )
  );

  perform public.log_order_submission_activity(
    v_sub.id, new.created_by, 'order_number_used', v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'order_id',              new.id,
      'reserved_order_number', v_sub.reserved_order_number,
      'order_display_number',  new.display_number,
      'reserved_at',           v_sub.reserved_order_number_at,
      'reserved_by',           v_sub.reserved_order_number_by
    )
  );

  return null;
end;
$$;

revoke execute on function public.orders_consume_reserved_number()
  from public, anon, authenticated;

drop trigger if exists orders_consume_reserved_number on public.orders;
create trigger orders_consume_reserved_number
  after insert on public.orders
  for each row execute function public.orders_consume_reserved_number();


-- ═══ 8. A PI is not submitted for review with the wrong number on it ═══════
--
-- THE WORKFLOW SAYS THE REVISED PI COMES BEFORE REVIEW:
--
--   initial PI upload → reserved number → revised PI carrying it → submission
--   → review → finance → approval → Confirmed Order
--
-- So the check belongs at submission, not only at approval. A salesperson who
-- forgot the number learns it from the button they just pressed, rather than
-- from a reviewer days later — and a reviewer is never asked to read a PI whose
-- own number is wrong.
--
-- A TRIGGER ON THE TRANSITION rather than a clause in a submit RPC: status is
-- moved by an UPDATE, and there is more than one function that moves it
-- (submit_order_submission, submit_order_submission_with_advance_amount). One
-- trigger binds all of them and anything added later.
--
-- IT FIRES ONLY ON THE MOVE INTO 'submitted', and only where a reservation
-- exists. A legacy draft that never reserved is unaffected, which is what
-- grandfathering means.

create or replace function public.order_submissions_require_revised_pi_on_submit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_refusal text;
begin
  if new.status <> 'submitted' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'submitted' then return new; end if;

  if new.reservation_required and new.reserved_order_number is null then
    raise exception
      'ORDER_SUBMISSION_RESERVATION_REQUIRED: this PI has no reserved Order number. Upload the PI file so a number can be issued, then put it into the revised PI.'
      using errcode = 'P0001';
  end if;

  if new.reserved_order_number is null then return new; end if;

  v_refusal := public.order_submission_revised_pi_refusal(
    new.reserved_order_number,
    new.reserved_number_workbook_sha256,
    new.source_workbook_sha256,
    new.source_order_number);

  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_require_revised_pi_on_submit()
  from public, anon, authenticated;

drop trigger if exists order_submissions_require_revised_pi_on_submit on public.order_submissions;
create trigger order_submissions_require_revised_pi_on_submit
  before insert or update on public.order_submissions
  for each row execute function public.order_submissions_require_revised_pi_on_submit();


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
-- rewritten, and not one PI Draft given a number or an obligation by the act of
-- applying this.

do $$
declare
  v_bad     bigint;
  v_missing text[] := array[]::text[];
  v_fn      text;
  v_def     text;
  v_action  text;
begin
  -- ── 9a. NOT ONE EXISTING DRAFT WAS GIVEN A RESERVATION ──
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

  -- ── 9b. AND NOT ONE WAS GIVEN THE OBLIGATION ──
  --
  -- THE GRANDFATHERING, PROVED. Every row that exists at this moment must read
  -- reservation_required = false; the DEFAULT is true only for rows inserted
  -- afterwards. If this ever fails, an in-flight PI has been made unsubmittable
  -- by a migration, which is precisely the outcome the two-step DDL exists to
  -- prevent.
  select count(*) into v_bad
  from public.order_submissions where reservation_required;

  if v_bad <> 0 then
    raise exception
      'ASSERTION FAILED: % existing PI submission(s) were made subject to the new reservation rule', v_bad;
  end if;

  -- And the default really did change, or every future draft would be
  -- grandfathered too and the feature would be inert.
  select column_default into v_def
  from information_schema.columns
  where table_schema = 'public' and table_name = 'order_submissions'
    and column_name = 'reservation_required';

  if v_def is null or v_def not like 'true%' then
    raise exception
      'ASSERTION FAILED: new PI submissions would not require a reserved Order number (default is %)',
      coalesce(v_def, 'null');
  end if;

  -- ── 9c. Historical Order numbers are untouched ──
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

  -- ── 9d. The guarantees that hold the two sides of the series apart ──
  if not exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'order_submissions_reserved_order_number_uidx'
      and i.indisunique
      and i.indpred is not null
  ) then
    raise exception 'ASSERTION FAILED: the reserved-number index is missing, not unique, or not partial';
  end if;

  -- Every trigger this file installs, and the one it re-emits, enabled.
  foreach v_action in array array[
    'order_submissions_protect_reserved_number',
    'order_submissions_auto_reserve_order_number',
    'order_submissions_log_reservation',
    'order_submissions_require_revised_pi_on_submit',
    'order_number_cycle_respects_reservations',
    'orders_consume_reserved_number',
    'orders_assign_display_number'
  ]
  loop
    if not exists (
      select 1 from pg_trigger t where t.tgname = v_action and t.tgenabled <> 'D'
    ) then
      raise exception 'ASSERTION FAILED: trigger % is missing or disabled', v_action;
    end if;
  end loop;

  -- ── 9e. THE FOUR FUNCTIONS THIS FILE DOES **NOT** RESTATE ──
  --
  -- The whole point of the trigger-based design is that these keep the bodies
  -- that were applied. Asserted by their own rules still being present in the
  -- catalog's copy of the source, so a future edit that quietly rewrote one
  -- while claiming to be this migration would be caught.
  if position('ORDER_NUMBER_CYCLE_EXHAUSTED' in
              pg_get_functiondef('public.allocate_confirmed_order_number()'::regprocedure)) = 0 then
    raise exception 'ASSERTION FAILED: allocate_confirmed_order_number has lost its exhaustion rule';
  end if;

  if position('ORDER_NUMBER_TOO_LOW' in
              pg_get_functiondef('public.set_next_confirmed_order_number(bigint)'::regprocedure)) = 0 then
    raise exception 'ASSERTION FAILED: set_next_confirmed_order_number has lost its floor rule';
  end if;

  if position('ORDER_NUMBER_RESET_ORDERS_EXIST' in
              pg_get_functiondef('public.reset_confirmed_order_number_cycle(uuid)'::regprocedure)) = 0 then
    raise exception 'ASSERTION FAILED: reset_confirmed_order_number_cycle has lost its empty-register gate';
  end if;

  if position('ORDER_SUBMISSION_ALLOCATION_NOT_MOVED' in
              pg_get_functiondef('public.approve_order_submission(uuid)'::regprocedure)) = 0 then
    raise exception 'ASSERTION FAILED: approve_order_submission has lost its stranded-money refusal';
  end if;

  -- ── 9f. Every function this file installs exists, with the right reach ──
  foreach v_fn in array array[
    'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)',
    'public.reserve_order_number_for_submission(uuid)',
    'public.reserve_order_number_internal(uuid, uuid)',
    'public.order_submissions_log_reservation()',
    'public.normalize_order_number_reference(text)',
    'public.order_submission_revised_pi_refusal(text, text, text, text)',
    'public.assign_order_display_number()',
    'public.orders_consume_reserved_number()',
    'public.order_submissions_auto_reserve_order_number()',
    'public.order_submissions_require_revised_pi_on_submit()',
    'public.order_number_cycle_respects_reservations()',
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

  -- NOT ONE OF THE INTERNALS IS CLIENT-CALLABLE. Granting any of them would let
  -- a browser take a number, spend a reservation or bypass a gate.
  foreach v_fn in array array[
    'public.allocate_confirmed_order_number()',
    'public.assign_order_display_number()',
    'public.reserve_order_number_internal(uuid, uuid)',
    'public.orders_consume_reserved_number()',
    'public.order_submissions_auto_reserve_order_number()',
    'public.order_submissions_log_reservation()',
    'public.order_submissions_require_revised_pi_on_submit()',
    'public.order_number_cycle_respects_reservations()',
    'public.prevent_reserved_order_number_change()'
  ]
  loop
    if has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'ASSERTION FAILED: % is executable by a client role', v_fn;
    end if;
  end loop;

  -- And the two doors ARE reachable by an authenticated caller, which is what
  -- makes them doors. Their own bodies decide who gets through.
  foreach v_fn in array array[
    'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)',
    'public.reserve_order_number_for_submission(uuid)'
  ]
  loop
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'ASSERTION FAILED: % is not executable by authenticated', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'ASSERTION FAILED: % is executable by anon', v_fn;
    end if;
  end loop;

  -- ── 9g. NO STALE OVERLOAD. ──
  --
  -- 20261007000000 found this the hard way: revoking one signature while another
  -- overload of the same name stays granted closes nothing. Every name this file
  -- introduces must have exactly ONE signature in the catalog.
  for v_fn in
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('record_payment_with_allocations', 'reserve_order_number_for_submission',
                        'reserve_order_number_internal', 'normalize_order_number_reference',
                        'order_submission_revised_pi_refusal')
    group by p.proname having count(*) > 1
  loop
    raise exception 'ASSERTION FAILED: % has more than one overload; a revoke on one leaves the other open', v_fn;
  end loop;

  -- ── 9h. The action set admits everything any installed function logs ──
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
    'order_number_reserved', 'order_number_revised_pi_verified', 'order_number_used'
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

  -- ── 9i. THE REVISED-PI RULE IS READ FROM THE ONE PARSED COLUMN ──
  --
  -- source_order_number must still be written by exactly one function, and that
  -- function must still be unreachable from a browser. If either ever stops
  -- being true, the comparison in §3 stops being a fact about the workbook and
  -- becomes a fact about whatever the client last sent.
  select count(*) into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    -- prokind 'f' is a plain function. pg_get_functiondef() raises on an
    -- aggregate or a window function, so the filter is a correctness
    -- requirement rather than a narrowing.
    and p.prokind = 'f'
    and p.proname <> 'replace_order_submission_parse'
    and pg_get_functiondef(p.oid) ~* 'set[^;]*source_order_number\s*=';

  if v_bad <> 0 then
    raise exception
      'ASSERTION FAILED: % function(s) other than replace_order_submission_parse write source_order_number', v_bad;
  end if;

  if has_function_privilege('authenticated',
       'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon',
       'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute') then
    raise exception
      'ASSERTION FAILED: replace_order_submission_parse is client-callable, so a browser could state what the workbook says';
  end if;

  -- ── 9j. THE RETIREMENT IS NOT REOPENED ──
  --
  -- 20261007000000's guards must all still be installed and enabled. This file
  -- adds a payment-entry door, and a payment-entry door is exactly the kind of
  -- thing that could quietly reopen a retired workflow — so the guards are
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

  raise notice '20261009000000 applied: split payment entry, and a PI that carries its Order number.';
end $$;
