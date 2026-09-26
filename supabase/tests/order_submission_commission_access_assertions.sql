-- WHO CAN READ A PI'S MIDDLEMAN COMMISSION, AND WHO CAN CHANGE IT (20270122000000 §1b, §5)
-- ===========================================================================
-- Readers, exactly: the PI's salesperson/submitter, its assigned reviewer
-- (order_submissions.assigned_to), an active admin, and a holder of the
-- protected orders.view_pi_commission. Everybody else — an Operations Order
-- viewer, orders.view_all, orders.approve_order, a Finance verifier, another
-- salesperson, an inactive admin, anon — reads NOTHING, through direct API
-- reads of the commission table AND of the activity trail's metadata.
--
--   0  fixtures          one PI per state, each with a saved "Yes" commission:
--                        draft, returned (needs_changes), submitted, and
--                        approved into an Order (the real approval door)
--   1  readers           every allowed reader sees the row, in every state
--   2  non-readers       nobody else does, in any state; Order viewers still
--                        read the PI's dates on the Order-linked PI
--   3  activity          no commission value is stored in ANY activity row;
--                        a commission change is logged only as a flag
--   4  writes            no direct write by anybody; the save RPC refused after
--                        submission, after approval/Order creation, and to
--                        readers who are not editors; allowed on a returned PI
--   5  confirmation      a draft save that changes the commission clears it
--
-- One transaction, ROLLBACK. Synthetic records only.
-- On success prints NOTICE 'ALL COMMISSION ACCESS ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.admin_id',    '11111111-1111-1111-1111-111111111111', true); -- TEST-001, active admin
  perform set_config('test.opsrev_id',   '22222222-2222-2222-2222-222222222222', true); -- operations handoff reviewer
  perform set_config('test.sales_id',    'c0000000-0000-4000-8000-00000000c001', true); -- the PIs' salesperson
  perform set_config('test.other_id',    'c0000000-0000-4000-8000-00000000c002', true); -- another salesperson
  perform set_config('test.assigned_id', 'c0000000-0000-4000-8000-00000000c003', true); -- assigned PI reviewer
  perform set_config('test.viewer_id',   'c0000000-0000-4000-8000-00000000c004', true); -- orders.view_pi_commission
  perform set_config('test.ops_id',      'c0000000-0000-4000-8000-00000000c005', true); -- Operations member, Orders view
  perform set_config('test.viewall_id',  'c0000000-0000-4000-8000-00000000c006', true); -- orders.view_all
  perform set_config('test.approver_id', 'c0000000-0000-4000-8000-00000000c007', true); -- orders.approve_order
  perform set_config('test.finance_id',  'c0000000-0000-4000-8000-00000000c008', true); -- finance.approve verifier
  perform set_config('test.xadmin_id',   'c0000000-0000-4000-8000-00000000c009', true); -- INACTIVE admin
  perform set_config('test.pi_d', gen_random_uuid()::text, true);  -- draft
  perform set_config('test.pi_n', gen_random_uuid()::text, true);  -- returned
  perform set_config('test.pi_s', gen_random_uuid()::text, true);  -- submitted
  perform set_config('test.pi_o', gen_random_uuid()::text, true);  -- approved, Order-linked
end $$;

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.opsrev_id')::uuid,   'ASSERT OpsReviewer', 'c-opsrev@example.test',   'member', 'operations', true,  'ASSERT-C0'),
  (current_setting('test.sales_id')::uuid,    'ASSERT Sales',       'c-sales@example.test',    'member', 'sales',      true,  'ASSERT-C1'),
  (current_setting('test.other_id')::uuid,    'ASSERT Other',       'c-other@example.test',    'member', 'sales',      true,  'ASSERT-C2'),
  (current_setting('test.assigned_id')::uuid, 'ASSERT Assigned',    'c-assigned@example.test', 'member', 'sales',      true,  'ASSERT-C3'),
  (current_setting('test.viewer_id')::uuid,   'ASSERT Viewer',      'c-viewer@example.test',   'manager','operations', true,  'ASSERT-C4'),
  (current_setting('test.ops_id')::uuid,      'ASSERT Ops',         'c-ops@example.test',      'member', 'operations', true,  'ASSERT-C5'),
  (current_setting('test.viewall_id')::uuid,  'ASSERT ViewAll',     'c-viewall@example.test',  'member', 'sales',      true,  'ASSERT-C6'),
  (current_setting('test.approver_id')::uuid, 'ASSERT Approver',    'c-approver@example.test', 'manager','sales',      true,  'ASSERT-C7'),
  (current_setting('test.finance_id')::uuid,  'ASSERT Finance',     'c-finance@example.test',  'member', 'purchase',   true,  'ASSERT-C8'),
  (current_setting('test.xadmin_id')::uuid,   'ASSERT ExAdmin',     'c-xadmin@example.test',   'admin',  'management',      false, 'ASSERT-C9')
