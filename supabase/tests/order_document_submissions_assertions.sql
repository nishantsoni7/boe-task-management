-- ORDER DOCUMENT SUBMISSIONS assertions (20261231000000)
-- ===========================================================================
-- Validates, through the REAL doors (submit / admin decision / operations
-- decision) on a disposable local stack:
--
--   * lifecycle     Sales submits -> pending_admin; admin approves ->
--                   awaiting_operations addressed to the assigned reviewer;
--                   operations accepts -> accepted (the only promotion)
--   * rejections    admin and operations rejections require a reason, stay on
--                   record, notify Sales; a correction is a NEW submission
--   * permissions   an outsider cannot submit; Sales cannot decide either
--                   stage; an admin who is not the reviewer cannot accept;
--                   anon executes nothing; clients cannot write the tables
--   * races         a second open submission on the same category is refused
--                   (and the partial unique index backs it); a different
--                   category proceeds
--   * stale tabs    a repeated decision, a decision at the wrong stage and a
--                   wrong snapshot hash are refused and notify nobody again
--   * integrity     files must be the caller's own stored objects under this
--                   submission's key; the storage INSERT check seals the key
--                   once the submission exists; history rows are append-only
--   * safety        no Order commercial field, PI version or handoff changes
--
-- The fixture section (users, pg_temp.become, make_pi, approve, assign,
-- expect_error, check) is copied from order_operations_handoff_assertions.sql.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
-- On success prints NOTICE 'ALL DOCUMENT SUBMISSION ASSERTIONS PASSED'.
-- Run with supabase/tests/run_order_document_submissions_local.sh.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id',    '11111111-1111-1111-1111-111111111111', true); -- TEST-001, admin
  perform set_config('test.reviewer_id', '22222222-2222-2222-2222-222222222222', true); -- operations reviewer
  perform set_config('test.admin2_id',   '33333333-3333-3333-3333-333333333333', true); -- another active admin
  perform set_config('test.outsider_id', '44444444-4444-4444-4444-444444444444', true); -- no Orders relationship
  perform set_config('test.sales_id',    '55555555-5555-5555-5555-555555555555', true); -- the PI's owner
  perform set_config('test.reviewer2_id','66666666-6666-6666-6666-666666666666', true); -- a replacement reviewer
  perform set_config('test.viewer_id',   '77777777-7777-7777-7777-777777777777', true);
  perform set_config('test.pi_a', gen_random_uuid()::text, true);
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

/** A revised version approved, through the same writes approve_order_pi_revision() makes. */
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
  update public.order_pi_versions set status = 'superseded', superseded_at = now(), superseded_by_version_id = v_new where id = v_cur.id;
  update public.order_pi_versions set status = 'approved', decided_by = p_actor, decided_at = now() where id = v_new;
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

-- Sales holds orders.view (module entry) and orders.create (the submit door requires it of a non-admin).
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.sales_id')::uuid, pm.id, pa.id, true, current_setting('test.owner_id')::uuid
  from public.permission_modules pm join public.permission_actions pa on pa.action_key in ('create', 'view')
 where pm.module_key = 'orders'
on conflict do nothing;

/** A stored object in order-files, as the Storage API records it for p_owner. */
create function pg_temp.put(p_order uuid, p_sub uuid, p_cat text, p_owner uuid, p_mime text default 'application/pdf',
                            p_size bigint default 2048, p_ext text default 'pdf') returns text language plpgsql as $$
declare v_path text := 'order-documents/' || p_order || '/' || p_sub || '/' || p_cat || '/' || gen_random_uuid() || '.' || p_ext;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('order-files', v_path, p_owner::text, jsonb_build_object('mimetype', p_mime, 'size', p_size));
  return v_path;
end $$;

create function pg_temp.f(p_path text, p_name text) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('path', p_path, 'file_name', p_name));
$$;

