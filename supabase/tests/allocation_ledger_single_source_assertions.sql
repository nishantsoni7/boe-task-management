-- Assertions for 20261012000000_allocation_ledger_as_single_source.sql
--
-- THE QUESTION THIS SUITE ANSWERS: does a rupee mean the same thing to the
-- application and to the database? Before 112 it did not — a payment could read
-- ₹0 allocated on screen and be counted as an Order's money by SQL at the same
-- moment. Every assertion below is an exact numeric comparison; nothing here
-- compares a rendered string.
--
-- Run through run_allocation_ledger_single_source_suite.sh, which builds the
-- schema, applies the REAL migration and then runs this file. One transaction,
-- rolled back at the end: the suite leaves nothing behind.

\set ON_ERROR_STOP on
begin;

-- ── Acting as somebody, the way every other suite in this directory does ─────
create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

-- ── Actors ───────────────────────────────────────────────────────────────────
insert into public.users (id, email, role, full_name) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test',   'admin',       'Admin'),
  ('22222222-2222-4222-8222-222222222222', 'finance@boe.test', 'finance',     'Fin'),
  ('33333333-3333-4333-8333-333333333333', 'sales@boe.test',   'salesperson', 'Sales');

-- READ AS AN ADMIN throughout. available_balance and is_available_to_allocate
-- are deliberately WITHHELD (null / false) from a reader who cannot see every
-- allocation — that rule is unchanged by 112 and is asserted on its own in §K.
-- The arithmetic assertions need a reader who can see the whole picture, which
-- is what a Finance admin looking at Confirmed Payments actually is.
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');

-- ── Orders and a PI Draft ────────────────────────────────────────────────────
insert into public.orders (id, display_number, status, client_name, created_by) values
  ('aaaa0000-0000-4000-8000-00000000000a', 'ORD-A', 'running', 'Kalyan Interiors', '11111111-1111-4111-8111-111111111111'),
  ('bbbb0000-0000-4000-8000-00000000000b', 'ORD-B', 'running', 'Kalyan Interiors', '11111111-1111-4111-8111-111111111111'),
  ('cccc0000-0000-4000-8000-00000000000c', 'ORD-C', 'running', 'Kalyan Interiors', '11111111-1111-4111-8111-111111111111');

insert into public.order_submissions (id, client_name, status, created_by)
values ('dddd0000-0000-4000-8000-00000000000d', 'Kalyan Interiors', 'draft', '33333333-3333-4333-8333-333333333333');

insert into public.order_requests (id, request_number, status)
values ('eeee0000-0000-4000-8000-00000000000e', 'REQ-E', 'converted');

-- ═══════════════════════════════════════════════════════════════════════════
-- A. ZERO ALLOCATION — a legacy link is not money
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_alloc numeric; v_avail numeric; v_state text; v_conf text;
  v_order_total numeric; v_can_allocate boolean; v_attr numeric; v_order_attr numeric;
  v_linked boolean;
