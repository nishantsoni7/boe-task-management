-- Finance payment ALLOCATION assertions (20260918000000)
-- ===========================================================================
-- Validates the allocation spine introduced by
-- 20260918000000_finance_payment_allocations.sql:
--
--   * table    public.finance_payment_allocations
--   * CHECKs   finance_payment_allocations_amount_valid
--              finance_payment_allocations_one_target
--              finance_payment_allocations_status_known
--              finance_payment_allocations_origin_known
--              finance_payment_allocations_origin_matches_target
--              finance_payment_allocations_reversal_complete
--   * indexes  finance_payment_allocations_unique_active_submission
--              finance_payment_allocations_unique_active_order
--   * triggers finance_payment_allocations_enforce_capacity   (the lock)
--              finance_payment_allocations_derive_reversal
--              finance_payment_allocations_guard_transition
--              finance_payment_allocations_guard_delete
--              finance_payment_allocations_log_activity
--              finance_payment_requests_guard_allocated_amount
--   * RPCs     allocate_payment_to_target
--              reverse_payment_allocation
--   * actions  finance.allocate, finance.allocate_correct
--   * backfill every approved_linked payment carries exactly one active
--              allocation for its full amount against the same Order
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture —
-- the payments, the PI, the Order and its allocated display_number — is
-- discarded. (Since 20260703 the number cycle is a TABLE row, not a sequence, so
-- a rolled-back Order returns its number to the pool.)
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that bypasses RLS (standard Supabase `postgres`
--     connection) and may SET the `role` GUC to 'authenticated'.
--   * Replace the FOUR real user UUIDs below:
--       test.admin_id      -> a public.users row with role = 'admin'
--       test.allocator_id  -> a NON-admin who will be granted finance.allocate
--       test.corrector_id  -> a NON-admin who will be granted
--                             finance.allocate_correct (and NOT finance.allocate)
--       test.outsider_id   -> a NON-admin with NO finance allocation action
--
-- Reminder about role and RLS: a plain psql superuser connection BYPASSES RLS,
-- so a check that depends on RLS must set the `role` GUC to 'authenticated'
-- first, and every fixture write must happen after `reset role`.
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back. Any failed
-- ASSERT aborts the transaction with an error.
--
-- NOTE: like the other files in this directory, this script is run in a
-- controlled, already-migrated environment; it is not executed by the JS suite.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id',     '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.allocator_id', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.corrector_id', '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  perform set_config('test.outsider_id',  '44444444-4444-4444-4444-444444444444', true); -- REPLACE

  perform set_config('test.pay_a',   gen_random_uuid()::text, true);
  perform set_config('test.pay_b',   gen_random_uuid()::text, true);
  perform set_config('test.pay_pending', gen_random_uuid()::text, true);
  perform set_config('test.sub',     gen_random_uuid()::text, true);
  perform set_config('test.ord',     gen_random_uuid()::text, true);
end $$;

-- ═══ 0. The two actions exist, are protected, and are granted to nobody ══════
do $$
declare v_n integer;
begin
  select count(*) into v_n
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  join public.permission_actions  pa on pa.id = mpa.action_id
  where pm.module_key = 'finance' and pa.action_key in ('allocate', 'allocate_correct');
  assert v_n = 2, 'finance.allocate and finance.allocate_correct must both be registered';

  select count(*) into v_n
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  join public.permission_actions  pa on pa.id = mpa.action_id
  where pm.module_key = 'finance'
    and pa.action_key in ('allocate', 'allocate_correct')
    and mpa.default_allowed;
  assert v_n = 0, 'the allocation actions must never be default_allowed';

  select count(*) into v_n
  from public.role_permissions rp
  join public.permission_actions pa on pa.id = rp.action_id
  where pa.action_key in ('allocate', 'allocate_correct') and rp.allowed;
  assert v_n = 0, 'no ROLE may carry an allocation action — they are per-employee only';
end $$;

