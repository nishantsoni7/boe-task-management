-- Assertions for 20270607000000_finance_payment_request_old_order.sql
--
-- TEST-ONLY. Run AFTER the migration by run_payment_request_old_order_suite.sh.
-- Every scenario acts as a real user (request.jwt.claims). One transaction,
-- rolled back: nothing is left behind. Prints `PASS: <n>` per claim; any
-- failure raises and stops the file.
--
-- Claims:
--   1. a request for an OLD order writes a payment, ONE pending legacy intent
--      and NO allocation; the typed client is the payment's customer; the
--      number is normalised; no Order or PI total moves;
--   2. the refusals, by name, and none leaves a payment behind;
--   3. a keyed retry replays the same payment; a different old order under the
--      same key is refused;
--   4. Finance's approval turns the intent into ONE active legacy allocation
--      (and nothing else); a second payment for the same old order does too;
--   5. editing: amount / date / client changes keep one intent; changing the
--      number cancels the old and places the new; to and from Suspense, PI
--      Draft and Confirmed Order; a stranger, a verified payment and an
--      allocated payment are refused;
--   6. a rejected request cancels its intent and can be resent as an old order;
--   7. the other destinations are unchanged and carry no old-order facts;
--   8. the implementation doors are closed to a signed-in user.
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_id is null then '' else json_build_object('sub', p_id, 'role', 'authenticated')::text end, true);
end $$;

-- Runs p_sql and requires it to FAIL with a message containing p_expect.
create or replace function pg_temp.refused(p_sql text, p_expect text)
returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED A REFUSAL (%) BUT IT SUCCEEDED: %', p_expect, p_sql;
exception when others then
  if sqlerrm like 'EXPECTED A REFUSAL%' then raise; end if;
  if position(p_expect in sqlerrm) = 0 and position(p_expect in sqlstate) = 0 then
    raise exception 'WRONG REFUSAL for %: expected %, got [%] %', p_sql, p_expect, sqlstate, sqlerrm;
  end if;
end $$;

\set ADMIN   '''11111111-1111-4111-8111-111111111111'''
\set SALES   '''22222222-2222-4222-8222-222222222222'''
\set OUTSIDE '''33333333-3333-4333-8333-333333333333'''
\set SALES2  '''44444444-4444-4444-8444-444444444444'''

-- A PI Draft, for the allocated-payment and PI-destination scenarios.
insert into public.order_submissions (id, client_name, status, created_by, submitted_by, source_workbook_path) values
  ('d0000000-0000-4000-8000-00000000000d', 'Kalyan Interiors', 'draft',
   '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222',
   'd0000000-0000-4000-8000-00000000000d/original/pi.xlsx');

-- ═══ 1. A request for an old order ══════════════════════════════════════════
select pg_temp.act_as(:SALES);
do $$
declare
  v_res jsonb; v_pay uuid; v_row public.finance_payment_requests%rowtype;
  v_i public.finance_payment_allocation_intents%rowtype;
  v_n int; v_before numeric; v_after numeric;