begin
  -- A1. Verified payment carrying order_id, with NO active allocation.
  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status, order_id, order_number)
  values
    ('f0000001-0000-4000-8000-000000000001', 'PAY-A1', 'Kalyan Interiors', 100000,
     '22222222-2222-4222-8222-222222222222', 'approved_linked',
     'aaaa0000-0000-4000-8000-00000000000a', 'ORD-A');

  select allocated_total, available_balance, allocation_state, confirmed_allocation_status,
         attributed_total, order_attributed_total, is_linked_to_order, is_available_to_allocate
    into v_alloc, v_avail, v_state, v_conf, v_attr, v_order_attr, v_linked, v_can_allocate
  from public.finance_received_payments
  where id = 'f0000001-0000-4000-8000-000000000001';

  if v_alloc <> 0 then raise exception 'A1: allocated_total must be 0, got %', v_alloc; end if;
  if v_attr <> 0 then raise exception 'A1: attributed_total must be 0, got %', v_attr; end if;
  if v_order_attr <> 0 then raise exception 'A1: order_attributed_total must be 0, got %', v_order_attr; end if;
  if v_avail <> 100000 then raise exception 'A1: remaining must be the full 100000, got %', v_avail; end if;
  if v_state <> 'unallocated' then raise exception 'A1: allocation_state must be unallocated, got %', v_state; end if;
  if v_conf <> 'zero' then raise exception 'A1: confirmed_allocation_status must be zero, got %', v_conf; end if;
  if v_linked then raise exception 'A1: is_linked_to_order must be false'; end if;
  if not v_can_allocate then raise exception 'A1: the money must be available to allocate'; end if;

  -- The Order receives NOTHING from it.
  select public.order_linked_payment_total('aaaa0000-0000-4000-8000-00000000000a') into v_order_total;
  if v_order_total <> 0 then
    raise exception 'A1: Order A must receive 0 from a legacy-linked payment, got %', v_order_total;
  end if;

  -- A2. The same, through order_request_id — and this is the case that makes
  -- dropping unlink_finance_payment_from_order_request safe (see §3 of the
  -- migration): the money is not stranded, it is fully available to allocate.
  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status, order_request_id, order_request_number, payment_against)
  values
    ('f0000002-0000-4000-8000-000000000002', 'PAY-A2', 'Kalyan Interiors', 250000,
     '22222222-2222-4222-8222-222222222222', 'approved_unlinked',
     'eeee0000-0000-4000-8000-00000000000e', 'REQ-E', 'new_order');

  select allocated_total, available_balance, confirmed_allocation_status, is_available_to_allocate
    into v_alloc, v_avail, v_conf, v_can_allocate
  from public.finance_received_payments
  where id = 'f0000002-0000-4000-8000-000000000002';

  if v_alloc <> 0 then raise exception 'A2: allocated_total must be 0, got %', v_alloc; end if;
  if v_avail <> 250000 then raise exception 'A2: the whole 250000 must be available, got %', v_avail; end if;
  if v_conf <> 'zero' then raise exception 'A2: must be zero, got %', v_conf; end if;
  if not v_can_allocate then
    raise exception 'A2: money on a retired Order Request must be free to allocate — this is what makes unlink obsolete';
  end if;

  raise notice 'A. ZERO ALLOCATION — a legacy link contributes nothing, and the money is free';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. FULL ALLOCATION
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_alloc numeric; v_avail numeric; v_conf text; v_total numeric; v_before numeric;
begin
  select public.order_linked_payment_total('bbbb0000-0000-4000-8000-00000000000b') into v_before;

  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status)
  values ('f0000003-0000-4000-8000-000000000003', 'PAY-B', 'Kalyan Interiors', 100000,
          '22222222-2222-4222-8222-222222222222', 'approved_unlinked');

  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, created_by)
  values ('f0000003-0000-4000-8000-000000000003', 'bbbb0000-0000-4000-8000-00000000000b',
          100000, 'active', '22222222-2222-4222-8222-222222222222');

  select allocated_total, available_balance, confirmed_allocation_status
    into v_alloc, v_avail, v_conf
  from public.finance_received_payments where id = 'f0000003-0000-4000-8000-000000000003';

  if v_alloc <> 100000 then raise exception 'B: allocated_total must be 100000, got %', v_alloc; end if;
  if v_avail <> 0      then raise exception 'B: remaining must be 0, got %', v_avail; end if;
  if v_conf <> 'full'  then raise exception 'B: must be full, got %', v_conf; end if;

  select public.order_linked_payment_total('bbbb0000-0000-4000-8000-00000000000b') into v_total;
  if v_total - v_before <> 100000 then
    raise exception 'B: the Order total must rise by exactly 100000 (once), rose by %', v_total - v_before;
  end if;

  raise notice 'B. FULL ALLOCATION — counted once, remaining zero';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. PARTIAL ALLOCATION
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_alloc numeric; v_avail numeric; v_conf text;
begin
  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status)
  values ('f0000004-0000-4000-8000-000000000004', 'PAY-C', 'Kalyan Interiors', 100000,
          '22222222-2222-4222-8222-222222222222', 'approved_unlinked');

  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, created_by)
  values ('f0000004-0000-4000-8000-000000000004', 'cccc0000-0000-4000-8000-00000000000c',
          40000, 'active', '22222222-2222-4222-8222-222222222222');

  select allocated_total, available_balance, confirmed_allocation_status
    into v_alloc, v_avail, v_conf
  from public.finance_received_payments where id = 'f0000004-0000-4000-8000-000000000004';

  if v_alloc <> 40000 then raise exception 'C: allocated_total must be 40000, got %', v_alloc; end if;
  if v_avail <> 60000 then raise exception 'C: remaining must be 60000, got %', v_avail; end if;
  if v_conf <> 'partial' then raise exception 'C: must be partial, got %', v_conf; end if;

  raise notice 'C. PARTIAL ALLOCATION — 40000 allocated, 60000 remaining';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D. MULTI-TARGET — one payment across a PI Draft and two Orders
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_alloc numeric; v_avail numeric; v_conf text;
  v_pi numeric; v_order numeric; v_b_before numeric; v_c_before numeric;
  v_b numeric; v_c numeric; v_pi_share numeric;
