-- ═════════════════════════════════════════════════════════════════════════════
-- Finance: how much of a payment has been given a home
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS, AND WHY IT HAS TO BE IN THE DATABASE
-- ---------------------------------------------------
-- Two columns on public.finance_received_payments:
--
--   allocated_total    the sum of a payment's ACTIVE allocations, in numeric
--   allocation_state   unallocated | partial | full | over
--
-- Finance needs to find the money that still needs somebody to act on it: the
-- payments with nothing pointing at them, and the ones only partly spoken for.
-- That question has no answer on any Order screen — an Order reads only its OWN
-- allocations, so "the rest of this payment" is, from there, money it knows
-- nothing about.
--
-- IT CANNOT BE ANSWERED IN THE BROWSER. The Received Payments list is PAGED
-- (20261004 is the first migration after that change shipped). A state computed
-- over the fifty rows in hand would narrow those fifty and silently hide every
-- match on page two — the same class of defect the paging was introduced to end.
-- A filter must be a database predicate or it is not a filter.
--
-- AND IT MUST NOT BE A SECOND LEDGER. No column is added to any TABLE. Nothing
-- is stored, nothing is denormalised, and no trigger keeps a total in step with
-- the rows it is a total of. This is a projection over
-- finance_payment_allocations, which remains the only record of what money
-- belongs to, computed at read time in `numeric` — the same type, and therefore
-- the same arithmetic, as pi_submission_payment_summary() and every other
-- financial figure in this system.
--
-- WHAT IS DELIBERATELY NOT ADDED
-- ------------------------------
-- No allocation id, no per-target split, no list of what a payment is allocated
-- TO. 20260921000000 §8a states that boundary and this keeps it: the projection
-- says how much, never to whom. A caller that needs the split reads
-- finance_payment_allocations under its own RLS, which is what the Received
-- Payments detail modal already does.
--
-- SECURITY: UNCHANGED, AND THAT IS LOAD-BEARING
-- ---------------------------------------------
-- The view stays SECURITY INVOKER. Every reference inside it — including the new
-- aggregate over finance_payment_allocations — is evaluated as the CALLER, so it
-- can show nothing the base tables would not.
--
-- THE CONSEQUENCE THE APPLICATION MUST RESPECT. Because the sum is evaluated as
-- the caller, a reader who may see a PAYMENT but not its ALLOCATIONS sums to
-- zero and reads as `unallocated`. Payments and allocations sit behind different
-- policies (20260918000000 §11), so that reader genuinely exists:
-- finance.view without finance.view_all is exactly the case.
--
-- This migration does NOT try to fix that in SQL, and must not: making the sum a
-- SECURITY DEFINER would tell every reader how much of a payment is spoken for
-- whether or not they may see the allocations that say so, which is a widening.
-- The rule is enforced where it belongs, in the caller: the allocation filter is
-- offered ONLY to a reader who can see every allocation — an admin, or a holder
-- of the protected finance.view_all action — for whom the invoker sum IS the
-- true sum. src/lib/finance/paymentAllocations.ts states the same rule for the
-- per-payment panel, and defaults to the safe answer.
--
-- This is the SAME property is_order_allocated has carried since 20260921000000
-- §8a; no reader's view of any payment changes, and no policy is created,
-- dropped, altered or widened by this file.
--
-- NO NEW INDEX. The aggregate is keyed on payment_request_id where status =
-- 'active', which is exactly finance_payment_allocations_payment_active_idx
-- (20260918000000). Adding a second index over the same predicate would cost
-- every allocation write and buy nothing.
--
-- FORWARD-ONLY, and the first migration after 20261003000000.

begin;

-- ═══ 1. The projection, with the two new columns ════════════════════════════
--
-- CREATE OR REPLACE, not DROP and CREATE. Replacing keeps the view's oid, its
-- privileges and anything depending on it; dropping would revoke and re-grant
-- through the platform's default privileges and briefly leave the object absent
-- from a live system. Replace permits adding columns only AT THE END, which is
-- why the two new ones are last and every existing column keeps its name, its
-- type and its position — a client selecting the old column list is unaffected.
--
-- Everything above the new columns is 20260921000000 §8a verbatim.