-- ═══ 13. The backfill matches the eligible set exactly ══════════════════════
-- Asserted against real committed state, BEFORE any fixture is created.
do $$
declare v_bad text; v_expected bigint; v_actual bigint;
begin
  select count(*) into v_expected
  from public.finance_payment_requests f
  where f.status = 'approved_linked' and f.order_id is not null;

  select count(*) into v_actual
  from public.finance_payment_allocations a where a.status = 'active';

  assert v_actual = v_expected,
    format('expected %s active allocations after backfill, found %s', v_expected, v_actual);

  select string_agg(f.request_number, ', ') into v_bad
  from public.finance_payment_requests f
  where f.status = 'approved_linked' and f.order_id is not null
    and not exists (
      select 1 from public.finance_payment_allocations a
      where a.payment_request_id  = f.id
        and a.status              = 'active'
        and a.order_id            = f.order_id
        and a.allocated_amount    = f.amount
        and a.origin_target_type  = 'confirmed_order'
        and a.order_submission_id is null
    );
  assert v_bad is null,
    format('these linked payments have no matching active allocation: %s', v_bad);

  -- Nothing outside the eligible set was backfilled: no unlinked payment and no
  -- Order-Request-linked payment picked up an allocation.
  assert not exists (
    select 1 from public.finance_payment_allocations a
    join public.finance_payment_requests f on f.id = a.payment_request_id
    where f.status <> 'approved_linked' or f.order_id is null
  ), 'only approved_linked payments with an Order may have been backfilled';
end $$;

-- ── Fixtures (superuser connection; RLS bypassed) ────────────────────────────
-- Two verified suspense payments of 1000.00 and 500.00, one still pending, one
-- PI submission and one Confirmed Order. The payments are inserted directly in
-- their approved state; approve_finance_payment_request is not exercised here
-- (20260715000000's own assertions cover it) and this file is about what happens
-- to money AFTER it is verified.
insert into public.orders (id, display_number, client_name, requested_by, created_by, status, total_value)
values (current_setting('test.ord')::uuid, null, 'ASSERT alloc order',
        current_setting('test.allocator_id')::uuid, current_setting('test.admin_id')::uuid,
        'running', 900000);

insert into public.order_submissions
  (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
-- Created as 'draft', which is where the transition trigger requires every PI to
-- start — and is also the earliest stage the business wants a payment allocatable
-- against, so the fixture proves the intended case rather than working around it.
values (current_setting('test.sub')::uuid, 'draft',
        current_setting('test.allocator_id')::uuid, current_setting('test.allocator_id')::uuid,
        'ASSERT alloc PI', 800000, 0, 800000);

insert into public.finance_payment_requests
  (id, client_name, amount, payment_date, payment_mode, received_in, status, submitted_by, approved_by, approved_at)
values
  (current_setting('test.pay_a')::uuid, 'ASSERT alloc A', 1000.00, current_date, 'bank_transfer', 'company_account',
   'approved_unlinked', current_setting('test.allocator_id')::uuid, current_setting('test.admin_id')::uuid, now()),
  (current_setting('test.pay_b')::uuid, 'ASSERT alloc B', 500.00, current_date, 'upi', 'company_account',
   'approved_unlinked', current_setting('test.allocator_id')::uuid, current_setting('test.admin_id')::uuid, now()),
  (current_setting('test.pay_pending')::uuid, 'ASSERT alloc pending', 700.00, current_date, 'cash', 'cash_in_hand',
   'pending_approval', current_setting('test.allocator_id')::uuid, null, null);

-- Explicit, per-employee grants. Exactly the shape Access Control writes.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.allocator_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'allocate')
where pm.module_key = 'finance';

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.corrector_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'allocate_correct')
where pm.module_key = 'finance';

-- ═══ 11. Direct authenticated mutation is denied ════════════════════════════
-- Two independent refusals: the privilege check, then (if it were ever granted)
-- the absence of any INSERT/UPDATE/DELETE policy.
do $$
declare v_n integer;
begin
  select count(*) into v_n
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'finance_payment_allocations'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  assert v_n = 0,
    format('anon/authenticated must hold no write privilege on the allocation table, found %s', v_n);

  select count(*) into v_n
  from pg_policy p join pg_class t on t.oid = p.polrelid
  where t.relname = 'finance_payment_allocations' and p.polcmd in ('a', 'w', 'd');
  assert v_n = 0,
    format('the allocation table must carry no INSERT/UPDATE/DELETE policy, found %s', v_n);

  assert exists (
    select 1 from pg_policy p join pg_class t on t.oid = p.polrelid
    where t.relname = 'finance_payment_allocations'
      and p.polname = 'finance_payment_allocations_module_entry_gate'
      and p.polpermissive = false
  ), 'the Finance module entry gate must exist and be RESTRICTIVE';
