-- PI NUMBERING AT CONVERSION, DRAFT REFERENCE AND THE THREE REASONS (20270102000000)
-- ===========================================================================
-- Validates, through the real doors:
--
--   1. a new draft   gets a PID- reference, reserves NO Order number when its
--                    workbook lands, and leaves the cycle where it was
--   2. conversion    approve_order_submission gives it the NEXT cycle number;
--                    a failed approval rolls the cycle back, so the retry takes
--                    the same number (nothing skipped, nothing duplicated)
--   3. reserved      an existing draft holding a reservation keeps it; its
--                    Order takes exactly that number and the cycle is untouched
--   4. abandoned     rejecting or deleting a new draft consumes no number
--   5. retired       reserve_order_number_for_submission refuses by name
--   6. reference     draft_reference is permanent
--   7. reasons       below 40%: only 'Against client PO', 'Sample order' or
--                    'Other: <10+ chars>'; the category and actor are stored;
--                    the exception stays PENDING and still blocks conversion
--                    until an admin decides it; Payment Terms are optional
--   8. payments      the draft's active allocations follow it into the Order,
--                    once, and a reversed one stays in the draft's history
--  11. retired       a reserved number stays retired after its draft is
--                    rejected and deleted (ledger, 20270104000000); only Test
--                    Data Cleanup removes a test draft's entry
--  10. production    production's shape (a held reservation one below the
--                    cycle): a re-upload keeps it, new PIs approved first never
--                    take it, nobody can move the cycle back onto it, a rolled-
--                    back approval returns its number, no number twice
--
-- Two-session concurrency is in run_order_submission_numbering_race.sh.
--
-- Runs inside ONE transaction that ends in ROLLBACK.
-- PREREQUISITES: a disposable stack with the chain replayed through
-- 20270102000000, the owner TEST-001 (1111…, admin, permanent approve_order
-- grant), and these users:
--   5555… sales (orders.view + orders.create), 6666… finance (finance.view +
--   finance.approve), 7777… operations team (orders.view).
-- On success prints NOTICE 'ALL NUMBERING ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.admin_id', '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.sales_id', '55555555-5555-5555-5555-555555555555', true);
  perform set_config('test.fin_id',   '66666666-6666-6666-6666-666666666666', true);
  perform set_config('test.ops_id',   '77777777-7777-7777-7777-777777777777', true);
end $$;

-- ── Fixtures (same shape as order_pi_review_gate_and_versions_assertions) ──

create function pg_temp.make_pi(p_id uuid, p_client text, p_total numeric, p_reserved boolean default false)
returns void language plpgsql as $$
declare
  v_owner uuid := current_setting('test.sales_id')::uuid;
  v_item uuid := gen_random_uuid();
  v_wb   text := 'submissions/' || p_id::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha  text := repeat('a', 64);
  v_img  text;
  v_num  text;
begin
  if p_reserved then
    -- An EXISTING reserved draft, exactly as 20261009000000 left one: the
    -- obligation set, a number taken from the real cycle.
    v_num := public.allocate_confirmed_order_number();
    insert into public.order_submissions
      (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount,
       grand_total, source_workbook_path, source_workbook_sha256, parse_warnings, parse_blocking_issues,
       reservation_required, reserved_order_number, reserved_order_number_at, reserved_order_number_by,
       reserved_number_workbook_sha256)
    values
      (p_id, 'draft', v_owner, v_owner, p_client, p_total, 0, p_total, v_wb, v_sha, '[]', '[]',
       true, v_num, now(), v_owner, v_sha);
  else
    -- A NEW draft: created empty, as create_order_submission makes one, then
    -- given its workbook — the moment 20261009000000 used to reserve.
    insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
    values (p_id, 'draft', v_owner, v_owner, '[]', '[]');
    update public.order_submissions
       set client_name = p_client, gross_product_amount = p_total, discount_amount = 0, grand_total = p_total,
           source_workbook_path = v_wb, source_workbook_sha256 = v_sha
     where id = p_id;
  end if;

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

create function pg_temp.pay(p_pi uuid, p_amount numeric, p_status text)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_id, 'ASSERT', p_amount, current_date, 'hdfc', p_status, current_setting('test.sales_id')::uuid, null);
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_id, p_pi, p_amount, 'order_submission', current_setting('test.sales_id')::uuid);
  return v_id;
