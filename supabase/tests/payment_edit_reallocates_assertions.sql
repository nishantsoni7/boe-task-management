-- Assertions for 20270322000000_finance_payment_edit_reallocates.sql
--
-- A payment recorded from a PI carries an ALLOCATION, not an intent. Until this
-- migration edit_payment_request refused it (PAYMENT_EDIT_ALLOCATED). Claims:
--
--   1. an unverified, singly-allocated payment can be corrected; a whole
--      allocation follows a new amount by REVERSAL (kept, with a reason and the
--      actor) and a replacement on the SAME target;
--   2. a correction that does not change the amount leaves the allocation alone;
--   3. the destination is locked to the allocation's target;
--   4. a verified payment, a split payment and a stranger are still refused;
--   5. a partial allocation stays; the amount may not fall below it;
--   6. it is ONE transaction: a refused re-allocation undoes the whole edit;
--   7. the unallocated (intent) path behaves exactly as before.
--
-- One transaction, rolled back: nothing is left behind.

\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

insert into public.users (id, email, role, full_name) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test',   'admin',       'Admin'),
  ('22222222-2222-4222-8222-222222222222', 'sales@boe.test',   'salesperson', 'Sales'),
  ('33333333-3333-4333-8333-333333333333', 'nobody@boe.test',  'viewer',      'Nobody');

insert into public.order_submissions (id, client_name, status, created_by, source_order_number, source_workbook_name) values
  ('d0000000-0000-4000-8000-00000000000d', 'Kalyan Interiors', 'draft', '22222222-2222-4222-8222-222222222222', 'PI-4471', 'kalyan.xlsx'),
  ('e0000000-0000-4000-8000-00000000000e', 'Rao Associates',   'draft', '22222222-2222-4222-8222-222222222222', 'PI-4472', 'rao.xlsx');

insert into public.finance_permission_grants (user_id, action) values
  ('22222222-2222-4222-8222-222222222222', 'finance.create'),
  ('22222222-2222-4222-8222-222222222222', 'finance.allocate');

do $$ begin perform pg_temp.act_as('11111111-1111-4111-8111-111111111111'); end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. A whole allocation follows a changed amount, by reversal and replacement
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_old uuid; v_new uuid; v_n int; v_row public.finance_payment_requests%rowtype;
  v_rev public.finance_payment_allocations%rowtype;