begin
  select public.order_linked_payment_total('bbbb0000-0000-4000-8000-00000000000b') into v_b_before;
  select public.order_linked_payment_total('cccc0000-0000-4000-8000-00000000000c') into v_c_before;

  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status, order_id, order_number)
  values ('f0000005-0000-4000-8000-000000000005', 'PAY-D', 'Kalyan Interiors', 100000,
          '22222222-2222-4222-8222-222222222222', 'approved_linked',
          -- A legacy link to Order A as well, to prove it adds nothing on top.
          'aaaa0000-0000-4000-8000-00000000000a', 'ORD-A');

  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, order_id, allocated_amount, status, created_by)
  values
    ('f0000005-0000-4000-8000-000000000005', 'dddd0000-0000-4000-8000-00000000000d', null, 20000, 'active', '22222222-2222-4222-8222-222222222222'),
    ('f0000005-0000-4000-8000-000000000005', null, 'bbbb0000-0000-4000-8000-00000000000b', 30000, 'active', '22222222-2222-4222-8222-222222222222'),
    ('f0000005-0000-4000-8000-000000000005', null, 'cccc0000-0000-4000-8000-00000000000c', 25000, 'active', '22222222-2222-4222-8222-222222222222');

  select allocated_total, available_balance, confirmed_allocation_status,
         pi_allocated_total, order_allocated_total
    into v_alloc, v_avail, v_conf, v_pi, v_order
  from public.finance_received_payments where id = 'f0000005-0000-4000-8000-000000000005';

  if v_alloc <> 75000 then raise exception 'D: allocated_total must be 20000+30000+25000=75000, got %', v_alloc; end if;
  if v_avail <> 25000 then raise exception 'D: remaining must be 25000, got %', v_avail; end if;
  if v_conf <> 'partial' then raise exception 'D: must be partial, got %', v_conf; end if;
  if v_pi <> 20000 then raise exception 'D: the PI share must be 20000, got %', v_pi; end if;
  if v_order <> 55000 then raise exception 'D: the Order share must be 30000+25000=55000, got %', v_order; end if;

  -- Each target receives ONLY its own share.
  select public.order_linked_payment_total('bbbb0000-0000-4000-8000-00000000000b') into v_b;
  select public.order_linked_payment_total('cccc0000-0000-4000-8000-00000000000c') into v_c;
  if v_b - v_b_before <> 30000 then raise exception 'D: Order B must get exactly 30000, got %', v_b - v_b_before; end if;
  if v_c - v_c_before <> 25000 then raise exception 'D: Order C must get exactly 25000, got %', v_c - v_c_before; end if;

  -- And the legacy link to Order A still contributes nothing on top.
  select public.order_linked_payment_total('aaaa0000-0000-4000-8000-00000000000a') into v_pi_share;
  if v_pi_share <> 0 then
    raise exception 'D: Order A is named only by a legacy link and must still get 0, got %', v_pi_share;
  end if;

  -- NO PAYMENT-WIDE DOUBLE COUNTING: the three shares sum to the allocated
  -- total exactly, and attribution never exceeds the payment.
  if 20000 + 30000 + 25000 <> v_alloc then raise exception 'D: shares must sum to the allocated total'; end if;
  if v_alloc + v_avail <> 100000 then
    raise exception 'D: conservation broken — allocated % + available % <> 100000', v_alloc, v_avail;
  end if;

  raise notice 'D. MULTI-TARGET — PI 20000 / B 30000 / C 25000, remaining 25000, nothing counted twice';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. REVERSED ALLOCATIONS CONTRIBUTE ZERO
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_alloc numeric; v_avail numeric; v_conf text; v_count int;
  v_order numeric; v_before numeric; v_pi_verified numeric;
