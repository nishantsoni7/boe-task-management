-- THE ADVANCE IS 40% OF THE TOTAL BEFORE GST (20270226000000)
-- ===========================================================================
-- The rule: Advance % = VERIFIED advance / Total before GST x 100, and the
-- required 40% advance is 40% of the Total before GST (not of the Grand Total).
--
--   Total before GST 1,20,000 + GST 21,600 = Grand Total 1,41,600.
--   Verified 48,000 -> exactly 40.00%, required 48,000, shortfall 0, ready.
--   (Against the Grand Total the requirement was 56,640.)
--
-- Through the real doors, on a disposable stack:
--
--   1. the pure helpers   exact example; 47,999.99 -> 0.01 short; rounding;
--                         NULL / 0 / NaN / negative base: NULL, never ready
--   2. a PI at 48,000     summary, submission route and conversion; the Order
--                         position, order_total_before_gst and the JSON keys
--   3. 47,999.99          below by exactly one paisa; pending / needs
--                         clarification / rejected money does not count
--   4. between 40% of the pre-GST total and 40% of the Grand Total: standard now
--   5. no usable base     NULL / 0 / NaN pre-GST total: incomplete, refused at
--                         submission, exception decision and conversion; never
--                         ready, not even under an approved exception
--   6. transportation     "as applicable" adds nothing: the stored total is the
--                         base; a quoted amount is already inside it
--   7. an Order           derive-on-read: V1 PI, a revised version, a hand
--                         amendment (no base: NULL and blocked until an admin
--                         approves or a revised PI re-prices it); the dashboard
--   8. the declared amount the door classifies on the pre-GST base; the table
--                         constraint is the looser one; the trigger follows
--                         both totals
--   9. decisions          an exception decided against figures that then move is
--                         stale; permissions are unchanged
--
-- Runs inside ONE transaction that ends in ROLLBACK.
-- SELF-CONTAINED FIXTURES: creates its own people (a1b0…), its own operations
-- reviewer, and depends on nobody else's seed. Needs the migration chain
-- through 20270226000000.
-- On success prints NOTICE 'ALL ADVANCE-ON-TOTAL-BEFORE-GST ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

-- ═══ 0. PEOPLE, HELPERS ═════════════════════════════════════════════════════

do $$
begin
  perform set_config('test.admin_id',  'a1b00000-0000-4000-8000-000000000001', true);
  perform set_config('test.admin2_id', 'a1b00000-0000-4000-8000-000000000002', true);
  perform set_config('test.sales_id',  'a1b00000-0000-4000-8000-000000000003', true);
  perform set_config('test.ops_id',    'a1b00000-0000-4000-8000-000000000004', true);
  perform set_config('test.fin_id',    'a1b00000-0000-4000-8000-000000000005', true);
  perform set_config('test.out_id',    'a1b00000-0000-4000-8000-000000000006', true);

  insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
    ('a1b00000-0000-4000-8000-000000000001', 'ASSERT Base Admin',    'base-admin@suite.test',  'admin',  'management', true, 'BASE-ADM'),
    ('a1b00000-0000-4000-8000-000000000002', 'ASSERT Base Admin 2',  'base-admin2@suite.test', 'admin',  'management', true, 'BASE-AD2'),
    ('a1b00000-0000-4000-8000-000000000003', 'ASSERT Base Sales',    'base-sales@suite.test',  'member', 'sales',      true, 'BASE-SAL'),
    ('a1b00000-0000-4000-8000-000000000004', 'ASSERT Base Ops',      'base-ops@suite.test',    'member', 'operations', true, 'BASE-OPS'),
    ('a1b00000-0000-4000-8000-000000000005', 'ASSERT Base Finance',  'base-fin@suite.test',    'member', 'management', true, 'BASE-FIN'),
    ('a1b00000-0000-4000-8000-000000000006', 'ASSERT Base Outsider', 'base-out@suite.test',    'member', 'design',     true, 'BASE-OUT')
  on conflict (id) do update set role = excluded.role, is_active = true, full_name = excluded.full_name;

  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  select g.uid, mpa.module_id, mpa.action_id, true, 'a1b00000-0000-4000-8000-000000000001'::uuid
    from (values ('a1b00000-0000-4000-8000-000000000001'::uuid, 'orders',  'approve_order'),
                 ('a1b00000-0000-4000-8000-000000000001'::uuid, 'orders',  'approve_advance_exception'),
                 ('a1b00000-0000-4000-8000-000000000001'::uuid, 'orders',  'can_be_order_assignee'),
                 ('a1b00000-0000-4000-8000-000000000002'::uuid, 'orders',  'approve_order'),
                 ('a1b00000-0000-4000-8000-000000000003'::uuid, 'orders',  'can_be_order_assignee'),
                 ('a1b00000-0000-4000-8000-000000000003'::uuid, 'orders',  'view'),
                 ('a1b00000-0000-4000-8000-000000000003'::uuid, 'orders',  'create'),
                 ('a1b00000-0000-4000-8000-000000000004'::uuid, 'orders',  'view'),
                 ('a1b00000-0000-4000-8000-000000000004'::uuid, 'orders',  'align_production'),
                 ('a1b00000-0000-4000-8000-000000000005'::uuid, 'finance', 'view'),
                 ('a1b00000-0000-4000-8000-000000000005'::uuid, 'finance', 'approve'),
                 ('a1b00000-0000-4000-8000-000000000005'::uuid, 'finance', 'allocate_correct')) g(uid, m, a)
    join public.permission_modules pm on pm.module_key = g.m
    join public.permission_actions pa on pa.action_key = g.a
    join public.module_permission_actions mpa on mpa.module_id = pm.id and mpa.action_id = pa.id
  on conflict do nothing;

  -- Orders created below are real Orders, not test data (the stamp is taken from this phase at insert).
  update public.test_data_cleanup_settings set enabled = false where id;

  delete from public.order_operations_reviewers where duty = 'pi_handoff';
  insert into public.order_operations_reviewers (duty, user_id, assigned_by)
  values ('pi_handoff', 'a1b00000-0000-4000-8000-000000000004', 'a1b00000-0000-4000-8000-000000000001');
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
-- Runs p_sql as p_user (or as the owner when null); 'OK' or the error text.
create function pg_temp.try_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_user is not null then perform pg_temp.become(p_user); end if;
  begin
    execute p_sql;
    v := 'OK';
  exception when others then get stacked diagnostics v = message_text;
  end;
  perform pg_temp.restore();
  return v;
end $$;
-- A scalar as p_user (or the owner): the text of the result, or 'ERR: ' || message.
create function pg_temp.val_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_user is not null then perform pg_temp.become(p_user); end if;
  begin
    execute p_sql into v;
  exception when others then get stacked diagnostics v = message_text; v := 'ERR: ' || v;
  end;
  perform pg_temp.restore();
  return v;
end $$;
-- As the app does, the salesperson confirms the PI's internal details.
create function pg_temp.internal_details(p_sub uuid) returns void language plpgsql as $$
begin
  if pg_temp.try_as(current_setting('test.sales_id')::uuid, format(
       'select public.save_order_submission_internal_details(%L, %L::jsonb, null, true)', p_sub,
       jsonb_build_object('order_confirmation_date', current_date, 'due_date', current_date + 30, 'middleman_commission', 'no'))) <> 'OK' then
    raise exception 'fixture: internal details could not be saved for %', p_sub;
  end if;
end $$;

-- A draft PI with its workbook, one line and one picture, priced as the
-- workbook prices it: total before GST p_tbg (NULL = the cell held words),
-- Grand Total p_grand. Not submitted.
create function pg_temp.new_pi(p_client text, p_tbg numeric, p_grand numeric) returns uuid language plpgsql as $$
declare
  v_sub   uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_wb    text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_gross numeric := coalesce(p_tbg, p_grand);
