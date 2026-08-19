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
  -- A SALESPERSON WITH ORDER MANAGEMENT ACCESS AND NO FINANCE ACCESS AT ALL.
  -- The whole of Correction 2 rests on this account: they own a PI and an Order,
  -- and must be able to read the money attached to them without ever being
  -- granted Finance.
  perform set_config('test.sales_id',     '55555555-5555-5555-5555-555555555555', true); -- REPLACE

  perform set_config('test.pay_a',       gen_random_uuid()::text, true);
  perform set_config('test.pay_b',       gen_random_uuid()::text, true);
  perform set_config('test.pay_pending', gen_random_uuid()::text, true);
  perform set_config('test.pay_reject',  gen_random_uuid()::text, true);
  perform set_config('test.pay_sales',   gen_random_uuid()::text, true);
  perform set_config('test.sub',         gen_random_uuid()::text, true);
  perform set_config('test.ord',         gen_random_uuid()::text, true);
  perform set_config('test.sub2',        gen_random_uuid()::text, true);
  perform set_config('test.ord2',        gen_random_uuid()::text, true);
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
  -- STILL AWAITING VERIFICATION. The workflow's normal starting state, and what
  -- Correction 1 exists to allow.
  (current_setting('test.pay_pending')::uuid, 'ASSERT alloc pending', 700.00, current_date, 'cash', 'cash_in_hand',
   'pending_approval', current_setting('test.allocator_id')::uuid, null, null),
  (current_setting('test.pay_reject')::uuid, 'ASSERT alloc reject', 300.00, current_date, 'cheque', 'company_account',
   'pending_approval', current_setting('test.allocator_id')::uuid, null, null),
  -- The payment behind the Finance-less salesperson's own records.
  (current_setting('test.pay_sales')::uuid, 'ASSERT alloc sales', 250.00, current_date, 'upi', 'company_account',
   'pending_approval', current_setting('test.allocator_id')::uuid, null, null);

