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
-- SECURITY: UNCHANGED FOR THIS FUNCTION. order_linked_payment_total stays
-- SECURITY DEFINER with a pinned search_path, executable only by `authenticated`.
-- A definer ON PURPOSE — a salesperson's RLS does not show every payment on an
-- Order, and being misinformed about the money while cancelling is the hazard.
-- It reveals one aggregate and no rows.
--
-- The helper added in §1 is deliberately the opposite — SECURITY INVOKER — and
-- §1 explains at length why a definer cannot be gated soundly here. The two are
-- not inconsistent: order_linked_payment_total takes an Order id and returns one
-- number to a caller who is cancelling that Order, while the helper takes
-- caller-supplied payment ids and must answer only for the ones that caller may
-- read. Only the second needs a per-row gate, and RLS is the only gate that
-- cannot drift from the policies it stands for.
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
-- ELSEWHERE — a fact no single Order screen can establish from its own reads. It
-- sees only the allocations naming it, so without this it must either guess
-- (which is the defect) or withhold the fallback from every payment (which
-- under-reports case A, the ordinary one).
--
-- SECURITY INVOKER, AND THAT IS THE WHOLE DESIGN
-- ----------------------------------------------
-- An earlier draft of this function was SECURITY DEFINER, gated per id by
-- can_read_payment_as_participant(). That was wrong twice over, and both faults
-- are the reason this section is written the way it is.
--
--   1. A DEFINER CANNOT ASK RLS — IT CAN ONLY RESTATE IT. Inside a SECURITY
--      DEFINER function current_user is the owner, so RLS on every table it
--      touches is evaluated for the OWNER, not the caller. That is not confined
--      to the function's own body: a SECURITY INVOKER helper called from inside
--      a definer also runs as the definer, so can_view_order() — the repository's
--      canonical "may this viewer view this Order", invoker precisely so that it
--      ASKS the orders policies rather than restating them (20260924000000 §1) —
--      silently degenerates to `the Order exists` when nested inside one. Any
--      gate written for a definer must therefore be a RESTATEMENT of the read
--      rule, and this repository's settled position is that the Orders
--      visibility rule is never restated, because a second copy drifts silently
--      and in the permissive direction.
--
--   2. THE PARTICIPANT PREDICATE IS NOT THE READ RULE. can_read_payment_as_participant()
--      is true only when an allocation attaches the payment to a PI or Order the
--      caller can open. It is ONE of six permissive SELECT policies on
--      finance_payment_requests — it does not include the submitter, the admin,
--      finance.view_all or the order-request paths — and it is false for EVERY
--      caller when a payment has no allocation rows at all. That last case is
--      worked example A, the ordinary direct-linked payment: gating on it
--      returned no row for anybody, so the screen withheld the fallback and
--      reported ₹0 for money the Order had actually received.
--
-- So this function ASKS instead. As SECURITY INVOKER, `from
-- public.finance_payment_requests` is filtered by that table's own policies —
-- all six permissive ones and the RESTRICTIVE module gate, exactly as the caller
-- would get reading it directly. A payment the caller may not read yields no
-- row, so the function is not an existence oracle; a payment they may read
-- yields exactly one row, whoever they are and however they came to it. Nothing
-- is restated, so nothing can drift: a policy changed tomorrow changes this the
-- same day.
--
-- WHY IT DOES NOT NEED TO BE A DEFINER, WHICH IS THE PART WORTH CHECKING
-- ---------------------------------------------------------------------
-- The worry a definer was reaching for is real: the caller's own sight of
-- finance_payment_allocations may be PARTIAL. Its five SELECT policies split in
-- two — admin, finance.view_all and the payment's submitter are anchored on the
-- PAYMENT and so show every allocation of it; the PI- and Order-participant
-- policies are anchored on the TARGET and show only allocations naming a record
-- the caller can open. Work the two cases through:
--
--   * The caller sees at least one active allocation. `active_total > 0`, so
--     rule 1 fires — which is the correct branch — and the share it produces is
--     this Order's OWN allocations, which such a caller sees completely: the
--     order-participant policy shows every allocation naming an Order they can
--     open. A partial whole-payment figure cannot change the branch or the
--     share.
--
--   * The caller sees none. Now `0` is ambiguous — genuinely unallocated, or
--     allocated somewhere they cannot see — and rule 2 would attribute the WHOLE
--     payment on the strength of it. That is the over-attribution this release
--     exists to remove, so the ambiguity is NOT resolved by guessing: the
--     function returns NULL unless the caller holds a payment-anchored sight,
--     and NULL is the input paymentAttribution.ts already treats as `we could
--     not determine this`, withholding the fallback. Under-states, never over.
--
-- NULL IS A STATEMENT ABOUT THE READER, NOT THE MONEY, and it is deliberately
-- not zero — the same distinction paymentAllocations.ts refuses to collapse.
--
-- The completeness test is one call to actor_has_module_permission('finance',
-- 'view_all'), which is auth.uid()-based and therefore sound in any context,
-- plus the submitter's own id. It is STRICTER than the allocation policies it
-- stands for — those admit an admin row whatever its is_active/is_deleted flags,
-- this one requires an active, non-deleted admin — and stricter means a NULL
-- where a figure was available, which under-states. It is a claim about how much
-- of the table the reader can see, not an authorization decision: no row is
-- shown or hidden by it.
--
-- BATCHED BY DESIGN. It takes an array so a screen showing fifty payments asks
-- once, not fifty times. Duplicates in that array cannot duplicate a total —
-- the row source is the payment table, scanned once, not the array unnested.

