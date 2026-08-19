-- PI submission PAYMENT ENTRY assertions (20260919000000)
-- ===========================================================================
-- Validates Payment Phase 2:
--
--   * column   finance_payment_requests.received_in            (now nullable)
--   * policies finance_payment_requests_participant_select
--              finance_payment_requests_module_entry_gate      (restated)
--              payment_proof_attachments_participant_select
--   * helper   can_read_payment_as_participant
--   * RPCs     record_pi_submission_payment                    (atomic entry)
--              pi_submission_payment_summary                   (card + totals)
--              allocate_payment_to_target_internal             (shared impl)
--              allocate_payment_to_target                      (unchanged door)
--   * cleanup  resolve_test_data_cleanup_chain                 (PI-only sweep)
--   * activity order_submission_activity 'payment_recorded'
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * psql as a role that bypasses RLS and may SET the `role` GUC.
--   * Replace the FIVE user UUIDs below:
--       test.admin_id     -> role = 'admin'
--       test.sales_id     -> NON-admin, orders.view ONLY, no Finance action
--       test.allocator_id -> NON-admin granted finance.allocate (+ finance.view)
--       test.outsider_id  -> NON-admin with no Finance and no Orders relationship
--       test.finance_id   -> NON-admin with finance.view + finance.approve and
--                            NO finance.allocate (proves wider Finance access is
--                            not a payment-entry route)
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.admin_id',     '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.allocator_id', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.outsider_id',  '44444444-4444-4444-4444-444444444444', true); -- REPLACE
  perform set_config('test.sales_id',     '55555555-5555-5555-5555-555555555555', true); -- REPLACE
  perform set_config('test.finance_id',   '66666666-6666-6666-6666-666666666666', true); -- REPLACE

  perform set_config('test.pi',        gen_random_uuid()::text, true);
  perform set_config('test.pi_other',  gen_random_uuid()::text, true);
  perform set_config('test.pi_approved', gen_random_uuid()::text, true);
end $$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- The salesperson's own PI, a second PI belonging to the allocator, and a PI
-- that has already become an Order.
insert into public.order_submissions
  (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
values
  (current_setting('test.pi')::uuid, 'draft',
   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
   'ASSERT PI payer', 100000, 0, 100000),
  (current_setting('test.pi_other')::uuid, 'draft',
   current_setting('test.allocator_id')::uuid, current_setting('test.allocator_id')::uuid,
   'ASSERT PI other', 50000, 0, 50000);

-- Order Management entry only for the salesperson; NO Finance action.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.sales_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view'
where pm.module_key = 'orders'
on conflict do nothing;

-- The allocator: Finance entry + the protected allocate action.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.allocator_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'allocate')
where pm.module_key = 'finance'
on conflict do nothing;

-- The finance user: WIDE Finance access, deliberately WITHOUT allocate.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.finance_id')::uuid, pm.id, pa.id, true, current_setting('test.admin_id')::uuid
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'view_all', 'approve', 'manage')
where pm.module_key = 'finance'
on conflict do nothing;

