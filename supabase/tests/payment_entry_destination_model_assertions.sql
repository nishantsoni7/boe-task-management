-- Assertions for 20261013000000_payment_entry_destination_model.sql
--
-- THE CLAIM UNDER TEST: a payment request can name a PI Draft, a Confirmed
-- Order or nothing at all; the customer is never typed; and an unverified
-- request attributes no money until Finance approves it.
--
-- Every comparison is exact. Run through
-- run_payment_entry_destination_model_suite.sh, which applies the real
-- migration first. One transaction, rolled back: nothing is left behind.

\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

-- ── Actors ───────────────────────────────────────────────────────────────────
insert into public.users (id, email, role, full_name) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test',   'admin',       'Admin'),
  ('22222222-2222-4222-8222-222222222222', 'sales@boe.test',   'salesperson', 'Sales'),
  ('33333333-3333-4333-8333-333333333333', 'nobody@boe.test',  'viewer',      'Nobody');

-- ── Targets ──────────────────────────────────────────────────────────────────
insert into public.orders (id, display_number, status, client_name, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'ORD-A', 'running',   'Kalyan Interiors', '11111111-1111-4111-8111-111111111111'),
  ('b0000000-0000-4000-8000-00000000000b', 'ORD-B', 'running',   'Menon Builders',   '11111111-1111-4111-8111-111111111111'),
  ('c0000000-0000-4000-8000-00000000000c', 'ORD-C', 'cancelled', 'Dead Co',          '11111111-1111-4111-8111-111111111111');

insert into public.order_submissions (id, client_name, status, created_by) values
  ('d0000000-0000-4000-8000-00000000000d', 'Kalyan Interiors', 'draft',    '22222222-2222-4222-8222-222222222222'),
  ('e0000000-0000-4000-8000-00000000000e', 'Rao Associates',   'draft',    '22222222-2222-4222-8222-222222222222'),
  ('f0000000-0000-4000-8000-00000000000f', 'Rejected Co',      'rejected', '22222222-2222-4222-8222-222222222222');

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');

-- ═══════════════════════════════════════════════════════════════════════════
-- 1 + 2. A targeted Payment Request derives its customer and creates an INTENT
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_row public.finance_payment_requests%rowtype;
  v_intent public.finance_payment_allocation_intents%rowtype;
  v_allocs int;
