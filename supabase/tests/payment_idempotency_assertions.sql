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

rollback;
