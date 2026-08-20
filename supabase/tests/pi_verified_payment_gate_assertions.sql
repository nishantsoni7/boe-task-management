-- PI VERIFIED-PAYMENT APPROVAL GATE assertions (20260921000000)
-- ===========================================================================
-- Validates Order Management Phase 3:
--
--   * columns  order_submissions.payment_terms / billing_terms
--   * helpers  order_submission_required_payment
--              order_submission_payment_shortfall
--              order_submission_payment_ready
--              order_submission_verified_payment
--              order_submission_unverified_payment
--   * guard    finance_payment_allocations_guard_transition   (restated: the
--              one PI-to-Order move, and nothing wider)
--   * trigger  log_finance_payment_allocation_activity        (allocation_moved)
--   * RPCs     approve_order_submission                       (live payment gate
--                                                              + allocation move)
--              submit_pi_for_review                           (route chosen by
--                                                              verified payment)
--              pi_submission_payment_summary                  (approval position)
--   * activity order_submission_activity 'payment_allocations_moved'
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * psql as a role that bypasses RLS and may SET the `role` GUC.
--   * The Confirmed Order numbering cycle is configured (20260703000000), because
--     the conversion section inserts an Order and lets the existing trigger
--     assign its number. An unconfigured cycle raises ORDER_NUMBER_CYCLE, which
--     is an environment problem and not a failure of this phase.
--   * Replace the THREE user UUIDs below:
--       test.admin_id     -> role = 'admin', active
--       test.sales_id     -> NON-admin, orders.view + orders.create, no Finance
--       test.outsider_id  -> NON-admin with no Orders and no Finance relationship
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.admin_id',    '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.sales_id',    '55555555-5555-5555-5555-555555555555', true); -- REPLACE
  perform set_config('test.outsider_id', '44444444-4444-4444-4444-444444444444', true); -- REPLACE

  perform set_config('test.pi',       gen_random_uuid()::text, true);
  perform set_config('test.pi_other', gen_random_uuid()::text, true);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE STANDARD ROUTE — exact amounts, never a rounded percentage
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pure functions, so these need no fixture and no session: they are the rule
-- itself, asked directly.

do $$
begin
  -- 1. EXACTLY 40% allows approval.
  assert public.order_submission_payment_ready(1000000, 400000, null),
    'exactly 40% of the grand total must satisfy the standard route';

  -- 2. MORE than 40% allows approval.
  assert public.order_submission_payment_ready(1000000, 400000.01, null),
    'more than 40% must satisfy it';
  assert public.order_submission_payment_ready(1000000, 1000000, null),
    'and so must payment in full';

  -- 3. ₹0.01 BELOW the exact requirement blocks without an exception.
  assert not public.order_submission_payment_ready(1000000, 399999.99, null),
    'one paisa below the requirement is below the requirement';

  -- 4. A ROUNDED DISPLAYED PERCENTAGE CANNOT PASS.
  --    40% of 100.01 is 40.004. 40.00 displays as "40%" and does not meet it.
  assert public.order_submission_required_payment(100.01) = 40.004,
    format('the exact requirement for 100.01 must be 40.004, got %s',
           public.order_submission_required_payment(100.01));
  assert not public.order_submission_payment_ready(100.01, 40.00, null),
    'a figure that ROUNDS to 40% must not pass the gate';
  assert public.order_submission_payment_ready(100.01, 40.01, null),
    'and the smallest real figure that satisfies it must';

  -- The shortfall a person is shown is always a figure that closes the gate.
  assert public.order_submission_payment_shortfall(100.01, 40.00) = 0.01,
    format('the shortfall must round UP, got %s',
           public.order_submission_payment_shortfall(100.01, 40.00));
  assert public.order_submission_payment_shortfall(1000000, 400000) = 0,
    'a met requirement leaves nothing outstanding';

  -- An unknown or nonsensical figure is never ready.
  assert not public.order_submission_payment_ready(null, 400000, null),
    'an unknown grand total is never ready on the standard route';
  assert not public.order_submission_payment_ready(1000000, 'NaN'::numeric, null),
    'NaN is never ready';
  assert public.order_submission_required_payment(null) is null,
    'an unknown total yields NULL, never a guess';

  -- The requirement derives from the ONE rule that states 40.
  assert public.order_submission_required_payment(1000000)
       = 1000000 * public.order_submission_standard_advance_percent() / 100,
    'the requirement must derive from order_submission_standard_advance_percent()';

  raise notice '1. standard route: exact-amount comparison OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. WHAT COUNTS AS VERIFIED PAYMENT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 5. pending does not count.  6. needs_clarification does not count.
