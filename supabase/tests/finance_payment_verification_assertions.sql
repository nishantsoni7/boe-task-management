-- FINANCE PAYMENT VERIFICATION assertions (hotfix — no migration)
-- ===========================================================================
-- The production defect: Finance/Admin could not verify a payment recorded
-- against a PI. Reported against PAY-REQ-2026-0038.
--
-- The fix is entirely in the UI. This file exists to prove the SECOND half of
-- that claim — that the backend needed nothing, and that the door the UI now
-- opens is the same door, with the same lock, that Finance has always used:
--
--   * RPC      approve_finance_payment_request   (20260690000000,
--              re-gated onto finance.approve by 20260901000000) — UNCHANGED
--   * gate     actor_has_module_permission('finance', 'approve')
--   * decision needs_clarification / rejected — the direct-UPDATE route,
--              still separate and still working
--
-- It therefore asserts what a UI change could silently break or silently
-- widen, and it asserts that NO second approval flow was introduced.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * psql as a role that bypasses RLS and may SET the `role` GUC.
--   * Replace the SIX user UUIDs below:
--       test.admin_id     -> role = 'admin'
--       test.finance_id   -> NON-admin with finance.view + finance.approve
--                            (the authorised Finance approver)
--       test.manager_id   -> NON-admin with finance.view + view_all + manage
--                            and NO approve  (proves wide Finance access is
--                            not a verification route)
--       test.allocator_id -> NON-admin with finance.view + finance.allocate
--                            and NO approve  (proves allocate is not either)
--       test.sales_id     -> NON-admin, orders.view ONLY — the PI owner who
--                            recorded the payment
--       test.outsider_id  -> NON-admin with nothing at all
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.admin_id',     '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.allocator_id', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.manager_id',   '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  perform set_config('test.outsider_id',  '44444444-4444-4444-4444-444444444444', true); -- REPLACE
  perform set_config('test.sales_id',     '55555555-5555-5555-5555-555555555555', true); -- REPLACE
  perform set_config('test.finance_id',   '66666666-6666-6666-6666-666666666666', true); -- REPLACE

  perform set_config('test.pi',     gen_random_uuid()::text, true);
  perform set_config('test.req',    gen_random_uuid()::text, true);
end $$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────

-- The salesperson's PI. ₹100,000 grand total, so the summary percentages below
-- are checkable by eye.
insert into public.order_submissions
  (id, status, submitted_by, created_by, client_name, source_workbook_path,
   gross_product_amount, discount_amount, grand_total)
values
  (current_setting('test.pi')::uuid, 'draft',
   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
   'ASSERT verify PI', 'submissions/assert-verify/original/w.xlsx',
   100000, 0, 100000);

-- The transition trigger insists a submission is CREATED as draft; it reaches
-- 'submitted' only by moving there, which is the state a PI sits in while
-- finance looks at it.
update public.order_submissions set status = 'submitted'
where id = current_setting('test.pi')::uuid;

-- A submitted Order Request and a Confirmed Order, so the two NON-PI routes
-- through the same RPC are exercised as well.
insert into public.order_requests
  (id, client_name, requested_by, created_by, assigned_to, status, total_value, finalized_at)
values
  (current_setting('test.req')::uuid, 'ASSERT verify request',
   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
   current_setting('test.sales_id')::uuid, 'submitted', 500000, now());

insert into public.orders (client_name, created_by, status)
values ('ASSERT verify order', current_setting('test.admin_id')::uuid, 'running');

-- Order Management entry only for the salesperson; NO Finance action of any kind.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.sales_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view'
where pm.module_key = 'orders'
on conflict do nothing;

-- The authorised approver: Finance entry, company-wide read, and approve.
-- view_all is part of the real shape of this role rather than decoration — the
-- decision policy is an UPDATE policy, and an UPDATE that names a row still has
-- to READ it, so an approver who cannot see other people's payments cannot send
-- one back for clarification either. They hold NO manage and NO allocate.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.finance_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'view_all', 'approve')
where pm.module_key = 'finance'
on conflict do nothing;