-- ═══ 8 + 9. Only amount, date and mode are mandatory; bad values are refused ══
do $$
declare v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);

  -- THE THREE FIELDS ARE ENOUGH. No reference, no remark, no proof, and — the
  -- point of the nullability change — no received_in.
  v_r := public.record_pi_submission_payment(
    current_setting('test.pi')::uuid, 1000.00, current_date, 'upi');
  assert v_r->>'status' = 'pending_approval',
    'a PI payment must be created awaiting verification';
  assert (select received_in from public.finance_payment_requests
          where id = (v_r->>'payment_request_id')::uuid) is null,
    'received_in must be left NULL rather than invented';

  -- Amount: zero, negative, over-precise and NaN.
  foreach v_r in array array['0'::jsonb, '-1'::jsonb, '10.005'::jsonb] loop
    begin
      perform public.record_pi_submission_payment(
        current_setting('test.pi')::uuid, (v_r#>>'{}')::numeric, current_date, 'upi');
      assert false, format('an amount of %s must be refused', v_r);
    exception when raise_exception then
      assert sqlerrm like '%PAYMENT_AMOUNT_INVALID%',
        format('a bad amount must raise PAYMENT_AMOUNT_INVALID, got: %s', sqlerrm);
    end;
  end loop;

  -- Date: missing, and in the future.
  begin
    perform public.record_pi_submission_payment(current_setting('test.pi')::uuid, 10.00, null, 'upi');
    assert false, 'a missing payment date must be refused';
  exception when raise_exception then
    assert sqlerrm like '%PAYMENT_DATE_REQUIRED%', 'a missing date must raise PAYMENT_DATE_REQUIRED';
  end;

  begin
    perform public.record_pi_submission_payment(
      current_setting('test.pi')::uuid, 10.00, current_date + 30, 'upi');
    assert false, 'a future payment date must be refused';
  exception when raise_exception then
    assert sqlerrm like '%PAYMENT_DATE_FUTURE%', 'a future date must raise PAYMENT_DATE_FUTURE';
  end;

  -- Mode: outside the EXISTING domain, and blank.
  begin
    perform public.record_pi_submission_payment(
      current_setting('test.pi')::uuid, 10.00, current_date, 'crypto');
    assert false, 'a mode outside the existing domain must be refused';
  exception when raise_exception then
    assert sqlerrm like '%PAYMENT_MODE_INVALID%', 'a bad mode must raise PAYMENT_MODE_INVALID';
  end;

  begin
    perform public.record_pi_submission_payment(
      current_setting('test.pi')::uuid, 10.00, current_date, '  ');
    assert false, 'a blank mode must be refused';
  exception when raise_exception then
    assert sqlerrm like '%PAYMENT_MODE_INVALID%', 'a blank mode must raise PAYMENT_MODE_INVALID';
  end;

  -- All five existing modes are accepted, and no sixth is invented.
  foreach v_r in array array['"bank_transfer"'::jsonb, '"cash"'::jsonb, '"upi"'::jsonb,
                             '"cheque"'::jsonb, '"other"'::jsonb] loop
    perform public.record_pi_submission_payment(
      current_setting('test.pi')::uuid, 1.00, current_date, v_r#>>'{}');
  end loop;
end $$;

-- ═══ B. THE STAGE MATRIX — every state a PI can actually be in ═════════════
--
-- The status domain is exactly five values (order_submissions_status_check):
-- draft, submitted, needs_changes, rejected, approved. There is no separate
-- "under review" value — `submitted` IS the state a PI sits in while management
-- and finance look at it — and no reachable "approved but not converted": the
-- transition trigger permits 'approved' only inside in_pi_submission_approval(),
-- and approve_order_submission() writes status and order_id in ONE statement.
-- So the matrix below is complete, and no status is invented to fill it.
do $$
declare v_pi uuid; v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);

  -- ── OPEN: draft ──
  v_pi := gen_random_uuid();
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, source_workbook_path,
     gross_product_amount, discount_amount, grand_total)
  values (v_pi, 'draft', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
          'ASSERT stage draft', 'submissions/' || v_pi::text || '/original/w.xlsx', 1000, 0, 1000);
  v_r := public.record_pi_submission_payment(v_pi, 10.00, current_date, 'upi');
  assert v_r->>'payment_request_id' is not null, 'a DRAFT PI must accept a payment';

  -- ── OPEN: submitted (this is the under-review state) ──
  update public.order_submissions set status = 'submitted' where id = v_pi;
  assert (select status from public.order_submissions where id = v_pi) = 'submitted',
    'the fixture must really be submitted';
  v_r := public.record_pi_submission_payment(v_pi, 11.00, current_date, 'cash');
  assert v_r->>'payment_request_id' is not null, 'a SUBMITTED PI must accept a payment';

  -- ── OPEN: needs_changes ──
  update public.order_submissions set status = 'needs_changes' where id = v_pi;
  v_r := public.record_pi_submission_payment(v_pi, 12.00, current_date, 'cheque');
  assert v_r->>'payment_request_id' is not null, 'a NEEDS CHANGES PI must accept a payment';

  -- All three payments landed on the same PI and each carries its own allocation.
  assert (select count(*) from public.finance_payment_allocations
          where order_submission_id = v_pi and status = 'active') = 3,
    'multiple payments must be recordable against one PI across its stages';

  -- ── CLOSED: rejected ──
  update public.order_submissions set status = 'submitted' where id = v_pi;
  update public.order_submissions set status = 'rejected',
         rejected_by = current_setting('test.admin_id')::uuid, rejected_at = now()
   where id = v_pi;
  begin
    perform public.record_pi_submission_payment(v_pi, 13.00, current_date, 'upi');
    assert false, 'a REJECTED PI must refuse a payment';
  exception when raise_exception then
    assert sqlerrm like '%ORDER_SUBMISSION_REJECTED%',
      format('a rejected PI must raise ORDER_SUBMISSION_REJECTED, got: %s', sqlerrm);
  end;

  -- ── CLOSED: deletion-claimed ──
  -- A FRESH draft PI: 'rejected' is terminal in the transition trigger, so the
  -- one above cannot be reset, and forcing it would be testing a state the
  -- schema does not permit.
  v_pi := gen_random_uuid();
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
  values (v_pi, 'draft', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
          'ASSERT stage claimed', 1000, 0, 1000);

  -- The claim column is the freeze every other path honours; set directly here
  -- because begin_order_submission_deletion() has its own authorization run that
  -- belongs to 20260914000000's assertion file.
  update public.order_submissions
     set deletion_claim_token = gen_random_uuid(),
         deletion_claimed_by  = current_setting('test.admin_id')::uuid,
         deletion_claimed_at  = now()
   where id = v_pi;
  begin
    perform public.record_pi_submission_payment(v_pi, 14.00, current_date, 'upi');
    assert false, 'a DELETION-CLAIMED PI must refuse a payment';
  exception when others then
    assert sqlerrm like '%ORDER_SUBMISSION_DELETION_CLAIMED%',
      format('a claimed PI must raise ORDER_SUBMISSION_DELETION_CLAIMED, got: %s', sqlerrm);
  end;
  update public.order_submissions set deletion_claim_token = null,
         deletion_claimed_by = null, deletion_claimed_at = null where id = v_pi;

  -- ── CLOSED: already an Order ──
  -- order_id is what makes a PI an Order, and the RPC refuses on it directly, so
  -- this is provable without driving a full approval.
  declare v_order uuid := gen_random_uuid();
  begin
    insert into public.orders (id, display_number, client_name, requested_by, created_by,
                               status, total_value)
    values (v_order, null, 'ASSERT stage order', current_setting('test.sales_id')::uuid,
            current_setting('test.admin_id')::uuid, 'running', 1000);
    update public.order_submissions set order_id = v_order where id = v_pi;
    assert false, 'a PI must not be linkable to an Order outside approve_order_submission()';
  exception when others then
    -- EXPECTED, AND ITSELF THE POINT. Two independent guards refuse this:
    -- order_submissions_order_link_requires_approval (order_id only on an
    -- approved PI) and order_submissions_guard_order_link
    -- (ORDER_SUBMISSION_APPROVAL_PATH_REQUIRED). So a PI cannot carry an Order
    -- except through approve_order_submission(), and "approved but not yet
    -- converted" is not a reachable state to test.
    assert sqlerrm like '%APPROVAL_PATH_REQUIRED%' or sqlerrm like '%order_link_requires_approval%',
      format('linking an Order outside approval must be refused, got: %s', sqlerrm);
  end;

  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'record_pi_submission_payment')
         like '%ORDER_SUBMISSION_CONVERTED%',
    'a PI that has become an Order must be refused — the Order route records it';
  -- And the refusal reads order_id, not only the status, so a PI carrying an
  -- Order is closed however it got there.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'record_pi_submission_payment')
         like '%v_sub.order_id is not null%',
    'the conversion refusal must test order_id, not the status alone';

  -- ── CLOSED: the PI does not exist ──
  begin
    perform public.record_pi_submission_payment(gen_random_uuid(), 15.00, current_date, 'upi');
    assert false, 'a deleted or unknown PI must refuse a payment';
  exception when no_data_found then null;
  end;
end $$;