begin
  select public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a') into v_before;

  v_res := public.submit_payment_request(
    p_destination => 'old_order', p_amount => 100000, p_payment_date => current_date,
    p_payment_mode => 'hdfc',
    p_legacy_order_no => '  ab-12 ', p_legacy_client_name => '  Mehta   Furnishings ');
  v_pay := (v_res->>'payment_request_id')::uuid;

  if v_res->>'destination' <> 'old_order' then raise exception '1: result destination %', v_res->>'destination'; end if;
  if v_res->>'client_name' <> 'Mehta Furnishings' then raise exception '1: result client %', v_res->>'client_name'; end if;
  if v_res->>'intent_id' is null then raise exception '1: the result names no intent'; end if;
  if (v_res->>'allocation_created')::boolean then raise exception '1: a request must not create an allocation'; end if;

  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.status <> 'pending_approval' then raise exception '1: status %', v_row.status; end if;
  if v_row.client_name <> 'Mehta Furnishings' then raise exception '1: customer %', coalesce(v_row.client_name, '<null>'); end if;
  if v_row.order_id is not null then raise exception '1: the payment row must not name an Order'; end if;

  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_n <> 1 then raise exception '1: expected one intent, got %', v_n; end if;
  select * into v_i from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_i.target_type <> 'legacy_order' or v_i.legacy_order_no <> 'AB-12'
     or v_i.legacy_client_name <> 'Mehta Furnishings'
     or v_i.order_id is not null or v_i.order_submission_id is not null
     or v_i.intended_amount <> 100000 or v_i.status <> 'pending' then
    raise exception '1: the intent is wrong: %', to_jsonb(v_i);
  end if;

  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_n <> 0 then raise exception '1: an unverified request created % allocation(s)', v_n; end if;

  select public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a') into v_after;
  if v_after <> v_before then raise exception '1: an Order total moved'; end if;

  raise notice 'PASS: 1 a request for an old order writes one pending legacy intent and no allocation';
end $$;

-- ═══ 2. Refusals, by name; nothing is left behind ═══════════════════════════
do $$
declare v_before bigint; v_i bigint;
begin
  select count(*) into v_before from public.finance_payment_requests;
  select count(*) into v_i from public.finance_payment_allocation_intents;

  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_client_name => 'X')$q$, 'PAYMENT_LEGACY_ORDER_REQUIRED');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => '   ', p_legacy_client_name => 'X')$q$, 'PAYMENT_LEGACY_ORDER_REQUIRED');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => 'A')$q$, 'PAYMENT_LEGACY_CLIENT_REQUIRED');
  perform pg_temp.refused(format($q$select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => %L, p_legacy_client_name => 'X')$q$,
    repeat('9', 61)), 'PAYMENT_LEGACY_ORDER_TOO_LONG');
  perform pg_temp.refused(format($q$select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => 'A', p_legacy_client_name => %L)$q$,
    repeat('n', 121)), 'PAYMENT_LEGACY_CLIENT_TOO_LONG');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'old_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 1000, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_legacy_order_no => 'A', p_legacy_client_name => 'X')$q$, 'PAYMENT_TARGET_FORBIDDEN');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'suspense', p_amount => 1000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => 'A', p_legacy_client_name => 'X')$q$, 'PAYMENT_LEGACY_FORBIDDEN');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 1000, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_legacy_order_no => 'A')$q$, 'PAYMENT_LEGACY_FORBIDDEN');
  -- The core's own rules still apply to an old-order request.
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000.005,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => 'A', p_legacy_client_name => 'X')$q$, 'PAYMENT_AMOUNT_INVALID');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000,
    p_payment_date => current_date, p_payment_mode => 'upi', p_legacy_order_no => 'A', p_legacy_client_name => 'X')$q$, 'PAYMENT_MODE_INVALID');

  if (select count(*) from public.finance_payment_requests) <> v_before
     or (select count(*) from public.finance_payment_allocation_intents) <> v_i then
    raise exception '2: a refused request left a row behind';
  end if;
  raise notice 'PASS: 2 every refusal is named and leaves nothing behind';
end $$;

-- A signed-in user with no Finance entry is refused at the door.
select pg_temp.act_as(:OUTSIDE);
do $$
begin
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'old_order', p_amount => 1000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => 'A', p_legacy_client_name => 'X')$q$, 'FINANCE_MODULE_CLOSED');
  raise notice 'PASS: 2b the door still asks for Finance entry';
end $$;

-- ═══ 3. Idempotency ═════════════════════════════════════════════════════════
select pg_temp.act_as(:SALES);
do $$
declare
  v_a jsonb; v_b jsonb; v_n int;
