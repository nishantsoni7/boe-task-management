-- received_payment_allocation_targets() assertions (20261216000000)
-- ===========================================================================
-- Run by supabase/tests/run_received_payment_allocation_targets_suite.sh
-- against a DISPOSABLE database built from _payment_allocation_ledger_shaped_
-- schema.sql + _received_payment_allocation_targets_extra_schema.sql.
-- One transaction, ends in ROLLBACK. Never point this at a linked project.
--
-- THE SCENARIO. Payment PAY1, ₹7,50,000.55, recorded by S, confirmed:
--   a1  Order 0524                       4,00,000.25  active
--   a2  Order 0529                       2,00,000.20  active
--   a4  Order 0529 (second row, same)       25,000.00  active
--   a3  PI Draft, workbook "Hotel ABC.xlsx" (its B20 says 0101)
--                                        1,00,000.10  active
--   a0  Order 0529                          50,000.00  REVERSED
-- Active total 7,25,000.55; unallocated 25,000.00.
-- PAY2  ₹1,000, confirmed, only Order 0529 — unrelated to P.
-- PAY3  ₹2,000, NOT confirmed (pending_approval), recorded by S, Order 0524.
-- PAY4  ₹5,000, confirmed, PI Draft with reserved Order number 0431.
--
-- P holds finance.view only — NOT view_all — and can open Order 0524 only. P can
-- read PAY1 as a participant, and through RLS sees a1 alone.

\set ON_ERROR_STOP on
begin;

-- ── Fixtures (as the table owner) ───────────────────────────────────────────
insert into public.users (id, full_name, role, is_active) values
  ('00000000-0000-4000-8000-00000000000a', 'Admin A',              'admin',    true),
  ('00000000-0000-4000-8000-00000000000b', 'View-all W',           'employee', true),
  ('00000000-0000-4000-8000-00000000000c', 'Participant P',        'employee', true),
  ('00000000-0000-4000-8000-00000000000e', 'Unrelated Viewer V',   'employee', true),
  ('00000000-0000-4000-8000-00000000000f', 'No-entry Participant', 'employee', true),
  ('00000000-0000-4000-8000-000000000010', 'Inactive Participant', 'employee', false),
  ('00000000-0000-4000-8000-000000000011', 'Submitter S',          'employee', true);

insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('00000000-0000-4000-8000-00000000000b', 'finance', 'view'),
  ('00000000-0000-4000-8000-00000000000b', 'finance', 'view_all'),
  ('00000000-0000-4000-8000-00000000000c', 'finance', 'view'),
  ('00000000-0000-4000-8000-00000000000e', 'finance', 'view'),
  ('00000000-0000-4000-8000-000000000010', 'finance', 'view'),
  ('00000000-0000-4000-8000-000000000011', 'finance', 'view');

insert into public.orders (id, display_number, client_name) values
  ('10000000-0000-4000-8000-000000000524', '0524', 'Hotel Aurum'),
  ('10000000-0000-4000-8000-000000000529', '0529', 'Cafe Verde');
insert into public.order_submissions (id, source_order_number, source_workbook_name, client_name, reserved_order_number) values
  ('20000000-0000-4000-8000-000000000019', '0101', 'C:\fakepath\Hotel ABC.xlsx', 'Hotel ABC', null),
  ('20000000-0000-4000-8000-000000000431', '0099', 'Resort PI.xlsx',             'Resort',    '0431');

-- P, the no-entry participant and the inactive participant can open Order 0524.
insert into public.test_visible_orders (user_id, order_id)
select u, '10000000-0000-4000-8000-000000000524'::uuid from unnest(array[
  '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000f',
  '00000000-0000-4000-8000-000000000010']::uuid[]) u;