-- 7. rejected does not count. 8. a reversed allocation does not count.
-- 9. several verified payments sum correctly.

insert into public.order_submissions
  (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
values
  (current_setting('test.pi')::uuid, 'draft',
   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
   'ASSERT PI gate', 1000000, 0, 1000000),
  (current_setting('test.pi_other')::uuid, 'draft',
   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
   'ASSERT PI other', 1000000, 0, 1000000);

do $$
declare
  v_pi       uuid := current_setting('test.pi')::uuid;
  v_sales    uuid := current_setting('test.sales_id')::uuid;
  v_verified numeric;
  v_pending  numeric;
  v_ids      uuid[] := array[]::uuid[];
  v_id       uuid;
  v_status   text;
  v_amount   numeric;
begin
  -- Five payments against one PI, one per status, plus a second verified one so
  -- the sum has more than one term.
  for v_status, v_amount in
    select * from (values
      ('approved_unlinked', 250000::numeric),
      ('approved_linked',   150000::numeric),
      ('pending_approval',  300000::numeric),
      ('needs_clarification', 200000::numeric),
      ('rejected',          400000::numeric)
    ) as t(s, a)
  loop
    v_id := gen_random_uuid();
    insert into public.finance_payment_requests
      (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
    values (v_id, 'ASSERT PI gate', v_amount, current_date, 'bank_transfer', v_status, v_sales, null);

    insert into public.finance_payment_allocations
      (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
    values (v_id, v_pi, v_amount, 'order_submission', v_sales);

    v_ids := v_ids || v_id;
  end loop;

  v_verified := public.order_submission_verified_payment(v_pi);
  v_pending  := public.order_submission_unverified_payment(v_pi);

  -- 9. MULTIPLE VERIFIED PAYMENTS SUM CORRECTLY: 250000 + 150000.
  assert v_verified = 400000,
    format('verified must be 400000 (two verified payments), got %s', v_verified);

  -- 5 + 6. pending_approval and needs_clarification are AWAITING, never counted.
  assert v_pending = 500000,
    format('awaiting verification must be 500000, got %s', v_pending);

  -- 7. rejected counts in NEITHER total.
  assert v_verified + v_pending = 900000,
    'a rejected payment must count in neither total';

  -- The PI is at exactly 40% and is therefore ready on the standard route.
  assert public.order_submission_payment_ready(1000000, v_verified, null),
    'two verified payments reaching exactly 40% must satisfy the standard route';

  -- 8. A REVERSED ALLOCATION DOES NOT COUNT.
  update public.finance_payment_allocations
     set status = 'reversed', reversed_by = v_sales, reversed_at = now(),
         reversal_reason = 'ASSERT reversal'
   where order_submission_id = v_pi
     and payment_request_id = v_ids[2];   -- the approved_linked one, 150000

  v_verified := public.order_submission_verified_payment(v_pi);
  assert v_verified = 250000,
    format('a reversed allocation must stop counting, got %s', v_verified);

  -- 20. DROPPING BELOW 40% BLOCKS unless an approved exception exists.
  assert not public.order_submission_payment_ready(1000000, v_verified, null),
    'the PI must fall back below the requirement once the allocation is reversed';
  assert not public.order_submission_payment_ready(1000000, v_verified, 'pending'),
    'and a PENDING exception must not rescue it';
  assert public.order_submission_payment_ready(1000000, v_verified, 'approved'),
    'only an APPROVED exception may';

  raise notice '2. verified/unverified totals and reversal OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE EXCEPTION ROUTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 15. a pending exception blocks.  16/17. an approved one permits, at any level
-- including zero.  21. approving one never marks a payment verified.

do $$
begin
  assert not public.order_submission_payment_ready(1000000, 0, null),
    'zero payment with no exception must be blocked';
  assert not public.order_submission_payment_ready(1000000, 0, 'pending'),
    '15. a pending exception must block final approval';
  assert not public.order_submission_payment_ready(1000000, 0, 'rejected'),
    'a rejected exception must block final approval';
  assert public.order_submission_payment_ready(1000000, 399999.99, 'approved'),
    '16. an approved exception permits approval below 40%';
  assert public.order_submission_payment_ready(1000000, 0, 'approved'),
    '17. an approved ZERO-payment exception permits approval';

  -- 19. REACHING 40% AFTER REQUESTING allows the standard route with no decision.
  assert public.order_submission_payment_ready(1000000, 400000, 'pending'),
    '19. money reaching the requirement must not wait on a decision nobody needs';

  raise notice '3. exception route OK';
end $$;

do $$
declare
  v_pi     uuid := current_setting('test.pi')::uuid;
  v_before numeric;
  v_after  numeric;
  v_n      integer;
begin
  -- 21. AN EXCEPTION APPROVAL NEVER CONVERTS UNVERIFIED MONEY INTO VERIFIED
  --     MONEY. Proved on the data: the totals before and after are identical.
  v_before := public.order_submission_verified_payment(v_pi);

  update public.order_submissions
     set advance_condition = 'exception',
         advance_exception_percent = 25,
         advance_exception_reason = 'ASSERT reduced payment',
         advance_exception_status = 'approved',
         advance_exception_requested_by = current_setting('test.sales_id')::uuid,
         advance_exception_requested_at = now(),
         advance_exception_decided_by = current_setting('test.admin_id')::uuid,
         advance_exception_decided_at = now()
   where id = v_pi;

  v_after := public.order_submission_verified_payment(v_pi);
  assert v_before = v_after,
    format('21. an exception decision must not change verified payment (%s -> %s)', v_before, v_after);

  select count(*) into v_n
  from public.finance_payment_requests f
  join public.finance_payment_allocations a on a.payment_request_id = f.id
  where a.order_submission_id = v_pi
    and f.status in ('pending_approval', 'needs_clarification');
  assert v_n = 2,
    '21. and every unverified payment must still be unverified';

  -- 14. ONLY THE AUTHORISED APPROVER MAY DECIDE. Asked of the function itself,
  --     because a decision taken as an outsider is refused before it is taken.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.outsider_id'))::text, true);
  begin
    perform public.approve_pi_advance_exception(v_pi);
    reset role;
    raise exception '14. an outsider must not be able to decide an exception';
  exception when sqlstate '42501' then
    reset role;
  end;

  raise notice '3b. exception authority and verification separation OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. FINAL APPROVAL REFUSES ON LIVE PAYMENT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 31. The DECLARED advance no longer gates approval: this PI declares the full
--     standard advance and is still refused, because no money has arrived.

do $$
declare
  v_pi   uuid := current_setting('test.pi_other')::uuid;
  v_msg  text;
begin
  update public.order_submissions
     set status = 'submitted',
         submitted_at = now(),
         advance_condition = 'standard',
         advance_declared_amount = 400000
   where id = v_pi;

  -- A CURRENT finance check, so the refusal that follows is the PAYMENT one and
  -- not the finance one. Written directly because verify_pi_finance_check()
  -- needs its own authority and this section is about the payment gate.
  update public.order_submissions
     set finance_verified_by = current_setting('test.admin_id')::uuid,
         finance_verified_at = now(),
         finance_verified_submission_at = submitted_at
   where id = v_pi;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'))::text, true);

  begin
    perform public.approve_order_submission(v_pi);
    reset role;
    raise exception '31. a declared advance must not let an Order be created';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    reset role;
    assert v_msg like 'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT%',
      format('the refusal must be the payment one, got: %s', v_msg);
    assert v_msg like '%more verified payment is required for standard approval%',
      format('and it must say so in business language, got: %s', v_msg);
  end;

  -- 33. THE FINANCE CHECK IS STILL REQUIRED AND STILL SEPARATE. Clearing it
  --     refuses the same PI for a different, named reason.
  update public.order_submissions
     set finance_verified_by = null, finance_verified_at = null,
         finance_verified_submission_at = null
   where id = v_pi;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'))::text, true);
  begin
    perform public.approve_order_submission(v_pi);
    reset role;
    raise exception '33. the PI finance check must still be required';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    reset role;
    assert v_msg like 'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED%',
      format('the finance check must refuse in its own words, got: %s', v_msg);
  end;

  -- 34. AND THE APPROVAL PERMISSION IS STILL ENFORCED.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.outsider_id'))::text, true);
  begin
    perform public.approve_order_submission(v_pi);
    reset role;
    raise exception '34. an outsider must not be able to approve a PI';
  exception when sqlstate '42501' then
    reset role;
  end;

  raise notice '4. final approval refuses on live payment, and every other gate holds';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. CONVERSION CONTINUITY — the money MOVES, and only inside the approval
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 22–27. The allocation is re-pointed, not copied: same id, same payment, same
-- amount, same provenance, and its proof and Finance history stay attached to a
-- payment nothing rewrote.

do $$
declare
  v_pi      uuid := current_setting('test.pi')::uuid;
  v_sales   uuid := current_setting('test.sales_id')::uuid;
  v_order   uuid := gen_random_uuid();
  v_wrong   uuid := gen_random_uuid();
  v_pay     uuid := gen_random_uuid();
  v_alloc   uuid := gen_random_uuid();
  v_n       integer;
  v_before  integer;
  v_target  uuid;
  v_origin  text;
begin
  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ASSERT PI gate', 500000, current_date, 'upi', 'approved_unlinked', v_sales, null);

  insert into public.finance_payment_allocations
    (id, payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_alloc, v_pay, v_pi, 500000, 'order_submission', v_sales);

  select count(*) into v_before from public.finance_payment_allocations;

  insert into public.orders (id, client_name, total_value, created_by, status, source_order_submission_id)
  values (v_order, 'ASSERT PI gate', 1000000, current_setting('test.admin_id')::uuid, 'running', v_pi);
  insert into public.orders (id, client_name, total_value, created_by, status, source_order_submission_id)
  values (v_wrong, 'ASSERT unrelated', 1, current_setting('test.admin_id')::uuid, 'running', null);

  -- OUTSIDE the approval context, the move is refused.
  begin
    update public.finance_payment_allocations
       set order_submission_id = null, order_id = v_order where id = v_alloc;
    raise exception 'a move outside approve_order_submission() must be refused';
  exception when sqlstate '42501' then null;
  end;

  perform set_config('boe.pi_submission_approval_id', v_pi::text, true);

  -- INSIDE it, money still cannot go to somebody else's Order …
  begin
    update public.finance_payment_allocations
       set order_submission_id = null, order_id = v_wrong where id = v_alloc;
    raise exception 'money must never move to an unrelated Order';
  exception when sqlstate '42501' then null;
  end;

  -- … the amount cannot be edited on the way across …
  begin
    update public.finance_payment_allocations
       set order_submission_id = null, order_id = v_order, allocated_amount = 900000
     where id = v_alloc;
    raise exception 'the amount must not be editable during the move';
  exception when sqlstate '42501' then null;
  end;

  -- … and the provenance cannot be rewritten.
  begin
    update public.finance_payment_allocations
       set order_submission_id = null, order_id = v_order, origin_target_type = 'confirmed_order'
     where id = v_alloc;
    raise exception 'provenance must survive the move unchanged';
  exception when sqlstate '42501' then null;
  end;

  -- The real move.
  update public.finance_payment_allocations
     set order_submission_id = null, order_id = v_order
   where order_submission_id = v_pi and status = 'active';

  -- 22 + 23 + 24. MOVED, NOT COPIED: the row count is unchanged and the ids are
  -- the ones that already existed.
  select count(*) into v_n from public.finance_payment_allocations;
  assert v_n = v_before,
    format('22. the move must create and destroy nothing (%s -> %s)', v_before, v_n);

  select order_id, origin_target_type into v_target, v_origin
  from public.finance_payment_allocations where id = v_alloc;
  assert v_target = v_order, '23. the allocation id must be unchanged';
  assert v_origin = 'order_submission', '26. provenance must be unchanged';

  select count(*) into v_n from public.finance_payment_allocations
   where id = v_alloc and payment_request_id = v_pay and allocated_amount = 500000
     and order_submission_id is null and status = 'active';
  assert v_n = 1, '24. the payment id and the amount must be unchanged';

  -- 25. THE PI TARGET CLEARS AND THE ORDER TARGET IS ASSIGNED, so the PI no
  --     longer counts the money and the Order does.
  assert public.order_submission_verified_payment(v_pi) = 0,
    '25. the PI must stop counting an allocation that has moved';
  select coalesce(sum(a.allocated_amount), 0) into v_n
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_id = v_order and a.status = 'active'
    and public.finance_payment_status_is_verified(f.status);
  assert v_n = 500000, '29. the Order must retrieve the moved payment';

  -- 27. THE PAYMENT ITSELF WAS NOT TOUCHED, so its proof, its verification and
  --     its Finance history are exactly where they were.
  select count(*) into v_n from public.finance_payment_requests
   where id = v_pay and status = 'approved_unlinked' and order_id is null;
  assert v_n = 1, '27. the payment row must be untouched by the move';

  -- 13. THE MOVE IS RECORDED, SERVER-DERIVED, EXACTLY ONCE.
  select count(*) into v_n from public.finance_payment_request_activity_log
   where event_type = 'allocation_moved'
     and payment_request_id = v_pay
     and (payload->>'allocation_id')::uuid = v_alloc
     and (payload->>'moved_from_order_submission_id')::uuid = v_pi
     and (payload->>'moved_to_order_id')::uuid = v_order;
  assert v_n = 1, format('the move must be recorded exactly once, found %s', v_n);

  -- It cannot move again, and it cannot move back.
  begin
    update public.finance_payment_allocations
       set order_id = null, order_submission_id = v_pi where id = v_alloc;
    raise exception 'money must never move back onto a PI';
  exception when sqlstate '42501' then null;
  end;

  perform set_config('boe.pi_submission_approval_id', '', true);

  -- The reversal path is unchanged, and still terminal.
  update public.finance_payment_allocations
     set status = 'reversed', reversed_by = v_sales, reversed_at = now(),
         reversal_reason = 'ASSERT post-move reversal'
   where id = v_alloc;
  begin
    update public.finance_payment_allocations set status = 'active' where id = v_alloc;
    raise exception 'a reversed allocation must never be reactivated';
  exception when sqlstate '42501' then null;
  end;

  raise notice '5. conversion continuity OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. THE PAYMENT SUMMARY REPORTS THE POSITION, AND STAYS PARTICIPANT-SCOPED
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_pi  uuid := current_setting('test.pi_other')::uuid;
  v_sum jsonb;
begin
  update public.order_submissions
     set payment_terms = '30% advance, 30% during production, 40% before dispatch',
         billing_terms = '100% invoice before dispatch'
   where id = v_pi;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'))::text, true);
  v_sum := public.pi_submission_payment_summary(v_pi);
  reset role;

  assert (v_sum->>'meets_standard')::boolean = false,
    'a PI with no verified payment must not meet the standard requirement';
  assert v_sum->>'approval_position' = 'payment_required',
    format('the position must be payment_required, got %s', v_sum->>'approval_position');
  assert (v_sum->>'required_payment')::numeric = 400000,
    format('the requirement must be 400000, got %s', v_sum->>'required_payment');
  assert (v_sum->>'needed_for_standard')::numeric = 400000,
    format('the shortfall must be 400000, got %s', v_sum->>'needed_for_standard');
  assert v_sum->>'payment_terms' = '30% advance, 30% during production, 40% before dispatch',
    'the agreed collection arrangement must be reported';
  assert v_sum->>'billing_terms' = '100% invoice before dispatch',
    'and so must the invoicing arrangement';
  assert not (v_sum ? 'advance_declared_amount'),
    'the summary must never report a declared advance';

  -- 36. PARTICIPANT-SCOPED. An outsider learns nothing — not a total, not a
  --     position, not an empty list.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.outsider_id'))::text, true);
  begin
    perform public.pi_submission_payment_summary(v_pi);
    reset role;
    raise exception '36. an outsider must not be able to read a PI payment summary';
  exception when sqlstate '42501' then
    reset role;
  end;

  raise notice '6. payment summary position, terms and scoping OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. SUBMISSION — the route is the database's, and the terms are mandatory
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 10/11. Below 40%, including at zero, a reason AND Payment Terms are required.
-- 12/13. The owner may ask; an unrelated salesperson may not.
--
-- NOTE: submit_pi_for_review() also re-checks the workbook and every product
-- image, which this file does not fixture. The refusals below are raised BEFORE
-- those checks, which is what makes them assertable here; a full end-to-end
-- submission is covered by the manual production pass.

do $$
declare
  v_pi  uuid := current_setting('test.pi_other')::uuid;
  v_msg text;
begin
  update public.order_submissions set status = 'draft' where id = v_pi;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'))::text, true);

  -- 10 + 11. No reason: refused by name.
  begin
    perform public.submit_pi_for_review(v_pi, null, null, null, null);
    reset role;
    raise exception '10. a submission below the requirement must require a reason';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    reset role;
    assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED%',
      format('expected the reason refusal, got: %s', v_msg);
  end;

  -- A reason but no Payment Terms: still refused, and for the right reason.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'))::text, true);
  begin
    perform public.submit_pi_for_review(v_pi, null, 'Client pays on delivery', null, null);
    reset role;
    raise exception '10. Payment Terms must be mandatory below the requirement';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    reset role;
    assert v_msg like 'ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED%',
      format('expected the terms refusal, got: %s', v_msg);
  end;

  -- 13. AN UNRELATED SALESPERSON CANNOT ASK on somebody else's PI.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.outsider_id'))::text, true);
  begin
    perform public.submit_pi_for_review(
      v_pi, null, 'Client pays on delivery', '50% before dispatch', null);
    reset role;
    raise exception '13. an unrelated user must not be able to submit this PI';
  exception when sqlstate '42501' then
    reset role;
  end;

  raise notice '7. submission route and mandatory terms OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. WHAT MUST NOT HAVE CHANGED
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_n integer;
begin
  -- 32. HISTORICAL DECLARED-ADVANCE DATA REMAINS READABLE.
  select count(*) into v_n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'order_submissions'
    and column_name in ('advance_declared_amount', 'advance_condition',
                        'advance_exception_percent', 'advance_exception_reason');
  assert v_n = 4, 'every declared-advance column must still exist';

  select count(*) into v_n from public.order_submissions
   where id = current_setting('test.pi_other')::uuid and advance_declared_amount = 400000;
  assert v_n = 1, '32. a stored declared advance must still be readable';

  -- 35. DIRECT CLIENT WRITES CANNOT FORGE A TOTAL OR A DECISION: neither table
  --     is writable by a client role at all.
  for v_n in
    select count(*) from unnest(array['anon', 'authenticated']) r
    where has_table_privilege(r, 'public.finance_payment_allocations', 'INSERT')
       or has_table_privilege(r, 'public.finance_payment_allocations', 'UPDATE')
       or has_table_privilege(r, 'public.finance_payment_allocations', 'DELETE')
  loop
    assert v_n = 0, '35. no client role may write an allocation directly';
  end loop;

  -- 39. NO UNBOUNDED PAYMENT READ: both totals are anchored to one submission.
  assert (select pg_get_functiondef(p.oid) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'order_submission_verified_payment')
         ilike '%a.order_submission_id = p_submission_id%',
    '39. the verified total must be bounded by the PI it is asked about';

  -- 37. THE PAYMENT VERIFICATION FLOW IS UNCHANGED: the two verified statuses
  --     are still exactly the two Phase 1 named.
  assert public.finance_payment_status_is_verified('approved_unlinked');
  assert public.finance_payment_status_is_verified('approved_linked');
  assert not public.finance_payment_status_is_verified('pending_approval');
  assert not public.finance_payment_status_is_verified('needs_clarification');
  assert not public.finance_payment_status_is_verified('rejected');

  raise notice '8. regression and security OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. THE EXACT PAISE RULE — what is shown always closes the gate
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_total    numeric;
  v_needed   numeric;
  v_rounded  numeric;