begin
  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', v_sales, v_sales, '[]', '[]');
  update public.order_submissions
     set client_name = p_client, gross_product_amount = v_gross, discount_amount = 0, subtotal_after_discount = v_gross,
         total_before_gst = p_tbg, gst_amount = case when p_tbg is not null then p_grand - p_tbg end, grand_total = p_grand,
         source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64)
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_sub, 32, 'B001', p_client || ' chair', 10, v_gross / 10, v_gross, 0);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select v_sub, i.id, 'representative', 0,
         'submissions/' || v_sub || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png', 'image/png', repeat('c', 64), i.source_row
    from public.order_submission_items i where i.submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', m.storage_path, jsonb_build_object('mimetype', 'image/png') from public.order_submission_item_images m where m.submission_id = v_sub;
  perform pg_temp.internal_details(v_sub);
  return v_sub;
end $$;

-- Money against a PI in the given Finance state; returns the payment request.
create function pg_temp.pay_pi(p_sub uuid, p_amount numeric, p_status text default 'approved_unlinked') returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v, 'ASSERT base', p_amount, current_date, 'hdfc', p_status, current_setting('test.sales_id')::uuid, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v, p_sub, p_amount, 'order_submission', current_setting('test.sales_id')::uuid);
  return v;
end $$;
-- Money against an Order.
create function pg_temp.pay_order(p_order uuid, p_amount numeric, p_status text default 'approved_unlinked') returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v, 'ASSERT base', p_amount, current_date, 'hdfc', p_status, current_setting('test.sales_id')::uuid, null);
  insert into public.finance_payment_allocations (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
  values (v, p_order, p_amount, 'confirmed_order', current_setting('test.sales_id')::uuid);
  return v;
end $$;

-- The salesperson submits it (optionally with an exception reason): 'OK' or the refusal.
create function pg_temp.submit(p_sub uuid, p_reason text default null) returns text language plpgsql as $$
begin
  return pg_temp.try_as(current_setting('test.sales_id')::uuid,
    format('select public.submit_pi_for_review(%L, null, %L, null, null)', p_sub, p_reason));
end $$;
-- The admin approves the PI's own decision if still needed and converts it: 'OK' or the refusal.
create function pg_temp.convert(p_sub uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  begin
    if (select pi_approved_at from public.order_submissions where id = p_sub) is null then
      perform public.approve_pi_review(p_sub);
    end if;
    perform public.approve_order_submission(p_sub, current_setting('test.sales_id')::uuid, current_date, current_date + 30, 'reference');
    v := 'OK';
  exception when others then get stacked diagnostics v = message_text;
  end;
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.order_of(p_sub uuid) returns uuid language sql as $$
  select order_id from public.order_submissions where id = p_sub
$$;
create function pg_temp.summary(p_sub uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  v := public.pi_submission_payment_summary(p_sub);
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.alignment_of(p_order uuid) returns text language sql as $$
  select production_alignment from public.orders where id = p_order
$$;
create function pg_temp.position(p_order uuid) returns jsonb language sql as $$
  select public.order_advance_position(p_order)
$$;
create function pg_temp.ops_decide(p_order uuid, p_decision text, p_reason text default null) returns text language plpgsql as $$
declare h uuid;
begin
  select id into h from public.order_operations_handoffs where order_id = p_order and superseded_at is null;
  return pg_temp.try_as(current_setting('test.ops_id')::uuid,
    format('select public.decide_order_operations_handoff(%L, %L, %L)', h, p_decision, p_reason));
end $$;
create function pg_temp.approve_exception(p_order uuid) returns text language plpgsql as $$
begin
  return pg_temp.try_as(current_setting('test.admin_id')::uuid,
    format('select public.approve_order_advance_exception(%L, %L)', p_order, 'ASSERT long-standing client, balance on delivery'));
end $$;
-- A converted Order: PI priced p_tbg + GST = p_grand, p_paid verified money, converted through the real doors.
create function pg_temp.fresh_order(p_client text, p_tbg numeric, p_grand numeric, p_paid numeric) returns uuid language plpgsql as $$
declare v_sub uuid; v_msg text;
begin
  v_sub := pg_temp.new_pi(p_client, p_tbg, p_grand);
  if p_paid > 0 then perform pg_temp.pay_pi(v_sub, p_paid); end if;
  -- Below 40% of the pre-GST total the PI goes the exception route, and an administrator approves it.
  v_msg := pg_temp.submit(v_sub, case when p_paid < 0.4 * p_tbg then 'Against client PO' end);
  if v_msg <> 'OK' then raise exception 'fixture: submit: %', v_msg; end if;
  if p_paid < 0.4 * p_tbg then
    v_msg := pg_temp.try_as(current_setting('test.admin_id')::uuid, format('select public.approve_pi_advance_exception(%L)', v_sub));
    if v_msg <> 'OK' then raise exception 'fixture: exception: %', v_msg; end if;
  end if;
  v_msg := pg_temp.convert(v_sub);
  if v_msg <> 'OK' then raise exception 'fixture: convert: %', v_msg; end if;
  return pg_temp.order_of(v_sub);
end $$;
-- A revision through the real doors with its own pre-GST total (propose, then an admin approves).
create function pg_temp.revise(p_order uuid, p_tbg numeric, p_grand numeric, p_reason text) returns void language plpgsql as $$
declare v_sub uuid; v_item uuid; s public.order_submissions%rowtype; o public.orders%rowtype; v_ver uuid; v_prop jsonb;
begin
  select * into o from public.orders where id = p_order;
  select * into s from public.order_submissions where id = o.source_order_submission_id;
  select id into v_item from public.order_submission_items where submission_id = s.id;
  v_prop := jsonb_build_object(
    'payload', jsonb_build_object(
      'header', jsonb_build_object('client_name', o.client_name, 'order_confirmation_date', o.confirm_date,
                                   'due_date', o.due_date, 'creation_date', s.creation_date),
      'commercial', jsonb_build_object('gross_product_amount', p_tbg, 'discount_amount', 0,
                                       'total_before_gst', p_tbg, 'gst_amount', p_grand - p_tbg, 'grand_total', p_grand),
      'source', jsonb_build_object('workbook_path', s.source_workbook_path, 'workbook_sha256', s.source_workbook_sha256),
      'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
      'items', jsonb_build_array(jsonb_build_object('id', v_item, 'source_row', 32, 'item_sequence', 'B001',
                 'product_name', 'ASSERT base chair', 'quantity', 10, 'cost_per_piece', p_tbg / 10,
                 'total_amount', p_tbg, 'sort_order', 0)),
      'item_images', coalesce((select jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'submission_id')
                                 from public.order_submission_item_images m where m.submission_id = s.id), '[]'::jsonb),
      'seed_terms', jsonb_build_object('fabric_responsibility', 'client'),
      'fingerprint', encode(sha256(convert_to(p_grand::text || clock_timestamp()::text, 'UTF8')), 'hex')),
    'terms', jsonb_build_object('fabric_responsibility', 'client'),
    'change_summary', jsonb_build_array('ASSERT base revise'));
  v_ver := (public.propose_order_pi_edit_revision(p_order, current_setting('test.sales_id')::uuid, v_prop, p_reason) ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  perform public.approve_order_pi_revision(v_ver, current_setting('test.admin_id')::uuid,
    (select proposal -> 'payload' from public.order_pi_versions where id = v_ver));
end $$;


-- ═══ 1. THE PURE HELPERS ════════════════════════════════════════════════════

do $$
begin
  -- The worked example: total before GST 1,20,000 (GST 21,600, Grand Total 1,41,600).
  assert public.order_submission_required_payment(120000) = 48000, '1. required is 40% of the pre-GST total';
  assert public.order_submission_payment_shortfall(120000, 48000) = 0, '1. 48,000 verified: nothing short';
  assert public.order_submission_payment_ready(120000, 48000, null), '1. and ready';
  assert public.order_submission_advance_percent_of(120000, 48000) = 40.00, '1. exactly 40.00%';
  assert public.order_submission_standard_advance_amount(120000) = 48000, '1. the standard amount is 48,000';
  assert public.order_submission_advance_amount(120000, 30) = 36000, '1. 30% of the pre-GST total';

  -- One paisa below.
  assert public.order_submission_payment_shortfall(120000, 47999.99) = 0.01, '1. 47,999.99: 0.01 short';
  assert not public.order_submission_payment_ready(120000, 47999.99, null), '1. and not ready';
  assert public.order_submission_advance_percent_of(120000, 47999.99) = 39.99, '1. 39.99% (truncated, never rounded up to 40)';

  -- The distinction: 48,000 satisfied nothing against the Grand Total (56,640).
  assert public.order_submission_required_payment(141600) = 56640, '1. the same helper on the Grand Total would ask for 56,640';
  assert not public.order_submission_payment_ready(141600, 48000, null), '1. so a caller passing the Grand Total is the old rule';

  -- The paisa rounding rules are unchanged: required exact, shortfall up, suggestion up.
  assert public.order_submission_required_payment(100.01) = 40.004, '1. required is exact';
  assert public.order_submission_payment_shortfall(100.01, 40.00) = 0.01, '1. the shortfall rounds UP to the paisa';
  assert public.order_submission_payment_shortfall(100.01, 40.01) = 0, '1. and 40.01 meets it';
  assert public.order_submission_standard_advance_amount(100.01) = 40.01, '1. the suggested amount rounds UP to the paisa';

  -- A base that is missing is explicit, and never satisfies anything.
  assert public.order_submission_required_payment(null) is null and public.order_submission_required_payment(0) is null
     and public.order_submission_required_payment(-1) is null and public.order_submission_required_payment('NaN'::numeric) is null,
    '1. required: NULL, 0, negative and NaN bases answer NULL';
  assert public.order_submission_payment_shortfall(null, 5) is null and public.order_submission_payment_shortfall(0, 5) is null
     and public.order_submission_payment_shortfall(-5, 5) is null and public.order_submission_payment_shortfall('NaN'::numeric, 5) is null
     and public.order_submission_payment_shortfall(100, null) is null and public.order_submission_payment_shortfall(100, 'NaN'::numeric) is null,
    '1. shortfall: unusable base or verified figure answers NULL, never 0 (0 would read as "nothing short")';
  assert public.order_submission_advance_percent_of(null, 5) is null and public.order_submission_advance_percent_of(0, 5) is null
     and public.order_submission_advance_percent_of(-1, 5) is null and public.order_submission_advance_percent_of('NaN'::numeric, 5) is null,
    '1. percent: NULL, never 0/0, NaN or Infinity';
  assert public.order_submission_standard_advance_amount(null) is null and public.order_submission_standard_advance_amount(0) is null
     and public.order_submission_standard_advance_amount(-1) is null and public.order_submission_standard_advance_amount('NaN'::numeric) is null,
    '1. the standard amount is NULL for an unusable base';
  assert public.order_submission_advance_amount(0, 10) is null and public.order_submission_advance_amount(null, 10) is null,
    '1. and so is the amount of a percentage';
  assert public.order_submission_payment_ready(null, 999999, null) is false and public.order_submission_payment_ready(0, 999999, null) is false
     and public.order_submission_payment_ready(-1, 999999, null) is false and public.order_submission_payment_ready('NaN'::numeric, 999999, null) is false,
    '1. payment_ready is FALSE (not NULL) for an unusable base however much is paid';
  assert public.order_submission_payment_ready(null, 999999, 'approved') is false and public.order_submission_payment_ready(0, 0, 'approved') is false,
    '1. not even an approved exception makes a missing base ready';
  assert public.order_submission_payment_ready(100, null, null) is false and public.order_submission_payment_ready(100, null, 'approved') is true,
    '1. a NULL verified figure is not ready; an approved exception on a real base still is';
  assert public.order_submission_payment_ready(100, 40, 'pending') is true and public.order_submission_payment_ready(100, 39.99, 'pending') is false
     and public.order_submission_payment_ready(100, 39.99, 'rejected') is false and public.order_submission_payment_ready(100, 39.99, null) is false,
    '1. a pending / rejected / absent exception adds nothing';
  raise notice '1. the helpers: 40%% of the pre-GST total, rounding as before, a missing base is NULL and never ready OK';
end $$;


-- ═══ 2. THE WORKED EXAMPLE, THROUGH THE REAL DOORS ═══════════════════════════

do $$
declare
  v_sub uuid; v_msg text; v_s jsonb; o uuid; v_pos jsonb; v_hist jsonb;
begin
  v_sub := pg_temp.new_pi('ASSERT ex 2', 120000, 141600);
  perform pg_temp.pay_pi(v_sub, 48000);

  v_s := pg_temp.summary(v_sub);
  assert (v_s ->> 'required_payment')::numeric = 48000 and (v_s ->> 'needed_for_standard')::numeric = 0
     and (v_s ->> 'verified_percent')::numeric = 40.00 and (v_s ->> 'verified_amount')::numeric = 48000
     and (v_s ->> 'meets_standard')::boolean and (v_s ->> 'order_gate_cleared')::boolean
     and v_s ->> 'approval_position' = 'standard_met',
    '2. the summary: required 48,000, 40.00%, nothing needed, gate cleared: ' || v_s::text;
  assert (v_s ->> 'advance_base')::numeric = 120000 and (v_s ->> 'total_before_gst')::numeric = 120000
     and (v_s ->> 'grand_total')::numeric = 141600 and not (v_s ->> 'advance_base_missing')::boolean,
    '2. the summary names the base beside the Grand Total: ' || v_s::text;
  assert (v_s ->> 'pending_balance')::numeric = 93600, '2. the balance still owed is of the Grand Total (141600 - 48000)';

  -- 48,000 is below 40% of the Grand Total: the route is standard only on the new rule.
  assert 48000 < 141600 * 0.4, '2. (48,000 is below 56,640)';
  v_msg := pg_temp.submit(v_sub);
  assert v_msg = 'OK', '2. submitted with no exception reason, because 48,000 meets 40% of the pre-GST total: ' || v_msg;
  assert (select advance_condition from public.order_submissions where id = v_sub) = 'standard'
     and (select advance_exception_status from public.order_submissions where id = v_sub) is null, '2. the standard route';
  select metadata into v_hist from public.order_submission_activity where submission_id = v_sub and action = 'submitted' order by created_at desc limit 1;
  assert (v_hist ->> 'required_payment')::numeric = 48000 and (v_hist ->> 'advance_base')::numeric = 120000
     and (v_hist ->> 'grand_total')::numeric = 141600 and (v_hist ->> 'total_before_gst')::numeric = 120000,
    '2. the submission is logged with the base: ' || coalesce(v_hist::text, 'none');

  v_msg := pg_temp.convert(v_sub);
  assert v_msg = 'OK', '2. approved and converted at exactly 40.00% of the pre-GST total: ' || v_msg;
  o := pg_temp.order_of(v_sub);
  assert (select total_value from public.orders where id = o) = 141600, '2. the Order carries the Grand Total';
  select metadata into v_hist from public.order_submission_activity where submission_id = v_sub and action = 'approved' order by created_at desc limit 1;
  assert (v_hist ->> 'required_payment')::numeric = 48000 and (v_hist ->> 'advance_base')::numeric = 120000
     and (v_hist ->> 'grand_total')::numeric = 141600, '2. the approval is logged with the base: ' || coalesce(v_hist::text, 'none');

  v_pos := pg_temp.position(o);
  assert (v_pos ->> 'order_value')::numeric = 141600 and (v_pos ->> 'advance_base')::numeric = 120000
     and (v_pos ->> 'verified')::numeric = 48000 and (v_pos ->> 'required')::numeric = 48000
     and (v_pos ->> 'shortfall')::numeric = 0 and (v_pos ->> 'percent')::numeric = 40.00
     and (v_pos ->> 'threshold_percent')::numeric = 40
     and (v_pos ->> 'value_known')::boolean and (v_pos ->> 'order_value_known')::boolean
     and not (v_pos ->> 'below')::boolean and (v_pos ->> 'ready')::boolean,
    '2. the Order position: 40.00% of 1,20,000, required 48,000, ready: ' || v_pos::text;

  -- The scalar for a signed-in reader (a PostgREST computed column).
  assert pg_temp.val_as(current_setting('test.admin_id')::uuid,
           format('select o.order_total_before_gst from public.orders o where o.id = %L', o)) = '120000.00',
    '2. order_total_before_gst, as a computed column, for a reader of the Order: ' ||
      pg_temp.val_as(current_setting('test.admin_id')::uuid, format('select o.order_total_before_gst from public.orders o where o.id = %L', o));
  assert pg_temp.val_as(current_setting('test.admin_id')::uuid,
           format('select public.order_total_before_gst(o) from public.orders o where o.id = %L', o)) = '120000.00',
    '2. and as a function call';
  assert pg_temp.val_as(current_setting('test.out_id')::uuid,
           format('select public.order_total_before_gst(o) from public.orders o where o.id = %L', o)) is null,
    '2. nothing for somebody who cannot read the Order (a made-up row cannot read another Order''s figure either)';
  assert pg_temp.val_as(current_setting('test.out_id')::uuid,
           format('select public.order_total_before_gst(jsonb_populate_record(null::public.orders, jsonb_build_object(''id'', %L)))', o)) is null,
    '2. a row built by hand answers nothing';
  assert not has_function_privilege('anon', 'public.order_total_before_gst(public.orders)', 'execute')
     and has_function_privilege('authenticated', 'public.order_total_before_gst(public.orders)', 'execute')
     and not has_function_privilege('authenticated', 'public.order_advance_base(uuid)', 'execute'),
    '2. EXECUTE: authenticated only on the reader; the internal base is for definers alone';
  raise notice '2. 1,20,000 + GST = 1,41,600 with 48,000 verified: exactly 40.00%%, required 48,000, shortfall 0, ready, converted OK';
end $$;


-- ═══ 3. ONE PAISA BELOW, AND MONEY THAT DOES NOT COUNT ═══════════════════════

do $$
declare
  v_sub uuid; v_msg text; v_s jsonb; o uuid; p uuid;
begin
  v_sub := pg_temp.new_pi('ASSERT ex 3', 120000, 141600);
  perform pg_temp.pay_pi(v_sub, 47999.99);
  v_s := pg_temp.summary(v_sub);
  assert (v_s ->> 'needed_for_standard')::numeric = 0.01 and (v_s ->> 'verified_percent')::numeric = 39.99
     and not (v_s ->> 'meets_standard')::boolean and not (v_s ->> 'order_gate_cleared')::boolean
     and v_s ->> 'approval_position' = 'payment_required',
    '3. 47,999.99 verified: 0.01 short, 39.99%, not cleared: ' || v_s::text;

  -- Money Finance has not verified counts for nothing: pending, needs clarification, rejected.
  perform pg_temp.pay_pi(v_sub, 10000, 'pending_approval');
  perform pg_temp.pay_pi(v_sub, 10000, 'needs_clarification');
  perform pg_temp.pay_pi(v_sub, 10000, 'rejected');
  v_s := pg_temp.summary(v_sub);
  assert (v_s ->> 'verified_amount')::numeric = 47999.99 and (v_s ->> 'unverified_amount')::numeric = 20000
     and (v_s ->> 'attached_amount')::numeric = 67999.99
     and (v_s ->> 'needed_for_standard')::numeric = 0.01 and not (v_s ->> 'meets_standard')::boolean
     and (v_s ->> 'attached_meets_standard')::boolean and (v_s ->> 'needed_attached_for_submission')::numeric = 0,
    '3. pending and needs-clarification money is attached, not verified; rejected money is neither: ' || v_s::text;
  assert v_s ->> 'approval_position' = 'verification_pending', '3. and the position says so';

  -- Attached money is enough to SUBMIT (it is a reason for Finance to look), never to convert.
  v_msg := pg_temp.submit(v_sub);
  assert v_msg = 'OK', '3. it can be submitted (attached 67,999.99 is over 48,000): ' || v_msg;
  v_msg := pg_temp.convert(v_sub);
  assert v_msg like 'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION:%0.01 more verified payment%',
    '3. but not converted: 0.01 more verified payment is required: ' || v_msg;
  assert pg_temp.order_of(v_sub) is null, '3. no Order was created';

  -- A verified paisa later, it converts.
  perform pg_temp.pay_pi(v_sub, 0.01);
  update public.finance_payment_requests set status = 'approved_unlinked' where id in (
    select payment_request_id from public.finance_payment_allocations where order_submission_id = v_sub and allocated_amount in (10000));
  v_msg := pg_temp.convert(v_sub);
  assert v_msg = 'OK', '3. with 48,000.00 verified (and nothing left awaiting) it converts: ' || v_msg;
  assert (pg_temp.position(pg_temp.order_of(v_sub)) ->> 'percent')::numeric > 40, '3. and the Order is over 40% of the pre-GST total';

  -- Not enough, no exception: the plain refusal says how much more.
  v_sub := pg_temp.new_pi('ASSERT ex 3b', 120000, 141600);
  perform pg_temp.pay_pi(v_sub, 47999.99);
  v_msg := pg_temp.submit(v_sub);
  assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED:%', '3. below 40% of the pre-GST total a reason is required: ' || v_msg;
  v_msg := pg_temp.submit(v_sub, 'Against client PO');
  assert v_msg = 'OK', '3. with a reason it is submitted as a pending exception: ' || v_msg;
  assert (select advance_condition from public.order_submissions where id = v_sub) = 'exception'
     and (select advance_exception_status from public.order_submissions where id = v_sub) = 'pending'
     and (select advance_exception_percent from public.order_submissions where id = v_sub) = 39.99,
    '3. the snapshot is the verified payment as a percentage of the pre-GST total (39.99, strictly below 40)';
  v_msg := pg_temp.convert(v_sub);
  assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_PENDING:%', '3. a pending exception does not convert: ' || v_msg;
  raise notice '3. 47,999.99 verified: 0.01 short; pending / needs clarification / rejected money counts for nothing OK';
end $$;


-- ═══ 4. BETWEEN 40% OF THE PRE-GST TOTAL AND 40% OF THE GRAND TOTAL ═══════════

do $$
declare v_sub uuid; v_msg text; o uuid; v_pos jsonb;
begin
  -- 50,000 is 41.66% of 1,20,000 and 35.31% of 1,41,600: above the line now, below it before.
  v_sub := pg_temp.new_pi('ASSERT ex 4', 120000, 141600);
  perform pg_temp.pay_pi(v_sub, 50000);
  assert pg_temp.submit(v_sub) = 'OK', '4. standard route, no reason';
  assert (select advance_condition from public.order_submissions where id = v_sub) = 'standard', '4. declared standard';
  assert pg_temp.convert(v_sub) = 'OK', '4. converts';
  v_pos := pg_temp.position(pg_temp.order_of(v_sub));
  assert (v_pos ->> 'percent')::numeric = 41.66 and (v_pos ->> 'shortfall')::numeric = 0 and (v_pos ->> 'ready')::boolean,
    '4. and the Order reads 41.66%, ready: ' || v_pos::text;
  -- Above 40% of the Grand Total as well: the same route.
  v_sub := pg_temp.new_pi('ASSERT ex 4b', 120000, 141600);
  perform pg_temp.pay_pi(v_sub, 56640);
  assert pg_temp.submit(v_sub) = 'OK' and pg_temp.convert(v_sub) = 'OK', '4. 56,640 (40% of the Grand Total) is plenty';
  raise notice '4. 41.66%% of the pre-GST total is standard now (it was an exception against the Grand Total) OK';
end $$;


-- ═══ 5. NO USABLE BASE IS NEVER READY ═══════════════════════════════════════

do $$
declare v_sub uuid; v_msg text; v_s jsonb; bad text; i int;
  v_bases numeric[] := array[null, 0, 'NaN'::numeric];
  v_names text[]    := array['NULL', 'zero', 'NaN'];
begin
  for i in 1 .. 3 loop
    -- A PI with a Grand Total whose pre-GST total is missing / zero / NaN.
    v_sub := pg_temp.new_pi('ASSERT ex 5-' || v_names[i], 120000, 141600);
    update public.order_submissions set total_before_gst = v_bases[i], gst_amount = null where id = v_sub;
    perform pg_temp.pay_pi(v_sub, 141600);

    v_s := pg_temp.summary(v_sub);
    assert v_s ->> 'advance_base' is null and v_s ->> 'required_payment' is null and v_s ->> 'needed_for_standard' is null
       and v_s ->> 'verified_percent' is null and v_s ->> 'attached_percent' is null and v_s ->> 'unverified_percent' is null
       and v_s ->> 'needed_attached_for_submission' is null
       and (v_s ->> 'advance_base_missing')::boolean
       and not (v_s ->> 'meets_standard')::boolean and not (v_s ->> 'attached_meets_standard')::boolean
       and not (v_s ->> 'order_gate_cleared')::boolean and v_s ->> 'approval_position' = 'payment_required',
      '5 (' || v_names[i] || '). the summary: percent, required and shortfall NULL, never ready, even fully paid: ' || v_s::text;

    v_msg := pg_temp.submit(v_sub);
    assert v_msg like 'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING:%total before GST%',
      '5 (' || v_names[i] || '). submission refuses in the missing-total style: ' || v_msg;
    assert (select status from public.order_submissions where id = v_sub) = 'draft', '5. and changes nothing';
  end loop;

  -- A PI already submitted whose pre-GST total then goes missing cannot be converted, exception or not.
  for i in 1 .. 3 loop
    v_sub := pg_temp.new_pi('ASSERT ex 5x-' || v_names[i], 120000, 141600);
    perform pg_temp.pay_pi(v_sub, 141600);
    assert pg_temp.submit(v_sub) = 'OK', '5. submitted while the figure was there';
    update public.order_submissions set total_before_gst = v_bases[i], gst_amount = null where id = v_sub;
    v_msg := pg_temp.convert(v_sub);
    assert v_msg like 'ORDER_SUBMISSION_INCOMPLETE:%total before GST%', '5 (' || v_names[i] || '). conversion is refused as incomplete: ' || v_msg;
    assert pg_temp.order_of(v_sub) is null, '5. and no Order exists';
  end loop;

  -- An APPROVED exception does not rescue it: the base is checked before any exception is looked at.
  v_sub := pg_temp.new_pi('ASSERT ex 5e', 120000, 141600);
  assert pg_temp.submit(v_sub, 'Against client PO') = 'OK', '5. exception requested with nothing paid';
  assert pg_temp.try_as(current_setting('test.admin_id')::uuid, format('select public.approve_pi_advance_exception(%L)', v_sub)) = 'OK',
    '5. approved while the figure is there';
  update public.order_submissions set total_before_gst = null, gst_amount = null where id = v_sub;
  v_msg := pg_temp.convert(v_sub);
  assert v_msg like 'ORDER_SUBMISSION_INCOMPLETE:%total before GST%', '5. an approved exception cannot convert a PI with no base: ' || v_msg;
  v_s := pg_temp.summary(v_sub);
  assert not (v_s ->> 'order_gate_cleared')::boolean and (v_s ->> 'exception_current')::boolean,
    '5. the summary: the exception is current but the gate is NOT cleared: ' || v_s::text;

  -- An exception cannot even be decided on a PI with no base.
  v_sub := pg_temp.new_pi('ASSERT ex 5d', 120000, 141600);
  assert pg_temp.submit(v_sub, 'Sample order') = 'OK', '5. exception requested';
  update public.order_submissions set total_before_gst = null, gst_amount = null where id = v_sub;
  v_msg := pg_temp.try_as(current_setting('test.admin_id')::uuid, format('select public.approve_pi_advance_exception(%L)', v_sub));
  assert v_msg like 'ORDER_SUBMISSION_INCOMPLETE:%total before GST%', '5. nor decided: ' || v_msg;
  assert (select advance_exception_status from public.order_submissions where id = v_sub) = 'pending', '5. still pending';
  -- Rejecting it is always possible (it returns the PI for correction).
  v_msg := pg_temp.try_as(current_setting('test.admin_id')::uuid, format('select public.reject_pi_advance_exception(%L, %L)', v_sub, 'Please re-upload the workbook'));
  assert v_msg = 'OK', '5. but it can be rejected, returning the PI for correction: ' || v_msg;
  raise notice '5. a NULL, zero or NaN total before GST: no percent, no required, never ready, refused as incomplete everywhere OK';
end $$;


-- ═══ 6. TRANSPORTATION: "AS APPLICABLE" ADDS NOTHING ═════════════════════════

do $$
declare v_sub uuid; v_s jsonb; o uuid;
begin
  -- Product 1,00,000 + fabric 10,000 + packaging 10,000, transportation "As applicable" (no amount):
  -- the workbook's own total before GST is 1,20,000. That stored figure is the base -- nothing is recomputed.
  v_sub := pg_temp.new_pi('ASSERT ex 6a', 120000, 141600);
  update public.order_submissions
     set gross_product_amount = 100000, subtotal_after_discount = 100000, fabric_cost = 10000, packing_cost = 10000,
         transportation_amount = null, transportation_text = 'As applicable'
   where id = v_sub;
  perform pg_temp.pay_pi(v_sub, 48000);
  v_s := pg_temp.summary(v_sub);
  assert (v_s ->> 'advance_base')::numeric = 120000 and (v_s ->> 'required_payment')::numeric = 48000
     and (v_s ->> 'meets_standard')::boolean, '6. "as applicable": the stored total before GST is the base: ' || v_s::text;
  assert pg_temp.submit(v_sub) = 'OK' and pg_temp.convert(v_sub) = 'OK', '6. and it converts at 48,000';
  o := pg_temp.order_of(v_sub);
  assert (pg_temp.position(o) ->> 'advance_base')::numeric = 120000 and (pg_temp.position(o) ->> 'required')::numeric = 48000,
    '6. the Order reads the same base';

  -- A quoted transportation amount is already inside the workbook's total before GST.
  v_sub := pg_temp.new_pi('ASSERT ex 6b', 125000, 147500);
  update public.order_submissions
     set gross_product_amount = 100000, subtotal_after_discount = 100000, fabric_cost = 10000, packing_cost = 10000,
         transportation_amount = 5000, transportation_text = null
   where id = v_sub;
  perform pg_temp.pay_pi(v_sub, 49999.99);
  v_s := pg_temp.summary(v_sub);
  assert (v_s ->> 'advance_base')::numeric = 125000 and (v_s ->> 'required_payment')::numeric = 50000
     and (v_s ->> 'needed_for_standard')::numeric = 0.01, '6. quoted transportation: 40% of 1,25,000 = 50,000: ' || v_s::text;
  raise notice '6. "as applicable" adds nothing; a quoted amount is inside the stored total OK';
end $$;


-- ═══ 7. AN ORDER'S BASE: DERIVED ON READ, NEVER GUESSED ═══════════════════════

do $$
declare
  o uuid; v_pos jsonb; v_msg text; v_row jsonb; v_dash jsonb; r jsonb; sub_id uuid;
begin
  o := pg_temp.fresh_order('ASSERT ex 7', 120000, 141600, 48000);
  select source_order_submission_id into sub_id from public.orders where id = o;

  -- 7a. V1: the source PI is the base while its Grand Total is the Order's value.
  v_pos := pg_temp.position(o);
  assert (v_pos ->> 'advance_base')::numeric = 120000 and (v_pos ->> 'percent')::numeric = 40.00 and (v_pos ->> 'ready')::boolean,
    '7a. V1: 40.00% of the PI''s pre-GST total: ' || v_pos::text;

  -- 7b. A revised PI: the in-force version carries its own pre-GST total.
  perform pg_temp.revise(o, 150000, 177000, 'ASSERT bigger order, GST 18%');
  assert (select total_value from public.orders where id = o) = 177000, '7b. the Order is re-valued to the revision''s Grand Total';
  v_pos := pg_temp.position(o);
  assert (v_pos ->> 'order_value')::numeric = 177000 and (v_pos ->> 'advance_base')::numeric = 150000
     and (v_pos ->> 'required')::numeric = 60000 and (v_pos ->> 'shortfall')::numeric = 12000
     and (v_pos ->> 'percent')::numeric = 32.00 and not (v_pos ->> 'ready')::boolean and (v_pos ->> 'below')::boolean,
    '7b. the revised version''s pre-GST total is the base: 32.00% of 1,50,000, 12,000 short: ' || v_pos::text;
  assert (select count(*) from public.order_pi_versions where order_id = o and status = 'approved') = 1,
    '7b. one version in force';
  assert pg_temp.val_as(current_setting('test.admin_id')::uuid,
           format('select public.order_total_before_gst(x) from public.orders x where x.id = %L', o)) = '150000.00',
    '7b. order_total_before_gst follows the version in force: ' || coalesce(pg_temp.val_as(current_setting('test.admin_id')::uuid, format('select public.order_total_before_gst(x) from public.orders x where x.id = %L', o)), 'NULL');
  assert (select count(*) from public.order_pi_versions v where v.order_id = o and v.status = 'superseded') = 1,
    '7b. V1 is superseded and no longer the base';

  -- 7c. The payment that closes the gap makes it ready, on the new base.
  perform pg_temp.pay_order(o, 12000);
  v_pos := pg_temp.position(o);
  assert (v_pos ->> 'shortfall')::numeric = 0 and (v_pos ->> 'percent')::numeric = 40.00 and (v_pos ->> 'ready')::boolean,
    '7c. 60,000 verified is 40.00% of 1,50,000: ' || v_pos::text;

  -- 7d. The dashboard lists by the same base.
  perform pg_temp.pay_order(o, 0.01, 'pending_approval');
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  v_dash := public.orders_dashboard_summary();
  perform pg_temp.restore();
  assert not exists (select 1 from jsonb_array_elements(v_dash -> 'groups' -> 'advance_below_40') x where (x ->> 'order_id')::uuid = o),
    '7d. at exactly 40.00% of the pre-GST total (33.9% of the Grand Total) it is not listed below 40%';
  -- A second Order, 39.99% of the pre-GST total.
  o := pg_temp.fresh_order('ASSERT ex 7d', 120000, 141600, 47999.99);
  perform pg_temp.become(current_setting('test.admin_id')::uuid);
  v_dash := public.orders_dashboard_summary();
  perform pg_temp.restore();
  select x into r from jsonb_array_elements(v_dash -> 'groups' -> 'advance_below_40') x where (x ->> 'order_id')::uuid = o;
  assert r is not null and (r ->> 'percent')::numeric = 39.99 and (r ->> 'shortfall')::numeric = 0.01
     and (r ->> 'advance_base')::numeric = 120000 and (r ->> 'order_value')::numeric = 141600,
    '7d. 47,999.99: listed, 39.99%, 0.01 short, with advance_base beside order_value: '
      || coalesce(r::text, 'not listed ' || pg_temp.position(o)::text || ' ' || (select to_jsonb(x)::text from public.orders x where x.id = o) || ' ' || (v_dash -> 'gaps')::text);

  raise notice '7. an Order''s base: the source PI, then the version in force; the dashboard follows OK';
end $$;

do $$
declare
  o uuid; v_pos jsonb; v_msg text; v_h public.order_advance_holds; v_sub uuid;
begin
  -- 7e. A hand amendment re-values the Order without a PI to say its pre-GST total: no base.
  o := pg_temp.fresh_order('ASSERT ex 7e', 120000, 141600, 48000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '7e. aligned at 40.00%';
  v_msg := pg_temp.try_as(current_setting('test.admin2_id')::uuid,
    format('select public.amend_order(%L, %L, null, %s, null, null, null, null, null)', o, 'ASSERT hand amendment', 177000));
  assert v_msg = 'OK', '7e. the amendment goes through: ' || v_msg;
  v_pos := pg_temp.position(o);
  assert (v_pos ->> 'order_value')::numeric = 177000 and v_pos ->> 'advance_base' is null
     and not (v_pos ->> 'value_known')::boolean and (v_pos ->> 'order_value_known')::boolean
     and v_pos ->> 'percent' is null and v_pos ->> 'required' is null and v_pos ->> 'shortfall' is null
     and (v_pos ->> 'below')::boolean and not (v_pos ->> 'ready')::boolean,
    '7e. no base: percent, required and shortfall NULL, below, not ready: ' || v_pos::text;
  assert pg_temp.val_as(current_setting('test.admin_id')::uuid,
           format('select public.order_total_before_gst(x) from public.orders x where x.id = %L', o)) is null,
    '7e. order_total_before_gst is NULL';
  assert pg_temp.alignment_of(o) = 'not_aligned', '7e. the amendment removed the alignment';
  select * into v_h from public.order_advance_holds where order_id = o and resolved_at is null;
  assert v_h.id is not null and v_h.percent is null and v_h.shortfall is null and v_h.verified = 48000,
    '7e. a hold was opened, recording what is known (no percent, no shortfall): ' || coalesce(to_jsonb(v_h)::text, 'none');
  assert exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                   and body like '%no total before GST on record%'),
    '7e. management is told the advance cannot be measured';
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg like 'ORDER_ADVANCE_VALUE_UNKNOWN:%total before GST%', '7e. aligning is refused, saying why: ' || v_msg;
  -- More money does not help: there is nothing to measure it against.
  perform pg_temp.pay_order(o, 100000);
  assert not (pg_temp.position(o) ->> 'ready')::boolean, '7e. 1,48,000 verified is still not ready on an unknown base';
  assert pg_temp.ops_decide(o, 'accepted') like 'ORDER_ADVANCE_VALUE_UNKNOWN:%', '7e. and still refused';
  -- An administrator's explicit approval is the way through, exactly as for an Order with no value.
  assert pg_temp.approve_exception(o) = 'OK', '7e. an administrator may approve it';
  assert (pg_temp.position(o) ->> 'ready')::boolean and pg_temp.ops_decide(o, 'accepted') = 'OK', '7e. and then it aligns';

  -- 7f. A revised PI at that value re-prices it and the base returns.
  o := pg_temp.fresh_order('ASSERT ex 7f', 120000, 141600, 48000);
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders set total_value = 177000 where id = o;
  perform set_config('boe.amendment_context', '', true);
  assert pg_temp.position(o) ->> 'advance_base' is null, '7f. a raw value write leaves no base';
  perform pg_temp.revise(o, 150000, 177000, 'ASSERT re-price');
  assert (pg_temp.position(o) ->> 'advance_base')::numeric = 150000, '7f. a revised PI at the Order''s value gives it a base again';

  -- 7g. An Order that is NULL, zero or NaN valued has none either.
  o := pg_temp.fresh_order('ASSERT ex 7g', 120000, 141600, 48000);
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders set total_value = null where id = o;
  perform set_config('boe.amendment_context', '', true);
  v_pos := pg_temp.position(o);
  assert v_pos ->> 'advance_base' is null and not (v_pos ->> 'value_known')::boolean and not (v_pos ->> 'order_value_known')::boolean
     and v_pos ->> 'percent' is null and not (v_pos ->> 'ready')::boolean, '7g. no value, no base: ' || v_pos::text;
  raise notice '7. a hand-amended Order has no base: NULL, below, never ready until an administrator approves or a PI re-prices it OK';
end $$;



-- ═══ 8. THE DECLARED AMOUNT: THE DOOR CLASSIFIES, THE TABLE IS LOOSER ════════

-- The declaration door (internal; the app's door calls it), as the salesperson.
create function pg_temp.v2(p_sub uuid, p_mode text, p_cond text, p_value numeric, p_reason text default null) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);
  begin
    perform public.submit_order_submission_advance_v2_internal(p_sub, null, p_mode, p_cond, p_value, p_reason);
    v := 'OK';
  exception when others then get stacked diagnostics v = message_text;
  end;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

do $$
declare
  v_sub uuid; v_msg text; v_meta jsonb; r public.order_submissions%rowtype;
begin
  -- 8a. standard: at least 40% of the PRE-GST total (48,000.00), whatever the Grand Total.
  v_sub := pg_temp.new_pi('ASSERT ex 8a', 120000, 141600);
  v_msg := pg_temp.v2(v_sub, 'amount', 'standard', 47999.99);
  assert v_msg like 'ORDER_SUBMISSION_ADVANCE_AMOUNT_BELOW_STANDARD:%48000.00%', '8a. 47,999.99 is below the standard of 48,000.00: ' || v_msg;
  assert (select status from public.order_submissions where id = v_sub) = 'draft', '8a. and nothing changed';
  v_msg := pg_temp.v2(v_sub, 'amount', 'standard', 48000);
  assert v_msg = 'OK', '8a. 48,000 is the standard (it was not, against 56,640): ' || v_msg;
  select * into r from public.order_submissions where id = v_sub;
  assert r.advance_condition = 'standard' and r.advance_declared_amount = 48000 and r.advance_exception_status is null,
    '8a. recorded as a standard declaration';
  select metadata into v_meta from public.order_submission_activity where submission_id = v_sub and action = 'submitted' order by created_at desc limit 1;
  assert (v_meta ->> 'advance_base')::numeric = 120000 and (v_meta ->> 'grand_total')::numeric = 141600
     and (v_meta ->> 'advance_amount')::numeric = 48000 and (v_meta ->> 'advance_percent')::numeric = 40,
    '8a. the trail carries the base: ' || coalesce(v_meta::text, 'none');

  -- 8b. an exception: strictly below the pre-GST standard.
  v_sub := pg_temp.new_pi('ASSERT ex 8b', 120000, 141600);
  v_msg := pg_temp.v2(v_sub, 'amount', 'exception', 48000, 'Sample order');
  assert v_msg like 'ORDER_SUBMISSION_ADVANCE_AMOUNT_NOT_REDUCED:%48000.00%', '8b. 48,000 is not a reduced advance: ' || v_msg;
  v_msg := pg_temp.v2(v_sub, 'amount', 'exception', 141600.01, 'Sample order');
  assert v_msg like 'ORDER_SUBMISSION_ADVANCE_AMOUNT_ABOVE_TOTAL:%', '8b. nobody declares more than the Grand Total: ' || v_msg;
  v_msg := pg_temp.v2(v_sub, 'amount', 'exception', 47999.99, 'Sample order');
  assert v_msg = 'OK', '8b. 47,999.99 is an exception: ' || v_msg;
  select * into r from public.order_submissions where id = v_sub;
  assert r.advance_condition = 'exception' and r.advance_exception_status = 'pending' and r.advance_declared_amount = 47999.99
     and r.advance_exception_percent = 39.99, '8b. 39.99% of the pre-GST total, truncated: ' || r.advance_exception_percent;

  -- 8c. the percentage way (the older shape): the amount follows the pre-GST base.
  v_sub := pg_temp.new_pi('ASSERT ex 8c', 120000, 141600);
  assert pg_temp.v2(v_sub, 'percent', 'exception', 30, 'Sample order') = 'OK', '8c. 30% exception';
  select metadata into v_meta from public.order_submission_activity where submission_id = v_sub and action = 'advance_exception_requested' order by created_at desc limit 1;
  assert (v_meta ->> 'advance_amount')::numeric = 36000 and (v_meta ->> 'advance_base')::numeric = 120000,
    '8c. 30% of 1,20,000 is 36,000 (not 42,480): ' || coalesce(v_meta::text, 'none');
  v_sub := pg_temp.new_pi('ASSERT ex 8c2', 120000, 141600);
  assert pg_temp.v2(v_sub, 'percent', 'standard', null) = 'OK', '8c. the standard, declared the older way';
  select metadata into v_meta from public.order_submission_activity where submission_id = v_sub and action = 'submitted' order by created_at desc limit 1;
  assert (v_meta ->> 'advance_amount')::numeric = 48000, '8c. is 48,000: ' || coalesce(v_meta::text, 'none');

  -- 8d. no usable base: nothing can be declared against it; declaring nothing is still allowed.
  v_sub := pg_temp.new_pi('ASSERT ex 8d', null, 141600);
  v_msg := pg_temp.v2(v_sub, 'amount', 'standard', 56640);
  assert v_msg like 'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING:%total before GST%', '8d. NULL base: ' || v_msg;
  v_msg := pg_temp.v2(v_sub, 'percent', 'exception', 10, 'Sample order');
  assert v_msg like 'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING:%total before GST%', '8d. an exception too: ' || v_msg;
  update public.order_submissions set total_before_gst = 0 where id = v_sub;
  assert pg_temp.v2(v_sub, 'amount', 'standard', 0) like 'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING:%', '8d. a zero base';
  assert pg_temp.v2(v_sub, 'none', null, null) = 'OK', '8d. but declaring nothing goes through';
  raise notice '8. the declaration door classifies on the pre-GST base OK';
end $$;

do $$
declare
  v_sub uuid; v_name text;
begin
  -- The table constraint is the LOOSER one (see the migration): written directly, with the
  -- declaration guard stepped aside for the fixture.
  v_sub := pg_temp.new_pi('ASSERT ex 8e', 120000, 141600);
  alter table public.order_submissions disable trigger order_submissions_guard_advance_exception;

  update public.order_submissions set advance_condition = 'standard', advance_declared_amount = 48000 where id = v_sub;
  assert (select advance_declared_amount from public.order_submissions where id = v_sub) = 48000,
    '8e. the table accepts a standard 48,000 (40% of the pre-GST total; the old rule wanted 56,640)';

  begin
    update public.order_submissions set advance_declared_amount = 47999.99 where id = v_sub;
    assert false, '8e. 47,999.99 as a standard amount must be refused';
  exception when check_violation then
    get stacked diagnostics v_name = constraint_name;
    assert v_name = 'order_submissions_advance_amount_matches_condition', '8e. refused by the amount/condition constraint: ' || v_name;
  end;

  -- An exception stays bounded by the OLD line (40% of the Grand Total = 56,640), so a PI declared on the
  -- old basis can still be updated; the door above applies the strict pre-GST line to new declarations.
  update public.order_submissions
     set advance_condition = 'exception', advance_declared_amount = 50000, advance_exception_percent = 35,
         advance_exception_reason = 'ASSERT declared before the change', advance_exception_status = 'pending',
         advance_exception_requested_by = current_setting('test.sales_id')::uuid, advance_exception_requested_at = now()
   where id = v_sub;
  assert (select advance_declared_amount from public.order_submissions where id = v_sub) = 50000,
    '8e. an exception declared at 50,000 (below 40% of the Grand Total) is still a valid row';
  update public.order_submissions set review_note = 'ASSERT later unrelated update' where id = v_sub;
  assert (select review_note from public.order_submissions where id = v_sub) = 'ASSERT later unrelated update',
    '8e. and a later unrelated update of that row is not blocked by the constraint';
  begin
    update public.order_submissions set advance_declared_amount = 56640 where id = v_sub;
    assert false, '8e. an exception at 40% of the Grand Total must be refused';
  exception when check_violation then
    null;
  end;

  -- A row with no pre-GST total falls back to the Grand Total for the standard line, as before.
  update public.order_submissions
     set advance_condition = 'standard', advance_declared_amount = 56640, advance_exception_percent = null,
         advance_exception_reason = null, advance_exception_status = null,
         advance_exception_requested_by = null, advance_exception_requested_at = null, total_before_gst = null
   where id = v_sub;
  begin
    update public.order_submissions set advance_declared_amount = 56639.99 where id = v_sub;
    assert false, '8e. with no pre-GST figure the standard line is 40% of the Grand Total';
  exception when check_violation then
    null;
  end;

  -- 8f. A declared amount does not survive either total being replaced.
  update public.order_submissions set total_before_gst = 120000 where id = v_sub;
  update public.order_submissions set advance_declared_amount = 48000 where id = v_sub;
  update public.order_submissions set total_before_gst = 125000 where id = v_sub;
  assert (select advance_declared_amount from public.order_submissions where id = v_sub) is null,
    '8f. replacing total_before_gst clears the declared amount';
  update public.order_submissions set advance_declared_amount = 56640 where id = v_sub;
  update public.order_submissions set grand_total = 147500 where id = v_sub;
  assert (select advance_declared_amount from public.order_submissions where id = v_sub) is null,
    '8f. and so does replacing grand_total (as before)';
  update public.order_submissions set advance_declared_amount = 52000 where id = v_sub;
  update public.order_submissions set total_before_gst = 130000, advance_declared_amount = 53000 where id = v_sub;
  assert (select advance_declared_amount from public.order_submissions where id = v_sub) = 53000,
    '8f. unless the same statement writes a new amount';

  alter table public.order_submissions enable trigger order_submissions_guard_advance_exception;
  raise notice '8. the table constraint accepts every row the old rule accepted; the pre-GST line is held by the door; the amount follows both totals OK';
end $$;


-- ═══ 9. DECISIONS, PERMISSIONS, GRANTS ═══════════════════════════════════════

do $$
declare
  v_sub uuid; v_msg text; v_s jsonb; v_fn text;
begin
  -- 9a. The identity check is unchanged: figures that moved since the decision make it stale.
  assert public.order_submission_exception_current('approved', 141600, 141600, 'h', 'h', 't', 't', 'b', 'b'), '9a. same figures: current';
  assert not public.order_submission_exception_current('approved', 141600, 150000, 'h', 'h', 't', 't', 'b', 'b'), '9a. a new Grand Total: stale';
  assert not public.order_submission_exception_current('approved', null, 141600, 'h', 'h', 't', 't', 'b', 'b'), '9a. no recorded basis: not current';
  assert not public.order_submission_exception_current('approved', 141600, 141600, 'h', 'h2', 't', 't', 'b', 'b'), '9a. a new workbook: stale';
  assert not public.order_submission_exception_current('pending', 141600, 141600, 'h', 'h', 't', 't', 'b', 'b'), '9a. not approved: not current';

  v_sub := pg_temp.new_pi('ASSERT ex 9a', 120000, 141600);
  assert pg_temp.submit(v_sub, 'Against client PO') = 'OK', '9a. exception requested';
  assert pg_temp.try_as(current_setting('test.admin_id')::uuid, format('select public.approve_pi_advance_exception(%L)', v_sub)) = 'OK', '9a. decided';
  assert (select advance_exception_decided_grand_total from public.order_submissions where id = v_sub) = 141600, '9a. the decision records the Grand Total';
  assert (select advance_exception_decided_verified from public.order_submissions where id = v_sub) = 0, '9a. and the verified rupees (a floor, unaffected)';
  v_s := pg_temp.summary(v_sub);
  assert (v_s ->> 'exception_current')::boolean and (v_s ->> 'order_gate_cleared')::boolean and v_s ->> 'approval_position' = 'exception_approved',
    '9a. an approved exception on a PI with a base clears the gate: ' || v_s::text;
  update public.order_submissions set grand_total = 150000, total_before_gst = 127000 where id = v_sub;
  v_msg := pg_temp.convert(v_sub);
  assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_STALE:%', '9a. figures that moved after the decision make it stale: ' || v_msg;
  v_s := pg_temp.summary(v_sub);
  assert not (v_s ->> 'exception_current')::boolean and not (v_s ->> 'order_gate_cleared')::boolean and v_s ->> 'approval_position' = 'exception_stale',
    '9a. and the summary says so: ' || v_s::text;

  -- 9b. A decision taken before decided_verified existed read its percentage against the Grand Total; that
  -- reading is kept (the stricter floor).
  assert public.order_pi_exception_floor(null, 35, 141600) = 49560, '9b. legacy percentage floor: 35% of the Grand Total, as decided';
  assert public.order_pi_exception_floor(12345.67, 35, 141600) = 12345.67, '9b. a recorded rupee floor wins';

  -- 9c. Permissions are unchanged.
  v_msg := pg_temp.try_as(current_setting('test.sales_id')::uuid, format('select public.approve_pi_advance_exception(%L)', v_sub));
  assert v_msg like 'You do not have permission to decide advance exceptions%', '9c. a salesperson cannot decide an exception: ' || v_msg;
  v_msg := pg_temp.try_as(current_setting('test.sales_id')::uuid,
    format('select public.approve_order_submission(%L, %L, current_date, current_date + 30, ''reference'')', v_sub, current_setting('test.sales_id')));
  assert v_msg like 'You do not have permission to approve order submissions%', '9c. nor approve a PI: ' || v_msg;
  v_msg := pg_temp.try_as(current_setting('test.sales_id')::uuid, format('select public.order_advance_position(%L)', gen_random_uuid()));
  assert v_msg like 'permission denied%', '9c. the position is still not callable by a client: ' || v_msg;
  v_msg := pg_temp.try_as(current_setting('test.sales_id')::uuid, format('select public.order_advance_base(%L)', gen_random_uuid()));
  assert v_msg like 'permission denied%', '9c. nor the base: ' || v_msg;

  -- 9d. Every grant is what it was: the helpers are not for anon; the doors are for signed-in users.
  foreach v_fn in array array[
    'public.order_submission_required_payment(numeric)', 'public.order_submission_payment_shortfall(numeric, numeric)',
    'public.order_submission_payment_ready(numeric, numeric, text)', 'public.order_submission_standard_advance_amount(numeric)',
    'public.order_submission_advance_amount(numeric, numeric)', 'public.approve_order_submission(uuid, uuid, date, date, text)',
    'public.approve_pi_advance_exception(uuid)', 'public.reject_pi_advance_exception(uuid, text)',
    'public.pi_submission_payment_summary(uuid)', 'public.orders_dashboard_summary()'] loop
    assert not has_function_privilege('anon', v_fn::regprocedure, 'execute'), '9d. anon cannot execute ' || v_fn;
    assert has_function_privilege('authenticated', v_fn::regprocedure, 'execute'), '9d. authenticated still can execute ' || v_fn;
  end loop;
  foreach v_fn in array array[
    'public.order_advance_position(uuid)', 'public.order_advance_hold_recheck(uuid, text, jsonb)',
    'public.submit_pi_for_review_internal(uuid, text, text, text, text)',
    'public.submit_order_submission_advance_v2_internal(uuid, text, text, text, numeric, text)',
    'public.order_advance_base(uuid)', 'public.order_advance_numeric(text)'] loop
    assert not has_function_privilege('anon', v_fn::regprocedure, 'execute') and not has_function_privilege('authenticated', v_fn::regprocedure, 'execute')
       and not has_function_privilege('service_role', v_fn::regprocedure, 'execute'), '9d. no client role can execute ' || v_fn;
  end loop;
  assert (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
            and p.proname in ('order_advance_base', 'order_total_before_gst', 'order_advance_position', 'approve_order_submission',
                              'approve_pi_advance_exception', 'reject_pi_advance_exception', 'submit_pi_for_review_internal',
                              'submit_order_submission_advance_v2_internal', 'pi_submission_payment_summary', 'orders_alignment_requires_advance',
                              'order_advance_hold_recheck', 'orders_dashboard_summary', 'order_submissions_advance_amount_follows_total')
            and coalesce(p.proconfig::text, '') like '%search_path=public, pg_temp%') = 13,
    '9d. every definer keeps a pinned search_path ending in pg_temp';
  raise notice '9. decisions go stale as before, permissions and grants are unchanged OK';
end $$;

do $$ begin raise notice 'ALL ADVANCE-ON-TOTAL-BEFORE-GST ASSERTIONS PASSED'; end $$;

rollback;
