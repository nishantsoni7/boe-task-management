-- ═════════════════════════════════════════════════════════════════════════════
-- order_linked_payment_total: count the money that reached the Order
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT
-- ----------
-- The function reads:
--
--     select coalesce(sum(amount), 0)
--       from public.finance_payment_requests
--      where order_id = p_order_id
--        and status = 'approved_linked';
--
-- It was written in 20260816000000, before allocations existed, when the ONLY
-- way money reached an Order was a legacy `order_id` link. Two things have
-- happened since, and it learned neither:
--
--   1. PI CONVERSION MOVES AN ALLOCATION, NOT A PAYMENT. approve_order_submission()
--      (20260921000000) repoints the PI's allocation onto the new Order and
--      deliberately leaves the ledger row alone: its proof, its verification and
--      its Finance history stay where they are, so it still carries
--      `order_id = NULL`. This function sees none of that money.
--
--   2. `approved_unlinked` IS VERIFIED MONEY. finance_payment_status_is_verified()
--      (20260918000000 §5) counts both approved statuses, and the Order detail
--      screen has counted both since Phase 3. Whether a verified payment also
--      carries a legacy order_id is a Finance bookkeeping detail that says
--      nothing about whether the client paid.
--
-- WHAT THAT LOOKS LIKE TO A PERSON
-- --------------------------------
-- On an Order created by approving a PI, the Cancel dialog says
--
--     "No payments have been received against this order."
--
-- while the Payment Summary a few centimetres above it shows lakhs verified. The
-- comment on the calling hook states the exact purpose this defeats: "Cancelling
-- an order while misinformed about the money on it is the specific mistake this
-- prevents." For PI-originated Orders — which is every Order the current flow
-- creates — the safeguard was inverted into a reassurance.
--
-- The same figure is recorded into the cancellation's activity payload as
-- `received_at_cancellation`, so the audit trail has been storing 0 for Orders
-- that had been substantially paid.
--
-- WHY THIS IS A FIX AND NOT A RULE CHANGE
-- ---------------------------------------
-- IT GATES NOTHING. Both callers — cancel_order() in 20260816000000 and the
-- rebuilt one in 20260819000000 — read it into `v_received` and use it for
-- exactly one thing: a value in the activity log. No branch, no refusal, no
-- approval, no numbering. Nothing anywhere depends on the value being what it
-- has been; grep for the function name confirms the only other reader is the
-- Cancel dialog's warning.
--
-- So the change is: the warning tells the truth, and the audit trail records the
-- truth. What "received" MEANS is not being redefined here — it is being made to
-- agree with the definition the Order screen, the PI card and
-- pi_submission_payment_summary() already share.
--
-- WHY THE FUNCTION IS FIXED RATHER THAN JOINED BY A COMPANION
-- -----------------------------------------------------------
-- A second `order_received_payment_total()` would leave two functions answering
-- one question, and the wrong one still wired into the audit trail. That is a
-- duplicate source of financial truth, which is the thing this whole phase
-- exists to remove. The signature, the return type, the volatility, the security
-- context and the grants are all unchanged, so every existing caller keeps
-- working without being touched.
--
-- SECURITY: UNCHANGED. Still SECURITY DEFINER with `set search_path`, still
-- executable only by `authenticated`. It is a definer ON PURPOSE — a
-- salesperson's RLS does not show every payment on an Order, and being
-- misinformed about the money is precisely the hazard. It reveals one aggregate
-- and no rows, exactly as before; it now reveals a CORRECT aggregate.
--
-- NO NEW INDEX. The allocation branch is keyed on order_id where status =
-- 'active', which is finance_payment_allocations_order_idx together with the
-- status predicate (20260918000000). The legacy branch is unchanged.
--
-- FORWARD-ONLY. Edits no applied file.

begin;