begin
  -- The three cases the pre-deployment audit named, driven through the real
  -- functions rather than restated as arithmetic here.
  for v_total in select unnest(array[100.00, 100.01, 33333.33, 1000000.00]::numeric[])
  loop
    v_needed  := public.order_submission_payment_shortfall(v_total, 0);
    v_rounded := round(public.order_submission_required_payment(v_total), 2);

    -- 1. Paying exactly the figure the screen asks for ALWAYS satisfies the gate.
    assert public.order_submission_payment_ready(v_total, v_needed, null),
      format('paying the shown %s against a total of %s must satisfy the gate', v_needed, v_total);

    -- 2. The figure shown is a real two-decimal amount somebody can transfer.
    assert scale(v_needed) <= 2,
      format('the amount shown must be whole paise, got %s', v_needed);

    -- 3. It is never LESS than the exact requirement.
    assert v_needed >= public.order_submission_required_payment(v_total),
      format('the amount shown (%s) understates the requirement (%s)',
             v_needed, public.order_submission_required_payment(v_total));

    -- 4. And where the two differ, the ROUNDED requirement does not pass.
    if v_rounded < public.order_submission_required_payment(v_total) then
      assert not public.order_submission_payment_ready(v_total, v_rounded, null),
        format('the rounded display %s must not satisfy a total of %s', v_rounded, v_total);
    end if;
  end loop;

  -- The two worked examples, by name.
  assert public.order_submission_payment_shortfall(100.01, 0) = 40.01,
    format('40%% of 100.01 needs 40.01, got %s', public.order_submission_payment_shortfall(100.01, 0));
  assert public.order_submission_payment_shortfall(33333.33, 0) = 13333.34,
    format('40%% of 33,333.33 needs 13,333.34, got %s',
           public.order_submission_payment_shortfall(33333.33, 0));
  assert public.order_submission_payment_shortfall(100.00, 0) = 40.00,
    'a total that divides exactly needs exactly 40.00';
  assert not public.order_submission_payment_ready(33333.33, 13333.33, null),
    '13,333.33 is below the exact 13,333.332 and must not pass';

  raise notice '9. exact-paise behaviour OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. AN APPROVED EXCEPTION IS AN APPROVAL OF *THIS* PI
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_pi    uuid := current_setting('test.pi_other')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_msg   text;
  v_cur   boolean;