create function pg_temp.submit(p_user uuid, p_sub uuid, p_order uuid, p_mode text, p_files jsonb, p_prior uuid default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.create_order_document_submission(p_sub, p_order, p_mode, 'ASSERT note', p_files, p_prior);
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.snap(p_sub uuid) returns text language sql as $$
  select snapshot_sha256 from public.order_document_submissions where id = p_sub;
$$;
create function pg_temp.admin_decide(p_user uuid, p_sub uuid, p_decision text, p_reason text, p_snap text default null)
returns jsonb language plpgsql as $$
declare v jsonb; v_snap text := coalesce(p_snap, pg_temp.snap(p_sub));
begin
  perform pg_temp.become(p_user);
  v := public.decide_order_document_submission_admin(p_sub, p_decision, p_reason, v_snap);
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.ops_decide(p_user uuid, p_sub uuid, p_decision text, p_reason text, p_snap text default null)
returns jsonb language plpgsql as $$
declare v jsonb; v_snap text := coalesce(p_snap, pg_temp.snap(p_sub));
begin
  perform pg_temp.become(p_user);
  v := public.decide_order_document_submission_operations(p_sub, p_decision, p_reason, v_snap);
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.status(p_sub uuid) returns text language sql as $$
  select status from public.order_document_submissions where id = p_sub;
$$;
create function pg_temp.notes(p_user uuid, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where user_id = p_user and type::text = p_type;
$$;

-- ═══ 1. FIXTURE ORDER, reviewer assigned ═══════════════════════════════════

select pg_temp.assign(current_setting('test.reviewer_id')::uuid);
select pg_temp.make_pi(current_setting('test.pi_a')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT A', 1000000);
select set_config('test.order_a', pg_temp.approve(current_setting('test.pi_a')::uuid)::text, true);
select set_config('test.before', (select row(o.client_name, o.total_value, o.total_product_value, o.due_date, o.confirm_date, o.status)::text
                                    from public.orders o where o.id = current_setting('test.order_a')::uuid), true);
select set_config('test.pi_before', (select string_agg(id::text || status, ',' order by version_number) from public.order_pi_versions
                                      where order_id = current_setting('test.order_a')::uuid), true);
select set_config('test.handoff_before', (select string_agg(id::text || status, ',') from public.order_operations_handoffs
                                           where order_id = current_setting('test.order_a')::uuid), true);

-- ═══ 2. SUBMIT: permissions and file checks ════════════════════════════════

do $$
declare o uuid := current_setting('test.order_a')::uuid; s uuid := gen_random_uuid(); p text;
        sales uuid := current_setting('test.sales_id')::uuid; outsider uuid := current_setting('test.outsider_id')::uuid;
begin
  p := pg_temp.put(o, s, 'client_po', outsider);
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''po.pdf''))', outsider, s, o, p),
          'can submit documents', '2. an outsider cannot submit');
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''po.pdf''))', sales, s, o, p),
          'ORDER_DOCUMENT_FILE_NOT_YOURS', '2. a file uploaded by somebody else is refused');
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''po.pdf''))', sales, gen_random_uuid(), o,
            pg_temp.put(o, s, 'client_po', sales)),
          'ORDER_DOCUMENT_FILE_PATH_INVALID', '2. a key outside this submission is refused');
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''po.pdf''))', sales, s, o,
            pg_temp.put(o, s, 'client_po', sales, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
          'ORDER_DOCUMENT_FILE_TYPE', '2. a non-PDF/image object is refused');
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''po.pdf''))', sales, s, o,
            pg_temp.put(o, s, 'client_po', sales, 'application/pdf', 20000000)),
          'ORDER_DOCUMENT_FILE_SIZE', '2. an object over 10 MB is refused');
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''d.png''))', sales, s, o,
            pg_temp.put(o, s, 'design_files', sales, 'image/png', 4096, 'png')),
          'ORDER_DOCUMENT_DESIGN_MODE_REQUIRED', '2. design files need add or replace');
  perform pg_temp.check(not exists (select 1 from public.order_document_submissions where order_id = o), '2. nothing recorded by refused submits');
end $$;

-- ═══ 3. THE HAPPY PATH: PO + design (replace), admin then operations ═══════

do $$
declare o uuid := current_setting('test.order_a')::uuid; s uuid := gen_random_uuid(); v jsonb; r public.order_document_submissions;
        sales uuid := current_setting('test.sales_id')::uuid; owner uuid := current_setting('test.owner_id')::uuid;
        reviewer uuid := current_setting('test.reviewer_id')::uuid; admin2 uuid := current_setting('test.admin2_id')::uuid;
        n_admin bigint; n_rev bigint;
