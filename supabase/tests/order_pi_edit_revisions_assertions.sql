-- EDIT PI: AN APPROVED PI CHANGES ONLY AS A NEW VERSION (20270103000000)
-- ===========================================================================
-- Through the real doors, on a disposable stack:
--
--   1. guard      an approved PI refuses every direct edit — the admin RPCs,
--                 a raw UPDATE, its product lines — outside a version
--   2. propose    propose_order_pi_edit_revision is service-role only; the
--                 owner's proposal is PENDING; V1 stays current and the PI and
--                 Order are byte-for-byte unchanged; an outsider is refused; a
--                 second open revision is refused
--   3. drafts     order_pi_edit_drafts is private to its author
--   4. authorize  an Admin stages V2; still nothing current moves
--   5. accept     the Operations reviewer accepts: V2 is current, V1 superseded
--                 and still readable in full, the edited product lines and the
--                 edited TERMS are in force, the payment allocation untouched
--   6. money      a V3 that changes the price meets #205's amendment gate at
--                 acceptance and, rejected by Operations, changes nothing
--   7. reject     a V4 rejected by the Admin changes nothing; history keeps all
--
-- Runs inside ONE transaction that ends in ROLLBACK.
-- PREREQUISITES: as order_submission_numbering_at_conversion_assertions.sql
-- (TEST-001 admin 1111…, sales 5555…, operations 7777…), with 20270103000000.
-- On success prints NOTICE 'ALL EDIT PI ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.admin_id', '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.sales_id', '55555555-5555-5555-5555-555555555555', true);
  perform set_config('test.ops_id',   '77777777-7777-7777-7777-777777777777', true);
  perform set_config('test.out_id',   '44444444-4444-4444-4444-444444444444', true);
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

-- The PI in force, as a fingerprint of everything a reader of it sees.
create function pg_temp.fingerprint(p_sub uuid) returns text language sql as $$
  select md5(public.order_pi_content_of(p_sub)::text
             || coalesce((select to_jsonb(o) - 'updated_at' from public.orders o
                           where o.source_order_submission_id = p_sub)::text, ''))
$$;

-- A proposal as the Edit PI route builds it: the PI in force, with changes.
create function pg_temp.proposal(p_sub uuid, p_name text, p_rate numeric, p_add_line boolean,
                                 p_fabric text, p_payment_terms text)
returns jsonb language plpgsql as $$
declare
  s public.order_submissions%rowtype;
  o public.orders%rowtype;
  v_items jsonb; v_images jsonb; v_gross numeric;
begin
  select * into s from public.order_submissions where id = p_sub;
  select * into o from public.orders where source_order_submission_id = p_sub;
  select jsonb_agg(jsonb_build_object(
           'id', i.id, 'source_row', i.source_row, 'item_sequence', i.item_sequence,
           'source_product_code', i.source_product_code, 'product_name', p_name,
           'quantity', i.quantity, 'dimensions', i.dimensions, 'material', i.material,
           'customization', i.customization, 'cost_per_piece', p_rate,
           'total_amount', i.quantity * p_rate, 'image_storage_path', i.image_storage_path,
           'image_mime_type', i.image_mime_type, 'image_sha256', i.image_sha256,
           'image_anchor_row', i.image_anchor_row, 'sort_order', i.sort_order) order by i.sort_order)
    into v_items from public.order_submission_items i where i.submission_id = p_sub;
  select coalesce(jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'submission_id'), '[]'::jsonb) into v_images
    from public.order_submission_item_images m where m.submission_id = p_sub;
  if p_add_line then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(), 'source_row', 99, 'product_name', 'ASSERT side table',
      'quantity', 1, 'cost_per_piece', 5000, 'total_amount', 5000, 'sort_order', 9));
  end if;
  select sum((e ->> 'total_amount')::numeric) into v_gross from jsonb_array_elements(v_items) e;
  return jsonb_build_object(
    'payload', jsonb_build_object(
      'header', jsonb_build_object('client_name', o.client_name, 'order_confirmation_date', o.confirm_date,
                                   'due_date', o.due_date, 'creation_date', s.creation_date),
      'commercial', jsonb_build_object('gross_product_amount', v_gross, 'discount_amount', 0,
                                       'total_before_gst', v_gross, 'gst_amount', 0, 'grand_total', v_gross),
      'source', jsonb_build_object('workbook_path', s.source_workbook_path, 'workbook_sha256', s.source_workbook_sha256),
      'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
      'items', v_items, 'item_images', v_images,
      'seed_terms', jsonb_build_object('fabric_responsibility', p_fabric),
      'fingerprint', encode(sha256(convert_to(v_items::text || p_rate::text, 'UTF8')), 'hex')),
    'terms', jsonb_build_object('fabric_responsibility', p_fabric, 'payment_terms', p_payment_terms),
    'change_summary', jsonb_build_array('ASSERT change'));
