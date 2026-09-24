-- REVISED PI PROMOTION assertions (20270101000000)
-- ===========================================================================
-- Through the REAL doors — the processing lease, approve_order_pi_revision()
-- (service role, staging) and decide_order_pi_revision_operations() — on a
-- disposable local stack:
--
--   * staging      admin approval changes NOTHING current: V1 in force, the
--                  Order's figures, lines, codes, V1's handoff and alignment
--   * freeze       the PI cannot be edited while V2 awaits operations; no
--                  second revision can be proposed
--   * authority    only the current reviewer decides; Sales, an admin who is
--                  not the reviewer, a former reviewer and anon are refused;
--                  the old pending → approved transition is refused
--   * matching V2  accepted → applied in one transaction, V1 superseded (its
--                  lines kept in the snapshot), V2's handoff accepted and the
--                  Order aligned, codes assigned, Sales told once
--   * different V2 accept refused with the amendment rule; after amend_order
--                  it is accepted and the Order keeps the amended values
--   * reject       reason required; nothing current moves; a new revision
--                  can then be proposed
--   * stale tabs   a second accept / reject is refused; a second admin
--                  approval is refused
--   * #202         documents sent with the PI are accepted with the PI
--                  version Operations accepts
--
-- Runs inside ONE transaction that ends in ROLLBACK.
-- On success prints NOTICE 'ALL PI REVISION PROMOTION ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

-- TWO LIFECYCLES, ONE SUITE. Against #205's own head (20270101000000) the
-- sections below prove staging and operations promotion, as they always did.
-- With 20270104000000 (#207) applied — the owner's rule: an Admin's approval
-- puts a revision in force and amends the Order — the same fixtures run the
-- L-sections instead, which assert what still holds of #205 (authority,
-- reassignment, the handoff and production alignment, #202's documents) and
-- what changed. Nothing is skipped on either database.
select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'approve_order_pi_revision'
                  and p.prosrc like '%apply_order_amendment(%') as superseded_by_20270104 \gset

begin;

do $$
begin
  perform set_config('test.owner_id',    '11111111-1111-1111-1111-111111111111', true); -- TEST-001, admin
  perform set_config('test.reviewer_id', '22222222-2222-2222-2222-222222222222', true); -- operations reviewer
  perform set_config('test.admin2_id',   '33333333-3333-3333-3333-333333333333', true); -- another admin
  perform set_config('test.outsider_id', '44444444-4444-4444-4444-444444444444', true);
  perform set_config('test.sales_id',    '55555555-5555-5555-5555-555555555555', true); -- the PI's owner
  perform set_config('test.reviewer2_id','66666666-6666-6666-6666-666666666666', true);
  perform set_config('test.viewer_id',   '77777777-7777-7777-7777-777777777777', true);
end $$;

-- ═══ 0. FIXTURES ════════════════════════════════════════════════════════════

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.reviewer_id')::uuid,  'ASSERT Reviewer',   'reviewer@example.test',  'member', 'operations', true, 'ASSERT-OPS'),
  (current_setting('test.reviewer2_id')::uuid, 'ASSERT Reviewer 2', 'reviewer2@example.test', 'member', 'operations', true, 'ASSERT-OPS2'),
  (current_setting('test.admin2_id')::uuid,    'ASSERT Admin Two',  'admin2@example.test',    'admin',  'management', true, 'ASSERT-ADM'),
  (current_setting('test.outsider_id')::uuid,  'ASSERT Outsider',   'out@example.test',       'member', 'design',     true, 'ASSERT-OUT'),
  (current_setting('test.sales_id')::uuid,     'ASSERT Sales',      'sales@example.test',     'member', 'sales',      true, 'ASSERT-SAL')
on conflict (id) do nothing;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u, pm.id, pa.id, true, current_setting('test.owner_id')::uuid
  from unnest(array[current_setting('test.reviewer_id')::uuid, current_setting('test.reviewer2_id')::uuid]) as u,
       public.permission_modules pm join public.permission_actions pa on pa.action_key = 'view'
 where pm.module_key = 'orders'
on conflict do nothing;

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

create function pg_temp.make_pi(p_id uuid, p_owner uuid, p_client text, p_total numeric) returns void language plpgsql as $$
declare
  v_item uuid := gen_random_uuid();
  v_wb   text := 'submissions/' || p_id::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha  text := repeat('a', 64);
  v_img  text;