-- A SECOND PI and a SECOND Order, both belonging to the Finance-less
-- salesperson: the PI is theirs because they submitted it, the Order because it
-- was requested for them. Those are exactly the two participant branches.
insert into public.order_submissions
  (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
values (current_setting('test.sub2')::uuid, 'draft',
        current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
        'ASSERT sales PI', 500000, 0, 500000);

insert into public.orders (id, display_number, client_name, requested_by, created_by, status, total_value)
values (current_setting('test.ord2')::uuid, null, 'ASSERT sales order',
        current_setting('test.sales_id')::uuid, current_setting('test.admin_id')::uuid,
        'running', 500000);

-- Order Management entry only. NO Finance action of any kind — not view, not
-- view_all, not allocate. Asserted below rather than assumed.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.sales_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view'
where pm.module_key = 'orders';

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

  -- anon holds nothing at all, SELECT included: nothing reads an allocation
  -- unauthenticated.
  select count(*) into v_n
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'finance_payment_allocations' and grantee = 'anon';
  assert v_n = 0,
    format('anon must hold no privilege on the allocation table, found %s', v_n);

  select count(*) into v_n
  from pg_policy p join pg_class t on t.oid = p.polrelid
  where t.relname = 'finance_payment_allocations' and p.polcmd in ('a', 'w', 'd');
  assert v_n = 0,
    format('the allocation table must carry no INSERT/UPDATE/DELETE policy, found %s', v_n);

  -- CORRECTION 2. No RESTRICTIVE policy of any kind on this table: a restrictive
  -- policy ANDs onto every permissive one, which is precisely what would hide a
  -- salesperson's own PI or Order payment from them unless somebody also granted
  -- them Finance-module access.
  select count(*) into v_n
  from pg_policy p join pg_class t on t.oid = p.polrelid
  where t.relname = 'finance_payment_allocations' and p.polpermissive = false;
  assert v_n = 0,
    format('the allocation table must carry no RESTRICTIVE policy, found %s', v_n);
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

  -- ── The other half of the same invariant, and the one Correction 1 makes
  --    load-bearing: the AMOUNT may not drop below what is already allocated.
  --    An unverified payment is now allocatable AND still editable by its own
  --    submitter, so this has to hold on every path that can change `amount`.
  begin
    update public.finance_payment_requests
       set amount = 100.00
     where id = current_setting('test.pay_a')::uuid;
    assert false, 'reducing a payment below its allocated total must be refused';
  exception when raise_exception then
    assert sqlerrm like '%PAYMENT_BELOW_ALLOCATED%',
      format('an under-cutting correction must raise PAYMENT_BELOW_ALLOCATED, got: %s', sqlerrm);
  end;

  -- It is a TRIGGER and not an RPC check, which is what makes it total. The
  -- commonest edit in the whole module is the SUBMITTER correcting their own
  -- PENDING request through finance_payment_requests_own_update — a direct
  -- PostgREST PATCH that touches no RPC at all, and exactly the path Correction
  -- 1 puts at risk by making a pending payment allocatable.
  --
  -- Tested on a scratch pending payment of its own, because the owner-update
  -- policy does not reach an already-approved row: an UPDATE that matches no row
  -- raises nothing, and would have looked like a pass.
  declare
    v_scratch uuid := gen_random_uuid();
    v_rows    integer;
  begin
    insert into public.finance_payment_requests
      (id, client_name, amount, payment_date, payment_mode, received_in, status, submitted_by)
    values (v_scratch, 'ASSERT owner edit', 800.00, current_date, 'upi', 'company_account',
            'pending_approval', current_setting('test.allocator_id')::uuid);

    perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);
    perform public.allocate_payment_to_target(v_scratch, null, current_setting('test.ord')::uuid, 800.00);

    perform set_config('role', 'authenticated', true);

    -- First prove the path is LIVE — the owner really can edit this row — so the
    -- refusal below cannot be a silent zero-row update masquerading as a pass.
    update public.finance_payment_requests set sales_note = 'ASSERT reachable' where id = v_scratch;
    get diagnostics v_rows = row_count;
    assert v_rows = 1, 'the fixture must be editable by its submitter, or this proves nothing';

    begin
      update public.finance_payment_requests set amount = 1.00 where id = v_scratch;
      assert false, 'the submitter''s own edit must not be able to undercut an allocation';
    exception when raise_exception then
      assert sqlerrm like '%PAYMENT_BELOW_ALLOCATED%',
        format('the owner edit path must raise PAYMENT_BELOW_ALLOCATED, got: %s', sqlerrm);
    end;

    -- Raising it on the same path is fine.
    update public.finance_payment_requests set amount = 900.00 where id = v_scratch;
    get diagnostics v_rows = row_count;
    assert v_rows = 1, 'the submitter must still be able to raise their own pending amount';

    perform set_config('role', 'postgres', true);

    -- Clean the scratch pair away: an unverified payment releases its own
    -- allocations, which the deletion section proves separately.
    delete from public.finance_payment_requests where id = v_scratch;
  end;

  -- The guard is scoped to an actual amount CHANGE, so it is attached to the
  -- payment table and fires BEFORE UPDATE for every role — asserted rather than
  -- assumed, because an RPC-only check would silently miss the PATCH paths.
  assert exists (
    select 1 from pg_trigger g join pg_class t on t.oid = g.tgrelid
    where t.relname = 'finance_payment_requests'
      and g.tgname  = 'finance_payment_requests_guard_allocated_amount'
      and g.tgtype & 2 = 2      -- BEFORE
      and g.tgtype & 16 = 16    -- UPDATE
  ), 'the payment-side guard must be a BEFORE UPDATE row trigger on the payment table';

  -- ── AT OR ABOVE the allocated total is allowed, in both directions ────────
  --
  -- As the ADMIN, because pay_a is already approved and
  -- finance_payment_requests_guard_approved (20260901000000) reserves correcting
  -- a recorded payment to an admin or a finance.manage holder. That existing
  -- authority is unchanged by this phase — the point here is that the allocation
  -- guard does not take it away, only bounds it from below.
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);

  -- Exactly equal to the allocated total: permitted, because the invariant is
  -- "never exceed", not "always leave a remainder".
  update public.finance_payment_requests
     set amount = 1000.00
   where id = current_setting('test.pay_a')::uuid;
  assert (select amount from public.finance_payment_requests
          where id = current_setting('test.pay_a')::uuid) = 1000.00,
    'a correction to exactly the allocated total must be allowed';

  -- And an INCREASE, which is the ordinary correct-and-verify case: Finance
  -- raises the figure to what actually arrived.
  update public.finance_payment_requests
     set amount = 1500.00
   where id = current_setting('test.pay_a')::uuid;
  assert (select amount from public.finance_payment_requests
          where id = current_setting('test.pay_a')::uuid) = 1500.00,
    'raising a payment above its allocated total must be allowed';

  -- The extra headroom is real: it shows up in the derived balance immediately,
  -- with nothing to recompute.
  assert (select f.amount - coalesce(sum(a.allocated_amount), 0)
          from public.finance_payment_requests f
          left join public.finance_payment_allocations a
            on a.payment_request_id = f.id and a.status = 'active'
          where f.id = current_setting('test.pay_a')::uuid
          group by f.amount) = 500.00,
    'the derived balance must follow a corrected amount with no recomputation';

  -- Put it back, so the totals the later sections assert still hold.
  update public.finance_payment_requests
     set amount = 1000.00
   where id = current_setting('test.pay_a')::uuid;
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