begin
  perform set_config('test.sub1', s::text, true);
  n_admin := pg_temp.notes(admin2, 'order_document_review_requested');
  v := pg_temp.submit(sales, s, o, 'replace', jsonb_build_array(
         jsonb_build_object('path', pg_temp.put(o, s, 'client_po', sales), 'file_name', 'PO-771.pdf'),
         jsonb_build_object('path', pg_temp.put(o, s, 'design_files', sales, 'image/png', 4096, 'png'), 'file_name', 'front.png'),
         jsonb_build_object('path', pg_temp.put(o, s, 'design_files', sales, 'image/jpeg', 4096, 'jpg'), 'file_name', 'back.jpg')));
  select * into r from public.order_document_submissions where id = s;
  perform pg_temp.check(r.status = 'pending_admin' and r.includes_client_po and r.includes_design_files and r.design_mode = 'replace', '3. submitted, pending admin');
  perform pg_temp.check(r.file_count = 3 and (select count(*) from public.order_document_submission_files where submission_id = s) = 3, '3. three files snapshotted');
  perform pg_temp.check(r.snapshot_sha256 ~ '^[0-9a-f]{64}$' and r.snapshot_sha256 = v->>'snapshot_sha256', '3. snapshot hash recorded');
  perform pg_temp.check(pg_temp.notes(admin2, 'order_document_review_requested') = n_admin + 1, '3. each admin is told once');
  perform pg_temp.check(pg_temp.notes(sales, 'order_document_review_requested') = 0, '3. the submitter is not told of their own submit');
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''x.pdf''))', sales, s, o,
            pg_temp.put(o, gen_random_uuid(), 'client_po', sales)),
          'ORDER_DOCUMENT_SUBMISSION_EXISTS', '3. a retried submit id is refused, not doubled');

  -- Sealed: no more files can be uploaded under this submission's key.
  perform pg_temp.become(sales);
  perform pg_temp.check(not public.can_upload_order_document_file('order-documents/' || o || '/' || s || '/client_po/' || gen_random_uuid() || '.pdf'),
                        '3. the storage key is sealed once the submission exists');
  perform pg_temp.check(public.can_upload_order_document_file('order-documents/' || o || '/' || gen_random_uuid() || '/client_po/' || gen_random_uuid() || '.pdf'),
                        '3. a fresh submission key is writable by Sales');
  perform pg_temp.check(not public.can_upload_order_document_file('order-documents/' || o || '/' || gen_random_uuid() || '/client_po/../x.pdf'),
                        '3. a malformed key is refused');
  perform pg_temp.restore();
  perform pg_temp.become(current_setting('test.outsider_id')::uuid);
  perform pg_temp.check(not public.can_upload_order_document_file('order-documents/' || o || '/' || gen_random_uuid() || '/client_po/' || gen_random_uuid() || '.pdf'),
                        '3. an outsider cannot upload under the Order');
  perform pg_temp.restore();

  perform pg_temp.expect_error(format('select pg_temp.admin_decide(%L, %L, ''approved'', null)', sales, s),
          'Only an administrator', '3. Sales cannot make the admin decision');
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', reviewer, s),
          'ORDER_DOCUMENT_ALREADY_DECIDED', '3. operations cannot accept before admin approval');
  perform pg_temp.expect_error(format('select pg_temp.admin_decide(%L, %L, ''approved'', null, %L)', owner, s, repeat('b', 64)),
          'ORDER_DOCUMENT_SNAPSHOT_MISMATCH', '3. a decision on a different snapshot is refused');
  perform pg_temp.expect_error(format('select pg_temp.admin_decide(%L, %L, ''rejected'', ''  '')', owner, s),
          'ORDER_DOCUMENT_REASON_REQUIRED', '3. an admin rejection needs a reason');

  n_rev := pg_temp.notes(reviewer, 'order_document_review_requested');
  v := pg_temp.admin_decide(owner, s, 'approved', null);
  perform pg_temp.check(pg_temp.status(s) = 'awaiting_operations', '3. admin approval -> awaiting operations');
  perform pg_temp.check((select operations_reviewer from public.order_document_submissions where id = s) = reviewer, '3. addressed to the assigned reviewer');
  perform pg_temp.check(pg_temp.notes(reviewer, 'order_document_review_requested') = n_rev + 1, '3. the reviewer is told once, when it becomes their action');
  perform pg_temp.check(not exists (select 1 from public.order_document_submissions where order_id = o and status = 'accepted'),
                        '3. nothing is current after admin approval alone');

  perform pg_temp.expect_error(format('select pg_temp.admin_decide(%L, %L, ''approved'', null)', owner, s),
          'ORDER_DOCUMENT_ALREADY_DECIDED', '3. a repeated admin approval is refused');
  perform pg_temp.expect_error(format('select pg_temp.admin_decide(%L, %L, ''rejected'', ''late'')', admin2, s),
          'ORDER_DOCUMENT_ALREADY_DECIDED', '3. a stale admin tab cannot reject afterwards');
  perform pg_temp.check(pg_temp.notes(reviewer, 'order_document_review_requested') = n_rev + 1, '3. and nobody is notified again');

  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', owner, s),
          'Only the assigned operations reviewer', '3. an admin is not substituted for the reviewer');
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', sales, s),
          'Only the assigned operations reviewer', '3. Sales cannot accept');
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null, %L)', reviewer, s, repeat('d', 64)),
          'ORDER_DOCUMENT_SNAPSHOT_MISMATCH', '3. operations cannot accept a different snapshot');

  v := pg_temp.ops_decide(reviewer, s, 'accepted', 'Looks right');
  perform pg_temp.check(pg_temp.status(s) = 'accepted', '3. operations acceptance promotes');
  perform pg_temp.check(pg_temp.notes(sales, 'order_document_review_decided') = 1, '3. Sales is told of the final acceptance, once');
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', reviewer, s),
          'ORDER_DOCUMENT_ALREADY_DECIDED', '3. a repeated acceptance is refused');
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''rejected'', ''stale'')', reviewer, s),
          'ORDER_DOCUMENT_ALREADY_DECIDED', '3. a stale tab cannot reject an accepted submission');
  perform pg_temp.check(pg_temp.notes(sales, 'order_document_review_decided') = 1, '3. no duplicate notification');
  perform pg_temp.check((select count(*) from public.order_document_submission_events where submission_id = s) = 3, '3. three events on the trail');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o and event_type like 'document_submission_%') >= 3, '3. and on the Order history');
end $$;

-- ═══ 4. RACES: one open submission per category ═══════════════════════════

do $$
declare o uuid := current_setting('test.order_a')::uuid; s2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid(); s4 uuid := gen_random_uuid();
        sales uuid := current_setting('test.sales_id')::uuid;
begin
  perform set_config('test.sub2', s2::text, true);
  perform set_config('test.sub4', s4::text, true);
  perform pg_temp.submit(sales, s2, o, null, pg_temp.f(pg_temp.put(o, s2, 'client_po', sales), 'PO-772.pdf'));
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''PO-773.pdf''))', sales, s3, o,
            pg_temp.put(o, s3, 'client_po', sales)),
          'ORDER_DOCUMENT_CATEGORY_PENDING', '4. a second open Client PO submission is refused, in words');
  perform pg_temp.submit(sales, s4, o, 'add', pg_temp.f(pg_temp.put(o, s4, 'design_files', sales, 'image/webp', 1000, 'webp'), 'side.webp'));
  perform pg_temp.check(pg_temp.status(s4) = 'pending_admin', '4. a Design Files submission proceeds beside an open PO one');
  -- The index backs the check even if the RPC were bypassed.
  perform pg_temp.expect_error(format(
      'insert into public.order_document_submissions (id, order_id, includes_client_po, snapshot_sha256, file_count, submitted_by) values (%L, %L, true, %L, 1, %L)',
      gen_random_uuid(), o, repeat('e', 64), sales),
    'order_document_submissions_one_open_po', '4. the partial unique index refuses a second open PO row');
end $$;

-- ═══ 5. REJECTIONS AND CORRECTION ══════════════════════════════════════════