begin
  -- Fixtures are written by the bypassing role with NO impersonated identity:
  -- a claim left behind by an earlier become() would make the payment trigger
  -- judge the fixture as that person.
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total,
     source_workbook_path, source_workbook_sha256, source_workbook_name, parse_warnings, parse_blocking_issues, reservation_required)
  values (p_id, 'draft', p_owner, p_owner, p_client, p_total, 0, p_total, v_wb, v_sha, 'pi.xlsx', '[]', '[]', false);
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_wb, jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items
    (id, submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_item, p_id, 10, '1', 'ASSERT chair', 1, p_total, p_total, 0);
  v_img := 'submissions/' || p_id::text || '/images/' || v_item::text || '/representative/0-' || v_sha || '.png';
  insert into public.order_submission_item_images
    (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  values (p_id, v_item, 'representative', 0, v_img, 'image/png', v_sha, 10);
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_img, jsonb_build_object('mimetype', 'image/png'));
  -- verified 40%, nothing awaiting: the Order gate is clear
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (gen_random_uuid(), 'ASSERT', p_total * 0.4, current_date, 'hdfc', 'approved_unlinked', p_owner, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  select id, p_id, amount, 'order_submission', p_owner from public.finance_payment_requests where client_name = 'ASSERT' and amount = p_total * 0.4
   and not exists (select 1 from public.finance_payment_allocations a where a.payment_request_id = finance_payment_requests.id);
  update public.order_submissions set status = 'submitted', submitted_at = now() where id = p_id;
end $$;

/** Approve a submitted PI as the owner; returns the Order id. */
create function pg_temp.approve(p_pi uuid) returns uuid language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  v := public.approve_order_submission(p_pi, current_setting('test.sales_id')::uuid, current_date, current_date + 30, 'reference');
  perform pg_temp.restore();
  return (v ->> 'order_id')::uuid;
end $$;

/** A revised version put in force through the writes the revision path makes since 20270101000000: admin approval stages it (admin_approved), the operations acceptance promotes it. */
create function pg_temp.approve_revision(p_order uuid, p_actor uuid) returns uuid language plpgsql as $$
declare v_sub uuid; v_cur record; v_new uuid;
begin
  select source_order_submission_id into v_sub from public.orders where id = p_order;
  select * into v_cur from public.order_pi_versions where order_id = p_order and status = 'approved';
  insert into public.order_pi_versions (order_id, submission_id, version_number, status, workbook_path, workbook_name, uploaded_by, revision_reason)
  values (p_order, v_sub, v_cur.version_number + 1, 'pending',
          'submissions/' || v_sub::text || '/original/' || gen_random_uuid()::text || '.xlsx', 'rev.xlsx',
          current_setting('test.sales_id')::uuid, 'ASSERT revised figures')
  returning id into v_new;
  update public.order_pi_versions set status = 'admin_approved', decided_by = p_actor, decided_at = now() where id = v_new;
  perform set_config('boe.pi_revision_apply', v_sub::text, true);
  update public.order_pi_versions set status = 'superseded', superseded_at = now(), superseded_by_version_id = v_new where id = v_cur.id;
  update public.order_pi_versions set status = 'approved', operations_decided_by = p_actor, operations_decided_at = now(), applied_at = now() where id = v_new;
  perform set_config('boe.pi_revision_apply', '', true);
  return v_new;
end $$;

create function pg_temp.expect_error(p_sql text, p_marker text, p_label text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
    if position(p_marker in v_msg) = 0 then
      raise exception 'ASSERT %: expected error containing "%", got "%"', p_label, p_marker, v_msg;
    end if;
    return;
  end;
  raise exception 'ASSERT %: expected an error containing "%", got none', p_label, p_marker;
end $$;

create function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'ASSERT FAILED: %', p_label; end if;
end $$;

create function pg_temp.live(p_order uuid) returns public.order_operations_handoffs language sql as $$
  select * from public.order_operations_handoffs where order_id = p_order and superseded_at is null;
$$;
create function pg_temp.alignment(p_order uuid) returns text language sql as $$
  select production_alignment from public.orders where id = p_order;
$$;
create function pg_temp.decide(p_user uuid, p_handoff uuid, p_decision text, p_reason text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.decide_order_operations_handoff(p_handoff, p_decision, p_reason);
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.assign(p_user uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  v := public.set_order_operations_reviewer(p_user);
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.align(p_user uuid, p_order uuid, p_aligned boolean, p_note text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.set_order_production_alignment(p_order, p_aligned, p_note);
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.events(p_order uuid, p_type text) returns bigint language sql as $$
  select count(*) from public.order_activity_log where order_id = p_order and event_type = p_type;
$$;


insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.sales_id')::uuid, pm.id, pa.id, true, current_setting('test.owner_id')::uuid
  from public.permission_modules pm join public.permission_actions pa on pa.action_key in ('create', 'view')
 where pm.module_key = 'orders'
on conflict do nothing;

/** Sales proposes V2 with a stored workbook; returns the version id. */
create function pg_temp.propose(p_order uuid) returns uuid language plpgsql as $$
declare v_pi uuid; v_path text; v_id uuid;
begin
  select source_order_submission_id into v_pi from public.orders where id = p_order;
  v_path := 'submissions/' || v_pi || '/original/' || gen_random_uuid() || '.xlsx';
  perform set_config('request.jwt.claims', '', true);
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_path, jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  perform public.propose_order_pi_revision(p_order, v_path, 'v2.xlsx', 'ASSERT client changed quantities');
  perform pg_temp.restore();
  select id into v_id from public.order_pi_versions where order_id = p_order and status = 'pending';
  return v_id;
end $$;

/** The parsed payload of a revised workbook, as processUnderLease builds it. */
create function pg_temp.payload(p_version uuid, p_client text, p_total numeric, p_qty numeric) returns jsonb language sql as $$
  select jsonb_build_object(
    'source', jsonb_build_object('workbook_path', v.workbook_path, 'workbook_name', 'v2.xlsx', 'workbook_sha256', repeat('b', 64)),
    'header', jsonb_build_object('client_name', p_client),
    'commercial', jsonb_build_object('gross_product_amount', p_total, 'grand_total', p_total),
    'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
    'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'source_row', 10, 'item_sequence', '1',
             'product_name', 'ASSERT chair v2', 'quantity', p_qty, 'cost_per_piece', p_total / p_qty, 'total_amount', p_total)),
    'item_images', '[]'::jsonb,
    'seed_terms', jsonb_build_object('fabric_responsibility', null, 'commercial_terms_note', null, 'client_city', null))
  from public.order_pi_versions v where v.id = p_version;
$$;

/** The admin approval exactly as the route makes it: lease, service-role door, release. */
create function pg_temp.stage(p_version uuid, p_payload jsonb, p_admin uuid default null) returns jsonb language plpgsql as $$
declare v_pi uuid; v_tok uuid := gen_random_uuid(); v jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  select submission_id into v_pi from public.order_pi_versions where id = p_version;
  perform public.begin_order_submission_processing(v_pi, coalesce(p_admin, current_setting('test.owner_id')::uuid), v_tok);
  v := public.approve_order_pi_revision(p_version, coalesce(p_admin, current_setting('test.owner_id')::uuid),
         p_payload || jsonb_build_object('processing_token', v_tok));
  perform public.finish_order_submission_processing(v_pi, v_tok);
  return v;
end $$;

create function pg_temp.ops(p_user uuid, p_version uuid, p_decision text, p_reason text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.decide_order_pi_revision_operations(p_version, p_decision, p_reason);
  perform pg_temp.restore();
  return v;
end $$;

create function pg_temp.vstatus(p_order uuid) returns text language sql as $$
  select string_agg(version_number || '/' || status, ',' order by version_number) from public.order_pi_versions where order_id = p_order;
$$;
create function pg_temp.lines(p_order uuid) returns text language sql as $$
  select string_agg(i.product_name || ' x' || i.quantity::int, ',' order by i.sort_order)
    from public.order_submission_items i join public.orders o on o.source_order_submission_id = i.submission_id where o.id = p_order;
$$;
create function pg_temp.figures(p_order uuid) returns text language sql as $$
  select row(client_name, total_value, total_product_value, confirm_date, due_date, production_alignment)::text from public.orders where id = p_order;
$$;
create function pg_temp.live_handoff(p_order uuid) returns text language sql as $$
  select version_number || '/' || status from public.order_operations_handoffs where order_id = p_order and superseded_at is null;
$$;
/** EVERYTHING a reader of the PI in force sees, as one value: the Order row,
 *  the PI's parse-owned columns (the frozen list, incl. billing %), its lines
 *  in full, its images and whether their stored objects still exist, the
 *  product codes, the generated PDF/Excel records, and V1's version row. */
create function pg_temp.current_state(p_order uuid) returns text language sql as $$
  with o as (select * from public.orders where id = p_order),
       s as (select * from public.order_submissions where id = (select source_order_submission_id from o))
  select md5(concat_ws(' | ',
    (select (to_jsonb(o) - 'updated_at')::text from o),
    (select jsonb_object_agg(k, to_jsonb(s) -> k)::text from s, unnest(array[
      'parse_fingerprint', 'client_name', 'creation_date', 'source_created_by', 'boe_gst', 'contact_number',
      'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address', 'ship_to_name', 'ship_to_phone',
      'ship_to_gst', 'shipping_address', 'order_confirmation_date', 'dispatch_commitment', 'due_date',
      'source_order_number', 'source_workbook_path', 'source_workbook_name', 'source_workbook_size_bytes',
      'source_workbook_sha256', 'template_version', 'parse_warnings', 'parse_blocking_issues',
      'gross_product_amount', 'discount_amount', 'subtotal_after_discount', 'fabric_cost', 'fabric_cost_meaning',
      'fabric_cost_text', 'packing_cost', 'packing_cost_meaning', 'packing_cost_text', 'transportation_amount',
      'transportation_text', 'total_before_gst', 'gst_amount', 'grand_total', 'billing_percentage',
      'fabric_responsibility', 'commercial_terms_note', 'client_city', 'payment_terms', 'billing_terms']) k),
    (select jsonb_agg(to_jsonb(i) - 'updated_at' order by i.id)::text from public.order_submission_items i where i.submission_id = (select id from s)),
    (select jsonb_agg(to_jsonb(m) || jsonb_build_object('stored', exists (select 1 from storage.objects so
               where so.bucket_id = 'order-files' and so.name = m.storage_path)) order by m.id)::text
       from public.order_submission_item_images m where m.submission_id = (select id from s)),
    (select jsonb_agg(to_jsonb(c) order by c.id)::text from public.order_product_codes c where c.order_id = p_order),
    (select jsonb_agg(to_jsonb(d) - 'updated_at' order by d.id)::text from public.order_document_versions d where d.order_id = p_order),
    (select (to_jsonb(v) - 'updated_at')::text from public.order_pi_versions v where v.order_id = p_order and v.version_number = 1)));
$$;
/** A generated PI PDF/Excel for the Order, as the documents route leaves it. */
create function pg_temp.put_pdf(p_order uuid) returns void language plpgsql as $$
declare v_base text := 'orders/' || p_order || '/versions/1/' || gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_document_versions (order_id, version, status, excel_path, pdf_path, completed_at)
  values (p_order, 1, 'ready', v_base || '.xlsx', v_base || '.pdf', now());
end $$;

\if :superseded_by_20270104
-- ═══════════════════════════════════════════════════════════════════════════
-- ON A DATABASE WITH 20270104000000 (#207): THE LIFECYCLE AS IT NOW IS
-- ═══════════════════════════════════════════════════════════════════════════
-- The same fixtures and the same real doors, asserting what still holds of
-- #205 and what the owner's rule changed:
--   L1  a matching V2 is IN FORCE at admin approval: V1 superseded, the
--       Order's documents superseded, V2's handoff AWAITING the reviewer, the
--       old alignment reset — and the reviewer's acceptance aligns production
--       without being needed for V2 to be current; #205's operations door has
--       nothing left to decide; a pre-staging route is still refused
--   L2  a V2 with a new client and value amends the Order in the same step,
--       recorded as 'order_amended' (pi_revision), no amend_order needed
--   L3  "Cannot accept" (clarification_needed) leaves V2 current and the
--       Order not aligned for production
--   L4  authority: only an active admin approves; a second approval of the
--       same version is refused; the door stays service-role only
--   L5  reassignment readdresses the live handoff; the former reviewer can no
--       longer decide; with no reviewer the handoff is recorded unassigned and
--       every admin is told
--   L6  #202: documents sent with the PI are accepted with the version
--       Operations accepts
--   L7  an admin's rejection of a pending revision changes nothing

select pg_temp.assign(current_setting('test.reviewer_id')::uuid);
select set_config('test.pi_m', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_m')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT MATCH', 500000);
select set_config('test.order_m', pg_temp.approve(current_setting('test.pi_m')::uuid)::text, true);
select pg_temp.decide(current_setting('test.reviewer_id')::uuid,
  (select id from public.order_operations_handoffs where order_id = current_setting('test.order_m')::uuid), 'accepted', null);

do $$
declare o uuid := current_setting('test.order_m')::uuid; v uuid; r jsonb; h uuid;
        owner uuid := current_setting('test.owner_id')::uuid; sales uuid := current_setting('test.sales_id')::uuid;
        reviewer uuid := current_setting('test.reviewer_id')::uuid; before_state text;
begin
  perform pg_temp.put_pdf(o);
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved' and pg_temp.alignment(o) = 'aligned', 'L1. V1 in force, accepted, aligned');
  v := pg_temp.propose(o);
  before_state := pg_temp.current_state(o);
  perform pg_temp.expect_error(format('select pg_temp.stage(%L, pg_temp.payload(%L, ''ASSERT MATCH'', 500000, 2) - ''seed_terms'')', v, v),
          'ORDER_PI_REVISION_CLIENT_UPDATE_REQUIRED', 'L1. a pre-staging route''s approval is refused');
  perform pg_temp.check(pg_temp.current_state(o) = before_state, 'L1. …and nothing changed');

  r := pg_temp.stage(v, pg_temp.payload(v, 'ASSERT MATCH', 500000, 2));
  perform pg_temp.check(r ->> 'status' = 'approved', 'L1. the admin''s approval puts V2 in force: ' || r::text);
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/approved', 'L1. V1 superseded, V2 current: ' || pg_temp.vstatus(o));
  perform pg_temp.check(pg_temp.lines(o) = 'ASSERT chair v2 x2', 'L1. V2''s lines are in force');
  perform pg_temp.check(pg_temp.live_handoff(o) = '2/awaiting', 'L1. V2''s handoff awaits the reviewer: ' || coalesce(pg_temp.live_handoff(o), 'none'));
  perform pg_temp.check(pg_temp.alignment(o) = 'not_aligned', 'L1. the alignment that covered V1 is reset');
  perform pg_temp.check(not exists (select 1 from public.order_document_versions where order_id = o and superseded_at is null and status = 'ready'),
    'L1. V1''s generated documents are superseded');
  perform pg_temp.check(pg_temp.events(o, 'order_amended') = 0, 'L1. same value: no amendment');
  perform pg_temp.check(exists (select 1 from public.notifications where user_id = reviewer and entity_id = o and title like '%PI V2 approved%'),
    'L1. the reviewer is told');
  perform pg_temp.check(exists (select 1 from public.notifications where user_id = sales and entity_id = o and title like '%it is now the PI in force%'),
    'L1. Sales is told it is in force');

  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', reviewer, v),
          'ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS', 'L1. #205''s operations door has nothing to decide');
  perform pg_temp.expect_error(format('select pg_temp.stage(%L, pg_temp.payload(%L, ''ASSERT MATCH'', 500000, 2))', v, v),
          'ORDER_PI_REVISION_NOT_PENDING', 'L4. a second approval of the same version is refused');

  h := (pg_temp.live(o)).id;
  perform pg_temp.decide(reviewer, h, 'accepted', null);
  perform pg_temp.check(pg_temp.live_handoff(o) = '2/accepted' and pg_temp.alignment(o) = 'aligned',
    'L1. the reviewer''s acceptance aligns production for V2');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/approved', 'L1. and V2 was current all along');
  raise notice 'L1. a matching V2 is in force at admin approval; operations governs production only OK';
end $$;

do $$
declare o uuid := current_setting('test.order_m')::uuid; v uuid; a record;
        owner uuid := current_setting('test.owner_id')::uuid; reviewer uuid := current_setting('test.reviewer_id')::uuid;
begin
  -- L2. A new client and value: amended with the approval, audited.
  v := pg_temp.propose(o);
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT NEW CLIENT', 650000, 3));
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/superseded,3/approved', 'L2. V3 current');
  perform pg_temp.check((select client_name = 'ASSERT NEW CLIENT' and total_value = 650000 from public.orders where id = o),
    'L2. the Order carries V3''s client and value: ' || pg_temp.figures(o));
  select * into a from public.order_activity_log where order_id = o and event_type = 'order_amended' order by created_at desc limit 1;
  perform pg_temp.check(a.actor_id = owner and a.payload ->> 'source' = 'pi_revision'
                        and (a.payload #>> '{changes,total_value,from}')::numeric = 500000
                        and (a.payload #>> '{changes,total_value,to}')::numeric = 650000
                        and a.payload #>> '{changes,client_name,to}' = 'ASSERT NEW CLIENT',
    'L2. recorded as an amendment: old → new, the approving admin: ' || coalesce(a.payload::text, 'none'));

  -- L3. "Cannot accept": V3 stays current, production is not aligned.
  perform pg_temp.decide(reviewer, (pg_temp.live(o)).id, 'clarification_needed', 'ASSERT the new client''s delivery address is missing');
  perform pg_temp.check(pg_temp.live_handoff(o) = '3/clarification_needed' and pg_temp.alignment(o) = 'not_aligned',
    'L3. flagged: not aligned for production');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/superseded,3/approved', 'L3. and V3 is still the PI in force');

  -- L7. An admin rejection of a pending revision changes nothing.
  v := pg_temp.propose(o);
  declare s text := pg_temp.current_state(o);
  begin
    perform pg_temp.become(owner);
    perform public.reject_order_pi_revision(v, 'ASSERT not agreed');
    perform pg_temp.restore();
    perform pg_temp.check(pg_temp.current_state(o) = s and pg_temp.vstatus(o) like '%4/rejected', 'L7. a rejection changes nothing');
  end;
  raise notice 'L2/L3/L7. value amended with the approval; a flag leaves the version current; a rejection changes nothing OK';
end $$;

do $$
declare o uuid := current_setting('test.order_m')::uuid; v uuid;
        sales uuid := current_setting('test.sales_id')::uuid; reviewer uuid := current_setting('test.reviewer_id')::uuid;
        reviewer2 uuid := current_setting('test.reviewer2_id')::uuid; outsider uuid := current_setting('test.outsider_id')::uuid;
begin
  -- L4. Only an active admin approves; the door is the server's.
  v := pg_temp.propose(o);
  perform pg_temp.expect_error(format('select public.approve_order_pi_revision(%L, %L, pg_temp.payload(%L, ''ASSERT NEW CLIENT'', 650000, 3))', v, sales, v),
          'permission', 'L4. Sales cannot approve');
  perform pg_temp.expect_error(format('select public.approve_order_pi_revision(%L, %L, pg_temp.payload(%L, ''ASSERT NEW CLIENT'', 650000, 3))', v, reviewer, v),
          'permission', 'L4. the operations reviewer cannot approve');
  perform pg_temp.check(not has_function_privilege('authenticated', 'public.approve_order_pi_revision(uuid, uuid, jsonb)', 'EXECUTE'),
    'L4. the approval door is not the browser''s');

  -- L5. Reassignment readdresses the live handoff of the version in force.
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT NEW CLIENT', 650000, 3));
  perform pg_temp.check((pg_temp.live(o)).assigned_to = reviewer, 'L5. V5''s handoff is the reviewer''s');
  perform pg_temp.assign(reviewer2);
  perform pg_temp.check((pg_temp.live(o)).assigned_to = reviewer2, 'L5. reassigning readdresses it');
  perform pg_temp.expect_error(format('select pg_temp.decide(%L, %L, ''accepted'', null)', reviewer, (pg_temp.live(o)).id),
          'Only the assigned operations reviewer', 'L5. the former reviewer can no longer decide');
  perform pg_temp.expect_error(format('select pg_temp.decide(%L, %L, ''accepted'', null)', outsider, (pg_temp.live(o)).id),
          'Only the assigned operations reviewer', 'L5. nor can an outsider');
  perform pg_temp.decide(reviewer2, (pg_temp.live(o)).id, 'accepted', null);
  perform pg_temp.check(pg_temp.alignment(o) = 'aligned', 'L5. the new reviewer aligns it');

  -- No reviewer: the next version's handoff is recorded unassigned; admins are told.
  perform pg_temp.assign(null);
  v := pg_temp.propose(o);
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT NEW CLIENT', 650000, 3));
  perform pg_temp.check((pg_temp.live(o)).assigned_to is null and (pg_temp.live(o)).unassigned_reason = 'no_reviewer',
    'L5. with no reviewer the handoff is recorded unassigned');
  perform pg_temp.check(exists (select 1 from public.notifications where user_id = current_setting('test.owner_id')::uuid
                                   and entity_id = o and title like '%no operations reviewer%'),
    'L5. and the administrators are told');
  perform pg_temp.check(pg_temp.vstatus(o) like '%6/approved', 'L5. the version is in force regardless');
  perform pg_temp.assign(reviewer);
  raise notice 'L4/L5. authority and reassignment OK';
end $$;

-- L6. #202: documents sent with the PI are accepted with the version Operations accepts.
select set_config('test.pi_i', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_i')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT INITIAL', 350000);

do $$
declare pi uuid := current_setting('test.pi_i')::uuid; o uuid; v uuid; d uuid := gen_random_uuid(); path text;
        reviewer uuid := current_setting('test.reviewer_id')::uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  path := 'pi-documents/' || pi || '/' || d || '/client_po/' || gen_random_uuid() || '.pdf';
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('order-files', path, current_setting('test.sales_id'), jsonb_build_object('mimetype', 'application/pdf', 'size', 900));
  insert into public.order_document_submissions (id, stage, pi_submission_id, includes_client_po, status, snapshot_sha256, file_count, submitted_by)
  values (d, 'initial', pi, true, 'pending_admin', repeat('c', 64), 1, current_setting('test.sales_id')::uuid);
  o := pg_temp.approve(pi);
  perform pg_temp.check((select status from public.order_document_submissions where id = d) = 'awaiting_operations', 'L6. PI approval sends its documents to operations');
  -- V2 approved (in force) before Operations looked at V1.
  v := pg_temp.propose(o);
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT INITIAL', 350000, 1));
  perform pg_temp.check((select status from public.order_document_submissions where id = d) = 'awaiting_operations', 'L6. still awaiting after V2');
  perform pg_temp.decide(reviewer, (pg_temp.live(o)).id, 'accepted', null);
  perform pg_temp.check((select status from public.order_document_submissions where id = d) = 'accepted',
    'L6. accepted with the version Operations accepted');
  raise notice 'L6. #202 documents follow the accepted version OK';
end $$;

do $$ begin raise notice 'ALL PI REVISION LIFECYCLE ASSERTIONS PASSED (20270104000000)'; end $$;

\else

-- ═══ 1. A MATCHING V2: staged, then accepted ═══════════════════════════════

select pg_temp.assign(current_setting('test.reviewer_id')::uuid);
select set_config('test.pi_m', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_m')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT MATCH', 500000);
select set_config('test.order_m', pg_temp.approve(current_setting('test.pi_m')::uuid)::text, true);
-- V1 accepted by operations first, so the Order is aligned and running.
select pg_temp.decide(current_setting('test.reviewer_id')::uuid,
  (select id from public.order_operations_handoffs where order_id = current_setting('test.order_m')::uuid), 'accepted', null);

do $$
declare o uuid := current_setting('test.order_m')::uuid; v uuid; r jsonb;
        owner uuid := current_setting('test.owner_id')::uuid; sales uuid := current_setting('test.sales_id')::uuid;
        reviewer uuid := current_setting('test.reviewer_id')::uuid; admin2 uuid := current_setting('test.admin2_id')::uuid;
        before_fig text; before_lines text; before_codes bigint; n_rev bigint; d jsonb; before_state text;
begin
  perform pg_temp.put_pdf(o);
  before_fig := pg_temp.figures(o); before_lines := pg_temp.lines(o);
  before_codes := (select count(*) from public.order_product_codes where order_id = o);
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved' and pg_temp.live_handoff(o) = '1/accepted', '1. V1 in force, accepted, aligned');

  v := pg_temp.propose(o);
  perform set_config('test.v_m', v::text, true);
  n_rev := (select count(*) from public.notifications where user_id = reviewer and entity_id = o);
  before_state := pg_temp.current_state(o);
  -- A route deployed before 20270101000000 sends no seed_terms; it is refused
  -- before anything is staged, so it never reaches its own image cleanup.
  perform pg_temp.expect_error(format('select pg_temp.stage(%L, pg_temp.payload(%L, ''ASSERT MATCH'', 500000, 2) - ''seed_terms'')', v, v),
          'ORDER_PI_REVISION_CLIENT_UPDATE_REQUIRED', '1. a pre-staging route''s approval is refused');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved,2/pending' and pg_temp.current_state(o) = before_state
                        and not exists (select 1 from public.order_pi_revision_staged_parses where version_id = v),
                        '1. …and nothing is staged or changed');
  r := pg_temp.stage(v, pg_temp.payload(v, 'ASSERT MATCH', 500000, 2));
  perform pg_temp.check(pg_temp.current_state(o) = before_state,
    '1. staging leaves the Order, the PI''s own columns (incl. billing %), its lines, images and stored files, codes, PDF records and V1 byte-identical');
  perform pg_temp.check((select superseded_at is null from public.order_document_versions where order_id = o and version = 1),
    '1. the generated PDF stays current while V2 is only staged');

  -- ── STAGED: nothing current moved ──
  perform pg_temp.check(r ->> 'status' = 'admin_approved', '1. admin approval stages');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved,2/admin_approved', '1. V1 stays in force; V2 awaits operations');
  perform pg_temp.check(pg_temp.figures(o) = before_fig, '1. the Order''s figures, dates and alignment are unchanged');
  perform pg_temp.check(pg_temp.lines(o) = before_lines, '1. the product lines are unchanged');
  perform pg_temp.check((select count(*) from public.order_product_codes where order_id = o) = before_codes, '1. no codes issued');
  perform pg_temp.check(pg_temp.live_handoff(o) = '1/accepted', '1. V1''s handoff is still the live, accepted one');
  perform pg_temp.check(not exists (select 1 from public.order_operations_handoffs where order_id = o and version_number = 2), '1. no V2 handoff yet');
  perform pg_temp.check((select operations_reviewer from public.order_pi_versions where id = v) = reviewer, '1. addressed to the reviewer');
  perform pg_temp.check((select count(*) from public.notifications where user_id = reviewer and entity_id = o) = n_rev + 1, '1. the reviewer is told once');
  perform pg_temp.check(exists (select 1 from public.order_pi_revision_staged_parses where version_id = v and applied_at is null), '1. the parse is staged');

  -- ── A second admin approval (a stale tab / retried request) is refused ──
  perform pg_temp.expect_error(format('select pg_temp.stage(%L, pg_temp.payload(%L, ''ASSERT MATCH'', 500000, 2))', v, v),
          'ORDER_PI_REVISION_NOT_PENDING', '1. a repeated admin approval is refused');

  -- ── FROZEN: no edit and no second revision while V2 awaits operations ──
  perform pg_temp.expect_error(format('update public.order_submissions set client_name = ''X'' where id = %L', current_setting('test.pi_m')),
          'ORDER_PI_REVISION_AWAITING_OPERATIONS', '1. the PI''s parse-owned columns are frozen');
  perform pg_temp.expect_error(format('delete from public.order_submission_items where submission_id = %L', current_setting('test.pi_m')),
          'ORDER_PI_REVISION_AWAITING_OPERATIONS', '1. its lines are frozen');
  perform pg_temp.expect_error(format('select pg_temp.propose(%L)', o), 'order_pi_versions_one_pending_per_order',
          '1. no second revision while one awaits operations');

  -- ── AUTHORITY ──
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', sales, v),
          'Only the assigned operations reviewer', '1. Sales cannot accept');
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', owner, v),
          'Only the assigned operations reviewer', '1. an admin who is not the reviewer cannot accept');
  perform pg_temp.expect_error(format('update public.order_pi_versions set status = ''approved'' where id = %L', v),
          'ORDER_PI_VERSION_TRANSITION_INVALID', '1. nothing puts V2 in force outside the operations acceptance');
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''rejected'', ''  '')', reviewer, v),
          'ORDER_PI_REVISION_REASON_REQUIRED', '1. a rejection needs a reason');

  -- ── The differences the reviewer is shown ──
  perform pg_temp.become(reviewer);
  d := public.order_pi_revision_differences(v);
  perform pg_temp.restore();
  perform pg_temp.check(jsonb_array_length(d -> 'blocking') = 0, '1. a matching V2 has no blocking difference');
  perform pg_temp.check(jsonb_array_length(d -> 'lines' -> 'changed') = 1, '1. the changed line is listed');

  -- ── ACCEPT ──
  r := pg_temp.ops(reviewer, v, 'accepted', 'Quantities confirmed with the client');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/approved', '1. accepted: V2 in force, V1 superseded');
  perform pg_temp.check(pg_temp.lines(o) = 'ASSERT chair v2 x2', '1. V2''s lines applied');
  perform pg_temp.check(pg_temp.figures(o) = before_fig, '1. the Order''s commercial figures and alignment are as reconciled (aligned against V2)');
  perform pg_temp.check(pg_temp.live_handoff(o) = '2/accepted', '1. V2''s handoff recorded AND accepted — one decision');
  perform pg_temp.check((select accepted_by from public.order_operations_handoffs where order_id = o and version_number = 2) = reviewer, '1. accepted by the reviewer');
  perform pg_temp.check((select count(*) from public.order_product_codes where order_id = o) > before_codes, '1. the new line has a code');
  perform pg_temp.check((select jsonb_array_length(superseded_snapshot -> 'items') from public.order_pi_revision_staged_parses where version_id = v) = 1
                        and (select superseded_snapshot -> 'items' -> 0 ->> 'product_name' from public.order_pi_revision_staged_parses where version_id = v) = 'ASSERT chair',
                        '1. V1''s lines are kept in the snapshot');
  perform pg_temp.check((select workbook_path from public.order_pi_versions where order_id = o and version_number = 1) is not null, '1. V1''s file stays on its version');
  perform pg_temp.check((select count(*) from public.notifications where user_id = sales and entity_id = o and title like '%accepted PI V2%') = 1, '1. Sales is told once');
  perform pg_temp.check(not exists (select 1 from public.notifications where user_id = reviewer and entity_id = o and type::text = 'order_operations_review_requested' and title like '%PI V2 is awaiting%'),
                        '1. the reviewer is not asked to review what they just accepted');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o and event_type = 'pi_revision_applied') = 1, '1. applied once, on the history');
  perform pg_temp.check((select superseded_at is not null from public.order_document_versions where order_id = o and version = 1),
    '1. only the acceptance retires V1''s generated PDF');
  perform pg_temp.check(pg_temp.current_state(o) <> before_state, '1. (the state fingerprint does see a promotion)');

  -- ── Stale tabs ──
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', reviewer, v),
          'ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS', '1. a second accept is refused');
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''rejected'', ''late'')', reviewer, v),
          'ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS', '1. a stale reject is refused');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o and event_type = 'pi_revision_applied') = 1, '1. never applied twice');
