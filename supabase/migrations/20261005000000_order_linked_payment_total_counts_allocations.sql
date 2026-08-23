-- ═════════════════════════════════════════════════════════════════════════════
-- order_linked_payment_total: the canonical attribution rule
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT
-- ----------
-- The function as shipped in 20260816000000 reads:
--
--     select coalesce(sum(amount), 0)
--       from public.finance_payment_requests
--      where order_id = p_order_id
--        and status = 'approved_linked';
--
-- It was written before allocations existed, when the only way money reached an
-- Order was a legacy `order_id` link, and it learned neither of the two things
-- that happened since:
--
--   1. PI CONVERSION MOVES AN ALLOCATION, NOT A PAYMENT. approve_order_submission()
--      repoints the PI's allocation onto the new Order and deliberately leaves
--      the ledger row alone, so it still carries `order_id = NULL`. This
--      function sees none of that money.
--
--   2. `approved_unlinked` IS VERIFIED MONEY. finance_payment_status_is_verified()
--      (20260918000000 §5) counts both approved statuses.
--
-- AND A THIRD, WHICH IS WHY THIS FILE WAS REWRITTEN BEFORE BEING APPLIED.
-- The first correction simply added the allocations to the legacy sum, keeping
-- "the legacy link wins" for any payment that carried one. That is
-- arithmetically unsound the moment BOTH exist — and both can:
-- allocate_payment_to_target() refuses a rejected payment, a duplicate active
-- allocation and an over-capacity one, but it does NOT refuse a payment that
-- already carries an order_id.
--
-- So a ₹10,00,000 payment linked to Order X and allocated ₹4,00,000 to Order Y
-- was credited ₹10,00,000 to X *and* ₹4,00,000 to Y: ₹14,00,000 of attribution
-- for ₹10,00,000 of money, with the entire overstatement landing on the Order
-- that had actually received nothing.
--
-- THE CANONICAL RULE, applied identically here and in
-- src/lib/finance/paymentAttribution.ts:
--
--   1. If a payment has ANY active allocation, allocations are authoritative.
--      Each Order or PI receives only its own active allocated share, and the
--      direct linkage is ignored entirely — including when it names the same
--      Order.
--   2. If it has NO active allocation, the direct linkage attributes the WHOLE
--      payment to the Order it names.
--   3. Reversed allocations are withdrawn claims and count for nothing, so a
--      payment whose only allocation was reversed falls back to rule 2.
--   4. What is left after active allocations is unallocated.
--   5. Attribution summed across every target, plus what is unallocated, is
--      exactly the payment amount — never more.
--
-- WHY THIS FUNCTION IS REPLACED RATHER THAN JOINED BY A COMPANION
-- ---------------------------------------------------------------
-- A second function would leave two answers to one question, with the wrong one
-- still wired into the cancellation audit trail. The signature, return type,
-- volatility, security context and grants are unchanged, so every existing
-- caller keeps working untouched.
--
-- IT GATES NOTHING. Both callers — cancel_order() in 20260816000000 and the
-- rebuilt one in 20260819000000 — read it into `v_received` and use it for
-- exactly one thing: a value in the activity log. No branch, no refusal, no
-- approval, no numbering. So what "received" MEANS is not being redefined; it is
-- being made to agree with the definition every screen now shares.
--
-- SECURITY: UNCHANGED. Still SECURITY DEFINER with a pinned search_path, still
-- executable only by `authenticated`. A definer ON PURPOSE — a salesperson's RLS
-- does not show every payment on an Order, and being misinformed about the money
-- while cancelling is the hazard. It reveals one aggregate and no rows.
--
-- NO NEW INDEX. Both allocation lookups are keyed on payment_request_id where
-- status = 'active' — finance_payment_allocations_payment_active_idx — and the
-- candidate scan uses finance_payment_allocations_order_idx. Both exist
-- (20260918000000) and are asserted below.
--
-- FORWARD-ONLY. Edits no applied file.

begin;

