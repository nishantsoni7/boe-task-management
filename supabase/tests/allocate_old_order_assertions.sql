-- Assertions for 20270407000000 (allocate a payment to an OLD order that is not
-- in the system). Run by run_allocate_old_order_suite.sh after the migration.
-- Every failure raises; the last line prints ALL ASSERTIONS PASSED.

create function pg_temp.fails_with(p_sql text, p_code text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_code in sqlerrm) = 0 and position(p_code in coalesce(sqlstate, '')) = 0 then
      raise exception 'expected % but got: % (%)', p_code, sqlerrm, sqlstate;
    end if;
    return;
  end;
  raise exception 'expected % but the statement succeeded: %', p_code, p_sql;
end $$;

insert into public.users (id, full_name, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'Allocator', 'employee'),
  ('00000000-0000-0000-0000-0000000000a2', 'Corrector', 'employee');

insert into public.orders (id, display_number, client_name) values
  ('00000000-0000-0000-0000-0000000000b1', '100001', 'Acme'),
  ('00000000-0000-0000-0000-0000000000b2', '100002', 'Acme');
insert into public.order_submissions (id, client_name, draft_reference) values
  ('00000000-0000-0000-0000-0000000000c1', 'Zenith', 'PID-1');

insert into public.finance_payment_requests (id, request_number, status, amount, submitted_by) values
  ('00000000-0000-0000-0000-0000000000d1', 'PAY-1', 'approved_unlinked', 1000000, '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000d2', 'PAY-2', 'approved_unlinked', 500000, '00000000-0000-0000-0000-0000000000a1');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
set test.perms = 'allocate,view';

-- ── 1. A legacy allocation is written, normalised and logged ────────────────
select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"  ab-12  ","legacy_client_name":" Old Client ","allocated_amount":300000}]'::jsonb);

do $$
declare a public.finance_payment_allocations%rowtype; v_log jsonb;
begin
  select * into a from public.finance_payment_allocations
   where payment_request_id = '00000000-0000-0000-0000-0000000000d1';
  if a.legacy_order_no is distinct from 'AB-12' then raise exception 'order number not normalised: %', a.legacy_order_no; end if;
  if a.legacy_client_name is distinct from 'Old Client' then raise exception 'client not trimmed: %', a.legacy_client_name; end if;
  if a.origin_target_type <> 'legacy_order' or a.status <> 'active'
     or a.order_id is not null or a.order_submission_id is not null then
    raise exception 'wrong legacy row: %', row_to_json(a);
  end if;
  select payload into v_log from public.finance_payment_request_activity_log
   where payment_request_id = a.payment_request_id and event_type = 'allocation_created';
  if v_log->>'target_type' <> 'legacy_order' or v_log->>'legacy_order_no' <> 'AB-12'
     or v_log->>'legacy_client_name' <> 'Old Client' then
    raise exception 'activity payload does not name the legacy order: %', v_log;
  end if;
  raise notice 'ok 1: legacy allocation written, normalised and logged';
end $$;

-- ── 2. The refusals ─────────────────────────────────────────────────────────
select pg_temp.fails_with($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":" ab-12 ","legacy_client_name":"Old Client","allocated_amount":1000}]'::jsonb)$q$,
  'ALLOCATION_DUPLICATE');
select pg_temp.fails_with($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"XY-1","legacy_client_name":"  ","allocated_amount":1000}]'::jsonb)$q$,
  'ALLOCATION_LEGACY_CLIENT_REQUIRED');
select pg_temp.fails_with($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"XY-1","legacy_client_name":"C","allocated_amount":700000.01}]'::jsonb)$q$,
  'ALLOCATION_EXCEEDS_PAYMENT');
select pg_temp.fails_with($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"XY-1","legacy_client_name":"C","allocated_amount":0}]'::jsonb)$q$,
  'ALLOCATION_AMOUNT_INVALID');
select pg_temp.fails_with($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"XY-1","legacy_client_name":"C","allocated_amount":10.001}]'::jsonb)$q$,
  'ALLOCATION_AMOUNT_INVALID');