end $$;

-- ═══ 2. A MATERIALLY DIFFERENT V2: blocked until the Order is amended ══════

select set_config('test.pi_d', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_d')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT DIFF', 600000);
select set_config('test.order_d', pg_temp.approve(current_setting('test.pi_d')::uuid)::text, true);

do $$
declare o uuid := current_setting('test.order_d')::uuid; v uuid; d jsonb; before_fig text; before_lines text; before_state text;
        owner uuid := current_setting('test.owner_id')::uuid; reviewer uuid := current_setting('test.reviewer_id')::uuid;
begin
  perform pg_temp.put_pdf(o);
  before_fig := pg_temp.figures(o); before_lines := pg_temp.lines(o);
  v := pg_temp.propose(o);
  before_state := pg_temp.current_state(o);
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT DIFF Pvt Ltd', 750000, 3));
  perform pg_temp.become(reviewer);
  d := public.order_pi_revision_differences(v);
  perform pg_temp.restore();
  perform pg_temp.check((select array_agg(e ->> 'field' order by e ->> 'field') from jsonb_array_elements(d -> 'blocking') e)
                        = array['client_name', 'total_product_value', 'total_value'], '2. client, order value and product value are blocking');

  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', reviewer, v),
          'ORDER_PI_REVISION_AMENDMENT_REQUIRED', '2. acceptance is refused until the Order is amended');
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', reviewer, v),
          'Order value: Order has 600000', '2. …naming each difference');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved,2/admin_approved' and pg_temp.figures(o) = before_fig and pg_temp.lines(o) = before_lines,
                        '2. a refused acceptance changes nothing');
  perform pg_temp.check(pg_temp.current_state(o) = before_state,
                        '2. …not the PI''s own columns, lines, images, codes, PDF records or V1 either');

  -- The reconciliation path: the existing amendment door.
  perform pg_temp.become(owner);
  perform public.amend_order(o, 'ASSERT client re-issued PO at the revised value', 'ASSERT DIFF Pvt Ltd', 750000, 750000);
  perform pg_temp.restore();
  perform pg_temp.ops(reviewer, v, 'accepted', null);
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/approved', '2. accepted after the amendment');
  perform pg_temp.check((select client_name = 'ASSERT DIFF Pvt Ltd' and total_value = 750000 and total_product_value = 750000 from public.orders where id = o), '2. the Order carries the AMENDED values');
  perform pg_temp.check(pg_temp.lines(o) = 'ASSERT chair v2 x3', '2. V2''s lines applied');
  perform pg_temp.check((select due_date from public.orders where id = o) is not null, '2. a PI with no due date never wipes the Order''s');