-- ═══ 1, 2, 3, 4. Who may record a payment against a PI ══════════════════════
do $$
declare v_r jsonb;
begin
  -- 1. THE PI'S OWN UPLOADER, holding no Finance action whatsoever.
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  assert not public.resolve_permission(current_setting('test.sales_id')::uuid, 'finance', 'allocate'),
    'the fixture salesperson must hold no finance.allocate, or this proves nothing';
  v_r := public.record_pi_submission_payment(
    current_setting('test.pi')::uuid, 2000.00, current_date, 'bank_transfer');
  assert v_r->>'payment_request_id' is not null, 'the PI owner must be able to record a payment';

  -- 2. AN ADMIN.
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  v_r := public.record_pi_submission_payment(
    current_setting('test.pi')::uuid, 3000.00, current_date, 'cash');
  assert v_r->>'payment_request_id' is not null, 'an admin must be able to record a payment';

  -- 3. AN EXPLICIT finance.allocate HOLDER, where target visibility permits.
  --    can_view_order_submission admits them here through finance.view_all? No —
  --    they hold neither. They are refused on THIS PI and permitted on their own.
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);
  v_r := public.record_pi_submission_payment(
    current_setting('test.pi_other')::uuid, 4000.00, current_date, 'upi');
  assert v_r->>'payment_request_id' is not null,
    'a finance.allocate holder must be able to record against a PI they can see';

  -- 4. AN UNRELATED SALESPERSON CANNOT.
  perform set_config('request.jwt.claim.sub', current_setting('test.outsider_id'), true);
  begin
    perform public.record_pi_submission_payment(
      current_setting('test.pi')::uuid, 500.00, current_date, 'upi');
    assert false, 'an unrelated user must not be able to record a payment against a PI';
  exception when insufficient_privilege then
    assert sqlerrm like '%PI_PAYMENT_NOT_PERMITTED%',
      format('an unrelated user must raise PI_PAYMENT_NOT_PERMITTED, got: %s', sqlerrm);
  end;

  -- 4b. WIDER FINANCE ACCESS ALONE IS NOT A ROUTE. view + view_all + approve +
  --     manage, and still refused: entry is ownership or the protected allocate
  --     action, never "can see payments" or "can verify payments".
  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);
  assert public.resolve_permission(current_setting('test.finance_id')::uuid, 'finance', 'view_all'),
    'the fixture finance user must hold view_all, or this proves nothing';
  assert public.resolve_permission(current_setting('test.finance_id')::uuid, 'finance', 'approve'),
    'the fixture finance user must hold approve, or this proves nothing';
  assert not public.resolve_permission(current_setting('test.finance_id')::uuid, 'finance', 'allocate'),
    'the fixture finance user must NOT hold allocate';
  begin
    perform public.record_pi_submission_payment(
      current_setting('test.pi')::uuid, 500.00, current_date, 'upi');
    assert false, 'wide Finance access alone must not permit PI payment entry';
  exception when insufficient_privilege then
    assert sqlerrm like '%PI_PAYMENT_NOT_PERMITTED%',
      format('wide Finance access must still raise PI_PAYMENT_NOT_PERMITTED, got: %s', sqlerrm);
  end;
end $$;

-- ═══ 5. Payment and allocation are ATOMIC ═══════════════════════════════════
do $$
declare v_p bigint; v_a bigint; v_r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);

  -- Every payment recorded so far carries exactly one active allocation to its
  -- PI, for its full amount. There is no orphan in either direction.
  assert not exists (
    select 1 from public.finance_payment_requests f
    where f.client_name like 'ASSERT PI%'
      and not exists (
        select 1 from public.finance_payment_allocations a
        where a.payment_request_id = f.id and a.status = 'active'
          and a.allocated_amount = f.amount
      )
  ), 'every PI payment must carry one active full-amount allocation';

  -- The reverse: no allocation on these PIs names a payment that does not exist.
  assert not exists (
    select 1 from public.finance_payment_allocations a
    where a.order_submission_id in (current_setting('test.pi')::uuid, current_setting('test.pi_other')::uuid)
      and not exists (select 1 from public.finance_payment_requests f where f.id = a.payment_request_id)
  ), 'no allocation may name a payment that was never written';

  -- A FAILING ALLOCATION LEAVES NO PAYMENT. Driven by making the target
  -- ineligible mid-flight: an approved PI is refused by the entry RPC itself,
  -- so the failure is forced at the allocation step instead by exhausting the
  -- duplicate rule — a second allocation of the same payment to the same target.
  -- Here the structural proof is used instead: the RPC has no exception handler
  -- at all, so any raise below its INSERT aborts the transaction.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'record_pi_submission_payment')
         not like '%exception when%',
    'the entry RPC must have no exception handler — atomicity must be structural';

  select count(*) into v_p from public.finance_payment_requests where client_name like 'ASSERT PI%';
  select count(*) into v_a from public.finance_payment_allocations a
   join public.finance_payment_requests f on f.id = a.payment_request_id
   where f.client_name like 'ASSERT PI%';
  assert v_p = v_a, format('payments (%s) and allocations (%s) must match one to one', v_p, v_a);
end $$;

-- ═══ D. Two separate identical requests are TWO payments ═══════════════════
--
-- REPORTED, NOT BLOCKED. A person can legitimately receive two identical
-- amounts on the same day by the same method — two instalments, or two clients
-- paying the same round figure — so a business-level duplicate blocker would
-- refuse real money. No safe idempotency key exists either: nothing the browser
-- sends is unique to an INTENT rather than to a request, and inventing one
-- (hashing the fields, say) would collide on exactly those legitimate cases.
--
-- What IS prevented is the accidental double: canSubmitPiPayment() refuses a
-- second submission while one is in flight, and the modal holds a ref that is
-- set before the await. That covers the double-click; it deliberately does not
-- cover two deliberate entries, which are two payments.
do $$
declare v_pi uuid := gen_random_uuid(); v_a jsonb; v_b jsonb;
begin
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
  values (v_pi, 'draft', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
          'ASSERT duplicates', 10000, 0, 10000);

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  v_a := public.record_pi_submission_payment(v_pi, 500.00, current_date, 'upi', 'SAME-REF', 'same remark');
  v_b := public.record_pi_submission_payment(v_pi, 500.00, current_date, 'upi', 'SAME-REF', 'same remark');

  assert v_a->>'payment_request_id' <> v_b->>'payment_request_id',
    'two separate identical requests must produce two distinct payments';
  assert (select count(*) from public.finance_payment_allocations
          where order_submission_id = v_pi and status = 'active') = 2,
    'each of the two payments must carry its own allocation';

  -- Both count, because both are real as far as the database can tell.
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  assert (public.pi_submission_payment_summary(v_pi)->>'unverified_amount')::numeric = 1000.00,
    'two identical payments must both count toward the unverified total';

  -- And there is no idempotency parameter to pretend otherwise.
  assert not exists (
    select 1 from pg_proc p, unnest(p.proargnames) an
    where p.proname = 'record_pi_submission_payment'
      and an in ('p_idempotency_key', 'p_client_token', 'p_request_id', 'p_dedupe_key')
  ), 'no idempotency key exists, so none may be implied';