create or replace function public.order_linked_payment_total(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- THE LEGACY LINK, exactly as before: payments carrying this Order's id.
  --
  -- The status test widens from 'approved_linked' to both verified statuses,
  -- through the same predicate every other surface uses. A payment carrying an
  -- order_id can only be approved_linked in practice — the CHECK
  -- finance_payment_requests_approved_linked_requires_order_id ties the two —
  -- so this branch's result does not actually change. It is expressed this way
  -- so that ONE definition of "verified" appears here, not two.
  select coalesce((
    select sum(f.amount)
      from public.finance_payment_requests f
     where f.order_id = p_order_id
       and public.finance_payment_status_is_verified(f.status)
  ), 0)
  +
  -- THE ALLOCATIONS, which is how a PI's money arrives. Summed at the
  -- ALLOCATED figure and not the ledger amount: a payment may legitimately be
  -- split across targets, and summing the whole amount would credit this Order
  -- with money that is not its own. That is the same rule the Order detail
  -- screen applies (src/lib/finance/orderFinancePosition.ts) and the same one
  -- pi_submission_payment_summary() applies to a PI.
  --
  -- ACTIVE ALLOCATIONS ONLY, and the PARENT payment must be verified. A
  -- reversed allocation is a withdrawn claim; an unverified payment is money
  -- the client says they sent, which is a different fact from money that
  -- arrived.
  --
  -- NOT DOUBLE-COUNTED. A row satisfies the first branch only if it carries
  -- order_id, and the second only through an allocation naming this Order. The
  -- exclusion below makes the two disjoint even for a payment that somehow has
  -- both — which a backfill could produce — so no rupee is counted twice.
  coalesce((
    select sum(a.allocated_amount)
      from public.finance_payment_allocations a
      join public.finance_payment_requests f on f.id = a.payment_request_id
     where a.order_id = p_order_id
       and a.status = 'active'
       and public.finance_payment_status_is_verified(f.status)
       and (f.order_id is distinct from p_order_id)
  ), 0);
$$;

comment on function public.order_linked_payment_total(uuid) is
  'Rupees of VERIFIED money that have reached one Confirmed Order: payments carrying its order_id, plus the allocated figure of every ACTIVE allocation naming it whose parent payment is verified. The two are disjoint, so a payment that is both linked and allocated is counted once. Counts both approved statuses — approved_unlinked is verified money, and whether it also carries a legacy order_id is Finance bookkeeping. Reversed allocations and unverified payments count as zero. SECURITY DEFINER on purpose: a salesperson''s RLS does not show every payment on an Order, and cancelling one while misinformed about the money is the mistake this prevents. Reports; gates nothing.';

revoke execute on function public.order_linked_payment_total(uuid) from public, anon;
grant  execute on function public.order_linked_payment_total(uuid) to authenticated;

-- ═══ Apply-time assertions ══════════════════════════════════════════════════

do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'order_linked_payment_total';

  if v_def is null then
    raise exception 'order_linked_payment_total is missing';
  end if;

  -- Still a definer, still search_path-pinned. Losing either would change who
  -- the aggregate is computed for, or let a caller-controlled search_path decide
  -- which tables it reads.
  if v_def !~* 'security definer' then
    raise exception 'order_linked_payment_total must remain SECURITY DEFINER';
  end if;
  if v_def !~ 'search_path' then
    raise exception 'order_linked_payment_total must pin its search_path';
  end if;

  -- It now reads the allocations. Without this branch the function is blind to
  -- every rupee a PI conversion moved.
  if v_def !~ 'finance_payment_allocations' then
    raise exception 'order_linked_payment_total must count active allocations';
  end if;

  -- And states "verified" through the shared predicate rather than restating it.
  if v_def !~ 'finance_payment_status_is_verified' then
    raise exception 'order_linked_payment_total must use the shared verified predicate';
  end if;

  -- The grants are what they were.
  if not has_function_privilege('authenticated', 'public.order_linked_payment_total(uuid)', 'execute') then
    raise exception 'authenticated must retain EXECUTE on order_linked_payment_total';
  end if;
  if has_function_privilege('anon', 'public.order_linked_payment_total(uuid)', 'execute') then
    raise exception 'anon must not hold EXECUTE on order_linked_payment_total';
  end if;

  -- The index the allocation branch rides on.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'finance_payment_allocations'
      and indexname = 'finance_payment_allocations_order_idx'
  ) then
    raise exception 'finance_payment_allocations_order_idx is required by the allocation branch';
  end if;
end $$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Re-run 20260816000000's definition of the function verbatim (a bare
-- `order_id = p_order_id and status = 'approved_linked'` sum), then re-apply
-- 20260818000000's `alter function ... set search_path = public, pg_temp`.
--
-- Nothing else in this file needs undoing: no table, column, policy, index,
-- trigger or other function was created, altered or dropped, and no data was
-- written. Rolling back restores the defect described above — the Cancel dialog
-- would again tell a salesperson that a substantially paid PI-originated Order
-- has received nothing.