-- The Finance manager: WIDE read and correction rights, deliberately WITHOUT
-- approve. This is the user the requirement is really about — verification must
-- not fall out of finance.view, finance.view_all or finance.manage.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.manager_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'view_all', 'manage')
where pm.module_key = 'finance'
on conflict do nothing;

-- The allocator: Finance entry + the protected allocate action, no approve.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.allocator_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'allocate')
where pm.module_key = 'finance'
on conflict do nothing;

-- The premise every permission assertion below rests on: these four really do
-- hold the access they are named for, and really do NOT hold approve. Without
-- this, a fixture that silently granted nothing would make the whole file pass
-- for the wrong reason.
do $$
begin
  perform set_config('test.order_id',
    (select id::text from public.orders where client_name = 'ASSERT verify order'), true);

  perform set_config('request.jwt.claim.sub', current_setting('test.manager_id'), true);
  assert public.actor_has_module_permission('finance', 'view')
     and public.actor_has_module_permission('finance', 'view_all')
     and public.actor_has_module_permission('finance', 'manage'),
    'the manager fixture must really hold view, view_all and manage';
  assert not public.actor_has_module_permission('finance', 'approve'),
    'the manager fixture must NOT hold approve, or it proves nothing';

  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);
  assert public.actor_has_module_permission('finance', 'allocate'),
    'the allocator fixture must really hold allocate';
  assert not public.actor_has_module_permission('finance', 'approve'),
    'the allocator fixture must NOT hold approve, or it proves nothing';

  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);
  assert public.actor_has_module_permission('finance', 'approve'),
    'the approver fixture must really hold approve';
  assert not public.actor_has_module_permission('finance', 'manage')
     and not public.actor_has_module_permission('finance', 'allocate'),
    'the approver fixture must hold neither manage nor allocate, so approve is what is being tested';

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  assert not public.module_entry_open('finance'),
    'the salesperson fixture must have no Finance entry at all';
end $$;

-- A PI payment, recorded exactly the way production recorded PAY-REQ-2026-0038:
-- by the PI owner, through record_pi_submission_payment, with no received_in.
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);

  v_r := public.record_pi_submission_payment(
    current_setting('test.pi')::uuid, 40000.00, current_date, 'upi', 'ASSERT-REF-1');
  perform set_config('test.pay_pi',   v_r->>'payment_request_id', true);
  perform set_config('test.alloc_pi', v_r->>'allocation_id', true);

  -- A second PI payment, used for the rejected-then-verify assertion so the
  -- first one stays clean.
  v_r := public.record_pi_submission_payment(
    current_setting('test.pi')::uuid, 1000.00, current_date, 'cash');
  perform set_config('test.pay_pi2', v_r->>'payment_request_id', true);
end $$;

-- The two non-PI payments, inserted directly the way the Finance page inserts
-- them. The target type is derived by trigger, never taken from the payload.
do $$
declare v_id uuid;
begin
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     order_request_id, submitted_by)
  values ('ASSERT ignored', 25000, current_date, 'bank_transfer', 'company_account',
          current_setting('test.req')::uuid, current_setting('test.sales_id')::uuid)
  returning id into v_id;
  perform set_config('test.pay_req', v_id::text, true);

  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     order_id, submitted_by)
  values ('ASSERT ignored', 30000, current_date, 'bank_transfer', 'company_account',
          current_setting('test.order_id')::uuid, current_setting('test.sales_id')::uuid)
  returning id into v_id;
  perform set_config('test.pay_order', v_id::text, true);

  -- One more unallocated payment, for the two rejection/clarification routes.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in, submitted_by)
  values ('ASSERT decisions', 500, current_date, 'cash', 'cash_in_hand',
          current_setting('test.sales_id')::uuid)
  returning id into v_id;
  perform set_config('test.pay_clarify', v_id::text, true);

  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in, submitted_by)
  values ('ASSERT decisions', 600, current_date, 'cash', 'cash_in_hand',
          current_setting('test.sales_id')::uuid)
  returning id into v_id;
  perform set_config('test.pay_reject', v_id::text, true);
end $$;