do $$
declare o uuid := current_setting('test.order_a')::uuid; s2 uuid := current_setting('test.sub2')::uuid; s4 uuid := current_setting('test.sub4')::uuid;
        s5 uuid := gen_random_uuid(); sales uuid := current_setting('test.sales_id')::uuid; owner uuid := current_setting('test.owner_id')::uuid;
        reviewer uuid := current_setting('test.reviewer_id')::uuid; n bigint;
begin
  n := pg_temp.notes(sales, 'order_document_review_decided');
  perform pg_temp.admin_decide(owner, s2, 'rejected', 'Wrong client on the PO');
  perform pg_temp.check(pg_temp.status(s2) = 'rejected_admin', '5. admin rejection recorded');
  perform pg_temp.check((select admin_reason from public.order_document_submissions where id = s2) = 'Wrong client on the PO', '5. the reason is kept for Sales');
  perform pg_temp.check(pg_temp.notes(sales, 'order_document_review_decided') = n + 1, '5. Sales is told of the admin rejection');

  perform pg_temp.submit(sales, s5, o, null, pg_temp.f(pg_temp.put(o, s5, 'client_po', sales), 'PO-772-corrected.pdf'), s2);
  perform pg_temp.check((select resubmission_of from public.order_document_submissions where id = s5) = s2, '5. the correction links the rejected submission');
  perform pg_temp.check(pg_temp.status(s2) = 'rejected_admin', '5. the rejected submission stays in history, unchanged');
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, ''add'', pg_temp.f(%L, ''a.png''), %L)', sales, gen_random_uuid(), o,
            pg_temp.put(o, gen_random_uuid(), 'design_files', sales, 'image/png', 1000, 'png'), current_setting('test.sub1')),
          'ORDER_DOCUMENT_FILE_PATH_INVALID', '5. (sanity) a key of another submission is refused first');

  perform pg_temp.admin_decide(owner, s4, 'approved', null);
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''rejected'', null)', reviewer, s4),
          'ORDER_DOCUMENT_REASON_REQUIRED', '5. an operations rejection needs a reason');
  n := pg_temp.notes(owner, 'order_document_review_decided');
  perform pg_temp.ops_decide(reviewer, s4, 'rejected', 'Side view is the old colourway');
  perform pg_temp.check(pg_temp.status(s4) = 'rejected_operations', '5. operations rejection recorded');
  perform pg_temp.check((select operations_reason from public.order_document_submissions where id = s4) = 'Side view is the old colourway', '5. the reason is visible');
  perform pg_temp.check(pg_temp.notes(owner, 'order_document_review_decided') = n + 1, '5. the approving admin is told of the operations rejection');
end $$;

-- ═══ 6. VISIBILITY, PRIVILEGES AND HISTORY ═════════════════════════════════

do $$
declare o uuid := current_setting('test.order_a')::uuid; s uuid := current_setting('test.sub1')::uuid; p text;
begin
  select storage_path into p from public.order_document_submission_files where submission_id = s limit 1;
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  perform pg_temp.check((select count(*) from public.order_document_submissions where order_id = o) >= 4, '6. Sales reads their Order''s submissions');
  perform pg_temp.check(public.can_read_order_document_file(p), '6. Sales can read the files');
  perform pg_temp.restore();
  perform pg_temp.become(current_setting('test.reviewer_id')::uuid);
  perform pg_temp.check(public.can_read_order_document_file(p), '6. the operations reviewer can read the files');
  perform pg_temp.restore();
  perform pg_temp.become(current_setting('test.outsider_id')::uuid);
  perform pg_temp.check((select count(*) from public.order_document_submissions where order_id = o) = 0, '6. an outsider reads no submissions');
  perform pg_temp.check((select count(*) from public.order_document_submission_files) = 0, '6. an outsider reads no file rows');
  perform pg_temp.check(not public.can_read_order_document_file(p), '6. an outsider cannot read the files');
  perform pg_temp.restore();

  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_document_submissions', 'INSERT'), '6. clients cannot insert submissions');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_document_submissions', 'UPDATE'), '6. clients cannot update submissions');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_document_submission_files', 'INSERT'), '6. clients cannot insert file rows');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_document_submission_events', 'DELETE'), '6. clients cannot delete history');
  perform pg_temp.check(not has_function_privilege('anon', 'public.create_order_document_submission(uuid, uuid, text, text, jsonb, uuid)', 'EXECUTE'), '6. anon cannot submit');
  perform pg_temp.check(not has_function_privilege('anon', 'public.decide_order_document_submission_admin(uuid, text, text, text)', 'EXECUTE'), '6. anon cannot decide (admin)');
  perform pg_temp.check(not has_function_privilege('anon', 'public.decide_order_document_submission_operations(uuid, text, text, text)', 'EXECUTE'), '6. anon cannot decide (operations)');
  perform pg_temp.check(not exists (select 1 from pg_policy pp join pg_class c on c.oid = pp.polrelid
                                     where c.relname = 'objects' and pp.polname like 'order_files_document%' and pp.polcmd in ('w', 'd')),
                        '6. no UPDATE or DELETE storage policy for submitted files');

  perform pg_temp.expect_error(format('update public.order_document_submission_files set file_name = ''x'' where submission_id = %L', s),
          'ORDER_DOCUMENT_HISTORY_IMMUTABLE', '6. files are append-only');
  perform pg_temp.expect_error(format('delete from public.order_document_submission_events where submission_id = %L', s),
          'ORDER_DOCUMENT_HISTORY_IMMUTABLE', '6. events are append-only');
  perform pg_temp.expect_error(format('update public.order_document_submissions set status = ''pending_admin'' where id = %L', s),
          'ORDER_DOCUMENT_SUBMISSION_TRANSITION_INVALID', '6. an accepted submission cannot move back');
  perform pg_temp.expect_error(format('update public.order_document_submissions set snapshot_sha256 = repeat(''c'', 64) where id = %L', s),
          'ORDER_DOCUMENT_SUBMISSION_IMMUTABLE', '6. the snapshot cannot be rewritten');
  perform pg_temp.expect_error(format('delete from public.order_document_submissions where id = %L', s),
          'ORDER_DOCUMENT_SUBMISSION_IMMUTABLE', '6. a submission cannot be deleted');