-- ═══ 1. The whole-payment fact, for callers that can only see one target ════
--
-- WHY THIS EXISTS. Rule 1 turns on whether a payment has active allocations
-- ELSEWHERE — a fact no single Order screen can establish for itself. It reads
-- only the allocations naming it, and RLS would not show it an allocation onto
-- somebody else's Order in any case. Without this, the Order screen must either
-- guess (which is the defect) or withhold the fallback from every payment
-- (which under-reports case A, the ordinary one).
--
-- WHAT IT REVEALS, AND TO WHOM. One number per payment: how much of it is
-- actively allocated. Not to whom, not in what shares, not how many allocations.
-- And only for a payment the caller may ALREADY read — every id is gated
-- individually by can_read_payment_as_participant() (20260919000000), the same
-- predicate the payment's own RLS policy uses, with the admin and
-- finance.view_all short-circuits those policies already grant.
--
-- SECURITY DEFINER is required and is the narrowest possible: the aggregate must
-- see allocations the caller cannot, or it would return the same partial answer
-- the caller could compute alone. The per-id gate is what keeps that from being
-- a widening — a caller learns nothing about a payment they could not open.
--
-- BATCHED BY DESIGN. It takes an array so a screen showing fifty payments asks
-- once, not fifty times.

create or replace function public.payment_active_allocation_totals(p_payment_ids uuid[])
returns table (payment_request_id uuid, active_total numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    f.id,
    coalesce((
      select sum(a.allocated_amount)
        from public.finance_payment_allocations a
       where a.payment_request_id = f.id
         and a.status = 'active'
    ), 0)
  from public.finance_payment_requests f
  where f.id = any(coalesce(p_payment_ids, '{}'::uuid[]))
    -- THE GATE. A payment the caller cannot read yields no row at all, so this
    -- function can never be used to probe for the existence of one.
    and public.can_read_payment_as_participant(f.id);
$$;

comment on function public.payment_active_allocation_totals(uuid[]) is
  'For each payment the CALLER MAY ALREADY READ, the total of its ACTIVE allocations — one number, not the split and not the targets. Exists because the canonical attribution rule turns on whether a payment has allocations elsewhere, which no single Order screen can see for itself. SECURITY DEFINER so the aggregate is complete, gated per id by can_read_payment_as_participant so it reveals nothing about a payment the caller could not open. Reversed allocations count as zero. Batched: pass every id on the screen at once.';

revoke execute on function public.payment_active_allocation_totals(uuid[]) from public, anon;
grant  execute on function public.payment_active_allocation_totals(uuid[]) to authenticated;

-- ═══ 2. The Order's attributed total ════════════════════════════════════════

create or replace function public.order_linked_payment_total(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    -- Every VERIFIED payment that could be attributed to this Order at all:
    -- one the Order's own id names, or one an active allocation names it from.
    -- A payment whose only allocation to this Order was reversed is not a
    -- candidate through that route, which is rule 3.
    select f.id, f.amount, f.order_id
      from public.finance_payment_requests f
     where public.finance_payment_status_is_verified(f.status)
       and (
         f.order_id = p_order_id
         or exists (
           select 1
             from public.finance_payment_allocations a
            where a.payment_request_id = f.id
              and a.status = 'active'
              and a.order_id = p_order_id
         )
       )
  ),
  shares as (
    select
      c.id,
      c.amount,
      c.order_id,
      -- Every active allocation against this payment, wherever it points. This
      -- is the fact rule 1 turns on.
      coalesce((
        select sum(a.allocated_amount)
          from public.finance_payment_allocations a
         where a.payment_request_id = c.id
           and a.status = 'active'
      ), 0) as active_total,
      -- Only the ones naming THIS Order.
      coalesce((
        select sum(a.allocated_amount)
          from public.finance_payment_allocations a
         where a.payment_request_id = c.id
           and a.status = 'active'
           and a.order_id = p_order_id
      ), 0) as own_total
    from candidates c
  )
  select coalesce(sum(
    case
      -- RULE 1. Allocations exist, so allocations decide — and this Order's
      -- share is legitimately ZERO when the money went somewhere else. The
      -- direct linkage contributes nothing here, which is the whole correction.
      when s.active_total > 0        then s.own_total
      -- RULE 2. No active allocation anywhere: the direct linkage attributes
      -- the whole payment to the Order it names.
      when s.order_id = p_order_id   then s.amount
      else 0
    end
  ), 0)
  from shares s;
$$;

comment on function public.order_linked_payment_total(uuid) is
  'Rupees of VERIFIED money attributed to one Confirmed Order under the canonical rule: if the payment has ANY active allocation, this Order receives only its own active allocated share and the payment''s direct order_id is ignored entirely; if it has none, the direct link attributes the whole payment. Reversed allocations count as zero, so a payment whose only allocation was reversed falls back to its link. Attribution summed across every Order and PI, plus what is unallocated, equals the payment exactly — it can never exceed it. Mirrored exactly by src/lib/finance/paymentAttribution.ts. SECURITY DEFINER on purpose: a salesperson''s RLS does not show every payment on an Order, and cancelling one while misinformed about the money is the mistake this prevents. Reports; gates nothing.';

revoke execute on function public.order_linked_payment_total(uuid) from public, anon;
grant  execute on function public.order_linked_payment_total(uuid) to authenticated;

-- ═══ 3. Apply-time assertions ═══════════════════════════════════════════════
--
-- The migration refuses itself rather than shipping a rule that is wrong in a
-- way nobody would notice until money had been reported.

do $$
declare
  v_def text;
begin
  -- 3a. Shape and security of the attribution function.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'order_linked_payment_total';

  if v_def is null then
    raise exception 'order_linked_payment_total is missing';
  end if;
  if v_def !~* 'security definer' then
    raise exception 'order_linked_payment_total must remain SECURITY DEFINER';
  end if;
  if v_def !~ 'search_path' then
    raise exception 'order_linked_payment_total must pin its search_path';
  end if;
  if v_def !~ 'finance_payment_allocations' then
    raise exception 'order_linked_payment_total must count active allocations';
  end if;
  if v_def !~ 'finance_payment_status_is_verified' then
    raise exception 'order_linked_payment_total must use the shared verified predicate';
  end if;
  -- The canonical rule's shape: the allocation branch must be tested BEFORE the
  -- direct-link branch, or the link wins again and the defect returns.
  if position('active_total > 0' in v_def) = 0
     or position('active_total > 0' in v_def) > position('s.order_id = p_order_id' in v_def) then
    raise exception
      'order_linked_payment_total must prefer active allocations over the direct link';
  end if;

  -- 3b. The batched whole-payment helper, and its gate.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'payment_active_allocation_totals';

  if v_def is null then
    raise exception 'payment_active_allocation_totals is missing';
  end if;
  if v_def !~ 'can_read_payment_as_participant' then
    raise exception
      'payment_active_allocation_totals must gate every id on readability';
  end if;

  -- 3c. Grants, exactly as they were.
  if not has_function_privilege('authenticated', 'public.order_linked_payment_total(uuid)', 'execute') then
    raise exception 'authenticated must retain EXECUTE on order_linked_payment_total';
  end if;
  if has_function_privilege('anon', 'public.order_linked_payment_total(uuid)', 'execute') then
    raise exception 'anon must not hold EXECUTE on order_linked_payment_total';
  end if;
  if has_function_privilege('anon', 'public.payment_active_allocation_totals(uuid[])', 'execute') then
    raise exception 'anon must not hold EXECUTE on payment_active_allocation_totals';
  end if;

  -- 3d. The indexes both functions ride on.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'finance_payment_allocations'
      and indexname = 'finance_payment_allocations_payment_active_idx'
  ) then
    raise exception 'finance_payment_allocations_payment_active_idx is required';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'finance_payment_allocations'
      and indexname = 'finance_payment_allocations_order_idx'
  ) then
    raise exception 'finance_payment_allocations_order_idx is required';
  end if;
