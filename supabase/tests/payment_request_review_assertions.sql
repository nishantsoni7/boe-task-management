-- FINANCE REVIEW MODAL assertions (20261220000000), run by
-- run_payment_request_review_suite.sh AFTER the migration.
--
-- Proves, by EXECUTING the calls the Finance review modal now makes, AS the
-- client role, on production's privileges:
--
--   * a payment verifier sends a payment back for clarification through
--     request_finance_payment_clarification() and rejects it through
--     reject_finance_payment_request(), and the activity trail names them;
--   * the clarification door has exactly the rejection door's authority: no
--     finance.approve → refused; the person who recorded the payment → refused
--     (admins excepted); a blank note → refused; anything not pending →
--     refused; an unknown id → refused; anon → cannot call it;
--   * a module reset in flight still freezes it (55P03);
--   * NOTHING WAS WIDENED: a direct client UPDATE of the table is refused
--     exactly as before, the reset guard is still invoker-rights, its helpers
--     still closed to clients, and the UPDATE policy set is unchanged.
--
-- Prints one "PASS:" line per assertion. Two transactions, both rolled back.

\set ON_ERROR_STOP on

-- ── 0. The direct write is still refused — in a transaction of its own ──────
-- FIRST, and alone. PL/pgSQL caches a trigger's simple expressions — and the
-- EXECUTE check made when each was first evaluated — for the rest of the
-- transaction. Once the reset guard has run inside a SECURITY DEFINER RPC, a
-- later direct UPDATE in the SAME transaction would pass it. PostgREST runs
-- each request in its own transaction, so this is the shape that matters.
begin;
set local role authenticated;
do $$ begin perform harness.as_user('d0000000-0000-4000-8000-000000000003'); end $$;
do $$
declare r text;
begin
  r := harness.try($q$
    update public.finance_payment_requests
       set admin_note = 'direct', status = 'needs_clarification', updated_at = now()
     where id = 'e0000000-0000-4000-8000-000000000005' and status = 'pending_approval'
  $q$);
  assert r like '42501 permission denied for function in_test_data_cleanup%', 'direct UPDATE: ' || r;
  raise notice 'PASS: a direct client UPDATE is still refused exactly as before — no table write was opened';
end $$;
rollback;

begin;

-- ── 1. The verifier's two decisions ─────────────────────────────────────────
set local role authenticated;
do $$ begin perform harness.as_user('d0000000-0000-4000-8000-000000000003'); end $$;
do $$
declare r text;
begin
  r := harness.try($q$ select public.request_finance_payment_clarification(
         p_request_id => 'e0000000-0000-4000-8000-000000000001', p_note => '  Which account did this land in?  ') $q$);
  assert r = 'OK', 'verifier clarification: ' || r;
  r := harness.try($q$ select public.reject_finance_payment_request(
         p_request_id => 'e0000000-0000-4000-8000-000000000002', p_reason => 'Duplicate of an earlier payment') $q$);
  assert r = 'OK', 'verifier rejection: ' || r;