end $$;

-- ═══ 3. REJECTION leaves everything; a new revision can follow ════════════

select set_config('test.pi_r', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_r')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT REJ', 400000);
select set_config('test.order_r', pg_temp.approve(current_setting('test.pi_r')::uuid)::text, true);

do $$
declare o uuid := current_setting('test.order_r')::uuid; v uuid; v3 uuid; before_fig text; before_lines text; before_h text; before_state text;
        sales uuid := current_setting('test.sales_id')::uuid; owner uuid := current_setting('test.owner_id')::uuid;
        reviewer uuid := current_setting('test.reviewer_id')::uuid;
begin
  perform pg_temp.put_pdf(o);
  before_fig := pg_temp.figures(o); before_lines := pg_temp.lines(o); before_h := pg_temp.live_handoff(o);
  v := pg_temp.propose(o);
  before_state := pg_temp.current_state(o);
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT REJ', 400000, 4));
  perform pg_temp.ops(reviewer, v, 'rejected', 'Rate on line 1 is last season''s');
  perform pg_temp.check(pg_temp.current_state(o) = before_state,
                        '3. rejection leaves the Order, the PI''s own columns, lines, images, codes, PDF records and V1 byte-identical');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved,2/rejected', '3. rejected; V1 still in force');
  perform pg_temp.check(pg_temp.figures(o) = before_fig and pg_temp.lines(o) = before_lines and pg_temp.live_handoff(o) = before_h,
                        '3. figures, lines and V1''s handoff untouched');
  perform pg_temp.check((select operations_reason from public.order_pi_versions where id = v) = 'Rate on line 1 is last season''s', '3. the reason is kept');
  perform pg_temp.check((select count(*) from public.notifications where user_id = sales and entity_id = o and title like '%rejected PI V2%') = 1, '3. Sales is told');
  perform pg_temp.check((select count(*) from public.notifications where user_id = owner and entity_id = o and title like '%rejected PI V2%') = 1, '3. the approving admin is told');
  perform pg_temp.check(not exists (select 1 from public.order_pi_revision_staged_parses where version_id = v and applied_at is not null), '3. never applied');
  -- The PI is no longer frozen BY THE REVISION, and a corrected V3 can be
  -- proposed. Since 20270103000000 an approved PI is still never edited in
  -- place: the refusal is now the versioning rule's, not the freeze's.
  perform pg_temp.expect_error(
    format('update public.order_submissions set commercial_terms_note = %L where id = %L', 'ASSERT unfrozen', current_setting('test.pi_r')),
    'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION', '3. no longer frozen by the revision, and still changed only as a version');
  v3 := pg_temp.propose(o);
  perform pg_temp.check((select version_number from public.order_pi_versions where id = v3) = 3, '3. a corrected V3 can be proposed');