end $$;

-- ═══ 7. NO COMMERCIAL DATA, PI VERSION OR HANDOFF MOVED ════════════════════

do $$
declare o uuid := current_setting('test.order_a')::uuid;
begin
  perform pg_temp.check((select row(o2.client_name, o2.total_value, o2.total_product_value, o2.due_date, o2.confirm_date, o2.status)::text
                           from public.orders o2 where o2.id = o) = current_setting('test.before'), '7. the Order''s commercial fields are unchanged');
  perform pg_temp.check((select string_agg(id::text || status, ',' order by version_number) from public.order_pi_versions where order_id = o)
                          = current_setting('test.pi_before'), '7. PI versions are unchanged');
  perform pg_temp.check((select string_agg(id::text || status, ',') from public.order_operations_handoffs where order_id = o)
                          = current_setting('test.handoff_before'), '7. the PI handoff is unchanged');
end $$;

-- ═══ 8. REASSIGNMENT AND NO REVIEWER ═══════════════════════════════════════

do $$
declare o uuid := current_setting('test.order_a')::uuid; s6 uuid := gen_random_uuid();
        sales uuid := current_setting('test.sales_id')::uuid; owner uuid := current_setting('test.owner_id')::uuid;
        reviewer uuid := current_setting('test.reviewer_id')::uuid; reviewer2 uuid := current_setting('test.reviewer2_id')::uuid;
        n bigint;
begin
  perform pg_temp.submit(sales, s6, o, 'add', pg_temp.f(pg_temp.put(o, s6, 'design_files', sales, 'image/png', 1000, 'png'), 'top.png'));
  perform pg_temp.admin_decide(owner, s6, 'approved', null);
  perform pg_temp.assign(reviewer2);
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', reviewer, s6),
          'Only the assigned operations reviewer', '8. the former reviewer is refused after reassignment');
  perform pg_temp.assign(null);
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', reviewer2, s6),
          'ORDER_DOCUMENT_NO_OPERATIONS_REVIEWER', '8. with no reviewer assigned, nobody decides');
  perform pg_temp.assign(reviewer2);
  perform pg_temp.ops_decide(reviewer2, s6, 'accepted', null);
  perform pg_temp.check(pg_temp.status(s6) = 'accepted', '8. the replacement reviewer accepts');

  -- No reviewer at admin approval: it waits unassigned and every admin is told.
  perform pg_temp.assign(null);
  s6 := gen_random_uuid();
  perform pg_temp.submit(sales, s6, o, 'add', pg_temp.f(pg_temp.put(o, s6, 'design_files', sales, 'image/png', 900, 'png'), 'late.png'));
  n := pg_temp.notes(current_setting('test.admin2_id')::uuid, 'order_document_review_requested');
  perform pg_temp.admin_decide(owner, s6, 'approved', null);
  perform pg_temp.check((select operations_reviewer from public.order_document_submissions where id = s6) is null, '8. unassigned when nobody is assigned');
  perform pg_temp.check(pg_temp.notes(current_setting('test.admin2_id')::uuid, 'order_document_review_requested') = n + 1, '8. the admins are told nobody is assigned');
end $$;


-- ═══ 9. REASSIGNMENT DURING AN OPEN SUBMISSION ═════════════════════════════
--
-- The assignment is the one authority: the row's operations_reviewer (which
-- the Order page and the dashboard queue read) follows it, the former
-- reviewer loses the decision at the database, and the new one is told once.

create function pg_temp.notes_on(p_user uuid, p_order uuid) returns bigint language sql as $$
  select count(*) from public.notifications where user_id = p_user and entity_id = p_order and type::text = 'order_document_review_requested';
