-- TEST-ONLY. Run AFTER 20261219000000 by run_payment_idempotency_suite.sh.
-- Every scenario acts as a real user (request.jwt.claims; `set local role
-- authenticated` where the table/function PRIVILEGE is the thing under test).
-- One transaction, rolled back. Prints `PASS: <n>` per block; any failure
-- raises and stops the file.
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

-- Row counts that must not move when a retry is replayed.
create or replace function pg_temp.footprint()
returns text language sql as $$
  select format('pay=%s alloc=%s intent=%s custody=%s activity=%s keys=%s',
    (select count(*) from public.finance_payment_requests),
    (select count(*) from public.finance_payment_allocations),
    (select count(*) from public.finance_payment_allocation_intents),
    (select count(*) from public.finance_payment_custody_events),
    (select count(*) from public.finance_payment_request_activity_log),
    (select count(*) from public.finance_payment_submission_keys))
$$;

\set SALES   '''22222222-2222-4222-8222-222222222222'''
\set SALES2  '''44444444-4444-4444-8444-444444444444'''
\set OUTSIDE '''33333333-3333-4333-8333-333333333333'''

-- ═══ 1. Rupees and paise, on every door ═══════════════════════════════════════
select pg_temp.act_as(:SALES);
do $$
declare
  v_before text := pg_temp.footprint();
  v_pay uuid;
begin
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 1000.005,
    p_payment_date => current_date, p_payment_mode => 'hdfc')$q$, 'PAYMENT_AMOUNT_INVALID');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 'NaN'::numeric,
    p_payment_date => current_date, p_payment_mode => 'hdfc')$q$, 'PAYMENT_AMOUNT_INVALID');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 'Infinity'::numeric,
    p_payment_date => current_date, p_payment_mode => 'hdfc')$q$, 'PAYMENT_AMOUNT_INVALID');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 1000.005,
    p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_idempotency_key => '90000000-0000-4000-8000-000000000001')$q$, 'PAYMENT_AMOUNT_INVALID');
  perform pg_temp.refused($q$select public.record_payment_with_allocations(p_amount => 1000.005,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_client_name => null)$q$, 'PAYMENT_AMOUNT_INVALID');
  perform pg_temp.refused($q$select public.record_pi_submission_payment(
    p_submission_id => 'd0000000-0000-4000-8000-00000000000d', p_amount => 1000.005,
    p_payment_date => current_date, p_payment_mode => 'hdfc')$q$, 'PAYMENT_AMOUNT_INVALID');
  if pg_temp.footprint() <> v_before then
    raise exception 'a refused amount wrote something: % -> %', v_before, pg_temp.footprint();
  end if;

  -- The EDIT door: refused, and the stored amount is the one that was there.
  v_pay := (public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 500,
    p_payment_date => current_date, p_payment_mode => 'hdfc')->>'payment_request_id')::uuid;
  perform pg_temp.refused(format($q$select public.edit_payment_request(p_payment_request_id => %L,
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 500.009, p_payment_date => current_date, p_payment_mode => 'hdfc')$q$, v_pay), 'PAYMENT_AMOUNT_INVALID');
  if (select amount from public.finance_payment_requests where id = v_pay) <> 500 then
    raise exception 'a refused edit changed the amount';
  end if;
  -- Two decimals, and a correction to one, are accepted exactly as entered.
  perform public.edit_payment_request(p_payment_request_id => v_pay,
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 500.75, p_payment_date => current_date, p_payment_mode => 'hdfc');
  if (select amount from public.finance_payment_requests where id = v_pay) <> 500.75 then
    raise exception 'a valid two-decimal edit was not stored exactly';
  end if;
  raise notice 'PASS: 1a every payment door refuses 1000.005, NaN and Infinity with PAYMENT_AMOUNT_INVALID and writes nothing; 500.75 is stored exactly';
end $$;

-- The table itself, for a writer that is not an RPC (service role, SQL).
do $$
begin
  perform pg_temp.refused($q$insert into public.finance_payment_requests (amount, submitted_by, client_name, payment_mode)
    values (10.001, '22222222-2222-4222-8222-222222222222', 'X', 'hdfc')$q$, 'PAYMENT_AMOUNT_INVALID');
  perform pg_temp.refused($q$update public.finance_payment_requests set amount = 1.234
    where id = (select id from public.finance_payment_requests limit 1)$q$, 'PAYMENT_AMOUNT_INVALID');
  -- With the friendly trigger out of the way, the CHECK alone still refuses.
  alter table public.finance_payment_requests disable trigger finance_payment_requests_amount_is_rupees_and_paise;
  perform pg_temp.refused($q$insert into public.finance_payment_requests (amount, submitted_by, client_name, payment_mode)
    values (10.001, '22222222-2222-4222-8222-222222222222', 'X', 'hdfc')$q$, 'finance_payment_requests_amount_rupees_and_paise');
  perform pg_temp.refused($q$insert into public.finance_payment_requests (amount, submitted_by, client_name, payment_mode)
    values ('NaN', '22222222-2222-4222-8222-222222222222', 'X', 'hdfc')$q$, 'finance_payment_requests_amount_rupees_and_paise');
  alter table public.finance_payment_requests enable trigger finance_payment_requests_amount_is_rupees_and_paise;
  raise notice 'PASS: 1b the table refuses a third decimal from any writer; the CHECK holds even without the trigger';