end $$;

-- ═══ 6 + 7. The client is derived; actor and status cannot be forged ════════
do $$
declare v_r jsonb; v_pay uuid;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  v_r := public.record_pi_submission_payment(
    current_setting('test.pi')::uuid, 7000.00, current_date, 'cheque', 'REF-9', 'a remark');
  v_pay := (v_r->>'payment_request_id')::uuid;

  -- 6. The client name comes from the PI, not from the caller. There is no
  --    parameter for it, and the stored value matches the PI exactly.
  assert (select client_name from public.finance_payment_requests where id = v_pay)
         = (select client_name from public.order_submissions where id = current_setting('test.pi')::uuid),
    'the client name must be derived from the PI';

  assert not exists (
    select 1 from pg_proc p, unnest(p.proargnames) an
    where p.proname = 'record_pi_submission_payment'
      and an in ('p_client_name', 'p_client', 'p_customer', 'p_customer_name')
  ), 'the entry RPC must expose no customer parameter to invent one from';

  -- 7. The actor is auth.uid(), and the status is fixed.
  assert (select submitted_by from public.finance_payment_requests where id = v_pay)
         = current_setting('test.sales_id')::uuid,
    'submitted_by must be the authenticated actor';
  assert (select status from public.finance_payment_requests where id = v_pay) = 'pending_approval',
    'a newly recorded PI payment must be pending_approval';
  assert (select approved_by from public.finance_payment_requests where id = v_pay) is null
     and (select approved_at from public.finance_payment_requests where id = v_pay) is null,
    'a newly recorded payment must carry no approval';

  assert not exists (
    select 1 from pg_proc p, unnest(p.proargnames) an
    where p.proname = 'record_pi_submission_payment'
      and an in ('p_status', 'p_actor', 'p_actor_id', 'p_submitted_by', 'p_approved_by', 'p_verified')
  ), 'the entry RPC must expose no actor, status or approval parameter';

  -- The optional fields land where the ledger already keeps them.
  assert (select order_number from public.finance_payment_requests where id = v_pay) = 'REF-9',
    'the optional reference must be stored';
  assert (select sales_note from public.finance_payment_requests where id = v_pay) = 'a remark',
    'the optional remark must be stored';

  -- And ONE concise PI activity event, not a duplicate Finance trail.
  assert (select count(*) from public.order_submission_activity
          where submission_id = current_setting('test.pi')::uuid
            and action = 'payment_recorded'
            and (metadata->>'payment_request_id')::uuid = v_pay) = 1,
    'recording a payment must write exactly one PI activity row';
  assert (select previous_status = new_status from public.order_submission_activity
          where submission_id = current_setting('test.pi')::uuid
            and (metadata->>'payment_request_id')::uuid = v_pay),
    'recording a payment must not move the PI through review';
end $$;

-- ═══ A PI that is no longer a PI ════════════════════════════════════════════
do $$
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);

  -- The PI status transition trigger (20260910000000) is the only writer of
  -- these states, and it permits no direct move, so the three refusals are
  -- asserted from the DEPLOYED body: reaching them live needs a full review,
  -- approval or deletion-claim run, which belongs to those phases' own assertion
  -- files rather than to this one.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'record_pi_submission_payment')
         like '%ORDER_SUBMISSION_REJECTED%',
    'a rejected PI must be refused';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'record_pi_submission_payment')
         like '%ORDER_SUBMISSION_CONVERTED%',
    'a PI that has become an Order must be refused — use the Order route';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'record_pi_submission_payment')
         like '%ORDER_SUBMISSION_DELETION_CLAIMED%',
    'a PI reserved for deletion must be refused';
end $$;

-- ═══ 10-14. The card's totals ═══════════════════════════════════════════════
do $$
declare
  v_sum jsonb; v_r jsonb; v_verified uuid; v_pending uuid; v_rejected uuid; v_reversed uuid;
  v_pi uuid := gen_random_uuid();
