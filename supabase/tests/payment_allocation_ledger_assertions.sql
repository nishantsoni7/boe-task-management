-- payment_allocation_ledger_for_correction() assertions (20261215000000)
-- ===========================================================================
-- Run by supabase/tests/run_payment_allocation_ledger_suite.sh against a
-- DISPOSABLE database built from _payment_allocation_ledger_shaped_schema.sql.
-- One transaction, ends in ROLLBACK. Never point this at a linked project.
--
-- THE SCENARIO. Payment PAY1, ₹7,50,000.55, recorded by S, divided across:
--   a1  Order 0524 (Hotel Aurum)  4,00,000.25  active
--   a2  Order 0529 (Cafe Verde)   2,00,000.20  active
--   a3  PI Draft 019 (Hotel Aurum) 1,00,000.10 active
--   a0  Order 0529 (Cafe Verde)     50,000.00  REVERSED by V, "Duplicate entry"
-- Active total 7,00,000.55; unallocated 50,000.00.
-- PAY2, ₹1,000, allocated only to Order 0529 — unrelated to P.
--
-- P holds finance.view + finance.allocate_correct, NOT view_all, and can open
-- Order 0524 only. P can read PAY1 as a participant — and, through RLS, only a1.

\set ON_ERROR_STOP on
begin;

-- ── Fixtures (as the table owner) ───────────────────────────────────────────
insert into public.users (id, full_name, role, is_active) values
  ('00000000-0000-4000-8000-00000000000a', 'Admin A',            'admin',    true),
  ('00000000-0000-4000-8000-00000000000b', 'View-all Corrector', 'employee', true),
  ('00000000-0000-4000-8000-00000000000c', 'Participant Corrector', 'employee', true),
  ('00000000-0000-4000-8000-00000000000d', 'Allocator Only',     'employee', true),
  ('00000000-0000-4000-8000-00000000000e', 'Viewer Only',        'employee', true),
  ('00000000-0000-4000-8000-00000000000f', 'No-entry Corrector', 'employee', true),
  ('00000000-0000-4000-8000-000000000010', 'Inactive Corrector', 'employee', false),
  ('00000000-0000-4000-8000-000000000011', 'Submitter S',        'employee', true);

insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('00000000-0000-4000-8000-00000000000b', 'finance', 'view'),
  ('00000000-0000-4000-8000-00000000000b', 'finance', 'view_all'),
  ('00000000-0000-4000-8000-00000000000b', 'finance', 'allocate_correct'),
  ('00000000-0000-4000-8000-00000000000c', 'finance', 'view'),
  ('00000000-0000-4000-8000-00000000000c', 'finance', 'allocate_correct'),
  ('00000000-0000-4000-8000-00000000000d', 'finance', 'view'),
  ('00000000-0000-4000-8000-00000000000d', 'finance', 'allocate'),
  ('00000000-0000-4000-8000-00000000000e', 'finance', 'view'),
  ('00000000-0000-4000-8000-00000000000f', 'finance', 'allocate_correct'),
  ('00000000-0000-4000-8000-000000000010', 'finance', 'view'),
  ('00000000-0000-4000-8000-000000000010', 'finance', 'allocate_correct'),
  ('00000000-0000-4000-8000-000000000011', 'finance', 'view');

insert into public.orders (id, display_number, client_name) values
  ('10000000-0000-4000-8000-000000000524', '0524', 'Hotel Aurum'),
  ('10000000-0000-4000-8000-000000000529', '0529', 'Cafe Verde');
insert into public.order_submissions (id, source_order_number, source_workbook_name, client_name) values
  ('20000000-0000-4000-8000-000000000019', '019', 'aurum-pi.xlsx', 'Hotel Aurum');

-- Everyone except the viewers of nothing may open Order 0524; nobody but the
-- admin path sees 0529 or PI 019.
insert into public.test_visible_orders (user_id, order_id)
select u, '10000000-0000-4000-8000-000000000524'::uuid from unnest(array[
  '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000d',
  '00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-00000000000f',
  '00000000-0000-4000-8000-000000000010']::uuid[]) u;

insert into public.finance_payment_requests (id, request_number, amount, status, submitted_by, client_name) values
  ('30000000-0000-4000-8000-000000000001', 'PAY1', 750000.55, 'approved_unlinked', '00000000-0000-4000-8000-000000000011', null),
  ('30000000-0000-4000-8000-000000000002', 'PAY2',   1000.00, 'approved_unlinked', '00000000-0000-4000-8000-000000000011', 'Cafe Verde');