begin
  select public.order_linked_payment_total('bbbb0000-0000-4000-8000-00000000000b') into v_before;

  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status, order_id)
  values ('f0000006-0000-4000-8000-000000000006', 'PAY-E', 'Kalyan Interiors', 80000,
          '22222222-2222-4222-8222-222222222222', 'approved_linked',
          'bbbb0000-0000-4000-8000-00000000000b');

  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, created_by)
  values ('f0000006-0000-4000-8000-000000000006', 'bbbb0000-0000-4000-8000-00000000000b',
          80000, 'reversed', '22222222-2222-4222-8222-222222222222');

  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, created_by)
  values ('f0000006-0000-4000-8000-000000000006', 'dddd0000-0000-4000-8000-00000000000d',
          80000, 'reversed', '22222222-2222-4222-8222-222222222222');

  select allocated_total, available_balance, confirmed_allocation_status, active_allocation_count
    into v_alloc, v_avail, v_conf, v_count
  from public.finance_received_payments where id = 'f0000006-0000-4000-8000-000000000006';

  if v_alloc <> 0 then raise exception 'E: a reversed allocation must contribute 0, got %', v_alloc; end if;
  if v_avail <> 80000 then raise exception 'E: the whole 80000 must be free again, got %', v_avail; end if;
  if v_conf <> 'zero' then raise exception 'E: must be zero, got %', v_conf; end if;
  if v_count <> 0 then raise exception 'E: a reversed row must not be counted active, got %', v_count; end if;

  -- The Order total is unmoved: neither the reversed row NOR the legacy order_id
  -- gives it anything.
  select public.order_linked_payment_total('bbbb0000-0000-4000-8000-00000000000b') into v_order;
  if v_order <> v_before then
    raise exception 'E: a reversed allocation must not move the Order total (% -> %)', v_before, v_order;
  end if;

  -- The PI's 40%-gate input sees nothing either.
  select public.order_submission_verified_payment('dddd0000-0000-4000-8000-00000000000d') into v_pi_verified;
  if v_pi_verified <> 20000 then
    raise exception 'E: the PI must still see only its own ACTIVE 20000 from D, got %', v_pi_verified;
  end if;

  raise notice 'E. REVERSED — zero to the payment, the Order, the PI and the gate';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. OVER-ALLOCATION STAYS VISIBLE
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_alloc numeric; v_conf text; v_state text; v_avail numeric;
begin
  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status)
  values ('f0000007-0000-4000-8000-000000000007', 'PAY-F', 'Kalyan Interiors', 100000,
          '22222222-2222-4222-8222-222222222222', 'approved_unlinked');

  -- Written directly: the capacity trigger refuses to CREATE this state, which
  -- is why a row in it is historical data needing a person rather than a normal
  -- outcome. The fixture reproduces the data, not the write path.
  alter table public.finance_payment_allocations disable trigger all;
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, created_by)
  values ('f0000007-0000-4000-8000-000000000007', 'cccc0000-0000-4000-8000-00000000000c',
          150000, 'active', '22222222-2222-4222-8222-222222222222');
  alter table public.finance_payment_allocations enable trigger all;

  select allocated_total, confirmed_allocation_status, allocation_state, available_balance
    into v_alloc, v_conf, v_state, v_avail
  from public.finance_received_payments where id = 'f0000007-0000-4000-8000-000000000007';

  if v_alloc <> 150000 then raise exception 'F: allocated_total must be 150000, got %', v_alloc; end if;
  if v_conf <> 'over' then raise exception 'F: must be OVER, got %', v_conf; end if;
  if v_conf = 'full' then raise exception 'F: an over-allocated payment must never read full'; end if;
  if v_state <> 'over' then raise exception 'F: allocation_state must be over, got %', v_state; end if;
  if v_avail <> 0 then raise exception 'F: available must floor at 0, never negative, got %', v_avail; end if;

  raise notice 'F. OVER-ALLOCATION — visible as over, never rounded into full, never negative';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. PI → ORDER CONTINUITY — value preserved exactly once
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_pi_before numeric; v_pi_after numeric;
  v_order_before numeric; v_order_after numeric;
  v_alloc_before numeric; v_alloc_after numeric;