select pg_temp.fails_with($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"XY-1","legacy_client_name":"C","order_id":"00000000-0000-0000-0000-0000000000b1","allocated_amount":10}]'::jsonb)$q$,
  'ALLOCATION_TARGET_REQUIRED');
select pg_temp.fails_with(format($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"%s","legacy_client_name":"C","allocated_amount":10}]'::jsonb)$q$, repeat('9', 61)),
  'ALLOCATION_LEGACY_ORDER_TOO_LONG');

set test.perms = 'view';
select pg_temp.fails_with($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"XY-1","legacy_client_name":"C","allocated_amount":10}]'::jsonb)$q$,
  'permission to allocate');
set test.perms = 'allocate,view';

-- ── 3. A legacy row and an Order row in one call; a refusal rolls both back ─
select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"order_id":"00000000-0000-0000-0000-0000000000b1","allocated_amount":100000},
    {"legacy_order_no":"OLD-2","legacy_client_name":"Other Client","allocated_amount":50000}]'::jsonb);

do $$
declare n integer;
begin
  select count(*) into n from public.finance_payment_allocations
   where payment_request_id = '00000000-0000-0000-0000-0000000000d1' and status = 'active';
  if n <> 3 then raise exception 'expected 3 active allocations, found %', n; end if;
end $$;

select pg_temp.fails_with($q$select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"OLD-3","legacy_client_name":"C","allocated_amount":100000},
    {"legacy_order_no":"OLD-4","legacy_client_name":"C","allocated_amount":999999}]'::jsonb)$q$,
  'ALLOCATION_EXCEEDS_PAYMENT');

do $$
declare n integer;
begin
  select count(*) into n from public.finance_payment_allocations
   where payment_request_id = '00000000-0000-0000-0000-0000000000d1' and legacy_order_no in ('OLD-3', 'OLD-4');
  if n <> 0 then raise exception 'a refused submission left % legacy row(s) behind', n; end if;
  raise notice 'ok 3: refusals and atomicity';
end $$;

-- ── 4. The table's own rules hold for any writer ────────────────────────────
select pg_temp.fails_with($q$insert into public.finance_payment_allocations
  (payment_request_id, legacy_order_no, legacy_client_name, order_id, allocated_amount, origin_target_type, created_by)
  values ('00000000-0000-0000-0000-0000000000d2', 'Q-1', 'C', '00000000-0000-0000-0000-0000000000b1', 10, 'legacy_order',
          '00000000-0000-0000-0000-0000000000a1')$q$, 'violates check constraint');
select pg_temp.fails_with($q$insert into public.finance_payment_allocations
  (payment_request_id, legacy_order_no, allocated_amount, origin_target_type, created_by)
  values ('00000000-0000-0000-0000-0000000000d2', 'Q-1', 10, 'legacy_order',
          '00000000-0000-0000-0000-0000000000a1')$q$, 'violates check constraint');
select pg_temp.fails_with($q$insert into public.finance_payment_allocations
  (payment_request_id, legacy_order_no, legacy_client_name, allocated_amount, origin_target_type, created_by)
  values ('00000000-0000-0000-0000-0000000000d2', 'q-1', 'C', 10, 'legacy_order',
          '00000000-0000-0000-0000-0000000000a1')$q$, 'violates check constraint');
select pg_temp.fails_with($q$insert into public.finance_payment_allocations
  (payment_request_id, legacy_order_no, legacy_client_name, allocated_amount, origin_target_type, created_by)
  values ('00000000-0000-0000-0000-0000000000d2', 'Q-1', 'C', 10, 'confirmed_order',
          '00000000-0000-0000-0000-0000000000a1')$q$, 'violates check constraint');
select pg_temp.fails_with($q$insert into public.finance_payment_allocations
  (payment_request_id, allocated_amount, origin_target_type, created_by)
  values ('00000000-0000-0000-0000-0000000000d2', 10, 'legacy_order',
          '00000000-0000-0000-0000-0000000000a1')$q$, 'violates check constraint');
select pg_temp.fails_with($q$update public.finance_payment_allocations
  set legacy_order_no = 'ZZ-9' where legacy_order_no = 'AB-12'$q$, 'ALLOCATION_IMMUTABLE');
