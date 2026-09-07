-- PI REVIEW GATE, PI VERSIONS AND PRODUCTION ALIGNMENT assertions (20261119000000)
-- ===========================================================================
-- Validates:
--
--   * submission   submit_pi_for_review()       reason owed below 40% ATTACHED
--                                               (verified + awaiting), zero
--                                               included; approved + pending
--                                               both count; the server decides
--   * PI decision  approve_pi_review()          the PI approved on its own —
--                                               no Order, no number, no money
--   * the gate     approve_order_submission()   unresolved payment creates no
--                                               Order; both gates → exactly one
--   * independence a payment verified while the PI is held; a PI approved while
--                  the payment is unresolved
--   * exception    recorded on submission, required before confirmation
--   * production   orders.production_alignment defaults to not_aligned; moved
--                  only by set_order_production_alignment() under
--                  orders.align_production
--   * versions     order_pi_versions: propose / reject / one current / one
--                  pending / no overwrite / immutable / stale refused
--   * authority    unauthorised callers refused at every door
--   * audit        the events each door writes
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES (controlled environment, 20261119000000 applied):
--   * psql as a role that bypasses RLS and may SET the `role` GUC.
--   * The Confirmed Order numbering cycle is configured (20260703000000).
--   * The `order-files` storage bucket exists.
--   * Replace the FIVE user UUIDs below:
--       test.admin_id        -> role = 'admin', active
--       test.sales_id        -> NON-admin, orders.view + orders.create, no Finance
--       test.finance_id      -> NON-admin, finance.view + finance.approve
--       test.factory_id      -> NON-admin, orders.view + orders.align_production
--       test.outsider_id     -> NON-admin with no Orders and no Finance relationship
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.admin_id',    '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.sales_id',    '55555555-5555-5555-5555-555555555555', true); -- REPLACE
  perform set_config('test.finance_id',  '66666666-6666-6666-6666-666666666666', true); -- REPLACE
  perform set_config('test.factory_id',  '77777777-7777-7777-7777-777777777777', true); -- REPLACE
  perform set_config('test.outsider_id', '44444444-4444-4444-4444-444444444444', true); -- REPLACE

  perform set_config('test.pi_a', gen_random_uuid()::text, true);  -- 20% verified + 20% pending
  perform set_config('test.pi_b', gen_random_uuid()::text, true);  -- 10% verified + 10% pending
  perform set_config('test.pi_c', gen_random_uuid()::text, true);  -- nothing attached
  perform set_config('test.pi_d', gen_random_uuid()::text, true);  -- 0 verified + 40% pending
  perform set_config('test.pi_e', gen_random_uuid()::text, true);  -- 40% verified, then held
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. FIXTURES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Complete PIs — a stored workbook, one product line with one representative
-- image, both objects present in storage — so every refusal below is the one
-- being asserted and not a completeness one. reservation_required = false: the
-- Order-number reservation (20261009000000) is a separate, tested rule.

create function pg_temp.make_pi(p_id uuid, p_owner uuid, p_client text, p_total numeric)
returns void language plpgsql as $$
declare
  v_item uuid := gen_random_uuid();
  v_wb   text := 'submissions/' || p_id::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha  text := repeat('a', 64);
  v_img  text;
begin
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount,
     grand_total, source_workbook_path, source_workbook_sha256, parse_warnings, parse_blocking_issues,
     reservation_required)
  values
    (p_id, 'draft', p_owner, p_owner, p_client, p_total, 0, p_total, v_wb, v_sha, '[]', '[]', false);

  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_wb,
          jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));

  insert into public.order_submission_items
    (id, submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_item, p_id, 10, '1', 'ASSERT chair', 1, p_total, p_total, 0);

  v_img := 'submissions/' || p_id::text || '/images/' || v_item::text || '/representative/0-' || v_sha || '.png';
  insert into public.order_submission_item_images
    (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  values (p_id, v_item, 'representative', 0, v_img, 'image/png', v_sha, 10);
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_img, jsonb_build_object('mimetype', 'image/png'));
end $$;

create function pg_temp.pay(p_pi uuid, p_owner uuid, p_amount numeric, p_status text)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_id, 'ASSERT', p_amount, current_date, 'hdfc', p_status, p_owner, null);
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_id, p_pi, p_amount, 'order_submission', p_owner);
  return v_id;
end $$;