begin
  v_a := public.submit_payment_request(
    p_destination => 'old_order', p_amount => 25000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'K-77', p_legacy_client_name => 'Kapoor Hotels',
    p_idempotency_key => 'a1000000-0000-4000-8000-0000000000a1');
  v_b := public.submit_payment_request(
    p_destination => 'old_order', p_amount => 25000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => ' k-77', p_legacy_client_name => 'Kapoor  Hotels',
    p_idempotency_key => 'a1000000-0000-4000-8000-0000000000a1');
  if v_a->>'payment_request_id' <> v_b->>'payment_request_id' then
    raise exception '3: a replay recorded a second payment';
  end if;
  select count(*) into v_n from public.finance_payment_allocation_intents
   where payment_request_id = (v_a->>'payment_request_id')::uuid;
  if v_n <> 1 then raise exception '3: a replay left % intents', v_n; end if;

  perform pg_temp.refused($q$select public.submit_payment_request(
    p_destination => 'old_order', p_amount => 25000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'K-78', p_legacy_client_name => 'Kapoor Hotels',
    p_idempotency_key => 'a1000000-0000-4000-8000-0000000000a1')$q$, 'PAYMENT_IDEMPOTENCY_KEY_REUSED');

  raise notice 'PASS: 3 a keyed retry replays the payment; a different old order under the key is refused';
end $$;

-- ═══ 4. Approval converts the intent into ONE legacy allocation ═════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_pay2 uuid; v_before numeric; v_after numeric;
  v_a public.finance_payment_allocations%rowtype; v_i public.finance_payment_allocation_intents%rowtype;
  v_n int; v_total numeric; v_state text; v_pi_before numeric;
begin
  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');
  select public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a') into v_before;

  select id into v_pay from public.finance_payment_requests where client_name = 'Mehta Furnishings';
  v_res := public.approve_finance_payment_request(v_pay, 'verified');
  if (v_res->>'allocations_applied')::int <> 1 then
    raise exception '4: approval must apply exactly one intent, applied %', v_res->>'allocations_applied';
  end if;

  select * into v_i from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_i.status <> 'applied' or v_i.applied_allocation_id is null or v_i.applied_at is null then
    raise exception '4: the intent was not marked applied: %', to_jsonb(v_i);
  end if;

  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_n <> 1 then raise exception '4: expected one allocation, got %', v_n; end if;
  select * into v_a from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_a.id <> v_i.applied_allocation_id or v_a.status <> 'active'
     or v_a.legacy_order_no <> 'AB-12' or v_a.legacy_client_name <> 'Mehta Furnishings'
     or v_a.allocated_amount <> 100000
     or v_a.order_id is not null or v_a.order_submission_id is not null
     or v_a.origin_target_type <> 'legacy_order' then
    raise exception '4: the allocation is wrong: %', to_jsonb(v_a);
  end if;

  select allocated_total, allocation_state into v_total, v_state from public.finance_received_payments where id = v_pay;
  if v_total <> 100000 or v_state <> 'full' then
    raise exception '4: the payment must read fully allocated, got % / %', v_total, v_state;
  end if;

  select public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a') into v_after;
  if v_after <> v_before then raise exception '4: an Order total moved'; end if;

  -- A second payment for the SAME old order (an instalment) approves too.
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');
  v_res := public.submit_payment_request(
    p_destination => 'old_order', p_amount => 40000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'ab-12', p_legacy_client_name => 'Mehta Furnishings');
  v_pay2 := (v_res->>'payment_request_id')::uuid;
  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');
  perform public.approve_finance_payment_request(v_pay2, null);
  select count(*) into v_n from public.finance_payment_allocations
   where legacy_order_no = 'AB-12' and status = 'active';
  if v_n <> 2 then raise exception '4: two payments for one old order must both allocate, got %', v_n; end if;

  -- Approval again adds nothing.
  perform pg_temp.refused(format('select public.approve_finance_payment_request(%L, null)', v_pay), 'Only a pending payment request can be approved');
  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_n <> 1 then raise exception '4: a retried approval added an allocation'; end if;

  raise notice 'PASS: 4 approval makes exactly one active legacy allocation; a second payment for the same old order does too';
