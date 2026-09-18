-- update_order_submission_schedule_terms() meets the Order guard (20261217000000)
-- ===========================================================================
-- Run by supabase/tests/run_schedule_terms_amendment_suite.sh against a
-- DISPOSABLE database. One transaction, ends in ROLLBACK. Never point this at
-- a linked project.
--
-- Fixtures: an approved PI whose Confirmed Order 0526 carries the PI's dates,
-- and a draft PI with no Order. The admin (A) edits both.

\set ON_ERROR_STOP on
begin;

insert into public.orders (id, display_number, client_name, confirm_date, due_date, created_by)
values ('b0000000-0000-4000-8000-000000000526', '0526', 'Hotel Aurum', date '2026-09-01', date '2026-10-01',
        '00000000-0000-4000-8000-00000000000a');
insert into public.order_submissions (id, status, order_id, order_confirmation_date, due_date, payment_terms)
values ('a0000000-0000-4000-8000-000000000001', 'approved', 'b0000000-0000-4000-8000-000000000526',
        date '2026-09-01', date '2026-10-01', '50% advance'),
       ('a0000000-0000-4000-8000-000000000002', 'draft', null, date '2026-09-05', date '2026-10-05', null);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';


-- ═══ 1. Moving the approved PI's Due Date now reaches the Order ═══════════
do $$
declare r jsonb; v_due date; v_confirm date;
begin
  r := public.update_order_submission_schedule_terms(
         'a0000000-0000-4000-8000-000000000001', '{"due_date":"2026-10-20"}'::jsonb, null, 'Customer asked for a later date');
  assert (r ->> 'changed')::boolean, format('expected a change, got %s', r);
  select due_date, confirm_date into v_due, v_confirm from public.orders where id = 'b0000000-0000-4000-8000-000000000526';
  assert v_due = date '2026-10-20', format('Order due date must follow the PI, got %s', v_due);
  assert v_confirm = date '2026-09-01', 'the confirm date must not move';
  assert (select due_date from public.order_submissions where id = 'a0000000-0000-4000-8000-000000000001') = date '2026-10-20',
    'the PI itself carries the new date';
  raise notice '1. approved PI: Due Date change saved and carried onto Order 0526';
end $$;


-- ═══ 2. …and the Order Confirmation Date too ═══════════════════════════════
do $$
begin
  perform public.update_order_submission_schedule_terms(
    'a0000000-0000-4000-8000-000000000001', '{"order_confirmation_date":"2026-09-03"}'::jsonb, null, 'Signed later');
  assert (select confirm_date from public.orders where id = 'b0000000-0000-4000-8000-000000000526') = date '2026-09-03',
    'Order confirm date must follow the PI';
  raise notice '2. approved PI: Order Confirmation Date change carried onto the Order';
end $$;


-- ═══ 3. The amendment window closes after the one statement ═══════════════
do $$
begin
  assert coalesce(current_setting('boe.amendment_context', true), '') = '',
    format('the amendment context must be closed after the call, got %L', current_setting('boe.amendment_context', true));
  raise notice '3. the amendment context is closed again after the call';
end $$;


-- ═══ 4. The guard is intact: a direct write outside the door is refused ═══
do $$
begin
  update public.orders set due_date = date '2027-01-01' where id = 'b0000000-0000-4000-8000-000000000526';
  assert false, 'a direct due_date write must be refused';
exception when insufficient_privilege then
  assert sqlerrm like 'ORDER_AMENDMENT_REQUIRED%', sqlerrm;
  raise notice '4. a direct Order date write outside the amendment door is still refused (ORDER_AMENDMENT_REQUIRED)';
end $$;

do $$
begin
  update public.orders set total_value = 1 where id = 'b0000000-0000-4000-8000-000000000526';
  assert false, 'a direct total_value write must be refused';
exception when insufficient_privilege then
  raise notice '4b. and so is any other frozen column';
end $$;


-- ═══ 5. A terms-only change leaves the Order alone ═════════════════════════
do $$
declare v_before text; v_after text;
begin
  select to_jsonb(o)::text into v_before from public.orders o where id = 'b0000000-0000-4000-8000-000000000526';
  perform public.update_order_submission_schedule_terms(
    'a0000000-0000-4000-8000-000000000001', '{"payment_terms":"30% advance"}'::jsonb, null, 'Terms corrected');
  select to_jsonb(o)::text into v_after from public.orders o where id = 'b0000000-0000-4000-8000-000000000526';
  assert v_before = v_after, 'a payment-terms change must not write the Order';
  raise notice '5. payment-terms change: the Order row is untouched';
end $$;


-- ═══ 6. A draft PI (no Order) is unaffected ═══════════════════════════════
do $$
begin
  perform public.update_order_submission_schedule_terms(
    'a0000000-0000-4000-8000-000000000002', '{"due_date":"2026-11-05"}'::jsonb, null, null);
  assert (select due_date from public.order_submissions where id = 'a0000000-0000-4000-8000-000000000002') = date '2026-11-05';
  raise notice '6. draft PI without an Order: saved as before';
end $$;


-- ═══ 7. The admin still has to give a reason after submission ═════════════
do $$
begin
  perform public.update_order_submission_schedule_terms(
    'a0000000-0000-4000-8000-000000000001', '{"due_date":"2026-12-01"}'::jsonb, null, null);
  assert false, 'an admin edit after submission without a reason must be refused';
exception when others then
  assert sqlerrm like 'ORDER_SUBMISSION_REASON_REQUIRED%', sqlerrm;
  raise notice '7. an admin edit after submission still needs a reason';
end $$;


-- ═══ 8. The Order carries an audit event for each date change ═════════════
do $$
begin
  assert (select count(*) from public.order_activity_log
          where order_id = 'b0000000-0000-4000-8000-000000000526'
            and event_type = 'order_schedule_terms_amended') = 3,
    'every change on an approved PI with an Order is logged on the Order (2 dates + 1 terms)';
  raise notice '8. each change is recorded on the Order activity log';
end $$;

reset role;
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;