end $$;

-- ═══ 4. REASSIGNMENT and NO REVIEWER ═══════════════════════════════════════

select set_config('test.pi_a', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_a')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT REASSIGN', 300000);
select set_config('test.order_a', pg_temp.approve(current_setting('test.pi_a')::uuid)::text, true);

do $$
declare o uuid := current_setting('test.order_a')::uuid; v uuid;
        r1 uuid := current_setting('test.reviewer_id')::uuid; r2 uuid := current_setting('test.reviewer2_id')::uuid;
begin
  v := pg_temp.propose(o);
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT REASSIGN', 300000, 1));
  perform pg_temp.assign(r2);
  perform pg_temp.check((select operations_reviewer from public.order_pi_versions where id = v) = r2, '4. readdressed to the new reviewer');
  perform pg_temp.check((select count(*) from public.notifications where user_id = r2 and entity_id = o and title like '%PI V2 now awaits%') = 1, '4. who is told once');
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', r1, v),
          'Only the assigned operations reviewer', '4. the former reviewer is refused');
  perform pg_temp.assign(null);
  perform pg_temp.check((select operations_reviewer from public.order_pi_versions where id = v) is null, '4. cleared → unassigned');
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', r2, v),
          'ORDER_PI_REVISION_NO_REVIEWER', '4. nobody decides while unassigned');
  perform pg_temp.assign(r2);
  perform pg_temp.ops(r2, v, 'accepted', null);
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/approved', '4. the current reviewer accepts');
  perform pg_temp.assign(r1);
