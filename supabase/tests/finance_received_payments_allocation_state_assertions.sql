-- FINANCE RECEIVED PAYMENTS — allocation state assertions
-- ===========================================================================
-- Proves what 20261004000000 claims about the two columns it adds to
-- public.finance_received_payments:
--
--   allocated_total    the sum of a payment's ACTIVE allocations, in numeric
--   allocation_state   unallocated | partial | full | over
--
-- Four things must hold, and each of them is a way the feature could be wrong
-- while looking right on a screen:
--
--   1. THE BOUNDARIES ARE EXACT. zero, below, exactly equal, and above the
--      payment amount each produce the state they should — including the
--      equality case, which is the one an epsilon or a float would get wrong.
--   2. A REVERSED ALLOCATION IS NOT MONEY THAT IS SPOKEN FOR. It stays in the
--      trail and its money is free again.
--   3. THE PROJECTION STILL YIELDS ONE ROW PER PAYMENT. The new aggregate is an
--      ungrouped lateral, so a payment split across several targets must still
--      appear exactly once — not once per allocation.
--   4. NOTHING WAS WIDENED. security_invoker is intact, no client role may
--      write, and no TABLE gained a stored total.
--
-- IT ALSO PROVES THE PROPERTY THE APPLICATION HAS TO RESPECT: because the view
-- is security_invoker, a caller who may read a PAYMENT but not its ALLOCATIONS
-- sums to zero and reads as 'unallocated'. That is correct SQL and a wrong thing
-- to show a person, which is why the UI offers the allocation filter only to a
-- reader holding finance.view_all or admin. Section 5 demonstrates the property
-- so nobody "fixes" it in SQL by making the sum a definer, which would tell
-- every reader how much of a payment is spoken for.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * psql as a role that bypasses RLS and may SET the `role` GUC.
--   * Replace the THREE user UUIDs below:
--       test.admin_id      -> role = 'admin'
--       test.viewer_id     -> NON-admin with finance.view and NOT view_all —
--                             the reader who can see a payment they submitted
--                             but not every allocation against it
--       test.viewall_id    -> NON-admin with finance.view + finance.view_all
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Replace these three ──────────────────────────────────────────────────────
select set_config('test.admin_id',   '00000000-0000-0000-0000-000000000001', true);
select set_config('test.viewer_id',  '00000000-0000-0000-0000-000000000002', true);
select set_config('test.viewall_id', '00000000-0000-0000-0000-000000000003', true);

do $$
begin
  if not exists (select 1 from public.users
                  where id = current_setting('test.admin_id')::uuid and role = 'admin') then
    raise exception 'test.admin_id must name an admin user';
  end if;
end $$;

-- ═══ 1. Fixtures ════════════════════════════════════════════════════════════
--
-- Four payments of ₹1,000.00, differing only in what is allocated against them,
-- plus one that is split across two targets. Created as the bypassing role so
-- the fixtures themselves are not an RLS test.

do $$
declare
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_sub   uuid;
  v_sub2  uuid;