end $$;

-- ── Fixture: one approved PI, confirmed into an Order, as V1 ──
do $$
declare
  v_sub   uuid := gen_random_uuid();
  v_item  uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_sha   text := repeat('a', 64);
  v_wb    text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_img   text;
  v_pay   uuid := gen_random_uuid();
  v_res   jsonb;
begin
  delete from public.order_operations_reviewers where duty = 'pi_handoff';
  insert into public.order_operations_reviewers (duty, user_id, assigned_by)
  values ('pi_handoff', current_setting('test.ops_id')::uuid, v_admin);

  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', v_sales, v_sales, '[]', '[]');
  update public.order_submissions
     set client_name = 'ASSERT edit client', gross_product_amount = 100000, discount_amount = 0,
         grand_total = 100000, source_workbook_path = v_wb, source_workbook_sha256 = v_sha,
         fabric_responsibility = 'client', commercial_terms_note = 'Ex-factory.', client_city = 'Coimbatore'
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (id, submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_item, v_sub, 32, 'B001', 'ASSERT lounge chair', 10, 10000, 100000, 0);
  v_img := 'submissions/' || v_sub || '/images/' || v_item || '/representative/0-' || v_sha || '.png';
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  values (v_sub, v_item, 'representative', 0, v_img, 'image/png', v_sha, 32);
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_img, jsonb_build_object('mimetype', 'image/png'));

  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ASSERT', 40000, current_date, 'hdfc', 'approved_unlinked', v_sales, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, v_sub, 40000, 'order_submission', v_sales);

  perform pg_temp.become(v_sales);
  perform public.submit_pi_for_review(v_sub, null, null, null, null);
  perform pg_temp.restore();
  perform pg_temp.become(v_admin);
  if (select pi_approved_at from public.order_submissions where id = v_sub) is null then
    perform public.approve_pi_review(v_sub);
  end if;
  v_res := public.approve_order_submission(v_sub, v_sales, current_date, current_date + 30, 'reference');
  perform pg_temp.restore();

  perform set_config('test.sub', v_sub::text, true);
  perform set_config('test.order', v_res ->> 'order_id', true);
  perform set_config('test.pay', v_pay::text, true);
  assert (select status from public.order_pi_versions where order_id = (v_res ->> 'order_id')::uuid) = 'approved',
    'fixture: V1 is current';
end $$;


-- ═══ 1. AN APPROVED PI REFUSES EVERY DIRECT EDIT ═════════════════════════════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_msg   text;
  v_fp    text := pg_temp.fingerprint(v_sub);
begin
  perform pg_temp.become(v_admin);
  v_msg := pg_temp.fails_with(format(
    'select public.update_order_submission_client_details(%L, %L::jsonb, null, %L)',
    v_sub, '{"client_name": "ASSERT overwritten"}', 'ASSERT direct edit'));
  perform pg_temp.restore();
  assert v_msg like 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%', 'the admin client-details door: ' || v_msg;

  v_msg := pg_temp.fails_with(format('update public.order_submissions set grand_total = 1 where id = %L', v_sub));
  assert v_msg like 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%', 'a raw UPDATE, even as the owner of the table: ' || v_msg;

  v_msg := pg_temp.fails_with(format(
    'update public.order_submission_items set product_name = %L where submission_id = %L', 'x', v_sub));
  assert v_msg like 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%', 'its product lines: ' || v_msg;

  v_msg := pg_temp.fails_with(format('delete from public.order_submission_item_images where submission_id = %L', v_sub));
  assert v_msg like 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%', 'its pictures: ' || v_msg;

  assert pg_temp.fingerprint(v_sub) = v_fp, 'and nothing moved';
  raise notice '1. an approved PI refuses every direct edit OK';
