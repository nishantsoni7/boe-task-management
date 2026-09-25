-- A REVISED PI IS IN FORCE WHEN AN ADMIN APPROVES IT (20270104000000)
-- ===========================================================================
-- Through the real doors, on a disposable stack:
--
--   1. V1        an Order of three products, B001 B002 B003 → BE001 BE002 BE003
--   2. V2        rename B001, remove B002, keep B003, add one. Admin approval
--                makes V2 current AT ONCE: V1 superseded and captured, the
--                Order's value amended in the same transaction with an
--                'order_amended' record (old → new, the admin, the time), the
--                operations handoff recorded and awaiting — not blocking.
--                Codes: BE001 stays with the RENAMED line, BE003 with the kept
--                one, the added line gets BE004, BE002 is retired.
--   3. ops       the reviewer's acknowledgement aligns the Order for production
--                and changes nothing about which version is current
--   4. V3        an added line that takes B002 (a removed product's number) is
--                refused and nothing moves; with a fresh number it goes through
--                and gets BE005 — never BE002 or BE003
--   5. refusals  no Grand Total; a value change on a dispatched Order
--   6. finance   a PI Draft allocation reads as its PID; once converted, as
--                the Order's number, and the moved allocation is the same row
--   7. advance   (section 7) production is never aligned below 40% of the
--                AMENDED value: increase, pending, verified, retry, decrease,
--                an admin's exception (and its staleness), a raw write
--   6. workbook  (section 6) a revised WORKBOOK's lines keep their codes by
--                item number even when the row-derived ids land on another
--                product; an unnumbered line is not guessed (the approval
--                asks, listing it and the candidates, and nothing moves) and is
--                matched by the admin; one product, one continuing line; a
--                removed product's number is refused even marked "new"
--
-- Runs inside ONE transaction that ends in ROLLBACK.
-- PREREQUISITES: TEST-001 admin 1111…, sales 5555…, operations 7777…, finance
-- viewer = the admin; 20270104000000 applied.
-- On success prints NOTICE 'ALL IN-FORCE-AT-APPROVAL ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.admin_id', '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.sales_id', '55555555-5555-5555-5555-555555555555', true);
  perform set_config('test.ops_id',   '77777777-7777-7777-7777-777777777777', true);
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
create function pg_temp.fails_with(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  get stacked diagnostics v = message_text;
  return v;
end $$;

-- A proposal as the Edit PI route builds it. p_lines: [{id?, seq, name, qty, rate}]
-- — a line with an id continues that line; one without is added.
create function pg_temp.proposal(p_sub uuid, p_lines jsonb, p_grand numeric default null)
returns jsonb language plpgsql as $$
declare
  s public.order_submissions%rowtype;
  o public.orders%rowtype;
  v_items jsonb := '[]'::jsonb; v_gross numeric := 0; l jsonb; n int := 0; v_id uuid; v_row int;
begin
  select * into s from public.order_submissions where id = p_sub;
  select * into o from public.orders where source_order_submission_id = p_sub;
  select coalesce(max(source_row), 31) into v_row from public.order_submission_items where submission_id = p_sub;
  for l in select value from jsonb_array_elements(p_lines) loop
    v_id := coalesce(nullif(l ->> 'id', '')::uuid, gen_random_uuid());
    if l ->> 'id' is null then v_row := v_row + 1; end if;
    v_items := v_items || jsonb_build_object(
      'id', v_id,
      'source_row', coalesce((select source_row from public.order_submission_items where id = v_id), v_row),
      'item_sequence', l ->> 'seq', 'product_name', l ->> 'name',
      'quantity', (l ->> 'qty')::numeric, 'cost_per_piece', (l ->> 'rate')::numeric,
      'total_amount', (l ->> 'qty')::numeric * (l ->> 'rate')::numeric, 'sort_order', n);
    v_gross := v_gross + (l ->> 'qty')::numeric * (l ->> 'rate')::numeric;
    n := n + 1;
  end loop;
  return jsonb_build_object(
    'payload', jsonb_build_object(
      'header', jsonb_build_object('client_name', o.client_name, 'order_confirmation_date', o.confirm_date,
                                   'due_date', o.due_date, 'creation_date', s.creation_date),
      'commercial', jsonb_build_object('gross_product_amount', v_gross, 'discount_amount', 0,
                                       'total_before_gst', v_gross, 'gst_amount', 0,
                                       'grand_total', case when p_grand = -1 then null else coalesce(p_grand, v_gross) end),
      'source', jsonb_build_object('workbook_path', s.source_workbook_path, 'workbook_sha256', s.source_workbook_sha256),
      'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
      'items', v_items,
      -- A continuing line keeps its pictures, as the Edit PI route does.
      'item_images', coalesce((select jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'submission_id')
                                 from public.order_submission_item_images m
                                where m.submission_id = p_sub
                                  and m.item_id in (select (e ->> 'id')::uuid from jsonb_array_elements(v_items) e)), '[]'::jsonb),
      'seed_terms', jsonb_build_object('fabric_responsibility', 'client'),
      'fingerprint', encode(sha256(convert_to(v_items::text, 'UTF8')), 'hex')),
    'terms', jsonb_build_object('fabric_responsibility', 'client'),
    'change_summary', jsonb_build_array('ASSERT change'));
end $$;

create function pg_temp.propose_and_approve(p_order uuid, p_prop jsonb, p_reason text) returns jsonb language plpgsql as $$
declare v_ver uuid;
begin
  v_ver := (public.propose_order_pi_edit_revision(p_order, current_setting('test.sales_id')::uuid, p_prop, p_reason) ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('test.last_version', v_ver::text, true);
  return public.approve_order_pi_revision(v_ver, current_setting('test.admin_id')::uuid,
    (select proposal -> 'payload' from public.order_pi_versions where id = v_ver));
end $$;

-- The BOE code each current line holds, by product name.
create function pg_temp.codes(p_sub uuid) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(i.product_name, 'BE' || lpad(c.boe_sequence::text, 3, '0')), '{}'::jsonb)
    from public.order_submission_items i
    left join public.order_product_codes c on c.submission_item_id = i.id
   where i.submission_id = p_sub