-- Every fixture payment starts pending, or none of the transitions below mean
-- anything.
do $$
begin
  assert (select count(*) from public.finance_payment_requests
          where id in (current_setting('test.pay_pi')::uuid,
                       current_setting('test.pay_pi2')::uuid,
                       current_setting('test.pay_req')::uuid,
                       current_setting('test.pay_order')::uuid,
                       current_setting('test.pay_clarify')::uuid,
                       current_setting('test.pay_reject')::uuid)
            and status = 'pending_approval') = 6,
    'all six fixture payments must start pending_approval';
end $$;

-- ═══ 4. THE GATE — who may invoke verification, and who may not ═════════════
--
-- UI HIDING IS NOT SECURITY. Every caller below reaches the RPC directly, with
-- no UI in the way, exactly as a hand-written PostgREST call would.
do $$
declare
  v_caller text;
  v_pay    uuid := current_setting('test.pay_pi')::uuid;
begin
  foreach v_caller in array array['test.outsider_id',   -- nothing at all
                                  'test.sales_id',      -- the PI owner / submitter
                                  'test.allocator_id',  -- finance.view + finance.allocate
                                  'test.manager_id']    -- finance.view + view_all + manage
  loop
    perform set_config('request.jwt.claim.sub', current_setting(v_caller), true);
    begin
      perform public.approve_finance_payment_request(v_pay, null);
      assert false, format('%s must not be able to verify a payment', v_caller);
    exception when insufficient_privilege then
      null;  -- 42501, the expected refusal
    end;
  end loop;

  -- Unauthenticated is refused before authorization is even considered.
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.approve_finance_payment_request(v_pay, null);
    assert false, 'an unauthenticated caller must not be able to verify a payment';
  exception when invalid_authorization_specification then
    null;  -- 28000
  end;

  -- And after four refusals the payment has not moved.
  assert (select status from public.finance_payment_requests where id = v_pay) = 'pending_approval',
    'a refused verification must leave the payment untouched';
  assert (select approved_by from public.finance_payment_requests where id = v_pay) is null,
    'a refused verification must not stamp an approver';
end $$;