end $$;

create function pg_temp.become(p_user uuid) returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create function pg_temp.restore() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Submit as the owner (standard route unless a reason is given), approve the
-- PI decision as the owner-admin.
create function pg_temp.submit(p_id uuid, p_reason text default null) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  v := public.submit_pi_for_review(p_id, null, p_reason, null, null);
  perform pg_temp.restore();
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  if (select pi_approved_at from public.order_submissions where id = p_id) is null then
    perform public.approve_pi_review(p_id);
  end if;
  perform pg_temp.restore();
  return v;
end $$;

create function pg_temp.confirm(p_id uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  v := public.approve_order_submission(p_id, current_setting('test.sales_id')::uuid,
    current_date, current_date + 30, 'reference');
  perform pg_temp.restore();
  return v;
end $$;

create function pg_temp.cycle() returns bigint language sql as $$
  select next_number from public.order_number_cycle
$$;

do $$
begin
  delete from public.order_operations_reviewers where duty = 'pi_handoff';
  insert into public.order_operations_reviewers (duty, user_id, assigned_by)
  values ('pi_handoff', current_setting('test.ops_id')::uuid, current_setting('test.admin_id')::uuid);
end $$;


-- ═══ 1. A NEW DRAFT RESERVES NOTHING ═════════════════════════════════════════

do $$
declare
  v_new    uuid := gen_random_uuid();
  v_before bigint := pg_temp.cycle();
  v_sub    public.order_submissions%rowtype;
begin
  perform pg_temp.make_pi(v_new, 'ASSERT new draft', 1000000);
  select * into v_sub from public.order_submissions where id = v_new;

  assert v_sub.draft_reference ~ '^PID-[0-9]{5,}$', 'a new draft has a PID- reference: ' || coalesce(v_sub.draft_reference, 'null');
  assert not v_sub.reservation_required, 'a new draft carries no reservation obligation';
  assert v_sub.reserved_order_number is null, 'and its workbook reserved no Order number';
  assert pg_temp.cycle() = v_before, 'the cycle did not move';
  assert not exists (select 1 from public.order_submission_activity
                     where submission_id = v_new and action = 'order_number_reserved'),
    'and no reservation was recorded';

  perform set_config('test.pi_new', v_new::text, true);
  raise notice '1. a new draft reserves nothing OK';
end $$;


-- ═══ 2. CONVERSION ALLOCATES; A FAILED APPROVAL GIVES THE NUMBER BACK ════════

do $$
declare
  v_new    uuid := current_setting('test.pi_new')::uuid;
  v_next   bigint;
  v_res    jsonb;
  v_order  uuid;
  v_orders integer;
begin
  perform pg_temp.pay(v_new, 400000, 'approved_unlinked');
  v_res := pg_temp.submit(v_new);
  assert v_res ->> 'payment_route' = 'standard';

  v_next   := pg_temp.cycle();
  v_orders := (select count(*) from public.orders);

  -- The approval runs, allocates, and is then rolled back (as a failure after
  -- the Order insert would be). Nothing survives it — least of all the number.
  begin
    perform pg_temp.confirm(v_new);
    assert pg_temp.cycle() = v_next + 1, 'inside the approval the cycle advanced';
    raise exception using errcode = 'P0099', message = 'ASSERT forced rollback';
  exception when sqlstate 'P0099' then
    perform pg_temp.restore();
  end;
  assert pg_temp.cycle() = v_next, 'a rolled-back approval leaves the cycle where it was';
  assert (select count(*) from public.orders) = v_orders, 'and no Order';
  assert (select order_id from public.order_submissions where id = v_new) is null;

  -- The retry takes exactly the number the failed attempt had.
  v_res := pg_temp.confirm(v_new);
  v_order := (v_res ->> 'order_id')::uuid;
  assert (select display_number from public.orders where id = v_order) = lpad(v_next::text, 4, '0'),
    format('the Order takes the next cycle number %s, got %s', lpad(v_next::text, 4, '0'),
           (select display_number from public.orders where id = v_order));
  assert pg_temp.cycle() = v_next + 1, 'and the cycle moved by exactly one';

  -- A second call is idempotent: same Order, no second number.
  v_res := pg_temp.confirm(v_new);
  assert (v_res ->> 'already_approved')::boolean and (v_res ->> 'order_id')::uuid = v_order;
  assert pg_temp.cycle() = v_next + 1, 'a repeated approval takes no second number';

  -- 8. The allocation followed the record, once.
  assert (select count(*) from public.finance_payment_allocations
          where order_id = v_order and status = 'active') = 1, 'the allocation moved to the Order';
  assert not exists (select 1 from public.finance_payment_allocations
                     where order_submission_id = v_new and status = 'active'),
    'and none still names the draft';

  perform set_config('test.order_new', v_order::text, true);
  raise notice '2. conversion allocates, rollback returns the number, retry is idempotent OK';
end $$;


-- ═══ 3. AN EXISTING RESERVED DRAFT KEEPS ITS NUMBER ══════════════════════════

do $$
declare
  v_res_pi uuid := gen_random_uuid();
  v_num    text;
  v_next   bigint;
  v_res    jsonb;
  v_order  uuid;
  v_rev    uuid;
begin
  perform pg_temp.make_pi(v_res_pi, 'ASSERT reserved draft', 1000000, true);
  v_num := (select reserved_order_number from public.order_submissions where id = v_res_pi);
  assert v_num is not null, 'fixture: the old draft holds a reservation';

  perform pg_temp.pay(v_res_pi, 400000, 'approved_unlinked');
  -- A reversed allocation: history that must stay on the draft.
  v_rev := pg_temp.pay(v_res_pi, 1000, 'approved_unlinked');
  update public.finance_payment_allocations
     set status = 'reversed', reversed_by = current_setting('test.admin_id')::uuid,
         reversed_at = now(), reversal_reason = 'ASSERT reversed before conversion'
   where payment_request_id = v_rev;

  perform pg_temp.submit(v_res_pi);
  v_next := pg_temp.cycle();
  v_res := pg_temp.confirm(v_res_pi);
  v_order := (v_res ->> 'order_id')::uuid;

  assert (select display_number from public.orders where id = v_order) = v_num,
    'the Order takes the reservation, not a new number';
  assert pg_temp.cycle() = v_next, 'and the cycle is untouched';
  assert (select reserved_order_number_used_at from public.order_submissions where id = v_res_pi) is not null,
    'the reservation is marked used';
  assert (select reserved_order_number from public.order_submissions where id = v_res_pi) = v_num,
    'and still reads the same number';
  assert exists (select 1 from public.finance_payment_allocations
                 where payment_request_id = v_rev and status = 'reversed' and order_submission_id = v_res_pi),
    'a reversed allocation stays in the draft''s history';
  assert (select count(*) from public.finance_payment_allocations where order_id = v_order) = 1,
    'only the active allocation moved';

  raise notice '3. an existing reservation is kept and used OK';
end $$;


-- ═══ 4. ABANDONED DRAFTS CONSUME NOTHING ═════════════════════════════════════

do $$
declare
  v_rej    uuid := gen_random_uuid();
  v_before bigint;
begin
  v_before := pg_temp.cycle();
  perform pg_temp.make_pi(v_rej, 'ASSERT rejected draft', 1000000);
  perform pg_temp.pay(v_rej, 400000, 'approved_unlinked');
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  perform public.submit_pi_for_review(v_rej, null, null, null, null);
  perform pg_temp.restore();

  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  perform public.reject_order_submission(v_rej, 'ASSERT not going ahead');
  perform pg_temp.restore();
  assert (select status from public.order_submissions where id = v_rej) = 'rejected';
  assert pg_temp.cycle() = v_before, 'a rejected new draft consumed no number';
  assert (select reserved_order_number from public.order_submissions where id = v_rej) is null;

  raise notice '4. abandoned drafts consume nothing OK';
end $$;


-- ═══ 5 + 6. THE RETIRED ACTION, AND THE PERMANENT REFERENCE ══════════════════

do $$
declare
  v_pi  uuid := gen_random_uuid();
  v_msg text;
begin
  perform pg_temp.make_pi(v_pi, 'ASSERT retired action', 1000000);

  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  begin
    perform public.reserve_order_number_for_submission(v_pi);
    perform pg_temp.restore();
    raise exception 'the retired reservation action must refuse';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.restore();
    assert v_msg like 'ORDER_NUMBER_RESERVATION_RETIRED%', v_msg;
  end;

  begin
    update public.order_submissions set draft_reference = 'PID-99999' where id = v_pi;
    raise exception 'a draft reference must be permanent';
  exception when sqlstate '42501' then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ORDER_SUBMISSION_DRAFT_REFERENCE_IMMUTABLE%', v_msg;
  end;

  assert (select count(distinct draft_reference) = count(*) from public.order_submissions),
    'every reference is unique';
  raise notice '5-6. retired action and permanent reference OK';
end $$;


-- ═══ 7. BELOW 40%: ONE OF THREE REASONS, AND STILL ONLY A REQUEST ════════════

do $$
declare
  v_po    uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_msg   text;
  v_res   jsonb;
  v_bad   text;
begin
  perform pg_temp.make_pi(v_po, 'ASSERT against PO', 1000000);
  perform pg_temp.pay(v_po, 100000, 'approved_unlinked');   -- 10% verified

  -- Free text, an empty Other, a too-short Other: all refused by name.
  foreach v_bad in array array['client pays on delivery', 'Other:', 'Other: ok', 'against client po'] loop
    perform pg_temp.become(current_setting('test.sales_id')::uuid);
    begin
      perform public.submit_pi_for_review(v_po, null, v_bad, null, null);
      perform pg_temp.restore();
      raise exception 'reason % must be refused', v_bad;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_msg = message_text;
      perform pg_temp.restore();
      assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_REASON_INVALID%', v_bad || ' → ' || v_msg;
    end;
  end loop;
  assert (select status from public.order_submissions where id = v_po) = 'draft', 'refusals left it a draft';

  -- Against client PO, with NO payment terms: accepted, pending, attributed.
  v_res := pg_temp.submit(v_po, 'Against client PO');
  assert v_res ->> 'payment_route' = 'exception' and (v_res ->> 'exception_requested')::boolean;
  assert (select advance_exception_reason_code = 'against_client_po'
             and advance_exception_reason = 'Against client PO'
             and advance_exception_status = 'pending'
             and advance_exception_requested_by = current_setting('test.sales_id')::uuid
             and advance_exception_requested_at is not null
             and payment_terms is null
            from public.order_submissions where id = v_po),
    'the category, the actor and the time are recorded; Payment Terms were optional';
  assert exists (select 1 from public.order_submission_activity
                 where submission_id = v_po and action = 'advance_exception_requested'
                   and metadata ->> 'reason_code' = 'against_client_po'),
    'and the request is in the trail with its category';

  -- A reason is not a waiver: the PI decision may be taken, the Order may not.
  begin
    perform pg_temp.confirm(v_po);
    raise exception 'a pending exception must not create an Order';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.restore();
    assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_PENDING%', v_msg;
  end;
  assert (select order_id from public.order_submissions where id = v_po) is null;

  -- Only an explicit decision by an exception approver opens the gate.
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  perform public.approve_pi_advance_exception(v_po);
  perform pg_temp.restore();
  v_res := pg_temp.confirm(v_po);
  assert (v_res ->> 'order_id') is not null, 'after the explicit approval the Order is created';

  -- Other, with a real remark: accepted and stored with it.
  perform pg_temp.make_pi(v_other, 'ASSERT other reason', 1000000);
  perform pg_temp.submit(v_other, 'Other: long-standing client, balance on delivery');
  assert (select advance_exception_reason_code = 'other'
             and advance_exception_reason = 'Other: long-standing client, balance on delivery'
            from public.order_submissions where id = v_other);

  -- The category cannot be rewritten outside a submission.
  begin
    update public.order_submissions set advance_exception_reason_code = 'sample_order' where id = v_other;
    raise exception 'the category must be written only by submitting';
  exception when sqlstate '42501' then
    null;
  end;

  raise notice '7. the three reasons, recorded and never a waiver OK';
end $$;

-- ═══ 9. CLIENT PO AND DESIGN FILES ATTACHED BEFORE SENDING ═══════════════════

do $$
declare
  v_pi    uuid := gen_random_uuid();
  v_stage uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_ops   uuid := current_setting('test.ops_id')::uuid;
  v_po    text;
  v_df    text;
  v_res   jsonb;
  v_n     integer;
begin
  perform pg_temp.make_pi(v_pi, 'ASSERT staged docs', 1000000);
  perform pg_temp.pay(v_pi, 400000, 'approved_unlinked');
  v_po := 'pi-documents/' || v_pi || '/' || v_stage || '/client_po/' || gen_random_uuid() || '.pdf';
  v_df := 'pi-documents/' || v_pi || '/' || v_stage || '/design_files/' || gen_random_uuid() || '.png';

  -- The owner uploads under the staging id (the storage rule 20261231000000
  -- already has), then records each file by name.
  insert into storage.objects (bucket_id, name, owner_id, metadata) values
    ('order-files', v_po, v_sales::text, jsonb_build_object('mimetype', 'application/pdf', 'size', 2048)),
    ('order-files', v_df, v_sales::text, jsonb_build_object('mimetype', 'image/png', 'size', 4096));

  perform pg_temp.become(v_sales);
  insert into public.order_pi_staged_documents (pi_submission_id, staging_submission_id, category, storage_path, file_name)
  values (v_pi, v_stage, 'client_po', v_po, 'Client PO 118.pdf'),
         (v_pi, v_stage, 'design_files', v_df, 'Sofa elevation.png');
  select count(*) into v_n from public.order_pi_staged_documents where pi_submission_id = v_pi;
  perform pg_temp.restore();
  assert v_n = 2, 'the owner stages and reads back both files';

  -- Somebody else may not record a file on this PI.
  perform pg_temp.become(v_ops);
  begin
    insert into public.order_pi_staged_documents (pi_submission_id, staging_submission_id, category, storage_path, file_name)
    values (v_pi, v_stage, 'client_po', v_po || 'x', 'intruder.pdf');
    perform pg_temp.restore();
    raise exception 'a non-owner must not attach files to a PI Draft';
  exception when insufficient_privilege or check_violation then
    perform pg_temp.restore();
  end;

  -- A key outside this PI, or in the wrong category, is refused by the table.
  begin
    insert into public.order_pi_staged_documents (pi_submission_id, staging_submission_id, category, storage_path, file_name, uploaded_by)
    values (v_pi, v_stage, 'design_files', v_po, 'misfiled.pdf', v_sales);
    raise exception 'a Client PO key must not be recorded as a design file';
  exception when check_violation or unique_violation then null;
  end;

  -- Sent with the PI under the staging id: #202's door records both, unchanged.
  perform pg_temp.become(v_sales);
  v_res := public.submit_pi_for_review_with_documents(v_pi, null, null, null, null, v_stage,
    jsonb_build_array(jsonb_build_object('path', v_po, 'file_name', 'Client PO 118.pdf'),
                      jsonb_build_object('path', v_df, 'file_name', 'Sofa elevation.png')),
    array[]::text[]);
  perform pg_temp.restore();
  assert (select status from public.order_submissions where id = v_pi) = 'submitted';
  assert (select count(*) from public.order_document_submission_files f
            join public.order_document_submissions s on s.id = f.submission_id
           where s.id = v_stage and s.pi_submission_id = v_pi) = 2,
    'both staged files travel with the PI, under the staging id';
  assert (select status from public.order_document_submissions where id = v_stage) = 'pending_admin',
    'and nothing about them was approved by attaching them';

  -- Once sent, the staged record is frozen with the submission.
  perform pg_temp.become(v_sales);
  delete from public.order_pi_staged_documents where storage_path = v_po;
  get diagnostics v_n = row_count;
  perform pg_temp.restore();
  assert v_n = 0, 'a sent file cannot be taken off the list';

  raise notice '9. Client PO and Design Files attached before sending OK';
end $$;

-- ═══ 10. PRODUCTION'S SHAPE: A HELD RESERVATION BELOW THE CYCLE ══════════════
--
-- Production on 2026-09-25 (SELECT-only read): Order 0524 exists; draft
-- 11fd3102… holds 0525 (reservation_required, unused); order_number_cycle
-- next_number = 526. The same shape is made here — a reserved draft R that took
-- number N, the cycle at N+1 — and legacy and new approvals are interleaved.

do $$
declare
  v_r     uuid := gen_random_uuid();
  v_a     uuid := gen_random_uuid();
  v_b     uuid := gen_random_uuid();
  v_n     bigint;
  v_rnum  text;
  v_anum  text;
  v_bnum  text;
  v_msg   text;
begin
  perform pg_temp.make_pi(v_r, 'ASSERT legacy reserved (as 0525)', 1000000, true);
  v_rnum := (select reserved_order_number from public.order_submissions where id = v_r);
  v_n := v_rnum::bigint;
  assert pg_temp.cycle() = v_n + 1, 'fixture: the cycle sits one above the held reservation, as in production';

  -- The reserved draft's workbook is REPLACED before approval (the 0525 repair):
  -- nothing re-reserves and nothing releases the number.
  assert not exists (select 1 from pg_trigger where tgname ilike '%auto%reserv%' and not tgisinternal),
    'the auto-reservation trigger is gone';
  update public.order_submissions
     set source_workbook_sha256 = repeat('e', 64), grand_total = 1000000, total_before_gst = 847457.63
   where id = v_r;
  assert (select reserved_order_number from public.order_submissions where id = v_r) = v_rnum
     and pg_temp.cycle() = v_n + 1, 'a re-upload keeps the reservation and takes nothing from the cycle';

  perform pg_temp.make_pi(v_a, 'ASSERT new A', 500000);
  perform pg_temp.make_pi(v_b, 'ASSERT new B', 500000);
  perform pg_temp.pay(v_r, 400000, 'approved_unlinked');
  perform pg_temp.pay(v_a, 200000, 'approved_unlinked');
  perform pg_temp.pay(v_b, 200000, 'approved_unlinked');
  perform pg_temp.submit(v_r);
  perform pg_temp.submit(v_a);
  perform pg_temp.submit(v_b);

  -- A new PI approved FIRST takes the cycle's number, never the held one.
  -- (Each approval runs first; its Order is read after, in a fresh snapshot.)
  perform pg_temp.confirm(v_a);
  v_anum := (select display_number from public.orders where source_order_submission_id = v_a);
  assert v_anum = lpad((v_n + 1)::text, 4, '0'), format('A takes %s, got %s', v_n + 1, v_anum);
  assert v_anum <> v_rnum;

  -- Nobody can move the cycle back onto the held number: not the admin door,
  -- not a raw UPDATE by the owner of the table.
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  begin
    perform public.set_next_confirmed_order_number(v_n);
    v_msg := 'NO ERROR';
  exception when others then
    get stacked diagnostics v_msg = message_text;
  end;
  perform pg_temp.restore();
  assert v_msg like 'ORDER_NUMBER_%', 'the admin door refuses a number at or below what exists: ' || v_msg;
  begin
    update public.order_number_cycle set next_number = v_n where id = true;
    v_msg := 'NO ERROR';
  exception when others then
    get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'ORDER_NUMBER_CYCLE_BEHIND_RESERVATION%', 'the table refuses a cycle at the held number: ' || v_msg;

  -- B's approval fails after allocating; its number comes back.
  begin
    perform pg_temp.confirm(v_b);
    raise exception using errcode = 'P0099', message = 'ASSERT forced rollback';
  exception when sqlstate 'P0099' then
    perform pg_temp.restore();
  end;
  assert pg_temp.cycle() = v_n + 2, 'the rolled-back approval returned its number';

  -- The legacy draft converts AFTER a newer one: it still takes its own number.
  perform pg_temp.confirm(v_r);
  assert (select display_number from public.orders where source_order_submission_id = v_r) = v_rnum,
    'the reserved draft takes exactly its reservation';
  assert pg_temp.cycle() = v_n + 2, 'and takes nothing from the cycle';

  perform pg_temp.confirm(v_b);
  v_bnum := (select display_number from public.orders where source_order_submission_id = v_b);
  assert v_bnum = lpad((v_n + 2)::text, 4, '0'), format('B takes %s (the number its failed attempt had), got %s', v_n + 2, v_bnum);

  assert (select count(distinct display_number) from public.orders where display_number in (v_rnum, v_anum, v_bnum)) = 3,
    'three Orders, three numbers';
  assert not exists (select display_number from public.orders group by 1 having count(*) > 1), 'no number twice';
  assert exists (select 1 from pg_indexes where tablename = 'orders' and indexdef ilike 'CREATE UNIQUE INDEX%(display_number)%'),
    'and the unique index would refuse one anyway';

  raise notice '10. production shape: held reservation, interleaved approvals, rollback, no collision OK';
end $$;

-- ═══ 11. A RESERVED NUMBER STAYS RETIRED AFTER ITS DRAFT IS GONE ═════════════
--
-- The rule (20270104000000 §4c): an Order number a PI Draft ever reserved is
-- never issued to anything else — the cycle can never be set at or below it,
-- whether its draft is live, rejected, converted or permanently deleted. Only
-- Test Data Cleanup, removing a TEST draft, takes its entry away.

do $$
declare
  v_r     uuid := gen_random_uuid();
  v_rej   uuid;
  v_num   text;
  v_n     bigint;
  v_msg   text;
begin
  -- REJECTED: the real door. The row stays, so its number stays held.
  v_rej := gen_random_uuid();
  perform pg_temp.make_pi(v_rej, 'ASSERT reserved then rejected', 500000, true);
  perform pg_temp.pay(v_rej, 250000, 'approved_unlinked');
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  perform public.submit_pi_for_review(v_rej, null, null, null, null);
  perform pg_temp.restore();
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  perform public.reject_order_submission(v_rej, 'ASSERT not going ahead');
  perform pg_temp.restore();
  assert (select status from public.order_submissions where id = v_rej) = 'rejected', 'the draft is rejected';
  assert exists (select 1 from public.order_reserved_number_ledger l join public.order_submissions s on s.reserved_order_number = l.number
                  where s.id = v_rej), 'a rejected draft''s number is in the ledger';

  -- DELETED: a reserved draft never sent anywhere, removed for good.
  perform pg_temp.make_pi(v_r, 'ASSERT reserved then deleted', 500000, true);
  v_num := (select reserved_order_number from public.order_submissions where id = v_r);
  v_n := v_num::bigint;
  assert exists (select 1 from public.order_reserved_number_ledger where number = v_num and submission_id = v_r),
    'the reservation is in the ledger';
  assert v_n > (select reserved_order_number::bigint from public.order_submissions where id = v_rej),
    'fixture: the deleted draft holds the highest reservation, so only the ledger can hold the floor';

  -- Permanently deleted, through the purge marker the deletion door sets.
  perform set_config('boe.order_submission_purge_id', v_r::text, true);
  delete from public.order_submissions where id = v_r;
  perform set_config('boe.order_submission_purge_id', '', true);
  assert not exists (select 1 from public.order_submissions where id = v_r), 'the draft is gone';
  assert exists (select 1 from public.order_reserved_number_ledger where number = v_num), 'its number is still recorded';

  -- The cycle cannot come back onto it: not by the admin door…
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  begin
    perform public.set_next_confirmed_order_number(v_n);
    v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  perform pg_temp.restore();
  assert v_msg like 'ORDER_NUMBER_CYCLE_BEHIND_RESERVATION%', 'the admin door refuses the deleted draft''s number: ' || v_msg;
  -- …nor by a raw UPDATE.
  begin
    update public.order_number_cycle set next_number = v_n where id = true;
    v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'ORDER_NUMBER_CYCLE_BEHIND_RESERVATION%', 'nor a raw write: ' || v_msg;

  -- The ledger itself cannot be edited or emptied.
  begin
    delete from public.order_reserved_number_ledger where number = v_num;
    v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'ORDER_RESERVED_NUMBER_PERMANENT%', 'the ledger is permanent: ' || v_msg;
  assert not has_table_privilege('authenticated', 'public.order_reserved_number_ledger', 'SELECT'), 'and not client-readable';

  -- Test Data Cleanup is the one exception: a test draft takes its entry with it.
  v_r := gen_random_uuid();
  perform pg_temp.make_pi(v_r, 'ASSERT test draft', 1000, true);
  v_num := (select reserved_order_number from public.order_submissions where id = v_r);
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  delete from public.order_submissions where id = v_r;
  perform set_config('boe.cleanup_context', '', true);
  assert not exists (select 1 from public.order_reserved_number_ledger where number = v_num),
    'Test Data Cleanup removed the test draft''s entry';

  raise notice '11. a reserved number stays retired after its draft is rejected and deleted OK';
end $$;

do $$ begin raise notice 'ALL NUMBERING ASSERTIONS PASSED'; end $$;

rollback;