$$;
select set_config('test.pi_r', gen_random_uuid()::text, true);
select pg_temp.make_pi(current_setting('test.pi_r')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT R', 700000);
select set_config('test.order_r', pg_temp.approve(current_setting('test.pi_r')::uuid)::text, true);

do $$
declare o uuid := current_setting('test.order_r')::uuid; s uuid := gen_random_uuid();
        sales uuid := current_setting('test.sales_id')::uuid; owner uuid := current_setting('test.owner_id')::uuid;
        r1 uuid := current_setting('test.reviewer_id')::uuid; r2 uuid := current_setting('test.reviewer2_id')::uuid;
        n2 bigint; n1 bigint;
begin
  perform pg_temp.assign(r1);
  perform pg_temp.submit(sales, s, o, 'add', pg_temp.f(pg_temp.put(o, s, 'design_files', sales, 'image/png', 700, 'png'), 'r.png'));
  perform pg_temp.admin_decide(owner, s, 'approved', null);
  perform pg_temp.check((select operations_reviewer from public.order_document_submissions where id = s) = r1, '9. addressed to R1');

  n2 := pg_temp.notes_on(r2, o);
  n1 := pg_temp.notes_on(r1, o);
  perform pg_temp.assign(r2);
  perform pg_temp.check((select operations_reviewer from public.order_document_submissions where id = s) = r2,
                        '9. the row follows the reassignment (what the page and the queue read)');
  perform pg_temp.check(pg_temp.notes_on(r2, o) = n2 + 1, '9. the new reviewer is told once');
  perform pg_temp.check(pg_temp.notes_on(r1, o) = n1, '9. the former reviewer is not told again');
  perform pg_temp.check(exists (select 1 from public.order_document_submission_events where submission_id = s and event = 'operations_reassigned'),
                        '9. the reassignment is on the trail');
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', r1, s),
          'Only the assigned operations reviewer', '9. the former reviewer is refused at the database');
  -- Re-assigning the same person changes and notifies nothing.
  perform pg_temp.assign(r2);
  perform pg_temp.check(pg_temp.notes_on(r2, o) = n2 + 1, '9. no duplicate on an unchanged assignment');

  -- Cleared: nobody holds it, and the row says so.
  perform pg_temp.assign(null);
  perform pg_temp.check((select operations_reviewer from public.order_document_submissions where id = s) is null, '9. cleared → unassigned');
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', r2, s),
          'ORDER_DOCUMENT_NO_OPERATIONS_REVIEWER', '9. nobody decides while unassigned');

  perform pg_temp.assign(r2);
  perform pg_temp.check((select operations_reviewer from public.order_document_submissions where id = s) = r2, '9. reassigned again');
  perform pg_temp.ops_decide(r2, s, 'accepted', null);
  perform pg_temp.check(pg_temp.status(s) = 'accepted', '9. the current reviewer accepts');
  -- The guard admits a reviewer change ONLY while awaiting operations.
  perform pg_temp.expect_error(format('update public.order_document_submissions set operations_reviewer = %L where id = %L', r1, s),
          'ORDER_DOCUMENT_SUBMISSION_TRANSITION_INVALID', '9. an accepted row cannot be readdressed');
end $$;

-- ═══ 10. DOCUMENTS SENT WITH THE PI (initial submission) ═══════════════════

/** A PI left in DRAFT: make_pi without the final submit. */
create function pg_temp.make_draft(p_id uuid, p_owner uuid, p_client text, p_total numeric) returns void language plpgsql as $$
declare
  v_item uuid := gen_random_uuid();
  v_wb   text := 'submissions/' || p_id::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha  text := repeat('a', 64);
  v_img  text;