-- ═══ 14 + CORRECTION 3. Nothing deletes financial history by side effect ═══
do $$
declare v_before bigint; v_after bigint;
begin
  select count(*) into v_before from public.finance_payment_allocations;

  -- ── The allocation itself ────────────────────────────────────────────────
  begin
    delete from public.finance_payment_allocations
     where payment_request_id = current_setting('test.pay_a')::uuid;
    assert false, 'an allocation must never be deletable';
  exception when insufficient_privilege then
    assert sqlerrm like '%ALLOCATION_PERMANENT%',
      format('deleting an allocation must raise ALLOCATION_PERMANENT, got: %s', sqlerrm);
  end;

  -- ── A VERIFIED parent payment, unchanged from 20260705000000 ────────────
  begin
    delete from public.finance_payment_requests where id = current_setting('test.pay_a')::uuid;
    assert false, 'a verified payment must never be deletable';
  exception when insufficient_privilege then
    assert sqlerrm like '%PAYMENT_APPROVED_PERMANENT%',
      format('deleting a verified payment must raise PAYMENT_APPROVED_PERMANENT, got: %s', sqlerrm);
  end;

  -- ── An ORDER carrying an allocation ─────────────────────────────────────
  -- Refused twice over, and both are asserted because they fail at different
  -- layers: prevent_order_delete (20260705000000) refuses first, and the NO
  -- ACTION foreign key would refuse even if that guard were stood down. The
  -- second half is proved below, inside a cleanup context where the guard does
  -- stand down.
  begin
    delete from public.orders where id = current_setting('test.ord')::uuid;
    assert false, 'an Order carrying an allocation must not be deletable';
  exception
    when insufficient_privilege then null;      -- prevent_order_delete
    when foreign_key_violation then null;       -- the NO ACTION FK
  end;

  -- ── A PI carrying an allocation ─────────────────────────────────────────
  begin
    delete from public.order_submissions where id = current_setting('test.sub')::uuid;
    assert false, 'a PI carrying an allocation must not be deletable';
  exception
    when insufficient_privilege then null;      -- order_submissions_guard_delete
    when foreign_key_violation then null;       -- the NO ACTION FK
  end;

  -- ── NOTHING WAS LOST TO ANY OF THOSE ATTEMPTS ───────────────────────────
  select count(*) into v_after from public.finance_payment_allocations;
  assert v_after = v_before,
    format('a refused deletion must remove no allocation (before %s, after %s)', v_before, v_after);
end $$;

