-- HELPERS for the PI version PDF Order number suite (20270201000000).
-- Not a suite on its own: run_order_pi_version_pdf_order_number_local.sh
-- prepends it to the fixture and to the assertions, in the same psql session.
--
-- Every PI version these helpers make goes through the real doors, as the app
-- drives them:
--   V1        save_order_submission_internal_details → submit_pi_for_review →
--             approve_pi_review → approve_order_submission
--   revision  propose_order_pi_edit_revision (Edit PI) or
--             propose_order_pi_revision (a revised workbook), then
--             approve_order_pi_revision or reject_order_pi_revision
--
-- PREREQUISITES: TEST-001 admin 1111…, sales 5555…, operations 7777….

\set ON_ERROR_STOP on

select set_config('test.admin_id', '11111111-1111-1111-1111-111111111111', false),
       set_config('test.sales_id', '55555555-5555-5555-5555-555555555555', false),
       set_config('test.ops_id',   '77777777-7777-7777-7777-777777777777', false),
       set_config('test.outsider_id', '44444444-4444-4444-4444-444444444444', false);

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

-- The route's expression, in SQL: formatOrderOperationalNumber(trim) ?? trim.
create function pg_temp.route_number(p_display text) returns text language sql immutable as $$
  select coalesce(public.order_operational_number(btrim(p_display)), btrim(p_display))
$$;

-- The release stage the database is at, from the session setting test.stage:
--   'old'    20270201000000 alone: new versions are stamped with what the
--            route being replaced prints ("4") — the default;
--   'stored' after 20270202000000: new versions carry the stored "0004".
create function pg_temp.stage() returns text language sql stable as $$
  select coalesce(nullif(current_setting('test.stage', true), ''), 'old')
$$;

-- What a version created now must be stamped with, at this stage.
create function pg_temp.expected_stamp(p_display text) returns text language sql stable as $$
  select case pg_temp.stage() when 'stored' then btrim(p_display) else pg_temp.route_number(p_display) end
$$;

-- A new PI, sent, reviewed and approved into an Order with V1. Returns the Order id.
create function pg_temp.new_order(p_label text) returns uuid language plpgsql as $$
declare
  v_sub   uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_wb    text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_pay   uuid := gen_random_uuid();
  v_res   jsonb;
begin
  if not exists (select 1 from public.order_operations_reviewers where duty = 'pi_handoff') then
    insert into public.order_operations_reviewers (duty, user_id, assigned_by)
    values ('pi_handoff', current_setting('test.ops_id')::uuid, v_admin);
  end if;

  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', v_sales, v_sales, '[]', '[]');
  update public.order_submissions
     set client_name = 'ASSERT pdfnum ' || p_label, gross_product_amount = 40000, discount_amount = 0,
         grand_total = 40000, total_before_gst = 40000, source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64),
         fabric_responsibility = 'client', commercial_terms_note = 'Ex-factory.', client_city = 'Pune'
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_sub, 32, 'B001', 'ASSERT chair', 2, 10000, 20000, 0),
         (v_sub, 33, 'B002', 'ASSERT table', 2, 10000, 20000, 1);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select v_sub, i.id, 'representative', 0,
         'submissions/' || v_sub || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png',
         'image/png', repeat('c', 64), i.source_row
    from public.order_submission_items i where i.submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', m.storage_path, jsonb_build_object('mimetype', 'image/png')
    from public.order_submission_item_images m where m.submission_id = v_sub;

  -- Half the value paid and allocated to the draft: above the advance requirement.
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ASSERT pdfnum', 20000, current_date, 'hdfc', 'approved_unlinked', v_sales, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, v_sub, 20000, 'order_submission', v_sales);

  perform pg_temp.become(v_sales);
  perform public.save_order_submission_internal_details(v_sub,
    jsonb_build_object('order_confirmation_date', current_date, 'due_date', current_date + 30,
                       'middleman_commission', 'no'), null, true);
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

