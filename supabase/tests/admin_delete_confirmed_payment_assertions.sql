-- An admin may delete a Confirmed Payment entered by mistake (20270331000000)
-- ===========================================================================
-- Run by supabase/tests/run_admin_delete_confirmed_payment_suite.sh against a
-- DISPOSABLE database. One transaction, ends in ROLLBACK. The functions are
-- called the way the route calls them: begin -> (sweep) -> finalize, as a user.
--
-- Payments:  V1  verified, real, one allocation + one proof object
--            V2  verified, real, actively linked to a bank line
--            V3  verified, real, link already undone (a history note)
--            V4  verified, real, nothing attached
--            V5  verified, real, for the direct-DELETE probe
--            P1  pending_approval

\set ON_ERROR_STOP on
begin;

insert into public.users (id, email, role, is_active) values
  ('00000000-0000-4000-8000-00000000000a', 'admin@example.invalid',    'admin',   true),
  ('00000000-0000-4000-8000-00000000000b', 'inactive@example.invalid', 'admin',   false),
  ('00000000-0000-4000-8000-00000000000c', 'manager@example.invalid',  'manager', true);

insert into public.finance_payment_requests (id, request_number, human_payment_id, status, client_name) values
  ('10000000-0000-4000-8000-000000000001', 'R1', 'P-ZZ-0001', 'approved_linked',   'Hotel One'),
  ('10000000-0000-4000-8000-000000000002', 'R2', 'P-ZZ-0002', 'approved_unlinked', 'Hotel Two'),
  ('10000000-0000-4000-8000-000000000003', 'R3', 'P-ZZ-0003', 'approved_linked',   'Hotel Three'),
  ('10000000-0000-4000-8000-000000000004', 'R4', 'P-ZZ-0004', 'approved_unlinked', null),
  ('10000000-0000-4000-8000-000000000005', 'R5', 'P-ZZ-0005', 'approved_linked',   'Hotel Five'),
  ('10000000-0000-4000-8000-000000000006', 'R6', 'P-ZZ-0006', 'pending_approval',  'Hotel Six');

insert into public.finance_payment_allocations (payment_request_id, order_id, allocated_amount) values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 100);
insert into public.payment_proof_attachments (payment_request_id, storage_path) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001/proof.jpg');

insert into public.bank_line_payment_links (line_id, payment_id, amount, linked_by) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 100,
   '00000000-0000-4000-8000-00000000000a');
insert into public.bank_line_payment_links (line_id, payment_id, amount, linked_by, unlinked_by, unlinked_at) values
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 100,
   '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', now());


-- ═══ 1. Who may open a deletion claim ══════════════════════════════════════
do $$
declare A uuid := '00000000-0000-4000-8000-00000000000a';
begin
  assert public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000001', A),
    'an admin MUST be able to open a claim on a real verified payment';
  assert public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000006', A),
    'an admin may delete an unverified payment, as before';
  assert not public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b'),
    'an inactive admin may delete nothing';
  assert not public.finance_payment_deletable_by('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000c'),
    'a non-admin may delete nothing';
  raise notice '1. deletable_by: real verified YES for an active admin; inactive admin and non-admin NO';
end $$;


-- ═══ 2. The full protocol on a real verified payment (V1) ══════════════════
do $$
declare
  A uuid := '00000000-0000-4000-8000-00000000000a';
  V1 uuid := '10000000-0000-4000-8000-000000000001';
  claim jsonb; res jsonb;
begin
  perform set_config('request.jwt.claim.sub', A::text, true);

  claim := public.begin_finance_payment_deletion(V1, 'Entered by mistake', 'P-ZZ-0001');
  assert jsonb_array_length(claim->'storage_paths') = 1, 'the proof manifest is taken';

  -- finalize refuses while the proof object is still in storage
  begin
    perform public.finalize_finance_payment_deletion(V1, (claim->>'claim_token')::uuid);
    assert false, 'finalize must wait for the proof sweep';
  exception when others then
    assert sqlerrm like 'PAYMENT_DELETION_PROOF_PENDING%', sqlerrm;
  end;

  -- the route reports the sweep
  update public.finance_payment_deletion_claims
     set storage_removed = storage_paths where claim_token = (claim->>'claim_token')::uuid;

  res := public.finalize_finance_payment_deletion(V1, (claim->>'claim_token')::uuid);
  assert (res->>'allocations_released')::int = 1, 'the allocation is released: ' || res::text;
  assert not exists (select 1 from public.finance_payment_requests where id = V1), 'the payment is gone';
  assert not exists (select 1 from public.finance_payment_allocations where payment_request_id = V1), 'allocations are gone';
  assert exists (select 1 from public.finance_payment_deletion_claims
                  where payment_id = V1 and finalized_at is not null
                    and human_payment_id = 'P-ZZ-0001' and deletion_reason = 'Entered by mistake'
                    and claimed_by_email = 'admin@example.invalid' and amount = 100),
    'the claim stays as the tombstone: who, why, what';
  raise notice '2. a real verified payment is deleted through begin -> sweep -> finalize; allocation released; tombstone kept';
end $$;