$$;


-- ═══ 1. V1: THREE PRODUCTS, THREE CODES, A DRAFT PAYMENT ═══════════════════

do $$
declare
  v_sub   uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_wb    text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_pay   uuid := gen_random_uuid();
  v_alloc uuid;
  v_res   jsonb;
  v_ref   text;
  v_row   record;
begin
  delete from public.order_operations_reviewers where duty = 'pi_handoff';
  insert into public.order_operations_reviewers (duty, user_id, assigned_by)
  values ('pi_handoff', current_setting('test.ops_id')::uuid, v_admin);

  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', v_sales, v_sales, '[]', '[]');
  update public.order_submissions
     set client_name = 'ASSERT in-force client', gross_product_amount = 60000, discount_amount = 0,
         grand_total = 60000, source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64),
         fabric_responsibility = 'client', commercial_terms_note = 'Ex-factory.', client_city = 'Pune'
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_sub, 32, 'B001', 'ASSERT chair',   2, 10000, 20000, 0),
         (v_sub, 33, 'B002', 'ASSERT stool',   2, 10000, 20000, 1),
         (v_sub, 34, 'B003', 'ASSERT table',   2, 10000, 20000, 2);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select v_sub, i.id, 'representative', 0,
         'submissions/' || v_sub || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png',
         'image/png', repeat('c', 64), i.source_row
    from public.order_submission_items i where i.submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', m.storage_path, jsonb_build_object('mimetype', 'image/png')
    from public.order_submission_item_images m where m.submission_id = v_sub;

  -- A payment allocated to the DRAFT: Finance reads it as the PID.
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ASSERT', 30000, current_date, 'hdfc', 'approved_unlinked', v_sales, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, v_sub, 30000, 'order_submission', v_sales) returning id into v_alloc;

  perform pg_temp.become(v_admin);
  select * into v_row from public.received_payment_allocation_targets(array[v_pay]);
  perform pg_temp.restore();
  select draft_reference into v_ref from public.order_submissions where id = v_sub;
  assert v_ref ~ '^PID-\d{5,}$', 'the draft carries a PID: ' || coalesce(v_ref, 'null');
  assert v_row.target_type = 'pi_draft' and v_row.target_reference = v_ref,
    'Allocated Against names the draft by its PID, not its file: ' || coalesce(v_row.target_reference, 'null');

  perform pg_temp.become(v_sales);
  perform public.submit_pi_for_review(v_sub, null, null, null, null);
  perform pg_temp.restore();

  -- A Client PO sent with the PI (as submit_pi_for_review_with_documents records it, #202).
  perform set_config('test.docs', gen_random_uuid()::text, true);
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('order-files', 'pi-documents/' || v_sub || '/' || current_setting('test.docs') || '/client_po/' || gen_random_uuid() || '.pdf',
          v_sales::text, jsonb_build_object('mimetype', 'application/pdf', 'size', 900));
  insert into public.order_document_submissions (id, stage, pi_submission_id, includes_client_po, status, snapshot_sha256, file_count, submitted_by)
  values (current_setting('test.docs')::uuid, 'initial', v_sub, true, 'pending_admin', repeat('d', 64), 1, v_sales);
  perform pg_temp.become(v_admin);
  if (select pi_approved_at from public.order_submissions where id = v_sub) is null then
    perform public.approve_pi_review(v_sub);
  end if;
  v_res := public.approve_order_submission(v_sub, v_sales, current_date, current_date + 30, 'reference');
  perform pg_temp.restore();

  -- 6 (conversion). The SAME allocation row now points at the Order, and
  -- Finance reads it as the Order's number.
  perform pg_temp.become(v_admin);
  select * into v_row from public.received_payment_allocation_targets(array[v_pay]);
  perform pg_temp.restore();
  assert v_row.allocation_id = v_alloc and v_row.target_type = 'order'
     and v_row.target_reference = (select display_number from public.orders where id = (v_res ->> 'order_id')::uuid),
    'once converted, the same allocation reads as the Order number';
  assert (select draft_reference from public.order_submissions where id = v_sub) = v_ref, 'the PID never changes';

  perform set_config('test.sub', v_sub::text, true);
  perform set_config('test.order', v_res ->> 'order_id', true);
  assert pg_temp.codes(v_sub) = '{"ASSERT chair": "BE001", "ASSERT stool": "BE002", "ASSERT table": "BE003"}'::jsonb,
    'V1 codes: ' || pg_temp.codes(v_sub)::text;
  raise notice '1. V1 with BE001-BE003; draft payment read as its PID, then as the Order OK';
end $$;


-- ═══ 2. V2: CURRENT AT ADMIN APPROVAL, ORDER AMENDED, CODES KEPT ═══════════

do $$
declare
  v_sub    uuid := current_setting('test.sub')::uuid;
  v_order  uuid := current_setting('test.order')::uuid;
  v_admin  uuid := current_setting('test.admin_id')::uuid;
  v_ops    uuid := current_setting('test.ops_id')::uuid;
  v_chair  uuid := (select id from public.order_submission_items where submission_id = current_setting('test.sub')::uuid and item_sequence = 'B001');
  v_table  uuid := (select id from public.order_submission_items where submission_id = current_setting('test.sub')::uuid and item_sequence = 'B003');
  v_before numeric := (select total_value from public.orders where id = current_setting('test.order')::uuid);
  v_v1     uuid := (select id from public.order_pi_versions where order_id = current_setting('test.order')::uuid and version_number = 1);
  v_v2     uuid;
  v_res    jsonb;
  v_amend  record;
  v_det    jsonb;
  v_h      record;
begin
  v_res := pg_temp.propose_and_approve(v_order, pg_temp.proposal(v_sub, jsonb_build_array(
    jsonb_build_object('id', v_chair, 'seq', 'B001', 'name', 'ASSERT armchair (renamed)', 'qty', 2, 'rate', 12000),
    jsonb_build_object('id', v_table, 'seq', 'B003', 'name', 'ASSERT table', 'qty', 2, 'rate', 10000),
    jsonb_build_object('seq', 'B004', 'name', 'ASSERT bench (added)', 'qty', 1, 'rate', 15000))),
    'ASSERT renamed chair, stool dropped, bench added');
  v_v2 := current_setting('test.last_version')::uuid;

  assert v_res ->> 'status' = 'approved', 'admin approval makes V2 current: ' || v_res::text;
  assert (select status from public.order_pi_versions where id = v_v2) = 'approved', 'V2 is the version in force';
  assert (select status from public.order_pi_versions where id = v_v1) = 'superseded', 'V1 is history';
  assert (select array_agg(product_name order by sort_order) from public.order_submission_items where submission_id = v_sub)
       = array['ASSERT armchair (renamed)', 'ASSERT table', 'ASSERT bench (added)'], 'V2''s lines are in force';

  -- The Order's value moved in the same transaction, as an audited amendment.
  assert (select total_value from public.orders where id = v_order) = 59000, 'the Order value is V2''s Grand Total';
  select * into v_amend from public.order_activity_log
   where order_id = v_order and event_type = 'order_amended' order by created_at desc limit 1;
  assert v_amend.actor_id = v_admin, 'the amendment names the approving admin';
  assert v_amend.payload ->> 'source' = 'pi_revision', 'and says it came from a PI revision';
  assert (v_amend.payload #>> '{changes,total_value,from}')::numeric = v_before
     and (v_amend.payload #>> '{changes,total_value,to}')::numeric = 59000, 'with the old and new value: ' || v_amend.payload::text;
  assert v_amend.payload ->> 'reason' like 'PI V2 approved:%', 'and the revision''s reason';
  assert v_amend.created_at is not null;
  assert (v_res -> 'order_amendment') ? 'total_value', 'the approval reports the amendment';

  -- Operations receives it — and it does not stand in the way.
  select * into v_h from public.order_operations_handoffs where pi_version_id = v_v2;
  assert v_h.id is not null and v_h.status = 'awaiting' and v_h.assigned_to = v_ops,
    'a handoff for V2 awaits the reviewer';
  assert exists (select 1 from public.notifications where user_id = v_ops and entity_id = v_order
                   and type = 'order_operations_review_requested'::notification_type),
    'and the reviewer was told';

  -- Codes: kept by identity (renamed included), fresh for the added line.
  assert pg_temp.codes(v_sub) = '{"ASSERT armchair (renamed)": "BE001", "ASSERT table": "BE003", "ASSERT bench (added)": "BE004"}'::jsonb,
    'V2 codes: ' || pg_temp.codes(v_sub)::text;
  assert (select submission_item_id is null from public.order_product_codes where order_id = v_order and boe_sequence = 2),
    'the removed stool''s BE002 is retired, not reassigned';

  -- V1 reads back in full, with the stool.
  perform pg_temp.become(v_admin);
  v_det := public.order_pi_version_detail(v_v1);
  perform pg_temp.restore();
  assert v_det ->> 'source' = 'captured' and jsonb_array_length(v_det #> '{content,items}') = 3, 'V1 was captured in full';

  perform set_config('test.v2', v_v2::text, true);
  raise notice '2. V2 current at admin approval; Order amended with an audit row; codes kept by identity OK';
end $$;


-- ═══ 3. THE OPERATIONS ACKNOWLEDGEMENT IS ABOUT PRODUCTION, NOT THE VERSION ═

do $$
declare
  v_order uuid := current_setting('test.order')::uuid;
  v_v2    uuid := current_setting('test.v2')::uuid;
  v_ops   uuid := current_setting('test.ops_id')::uuid;
  v_h     uuid := (select id from public.order_operations_handoffs where pi_version_id = current_setting('test.v2')::uuid);
begin
  assert (select status from public.order_document_submissions where id = current_setting('test.docs')::uuid) = 'awaiting_operations',
    'the PO sent with the PI still awaits Operations after V2 went into force';
  perform pg_temp.become(v_ops);
  perform public.decide_order_operations_handoff(v_h, 'accepted', null);
  perform pg_temp.restore();
  assert (select status from public.order_operations_handoffs where id = v_h) = 'accepted';
  assert (select production_alignment from public.orders where id = v_order) = 'aligned', 'acceptance aligns the Order';
  assert (select status from public.order_pi_versions where id = v_v2) = 'approved', 'V2 was already current, and still is';
  assert (select status from public.order_document_submissions where id = current_setting('test.docs')::uuid) = 'accepted',
    'the documents sent with the PI are accepted with the version Operations accepted (#202)';
  raise notice '3. the operations acknowledgement aligns production and does not gate V2 OK';
end $$;


-- ═══ 4. V3: A REMOVED PRODUCT'S NUMBER IS NEVER HANDED OUT AGAIN ═══════════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_order uuid := current_setting('test.order')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_chair uuid := (select id from public.order_submission_items where submission_id = current_setting('test.sub')::uuid and item_sequence = 'B001');
  v_bench uuid := (select id from public.order_submission_items where submission_id = current_setting('test.sub')::uuid and item_sequence = 'B004');
  v_ver   uuid;
  v_msg   text;
  v_fp    text := md5(public.order_pi_content_of(current_setting('test.sub')::uuid)::text);
  v_codes jsonb := pg_temp.codes(current_setting('test.sub')::uuid);
begin
  assert public.order_item_sequences_ever_used(v_order) @> array['B001', 'B002', 'B003', 'B004'],
    'the Order remembers every number: ' || public.order_item_sequences_ever_used(v_order)::text;

  -- Remove the table (B003), and give an added line the stool's old B002.
  v_ver := (public.propose_order_pi_edit_revision(v_order, current_setting('test.sales_id')::uuid,
    pg_temp.proposal(v_sub, jsonb_build_array(
      jsonb_build_object('id', v_chair, 'seq', 'B001', 'name', 'ASSERT armchair (renamed)', 'qty', 2, 'rate', 12000),
      jsonb_build_object('id', v_bench, 'seq', 'B004', 'name', 'ASSERT bench (added)', 'qty', 1, 'rate', 15000),
      jsonb_build_object('seq', 'B002', 'name', 'ASSERT lamp', 'qty', 1, 'rate', 4000))),
    'ASSERT reuse an old number') ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  v_msg := pg_temp.fails_with(format('select public.approve_order_pi_revision(%L, %L, (select proposal -> %L from public.order_pi_versions where id = %L))',
    v_ver, v_admin, 'payload', v_ver));
  assert v_msg like 'ORDER_PI_EDIT_SEQUENCE_RETIRED%', 'a removed product''s number is refused: ' || v_msg;
  assert md5(public.order_pi_content_of(v_sub)::text) = v_fp and pg_temp.codes(v_sub) = v_codes, 'and nothing moved';
  assert (select status from public.order_pi_versions where id = v_ver) = 'pending', 'the revision is still pending';
  perform pg_temp.become(v_admin);
  perform public.reject_order_pi_revision(v_ver, 'ASSERT wrong number');
  perform pg_temp.restore();

  -- The same change with a fresh number goes through.
  perform pg_temp.propose_and_approve(v_order, pg_temp.proposal(v_sub, jsonb_build_array(
      jsonb_build_object('id', v_chair, 'seq', 'B001', 'name', 'ASSERT armchair (renamed)', 'qty', 2, 'rate', 12000),
      jsonb_build_object('id', v_bench, 'seq', 'B004', 'name', 'ASSERT bench (added)', 'qty', 1, 'rate', 15000),
      jsonb_build_object('seq', 'B005', 'name', 'ASSERT lamp', 'qty', 1, 'rate', 4000))),
    'ASSERT table dropped, lamp added');
  assert pg_temp.codes(v_sub) = '{"ASSERT armchair (renamed)": "BE001", "ASSERT bench (added)": "BE004", "ASSERT lamp": "BE005"}'::jsonb,
    'V3 codes: ' || pg_temp.codes(v_sub)::text;
  assert (select array_agg(boe_sequence order by boe_sequence) from public.order_product_codes where order_id = v_order and submission_item_id is null)
       = array[2, 3], 'BE002 and BE003 stay retired';
  assert (select count(*) from public.order_product_codes where order_id = v_order) = 5, 'five codes ever, none reused';
  assert (select total_value from public.orders where id = v_order) = 43000, 'and the Order was amended again';
  raise notice '4. V3: retired numbers refused, BE005 issued, BE002/BE003 retired OK';
end $$;


-- ═══ 5. REFUSALS THAT LEAVE EVERYTHING AS IT WAS ═══════════════════════════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_order uuid := current_setting('test.order')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_chair uuid := (select id from public.order_submission_items where submission_id = current_setting('test.sub')::uuid and item_sequence = 'B001');
  v_ver   uuid;
  v_msg   text;
  v_fp    text := md5(public.order_pi_content_of(current_setting('test.sub')::uuid)::text
                      || (select total_value::text from public.orders where id = current_setting('test.order')::uuid));
begin
  -- No Grand Total.
  v_ver := (public.propose_order_pi_edit_revision(v_order, current_setting('test.sales_id')::uuid,
    pg_temp.proposal(v_sub, jsonb_build_array(
      jsonb_build_object('id', v_chair, 'seq', 'B001', 'name', 'ASSERT armchair (renamed)', 'qty', 3, 'rate', 12000)), -1),
    'ASSERT unreadable total') ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  v_msg := pg_temp.fails_with(format('select public.approve_order_pi_revision(%L, %L, (select proposal -> %L from public.order_pi_versions where id = %L))',
    v_ver, v_admin, 'payload', v_ver));
  assert v_msg like 'ORDER_PI_REVISION_NO_GRAND_TOTAL%', 'a revision without a Grand Total is refused: ' || v_msg;
  perform pg_temp.become(v_admin);
  perform public.reject_order_pi_revision(v_ver, 'ASSERT no total');
  perform pg_temp.restore();

  -- A value change on a dispatched Order.
  -- Straight to dispatched for the test (the status-path triggers are not what
  -- is under test here).
  set local session_replication_role = replica;
  update public.orders set status = 'dispatched' where id = v_order;
  set local session_replication_role = origin;
  v_ver := (public.propose_order_pi_edit_revision(v_order, current_setting('test.sales_id')::uuid,
    pg_temp.proposal(v_sub, jsonb_build_array(
      jsonb_build_object('id', v_chair, 'seq', 'B001', 'name', 'ASSERT armchair (renamed)', 'qty', 3, 'rate', 12000))),
    'ASSERT after dispatch') ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  v_msg := pg_temp.fails_with(format('select public.approve_order_pi_revision(%L, %L, (select proposal -> %L from public.order_pi_versions where id = %L))',
    v_ver, v_admin, 'payload', v_ver));
  assert v_msg like 'ORDER_CLOSED%', 'a dispatched Order''s value cannot be amended by a revision: ' || v_msg;

  assert md5(public.order_pi_content_of(v_sub)::text || (select total_value::text from public.orders where id = v_order)) = v_fp,
    'neither refusal moved anything';
  raise notice '5. no Grand Total / dispatched Order refused, nothing moved OK';
end $$;

-- ═══ 6. WORKBOOK REVISIONS KEEP CODES BY ITEM NUMBER, OR ASK ═══════════════
--
-- The parse route derives a line's id from its ROW (deterministicItemId), so a
-- revised workbook's row-33 line has the id V1's row-33 line had — whatever
-- product now sits there. Here the ids are made exactly that way, which is the
-- worst case: the stool (row 33) is removed, the table moves up onto row 33 and
-- takes the stool's id, a new bench lands on row 34 and takes the table's id.

create function pg_temp.wb_propose(p_order uuid, p_reason text) returns uuid language plpgsql as $$
declare v_sub uuid; v_path text; v uuid;
begin
  select source_order_submission_id into v_sub from public.orders where id = p_order;
  v_path := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_path,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  v := (public.propose_order_pi_revision(p_order, v_path, 'revised.xlsx', p_reason) ->> 'version_id')::uuid;
  perform pg_temp.restore();
  return v;
end $$;

-- A parsed workbook: p_lines [{row, seq, name, qty, rate}], ids derived from the row.
create function pg_temp.wb_payload(p_version uuid, p_lines jsonb, p_line_map jsonb default null) returns jsonb language plpgsql as $$
declare v_sub uuid; v_path text; o public.orders%rowtype; v_items jsonb := '[]'::jsonb; v_gross numeric := 0; l jsonb; n int := 0;
begin
  select submission_id, workbook_path into v_sub, v_path from public.order_pi_versions where id = p_version;
  select * into o from public.orders where source_order_submission_id = v_sub;
  for l in select value from jsonb_array_elements(p_lines) loop
    v_items := v_items || jsonb_build_object(
      'id', pg_temp.row_id(v_sub, (l ->> 'row')::int), 'source_row', (l ->> 'row')::int,
      'item_sequence', l ->> 'seq', 'product_name', l ->> 'name',
      'quantity', (l ->> 'qty')::numeric, 'cost_per_piece', (l ->> 'rate')::numeric,
      'total_amount', (l ->> 'qty')::numeric * (l ->> 'rate')::numeric, 'sort_order', n);
    v_gross := v_gross + (l ->> 'qty')::numeric * (l ->> 'rate')::numeric;
    n := n + 1;
  end loop;
  return jsonb_build_object(
    'header', jsonb_build_object('client_name', o.client_name, 'order_confirmation_date', o.confirm_date, 'due_date', o.due_date),
    'commercial', jsonb_build_object('gross_product_amount', v_gross, 'discount_amount', 0,
                                     'total_before_gst', v_gross, 'gst_amount', 0, 'grand_total', v_gross),
    'source', jsonb_build_object('workbook_path', v_path, 'workbook_sha256', repeat('f', 64)),
    'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
    'items', v_items, 'item_images', '[]'::jsonb,
    'seed_terms', jsonb_build_object('fabric_responsibility', 'client'),
    'fingerprint', encode(sha256(convert_to(v_items::text || v_path, 'UTF8')), 'hex'))
    || case when p_line_map is null then '{}'::jsonb else jsonb_build_object('line_map', p_line_map) end;
end $$;

-- The id V1 gave the line on this row (the route's rule: a function of the row).
create function pg_temp.row_id(p_sub uuid, p_row int) returns uuid language sql as $$
  select nullif(current_setting('test.row_' || replace(p_sub::text, '-', '') || '_' || p_row, true), '')::uuid
$$;

do $$
declare
  v_sub   uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_wb    text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_res   jsonb;
  v_order uuid;
  r       int;
begin
  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', v_sales, v_sales, '[]', '[]');
  update public.order_submissions
     set client_name = 'ASSERT workbook client', gross_product_amount = 60000, discount_amount = 0,
         grand_total = 60000, source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64)
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  -- Ids made the route's way, remembered per row (rows 32-36).
  for r in 32..36 loop perform set_config('test.row_' || replace(v_sub::text, '-', '') || '_' || r, gen_random_uuid()::text, true); end loop;
  insert into public.order_submission_items (id, submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (pg_temp.row_id(v_sub, 32), v_sub, 32, 'B001', 'ASSERT wb chair', 2, 10000, 20000, 0),
         (pg_temp.row_id(v_sub, 33), v_sub, 33, 'B002', 'ASSERT wb stool', 2, 10000, 20000, 1),
         (pg_temp.row_id(v_sub, 34), v_sub, 34, 'B003', 'ASSERT wb table', 2, 10000, 20000, 2);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select v_sub, i.id, 'representative', 0,
         'submissions/' || v_sub || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png', 'image/png', repeat('c', 64), i.source_row
    from public.order_submission_items i where i.submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', m.storage_path, jsonb_build_object('mimetype', 'image/png') from public.order_submission_item_images m where m.submission_id = v_sub;
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (gen_random_uuid(), 'ASSERT wb', 30000, current_date, 'hdfc', 'approved_unlinked', v_sales, null)
  returning id into v_order;   -- (reused below as a scratch id)
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_order, v_sub, 30000, 'order_submission', v_sales);

  perform pg_temp.become(v_sales);
  perform public.submit_pi_for_review(v_sub, null, null, null, null);
  perform pg_temp.restore();
  perform pg_temp.become(v_admin);
  if (select pi_approved_at from public.order_submissions where id = v_sub) is null then
    perform public.approve_pi_review(v_sub);
  end if;
  v_res := public.approve_order_submission(v_sub, v_sales, current_date, current_date + 30, 'reference');
  perform pg_temp.restore();
  perform set_config('test.wb_sub', v_sub::text, true);
  perform set_config('test.wb_order', v_res ->> 'order_id', true);
  assert pg_temp.codes(v_sub) = '{"ASSERT wb chair": "BE001", "ASSERT wb stool": "BE002", "ASSERT wb table": "BE003"}'::jsonb,
    'V1 codes: ' || pg_temp.codes(v_sub)::text;
end $$;

do $$
declare
  v_sub   uuid := current_setting('test.wb_sub')::uuid;
  v_order uuid := current_setting('test.wb_order')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_ver   uuid;
  v_msg   text;
  v_det   text;
  v_fp    text;
  v_codes jsonb;
begin
  -- V2: chair renamed and more of them; stool removed; the table moves up to
  -- row 33 (so it carries the STOOL's row id); a bench is added on row 34 (the
  -- TABLE's old row id).
  v_ver := pg_temp.wb_propose(v_order, 'ASSERT wb V2');
  perform public.approve_order_pi_revision(v_ver, v_admin, pg_temp.wb_payload(v_ver, jsonb_build_array(
    jsonb_build_object('row', 32, 'seq', 'B001', 'name', 'ASSERT wb armchair (renamed)', 'qty', 3, 'rate', 10000),
    jsonb_build_object('row', 33, 'seq', 'B003', 'name', 'ASSERT wb table', 'qty', 2, 'rate', 10000),
    jsonb_build_object('row', 34, 'seq', 'B004', 'name', 'ASSERT wb bench (added)', 'qty', 1, 'rate', 8000))));
  assert (select status from public.order_pi_versions where id = v_ver) = 'approved', 'workbook V2 is current';
  assert pg_temp.codes(v_sub) = '{"ASSERT wb armchair (renamed)": "BE001", "ASSERT wb table": "BE003", "ASSERT wb bench (added)": "BE004"}'::jsonb,
    'matched by item number, not by row id: ' || pg_temp.codes(v_sub)::text;
  assert (select submission_item_id is null from public.order_product_codes where order_id = v_order and boe_sequence = 2),
    'the removed stool''s BE002 is retired, even though its row id is back on the table';
  assert (select total_value from public.orders where id = v_order) = 58000, 'the Order was amended to V2';

  -- V3: the table's line has lost its number → the approval asks, changes nothing.
  v_fp := md5(public.order_pi_content_of(v_sub)::text); v_codes := pg_temp.codes(v_sub);
  v_ver := pg_temp.wb_propose(v_order, 'ASSERT wb V3');
  perform set_config('test.wb_v3', v_ver::text, true);
  begin
    perform public.approve_order_pi_revision(v_ver, v_admin, pg_temp.wb_payload(v_ver, jsonb_build_array(
      jsonb_build_object('row', 32, 'seq', 'B001', 'name', 'ASSERT wb armchair (renamed)', 'qty', 3, 'rate', 10000),
      jsonb_build_object('row', 33, 'seq', '',     'name', 'ASSERT wb table, oak', 'qty', 2, 'rate', 11000),
      jsonb_build_object('row', 34, 'seq', 'B004', 'name', 'ASSERT wb bench (added)', 'qty', 1, 'rate', 8000),
      jsonb_build_object('row', 35, 'seq', 'B005', 'name', 'ASSERT wb lamp (added)', 'qty', 1, 'rate', 3000))));
    v_msg := 'NO ERROR';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail;
  end;
  assert v_msg like 'ORDER_PI_REVISION_LINES_NEED_REVIEW%', 'an unnumbered line is not guessed: ' || v_msg;
  assert (v_det::jsonb -> 'lines' -> 0 ->> 'name') = 'ASSERT wb table, oak'
     and (v_det::jsonb -> 'lines' -> 0 ->> 'why') = 'no item number'
     and jsonb_array_length(v_det::jsonb -> 'candidates') = 3, 'the refusal names the line and the candidates: ' || coalesce(v_det, 'none');
  assert md5(public.order_pi_content_of(v_sub)::text) = v_fp and pg_temp.codes(v_sub) = v_codes
     and (select status from public.order_pi_versions where id = v_ver) = 'pending', 'and nothing moved';

  -- Two lines may not continue the same product.
  v_msg := pg_temp.fails_with(format('select public.approve_order_pi_revision(%L, %L, pg_temp.wb_payload(%L, %L::jsonb, %L::jsonb))',
    v_ver, v_admin, v_ver,
    jsonb_build_array(jsonb_build_object('row', 32, 'seq', 'B001', 'name', 'a', 'qty', 1, 'rate', 1),
                      jsonb_build_object('row', 33, 'seq', '', 'name', 'b', 'qty', 1, 'rate', 1)),
    jsonb_build_object(pg_temp.row_id(v_sub, 33), (select id from public.order_submission_items where submission_id = v_sub and item_sequence = 'B001'))));
  assert v_msg like 'ORDER_PI_REVISION_LINE_MAP_INVALID%', 'one product, one continuing line: ' || v_msg;

  -- The admin matches it to the table: it keeps BE003; the lamp gets BE005.
  perform public.approve_order_pi_revision(v_ver, v_admin, pg_temp.wb_payload(v_ver, jsonb_build_array(
      jsonb_build_object('row', 32, 'seq', 'B001', 'name', 'ASSERT wb armchair (renamed)', 'qty', 3, 'rate', 10000),
      jsonb_build_object('row', 33, 'seq', '',     'name', 'ASSERT wb table, oak', 'qty', 2, 'rate', 11000),
      jsonb_build_object('row', 34, 'seq', 'B004', 'name', 'ASSERT wb bench (added)', 'qty', 1, 'rate', 8000),
      jsonb_build_object('row', 35, 'seq', 'B005', 'name', 'ASSERT wb lamp (added)', 'qty', 1, 'rate', 3000)),
    jsonb_build_object(pg_temp.row_id(v_sub, 33),
      (select i.id from public.order_submission_items i where i.submission_id = v_sub and i.item_sequence = 'B003'))));
  assert pg_temp.codes(v_sub) = '{"ASSERT wb armchair (renamed)": "BE001", "ASSERT wb table, oak": "BE003", "ASSERT wb bench (added)": "BE004", "ASSERT wb lamp (added)": "BE005"}'::jsonb,
    'the matched line keeps its code: ' || pg_temp.codes(v_sub)::text;

  -- V4 gives the stool's old number to a new product: refused, even marked new.
  v_ver := pg_temp.wb_propose(v_order, 'ASSERT wb V4');
  v_msg := pg_temp.fails_with(format('select public.approve_order_pi_revision(%L, %L, pg_temp.wb_payload(%L, %L::jsonb, %L::jsonb))',
    v_ver, v_admin, v_ver,
    jsonb_build_array(jsonb_build_object('row', 32, 'seq', 'B001', 'name', 'ASSERT wb armchair (renamed)', 'qty', 3, 'rate', 10000),
                      jsonb_build_object('row', 36, 'seq', 'B002', 'name', 'ASSERT wb mirror', 'qty', 1, 'rate', 5000)),
    jsonb_build_object(pg_temp.row_id(v_sub, 36), 'new')));
  assert v_msg like 'ORDER_PI_REVISION_SEQUENCE_RETIRED%', 'a removed product''s number is never reused: ' || v_msg;
  assert (select count(*) from public.order_product_codes where order_id = v_order) = 5, 'five codes ever, none reused';
  raise notice '6. workbook revisions: matched by item number, ambiguous lines asked, retired numbers refused OK';
end $$;

-- ═══ 7. PRODUCTION IS NEVER ALIGNED BELOW THE 40% ADVANCE (§4d) ═════════════
--
-- The version is in force at the admin's approval, always. What the verified
-- advance decides is whether Operations can ALIGN production:
--   7a increase  → below 40% on the amended value: accepting is refused in the
--                  database, and a retry is refused the same way, changing
--                  nothing; "Cannot accept" is still possible
--   7b pending   → a payment awaiting Finance does not count, and is named
--   7c verified  → once Finance verifies enough, the same accept goes through
--   7d decrease  → a smaller value can only help: accepted at once
--   7e exception → an admin's explicit below-40% approval lets it through;
--                  Sales/Operations cannot give one; it is refused when not
--                  needed; a later value change makes it stale
--   7f any write → a raw UPDATE to aligned is refused too

create function pg_temp.fresh_order(p_client text, p_total numeric, p_paid numeric) returns uuid language plpgsql as $$
declare
  v_sub   uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_wb    text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_pay   uuid := gen_random_uuid();
  v_res   jsonb;
begin
  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', v_sales, v_sales, '[]', '[]');
  update public.order_submissions
     set client_name = p_client, gross_product_amount = p_total, discount_amount = 0,
         grand_total = p_total, source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64)
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_sub, 32, 'B001', p_client || ' chair', 10, p_total / 10, p_total, 0);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select v_sub, i.id, 'representative', 0,
         'submissions/' || v_sub || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png', 'image/png', repeat('c', 64), i.source_row
    from public.order_submission_items i where i.submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', m.storage_path, jsonb_build_object('mimetype', 'image/png') from public.order_submission_item_images m where m.submission_id = v_sub;
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ASSERT adv', p_paid, current_date, 'hdfc', 'approved_unlinked', v_sales, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, v_sub, p_paid, 'order_submission', v_sales);
  perform pg_temp.become(v_sales);
  perform public.submit_pi_for_review(v_sub, null, null, null, null);
  perform pg_temp.restore();
  perform pg_temp.become(v_admin);
  if (select pi_approved_at from public.order_submissions where id = v_sub) is null then
    perform public.approve_pi_review(v_sub);
  end if;
  v_res := public.approve_order_submission(v_sub, v_sales, current_date, current_date + 30, 'reference');
  perform pg_temp.restore();
  return (v_res ->> 'order_id')::uuid;
end $$;

-- A payment on the Order itself, in the given Finance state.
create function pg_temp.pay_order(p_order uuid, p_amount numeric, p_status text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v, 'ASSERT adv', p_amount, current_date, 'hdfc', p_status, current_setting('test.sales_id')::uuid, null);
  insert into public.finance_payment_allocations (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
  values (v, p_order, p_amount, 'confirmed_order', current_setting('test.sales_id')::uuid);
  return v;
end $$;

-- Operations' decision on the live handoff, as the reviewer. EVERY refusal is
-- printed with its SQLSTATE and where it was raised, whatever the caller then
-- asserts, so an intermittent §7 failure leaves its cause in the log (the two
-- earlier ones did not: they were caught here and never shown).
create function pg_temp.ops_decide(p_order uuid, p_decision text, p_reason text default null) returns text language plpgsql as $$
declare v text; h uuid; v_state text; v_where text;
begin
  select id into h from public.order_operations_handoffs where order_id = p_order and superseded_at is null;
  perform pg_temp.become(current_setting('test.ops_id')::uuid);
  begin
    perform public.decide_order_operations_handoff(h, p_decision, p_reason);
    v := 'OK';
  exception when others then
    get stacked diagnostics v = message_text, v_state = returned_sqlstate, v_where = pg_exception_context;
    raise notice 'ops_decide(%, %) refused [%]: % | at: %', p_order, p_decision, v_state, v, left(replace(v_where, E'\n', ' <- '), 400);
  end;
  perform pg_temp.restore();
  return v;
end $$;

-- A value change through the real revision door: one line at a new rate.
create function pg_temp.revalue(p_order uuid, p_total numeric, p_reason text) returns void language plpgsql as $$
declare v_sub uuid; v_item uuid;
begin
  select source_order_submission_id into v_sub from public.orders where id = p_order;
  select id into v_item from public.order_submission_items where submission_id = v_sub;
  perform pg_temp.propose_and_approve(p_order, pg_temp.proposal(v_sub, jsonb_build_array(
    jsonb_build_object('id', v_item, 'seq', 'B001', 'name', 'ASSERT adv chair', 'qty', 10, 'rate', p_total / 10))), p_reason);
end $$;

do $$
declare
  o     uuid;
  v_msg text;
  v_pos jsonb;
  v_pend uuid;
begin
  -- V1 at exactly 40% (400,000 of 1,000,000): Operations accepts, aligned.
  o := pg_temp.fresh_order('ASSERT adv', 1000000, 400000);
  perform set_config('test.adv_order', o::text, true);
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg = 'OK' and (select production_alignment from public.orders where id = o) = 'aligned',
    '7. V1 at 40% is accepted and aligned: ' || v_msg || ' ' || coalesce(public.order_advance_position(o)::text, '');

  -- 7a. V2 raises the value to 1,250,000: V2 is in force, the advance is 32%.
  perform pg_temp.revalue(o, 1250000, 'ASSERT client added a second room');
  assert (select version_number from public.order_pi_versions where order_id = o and status = 'approved') = 2, '7a. V2 is in force at approval';
  assert (select total_value from public.orders where id = o) = 1250000, '7a. the Order was amended';
  v_pos := public.order_advance_position(o);
  assert (v_pos ->> 'below')::boolean and not (v_pos ->> 'ready')::boolean
     and (v_pos ->> 'percent')::numeric = 32 and (v_pos ->> 'shortfall')::numeric = 100000,
    '7a. measured on the amended value: 32%, ₹1,00,000 short: ' || v_pos::text;
  assert (select production_alignment from public.orders where id = o) = 'not_aligned', '7a. the V1 alignment was reset';
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg like 'ORDER_ADVANCE_BELOW_THRESHOLD: Order % has ₹400000.00 verified — 32.00% of its ₹1250000.00 value. ₹100000.00 more verified payment%',
    '7a. Operations cannot align it: ' || v_msg;
  assert (select status from public.order_operations_handoffs where order_id = o and superseded_at is null) = 'awaiting'
     and (select production_alignment from public.orders where id = o) = 'not_aligned', '7a. and the refused decision changed nothing';
  assert pg_temp.ops_decide(o, 'accepted') like 'ORDER_ADVANCE_BELOW_THRESHOLD%', '7a. a retry is refused the same way';

  -- 7b. ₹1,00,000 recorded but awaiting Finance: still refused, and named.
  v_pend := pg_temp.pay_order(o, 100000, 'pending_approval');
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg like 'ORDER_ADVANCE_BELOW_THRESHOLD%₹100000.00 is awaiting Finance verification.', '7b. pending money does not count: ' || v_msg;
  assert (public.order_advance_position(o) ->> 'awaiting')::numeric = 100000, '7b. and it is reported';

  -- "Cannot accept" is never blocked by the advance.
  assert pg_temp.ops_decide(o, 'clarification_needed', 'ASSERT waiting for the client''s second payment') = 'OK',
    '7a. Operations can still flag the version';

  -- 7c. Finance verifies it: the same acceptance now goes through.
  update public.finance_payment_requests set status = 'approved_unlinked' where id = v_pend;
  assert (public.order_advance_position(o) ->> 'ready')::boolean, '7c. 40% of the amended value is verified';
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg = 'OK' and (select production_alignment from public.orders where id = o) = 'aligned',
    '7c. once verified, Operations aligns production: ' || v_msg;

  -- 7d. V3 LOWERS the value: the advance only improves; accepted at once.
  perform pg_temp.revalue(o, 1100000, 'ASSERT client dropped a table');
  assert (public.order_advance_position(o) ->> 'ready')::boolean, '7d. a decrease keeps the advance met';
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '7d. and V3 is accepted';

  -- 7e. V4 raises it again to 2,000,000 (25%): an explicit exception.
  perform pg_temp.revalue(o, 2000000, 'ASSERT client doubled the order');
  assert pg_temp.ops_decide(o, 'accepted') like 'ORDER_ADVANCE_BELOW_THRESHOLD%', '7e. below 40% again';
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  begin perform public.approve_order_advance_exception(o, 'ASSERT sales would like to go ahead'); v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text; end;
  perform pg_temp.restore();
  assert v_msg like 'Only an administrator%', '7e. Sales cannot approve it: ' || v_msg;
  perform pg_temp.become(current_setting('test.ops_id')::uuid);
  begin perform public.approve_order_advance_exception(o, 'ASSERT operations would like to go ahead'); v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text; end;
  perform pg_temp.restore();
  assert v_msg like 'Only an administrator%', '7e. nor can Operations: ' || v_msg;
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  begin perform public.approve_order_advance_exception(o, 'short'); v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text; end;
  assert v_msg like 'ORDER_ADVANCE_EXCEPTION_REASON_REQUIRED%', '7e. a reason is required: ' || v_msg;
  v_pos := public.approve_order_advance_exception(o, 'ASSERT long-standing client, balance on delivery');
  perform pg_temp.restore();
  assert (v_pos ->> 'ready')::boolean and v_pos #>> '{exception,source}' = 'order', '7e. the exception makes it ready: ' || v_pos::text;
  assert exists (select 1 from public.order_activity_log where order_id = o and event_type = 'order_advance_exception_approved'
                   and actor_id = current_setting('test.admin_id')::uuid and (payload ->> 'order_value')::numeric = 2000000),
    '7e. and it is recorded, with the value it covers';
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '7e. Operations aligns under the exception';

  -- A later value change makes that exception stale.
  perform pg_temp.revalue(o, 2100000, 'ASSERT one more chair');
  assert not (public.order_advance_position(o) ->> 'ready')::boolean, '7e. the exception covered 20,00,000, not 21,00,000';
  assert pg_temp.ops_decide(o, 'accepted') like 'ORDER_ADVANCE_BELOW_THRESHOLD%', '7e. so accepting is refused again';

  -- Not needed once 40% is verified.
  perform pg_temp.pay_order(o, 400000, 'approved_unlinked');
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  begin perform public.approve_order_advance_exception(o, 'ASSERT just in case, no need'); v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text; end;
  perform pg_temp.restore();
  assert v_msg like 'ORDER_ADVANCE_EXCEPTION_NOT_NEEDED%', '7e. no exception is given where none is needed: ' || v_msg;

  -- 7f. Any write, not only the doors.
  perform pg_temp.revalue(o, 3000000, 'ASSERT a much larger order');
  begin
    update public.orders set production_alignment = 'aligned' where id = o;
    v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'ORDER_ADVANCE_BELOW_THRESHOLD%' or v_msg like 'ORDER_PRODUCTION_ALIGNMENT%' or v_msg like '%alignment%',
    '7f. a raw write to aligned is refused: ' || v_msg;
  raise notice '7. production is never aligned below 40%% of the amended value: increase, pending, verified, retry, decrease, exception, stale, raw write OK';
end $$;

do $$ begin raise notice 'ALL IN-FORCE-AT-APPROVAL ASSERTIONS PASSED'; end $$;

rollback;