insert into public.finance_payment_requests (id, request_number, amount, status, submitted_by, client_name) values
  ('30000000-0000-4000-8000-000000000001', 'PAY1', 750000.55, 'approved_unlinked', '00000000-0000-4000-8000-000000000011', null),
  ('30000000-0000-4000-8000-000000000002', 'PAY2',   1000.00, 'approved_unlinked', '00000000-0000-4000-8000-000000000011', 'Cafe Verde'),
  ('30000000-0000-4000-8000-000000000003', 'PAY3',   2000.00, 'pending_approval',  '00000000-0000-4000-8000-000000000011', null),
  ('30000000-0000-4000-8000-000000000004', 'PAY4',   5000.00, 'approved_linked',   '00000000-0000-4000-8000-000000000011', null);

insert into public.finance_payment_allocations
  (id, payment_request_id, order_id, order_submission_id, allocated_amount, status, created_at, created_by, reversed_by, reversed_at, reversal_reason) values
  ('40000000-0000-4000-8000-0000000000a0', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000529', null,  50000.00, 'reversed', '2026-09-09 05:00+00', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000000b', '2026-09-11 09:30+00', 'Duplicate entry'),
  ('40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000524', null, 400000.25, 'active',   '2026-09-10 05:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000a2', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000529', null, 200000.20, 'active',   '2026-09-10 06:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000a3', '30000000-0000-4000-8000-000000000001', null, '20000000-0000-4000-8000-000000000019', 100000.10, 'active', '2026-09-10 07:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000a4', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000529', null,  25000.00, 'active',   '2026-09-10 08:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000529', null,   1000.00, 'active',   '2026-09-10 08:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000c1', '30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000524', null,   2000.00, 'active',   '2026-09-10 09:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000d1', '30000000-0000-4000-8000-000000000004', null, '20000000-0000-4000-8000-000000000431',   5000.00, 'active', '2026-09-10 10:00+00', '00000000-0000-4000-8000-000000000011', null, null, null);

-- Fingerprint of everything the read must never change.
create temporary table targets_before as
select
  (select md5(string_agg(t::text, '|' order by t.id)) from public.finance_payment_requests t)    as payments,
  (select md5(string_agg(t::text, '|' order by t.id)) from public.finance_payment_allocations t) as allocations,
  (select md5(string_agg(t::text, '|' order by t.id)) from public.orders t)                      as orders,
  (select md5(string_agg(t::text, '|' order by t.id)) from public.order_submissions t)           as submissions,
  (select md5(string_agg(t::text, '|' order by t.user_id, t.module_key, t.action_key)) from public.test_permission_grants t) as grants,
  (select md5(string_agg(p::text, '|' order by p.tablename, p.policyname)) from pg_policies p
    where p.schemaname = 'public' and p.tablename in ('finance_payment_requests', 'finance_payment_allocations')) as policies;
grant select on targets_before to authenticated, anon, service_role;

-- The page every reader below asks about: all four payments.
set local check_function_bodies = off;
create or replace function pg_temp.page_ids() returns uuid[] language sql immutable as $$
  select array[
    '30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004']::uuid[]
$$;
grant execute on function pg_temp.page_ids() to authenticated, anon, service_role;


-- ═══ 0. THE DEFECT, reproduced: a participant's direct RLS read is partial ═══
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
declare v_n bigint; v_sum numeric; v_pay bigint;
begin
  select count(*) into v_pay from public.finance_payment_requests where id = '30000000-0000-4000-8000-000000000001';
  assert v_pay = 1, 'P must be able to read PAY1 (participant visibility)';
  select count(*), coalesce(sum(allocated_amount), 0) into v_n, v_sum
  from public.finance_payment_allocations
  where payment_request_id = '30000000-0000-4000-8000-000000000001' and status = 'active';
  assert v_n = 1 and v_sum = 400000.25,
    format('DEFECT NOT REPRODUCED: expected the partial RLS read (1 row, 400000.25), got %s rows, %s', v_n, v_sum);
  raise notice '0. reproduced: P reads PAY1 but RLS returns 1 of 4 active allocations';
end $$;
reset role;