-- Impersonate an authenticated user for the statements that follow.
create function pg_temp.become(p_user uuid) returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
end $$;
create function pg_temp.restore() returns void language plpgsql as $$
begin
  execute 'reset role';
end $$;

do $$
declare v_sales uuid := current_setting('test.sales_id')::uuid;
begin
  perform pg_temp.make_pi(current_setting('test.pi_a')::uuid, v_sales, 'ASSERT A attached 40', 1000000);
  perform pg_temp.make_pi(current_setting('test.pi_b')::uuid, v_sales, 'ASSERT B attached 20', 1000000);
  perform pg_temp.make_pi(current_setting('test.pi_c')::uuid, v_sales, 'ASSERT C nothing',     1000000);
  perform pg_temp.make_pi(current_setting('test.pi_d')::uuid, v_sales, 'ASSERT D pending 40',  1000000);
  perform pg_temp.make_pi(current_setting('test.pi_e')::uuid, v_sales, 'ASSERT E held',        1000000);

  perform pg_temp.pay(current_setting('test.pi_a')::uuid, v_sales, 200000, 'approved_unlinked');
  perform pg_temp.pay(current_setting('test.pi_a')::uuid, v_sales, 200000, 'pending_approval');
  perform pg_temp.pay(current_setting('test.pi_b')::uuid, v_sales, 100000, 'approved_unlinked');
  perform pg_temp.pay(current_setting('test.pi_b')::uuid, v_sales, 100000, 'pending_approval');
  perform set_config('test.pay_d',
    pg_temp.pay(current_setting('test.pi_d')::uuid, v_sales, 400000, 'pending_approval')::text, true);
  perform pg_temp.pay(current_setting('test.pi_e')::uuid, v_sales, 400000, 'approved_unlinked');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SUBMISSION IS JUDGED ON ATTACHED PAYMENT, BY THE SERVER
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_a   uuid := current_setting('test.pi_a')::uuid;
  v_b   uuid := current_setting('test.pi_b')::uuid;
  v_c   uuid := current_setting('test.pi_c')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_sum jsonb;
  v_res jsonb;
  v_msg text;
begin
  -- The helper sums verified + awaiting, and the summary reports it.
  assert public.order_submission_attached_payment(v_a) = 400000,
    'attached must be verified + awaiting verification';

  perform pg_temp.become(v_sales);
  v_sum := public.pi_submission_payment_summary(v_a);
  perform pg_temp.restore();
  assert (v_sum ->> 'attached_amount')::numeric = 400000, 'attached_amount is reported';
  assert (v_sum ->> 'attached_percent')::numeric = 40, 'attached_percent is reported';
  assert (v_sum ->> 'attached_meets_standard')::boolean, 'attached meets the standard';
  assert v_sum ->> 'submission_position' = 'attached_met';
  assert not (v_sum ->> 'meets_standard')::boolean, 'while VERIFIED alone (20%) does not';
  assert v_sum ->> 'approval_position' = 'verification_pending', 'and the Order gate says so';

  -- A. =40% ATTACHED (20% verified + 20% pending): no reason owed. A reason
  --    sent anyway is ignored — the server decides the route, not the client.
  perform pg_temp.become(v_sales);
  v_res := public.submit_pi_for_review(v_a, null, 'a reason the client typed', null, null);
  perform pg_temp.restore();
  assert v_res ->> 'payment_route' = 'standard', 'A: attached at 40% is the standard route';
  assert not (v_res ->> 'exception_requested')::boolean, 'A: no exception is raised';
  assert (select advance_exception_status from public.order_submissions where id = v_a) is null,
    'A: and none is stored';
  assert (select status from public.order_submissions where id = v_a) = 'submitted';

  -- B. <40% ATTACHED (10% + 10%): a reason is mandatory.
  perform pg_temp.become(v_sales);
  begin
    perform public.submit_pi_for_review(v_b, null, null, '50% before dispatch', null);
    perform pg_temp.restore();
    raise exception 'B: submitting below 40%% attached without a reason must be refused';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.restore();
    assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED%', v_msg;
  end;
  perform pg_temp.become(v_sales);
  v_res := public.submit_pi_for_review(v_b, null, 'client pays balance on delivery', '50% before dispatch', null);
  perform pg_temp.restore();
  assert v_res ->> 'payment_route' = 'exception' and (v_res ->> 'exception_requested')::boolean;
  assert (select advance_exception_reason from public.order_submissions where id = v_b)
       = 'client pays balance on delivery', 'B: the reason is stored permanently';
  assert (select advance_exception_status from public.order_submissions where id = v_b) = 'pending';
  assert exists (select 1 from public.order_submission_activity
                 where submission_id = v_b and action = 'advance_exception_requested'
                   and (metadata ->> 'attached_payment')::numeric = 200000),
    'B: the exception event carries the attached figure';

  -- C. NOTHING ATTACHED: the same rule, never a waiver.
  perform pg_temp.become(v_sales);
  begin
    perform public.submit_pi_for_review(v_c, null, null, '100% before dispatch', null);
    perform pg_temp.restore();
    raise exception 'C: submitting with no payment and no reason must be refused';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.restore();
    assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED%', v_msg;
  end;
  perform pg_temp.become(v_sales);
  v_sum := public.pi_submission_payment_summary(v_c);
  assert v_sum ->> 'submission_position' = 'no_payment';
  v_res := public.submit_pi_for_review(v_c, null, 'repeat client, pays on delivery', '100% before dispatch', null);
  perform pg_temp.restore();
  assert (select advance_exception_status from public.order_submissions where id = v_c) = 'pending',
    'C: the no-payment exception is recorded';

  raise notice '1. attached-payment submission rule OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE PI DECISION IS SEPARABLE FROM THE ORDER; UNRESOLVED PAYMENT CREATES NONE
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_d      uuid := current_setting('test.pi_d')::uuid;
  v_admin  uuid := current_setting('test.admin_id')::uuid;
  v_sales  uuid := current_setting('test.sales_id')::uuid;
  v_fin    uuid := current_setting('test.finance_id')::uuid;
  v_out    uuid := current_setting('test.outsider_id')::uuid;
  v_pay    uuid := current_setting('test.pay_d')::uuid;
  v_before integer;
  v_res    jsonb;
  v_msg    text;
  v_order  uuid;
  v_sub    public.order_submissions%rowtype;
