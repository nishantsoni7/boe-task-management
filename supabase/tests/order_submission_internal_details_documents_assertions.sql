-- WHICH EDITS MAKE AN ORDER'S DOCUMENTS STALE, OR ASK OPERATIONS AGAIN (20270122000000)
-- ===========================================================================
-- No client document prints a confirmation or due date. So on an ACCEPTED,
-- ALIGNED Order with current documents, through the real doors:
--
--   1   date-only edit (schedule editor)   PI + Order dates and both histories
--                                           move; no PI version, no new handoff,
--                                           acceptance and alignment kept,
--                                           documents current, no notification
--   1b  everything printed                  dispatch text, a mixed edit, client
--                                           details and a direct write are still
--                                           refused as needing a revision
--   2   Order amendment of dates            clean, as before
--   3   printed content via Edit PI         documents superseded, V2 in force,
--                                           Operations must accept, alignment reset
--   4   a draft                             nothing to supersede
--
-- One transaction, ROLLBACK. Synthetic records only.
-- On success prints NOTICE 'ALL DOCUMENT STALENESS ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id',    '11111111-1111-1111-1111-111111111111', true); -- TEST-001, admin
  perform set_config('test.reviewer_id', '22222222-2222-2222-2222-222222222222', true); -- operations reviewer
  perform set_config('test.sales_id',    '55555555-5555-5555-5555-555555555555', true); -- the PI's owner
  perform set_config('test.pi_a', gen_random_uuid()::text, true);
end $$;

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.reviewer_id')::uuid, 'ASSERT Reviewer', 'reviewer@example.test', 'member', 'operations', true, 'ASSERT-OPS'),
  (current_setting('test.sales_id')::uuid,    'ASSERT Sales',    'sales@example.test',    'member', 'sales',      true, 'ASSERT-SAL')
on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, team = excluded.team,
                               is_active = true, is_deleted = false;
update public.users set full_name = 'ASSERT Owner', role = 'admin', is_active = true, is_deleted = false
 where id = current_setting('test.owner_id')::uuid;
delete from public.order_operations_reviewers where duty = 'pi_handoff';
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select g.uid, mpa.module_id, mpa.action_id, true, current_setting('test.owner_id')::uuid
  from (values (current_setting('test.owner_id')::uuid, 'approve_order'),
               (current_setting('test.owner_id')::uuid, 'can_be_order_assignee'),
               (current_setting('test.sales_id')::uuid, 'view'),
               (current_setting('test.sales_id')::uuid, 'create'),
               (current_setting('test.sales_id')::uuid, 'can_be_order_assignee'),
               (current_setting('test.reviewer_id')::uuid, 'view')) g(uid, a)
  join public.permission_modules pm on pm.module_key = 'orders'
  join public.permission_actions pa on pa.action_key = g.a
  join public.module_permission_actions mpa on mpa.module_id = pm.id and mpa.action_id = pa.id
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
create function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'ASSERT FAILED: %', p_label; end if;
end $$;