end $$;

-- ═══ 5. Editing a pending old-order request ═════════════════════════════════
select pg_temp.act_as(:SALES);
do $$
declare
  v_res jsonb; v_pay uuid; v_i public.finance_payment_allocation_intents%rowtype;
  v_row public.finance_payment_requests%rowtype; v_n int; v_first uuid;
begin
  v_res := public.submit_payment_request(
    p_destination => 'old_order', p_amount => 50000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'X-9', p_legacy_client_name => 'Client C');
  v_pay := (v_res->>'payment_request_id')::uuid;
  select id into v_first from public.finance_payment_allocation_intents where payment_request_id = v_pay;

  -- 5a. amount and client change: ONE intent row, the same one, now 70000.
  v_res := public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'old_order', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'x-9', p_legacy_client_name => 'Client C2');
  if v_res->>'destination' <> 'old_order' then raise exception '5a: result destination %', v_res->>'destination'; end if;
  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_n <> 1 then raise exception '5a: an amount-only correction left % intent rows', v_n; end if;
  select * into v_i from public.finance_payment_allocation_intents where payment_request_id = v_pay;
  if v_i.id <> v_first or v_i.status <> 'pending' or v_i.intended_amount <> 70000
     or v_i.legacy_client_name <> 'Client C2' or v_i.cancelled_at is not null or v_i.cancelled_reason is not null then
    raise exception '5a: the intent was not updated in place: %', to_jsonb(v_i);
  end if;
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.amount <> 70000 or v_row.client_name <> 'Client C2' then
    raise exception '5a: the payment row is wrong: % / %', v_row.amount, v_row.client_name;
  end if;

  -- 5b. a different old order: the old intent is cancelled and kept, one pending.
  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'old_order', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'X-10', p_legacy_client_name => 'Client C2');
  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending';
  if v_n <> 1 then raise exception '5b: expected one pending intent, got %', v_n; end if;
  if (select legacy_order_no from public.finance_payment_allocation_intents
       where payment_request_id = v_pay and status = 'pending') <> 'X-10' then
    raise exception '5b: the pending intent must name X-10';
  end if;
  if not exists (select 1 from public.finance_payment_allocation_intents
                  where payment_request_id = v_pay and status = 'cancelled' and legacy_order_no = 'X-9'
                    and cancelled_reason = 'destination_changed') then
    raise exception '5b: the replaced intent must be kept as cancelled';
  end if;

  -- 5c. to Suspense: no intent, no customer.
  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'suspense', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc');
  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending';
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_n <> 0 or v_row.client_name is not null then
    raise exception '5c: Suspense must hold no intent and no customer (% / %)', v_n, coalesce(v_row.client_name, '<null>');
  end if;

  -- 5d. Suspense -> old order again.
  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'old_order', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'X-11', p_legacy_client_name => 'Client D');
  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending';
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_n <> 1 or v_row.client_name <> 'Client D' then raise exception '5d: % / %', v_n, v_row.client_name; end if;

  -- 5e. old order -> Confirmed Order: the record's own customer, the legacy intent cancelled.
  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc');
  select * into v_i from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending';
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_i.target_type <> 'confirmed_order' or v_i.legacy_order_no is not null
     or v_i.order_id <> 'a0000000-0000-4000-8000-00000000000a' or v_row.client_name <> 'Kalyan Interiors' then
    raise exception '5e: the Order intent is wrong: %', to_jsonb(v_i);
  end if;

  -- 5f. Confirmed Order -> old order, and -> PI Draft -> old order.
  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'old_order', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'X-12', p_legacy_client_name => 'Client E');
  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'pi_draft',
    p_target_id => 'd0000000-0000-4000-8000-00000000000d', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc');
  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'old_order', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'X-12', p_legacy_client_name => 'Client E');
  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending';
  select * into v_i from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending';
  if v_n <> 1 or v_i.legacy_order_no <> 'X-12' then raise exception '5f: % / %', v_n, v_i.legacy_order_no; end if;

  -- 5g. The refusals.
  perform pg_temp.refused(format($q$select public.edit_payment_request(p_payment_request_id => %L,
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => 'X-12')$q$, v_pay), 'PAYMENT_LEGACY_FORBIDDEN');
  perform pg_temp.refused(format($q$select public.edit_payment_request(p_payment_request_id => %L,
    p_destination => 'old_order', p_amount => 70000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_client_name => 'Client E')$q$, v_pay), 'PAYMENT_LEGACY_ORDER_REQUIRED');
  perform pg_temp.refused(format($q$select public.edit_payment_request(p_payment_request_id => %L,
    p_destination => 'old_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 70000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_legacy_order_no => 'X-12',
    p_legacy_client_name => 'Client E')$q$, v_pay), 'PAYMENT_TARGET_FORBIDDEN');
  -- An old-order correction that is refused leaves the request exactly as it was.
  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending';
  if v_n <> 1 or (select legacy_order_no from public.finance_payment_allocation_intents
                   where payment_request_id = v_pay and status = 'pending') <> 'X-12' then
    raise exception '5g: a refused correction changed the request';
  end if;

  -- Another salesperson is not the submitter.
  perform pg_temp.act_as('44444444-4444-4444-8444-444444444444');
  perform pg_temp.refused(format($q$select public.edit_payment_request(p_payment_request_id => %L,
    p_destination => 'old_order', p_amount => 70000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'ZZ', p_legacy_client_name => 'Nobody')$q$, v_pay), 'PAYMENT_EDIT_NOT_PERMITTED');
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');

  -- A verified payment can no longer be corrected.
  perform pg_temp.refused($q$select public.edit_payment_request(
    p_payment_request_id => (select id from public.finance_payment_requests where client_name = 'Mehta Furnishings' and amount = 100000),
    p_destination => 'old_order', p_amount => 100000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'AB-12', p_legacy_client_name => 'Mehta Furnishings')$q$, 'PAYMENT_ALREADY_APPROVED');

  raise notice 'PASS: 5 an old-order request can be corrected, moved to and from every destination, and the refusals hold';