begin
  -- 1. PI Draft
  v_res := public.submit_payment_request(
    p_destination => 'pi_draft',
    p_target_id   => 'd0000000-0000-4000-8000-00000000000d',
    p_amount      => 100000, p_payment_date => current_date, p_payment_mode => 'upi');
  v_pay := (v_res->>'payment_request_id')::uuid;

  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.client_name <> 'Kalyan Interiors' then
    raise exception '1: the customer must be DERIVED from the PI, got %', coalesce(v_row.client_name, '<null>');
  end if;
  if v_row.status <> 'pending_approval' then raise exception '1: must be pending, got %', v_row.status; end if;

  select * into v_intent from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if not found then raise exception '1: no intent was created'; end if;
  if v_intent.target_type <> 'pi_draft' then raise exception '1: wrong target_type %', v_intent.target_type; end if;
  if v_intent.order_submission_id <> 'd0000000-0000-4000-8000-00000000000d' then raise exception '1: wrong PI'; end if;
  if v_intent.order_id is not null then raise exception '1: a PI intent must not name an Order'; end if;
  if v_intent.intended_amount <> 100000 then raise exception '1: wrong amount %', v_intent.intended_amount; end if;
  if v_intent.status <> 'pending' then raise exception '1: intent must be pending, got %', v_intent.status; end if;

  -- NO ALLOCATION. This is the whole point of intent.
  select count(*) into v_allocs from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_allocs <> 0 then raise exception '1: an unverified request created % allocation(s)', v_allocs; end if;

  -- 2. Confirmed Order
  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order',
    p_target_id   => 'b0000000-0000-4000-8000-00000000000b',
    p_amount      => 50000, p_payment_date => current_date, p_payment_mode => 'bank_transfer');
  v_pay := (v_res->>'payment_request_id')::uuid;

  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.client_name <> 'Menon Builders' then
    raise exception '2: the customer must be DERIVED from the Order, got %', coalesce(v_row.client_name, '<null>');
  end if;

  select * into v_intent from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_intent.target_type <> 'confirmed_order' then raise exception '2: wrong target_type'; end if;
  if v_intent.order_submission_id is not null then raise exception '2: an Order intent must not name a PI'; end if;

  select count(*) into v_allocs from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_allocs <> 0 then raise exception '2: an unverified Order request created an allocation'; end if;

  raise notice '1+2. TARGETED REQUEST — customer derived, intent created, no allocation';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. A Suspense Payment Request: null customer, no intent, no allocation
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_res jsonb; v_pay uuid; v_row public.finance_payment_requests%rowtype; v_n int;
begin
  v_res := public.submit_payment_request(
    p_destination => 'suspense',
    p_amount => 75000, p_payment_date => current_date, p_payment_mode => 'cash');
  v_pay := (v_res->>'payment_request_id')::uuid;

  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.client_name is not null then
    raise exception '3: a Suspense payment must have NO customer, got "%"', v_row.client_name;
  end if;
  if v_row.received_in is not null then
    raise exception '3: received_in must not be fabricated, got "%"', v_row.received_in;
  end if;

  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_n <> 0 then raise exception '3: Suspense must create no intent, got %', v_n; end if;
  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_n <> 0 then raise exception '3: Suspense must create no allocation, got %', v_n; end if;

  raise notice '3. SUSPENSE REQUEST — null customer, no intent, no allocation, no invented account';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. INTENT IS NOT ALLOCATION — no total moves before approval
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid;
  v_order_before numeric; v_order_after numeric;
  v_pi_before numeric; v_pi_after numeric;
  v_alloc numeric; v_avail numeric; v_state text;
begin
  select public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a') into v_order_before;
  select public.order_submission_verified_payment('e0000000-0000-4000-8000-00000000000e') into v_pi_before;

  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 400000, p_payment_date => current_date, p_payment_mode => 'cheque');
  v_pay := (v_res->>'payment_request_id')::uuid;

  perform public.submit_payment_request(
    p_destination => 'pi_draft', p_target_id => 'e0000000-0000-4000-8000-00000000000e',
    p_amount => 400000, p_payment_date => current_date, p_payment_mode => 'cheque');

  select public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a') into v_order_after;
  select public.order_submission_verified_payment('e0000000-0000-4000-8000-00000000000e') into v_pi_after;

  if v_order_after <> v_order_before then
    raise exception '4: an INTENT moved the Order total (% -> %)', v_order_before, v_order_after;
  end if;
  if v_pi_after <> v_pi_before then
    raise exception '4: an INTENT moved the PI 40%% gate figure (% -> %)', v_pi_before, v_pi_after;
  end if;

  -- And the payment itself is Zero Allocated with its whole balance free.
  select allocated_total, available_balance, allocation_state
    into v_alloc, v_avail, v_state
  from public.finance_received_payments where id = v_pay;
  if v_alloc <> 0 then raise exception '4: intent counted as allocated (%)', v_alloc; end if;
  if v_avail <> 400000 then raise exception '4: intent reduced the balance (%)', v_avail; end if;
  if v_state <> 'unallocated' then raise exception '4: intent changed the state to %', v_state; end if;

  raise notice '4. INTENT IS NOT ALLOCATION — no Order total, no PI gate, no balance moved';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5 + 6. Approval converts exactly once, and a retry adds nothing
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_before numeric; v_after numeric;
  v_intent public.finance_payment_allocation_intents%rowtype;
  v_n int; v_alloc numeric; v_state text; v_failed boolean := false;