-- ── The foreign keys are the guarantee, not the guards ─────────────────────
-- Proved by standing the target-side guards down (the cleanup context does
-- exactly that) and showing the FK still refuses. This is what stops a future
-- deletion path — one that legitimately holds the cleanup marker, or a service
-- role script — from quietly taking allocation history with it.
do $$
declare v_before bigint;
begin
  select count(*) into v_before from public.finance_payment_allocations;
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);

  begin
    delete from public.orders where id = current_setting('test.ord')::uuid;
    assert false, 'the NO ACTION foreign key must refuse an Order that an allocation names';
  exception when foreign_key_violation then null;
  end;

  begin
    delete from public.order_submissions where id = current_setting('test.sub')::uuid;
    assert false, 'the NO ACTION foreign key must refuse a PI that an allocation names';
  exception when foreign_key_violation then null;
  end;

  perform set_config('boe.cleanup_context', '', true);

  assert (select count(*) from public.finance_payment_allocations) = v_before,
    'neither refused target deletion may remove allocation history';

  -- And no foreign key on this table cascades or nulls, so there is no path at
  -- all by which a target deletion could reach an allocation implicitly.
  assert not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_payment_allocations'::regclass
      and contype = 'f' and confdeltype <> 'a'
  ), 'no allocation foreign key may cascade or set null on delete';
end $$;

-- ── An UNVERIFIED payment is still deletable, and takes its own allocations ─
-- The rule 20260705000000 states — an unapproved request "represents a mistake
-- rather than an event" — is preserved. Its allocations describe money that was
-- never confirmed, so leaving them behind would be false history pointing at a
-- payment that no longer exists.
do $$
declare v_pay uuid; v_other bigint; v_other_after bigint;
begin
  v_pay := gen_random_uuid();

  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, received_in, status, submitted_by)
  values (v_pay, 'ASSERT alloc disposable', 400.00, current_date, 'cash', 'cash_in_hand',
          'pending_approval', current_setting('test.allocator_id')::uuid);

  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);
  perform public.allocate_payment_to_target(v_pay, null, current_setting('test.ord')::uuid, 400.00);

  assert (select count(*) from public.finance_payment_allocations where payment_request_id = v_pay) = 1,
    'the disposable payment should hold one allocation before deletion';

  -- Everything NOT belonging to this payment, so we can prove the release is
  -- pinned to the one payment being deleted.
  select count(*) into v_other from public.finance_payment_allocations
   where payment_request_id <> v_pay;

  delete from public.finance_payment_requests where id = v_pay;

  assert not exists (select 1 from public.finance_payment_requests where id = v_pay),
    'an unverified payment must still be deletable';
  assert not exists (select 1 from public.finance_payment_allocations where payment_request_id = v_pay),
    'deleting an unverified payment must release its own allocations';

  select count(*) into v_other_after from public.finance_payment_allocations
   where payment_request_id <> v_pay;
  assert v_other_after = v_other,
    'the release must be pinned to the deleted payment and touch nothing else';

  -- And the door is shut again the moment that statement ends.
  begin
    delete from public.finance_payment_allocations
     where payment_request_id = current_setting('test.pay_b')::uuid;
  exception when insufficient_privilege then null;
  end;
  assert not public.in_payment_allocation_release(current_setting('test.pay_a')::uuid),
    'the release marker must not survive the statement that set it';
end $$;