begin
  -- D is submitted on the standard route: 40% ATTACHED, all of it pending.
  perform pg_temp.become(v_sales);
  v_res := public.submit_pi_for_review(v_d, null, null, null, null);
  perform pg_temp.restore();
  assert v_res ->> 'payment_route' = 'standard';

  -- The finance CHECK, written directly: this section is about the gate.
  update public.order_submissions
     set finance_verified_by = v_admin, finance_verified_at = now(),
         finance_verified_submission_at = submitted_at
   where id = v_d;

  select count(*) into v_before from public.orders;

  -- An outsider may not approve the PI.
  perform pg_temp.become(v_out);
  begin
    perform public.approve_pi_review(v_d);
    perform pg_temp.restore();
    raise exception 'an outsider must not approve a PI';
  exception when sqlstate '42501' then
    perform pg_temp.restore();
  end;

  -- The reviewer approves the PI ITSELF. Nothing else happens.
  perform pg_temp.become(v_admin);
  v_res := public.approve_pi_review(v_d);
  perform pg_temp.restore();
  assert (v_res ->> 'pi_approved')::boolean and not (v_res ->> 'already_approved')::boolean;
  select * into v_sub from public.order_submissions where id = v_d;
  assert v_sub.status = 'submitted', 'the PI stays submitted';
  assert v_sub.pi_approved_by = v_admin and v_sub.pi_approved_submission_at = v_sub.submitted_at;
  assert v_sub.order_id is null, 'no Order';
  assert (select count(*) from public.orders) = v_before, 'no Order row';
  assert exists (select 1 from public.order_submission_activity
                 where submission_id = v_d and action = 'pi_approved'), 'the decision is on the trail';

  -- Idempotent.
  perform pg_temp.become(v_admin);
  v_res := public.approve_pi_review(v_d);
  perform pg_temp.restore();
  assert (v_res ->> 'already_approved')::boolean;
  assert (select count(*) from public.order_submission_activity
          where submission_id = v_d and action = 'pi_approved') = 1, 'and writes no second event';

  -- The Order gate still refuses: the money is with Finance.
  perform pg_temp.become(v_admin);
  begin
    perform public.approve_order_submission(v_d);
    perform pg_temp.restore();
    raise exception 'unresolved payment must not create a Confirmed Order';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.restore();
    assert v_msg like 'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION%', v_msg;
  end;
  assert (select count(*) from public.orders) = v_before, 'still no Order';
  assert (select pi_approved_at from public.order_submissions where id = v_d) is not null,
    'and the PI decision survives the refusal, because it was taken by its own door';

  -- Finance verifies the payment — a decision the PI review never took.
  -- An outsider may not; a Finance approver may.
  perform pg_temp.become(v_out);
  begin
    perform public.approve_finance_payment_request(v_pay, null);
    perform pg_temp.restore();
    raise exception 'an outsider must not verify a payment';
  exception when sqlstate '42501' then
    perform pg_temp.restore();
  end;

  -- The echo is a DEFERRED trigger; fire it now so the trail can be read
  -- inside this transaction.
  set constraints finance_payment_requests_echo_decision immediate;
  perform pg_temp.become(v_fin);
  perform public.approve_finance_payment_request(v_pay, 'ASSERT verified');
  perform pg_temp.restore();
  assert exists (select 1 from public.order_submission_activity
                 where submission_id = v_d and action = 'payment_verified'
                   and (metadata ->> 'allocated_amount')::numeric = 400000),
    'Finance''s decision is echoed onto the PI trail with the allocated share';

  -- BOTH GATES CLEARED: the same door creates the Order, exactly once.
  perform pg_temp.become(v_admin);
  v_res := public.approve_order_submission(v_d);
  perform pg_temp.restore();
  v_order := (v_res ->> 'order_id')::uuid;
  assert not (v_res ->> 'already_approved')::boolean;
  assert (select count(*) from public.orders) = v_before + 1, 'exactly one Order';
  perform set_config('test.order_d', v_order::text, true);

  perform pg_temp.become(v_admin);
  v_res := public.approve_order_submission(v_d);
  perform pg_temp.restore();
  assert (v_res ->> 'already_approved')::boolean and (v_res ->> 'order_id')::uuid = v_order,
    'a retry finds the Order it already made';
  assert (select count(*) from public.orders) = v_before + 1, 'and makes no second one';

  -- The trail reads PI approved, then Confirmed Order created.
  assert (select min(created_at) from public.order_submission_activity where submission_id = v_d and action = 'pi_approved')
       <= (select min(created_at) from public.order_submission_activity where submission_id = v_d and action = 'approved');
  assert exists (select 1 from public.order_activity_log
                 where order_id = v_order and event_type = 'order_created_from_pi_submission');

  -- The Order is born NOT ALIGNED, and carries V1 of its PI history.
  assert (select production_alignment from public.orders where id = v_order) = 'not_aligned';
  assert (select count(*) from public.order_pi_versions where order_id = v_order and status = 'approved' and version_number = 1) = 1,
    'V1 is the PI the Order was approved from';

  raise notice '2. PI decision, gate and exactly-one Order OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. PAYMENT APPROVED, PI HELD — AND THE EXCEPTION IS REQUIRED BEFORE CONFIRMATION
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_e     uuid := current_setting('test.pi_e')::uuid;
  v_c     uuid := current_setting('test.pi_c')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_res   jsonb;
  v_msg   text;
  v_before integer;