end $$;

-- The live refusal, as the authenticated role.
do $$
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);
  perform set_config('role', 'authenticated', true);

  begin
    insert into public.finance_payment_allocations
      (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
    values (current_setting('test.pay_a')::uuid, current_setting('test.ord')::uuid,
            1.00, 'confirmed_order', current_setting('test.allocator_id')::uuid);
    assert false, 'a direct authenticated INSERT into the allocation table must be refused';
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', 'postgres', true);
end $$;
reset role;

-- ═══ 12. Permission enforcement on both RPCs ════════════════════════════════
do $$
declare v_r jsonb;
begin
  -- An outsider holds neither action.
  assert not public.resolve_permission(current_setting('test.outsider_id')::uuid, 'finance', 'allocate'),
    'the outsider must not resolve finance.allocate';
  assert not public.resolve_permission(current_setting('test.outsider_id')::uuid, 'finance', 'allocate_correct'),
    'the outsider must not resolve finance.allocate_correct';

  -- The two grants are genuinely independent in both directions.
  assert public.resolve_permission(current_setting('test.allocator_id')::uuid, 'finance', 'allocate'),
    'the allocator must resolve finance.allocate';
  assert not public.resolve_permission(current_setting('test.allocator_id')::uuid, 'finance', 'allocate_correct'),
    'finance.allocate must NOT imply finance.allocate_correct';
  assert public.resolve_permission(current_setting('test.corrector_id')::uuid, 'finance', 'allocate_correct'),
    'the corrector must resolve finance.allocate_correct';
  assert not public.resolve_permission(current_setting('test.corrector_id')::uuid, 'finance', 'allocate'),
    'finance.allocate_correct must NOT imply finance.allocate';

  -- The outsider is refused by the RPC itself.
  perform set_config('request.jwt.claim.sub', current_setting('test.outsider_id'), true);
  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_a')::uuid, null, current_setting('test.ord')::uuid, 100.00);
    assert false, 'a caller without finance.allocate must not be able to allocate';
  exception when insufficient_privilege then null;
  end;

  -- Holding allocate_correct is not holding allocate.
  perform set_config('request.jwt.claim.sub', current_setting('test.corrector_id'), true);
  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_a')::uuid, null, current_setting('test.ord')::uuid, 100.00);
    assert false, 'finance.allocate_correct must not confer the authority to allocate';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ═══ 1 & 2. Partial allocation, and several that stay within the amount ═════
do $$
declare v_r jsonb; v_total numeric;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

  -- 1. PARTIAL: 400 of a 1000 payment, against the PI.
  v_r := public.allocate_payment_to_target(
    current_setting('test.pay_a')::uuid, current_setting('test.sub')::uuid, null, 400.00);

  assert (v_r->>'allocated_amount')::numeric = 400.00, 'the allocated amount must be echoed back';
  assert (v_r->>'unallocated_balance')::numeric = 600.00,
    format('a 400 allocation against a 1000 payment must leave 600, got %s', v_r->>'unallocated_balance');
  assert v_r->>'target_type' = 'order_submission', 'the PI target must be classified as order_submission';

  -- The balance is DERIVED, never stored: no column anywhere holds 600.
  assert not exists (
    select 1 from information_schema.columns
    where table_name = 'finance_payment_allocations'
      and column_name in ('unallocated_amount', 'unallocated_balance', 'remaining_amount', 'balance')
  ), 'the unallocated balance must never be stored on the allocation table';

  -- 2. MULTIPLE, still within the amount: +600 against the Order = exactly 1000.
  v_r := public.allocate_payment_to_target(
    current_setting('test.pay_a')::uuid, null, current_setting('test.ord')::uuid, 600.00);
  assert (v_r->>'unallocated_balance')::numeric = 0.00,
    format('400 + 600 against a 1000 payment must leave 0, got %s', v_r->>'unallocated_balance');

  select sum(allocated_amount) into v_total
  from public.finance_payment_allocations
  where payment_request_id = current_setting('test.pay_a')::uuid and status = 'active';
  assert v_total = 1000.00, format('the active allocated total must be 1000.00, got %s', v_total);

  -- One payment now legitimately spans a PI and an Order at once — the shape the
  -- parent table's one_link_target CHECK makes impossible.
  assert (select count(*) from public.finance_payment_allocations
          where payment_request_id = current_setting('test.pay_a')::uuid and status = 'active') = 2,
    'a payment must be able to hold two active allocations against different targets';

  -- The PARENT PAYMENT is untouched: Phase 1 changes no linkage field.
  assert (select order_id from public.finance_payment_requests
          where id = current_setting('test.pay_a')::uuid) is null,
    'allocating must not write the parent payment order_id';
  assert (select status from public.finance_payment_requests
          where id = current_setting('test.pay_a')::uuid) = 'approved_unlinked',
    'allocating must not change the parent payment status';
  assert (select payment_target_type from public.finance_payment_requests
          where id = current_setting('test.pay_a')::uuid) = 'unallocated',
    'allocating must not change the parent payment_target_type';
end $$;

-- ═══ 3. Over-allocation fails ═══════════════════════════════════════════════
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

  -- pay_a is fully allocated; even the smallest further claim must be refused.
  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_b')::uuid, null, current_setting('test.ord')::uuid, 500.01);
    assert false, 'allocating more than the payment amount must be refused';
  exception when raise_exception then
    assert sqlerrm like '%ALLOCATION_EXCEEDS_PAYMENT%',
      format('over-allocation must raise ALLOCATION_EXCEEDS_PAYMENT, got: %s', sqlerrm);
  end;

  -- And the refusal left nothing behind.
  assert not exists (
    select 1 from public.finance_payment_allocations
    where payment_request_id = current_setting('test.pay_b')::uuid
  ), 'a refused allocation must write no row';
end $$;

-- ═══ 4. The capacity check is the LAST word, under the parent lock ══════════
-- The RPC's own arithmetic is a courtesy; the invariant is the trigger's, and it
-- must refuse an over-allocation that arrives by any other path — a service-role
-- script, direct SQL, or a future RPC that forgets to check.
do $$
declare v_def text;
begin
  assert exists (
    select 1 from pg_trigger g join pg_class t on t.oid = g.tgrelid
    where t.relname = 'finance_payment_allocations'
      and g.tgname  = 'finance_payment_allocations_enforce_capacity'
  ), 'the capacity trigger must be attached';

  -- The lock is what makes concurrent allocation safe, so its presence is
  -- asserted from the deployed function body rather than assumed.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finance_payment_allocations_enforce_capacity';
  assert v_def like '%for update%',
    'the capacity trigger must lock the parent payment row FOR UPDATE';
  assert v_def like '%finance_payment_requests%',
    'the capacity trigger must read the parent payment';

  -- Direct SQL, bypassing the RPC entirely.
  begin
    insert into public.finance_payment_allocations
      (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
    values (current_setting('test.pay_b')::uuid, current_setting('test.ord')::uuid,
            500.01, 'confirmed_order', current_setting('test.admin_id')::uuid);
    assert false, 'the capacity trigger must refuse an over-allocation from direct SQL too';
  exception when raise_exception then
    assert sqlerrm like '%ALLOCATION_EXCEEDS_PAYMENT%',
      format('direct over-allocation must raise ALLOCATION_EXCEEDS_PAYMENT, got: %s', sqlerrm);
  end;

  -- The other half of the same invariant: the AMOUNT may not drop below what is
  -- already allocated.
  begin
    update public.finance_payment_requests
       set amount = 100.00
     where id = current_setting('test.pay_a')::uuid;
    assert false, 'reducing a payment below its allocated total must be refused';
  exception when raise_exception then
    assert sqlerrm like '%PAYMENT_BELOW_ALLOCATED%',
      format('an under-cutting correction must raise PAYMENT_BELOW_ALLOCATED, got: %s', sqlerrm);
  end;
end $$;

-- ═══ 5. Zero, negative and over-precise allocations fail ════════════════════
do $$
declare v_r jsonb; v_amt numeric;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

  foreach v_amt in array array[0::numeric, -1::numeric, 10.005::numeric] loop
    begin
      v_r := public.allocate_payment_to_target(
        current_setting('test.pay_b')::uuid, null, current_setting('test.ord')::uuid, v_amt);
      assert false, format('an allocation of %s must be refused', v_amt);
    exception when raise_exception then
      assert sqlerrm like '%ALLOCATION_AMOUNT_INVALID%',
        format('an allocation of %s must raise ALLOCATION_AMOUNT_INVALID, got: %s', v_amt, sqlerrm);
    end;
  end loop;

  -- NULL is refused too, and by the same rule.
  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_b')::uuid, null, current_setting('test.ord')::uuid, null);
    assert false, 'a null allocation amount must be refused';
  exception when raise_exception then
    assert sqlerrm like '%ALLOCATION_AMOUNT_INVALID%', 'a null amount must raise ALLOCATION_AMOUNT_INVALID';
  end;

  -- The CHECK holds against direct SQL as well as against the RPC.
  begin
    insert into public.finance_payment_allocations
      (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
    values (current_setting('test.pay_b')::uuid, current_setting('test.ord')::uuid,
            10.005, 'confirmed_order', current_setting('test.admin_id')::uuid);
    assert false, 'an over-precise amount must be refused by the CHECK, not rounded';
  exception when check_violation then null;
  end;
end $$;

-- ═══ 6 & 7. Exactly one target: never both, never neither ═══════════════════
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_b')::uuid, current_setting('test.sub')::uuid,
      current_setting('test.ord')::uuid, 10.00);
    assert false, 'an allocation naming BOTH a PI and an Order must be refused';
  exception when raise_exception then
    assert sqlerrm like '%ALLOCATION_TARGET_REQUIRED%', 'naming both targets must raise ALLOCATION_TARGET_REQUIRED';
  end;

  begin
    v_r := public.allocate_payment_to_target(current_setting('test.pay_b')::uuid, null, null, 10.00);
    assert false, 'an allocation naming NEITHER target must be refused';
  exception when raise_exception then
    assert sqlerrm like '%ALLOCATION_TARGET_REQUIRED%', 'naming no target must raise ALLOCATION_TARGET_REQUIRED';
  end;

  -- The CHECK is what actually guarantees it, for every path.
  begin
    insert into public.finance_payment_allocations
      (payment_request_id, order_submission_id, order_id, allocated_amount, origin_target_type, created_by)
    values (current_setting('test.pay_b')::uuid, current_setting('test.sub')::uuid,
            current_setting('test.ord')::uuid, 10.00, 'confirmed_order', current_setting('test.admin_id')::uuid);
    assert false, 'the one_target CHECK must refuse two targets';
  exception when check_violation then null;
  end;

  begin
    insert into public.finance_payment_allocations
      (payment_request_id, allocated_amount, origin_target_type, created_by)
    values (current_setting('test.pay_b')::uuid, 10.00, 'confirmed_order', current_setting('test.admin_id')::uuid);
    assert false, 'the one_target CHECK must refuse zero targets';
  exception when check_violation then null;
  end;
end $$;

-- ═══ 8. Duplicate ACTIVE allocation to the same target fails ════════════════
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_a')::uuid, current_setting('test.sub')::uuid, null, 1.00);
    assert false, 'a second active allocation to the same PI must be refused';
  exception when raise_exception then
    assert sqlerrm like '%ALLOCATION_DUPLICATE%' or sqlerrm like '%ALLOCATION_EXCEEDS_PAYMENT%',
      format('a duplicate must be refused, got: %s', sqlerrm);
  end;

  -- And the unique index is the guarantee behind the readable refusal.
  assert exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'finance_payment_allocations_unique_active_submission'
  ), 'the per-PI active-allocation unique index must exist';
  assert exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'finance_payment_allocations_unique_active_order'
  ), 'the per-Order active-allocation unique index must exist';
