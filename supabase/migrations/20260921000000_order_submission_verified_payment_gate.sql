-- Order Management, Phase 3 — the verified-payment gate on final approval, the
-- reduced-payment exception, and the PI-to-Order payment continuity.
--
-- WHAT CHANGES, IN ONE SENTENCE
-- -----------------------------
-- An Order number is assigned only when at least 40% of the PI's grand total has
-- ACTUALLY BEEN RECEIVED AND VERIFIED BY FINANCE, or when an authorised approver
-- has accepted proceeding on less — and when the Order is created, the money
-- already allocated to the PI MOVES onto it rather than being copied.
--
-- WHAT THE RULE USED TO BE, AND WHY IT IS WRONG
-- ---------------------------------------------
-- 20260913000000 gave the employee a DECLARATION — "this order carries a 40%
-- advance" — and 20260915000000 §7 gated final approval on it through
-- order_submission_advance_ready(). That declaration is a COMMERCIAL CONDITION.
-- Every one of those migrations says so, at length, in as many words: "THIS
-- RECORDS A COMMERCIAL CONDITION. IT IS NOT A PAYMENT."
--
-- The business rule was always about money that arrived. Until Phase 1
-- (20260918000000) and Phase 2 (20260919000000) there was no way to know whether
-- it had, so the declaration stood in for the fact. It no longer has to:
-- finance_payment_allocations plus finance_payment_status_is_verified() answer
-- the real question exactly. So the declaration stops deciding, and the money
-- starts.
--
--   BEFORE   approve_order_submission() → order_submission_advance_ready(
--                                           advance_condition,
--                                           advance_exception_percent,
--                                           advance_exception_status)
--
--   AFTER    approve_order_submission() → order_submission_payment_ready(
--                                           grand_total,
--                                           VERIFIED PAYMENT SUMMED LIVE
--                                             FROM finance_payment_allocations
--                                             UNDER ROW LOCKS,
--                                           advance_exception_status)
--
-- WHAT IS DELIBERATELY NOT BUILT HERE
-- -----------------------------------
--   * NO SECOND EXCEPTION SYSTEM. 20260913000000's exception columns, its guard
--     trigger, its two decision RPCs and its orders.approve_advance_exception
--     permission are ADAPTED, not duplicated. What the exception MEANS changes
--     — it is now "proceed with less than 40% VERIFIED PAYMENT" rather than
--     "proceed on a lower declared advance" — and the mechanism, the authority
--     and the audit trail are the ones already deployed and already tested.
--   * NO COLUMN IS DROPPED. advance_declared_amount, advance_exception_percent
--     and every historical record stay exactly where they are and stay readable.
--     What changes is that NOTHING GATES ON THEM ANY MORE.
--   * NO PAYMENT IS CREATED, COPIED, VERIFIED OR RECONCILED. Approving an
--     exception does not turn unverified money into verified money, and creating
--     an Order does not create a payment row. The allocation MOVES; the payment,
--     its proof, its verification and its Finance history are untouched.
--   * NO NUMBERING CHANGE. The Order number still comes only from
--     orders_assign_display_number (20260703000000 §7). A PI held for
--     insufficient payment or a pending exception is assigned no number at all,
--     and a failed approval consumes none — because the whole transaction rolls
--     back, cycle advancement included.
--   * NO CANCELLATION, no refund, no debit note, no multi-Order split, no
--     allocation-correction request, no ledger redesign.
--
-- THE FIVE FUNCTIONS THIS RESTATES, AND WHY EACH RESTATEMENT IS SANCTIONED
-- -----------------------------------------------------------------------
--   finance_payment_allocations_guard_transition()
--       20260918000000 §6 says, verbatim: "PHASE 3 WILL HAVE TO RESTATE THIS
--       FUNCTION, on purpose. Turning an approved PI into an Order re-points its
--       allocations from order_submission_id onto order_id, which the
--       target-immutability clause below refuses." This is that restatement, and
--       it opens exactly that one move and nothing else.
--
--   approve_order_submission(uuid)
--       The payment gate and the allocation move both belong inside the one
--       transaction that creates the Order.
--
--   pi_submission_payment_summary(uuid)
--       20260919000000 §6 says needed_for_standard "is REPORTING ONLY and gates
--       nothing — Order approval still reads the declared advance". It gates
--       everything now, so the summary must also report the approval POSITION
--       and the commercial terms.
--
--   order_submission_standard_advance_amount(numeric) is NOT restated, and
--   order_submission_advance_ready(text, numeric, text) is NOT dropped: both
--   remain exactly as applied, still correct about what they describe, and are
--   simply no longer consulted by the approval path.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §1. Payment Terms and Billing Terms
-- ═════════════════════════════════════════════════════════════════════════════
--
-- TWO PLAIN TEXT FIELDS. Not a schedule, not an instalment plan, not a due-date
-- engine, and deliberately not parsed by anything: "30% advance, 30% during
-- production, 40% before dispatch" is a sentence the business agreed, and the
-- moment a column tries to understand it the column starts disagreeing with the
-- agreement.
--
--   payment_terms   how the money will be COLLECTED.
--   billing_terms   how the client will be INVOICED.
--
-- payment_terms is MANDATORY when a PI asks to proceed below the standard 40%,
-- including at zero — that rule lives in the submit RPC in §8, because it is a
-- rule about ONE ACT (submitting under an exception) and not about every row
-- that has ever existed. billing_terms stays optional in this phase.
--
-- NEITHER SAYS ANYTHING ABOUT MONEY RECEIVED. They are what was agreed; the
-- allocations are what arrived.

alter table public.order_submissions
  add column payment_terms text,
  add column billing_terms text;

comment on column public.order_submissions.payment_terms is
  'The agreed COLLECTION arrangement for this PI, as free text — e.g. "30% advance, 30% during production, 40% before dispatch". Mandatory when the PI is submitted asking to proceed below the standard verified-payment requirement, optional otherwise. Never parsed, never scheduled, and never evidence that money was received.';
comment on column public.order_submissions.billing_terms is
  'The agreed INVOICING arrangement for this PI, as free text — e.g. "100% invoice before dispatch". Optional in every case in this phase. Never parsed and never evidence that money was received.';