end $$;

-- ═══ 2. Idempotency — sequential retry, every door ════════════════════════════
select pg_temp.act_as(:SALES);
do $$
declare
  k1 constant uuid := '91000000-0000-4000-8000-000000000001';
  k2 constant uuid := '91000000-0000-4000-8000-000000000002';
  v_first jsonb; v_again jsonb; v_other jsonb; v_fp text;
begin
  -- submit_payment_request
  v_first := public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 40000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_proof_note => 'NEFT 1',
    p_idempotency_key => k1);
  v_fp := pg_temp.footprint();
  -- The retry: same key, same payload — even spelled 40000.00 with padding.
  v_again := public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 40000.00,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_proof_note => '  NEFT 1 ',
    p_idempotency_key => k1);
  if v_again <> v_first then raise exception 'the retry did not return the original result'; end if;
  if pg_temp.footprint() <> v_fp then raise exception 'the retry wrote rows: % -> %', v_fp, pg_temp.footprint(); end if;
  -- Same key, different payload: refused by name, nothing written.
  perform pg_temp.refused(format($q$select public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 45000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_proof_note => 'NEFT 1',
    p_idempotency_key => %L)$q$, k1), 'PAYMENT_IDEMPOTENCY_KEY_REUSED');
  -- Same key on ANOTHER door: refused.
  perform pg_temp.refused(format($q$select public.record_payment_with_allocations(p_amount => 40000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_client_name => null,
    p_idempotency_key => %L)$q$, k1), 'PAYMENT_IDEMPOTENCY_KEY_REUSED');
  if pg_temp.footprint() <> v_fp then raise exception 'a refused key wrote rows'; end if;
  -- A genuinely separate payment — same details, NEW key — is recorded.
  v_other := public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 40000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_proof_note => 'NEFT 1',
    p_idempotency_key => k2);
  if v_other->>'payment_request_id' = v_first->>'payment_request_id' then
    raise exception 'a new key replayed an old payment';
  end if;
  raise notice 'PASS: 2a submit_payment_request — a retry returns the original result and writes nothing; a changed payload or another door is refused by name; a new key records a second payment';
end $$;

do $$
declare
  k constant uuid := '92000000-0000-4000-8000-000000000001';
  v_first jsonb; v_again jsonb; v_fp text; v_pay uuid;
  v_alloc constant jsonb := '[{"kind":"order","id":"a0000000-0000-4000-8000-00000000000a","amount":600000},
                              {"kind":"submission","id":"d0000000-0000-4000-8000-00000000000d","amount":400000}]';
  v_custody constant jsonb := '[{"key":"c1","activity_type":"collected","occurred_at":"2026-09-19T10:00:00+05:30",
                                 "collected_by":"22222222-2222-4222-8222-222222222222"}]';
begin
  v_first := public.record_payment_with_allocations(p_amount => 1000000, p_payment_date => current_date,
    p_payment_mode => 'pnb', p_client_name => null, p_reference => 'UTR-9',
    p_allocations => v_alloc, p_custody_events => v_custody, p_idempotency_key => k);
  v_pay := (v_first->>'payment_request_id')::uuid;
  v_fp := pg_temp.footprint();
  v_again := public.record_payment_with_allocations(p_amount => 1000000, p_payment_date => current_date,
    p_payment_mode => 'pnb', p_client_name => null, p_reference => 'UTR-9',
    p_allocations => v_alloc, p_custody_events => v_custody, p_idempotency_key => k);
  if v_again <> v_first then raise exception 'split retry did not return the original result'; end if;
  if pg_temp.footprint() <> v_fp then raise exception 'split retry wrote rows: % -> %', v_fp, pg_temp.footprint(); end if;
  if (select count(*) from public.finance_payment_allocations where payment_request_id = v_pay and status = 'active') <> 2
     or (select sum(allocated_amount) from public.finance_payment_allocations where payment_request_id = v_pay) <> 1000000
     or (select count(*) from public.finance_payment_custody_events where payment_request_id = v_pay) <> 1 then
    raise exception 'the split payment is not exactly one allocation set and one custody set';
  end if;
  perform pg_temp.refused(format($q$select public.record_payment_with_allocations(p_amount => 1000000,
    p_payment_date => current_date, p_payment_mode => 'pnb', p_client_name => null, p_reference => 'UTR-9',
    p_allocations => '[{"kind":"order","id":"a0000000-0000-4000-8000-00000000000a","amount":1000000}]',
    p_custody_events => %L, p_idempotency_key => %L)$q$, v_custody, k), 'PAYMENT_IDEMPOTENCY_KEY_REUSED');
  raise notice 'PASS: 2b record_payment_with_allocations — ₹10,00,000 split 6L/4L with a custody event: the retry returns the original, writes nothing; 2 allocations, 1 custody event; a different split is refused';
end $$;