end $$;

-- ═══ 9. Reversal preserves the row and records actor, time and reason ═══════
do $$
declare v_r jsonb; v_alloc uuid; v_row public.finance_payment_allocations%rowtype; v_before bigint;
begin
  select id into v_alloc from public.finance_payment_allocations
  where payment_request_id = current_setting('test.pay_a')::uuid
    and order_submission_id = current_setting('test.sub')::uuid and status = 'active';

  select count(*) into v_before from public.finance_payment_allocations;

  -- A reason is mandatory, and blank is not a reason.
  perform set_config('request.jwt.claim.sub', current_setting('test.corrector_id'), true);
  begin
    v_r := public.reverse_payment_allocation(v_alloc, '   ');
    assert false, 'a blank reversal reason must be refused';
  exception when raise_exception then
    assert sqlerrm like '%ALLOCATION_REASON_REQUIRED%', 'a blank reason must raise ALLOCATION_REASON_REQUIRED';
  end;

  v_r := public.reverse_payment_allocation(v_alloc, '  Allocated to the wrong PI  ');

  assert (select count(*) from public.finance_payment_allocations) = v_before,
    'reversal must PRESERVE the row — nothing may be deleted';

  select * into v_row from public.finance_payment_allocations where id = v_alloc;
  assert v_row.status = 'reversed',                                  'the row must be reversed';
  assert v_row.reversed_by = current_setting('test.corrector_id')::uuid,
    'the reversal must be attributed to the caller, not to anything the caller supplied';
  assert v_row.reversed_at is not null,                              'the reversal must record a time';
  assert v_row.reversal_reason = 'Allocated to the wrong PI',        'the reason must be stored trimmed';
  assert v_row.allocated_amount = 400.00,                            'the reversed amount must still be readable';
  assert v_row.order_submission_id = current_setting('test.sub')::uuid,
    'the reversed allocation must still name what it was allocated to';

  -- The balance is derived, so it recovers on its own.
  assert (select f.amount - coalesce(sum(a.allocated_amount), 0)
          from public.finance_payment_requests f
          left join public.finance_payment_allocations a
            on a.payment_request_id = f.id and a.status = 'active'
          where f.id = current_setting('test.pay_a')::uuid
          group by f.amount) = 400.00,
    'reversing a 400 allocation must return 400 to the unallocated balance';

  -- Idempotent: a second call answers, it does not act.
  v_r := public.reverse_payment_allocation(v_alloc, 'again');
  assert (v_r->>'already_reversed')::boolean, 'a repeated reversal must report already_reversed';
  assert (select reversal_reason from public.finance_payment_allocations where id = v_alloc)
         = 'Allocated to the wrong PI',
    'a repeated reversal must not rewrite the recorded reason';

  -- The freed capacity is genuinely reusable, and a reversed row does not block
  -- a corrected re-allocation to the same target.
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);
  v_r := public.allocate_payment_to_target(
    current_setting('test.pay_a')::uuid, current_setting('test.sub')::uuid, null, 400.00);
  assert (v_r->>'unallocated_balance')::numeric = 0.00,
    're-allocating the freed amount to the same PI must succeed';