begin
  -- A PI submitted under the reduced-payment route, with a decision taken.
  update public.order_submissions
     set status = 'submitted',
         submitted_at = now(),
         payment_terms = '50% before dispatch',
         billing_terms = null,
         source_workbook_sha256 = repeat('a', 64),
         advance_condition = 'exception',
         advance_exception_percent = 0,
         advance_exception_reason = 'ASSERT client pays on delivery',
         advance_exception_status = 'approved',
         advance_exception_requested_by = v_sales,
         advance_exception_requested_at = now(),
         advance_exception_decided_by = v_admin,
         advance_exception_decided_at = now(),
         advance_exception_decided_grand_total     = 1000000,
         advance_exception_decided_workbook_sha256 = repeat('a', 64),
         advance_exception_decided_payment_terms   = '50% before dispatch',
         advance_exception_decided_billing_terms   = null
   where id = v_pi;

  v_cur := public.order_submission_exception_current(
    'approved', 1000000, 1000000, repeat('a', 64), repeat('a', 64),
    '50% before dispatch', '50% before dispatch', null, null);
  assert v_cur, 'an approval against the current basis must be current';

  -- A REPLACED WORKBOOK makes it stale — which is how "the products changed"
  -- and "the figures changed" are both covered by one column.
  assert not public.order_submission_exception_current(
    'approved', 1000000, 1000000, repeat('a', 64), repeat('b', 64),
    '50% before dispatch', '50% before dispatch', null, null),
    'a replaced workbook must make the approval stale';

  -- A CHANGED GRAND TOTAL makes it stale.
  assert not public.order_submission_exception_current(
    'approved', 1000000, 5000000, repeat('a', 64), repeat('a', 64),
    '50% before dispatch', '50% before dispatch', null, null),
    'a changed grand total must make the approval stale';

  -- CHANGED TERMS make it stale, in both directions.
  assert not public.order_submission_exception_current(
    'approved', 1000000, 1000000, repeat('a', 64), repeat('a', 64),
    '50% before dispatch', '30% before dispatch', null, null),
    'changed Payment Terms must make the approval stale';
  assert not public.order_submission_exception_current(
    'approved', 1000000, 1000000, repeat('a', 64), repeat('a', 64),
    '50% before dispatch', '50% before dispatch', null, '100% before dispatch'),
    'changed Billing Terms must make the approval stale';

  -- A LEGACY DECISION, which recorded no basis, is never current.
  assert not public.order_submission_exception_current(
    'approved', null, 1000000, null, repeat('a', 64), null, null, null, null),
    'a decision with no recorded basis must never be current';

  -- ── The words under a standing approval are frozen ──
  begin
    update public.order_submissions
       set advance_exception_reason = 'ASSERT rewritten after approval'
     where id = v_pi;
    raise exception 'the reason under a standing approval must not be rewritable';
  exception when sqlstate '42501' then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_REASON_FROZEN%',
      format('expected the frozen-reason refusal, got: %s', v_msg);
  end;

  -- ── The recorded basis cannot be forged under a standing decision ──
  begin
    update public.order_submissions
       set advance_exception_decided_grand_total = 5000000
     where id = v_pi;
    raise exception 'the decision basis must not be writable on its own';
  exception when sqlstate '42501' then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_BASIS_IMMUTABLE%',
      format('expected the immutable-basis refusal, got: %s', v_msg);
  end;

  -- ── A STALE approval is refused at final approval, in its own words ──
  update public.order_submissions
     set finance_verified_by = v_admin,
         finance_verified_at = now(),
         finance_verified_submission_at = submitted_at
   where id = v_pi;

  -- The workbook is replaced under the standing approval. (Written directly:
  -- replace_order_submission_parse is service-role-only and needs a draft, and
  -- this section is about what APPROVAL does with the result.)
  update public.order_submissions
     set source_workbook_sha256 = repeat('c', 64)
   where id = v_pi;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  begin
    perform public.approve_order_submission(v_pi);
    reset role;
    raise exception 'a stale reduced-payment approval must not create an Order';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    reset role;
    assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_STALE%',
      format('expected the stale-approval refusal, got: %s', v_msg);
  end;

  raise notice '10. exception currentness OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. ONE LOCK ORDER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Structural, and read out of the catalog rather than trusted from a comment.
