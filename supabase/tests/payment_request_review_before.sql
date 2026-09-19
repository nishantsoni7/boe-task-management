-- REPRODUCTION, before 20261220000000 (run_payment_request_review_suite.sh).
--
-- On the deployed guard and production's function privileges, a payment
-- verifier's "Needs Clarification" and "Reject" from the Finance review modal —
-- a direct UPDATE of finance_payment_requests — fail with
--   permission denied for function in_test_data_cleanup
-- while the RPC doors already in production (reject_finance_payment_request)
-- work. Also shows the refusal is the reset guard's and not RLS's: sibling
-- tables whose policy admits the write fail the same way.
--
-- Prints one "REPRODUCED:" line per gap. One transaction, rolled back.

\set ON_ERROR_STOP on
begin;

-- The fixture (committed by the runner) is: admin …a, submitter …1, verifier …3,
-- viewer …5, submitter+verifier …7; pending payments PR-0001…0006 recorded by …1,
-- PR-0007 by …7 and PR-000A by the admin.

-- Precondition: production's privileges, not a friendlier copy.
do $$
begin
  assert not has_function_privilege('authenticated', 'public.in_test_data_cleanup()', 'execute'),
    'fixture drift: authenticated may execute in_test_data_cleanup()';
  assert not has_function_privilege('authenticated', 'public.open_order_finance_reset_scope()', 'execute'),
    'fixture drift: authenticated may execute open_order_finance_reset_scope()';
  assert not (select prosecdef from pg_proc where oid = 'public.order_finance_reset_write_guard()'::regprocedure),
    'fixture drift: the reset guard is security definer';
  assert to_regprocedure('public.request_finance_payment_clarification(uuid, text)') is null,
    'the clarification RPC already exists — this is not the before state';
end $$;

set local role authenticated;
do $$ begin perform harness.as_user('d0000000-0000-4000-8000-000000000003'); end $$;

do $$
declare r text;
begin
  -- THE MODAL'S CLARIFICATION, verbatim in shape: a verifier who did not record
  -- the payment, a note, a pending row.
  r := harness.try($q$
    update public.finance_payment_requests
       set admin_note = 'Which account did this land in?', status = 'needs_clarification', updated_at = now()
     where id = 'e0000000-0000-4000-8000-000000000001' and status = 'pending_approval'
  $q$);
  if r not like '42501 permission denied for function in_test_data_cleanup%' then
    raise exception 'expected the clarification UPDATE to be refused by the reset guard, got: %', r;
  end if;
  raise notice 'REPRODUCED: Needs Clarification (direct UPDATE) -> %', r;

  r := harness.try($q$
    update public.finance_payment_requests
       set admin_note = 'Duplicate of an earlier payment', status = 'rejected', updated_at = now()
     where id = 'e0000000-0000-4000-8000-000000000002' and status = 'pending_approval'
  $q$);
  if r not like '42501 permission denied for function in_test_data_cleanup%' then
    raise exception 'expected the reject UPDATE to be refused by the reset guard, got: %', r;
  end if;
  raise notice 'REPRODUCED: Reject (direct UPDATE) -> %', r;

  -- The deployed rejection door is unaffected: it runs as its owner.
  r := harness.try($q$ select public.reject_finance_payment_request('e0000000-0000-4000-8000-000000000002', 'Duplicate of an earlier payment') $q$);
  if r <> 'OK' then
    raise exception 'expected reject_finance_payment_request to work, got: %', r;
  end if;
  raise notice 'REPRODUCED: reject_finance_payment_request (RPC) -> OK, the door the fix routes Reject through';

  -- Not RLS: a policy that admits the write does not help.
  r := harness.try($q$
    insert into public.payment_proof_attachments (payment_request_id, storage_path)
    values ('e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003/proof.jpg')
  $q$);
  if r not like '42501 permission denied for function in_test_data_cleanup%' then
    raise exception 'expected the proof INSERT to be refused by the reset guard, got: %', r;
  end if;
  raise notice 'REPRODUCED: the same guard refuses a policy-admitted INSERT on payment_proof_attachments -> %', r;

  r := harness.try($q$ update public.orders set status = 'running' where id = 'a0000000-0000-4000-8000-00000000000a' $q$);
  if r not like '42501 permission denied for function in_test_data_cleanup%' then
    raise exception 'expected the Order UPDATE to be refused by the reset guard, got: %', r;
  end if;
  raise notice 'REPRODUCED: the same guard refuses a policy-admitted UPDATE on orders -> %', r;
end $$;

reset role;

-- Nothing moved but the one RPC rejection.
do $$
begin
  assert (select status from public.finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000001') = 'pending_approval';
  assert (select status from public.finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000002') = 'rejected';
  raise notice 'REPRODUCED: the refused writes left the rows untouched';
end $$;

rollback;