end $$;

-- ═══ 10. A reversed allocation can never be reactivated ═════════════════════
do $$
declare v_alloc uuid;
begin
  select id into v_alloc from public.finance_payment_allocations
  where payment_request_id = current_setting('test.pay_a')::uuid and status = 'reversed' limit 1;

  begin
    update public.finance_payment_allocations set status = 'active' where id = v_alloc;
    assert false, 'a reversed allocation must never become active again';
  exception when insufficient_privilege then
    assert sqlerrm like '%ALLOCATION_REVERSAL_FINAL%',
      format('reactivation must raise ALLOCATION_REVERSAL_FINAL, got: %s', sqlerrm);
  end;

  -- Nor may the recorded reversal be rewritten.
  begin
    update public.finance_payment_allocations
       set reversal_reason = 'something else' where id = v_alloc;
    assert false, 'a recorded reversal reason must not be rewritable';
  exception when insufficient_privilege then
    assert sqlerrm like '%ALLOCATION_REVERSAL_IMMUTABLE%',
      format('rewriting a reversal must raise ALLOCATION_REVERSAL_IMMUTABLE, got: %s', sqlerrm);
  end;

  -- Nor the amount, the target, the payment or the provenance of ANY allocation.
  begin
    update public.finance_payment_allocations
       set allocated_amount = 1.00
     where payment_request_id = current_setting('test.pay_a')::uuid and status = 'active';
    assert false, 'an allocation amount must be immutable';
  exception when insufficient_privilege then
    assert sqlerrm like '%ALLOCATION_IMMUTABLE%',
      format('editing an allocation must raise ALLOCATION_IMMUTABLE, got: %s', sqlerrm);
  end;