create or replace view public.finance_received_payments
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
  f.approved_at,

  eb.full_name as submitted_by_name,
  ab.full_name as approved_by_name,

  alloc.order_id       as allocated_order_id,
  alloc.display_number as allocated_order_number,

  (alloc.order_id is not null) as is_order_allocated,

  -- ── NEW: how much of this payment is spoken for ──
  --
  -- ACTIVE ONLY, the same rule the lateral above applies and the same one
  -- finance_payment_status_is_verified's callers apply: a reversed allocation is
  -- a claim that was WITHDRAWN. It stays in the Finance trail, where its reason
  -- is, and the money it named is available again.
  --
  -- COALESCED TO 0, so "no allocations" is a number rather than a null. A null
  -- would mean the column is missing, not that the money is free, and the two
  -- must not collapse — the state below reads this, and every comparison against
  -- a null would be null.
  --
  -- SUMMED IN `numeric`. Never a float: a percentage or a balance that passed
  -- through binary floating point could disagree with the same money summed
  -- anywhere else in this system.
  coalesce(totals.allocated_total, 0) as allocated_total,

  -- ── NEW: the state, as one word ──
  --
  -- Derived from the total and the payment's own amount, so the boundaries are
  -- exact at any figure rather than at a constant. PostgREST cannot compare two
  -- columns in a filter, which is the whole reason this is a column and not a
  -- predicate the client could assemble.
  --
  -- 'over' IS NOT AN EXPECTED STATE. The capacity trigger
  -- (finance_payment_allocations_enforce_capacity, 20260918000000 §2) refuses an
  -- allocation that would exceed its payment, so a row in this state means
  -- something has gone wrong — which is exactly why it is nameable rather than
  -- rounded into 'full'. A state that cannot be found cannot be corrected.
  --
  -- A NULL AMOUNT yields a null state rather than a wrong one. The column is NOT
  -- NULL on the table (20260628000200), so this branch is unreachable today; it
  -- is stated so the expression can never return 'unallocated' for a payment
  -- whose amount could not be read.
  case
    when f.amount is null                             then null
    when coalesce(totals.allocated_total, 0) = 0      then 'unallocated'
    when coalesce(totals.allocated_total, 0) > f.amount then 'over'
    when coalesce(totals.allocated_total, 0) = f.amount then 'full'
    else 'partial'
  end as allocation_state

from public.finance_payment_requests f
left join public.users eb on eb.id = f.submitted_by
left join public.users ab on ab.id = f.approved_by
left join lateral (
  select a.order_id, o.display_number
  from public.finance_payment_allocations a
  left join public.orders o on o.id = a.order_id
  where a.payment_request_id = f.id
    and a.status = 'active'
    and a.order_id is not null
  order by a.created_at, a.id
  limit 1
) alloc on true
-- ONE ROW BY CONSTRUCTION: an aggregate with no GROUP BY over a correlated
-- filter always yields exactly one row, so this cannot multiply a payment. That
-- is the same property the two name joins have (primary key) and the lateral
-- above has (LIMIT 1), and together they are why the view still returns exactly
-- one row per payment — which the assertions below re-check.
--
-- Uses finance_payment_allocations_payment_active_idx directly: the predicate is
-- that index's predicate and the key is its key.
left join lateral (
  select sum(a.allocated_amount) as allocated_total
  from public.finance_payment_allocations a
  where a.payment_request_id = f.id
    and a.status = 'active'
) totals on true;

comment on view public.finance_received_payments is
  'Every payment row a caller may already read, plus whether its money is allocated to a Confirmed Order and which one, plus HOW MUCH of it is spoken for. SECURITY INVOKER: every underlying policy is evaluated as the caller, so this can show nothing the tables beneath it would not — and, in consequence, a caller who may read a payment but not its allocations sums to zero and reads as unallocated, which is why the allocation filter is offered only to a reader holding finance.view_all or admin. Exactly one row per payment — the name joins are on a primary key, the allocation lookup is a LATERAL LIMIT 1, and the total is an ungrouped aggregate. allocated_total counts ACTIVE allocations only, in numeric; a reversed allocation is a withdrawn claim and its money is free again. Exposes no allocation id and no per-target split. Read-only projection; it stores nothing and is not a second ledger.';