-- Table constraints, so a direct UPDATE and a service-role write are held to the
-- same shape a browser is. A present-but-blank value is REFUSED rather than
-- stored: "" and NULL would then both mean "nothing agreed" and only one of them
-- would read that way on screen.
alter table public.order_submissions
  add constraint order_submissions_payment_terms_valid check (
    payment_terms is null
    or (btrim(payment_terms) <> '' and char_length(payment_terms) <= 500)
  ),
  add constraint order_submissions_billing_terms_valid check (
    billing_terms is null
    or (btrim(billing_terms) <> '' and char_length(billing_terms) <= 500)
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- §1a. What a reduced-payment approval was actually a decision ABOUT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT THIS CLOSES. An approved exception is a decision to start an Order
-- on less than 40% — taken against a PARTICULAR total, a PARTICULAR document and
-- PARTICULAR collection terms. Nothing recorded what those were, so an approval
-- given for "₹1,20,000 against a ₹3,00,000 PI, collected 50% before dispatch"
-- would still authorise the same PI after its workbook was replaced with a
-- ₹30,00,000 one. The employee resubmits, and the standing approval carries.
--
-- THE SHAPE, TAKEN FROM THE FINANCE CHECK. 20260915000000 §9 solved the same
-- problem for finance verification by recording what the verification was made
-- AGAINST (finance_verified_submission_at) and comparing it at approval. These
-- four columns are that idea for the exception, and the comparison lives in
-- order_submission_exception_current().
--
-- WHY THE WORKBOOK HASH AND NOT A PRODUCT COUNT. Every product line, every
-- image anchor and every commercial figure on a PI comes from one parsed file.
-- replace_order_submission_parse rewrites source_workbook_sha256 whenever that
-- file is replaced, so one column covers "the products changed" and "the figures
-- changed" together, exactly, with nothing to keep in step.
--
-- NULL MEANS "NOT RECORDED", AND THEREFORE NOT CURRENT. A decision taken before
-- this migration carries no basis, and it was a decision about a DECLARED
-- ADVANCE rather than about verified payment — a different question. It stays
-- readable forever, and it authorises nothing until it is taken again. The
-- assertion block at the foot reports how many records that is, rather than
-- guessing on the business's behalf by backfilling one.

alter table public.order_submissions
  add column advance_exception_decided_grand_total    numeric,
  add column advance_exception_decided_workbook_sha256 text,
  add column advance_exception_decided_payment_terms  text,
  add column advance_exception_decided_billing_terms  text;

comment on column public.order_submissions.advance_exception_decided_grand_total is
  'The grand total the reduced-payment exception was APPROVED against. NULL means no basis was recorded — a pre-Phase-3 decision, which is never current. Also the marker for whether a basis exists at all.';
comment on column public.order_submissions.advance_exception_decided_workbook_sha256 is
  'The source workbook hash the reduced-payment exception was APPROVED against. Every product line and every commercial figure comes from that one file, so this covers both together.';
comment on column public.order_submissions.advance_exception_decided_payment_terms is
  'The Payment Terms the reduced-payment exception was APPROVED against. Changing them makes the decision stale: the approver agreed to start early on a stated collection arrangement.';
comment on column public.order_submissions.advance_exception_decided_billing_terms is
  'The Billing Terms the reduced-payment exception was APPROVED against. Recorded for the same reason as the Payment Terms.';

-- A BASIS BELONGS TO AN APPROVAL AND TO NOTHING ELSE. A pending request has not
-- been decided; a rejected one sent the PI back and its basis would describe a
-- record that has since been corrected. So the four columns are permitted only
-- while the exception stands approved, and they are cleared with it — for every
-- caller, including the service role.
--
-- The grand total is the completeness marker rather than all four, because the
-- two terms columns are legitimately NULL when nothing was agreed, and a NULL
-- there must not be indistinguishable from "never stamped".
alter table public.order_submissions
  add constraint order_submissions_exception_basis_scope check (
    advance_exception_status = 'approved'
    or (advance_exception_decided_grand_total     is null
        and advance_exception_decided_workbook_sha256 is null
        and advance_exception_decided_payment_terms  is null
        and advance_exception_decided_billing_terms  is null)
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- §2. The declared advance, renamed in the documentation to what it now is
-- ═════════════════════════════════════════════════════════════════════════════
--
-- NOT A DROP, NOT A RENAME, NOT A BACKFILL, NOT A DELETE. Every value stays.
-- What changes is the COMMENT, which is the schema's own statement of what a
-- column is for — and from this migration onward the declared advance is for
-- reading history and for nothing else.
--
--   LEGACY, gates nothing
--     advance_declared_amount     what an employee once typed as the advance
--     advance_exception_percent   re-purposed: see below
--
--   STILL OPERATIONAL
--     advance_condition                    'standard' | 'exception' — now read as
--                                          "standard verified-payment route" and
--                                          "reduced-payment exception route"
--     advance_exception_status             pending | approved | rejected
--     advance_exception_reason             why proceeding below 40% is asked for
--     advance_exception_requested_by/_at   who asked, and when
--     advance_exception_decided_by/_at     who decided, and when
--     advance_exception_rejection_reason   why it was refused
--
-- advance_exception_percent keeps its column, its constraints and its history,
-- and the new submit path keeps writing it — but it now records THE VERIFIED
-- PAYMENT PERCENTAGE AT THE MOMENT THE EXCEPTION WAS REQUESTED. That is a
-- snapshot for the record and for the reviewer's context. It is never the gate:
-- the gate re-reads the allocations at the instant of approval, because payment
-- moves and a stored percentage does not.

comment on column public.order_submissions.advance_declared_amount is
  'LEGACY (Phase 3). The advance AMOUNT an employee declared under the pre-Phase-3 submission flow, in rupees. Retained in full for historical records and never dropped, but it GATES NOTHING: final approval reads verified payment from finance_payment_allocations, and new submissions do not ask for this figure at all. Never was, and still is not, evidence that money was received.';

comment on column public.order_submissions.advance_exception_percent is
  'Under Phase 3 this records the VERIFIED PAYMENT PERCENTAGE of the grand total at the moment a reduced-payment exception was requested — a snapshot for the reviewer and the trail, at least 0 and strictly below the standard 40. On pre-Phase-3 records it is the advance percentage the employee proposed. It gates nothing in either case: approval re-derives the live figure from the allocations under a row lock.';

comment on column public.order_submissions.advance_condition is
  'The route this submission was sent under: ''standard'' (verified payment already meets the 40% requirement) or ''exception'' (a request to proceed below it, zero included, carrying or awaiting a decision). NULL means the PI was submitted before this workflow existed, which is never approvable. On pre-Phase-3 records the same two values described a DECLARED advance instead.';

comment on column public.order_submissions.advance_exception_reason is
  'Why the salesperson is asking to confirm an Order below the standard verified-payment requirement. Mandatory on the exception route — zero payment included — and shown to the approver and on the PI. Free text, never parsed.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §3. What "verified payment allocated to this PI" is, computed once
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFINITION, AND NOTHING MAY RESTATE IT ELSEWHERE:
--
--   an ACTIVE allocation (status = 'active' — a reversed one is history)
--   naming THIS submission (order_submission_id = the PI)
--   whose PARENT payment is VERIFIED by finance_payment_status_is_verified()
--     — i.e. approved_unlinked or approved_linked, and nothing else.
--
-- So pending_approval does not count. needs_clarification does not count.
-- rejected does not count. A reversed allocation does not count. And no amount
-- of exception approval turns any of them into money: an approved exception
-- lets the business proceed WITHOUT the payment, it does not pretend the payment
-- exists.
--
-- `numeric` throughout. A percentage of a grand total decides whether an Order
-- comes into existence, and an eligibility figure must never pass through binary
-- floating point.
--
-- EXECUTABLE BY NO ROLE. These are the arithmetic behind a decision, not a
-- reporting route: a caller who wants to READ a PI's payment position calls
-- pi_submission_payment_summary(), which checks that they may open the PI first.
-- Reached only as the definer of the functions in §6 and §8.

create or replace function public.order_submission_verified_payment(p_submission_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(a.allocated_amount), 0)::numeric
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id
    and a.status = 'active'
    and public.finance_payment_status_is_verified(f.status)
$$;

comment on function public.order_submission_verified_payment(uuid) is
  'Rupees of FINANCE-VERIFIED money currently allocated to one PI submission: active allocations whose parent payment is approved_unlinked or approved_linked. Pending, needs-clarification, rejected and reversed all count as zero. The single definition the approval gate uses. Executable by no role — read a PI''s position through pi_submission_payment_summary().';

revoke execute on function public.order_submission_verified_payment(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.order_submission_unverified_payment(p_submission_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(a.allocated_amount), 0)::numeric
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id
    and a.status = 'active'
    and f.status in ('pending_approval', 'needs_clarification')
$$;

comment on function public.order_submission_unverified_payment(uuid) is
  'Rupees currently allocated to one PI submission whose parent payment is REPORTED but not yet decided by Finance (pending_approval or needs_clarification). Reported so a refusal can say "payment is awaiting Finance verification" instead of only "not enough". Counts toward NOTHING. Executable by no role.';

revoke execute on function public.order_submission_unverified_payment(uuid)
  from public, anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- §4. The requirement, the shortfall, and the gate
-- ═════════════════════════════════════════════════════════════════════════════
--
-- IMMUTABLE and taking their inputs as ARGUMENTS, never as an id — the same
-- distinction 20260913000000 drew between order_submission_advance_ready(text,
-- numeric, text) and order_submission_is_advance_ready(uuid), for the same
-- reason: a definer function holding a LOCKED row must be able to ask about the
-- row it is holding, not re-ask on behalf of whoever happens to be signed in.

-- The exact requirement, to full numeric precision and NOT to a rounded
-- percentage.
--
-- `p_grand_total * 40 / 100` is written the way
-- order_submissions_advance_amount_matches_condition (20260917000000 §2) writes
-- it, and for the reason recorded there: numeric is exact, so this is the true
-- 40% of the total, and a figure one paisa below it does not meet the
-- requirement however it rounds for display. The assertions at the foot prove it
-- agrees with order_submission_standard_advance_percent().
create or replace function public.order_submission_required_payment(p_grand_total numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p_grand_total is null then null
    when p_grand_total = 'NaN'::numeric then null
    else p_grand_total * public.order_submission_standard_advance_percent() / 100
  end
$$;

comment on function public.order_submission_required_payment(numeric) is
  'The exact rupee figure that satisfies the standard requirement for a grand total: 40% of it, to full numeric precision and never a rounded percentage. NULL — never a guess — for an absent or NaN total.';

revoke execute on function public.order_submission_required_payment(numeric) from public, anon;
grant  execute on function public.order_submission_required_payment(numeric) to authenticated;

-- How much MORE verified payment is needed, as a figure somebody can actually
-- pay.
--
-- CEILING TO PAISE, NOT ROUNDING, and the difference is the whole point. 40% of
-- ₹100.01 is ₹40.004. Rounding the shortfall to two places would print ₹0.00
-- still required against ₹40.00 received — a figure that says "you are there"
-- while the gate says "you are not". The ceiling prints ₹0.01, which is the
-- smallest real payment that actually closes it. The same reasoning
-- 20260917000000 §4 records for order_submission_standard_advance_amount().
create or replace function public.order_submission_payment_shortfall(
  p_grand_total numeric,
  p_verified    numeric
)
returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p_grand_total is null or p_grand_total = 'NaN'::numeric then null
    when p_verified is null or p_verified = 'NaN'::numeric then null
    else round(greatest(
      ceil((public.order_submission_required_payment(p_grand_total) - p_verified) * 100) / 100,
      0), 2)
  end
$$;

comment on function public.order_submission_payment_shortfall(numeric, numeric) is
  'How much MORE verified payment a PI needs to satisfy the standard requirement, rounded UP to whole paise so the figure shown is always one that actually closes the gate. Zero once the requirement is met. NULL for an absent or NaN input.';

revoke execute on function public.order_submission_payment_shortfall(numeric, numeric) from public, anon;
grant  execute on function public.order_submission_payment_shortfall(numeric, numeric) to authenticated;

-- THE GATE ITSELF, IN ONE PLACE:
--
--   payment-ready  ⇔  verified >= 40% of grand total          the standard route
--                     OR the reduced-payment exception is APPROVED
--
-- Everything else is NOT ready: a pending exception, a rejected exception, no
-- exception at all, an unknown total, a NaN.
--
-- THE STANDARD ROUTE DOES NOT CARE WHAT THE EXCEPTION SAYS, deliberately. A PI
-- that asked to proceed on ₹0 and then collected 45% while the request sat in a
-- queue is a PI that meets the standard requirement, and making it wait for a
-- decision nobody now needs would be the database enforcing its own paperwork.
-- The exception simply stops mattering.
--
-- THE EXCEPTION ROUTE DOES NOT CARE HOW MUCH WAS PAID, equally deliberately. An
-- approved exception is the business saying "start this order on what we have",
-- whatever that turns out to be — including nothing.
--
-- IT AUTHORISES NOTHING. It answers a question. approve_order_submission() still
-- checks the actor, the permission, the status, finance verification, the parse,
-- the workbook and every image before and after consulting it.
create or replace function public.order_submission_payment_ready(
  p_grand_total              numeric,
  p_verified_payment         numeric,
  p_advance_exception_status text
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(
    -- An APPROVED exception is sufficient on its own, at any level of payment
    -- including none.
    p_advance_exception_status = 'approved'
    or (
      p_grand_total      is not null and p_grand_total      <> 'NaN'::numeric
      and p_verified_payment is not null and p_verified_payment <> 'NaN'::numeric
      and p_verified_payment >= public.order_submission_required_payment(p_grand_total)
    ),
    false
  )
$$;

comment on function public.order_submission_payment_ready(numeric, numeric, text) is
  'True only when FINANCE-VERIFIED payment allocated to a PI is at least the exact 40% of its grand total, or when a reduced-payment exception has been APPROVED. Pending and rejected exceptions, an unknown total and a NaN are all false. Compares exact numeric amounts, never a rounded displayed percentage. Authorises nothing by itself.';

revoke execute on function public.order_submission_payment_ready(numeric, numeric, text) from public, anon;
grant  execute on function public.order_submission_payment_ready(numeric, numeric, text) to authenticated;

-- ── Whether an APPROVED exception still describes the record in front of us ──
--
-- An approved exception permits an Order below 40%. It must therefore be an
-- approval OF THIS PI — this total, this document, these collection terms — and
-- not of an earlier one that has since been replaced.
--
-- FOUR COMPARISONS, AND WHY EACH ONE:
--
--   the grand total   the decision was "start on less than 40% of THAT". A
--                     different total is a different amount of money at risk.
--   the workbook hash every product line and every commercial figure comes from
--                     that one parsed file. If it changed, the order changed.
--   payment terms     the approver agreed to start early on a stated collection
--                     arrangement. Rewriting it rewrites what they agreed to.
--   billing terms     the same, for invoicing.
--
-- The REASON is not compared here because it cannot drift: the guard trigger
-- refuses to change it while the exception stands approved, so the words the
-- approver read are the words on the record.
--
-- `is not distinct from` on the two terms, because NULL is a legitimate value
-- there — nothing agreed — and `null = null` is not true.
--
-- IMMUTABLE and taking its inputs as ARGUMENTS: a definer function holding the
-- LOCKED row must be able to ask about the row it is holding.
create or replace function public.order_submission_exception_current(
  p_status                   text,
  p_decided_grand_total      numeric,
  p_grand_total              numeric,
  p_decided_workbook_sha256  text,
  p_workbook_sha256          text,
  p_decided_payment_terms    text,
  p_payment_terms            text,
  p_decided_billing_terms    text,
  p_billing_terms            text
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(
    p_status = 'approved'
    -- NO RECORDED BASIS IS NOT CURRENT. A pre-Phase-3 decision was taken about a
    -- DECLARED ADVANCE, which is a different question from verified payment, and
    -- it authorises nothing until it is taken again.
    and p_decided_grand_total is not null
    and p_decided_grand_total = p_grand_total
    and p_decided_workbook_sha256 is not distinct from p_workbook_sha256
    and p_decided_payment_terms   is not distinct from p_payment_terms
    and p_decided_billing_terms   is not distinct from p_billing_terms,
    false
  )
$$;

comment on function public.order_submission_exception_current(text, numeric, numeric, text, text, text, text, text, text) is
  'True only when a reduced-payment exception is APPROVED and was approved against this PI''s current grand total, workbook, Payment Terms and Billing Terms. A decision with no recorded basis — every pre-Phase-3 one — is never current, because it was a decision about a declared advance rather than about verified payment. Authorises nothing by itself.';

revoke execute on function public.order_submission_exception_current(text, numeric, numeric, text, text, text, text, text, text) from public, anon;
grant  execute on function public.order_submission_exception_current(text, numeric, numeric, text, text, text, text, text, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §4a. The exception guard, restated: what may move once a decision stands
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20260913000000 §5's function, unchanged in every clause it already had, with
-- TWO added:
--
--   1. THE REASON IS FROZEN WHILE THE APPROVAL STANDS. The approver decided
--      about the words on the record. Rewriting them under a standing approval
--      would leave the PI claiming management accepted an argument nobody put to
--      them. Changing the ask means asking again — which the submit door already
--      does, because a changed reason raises a fresh PENDING request.
--   2. THE RECORDED BASIS MOVES ONLY WITH A DECISION. The four
--      advance_exception_decided_* columns say what was approved; a write that
--      touched them while the decision itself stood still would be forging
--      currentness. They may change only in the same statement that changes the
--      exception's status — which is to say, only by deciding, clearing or
--      re-raising it.
--
-- SECURITY DEFINER and executable by no role, exactly as before: reached only as
-- a trigger, with no exemption for admin, the service role or direct SQL.

create or replace function public.order_submissions_guard_advance_exception()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- A submission is created as an empty draft. It has declared nothing, and
    -- stating that here stops a row being INSERTed with an approved exception
    -- already on it by anything holding an INSERT privilege.
    if new.advance_condition is not null or new.advance_exception_status is not null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: a submission is created with no advance declaration'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- The declaration itself is the employee's, made at submission time only.
  if new.advance_condition is distinct from old.advance_condition
     and not (new.status = 'submitted' and old.status in ('draft', 'needs_changes')) then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_INVALID: the advance condition of % is set only by submitting it', old.id
      using errcode = '42501';
  end if;

  -- ── NEW: the words under a standing approval do not move ──
  if old.advance_exception_status = 'approved'
     and new.advance_exception_status is not distinct from old.advance_exception_status
     and new.advance_exception_reason is distinct from old.advance_exception_reason
  then
    raise exception
      'ORDER_SUBMISSION_EXCEPTION_REASON_FROZEN: the reason an approved reduced-payment exception was granted for cannot be rewritten. Resubmit to ask again.'
      using errcode = '42501';
  end if;

  -- ── NEW: the recorded basis moves only with the decision it describes ──
  if new.advance_exception_status is not distinct from old.advance_exception_status
     and (new.advance_exception_decided_grand_total     is distinct from old.advance_exception_decided_grand_total
       or new.advance_exception_decided_workbook_sha256 is distinct from old.advance_exception_decided_workbook_sha256
       or new.advance_exception_decided_payment_terms   is distinct from old.advance_exception_decided_payment_terms
       or new.advance_exception_decided_billing_terms   is distinct from old.advance_exception_decided_billing_terms)
  then
    raise exception
      'ORDER_SUBMISSION_EXCEPTION_BASIS_IMMUTABLE: what a reduced-payment exception was approved against is written by the decision and by nothing else.'
      using errcode = '42501';
  end if;

  if new.advance_exception_status is not distinct from old.advance_exception_status then
    return new;
  end if;

  if new.advance_exception_status = 'pending' then
    if new.status <> 'submitted' or old.status not in ('draft', 'needs_changes') then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: an advance exception is requested only by submitting the PI'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.advance_exception_status in ('approved', 'rejected') then
    -- A stale decision, a double click and a decision on a record that has
    -- already moved on all land here and all fail.
    if old.advance_exception_status is distinct from 'pending' or old.status <> 'submitted' then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_PENDING: only a pending advance exception on a submitted PI can be decided'
        using errcode = '42501';
    end if;

    -- Approving the advance condition is NOT approving the PI. The record stays
    -- exactly where it was.
    if new.advance_exception_status = 'approved' and new.status <> 'submitted' then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: approving an advance exception must leave the PI submitted'
        using errcode = '42501';
    end if;

    -- Refusing the proposed advance is not refusing the PI. It goes back for
    -- correction, in the same statement as the decision or not at all.
    if new.advance_exception_status = 'rejected' and new.status <> 'needs_changes' then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: rejecting an advance exception must return the PI for correction'
        using errcode = '42501';
    end if;

    return new;
  end if;

  -- Cleared. That is what choosing the standard requirement on a resubmission
  -- does, and it is the only thing that may do it: the historical events stay in
  -- the append-only trail, and only the ACTIONABLE state leaves the row.
  if new.advance_exception_status is null then
    if new.advance_condition is distinct from 'standard' or new.status <> 'submitted' then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: an advance exception is cleared only by resubmitting under the standard requirement'
        using errcode = '42501';
    end if;
    return new;
  end if;

  return new;
end;
$$;

comment on function public.order_submissions_guard_advance_exception() is
  'When the advance/reduced-payment exception state may move, for every caller including the service role: the declaration is written only by submitting, a request becomes pending only as the PI is submitted, only a pending request on a submitted PI can be decided, approval leaves the PI submitted, rejection returns it for correction, the exception clears only by resubmitting under the standard requirement, the REASON is frozen while an approval stands, and the recorded decision basis moves only with the decision itself.';

revoke execute on function public.order_submissions_guard_advance_exception()
  from public, anon, authenticated, service_role;

-- The trigger is NOT recreated: 20260913000000 §5 installed
-- order_submissions_guard_advance_exception with this function, and the name
-- order matters (it sorts after the status-transition guard, so an illegal
-- status move is refused before this runs). CREATE OR REPLACE FUNCTION keeps
-- that wiring exactly as applied.

-- ═════════════════════════════════════════════════════════════════════════════
-- §4b. The two decisions, restated to record what they decided ABOUT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20260913000000 §9a and §9b, unchanged in authority, in status handling, in
-- error text and in what they log. The ONLY difference is that an approval now
-- stamps the four basis columns, and a rejection clears them — because a refused
-- exception describes a record that is about to be corrected.
--
-- THE AUTHORITY IS NOT TOUCHED. Both still require orders.approve_advance_exception,
-- which no preset grants and which an active admin holds through the established
-- bypass in actor_has_module_permission. Neither reads or writes the payment
-- ledger, and the assertion block at the foot proves it.

create or replace function public.approve_pi_advance_exception(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_sub   public.order_submissions%rowtype;
begin
  -- NOT orders.approve_order. Holding that alone is deliberately not enough.
  if not public.actor_has_module_permission('orders', 'approve_advance_exception') then
    raise exception 'You do not have permission to decide advance exceptions'
      using errcode = '42501';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can have its advance exception decided (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.advance_condition is distinct from 'exception'
     or v_sub.advance_exception_status is distinct from 'pending' then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_NOT_PENDING: this PI has no advance exception waiting for a decision'
      using errcode = 'P0001';
  end if;

  -- THE PI STAYS SUBMITTED. Accepting the reduced-payment condition is not
  -- accepting the PI: it makes the condition eligible for final approval and does
  -- nothing else. It records no payment and verifies none.
  --
  -- THE BASIS IS STAMPED FROM THE LOCKED ROW, never from anything a caller sent:
  -- this decision is about THIS total, THIS document and THESE terms, and
  -- order_submission_exception_current() will refuse it the moment any of them
  -- moves.
  update public.order_submissions
     set advance_exception_status = 'approved',
         advance_exception_decided_by = v_actor,
         advance_exception_decided_at = now(),
         advance_exception_rejection_reason = null,
         advance_exception_decided_grand_total     = v_sub.grand_total,
         advance_exception_decided_workbook_sha256 = v_sub.source_workbook_sha256,
         advance_exception_decided_payment_terms   = v_sub.payment_terms,
         advance_exception_decided_billing_terms   = v_sub.billing_terms
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'advance_exception_approved', 'submitted', 'submitted', null,
    jsonb_build_object(
      'advance_condition', 'exception',
      'advance_percent',   v_sub.advance_exception_percent,
      'standard_percent',  public.order_submission_standard_advance_percent(),
      'grand_total',       v_sub.grand_total,
      'advance_amount',    public.order_submission_advance_amount(
                             v_sub.grand_total, v_sub.advance_exception_percent),
      'exception_status',  'approved',
      'payment_terms',     v_sub.payment_terms,
      'billing_terms',     v_sub.billing_terms,
      'workbook_sha256',   v_sub.source_workbook_sha256
    )
  );

  return jsonb_build_object(
    'id', p_submission_id,
    'status', 'submitted',
    'advance_exception_status', 'approved'
  );
end;
$$;

revoke execute on function public.approve_pi_advance_exception(uuid) from public, anon;
grant  execute on function public.approve_pi_advance_exception(uuid) to authenticated;

comment on function public.approve_pi_advance_exception(uuid) is
  'Accepts a pending reduced-payment exception on a submitted PI, for a caller holding orders.approve_advance_exception, and records the grand total, workbook, Payment Terms and Billing Terms it was decided against. The PI stays submitted: this approves the commercial condition only, never the PI, and creates and verifies no payment. The approval stops being current the moment any of that basis changes.';

create or replace function public.reject_pi_advance_exception(
  p_submission_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_sub    public.order_submissions%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.actor_has_module_permission('orders', 'approve_advance_exception') then
    raise exception 'You do not have permission to decide advance exceptions'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_DECISION_REASON_REQUIRED: say why the proposed advance is being refused'
      using errcode = 'P0001';
  end if;

  if char_length(v_reason) > 1000 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can have its advance exception decided (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.advance_condition is distinct from 'exception'
     or v_sub.advance_exception_status is distinct from 'pending' then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_NOT_PENDING: this PI has no advance exception waiting for a decision'
      using errcode = 'P0001';
  end if;

  -- ONE STATEMENT: the refusal, the reason and the PI's return happen together
  -- or not at all. The basis columns are cleared with it — a refused exception
  -- describes a record that is about to be corrected, so there is nothing left
  -- for it to have been a decision about.
  update public.order_submissions
     set advance_exception_status = 'rejected',
         advance_exception_decided_by = v_actor,
         advance_exception_decided_at = now(),
         advance_exception_rejection_reason = v_reason,
         advance_exception_decided_grand_total     = null,
         advance_exception_decided_workbook_sha256 = null,
         advance_exception_decided_payment_terms   = null,
         advance_exception_decided_billing_terms   = null,
         status = 'needs_changes',
         review_note = v_reason
   where id = p_submission_id;

  -- ONE EVENT FOR ONE ACTION. No 'changes_requested' row is written beside this:
  -- the previous and new status on this row already say the PI was returned, and
  -- two entries would read as two separate management decisions.
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'advance_exception_rejected', 'submitted', 'needs_changes', v_reason,
    jsonb_build_object(
      'advance_condition', 'exception',
      'advance_percent',   v_sub.advance_exception_percent,
      'standard_percent',  public.order_submission_standard_advance_percent(),
      'grand_total',       v_sub.grand_total,
      'advance_amount',    public.order_submission_advance_amount(
                             v_sub.grand_total, v_sub.advance_exception_percent),
      'exception_status',  'rejected',
      'pi_returned',       true
    )
  );

  return jsonb_build_object(
    'id', p_submission_id,
    'status', 'needs_changes',
    'advance_exception_status', 'rejected'
  );
end;
$$;

revoke execute on function public.reject_pi_advance_exception(uuid, text) from public, anon;
grant  execute on function public.reject_pi_advance_exception(uuid, text) to authenticated;

comment on function public.reject_pi_advance_exception(uuid, text) is
  'Refuses a pending reduced-payment exception on a submitted PI and returns the PI for correction, in one atomic write, for a caller holding orders.approve_advance_exception. The reason is mandatory and becomes the visible correction instruction; any recorded decision basis is cleared with it. The PI itself is not rejected.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §4c. One lock order, and the race it closes
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. approve_order_submission() holds the PI submission FOR UPDATE from
-- its first statement, and every other writer that touches a PI's money takes
-- that lock too — record_pi_submission_payment() (20260919000000 §2) locks the
-- submission before it creates anything. One did not:
-- allocate_payment_to_target_internal() locks the PAYMENT first and then reads
-- the submission WITHOUT a lock, purely to check that it is eligible.
--
-- So a Finance allocator naming this PI could read `status = 'submitted'`, be
-- descheduled, and INSERT its allocation after the approval had committed. The
-- allocation lands ACTIVE, pointing at a PI that is now an Order — money the
-- Order will never see, on a record that no longer counts it. The approval
-- cannot notice: in READ COMMITTED the other transaction's row is not yet
-- visible when step 14a runs its UPDATE.
--
-- THE FIX IS THE LOCK ORDER, NOT A RE-CHECK. A re-check after the move would
-- read the same invisible row. What closes it is taking the submission's lock
-- before the payment's, so the allocator either wins the race and the approval
-- waits for it, or loses and re-reads a PI that says 'approved' and is refused
-- by the eligibility check that was already there.
--
-- THE PROJECT-WIDE ORDER, now true on every path that touches these tables:
--
--   orders → order_requests → order_submissions → finance_payment_requests
--          → finance_payment_allocations → order_number_cycle
--
-- with multi-row sets locked in ascending id. It is the order
-- finalize_test_data_cleanup() (20260916000000) already walks, and the order
-- reverse_payment_allocation() (20260918000000 §12) documents for itself.
--
-- WHAT THIS RESTATEMENT CHANGES, EXACTLY. The target-resolution block moves
-- ahead of the payment lock and takes `for update` on a PI-submission target.
-- Every check, every message, every errcode and the returned shape are
-- unchanged. One consequence is visible and is stated rather than hidden: a call
-- naming BOTH an unreadable target and a missing payment now reports the target
-- first. Neither refusal tells a caller anything the other did not.
--
-- The Confirmed-Order branch keeps its unlocked read: an Order does not change
-- into something else, nothing in this phase re-points an Order's allocations,
-- and locking `orders` after the payment would be the inversion this section
-- exists to remove.

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

  v_finance_all := public.actor_has_module_permission('finance', 'view_all');

  -- ── 3. THE TARGET, AND ITS LOCK — before the payment's, always ──
  --
  -- A PI SUBMISSION IS LOCKED. It is the record whose eligibility is being
  -- judged, and holding it is what makes that judgement still true at COMMIT:
  -- an approval in flight either has this lock and this call waits for it, or
  -- waits for this call and then sees the allocation it created.
  if p_order_submission_id is not null then
    select * into v_sub
    from public.order_submissions
    where id = p_order_submission_id
    for update;

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
    -- applies to a converted Order Request. Judged under the lock above, so an
    -- approval committing in the same instant is seen rather than raced.
    if v_sub.status = 'approved' or v_sub.order_id is not null then
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

  -- ── 4. THE PAYMENT LOCK. Taken after the target's and before the payment's
  --      state is judged, and held for the rest of the transaction, so the
  --      balance computed below is the balance that will still be true at
  --      COMMIT. Same lock the capacity trigger takes.
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
  'The single implementation of allocating part or all of one payment to one target. Locks the TARGET first and the payment second — the project-wide order — so an allocation to a PI cannot race that PI''s approval. Authorization belongs to its two doors; this decides eligibility, capacity and provenance. Executable by no client role.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §5. The one move an allocation may now make
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE RESTATEMENT 20260918000000 §6 ASKED FOR, AND ONLY THAT.
--
-- That file wrote, of this exact function: "PHASE 3 WILL HAVE TO RESTATE THIS
-- FUNCTION, on purpose. Turning an approved PI into an Order re-points its
-- allocations from order_submission_id onto order_id, which the
-- target-immutability clause below refuses. That restatement is a visible,
-- reviewed change to one named function in its own migration."
--
-- This is it. Everything that was immutable stays immutable, with ONE opening,
-- and the opening is defined so narrowly that it can only ever describe the
-- conversion:
--
--   * the transaction must be inside approve_order_submission(), for THIS
--     submission — in_pi_submission_approval(old.order_submission_id), the
--     marker 20260915000000 §3 created for exactly this kind of question;
--   * the allocation must currently be ACTIVE and must currently name that
--     submission;
--   * it must be moving to an ORDER and to no submission;
--   * that Order must be the one created FROM this submission
--     (orders.source_order_submission_id), which is written in the same INSERT
--     that creates the Order and is immutable thereafter
--     (orders_protect_source_submission, 20260915000000 §2);
--   * and its payment, its amount, its provenance, its identity, its creation
--     record and its status must all be unchanged.
--
-- WHAT STILL CANNOT HAPPEN, inside the approval or anywhere else:
--   * money cannot move to a different Order — source_order_submission_id ties
--     the destination to this PI;
--   * an amount cannot be edited on the way across;
--   * origin_target_type cannot be rewritten, so a PI-origin allocation stays
--     PI-origin forever and the provenance survives the move — which is
--     precisely why 20260918000000 §1 refused to constrain that direction;
--   * a REVERSED allocation cannot be moved, resurrected or re-pointed;
--   * an allocation cannot move BACK to a submission;
--   * and a reversal, once recorded, still cannot be rewritten.
--
-- NOT SECURITY DEFINER, and no exemption for anybody — not admin, not the
-- service role, not the cleanup context — exactly as before. The marker is not
-- an authorization: it is set transaction-locally by a function that has already
-- proved the caller may approve this PI, and cleared before that function
-- returns.

create or replace function public.finance_payment_allocations_guard_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_conversion boolean := false;
begin
  -- ── Is this the sanctioned PI-to-Order move? ──
  --
  -- Every clause is required. A statement that satisfies all of them is the
  -- conversion; a statement that satisfies all but one is refused below with the
  -- same message it has always been refused with.
  if old.status = 'active'
     and old.order_submission_id is not null
     and public.in_pi_submission_approval(old.order_submission_id)
     and new.order_submission_id is null
     and new.order_id is not null
     and new.id                 is not distinct from old.id
     and new.payment_request_id is not distinct from old.payment_request_id
     and new.allocated_amount   is not distinct from old.allocated_amount
     and new.origin_target_type is not distinct from old.origin_target_type
     and new.created_by         is not distinct from old.created_by
     and new.created_at         is not distinct from old.created_at
     and new.status             is not distinct from old.status
     and new.reversed_by        is not distinct from old.reversed_by
     and new.reversed_at        is not distinct from old.reversed_at
     and new.reversal_reason    is not distinct from old.reversal_reason
     and exists (
       select 1 from public.orders o
       where o.id = new.order_id
         and o.source_order_submission_id = old.order_submission_id
     )
  then
    v_conversion := true;
  end if;

  if not v_conversion then
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
  end if;

  -- Reversal is terminal, in every direction, conversion or not. Neither the
  -- status nor the reversal record may be rewritten once it is written — and a
  -- reversed allocation is never part of a conversion, because the branch above
  -- requires old.status = 'active'.
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
  'An allocation may only ever go active -> reversed, OR move once from its PI submission onto the Confirmed Order created from that same submission, inside approve_order_submission() and only for the submission being approved. Payment, amount, provenance, identity and creation record stay immutable on every path, a reversal is terminal, and a recorded reversal cannot be rewritten. No exemption for any role, including the service role.';

revoke execute on function public.finance_payment_allocations_guard_transition()
  from public, anon, authenticated, service_role;

-- The trigger itself is NOT recreated: 20260918000000 §6 already installed
-- finance_payment_allocations_check_transition with this function, and the name
-- was chosen so it sorts ahead of ..._derive_reversal and ..._enforce_capacity.
-- CREATE OR REPLACE FUNCTION keeps that wiring; dropping and recreating the
-- trigger would risk losing the ordering the applied file reasoned about.

-- ── The reversal derivation must not fire on a conversion ────────────────────
--
-- finance_payment_allocations_derive_reversal() stamps the reverser and the time
-- when a row BECOMES reversed. A conversion leaves status alone, so it never
-- reaches that branch — asserted at the foot of this file rather than assumed.

-- ═════════════════════════════════════════════════════════════════════════════
-- §6. The trails this phase produces
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THREE TRAILS, EACH ANSWERING A DIFFERENT READER'S QUESTION, and no duplicates:
--
--   the payment's Finance trail   "where did this money go?"     allocation_moved
--   the PI's own trail            "what happened to this PI?"    payment_allocations_moved
--   the Order's trail             "where did this Order's        order_created_from_pi_submission
--                                  money come from?"             (already written, now carrying
--                                                                the moved count)
--
-- WHAT IS NOT LOGGED, and why: a REFUSED approval. approve_order_submission()
-- raises, and a raise rolls the transaction back — an audit row written inside it
-- would vanish with it, and one written outside it would need a second
-- transaction this schema has nowhere to put. The architecture records DECISIONS
-- TAKEN, not decisions attempted, everywhere else on these tables
-- (20260913000000 §6: "ONE EVENT FOR ONE MANAGEMENT ACTION"), and a row per
-- disabled-button click would be noise, not audit. The reviewer sees the reason
-- immediately, on screen, in business language.

-- ── The payment's own trail learns one event ────────────────────────────────
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
    'allocation_reversed',
    -- NEW. The allocation moved from the PI it was recorded against onto the
    -- Confirmed Order that PI became. The money did not change, the payment did
    -- not change, and no new allocation exists — this row says so explicitly so
    -- that a reader who sees the target change is not left to guess whether it
    -- was re-entered.
    'allocation_moved'
  ));

-- The writer, restated to recognise the move.
--
-- SERVER-DERIVED, from the trigger, on the row that actually changed. There is
-- no path by which a client produces this row and no path by which the RPC
-- forgets to: it is written by the same AFTER trigger that has always written
-- allocation_created and allocation_reversed, inside the caller's transaction,
-- so a failure anywhere in the approval takes the trail with it.
--
-- The payload carries BOTH ENDS of the move plus the unchanged provenance, which
-- is the whole point of recording it: "this exact allocation, this exact amount,
-- from that PI to this Order, still originating where it always did."
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
  elsif old.status = 'active' and new.status = 'active'
        and old.order_submission_id is not null
        and new.order_submission_id is null
        and new.order_id is not null then
    -- The PI-to-Order conversion. The transition guard in §5 has already proved
    -- this is that and nothing else, so no clause here re-litigates it.
    v_event := 'allocation_moved';
    v_actor := auth.uid();
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

  if v_event = 'allocation_moved' then
    v_payload := v_payload || jsonb_build_object(
      'moved_from_order_submission_id', old.order_submission_id,
      'moved_to_order_id',              new.order_id,
      'payment_request_id',             new.payment_request_id
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
  'The only writer of allocation_created / allocation_reversed / allocation_moved rows. Records the allocation id, its target type and id, the amount and the provenance into the payment''s existing Finance activity trail, plus the reason on a reversal and both ends of the move on a PI-to-Order conversion. Server-derived; no client can insert an audit row.';

revoke execute on function public.log_finance_payment_allocation_activity()
  from public, anon, authenticated;

-- The trigger is NOT recreated: 20260918000000 §9 installed
-- finance_payment_allocations_log_activity AFTER INSERT OR UPDATE with this
-- function, and CREATE OR REPLACE FUNCTION keeps that wiring intact.

-- ── The PI's own action set, widened by exactly one ─────────────────────────
--
-- The set is CLOSED on purpose, so a phase that produces a new kind of event
-- extends it in its own migration — 20260915000000 §10 names that as the
-- sanctioned extension point, and this is one use of it.
--
--   payment_allocations_moved   the PI's money moved onto its new Order
--
-- AND NOTHING ELSE. The reduced-payment exception reuses the three events
-- 20260913000000 already defined — advance_exception_requested,
-- advance_exception_approved, advance_exception_rejected — because it reuses the
-- exception itself. Inventing payment_exception_requested beside them would
-- produce two vocabularies for one workflow and split every history in half.
--
-- The standard route's success is recorded on the EXISTING 'approved' event, in
-- its payload, for the same reason: it is not a separate thing that happened, it
-- is why the thing that happened was allowed.

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'order_submission_activity'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%action%in%';

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
    'payment_recorded',
    'payment_allocations_moved'
  ));

-- ═════════════════════════════════════════════════════════════════════════════
-- §7. Final approval — restated
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20260915000000's function, with THREE changes and nothing else:
--
--   1. the grand-total check moves UP, from step 9 to step 6a, because the
--      payment gate is a percentage OF it and cannot be asked before it is
--      known. Same check, same code, same message.
--   2. step 7 stops consulting order_submission_advance_ready(...) and starts
--      consulting order_submission_payment_ready(...) over money summed LIVE
--      from the allocations under row locks.
--   3. a new step 14a MOVES the PI's active allocations onto the Order.
--
-- Every other line — the authority, the lock, the already-approved branch, the
-- deletion reservation, the status rule, the finance-verification rule, the
-- blocking-issue count, the client name, the workbook shape/existence/type, the
-- item invariants, the representative-image rule, the image-path rule, the
-- image-existence rule, the INSERT, the status update, both activity rows and
-- the returned shape — is preserved exactly.
--
-- WHY THE FIGURE IS RE-DERIVED HERE AND NEVER PASSED IN. This function still
-- takes exactly one argument and that argument is an id. A verified total that
-- arrived from a browser is a verified total somebody could type, and a verified
-- total captured at submission time is a verified total that may since have been
-- reversed. The only figure that can decide is the one the database sums at the
-- instant of the decision, from rows it holds locks on.
--
-- THE LOCKS, AND THEIR ORDER. The submission first (as before), then the PARENT
-- PAYMENTS in id order, then the ALLOCATIONS in id order. Payments before
-- allocations is not arbitrary: finance_payment_allocations_enforce_capacity()
-- already takes FOR UPDATE on the parent payment when an allocation row is
-- written, so taking them in the same order here means the conversion cannot
-- deadlock against a concurrent allocation. Holding them means a Finance
-- verification, a reversal or a new allocation landing in the same instant is
-- serialized against this decision rather than racing it: whichever commits
-- first, the other re-reads and gets a coherent answer.
--
-- FIVE SITUATIONS THIS HANDLES BY CONSTRUCTION, each named because each was
-- asked for:
--
--   payment reached 40% while an exception request was pending
--       → the standard route succeeds; the exception is simply not consulted.
--   a verified payment was reversed back below 40% after the exception was
--   approved
--       → the approved exception still permits approval. That is what approving
--         it meant.
--   a verified payment was reversed back below 40% and there is NO approved
--   exception
--       → refused. The declared advance cannot rescue it, because nothing reads
--         the declared advance.
--   a pending payment would take the total over 40%
--       → refused, and the refusal SAYS the money is with Finance rather than
--         implying the client has not paid.
--   an exception is approved but the payment is unverified
--       → the Order is created and the payment stays unverified. Approving an
--         exception is not verifying a payment, and this function writes nothing
--         to finance_payment_requests.

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
      'submission_id',    p_submission_id,
      'order_id',         v_sub.order_id,
      'display_number',   v_number,
      'already_approved', true
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
  insert into public.orders (
    client_name, requested_by, confirm_date, total_value, total_product_value,
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    coalesce(v_sub.order_confirmation_date, v_now::date),
    v_sub.grand_total,
    v_sub.gross_product_amount,
    v_actor,
    'running',
    p_submission_id
  )
  returning id, display_number into v_order_id, v_number;

  -- ── 14. The submission becomes approved, and names its Order ──
  update public.order_submissions
     set status      = 'approved',
         approved_by = v_actor,
         approved_at = v_now,
         order_id    = v_order_id
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
    'moved_allocations', v_moved_count
  );
end;
$$;

comment on function public.approve_order_submission(uuid) is
  'Approves a submitted PI and creates exactly one Confirmed Order, in one transaction, for a caller holding orders.approve_order. Re-derives every eligibility rule from the locked row, INCLUDING the payment gate: FINANCE-VERIFIED payment allocated to the PI must be at least the exact 40% of its grand total, or a reduced-payment exception must be approved. Declared advance decides nothing. The PI''s active allocations are MOVED onto the new Order — same rows, same ids, same payments, same provenance — and no payment is created, copied or verified. The Order number comes only from orders_assign_display_number; a failed approval consumes none and leaves no Order, no number and no moved allocation.';

revoke execute on function public.approve_order_submission(uuid) from public, anon;
grant  execute on function public.approve_order_submission(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §7a. Test Data Cleanup follows the money across the move
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE REGRESSION THIS CLOSES, AND IT IS THIS PHASE'S OWN. 20260919000000 §7 had
-- to teach the cleanup chain about payments that reach a record ONLY through an
-- allocation, because a PI payment carries no order_id and its NO ACTION foreign
-- key would otherwise refuse the delete with a raw constraint error rather than
-- a readable refusal. It found them with:
--
--     where a.order_submission_id = v_submission_id
--
-- Phase 3 moves exactly those allocations onto the Order, clearing
-- order_submission_id. The parent payment still carries no order_id — that is
-- the whole point, its proof and its reference stay untouched — so after a
-- conversion a test chain's payments are invisible to BOTH sweeps, and the
-- failure 20260919000000 fixed comes straight back on the other side of the
-- move.
--
-- ONE UNION BRANCH CLOSES IT, and the two are complementary rather than
-- alternatives: the applied branch finds the REVERSED allocations that stay with
-- the PI as its history, and the new one finds the ACTIVE ones that moved onto
-- the Order. Everything downstream — the delete list, the blocking list, the
-- eligibility test, the counts and the proof storage paths — reads v_payments,
-- so all of them pick it up without being restated.
--
-- Nothing else in the function changes: not the root resolution, not the
-- eligibility rules, not the retain/block lists, not one message.

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
      union
      -- ── PHASE 3: the same payments, after their allocation MOVED ──
      --
      -- Approving a PI re-points its ACTIVE allocations from order_submission_id
      -- onto order_id, and deliberately does not touch the parent payment — its
      -- proof, its verification, its Finance history and the reference the
      -- salesperson typed all stay where they are, which means it still carries
      -- no order_id.
      --
      -- So after conversion a chain's payments are invisible to BOTH sweeps
      -- above: the f.order_id one never saw them, and the branch above no longer
      -- does. Without this the NO ACTION foreign key would refuse the Order
      -- delete with a raw constraint error — exactly the failure the Phase 2
      -- branch was added to prevent, reappearing one phase later on the other
      -- side of the move.
      --
      -- The two allocation branches are complementary and both are needed: this
      -- one finds what moved, the one above finds the REVERSED allocations that
      -- stay with the PI as its history.
      select a.payment_request_id
      from public.finance_payment_allocations a
      where a.order_id is not null
        and (a.order_id = v_order_id or a.order_id = v_sub_order_id)
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

revoke execute on function public.resolve_test_data_cleanup_chain(text, uuid) from public, anon;
grant  execute on function public.resolve_test_data_cleanup_chain(text, uuid) to authenticated;

comment on function public.resolve_test_data_cleanup_chain(text, uuid) is
  'Everything one test-data cleanup would delete, retain or be blocked by, from any root. Payments are reached three ways — the legacy order/order-request link, an allocation still naming the chain''s PI, and an allocation that has MOVED onto the Order that PI became — so a converted chain cannot hide money from the sweep. Reads only.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §8. The PI payment card learns the approval position
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20260919000000 §6 wrote of needed_for_standard: "It gates nothing:
-- approve_order_submission() is untouched by this phase and still reads the
-- declared advance." It gates everything now, so the summary stops being a
-- report and starts being the same answer the approval path will give.
--
-- WHAT IS ADDED, AND NOTHING ELSE IS TOUCHED:
--
--   required_payment       the exact 40% figure the gate compares against
--   meets_standard         whether verified payment already satisfies it
--   approval_position      one of six codes; the card's own sentence
--   submission_status      so the card can read the position in context
--   advance_condition      the route the PI was submitted under
--   exception_status       pending | approved | rejected | null
--   exception_reason       why proceeding below 40% was asked for
--   exception_rejection_reason
--   payment_terms          the agreed collection arrangement
--   billing_terms          the agreed invoicing arrangement
--
-- ONE FIGURE CHANGES: needed_for_standard is now the CEILING of the shortfall
-- rather than the rounded one, so the amount the card asks for is always an
-- amount that actually closes the gate. For every figure with two decimal places
-- — which is every real grand total — the two are identical; they differ only in
-- the ₹100.01 case the rounded form got wrong.
--
-- DECLARED ADVANCE IS STILL NOT AMONG THEM, and now cannot be by rule as well as
-- by omission: what a client agreed to pay is not money that arrived, and this
-- card is about money that arrived.
--
-- SECURITY DEFINER, still gated on can_view_order_submission, so a caller who
-- may not open the PI still learns nothing — not a total, not a count, not a
-- position, not an empty list.

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
  v_required  numeric;
  v_meets      boolean;
  v_exc_current boolean;
  v_position  text;
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

  v_total    := v_sub.grand_total;
  v_required := public.order_submission_required_payment(v_total);
  v_meets    := v_required is not null and v_verified >= v_required;

  -- Whether the reduced-payment approval, if there is one, is an approval of the
  -- PI as it stands NOW. One definition, shared with approve_order_submission().
  v_exc_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  -- ── WHERE THIS PI STANDS, in the order a reader resolves it ───────────────
  --
  -- Money first: a PI that meets the requirement is standing on the standard
  -- route whatever it once asked for, which is exactly what approval will
  -- decide. Then the decision that stands in for money. Then, only if neither
  -- applies, what is actually missing — and unverified money is named before a
  -- shortfall, because "Finance has not looked at it yet" and "the client has
  -- not paid" are different problems belonging to different people.
  v_position := case
    when v_meets                                     then 'standard_met'
    when v_exc_current                               then 'exception_approved'
    -- APPROVED, BUT FOR SOMETHING ELSE. Named in its own right, because a
    -- salesperson told only "payment required" would go and collect money when
    -- what is actually needed is for the approver to look at the new terms.
    when v_sub.advance_exception_status = 'approved' then 'exception_stale'
    when v_sub.advance_exception_status = 'pending'  then 'exception_pending'
    when v_sub.advance_exception_status = 'rejected' then 'exception_rejected'
    when v_unverif > 0                               then 'verification_pending'
    else 'payment_required'
  end;

  -- ── The rows the card lists ───────────────────────────────────────────────
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
    'submission_status',    v_sub.status,
    'grand_total',          v_total,
    'verified_amount',      v_verified,
    'unverified_amount',    v_unverif,
    -- TRUNCATED, NEVER ROUNDED — the rule 20260917000000 §4 already states for
    -- order_submission_advance_percent_of(): "Truncation cannot overstate."
    -- 39.999% rounds to 40.00 and would print "40%" on a card beside a gate that
    -- refuses; truncation prints 39.99 and the two agree.
    'verified_percent',     case when v_total is null or v_total = 0 then null
                                 else trunc(v_verified * 100 / v_total, 2) end,
    'unverified_percent',   case when v_total is null or v_total = 0 then null
                                 else trunc(v_unverif  * 100 / v_total, 2) end,
    -- Rounded UP to whole paise: the figure a person acts on must be a figure
    -- that, once paid and verified, actually satisfies the gate.
    'needed_for_standard',  public.order_submission_payment_shortfall(v_total, v_verified),
    'required_payment',     v_required,
    'meets_standard',       v_meets,
    'approval_position',    v_position,
    'pending_balance',      case when v_total is null then null
                                 else greatest(v_total - v_verified, 0) end,
    'standard_percent',     public.order_submission_standard_advance_percent(),
    'advance_condition',    v_sub.advance_condition,
    'exception_status',     v_sub.advance_exception_status,
    'exception_current',    v_exc_current,
    'exception_reason',     v_sub.advance_exception_reason,
    'exception_rejection_reason', v_sub.advance_exception_rejection_reason,
    'payment_terms',        v_sub.payment_terms,
    'billing_terms',        v_sub.billing_terms,
    'can_view_all_finance', v_fin_all,
    'payments',             v_rows
  );
end;
$$;

comment on function public.pi_submission_payment_summary(uuid) is
  'Every payment allocated to one PI, with the card''s totals computed in numeric in the database, plus the APPROVAL POSITION the gate would reach right now and the agreed Payment/Billing Terms. Verified counts only active allocations whose parent payment is verified; unverified counts pending_approval and needs_clarification; rejected and reversed count in neither but rejected still appears in the list. needed_for_standard is rounded UP so the figure asked for always closes the gate. Reports; decides nothing — approve_order_submission() re-derives all of it under row locks. Refuses a caller who cannot open the PI.';

revoke execute on function public.pi_submission_payment_summary(uuid) from public, anon;
grant  execute on function public.pi_submission_payment_summary(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §8a. Finance linkage, after the money moves
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE INCONSISTENCY THIS PHASE WOULD OTHERWISE SHIP.
--
-- §7 moves a PI's active allocations onto the Order and deliberately does not
-- touch the parent payment: its proof, its verification, its Finance history and
-- the reference the salesperson typed all stay exactly where they are. So the
-- payment still carries `order_id = NULL` and `status = 'approved_unlinked'`.
--
-- Finance's two Received Payments pages and their sidebar counters split on the
-- LEGACY parent columns alone:
--
--     linked    order_id is not null OR order_request_id is not null
--     unlinked  both null
--
-- which means money genuinely allocated to a numbered Confirmed Order lands in
-- **Non-Linked Payments** — a queue whose stated meaning is "money that has
-- arrived with nothing at all pointing at it, which is the only set that needs
-- someone to act". The counters over-report, and an administrator taking the
-- obvious action would call link_finance_payment_to_order.
--
-- WHY THE PAYMENT IS NOT SIMPLY LINKED INSTEAD.
-- finance_payment_requests_status_order_invariant (20260692000000) requires
--
--     approved_linked  ⇒  order_id IS NOT NULL AND order_number IS NOT NULL
--
-- and on a PI payment `order_number` holds THE SALESPERSON'S REFERENCE / UTR —
-- record_pi_submission_payment (20260919000000 §6) writes p_reference into it.
-- Linking would overwrite that reference where one exists and invent one where
-- it does not. Relaxing the invariant instead would change the meaning of a
-- deployed financial CHECK. Both are ledger redesigns; neither is this phase's
-- business.
--
-- SO THE LEDGER IS LEFT ALONE AND THE READ IS CORRECTED. The allocation table is
-- already the source of truth for what money belongs to — that is what Phase 1
-- exists for — and this view is the smallest thing that lets the Finance lists
-- read it.
--
-- WHAT THIS IS, EXACTLY:
--
--   * A VIEW, not a table: it stores nothing, and there is no second ledger.
--   * SECURITY INVOKER, so every underlying policy is evaluated as the CALLER.
--     It cannot show a payment, an allocation, an Order or a name the caller
--     could not already read, and it cannot be more permissive than the tables
--     beneath it. A SECURITY DEFINER projection would have had to restate six
--     payment policies and five allocation policies to be safe; this restates
--     none.
--   * ONE ROW PER PAYMENT, structurally. The two name joins are on users.id, a
--     primary key, so neither can multiply. The allocation lookup is a LATERAL
--     with LIMIT 1, so a payment with several active Confirmed-Order allocations
--     still yields exactly one row.
--   * It exposes NO allocation id, NO allocated amount and NO split. Only
--     whether a Confirmed-Order allocation exists, and which Order the first one
--     names, so the list can label the row.
--
-- WHICH ORDER IS NAMED WHEN THERE ARE SEVERAL. The OLDEST active
-- Confirmed-Order allocation, by (created_at, id) — deterministic, and stable
-- across reads so a row cannot change label between the list and the counter.
-- Splitting money across several Orders is not something any path in this phase
-- creates; the classification simply does not assume it cannot happen. Such a
-- payment is LINKED, appears once, and is labelled by its first Order.
--
-- THE SECOND SURFACE THIS HAS TO CORRECT, and the reason it is not left for
-- later: the Admin Action Queue's SUSPENSE item is the same predicate under a
-- different name — approved_unlinked with both parent columns null — and it does
-- not merely count, it ASKS AN ADMINISTRATOR TO ACT. Left reading the parent
-- columns it would offer "Link suspense payment" for money that is already on a
-- numbered Order, and the obvious click would attach the payment a second time.
-- That queue therefore reads this projection too, which is why approved_at is in
-- the column list: it is the field the queue ages its rows by.
--
-- WHAT IS NOT CHANGED. Not one policy, not one grant on an existing object, not
-- one column, not one RPC, and not the meaning of `linked` for anything that was
-- already linked. An Order-Request linkage is still a linkage — 20260698000000's
-- CHECK forbids both parent columns at once, and paymentRouting.ts states that
-- rule at length — so an Order-Request payment is classified exactly as it is
-- today.

create view public.finance_received_payments
with (security_invoker = true) as
select
  f.id,
  f.request_number,
  f.client_name,
  f.amount,
  f.payment_date,
  f.payment_mode,
  f.received_in,
  f.proof_note,
  f.order_number,
  f.order_id,
  f.order_request_id,
  f.order_request_number,
  f.sales_note,
  f.status,
  f.payment_against,
  f.submitted_by,
  f.approved_by,
  f.admin_note,
  f.created_at,
  -- approved_at: when Finance confirmed the money arrived. Read by the Admin
  -- Action Queue, which ages its suspense items from it — see §8a's note on the
  -- second surface this projection has to correct.
  f.approved_at,

  -- The two names the list already renders. Flattened here rather than embedded
  -- by the client, because a view has no foreign keys for PostgREST to embed
  -- through — and because a LEFT JOIN on a primary key is the one shape that
  -- cannot multiply a row. A name the caller may not read comes back NULL,
  -- exactly as the embed did.
  eb.full_name as submitted_by_name,
  ab.full_name as approved_by_name,

  -- The Confirmed Order this payment's money is allocated to, if any.
  alloc.order_id       as allocated_order_id,
  alloc.display_number as allocated_order_number,

  -- THE CLASSIFICATION KEY. Derived from the allocation, never from the Order:
  -- a caller who cannot see the Order still sees that the money is allocated,
  -- and only loses the Order's number.
  (alloc.order_id is not null) as is_order_allocated

from public.finance_payment_requests f
left join public.users eb on eb.id = f.submitted_by
left join public.users ab on ab.id = f.approved_by
left join lateral (
  select a.order_id, o.display_number
  from public.finance_payment_allocations a
  left join public.orders o on o.id = a.order_id
  where a.payment_request_id = f.id
    -- ACTIVE ONLY. A reversed allocation is a claim that was withdrawn; it stays
    -- in the Finance trail, where its reason is, and it is not money this Order
    -- has. A payment whose only Confirmed-Order allocation was reversed is
    -- Non-Linked, and a payment with an active PI allocation plus a reversed
    -- Order one is Non-Linked too.
    and a.status = 'active'
    and a.order_id is not null
  order by a.created_at, a.id
  limit 1
) alloc on true;

comment on view public.finance_received_payments is
  'Every payment row a caller may already read, plus whether its money is allocated to a Confirmed Order and which one. SECURITY INVOKER: every underlying policy is evaluated as the caller, so this can show nothing the tables beneath it would not. Exactly one row per payment — the name joins are on a primary key and the allocation lookup is a LATERAL LIMIT 1 — so a payment split across several Orders still appears once, labelled by its oldest active Confirmed-Order allocation. Exposes no allocation id, no allocated amount and no split. Read-only projection; it stores nothing and is not a second ledger.';

-- ── PRIVILEGE NORMALISATION, AND WHY IT IS NOT A FORMALITY ───────────────────
--
-- THE DEPLOYMENT DIFFERENCE THIS EXISTS TO SURVIVE. A plain PostgreSQL cluster
-- creates a view with an EMPTY ACL: the owner has everything, nobody else has
-- anything, and a `grant select to authenticated` is then the whole story. This
-- database is not a plain cluster. Supabase bootstraps
--
--     alter default privileges in schema public
--       grant all on tables to postgres, anon, authenticated, service_role;
--
-- so EVERY new table AND VIEW in `public` is born carrying `arwdDxt` — SELECT,
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER — for all three
-- client-facing roles. Nothing in this file granted those; the platform did,
-- at CREATE VIEW, before the next statement ran.
--
-- Revoking from `public, anon` alone therefore left `authenticated` holding
-- INSERT, UPDATE and DELETE on a read projection, and the `grant select` below
-- was a no-op because SELECT was already there. The apply-time assertion caught
-- it and refused the migration — which is exactly what it is for.
--
-- SO THE PRIVILEGES ARE NORMALISED EXPLICITLY: everything is taken away from
-- every client role first, and the ONE privilege this object is meant to carry
-- is then granted back.
--
-- THE ORDER MATTERS AND IS NOT INTERCHANGEABLE:
--   1. CREATE VIEW      — the platform's default privileges land here
--   2. REVOKE ALL       — from public, anon AND authenticated, undoing them
--   3. GRANT SELECT     — to authenticated, the one thing it may do
-- Granting before revoking would erase the grant.
--
-- `revoke ... from public` removes PUBLIC's own grants; it does not touch a
-- role's individual ones, which is why `authenticated` has to be named.
--
-- SERVICE_ROLE IS LEFT AS THE PLATFORM SET IT, which is this project's
-- established convention for every table it has shipped (20260703000000
-- order_number_cycle, 20260706000000 test_data_cleanup_settings/_audit,
-- 20260916000000 test_data_cleanup_claims — each revokes from `public, anon,
-- authenticated` and says nothing about service_role). Nothing here GRANTS it
-- anything, no client can reach it, it bypasses RLS by design, and a view with
-- joins is not auto-updatable in any case — a write attempted through it fails
-- whoever tries. The rule this file holds itself to is the one the assertions
-- state: no CLIENT role may write.

revoke all privileges on public.finance_received_payments
  from public, anon, authenticated;

grant select on public.finance_received_payments to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §9. Submitting a PI for review, without declaring an advance
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT THE EMPLOYEE IS ASKED FOR NOW, AND WHAT THEY ARE NOT.
--
-- NOT ASKED: a declared advance amount. The question "what advance is this order
-- carrying?" was a proxy for "has the client paid?", and the answer is now a
-- fact the database holds. Asking somebody to restate it as a promise invites
-- exactly the confusion the last three migrations spent their comments warning
-- about.
--
-- ASKED, AND ONLY WHEN VERIFIED PAYMENT IS BELOW THE REQUIREMENT:
--
--   a REASON          why the business should confirm an Order below 40%
--   PAYMENT TERMS     how the rest will be collected
--
-- Billing Terms may be given on either route and is never required.
--
-- THE ROUTE IS DECIDED BY THE DATABASE, NOT BY THE BROWSER. This function sums
-- verified payment itself, under the same locks and with the same helper the
-- approval path uses, and chooses:
--
--   verified >= 40%   'standard'. The exception state is CLEARED — the actionable
--                     state only; the trail keeps every request and decision
--                     ever made. No reason is required and none is stored.
--   verified <  40%   'exception', pending, with the reason and terms — unless an
--                     identical request is already APPROVED, which survives a
--                     resubmission untouched (the rule 20260917000000 §5
--                     established, for the same reason: asking management to
--                     accept the same proposal twice is make-work).
--
-- WHY THE ROUTE IS NOT FROZEN HERE EITHER. Nothing about this write gates
-- approval. A PI submitted on the standard route whose payment is later reversed
-- is refused at approval; a PI submitted under an exception that later collects
-- 40% is approved on the standard route without the exception being decided.
-- This function records what was true at submission and what is being ASKED FOR;
-- approve_order_submission() decides.
--
-- ONLY THE OWNER MAY ASK. can_edit_order_submission admits an active admin as
-- well, which is right for correcting a record and wrong for asking the business
-- a commercial question in somebody else's name — the rule and the error code
-- 20260917000000 established, unchanged.
--
-- THE COMPLETENESS CHECKS ARE THE SAME ONES, DELIBERATELY. Blocking issues, the
-- client name, the workbook path/existence/type, the item invariants, exactly one
-- representative image per line, every image path naming its own line, and every
-- image actually stored. What was true when the employee submitted must still be
-- true when the Order is created, and the two paths must agree about what "still
-- true" means.

create or replace function public.submit_pi_for_review_internal(
  p_submission_id uuid,
  p_note          text,
  p_reason        text,
  p_payment_terms text,
  p_billing_terms text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_item_count integer;
  v_incomplete integer;
  v_bad        integer;
  v_bad_row    integer;
  v_note       text := nullif(btrim(coalesce(p_note, '')), '');
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_pay_terms  text := nullif(btrim(coalesce(p_payment_terms, '')), '');
  v_bill_terms text := nullif(btrim(coalesce(p_billing_terms, '')), '');
  v_verified   numeric;
  v_required   numeric;
  v_percent    numeric;
  v_standard   numeric := public.order_submission_standard_advance_percent();
  v_route      text;
  v_keep       boolean := false;
  v_requested  boolean := false;
  v_meta       jsonb;
begin
  if not public.actor_has_module_permission('orders', 'create') then
    raise exception 'You do not have permission to submit an order submission'
      using errcode = '42501';
  end if;

  -- ── Shapes, before the row is locked ──
  --
  -- Every one of these is the caller's own mistake and needs nothing from the
  -- record, so refusing early costs the database nothing and holds no lock.
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception
      'ORDER_SUBMISSION_NOTE_TOO_LONG: a reply may be at most 1000 characters (this one is %)',
      char_length(v_note)
      using errcode = 'P0001';
  end if;

  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  if v_pay_terms is not null and char_length(v_pay_terms) > 500 then
    raise exception
      'ORDER_SUBMISSION_TERMS_TOO_LONG: payment terms may be at most 500 characters (these are %)',
      char_length(v_pay_terms)
      using errcode = 'P0001';
  end if;

  if v_bill_terms is not null and char_length(v_bill_terms) > 500 then
    raise exception
      'ORDER_SUBMISSION_TERMS_TOO_LONG: billing terms may be at most 500 characters (these are %)',
      char_length(v_bill_terms)
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if not public.can_edit_order_submission(p_submission_id) then
    raise exception 'This order submission cannot be submitted by you in its current state'
      using errcode = '42501';
  end if;

  if v_sub.grand_total is null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored grand total, so its payment position cannot be judged'
      using errcode = 'P0001';
  end if;

  -- ── The live payment position, under the same locks the approval takes ──
  --
  -- Payments before allocations, both in id order — the ordering explained in
  -- §7. Taking it here too means a submission and an approval racing over the
  -- same PI serialize rather than interleave.
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

  v_verified := public.order_submission_verified_payment(p_submission_id);
  v_required := public.order_submission_required_payment(v_sub.grand_total);
  v_route    := case when v_verified >= v_required then 'standard' else 'exception' end;

  if v_route = 'exception' then
    -- ── What the business must be told before it is asked ──
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED: say why an Order should be confirmed below the standard %% requirement'
        using errcode = 'P0001';
    end if;

    if v_pay_terms is null then
      raise exception
        'ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED: enter the agreed payment terms before asking to proceed below the standard requirement'
        using errcode = 'P0001';
    end if;

    if not (v_sub.created_by = v_actor or v_sub.submitted_by = v_actor) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_OWNER: only the owner of this PI may request an advance exception'
        using errcode = '42501';
    end if;

    -- THE SNAPSHOT, TRUNCATED AND NEVER ROUNDED. order_submission_advance_percent_of
    -- truncates at two places, so a figure below the requirement can never be
    -- stored as 40 and the applied "strictly below 40" constraint is satisfied by
    -- construction. A non-positive total yields NULL there, and zero verified
    -- payment is zero percent exactly with no division involved.
    v_percent := case
      when v_verified = 0 then 0
      else coalesce(
        public.order_submission_advance_percent_of(v_sub.grand_total, v_verified), 0)
    end;

    -- Belt and braces against a total so small that truncation cannot separate
    -- the figures. The row constraint would refuse it anyway; this refuses it by
    -- name instead of as an opaque check violation.
    if v_percent >= v_standard then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_TOTAL_NOT_POSITIVE: this PI has no positive grand total to measure a payment percentage against'
        using errcode = 'P0001';
    end if;

    -- AN APPROVED EXCEPTION SURVIVES A RESUBMISSION THAT DOES NOT CHANGE WHAT IS
    -- BEING ASKED — and nothing else does.
    --
    -- The ask is the REASON. The commercial basis is the grand total, the
    -- workbook and the two sets of terms, and order_submission_exception_current()
    -- owns that comparison so the submit door and the approval path cannot word
    -- it differently. Anything that moves either of them — a replaced workbook, a
    -- corrected total, different collection terms, different words, a previously
    -- rejected or pending request, a decision with no recorded basis — becomes a
    -- FRESH pending decision with a fresh requester and time.
    --
    -- The percentage is NOT compared: it is a snapshot of verified payment, which
    -- legitimately moves, so it is refreshed rather than held against the record.
    --
    -- The terms compared are the ones being submitted NOW, not the ones on the
    -- row: this statement is about to write them.
    v_keep := coalesce(
      v_sub.advance_condition = 'exception'
      and v_sub.advance_exception_reason is not distinct from v_reason
      and public.order_submission_exception_current(
            v_sub.advance_exception_status,
            v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
            v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
            v_sub.advance_exception_decided_payment_terms,   v_pay_terms,
            v_sub.advance_exception_decided_billing_terms,   v_bill_terms),
      false
    );
  end if;

  -- ── The completeness checks, identical to every other submission path ──
  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) must be fixed in the workbook before this can be submitted',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.client_name), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

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
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: no file exists in order-files at the recorded workbook path'
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
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX: the stored workbook is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_incomplete
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_incomplete > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_incomplete
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

  -- ── The write ──
  --
  -- ONE STATEMENT ON EVERY PATH, so the status, the terms and the exception state
  -- land together or not at all. review_note is cleared exactly as the applied
  -- migrations established: management's outstanding request has been answered.
  --
  -- advance_declared_amount IS SET TO NULL ON BOTH PATHS. Nothing was declared —
  -- this door does not ask — and leaving a figure typed against a previous
  -- submission would make the row say something the employee did not say this
  -- time. The historical value is not lost: every declaration ever made is in the
  -- append-only trail, in the 'submitted' event that recorded it, and every
  -- record that has not been resubmitted keeps its column value untouched.

  if v_route = 'standard' then
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_condition = 'standard',
           advance_declared_amount = null,
           advance_exception_percent = null,
           advance_exception_reason = null,
           advance_exception_status = null,
           advance_exception_requested_by = null,
           advance_exception_requested_at = null,
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null
     where id = p_submission_id;

  elsif v_keep then
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_declared_amount = null,
           advance_exception_percent = v_percent
     where id = p_submission_id;

  else
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_condition = 'exception',
           advance_declared_amount = null,
           advance_exception_percent = v_percent,
           advance_exception_reason = v_reason,
           advance_exception_status = 'pending',
           advance_exception_requested_by = v_actor,
           advance_exception_requested_at = now(),
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null
     where id = p_submission_id;
    v_requested := true;
  end if;

  -- submitted_at is stamped by the status transition trigger (20260910000000)
  -- and by nothing here.

  -- THE SAME KEYS THE APPLIED EVENTS CARRY, so one reader renders every event
  -- ever logged, plus the figures this phase actually decides on. advance_percent
  -- is the VERIFIED PAYMENT percentage now, and advance_amount the verified
  -- rupees — the trail states what was true, not what was promised.
  v_meta := jsonb_build_object(
    'advance_condition',  v_route,
    'advance_percent',    case when v_route = 'standard' then v_standard else v_percent end,
    'standard_percent',   v_standard,
    'grand_total',        v_sub.grand_total,
    'advance_amount',     v_verified,
    'verified_payment',   v_verified,
    'required_payment',   v_required,
    'payment_terms',      v_pay_terms,
    'billing_terms',      v_bill_terms
  );

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
      || v_meta
  );

  -- The exception request is its OWN event, separate from the submission, so a
  -- reader can see the proposal without reading the submission's bookkeeping.
  if v_requested then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'advance_exception_requested', v_sub.status, 'submitted', v_reason,
      v_meta || jsonb_build_object('exception_status', 'pending')
    );
  end if;

  return jsonb_build_object(
    'id',                p_submission_id,
    'status',            'submitted',
    'item_count',        v_item_count,
    'payment_route',     v_route,
    'verified_payment',  v_verified,
    'required_payment',  v_required,
    'exception_requested', v_requested
  );
end;
$$;

revoke execute on function public.submit_pi_for_review_internal(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_pi_for_review_internal(uuid, text, text, text, text) is
  'The implementation of submitting a PI for review under the verified-payment rule: it sums verified payment itself, chooses the standard or the reduced-payment route, requires a reason and Payment Terms on the reduced route, and asks the employee for no declared advance at all. Executable by no role: reached only by its door, as the definer.';

-- ── The door ────────────────────────────────────────────────────────────────
--
-- A SEPARATE NAME, NOT AN OVERLOAD — the arrangement 20260911000000 established
-- and every phase since has extended: PostgREST resolves a function by the
-- argument names in the request body, so two functions sharing a name would be
-- picked apart by which keys a caller happened to send.
--
-- THE FOUR APPLIED DOORS ARE NOT TOUCHED. submit_order_submission(uuid),
-- submit_order_submission_with_note(uuid, text),
-- submit_order_submission_with_advance(...) and
-- submit_order_submission_with_advance_amount(...) keep their exact behaviour, so
-- a client mid-deploy is never refused. They simply no longer describe how this
-- product asks the question, and the browser stops calling them.

create or replace function public.submit_pi_for_review(
  p_submission_id uuid,
  p_note          text default null,
  p_reason        text default null,
  p_payment_terms text default null,
  p_billing_terms text default null
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.submit_pi_for_review_internal(
    p_submission_id, p_note, p_reason, p_payment_terms, p_billing_terms)
$$;

revoke execute on function public.submit_pi_for_review(uuid, text, text, text, text)
  from public, anon;
grant  execute on function public.submit_pi_for_review(uuid, text, text, text, text)
  to authenticated;

comment on function public.submit_pi_for_review(uuid, text, text, text, text) is
  'Submits a PI for management review. The database decides the route from FINANCE-VERIFIED payment: at or above 40% of the grand total it is the standard route and no exception is created; below it — zero included — a reason and Payment Terms are mandatory and a reduced-payment exception is raised for an authorised approver. No declared advance is asked for or stored. Assigns no Order number and creates no payment.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §10. Notifications
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHO IS TOLD, AND ONLY THESE:
--
--   the exception approvers   when a PI asks to proceed below the requirement
--   the submission owner      when that request is approved, or refused
--
-- Nobody else. Management already sees a submitted PI in its review queue, and
-- the approver's own decision is not news to the approver — the shared route
-- skips the actor exactly as every other notify route on this system does.
--
-- THE TYPES ARE ENUM VALUES, added the way 20260694000000 added the Finance and
-- Order-request ones. IF NOT EXISTS, so a re-run is inert, and nothing in this
-- transaction USES them — a new enum value is not visible to the transaction
-- that adds it.

alter type notification_type add value if not exists 'pi_exception_requested';
alter type notification_type add value if not exists 'pi_exception_approved';
alter type notification_type add value if not exists 'pi_exception_rejected';

-- WHO MAY DECIDE, resolved server-side so the notify route never has to guess.
--
-- Exactly the two authorities the decision RPCs accept, and derived from the
-- same engine: an ACTIVE, non-deleted admin, or an active user whom
-- resolve_permission() grants the module/action. There is no third route, and
-- this function confers nothing — it answers "who would be allowed", for the
-- purpose of telling them there is something waiting.
--
-- SERVICE ROLE ONLY. It reads the user table and the permission engine, which is
-- exactly what an authenticated caller must not be able to enumerate. The one
-- caller is the server-side notify route, which already runs with the service
-- key and already resolves recipients for every other module.
create or replace function public.users_with_module_permission(
  p_module_key text,
  p_action_key text
)
-- RETURNS TABLE, NOT SETOF uuid, and the difference is not cosmetic: PostgREST
-- renders a set-returning function's rows by COLUMN NAME, and an anonymous
-- scalar set arrives under whatever name the function happens to have. A named
-- column is what makes the caller's read unambiguous.
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id
  from public.users u
  where u.is_active
    and coalesce(u.is_deleted, false) = false
    and (
      u.role = 'admin'
      or coalesce(public.resolve_permission(u.id, p_module_key, p_action_key), false)
    )
$$;

comment on function public.users_with_module_permission(text, text) is
  'The active, non-deleted users who would be allowed to take one module action: every admin, plus everyone the permission engine grants it. Used only to address a notification to the people who can act on it. Grants nothing, changes nothing, and is executable by the service role only.';

revoke execute on function public.users_with_module_permission(text, text)
  from public, anon, authenticated;
grant  execute on function public.users_with_module_permission(text, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- §11. Assertions
-- ═════════════════════════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_n    integer;
  v_bool boolean;
  v_num  numeric;
  v_name text;
  v_def  text;
  v_cols text[];
begin
  -- ── The two new columns exist and are nullable text ──
  select count(*) into v_n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'order_submissions'
    and column_name in ('payment_terms', 'billing_terms')
    and data_type = 'text' and is_nullable = 'YES';
  if v_n <> 2 then
    raise exception 'payment_terms and billing_terms must both exist as nullable text (found %)', v_n;
  end if;

  -- ── Their constraints are present and validated ──
  select count(*) into v_n
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace ns on ns.oid = t.relnamespace
  where ns.nspname = 'public' and t.relname = 'order_submissions'
    and c.contype = 'c' and c.convalidated
    and c.conname in ('order_submissions_payment_terms_valid',
                      'order_submissions_billing_terms_valid');
  if v_n <> 2 then
    raise exception 'the payment/billing terms constraints are missing or unvalidated (found %)', v_n;
  end if;

  -- ── NOTHING WAS DECLARED, DECIDED OR CLEARED ON ANYBODY'S BEHALF ──
  --
  -- This migration writes no row of order_submissions. Every historical declared
  -- advance is exactly where it was, and every exception decision still stands.
  select count(*) into v_n from public.order_submissions where payment_terms is not null;
  if v_n > 0 then
    raise exception '% record(s) already carry payment terms; this migration agrees nothing on anybody''s behalf', v_n;
  end if;

  select count(*) into v_n from public.order_submissions where billing_terms is not null;
  if v_n > 0 then
    raise exception '% record(s) already carry billing terms', v_n;
  end if;

  -- ── The declared-advance column still exists and still holds its history ──
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_submissions'
      and column_name = 'advance_declared_amount'
  ) then
    raise exception 'advance_declared_amount must be preserved, never dropped';
  end if;

  -- ── The requirement agrees with the one rule that states it ──
  --
  -- ₹10,00,000 -> ₹4,00,000, exactly, and one paisa below it is below it.
  v_num := public.order_submission_required_payment(1000000);
  if v_num <> 400000 then
    raise exception '40%% of 10,00,000 must be 4,00,000, got %', v_num;
  end if;

  if public.order_submission_required_payment(1000000)
     <> 1000000 * public.order_submission_standard_advance_percent() / 100 then
    raise exception 'the requirement must derive from order_submission_standard_advance_percent()';
  end if;

  if public.order_submission_required_payment(null) is not null then
    raise exception 'an unknown grand total must yield NULL, never a guess';
  end if;

  -- EXACT, NOT ROUNDED. 40% of 100.01 is 40.004; 40.00 does not meet it.
  if public.order_submission_payment_ready(100.01, 40.00, null) then
    raise exception 'a payment below the exact requirement must not pass on a rounded percentage';
  end if;
  if not public.order_submission_payment_ready(100.01, 40.01, null) then
    raise exception 'a payment at or above the exact requirement must pass';
  end if;

  -- The shortfall is a payable figure: ceiling, never rounding.
  if public.order_submission_payment_shortfall(100.01, 40.00) <> 0.01 then
    raise exception 'the shortfall must round UP to a figure that closes the gate, got %',
      public.order_submission_payment_shortfall(100.01, 40.00);
  end if;
  if public.order_submission_payment_shortfall(1000000, 400000) <> 0 then
    raise exception 'a met requirement must show no shortfall';
  end if;

  -- ── The gate, in every combination that decides something ──
  if not public.order_submission_payment_ready(1000, 400, null) then
    raise exception 'exactly 40%% verified must be ready';
  end if;
  if not public.order_submission_payment_ready(1000, 999, null) then
    raise exception 'more than 40%% verified must be ready';
  end if;
  if public.order_submission_payment_ready(1000, 399.99, null) then
    raise exception 'below 40%% with no exception must not be ready';
  end if;
  if public.order_submission_payment_ready(1000, 399.99, 'pending') then
    raise exception 'a PENDING exception must not be ready';
  end if;
  if public.order_submission_payment_ready(1000, 399.99, 'rejected') then
    raise exception 'a REJECTED exception must not be ready';
  end if;
  if not public.order_submission_payment_ready(1000, 399.99, 'approved') then
    raise exception 'an APPROVED exception must be ready below 40%%';
  end if;
  if not public.order_submission_payment_ready(1000, 0, 'approved') then
    raise exception 'an APPROVED exception must be ready at zero payment';
  end if;
  if public.order_submission_payment_ready(1000, 0, null) then
    raise exception 'zero payment with no exception must not be ready';
  end if;
  if public.order_submission_payment_ready(null, 400, null) then
    raise exception 'an unknown grand total must never be ready on the standard route';
  end if;
  if public.order_submission_payment_ready(1000, 'NaN'::numeric, null) then
    raise exception 'NaN must never be ready';
  end if;

  -- ── The verified total counts what it says and nothing else ──
  --
  -- Asserted against the STATUS rule rather than against rows, because there is
  -- no fixture here: the two verified statuses are exactly the two Phase 1
  -- named, and the three unverified ones are exactly the three it excluded.
  for v_bool in
    select public.finance_payment_status_is_verified(s)
    from unnest(array['approved_unlinked', 'approved_linked']) as s
  loop
    if not v_bool then raise exception 'a verified status stopped counting as verified'; end if;
  end loop;

  for v_bool in
    select public.finance_payment_status_is_verified(s)
    from unnest(array['pending_approval', 'needs_clarification', 'rejected']) as s
  loop
    if v_bool then raise exception 'an unverified status must never count as verified'; end if;
  end loop;

  -- ── Approval still exists, still takes one argument, still returns jsonb ──
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'approve_order_submission'
    and pg_get_function_identity_arguments(p.oid) = 'p_submission_id uuid'
    and p.prosecdef;
  if v_n <> 1 then
    raise exception 'approve_order_submission(uuid) must remain one SECURITY DEFINER function, found %', v_n;
  end if;

  -- ── It no longer gates on the declared advance, and does gate on payment ──
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'approve_order_submission'
    and pg_get_functiondef(p.oid) ilike '%order_submission_verified_payment%'
    and pg_get_functiondef(p.oid) not ilike '%order_submission_advance_ready%';
  if v_n <> 1 then
    raise exception
      'approve_order_submission must read verified payment and must not read the declared-advance predicate';
  end if;

  -- ── The allocation guard admits the conversion and nothing wider ──
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finance_payment_allocations_guard_transition'
      and pg_get_functiondef(p.oid) ilike '%in_pi_submission_approval%'
      and pg_get_functiondef(p.oid) ilike '%source_order_submission_id%'
      and pg_get_functiondef(p.oid) ilike '%ALLOCATION_IMMUTABLE%'
      and pg_get_functiondef(p.oid) ilike '%ALLOCATION_REVERSAL_FINAL%'
      and pg_get_functiondef(p.oid) ilike '%ALLOCATION_REVERSAL_IMMUTABLE%'
  ) then
    raise exception
      'the allocation transition guard must tie the move to the approval context and to the Order created from that PI, and must keep all three refusals';
  end if;

  -- ── Its trigger is still wired, still BEFORE UPDATE, still first by name ──
  if not exists (
    select 1 from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
    where n.nspname = 'public'
      and c.relname = 'finance_payment_allocations'
      and tg.tgname = 'finance_payment_allocations_check_transition'
      and p.proname = 'finance_payment_allocations_guard_transition'
      and not tg.tgisinternal
  ) then
    raise exception 'finance_payment_allocations_check_transition must still run the transition guard';
  end if;

  -- ── The reversal derivation is untouched, so a conversion cannot stamp one ──
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finance_payment_allocations_derive_reversal'
      and pg_get_functiondef(p.oid) not ilike '%new.status = ''reversed'' and old.status = ''active''%'
  ) then
    raise exception 'the reversal derivation must still fire only on active -> reversed';
  end if;

  -- ── The two new activity vocabularies ──
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'order_submission_activity'
      and c.conname = 'order_submission_activity_action_check'
      and pg_get_constraintdef(c.oid) like '%payment_allocations_moved%'
      and pg_get_constraintdef(c.oid) like '%advance_exception_requested%'
      and pg_get_constraintdef(c.oid) like '%payment_recorded%'
      and pg_get_constraintdef(c.oid) like '%finance_verified%'
      and pg_get_constraintdef(c.oid) like '%approved%'
  ) then
    raise exception 'the PI action set must gain payment_allocations_moved and keep every applied action';
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'finance_payment_request_activity_log'
      and c.conname = 'finance_payment_request_activity_log_event_type_check'
      and pg_get_constraintdef(c.oid) like '%allocation_moved%'
      and pg_get_constraintdef(c.oid) like '%allocation_created%'
      and pg_get_constraintdef(c.oid) like '%allocation_reversed%'
      and pg_get_constraintdef(c.oid) like '%cash_handover_recorded%'
  ) then
    raise exception 'the Finance event set must gain allocation_moved and keep every applied event';
  end if;

  -- ── The submit door exists, is reachable by authenticated, and its
  --    implementation is reachable by nobody ──
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'submit_pi_for_review'
      and pg_get_function_identity_arguments(p.oid) =
          'p_submission_id uuid, p_note text, p_reason text, p_payment_terms text, p_billing_terms text'
  ) then
    raise exception 'submit_pi_for_review must exist with its five named arguments';
  end if;

  if not has_function_privilege('authenticated', 'public.submit_pi_for_review(uuid, text, text, text, text)', 'execute') then
    raise exception 'submit_pi_for_review must be callable by authenticated';
  end if;

  for v_bool in
    select has_function_privilege(r, 'public.submit_pi_for_review_internal(uuid, text, text, text, text)', 'execute')
    from unnest(array['anon', 'authenticated', 'service_role']) as r
  loop
    if v_bool then
      raise exception 'submit_pi_for_review_internal must be executable by no client role';
    end if;
  end loop;

  -- ── The arithmetic behind the decision is not a reporting route ──
  for v_bool in
    select has_function_privilege(r, 'public.order_submission_verified_payment(uuid)', 'execute')
    from unnest(array['anon', 'authenticated', 'service_role']) as r
  loop
    if v_bool then
      raise exception 'order_submission_verified_payment must be executable by no client role';
    end if;
  end loop;

  -- ── The four applied submit doors are still there ──
  select count(distinct p.proname) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('submit_order_submission',
                      'submit_order_submission_with_note',
                      'submit_order_submission_with_advance',
                      'submit_order_submission_with_advance_amount');
  if v_n < 4 then
    raise exception 'the applied submit doors must not be removed (found %)', v_n;
  end if;

  -- ── The exception authority is unchanged and unwidened ──
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_pi_advance_exception'
      and pg_get_functiondef(p.oid) ilike '%approve_advance_exception%'
  ) then
    raise exception 'approving an exception must still require orders.approve_advance_exception';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reject_pi_advance_exception'
      and pg_get_functiondef(p.oid) ilike '%approve_advance_exception%'
      and pg_get_functiondef(p.oid) ilike '%needs_changes%'
  ) then
    raise exception 'rejecting an exception must still require the authority and still return the PI for changes';
  end if;

  -- NEITHER DECISION RPC TOUCHES A PAYMENT. Approving an exception is not
  -- verifying money, and the proof is that neither function names the ledger.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_pi_advance_exception', 'reject_pi_advance_exception')
      and pg_get_functiondef(p.oid) ilike '%finance_payment_requests%'
  ) then
    raise exception 'an exception decision must never write or read the payment ledger';
  end if;

  -- ── The summary reports the position and still refuses an outsider ──
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pi_submission_payment_summary'
      and pg_get_functiondef(p.oid) ilike '%can_view_order_submission%'
      and pg_get_functiondef(p.oid) ilike '%approval_position%'
      and pg_get_functiondef(p.oid) ilike '%payment_terms%'
      and pg_get_functiondef(p.oid) not ilike '%advance_declared_amount%'
  ) then
    raise exception
      'the payment summary must stay gated, must report the approval position and the terms, and must never report a declared advance';
  end if;

  -- ── Numbering is untouched: no second allocator was introduced ──
  --
  -- The INSERT's column list must not name display_number, and nothing anywhere
  -- in the body may compute one. orders_assign_display_number (20260703000000 §7)
  -- assigns it unconditionally and RETURNING reads back what it assigned.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_order_submission'
      and (
        pg_get_functiondef(p.oid) ~* 'insert\s+into\s+public\.orders\s*\([^)]*display_number'
        or pg_get_functiondef(p.oid) ~* 'max\s*\(\s*display_number'
        or pg_get_functiondef(p.oid) ~* 'nextval'
      )
  ) then
    raise exception 'approve_order_submission must never assign or compute a display number itself';
  end if;

  -- ── The exception's recorded basis ──
  select count(*) into v_n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'order_submissions'
    and column_name in ('advance_exception_decided_grand_total',
                        'advance_exception_decided_workbook_sha256',
                        'advance_exception_decided_payment_terms',
                        'advance_exception_decided_billing_terms');
  if v_n <> 4 then
    raise exception 'the four exception-basis columns must exist (found %)', v_n;
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace ns on ns.oid = t.relnamespace
    where ns.nspname = 'public' and t.relname = 'order_submissions'
      and c.conname = 'order_submissions_exception_basis_scope' and c.convalidated
  ) then
    raise exception 'a decision basis must be permitted only on an approved exception';
  end if;

  -- CURRENTNESS, in every combination that decides something.
  if not public.order_submission_exception_current(
       'approved', 1000, 1000, 'sha', 'sha', '50% before dispatch', '50% before dispatch', null, null) then
    raise exception 'an approval against the same total, workbook and terms must be current';
  end if;
  if public.order_submission_exception_current(
       'approved', 1000, 2000, 'sha', 'sha', null, null, null, null) then
    raise exception 'a changed grand total must make the approval stale';
  end if;
  if public.order_submission_exception_current(
       'approved', 1000, 1000, 'sha', 'other', null, null, null, null) then
    raise exception 'a replaced workbook must make the approval stale';
  end if;
  if public.order_submission_exception_current(
       'approved', 1000, 1000, 'sha', 'sha', '50% now', '30% now', null, null) then
    raise exception 'changed Payment Terms must make the approval stale';
  end if;
  if public.order_submission_exception_current(
       'approved', 1000, 1000, 'sha', 'sha', null, null, '100% before dispatch', null) then
    raise exception 'changed Billing Terms must make the approval stale';
  end if;
  if public.order_submission_exception_current(
       'approved', null, 1000, null, 'sha', null, null, null, null) then
    raise exception 'a decision with NO recorded basis must never be current';
  end if;
  for v_bool in
    select public.order_submission_exception_current(
             st, 1000, 1000, 'sha', 'sha', null, null, null, null)
    from unnest(array['pending', 'rejected', null]) as st
  loop
    if v_bool then raise exception 'only an APPROVED exception can be current'; end if;
  end loop;

  -- ── The approval consults it, and says so in its own words ──
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_order_submission'
      and pg_get_functiondef(p.oid) ilike '%order_submission_exception_current%'
      and pg_get_functiondef(p.oid) ilike '%ORDER_SUBMISSION_EXCEPTION_STALE%'
      and pg_get_functiondef(p.oid) ilike '%ORDER_SUBMISSION_ALLOCATION_NOT_MOVED%'
  ) then
    raise exception
      'final approval must require a CURRENT exception, refuse a stale one by name, and refuse to leave money on the PI';
  end if;

  -- ── The reason is frozen while an approval stands, and the basis moves only
  --    with the decision ──
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'order_submissions_guard_advance_exception'
      and pg_get_functiondef(p.oid) ilike '%ORDER_SUBMISSION_EXCEPTION_REASON_FROZEN%'
      and pg_get_functiondef(p.oid) ilike '%ORDER_SUBMISSION_EXCEPTION_BASIS_IMMUTABLE%'
      and pg_get_functiondef(p.oid) ilike '%ORDER_SUBMISSION_ADVANCE_NOT_PENDING%'
  ) then
    raise exception 'the exception guard must freeze the reason and the basis, and keep every applied clause';
  end if;

  -- ── ONE LOCK ORDER: the target before the payment, on every path ──
  --
  -- Asserted structurally, on the one function that had it the other way round.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'allocate_payment_to_target_internal'
      and position('from public.order_submissions' in pg_get_functiondef(p.oid))
        < position('from public.finance_payment_requests' in pg_get_functiondef(p.oid))
  ) then
    raise exception
      'allocate_payment_to_target_internal must lock the PI submission BEFORE the payment, or an allocation can race an approval';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'allocate_payment_to_target_internal'
      and pg_get_functiondef(p.oid) ilike '%where id = p_order_submission_id%for update%'
  ) then
    raise exception 'the PI-submission target must be locked FOR UPDATE';
  end if;

  -- The same order in both Phase 3 write paths.
  for v_name in
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_order_submission', 'submit_pi_for_review_internal')
  loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;

    if position('from public.order_submissions' in v_def)
       > position('from public.finance_payment_requests' in v_def) then
      raise exception '% must lock the submission before any payment', v_name;
    end if;
    if position('from public.finance_payment_requests' in v_def)
       > position('from public.finance_payment_allocations' in v_def) then
      raise exception '% must lock payments before allocations', v_name;
    end if;
    if v_def not like '%order by f.id%' or v_def not like '%order by a.id%' then
      raise exception '% must lock multi-row sets in a deterministic id order', v_name;
    end if;
  end loop;

  -- ── The displayed percentage can never overstate ──
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pi_submission_payment_summary'
      and pg_get_functiondef(p.oid) ilike '%trunc(v_verified * 100 / v_total, 2)%'
      and pg_get_functiondef(p.oid) ilike '%exception_stale%'
  ) then
    raise exception
      'the summary must truncate the verified percentage and must name a stale approval';
  end if;

  -- ── The shortfall is whole paise, and always closes the gate ──
  if public.order_submission_payment_shortfall(33333.33, 0) <> 13333.34 then
    raise exception
      '40%% of 33,333.33 is 13,333.332; the amount asked for must be 13,333.34, got %',
      public.order_submission_payment_shortfall(33333.33, 0);
  end if;
  if not public.order_submission_payment_ready(
       33333.33, public.order_submission_payment_shortfall(33333.33, 0), null) then
    raise exception 'paying exactly the amount shown must always satisfy the gate';
  end if;
  if public.order_submission_payment_ready(
       33333.33, round(public.order_submission_required_payment(33333.33), 2), null) then
    raise exception 'the ROUNDED requirement must not satisfy the exact gate';
  end if;
  if scale(public.order_submission_payment_shortfall(100.01, 40.00)) > 2 then
    raise exception 'the amount asked for must be a real two-decimal figure';
  end if;

  -- ── How many legacy approvals this makes non-current, reported not guessed ──
  select count(*) into v_n
  from public.order_submissions
  where advance_exception_status = 'approved';
  if v_n > 0 then
    raise notice
      'Phase 3: % PI(s) carry an approved advance exception with no recorded basis. Each was a decision about a DECLARED advance, not about verified payment, and must be approved again before that PI can be confirmed below 40%%.',
      v_n;
  end if;

  -- ── Cleanup follows the money across the move ──
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_test_data_cleanup_chain'
      and pg_get_functiondef(p.oid) ilike '%a.order_submission_id = v_submission_id%'
      and pg_get_functiondef(p.oid) ilike '%a.order_id = v_order_id or a.order_id = v_sub_order_id%'
  ) then
    raise exception
      'the cleanup chain must find a payment through an allocation on EITHER side of the PI-to-Order move';
  end if;

  -- ── The Finance linkage projection ──
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'finance_received_payments'
      and c.relkind = 'v'
  ) then
    raise exception 'the Finance linkage projection must exist as a VIEW, never a table';
  end if;

  -- SECURITY INVOKER, and asserted rather than assumed: a definer view here
  -- would show every payment to everyone who can open the Finance pages.
  select coalesce((
    select opt
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral unnest(coalesce(c.reloptions, '{}'::text[])) as opt
    where n.nspname = 'public' and c.relname = 'finance_received_payments'
      and opt like 'security_invoker%'
    limit 1
  ), '') into v_def;
  if v_def is distinct from 'security_invoker=true' then
    raise exception
      'finance_received_payments must be security_invoker=true (found "%")', v_def;
  end if;

  -- ITS OUTPUT COLUMNS ARE A CLOSED SET, asserted on the columns themselves
  -- rather than on the view's text: no allocation id, no allocated amount, no
  -- provenance, no reversal record and no split. The list is exactly the columns
  -- the Finance list already read, plus the two names it already rendered and
  -- the three the classification needs.
  select coalesce(array_agg(column_name order by column_name), '{}')
    into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'finance_received_payments';

  if v_cols <> array[
    'admin_note', 'allocated_order_id', 'allocated_order_number', 'amount',
    'approved_at', 'approved_by', 'approved_by_name', 'client_name',
    'created_at', 'id', 'is_order_allocated', 'order_id', 'order_number',
    'order_request_id', 'order_request_number', 'payment_against',
    'payment_date', 'payment_mode', 'proof_note', 'received_in',
    'request_number', 'sales_note', 'status', 'submitted_by',
    'submitted_by_name'
  ]::text[] then
    raise exception
      'the projection exposes an unexpected column set: %', array_to_string(v_cols, ', ');
  end if;

  select pg_get_viewdef('public.finance_received_payments'::regclass, true) into v_def;

  -- One row per payment, structurally: the two name joins are on a primary key
  -- and the allocation lookup is a LATERAL LIMIT 1.
  if v_def not ilike '%limit 1%' then
    raise exception 'the allocation lookup must be a LATERAL LIMIT 1, or a split payment appears twice';
  end if;
  if v_def not ilike '%order by%' then
    raise exception 'the allocation lookup must be deterministically ordered';
  end if;
  if v_def not ilike '%status = ''active''%' then
    raise exception 'a reversed allocation must never classify a payment as linked';
  end if;

  -- ── THE WHOLE PRIVILEGE PICTURE, NOT A SAMPLE OF IT ──
  --
  -- These caught a real deployment difference once already: on a platform whose
  -- default privileges grant `arwdDxt` on every new table AND VIEW to the client
  -- roles, a revoke that names only `public, anon` leaves `authenticated`
  -- holding INSERT, UPDATE and DELETE. So the check is now the FULL matrix —
  -- all seven privileges, both client roles, plus PUBLIC — rather than the three
  -- that happened to be thought of.

  -- Reachable by authenticated …
  if not has_table_privilege('authenticated', 'public.finance_received_payments', 'select') then
    raise exception 'the projection must be readable by authenticated';
  end if;

  -- … and SELECT is the ONLY thing it may do.
  for v_bool in
    select has_table_privilege('authenticated', 'public.finance_received_payments', pr)
    from unnest(array['insert', 'update', 'delete',
                      'truncate', 'references', 'trigger']) as pr
  loop
    if v_bool then
      raise exception 'the projection is read-only; no write privilege may exist on it';
    end if;
  end loop;

  -- anon holds nothing at all — not read, not write.
  for v_bool in
    select has_table_privilege('anon', 'public.finance_received_payments', pr)
    from unnest(array['select', 'insert', 'update', 'delete',
                      'truncate', 'references', 'trigger']) as pr
  loop
    if v_bool then
      raise exception 'anon must hold no privilege of any kind on the projection';
    end if;
  end loop;

  -- AND NEITHER DOES PUBLIC. has_table_privilege() cannot be asked about PUBLIC,
  -- so this reads the ACL itself: grantee 0 is PUBLIC, and it must have no entry.
  -- Without this, a privilege granted to everyone would satisfy both loops above
  -- by being invisible to them.
  select coalesce(array_agg(distinct a.privilege_type order by a.privilege_type), '{}')
    into v_cols
  from pg_class c
  cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) as a
  where c.oid = 'public.finance_received_payments'::regclass
    and a.grantee = 0;
  if v_cols <> '{}'::text[] then
    raise exception
      'PUBLIC must hold no privilege on the projection, found: %',
      array_to_string(v_cols, ', ');
  end if;

  -- IT CHANGES NO POLICY AND NO LEDGER COLUMN. The payment rows are untouched:
  -- the invariant that decides linked/unlinked in the LEDGER still stands
  -- exactly as 20260692000000 wrote it.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'finance_payment_requests'
      and c.conname = 'finance_payment_requests_status_order_invariant'
      and c.convalidated
  ) then
    raise exception
      'the deployed approved_linked/order_id invariant must be left exactly as it is';
  end if;

  -- And the conversion still does not touch the parent payment.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_order_submission'
      and pg_get_functiondef(p.oid) ilike '%update public.finance_payment_requests%'
  ) then
    raise exception 'approving a PI must never write the payment ledger';
  end if;

  raise notice 'Phase 3 verified-payment gate: all assertions passed';
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK, for the record
-- ═════════════════════════════════════════════════════════════════════════════
--
-- There is no automatic down migration, deliberately: undoing this would mean
-- restoring an approval rule that lets an Order be numbered against money nobody
-- received. If it must be reverted before any PI has been approved under it:
--
--   1. restore approve_order_submission(uuid) and
--      finance_payment_allocations_guard_transition() from 20260915000000 and
--      20260918000000 respectively, verbatim;
--   2. restore pi_submission_payment_summary(uuid) and
--      log_finance_payment_allocation_activity() from 20260919000000 and
--      20260918000000;
--   3. drop public.submit_pi_for_review(uuid, text, text, text, text) and
--      public.submit_pi_for_review_internal(uuid, text, text, text, text);
--   4. restore allocate_payment_to_target_internal(uuid, uuid, uuid, numeric),
--      resolve_test_data_cleanup_chain(text, uuid),
--      order_submissions_guard_advance_exception(),
--      approve_pi_advance_exception(uuid) and
--      reject_pi_advance_exception(uuid, text) from 20260919000000 and
--      20260913000000 respectively, verbatim;
--   5. drop view public.finance_received_payments — it stores nothing and
--      nothing depends on it, so a plain DROP (no CASCADE) loses no data; but
--      the two Received Payments pages, the sidebar counters, the received
--      deep-link resolver and the Admin Action Queue's suspense item must be
--      pointed back at public.finance_payment_requests in the same deploy or
--      they will 404 — and they then classify from the parent columns again,
--      which is the inconsistency §8a exists to remove;
--   6. drop the four order_submissions.advance_exception_decided_* columns and
--      the order_submissions_exception_basis_scope constraint, and
--      drop public.order_submission_exception_current(...);
--   7. leave order_submissions.payment_terms / billing_terms in place — they
--      hold agreed commercial terms and dropping them destroys business data.
--
-- REAPPLICATION IS CLEAN. Every statement in this file is CREATE OR REPLACE,
-- ADD COLUMN on a column that does not exist, ADD CONSTRAINT on a constraint
-- that does not exist, ALTER TYPE ... ADD VALUE IF NOT EXISTS, or the one plain
-- CREATE VIEW in §8a — which step 5 above drops, so the name is free again.
-- Re-running the file over a rolled-back database therefore lands in the same
-- state; re-running it over an already-applied one fails loudly on the duplicate
-- column rather than half-applying, which is the intended behaviour for a
-- migration runner that tracks what it has run.
--
-- CREATE VIEW, NOT CREATE OR REPLACE VIEW, and that is the safer of the two: if
-- anything already holds that name the migration stops instead of silently
-- redefining somebody else's object, and CREATE OR REPLACE could not change the
-- column list anyway.
--
-- ON RE-APPLY THE PLATFORM'S DEFAULT PRIVILEGES LAND ON THE NEW VIEW AGAIN —
-- `arwdDxt` for anon, authenticated and service_role — and §8a's explicit
-- REVOKE ALL … / GRANT SELECT removes them again, in that order. The final ACL
-- is therefore the same on every apply and on every kind of cluster: SELECT for
-- authenticated, nothing for anon, nothing for PUBLIC.
--
-- Allocations already MOVED onto an Order are not reversible by any of that, and
-- must not be: the Order is numbered, the money is against it, and putting it
-- back on a PI that no longer exists as a PI would be the corruption this phase
-- was built to prevent.