begin
  select public.order_linked_payment_total('b0000000-0000-4000-8000-00000000000b') into v_before;

  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order', p_target_id => 'b0000000-0000-4000-8000-00000000000b',
    p_amount => 60000, p_payment_date => current_date, p_payment_mode => 'upi');
  v_pay := (v_res->>'payment_request_id')::uuid;

  v_res := public.approve_finance_payment_request(v_pay, 'verified');
  if (v_res->>'allocations_applied')::int <> 1 then
    raise exception '5: approval must apply exactly one intent, applied %', v_res->>'allocations_applied';
  end if;

  select * into v_intent from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_intent.status <> 'applied' then raise exception '5: the intent must be marked applied, got %', v_intent.status; end if;
  if v_intent.applied_allocation_id is null then raise exception '5: applied intent must name its allocation'; end if;
  if v_intent.applied_at is null then raise exception '5: applied intent must carry applied_at'; end if;

  select count(*) into v_n from public.finance_payment_allocations
   where payment_request_id = v_pay and status = 'active';
  if v_n <> 1 then raise exception '5: expected exactly 1 active allocation, got %', v_n; end if;

  select public.order_linked_payment_total('b0000000-0000-4000-8000-00000000000b') into v_after;
  if v_after - v_before <> 60000 then
    raise exception '5: the Order must gain exactly 60000, gained %', v_after - v_before;
  end if;

  select allocated_total, allocation_state into v_alloc, v_state
  from public.finance_received_payments where id = v_pay;
  if v_alloc <> 60000 then raise exception '5: allocated_total must be 60000, got %', v_alloc; end if;
  if v_state <> 'full' then raise exception '5: must read full, got %', v_state; end if;

  -- 6. RETRY. Already approved, so it refuses — and creates nothing either way.
  begin
    perform public.approve_finance_payment_request(v_pay, 'again');
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception '6: approving an already-approved request must be refused'; end if;

  select count(*) into v_n from public.finance_payment_allocations
   where payment_request_id = v_pay and status = 'active';
  if v_n <> 1 then raise exception '6: a retry duplicated the allocation (% now)', v_n; end if;

  -- And the converter itself is idempotent when called again directly: there is
  -- nothing pending left, so it applies nothing.
  v_res := public.apply_payment_allocation_intents(v_pay);
  if (v_res->>'applied_count')::int <> 0 then
    raise exception '6: re-converting must apply nothing, applied %', v_res->>'applied_count';
  end if;
  select count(*) into v_n from public.finance_payment_allocations
   where payment_request_id = v_pay and status = 'active';
  if v_n <> 1 then raise exception '6: re-converting duplicated the allocation'; end if;

  raise notice '5+6. APPROVAL — converts exactly once; retry refuses and duplicates nothing';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. A target that became ineligible rolls the WHOLE approval back
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_row public.finance_payment_requests%rowtype;
  v_intent public.finance_payment_allocation_intents%rowtype;
  v_n int; v_failed boolean := false;