end $$;


-- ═══ 2. PROPOSING AN EDIT CHANGES NOTHING CURRENT ════════════════════════════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_order uuid := current_setting('test.order')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_out   uuid := current_setting('test.out_id')::uuid;
  v_fp    text := pg_temp.fingerprint(v_sub);
  v_res   jsonb;
  v_msg   text;
  v_prop  jsonb := pg_temp.proposal(v_sub, 'ASSERT lounge chair, walnut', 10000, false, 'boe', '30% advance, 70% before dispatch');
begin
  assert not has_function_privilege('authenticated', 'public.propose_order_pi_edit_revision(uuid, uuid, jsonb, text)', 'EXECUTE'),
    'the browser cannot propose without the server';

  v_msg := pg_temp.fails_with(format('select public.propose_order_pi_edit_revision(%L, %L, %L::jsonb, %L)',
    v_order, v_out, v_prop, 'ASSERT intruder'));
  assert v_msg ilike '%permission%' or v_msg like 'ORDER_PI_REVISION_NOT_OWNER%', 'an outsider is refused: ' || v_msg;

  v_msg := pg_temp.fails_with(format('select public.propose_order_pi_edit_revision(%L, %L, %L::jsonb, %L)',
    v_order, v_sales, v_prop, ' '));
  assert v_msg like 'ORDER_PI_REVISION_REASON_REQUIRED%', 'a reason is required: ' || v_msg;

  v_res := public.propose_order_pi_edit_revision(v_order, v_sales, v_prop, 'ASSERT walnut finish and new terms');
  perform set_config('request.jwt.claims', '', true);
  assert v_res ->> 'status' = 'pending' and (v_res ->> 'version_number')::int = 2;
  perform set_config('test.v2', v_res ->> 'version_id', true);

  assert (select source_kind = 'edit' and proposal is not null and workbook_path = (select source_workbook_path from public.order_submissions where id = v_sub)
            from public.order_pi_versions where id = (v_res ->> 'version_id')::uuid),
    'an edit revision keeps the original workbook as its source of record';
  assert (select version_number from public.order_pi_versions where order_id = v_order and status = 'approved') = 1,
    'V1 stays the current version';
  assert pg_temp.fingerprint(v_sub) = v_fp, 'the PI and the Order are exactly as they were';

  v_msg := pg_temp.fails_with(format('select public.propose_order_pi_edit_revision(%L, %L, %L::jsonb, %L)',
    v_order, v_sales, v_prop, 'ASSERT second'));
  assert v_msg like 'ORDER_PI_REVISION_PENDING%', 'one open revision at a time: ' || v_msg;

  v_msg := pg_temp.fails_with(format('update public.order_pi_versions set proposal = %L::jsonb where id = %L',
    '{"payload": {}}', v_res ->> 'version_id'));
  assert v_msg like 'ORDER_PI_VERSION_IMMUTABLE%', 'what a version proposed is permanent: ' || v_msg;

  raise notice '2. proposing changes nothing current OK';
end $$;


-- ═══ 3. UNSENT EDIT WORK IS PRIVATE ═════════════════════════════════════════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_order uuid := current_setting('test.order')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_ops   uuid := current_setting('test.ops_id')::uuid;
  v_n     integer;
begin
  perform pg_temp.become(v_sales);
  insert into public.order_pi_edit_drafts (order_id, submission_id, edit, reason)
  values (v_order, v_sub, '{"header": {}}', 'ASSERT half-done');
  perform pg_temp.restore();

  perform pg_temp.become(v_ops);
  select count(*) into v_n from public.order_pi_edit_drafts where order_id = v_order;
  perform pg_temp.restore();
  assert v_n = 0, 'somebody else''s unsent edit is invisible';

  perform pg_temp.become(v_ops);
  assert pg_temp.fails_with(format(
    'insert into public.order_pi_edit_drafts (order_id, submission_id, edit) values (%L, %L, %L::jsonb)',
    v_order, v_sub, '{}')) <> 'NO ERROR', 'and a non-proposer cannot keep one';
  perform pg_temp.restore();

  perform pg_temp.become(v_sales);
  select count(*) into v_n from public.order_pi_edit_drafts where order_id = v_order;
  delete from public.order_pi_edit_drafts where order_id = v_order;
  perform pg_temp.restore();
  assert v_n = 1, 'the author sees their own';
  raise notice '3. unsent edit work is private OK';