begin
  -- E: verified at 40%, then HELD by management with a reason. The payment is
  -- untouched; the PI decision (if any) is cleared by the move.
  perform pg_temp.become(v_sales);
  perform public.submit_pi_for_review(v_e, null, null, null, null);
  perform pg_temp.restore();
  update public.order_submissions
     set finance_verified_by = v_admin, finance_verified_at = now(), finance_verified_submission_at = submitted_at
   where id = v_e;
  perform pg_temp.become(v_admin);
  perform public.approve_pi_review(v_e);
  perform public.request_order_submission_changes(v_e, 'line 3 quantity is wrong');
  perform pg_temp.restore();
  assert (select status from public.order_submissions where id = v_e) = 'needs_changes';
  assert (select pi_approved_at from public.order_submissions where id = v_e) is null,
    'a held PI carries no standing PI decision';
  assert (select count(*) from public.finance_payment_requests f
          join public.finance_payment_allocations a on a.payment_request_id = f.id
          where a.order_submission_id = v_e and f.status = 'approved_unlinked') = 1,
    'the verified payment is untouched by the hold';

  -- C: nothing attached, exception pending. PI approved; the Order waits for
  -- the explicit exception decision.
  update public.order_submissions
     set finance_verified_by = v_admin, finance_verified_at = now(), finance_verified_submission_at = submitted_at
   where id = v_c;
  perform pg_temp.become(v_admin);
  perform public.approve_pi_review(v_c);
  perform pg_temp.restore();
  select count(*) into v_before from public.orders;
  perform pg_temp.become(v_admin);
  begin
    perform public.approve_order_submission(v_c);
    perform pg_temp.restore();
    raise exception 'a pending exception must not be inferred as approved';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.restore();
    assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_PENDING%', v_msg;
  end;
  assert (select count(*) from public.orders) = v_before;

  perform pg_temp.become(v_admin);
  perform public.approve_pi_advance_exception(v_c);
  v_res := public.approve_order_submission(v_c);
  perform pg_temp.restore();
  assert (select count(*) from public.orders) = v_before + 1,
    'an explicitly approved exception clears the gate';
  assert v_res ->> 'payment_route' = 'exception';

  raise notice '3. hold independence and exception requirement OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. PRODUCTION ALIGNMENT
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_order   uuid := current_setting('test.order_d')::uuid;
  v_factory uuid := current_setting('test.factory_id')::uuid;
  v_sales   uuid := current_setting('test.sales_id')::uuid;
  v_res     jsonb;
  v_msg     text;