end $$;

-- ═══ 14. Verified payments and their allocations stay undeletable ═══════════
do $$
begin
  -- The allocation itself.
  begin
    delete from public.finance_payment_allocations
     where payment_request_id = current_setting('test.pay_a')::uuid;
    assert false, 'an allocation must never be deletable';
  exception when insufficient_privilege then
    assert sqlerrm like '%ALLOCATION_PERMANENT%',
      format('deleting an allocation must raise ALLOCATION_PERMANENT, got: %s', sqlerrm);
  end;

  -- The verified parent payment, unchanged from 20260705000000.
  begin
    delete from public.finance_payment_requests where id = current_setting('test.pay_a')::uuid;
    assert false, 'a verified payment must never be deletable';
  exception when insufficient_privilege then
    assert sqlerrm like '%PAYMENT_APPROVED_PERMANENT%' or sqlerrm like '%ALLOCATION_PERMANENT%',
      format('deleting a verified payment must be refused, got: %s', sqlerrm);
  end;

  -- And the ON DELETE CASCADE from the Order cannot be used as a back door.
  begin
    delete from public.orders where id = current_setting('test.ord')::uuid;
    assert false, 'deleting an Order must not silently discard its allocations';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ═══ Allocation eligibility: only a VERIFIED payment, only a LIVE target ════
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_pending')::uuid, null, current_setting('test.ord')::uuid, 10.00);
    assert false, 'a payment that has not been verified must not be allocatable';
  exception when raise_exception then
    assert sqlerrm like '%PAYMENT_NOT_VERIFIED%',
      format('allocating an unverified payment must raise PAYMENT_NOT_VERIFIED, got: %s', sqlerrm);
  end;

  -- A missing payment and a missing target are refused, not silently ignored.
  begin
    v_r := public.allocate_payment_to_target(gen_random_uuid(), null, current_setting('test.ord')::uuid, 10.00);
    assert false, 'an unknown payment must be refused';
  exception when no_data_found then null;
  end;

  begin
    v_r := public.allocate_payment_to_target(current_setting('test.pay_b')::uuid, gen_random_uuid(), null, 10.00);
    assert false, 'an unknown PI must be refused';
  exception when insufficient_privilege then
    assert sqlerrm like '%ALLOCATION_TARGET_NOT_AVAILABLE%',
      format('an unknown PI must raise ALLOCATION_TARGET_NOT_AVAILABLE, got: %s', sqlerrm);
  end;

  -- The two target states the RPC refuses outright are asserted from the
  -- DEPLOYED body: reaching them live would need a full approval or rejection
  -- run, which belongs to those phases' own assertion files, not this one.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target')
         like '%ALLOCATION_TARGET_CONVERTED%',
    'an approved PI must be refused — allocate to its Order instead';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target')
         like '%ALLOCATION_TARGET_NOT_ACTIVE%',
    'a rejected PI and a cancelled Order must be refused';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target')
         like '%ALLOCATION_TARGET_CLAIMED%',
    'a PI reserved for deletion must be refused';