begin
  v_res := public.submit_payment_request(
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 30000, p_payment_date => current_date, p_payment_mode => 'cash');
  v_pay := (v_res->>'payment_request_id')::uuid;

  -- The PI is approved into an Order between submission and verification — the
  -- ordinary race this guard exists for.
  update public.order_submissions
     set order_id = 'a0000000-0000-4000-8000-00000000000a'
   where id = 'd0000000-0000-4000-8000-00000000000d';

  begin
    perform public.approve_finance_payment_request(v_pay, 'verified');
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception '7: approving onto a converted PI must fail';
  end if;

  -- NOTHING half-happened.
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.status <> 'pending_approval' then
    raise exception '7: the payment must still be pending, got %', v_row.status;
  end if;
  if v_row.approved_at is not null then raise exception '7: approved_at was set by a failed approval'; end if;

  select * into v_intent from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_intent.status <> 'pending' then
    raise exception '7: the intent was consumed by a failed approval (%)', v_intent.status;
  end if;

  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_n <> 0 then raise exception '7: a failed approval created % allocation(s)', v_n; end if;

  update public.order_submissions set order_id = null where id = 'd0000000-0000-4000-8000-00000000000d';
  raise notice '7. FAILED TARGET — approval rolled back whole: no status, no intent, no allocation';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Rejection cancels the intent and allocates nothing
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_intent public.finance_payment_allocation_intents%rowtype; v_n int;
begin
  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 20000, p_payment_date => current_date, p_payment_mode => 'other');
  v_pay := (v_res->>'payment_request_id')::uuid;

  perform public.reject_finance_payment_request(v_pay, 'not received');

  select * into v_intent from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_intent.status <> 'cancelled' then
    raise exception '8: a rejected request''s intent must be cancelled, got %', v_intent.status;
  end if;
  if v_intent.cancelled_at is null then raise exception '8: cancelled intent must carry cancelled_at'; end if;
  -- Kept, not deleted: the claim stays auditable.
  if v_intent.id is null then raise exception '8: the intent row must survive rejection'; end if;

  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_n <> 0 then raise exception '8: rejection created an allocation'; end if;

  raise notice '8. REJECTION — intent cancelled and kept, no allocation';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9 + 10 + 11. Direct payment entry: derived customer, real allocation, or none
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_row public.finance_payment_requests%rowtype; v_n int;
begin
  -- 9. PI Draft
  v_res := public.record_payment_with_allocations(
    p_amount => 90000, p_payment_date => current_date, p_payment_mode => 'upi',
    p_client_name => 'A TYPED NAME THAT MUST BE IGNORED',
    p_allocations => jsonb_build_array(jsonb_build_object(
      'kind', 'submission', 'id', 'e0000000-0000-4000-8000-00000000000e', 'amount', 90000)));
  v_pay := (v_res->>'payment_request_id')::uuid;

  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.client_name <> 'Rao Associates' then
    raise exception '9: the customer must come from the PI, got "%"', coalesce(v_row.client_name, '<null>');
  end if;
  select count(*) into v_n from public.finance_payment_allocations
   where payment_request_id = v_pay and status = 'active';
  if v_n <> 1 then raise exception '9: expected one active allocation, got %', v_n; end if;

  -- 10. Confirmed Order
  v_res := public.record_payment_with_allocations(
    p_amount => 45000, p_payment_date => current_date, p_payment_mode => 'bank_transfer',
    p_client_name => 'IGNORED AGAIN',
    p_allocations => jsonb_build_array(jsonb_build_object(
      'kind', 'order', 'id', 'b0000000-0000-4000-8000-00000000000b', 'amount', 45000)));
  v_pay := (v_res->>'payment_request_id')::uuid;
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.client_name <> 'Menon Builders' then
    raise exception '10: the customer must come from the Order, got "%"', coalesce(v_row.client_name, '<null>');
  end if;

  -- 11. Suspense — no allocations at all
  v_res := public.record_payment_with_allocations(
    p_amount => 15000, p_payment_date => current_date, p_payment_mode => 'cash',
    p_client_name => null, p_allocations => '[]'::jsonb);
  v_pay := (v_res->>'payment_request_id')::uuid;
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.client_name is not null then
    raise exception '11: a direct Suspense payment must have no customer, got "%"', v_row.client_name;
  end if;
  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_n <> 0 then raise exception '11: Suspense created % allocation(s)', v_n; end if;

  raise notice '9+10+11. DIRECT ENTRY — customer derived from the target, typed value ignored, Suspense null';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. Multi-target direct payment: atomic, and the customer rule is honest
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_row public.finance_payment_requests%rowtype;
  v_n int; v_before int; v_failed boolean := false;