-- An Edit PI proposal of the Order's current lines at a new rate, as the
-- Edit PI route builds it.
create function pg_temp.edit_proposal(p_order uuid, p_rate numeric) returns jsonb language plpgsql as $$
declare
  o public.orders%rowtype;
  s public.order_submissions%rowtype;
  v_items jsonb; v_gross numeric;
begin
  select * into o from public.orders where id = p_order;
  select * into s from public.order_submissions where id = o.source_order_submission_id;
  select jsonb_agg(jsonb_build_object(
           'id', i.id, 'source_row', i.source_row, 'item_sequence', i.item_sequence,
           'product_name', i.product_name, 'quantity', i.quantity, 'cost_per_piece', p_rate,
           'total_amount', i.quantity * p_rate, 'sort_order', i.sort_order) order by i.sort_order),
         sum(i.quantity * p_rate)
    into v_items, v_gross
    from public.order_submission_items i where i.submission_id = s.id;
  return jsonb_build_object(
    'payload', jsonb_build_object(
      'header', jsonb_build_object('client_name', o.client_name, 'order_confirmation_date', o.confirm_date,
                                   'due_date', o.due_date, 'creation_date', s.creation_date),
      'commercial', jsonb_build_object('gross_product_amount', v_gross, 'discount_amount', 0,
                                       'total_before_gst', v_gross, 'gst_amount', 0, 'grand_total', v_gross),
      'source', jsonb_build_object('workbook_path', s.source_workbook_path, 'workbook_sha256', s.source_workbook_sha256),
      'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
      'items', v_items,
      'item_images', coalesce((select jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'submission_id')
                                 from public.order_submission_item_images m where m.submission_id = s.id), '[]'::jsonb),
      'seed_terms', jsonb_build_object('fabric_responsibility', 'client'),
      'fingerprint', encode(sha256(convert_to(v_items::text, 'UTF8')), 'hex')),
    'terms', jsonb_build_object('fabric_responsibility', 'client'),
    'change_summary', jsonb_build_array('ASSERT rate change'));
end $$;

-- Edit PI: propose. Returns the new (pending) version id.
create function pg_temp.propose_edit(p_order uuid, p_rate numeric, p_reason text) returns uuid language plpgsql as $$
declare v_ver uuid;
begin
  v_ver := (public.propose_order_pi_edit_revision(p_order, current_setting('test.sales_id')::uuid,
              pg_temp.edit_proposal(p_order, p_rate), p_reason) ->> 'version_id')::uuid;
  -- The door leaves the proposer's claim set; later fixture writes are not theirs.
  perform set_config('request.jwt.claims', '', true);
  return v_ver;
end $$;

-- A revised workbook: store it, propose it as Sales. Returns the new (pending) version id.
create function pg_temp.propose_workbook(p_order uuid, p_reason text) returns uuid language plpgsql as $$
declare
  v_sub  uuid := (select source_order_submission_id from public.orders where id = p_order);
  v_path text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_ver  uuid;
begin
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_path,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  perform public.propose_order_pi_revision(p_order, v_path, 'ASSERT revised.xlsx', p_reason);
  perform pg_temp.restore();
  select id into v_ver from public.order_pi_versions where order_id = p_order and workbook_path = v_path;
  return v_ver;
end $$;

-- The Admin approves an Edit PI revision: it is in force at once.
create function pg_temp.approve(p_version uuid) returns jsonb language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  return public.approve_order_pi_revision(p_version, current_setting('test.admin_id')::uuid,
    (select proposal -> 'payload' from public.order_pi_versions where id = p_version));
end $$;

-- The Admin rejects a revision.
create function pg_temp.reject(p_version uuid, p_reason text) returns void language plpgsql as $$
begin
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  perform public.reject_order_pi_revision(p_version, p_reason);
  perform pg_temp.restore();
end $$;