do $$
declare
  k constant uuid := '93000000-0000-4000-8000-000000000001';
  v_first jsonb; v_again jsonb; v_fp text;
begin
  v_first := public.record_pi_submission_payment(p_submission_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 250000.50, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => k);
  v_fp := pg_temp.footprint();
  v_again := public.record_pi_submission_payment(p_submission_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 250000.5, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => k);
  if v_again <> v_first then raise exception 'PI retry did not return the original result'; end if;
  if pg_temp.footprint() <> v_fp then raise exception 'PI retry wrote rows'; end if;
  if (select count(*) from public.finance_payment_allocations
       where payment_request_id = (v_first->>'payment_request_id')::uuid) <> 1 then
    raise exception 'the PI payment is not exactly one allocation';
  end if;
  raise notice 'PASS: 2c record_pi_submission_payment — the retry returns the original result and writes nothing; one payment, one allocation';
end $$;

-- A NULL key is today's behaviour, unchanged: the deployed frontend keeps working.
do $$
declare v_n int := (select count(*) from public.finance_payment_requests where amount = 321);
begin
  perform public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 321,
    p_payment_date => current_date, p_payment_mode => 'hdfc');
  perform public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 321,
    p_payment_date => current_date, p_payment_mode => 'hdfc');
  if (select count(*) from public.finance_payment_requests where amount = 321) <> v_n + 2 then
    raise exception 'a call without a key no longer behaves as deployed';
  end if;
  if exists (select 1 from public.finance_payment_submission_keys k
              join public.finance_payment_requests f on f.id = k.payment_request_id where f.amount = 321) then
    raise exception 'a call without a key left a key row';
  end if;
  raise notice 'PASS: 2d without a key the doors behave exactly as deployed (the current frontend is unaffected during rollout)';
end $$;

-- Keys are per ACTOR: another employee's identical key is their own.
select pg_temp.act_as(:SALES2);
do $$
declare v_mine jsonb; v_theirs uuid;
begin
  select payment_request_id into v_theirs from public.finance_payment_submission_keys
   where idempotency_key = '91000000-0000-4000-8000-000000000001';
  v_mine := public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 40000,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_proof_note => 'NEFT 1',
    p_idempotency_key => '91000000-0000-4000-8000-000000000001');
  if (v_mine->>'payment_request_id')::uuid = v_theirs then
    raise exception 'another employee''s key replayed someone else''s payment';
  end if;
  raise notice 'PASS: 2e a key is scoped to its actor — another employee using the same key value records their own payment and never reads the first one''s result';
end $$;

-- A payment that was removed (the /finance proof compensation, an admin
-- deletion) takes its key with it: an honest resubmission records ONCE.
select pg_temp.act_as(:SALES);
do $$
declare
  k constant uuid := '94000000-0000-4000-8000-000000000001';
  v_first uuid; v_second uuid; v_third uuid;
begin
  v_first := (public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 1234,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => k)->>'payment_request_id')::uuid;
  delete from public.finance_payment_requests where id = v_first;
  v_second := (public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 1234,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => k)->>'payment_request_id')::uuid;
  v_third := (public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 1234,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => k)->>'payment_request_id')::uuid;
  if v_second = v_first or v_third <> v_second
     or (select count(*) from public.finance_payment_requests where amount = 1234) <> 1 then
    raise exception 'resubmission after removal did not converge on exactly one payment';
  end if;
  raise notice 'PASS: 2f after the payment is removed, the same submission records exactly one new payment, and its retry replays that one';
end $$;

-- ═══ 3. Security ═══════════════════════════════════════════════════════════════
select pg_temp.act_as(:SALES);
set local role authenticated;
do $$
begin
  -- Refused by the PRIVILEGE now, before any trigger runs — not by the guard's
  -- accident.
  perform pg_temp.refused($q$insert into public.finance_payment_requests (amount, submitted_by, client_name, payment_mode)
    values (100, '22222222-2222-4222-8222-222222222222', 'Direct Co', 'hdfc')$q$, 'permission denied for table finance_payment_requests');
  perform pg_temp.refused($q$select public.submit_payment_request_core('confirmed_order',
    'a0000000-0000-4000-8000-00000000000a', 100, current_date, 'hdfc', null, null, '[]')$q$, '42501');
  perform pg_temp.refused($q$select public.record_payment_with_allocations_core(100, current_date, 'hdfc',
    null, null, null, null, '[]', '[]')$q$, '42501');
  perform pg_temp.refused($q$select public.record_pi_submission_payment_core(
    'd0000000-0000-4000-8000-00000000000d', 100, current_date, 'hdfc', null, null)$q$, '42501');
  perform pg_temp.refused($q$select public.create_order_submission_core(null)$q$, '42501');
  perform pg_temp.refused($q$select public.finance_payment_submission_key_claim('submit_payment_request',
    gen_random_uuid(), repeat('0', 32))$q$, '42501');
  perform pg_temp.refused($q$select public.finance_payment_submission_key_record('submit_payment_request',
    gen_random_uuid(), repeat('0', 32), '{}')$q$, '42501');
  perform pg_temp.refused($q$select count(*) from public.finance_payment_submission_keys$q$, '42501');
  perform pg_temp.refused($q$select count(*) from public.order_submission_creation_keys$q$, '42501');
  perform pg_temp.refused($q$insert into public.order_submission_creation_keys values
    ('22222222-2222-4222-8222-222222222222', gen_random_uuid(), 'd0000000-0000-4000-8000-00000000000d')$q$, '42501');
  raise notice 'PASS: 3a authenticated: direct INSERT refused (42501); every _core body and key helper refused; both key tables unreadable and unwritable';