begin
  -- Two targets, ONE customer (the PI and the Order both name Kalyan
  -- Interiors) -> that customer is the payment's.
  v_res := public.record_payment_with_allocations(
    p_amount => 70000, p_payment_date => current_date, p_payment_mode => 'upi',
    p_client_name => null,
    p_allocations => jsonb_build_array(
      jsonb_build_object('kind', 'submission', 'id', 'd0000000-0000-4000-8000-00000000000d', 'amount', 30000),
      jsonb_build_object('kind', 'order',      'id', 'a0000000-0000-4000-8000-00000000000a', 'amount', 40000)));
  v_pay := (v_res->>'payment_request_id')::uuid;
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.client_name <> 'Kalyan Interiors' then
    raise exception '12: one distinct customer across targets must be stored, got "%"',
      coalesce(v_row.client_name, '<null>');
  end if;
  select count(*) into v_n from public.finance_payment_allocations
   where payment_request_id = v_pay and status = 'active';
  if v_n <> 2 then raise exception '12: expected 2 allocations, got %', v_n; end if;

  -- Two targets, TWO customers -> NULL, never a fabricated summary name.
  v_res := public.record_payment_with_allocations(
    p_amount => 50000, p_payment_date => current_date, p_payment_mode => 'upi',
    p_client_name => null,
    p_allocations => jsonb_build_array(
      jsonb_build_object('kind', 'order', 'id', 'a0000000-0000-4000-8000-00000000000a', 'amount', 25000),
      jsonb_build_object('kind', 'order', 'id', 'b0000000-0000-4000-8000-00000000000b', 'amount', 25000)));
  v_pay := (v_res->>'payment_request_id')::uuid;
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.client_name is not null then
    raise exception '12: two distinct customers must store NULL, not "%"', v_row.client_name;
  end if;

  -- ATOMIC. The second row names a cancelled Order, so nothing at all lands.
  select count(*) into v_before from public.finance_payment_requests;
  begin
    perform public.record_payment_with_allocations(
      p_amount => 10000, p_payment_date => current_date, p_payment_mode => 'cash',
      p_client_name => null,
      p_allocations => jsonb_build_array(
        jsonb_build_object('kind', 'order', 'id', 'a0000000-0000-4000-8000-00000000000a', 'amount', 5000),
        jsonb_build_object('kind', 'order', 'id', 'c0000000-0000-4000-8000-00000000000c', 'amount', 5000)));
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception '12: allocating to a cancelled Order must fail'; end if;
  select count(*) into v_n from public.finance_payment_requests;
  if v_n <> v_before then
    raise exception '12: a failed multi-target entry left a payment row behind (% -> %)', v_before, v_n;
  end if;

  raise notice '12. MULTI-TARGET — atomic, one customer stored when unambiguous, NULL when not';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. Invalid destination and target combinations are refused
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_failed boolean; v_n int; v_msg text; v_state text; v_mode text;
begin
  -- A target on a Suspense entry.
  v_failed := false;
  begin
    perform public.submit_payment_request('suspense', 'a0000000-0000-4000-8000-00000000000a',
      1000, current_date, 'cash');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '13: Suspense must refuse a target'; end if;

  -- A missing target on a targeted entry.
  v_failed := false;
  begin
    perform public.submit_payment_request('pi_draft', null, 1000, current_date, 'cash');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '13: PI Draft must require a target'; end if;

  -- An unknown destination.
  v_failed := false;
  begin
    perform public.submit_payment_request('order_request', 'a0000000-0000-4000-8000-00000000000a',
      1000, current_date, 'cash');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '13: a retired destination must be refused'; end if;

  -- 'card' is not a payment mode, and the RPC must be the one that says so.
  --
  -- CHECKING *WHICH* REFUSAL. The table's own CHECK would also reject 'card',
  -- so "it failed" proves nothing about the RPC's canonical list — a version
  -- that admitted 'card' would still fail, one layer down, and this assertion
  -- would still pass. So it requires the RPC's own message and SQLSTATE.
  v_failed := false;
  begin
    perform public.submit_payment_request('suspense', null, 1000, current_date, 'card');
  exception when others then
    v_failed := true;
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
  end;
  if not v_failed then raise exception '13: ''card'' must be refused — the canonical list is five'; end if;
  if v_state <> 'P0001' or position('PAYMENT_MODE_INVALID' in v_msg) = 0 then
    raise exception
      '13: ''card'' must be refused BY THE RPC (PAYMENT_MODE_INVALID/P0001), got %/%', v_state, v_msg;
  end if;

  -- …and each of the five canonical values is accepted by it.
  foreach v_mode in array array['bank_transfer', 'cash', 'upi', 'cheque', 'other'] loop
    perform public.submit_payment_request('suspense', null, 1, current_date, v_mode);
  end loop;

  -- A non-positive amount.
  v_failed := false;
  begin
    perform public.submit_payment_request('suspense', null, 0, current_date, 'cash');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '13: a zero amount must be refused'; end if;

  -- A cancelled Order, and a rejected PI.
  v_failed := false;
  begin
    perform public.submit_payment_request('confirmed_order', 'c0000000-0000-4000-8000-00000000000c',
      1000, current_date, 'cash');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '13: a cancelled Order must be refused'; end if;

  v_failed := false;
  begin
    perform public.submit_payment_request('pi_draft', 'f0000000-0000-4000-8000-00000000000f',
      1000, current_date, 'cash');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '13: a rejected PI must be refused'; end if;

  -- An intent may never promise more than the payment is worth.
  v_failed := false;
  begin
    insert into public.finance_payment_allocation_intents
      (payment_request_id, target_type, order_id, intended_amount, created_by)
    select id, 'confirmed_order', 'a0000000-0000-4000-8000-00000000000a', amount + 1,
           '11111111-1111-4111-8111-111111111111'
    from public.finance_payment_requests order by created_at limit 1;
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '13: an over-capacity intent must be refused'; end if;

  raise notice '13. REFUSALS — bad destination, bad target, bad mode, bad amount, over-capacity intent';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. Unauthorized callers are refused
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_failed boolean; v_pay uuid;
begin
  select id into v_pay from public.finance_payment_requests
   where status = 'pending_approval' order by created_at limit 1;

  -- Somebody with no Finance module entry cannot submit.
  perform pg_temp.act_as('33333333-3333-4333-8333-333333333333');
  v_failed := false;
  begin
    perform public.submit_payment_request('suspense', null, 1000, current_date, 'cash');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '14: a user without Finance entry must not submit'; end if;

  -- …and cannot approve.
  v_failed := false;
  begin
    perform public.approve_finance_payment_request(v_pay, null);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception '14: a non-approver must not approve'; end if;

  -- …and cannot write the intent table directly, whatever they try.
  if has_table_privilege('authenticated', 'public.finance_payment_allocation_intents', 'insert')
  then raise exception '14: authenticated must not INSERT intents directly'; end if;
  if has_function_privilege('authenticated', 'public.apply_payment_allocation_intents(uuid)', 'execute')
  then raise exception '14: authenticated must not convert intents directly'; end if;

  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');
  raise notice '14. AUTHORIZATION — no entry, no submit; no approve grant, no approval; no direct intent writes';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 15 + 16. The deletion protocol and 20261012000000 still hold
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_claim jsonb; v_n int;
  v_order numeric; v_alloc numeric;