-- ═══ CORRECTION 1. An UNVERIFIED payment may be allocated ══════════════════
--
-- The confirmed workflow is: Sales records the money against a PI or an Order,
-- the payment and its allocation read as Awaiting Verification, and Finance then
-- verifies, corrects-and-verifies or rejects it. Requiring verification first
-- would invert that sequence.
do $$
declare v_r jsonb; v_alloc uuid; v_before bigint; v_after bigint;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

  -- 1. A PENDING payment can be allocated to a PI.
  v_r := public.allocate_payment_to_target(
    current_setting('test.pay_pending')::uuid, current_setting('test.sub')::uuid, null, 200.00);
  assert (v_r->>'target_type') = 'order_submission',
    'a pending payment must be allocatable to a PI submission';

  -- 2. A PENDING payment can be allocated to an Order.
  v_r := public.allocate_payment_to_target(
    current_setting('test.pay_pending')::uuid, null, current_setting('test.ord')::uuid, 100.00);
  assert (v_r->>'target_type') = 'confirmed_order',
    'a pending payment must be allocatable to a Confirmed Order';

  -- 3. PARTIAL: 200 + 100 of 700 leaves 400 unallocated, derived not stored.
  assert (v_r->>'unallocated_balance')::numeric = 400.00,
    format('a partly allocated pending payment must report the remainder, got %s',
           v_r->>'unallocated_balance');

  -- 4. VERIFICATION LIVES ON THE PARENT, NOT THE ALLOCATION. Both allocations
  --    are plain 'active'; nothing anywhere records "pending allocation".
  assert not exists (
    select 1 from public.finance_payment_allocations
    where payment_request_id = current_setting('test.pay_pending')::uuid
      and status <> 'active'
  ), 'an allocation on an unverified payment is still simply active';

  assert not exists (
    select 1 from information_schema.columns
    where table_name = 'finance_payment_allocations'
      and column_name in ('verified', 'is_verified', 'verification_status', 'verified_at')
  ), 'the allocation table must carry no verification state of its own';

  -- 5. PAYMENT STATUS CHANGES NEITHER DELETE NOR REWRITE ALLOCATIONS.
  select count(*) into v_before
  from public.finance_payment_allocations
  where payment_request_id = current_setting('test.pay_pending')::uuid;

  -- pending -> needs_clarification -> pending -> approved_unlinked, the real
  -- clarification loop, driven directly so no RPC hides it.
  update public.finance_payment_requests
     set status = 'needs_clarification', clarification_requested_at = now()
   where id = current_setting('test.pay_pending')::uuid;

  select count(*) into v_after
  from public.finance_payment_allocations
  where payment_request_id = current_setting('test.pay_pending')::uuid;
  assert v_after = v_before,
    'returning a payment for clarification must not touch its allocations';

  update public.finance_payment_requests
     set status = 'pending_approval'
   where id = current_setting('test.pay_pending')::uuid;
  update public.finance_payment_requests
     set status = 'approved_unlinked', approved_by = current_setting('test.admin_id')::uuid, approved_at = now()
   where id = current_setting('test.pay_pending')::uuid;

  select count(*) into v_after
  from public.finance_payment_allocations
  where payment_request_id = current_setting('test.pay_pending')::uuid;
  assert v_after = v_before,
    'verifying a payment must not add, remove or rewrite an allocation';

  assert (select sum(allocated_amount) from public.finance_payment_allocations
          where payment_request_id = current_setting('test.pay_pending')::uuid
            and status = 'active') = 300.00,
    'the allocated amounts must survive the whole status journey unchanged';
end $$;

-- ── A REJECTED payment RETAINS its allocation history ───────────────────────
do $$
declare v_r jsonb; v_n bigint;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

  -- Allocated while pending, which is the normal case.
  v_r := public.allocate_payment_to_target(
    current_setting('test.pay_reject')::uuid, null, current_setting('test.ord')::uuid, 300.00);

  -- Finance then rejects the money.
  update public.finance_payment_requests
     set status = 'rejected', rejected_at = now()
   where id = current_setting('test.pay_reject')::uuid;

  -- THE ROW SURVIVES. A rejection is frequently corrected and reapplied
  -- (20260695000000), and destroying the allocation would make the salesperson
  -- restate what the money was for.
  select count(*) into v_n
  from public.finance_payment_allocations
  where payment_request_id = current_setting('test.pay_reject')::uuid and status = 'active';
  assert v_n = 1, 'a rejected payment must retain its allocation row';

  -- BUT IT IS NOT VERIFIED MONEY, and the single definition says so.
  assert not public.finance_payment_status_is_verified('rejected'),
    'a rejected payment must never count as verified';
  assert not public.finance_payment_status_is_verified('pending_approval'),
    'a pending payment must never count as verified';
  assert not public.finance_payment_status_is_verified('needs_clarification'),
    'a payment awaiting clarification must never count as verified';
  assert public.finance_payment_status_is_verified('approved_unlinked'),
    'approved_unlinked is verified money';
  assert public.finance_payment_status_is_verified('approved_linked'),
    'approved_linked is verified money';

  -- A NEW allocation on a rejected payment is refused; the existing one stays.
  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_reject')::uuid, current_setting('test.sub')::uuid, null, 1.00);
    assert false, 'a rejected payment must not receive a NEW allocation';
  exception when raise_exception then
    assert sqlerrm like '%PAYMENT_REJECTED%',
      format('a rejected payment must raise PAYMENT_REJECTED, got: %s', sqlerrm);
  end;

  select count(*) into v_n
  from public.finance_payment_allocations
  where payment_request_id = current_setting('test.pay_reject')::uuid;
  assert v_n = 1, 'the refusal must not have disturbed the retained allocation';