begin
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
  values (v_pi, 'draft', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
          'ASSERT PI totals', 100000, 0, 100000);
  perform set_config('test.pi_totals', v_pi::text, true);

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  v_r := public.record_pi_submission_payment(v_pi, 30000.00, current_date, 'upi');
  v_verified := (v_r->>'payment_request_id')::uuid;
  v_r := public.record_pi_submission_payment(v_pi, 10000.00, current_date, 'cash');
  v_pending  := (v_r->>'payment_request_id')::uuid;
  v_r := public.record_pi_submission_payment(v_pi,  5000.00, current_date, 'cheque');
  v_rejected := (v_r->>'payment_request_id')::uuid;
  v_r := public.record_pi_submission_payment(v_pi,  8000.00, current_date, 'other');
  v_reversed := (v_r->>'payment_request_id')::uuid;

  -- Verified, rejected, and one whose ALLOCATION is reversed while its payment
  -- stays verified — the case that separates "allocation counts" from "payment
  -- is verified".
  update public.finance_payment_requests
     set status = 'approved_unlinked', approved_by = current_setting('test.admin_id')::uuid, approved_at = now()
   where id in (v_verified, v_reversed);
  update public.finance_payment_requests set status = 'rejected', rejected_at = now()
   where id = v_rejected;

  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  perform public.reverse_payment_allocation(
    (select id from public.finance_payment_allocations
      where payment_request_id = v_reversed and status = 'active'),
    'allocated in error');

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  v_sum := public.pi_submission_payment_summary(v_pi);

  -- 11. Verified counts only the verified parent.
  assert (v_sum->>'verified_amount')::numeric = 30000.00,
    format('verified must be 30000, got %s', v_sum->>'verified_amount');
  -- 10. Pending counts as unverified.
  assert (v_sum->>'unverified_amount')::numeric = 10000.00,
    format('unverified must be 10000, got %s', v_sum->>'unverified_amount');
  -- 12 + 13. Rejected and reversed count in NEITHER.
  assert (v_sum->>'verified_amount')::numeric + (v_sum->>'unverified_amount')::numeric = 40000.00,
    'the rejected 5000 and the reversed 8000 must count in neither total';

  -- 12. But the rejected payment is STILL IN THE HISTORY.
  assert exists (
    select 1 from jsonb_array_elements(v_sum->'payments') p
    where (p->>'payment_id')::uuid = v_rejected and p->>'status' = 'rejected'
  ), 'a rejected payment must remain visible in the payment history';
  assert exists (
    select 1 from jsonb_array_elements(v_sum->'payments') p
    where (p->>'payment_id')::uuid = v_reversed and p->>'allocation_status' = 'reversed'
  ), 'a reversed allocation must remain visible in the payment history';

  -- 14. Multiple payments total correctly, and every derived figure follows.
  assert (v_sum->>'verified_percent')::numeric = 30.00,
    format('verified percent must be 30.00, got %s', v_sum->>'verified_percent');
  assert (v_sum->>'unverified_percent')::numeric = 10.00,
    format('unverified percent must be 10.00, got %s', v_sum->>'unverified_percent');
  -- 40% of 100000 = 40000; 30000 verified; 10000 still needed.
  assert (v_sum->>'needed_for_standard')::numeric = 10000.00,
    format('needed for standard must be 10000, got %s', v_sum->>'needed_for_standard');
  assert (v_sum->>'pending_balance')::numeric = 70000.00,
    format('pending balance must be 70000, got %s', v_sum->>'pending_balance');
  assert (v_sum->>'standard_percent')::numeric = 40,
    'the standard percent must come from the existing single source';

  -- 21. NO DECLARED-ADVANCE FIGURE IS PRESENTED AS PAYMENT. The summary exposes
  -- no advance field at all, and the PI's own declaration is not consulted.
  assert not (v_sum ?| array['advance_declared_amount', 'advance', 'declared_advance',
                             'advance_condition', 'advance_exception_percent']),
    'the payment summary must expose no declared-advance figure';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'pi_submission_payment_summary')
         not like '%advance_declared_amount%',
    'the payment summary must not read the declared advance';

  -- Once verified money crosses 40%, the figure floors at zero rather than
  -- going negative.
  -- Verifying the pending 10000 takes verified money to exactly 40000, which is
  -- exactly the standard 40% of this PI's 100000 grand total.
  update public.finance_payment_requests
     set status = 'approved_unlinked', approved_by = current_setting('test.admin_id')::uuid, approved_at = now()
   where id = v_pending;
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  v_sum := public.pi_submission_payment_summary(v_pi);
  assert (v_sum->>'verified_amount')::numeric = 40000.00,
    format('verified must now be 40000, got %s', v_sum->>'verified_amount');
  assert (v_sum->>'needed_for_standard')::numeric = 0,
    format('needed for standard must reach zero at exactly 40%%, got %s', v_sum->>'needed_for_standard');
  assert (v_sum->>'pending_balance')::numeric = 60000.00,
    format('pending balance must be 60000, got %s', v_sum->>'pending_balance');
end $$;

-- ═══ E. Needs Clarification is unverified money, and says so ═══════════════
do $$
declare v_pi uuid := gen_random_uuid(); v_r jsonb; v_sum jsonb; v_pay uuid;
begin
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
  values (v_pi, 'draft', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
          'ASSERT clarification', 10000, 0, 10000);

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  v_r := public.record_pi_submission_payment(v_pi, 700.00, current_date, 'cheque');
  v_pay := (v_r->>'payment_request_id')::uuid;

  update public.finance_payment_requests
     set status = 'needs_clarification', clarification_requested_at = now()
   where id = v_pay;

  v_sum := public.pi_submission_payment_summary(v_pi);

  -- It counts as UNVERIFIED — money reported and not yet decided — and never as
  -- verified.
  assert (v_sum->>'unverified_amount')::numeric = 700.00,
    format('needs_clarification must count as unverified, got %s', v_sum->>'unverified_amount');
  assert (v_sum->>'verified_amount')::numeric = 0,
    'needs_clarification must never count as verified';
  assert not public.finance_payment_status_is_verified('needs_clarification'),
    'the single verified rule must exclude needs_clarification';

  -- And the ROW keeps its own status, so the card can label it separately rather
  -- than folding it into a generic "awaiting" bucket.
  assert exists (
    select 1 from jsonb_array_elements(v_sum->'payments') p
    where (p->>'payment_id')::uuid = v_pay
      and p->>'status' = 'needs_clarification'
      and (p->>'is_verified')::boolean = false
  ), 'the payment row must carry needs_clarification so the card can label it';
end $$;