begin
  -- 15. A payment with a NULL customer still deletes, and its tombstone is
  --     honest about the customer rather than inventing one.
  v_res := public.record_payment_with_allocations(
    p_amount => 5000, p_payment_date => current_date, p_payment_mode => 'cash',
    p_client_name => null, p_allocations => '[]'::jsonb);
  v_pay := (v_res->>'payment_request_id')::uuid;

  v_claim := public.begin_finance_payment_deletion(
    v_pay, 'test tombstone with no customer',
    (select human_payment_id from public.finance_payment_requests where id = v_pay));
  if v_claim is null then raise exception '15: a null-customer payment must still be claimable'; end if;

  select count(*) into v_n from public.finance_payment_deletion_claims
   where payment_id = v_pay and customer_name is null;
  if v_n <> 1 then raise exception '15: the tombstone must record a NULL customer honestly'; end if;

  perform public.release_finance_payment_deletion(
    v_pay, (v_claim->>'claim_token')::uuid);

  -- 16. Allocation-only attribution is unchanged: a payment carrying a legacy
  --     order_id and no allocation is still worth nothing to that Order.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, status, submitted_by, order_id)
  values ('Legacy Co', 999999, current_date, 'cash', 'approved_linked',
          '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-00000000000a')
  returning id into v_pay;

  select allocated_total into v_alloc from public.finance_received_payments where id = v_pay;
  if v_alloc <> 0 then raise exception '16: a legacy link must attribute nothing, got %', v_alloc; end if;

  select public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a') into v_order;
  if v_order >= 999999 then
    raise exception '16: the legacy link leaked into the Order total (%)', v_order;
  end if;

  raise notice '15+16. DELETION + ALLOCATION-ONLY — tombstone honest, 20261012000000 intact';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 17. The cash trail belongs to cash, and the account is never invented
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The form draws the collector and handover fields only for Cash. That is a
-- convenience; THIS is the rule. A caller that sends a cash trail on a bank
-- transfer — a stale form field, a hand-written call — has it discarded, and a
-- caller that sends one on cash has it kept.
do $$
declare
  v_res jsonb; v_row public.finance_payment_requests%rowtype;