on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, team = excluded.team,
                               is_active = excluded.is_active, is_deleted = false;
update public.users set role = 'admin', is_active = true, is_deleted = false
 where id = current_setting('test.admin_id')::uuid;
delete from public.order_operations_reviewers where duty = 'pi_handoff';

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select g.uid, mpa.module_id, mpa.action_id, true, current_setting('test.admin_id')::uuid
  from (values
    (current_setting('test.admin_id')::uuid,    'orders',  'approve_order'),
    (current_setting('test.admin_id')::uuid,    'orders',  'can_be_order_assignee'),
    (current_setting('test.opsrev_id')::uuid,   'orders',  'view'),
    (current_setting('test.sales_id')::uuid,    'orders',  'view'),
    (current_setting('test.sales_id')::uuid,    'orders',  'create'),
    (current_setting('test.sales_id')::uuid,    'orders',  'can_be_order_assignee'),
    (current_setting('test.other_id')::uuid,    'orders',  'view'),
    (current_setting('test.other_id')::uuid,    'orders',  'create'),
    (current_setting('test.assigned_id')::uuid, 'orders',  'view'),
    (current_setting('test.viewer_id')::uuid,   'orders',  'view'),
    (current_setting('test.viewer_id')::uuid,   'orders',  'view_pi_commission'),
    (current_setting('test.ops_id')::uuid,      'orders',  'view'),
    (current_setting('test.viewall_id')::uuid,  'orders',  'view'),
    (current_setting('test.viewall_id')::uuid,  'orders',  'view_all'),
    (current_setting('test.approver_id')::uuid, 'orders',  'view'),
    (current_setting('test.approver_id')::uuid, 'orders',  'approve_order'),
    (current_setting('test.finance_id')::uuid,  'orders',  'view'),
    (current_setting('test.finance_id')::uuid,  'finance', 'view'),
    (current_setting('test.finance_id')::uuid,  'finance', 'approve'),
    (current_setting('test.xadmin_id')::uuid,   'orders',  'view')) g(uid, m, a)
  join public.permission_modules pm on pm.module_key = g.m
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
/** Runs p_sql and requires it to fail with a message containing p_code. */
create function pg_temp.expect_error(p_sql text, p_code text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    perform pg_temp.restore();
    if position(p_code in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: % — expected %, got: %', p_what, p_code, sqlerrm;
    end if;
    return;
  end;
  perform pg_temp.restore();
  raise exception 'ASSERT FAILED: % — expected %, but it succeeded', p_what, p_code;
end $$;

/** What p_user reads DIRECTLY, as PostgREST would: the commission row's recipient, or null. */
create function pg_temp.read_commission(p_user uuid, p_pi uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.become(p_user);
  select middleman_recipient into v from public.order_submission_middleman_commissions where submission_id = p_pi;
  perform pg_temp.restore();
  return v;
end $$;
/** Every activity metadata of p_pi that p_user can read, as one text. */
create function pg_temp.read_activity(p_user uuid, p_pi uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.become(p_user);
  select coalesce(string_agg(metadata::text, ' '), '') into v from public.order_submission_activity where submission_id = p_pi;
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.can_read(p_user uuid, p_pi uuid) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.become(p_user);
  v := public.can_read_order_submission_commission(p_pi);
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.save(p_user uuid, p_pi uuid, p_details jsonb, p_confirm boolean) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.save_order_submission_internal_details(p_pi, p_details, null, p_confirm);
  perform pg_temp.restore();
  return v;
end $$;

/** A draft PI with one product line, a stored workbook and image, and a 40% allocated payment. */
create function pg_temp.make_draft(p_id uuid, p_owner uuid, p_total numeric) returns void language plpgsql as $$
declare
  v_item uuid := gen_random_uuid();
  v_wb   text := 'submissions/' || p_id::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha  text := repeat('a', 64);
  v_img  text;
  v_pay  uuid := gen_random_uuid();
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
  values (v_pay, 'ASSERT-COMM', p_total * 0.4, current_date, 'hdfc', 'approved_unlinked', p_owner, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, p_id, p_total * 0.4, 'order_submission', p_owner);
end $$;

/** The commission every fixture carries: a distinctive recipient and amount, so any leak is findable. */
create function pg_temp.commission(p_pi uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'order_confirmation_date', '2026-09-20', 'due_date', '2026-11-20',
    'middleman_commission', 'yes', 'middleman_recipient', 'ASSERT-RCPT-' || left(p_pi::text, 8),
    'middleman_commission_basis', 'amount', 'middleman_commission_amount', '4321.57');
$$;


-- ═══ 0. ONE PI PER STATE, EACH WITH A SAVED, CONFIRMED "YES" ═══════════════

do $$
declare
  s uuid := current_setting('test.sales_id')::uuid;
  pi_ uuid;
begin
  foreach pi_ in array array[current_setting('test.pi_d')::uuid, current_setting('test.pi_n')::uuid,
                             current_setting('test.pi_s')::uuid, current_setting('test.pi_o')::uuid] loop
    perform pg_temp.make_draft(pi_, s, 1000000);
    -- a draft save first, then the confirm: both are logged
    perform pg_temp.save(s, pi_, pg_temp.commission(pi_) - 'middleman_commission_amount' - 'middleman_commission_basis', false);
    perform pg_temp.save(s, pi_, pg_temp.commission(pi_), true);
  end loop;

  -- The assigned PI reviewer. No door writes assigned_to today; the fixture
  -- sets it the way a future assignment would.
  update public.order_submissions set assigned_to = current_setting('test.assigned_id')::uuid
   where id in (current_setting('test.pi_d')::uuid, current_setting('test.pi_n')::uuid,
                current_setting('test.pi_s')::uuid, current_setting('test.pi_o')::uuid);

  -- submitted, returned, and submitted again for the Order
  update public.order_submissions set status = 'submitted', submitted_at = now()
   where id in (current_setting('test.pi_n')::uuid, current_setting('test.pi_s')::uuid, current_setting('test.pi_o')::uuid);
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  perform public.request_order_submission_changes(current_setting('test.pi_n')::uuid, 'ASSERT: please check the dates');
  perform public.set_order_operations_reviewer(current_setting('test.opsrev_id')::uuid);
  perform set_config('test.order_o', (public.approve_order_submission(current_setting('test.pi_o')::uuid, s,
      date '2026-09-20', date '2026-11-20', 'reference') ->> 'order_id'), true);
  perform pg_temp.restore();

  perform pg_temp.check((select status from public.order_submissions where id = current_setting('test.pi_d')::uuid) = 'draft', '0. draft');
  perform pg_temp.check((select status from public.order_submissions where id = current_setting('test.pi_n')::uuid) = 'needs_changes', '0. returned');
  perform pg_temp.check((select status from public.order_submissions where id = current_setting('test.pi_s')::uuid) = 'submitted', '0. submitted');
  perform pg_temp.check((select status = 'approved' and order_id = current_setting('test.order_o')::uuid
                           from public.order_submissions where id = current_setting('test.pi_o')::uuid), '0. approved into an Order');
  perform pg_temp.check((select count(*) from public.order_submission_middleman_commissions
                          where middleman_recipient like 'ASSERT-RCPT-%'
                            and submission_id in (current_setting('test.pi_d')::uuid, current_setting('test.pi_n')::uuid,
                                                  current_setting('test.pi_s')::uuid, current_setting('test.pi_o')::uuid)) = 4,
    '0. four commission rows');
  raise notice 'section 0 (draft, returned, submitted, Order-linked fixtures) ready';
end $$;


-- ═══ 1. EVERY ALLOWED READER, IN EVERY STATE ═══════════════════════════════

do $$
declare
  pi_ uuid;
  u   uuid;
  who text;
begin
  foreach pi_ in array array[current_setting('test.pi_d')::uuid, current_setting('test.pi_n')::uuid,
                             current_setting('test.pi_s')::uuid, current_setting('test.pi_o')::uuid] loop
    for u, who in select * from (values
        (current_setting('test.sales_id')::uuid,    'the salesperson/submitter'),
        (current_setting('test.assigned_id')::uuid, 'the assigned PI reviewer'),
        (current_setting('test.admin_id')::uuid,    'an active admin'),
        (current_setting('test.viewer_id')::uuid,   'a holder of orders.view_pi_commission')) r(u, w) loop
      perform pg_temp.check(pg_temp.read_commission(u, pi_) = 'ASSERT-RCPT-' || left(pi_::text, 8),
        format('1. %s reads the commission of the %s PI', who,
               (select status from public.order_submissions where id = pi_)));
      perform pg_temp.check(pg_temp.can_read(u, pi_), format('1. can_read_order_submission_commission is true for %s', who));
    end loop;
  end loop;
  raise notice 'section 1 (allowed readers, every state) passed';
end $$;


-- ═══ 2. NOBODY ELSE — AND ORDER VIEWERS STILL READ THE PI'S DATES ══════════

do $$
declare
  pi_ uuid;
  u   uuid;
  who text;
  o   uuid := current_setting('test.pi_o')::uuid;
  v   record;
begin
  foreach pi_ in array array[current_setting('test.pi_d')::uuid, current_setting('test.pi_n')::uuid,
                             current_setting('test.pi_s')::uuid, current_setting('test.pi_o')::uuid] loop
    for u, who in select * from (values
        (current_setting('test.other_id')::uuid,    'another salesperson'),
        (current_setting('test.ops_id')::uuid,      'an Operations member who can see the Order'),
        (current_setting('test.opsrev_id')::uuid,   'the Operations handoff reviewer'),
        (current_setting('test.viewall_id')::uuid,  'an orders.view_all holder'),
        (current_setting('test.approver_id')::uuid, 'an orders.approve_order holder'),
        (current_setting('test.finance_id')::uuid,  'a Finance verifier'),
        (current_setting('test.xadmin_id')::uuid,   'an INACTIVE admin')) r(u, w) loop
      perform pg_temp.check(pg_temp.read_commission(u, pi_) is null,
        format('2. %s reads NO commission on the %s PI', who, (select status from public.order_submissions where id = pi_)));
      perform pg_temp.check(not pg_temp.can_read(u, pi_), format('2. can_read_order_submission_commission is false for %s', who));
    end loop;
  end loop;

  -- The wider audiences really are audiences: each of them CAN read the
  -- Order-linked PI row itself (so the refusal above is the commission's
  -- own rule, not a failure to see the PI), and its dates are there.
  for u, who in select * from (values
      (current_setting('test.ops_id')::uuid,      'the Operations member'),
      (current_setting('test.opsrev_id')::uuid,   'the Operations handoff reviewer'),
      (current_setting('test.viewall_id')::uuid,  'the view_all holder'),
      (current_setting('test.approver_id')::uuid, 'the approver'),
      (current_setting('test.finance_id')::uuid,  'the Finance verifier')) r(u, w) loop
    perform pg_temp.become(u);
    select order_confirmation_date, due_date into v from public.order_submissions where id = o;
    perform pg_temp.restore();
    perform pg_temp.check(v.order_confirmation_date = date '2026-09-20' and v.due_date = date '2026-11-20',
      format('2. %s still reads the Order-linked PI''s dates', who));
  end loop;
  perform pg_temp.become(current_setting('test.ops_id')::uuid);
  perform pg_temp.check((select count(*) from public.orders where id = current_setting('test.order_o')::uuid) = 1,
    '2. the Operations member sees the Order');
  perform pg_temp.restore();

  -- anon: no privilege at all.
  perform pg_temp.expect_error(
    'set local role anon; select count(*) from public.order_submission_middleman_commissions',
    'permission denied', '2. anon cannot read the commission table');
  raise notice 'section 2 (non-readers, every state; Order viewers keep the dates) passed';
end $$;


-- ═══ 3. NO COMMISSION VALUE IN ANY ACTIVITY ROW ════════════════════════════

do $$
declare
  pi_ uuid;
  u   uuid;
  t   text;
begin
  foreach pi_ in array array[current_setting('test.pi_d')::uuid, current_setting('test.pi_n')::uuid,
                             current_setting('test.pi_s')::uuid, current_setting('test.pi_o')::uuid] loop
    -- As the table owner: nothing is stored, so nothing can be served.
    select string_agg(metadata::text || coalesce(note, ''), ' ') into t
      from public.order_submission_activity where submission_id = pi_;
    perform pg_temp.check(t not like '%ASSERT-RCPT%' and t not like '%4321.57%' and t not like '%"amount"%'
                          and t not like '%middleman_recipient%' and t not like '%middleman_commission_amount%',
      '3. no commission value or field is stored in the activity of ' || pi_);
    perform pg_temp.check(exists (select 1 from public.order_submission_activity
                                   where submission_id = pi_ and action = 'internal_details_updated'
                                     and (metadata ->> 'commission_changed')::boolean),
      '3. a commission change is logged as a flag');
    -- And as the viewers who DO get the trail, directly.
    foreach u in array array[current_setting('test.ops_id')::uuid, current_setting('test.viewall_id')::uuid,
                             current_setting('test.approver_id')::uuid, current_setting('test.finance_id')::uuid,
                             current_setting('test.sales_id')::uuid] loop
      t := pg_temp.read_activity(u, pi_);
      perform pg_temp.check(t not like '%ASSERT-RCPT%' and t not like '%4321.57%',
        '3. the activity served to ' || u || ' carries no commission value');
    end loop;
  end loop;
  -- The Operations member really does get the trail of the Order-linked PI.
  perform pg_temp.check(pg_temp.read_activity(current_setting('test.ops_id')::uuid, current_setting('test.pi_o')::uuid)
                        like '%commission_changed%', '3. the Operations member reads the Order-linked PI''s trail');
  raise notice 'section 3 (no commission value in activity) passed';
end $$;


-- ═══ 4. WRITES ═════════════════════════════════════════════════════════════

do $$
declare
  d uuid := current_setting('test.pi_d')::uuid;
  n uuid := current_setting('test.pi_n')::uuid;
  s uuid := current_setting('test.sales_id')::uuid;
  a uuid := current_setting('test.admin_id')::uuid;
  u uuid;
begin
  -- No direct write, by anybody signed in — the salesperson and an admin included.
  foreach u in array array[s, a] loop
    perform pg_temp.expect_error(format(
      'select pg_temp.become(%L); insert into public.order_submission_middleman_commissions (submission_id, middleman_commission) values (%L, ''no'')',
      u, gen_random_uuid()), 'permission denied', '4. direct INSERT');
    perform pg_temp.expect_error(format(
      'select pg_temp.become(%L); update public.order_submission_middleman_commissions set middleman_recipient = ''X'' where submission_id = %L',
      u, d), 'permission denied', '4. direct UPDATE');
    perform pg_temp.expect_error(format(
      'select pg_temp.become(%L); delete from public.order_submission_middleman_commissions where submission_id = %L',
      u, d), 'permission denied', '4. direct DELETE');
  end loop;

  -- The editor after submission, and after approval into an Order — owner and admin.
  foreach u in array array[s, a] loop
    perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', u, current_setting('test.pi_s'),
      '{"middleman_commission":"no"}'), 'ORDER_SUBMISSION_NOT_EDITABLE', '4. editing a submitted PI');
    perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', u, current_setting('test.pi_o'),
      '{"middleman_commission":"no"}'), 'ORDER_SUBMISSION_NOT_EDITABLE', '4. editing an approved, Order-linked PI');
  end loop;
  -- Readers who are not editors.
  foreach u in array array[current_setting('test.assigned_id')::uuid, current_setting('test.viewer_id')::uuid,
                           current_setting('test.approver_id')::uuid, current_setting('test.other_id')::uuid,
                           current_setting('test.xadmin_id')::uuid] loop
    perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', u, d, '{"middleman_commission":"no"}'),
      'ORDER_SUBMISSION_NOT_EDITABLE', '4. a non-editor saving a draft');
  end loop;
  -- Nothing moved.
  perform pg_temp.check((select count(*) from public.order_submission_middleman_commissions
                          where submission_id in (d, current_setting('test.pi_s')::uuid, current_setting('test.pi_o')::uuid)
                            and middleman_commission = 'yes') = 3, '4. refused saves wrote nothing');

  -- A returned PI is editable by its salesperson, and an admin may edit a draft.
  perform pg_temp.save(s, n, pg_temp.commission(n) || '{"middleman_commission_amount":"4000"}', false);
  perform pg_temp.check((select middleman_commission_amount from public.order_submission_middleman_commissions
                          where submission_id = n) = 4000, '4. the salesperson edits a returned PI');
  perform pg_temp.save(a, d, pg_temp.commission(d), true);
  perform pg_temp.check((select internal_details_confirmed_by from public.order_submissions where id = d) = a,
    '4. an active admin confirms a draft and is recorded as the confirmer');
  raise notice 'section 4 (writes) passed';