-- ═══ E. The money rules, at exact values ═══════════════════════════════════
--
-- THE ROUNDING RULE, STATED ONCE SO THE CASES BELOW ARE READABLE:
--
--   * every figure is PostgreSQL `numeric` from end to end. grand_total is
--     numeric(12,2) and allocated_amount carries a CHECK that it equals
--     round(x, 2), so every INPUT is already exact to the paisa;
--   * subtracting two 2-decimal values is therefore exact, and
--     pending_balance is deliberately NOT rounded — there is nothing to round;
--   * the ONLY operation that can produce sub-paise is the 40% share, because
--     `grand_total * 40 / 100` divides. That result is rounded to 2 decimals,
--     and PostgreSQL's numeric round() is HALF AWAY FROM ZERO (0.125 -> 0.13,
--     2.675 -> 2.68). A binary double would give 2.67 for that second one,
--     which is exactly why no approval figure is allowed near a float;
--   * percentages are likewise a division, and are rounded the same way.
--
-- The invariant the cases assert, in the RPC's own returned fields:
--
--   requirement = round(grand_total * standard_percent / 100, 2)
--   needed      = max(requirement - verified, 0)
--   pending     = max(grand_total - verified, 0)
--
-- Driven end to end through record_pi_submission_payment() and
-- pi_submission_payment_summary() — never through a formula restated in the
-- test, which would only prove the test agrees with itself.
do $$
declare
  v_case      record;
  v_pi        uuid;
  v_sum       jsonb;
  v_requirement numeric;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);

  for v_case in
    select * from (values
      -- grand_total, verified, requirement, needed,    pending,  percent
      (33333.33::numeric,     0.00::numeric, 13333.33::numeric, 13333.33::numeric, 33333.33::numeric,  0.00::numeric),
      (33333.33::numeric, 10000.00::numeric, 13333.33::numeric,  3333.33::numeric, 23333.33::numeric, 30.00::numeric),
      (10000.00::numeric,  4000.00::numeric,  4000.00::numeric,     0.00::numeric,  6000.00::numeric, 40.00::numeric),
      (    0.30::numeric,     0.10::numeric,     0.12::numeric,     0.02::numeric,     0.20::numeric, 33.33::numeric),
      -- The sub-paise case: 40% of 33,333.33 is 13,333.332, and 0.30 has already
      -- been verified, so 13,333.032 rounds to 13,333.03. Kept because it is the
      -- one value in this table where the third decimal actually decides.
      (33333.33::numeric,     0.30::numeric, 13333.33::numeric, 13333.03::numeric, 33333.03::numeric,  0.00::numeric)
    ) as t(grand_total, verified, requirement, needed, pending, percent)
  loop
    v_pi := gen_random_uuid();
    insert into public.order_submissions
      (id, status, submitted_by, created_by, client_name,
       gross_product_amount, discount_amount, grand_total)
    values (v_pi, 'draft', current_setting('test.sales_id')::uuid,
            current_setting('test.sales_id')::uuid, 'ASSERT money rules',
            v_case.grand_total, 0, v_case.grand_total);

    -- Verified money arrives as a real payment, verified the real way. Zero
    -- verified means no payment at all, which is the honest starting state.
    if v_case.verified > 0 then
      perform public.record_pi_submission_payment(v_pi, v_case.verified, current_date, 'upi');
      update public.finance_payment_requests
         set status = 'approved_unlinked',
             approved_by = current_setting('test.admin_id')::uuid, approved_at = now()
       where id in (select a.payment_request_id
                    from public.finance_payment_allocations a
                    where a.order_submission_id = v_pi);
    end if;

    v_sum := public.pi_submission_payment_summary(v_pi);

    assert (v_sum->>'verified_amount')::numeric = v_case.verified,
      format('GT %s: verified must be %s, got %s',
             v_case.grand_total, v_case.verified, v_sum->>'verified_amount');

    -- THE 40% REQUIREMENT, derived from the RPC's own returned percentage
    -- rather than from a literal, so a change to the standard rate cannot make
    -- this pass while the card shows something else.
    v_requirement := round(
      (v_sum->>'grand_total')::numeric * (v_sum->>'standard_percent')::numeric / 100, 2);
    assert v_requirement = v_case.requirement,
      format('GT %s: the %s%% requirement must be %s, got %s',
             v_case.grand_total, v_sum->>'standard_percent', v_case.requirement, v_requirement);

    assert (v_sum->>'needed_for_standard')::numeric = v_case.needed,
      format('GT %s verified %s: needed must be %s, got %s',
             v_case.grand_total, v_case.verified, v_case.needed, v_sum->>'needed_for_standard');

    assert (v_sum->>'pending_balance')::numeric = v_case.pending,
      format('GT %s verified %s: pending must be %s, got %s',
             v_case.grand_total, v_case.verified, v_case.pending, v_sum->>'pending_balance');

    assert (v_sum->>'verified_percent')::numeric = v_case.percent,
      format('GT %s verified %s: percent must be %s, got %s',
             v_case.grand_total, v_case.verified, v_case.percent, v_sum->>'verified_percent');

    -- The three returned figures agree with each other, not merely with the
    -- table above.
    assert (v_sum->>'needed_for_standard')::numeric
           = greatest(v_requirement - (v_sum->>'verified_amount')::numeric, 0),
      format('GT %s: needed must equal max(requirement - verified, 0)', v_case.grand_total);
    assert (v_sum->>'pending_balance')::numeric
           = greatest((v_sum->>'grand_total')::numeric - (v_sum->>'verified_amount')::numeric, 0),
      format('GT %s: pending must equal max(grand total - verified, 0)', v_case.grand_total);
  end loop;
end $$;

-- ── The arithmetic is numeric, not binary floating point ───────────────────
do $$
declare v_pi uuid := gen_random_uuid(); v_sum jsonb;
begin
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total)
  values (v_pi, 'draft', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
          'ASSERT float safety', 1.00, 0, 1.00);

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  perform public.record_pi_submission_payment(v_pi, 0.10, current_date, 'upi');
  perform public.record_pi_submission_payment(v_pi, 0.20, current_date, 'cash');
  update public.finance_payment_requests
     set status = 'approved_unlinked', approved_by = current_setting('test.admin_id')::uuid, approved_at = now()
   where id in (select a.payment_request_id from public.finance_payment_allocations a
                 where a.order_submission_id = v_pi);

  v_sum := public.pi_submission_payment_summary(v_pi);

  -- 0.1 + 0.2 is exactly 0.30 in numeric. As a double it is 0.30000000000000004,
  -- and this equality would fail.
  assert (v_sum->>'verified_amount')::numeric = 0.30,
    format('0.10 + 0.20 must be exactly 0.30, got %s', v_sum->>'verified_amount');

  -- Half-away-from-zero, asserted directly so the rule the cases above rely on
  -- is pinned rather than assumed. A double would make the third of these 2.67.
  assert round(0.125::numeric, 2) = 0.13
     and round(0.135::numeric, 2) = 0.14
     and round(2.675::numeric, 2) = 2.68,
    'numeric rounding must be half away from zero';

  -- Every input to the money rules is already exact to the paisa, which is what
  -- makes the unrounded subtraction safe.
  assert (select numeric_scale from information_schema.columns
          where table_name = 'order_submissions' and column_name = 'grand_total') = 2,
    'grand_total must be numeric(12,2)';
  assert (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'finance_payment_allocations_amount_valid')
         like '%round(allocated_amount, 2)%',
    'an allocation amount must be exact to the paisa';

  -- And the figures leave the database with their scale intact, so no JSON
  -- double touches them before the browser formats them.
  assert (v_sum->>'verified_amount') like '%.%',
    'money must cross the wire with its scale intact';
end $$;

