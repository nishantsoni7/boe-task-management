-- TEST-ONLY. Run BEFORE 20261219000000 by run_payment_idempotency_suite.sh.
-- Each block REPRODUCES one launch gap on the deployed bodies and prints
-- `REPRODUCED: <gap>`; the runner requires every line. One transaction, rolled
-- back. Fixtures are the runner's committed seed.
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

do $$
declare
  v_a jsonb; v_b jsonb; v_n int; v_amount numeric;
begin
  -- B1. submit_payment_request stores a third decimal as typed.
  v_a := public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 1000.005, p_payment_date => current_date, p_payment_mode => 'hdfc');
  select amount into v_amount from public.finance_payment_requests where id = (v_a->>'payment_request_id')::uuid;
  if v_amount = 1000.005 then raise notice 'REPRODUCED: submit_payment_request stored 1000.005'; end if;

  -- B2. edit_payment_request does the same.
  v_b := public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 500, p_payment_date => current_date, p_payment_mode => 'hdfc');
  perform public.edit_payment_request(p_payment_request_id => (v_b->>'payment_request_id')::uuid,
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 500.009, p_payment_date => current_date, p_payment_mode => 'hdfc');
  select amount into v_amount from public.finance_payment_requests where id = (v_b->>'payment_request_id')::uuid;
  if v_amount = 500.009 then raise notice 'REPRODUCED: edit_payment_request stored 500.009'; end if;

  -- B3. NaN passes `amount <= 0` and the 20260817000000 `amount > 0` CHECK.
  v_a := public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 'NaN'::numeric, p_payment_date => current_date, p_payment_mode => 'hdfc');
  select amount into v_amount from public.finance_payment_requests where id = (v_a->>'payment_request_id')::uuid;
  if v_amount = 'NaN'::numeric then raise notice 'REPRODUCED: submit_payment_request stored NaN'; end if;

  -- B4. The same submission twice is two payments: nothing on the server can
  -- tell a retry from a new payment.
  select count(*) into v_n from public.finance_payment_requests where amount = 777;
  perform public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 777, p_payment_date => current_date, p_payment_mode => 'hdfc');
  perform public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 777, p_payment_date => current_date, p_payment_mode => 'hdfc');
  if (select count(*) from public.finance_payment_requests where amount = 777) = v_n + 2 then
    raise notice 'REPRODUCED: a retried submission recorded the money twice';
  end if;
  perform public.record_payment_with_allocations(p_amount => 888, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_client_name => null,
    p_allocations => '[{"kind":"order","id":"a0000000-0000-4000-8000-00000000000a","amount":888}]'::jsonb);
  perform public.record_payment_with_allocations(p_amount => 888, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_client_name => null,
    p_allocations => '[{"kind":"order","id":"a0000000-0000-4000-8000-00000000000a","amount":888}]'::jsonb);
  if (select count(*) from public.finance_payment_requests where amount = 888) = 2 then
    raise notice 'REPRODUCED: record_payment_with_allocations recorded a retry twice';
  end if;

  -- B5. A lost create response and a retry are two PI Drafts, and a draft whose
  -- upload then failed stays, empty, in its creator's list.
  perform public.create_order_submission(null);
  perform public.create_order_submission(null);
  if (select count(*) from public.order_submissions
       where created_by = '22222222-2222-4222-8222-222222222222'
         and status = 'draft' and source_workbook_path is null) >= 2 then
    raise notice 'REPRODUCED: a retried create left two empty PI Drafts';
  end if;
end $$;

-- B6. The direct INSERT door is OPEN at the privilege and policy layers — the
-- table grant and finance_payment_requests_own_insert — and today a client
-- insert is stopped only because the 20261010000000 reset write guard, which is
-- not SECURITY DEFINER, calls functions authenticated may not execute. That is
-- an accident, not a rule: the day that guard is corrected, the door opens.
set local role authenticated;
do $$
begin
  insert into public.finance_payment_requests (amount, submitted_by, client_name, payment_mode, payment_date)
  values (1234.567, '22222222-2222-4222-8222-222222222222', 'Direct Co', 'hdfc', current_date);
  raise notice 'REPRODUCED: a direct INSERT by authenticated stored a payment with 1234.567';
exception when insufficient_privilege then
  if sqlerrm like 'permission denied for function%'
     and has_table_privilege('authenticated', 'public.finance_payment_requests', 'INSERT')
     and exists (select 1 from pg_policies where tablename = 'finance_payment_requests' and cmd = 'INSERT') then
    raise notice 'REPRODUCED: authenticated holds INSERT and an INSERT policy; the write is stopped only by the reset guard''s accidental "%"', sqlerrm;
  else
    raise;
  end if;
end $$;
reset role;

-- B7. The empty drafts are what the creator's PI Drafts list shows.
set local role authenticated;
do $$
begin
  if (select count(*) from public.order_submissions
       where status = 'draft' and source_workbook_path is null) >= 2 then
    raise notice 'REPRODUCED: the creator reads the empty drafts under RLS (PI Drafts lists them)';
  end if;
end $$;
reset role;

-- B9. "Needs clarification" / "Reject" from the Payment Requests review is a
-- direct UPDATE — and a verifier's direct UPDATE is refused by the reset guard's
-- accidental permission error, so both actions fail in production.
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
create temp table b9_payment on commit drop as
  select (public.submit_payment_request(p_destination => 'suspense', p_amount => 900,
    p_payment_date => current_date, p_payment_mode => 'hdfc')->>'payment_request_id')::uuid as id;
grant select on b9_payment to authenticated;
select pg_temp.act_as('55555555-5555-4555-8555-555555555555');
set local role authenticated;
do $$
begin
  update public.finance_payment_requests
     set status = 'needs_clarification', admin_note = 'Which account?'
   where id = (select id from b9_payment) and status = 'pending_approval';
  raise notice 'NOT REPRODUCED: the direct update worked';
exception when insufficient_privilege then
  if sqlerrm like 'permission denied for function%' then
    raise notice 'REPRODUCED: a verifier''s direct clarification UPDATE fails with "%"', sqlerrm;
  else
    raise;
  end if;
end $$;
reset role;

rollback;