select pg_temp.fails_with($q$update public.finance_payment_allocations
  set legacy_client_name = 'Someone Else' where legacy_order_no = 'AB-12'$q$, 'ALLOCATION_IMMUTABLE');
select pg_temp.fails_with($q$update public.finance_payment_allocations
  set allocated_amount = 1 where legacy_order_no = 'AB-12'$q$, 'ALLOCATION_IMMUTABLE');

do $$ begin raise notice 'ok 4: constraints and immutability'; end $$;

-- ── 5. Reversal keeps the row and frees the old order for a corrected claim ─
set test.perms = 'allocate_correct,view';
select public.reverse_payment_allocation(
  (select id from public.finance_payment_allocations where legacy_order_no = 'AB-12' and status = 'active'),
  'Wrong client');
set test.perms = 'allocate,view';

do $$
declare r public.finance_payment_allocations%rowtype; v_log jsonb;
begin
  select * into r from public.finance_payment_allocations where legacy_order_no = 'AB-12';
  if r.status <> 'reversed' or r.reversal_reason <> 'Wrong client' or r.reversed_by is null then
    raise exception 'reversal not recorded: %', row_to_json(r);
  end if;
  select payload into v_log from public.finance_payment_request_activity_log
   where event_type = 'allocation_reversed' and payload->>'allocation_id' = r.id::text;
  if v_log->>'legacy_order_no' <> 'AB-12' then raise exception 'reversal log lacks the legacy order: %', v_log; end if;
end $$;

select public.allocate_payment_to_targets('00000000-0000-0000-0000-0000000000d1',
  '[{"legacy_order_no":"AB-12","legacy_client_name":"Right Client","allocated_amount":300000}]'::jsonb);

do $$
declare n integer; t numeric;
begin
  select count(*) into n from public.finance_payment_allocations where legacy_order_no = 'AB-12';
  if n <> 2 then raise exception 'expected the reversed row to be kept beside the new one, found %', n; end if;
  -- the payment's allocated total counts legacy rows (300000 + 100000 + 50000), and an Order's does not
  select sum(allocated_amount) into t from public.finance_payment_allocations
   where payment_request_id = '00000000-0000-0000-0000-0000000000d1' and status = 'active';
  if t <> 450000 then raise exception 'allocated total should include legacy rows, got %', t; end if;
  select coalesce(sum(allocated_amount), 0) into t from public.finance_payment_allocations
   where order_id = '00000000-0000-0000-0000-0000000000b1' and status = 'active';
  if t <> 100000 then raise exception 'an Order total must not include legacy rows, got %', t; end if;
  raise notice 'ok 5: reversal, re-allocation, totals';
end $$;

-- ── 6. Allocated Against and Correct Allocation name the legacy order ───────
do $$
declare r record; n integer := 0;
begin
  for r in select * from public.received_payment_allocation_targets(array['00000000-0000-0000-0000-0000000000d1'::uuid]) loop
    n := n + 1;
    if r.target_type = 'legacy_order' then
      if r.target_id is not null or r.target_reference not in ('AB-12', 'OLD-2')
         or r.target_client_name not in ('Right Client', 'Other Client') then
        raise exception 'legacy target read wrongly: %', row_to_json(r);
      end if;
    elsif r.target_type <> 'order' or r.target_client_name is not null then
      raise exception 'order target read wrongly: %', row_to_json(r);
    end if;
  end loop;
  if n <> 3 then raise exception 'expected 3 active targets, got %', n; end if;
end $$;

set test.perms = 'allocate_correct,view';
do $$
declare r record; n integer := 0;
begin
  for r in select * from public.payment_allocation_ledger_for_correction('00000000-0000-0000-0000-0000000000d1') loop
    n := n + 1;
    if r.target_reference = 'AB-12' and r.client_name not in ('Old Client', 'Right Client') then
      raise exception 'ledger client wrong: %', row_to_json(r);
    end if;
  end loop;
  if n <> 4 then raise exception 'ledger should list 4 rows (one reversed), got %', n; end if;
  raise notice 'ok 6: readers';
end $$;
set test.perms = 'allocate,view';

select 'ALL ASSERTIONS PASSED';