begin
  perform pg_temp.become(v_sales);
  begin
    perform public.set_order_production_alignment(v_order, true, null);
    perform pg_temp.restore();
    raise exception 'orders.create does not align an Order for production';
  exception when sqlstate '42501' then
    perform pg_temp.restore();
  end;

  begin
    update public.orders set production_alignment = 'aligned' where id = v_order;
    raise exception 'a direct write must not move the alignment';
  exception when sqlstate '42501' then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ORDER_PRODUCTION_ALIGNMENT_PATH_REQUIRED%', v_msg;
  end;

  perform pg_temp.become(v_factory);
  v_res := public.set_order_production_alignment(v_order, true, 'feasibility and costing checked');
  perform pg_temp.restore();
  assert v_res ->> 'production_alignment' = 'aligned' and not (v_res ->> 'unchanged')::boolean;
  assert (select production_aligned_by from public.orders where id = v_order) = v_factory;
  assert exists (select 1 from public.order_activity_log
                 where order_id = v_order and event_type = 'production_alignment_changed'
                   and payload ->> 'to' = 'aligned');

  perform pg_temp.become(v_factory);
  v_res := public.set_order_production_alignment(v_order, true, null);
  perform pg_temp.restore();
  assert (v_res ->> 'unchanged')::boolean, 'aligning an aligned Order is a no-op';

  raise notice '4. production alignment OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. PI VERSIONS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_order uuid := current_setting('test.order_d')::uuid;
  v_d     uuid := current_setting('test.pi_d')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_out   uuid := current_setting('test.outsider_id')::uuid;
  v_v1    uuid;
  v_v2    uuid;
  v_v3    uuid;
  v_path2 text := 'submissions/' || v_d::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_path3 text := 'submissions/' || v_d::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_res   jsonb;
  v_msg   text;