end $$;
reset role;

set local role anon;
do $$
begin
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'suspense', p_amount => 1,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => gen_random_uuid())$q$, '42501');
  perform pg_temp.refused($q$select public.record_payment_with_allocations(p_amount => 1, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_client_name => null, p_idempotency_key => gen_random_uuid())$q$, '42501');
  perform pg_temp.refused($q$select public.record_pi_submission_payment(p_submission_id => gen_random_uuid(),
    p_amount => 1, p_payment_date => current_date, p_payment_mode => 'hdfc')$q$, '42501');
  perform pg_temp.refused($q$select public.create_order_submission(null, gen_random_uuid())$q$, '42501');
  perform pg_temp.refused($q$select public.discard_unsaved_order_submission(gen_random_uuid())$q$, '42501');
  raise notice 'PASS: 3b anon cannot execute any door';
end $$;
reset role;

-- Signed out (no claims) and a signed-in employee with no Finance or Orders grant.
do $$
declare v_fp text := pg_temp.footprint();
begin
  perform pg_temp.act_as(null);
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 10, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_idempotency_key => gen_random_uuid())$q$, 'Authentication required');
  perform pg_temp.act_as('33333333-3333-4333-8333-333333333333');
  perform pg_temp.refused($q$select public.submit_payment_request(p_destination => 'confirmed_order',
    p_target_id => 'a0000000-0000-4000-8000-00000000000a', p_amount => 10, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_idempotency_key => '91000000-0000-4000-8000-000000000001')$q$, '');
  perform pg_temp.refused($q$select public.record_payment_with_allocations(p_amount => 10, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_client_name => null, p_idempotency_key => gen_random_uuid())$q$, '');
  perform pg_temp.refused($q$select public.record_pi_submission_payment(p_submission_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 10, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => gen_random_uuid())$q$, '');
  perform pg_temp.refused($q$select public.create_order_submission(null, gen_random_uuid())$q$, '42501');
  if pg_temp.footprint() <> v_fp then raise exception 'an unauthorized call wrote rows'; end if;
  raise notice 'PASS: 3c signed out: refused; an employee without Finance/Orders grants: every door refused, even replaying another employee''s key value, and nothing is written';
end $$;

-- ═══ 4. PI Drafts: one per attempt, and an unsaved one leaves nothing ═════════
select pg_temp.act_as(:SALES);
do $$
declare
  k  constant uuid := '95000000-0000-4000-8000-000000000001';
  v_a jsonb; v_b jsonb; v_c jsonb; v_n int; v_r jsonb; v_other uuid;
begin
  v_n := (select count(*) from public.order_submissions);
  v_a := public.create_order_submission(null, k);
  v_b := public.create_order_submission(null, k);   -- the lost-response retry
  v_c := public.create_order_submission(null, k);   -- a third click
  if v_b->>'id' <> v_a->>'id' or v_c->>'id' <> v_a->>'id'
     or (select count(*) from public.order_submissions) <> v_n + 1 then
    raise exception 'one key did not resolve to one draft';
  end if;
  if (select count(*) from public.order_submission_activity where submission_id = (v_a->>'id')::uuid) <> 1 then
    raise exception 'a replayed create logged activity again';
  end if;
  -- Nobody else may discard it.
  perform pg_temp.act_as('44444444-4444-4444-8444-444444444444');
  perform pg_temp.refused(format('select public.discard_unsaved_order_submission(%L)', v_a->>'id'), 'ORDER_SUBMISSION_DISCARD_DENIED');
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');
  -- Its creator may, and it is gone with its trail and its key.
  v_r := public.discard_unsaved_order_submission((v_a->>'id')::uuid);
  if v_r->>'discarded' <> 'true'
     or exists (select 1 from public.order_submissions where id = (v_a->>'id')::uuid)
     or exists (select 1 from public.order_submission_activity where submission_id = (v_a->>'id')::uuid)
     or exists (select 1 from public.order_submission_creation_keys where idempotency_key = k) then
    raise exception 'the creator''s discard did not remove the unsaved draft: %', v_r;
  end if;
  if (select count(*) from public.order_submissions) <> v_n then raise exception 'draft count did not return'; end if;
  -- Discarding it again is an answer, not an error.
  if public.discard_unsaved_order_submission((v_a->>'id')::uuid)->>'reason' <> 'absent' then
    raise exception 'a second discard did not say absent';
  end if;
  -- A different key is a different upload.
  v_other := (public.create_order_submission(null, '95000000-0000-4000-8000-000000000002')->>'id')::uuid;
  if v_other::text = v_a->>'id' then raise exception 'a new key reused a discarded draft'; end if;
  raise notice 'PASS: 4a one key → one draft across three calls (one activity row); only its creator can discard it; discard removes row, activity and key; a repeat says absent';