end $$;

-- 5h. A payment the PI page recorded carries an ALLOCATION: its destination is locked.
do $$
declare v_res jsonb; v_pay uuid;
begin
  v_res := public.record_pi_submission_payment(
    p_submission_id => 'd0000000-0000-4000-8000-00000000000d', p_amount => 12000,
    p_payment_date => current_date, p_payment_mode => 'hdfc');
  v_pay := (v_res->>'payment_request_id')::uuid;
  perform pg_temp.refused(format($q$select public.edit_payment_request(p_payment_request_id => %L,
    p_destination => 'old_order', p_amount => 12000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'Q-1', p_legacy_client_name => 'Q Co')$q$, v_pay), 'PAYMENT_EDIT_DESTINATION_LOCKED');
  if exists (select 1 from public.finance_payment_allocation_intents where payment_request_id = v_pay) then
    raise exception '5h: a refused move left an intent';
  end if;
  raise notice 'PASS: 5h an already-allocated payment cannot be moved to an old order here';
end $$;

-- ═══ 6. Rejection and resending ═════════════════════════════════════════════
do $$
declare v_res jsonb; v_pay uuid; v_n int; v_row public.finance_payment_requests%rowtype;
begin
  v_res := public.submit_payment_request(
    p_destination => 'old_order', p_amount => 9000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'R-1', p_legacy_client_name => 'Rejected Co');
  v_pay := (v_res->>'payment_request_id')::uuid;

  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');
  perform public.reject_finance_payment_request(v_pay, 'not received');
  if exists (select 1 from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending') then
    raise exception '6: a rejected request still holds a pending intent';
  end if;
  if not exists (select 1 from public.finance_payment_allocation_intents
                  where payment_request_id = v_pay and status = 'cancelled' and legacy_order_no = 'R-1') then
    raise exception '6: the rejected intent must be kept as cancelled';
  end if;
  if exists (select 1 from public.finance_payment_allocations where payment_request_id = v_pay) then
    raise exception '6: a rejected request created an allocation';
  end if;

  -- The submitter corrects and resends it as an old order.
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');
  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'old_order', p_amount => 9000,
    p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_legacy_order_no => 'R-1', p_legacy_client_name => 'Rejected Co');
  select * into v_row from public.finance_payment_requests where id = v_pay;
  select count(*) into v_n from public.finance_payment_allocation_intents where payment_request_id = v_pay and status = 'pending';
  if v_row.status <> 'pending_approval' or v_n <> 1 then
    raise exception '6: the resent request must be pending with one intent (% / %)', v_row.status, v_n;
  end if;
  raise notice 'PASS: 6 a rejection cancels the intent; the submitter can resend it as an old order';