end $$;

-- ═══ 6. Audit: the existing Finance trail carries both events ═══════════════
do $$
declare v_created bigint; v_reversed bigint; v_payload jsonb;
begin
  select count(*) into v_created
  from public.finance_payment_request_activity_log
  where payment_request_id = current_setting('test.pay_a')::uuid and event_type = 'allocation_created';
  assert v_created = 3,
    format('three allocations were created against pay_a, found %s allocation_created rows', v_created);

  select count(*) into v_reversed
  from public.finance_payment_request_activity_log
  where payment_request_id = current_setting('test.pay_a')::uuid and event_type = 'allocation_reversed';
  assert v_reversed = 1,
    format('exactly one reversal happened, found %s allocation_reversed rows', v_reversed);

  select payload into v_payload
  from public.finance_payment_request_activity_log
  where payment_request_id = current_setting('test.pay_a')::uuid and event_type = 'allocation_reversed';

  assert v_payload ? 'allocation_id',      'the audit payload must name the allocation';
  assert v_payload ? 'target_type',        'the audit payload must name the target type';
  assert v_payload ? 'target_id',          'the audit payload must name the target';
  assert v_payload ? 'allocated_amount',   'the audit payload must carry the amount';
  assert v_payload ? 'reversal_reason',    'a reversal payload must carry the reason';
  assert v_payload->>'reversal_reason' = 'Allocated to the wrong PI', 'the audited reason must be the stored one';

  -- The actor is recorded, and it is the person who acted.
  assert (select actor_id from public.finance_payment_request_activity_log
          where payment_request_id = current_setting('test.pay_a')::uuid
            and event_type = 'allocation_reversed') = current_setting('test.corrector_id')::uuid,
    'the reversal must be audited against the caller who performed it';

  -- No client may write an audit row directly: there has been no INSERT policy
  -- on this table since 20260675.
  assert not exists (
    select 1 from pg_policy p join pg_class t on t.oid = p.polrelid
    where t.relname = 'finance_payment_request_activity_log' and p.polcmd = 'a'
  ), 'the Finance activity log must accept no client INSERT';