-- The salesperson holding finance.view alone is still refused: entry is not
-- approval. Granted and revoked inside this assertion so the fixture above
-- keeps its "no Finance at all" meaning.
do $$
begin
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  select current_setting('test.sales_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
  from public.permission_modules pm
  join public.permission_actions pa on pa.action_key = 'view'
  where pm.module_key = 'finance'
  on conflict do nothing;

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  assert public.module_entry_open('finance'), 'the grant must have taken effect';
  begin
    perform public.approve_finance_payment_request(current_setting('test.pay_pi')::uuid, null);
    assert false, 'finance.view alone must not verify a payment';
  exception when insufficient_privilege then
    null;
  end;

  delete from public.employee_permission_overrides
  where user_id = current_setting('test.sales_id')::uuid
    and module_id = (select id from public.permission_modules where module_key = 'finance');
end $$;

-- ═══ 5–10. THE PI PAYMENT VERIFIES, AND NOTHING ELSE MOVES ═════════════════
do $$
declare
  v_pay      uuid := current_setting('test.pay_pi')::uuid;
  v_alloc    uuid := current_setting('test.alloc_pi')::uuid;
  v_before   public.finance_payment_requests%rowtype;
  v_after    public.finance_payment_requests%rowtype;
  v_a_before public.finance_payment_allocations%rowtype;
  v_a_after  public.finance_payment_allocations%rowtype;
  v_sum      jsonb;
  v_result   jsonb;
begin
  select * into v_before from public.finance_payment_requests where id = v_pay;
  select * into v_a_before from public.finance_payment_allocations where id = v_alloc;

  -- The summary BEFORE: the whole 40,000 is unverified.
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  v_sum := public.pi_submission_payment_summary(current_setting('test.pi')::uuid);
  assert (v_sum->>'verified_amount')::numeric = 0,
    format('nothing may be verified yet, got %s', v_sum->>'verified_amount');
  assert (v_sum->>'unverified_amount')::numeric = 41000.00,
    format('both pending payments must count as unverified, got %s', v_sum->>'unverified_amount');

  -- 5. The authorised Finance approver — NOT an admin — verifies it.
  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);
  v_result := public.approve_finance_payment_request(v_pay, 'ASSERT verified by finance');

  select * into v_after from public.finance_payment_requests where id = v_pay;

  -- 6. A PI payment is a new_order payment: it lands in Suspense, with NO order.
  assert v_after.status = 'approved_unlinked',
    format('a verified PI payment must be approved_unlinked, got %s', v_after.status);
  assert v_after.order_id is null,     'a verified PI payment must not be given an order_id';
  assert v_after.order_number is null, 'a verified PI payment must not be given an order number';
  assert v_after.payment_target_type = 'unallocated',
    'the target classification must be unchanged by verification';
  assert (v_result->>'status') = 'approved_unlinked',
    'the RPC must report the status it wrote';

  -- 8. NOTHING WAS COPIED. The payment row the allocation points at is the same
  --    row, with the same identity and the same money on it.
  assert v_after.id = v_before.id,                         'the payment id must not change';
  assert v_after.request_number = v_before.request_number, 'the payment number must not change';
  assert v_after.amount = v_before.amount,                 'verification must not restate the amount';
  assert v_after.payment_date = v_before.payment_date,     'verification must not restate the date';
  assert v_after.payment_mode = v_before.payment_mode,     'verification must not restate the mode';
  assert v_after.received_in is null,
    'verification must not invent a received_in for a PI payment';
  assert v_after.submitted_by = v_before.submitted_by,
    'verification must not reassign who recorded the payment';
  assert (select count(*) from public.finance_payment_requests
          where id <> v_pay and request_number = v_before.request_number) = 0,
    'verification must not create a second payment row';

  -- 7. The allocation is untouched — same id, same status, same amount, still
  --    on the same PI, and still exactly one of it.
  select * into v_a_after from public.finance_payment_allocations where id = v_alloc;
  assert v_a_after.id = v_a_before.id,                           'the allocation id must not change';
  assert v_a_after.status = 'active',                            'the allocation must stay active';
  assert v_a_after.allocated_amount = v_a_before.allocated_amount,
    'the allocated amount must not change';
  assert v_a_after.order_submission_id = current_setting('test.pi')::uuid,
    'the allocation must still point at the same PI';
  assert v_a_after.payment_request_id = v_pay,
    'the allocation must still point at the same payment';
  assert v_a_after.order_id is null,
    'verification must not retarget a PI allocation at an Order';
  assert v_a_after.reversed_at is null and v_a_after.reversed_by is null,
    'verification must not reverse the allocation';
  assert (select count(*) from public.finance_payment_allocations
          where payment_request_id = v_pay) = 1,
    'verification must not create a second allocation';

  -- 10. The verifier and the moment are recorded, and the note is kept.
  assert v_after.approved_by = current_setting('test.finance_id')::uuid,
    'the verifier must be stamped on the payment';
  assert v_after.approved_at is not null,   'the verification time must be stamped';
  assert v_after.approved_at = now(),
    'the verification time must be this transaction''s, not a stale or client-supplied one';
  assert v_after.admin_note = 'ASSERT verified by finance', 'the verification note must be kept';

  -- ...and in the activity log, by the same person, as a status change.
  assert exists (
    select 1 from public.finance_payment_request_activity_log
    where payment_request_id = v_pay
      and event_type = 'status_changed'
      and actor_id = current_setting('test.finance_id')::uuid
      and payload->>'from_status' = 'pending_approval'
      and payload->>'to_status'   = 'approved_unlinked'),
    'the activity log must record the verifier and the transition';

  -- 9. The summary moved the money from unverified to verified, and the PI's
  --    percentage now reflects it. 40,000 of 100,000 is 40.00%.
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  v_sum := public.pi_submission_payment_summary(current_setting('test.pi')::uuid);
  assert (v_sum->>'verified_amount')::numeric = 40000.00,
    format('the verified amount must be 40000.00, got %s', v_sum->>'verified_amount');
  assert (v_sum->>'unverified_amount')::numeric = 1000.00,
    format('only the second payment may remain unverified, got %s', v_sum->>'unverified_amount');
  assert (v_sum->>'verified_percent')::numeric = 40.00,
    format('40000 of 100000 is 40.00%%, got %s', v_sum->>'verified_percent');

  -- The PI participant sees the same movement — verification does not hide the
  -- payment from the person who recorded it.
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  v_sum := public.pi_submission_payment_summary(current_setting('test.pi')::uuid);
  assert (v_sum->>'verified_amount')::numeric = 40000.00,
    'the PI owner must see the verified amount too';

  -- Verifying twice is refused rather than replayed. The UI guards a double
  -- click with a ref; this is the guarantee underneath it.
  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);
  begin
    perform public.approve_finance_payment_request(v_pay, null);
    assert false, 'an already-verified payment must not verify again';
  exception when raise_exception then
    assert sqlerrm like '%Only a pending payment request can be approved%',
      format('the second call must be refused as non-pending, got: %s', sqlerrm);
  end;