create or replace function public.payment_active_allocation_totals(p_payment_ids uuid[])
returns table (payment_request_id uuid, active_total numeric)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    f.id,
    case
      -- Complete, because the reader holds a PAYMENT-anchored sight of the
      -- allocation table: they see every allocation of this payment.
      when public.actor_has_module_permission('finance', 'view_all')
        or f.submitted_by = auth.uid()
        then coalesce(v.visible_total, 0)
      -- Partial but non-zero still settles rule 1, and the share rule 1 produces
      -- is this Order's own allocations, which such a reader sees in full.
      when coalesce(v.visible_total, 0) > 0
        then v.visible_total
      -- Nothing visible and no payment-anchored sight: unknowable, not zero.
      else null::numeric
    end
  from public.finance_payment_requests f
  left join lateral (
    select sum(a.allocated_amount) as visible_total
      from public.finance_payment_allocations a
     where a.payment_request_id = f.id
       and a.status = 'active'
  ) v on true
  -- RLS ON public.finance_payment_requests IS THE GATE. Not restated here, and
  -- deliberately not restatable: it is asked, per row, for every id supplied.
  where f.id = any(coalesce(p_payment_ids, '{}'::uuid[]));
$$;

comment on function public.payment_active_allocation_totals(uuid[]) is
  'For each payment the CALLER MAY ALREADY READ, the total of its ACTIVE allocations — one number, not the split and not the targets. Exists because the canonical attribution rule turns on whether a payment has allocations elsewhere, which no single Order screen can see for itself. SECURITY INVOKER on purpose: the payment table''s own RLS decides which ids are answerable, so the read rule is asked rather than restated and cannot drift, and an unreadable payment yields no row at all. Returns NULL — never 0 — when the caller cannot see enough of the allocation table to be sure, so the caller withholds the direct-link fallback instead of guessing. Reversed allocations count as zero. Batched: pass every id on the screen at once; duplicates cannot duplicate a total.';

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

  -- 3b. The batched whole-payment helper. Its gate is RLS, so what has to be
  -- asserted is that nothing has quietly turned it into a definer — which would
  -- bypass that gate entirely and hand every caller every payment's total.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'payment_active_allocation_totals';

  if v_def is null then
    raise exception 'payment_active_allocation_totals is missing';
  end if;
  if v_def ~* 'security definer' then
    raise exception
      'payment_active_allocation_totals must be SECURITY INVOKER: as a definer it bypasses the payment RLS that is its only gate';
  end if;
  if v_def !~ 'search_path' then
    raise exception 'payment_active_allocation_totals must pin its search_path';
  end if;
  if v_def !~ 'finance_payment_requests' then
    raise exception
      'payment_active_allocation_totals must select from the payment table, whose RLS is the gate';
  end if;
  -- The ambiguity must resolve to NULL and never to 0: a zero the caller cannot
  -- vouch for would let the direct-link fallback fire and restore the
  -- over-attribution this migration exists to remove.
  if v_def !~ 'null::numeric' then
    raise exception
      'payment_active_allocation_totals must return NULL, not 0, when the caller cannot see the whole allocation set';
  end if;
  if v_def !~ 'actor_has_module_permission' then
    raise exception
      'payment_active_allocation_totals must test completeness with the shared, auth.uid()-based permission helper';
  end if;

  -- The one function it must NOT rely on. can_read_payment_as_participant() is
  -- a definer whose Order branch is a bare EXISTS on public.orders, so nested in
  -- another definer it degenerates to 'the Order exists'; and it is only one of
  -- the payment table's six permissive SELECT policies, false for every caller
  -- when a payment has no allocations at all.
  if v_def ~ 'can_read_payment_as_participant' then
    raise exception
      'payment_active_allocation_totals must not gate on can_read_payment_as_participant: it is neither the read rule nor sound inside a definer';
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
  if has_function_privilege('public', 'public.payment_active_allocation_totals(uuid[])', 'execute') then
    raise exception 'PUBLIC must not hold EXECUTE on payment_active_allocation_totals';
  end if;
  if not has_function_privilege('authenticated', 'public.payment_active_allocation_totals(uuid[])', 'execute') then
    raise exception 'authenticated must hold EXECUTE on payment_active_allocation_totals';
  end if;
  -- The invoker reads two tables under the caller's own rights, so the caller
  -- must actually hold SELECT on both or the function errors instead of
  -- returning a gated answer.
  if not has_table_privilege('authenticated', 'public.finance_payment_requests', 'select') then
    raise exception 'authenticated must hold SELECT on finance_payment_requests';
  end if;
  if not has_table_privilege('authenticated', 'public.finance_payment_allocations', 'select') then
    raise exception 'authenticated must hold SELECT on finance_payment_allocations';
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