end $$;

-- ── A future verified total can separate the parent statuses ───────────────
-- The Phase 3 calculation is NOT built here. What is proved is that it CAN be
-- built from what Phase 1 stores: one join, no allocation status involved.
do $$
declare v_verified numeric; v_all numeric;
begin
  select coalesce(sum(a.allocated_amount), 0) into v_verified
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_id = current_setting('test.ord')::uuid
    and a.status = 'active'
    and public.finance_payment_status_is_verified(f.status);

  select coalesce(sum(a.allocated_amount), 0) into v_all
  from public.finance_payment_allocations a
  where a.order_id = current_setting('test.ord')::uuid and a.status = 'active';

  -- Against this Order: 600 (verified pay_a) + 100 (pay_pending, since verified
  -- above) = 700 verified, plus 300 from the REJECTED payment = 1000 in total.
  assert v_all = v_verified + 300.00,
    format('the rejected 300 must be excluded from the verified total (all %s, verified %s)', v_all, v_verified);
  assert v_verified = 700.00,
    format('expected 700.00 of verified allocation against the Order, got %s', v_verified);
end $$;

-- ── Target eligibility, unchanged by Correction 1 ──────────────────────────
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);

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

  -- The three target states the RPC refuses outright are asserted from the
  -- DEPLOYED body: reaching them live would need a full approval or rejection
  -- run, which belongs to those phases' own assertion files, not this one.
  --
  -- READ FROM THE IMPLEMENTATION, NOT THE DOOR. 20260919000000 split this into
  -- allocate_payment_to_target_internal (the rules) and
  -- allocate_payment_to_target (the finance.allocate door), so the PI payment
  -- entry path can reuse the rules without duplicating them. The properties
  -- asserted are unchanged; only where they live has moved, and the delegation
  -- is asserted immediately below so the door cannot drift away from them.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target_internal')
         like '%ALLOCATION_TARGET_CONVERTED%',
    'an approved PI must be refused — allocate to its Order instead';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target_internal')
         like '%ALLOCATION_TARGET_NOT_ACTIVE%',
    'a rejected PI and a cancelled Order must be refused';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target_internal')
         like '%ALLOCATION_TARGET_CLAIMED%',
    'a PI reserved for deletion must be refused';

  -- And the verification gate is GONE, not merely bypassed.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target_internal')
         not like '%PAYMENT_NOT_VERIFIED%',
    'the RPC must no longer require the payment to be verified';

  -- THE DOOR STILL GUARDS AND STILL DELEGATES. Without both halves the split
  -- could silently become a bypass: rules with no door, or a door with no rules.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target')
         like '%actor_has_module_permission(''finance'', ''allocate'')%',
    'the public door must still require finance.allocate';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'allocate_payment_to_target')
         like '%allocate_payment_to_target_internal%',
    'the public door must delegate to the shared implementation';
  -- The implementation is reachable by no client role, so the door is the only
  -- way in from a browser.
  assert not exists (
    select 1
    from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) a
    join pg_roles r on r.oid = a.grantee
    where pr.proname = 'allocate_payment_to_target_internal'
      and r.rolname in ('anon', 'authenticated', 'public')
  ), 'the shared implementation must not be executable by any client role';
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

-- ═══ CORRECTION 2. A PI or Order owner sees their own money, with NO Finance ══
--
-- The confirmed rule: Sales may see the payment attached to a PI or Order they
-- uploaded or own, WITHOUT holding Finance-module access — and must see nothing
-- else, and gain no authority at all.
--
-- Every check below runs as the `authenticated` role with the salesperson's
-- session, so RLS actually decides the answer rather than a superuser connection
-- silently bypassing it.
do $$
declare v_r jsonb;
begin
  -- Set up: allocate the salesperson's payment to THEIR PI and THEIR Order.
  --
  -- Done by the ADMIN, and the reason is itself a check on the design: the
  -- allocator holds finance.allocate but is not a participant of the
  -- salesperson's PI and has no finance.view_all, so the RPC refuses them the
  -- target — allocation authority does not carry sight of records it has no
  -- business with. The salesperson cannot do it either; allocating is a Finance
  -- authority they deliberately do not hold.
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  v_r := public.allocate_payment_to_target(
    current_setting('test.pay_sales')::uuid, current_setting('test.sub2')::uuid, null, 100.00);
  v_r := public.allocate_payment_to_target(
    current_setting('test.pay_sales')::uuid, null, current_setting('test.ord2')::uuid, 150.00);