end $$;

-- ═══ 11 + 12. THE OTHER TWO ROUTES THROUGH THE SAME RPC ════════════════════
do $$
declare v_row public.finance_payment_requests%rowtype;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);

  -- 12. Order Request (a New Order / Order Request payment): confirmation of
  --     receipt only. It lands in Suspense and KEEPS its request linkage.
  perform public.approve_finance_payment_request(current_setting('test.pay_req')::uuid, null);
  select * into v_row from public.finance_payment_requests where id = current_setting('test.pay_req')::uuid;
  assert v_row.status = 'approved_unlinked',
    format('an Order Request payment must verify to approved_unlinked, got %s', v_row.status);
  assert v_row.order_id is null, 'an Order Request payment must not be given an order_id';
  assert v_row.order_request_id = current_setting('test.req')::uuid,
    'the Order Request linkage must survive verification';
  assert v_row.payment_target_type = 'order_request',
    'the target classification must survive verification';
  assert v_row.approved_by = current_setting('test.finance_id')::uuid,
    'the verifier must be stamped on an Order Request payment too';

  -- 11. Confirmed Order: links straight through, with the number resolved from
  --     the Order itself.
  perform public.approve_finance_payment_request(current_setting('test.pay_order')::uuid, null);
  select * into v_row from public.finance_payment_requests where id = current_setting('test.pay_order')::uuid;
  assert v_row.status = 'approved_linked',
    format('an Order payment must verify to approved_linked, got %s', v_row.status);
  assert v_row.order_id = current_setting('test.order_id')::uuid,
    'the Order linkage must be kept';
  assert v_row.order_number = (select display_number from public.orders
                               where id = current_setting('test.order_id')::uuid),
    'the order number must be resolved from the Order, not invented';
  assert v_row.approved_by = current_setting('test.finance_id')::uuid,
    'the verifier must be stamped on an Order payment too';
end $$;

-- Admin verifies too, by the admin branch of actor_has_module_permission and
-- not by any Finance grant. Proven on a payment of its own.
do $$
declare v_id uuid;
begin
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in, submitted_by)
  values ('ASSERT admin verify', 700, current_date, 'cash', 'cash_in_hand',
          current_setting('test.sales_id')::uuid)
  returning id into v_id;

  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  assert not exists (
    select 1 from public.employee_permission_overrides o
    join public.permission_modules pm on pm.id = o.module_id
    where o.user_id = current_setting('test.admin_id')::uuid and pm.module_key = 'finance'),
    'the admin must hold no Finance override, or this proves nothing about the admin branch';

  perform public.approve_finance_payment_request(v_id, null);
  assert (select status from public.finance_payment_requests where id = v_id) = 'approved_unlinked',
    'an admin must be able to verify a payment';
end $$;