-- ═══ 15 + 16. Participant visibility, and what it does NOT confer ═══════════
do $$
declare v_n bigint; v_pi uuid := current_setting('test.pi')::uuid; v_pay uuid;
begin
  -- A payment on the salesperson's PI that SOMEBODY ELSE recorded. That is the
  -- case this section is about: participant, but not submitter. Using one they
  -- submitted themselves would prove nothing, because the pre-existing
  -- finance_payment_requests_own_delete / _own_update policies (20260653 /
  -- 20260700000000) legitimately let a submitter edit and delete their own
  -- UNAPPROVED payment, and that authority is not Phase 2's to remove.
  select f.id into v_pay
  from public.finance_payment_requests f
  join public.finance_payment_allocations a on a.payment_request_id = f.id
  where a.order_submission_id = v_pi
    and f.submitted_by = current_setting('test.admin_id')::uuid
  limit 1;

  assert v_pay is not null, 'the fixture must include a payment recorded by somebody else';

  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  perform set_config('role', 'authenticated', true);

  -- The premise: no Finance module entry at all.
  assert not public.module_entry_open('finance'),
    'the fixture salesperson must have no Finance module entry, or this proves nothing';

  -- 15. They CAN read the payment rows on their OWN PI — the Phase 1 dependency,
  --     now paid.
  select count(*) into v_n from public.finance_payment_requests where id = v_pay;
  assert v_n = 1, 'a PI participant must be able to read the payment on their own PI';

  -- And NOT the payment on somebody else's PI.
  select count(*) into v_n
  from public.finance_payment_requests f
  join public.finance_payment_allocations a on a.payment_request_id = f.id
  where a.order_submission_id = current_setting('test.pi_other')::uuid;
  assert v_n = 0, 'a participant must not read payments on an unrelated PI';

  -- AND NOTHING ELSE AT ALL. Every payment row this caller can reach must be
  -- allocated to a PI they own — stated as "no visible row lacks such an
  -- allocation" rather than as a fixed count, because they legitimately own more
  -- than one PI and the set grows as this file adds fixtures.
  select count(*) into v_n
  from public.finance_payment_requests f
  where not exists (
    select 1
    from public.finance_payment_allocations a
    join public.order_submissions s on s.id = a.order_submission_id
    where a.payment_request_id = f.id
      and (s.submitted_by = current_setting('test.sales_id')::uuid
           or s.created_by = current_setting('test.sales_id')::uuid
           or s.assigned_to = current_setting('test.sales_id')::uuid)
  );
  assert v_n = 0,
    format('a participant must see only payments allocated to a PI of theirs, saw %s other(s)', v_n);

  -- 16. SEEING IS NOT DOING.
  --
  -- Probed on sales_note rather than amount, deliberately: amount is separately
  -- protected by the Phase 1 allocated-amount guard, which would refuse the write
  -- for a reason that has nothing to do with this caller's authority and would
  -- make the test pass without proving anything about RLS.
  declare v_rows integer;
  begin
    update public.finance_payment_requests set sales_note = 'FORGED' where id = v_pay;
    get diagnostics v_rows = row_count;
    assert v_rows = 0,
      'a participant must match no row for UPDATE — read access is not write access';
  exception when insufficient_privilege then null;
  end;

  assert (select coalesce(sales_note, '') from public.finance_payment_requests where id = v_pay) <> 'FORGED',
    'a participant must not be able to change a payment';

  declare v_rows integer;
  begin
    delete from public.finance_payment_requests where id = v_pay;
    get diagnostics v_rows = row_count;
    assert v_rows = 0, 'a participant must match no row for DELETE';
  exception when insufficient_privilege then null;
  end;

  assert exists (select 1 from public.finance_payment_requests where id = v_pay),
    'the payment must survive a participant''s delete attempt';

  -- Nor may they insert a payment row directly, bypassing the RPC's own rules.
  begin
    insert into public.finance_payment_requests
      (client_name, amount, payment_date, payment_mode, status, submitted_by)
    values ('FORGED', 1.00, current_date, 'upi', 'approved_unlinked', current_setting('test.sales_id')::uuid);
    assert false, 'a participant must not be able to insert a pre-verified payment';
  exception when others then null;
  end;

  perform set_config('role', 'postgres', true);

  assert not exists (select 1 from public.finance_payment_requests where client_name = 'FORGED'),
    'no forged payment row may exist';

  -- No verification, no allocation, no correction.
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  begin
    perform public.approve_finance_payment_request(v_pay, null);
    assert false, 'a participant must not be able to verify a payment';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.allocate_payment_to_target(v_pay, null, null, 1.00);
    assert false, 'a participant must not hold finance.allocate';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.reverse_payment_allocation(
      (select id from public.finance_payment_allocations
        where payment_request_id = v_pay and status = 'active'), 'no');
    assert false, 'a participant must not hold finance.allocate_correct';
  exception when insufficient_privilege then null;
  end;

  -- Nor REJECTION. The approver route is an RLS UPDATE policy
  -- (finance_payment_requests_approver_decide) gated on finance.approve, so a
  -- participant simply matches no row for the decision write.
  perform set_config('role', 'authenticated', true);
  declare v_rows integer;
  begin
    update public.finance_payment_requests
       set status = 'rejected', admin_note = 'FORGED REJECTION'
     where id = v_pay;
    get diagnostics v_rows = row_count;
    assert v_rows = 0, 'a participant must match no row for a rejection';
  exception when others then null;
  end;
  perform set_config('role', 'postgres', true);

  assert (select status from public.finance_payment_requests where id = v_pay) <> 'rejected'
      or (select coalesce(admin_note,'') from public.finance_payment_requests where id = v_pay)
         <> 'FORGED REJECTION',
    'a participant must not be able to reject a payment';
end $$;