-- ═══ 1. P (finance.view, no view_all) — COMPLETE active targets of PAY1 ════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
declare v_n bigint; v_sum numeric; v_payments text; v_refs text;
begin
  select count(*), sum(allocated_amount),
         string_agg(distinct payment_request_id::text, ','),
         string_agg(coalesce(target_reference, '∅'), ',' order by allocation_id)
    into v_n, v_sum, v_payments, v_refs
  from public.received_payment_allocation_targets(pg_temp.page_ids());

  assert v_payments = '30000000-0000-4000-8000-000000000001',
    format('P may see PAY1 only (not unrelated PAY2, unconfirmed PAY3 or PAY4), got %s', v_payments);
  assert v_n = 4, format('P must receive all 4 ACTIVE allocations of PAY1, got %s', v_n);
  assert v_sum = 725000.55, format('active total must be 725000.55, got %s', v_sum);
  assert 750000.55 - v_sum = 25000.00, 'unallocated must be 25000.00';
  assert v_refs = '0524,0529,Hotel ABC.xlsx,0529', format('every target named in allocation order, got %s', v_refs);
  raise notice '1. finance.view participant without view_all: complete targets (4 active, 725000.55)';
end $$;
reset role;


-- ═══ 2. Reversed allocations are excluded; duplicates stay separate rows ═══
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
begin
  assert not exists (select 1 from public.received_payment_allocation_targets(pg_temp.page_ids())
                     where allocation_id = '40000000-0000-4000-8000-0000000000a0'),
    'a reversed allocation must never be returned';
  assert (select count(*) from public.received_payment_allocation_targets(pg_temp.page_ids())
          where target_id = '10000000-0000-4000-8000-000000000529') = 2,
    'two active rows to one Order are returned separately (the list combines them)';
  raise notice '2. reversed excluded; duplicate active rows returned separately';
end $$;
reset role;


-- ═══ 3. PI Draft references: never the workbook B20 number ════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare r record;
begin
  select * into r from public.received_payment_allocation_targets(pg_temp.page_ids())
  where allocation_id = '40000000-0000-4000-8000-0000000000a3';
  assert r.target_type = 'pi_draft' and r.target_reference = 'Hotel ABC.xlsx' and r.reserved_order_number is null,
    format('unreserved PI Draft: expected the file name without its path and no reserved number, got %s / %s / %s',
      r.target_type, r.target_reference, r.reserved_order_number);

  select * into r from public.received_payment_allocation_targets(pg_temp.page_ids())
  where allocation_id = '40000000-0000-4000-8000-0000000000d1';
  assert r.target_type = 'pi_draft' and r.reserved_order_number = '0431',
    format('reserved PI Draft must carry 0431, got %s', r.reserved_order_number);

  assert not exists (select 1 from public.received_payment_allocation_targets(pg_temp.page_ids())
                     where target_reference in ('0101', '0099') or reserved_order_number in ('0101', '0099')),
    'source_order_number must never be returned';
  assert (select count(*) from public.received_payment_allocation_targets(pg_temp.page_ids())
          where target_type = 'order' and reserved_order_number is not null) = 0,
    'an Order target carries no reserved number';
  raise notice '3. PI Draft: file name or reserved Order number, never source_order_number';
end $$;
reset role;


-- ═══ 4. Admin and view_all — every confirmed payment, no unconfirmed one ══
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare v_payments text;
begin
  select string_agg(distinct right(payment_request_id::text, 1), ',') into v_payments
  from public.received_payment_allocation_targets(pg_temp.page_ids());
  assert v_payments = '1,2,4', format('admin: PAY1, PAY2, PAY4 (not the unconfirmed PAY3), got %s', v_payments);
  raise notice '4a. admin: all confirmed payments; unconfirmed PAY3 excluded';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
begin
  assert (select count(*) from public.received_payment_allocation_targets(pg_temp.page_ids())) = 6,
    'view_all: 4 + 1 + 1 active allocations';
  raise notice '4b. view_all: all confirmed payments';
end $$;
reset role;