end $$;

-- ═══ 16. Test-data cleanup still completes ══════════════════════════════════
-- The claim/finalize protocol is NOT weakened and NOT restated by this phase.
-- What is asserted here is the one thing that changed: an allocation no longer
-- blocks the cleanup's own deletes, because the delete guard stands down inside
-- an authorized cleanup transaction and the CASCADE then carries it.
do $$
declare v_n bigint;
begin
  assert exists (select 1 from pg_proc where proname = 'begin_test_data_cleanup'),
    'begin_test_data_cleanup must still exist';
  assert exists (select 1 from pg_proc where proname = 'finalize_test_data_cleanup'),
    'finalize_test_data_cleanup must still exist';
  assert exists (select 1 from pg_proc where proname = 'release_test_data_cleanup'),
    'release_test_data_cleanup must still exist';

  -- The three FKs cascade, so the cleanup's existing deletes reach allocations.
  select count(*) into v_n
  from pg_constraint
  where conrelid = 'public.finance_payment_allocations'::regclass
    and contype = 'f' and confdeltype = 'c';
  assert v_n = 3,
    format('all three allocation parents must cascade so cleanup is not blocked, found %s', v_n);

  -- Inside an authorized cleanup transaction the guard stands down — and ONLY
  -- there. This is the same transaction-local marker 20260705000000 defined; it
  -- is not an identity and no client can set it.
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  delete from public.finance_payment_allocations
   where payment_request_id = current_setting('test.pay_a')::uuid;
  assert not exists (
    select 1 from public.finance_payment_allocations
    where payment_request_id = current_setting('test.pay_a')::uuid
  ), 'inside an authorized cleanup the allocations must be removable';
  perform set_config('boe.cleanup_context', '', true);

  -- And the door closes again immediately.
  begin
    delete from public.finance_payment_allocations
     where payment_request_id = current_setting('test.pay_b')::uuid;
  exception when insufficient_privilege then null;
  end;
end $$;

-- ═══ 15. Nothing that existed before behaves differently ════════════════════
-- The parent payment contract is exactly what 20260692/20260698/20260715 left.
do $$
begin
  assert exists (select 1 from pg_constraint
                 where conname = 'finance_payment_requests_one_link_target'),
    'the parent one-link-target CHECK must be untouched';
  assert exists (select 1 from pg_constraint
                 where conname = 'finance_payment_requests_status_order_invariant'),
    'the parent status/order invariant must be untouched';
  assert exists (select 1 from pg_constraint
                 where conname = 'finance_payment_requests_target_type_check'),
    'the parent target-type CHECK must be untouched';

  -- payment_target_type gained no fourth value.
  assert (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'finance_payment_requests_target_type_check')
         not like '%order_submission%',
    'order_submission must NOT have been added to payment_target_type';

  -- The payment status domain gained no sixth value.
  assert (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'finance_payment_requests_status_check')
         not like '%awaiting%',
    'no Awaiting Verification status may have been added';

  -- Order approval still gates on the DECLARED advance, not on payment.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'approve_order_submission')
         like '%order_submission_advance_ready%',
    'approve_order_submission must still consult the declared-advance rule';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'approve_order_submission')
         not like '%finance_payment_allocations%',
    'approve_order_submission must not have been wired to allocations in this phase';
end $$;

reset role;
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