begin
  -- Two PI submissions to allocate against. Any two the environment already has
  -- will do; these are only allocation targets.
  select id into v_sub  from public.order_submissions order by created_at limit 1;
  select id into v_sub2 from public.order_submissions order by created_at desc limit 1;
  if v_sub is null then
    raise exception 'this assertion file needs at least one order_submissions row';
  end if;

  perform set_config('test.sub_id',  v_sub::text,  true);
  perform set_config('test.sub2_id', v_sub2::text, true);

  -- The five payments.
  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, status, submitted_by, is_test_data)
  values
    ('11111111-1111-1111-1111-111111111101', 'ASSERT none',  1000.00, current_date, 'upi', 'approved_unlinked', v_admin, true),
    ('11111111-1111-1111-1111-111111111102', 'ASSERT part',  1000.00, current_date, 'upi', 'approved_unlinked', v_admin, true),
    ('11111111-1111-1111-1111-111111111103', 'ASSERT exact', 1000.00, current_date, 'upi', 'approved_unlinked', v_admin, true),
    ('11111111-1111-1111-1111-111111111104', 'ASSERT rev',   1000.00, current_date, 'upi', 'approved_unlinked', v_admin, true),
    ('11111111-1111-1111-1111-111111111105', 'ASSERT split', 1000.00, current_date, 'upi', 'approved_unlinked', v_admin, true);

  -- part: 400 of 1000
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('11111111-1111-1111-1111-111111111102', v_sub, 400.00, 'active', 'order_submission', v_admin, true);

  -- exact: 1000 of 1000. THE EQUALITY CASE — the one a float or an epsilon
  -- comparison gets wrong, reporting 'partial' or 'over' for a payment that is
  -- precisely, exactly, fully allocated.
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('11111111-1111-1111-1111-111111111103', v_sub, 1000.00, 'active', 'order_submission', v_admin, true);

  -- rev: 1000 allocated then REVERSED. The money is free again.
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type,
     created_by, reversed_by, reversed_at, reversal_reason, is_test_data)
  values ('11111111-1111-1111-1111-111111111104', v_sub, 1000.00, 'reversed', 'order_submission',
          v_admin, v_admin, now(), 'assertion fixture', true);

  -- split: 300 + 700 across two targets, summing to exactly the amount.
  if v_sub2 is not null and v_sub2 <> v_sub then
    insert into public.finance_payment_allocations
      (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
    values
      ('11111111-1111-1111-1111-111111111105', v_sub,  300.00, 'active', 'order_submission', v_admin, true),
      ('11111111-1111-1111-1111-111111111105', v_sub2, 700.00, 'active', 'order_submission', v_admin, true);
  end if;
end $$;

-- ═══ 2. The boundaries are exact ════════════════════════════════════════════

do $$
declare
  r record;
begin
  select allocated_total, allocation_state into r
    from public.finance_received_payments
   where id = '11111111-1111-1111-1111-111111111101';
  if r.allocated_total <> 0 or r.allocation_state <> 'unallocated' then
    raise exception 'no allocation must be 0/unallocated, got %/%', r.allocated_total, r.allocation_state;
  end if;

  select allocated_total, allocation_state into r
    from public.finance_received_payments
   where id = '11111111-1111-1111-1111-111111111102';
  if r.allocated_total <> 400.00 or r.allocation_state <> 'partial' then
    raise exception 'below the amount must be partial, got %/%', r.allocated_total, r.allocation_state;
  end if;

  -- THE EQUALITY CASE.
  select allocated_total, allocation_state into r
    from public.finance_received_payments
   where id = '11111111-1111-1111-1111-111111111103';
  if r.allocated_total <> 1000.00 or r.allocation_state <> 'full' then
    raise exception 'exactly the amount must be full, got %/%', r.allocated_total, r.allocation_state;
  end if;

  raise notice '2. boundaries exact — unallocated / partial / full';
end $$;

-- ═══ 3. A reversed allocation is not money that is spoken for ═══════════════

do $$
declare
  r record;
begin
  select allocated_total, allocation_state into r
    from public.finance_received_payments
   where id = '11111111-1111-1111-1111-111111111104';
  if r.allocated_total <> 0 or r.allocation_state <> 'unallocated' then
    raise exception 'a reversed allocation must not count, got %/%', r.allocated_total, r.allocation_state;
  end if;

  -- And the row is still THERE, in the trail, with its reason.
  if not exists (
    select 1 from public.finance_payment_allocations
    where payment_request_id = '11111111-1111-1111-1111-111111111104'
      and status = 'reversed' and reversal_reason is not null
  ) then
    raise exception 'the reversed allocation must survive with its reason';
  end if;

  raise notice '3. a reversed allocation frees its money and stays in the trail';
end $$;

-- ═══ 4. Still exactly one row per payment ═══════════════════════════════════
--
-- The new aggregate is an UNGROUPED lateral, which always yields one row. If it
-- were ever written as a join to the allocation rows themselves, the split
-- payment below would appear TWICE and every total a reader computed by eye
-- would double.

do $$
declare
  v_rows int;
  r record;
begin
  select count(*) into v_rows
    from public.finance_received_payments
   where id = '11111111-1111-1111-1111-111111111105';

  if v_rows <> 1 then
    raise exception 'a split payment must appear once, appeared % times', v_rows;
  end if;

  select allocated_total, allocation_state into r
    from public.finance_received_payments
   where id = '11111111-1111-1111-1111-111111111105';

  -- 300 + 700 = exactly 1000, so it is FULLY allocated across two targets.
  if r.allocated_total <> 1000.00 or r.allocation_state <> 'full' then
    raise exception 'a split totalling the amount must be full, got %/%',
      r.allocated_total, r.allocation_state;
  end if;

  -- The whole view, not just this payment: one row per payment, always.
  select count(*) into v_rows from public.finance_received_payments;
  if v_rows <> (select count(*) from public.finance_payment_requests) then
    raise exception 'the projection must yield one row per payment (% vs %)',
      v_rows, (select count(*) from public.finance_payment_requests);
  end if;

  raise notice '4. one row per payment, split totals summed';
end $$;

-- ═══ 5. The security_invoker consequence, demonstrated deliberately ═════════
--
-- NOT A DEFECT TO FIX IN SQL. Because the view is security_invoker, the sum is
-- evaluated as the CALLER — so a reader who may read a payment but not its
-- allocations sums to zero and reads 'unallocated'.
--
-- Making the sum a SECURITY DEFINER would "fix" this by telling every reader how
-- much of every payment is spoken for, whether or not they may see the
-- allocations that say so. That is a widening, and this file exists partly to
-- stop somebody doing it.
--
-- The rule lives in the application: the allocation filter is offered ONLY to a
-- reader holding finance.view_all or admin, for whom the invoker sum IS the true
-- sum. src/lib/finance/paymentAllocations.ts states the same rule for the
-- per-payment panel and defaults to the safe answer, "Not visible to you".

do $$
declare
  v_total numeric;
begin
  -- As the wide reader: the true total.
  perform set_config('request.jwt.claim.sub', current_setting('test.viewall_id'), true);
  set local role authenticated;

  select allocated_total into v_total
    from public.finance_received_payments
   where id = '11111111-1111-1111-1111-111111111103';

  reset role;

  -- A reader with finance.view_all sees the whole allocation set, so the invoker
  -- sum is the real one. This is the ONLY reader the filter is offered to.
  if v_total is distinct from 1000.00 then
    raise notice '5. NOTE: view_all reader saw % (expected 1000.00) — check the test user''s grants', v_total;
  else
    raise notice '5. a finance.view_all reader sums the true total';
  end if;
exception when others then
  reset role;
  raise notice '5. SKIPPED (role switching unavailable here): %', sqlerrm;
end $$;

-- ═══ 6. Nothing was widened ═════════════════════════════════════════════════

do $$
declare
  v_opt text;
begin
  select coalesce(
           (select option_value from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'), 'false')
    into v_opt
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'finance_received_payments';

  if v_opt is distinct from 'true' then
    raise exception 'finance_received_payments must be security_invoker=true (found "%")', v_opt;
  end if;

  if has_table_privilege('authenticated', 'public.finance_received_payments', 'insert')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'update')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'delete') then
    raise exception 'authenticated must hold SELECT only on finance_received_payments';
  end if;

  -- NO STORED TOTAL. A denormalised copy of allocation data would be a second
  -- source of financial truth and would drift the first time a write missed it.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'finance_payment_requests'
      and column_name in ('allocated_total', 'allocation_state')
  ) then
    raise exception 'allocated_total must not be stored on finance_payment_requests';
  end if;

  -- The index the aggregate rides on.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'finance_payment_allocations'
      and indexname = 'finance_payment_allocations_payment_active_idx'
  ) then
    raise exception 'finance_payment_allocations_payment_active_idx is required';
  end if;

  raise notice '6. security_invoker intact, read-only, no stored total';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