end $$;

-- ═══ 5. #202: documents sent with the PI, and the admin's own upload ══════

select set_config('test.pi_i', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_i')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT INITIAL', 350000);

do $$
declare pi uuid := current_setting('test.pi_i')::uuid; o uuid; v uuid; d uuid := gen_random_uuid(); path text;
        owner uuid := current_setting('test.owner_id')::uuid; reviewer uuid := current_setting('test.reviewer_id')::uuid;
begin
  -- A document submission sent with the PI (as submit_pi_for_review_with_documents records it).
  perform set_config('request.jwt.claims', '', true);
  path := 'pi-documents/' || pi || '/' || d || '/client_po/' || gen_random_uuid() || '.pdf';
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('order-files', path, current_setting('test.sales_id'), jsonb_build_object('mimetype', 'application/pdf', 'size', 900));
  insert into public.order_document_submissions (id, stage, pi_submission_id, includes_client_po, status, snapshot_sha256, file_count, submitted_by)
  values (d, 'initial', pi, true, 'pending_admin', repeat('c', 64), 1, current_setting('test.sales_id')::uuid);
  o := pg_temp.approve(pi);
  perform pg_temp.check((select status from public.order_document_submissions where id = d) = 'awaiting_operations', '5. PI approval sends its documents to operations');

  -- V2 proposed and approved by an ADMIN (own upload) before V1 was accepted.
  v := pg_temp.propose(o);
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT INITIAL', 350000, 1), owner);
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved,2/admin_approved', '5. an admin''s approval is never the operations acceptance');
  perform pg_temp.check((select status from public.order_document_submissions where id = d) = 'awaiting_operations', '5. documents still awaiting');
  perform pg_temp.ops(reviewer, v, 'accepted', null);
  perform pg_temp.check((select status from public.order_document_submissions where id = d) = 'accepted',
                        '5. the documents are accepted with the PI version operations accepts');
  perform pg_temp.check((select count(*) from public.order_operations_handoffs where order_id = o and status = 'accepted' and superseded_at is null) = 1,
                        '5. exactly one live, accepted handoff');