begin
  v_res := public.record_pi_submission_payment(
    'd0000000-0000-4000-8000-00000000000d', 5000000, current_date - 3, 'hdfc');
  v_pay := (v_res->>'payment_request_id')::uuid;
  select id into v_old from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active';
  if v_old is null then raise exception '1: the PI entry did not leave an allocation (fixture)'; end if;

  v_res := public.edit_payment_request(
    p_payment_request_id => v_pay,
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 4212670.80, p_payment_date => current_date - 12, p_payment_mode => 'hdfc');

  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.amount <> 4212670.80 or v_row.payment_date <> current_date - 12 then
    raise exception '1a: the payment row was not corrected (%, %)', v_row.amount, v_row.payment_date;
  end if;
  if v_row.status <> 'pending_approval' then raise exception '1a: status moved to %', v_row.status; end if;
  if v_row.client_name <> 'Kalyan Interiors' then raise exception '1a: the customer changed to %', v_row.client_name; end if;

  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active';
  if v_n <> 1 then raise exception '1b: expected exactly 1 active allocation, got %', v_n; end if;
  select id into v_new from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active';
  if v_new = v_old then raise exception '1b: the allocation was edited in place instead of replaced'; end if;
  if not exists (select 1 from public.finance_payment_allocations
                 where id = v_new and allocated_amount = 4212670.80
                   and order_submission_id = 'd0000000-0000-4000-8000-00000000000d'
                   and order_id is null and origin_target_type = 'order_submission') then
    raise exception '1b: the replacement is not 4212670.80 on the same PI';
  end if;

  select * into v_rev from public.finance_payment_allocations where id = v_old;
  if v_rev.status <> 'reversed' or v_rev.allocated_amount <> 5000000
     or v_rev.reversal_reason not like 'Payment corrected before verification%'
     or v_rev.reversed_by is distinct from '11111111-1111-4111-8111-111111111111'::uuid
     or v_rev.reversed_at is null then
    raise exception '1c: the old allocation was not kept as a reversal with its reason and actor (%)', row_to_json(v_rev);
  end if;

  if (v_res->>'allocation_created')::boolean is not true then raise exception '1d: result does not say an allocation was created'; end if;
  if v_res->>'allocation_id' is distinct from v_new::text then raise exception '1d: result names the wrong allocation'; end if;

  raise notice '1. A WHOLE ALLOCATION FOLLOWS THE NEW AMOUNT, BY REVERSAL AND REPLACEMENT';

  -- 2. A correction that leaves the amount alone leaves the allocation alone.
  v_res := public.edit_payment_request(
    p_payment_request_id => v_pay,
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 4212670.80, p_payment_date => current_date - 11, p_payment_mode => 'hdfc',
    p_proof_note => 'UTR 123');
  if (select id from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active') <> v_new then
    raise exception '2: a date-only correction replaced the allocation';
  end if;
  select count(*) into v_n from public.finance_payment_allocations where payment_request_id = v_pay;
  if v_n <> 2 then raise exception '2: expected 2 allocation rows in all, got %', v_n; end if;
  if (v_res->>'allocation_created')::boolean is not false then raise exception '2: result says an allocation was created'; end if;
  raise notice '2. NO AMOUNT CHANGE, NO ALLOCATION CHANGE';

  -- 3. The destination is locked.
  begin
    perform public.edit_payment_request(
      p_payment_request_id => v_pay, p_destination => 'suspense', p_target_id => null,
      p_amount => 4212670.80, p_payment_date => current_date - 11, p_payment_mode => 'hdfc');
    raise exception '3a: moving an allocated payment to Suspense was accepted';
  exception when others then
    if sqlerrm not like '%PAYMENT_EDIT_DESTINATION_LOCKED%' then raise; end if;
  end;
  begin
    perform public.edit_payment_request(
      p_payment_request_id => v_pay, p_destination => 'pi_draft',
      p_target_id => 'e0000000-0000-4000-8000-00000000000e',
      p_amount => 4212670.80, p_payment_date => current_date - 11, p_payment_mode => 'hdfc');
    raise exception '3b: moving an allocated payment to another PI was accepted';
  exception when others then
    if sqlerrm not like '%PAYMENT_EDIT_DESTINATION_LOCKED%' then raise; end if;
  end;
  if (select id from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active') <> v_new then
    raise exception '3: a refused move changed the allocation';
  end if;
  raise notice '3. THE DESTINATION IS LOCKED';

  -- 4a. A stranger is refused.
  perform pg_temp.act_as('33333333-3333-4333-8333-333333333333');
  begin
    perform public.edit_payment_request(
      p_payment_request_id => v_pay, p_destination => 'pi_draft',
      p_target_id => 'd0000000-0000-4000-8000-00000000000d',
      p_amount => 100, p_payment_date => current_date, p_payment_mode => 'hdfc');
    raise exception '4a: a stranger corrected the payment';
  exception when others then
    if sqlerrm not like '%PAYMENT_EDIT_NOT_PERMITTED%' and sqlerrm not like '%FINANCE_MODULE_CLOSED%' then raise; end if;
  end;
  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');

  -- 4b. A verified payment is refused and nothing moves.
  perform public.approve_finance_payment_request(v_pay, null);
  begin
    perform public.edit_payment_request(
      p_payment_request_id => v_pay, p_destination => 'pi_draft',
      p_target_id => 'd0000000-0000-4000-8000-00000000000d',
      p_amount => 1, p_payment_date => current_date, p_payment_mode => 'hdfc');
    raise exception '4b: a verified payment was corrected';
  exception when others then
    if sqlerrm not like '%PAYMENT_ALREADY_APPROVED%' then raise; end if;
  end;
  if (select amount from public.finance_payment_requests where id = v_pay) <> 4212670.80
     or (select id from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active') <> v_new then
    raise exception '4b: a refused edit of a verified payment changed something';
  end if;
  raise notice '4. A STRANGER AND A VERIFIED PAYMENT ARE STILL REFUSED';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Split and partial allocations
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_alloc uuid;
begin
  v_res := public.submit_payment_request(
    p_destination => 'suspense', p_amount => 60000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  v_pay := (v_res->>'payment_request_id')::uuid;

  -- Partial: 20,000 of 60,000 on one PI.
  perform public.allocate_payment_to_target_internal(v_pay, 'd0000000-0000-4000-8000-00000000000d'::uuid, null::uuid, 20000::numeric);
  select id into v_alloc from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active';

  perform public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'pi_draft',
    p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 70000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  if (select id from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active') <> v_alloc
     or (select amount from public.finance_payment_requests where id = v_pay) <> 70000 then
    raise exception '5a: a partial allocation was disturbed, or the amount not corrected';
  end if;

  begin
    perform public.edit_payment_request(
      p_payment_request_id => v_pay, p_destination => 'pi_draft',
      p_target_id => 'd0000000-0000-4000-8000-00000000000d',
      p_amount => 10000, p_payment_date => current_date, p_payment_mode => 'hdfc');
    raise exception '5b: the amount fell below what is allocated';
  exception when others then
    if sqlerrm not like '%PAYMENT_BELOW_ALLOCATED%' then raise; end if;
  end;

  -- Split: a second allocation on the other PI.
  perform public.allocate_payment_to_target_internal(v_pay, 'e0000000-0000-4000-8000-00000000000e'::uuid, null::uuid, 10000::numeric);
  begin
    perform public.edit_payment_request(
      p_payment_request_id => v_pay, p_destination => 'pi_draft',
      p_target_id => 'd0000000-0000-4000-8000-00000000000d',
      p_amount => 70000, p_payment_date => current_date, p_payment_mode => 'hdfc');
    raise exception '5c: a split payment was corrected';
  exception when others then
    if sqlerrm not like '%PAYMENT_EDIT_SPLIT_ALLOCATED%' then raise; end if;
  end;
  raise notice '5. A PARTIAL ALLOCATION STAYS; A SPLIT PAYMENT IS REFUSED BY NAME';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. ONE TRANSACTION: a refused replacement undoes the whole correction
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_alloc uuid; v_failed boolean := false;
begin
  v_res := public.record_pi_submission_payment(
    'e0000000-0000-4000-8000-00000000000e', 80000, current_date, 'hdfc');
  v_pay := (v_res->>'payment_request_id')::uuid;
  select id into v_alloc from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active';

  update public.order_submissions set status = 'rejected' where id = 'e0000000-0000-4000-8000-00000000000e';
  begin
    perform public.edit_payment_request(
      p_payment_request_id => v_pay, p_destination => 'pi_draft',
      p_target_id => 'e0000000-0000-4000-8000-00000000000e',
      p_amount => 75000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception '6: the correction onto a rejected PI was accepted'; end if;
  if (select amount from public.finance_payment_requests where id = v_pay) <> 80000
     or (select id from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active') is distinct from v_alloc
     or (select count(*) from public.finance_payment_allocations where payment_request_id = v_pay) <> 1 then
    raise exception '6: a refused correction left the payment or its allocation changed';
  end if;
  update public.order_submissions set status = 'draft' where id = 'e0000000-0000-4000-8000-00000000000e';
  raise notice '6. ONE TRANSACTION: A REFUSED REPLACEMENT UNDOES THE EDIT';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. The unallocated (intent) path is exactly as before
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid;
begin
  v_res := public.submit_payment_request(
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 30000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  v_pay := (v_res->>'payment_request_id')::uuid;
  v_res := public.edit_payment_request(
    p_payment_request_id => v_pay, p_destination => 'suspense', p_target_id => null,
    p_amount => 31000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  if (v_res->>'pending_intents')::int <> 0 or (v_res->>'allocation_created')::boolean is not false
     or (select count(*) from public.finance_payment_allocations where payment_request_id = v_pay) <> 0
     or (select client_name from public.finance_payment_requests where id = v_pay) is not null then
    raise exception '7: the intent path changed: %', v_res;
  end if;
  raise notice '7. THE INTENT PATH IS UNCHANGED';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