insert into public.finance_payment_allocations
  (id, payment_request_id, order_id, order_submission_id, allocated_amount, status, created_at, created_by, reversed_by, reversed_at, reversal_reason) values
  ('40000000-0000-4000-8000-0000000000a0', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000529', null,  50000.00, 'reversed', '2026-09-09 05:00+00', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000000b', '2026-09-11 09:30+00', 'Duplicate entry'),
  ('40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000524', null, 400000.25, 'active',   '2026-09-10 05:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000a2', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000529', null, 200000.20, 'active',   '2026-09-10 06:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000a3', '30000000-0000-4000-8000-000000000001', null, '20000000-0000-4000-8000-000000000019', 100000.10, 'active', '2026-09-10 07:00+00', '00000000-0000-4000-8000-000000000011', null, null, null),
  ('40000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000529', null,   1000.00, 'active',   '2026-09-10 08:00+00', '00000000-0000-4000-8000-000000000011', null, null, null);

-- Fingerprint of everything the read must never change.
create temporary table ledger_before as
select
  (select md5(string_agg(t::text, '|' order by t.id)) from public.finance_payment_requests t)    as payments,
  (select md5(string_agg(t::text, '|' order by t.id)) from public.finance_payment_allocations t) as allocations,
  (select md5(string_agg(t::text, '|' order by t.user_id, t.module_key, t.action_key)) from public.test_permission_grants t) as grants,
  (select md5(string_agg(p::text, '|' order by p.tablename, p.policyname)) from pg_policies p
    where p.schemaname = 'public' and p.tablename in ('finance_payment_requests', 'finance_payment_allocations')) as policies;
grant select on ledger_before to authenticated, anon, service_role;

-- A helper the checks below share: call the RPC and summarise it. Body checks
-- are deferred so that, run BEFORE the migration, step 0 still executes.
set local check_function_bodies = off;
create or replace function pg_temp.ledger_summary(p uuid)
returns table (n bigint, active_sum numeric, reversed_n bigint, refs text, clients text)
language sql as $$
  select count(*),
         coalesce(sum(allocated_amount) filter (where status = 'active'), 0),
         count(*) filter (where status = 'reversed'),
         string_agg(distinct target_reference, ',' order by target_reference),
         string_agg(distinct client_name, ',' order by client_name)
  from public.payment_allocation_ledger_for_correction(p)
$$;
grant execute on function pg_temp.ledger_summary(uuid) to authenticated, anon, service_role;


-- ═══ 0. THE DEFECT, reproduced: a participant's direct RLS read is partial ═══
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
declare v_n bigint; v_sum numeric; v_pay bigint;
begin
  select count(*) into v_pay from public.finance_payment_requests where id = '30000000-0000-4000-8000-000000000001';
  assert v_pay = 1, 'P must be able to read PAY1 (participant visibility)';

  select count(*), coalesce(sum(allocated_amount) filter (where status = 'active'), 0) into v_n, v_sum
  from public.finance_payment_allocations where payment_request_id = '30000000-0000-4000-8000-000000000001';
  assert v_n = 1 and v_sum = 400000.25,
    format('DEFECT NOT REPRODUCED: expected the partial RLS read (1 row, 400000.25), got %s rows, %s', v_n, v_sum);
  raise notice '0. reproduced: P reads PAY1 but RLS returns 1 of 4 allocations (active 400000.25 of 700000.55)';
end $$;
reset role;


-- ═══ 1. Admin — the full ledger ════════════════════════════════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare s record;
begin
  select * into s from pg_temp.ledger_summary('30000000-0000-4000-8000-000000000001');
  assert s.n = 4 and s.active_sum = 700000.55 and s.reversed_n = 1,
    format('admin: expected 4 rows / 700000.55 / 1 reversed, got %s / %s / %s', s.n, s.active_sum, s.reversed_n);
  raise notice '1. admin: full ledger';
end $$;
reset role;


-- ═══ 2. view_all + allocate_correct — the full ledger ══════════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare s record;
begin
  select * into s from pg_temp.ledger_summary('30000000-0000-4000-8000-000000000001');
  assert s.n = 4 and s.active_sum = 700000.55 and s.reversed_n = 1, 'view_all corrector must receive the full ledger';
  raise notice '2. view_all + allocate_correct: full ledger';
end $$;
reset role;


-- ═══ 3. The participant corrector — COMPLETE ledger for the payment they can read ═
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
declare s record; r record; v_unallocated numeric;
begin
  select * into s from pg_temp.ledger_summary('30000000-0000-4000-8000-000000000001');
  assert s.n = 4, format('participant corrector: expected all 4 allocations, got %s', s.n);
  assert s.active_sum = 700000.55, format('full active total must be 700000.55, got %s', s.active_sum);
  select 750000.55 - s.active_sum into v_unallocated;
  assert v_unallocated = 50000.00, format('full unallocated must be 50000.00, got %s', v_unallocated);
  assert s.refs = '019,0524,0529', format('every target must be named, got %s', s.refs);
  assert s.clients = 'Cafe Verde,Hotel Aurum', format('every customer must be present (existing-customer detection), got %s', s.clients);

  -- Reversed history is complete, with actor, time and reason.
  select * into r from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001')
  where status = 'reversed';
  assert r.allocation_id = '40000000-0000-4000-8000-0000000000a0'
     and r.reversal_reason = 'Duplicate entry'
     and r.reversed_by_name = 'View-all Corrector'
     and r.reversed_at = '2026-09-11 09:30+00'
     and r.target_reference = '0529',
    'the reversed allocation must carry its target, reason, reverser and time';

  -- Only the requested payment's rows.
  assert not exists (
    select 1 from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001')
    where allocation_id = '40000000-0000-4000-8000-0000000000b1'),
    'another payment''s allocation must never be returned';
  raise notice '3. participant + allocate_correct: complete ledger (4 rows, 700000.55 active, 50000.00 unallocated, 2 customers)';
end $$;
reset role;


-- ═══ 4. …but not the ledger of a payment they cannot read ═════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
begin
  perform * from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000002');
  assert false, 'an unrelated payment must be refused';
exception when sqlstate 'P0002' then
  assert sqlerrm like 'ALLOCATION_LEDGER_PAYMENT_NOT_FOUND%', sqlerrm;
  raise notice '4. unrelated payment: refused (P0002)';
end $$;
reset role;


-- ═══ 5–8. The refusals ═══════════════════════════════════════════════════════
-- finance.allocate without allocate_correct.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000d';
do $$ begin
  perform * from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001');
  assert false, 'finance.allocate alone must be refused';
exception when insufficient_privilege then raise notice '5. finance.allocate only: refused (42501)';
end $$;
reset role;

-- Finance view without allocate_correct.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000e';
do $$ begin
  perform * from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001');
  assert false, 'finance.view alone must be refused';
exception when insufficient_privilege then raise notice '6. finance.view only: refused (42501)';
end $$;
reset role;

-- allocate_correct without Finance module entry.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000f';
do $$ begin
  perform * from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001');
  assert false, 'allocate_correct without Finance entry must be refused';
exception when insufficient_privilege then raise notice '7. allocate_correct without Finance entry: refused (42501)';
end $$;
reset role;

-- An inactive user holding every grant.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000010';
do $$ begin
  perform * from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001');
  assert false, 'an inactive user must be refused';
exception when insufficient_privilege then raise notice '8. inactive user: refused (42501)';
end $$;
reset role;


-- ═══ 9–11. Unauthenticated, anon, service_role, and a missing payment ══════
set local role authenticated;
set local request.jwt.claim.sub = '';
do $$ begin
  perform * from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001');
  assert false, 'no signed-in user must be refused';
exception when sqlstate '28000' then raise notice '9. authenticated role with no user: refused (28000)';
end $$;
reset role;

set local role anon;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$ begin
  perform * from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001');
  assert false, 'anon must not be able to execute the ledger read';
exception when insufficient_privilege then raise notice '10a. anon: no EXECUTE (42501)';
end $$;
reset role;

set local role service_role;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$ begin
  perform * from public.payment_allocation_ledger_for_correction('30000000-0000-4000-8000-000000000001');
  assert false, 'service_role must not be able to execute the ledger read';
exception when insufficient_privilege then raise notice '10b. service_role: no EXECUTE (42501)';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$ begin
  perform * from public.payment_allocation_ledger_for_correction('3fffffff-0000-4000-8000-000000000000');
  assert false, 'a missing payment must be refused';
exception when sqlstate 'P0002' then raise notice '11. missing payment: refused with the same P0002 as an invisible one';
end $$;
reset role;


-- ═══ 12. The read changed nothing ══════════════════════════════════════════
do $$
declare b record;
begin
  select * into b from ledger_before;
  assert b.payments    = (select md5(string_agg(t::text, '|' order by t.id)) from public.finance_payment_requests t), 'a payment row changed';
  assert b.allocations = (select md5(string_agg(t::text, '|' order by t.id)) from public.finance_payment_allocations t), 'an allocation row changed';
  assert b.grants      = (select md5(string_agg(t::text, '|' order by t.user_id, t.module_key, t.action_key)) from public.test_permission_grants t), 'a permission changed';
  assert b.policies    = (select md5(string_agg(p::text, '|' order by p.tablename, p.policyname)) from pg_policies p
                           where p.schemaname = 'public' and p.tablename in ('finance_payment_requests', 'finance_payment_allocations')), 'an RLS policy changed';
  assert (select provolatile from pg_proc where oid = 'public.payment_allocation_ledger_for_correction(uuid)'::regprocedure) = 's',
    'the read must be STABLE so it cannot write';
  raise notice '12. no payment, allocation, permission or policy changed; the function is STABLE';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