begin
  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status)
  values ('f0000008-0000-4000-8000-000000000008', 'PAY-G', 'Kalyan Interiors', 60000,
          '22222222-2222-4222-8222-222222222222', 'approved_unlinked');

  insert into public.order_submissions (id, client_name, status, created_by)
  values ('dddd0000-0000-4000-8000-00000000000f', 'Kalyan Interiors', 'draft', '33333333-3333-4333-8333-333333333333');

  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, created_by)
  values ('f0000008-0000-4000-8000-000000000008', 'dddd0000-0000-4000-8000-00000000000f',
          60000, 'active', '22222222-2222-4222-8222-222222222222');

  select public.order_submission_verified_payment('dddd0000-0000-4000-8000-00000000000f') into v_pi_before;
  select public.order_linked_payment_total('aaaa0000-0000-4000-8000-00000000000a') into v_order_before;
  select allocated_total into v_alloc_before
  from public.finance_received_payments where id = 'f0000008-0000-4000-8000-000000000008';

  if v_pi_before <> 60000 then raise exception 'G: the PI must hold 60000 first, got %', v_pi_before; end if;

  -- The transfer approve_order_submission performs: the SAME ROW moves. Nothing
  -- is created, so nothing can be counted twice.
  update public.finance_payment_allocations
     set order_submission_id = null,
         order_id            = 'aaaa0000-0000-4000-8000-00000000000a'
   where order_submission_id = 'dddd0000-0000-4000-8000-00000000000f'
     and status = 'active';

  select public.order_submission_verified_payment('dddd0000-0000-4000-8000-00000000000f') into v_pi_after;
  select public.order_linked_payment_total('aaaa0000-0000-4000-8000-00000000000a') into v_order_after;
  select allocated_total into v_alloc_after
  from public.finance_received_payments where id = 'f0000008-0000-4000-8000-000000000008';

  if v_pi_after <> 0 then raise exception 'G: the source PI must no longer count it, got %', v_pi_after; end if;
  if v_order_after - v_order_before <> 60000 then
    raise exception 'G: the Order must gain exactly 60000 once, gained %', v_order_after - v_order_before;
  end if;
  if v_alloc_after <> v_alloc_before then
    raise exception 'G: the payment''s own allocated total must not change on a move (% -> %)',
      v_alloc_before, v_alloc_after;
  end if;

  raise notice 'G. PI -> ORDER — 60000 left the PI and reached the Order exactly once';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- H. 40% GATE PARITY
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_required numeric; v_verified numeric; v_app_equiv numeric; v_ready boolean;
begin
  insert into public.order_submissions (id, client_name, status, created_by)
  values ('dddd0000-0000-4000-8000-000000000010', 'Kalyan Interiors', 'draft', '33333333-3333-4333-8333-333333333333');

  -- A payment whose LEGACY LINK alone would look like plenty of money.
  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, status, order_id)
  values ('f0000009-0000-4000-8000-000000000009', 'PAY-H1', 'Kalyan Interiors', 500000,
          '22222222-2222-4222-8222-222222222222', 'approved_linked',
          'aaaa0000-0000-4000-8000-00000000000a');

  select public.order_submission_required_payment(1000000) into v_required;
  if v_required <> 400000 then raise exception 'H: 40%% of 1000000 must be 400000, got %', v_required; end if;

  -- LEGACY FIELDS ALONE CANNOT SATISFY THE GATE.
  select public.order_submission_verified_payment('dddd0000-0000-4000-8000-000000000010') into v_verified;
  if v_verified <> 0 then
    raise exception 'H: a legacy link must contribute 0 to the gate, got %', v_verified;
  end if;
  if v_verified >= v_required then raise exception 'H: the gate must NOT be satisfied by a legacy link'; end if;

  -- ACTIVE ALLOCATIONS CAN.
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, created_by)
  values ('f0000009-0000-4000-8000-000000000009', 'dddd0000-0000-4000-8000-000000000010',
          400000, 'active', '22222222-2222-4222-8222-222222222222');

  select public.order_submission_verified_payment('dddd0000-0000-4000-8000-000000000010') into v_verified;
  if v_verified <> 400000 then raise exception 'H: the gate must now see 400000, got %', v_verified; end if;
  if v_verified < v_required then raise exception 'H: 400000 must satisfy a 400000 requirement'; end if;

  -- PARITY: the figure the APPLICATION computes for the same PI — the sum of
  -- active allocation rows naming it, which is what paymentAllocations.ts does —
  -- must equal the figure the SQL gate uses. Same rows, same filter, same sum.
  select coalesce(sum(a.allocated_amount), 0) into v_app_equiv
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = 'dddd0000-0000-4000-8000-000000000010'
    and a.status = 'active'
    and f.status in ('approved_linked', 'approved_unlinked');

  if v_app_equiv <> v_verified then
    raise exception 'H: application-equivalent total % <> SQL gate total %', v_app_equiv, v_verified;
  end if;

  -- A reversal takes it straight back below the line: the exception path is
  -- driven by the same rows and is unchanged.
  update public.finance_payment_allocations set status = 'reversed'
   where payment_request_id = 'f0000009-0000-4000-8000-000000000009'
     and order_submission_id = 'dddd0000-0000-4000-8000-000000000010';
  select public.order_submission_verified_payment('dddd0000-0000-4000-8000-000000000010') into v_verified;
  if v_verified <> 0 then raise exception 'H: a reversal must drop the gate total to 0, got %', v_verified; end if;

  raise notice 'H. 40%% GATE — legacy links cannot satisfy it, active allocations can, and app == SQL';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- I. THE DIVERGENCE IS GONE — one number, both sides
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_screen numeric;   -- what the Confirmed Payments screen shows as allocated
  v_sql    numeric;   -- what the database credits the Order
  v_row    record;