end $$;

-- ═══ 6. PRIVILEGES ═════════════════════════════════════════════════════════

do $$
begin
  perform pg_temp.check(not has_function_privilege('anon', 'public.decide_order_pi_revision_operations(uuid, text, text)', 'EXECUTE'), '6. anon cannot decide');
  perform pg_temp.check(not has_function_privilege('authenticated', 'public.approve_order_pi_revision(uuid, uuid, jsonb)', 'EXECUTE'), '6. admin approval stays service-role');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_pi_revision_staged_parses', 'SELECT'), '6. staged parses are not client-readable');
  perform pg_temp.become(current_setting('test.outsider_id')::uuid);
  perform pg_temp.expect_error(format('select public.order_pi_revision_differences(%L)', current_setting('test.v_m')),
          'You do not have access', '6. an outsider cannot read the differences');
  perform pg_temp.restore();
  perform pg_temp.expect_error(format('delete from public.order_pi_revision_staged_parses where version_id = %L', current_setting('test.v_m')),
          'ORDER_PI_REVISION_STAGE_IMMUTABLE', '6. a staged revision cannot be deleted');
  perform pg_temp.expect_error(format('update public.order_pi_revision_staged_parses set payload = ''{}'' where version_id = %L', current_setting('test.v_m')),
          'ORDER_PI_REVISION_STAGE_IMMUTABLE', '6. or rewritten');
end $$;

-- ═══ 7. THE APPROVING ADMIN IS DEACTIVATED BEFORE OPERATIONS ACCEPTS ═══════

select set_config('test.pi_x', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_x')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT INACTIVE', 450000);
select set_config('test.order_x', pg_temp.approve(current_setting('test.pi_x')::uuid)::text, true);

do $$
declare o uuid := current_setting('test.order_x')::uuid; v uuid; r jsonb; before_state text; payload_md5 text;
        owner uuid := current_setting('test.owner_id')::uuid; admin2 uuid := current_setting('test.admin2_id')::uuid;
        sales uuid := current_setting('test.sales_id')::uuid; reviewer uuid := current_setting('test.reviewer_id')::uuid;