end $$;

-- ═══ 7. Every other destination is unchanged ════════════════════════════════
do $$
declare v_res jsonb; v_i public.finance_payment_allocation_intents%rowtype;
begin
  v_res := public.submit_payment_request(
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 5000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  select * into v_i from public.finance_payment_allocation_intents where id = (v_res->>'intent_id')::uuid;
  if v_i.target_type <> 'pi_draft' or v_i.legacy_order_no is not null or v_i.legacy_client_name is not null
     or v_res->>'client_name' <> 'Kalyan Interiors' or v_res->>'destination' <> 'pi_draft' then
    raise exception '7: a PI Draft request changed: % %', v_res, to_jsonb(v_i);
  end if;

  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 5000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  select * into v_i from public.finance_payment_allocation_intents where id = (v_res->>'intent_id')::uuid;
  if v_i.target_type <> 'confirmed_order' or v_i.legacy_order_no is not null then raise exception '7: an Order request changed'; end if;

  v_res := public.submit_payment_request(
    p_destination => 'suspense', p_amount => 5000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  if v_res->>'intent_id' is not null or v_res->>'client_name' is not null then raise exception '7: a Suspense request changed'; end if;

  -- The table itself refuses an intent of an unknown shape.
  perform pg_temp.refused($q$insert into public.finance_payment_allocation_intents
    (payment_request_id, target_type, legacy_order_no, legacy_client_name, intended_amount, created_by)
    select id, 'legacy_order', 'lower-case', 'X', 1, submitted_by
      from public.finance_payment_requests where amount = 5000 and client_name is null limit 1$q$,
    'finance_payment_allocation_intents_one_target');
  perform pg_temp.refused($q$insert into public.finance_payment_allocation_intents
    (payment_request_id, target_type, order_id, legacy_order_no, legacy_client_name, intended_amount, created_by)
    select id, 'confirmed_order', 'a0000000-0000-4000-8000-00000000000a', 'AB', 'X', 1, submitted_by
      from public.finance_payment_requests where amount = 5000 and client_name is null limit 1$q$,
    'finance_payment_allocation_intents_one_target');

  raise notice 'PASS: 7 PI Draft, Confirmed Order and Suspense requests are unchanged and carry no old-order facts';
end $$;

-- ═══ 8. The implementation doors are closed to a signed-in user ═════════════
select pg_temp.act_as(:SALES);
set local role authenticated;
do $$
begin
  perform pg_temp.refused($q$select public.place_old_order_intent_internal(
    gen_random_uuid(), 'A', 'B', 1)$q$, 'permission denied');
  perform pg_temp.refused($q$select public.edit_payment_request_base(
    gen_random_uuid(), 'suspense', null, 1, current_date, 'hdfc')$q$, 'permission denied');
  perform pg_temp.refused($q$select public.apply_payment_allocation_intents(gen_random_uuid())$q$, 'permission denied');
  raise notice 'PASS: 8 the internal doors are closed to a signed-in user';
end $$;
reset role;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