begin
  select id into v_v1 from public.order_pi_versions where order_id = v_order and status = 'approved';
  insert into storage.objects (bucket_id, name, metadata) values
    ('order-files', v_path2, jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
    ('order-files', v_path3, jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));

  -- An outsider may not propose.
  perform pg_temp.become(v_out);
  begin
    perform public.propose_order_pi_revision(v_order, v_path2, 'v2.xlsx', 'because');
    perform pg_temp.restore();
    raise exception 'an outsider must not propose a revision';
  exception when sqlstate '42501' then
    perform pg_temp.restore();
  end;

  -- The owner proposes V2. Nothing on the Order or the current PI moves.
  perform pg_temp.become(v_sales);
  v_res := public.propose_order_pi_revision(v_order, v_path2, 'v2.xlsx', 'client changed line 3');
  perform pg_temp.restore();
  v_v2 := (v_res ->> 'version_id')::uuid;
  assert (v_res ->> 'version_number')::integer = 2 and v_res ->> 'status' = 'pending';
  assert (select status from public.order_pi_versions where id = v_v1) = 'approved', 'V1 stays current';
  assert (select source_workbook_path from public.order_submissions where id = v_d) <> v_path2,
    'the current PI is not overwritten';

  -- Only one open revision.
  perform pg_temp.become(v_sales);
  begin
    perform public.propose_order_pi_revision(v_order, v_path3, 'v3.xlsx', 'again');
    perform pg_temp.restore();
    raise exception 'a second open revision must be refused';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.restore();
    assert v_msg like 'ORDER_PI_REVISION_PENDING%', v_msg;
  end;

  -- Deciding is an admin's. The owner may not; the admin needs a reason.
  perform pg_temp.become(v_sales);
  begin
    perform public.reject_order_pi_revision(v_v2, 'no');
    perform pg_temp.restore();
    raise exception 'the owner must not decide their own revision';
  exception when sqlstate '42501' then
    perform pg_temp.restore();
  end;
  perform pg_temp.become(v_admin);
  begin
    perform public.reject_order_pi_revision(v_v2, '  ');
    perform pg_temp.restore();
    raise exception 'a rejection needs a reason';
  exception when sqlstate 'P0001' then
    perform pg_temp.restore();
  end;
  perform pg_temp.become(v_admin);
  perform public.reject_order_pi_revision(v_v2, 'wrong quantity on line 3');
  perform pg_temp.restore();
  assert (select status from public.order_pi_versions where id = v_v2) = 'rejected';
  assert (select decision_reason from public.order_pi_versions where id = v_v2) = 'wrong quantity on line 3',
    'the rejected revision keeps its reason';
  assert (select status from public.order_pi_versions where id = v_v1) = 'approved', 'V1 still current';
  assert exists (select 1 from public.order_submission_activity where submission_id = v_d and action = 'pi_revision_rejected');
  assert exists (select 1 from public.order_activity_log where order_id = v_order and event_type = 'pi_revision_rejected');

  -- The service-role door is not client-callable.
  assert not has_function_privilege('authenticated', 'public.approve_order_pi_revision(uuid, uuid, jsonb)', 'execute');

  -- V3 proposed. The version state cannot be corrupted from underneath:
  perform pg_temp.become(v_sales);
  v_res := public.propose_order_pi_revision(v_order, v_path3, 'v3.xlsx', 'second correction');
  perform pg_temp.restore();
  v_v3 := (v_res ->> 'version_id')::uuid;

  -- a rejected version cannot become current;
  begin
    update public.order_pi_versions set status = 'approved', decided_by = v_admin, decided_at = now() where id = v_v2;
    raise exception 'a rejected revision must not become current';
  exception when sqlstate '42501' then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ORDER_PI_VERSION_TRANSITION_INVALID%', v_msg;
  end;
  -- two versions cannot both be current, whatever the caller;
  begin
    update public.order_pi_versions set status = 'approved', decided_by = v_admin, decided_at = now() where id = v_v3;
    raise exception 'two approved versions on one Order must be refused';
  exception when unique_violation then
    null;
  end;
  -- history cannot be deleted;
  begin
    delete from public.order_pi_versions where id = v_v2;
    raise exception 'a version row must not be deletable';
  exception when sqlstate '42501' then
    null;
  end;
  -- the approval door refuses a parse of the wrong file, before touching anything.
  begin
    perform public.approve_order_pi_revision(v_v3, v_admin,
      jsonb_build_object('source', jsonb_build_object('workbook_path', v_path2)));
    raise exception 'a payload for another file must be refused';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ORDER_PI_REVISION_FILE_MISMATCH%', v_msg;
  end;
  assert (select status from public.order_pi_versions where id = v_v3) = 'pending';
  assert (select status from public.order_pi_versions where id = v_v1) = 'approved';

  -- The one legal way V3 becomes current: V1 superseded first, then V3 approved.
  update public.order_pi_versions
     set status = 'superseded', superseded_at = now(), superseded_by_version_id = v_v3 where id = v_v1;
  update public.order_pi_versions
     set status = 'approved', decided_by = v_admin, decided_at = now() where id = v_v3;
  assert (select count(*) from public.order_pi_versions where order_id = v_order and status = 'approved') = 1,
    'exactly one current version';
  assert (select workbook_path from public.order_pi_versions where id = v_v1) is not null,
    'the previous version remains available';
  begin
    update public.order_pi_versions set status = 'pending' where id = v_v3;
    raise exception 'an approved version cannot go back to pending';
  exception when sqlstate '42501' then
    null;
  end;

  raise notice '5. PI versions OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. AUTHORITY, ONE MORE TIME, AT THE ORDER DOOR
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_b     uuid := current_setting('test.pi_b')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
begin
  perform pg_temp.become(v_sales);
  begin
    perform public.approve_order_submission(v_b);
    perform pg_temp.restore();
    raise exception 'orders.create must not approve an Order';
  exception when sqlstate '42501' then
    perform pg_temp.restore();
  end;

  -- The Order side may read the source PI's trail.
  assert exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'order_submission_activity'
                 and policyname = 'order_submission_activity_confirmed_order_select');

  raise notice '6. authority OK';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