end $$;

-- Every state that makes a draft real is refused.
do $$
declare
  v_id uuid;
  v_case text;
begin
  foreach v_case in array array['workbook', 'item', 'lease', 'submitted', 'reserved', 'claim', 'payment', 'activity', 'version'] loop
    v_id := (public.create_order_submission(null, gen_random_uuid())->>'id')::uuid;
    case v_case
      when 'workbook'  then update public.order_submissions set source_workbook_path = v_id || '/original/x.xlsx' where id = v_id;
      when 'item'      then insert into public.order_submission_items (submission_id, product_name) values (v_id, 'Chair');
      when 'lease'     then update public.order_submissions set processing_token = gen_random_uuid(), processing_started_at = now() where id = v_id;
      when 'submitted' then update public.order_submissions set status = 'submitted' where id = v_id;
      when 'reserved'  then update public.order_submissions set reserved_order_number = '0999' where id = v_id;
      when 'claim'     then update public.order_submissions set deletion_claim_token = gen_random_uuid(),
                              deletion_claimed_at = now(), deletion_claimed_by = '11111111-1111-4111-8111-111111111111' where id = v_id;
      when 'payment'   then
        update public.order_submissions set client_name = 'Pay Co' where id = v_id;
        perform public.record_pi_submission_payment(p_submission_id => v_id, p_amount => 10,
          p_payment_date => current_date, p_payment_mode => 'hdfc');
      when 'activity'  then insert into public.order_submission_activity (submission_id, action) values (v_id, 'parse_replaced');
      when 'version'   then insert into public.order_pi_versions (submission_id) values (v_id);
    end case;
    if public.discard_unsaved_order_submission(v_id)->>'discarded' <> 'false'
       or not exists (select 1 from public.order_submissions where id = v_id) then
      raise exception 'a draft with % was discarded', v_case;
    end if;
  end loop;
  raise notice 'PASS: 4b discard refuses a draft with a workbook, an item, a processing lease, a non-draft status, a reserved number, a deletion claim, a payment, later activity or a PI version';
end $$;

-- The creator's list, under RLS, holds no empty draft after a failed upload is
-- discarded — the same query /orders/drafts runs.
set local role authenticated;
do $$
declare v_id uuid;
begin
  v_id := (public.create_order_submission(null, '95000000-0000-4000-8000-000000000009')->>'id')::uuid;
  if not exists (select 1 from public.order_submissions where id = v_id) then
    raise exception 'the creator cannot read their own draft under RLS';
  end if;
  -- "the upload failed" → the screen discards
  perform public.discard_unsaved_order_submission(v_id);
  if exists (select 1 from public.order_submissions where id = v_id) then
    raise exception 'the discarded draft is still listed';
  end if;
  raise notice 'PASS: 4c as the creator under RLS: after a failed upload is discarded, PI Drafts lists nothing for it';
end $$;
reset role;


-- ═══ 5. A replay is still an authorized call ══════════════════════════════════
-- For every door: create with a key, replay it (same result); then take the
-- access away and replay again. The refusal must be the door's own, must write
-- nothing, and must read EXACTLY as it does for a key that was never used — a
-- caller who may not use the door learns nothing about whether a key exists.