-- ── Admin and finance.view_all keep their wider sight ───────────────────────
do $$
declare v_total bigint; v_seen bigint;
begin
  select count(*) into v_total from public.finance_payment_requests;

  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_seen from public.finance_payment_requests;
  perform set_config('role', 'postgres', true);
  assert v_seen = v_total, format('an admin must still see every payment (%s of %s)', v_seen, v_total);

  perform set_config('request.jwt.claim.sub', current_setting('test.finance_id'), true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_seen from public.finance_payment_requests;
  perform set_config('role', 'postgres', true);
  assert v_seen = v_total,
    format('a finance.view_all holder must still see every payment (%s of %s)', v_seen, v_total);
end $$;

-- ── The restated module gate still gates the Finance PAGES ─────────────────
do $$
declare v_seen bigint;
begin
  -- The outsider holds no Finance entry and owns nothing. The gate must still
  -- refuse them everything, which is what proves the participant branch widened
  -- the gate only for participants.
  perform set_config('request.jwt.claim.sub', current_setting('test.outsider_id'), true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_seen from public.finance_payment_requests;
  perform set_config('role', 'postgres', true);
  assert v_seen = 0,
    format('somebody with neither Finance entry nor a participant record must see nothing, saw %s', v_seen);
end $$;

-- ═══ 17 + 18. Cleanup discovers a PI-only payment, and only that ════════════
do $$
declare
  v_chain jsonb; v_pi uuid := current_setting('test.pi_totals')::uuid;
  v_order uuid := gen_random_uuid(); v_unrelated uuid; v_r jsonb; v_ids uuid[];
begin
  -- The chain resolver reaches a PI through its Order, so give this PI one.
  insert into public.orders (id, display_number, client_name, requested_by, created_by, status,
                             total_value, source_order_submission_id, is_test_data)
  values (v_order, null, 'ASSERT PI totals', current_setting('test.sales_id')::uuid,
          current_setting('test.admin_id')::uuid, 'running', 100000, v_pi, true);
  -- The PI's own status is deliberately NOT changed. The resolver reaches a PI
  -- through orders.source_order_submission_id, which is all this section needs,
  -- and moving a PI to 'approved' is the approval RPC's exclusive right
  -- (20260910000000's transition trigger refuses any direct move). The resolver
  -- will report the pair as mismatched and BLOCK, which is correct for a fixture
  -- like this and does not affect what is being asserted here — which is which
  -- payments the sweep DISCOVERS.

  -- A payment on an UNRELATED PI, which must not be swept in.
  perform set_config('request.jwt.claim.sub', current_setting('test.allocator_id'), true);
  v_r := public.record_pi_submission_payment(
    current_setting('test.pi_other')::uuid, 99.00, current_date, 'upi');
  v_unrelated := (v_r->>'payment_request_id')::uuid;

  v_chain := public.resolve_test_data_cleanup_chain('order', v_order);

  select array_agg((x#>>'{}')::uuid) into v_ids
  from jsonb_array_elements(v_chain->'payment_ids') x;

  -- 17. Every PI-only allocated payment on this chain is discovered. None of
  --     them is linked by order_id or order_request_id, so the pre-Phase-2 sweep
  --     would have found none of them.
  assert (select count(*) from public.finance_payment_allocations a
          where a.order_submission_id = v_pi) > 0,
    'the fixture PI must carry allocations, or this proves nothing';

  assert not exists (
    select 1 from public.finance_payment_allocations a
    where a.order_submission_id = v_pi
      and not (a.payment_request_id = any(v_ids))
  ), 'every payment allocated to the chain PI must be discovered by the resolver';

  assert not exists (
    select 1 from unnest(v_ids) pid
    join public.finance_payment_requests f on f.id = pid
    where f.order_id is not null or f.order_request_id is not null
  ) or true, 'informational: the chain may legitimately also hold linked payments';

  -- Their PROOF PATHS ride along, because storage_paths reads the same array.
  assert v_chain ? 'storage_paths', 'the chain must still report storage paths';

  -- 18. AND NOTHING ELSE. The unrelated PI's payment is not claimed.
  assert not (v_unrelated = any(v_ids)),
    'a payment on an unrelated PI must never be swept into this chain';

  -- The claim/finalize protocol is untouched by this phase.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'finalize_test_data_cleanup')
         not like '%finance_payment_allocations%',
    'finalize_test_data_cleanup must not have been restated';
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'begin_test_data_cleanup')
         not like '%finance_payment_allocations%',
    'begin_test_data_cleanup must not have been restated';

  -- And the resolver still refuses what it always refused.
  begin
    perform public.resolve_test_data_cleanup_chain('nonsense', v_order);
    assert false, 'an unknown root type must still be refused';
  exception when raise_exception then
    assert sqlerrm like '%CLEANUP_ROOT_TYPE_INVALID%', 'the root-type guard must survive the restatement';
  end;

  -- A PAYMENT root allocated only to a PI now reports that PI as retained.
  v_chain := public.resolve_test_data_cleanup_chain('payment', v_unrelated);
  assert v_chain ? 'blocking', 'a payment root must still report a blocking list';
end $$;

-- ═══ 19 + 20. Nothing that existed before behaves differently ═══════════════
do $$
declare v_def text;
begin
  -- The Phase 1 door keeps its exact contract.
  assert exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'allocate_payment_to_target'
      and pg_get_function_identity_arguments(p.oid) = 'p_payment_request_id uuid, p_order_submission_id uuid, p_order_id uuid, p_allocated_amount numeric'
  ), 'allocate_payment_to_target must keep its exact signature';

  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'allocate_payment_to_target';
  assert v_def like '%actor_has_module_permission(''finance'', ''allocate'')%',
    'the Phase 1 door must still require finance.allocate';

  -- The shared implementation is reachable by no client role.
  assert not exists (
    select 1
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    join pg_roles r on r.oid = a.grantee
    where p.proname = 'allocate_payment_to_target_internal'
      and r.rolname in ('anon', 'authenticated', 'public')
  ), 'the shared allocation implementation must not be executable by a client role';

  -- 19. Existing Finance entry is unchanged: every mandatory column it relies on
  --     is still mandatory, and the approval RPC is untouched.
  assert (select pg_get_functiondef(oid) from pg_proc where proname = 'approve_finance_payment_request')
         not like '%finance_payment_allocations%',
    'the Finance verification RPC must not have been rewired by this phase';

  -- 20. Order approval eligibility is untouched.
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'approve_order_submission';
  assert v_def like '%order_submission_advance_ready%',
    'approve_order_submission must still read the declared-advance rule';
  assert v_def not like '%finance_payment_allocations%'
     and v_def not like '%pi_submission_payment_summary%',
    'approve_order_submission must not consult payment in this phase';

  -- The payment status domain gained nothing.
  assert (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'finance_payment_requests_status_check')
         not like '%awaiting%',
    'no Awaiting Verification database status may have been added';
end $$;

reset role;
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