begin
  -- 17a. Not cash: every one of the five columns is null, whatever was sent.
  v_res := public.submit_payment_request(
    p_destination     => 'suspense',
    p_amount          => 4000, p_payment_date => current_date,
    p_payment_mode    => 'bank_transfer',
    p_collected_by    => '11111111-1111-4111-8111-111111111111',
    p_collected_from  => 'a walk-in',
    p_handed_over_to  => '11111111-1111-4111-8111-111111111111',
    p_handed_over_at  => current_date,
    p_collection_note => 'carried in a bag');
  select * into v_row from public.finance_payment_requests
   where id = (v_res->>'payment_request_id')::uuid;

  if v_row.collected_by_user_id is not null
     or v_row.collected_from_text is not null
     or v_row.handed_over_to_user_id is not null
     or v_row.handed_over_at is not null
     or v_row.collection_handover_note is not null then
    raise exception '17a: a bank transfer must store no cash trail';
  end if;

  -- 17b. Cash: the trail is kept exactly as given.
  v_res := public.submit_payment_request(
    p_destination     => 'suspense',
    p_amount          => 4000, p_payment_date => current_date,
    p_payment_mode    => 'cash',
    p_collected_by    => '11111111-1111-4111-8111-111111111111',
    p_collected_from  => 'a walk-in',
    p_handed_over_to  => '11111111-1111-4111-8111-111111111111',
    p_handed_over_at  => current_date,
    p_collection_note => 'carried in a bag');
  select * into v_row from public.finance_payment_requests
   where id = (v_res->>'payment_request_id')::uuid;

  if v_row.collected_by_user_id is null
     or v_row.collected_from_text <> 'a walk-in'
     or v_row.handed_over_to_user_id is null
     or v_row.handed_over_at is null
     or v_row.collection_handover_note <> 'carried in a bag' then
    raise exception '17b: a cash payment must keep its collection and handover record';
  end if;

  -- 17c. received_in is NEVER written by this door, for any mode or
  --      destination. The four-account picker is gone and null is the honest
  --      value; an invented account would be indistinguishable from a real one.
  if (select count(*) from public.finance_payment_requests
       where received_in is not null and status = 'pending_approval') <> 0 then
    raise exception '17c: submit_payment_request must never state a receiving account';
  end if;

  -- 17d. …and neither is order_number, which would name a link the row has not
  --      got. Every payment this suite submitted carries none.
  if (select count(*) from public.finance_payment_requests
       where order_number is not null and status = 'pending_approval'
         and order_id is null) <> 0 then
    raise exception '17d: a pending request must not carry an Order number it has no link to';
  end if;

  raise notice '17. CASH TRAIL — kept for cash, discarded otherwise; no invented account or Order number';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