end $$;

-- ═══ 4. Where the rule is proved against rows ═══════════════════════════════
--
-- NOT HERE, DELIBERATELY. Examples A–F are executed in
-- supabase/tests/payment_attribution_assertions.sql, against the same fixtures
-- src/lib/finance/attributionFixtures.ts feeds the TypeScript side, so the two
-- implementations are compared on identical data.
--
-- A migration must not insert fixtures into finance_payment_requests or
-- finance_payment_allocations even inside a transaction it rolls back: the
-- inserts would fire the capacity, activity-log and guard triggers against live
-- tables, and a ROLLBACK does not undo a sequence advance. The assertions above
-- check the SHAPE of the rule, which is all a migration should assert about
-- itself; the BEHAVIOUR is proved by the assertion file, on a database where
-- writing fixtures is the point.

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
--   drop function if exists public.payment_active_allocation_totals(uuid[]);
--
-- then re-run 20260816000000's definition of order_linked_payment_total (a bare
-- `order_id = p_order_id and status = 'approved_linked'` sum) and re-apply
-- 20260818000000's `alter function ... set search_path = public, pg_temp`.
--
-- Nothing else needs undoing: no table, column, policy, index, trigger or other
-- function was created, altered or dropped, and no data was written. Rolling
-- back restores the defect above — a substantially paid PI-originated Order
-- reporting that it has received nothing, and a payment counted twice when it
-- carries both a direct link and an allocation.