end $$;

do $$
declare v_action text;
begin
  -- THE PREMISE, ASSERTED. This account holds Order Management entry and NOT ONE
  -- Finance action. If that ever stops being true, everything below would pass
  -- for the wrong reason.
  assert public.resolve_permission(current_setting('test.sales_id')::uuid, 'orders', 'view'),
    'the fixture salesperson must hold orders.view';

  foreach v_action in array array['view', 'view_all', 'create', 'edit', 'delete',
                                  'approve', 'export', 'manage', 'allocate', 'allocate_correct']
  loop
    assert not public.resolve_permission(current_setting('test.sales_id')::uuid, 'finance', v_action),
      format('the fixture salesperson must hold no Finance action, but resolves finance.%s', v_action);
  end loop;

  assert (select role from public.users where id = current_setting('test.sales_id')::uuid) <> 'admin',
    'the fixture salesperson must not be an admin, or the admin bypass would explain everything';
end $$;

do $$
declare v_n bigint;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  perform set_config('role', 'authenticated', true);

  -- Finance really is closed to them.
  assert not public.module_entry_open('finance'),
    'the fixture salesperson must have no Finance module entry';

  -- 1. THE PI THEY UPLOADED — readable.
  select count(*) into v_n from public.finance_payment_allocations
   where order_submission_id = current_setting('test.sub2')::uuid;
  assert v_n = 1,
    format('a PI participant with no Finance access must read their PI allocation, saw %s', v_n);

  -- 2. THE ORDER THEY OWN — readable.
  select count(*) into v_n from public.finance_payment_allocations
   where order_id = current_setting('test.ord2')::uuid;
  assert v_n = 1,
    format('an Order participant with no Finance access must read their Order allocation, saw %s', v_n);

  -- 3. SOMEBODY ELSE'S RECORDS — invisible. The allocator's PI, the allocator's
  --    Order, and every allocation on them.
  select count(*) into v_n from public.finance_payment_allocations
   where order_submission_id = current_setting('test.sub')::uuid
      or order_id            = current_setting('test.ord')::uuid;
  assert v_n = 0,
    format('an unrelated PI or Order allocation must be invisible, saw %s', v_n);

  -- 4. AND NOTHING ELSE AT ALL. Exactly the two rows on their own records.
  select count(*) into v_n from public.finance_payment_allocations;
  assert v_n = 2,
    format('the salesperson must see exactly their own two allocations, saw %s', v_n);

  perform set_config('role', 'postgres', true);
end $$;

-- ── Seeing is not doing ────────────────────────────────────────────────────
do $$
declare v_r jsonb; v_alloc uuid;
begin
  select id into v_alloc from public.finance_payment_allocations
   where order_submission_id = current_setting('test.sub2')::uuid;

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);

  -- No allocate.
  begin
    v_r := public.allocate_payment_to_target(
      current_setting('test.pay_sales')::uuid, null, current_setting('test.ord2')::uuid, 1.00);
    assert false, 'reading an allocation must not confer finance.allocate';
  exception when insufficient_privilege then null;
  end;

  -- No reverse.
  begin
    v_r := public.reverse_payment_allocation(v_alloc, 'not mine to reverse');
    assert false, 'reading an allocation must not confer finance.allocate_correct';
  exception when insufficient_privilege then null;
  end;

  -- No direct write of any kind.
  perform set_config('role', 'authenticated', true);
  begin
    insert into public.finance_payment_allocations
      (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
    values (current_setting('test.pay_sales')::uuid, current_setting('test.ord2')::uuid,
            1.00, 'confirmed_order', current_setting('test.sales_id')::uuid);
    assert false, 'a participant must not be able to INSERT an allocation';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.finance_payment_allocations set allocated_amount = 1.00 where id = v_alloc;
    assert false, 'a participant must not be able to UPDATE an allocation';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.finance_payment_allocations where id = v_alloc;
    assert false, 'a participant must not be able to DELETE an allocation';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);

  -- THE PARENT PAYMENT. Phase 1 deliberately left finance_payment_requests
  -- unwidened and recorded it as a required Phase 2 dependency: the payment card
  -- needs the amount, the mode, the date, the Finance remark and the rejection
  -- reason, and all of those live on the parent row.
  --
  -- 20260919000000 PAID that dependency, so the participant can now read the
  -- payment behind their own allocation. The assertion is inverted rather than
  -- deleted, because the property still matters — what changed is which way it
  -- points, and a silent removal would leave nobody checking either direction.
  -- The full participant scoping (only their own records, and no mutation) is
  -- asserted in pi_submission_payment_assertions.sql.
  perform set_config('role', 'authenticated', true);
  assert exists (
    select 1 from public.finance_payment_requests
    where id = current_setting('test.pay_sales')::uuid
  ), 'a participant must be able to read the payment behind their own allocation';
  perform set_config('role', 'postgres', true);