begin
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
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (gen_random_uuid(), 'ASSERT', p_total * 0.4, current_date, 'hdfc', 'approved_unlinked', p_owner, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  select id, p_id, amount, 'order_submission', p_owner from public.finance_payment_requests where client_name = 'ASSERT' and amount = p_total * 0.4
   and not exists (select 1 from public.finance_payment_allocations a where a.payment_request_id = finance_payment_requests.id);
end $$;

/** A stored object under pi-documents/, as the Storage API records it. */
create function pg_temp.put_pi(p_pi uuid, p_sub uuid, p_cat text, p_owner uuid, p_mime text default 'application/pdf',
                               p_ext text default 'pdf') returns text language plpgsql as $$
declare v_path text := 'pi-documents/' || p_pi || '/' || p_sub || '/' || p_cat || '/' || gen_random_uuid() || '.' || p_ext;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('order-files', v_path, p_owner::text, jsonb_build_object('mimetype', p_mime, 'size', 3000));
  return v_path;
end $$;

create function pg_temp.send(p_user uuid, p_pi uuid, p_doc uuid, p_files jsonb, p_ack text[]) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.submit_pi_for_review_with_documents(p_pi, null, null, null, null, p_doc, p_files, p_ack);
  perform pg_temp.restore();
  return v;
end $$;

create function pg_temp.pi_status(p_pi uuid) returns text language sql as $$
  select status from public.order_submissions where id = p_pi;
$$;
create function pg_temp.initial(p_pi uuid) returns public.order_document_submissions language sql as $$
  select * from public.order_document_submissions where stage = 'initial' and pi_submission_id = p_pi order by submitted_at desc, id limit 1;
$$;

select set_config('test.pi_i', gen_random_uuid()::text, true);
select pg_temp.make_draft(current_setting('test.pi_i')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT I', 800000);

do $$
declare pi uuid := current_setting('test.pi_i')::uuid; d1 uuid := gen_random_uuid(); d2 uuid := gen_random_uuid();
        sales uuid := current_setting('test.sales_id')::uuid; owner uuid := current_setting('test.owner_id')::uuid;
        reviewer uuid := current_setting('test.reviewer2_id')::uuid; design text; po text; v jsonb; r public.order_document_submissions;
        n_before bigint;
begin
  -- Sales may upload under the draft PI; an outsider may not.
  perform pg_temp.become(sales);
  perform pg_temp.check(public.can_upload_pi_document_file('pi-documents/' || pi || '/' || d1 || '/client_po/' || gen_random_uuid() || '.pdf'),
                        '10. the PI owner can upload while it is a draft');
  perform pg_temp.restore();
  perform pg_temp.become(current_setting('test.outsider_id')::uuid);
  perform pg_temp.check(not public.can_upload_pi_document_file('pi-documents/' || pi || '/' || d1 || '/client_po/' || gen_random_uuid() || '.pdf'),
                        '10. an outsider cannot upload under the PI');
  perform pg_temp.restore();

  design := pg_temp.put_pi(pi, d1, 'design_files', sales, 'image/png', 'png');

  -- (a) An unconfirmed absence is refused, and the PI is NOT sent.
  perform pg_temp.expect_error(format('select pg_temp.send(%L, %L, %L, pg_temp.f(%L, ''front.png''), %L)', sales, pi, d1, design, '{}'),
          'ORDER_DOCUMENT_ABSENCE_NOT_CONFIRMED', '10a. a missing Client PO must be confirmed');
  perform pg_temp.check(pg_temp.pi_status(pi) = 'draft', '10a. Cancel / an unconfirmed absence sends nothing');
  perform pg_temp.expect_error(format('select pg_temp.send(%L, %L, %L, %L, %L)', sales, pi, null, '[]', '{client_po}'),
          'ORDER_DOCUMENT_ABSENCE_NOT_CONFIRMED', '10a. both missing must BOTH be confirmed');
  perform pg_temp.check(pg_temp.pi_status(pi) = 'draft', '10a. still a draft');

  -- (b) Design attached, Client PO confirmed absent: the PI is sent, once.
  n_before := (select count(*) from public.notifications);
  v := pg_temp.send(sales, pi, d1, pg_temp.f(design, 'front.png'), '{client_po}');
  perform pg_temp.check(pg_temp.pi_status(pi) = 'submitted', '10b. the PI is submitted through its own door');
  r := pg_temp.initial(pi);
  perform pg_temp.check(r.id = d1 and r.status = 'pending_admin' and r.order_id is null and r.includes_design_files and not r.includes_client_po,
                        '10b. the documents are an initial submission, pending with the PI');
  perform pg_temp.check((select missing from public.order_pi_document_absences where pi_submission_id = pi order by acknowledged_at desc limit 1) = '{client_po}',
                        '10b. the absent Client PO is recorded as acknowledged, not attached');
  perform pg_temp.check((select count(*) from public.notifications) = n_before, '10b. no notification is added to the PI submission');
  perform pg_temp.become(sales);
  perform pg_temp.check(not public.can_upload_pi_document_file('pi-documents/' || pi || '/' || gen_random_uuid() || '/client_po/' || gen_random_uuid() || '.pdf'),
                        '10b. nothing more can be uploaded once the PI is submitted');
  perform pg_temp.check((select count(*) from public.order_document_submissions where id = d1) = 1, '10b. Sales reads their initial submission before any Order exists');
  perform pg_temp.check(public.can_read_pi_document_file(design), '10b. and its file');
  perform pg_temp.restore();

  -- Direct decisions are refused: the PI's doors decide these.
  perform pg_temp.expect_error(format('select pg_temp.admin_decide(%L, %L, ''approved'', null)', owner, d1),
          'ORDER_DOCUMENT_DECIDED_WITH_PI', '10b. no separate admin approval of initial documents');
  perform pg_temp.expect_error(format('update public.order_document_submissions set status = ''rejected_admin'', admin_reason = ''x'', admin_decided_at = now() where id = %L', d1),
          'decided with that PI', '10b. the guard refuses moving an initial row outside the PI doors');

  -- (c) The PI is returned: its documents go back with the PI's reason.
  perform pg_temp.become(owner);
  perform public.request_order_submission_changes(pi, 'Wrong ship-to address');
  perform pg_temp.restore();
  r := pg_temp.initial(pi);
  perform pg_temp.check(r.status = 'rejected_admin' and r.admin_reason like 'PI returned for changes: Wrong ship-to address%',
                        '10c. the returned PI takes its documents back, with its reason');

  -- (d) Resubmission: the earlier design file is carried forward, a PO is added.
  po := pg_temp.put_pi(pi, d2, 'client_po', sales);
  perform pg_temp.expect_error(format('select pg_temp.send(%L, %L, %L, %L, %L)', sales, pi, d2,
            jsonb_build_array(jsonb_build_object('path', design, 'file_name', 'front.png'), jsonb_build_object('path', pg_temp.put_pi(current_setting('test.pi_a')::uuid, d2, 'client_po', sales), 'file_name', 'x.pdf')), '{}'),
          'ORDER_DOCUMENT_FILE_PATH_INVALID', '10d. a file of another PI cannot be carried');
  v := pg_temp.send(sales, pi, d2, jsonb_build_array(jsonb_build_object('path', design, 'file_name', 'front.png'),
                                                     jsonb_build_object('path', po, 'file_name', 'PO-9001.pdf')), '{}');
  r := pg_temp.initial(pi);
  perform pg_temp.check(r.id = d2 and r.status = 'pending_admin' and r.includes_client_po and r.includes_design_files and r.resubmission_of = d1,
                        '10d. the resubmission is a new initial submission linked to the returned one');
  perform pg_temp.check(pg_temp.status(d1) = 'rejected_admin', '10d. the returned one stays in history');
  perform pg_temp.check((select count(*) from public.order_pi_document_absences where pi_submission_id = pi) = 1,
                        '10d. no absence is recorded when both are attached');

  -- (e) The approver creates the Order: the documents go to operations with
  --     PI V1 — linked, admin-decided, addressed to the reviewer — and no
  --     second handoff or notification exists.
  perform pg_temp.assign(reviewer);
  perform set_config('test.order_i', pg_temp.approve(pi)::text, true);
  r := pg_temp.initial(pi);
  perform pg_temp.check(r.status = 'awaiting_operations' and r.order_id = current_setting('test.order_i')::uuid
                        and r.admin_decided_by = owner and r.operations_reviewer = reviewer,
                        '10e. approving the PI approves its documents and links them to the Order');
  perform pg_temp.check((select count(*) from public.order_operations_handoffs where order_id = r.order_id) = 1, '10e. one handoff, not two');
  perform pg_temp.check((select count(*) from public.notifications where user_id = reviewer and entity_id = r.order_id) = 1,
                        '10e. the reviewer is told once — by the handoff');
  perform pg_temp.expect_error(format('select pg_temp.ops_decide(%L, %L, ''accepted'', null)', reviewer, d2),
          'ORDER_DOCUMENT_DECIDED_WITH_PI', '10e. no separate operations task for initial documents');
end $$;

do $$
declare o uuid := current_setting('test.order_i')::uuid; pi uuid := current_setting('test.pi_i')::uuid;
        sales uuid := current_setting('test.sales_id')::uuid; reviewer uuid := current_setting('test.reviewer2_id')::uuid;
        s uuid := gen_random_uuid(); h uuid; r public.order_document_submissions; n bigint;
begin
  -- (f) An amendment on a category still awaiting with the PI is refused.
  perform pg_temp.expect_error(format('select pg_temp.submit(%L, %L, %L, null, pg_temp.f(%L, ''PO.pdf''))', sales, s, o,
            pg_temp.put(o, s, 'client_po', sales)),
          'ORDER_DOCUMENT_CATEGORY_PENDING', '10f. no amendment races the initial documents');

  -- (g) "Cannot accept" leaves them awaiting; accepting the PI accepts them.
  select id into h from public.order_operations_handoffs where order_id = o and superseded_at is null;
  perform pg_temp.decide(reviewer, h, 'clarification_needed', 'Confirm the fabric');
  perform pg_temp.check((pg_temp.initial(pi)).status = 'awaiting_operations', '10g. a flagged PI leaves its documents awaiting');
  n := pg_temp.notes(sales, 'order_document_review_decided');
  perform pg_temp.decide(reviewer, h, 'accepted', null);
  r := pg_temp.initial(pi);
  perform pg_temp.check(r.status = 'accepted' and r.operations_decided_by = reviewer, '10g. accepting PI V1 accepts its documents');
  perform pg_temp.check(pg_temp.notes(sales, 'order_document_review_decided') = n + 1, '10g. Sales is told once');
  perform pg_temp.check((select count(*) from public.order_operations_handoffs where order_id = o) = 1, '10g. still one handoff');
end $$;

-- (h) ADMIN-OWN UPLOAD: an approve_order holder's own PI is auto-approved as a
--     document (20261224) — its attachments are NOT: they wait for the Order
--     and for operations like anybody's.
select set_config('test.pi_own', gen_random_uuid()::text, true);
select pg_temp.make_draft(current_setting('test.pi_own')::uuid, current_setting('test.owner_id')::uuid, 'ASSERT OWN', 600000);
do $$
declare pi uuid := current_setting('test.pi_own')::uuid; d uuid := gen_random_uuid(); owner uuid := current_setting('test.owner_id')::uuid;
begin
  perform pg_temp.send(owner, pi, d, pg_temp.f(pg_temp.put_pi(pi, d, 'client_po', owner), 'own-PO.pdf'), '{design_files}');
  perform pg_temp.check((select pi_approved_by from public.order_submissions where id = pi) = owner, '10h. the PI decision is auto-stamped (unchanged rule)');
  perform pg_temp.check((pg_temp.initial(pi)).status = 'pending_admin', '10h. the attachments are NOT auto-approved');
  perform set_config('test.order_own', pg_temp.approve(pi)::text, true);
  perform pg_temp.check((pg_temp.initial(pi)).status = 'awaiting_operations', '10h. creating the Order is the admin decision');
  perform pg_temp.check((pg_temp.initial(pi)).status <> 'accepted', '10h. nothing is current before operations accepts');
end $$;

-- (i) A REJECTED PI rejects its documents with the PI's reason.
select set_config('test.pi_rej', gen_random_uuid()::text, true);
select pg_temp.make_draft(current_setting('test.pi_rej')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT REJ', 500000);
do $$
declare pi uuid := current_setting('test.pi_rej')::uuid; d uuid := gen_random_uuid(); sales uuid := current_setting('test.sales_id')::uuid;
begin
  perform pg_temp.send(sales, pi, d, pg_temp.f(pg_temp.put_pi(pi, d, 'client_po', sales), 'PO.pdf'), '{design_files}');
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.reject_order_submission(pi, 'Client cancelled');
  perform pg_temp.restore();
  perform pg_temp.check((pg_temp.initial(pi)).status = 'rejected_admin' and (pg_temp.initial(pi)).admin_reason = 'PI rejected: Client cancelled',
                        '10i. a rejected PI rejects its documents with its reason');
end $$;

-- (j) THE OLD DOOR still works and records nothing of documents.
select set_config('test.pi_old', gen_random_uuid()::text, true);
select pg_temp.make_draft(current_setting('test.pi_old')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT OLD', 400000);
do $$
declare pi uuid := current_setting('test.pi_old')::uuid;
begin
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  perform public.submit_pi_for_review(pi, null, null, null, null);
  perform pg_temp.restore();
  perform pg_temp.check(pg_temp.pi_status(pi) = 'submitted', '10j. submit_pi_for_review is unchanged');
  perform pg_temp.check(not exists (select 1 from public.order_document_submissions where pi_submission_id = pi)
                        and not exists (select 1 from public.order_pi_document_absences where pi_submission_id = pi),
                        '10j. and records no documents and no absence');
  perform pg_temp.check(not has_function_privilege('anon', 'public.submit_pi_for_review_with_documents(uuid, text, text, text, text, uuid, jsonb, text[])', 'EXECUTE'),
                        '10j. anon cannot send');
  perform pg_temp.expect_error('update public.order_pi_document_absences set missing = ''{design_files}''',
          'ORDER_DOCUMENT_HISTORY_IMMUTABLE', '10j. an acknowledged absence cannot be rewritten');
end $$;

do $$ begin raise notice 'ALL DOCUMENT SUBMISSION ASSERTIONS PASSED'; end $$;

rollback;