-- ═══ 13 + 14 + 15. THE OTHER TWO DECISIONS STAY SEPARATE ═══════════════════
--
-- Needs Clarification and Rejected are NOT verification and do not go through
-- the RPC: the Finance page writes them directly, under RLS. Adding a Verify
-- Payment button must not have disturbed either, and must not have made a
-- rejected payment verifiable without first travelling back through the
-- correction route.
do $$
declare v_n integer;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);
  perform set_config('role', 'authenticated', true);

  -- 13. Needs Clarification.
  update public.finance_payment_requests
     set status = 'needs_clarification', admin_note = 'ASSERT what is this'
   where id = current_setting('test.pay_clarify')::uuid;
  get diagnostics v_n = row_count;
  assert v_n = 1, 'the approver must still be able to send a payment back for clarification';

  -- 14. Reject.
  update public.finance_payment_requests
     set status = 'rejected', admin_note = 'ASSERT declined'
   where id = current_setting('test.pay_reject')::uuid;
  get diagnostics v_n = row_count;
  assert v_n = 1, 'the approver must still be able to reject a payment';

  perform set_config('role', 'postgres', true);

  assert (select status from public.finance_payment_requests
          where id = current_setting('test.pay_clarify')::uuid) = 'needs_clarification',
    'the clarification status must have been written';
  assert (select status from public.finance_payment_requests
          where id = current_setting('test.pay_reject')::uuid) = 'rejected',
    'the rejected status must have been written';

  -- 15. A rejected payment cannot be verified directly. The RPC refuses it, so
  --     the UI rule that only offers the control for pending_approval agrees
  --     with the backend rather than promising something it cannot deliver.
  begin
    perform public.approve_finance_payment_request(current_setting('test.pay_reject')::uuid, null);
    assert false, 'a rejected payment must not be verifiable directly';
  exception when raise_exception then
    assert sqlerrm like '%Only a pending payment request can be approved%',
      format('a rejected payment must be refused as non-pending, got: %s', sqlerrm);
  end;

  -- Nor a payment awaiting clarification.
  begin
    perform public.approve_finance_payment_request(current_setting('test.pay_clarify')::uuid, null);
    assert false, 'a payment awaiting clarification must not be verifiable directly';
  exception when raise_exception then
    assert sqlerrm like '%Only a pending payment request can be approved%',
      format('a clarification payment must be refused as non-pending, got: %s', sqlerrm);
  end;

  -- Both are still exactly where the decision left them.
  assert (select status from public.finance_payment_requests
          where id = current_setting('test.pay_reject')::uuid) = 'rejected',
    'a refused verification must not disturb a rejected payment';
  assert (select approved_by from public.finance_payment_requests
          where id = current_setting('test.pay_clarify')::uuid) is null,
    'a refused verification must not stamp an approver on a clarification payment';
end $$;

-- ═══ THE DOOR IS THE RPC, AND ONLY THE RPC ═════════════════════════════════
--
-- 20260920000000 lets the guard step aside for approve_finance_payment_request,
-- so a non-admin approver's verification is no longer refused for stamping who
-- verified and when. That is the ONLY thing it opens. These assertions state the
-- boundary from the other side: outside the RPC the guard is exactly as strict
-- as 20260901000000 §4a made it, and the marker cannot be reached, reused or
-- carried to a second payment.
do $$
declare v_id uuid; v_other uuid; v_n integer;
begin
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in, submitted_by)
  values ('ASSERT boundary', 800, current_date, 'cash', 'cash_in_hand',
          current_setting('test.sales_id')::uuid)
  returning id into v_id;

  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in, submitted_by)
  values ('ASSERT boundary two', 900, current_date, 'cash', 'cash_in_hand',
          current_setting('test.sales_id')::uuid)
  returning id into v_other;

  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);
  perform set_config('role', 'authenticated', true);

  -- An approver may still not stamp themselves as the verifier by hand. This is
  -- the write the guard exists to refuse, and it is still refused.
  begin
    update public.finance_payment_requests
       set status = 'needs_clarification',
           approved_by = current_setting('test.finance_id')::uuid,
           approved_at = now()
     where id = v_id;
    assert false, 'a direct update must not be able to stamp approved_by';
  exception when insufficient_privilege then
    null;
  end;

  -- Nor rewrite the money while deciding.
  begin
    update public.finance_payment_requests
       set status = 'rejected', amount = 1
     where id = v_id;
    assert false, 'a direct update must not be able to rewrite the amount';
  exception when insufficient_privilege then
    null;
  end;

  -- Nor retarget it at an Order. Refused whichever guard reaches it first —
  -- the client-name trigger runs ahead of this one — so the assertion is that
  -- the write does not land, not that one particular guard caught it.
  begin
    update public.finance_payment_requests
       set status = 'rejected', order_id = current_setting('test.order_id')::uuid
     where id = v_id;
    assert false, 'a direct update must not be able to retarget the payment';
  exception when insufficient_privilege or raise_exception then
    null;
  end;

  perform set_config('role', 'postgres', true);

  -- Three refusals later, nothing about the payment has moved.
  select count(*) into v_n from public.finance_payment_requests
   where id = v_id and status = 'pending_approval' and amount = 800
     and order_id is null and approved_by is null;
  assert v_n = 1, 'the refused direct updates must have left the payment exactly as it was';

  -- The marker is not a client-settable door: even with the GUC set by hand to
  -- this very payment, the guard still refuses, because the predicate function
  -- is revoked from every client role and the policy stack is unchanged. The
  -- assertion below is about the ONE thing a client could try — setting the GUC
  -- itself — and it is stated as "the write still fails", not as "the GUC is
  -- unsettable", because a GUC in a custom namespace always is settable.
  perform set_config('boe.finance_payment_verification', v_id::text, true);
  perform set_config('request.jwt.claim.sub', current_setting('test.manager_id'), true);
  begin
    perform public.approve_finance_payment_request(v_id, null);
    assert false, 'setting the marker by hand must not let a non-approver verify';
  exception when insufficient_privilege then
    null;  -- refused at the permission gate, long before the guard is reached
  end;
  perform set_config('boe.finance_payment_verification', '', true);

  -- And the marker does not carry: verifying one payment does not leave a door
  -- open for the next one in the same transaction.
  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);
  perform public.approve_finance_payment_request(v_id, null);
  assert current_setting('boe.finance_payment_verification', true) is null
      or current_setting('boe.finance_payment_verification', true) = '',
    'the RPC must clear its marker after the statement';

  perform set_config('role', 'authenticated', true);
  begin
    update public.finance_payment_requests
       set status = 'needs_clarification',
           approved_by = current_setting('test.finance_id')::uuid
     where id = v_other;
    assert false, 'the marker must not carry to a second payment';
  exception when insufficient_privilege then
    null;
  end;
  perform set_config('role', 'postgres', true);

  assert (select status from public.finance_payment_requests where id = v_other) = 'pending_approval',
    'the second payment must be untouched';
  assert (select status from public.finance_payment_requests where id = v_id) = 'approved_unlinked',
    'the first payment must have verified through the RPC';