end $$;


-- ═══ 4 + 5. AUTHORIZE, THEN ACCEPT ══════════════════════════════════════════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_order uuid := current_setting('test.order')::uuid;
  v_v2    uuid := current_setting('test.v2')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_ops   uuid := current_setting('test.ops_id')::uuid;
  v_fp    text := pg_temp.fingerprint(v_sub);
  v_v1    uuid;
  v_det   jsonb;
  v_res   jsonb;
begin
  select id into v_v1 from public.order_pi_versions where order_id = v_order and version_number = 1;

  -- 4. The Admin authorizes it with its stored proposal (what the approve route sends).
  v_res := public.approve_order_pi_revision(v_v2, v_admin,
    (select proposal -> 'payload' from public.order_pi_versions where id = v_v2));
  assert v_res ->> 'status' = 'admin_approved';
  assert pg_temp.fingerprint(v_sub) = v_fp, 'authorizing moves nothing current';
  assert (select status from public.order_pi_versions where id = v_v1) = 'approved', 'V1 is still in force';

  -- 5. The Operations reviewer accepts.
  perform pg_temp.become(v_ops);
  v_res := public.decide_order_pi_revision_operations(v_v2, 'accepted', null);
  perform pg_temp.restore();

  assert (select status from public.order_pi_versions where id = v_v2) = 'approved', 'V2 is current';
  assert (select status from public.order_pi_versions where id = v_v1) = 'superseded', 'V1 is kept as history';
  assert (select array_agg(product_name order by sort_order) from public.order_submission_items where submission_id = v_sub)
       = array['ASSERT lounge chair, walnut'], 'the edited line is in force';
  assert (select fabric_responsibility = 'boe' and payment_terms = '30% advance, 70% before dispatch'
            from public.order_submissions where id = v_sub),
    'and so are the edited TERMS — not only blanks filled';
  assert exists (select 1 from public.order_submission_item_images m
                  join public.order_submission_items i on i.id = m.item_id
                 where i.submission_id = v_sub and i.product_name = 'ASSERT lounge chair, walnut' and m.role = 'representative'),
    'the kept photo stays with its line';

  -- V1 can still be read in full.
  perform pg_temp.become(v_admin);
  v_det := public.order_pi_version_detail(v_v1);
  perform pg_temp.restore();
  assert v_det ->> 'source' = 'captured', 'V1 was captured when it was replaced: ' || (v_det ->> 'source');
  assert v_det #>> '{content,items,0,product_name}' = 'ASSERT lounge chair', 'with its own product name';
  assert v_det #>> '{content,submission,fabric_responsibility}' = 'client', 'and its own terms';

  perform pg_temp.become(v_admin);
  v_det := public.order_pi_version_detail(v_v2);
  perform pg_temp.restore();
  assert v_det ->> 'source' = 'proposal';

  -- The payment followed the Order at conversion and was not touched since.
  assert (select count(*) from public.finance_payment_allocations
           where payment_request_id = current_setting('test.pay')::uuid and order_id = v_order and status = 'active') = 1,
    'the allocation is on the Order, once';

  raise notice '4-5. authorize, accept, V1 kept in full OK';
end $$;


-- ═══ 6. A PRICE CHANGE MEETS #205's AMENDMENT GATE ══════════════════════════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_order uuid := current_setting('test.order')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_ops   uuid := current_setting('test.ops_id')::uuid;
  v_v3    uuid;
  v_fp    text;
  v_msg   text;