create function pg_temp.make_pi(p_id uuid, p_owner uuid, p_total numeric) returns void language plpgsql as $$
declare
  v_item uuid := gen_random_uuid();
  v_wb   text := 'submissions/' || p_id::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha  text := repeat('a', 64);
  v_img  text;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, bill_to_name, gross_product_amount, discount_amount, grand_total,
     source_workbook_path, source_workbook_sha256, source_workbook_name, parse_warnings, parse_blocking_issues, reservation_required,
     order_confirmation_date, due_date, dispatch_commitment)
  values (p_id, 'draft', p_owner, p_owner, 'ASSERT client', 'ASSERT client', p_total, 0, p_total, v_wb, v_sha, 'pi.xlsx', '[]', '[]', false,
          date '2026-09-20', date '2026-11-20', '8 weeks from confirmation');
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
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (gen_random_uuid(), 'ASSERT-DOCS', p_total * 0.4, current_date, 'hdfc', 'approved_unlinked', p_owner, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  select id, p_id, amount, 'order_submission', p_owner from public.finance_payment_requests
   where client_name = 'ASSERT-DOCS'
     and not exists (select 1 from public.finance_payment_allocations a where a.payment_request_id = finance_payment_requests.id);
  update public.order_submissions set status = 'submitted', submitted_at = now() where id = p_id;
end $$;

/** A ready document version, as generation leaves it. */
create function pg_temp.ready_documents(p_order uuid, p_version integer) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_document_versions
    (id, order_id, version, status, attempt_count, completed_at, excel_path, pdf_path, excel_sha256, pdf_sha256, excel_bytes, pdf_bytes)
  values (gen_random_uuid(), p_order, p_version, 'ready', 1, now(),
          'orders/' || p_order || '/versions/' || p_version || '/confirmed.xlsx',
          'orders/' || p_order || '/versions/' || p_version || '/confirmed.pdf',
          repeat('c', 64), repeat('d', 64), 1000, 1000)
  returning id into v;
  return v;
end $$;

/** Everything a date edit must NOT move, as one comparable value. */
create function pg_temp.untouched(p_order uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'order_status', (select to_jsonb(o) -> 'status' from public.orders o where o.id = p_order),
    'alignment',    (select production_alignment from public.orders where id = p_order),
    'handoffs',     (select jsonb_agg(jsonb_build_object('id', h.id, 'status', h.status, 'version', h.version_number,
                                                          'superseded', h.superseded_at is not null) order by h.created_at)
                       from public.order_operations_handoffs h where h.order_id = p_order),
    'pi_versions',  (select jsonb_agg(jsonb_build_object('id', v.id, 'status', v.status) order by v.version_number)
                       from public.order_pi_versions v where v.order_id = p_order),
    'notifications',(select count(*) from public.notifications where entity_id = p_order)
  );
$$;

create function pg_temp.events(p_order uuid, p_type text) returns bigint language sql as $$
  select count(*) from public.order_activity_log where order_id = p_order and event_type = p_type;
$$;

/** The schedule editor as the owner-admin, amending a submitted PI (reason required). */
create function pg_temp.schedule(p_pi uuid, p_fields jsonb) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  v := public.update_order_submission_schedule_terms(p_pi, p_fields, null, 'ASSERT amendment');
  perform pg_temp.restore();
  return v;
end $$;


-- ═══ 0. AN ACCEPTED, ALIGNED ORDER WITH CURRENT DOCUMENTS ═══════════════════

do $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.set_order_operations_reviewer(current_setting('test.reviewer_id')::uuid);
  perform pg_temp.restore();
end $$;

select pg_temp.make_pi(current_setting('test.pi_a')::uuid, current_setting('test.sales_id')::uuid, 1000000);

do $$
declare v jsonb; o uuid; h uuid;
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  v := public.approve_order_submission(current_setting('test.pi_a')::uuid, current_setting('test.sales_id')::uuid,
                                        date '2026-09-20', date '2026-11-20', 'reference');
  perform pg_temp.restore();
  o := (v ->> 'order_id')::uuid;
  perform set_config('test.order_a', o::text, true);

  select id into h from public.order_operations_handoffs where order_id = o and superseded_at is null;
  perform pg_temp.become(current_setting('test.reviewer_id')::uuid);
  -- Acceptance IS the alignment for a handoff Order (set_order_production_alignment
  -- refuses a second one: ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED).
  perform public.decide_order_operations_handoff(h, 'accepted', null);
  perform pg_temp.restore();

  perform set_config('test.doc_1', pg_temp.ready_documents(o, 1)::text, true);

  perform pg_temp.check((select status from public.order_operations_handoffs where id = h) = 'accepted', '0. Operations accepted V1');
  perform pg_temp.check((select production_alignment from public.orders where id = o) = 'aligned', '0. production is aligned');
  raise notice 'section 0 (accepted, aligned Order with current documents) ready';
end $$;


-- ═══ 1. A DATE-ONLY EDIT THROUGH THE SCHEDULE EDITOR ═══════════════════════

do $$
declare
  a  uuid := current_setting('test.pi_a')::uuid;
  o  uuid := current_setting('test.order_a')::uuid;
  before jsonb := pg_temp.untouched(o);
  sup0   bigint := pg_temp.events(o, 'document_generation_superseded');
  amd0   bigint := pg_temp.events(o, 'order_schedule_terms_amended');
  r jsonb;
begin
  r := pg_temp.schedule(a, '{"order_confirmation_date":"2026-09-23","due_date":"2026-12-04"}');

  perform pg_temp.check((r ->> 'superseded_documents')::int = 0, '1. the RPC reports nothing superseded');
  perform pg_temp.check((select superseded_at is null from public.order_document_versions
     where id = current_setting('test.doc_1')::uuid), '1. the ready documents are still CURRENT');
  perform pg_temp.check(pg_temp.events(o, 'document_generation_superseded') = sup0, '1. no supersede event');

  perform pg_temp.check((select confirm_date = date '2026-09-23' and due_date = date '2026-12-04'
     from public.orders where id = o), '1. the Order''s dates DID change');
  perform pg_temp.check((select order_confirmation_date = date '2026-09-23' and due_date = date '2026-12-04'
     from public.order_submissions where id = a), '1. the PI''s dates DID change');
  perform pg_temp.check(pg_temp.events(o, 'order_schedule_terms_amended') = amd0 + 1, '1. the Order history records the amendment');
  perform pg_temp.check(exists (select 1 from public.order_submission_activity
     where submission_id = a and action = 'schedule_terms_amended_by_admin'
       and metadata -> 'changed' -> 'due_date' ->> 'to' = '2026-12-04'
       and (metadata ->> 'superseded_documents')::int = 0), '1. the PI history records it, with 0 superseded');

  perform pg_temp.check(pg_temp.untouched(o) = before,
    '1. no new PI version, no new handoff, acceptance and production alignment kept, Order status and notifications unchanged: '
    || before::text || ' -> ' || pg_temp.untouched(o)::text);
  raise notice 'section 1 (date-only edit: dates and history move; documents, acceptance, alignment do not) passed';
end $$;


-- ═══ 1b. THE GUARD STILL HOLDS FOR EVERYTHING ELSE ══════════════════════════

do $$
declare
  a uuid := current_setting('test.pi_a')::uuid;
  o uuid := current_setting('test.order_a')::uuid;
  before jsonb := pg_temp.untouched(o);
  pi_before public.order_submissions%rowtype;
begin
  select * into pi_before from public.order_submissions where id = a;

  -- Dispatch text is printed (confirmed Excel E113): a revision, not an edit.
  begin
    perform pg_temp.schedule(a, '{"dispatch_commitment":"10 weeks from confirmation"}');
    raise exception 'ASSERT FAILED: 1b. a dispatch edit on an approved PI was accepted';
  exception when others then
    perform pg_temp.restore();
    perform pg_temp.check(sqlerrm like 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%', '1b. dispatch needs a revision: ' || sqlerrm);
  end;
  -- Dates AND dispatch together: refused whole — the dates do not slip through.
  begin
    perform pg_temp.schedule(a, '{"due_date":"2026-12-25","dispatch_commitment":"12 weeks"}');
    raise exception 'ASSERT FAILED: 1b. a mixed edit was accepted';
  exception when others then
    perform pg_temp.restore();
    perform pg_temp.check(sqlerrm like 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%', '1b. a mixed edit is refused whole: ' || sqlerrm);
  end;
  -- Client details are printed: still a revision.
  begin
    perform pg_temp.become(current_setting('test.owner_id')::uuid);
    perform public.update_order_submission_client_details(a, '{"bill_to_phone":"+91 90000 12345"}', null, 'ASSERT amendment');
    raise exception 'ASSERT FAILED: 1b. a client-details edit on an approved PI was accepted';
  exception when others then
    perform pg_temp.restore();
    perform pg_temp.check(sqlerrm like 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%', '1b. client details need a revision: ' || sqlerrm);
  end;
  -- The date rule, on an Order too.
  begin
    perform pg_temp.schedule(a, '{"due_date":"2026-09-01"}');
    raise exception 'ASSERT FAILED: 1b. a due date before the confirmation date was accepted';
  exception when others then
    perform pg_temp.restore();
    perform pg_temp.check(sqlerrm like 'ORDER_SUBMISSION_DUE_BEFORE_CONFIRMATION%', '1b. date order: ' || sqlerrm);
  end;
  -- The exemption is the editor's alone: a direct write of the dates is refused.
  begin
    perform set_config('request.jwt.claims', '', true);
    update public.order_submissions set due_date = date '2027-01-15' where id = a;
    raise exception 'ASSERT FAILED: 1b. a direct date write on an approved PI was accepted';
  exception when others then
    perform pg_temp.check(sqlerrm like 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%', '1b. a direct write is refused: ' || sqlerrm);
  end;

  perform pg_temp.check((select dispatch_commitment is not distinct from pi_before.dispatch_commitment
                            and due_date = pi_before.due_date and bill_to_phone is not distinct from pi_before.bill_to_phone
                           from public.order_submissions where id = a), '1b. nothing refused moved anything');
  perform pg_temp.check((select superseded_at is null from public.order_document_versions
     where id = current_setting('test.doc_1')::uuid), '1b. documents still current');
  perform pg_temp.check(pg_temp.untouched(o) = before, '1b. handoff, versions, alignment, status unchanged');
  raise notice 'section 1b (everything printed still needs a revision) passed';
end $$;


-- ═══ 2. AN ORDER AMENDMENT (amend_order), DATES ONLY ════════════════════════

do $$
declare
  o  uuid := current_setting('test.order_a')::uuid;
  before jsonb := pg_temp.untouched(o);
  sup0   bigint := pg_temp.events(o, 'document_generation_superseded');
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.amend_order(o, 'ASSERT dates', null, null, null, date '2026-09-24', date '2026-12-11', null, null);
  perform pg_temp.restore();
  perform pg_temp.check((select confirm_date = date '2026-09-24' and due_date = date '2026-12-11' from public.orders where id = o),
    '2. the Order dates changed');
  perform pg_temp.check(pg_temp.events(o, 'order_amended') >= 1, '2. recorded as an Order amendment');
  perform pg_temp.check(pg_temp.events(o, 'document_generation_superseded') = sup0, '2. no supersede');
  perform pg_temp.check(pg_temp.untouched(o) = before, '2. handoff, versions, alignment, status, notifications unchanged');
  raise notice 'section 2 (Order amendment of dates is clean) passed';
end $$;


-- ═══ 3. PRINTED CONTENT: a product line changed through Edit PI ═════════════
--
-- The contrast case: what a client document prints DOES change, so the
-- revision path runs in full — documents superseded, a new PI version, a new
-- Operations handoff awaiting acceptance, alignment reset.

do $$
declare
  a uuid := current_setting('test.pi_a')::uuid;
  o uuid := current_setting('test.order_a')::uuid;
  p jsonb; r jsonb; v uuid;
begin
  p := jsonb_build_object(
    'payload', jsonb_build_object(
      'header', (select jsonb_build_object('client_name', client_name, 'order_confirmation_date', order_confirmation_date,
                                           'due_date', due_date, 'creation_date', creation_date)
                   from public.order_submissions where id = a),
      'commercial', jsonb_build_object('gross_product_amount', 1000000, 'discount_amount', 0, 'total_before_gst', 1000000,
                                       'gst_amount', 0, 'grand_total', 1000000),
      'source', (select jsonb_build_object('workbook_path', source_workbook_path, 'workbook_sha256', source_workbook_sha256)
                   from public.order_submissions where id = a),
      'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
      'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'source_row', i.source_row, 'item_sequence', i.item_sequence,
                  'product_name', 'ASSERT walnut chair', 'quantity', i.quantity, 'cost_per_piece', i.cost_per_piece,
                  'total_amount', i.total_amount, 'image_storage_path', i.image_storage_path, 'image_mime_type', i.image_mime_type,
                  'image_sha256', i.image_sha256, 'image_anchor_row', i.image_anchor_row, 'sort_order', i.sort_order))
                  from public.order_submission_items i where i.submission_id = a),
      'item_images', (select coalesce(jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'submission_id'), '[]'::jsonb)
                        from public.order_submission_item_images m where m.submission_id = a),
      'seed_terms', jsonb_build_object(),
      'fingerprint', repeat('f', 64)),
    'terms', jsonb_build_object(), 'change_summary', jsonb_build_array('ASSERT product name'));
  r := public.propose_order_pi_edit_revision(o, current_setting('test.owner_id')::uuid, p, 'ASSERT product name');
  v := (r ->> 'version_id')::uuid;
  r := public.approve_order_pi_revision(v, current_setting('test.owner_id')::uuid,
         (select proposal -> 'payload' from public.order_pi_versions where id = v));

  perform pg_temp.check((select superseded_at is not null from public.order_document_versions
     where id = current_setting('test.doc_1')::uuid), '3. printed content changed: the documents are superseded');
  perform pg_temp.check((select status from public.order_pi_versions where id = v) = 'approved', '3. V2 is in force');
  perform pg_temp.check((select status from public.order_operations_handoffs where order_id = o and superseded_at is null) = 'awaiting',
    '3. and Operations must accept V2');
  perform pg_temp.check((select production_alignment from public.orders where id = o) = 'not_aligned', '3. alignment waits for it');
  raise notice 'section 3 (printed content still revises, supersedes and re-asks Operations) passed';
end $$;


-- ═══ 4. A DRAFT: nothing to supersede ═══════════════════════════════════════

do $$
declare p uuid := gen_random_uuid(); r jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name, parse_warnings, parse_blocking_issues, reservation_required)
  values (p, 'draft', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT draft', '[]', '[]', false);
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  r := public.update_order_submission_schedule_terms(p, '{"due_date":"2026-12-01","dispatch_commitment":"6 weeks"}', null, null);
  perform pg_temp.restore();
  perform pg_temp.check((r ->> 'superseded_documents')::int = 0, '4. a draft supersedes nothing');
  raise notice 'section 4 (draft) passed';
end $$;

do $$ begin raise notice 'ALL DOCUMENT STALENESS ASSERTIONS PASSED'; end $$;

rollback;