-- ═══ 5. An unrelated finance.view holder — nothing ════════════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000e';
do $$
begin
  assert (select count(*) from public.received_payment_allocation_targets(pg_temp.page_ids())) = 0,
    'a reader who cannot see any of these payments must receive nothing';
  raise notice '5. unrelated payment access: nothing returned';
end $$;
reset role;


-- ═══ 6–8. The refusals ═══════════════════════════════════════════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000f';
do $$ begin
  perform * from public.received_payment_allocation_targets(pg_temp.page_ids());
  assert false, 'a participant without Finance entry must be refused';
exception when insufficient_privilege then raise notice '6. no Finance entry: refused (42501)';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000010';
do $$ begin
  perform * from public.received_payment_allocation_targets(pg_temp.page_ids());
  assert false, 'an inactive user must be refused';
exception when insufficient_privilege then raise notice '7. inactive user: refused (42501)';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '';
do $$ begin
  perform * from public.received_payment_allocation_targets(pg_temp.page_ids());
  assert false, 'no signed-in user must be refused';
exception when sqlstate '28000' then raise notice '8. authenticated role with no user: refused (28000)';
end $$;
reset role;


-- ═══ 9. anon and service_role hold no EXECUTE ═══════════════════════════════
set local role anon;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$ begin
  perform * from public.received_payment_allocation_targets(pg_temp.page_ids());
  assert false, 'anon must not be able to execute the targets read';
exception when insufficient_privilege then raise notice '9a. anon: no EXECUTE (42501)';
end $$;
reset role;

set local role service_role;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$ begin
  perform * from public.received_payment_allocation_targets(pg_temp.page_ids());
  assert false, 'service_role must not be able to execute the targets read';
exception when insufficient_privilege then raise notice '9b. service_role: no EXECUTE (42501)';
end $$;
reset role;


-- ═══ 10. Bounded input ═════════════════════════════════════════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
begin
  assert (select count(*) from public.received_payment_allocation_targets(array[]::uuid[])) = 0, 'empty page';
  assert (select count(*) from public.received_payment_allocation_targets(null)) = 0, 'null page';
  assert (select count(*) from public.received_payment_allocation_targets(
            array(select gen_random_uuid() from generate_series(1, 50)))) = 0, '50 unknown ids: nothing, no error';
  begin
    perform * from public.received_payment_allocation_targets(array(select gen_random_uuid() from generate_series(1, 51)));
    assert false, '51 ids must be refused';
  exception when sqlstate '22023' then null;
  end;
  raise notice '10. at most 50 ids (51 refused, 22023); empty, null and unknown ids return nothing';
end $$;
reset role;


-- ═══ 11. The read changed nothing ══════════════════════════════════════════
do $$
declare b record;
begin
  select * into b from targets_before;
  assert b.payments    = (select md5(string_agg(t::text, '|' order by t.id)) from public.finance_payment_requests t), 'a payment row changed';
  assert b.allocations = (select md5(string_agg(t::text, '|' order by t.id)) from public.finance_payment_allocations t), 'an allocation row changed';
  assert b.orders      = (select md5(string_agg(t::text, '|' order by t.id)) from public.orders t), 'an order row changed';
  assert b.submissions = (select md5(string_agg(t::text, '|' order by t.id)) from public.order_submissions t), 'a PI row changed';
  assert b.grants      = (select md5(string_agg(t::text, '|' order by t.user_id, t.module_key, t.action_key)) from public.test_permission_grants t), 'a permission changed';
  assert b.policies    = (select md5(string_agg(p::text, '|' order by p.tablename, p.policyname)) from pg_policies p
                           where p.schemaname = 'public' and p.tablename in ('finance_payment_requests', 'finance_payment_allocations')), 'an RLS policy changed';
  assert (select provolatile from pg_proc where oid = 'public.received_payment_allocation_targets(uuid[])'::regprocedure) = 's',
    'the read must be STABLE so it cannot write';
  raise notice '11. no payment, allocation, Order, PI, permission or policy changed; the function is STABLE';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