begin
  v_v3 := (public.propose_order_pi_edit_revision(v_order, v_sales,
    pg_temp.proposal(v_sub, 'ASSERT lounge chair, walnut', 12000, false, 'boe', null), 'ASSERT price rise') ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  perform public.approve_order_pi_revision(v_v3, v_admin, (select proposal -> 'payload' from public.order_pi_versions where id = v_v3));
  v_fp := pg_temp.fingerprint(v_sub);

  perform pg_temp.become(v_ops);
  v_msg := pg_temp.fails_with(format('select public.decide_order_pi_revision_operations(%L, %L, null)', v_v3, 'accepted'));
  perform pg_temp.restore();
  assert v_msg like 'ORDER_PI_REVISION_AMENDMENT_REQUIRED%', 'a changed Order value must be amended first: ' || v_msg;
  assert pg_temp.fingerprint(v_sub) = v_fp, 'a refused acceptance moves nothing';

  perform pg_temp.become(v_ops);
  perform public.decide_order_pi_revision_operations(v_v3, 'rejected', 'ASSERT not agreed with the client');
  perform pg_temp.restore();
  assert (select status from public.order_pi_versions where id = v_v3) = 'rejected';
  assert (select version_number from public.order_pi_versions where order_id = v_order and status = 'approved') = 2,
    'V2 is still current';
  assert pg_temp.fingerprint(v_sub) = v_fp;
  raise notice '6. a price change meets the amendment gate and a rejection changes nothing OK';
end $$;


-- ═══ 6b. AN ADDED, PRICED PRODUCT GOES THROUGH ONCE THE ORDER IS AMENDED ════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_order uuid := current_setting('test.order')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_ops   uuid := current_setting('test.ops_id')::uuid;
  v_v4    uuid;
  v_prop  jsonb := pg_temp.proposal(v_sub, 'ASSERT lounge chair, walnut', 12000, true, 'boe', '30% advance, 70% before dispatch');
  v_total numeric := (v_prop #>> '{payload,commercial,grand_total}')::numeric;
begin
  v_v4 := (public.propose_order_pi_edit_revision(v_order, v_sales, v_prop, 'ASSERT dearer chair and a side table') ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  perform public.approve_order_pi_revision(v_v4, v_admin, (select proposal -> 'payload' from public.order_pi_versions where id = v_v4));

  -- #205's reconciliation path: the Admin amends the Order to the new value.
  perform pg_temp.become(v_admin);
  perform public.amend_order(v_order, 'ASSERT client agreed the revised value', null, v_total, v_total);
  perform pg_temp.restore();

  perform pg_temp.become(v_ops);
  perform public.decide_order_pi_revision_operations(v_v4, 'accepted', null);
  perform pg_temp.restore();
  assert (select status from public.order_pi_versions where id = v_v4) = 'approved', 'V4 is current';
  assert (select array_agg(product_name order by sort_order) from public.order_submission_items where submission_id = v_sub)
       = array['ASSERT lounge chair, walnut', 'ASSERT side table'], 'the added product is in force';
  assert (select grand_total from public.order_submissions where id = v_sub) = v_total, 'at the server-priced total';
  assert (select total_value from public.orders where id = v_order) = v_total, 'and the Order agrees';
  raise notice '6b. an added product goes through once the Order is amended OK';
end $$;


-- ═══ 7. AN ADMIN REJECTION CHANGES NOTHING; HISTORY KEEPS EVERYTHING ════════

do $$
declare
  v_sub   uuid := current_setting('test.sub')::uuid;
  v_order uuid := current_setting('test.order')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_v4    uuid;
  v_fp    text := pg_temp.fingerprint(v_sub);
begin
  v_v4 := (public.propose_order_pi_edit_revision(v_order, v_sales,
    pg_temp.proposal(v_sub, 'ASSERT renamed again', 12000, false, 'not_selected', null), 'ASSERT another idea') ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.become(v_admin);
  perform public.reject_order_pi_revision(v_v4, 'ASSERT keep V2');
  perform pg_temp.restore();
  assert (select status from public.order_pi_versions where id = v_v4) = 'rejected';
  assert pg_temp.fingerprint(v_sub) = v_fp, 'a rejected revision changes nothing';
  assert (select array_agg(status order by version_number) from public.order_pi_versions where order_id = v_order)
       = array['superseded', 'superseded', 'rejected', 'approved', 'rejected'], 'V1…V5 all remain in history';
  raise notice '7. rejection changes nothing, history keeps all OK';
end $$;

do $$ begin raise notice 'ALL EDIT PI ASSERTIONS PASSED'; end $$;

rollback;