end $$;
reset role;
do $$
begin
  assert (select status from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000001') = 'needs_clarification';
  assert (select admin_note from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000001') = 'Which account did this land in?',
    'the note is stored trimmed';
  assert (select status from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000002') = 'rejected';
  assert (select admin_note from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000002') = 'Duplicate of an earlier payment';
  assert exists (select 1 from finance_payment_request_activity_log
                 where payment_request_id = 'e0000000-0000-4000-8000-000000000001'
                   and actor_id = 'd0000000-0000-4000-8000-000000000003'
                   and event_type = 'status_changed'
                   and payload ->> 'to_status' = 'needs_clarification'), 'clarification activity names the verifier';
  assert exists (select 1 from finance_payment_request_activity_log
                 where payment_request_id = 'e0000000-0000-4000-8000-000000000002'
                   and actor_id = 'd0000000-0000-4000-8000-000000000003'
                   and payload ->> 'to_status' = 'rejected'), 'rejection activity names the verifier';
  raise notice 'PASS: a verifier sends back and rejects through the two RPCs; stored note trimmed; activity names the verifier';
end $$;

-- ── 2. Refusals, each leaving the row untouched ─────────────────────────────
set local role authenticated;
do $$
declare r text;
begin
  -- Blank and whitespace-only notes.
  perform harness.as_user('d0000000-0000-4000-8000-000000000003');
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000003', null) $q$);
  assert r like '22023 PAYMENT_CLARIFICATION_NOTE_REQUIRED%', 'null note: ' || r;
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000003', '   ') $q$);
  assert r like '22023 PAYMENT_CLARIFICATION_NOTE_REQUIRED%', 'blank note: ' || r;
  raise notice 'PASS: a blank or missing note is refused (22023 PAYMENT_CLARIFICATION_NOTE_REQUIRED)';

  -- Finance view_all without approve.
  perform harness.as_user('d0000000-0000-4000-8000-000000000005');
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000003', 'why?') $q$);
  assert r like '42501 Only a payment verifier%', 'viewer clarification: ' || r;
  r := harness.try($q$ select public.reject_finance_payment_request('e0000000-0000-4000-8000-000000000003', 'no') $q$);
  assert r like '42501 Only a payment verifier%', 'viewer rejection: ' || r;
  raise notice 'PASS: finance.view_all without finance.approve is refused by both doors (42501)';

  -- The submitter, without approve.
  perform harness.as_user('d0000000-0000-4000-8000-000000000001');
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000003', 'why?') $q$);
  assert r like '42501 Only a payment verifier%', 'submitter clarification: ' || r;
  raise notice 'PASS: the submitter cannot send their own payment back (42501)';

  -- A verifier who recorded the payment.
  perform harness.as_user('d0000000-0000-4000-8000-000000000007');
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000007', 'why?') $q$);
  assert r like '42501 PAYMENT_SELF_DECISION_FORBIDDEN%', 'self clarification: ' || r;
  r := harness.try($q$ select public.reject_finance_payment_request('e0000000-0000-4000-8000-000000000007', 'no') $q$);
  assert r like '42501 PAYMENT_SELF_DECISION_FORBIDDEN%', 'self rejection: ' || r;
  -- …who still decides somebody else's.
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000004', 'Which branch?') $q$);
  assert r = 'OK', 'submitter+verifier on another''s payment: ' || r;
  raise notice 'PASS: a verifier who recorded the payment is refused (PAYMENT_SELF_DECISION_FORBIDDEN) but decides others''';

  -- Not pending any more.
  perform harness.as_user('d0000000-0000-4000-8000-000000000003');
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000001', 'again') $q$);
  assert r like 'P0001 Only a pending payment request can be sent back%', 'already needs_clarification: ' || r;
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000002', 'again') $q$);
  assert r like 'P0001 Only a pending payment request can be sent back%', 'already rejected: ' || r;
  r := harness.try($q$ select public.reject_finance_payment_request('e0000000-0000-4000-8000-000000000001', 'again') $q$);
  assert r like 'P0001 Only a pending payment request can be rejected%', 'reject a sent-back payment: ' || r;
  raise notice 'PASS: a payment no longer pending is refused (P0001) by both doors';

  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-0000000000ff', 'why?') $q$);
  assert r like 'P0002%', 'unknown id: ' || r;
  raise notice 'PASS: an unknown payment is refused (P0002)';

  -- No identity at all, under the client role.
  perform set_config('request.jwt.claims', '', true);
  r := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000003', 'why?') $q$);
  assert r like '28000%', 'no identity: ' || r;
  raise notice 'PASS: a call with no auth.uid() is refused (28000)';
end $$;
reset role;

set local role anon;
do $$
declare r text := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000003', 'why?') $q$);
begin
  assert r like '42501 permission denied for function request_finance_payment_clarification%', 'anon: ' || r;
  raise notice 'PASS: anon cannot execute the clarification RPC';
end $$;
reset role;

do $$
begin
  assert (select status from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000003') = 'pending_approval';
  assert (select admin_note from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000003') is null;
  assert (select status from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000007') = 'pending_approval';
  assert (select admin_note from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000001') = 'Which account did this land in?';
  assert (select status from finance_payment_requests where id = 'e0000000-0000-4000-8000-000000000004') = 'needs_clarification';
  raise notice 'PASS: every refused call left its row exactly as it was';
end $$;

-- ── 3. Admins keep the override on a payment they recorded ──────────────────
set local role authenticated;
do $$ begin perform harness.as_user('d0000000-0000-4000-8000-00000000000a'); end $$;
do $$
declare r text := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-00000000000a', 'Admin question') $q$);
begin
  assert r = 'OK', 'admin on own payment: ' || r;
  raise notice 'PASS: an admin may send back a payment they recorded, as with rejection';
end $$;
reset role;

-- ── 4. A module reset in flight still freezes the door ──────────────────────
savepoint reset_in_flight;
insert into public.test_data_cleanup_claims (root_type, scope, reason, confirmation)
values ('finance_module', 'finance_module', 'harness', 'harness');
set local role authenticated;
do $$ begin perform harness.as_user('d0000000-0000-4000-8000-000000000003'); end $$;
do $$
declare r text := harness.try($q$ select public.request_finance_payment_clarification('e0000000-0000-4000-8000-000000000005', 'why?') $q$);
begin
  assert r like '55P03 ORDER_FINANCE_RESET_IN_PROGRESS%', 'during a reset: ' || r;
  raise notice 'PASS: while a Finance reset is in flight the RPC is refused by the guard (55P03)';
end $$;
reset role;
rollback to savepoint reset_in_flight;

-- ── 5. Nothing was widened ──────────────────────────────────────────────────
do $$
begin
  assert (select prosecdef from pg_proc where oid = 'public.request_finance_payment_clarification(uuid, text)'::regprocedure);
  assert (select 'search_path=public, pg_temp' = any(proconfig) from pg_proc where oid = 'public.request_finance_payment_clarification(uuid, text)'::regprocedure);
  assert has_function_privilege('authenticated', 'public.request_finance_payment_clarification(uuid, text)', 'execute');
  assert not has_function_privilege('anon', 'public.request_finance_payment_clarification(uuid, text)', 'execute');
  assert not has_function_privilege('public', 'public.request_finance_payment_clarification(uuid, text)', 'execute');
  assert not (select prosecdef from pg_proc where oid = 'public.order_finance_reset_write_guard()'::regprocedure),
    'the reset guard must stay invoker-rights';
  assert not has_function_privilege('authenticated', 'public.in_test_data_cleanup()', 'execute');
  assert not has_function_privilege('authenticated', 'public.open_order_finance_reset_scope()', 'execute');
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename = 'finance_payment_requests' and cmd = 'UPDATE') = 4;
  assert (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'request_finance_payment_clarification') = 1;
  raise notice 'PASS: catalog — definer + fixed search_path, authenticated only; guard, helpers and UPDATE policies unchanged';
end $$;

rollback;