end $$;


-- ═══ 5. A DRAFT SAVE THAT CHANGES THE COMMISSION CLEARS THE CONFIRMATION ═══

do $$
declare
  d uuid := current_setting('test.pi_d')::uuid;
  s uuid := current_setting('test.sales_id')::uuid;
  r jsonb;
  m jsonb;
  before uuid[];
begin
  perform pg_temp.check((select internal_details_confirmed_at is not null from public.order_submissions where id = d),
    '5. confirmed before');
  -- One transaction: every row shares now(), so the new entry is found by
  -- elimination rather than by time.
  before := array(select id from public.order_submission_activity where submission_id = d);
  r := pg_temp.save(s, d, pg_temp.commission(d) || '{"middleman_commission_amount":"5000"}', false);
  perform pg_temp.check((r ->> 'changed')::boolean and not (r ->> 'confirmed')::boolean, '5. the RPC reports changed, not confirmed');
  perform pg_temp.check((select internal_details_confirmed_at is null and internal_details_confirmed_by is null
                           from public.order_submissions where id = d), '5. a commission-only draft save clears the confirmation');
  perform pg_temp.check((select count(*) from public.order_submission_activity
                          where submission_id = d and not (id = any (before))) = 1, '5. the save wrote exactly one entry');
  select metadata into m from public.order_submission_activity
   where submission_id = d and not (id = any (before));
  perform pg_temp.check(m -> 'changed' = '{}'::jsonb and (m ->> 'commission_changed')::boolean and (m ->> 'fields')::int = 1,
    '5. the entry is a flag, with no dates changed and no value');
  -- An unchanged draft save writes nothing.
  r := pg_temp.save(s, d, pg_temp.commission(d) || '{"middleman_commission_amount":"5000"}', false);
  perform pg_temp.check(not (r ->> 'changed')::boolean, '5. an unchanged save changes nothing');
  -- The readiness check reads the commission table.
  perform pg_temp.check(public.order_submission_internal_details_problem(d) = 'confirm the internal details',
    '5. the readiness check sees a complete but unconfirmed answer');
  raise notice 'section 5 (confirmation clearing) passed';
end $$;

do $$ begin raise notice 'ALL COMMISSION ACCESS ASSERTIONS PASSED'; end $$;

rollback;
