-- A verified payment is permanent, test data excepted (20261218000000)
-- ===========================================================================
-- Run by supabase/tests/run_verified_payment_permanent_suite.sh against a
-- DISPOSABLE database. One transaction, ends in ROLLBACK.
--
-- Payments:  REAL  verified (approved_linked)      — must be permanent
--            TEST  verified (approved_unlinked)    — test data, removable
--            PEND  pending_approval, real          — still admin-deletable
--            REJ   rejected, real                  — still admin-deletable

\set ON_ERROR_STOP on
begin;

insert into public.users (id, role, is_active) values
  ('00000000-0000-4000-8000-00000000000a', 'admin',    true),
  ('00000000-0000-4000-8000-00000000000b', 'admin',    false),
  ('00000000-0000-4000-8000-00000000000c', 'manager',  true);

insert into public.finance_payment_requests (id, request_number, status, is_test_data) values
  ('10000000-0000-4000-8000-000000000001', 'REAL', 'approved_linked',   false),
  ('10000000-0000-4000-8000-000000000002', 'TEST', 'approved_unlinked', true),
  ('10000000-0000-4000-8000-000000000003', 'PEND', 'pending_approval',  false),
  ('10000000-0000-4000-8000-000000000004', 'REJ',  'rejected',          false);


-- ═══ 1. Who may open a deletion claim ══════════════════════════════════════
do $$
declare A uuid := '00000000-0000-4000-8000-00000000000a';
begin
  assert not public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000001', A),
    'an admin must NOT be able to delete a real verified payment';
  assert public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000002', A),
    'an admin may still delete a verified TEST payment';
  assert public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000003', A),
    'an admin may still delete an unverified payment';
  assert public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000004', A),
    'an admin may still delete a rejected payment';
  assert not public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000000b'),
    'an inactive admin may delete nothing';
  assert not public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000000c'),
    'a non-admin may delete nothing';
  raise notice '1. deletable_by: real verified NO; verified test YES; pending/rejected YES (admin); inactive admin and non-admin NO';
end $$;


-- ═══ 2. The trigger: finalizing a claim on a REAL verified payment fails ══
do $$
begin
  perform set_config('boe.payment_deletion_finalize', '10000000-0000-4000-8000-000000000001', true);
  delete from public.finance_payment_requests where id = '10000000-0000-4000-8000-000000000001';
  assert false, 'a real verified payment must not be deletable even while a claim finalizes';
exception when insufficient_privilege then
  assert sqlerrm like 'PAYMENT_APPROVED_PERMANENT%', sqlerrm;
  raise notice '2. finalizing a claim on a real verified payment: refused (PAYMENT_APPROVED_PERMANENT)';
end $$;
select set_config('boe.payment_deletion_finalize', '', true);


-- ═══ 3. A direct DELETE of a real verified payment fails ══════════════════
do $$
begin
  delete from public.finance_payment_requests where id = '10000000-0000-4000-8000-000000000001';
  assert false, 'a direct delete must be refused';
exception when insufficient_privilege then
  raise notice '3. a direct DELETE (any caller, incl. service role) of a real verified payment: refused';
end $$;


-- ═══ 4. …but a verified TEST payment can still be finalized away ═════════
do $$
begin
  perform set_config('boe.payment_deletion_finalize', '10000000-0000-4000-8000-000000000002', true);
  delete from public.finance_payment_requests where id = '10000000-0000-4000-8000-000000000002';
  assert not exists (select 1 from public.finance_payment_requests where id = '10000000-0000-4000-8000-000000000002');
  perform set_config('boe.payment_deletion_finalize', '', true);
  raise notice '4. a verified TEST payment is still removable through the claim protocol';
end $$;


-- ═══ 5. The Test Data Cleanup path is unchanged ═══════════════════════════
do $$
begin
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  delete from public.finance_payment_requests where id = '10000000-0000-4000-8000-000000000001';
  assert not exists (select 1 from public.finance_payment_requests where id = '10000000-0000-4000-8000-000000000001');
  perform set_config('boe.cleanup_context', '', true);
  raise notice '5. the Test Data Cleanup context is unchanged (it is inert once cleanup is permanently disabled)';
end $$;


-- ═══ 6. Unverified payments are deletable as before ═══════════════════════
do $$
begin
  delete from public.finance_payment_requests where id in ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004');
  assert (select count(*) from public.finance_payment_requests where id in ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004')) = 0;
  raise notice '6. pending and rejected payments: deletable as before';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