end $$;

-- ── Admin and finance.view_all are untouched ──────────────────────────────
do $$
declare v_admin bigint; v_viewall bigint; v_total bigint; v_uid uuid;
begin
  select count(*) into v_total from public.finance_payment_allocations;

  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_admin from public.finance_payment_allocations;
  perform set_config('role', 'postgres', true);
  assert v_admin = v_total,
    format('an admin must still see every allocation (%s of %s)', v_admin, v_total);

  -- A finance.view_all holder with no Orders access and no ownership of anything.
  v_uid := current_setting('test.outsider_id')::uuid;
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  select v_uid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
  from public.permission_modules pm
  join public.permission_actions pa on pa.action_key in ('view', 'view_all')
  where pm.module_key = 'finance';

  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_viewall from public.finance_payment_allocations;
  perform set_config('role', 'postgres', true);
  assert v_viewall = v_total,
    format('a finance.view_all holder must still see every allocation (%s of %s)', v_viewall, v_total);

  -- But view_all is still SELECT only — it confers no allocation authority.
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  begin
    perform public.allocate_payment_to_target(
      current_setting('test.pay_b')::uuid, null, current_setting('test.ord')::uuid, 1.00);
    assert false, 'finance.view_all must not confer finance.allocate';
  exception when insufficient_privilege then null;
  end;
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

  -- NOTHING CASCADES (Correction 3). Cleanup reaches allocations through the
  -- payment's own release trigger instead, which is exactly why
  -- finalize_test_data_cleanup() needs no change: its existing
  -- `delete from public.finance_payment_requests` fires that trigger.
  select count(*) into v_n
  from pg_constraint
  where conrelid = 'public.finance_payment_allocations'::regclass
    and contype = 'f' and confdeltype <> 'a';
  assert v_n = 0,
    format('no allocation foreign key may cascade or set null, found %s', v_n);

  -- The route cleanup actually takes, exercised end to end: set the marker the
  -- executor sets, delete a payment exactly as step 2 of finalize does, and the
  -- allocations go with it. No cleanup function is restated and no claim or
  -- finalize safeguard is touched.
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  delete from public.finance_payment_requests where id = current_setting('test.pay_a')::uuid;
  assert not exists (
    select 1 from public.finance_payment_allocations
    where payment_request_id = current_setting('test.pay_a')::uuid
  ), 'a cleanup payment delete must carry its allocations with it';
  perform set_config('boe.cleanup_context', '', true);

  -- And the door closes again immediately: outside the cleanup context a direct
  -- allocation delete is refused, exactly as before.
  begin
    delete from public.finance_payment_allocations
     where payment_request_id = current_setting('test.pay_sales')::uuid;
    assert false, 'the cleanup exemption must not survive the transaction-local reset';
  exception when insufficient_privilege then
    assert sqlerrm like '%ALLOCATION_PERMANENT%',
      format('outside cleanup, deletion must raise ALLOCATION_PERMANENT, got: %s', sqlerrm);
  end;

  -- The claim/finalize protections themselves are untouched: neither function is
  -- redefined by this migration.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'finalize_test_data_cleanup')
         not like '%finance_payment_allocations%',
    'finalize_test_data_cleanup must not have been restated by this phase';
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