-- ═══ 2. Privileges, normalised again ════════════════════════════════════════
--
-- CREATE OR REPLACE does not re-run the platform's default privileges, so the
-- ACL this view already carries is preserved and these statements are expected
-- to be no-ops. They are here anyway, and asserted below, because 20260921000000
-- §8a documents at length why this project cannot assume a view's ACL: Supabase
-- bootstraps `alter default privileges ... grant all on tables to postgres, anon,
-- authenticated, service_role`, and an object that ever passes through a plain
-- CREATE is born with INSERT, UPDATE and DELETE for every client role. The one
-- privilege this object may carry is SELECT.
--
-- ORDER MATTERS: revoke everything from every client role first, then grant back
-- the one thing. Granting before revoking would erase the grant.

revoke all privileges on public.finance_received_payments
  from public, anon, authenticated;

grant select on public.finance_received_payments to authenticated;

-- ═══ 3. Apply-time assertions ═══════════════════════════════════════════════
--
-- The migration refuses itself rather than shipping a projection that is wrong
-- in a way nobody would notice until a Finance user acted on it.

do $$
declare
  v_def text;
  v_cols text[];
begin
  -- 3a. Still SECURITY INVOKER. If a replace ever dropped this option the view
  -- would evaluate as its OWNER and show every caller every payment in the
  -- company. This is the single most important line in the file.
  select coalesce(
           (select option_value
              from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'),
           'false')
    into v_def
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'finance_received_payments';

  if v_def is distinct from 'true' then
    raise exception
      'finance_received_payments must remain security_invoker=true (found "%")', v_def;
  end if;

  -- 3b. Every pre-existing column is still present, still named the same.
  -- CREATE OR REPLACE enforces this itself; asserting it makes the intent
  -- explicit and catches a hand-edited redefinition.
  select array_agg(column_name::text order by ordinal_position)
    into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'finance_received_payments';

  foreach v_def in array array[
    'id','request_number','client_name','amount','payment_date','payment_mode',
    'received_in','proof_note','order_number','order_id','order_request_id',
    'order_request_number','sales_note','status','payment_against','submitted_by',
    'approved_by','admin_note','created_at','approved_at','submitted_by_name',
    'approved_by_name','allocated_order_id','allocated_order_number',
    'is_order_allocated'
  ] loop
    if not (v_def = any (v_cols)) then
      raise exception 'finance_received_payments lost the existing column "%"', v_def;
    end if;
  end loop;

  -- 3c. And the two new ones arrived.
  if not ('allocated_total' = any (v_cols)) then
    raise exception 'finance_received_payments is missing allocated_total';
  end if;
  if not ('allocation_state' = any (v_cols)) then
    raise exception 'finance_received_payments is missing allocation_state';
  end if;

  -- 3d. No CLIENT role may write through it. A view with joins is not
  -- auto-updatable in any case, so this is belt and braces — but 20260921000000
  -- §8a's assertion caught a real grant once, which is why it is repeated.
  if has_table_privilege('authenticated', 'public.finance_received_payments', 'insert')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'update')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'delete') then
    raise exception 'authenticated must hold SELECT only on finance_received_payments';
  end if;

  if not has_table_privilege('authenticated', 'public.finance_received_payments', 'select') then
    raise exception 'authenticated must be able to SELECT finance_received_payments';
  end if;

  -- 3e. The index the aggregate depends on still exists. Without it the sum
  -- becomes a sequential scan of every allocation, per payment, per page.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'finance_payment_allocations'
      and indexname = 'finance_payment_allocations_payment_active_idx'
  ) then
    raise exception
      'finance_payment_allocations_payment_active_idx is required by allocated_total';
  end if;

  -- 3f. NO TABLE GAINED A COLUMN. This migration adds a projection, not a
  -- stored total; a denormalised copy of allocation data would be a second
  -- source of financial truth and would drift the first time a write missed it.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'finance_payment_requests'
      and column_name in ('allocated_total', 'allocation_state')
  ) then
    raise exception 'allocated_total must not be stored on finance_payment_requests';
  end if;
end $$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Re-run 20260921000000 §8a's `create or replace view` block verbatim. It is the
-- same statement without the two trailing columns and without the `totals`
-- lateral, and CREATE OR REPLACE cannot DROP a column — so a rollback requires
-- `drop view public.finance_received_payments;` first, then that block, then its
-- revoke/grant pair. Nothing else in this file needs undoing: no table, column,
-- policy, index, function or trigger was created, altered or dropped.
--
-- The application degrades safely without this migration: the allocation filter
-- probes for `allocation_state` and is simply not offered when the column is
-- absent, so an un-migrated database behaves exactly as it did before.