-- The concurrency proof itself needs two sessions and cannot live in a single
-- transaction; it is recorded in the PR.

do $$
declare
  v_def text;
  v_fn  text;
begin
  -- The allocation door locks its PI TARGET before the payment. Without this an
  -- allocation can land on a PI that has just been approved: money stranded on a
  -- record that no longer counts it and an Order that will never see it.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'allocate_payment_to_target_internal';

  assert position('from public.order_submissions' in v_def)
       < position('from public.finance_payment_requests' in v_def),
    'allocate_payment_to_target_internal must lock the PI submission before the payment';
  assert v_def like '%where id = p_order_submission_id%for update%',
    'and the PI target must be LOCKED, not merely read';

  -- Both Phase 3 write paths take the same three locks in the same order, and
  -- lock multi-row sets in a deterministic id order.
  for v_fn in select unnest(array['approve_order_submission', 'submit_pi_for_review_internal'])
  loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    assert position('from public.order_submissions' in v_def)
         < position('from public.finance_payment_requests' in v_def),
      format('%s must lock the submission before any payment', v_fn);
    assert position('from public.finance_payment_requests' in v_def)
         < position('from public.finance_payment_allocations' in v_def),
      format('%s must lock payments before allocations', v_fn);
    assert v_def like '%order by f.id%' and v_def like '%order by a.id%',
      format('%s must lock multi-row sets in ascending id', v_fn);
  end loop;

  -- And the applied writers still agree with that order.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reverse_payment_allocation';
  assert position('from public.finance_payment_requests' in v_def)
       < position('from public.finance_payment_allocations' in v_def),
    'reverse_payment_allocation must still lock the payment before the allocation';

  raise notice '11. lock order OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. CLEANUP FOLLOWS THE MONEY ACROSS THE MOVE
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_test_data_cleanup_chain';

  -- The applied branch finds the REVERSED allocations that stay with the PI.
  assert v_def like '%a.order_submission_id = v_submission_id%',
    'the cleanup chain must still find allocations naming the PI';
  -- The new one finds the ACTIVE allocations that moved onto the Order. Without
  -- it a converted test chain hides its payments and the NO ACTION foreign key
  -- refuses the Order delete with a raw constraint error.
  assert v_def like '%a.order_id = v_order_id or a.order_id = v_sub_order_id%',
    'the cleanup chain must also find allocations that moved onto the Order';

  raise notice '12. cleanup chain OK';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