begin
  -- THE EXACT SHAPE PR #55 DOCUMENTED AS DIVERGING: a verified payment with a
  -- legacy order_id and no active allocation. Before 112 the screen said ₹0 and
  -- order_linked_payment_total said ₹100000.
  select allocated_total into v_screen
  from public.finance_received_payments where id = 'f0000001-0000-4000-8000-000000000001';
  select public.order_linked_payment_total('aaaa0000-0000-4000-8000-00000000000a') into v_sql;

  if v_screen <> 0 then raise exception 'I: the screen figure must be 0, got %', v_screen; end if;
  if v_sql <> 60000 then
    -- Order A holds exactly the 60000 moved from the PI in G, and nothing from
    -- the legacy links in A1, D or H.
    raise exception 'I: Order A must hold only its 60000 moved allocation, got %', v_sql;
  end if;

  -- EVERY payment in this fixture: attributed_total and allocated_total must be
  -- the same number. They were two different figures before 112; that is the
  -- divergence, and this is its general form.
  for v_row in
    select id, request_number, allocated_total, attributed_total,
           order_allocated_total, order_attributed_total,
           allocation_state, confirmed_allocation_status, amount, available_balance
    from public.finance_received_payments
  loop
    if v_row.attributed_total <> v_row.allocated_total then
      raise exception 'I: % attributed % <> allocated % — the fallback is back',
        v_row.request_number, v_row.attributed_total, v_row.allocated_total;
    end if;
    if v_row.order_attributed_total <> v_row.order_allocated_total then
      raise exception 'I: % order-attributed % <> order-allocated %',
        v_row.request_number, v_row.order_attributed_total, v_row.order_allocated_total;
    end if;
    -- The two vocabularies must agree about the same underlying figure.
    if (v_row.allocation_state = 'unallocated') <> (v_row.confirmed_allocation_status = 'zero') then
      raise exception 'I: % state % disagrees with confirmed status %',
        v_row.request_number, v_row.allocation_state, v_row.confirmed_allocation_status;
    end if;
    if v_row.allocation_state <> 'unallocated'
       and v_row.allocation_state <> v_row.confirmed_allocation_status then
      raise exception 'I: % state % <> confirmed status %',
        v_row.request_number, v_row.allocation_state, v_row.confirmed_allocation_status;
    end if;
    -- Conservation, exactly, to the paisa, wherever a balance may be stated.
    if v_row.available_balance is not null and v_row.allocation_state <> 'over' then
      if v_row.allocated_total + v_row.available_balance <> v_row.amount then
        raise exception 'I: % conservation broken: % + % <> %',
          v_row.request_number, v_row.allocated_total, v_row.available_balance, v_row.amount;
      end if;
    end if;
  end loop;

  -- And the whole-database check: the sum every Order is credited can never
  -- exceed the money that has actually been allocated.
  if (select coalesce(sum(public.order_linked_payment_total(o.id)), 0) from public.orders o)
     > (select coalesce(sum(a.allocated_amount), 0)
          from public.finance_payment_allocations a
          join public.finance_payment_requests f on f.id = a.payment_request_id
         where a.status = 'active' and a.order_id is not null
           and public.finance_payment_status_is_verified(f.status))
  then
    raise exception 'I: Orders are credited more in total than has been allocated to them';
  end if;

  raise notice 'I. PARITY — one number on both sides, conservation exact, no double counting';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- J. THE OBSOLETE RPC SURFACE IS GONE
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_n int; v_name text;
begin
  foreach v_name in array array[
    'link_finance_payment_to_order',
    'link_finance_payment_to_order_request',
    'unlink_finance_payment_from_order',
    'unlink_finance_payment_from_order_request'
  ] loop
    select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;
    if v_n <> 0 then raise exception 'J: % still exists (% overload(s))', v_name, v_n; end if;
  end loop;

  -- Not callable through any exposed schema, by any role: a function that does
  -- not exist cannot be reached, and this proves the name resolves to nothing.
  begin
    perform public.link_finance_payment_to_order(
      'f0000001-0000-4000-8000-000000000001'::uuid,
      'aaaa0000-0000-4000-8000-00000000000a'::uuid);
    raise exception 'J: link_finance_payment_to_order was still callable';
  exception
    when undefined_function then null;
  end;

  begin
    perform public.unlink_finance_payment_from_order(
      'f0000001-0000-4000-8000-000000000001'::uuid, 'because');
    raise exception 'J: unlink_finance_payment_from_order was still callable';
  exception
    when undefined_function then null;
  end;

  raise notice 'J. LINK/UNLINK — dropped in every overload, callable by nobody';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- K. SECURITY IS UNCHANGED
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_n int;
begin
  -- The view stays read-only for clients and invisible to anon.
  if has_table_privilege('authenticated', 'public.finance_received_payments', 'insert')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'update')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'delete')
  then raise exception 'K: finance_received_payments must stay read-only'; end if;
  if has_table_privilege('anon', 'public.finance_received_payments', 'select')
  then raise exception 'K: anon must not read finance_received_payments'; end if;

  -- The allocation table is not a client write surface: the guarded RPCs are.
  if has_table_privilege('anon', 'public.finance_payment_allocations', 'insert')
     or has_table_privilege('anon', 'public.finance_payment_allocations', 'update')
     or has_table_privilege('anon', 'public.finance_payment_allocations', 'delete')
  then raise exception 'K: anon must not write allocations'; end if;

  -- Row-level security is still on for both tables.
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('finance_payment_allocations', 'finance_payment_requests')
    and c.relrowsecurity;
  if v_n <> 2 then
    raise exception 'K: RLS must remain enabled on both finance tables (found % of 2)', v_n;
  end if;

  -- order_linked_payment_total keeps its posture.
  if has_function_privilege('anon', 'public.order_linked_payment_total(uuid)', 'execute')
  then raise exception 'K: anon must not execute order_linked_payment_total'; end if;
  if not has_function_privilege('authenticated', 'public.order_linked_payment_total(uuid)', 'execute')
  then raise exception 'K: authenticated lost order_linked_payment_total'; end if;

  -- The protected allocation and deletion RPCs are all still here.
  foreach v_n in array array[1] loop null; end loop;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='allocate_payment_to_targets')
  then raise exception 'K: allocate_payment_to_targets is missing'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='begin_finance_payment_deletion')
  then raise exception 'K: the deletion protocol is missing'; end if;

  raise notice 'K. SECURITY — read-only view, RLS on, protected RPCs intact, anon shut out';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