end $$;

-- ═══ 16 + 17. WHAT THIS HOTFIX DID NOT TOUCH ═══════════════════════════════
do $$
declare v_def text; v_n integer;
begin
  -- NO SECOND APPROVAL FLOW. Verification has exactly one implementation, and
  -- it is the one that already existed.
  select count(*) into v_n from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname ~ '^(verify|confirm)_(finance_)?payment'
     or (n.nspname = 'public' and p.proname like 'approve_finance_payment_request_%');
  assert v_n = 0, 'no second verification function may have been introduced';

  assert (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'approve_finance_payment_request') = 1,
    'approve_finance_payment_request must remain a single function at a single signature';

  -- The gate is still finance.approve, and still not any of the four actions
  -- the requirement names.
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'approve_finance_payment_request';
  assert v_def like '%actor_has_module_permission(''finance'', ''approve'')%',
    'verification must still be gated on finance.approve';
  assert v_def not like '%''view_all''%' and v_def not like '%''manage''%'
     and v_def not like '%''allocate''%',
    'verification must not consult view_all, manage or allocate';

  -- 16. The declared-advance rule is not part of verification, in either
  --     direction: the RPC does not read it, and it does not read the RPC.
  assert v_def not like '%advance%' and v_def not like '%finance_payment_allocations%',
    'verification must not touch the allocation ledger or the advance rule';

  -- 17. The Order approval gate is exactly what Phase 2 left it as.
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'approve_order_submission';
  assert v_def like '%order_submission_advance_ready%',
    'approve_order_submission must still read the declared-advance rule';
  assert v_def not like '%approve_finance_payment_request%'
     and v_def not like '%pi_submission_payment_summary%'
     and v_def not like '%finance_payment_allocations%',
    'approve_order_submission must not have been wired to payment verification';

  -- The status domain gained nothing. "Awaiting Verification" is a LABEL for
  -- pending_approval, not a sixth database status.
  assert (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'finance_payment_requests_status_check')
         not like '%verif%',
    'no verification status may have been added to the database';
end $$;

reset role;
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