-- ═══ 3. The gates are still there ══════════════════════════════════════════
do $$
declare
  A uuid := '00000000-0000-4000-8000-00000000000a';
  V4 uuid := '10000000-0000-4000-8000-000000000004';
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000c', true);
  begin
    perform public.begin_finance_payment_deletion(V4, 'x', 'P-ZZ-0004');
    assert false, 'a non-admin must be refused';
  exception when insufficient_privilege then
    assert sqlerrm like 'PAYMENT_DELETION_DENIED%', sqlerrm;
  end;

  perform set_config('request.jwt.claim.sub', A::text, true);
  begin
    perform public.begin_finance_payment_deletion(V4, '   ', 'P-ZZ-0004');
    assert false, 'a blank reason must be refused';
  exception when others then
    assert sqlerrm like 'PAYMENT_DELETION_REASON_REQUIRED%', sqlerrm;
  end;
  begin
    perform public.begin_finance_payment_deletion(V4, 'mistake', 'P-ZZ-0005');
    assert false, 'a wrong Payment ID must be refused';
  exception when others then
    assert sqlerrm like 'PAYMENT_DELETION_ID_MISMATCH%', sqlerrm;
  end;
  assert exists (select 1 from public.finance_payment_requests where id = V4), 'nothing was deleted';
  assert not exists (select 1 from public.finance_payment_deletion_claims where payment_id = V4), 'no claim was taken';
  raise notice '3. non-admin, blank reason and wrong typed ID are all still refused';
end $$;


-- ═══ 4. An ACTIVE bank link refuses the delete (V2) ═══════════════════════
do $$
declare
  A uuid := '00000000-0000-4000-8000-00000000000a';
  V2 uuid := '10000000-0000-4000-8000-000000000002';
  claim jsonb;
begin
  perform set_config('request.jwt.claim.sub', A::text, true);
  begin
    perform public.begin_finance_payment_deletion(V2, 'mistake', 'P-ZZ-0002');
    assert false, 'a bank-linked payment must be refused';
  exception when others then
    assert sqlerrm like 'PAYMENT_DELETION_BANK_LINKED%', sqlerrm;
  end;
  assert not exists (select 1 from public.finance_payment_deletion_claims where payment_id = V2),
    'refused before any freeze: no claim';

  -- once the reconciler unlinks it, the delete goes through and the note goes
  update public.bank_line_payment_links
     set unlinked_by = A, unlinked_at = now() where payment_id = V2;
  claim := public.begin_finance_payment_deletion(V2, 'mistake', 'P-ZZ-0002');
  perform public.finalize_finance_payment_deletion(V2, (claim->>'claim_token')::uuid);
  assert not exists (select 1 from public.finance_payment_requests where id = V2), 'deleted after unlinking';
  assert not exists (select 1 from public.bank_line_payment_links where payment_id = V2), 'the undone link note is cleared';
  raise notice '4. actively bank-linked: refused (BANK_LINKED); after unlinking it is deleted and the note cleared';
end $$;


-- ═══ 5. A link made AFTER begin stops finalize (V5) ═══════════════════════
do $$
declare
  A uuid := '00000000-0000-4000-8000-00000000000a';
  V5 uuid := '10000000-0000-4000-8000-000000000005';
  claim jsonb;
begin
  perform set_config('request.jwt.claim.sub', A::text, true);
  claim := public.begin_finance_payment_deletion(V5, 'mistake', 'P-ZZ-0005');
  insert into public.bank_line_payment_links (line_id, payment_id, amount, linked_by)
    values ('30000000-0000-4000-8000-000000000009', V5, 100, A);
  begin
    perform public.finalize_finance_payment_deletion(V5, (claim->>'claim_token')::uuid);
    assert false, 'finalize must refuse a payment linked meanwhile';
  exception when others then
    assert sqlerrm like 'PAYMENT_DELETION_BANK_LINKED%', sqlerrm;
  end;
  assert exists (select 1 from public.finance_payment_requests where id = V5), 'still there';
  -- leave the standing claim behind the direct-delete probe below
  raise notice '5. a link made after begin: finalize refuses, payment intact';
end $$;


-- ═══ 6. A direct DELETE, outside the protocol, still fails ════════════════
do $$
begin
  delete from public.finance_payment_requests where id = '10000000-0000-4000-8000-000000000003';
  assert false, 'a direct delete must be refused';
exception when insufficient_privilege then
  assert sqlerrm like 'PAYMENT_APPROVED_PERMANENT%', sqlerrm;
  raise notice '6. a direct DELETE (any caller, incl. service role) of a verified payment: refused';
end $$;


-- ═══ 7. A verified payment whose link was already undone (V3) ═════════════
do $$
declare
  A uuid := '00000000-0000-4000-8000-00000000000a';
  V3 uuid := '10000000-0000-4000-8000-000000000003';
  claim jsonb;
begin
  perform set_config('request.jwt.claim.sub', A::text, true);
  claim := public.begin_finance_payment_deletion(V3, 'duplicate entry', 'P-ZZ-0003');
  perform public.finalize_finance_payment_deletion(V3, (claim->>'claim_token')::uuid);
  assert not exists (select 1 from public.finance_payment_requests where id = V3);
  assert not exists (select 1 from public.bank_line_payment_links where payment_id = V3),
    'an undone link note does not block the delete (its foreign key would have)';
  raise notice '7. an already-unlinked payment deletes cleanly, the history note goes with it';
end $$;


-- ═══ 8. Unverified payments: as before ════════════════════════════════════
do $$
declare
  A uuid := '00000000-0000-4000-8000-00000000000a';
  P1 uuid := '10000000-0000-4000-8000-000000000006';
  claim jsonb;
begin
  perform set_config('request.jwt.claim.sub', A::text, true);
  claim := public.begin_finance_payment_deletion(P1, 'wrong customer', 'P-ZZ-0006');
  perform public.finalize_finance_payment_deletion(P1, (claim->>'claim_token')::uuid);
  assert not exists (select 1 from public.finance_payment_requests where id = P1);
  raise notice '8. a pending payment is deleted as before';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