-- Runs p_sql; returns 'OK' or '<sqlstate>:<message>'.
create or replace function pg_temp.outcome(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;

-- Replays p_sql_known (a key that exists) and p_sql_fresh (a key that never
-- did); both must be refused identically with p_expect, and write nothing.
create or replace function pg_temp.refused_alike(p_known text, p_fresh text, p_expect text, p_label text)
returns void language plpgsql as $$
declare
  v_fp text := pg_temp.footprint();
  v_known text := pg_temp.outcome(p_known);
  v_fresh text := pg_temp.outcome(p_fresh);
begin
  if v_known = 'OK' or position(p_expect in v_known) = 0 then
    raise exception '%: expected %, got %', p_label, p_expect, v_known;
  end if;
  if v_known <> v_fresh then
    raise exception '%: a used key reads differently from an unused one (% vs %)', p_label, v_known, v_fresh;
  end if;
  if pg_temp.footprint() <> v_fp then
    raise exception '%: a refused replay wrote rows', p_label;
  end if;
end $$;

-- 5a. Payment Request (submit_payment_request): Finance entry.
select pg_temp.act_as('44444444-4444-4444-8444-444444444444');
do $$
declare
  k  constant uuid := 'b1000000-0000-4000-8000-000000000001';
  call constant text := $q$select public.submit_payment_request(p_destination => 'suspense', p_amount => 1111,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => '%s')$q$;
  v1 jsonb; v2 jsonb;
begin
  v1 := public.submit_payment_request(p_destination => 'suspense', p_amount => 1111, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_idempotency_key => k);
  v2 := public.submit_payment_request(p_destination => 'suspense', p_amount => 1111, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_idempotency_key => k);
  if v1 <> v2 then raise exception '5a: authorized replay did not return the original'; end if;

  delete from public.finance_permission_grants where user_id = '44444444-4444-4444-8444-444444444444' and action like 'finance.%';
  perform pg_temp.refused_alike(format(call, k), format(call, gen_random_uuid()), 'FINANCE_MODULE_CLOSED', '5a revoked');
  insert into public.finance_permission_grants (user_id, action) values ('44444444-4444-4444-8444-444444444444', 'finance.create');

  update public.users set is_active = false where id = '44444444-4444-4444-8444-444444444444';
  perform pg_temp.refused_alike(format(call, k), format(call, gen_random_uuid()), 'This account is not active', '5a deactivated');
  update public.users set is_active = true where id = '44444444-4444-4444-8444-444444444444';

  if public.submit_payment_request(p_destination => 'suspense', p_amount => 1111, p_payment_date => current_date,
       p_payment_mode => 'hdfc', p_idempotency_key => k) <> v1 then
    raise exception '5a: access restored, the replay should return the original again';
  end if;
  raise notice 'PASS: 5a Payment Request — authorized replay returns the original; after losing Finance entry, or being deactivated, the replay is refused exactly as an unused key is, and writes nothing';
end $$;

-- 5b. Record Payment (record_payment_with_allocations): Finance entry + finance.allocate.
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
do $$
declare
  k  constant uuid := 'b2000000-0000-4000-8000-000000000001';
  call constant text := $q$select public.record_payment_with_allocations(p_amount => 2222, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_client_name => null, p_idempotency_key => '%s')$q$;
  v1 jsonb;
begin
  v1 := public.record_payment_with_allocations(p_amount => 2222, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_client_name => null, p_idempotency_key => k);
  if public.record_payment_with_allocations(p_amount => 2222, p_payment_date => current_date,
       p_payment_mode => 'hdfc', p_client_name => null, p_idempotency_key => k) <> v1 then
    raise exception '5b: authorized replay';
  end if;
  delete from public.finance_permission_grants where user_id = '22222222-2222-4222-8222-222222222222' and action = 'finance.allocate';
  perform pg_temp.refused_alike(format(call, k), format(call, gen_random_uuid()), 'PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED', '5b revoked');
  insert into public.finance_permission_grants (user_id, action) values ('22222222-2222-4222-8222-222222222222', 'finance.allocate');
  update public.users set is_active = false where id = '22222222-2222-4222-8222-222222222222';
  perform pg_temp.refused_alike(format(call, k), format(call, gen_random_uuid()), 'This account is not active', '5b deactivated');
  update public.users set is_active = true where id = '22222222-2222-4222-8222-222222222222';
  raise notice 'PASS: 5b Record Payment — authorized replay returns the original; without finance.allocate, or deactivated, the replay is refused as an unused key is, and writes nothing';
end $$;

-- 5c. PI payment (record_pi_submission_payment): finance.allocate, or the PI's own people.
do $$
declare
  k_alloc   constant uuid := 'b3000000-0000-4000-8000-000000000001';
  k_creator constant uuid := 'b3000000-0000-4000-8000-000000000002';
  call constant text := $q$select public.record_pi_submission_payment(p_submission_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => %s, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => '%s')$q$;
  v1 jsonb;
begin
  -- An allocator who is NOT one of the PI's people.
  perform pg_temp.act_as('77777777-7777-4777-8777-777777777777');
  v1 := public.record_pi_submission_payment(p_submission_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 3333, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => k_alloc);
  if public.record_pi_submission_payment(p_submission_id => 'd0000000-0000-4000-8000-00000000000d',
       p_amount => 3333, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => k_alloc) <> v1 then
    raise exception '5c: authorized replay';
  end if;
  delete from public.finance_permission_grants where user_id = '77777777-7777-4777-8777-777777777777' and action = 'finance.allocate';
  perform pg_temp.refused_alike(format(call, 3333, k_alloc), format(call, 3333, gen_random_uuid()), 'PI_PAYMENT_NOT_PERMITTED', '5c revoked');
  insert into public.finance_permission_grants (user_id, action) values ('77777777-7777-4777-8777-777777777777', 'finance.allocate');

  -- The PI's creator, deactivated.
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');
  perform public.record_pi_submission_payment(p_submission_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 3434, p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => k_creator);
  update public.users set is_active = false where id = '22222222-2222-4222-8222-222222222222';
  perform pg_temp.refused_alike(format(call, 3434, k_creator), format(call, 3434, gen_random_uuid()), 'This account is not active', '5c deactivated');
  update public.users set is_active = true where id = '22222222-2222-4222-8222-222222222222';
  raise notice 'PASS: 5c PI payment — an allocator who loses finance.allocate, and a PI creator who is deactivated, are refused on replay as on an unused key, and nothing is written';
end $$;

-- 5d. A DEACTIVATED ADMIN. Production's module_entry_open lets any admin in on
-- role alone, so without the replay's own active test this would pass.
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
do $$
declare
  k constant uuid := 'b4000000-0000-4000-8000-000000000001';
  call constant text := $q$select public.submit_payment_request(p_destination => 'suspense', p_amount => 4444,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => '%s')$q$;
begin
  perform public.submit_payment_request(p_destination => 'suspense', p_amount => 4444, p_payment_date => current_date,
    p_payment_mode => 'hdfc', p_idempotency_key => k);
  update public.users set is_active = false where id = '11111111-1111-4111-8111-111111111111';
  if not public.module_entry_open('finance') then
    raise exception '5d: the stand-in should admit an inactive admin, as production does';
  end if;
  perform pg_temp.refused_alike(format(call, k), format(call, gen_random_uuid()), 'This account is not active', '5d');
  update public.users set is_active = true where id = '11111111-1111-4111-8111-111111111111';
  raise notice 'PASS: 5d a deactivated admin — admitted by module entry on role alone — is refused on replay by the active check';
end $$;

-- 5e. Signed out: a known key and an unknown one read the same.
do $$
declare
  call constant text := $q$select public.submit_payment_request(p_destination => 'suspense', p_amount => 1111,
    p_payment_date => current_date, p_payment_mode => 'hdfc', p_idempotency_key => '%s')$q$;
begin
  perform pg_temp.act_as(null);
  perform pg_temp.refused_alike(format(call, 'b1000000-0000-4000-8000-000000000001'), format(call, gen_random_uuid()),
    'Authentication required', '5e');
  raise notice 'PASS: 5e signed out — a replay of a real key is refused exactly as an unknown key, and writes nothing (anon has no EXECUTE at all: 3b)';
end $$;

-- 5f. Keyed PI Draft creation: orders.create, active.
select pg_temp.act_as('44444444-4444-4444-8444-444444444444');
do $$
declare
  k constant uuid := 'b5000000-0000-4000-8000-000000000001';
  v1 jsonb;
begin
  v1 := public.create_order_submission(null, k);
  if public.create_order_submission(null, k) <> v1 then raise exception '5f: authorized replay'; end if;
  delete from public.finance_permission_grants where user_id = '44444444-4444-4444-8444-444444444444' and action = 'orders.create';
  perform pg_temp.refused_alike(format('select public.create_order_submission(null, %L)', k),
    format('select public.create_order_submission(null, %L)', gen_random_uuid()),
    'You do not have permission to create an order submission', '5f revoked');
  insert into public.finance_permission_grants (user_id, action) values ('44444444-4444-4444-8444-444444444444', 'orders.create');
  update public.users set is_active = false where id = '44444444-4444-4444-8444-444444444444';
  perform pg_temp.refused_alike(format('select public.create_order_submission(null, %L)', k),
    format('select public.create_order_submission(null, %L)', gen_random_uuid()),
    'This account is not active', '5f deactivated');
  update public.users set is_active = true where id = '44444444-4444-4444-8444-444444444444';
  raise notice 'PASS: 5f keyed PI Draft creation — replay returns the same draft; without orders.create, or deactivated, it is refused as an unused key is';
end $$;

-- ═══ 6. Send back for clarification, and reject — through the doors ══════════
create or replace function pg_temp.trail(p uuid)
returns bigint language sql as $$
  select count(*) from public.finance_payment_request_activity_log
   -- The deployed trail (20260716000000) records a decision as status_changed.
   where payment_request_id = p and event_type = 'status_changed'
     and payload->>'to_status' in ('needs_clarification', 'rejected')
$$;

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
create temp table pay6 on commit drop as
  select n, (public.submit_payment_request(p_destination => 'suspense', p_amount => 600 + n,
    p_payment_date => current_date, p_payment_mode => 'hdfc')->>'payment_request_id')::uuid as id
  from generate_series(1, 4) n;
grant select on pay6 to authenticated;

-- 6a. A verifier sends back; a second send-back is stale and writes nothing.
select pg_temp.act_as('55555555-5555-4555-8555-555555555555');
do $$
declare p uuid := (select id from pay6 where n = 1); r jsonb;
begin
  r := public.request_finance_payment_clarification(p, 'Which account did this arrive in?');
  if r->>'changed' <> 'true'
     or (select status from public.finance_payment_requests where id = p) <> 'needs_clarification'
     or (select admin_note from public.finance_payment_requests where id = p) <> 'Which account did this arrive in?'
     or pg_temp.trail(p) <> 1
     or (select actor_id from public.finance_payment_request_activity_log where payment_request_id = p
          and event_type = 'status_changed' and payload->>'to_status' = 'needs_clarification') <> '55555555-5555-4555-8555-555555555555' then
    raise exception '6a: the send-back did not land as one decision by this verifier: % | trail=%', r,
      (select string_agg(event_type || '/' || coalesce(actor_id::text, 'null'), ', ') from public.finance_payment_request_activity_log where payment_request_id = p);
  end if;
  r := public.request_finance_payment_clarification(p, 'Again');
  if r->>'changed' <> 'false' or pg_temp.trail(p) <> 1
     or (select admin_note from public.finance_payment_requests where id = p) <> 'Which account did this arrive in?' then
    raise exception '6a: a stale send-back changed something: %', r;
  end if;
  raise notice 'PASS: 6a a verifier sends back a pending payment (status, note and one trail entry naming the verifier); a second, stale send-back answers changed=false and writes nothing';
end $$;

-- 6b. Rejection uses the existing door; a stale rejection is refused.
do $$
declare p uuid := (select id from pay6 where n = 2);
begin
  perform public.reject_finance_payment_request(p, 'Duplicate of PR-0001');
  if (select status from public.finance_payment_requests where id = p) <> 'rejected' or pg_temp.trail(p) <> 1 then
    raise exception '6b: rejection';
  end if;
  perform pg_temp.refused(format('select public.reject_finance_payment_request(%L, %L)', p, 'Again'),
    'Only a pending payment request can be rejected');
  if pg_temp.trail(p) <> 1 then raise exception '6b: stale rejection wrote'; end if;
  perform pg_temp.refused(format('select public.request_finance_payment_clarification(%L, %L)', (select id from pay6 where n = 3), '  '),
    'PAYMENT_CLARIFICATION_NOTE_REQUIRED');
  raise notice 'PASS: 6b rejection through reject_finance_payment_request; a stale one is refused and writes nothing; a blank clarification note is refused';
end $$;

-- 6c. Nobody else decides: no permission, their own payment, a verified one.
do $$
declare p uuid := (select id from pay6 where n = 3); own uuid; ver uuid;
begin
  perform pg_temp.act_as('44444444-4444-4444-8444-444444444444');   -- Finance entry, no finance.approve
  perform pg_temp.refused(format('select public.request_finance_payment_clarification(%L, %L)', p, 'x'), 'Only a payment verifier');
  perform pg_temp.refused(format('select public.reject_finance_payment_request(%L, %L)', p, 'x'), 'Only a payment verifier');

  perform pg_temp.act_as('55555555-5555-4555-8555-555555555555');   -- a verifier who recorded it
  own := (public.submit_payment_request(p_destination => 'suspense', p_amount => 777, p_payment_date => current_date,
    p_payment_mode => 'hdfc')->>'payment_request_id')::uuid;
  perform pg_temp.refused(format('select public.request_finance_payment_clarification(%L, %L)', own, 'x'), 'PAYMENT_SELF_DECISION_FORBIDDEN');
  perform pg_temp.refused(format('select public.reject_finance_payment_request(%L, %L)', own, 'x'), 'PAYMENT_SELF_DECISION_FORBIDDEN');

  update public.users set is_active = false where id = '66666666-6666-4666-8666-666666666666';
  perform pg_temp.act_as('66666666-6666-4666-8666-666666666666');   -- a deactivated verifier
  perform pg_temp.refused(format('select public.request_finance_payment_clarification(%L, %L)', p, 'x'), 'Only a payment verifier');
  update public.users set is_active = true where id = '66666666-6666-4666-8666-666666666666';

  -- A VERIFIED payment is not sent back: verified-payment permanence holds.
  ver := (select id from pay6 where n = 4);
  perform set_config('request.jwt.claims', '', true);
  update public.finance_payment_requests set status = 'approved_unlinked' where id = ver;
  perform pg_temp.act_as('55555555-5555-4555-8555-555555555555');
  if public.request_finance_payment_clarification(ver, 'x')->>'changed' <> 'false'
     or (select status from public.finance_payment_requests where id = ver) <> 'approved_unlinked' then
    raise exception '6c: a verified payment was sent back';
  end if;
  if (select status from public.finance_payment_requests where id = p) <> 'pending_approval' or pg_temp.trail(p) <> 0
     or pg_temp.trail(own) <> 0 then
    raise exception '6c: a refused decision wrote something';
  end if;
  raise notice 'PASS: 6c refused, writing nothing: no finance.approve, a verifier deciding their own payment, a deactivated verifier; a verified payment answers changed=false and stays verified';
end $$;

-- 6d. Straight at the API: a verifier's direct UPDATE is still refused (no table
-- write is widened), anon cannot reach the door, and the door works.
select pg_temp.act_as('66666666-6666-4666-8666-666666666666');
set local role authenticated;
do $$
declare p uuid := (select id from pay6 where n = 3);
begin
  -- (The direct UPDATE's refusal is proved in a FRESH session by the runner:
  -- inside this one transaction PL/pgSQL has already cached the reset guard's
  -- call as the superuser, so its EXECUTE check would not run again.)
  if (public.request_finance_payment_clarification(p, 'Please attach the UTR.'))->>'changed' <> 'true' then
    raise exception '6d: the door refused an authorized verifier';
  end if;
  raise notice 'PASS: 6d as authenticated, request_finance_payment_clarification works for a verifier';
end $$;
reset role;
set local role anon;
do $$
begin
  perform pg_temp.refused($q$select public.request_finance_payment_clarification(gen_random_uuid(), 'x')$q$, '42501');
  perform pg_temp.refused($q$select public.reject_finance_payment_request(gen_random_uuid(), 'x')$q$, '42501');
  raise notice 'PASS: 6e anon cannot execute either decision door';
end $$;
reset role;

rollback;