begin
  v := pg_temp.propose(o);
  perform pg_temp.stage(v, pg_temp.payload(v, 'ASSERT INACTIVE', 450000, 3), admin2);
  payload_md5 := (select md5(payload::text) from public.order_pi_revision_staged_parses where version_id = v);

  -- While the approving admin is active, nobody can take the approval over.
  perform pg_temp.become(owner);
  perform pg_temp.expect_error(format('select public.reapprove_order_pi_revision(%L)', v),
          'ORDER_PI_REVISION_APPROVER_ACTIVE', '7. no re-approval while the approver is active');
  perform pg_temp.restore();

  -- The approving admin leaves.
  perform set_config('request.jwt.claims', '', true);
  update public.users set is_active = false where id = admin2;
  before_state := pg_temp.current_state(o);

  -- STUCK without recovery: the reviewer cannot accept, and nothing moves.
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', reviewer, v),
          'ORDER_PI_REVISION_APPROVER_INACTIVE', '7. acceptance is refused while the approver is inactive');
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''accepted'', null)', reviewer, v),
          'An active administrator must re-approve', '7. …and the refusal names the way out');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved,2/admin_approved' and pg_temp.current_state(o) = before_state,
                        '7. the refused acceptance changed nothing');

  -- Who may re-approve: an active admin only.
  perform pg_temp.become(sales);
  perform pg_temp.expect_error(format('select public.reapprove_order_pi_revision(%L)', v),
          'You do not have permission', '7. Sales cannot re-approve');
  perform pg_temp.restore();
  perform pg_temp.become(reviewer);
  perform pg_temp.expect_error(format('select public.reapprove_order_pi_revision(%L)', v),
          'You do not have permission', '7. the reviewer cannot re-approve');
  perform pg_temp.restore();
  perform pg_temp.become(admin2);
  perform pg_temp.expect_error(format('select public.reapprove_order_pi_revision(%L)', v),
          'This account is not active', '7. the deactivated admin cannot re-approve');
  perform pg_temp.restore();

  -- RECOVERY: another active admin re-approves the same staged parse.
  perform pg_temp.become(owner);
  r := public.reapprove_order_pi_revision(v);
  perform pg_temp.restore();
  perform pg_temp.check(r ->> 'previously_approved_by' = admin2::text and r ->> 'reapproved_by' = owner::text, '7. re-approved, attributed');
  perform pg_temp.check((select decided_by from public.order_pi_versions where id = v) = owner
                        and (select staged_by from public.order_pi_revision_staged_parses where version_id = v) = owner,
                        '7. the admin decision and the stage are the re-approving admin''s');
  perform pg_temp.check((select md5(payload::text) from public.order_pi_revision_staged_parses where version_id = v) = payload_md5,
                        '7. the staged parse itself is unchanged');
  perform pg_temp.check((select operations_reviewer from public.order_pi_versions where id = v) = reviewer, '7. still addressed to the reviewer');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved,2/admin_approved' and pg_temp.current_state(o) = before_state,
                        '7. re-approval changes nothing in force');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o and event_type = 'pi_revision_admin_reapproved') = 1,
                        '7. on the history once');
  perform pg_temp.check((select count(*) from public.notifications where user_id = reviewer and entity_id = o and title like '%re-approved%') = 1,
                        '7. the reviewer is told once');
  perform pg_temp.become(owner);
  perform pg_temp.expect_error(format('select public.reapprove_order_pi_revision(%L)', v),
          'ORDER_PI_REVISION_APPROVER_ACTIVE', '7. a repeated re-approval is refused');
  perform pg_temp.restore();
  perform pg_temp.expect_error(format('update public.order_pi_revision_staged_parses set staged_by = %L where version_id = %L', admin2, v),
          'ORDER_PI_REVISION_STAGE_IMMUTABLE', '7. the stage cannot be re-attributed outside the door');
  perform pg_temp.expect_error(format('update public.order_pi_versions set decided_by = %L where id = %L', admin2, v),
          'ORDER_PI_VERSION_IMMUTABLE', '7. nor the decision');

  -- The reviewer can now accept it.
  perform pg_temp.ops(reviewer, v, 'accepted', null);
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/approved' and pg_temp.lines(o) = 'ASSERT chair v2 x3', '7. accepted after re-approval');
  perform pg_temp.become(owner);
  perform pg_temp.expect_error(format('select public.reapprove_order_pi_revision(%L)', v),
          'ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS', '7. nothing to re-approve once decided');
  perform pg_temp.restore();
  update public.users set is_active = true where id = admin2;
end $$;

-- ═══ 8. AN ERRONEOUS ADMIN APPROVAL: rejected, or superseded, V1 untouched ═

select set_config('test.pi_e', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_e')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT ERRONEOUS', 520000);
select set_config('test.order_e', pg_temp.approve(current_setting('test.pi_e')::uuid)::text, true);

do $$
declare o uuid := current_setting('test.order_e')::uuid; v2 uuid; v3 uuid; before_state text;
        owner uuid := current_setting('test.owner_id')::uuid; sales uuid := current_setting('test.sales_id')::uuid;
        reviewer uuid := current_setting('test.reviewer_id')::uuid;
begin
  perform pg_temp.put_pdf(o);
  v2 := pg_temp.propose(o);
  before_state := pg_temp.current_state(o);
  -- The admin approves the wrong file while no reviewer is assigned.
  perform pg_temp.assign(null);
  perform pg_temp.stage(v2, pg_temp.payload(v2, 'ASSERT ERRONEOUS', 520000, 9));
  perform pg_temp.check(pg_temp.current_state(o) = before_state, '8. the erroneous approval changed nothing in force');
  -- It cannot be superseded by a new proposal while it awaits operations…
  perform pg_temp.expect_error(format('select pg_temp.propose(%L)', o), 'order_pi_versions_one_pending_per_order',
          '8. no V3 while V2 awaits operations');
  -- …nor accepted or rejected with nobody assigned; the admin assigns a reviewer.
  perform pg_temp.expect_error(format('select pg_temp.ops(%L, %L, ''rejected'', ''wrong file'')', reviewer, v2),
          'ORDER_PI_REVISION_NO_REVIEWER', '8. nobody decides while unassigned');
  perform pg_temp.assign(reviewer);
  perform pg_temp.ops(reviewer, v2, 'rejected', 'Admin approved the wrong workbook');
  perform pg_temp.check(pg_temp.vstatus(o) = '1/approved,2/rejected' and pg_temp.current_state(o) = before_state,
                        '8. rejected: V1, its lines, images, PDF and codes byte-identical');
  perform pg_temp.check((select count(*) from public.notifications where user_id = owner and entity_id = o and title like '%rejected PI V2%') = 1,
                        '8. the approving admin is told');
  -- The corrected file supersedes it as V3; V2 stays rejected in history.
  v3 := pg_temp.propose(o);
  perform pg_temp.stage(v3, pg_temp.payload(v3, 'ASSERT ERRONEOUS', 520000, 2));
  perform pg_temp.check(pg_temp.current_state(o) = before_state, '8. staging V3 changes nothing in force either');
  perform pg_temp.ops(reviewer, v3, 'accepted', null);
  perform pg_temp.check(pg_temp.vstatus(o) = '1/superseded,2/rejected,3/approved' and pg_temp.lines(o) = 'ASSERT chair v2 x2',
                        '8. V3 in force; V2 never was');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o and event_type = 'pi_revision_applied') = 1,
                        '8. exactly one application — V3''s');
end $$;

do $$
begin
  perform pg_temp.check(not has_function_privilege('anon', 'public.reapprove_order_pi_revision(uuid)', 'EXECUTE'), '9. anon cannot re-approve');
end $$;

do $$ begin raise notice 'ALL PI REVISION PROMOTION ASSERTIONS PASSED'; end $$;
\endif

rollback;
