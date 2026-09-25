-- PRODUCTION READINESS FOLLOWS THE 40% ADVANCE AFTER ALIGNMENT (20270116000000 §4d)
-- ===========================================================================
-- The gate is not only checked when production is aligned. Through the real
-- doors, on a disposable stack:
--
--   1. amend_order    an admin raises an ALIGNED Order's value below 40%:
--                     the same transaction removes the alignment, opens a
--                     hold, logs it, and tells management and Operations.
--                     Status and history are untouched. Operations cannot
--                     re-align until it is ready; then it re-aligns against
--                     the SAME acceptance and the hold closes.
--   2. change request an approved change request that raises the value: held.
--   3. money          a reversal, a reduced or deleted allocation, and a
--                     payment leaving a verified status: held. Money going up
--                     never holds.
--   4. no hold        a decrease, or an increase that stays at 40%.
--   5. no value       NULL, zero and NaN are never ready: aligning is refused
--                     (ORDER_ADVANCE_VALUE_UNKNOWN) until an admin approves;
--                     an aligned Order amended to 0 is held.
--   6. exception      specific to one amendment of one version: A → B → A
--                     does not revive it; a same-value revision does not
--                     carry it; verified money falling below what it was
--                     given against makes it stale.
--   7. revision       an aligned Order revised upward below 40%: ONE hold
--                     (cause pi_revision), the handoff removes the alignment.
--   8. writers        a raw write to total_value is re-checked like any door;
--                     value_epoch cannot be written; clients read no holds and
--                     cannot call the re-check.
--   9. photos (H1)    order_pi_image_key_is_canonical and the propose RPC
--                     refuse traversal, encoded, foreign, missing and
--                     mismatched keys.
--  10. returned PI    an approved exception with a reason written before the
--                     three existed resubmits unchanged; a new free text is
--                     refused.
--  11. review fixes   R1 the CURRENT reviewer re-aligns a held Order (the
--                     acceptance record untouched, the new actor and time
--                     recorded); reassignment aligns nothing; the former
--                     reviewer and an admin are refused while a reviewer can
--                     act; with none, an admin's recovery with a reason, the
--                     40% gate enforced. R2 a lower value is "lowered". R5 a
--                     revision's hold names the approving admin. R6 a reversal
--                     voids an exception for good. R7 the PI's exception is
--                     held to the money verified at the decision. R8 an
--                     inactive reviewer is not notified. R4 partial photo rows
--                     are refused.
--
-- Runs inside ONE transaction that ends in ROLLBACK.
-- SELF-CONTAINED FIXTURES: this suite creates its own people (ids a0d0…),
-- assigns its own operations reviewer inside the transaction, and depends on
-- nobody else's seed. Needs only the migration chain through 20270116000000.
-- On success prints NOTICE 'ALL ADVANCE-HOLD ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

-- ═══ 0. PEOPLE, HELPERS ═════════════════════════════════════════════════════

do $$
begin
  perform set_config('test.admin_id',  'a0d00000-0000-4000-8000-000000000001', true);
  perform set_config('test.admin2_id', 'a0d00000-0000-4000-8000-000000000002', true);
  perform set_config('test.sales_id',  'a0d00000-0000-4000-8000-000000000003', true);
  perform set_config('test.ops_id',    'a0d00000-0000-4000-8000-000000000004', true);
  perform set_config('test.fin_id',    'a0d00000-0000-4000-8000-000000000005', true);

  insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
    ('a0d00000-0000-4000-8000-000000000001', 'ASSERT Hold Admin',    'hold-admin@suite.test',  'admin',  'management', true, 'HOLD-ADM'),
    ('a0d00000-0000-4000-8000-000000000002', 'ASSERT Hold Admin 2',  'hold-admin2@suite.test', 'admin',  'management', true, 'HOLD-AD2'),
    ('a0d00000-0000-4000-8000-000000000003', 'ASSERT Hold Sales',    'hold-sales@suite.test',  'member', 'sales',      true, 'HOLD-SAL'),
    ('a0d00000-0000-4000-8000-000000000004', 'ASSERT Hold Ops',      'hold-ops@suite.test',    'member', 'operations', true, 'HOLD-OPS'),
    ('a0d00000-0000-4000-8000-000000000005', 'ASSERT Hold Finance',  'hold-fin@suite.test',    'member', 'management', true, 'HOLD-FIN')
  on conflict (id) do update set role = excluded.role, is_active = true, full_name = excluded.full_name;

  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  select g.uid, mpa.module_id, mpa.action_id, true, 'a0d00000-0000-4000-8000-000000000001'::uuid
    from (values ('a0d00000-0000-4000-8000-000000000001'::uuid, 'orders',  'approve_order'),
                 ('a0d00000-0000-4000-8000-000000000001'::uuid, 'orders',  'approve_advance_exception'),
                 ('a0d00000-0000-4000-8000-000000000001'::uuid, 'orders',  'can_be_order_assignee'),
                 ('a0d00000-0000-4000-8000-000000000002'::uuid, 'orders',  'approve_order'),
                 ('a0d00000-0000-4000-8000-000000000003'::uuid, 'orders',  'can_be_order_assignee'),
                 ('a0d00000-0000-4000-8000-000000000003'::uuid, 'orders',  'view'),
                 ('a0d00000-0000-4000-8000-000000000003'::uuid, 'orders',  'create'),
                 ('a0d00000-0000-4000-8000-000000000004'::uuid, 'orders',  'view'),
                 ('a0d00000-0000-4000-8000-000000000004'::uuid, 'orders',  'align_production'),
                 ('a0d00000-0000-4000-8000-000000000005'::uuid, 'finance', 'view'),
                 ('a0d00000-0000-4000-8000-000000000005'::uuid, 'finance', 'approve'),
                 ('a0d00000-0000-4000-8000-000000000005'::uuid, 'finance', 'allocate_correct')) g(uid, m, a)
    join public.permission_modules pm on pm.module_key = g.m
    join public.permission_actions pa on pa.action_key = g.a
    join public.module_permission_actions mpa on mpa.module_id = pm.id and mpa.action_id = pa.id
  on conflict do nothing;

  delete from public.order_operations_reviewers where duty = 'pi_handoff';
  insert into public.order_operations_reviewers (duty, user_id, assigned_by)
  values ('pi_handoff', 'a0d00000-0000-4000-8000-000000000004', 'a0d00000-0000-4000-8000-000000000001');
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
  if v <> 'OK' then raise notice '  try_as(%): %', left(p_sql, 60), v; end if;
  return v;
end $$;

-- A Confirmed Order of p_total with p_paid verified, converted through the real
-- doors. p_pi_exception: submitted below 40% with a reason, and an admin
-- approves the PI's own exception before the conversion.
create function pg_temp.fresh_order(p_client text, p_total numeric, p_paid numeric, p_pi_exception boolean default false)
returns uuid language plpgsql as $$
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
  values (v_pay, 'ASSERT hold', p_paid, current_date, 'hdfc', 'approved_unlinked', v_sales, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, v_sub, p_paid, 'order_submission', v_sales);
  perform pg_temp.become(v_sales);
  perform public.submit_pi_for_review(v_sub, null, case when p_pi_exception then 'Against client PO' end, null, null);
  perform pg_temp.restore();
  perform pg_temp.become(v_admin);
  if p_pi_exception then
    perform public.approve_pi_advance_exception(v_sub);
  end if;
  if (select pi_approved_at from public.order_submissions where id = v_sub) is null then
    perform public.approve_pi_review(v_sub);
  end if;
  v_res := public.approve_order_submission(v_sub, v_sales, current_date, current_date + 30, 'reference');
  perform pg_temp.restore();
  return (v_res ->> 'order_id')::uuid;
end $$;

-- A payment on the Order itself, in the given Finance state; returns the allocation.
create function pg_temp.pay_order(p_order uuid, p_amount numeric, p_status text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid(); a uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v, 'ASSERT hold', p_amount, current_date, 'hdfc', p_status, current_setting('test.sales_id')::uuid, null);
  insert into public.finance_payment_allocations (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
  values (v, p_order, p_amount, 'confirmed_order', current_setting('test.sales_id')::uuid) returning id into a;
  return a;
end $$;

-- Operations' decision on the live handoff, as the reviewer. Prints any refusal.
create function pg_temp.ops_decide(p_order uuid, p_decision text, p_reason text default null) returns text language plpgsql as $$
declare h uuid;
begin
  select id into h from public.order_operations_handoffs where order_id = p_order and superseded_at is null;
  return pg_temp.try_as(current_setting('test.ops_id')::uuid,
    format('select public.decide_order_operations_handoff(%L, %L, %L)', h, p_decision, p_reason));
end $$;

create function pg_temp.amend(p_order uuid, p_total numeric, p_as uuid default null) returns text language plpgsql as $$
begin
  return pg_temp.try_as(coalesce(p_as, current_setting('test.admin2_id')::uuid),
    format('select public.amend_order(%L, %L, null, %s, null, null, null, null, null)', p_order, 'ASSERT hold amendment', p_total));
end $$;

create function pg_temp.alignment(p_order uuid) returns text language sql as $$
  select production_alignment from public.orders where id = p_order
$$;
create function pg_temp.open_hold(p_order uuid) returns public.order_advance_holds language sql as $$
  select * from public.order_advance_holds where order_id = p_order and resolved_at is null
$$;

-- An edit revision through the real doors (propose, then an admin approves).
create function pg_temp.revalue(p_order uuid, p_total numeric, p_reason text) returns void language plpgsql as $$
declare v_sub uuid; v_item uuid; s public.order_submissions%rowtype; o public.orders%rowtype; v_ver uuid; v_prop jsonb;
begin
  select * into o from public.orders where id = p_order;
  select * into s from public.order_submissions where id = o.source_order_submission_id;
  select id into v_item from public.order_submission_items where submission_id = s.id;
  v_prop := jsonb_build_object(
    'payload', jsonb_build_object(
      'header', jsonb_build_object('client_name', o.client_name, 'order_confirmation_date', o.confirm_date,
                                   'due_date', o.due_date, 'creation_date', s.creation_date),
      'commercial', jsonb_build_object('gross_product_amount', p_total, 'discount_amount', 0,
                                       'total_before_gst', p_total, 'gst_amount', 0, 'grand_total', p_total),
      'source', jsonb_build_object('workbook_path', s.source_workbook_path, 'workbook_sha256', s.source_workbook_sha256),
      'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
      'items', jsonb_build_array(jsonb_build_object('id', v_item, 'source_row', 32, 'item_sequence', 'B001',
                 'product_name', 'ASSERT hold chair', 'quantity', 10, 'cost_per_piece', p_total / 10,
                 'total_amount', p_total, 'sort_order', 0)),
      'item_images', coalesce((select jsonb_agg(to_jsonb(m) - 'id' - 'created_at' - 'submission_id')
                                 from public.order_submission_item_images m where m.submission_id = s.id), '[]'::jsonb),
      'seed_terms', jsonb_build_object('fabric_responsibility', 'client'),
      'fingerprint', encode(sha256(convert_to(p_total::text || clock_timestamp()::text, 'UTF8')), 'hex')),
    'terms', jsonb_build_object('fabric_responsibility', 'client'),
    'change_summary', jsonb_build_array('ASSERT hold revalue'));
  v_ver := (public.propose_order_pi_edit_revision(p_order, current_setting('test.sales_id')::uuid, v_prop, p_reason) ->> 'version_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  perform public.approve_order_pi_revision(v_ver, current_setting('test.admin_id')::uuid,
    (select proposal -> 'payload' from public.order_pi_versions where id = v_ver));
end $$;

create function pg_temp.approve_exception(p_order uuid) returns text language plpgsql as $$
begin
  return pg_temp.try_as(current_setting('test.admin_id')::uuid,
    format('select public.approve_order_advance_exception(%L, %L)', p_order, 'ASSERT long-standing client, balance on delivery'));
end $$;


-- ═══ 1. amend_order RAISES AN ALIGNED ORDER'S VALUE BELOW 40% ═══════════════

do $$
declare
  o        uuid;
  v_msg    text;
  v_h      public.order_advance_holds;
  v_hand   record;
  v_epoch  int;
  v_events int;
  v_status text;
begin
  o := pg_temp.fresh_order('ASSERT hold 1', 1000000, 400000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '1. V1 at 40% is accepted';
  assert pg_temp.alignment(o) = 'aligned', '1. and aligned';
  select * into v_hand from public.order_operations_handoffs where order_id = o and superseded_at is null;
  v_epoch := (select value_epoch from public.orders where id = o);
  v_status := (select status from public.orders where id = o);
  v_events := (select count(*) from public.order_activity_log where order_id = o);

  v_msg := pg_temp.amend(o, 1250000);
  assert v_msg = 'OK', '1. the amendment itself goes through: ' || v_msg;
  assert pg_temp.alignment(o) = 'not_aligned', '1. readiness removed in the same transaction';
  v_h := pg_temp.open_hold(o);
  assert v_h.id is not null and v_h.cause = 'value_changed' and v_h.order_value = 1250000
     and v_h.previous_order_value = 1000000 and v_h.verified = 400000 and v_h.percent = 32
     and v_h.shortfall = 100000 and v_h.held_by = current_setting('test.admin2_id')::uuid,
    '1. a hold records what changed, the figures and who: ' || coalesce(to_jsonb(v_h)::text, 'none');
  assert (select value_epoch from public.orders where id = o) = v_epoch + 1, '1. the value epoch moved';
  assert (select status from public.orders where id = o) = v_status, '1. the Order''s status is untouched';
  assert exists (select 1 from public.order_activity_log where order_id = o and event_type = 'production_alignment_changed'
                   and payload ->> 'reason' = 'advance_hold' and (payload ->> 'hold_id')::uuid = v_h.id
                   and payload ->> 'previous_aligned_by' = current_setting('test.ops_id')),
    '1. the alignment removal is audited with the hold and who had aligned it';
  assert exists (select 1 from public.order_activity_log where order_id = o and event_type = 'order_advance_hold_opened'
                   and (payload ->> 'hold_id')::uuid = v_h.id and payload ->> 'cause' = 'value_changed'),
    '1. the hold is logged';
  assert exists (select 1 from public.order_activity_log where order_id = o and event_type = 'operations_handoff_accepted'),
    '1. the earlier acceptance stays on the history';
  assert (select status from public.order_operations_handoffs where id = v_hand.id) = 'accepted'
     and (select accepted_by from public.order_operations_handoffs where id = v_hand.id) = v_hand.accepted_by
     and (select accepted_at from public.order_operations_handoffs where id = v_hand.id) = v_hand.accepted_at,
    '1. and the acceptance record itself is not rewritten';
  assert exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                   and user_id = current_setting('test.admin_id')::uuid and title like '%production readiness removed%'
                   and body like '%32%' and body like '%100000.00 more verified payment%'),
    '1. management is told, with the percentage and the shortfall';
  assert exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                   and user_id = current_setting('test.ops_id')::uuid), '1. and so is the operations reviewer';
  assert not exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                       and user_id = current_setting('test.admin2_id')::uuid), '1. but not the admin who made the change';
  assert (public.order_advance_position(o) #>> '{hold,id}')::uuid = v_h.id, '1. readiness reports the hold';

  -- Operations cannot re-align while it is short — and the refusal changes nothing.
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg like 'ORDER_ADVANCE_BELOW_THRESHOLD:%32.00%%', '1. re-aligning is refused while short: ' || v_msg;
  assert (pg_temp.open_hold(o)).id is not null and pg_temp.alignment(o) = 'not_aligned', '1. and nothing moved';

  -- Finance verifies the shortfall: Operations re-aligns against the SAME acceptance.
  perform pg_temp.pay_order(o, 100000, 'approved_unlinked');
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg = 'OK' and pg_temp.alignment(o) = 'aligned', '1. once ready, Operations re-aligns: ' || v_msg;
  assert (select accepted_at from public.order_operations_handoffs where id = v_hand.id) = v_hand.accepted_at,
    '1. the original acceptance is kept as it was';
  assert exists (select 1 from public.order_activity_log where order_id = o and event_type = 'operations_handoff_realigned'
                   and (payload ->> 'hold_id')::uuid = v_h.id), '1. the re-alignment is its own event, naming the hold';
  assert (select resolution from public.order_advance_holds where id = v_h.id) = 'realigned'
     and (select resolved_by from public.order_advance_holds where id = v_h.id) = current_setting('test.ops_id')::uuid,
    '1. and the hold is closed by it';
  assert pg_temp.ops_decide(o, 'accepted') like 'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED%', '1. accepting an aligned version twice is still refused';
  assert (select count(*) from public.order_activity_log where order_id = o) > v_events, '1. history only grows';
  raise notice '1. amend_order below 40%%: alignment removed, held, logged, told; re-aligned only when ready OK';
end $$;


-- ═══ 2. AN APPROVED CHANGE REQUEST THAT RAISES THE VALUE ══════════════════════

do $$
declare
  o     uuid;
  v_req uuid := gen_random_uuid();
  v_msg text;
begin
  o := pg_temp.fresh_order('ASSERT hold 2', 1000000, 400000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '2. aligned';
  insert into public.order_change_requests (id, order_id, order_number_snapshot, request_type, requested_by, reason,
                                             proposed_total_value, baseline_total_value, status)
  select v_req, x.id, x.display_number, 'edit', current_setting('test.sales_id')::uuid, 'ASSERT client added a sofa',
         1300000, x.total_value, 'pending'
    from public.orders x where x.id = o;
  v_msg := pg_temp.try_as(current_setting('test.admin_id')::uuid,
    format('select public.approve_order_change_request(%L, %L)', v_req, 'ASSERT approved'));
  assert v_msg = 'OK', '2. the change request is approved: ' || v_msg;
  assert (select total_value from public.orders where id = o) = 1300000, '2. the Order is amended';
  assert pg_temp.alignment(o) = 'not_aligned' and (pg_temp.open_hold(o)).cause = 'value_changed'
     and (pg_temp.open_hold(o)).held_by = current_setting('test.admin_id')::uuid,
    '2. and held by the approving admin';
  raise notice '2. an approved change request that raises the value below 40%% is held OK';
end $$;


-- ═══ 3. VERIFIED MONEY GOING DOWN; MONEY GOING UP NEVER HOLDS ═════════════════

-- The allocation that carried the conversion payment onto the Order.
create function pg_temp.conversion_allocation(p_order uuid) returns uuid language sql as $$
  select a.id from public.finance_payment_allocations a
   where a.order_id = p_order and a.status = 'active' order by a.created_at limit 1
$$;

do $$
declare
  o     uuid;
  a     uuid;
  p     uuid;
  v_msg text;
begin
  -- 3a. A reversal by Finance.
  o := pg_temp.fresh_order('ASSERT hold 3a', 1000000, 400000);
  a := pg_temp.conversion_allocation(o);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '3a. aligned at 40%';
  v_msg := pg_temp.try_as(current_setting('test.fin_id')::uuid,
    format('select public.reverse_payment_allocation(%L, %L)', a, 'ASSERT wrong client'));
  assert v_msg = 'OK', '3a. Finance reverses the allocation: ' || v_msg;
  assert pg_temp.alignment(o) = 'not_aligned', '3a. readiness removed';
  assert (pg_temp.open_hold(o)).cause = 'payment_changed' and (pg_temp.open_hold(o)).verified = 0
     and (pg_temp.open_hold(o)).detail ->> 'change' = 'reversed'
     and (pg_temp.open_hold(o)).held_by = current_setting('test.fin_id')::uuid,
    '3a. held for the reversal, by Finance: ' || coalesce(to_jsonb(pg_temp.open_hold(o))::text, 'none');
  assert exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                   and user_id = current_setting('test.admin_id')::uuid and body like '%verified payment against it was reduced%'),
    '3a. management is told why';

  -- 3b. An allocation is never reduced or moved in place (reversal is the only
  -- way down, covered by 3a); the re-check's reduced/moved branches are
  -- defence in depth behind finance_payment_allocations_guard_transition.
  o := pg_temp.fresh_order('ASSERT hold 3b', 1000000, 400000);
  a := pg_temp.conversion_allocation(o);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '3b. aligned';
  v_msg := pg_temp.try_as(null, format('update public.finance_payment_allocations set allocated_amount = 300000 where id = %L', a));
  assert v_msg like 'ALLOCATION_IMMUTABLE%' and pg_temp.alignment(o) = 'aligned', '3b. an allocation cannot be reduced in place: ' || v_msg;

  -- 3c. A payment leaving a verified status.
  o := pg_temp.fresh_order('ASSERT hold 3c', 1000000, 400000);
  select payment_request_id into p from public.finance_payment_allocations where id = pg_temp.conversion_allocation(o);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '3c. aligned';
  update public.finance_payment_requests set status = 'needs_clarification' where id = p;
  assert pg_temp.alignment(o) = 'not_aligned' and (pg_temp.open_hold(o)).detail ->> 'change' = 'payment_status',
    '3c. a payment that is no longer verified holds: ' || coalesce(to_jsonb(pg_temp.open_hold(o))::text, 'none');

  -- 3d. More money, or a reversal that leaves 40% standing: nothing happens.
  o := pg_temp.fresh_order('ASSERT hold 3d', 1000000, 400000);
  a := pg_temp.pay_order(o, 50000, 'approved_unlinked');
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '3d. aligned';
  perform pg_temp.pay_order(o, 10000, 'approved_unlinked');
  v_msg := pg_temp.try_as(current_setting('test.fin_id')::uuid,
    format('select public.reverse_payment_allocation(%L, %L)', a, 'ASSERT duplicate'));
  assert v_msg = 'OK' and pg_temp.alignment(o) = 'aligned' and (pg_temp.open_hold(o)).id is null,
    '3d. a reversal that leaves 40% verified does not hold';

  -- 3e. An Order converted under the PI's own below-40% exception: ready while
  -- the money it was decided on stands; a reversal below that share holds it.
  o := pg_temp.fresh_order('ASSERT hold 3e', 1000000, 200000, true);
  assert public.order_advance_position(o) #>> '{exception,source}' = 'pi'
     and (public.order_advance_position(o) ->> 'ready')::boolean, '3e. ready under the PI''s exception';
  a := pg_temp.pay_order(o, 50000, 'approved_unlinked');
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '3e. aligned';
  assert pg_temp.try_as(current_setting('test.fin_id')::uuid,
    format('select public.reverse_payment_allocation(%L, %L)', a, 'ASSERT extra reversed')) = 'OK', '3e. extra reversed';
  assert pg_temp.alignment(o) = 'aligned', '3e. money above what the exception was decided on can go';
  assert pg_temp.try_as(current_setting('test.fin_id')::uuid,
    format('select public.reverse_payment_allocation(%L, %L)', pg_temp.conversion_allocation(o), 'ASSERT bounced')) = 'OK', '3e. reversed';
  assert pg_temp.alignment(o) = 'not_aligned' and (pg_temp.open_hold(o)).cause = 'payment_changed',
    '3e. below the share the PI''s exception was decided at: held';
  raise notice '3. reversal, reduced allocation, payment unverified, PI exception undercut: held; money up or still 40%%: untouched OK';
end $$;


-- ═══ 4. NO HOLD WHEN THE ADVANCE STILL STANDS ════════════════════════════════

do $$
declare o uuid;
begin
  o := pg_temp.fresh_order('ASSERT hold 4', 1000000, 500000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '4. aligned';
  assert pg_temp.amend(o, 800000) = 'OK', '4. decreased';
  assert pg_temp.alignment(o) = 'aligned' and (pg_temp.open_hold(o)).id is null, '4. a decrease never holds';
  assert pg_temp.amend(o, 1250000) = 'OK', '4. increased';
  assert pg_temp.alignment(o) = 'aligned' and (pg_temp.open_hold(o)).id is null,
    '4. an increase that keeps 40% verified (500000 of 1250000) does not hold';
  raise notice '4. decreases and increases that keep 40%% leave the alignment alone OK';
end $$;


-- ═══ 5. NO VALUE ON RECORD IS NEVER READY ═════════════════════════════════════

do $$
declare
  o     uuid;
  v_pos jsonb;
  v_msg text;
begin
  -- 5a. NULL (a legacy Order): not ready however much is paid, refused with
  -- its own words, then an admin decides.
  o := pg_temp.fresh_order('ASSERT hold 5a', 1000000, 400000);
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders set total_value = null where id = o;
  perform set_config('boe.amendment_context', '', true);
  v_pos := public.order_advance_position(o);
  assert not (v_pos ->> 'value_known')::boolean and (v_pos ->> 'below')::boolean and not (v_pos ->> 'ready')::boolean
     and v_pos ->> 'shortfall' is null and v_pos ->> 'percent' is null,
    '5a. a NULL value is below and not ready: ' || v_pos::text;
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg like 'ORDER_ADVANCE_VALUE_UNKNOWN:%', '5a. aligning is refused, saying why: ' || v_msg;
  assert pg_temp.approve_exception(o) = 'OK', '5a. an admin may approve it';
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '5a. and then it is accepted';
  assert pg_temp.alignment(o) = 'aligned', '5a. and aligned';

  -- 5b. Zero and NaN are no better.
  o := pg_temp.fresh_order('ASSERT hold 5b', 1000000, 400000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '5b. aligned at 40%';
  assert pg_temp.amend(o, 0) = 'OK', '5b. amended to zero';
  assert pg_temp.alignment(o) = 'not_aligned' and (pg_temp.open_hold(o)).order_value = 0,
    '5b. an aligned Order amended to 0 is held';
  assert not (public.order_advance_position(o) ->> 'ready')::boolean, '5b. zero is never ready on payment';
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders set total_value = 'NaN'::numeric where id = o;
  perform set_config('boe.amendment_context', '', true);
  assert not (public.order_advance_position(o) ->> 'value_known')::boolean
     and not (public.order_advance_position(o) ->> 'ready')::boolean, '5b. NaN is not a value';
  raise notice '5. NULL, zero and NaN are never ready: refused with their own words, held when amended to OK';
end $$;


-- ═══ 6. AN EXCEPTION BELONGS TO ONE AMENDMENT OF ONE VERSION ════════════════

do $$
declare
  o     uuid;
  a     uuid;
begin
  -- 6a. A → B → A: the old approval does not come back.
  o := pg_temp.fresh_order('ASSERT hold 6a', 1000000, 400000);
  assert pg_temp.amend(o, 2000000) = 'OK', '6a. A = 20,00,000 (20%)';
  assert pg_temp.approve_exception(o) = 'OK', '6a. approved at A';
  assert (public.order_advance_position(o) ->> 'ready')::boolean, '6a. ready under it';
  assert pg_temp.amend(o, 2100000) = 'OK', '6a. B';
  assert not (public.order_advance_position(o) ->> 'ready')::boolean, '6a. B: stale';
  assert pg_temp.amend(o, 2000000) = 'OK', '6a. back to A';
  assert not (public.order_advance_position(o) ->> 'ready')::boolean,
    '6a. returning to the old figure does not revive the old approval: ' || public.order_advance_position(o)::text;
  assert pg_temp.approve_exception(o) = 'OK', '6a. a new approval is possible for the new basis';

  -- 6b. A new version at the SAME value does not inherit it.
  o := pg_temp.fresh_order('ASSERT hold 6b', 1000000, 400000);
  assert pg_temp.amend(o, 2000000) = 'OK', '6b. 20,00,000';
  assert pg_temp.approve_exception(o) = 'OK', '6b. approved at 20,00,000';
  perform pg_temp.revalue(o, 2000000, 'ASSERT same value, new wording');
  assert (select total_value from public.orders where id = o) = 2000000, '6b. the value did not change';
  assert not (public.order_advance_position(o) ->> 'ready')::boolean,
    '6b. a new version needs its own approval: ' || public.order_advance_position(o)::text;

  -- 6c. Verified money below what the admin saw: stale, and an aligned Order is held.
  o := pg_temp.fresh_order('ASSERT hold 6c', 1000000, 400000);
  a := pg_temp.pay_order(o, 100000, 'approved_unlinked');
  assert pg_temp.amend(o, 2500000) = 'OK', '6c. 5,00,000 of 25,00,000 = 20%';
  assert pg_temp.approve_exception(o) = 'OK', '6c. approved at 20% verified';
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '6c. aligned under the exception';
  assert pg_temp.try_as(current_setting('test.fin_id')::uuid,
    format('select public.reverse_payment_allocation(%L, %L)', a, 'ASSERT bounced')) = 'OK', '6c. reversed';
  assert not (public.order_advance_position(o) ->> 'ready')::boolean, '6c. the exception no longer stands';
  assert pg_temp.alignment(o) = 'not_aligned' and (pg_temp.open_hold(o)).cause = 'payment_changed',
    '6c. and the aligned Order is held';
  assert (select count(*) from public.order_advance_exceptions where order_id = o) = 1, '6c. the exception record itself is kept';
  raise notice '6. an exception is specific to its amendment, its version and its money OK';
end $$;


-- ═══ 7. A REVISION THAT RAISES AN ALIGNED ORDER BELOW 40% ═══════════════════

do $$
declare o uuid;
begin
  o := pg_temp.fresh_order('ASSERT hold 7', 1000000, 400000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '7. aligned';
  perform pg_temp.revalue(o, 1250000, 'ASSERT a second room');
  assert (select count(*) from public.order_advance_holds where order_id = o) = 1
     and (pg_temp.open_hold(o)).cause = 'pi_revision' and (pg_temp.open_hold(o)).order_value = 1250000
     and (pg_temp.open_hold(o)).previous_order_value = 1000000,
    '7. exactly one hold, for the revision: ' || coalesce((select jsonb_agg(to_jsonb(h)) from public.order_advance_holds h where order_id = o)::text, 'none');
  assert pg_temp.alignment(o) = 'not_aligned', '7. the handoff removed the alignment';
  assert (select status from public.order_operations_handoffs where order_id = o and superseded_at is null) = 'awaiting',
    '7. V2 awaits Operations';
  assert pg_temp.ops_decide(o, 'accepted') like 'ORDER_ADVANCE_BELOW_THRESHOLD%', '7. and cannot be accepted while short';
  raise notice '7. a revision below 40%% on an aligned Order: one hold, alignment removed by its handoff OK';
end $$;


-- ═══ 8. EVERY WRITER, AND NOBODY ELSE ═══════════════════════════════════════

do $$
declare
  o      uuid;
  v_msg  text;
  v_ep   int;
begin
  -- 8a. A raw write to the value (any path that manages to write it) is re-checked.
  o := pg_temp.fresh_order('ASSERT hold 8', 1000000, 400000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '8a. aligned';
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders set total_value = 2000000 where id = o;
  perform set_config('boe.amendment_context', '', true);
  assert pg_temp.alignment(o) = 'not_aligned' and (pg_temp.open_hold(o)).id is not null, '8a. a raw value write is held too';

  -- 8b. value_epoch cannot be written.
  v_ep := (select value_epoch from public.orders where id = o);
  update public.orders set value_epoch = 0 where id = o;
  assert (select value_epoch from public.orders where id = o) = v_ep, '8b. value_epoch is not writable';

  -- 8c. Clients read no holds or exceptions and cannot call the re-check.
  v_msg := pg_temp.try_as(current_setting('test.admin_id')::uuid, 'select count(*) from public.order_advance_holds');
  assert v_msg like 'permission denied%', '8c. no client reads holds directly: ' || v_msg;
  v_msg := pg_temp.try_as(current_setting('test.admin_id')::uuid, 'select count(*) from public.order_advance_exceptions');
  assert v_msg like 'permission denied%', '8c. nor exceptions: ' || v_msg;
  v_msg := pg_temp.try_as(current_setting('test.admin_id')::uuid,
    format('select public.order_advance_hold_recheck(%L, %L, %L)', o, 'value_changed', '{}'));
  assert v_msg like 'permission denied%', '8c. nor call the re-check: ' || v_msg;
  assert not has_table_privilege('service_role', 'public.order_advance_holds', 'INSERT')
     and not has_table_privilege('service_role', 'public.order_advance_exceptions', 'INSERT'),
    '8c. nor does the service role write them';
  -- The Sales owner reads the hold through readiness (the Order page).
  v_msg := pg_temp.try_as(current_setting('test.sales_id')::uuid, format('select public.order_advance_readiness(%L)', o));
  assert v_msg = 'OK', '8c. readiness is readable by whoever may open the Order: ' || v_msg;

  -- 8d. A hold is a record.
  begin
    update public.order_advance_holds set cause = 'value_changed', verified = 0 where order_id = o;
    v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'ORDER_ADVANCE_HOLD_IMMUTABLE%', '8d. a hold is not edited: ' || v_msg;
  raise notice '8. raw writes re-checked; epoch unwritable; holds unreadable and immutable to clients OK';
end $$;


-- ═══ 9. PHOTO KEYS (H1) ═════════════════════════════════════════════════════

do $$
declare
  s     uuid := gen_random_uuid();
  it    uuid := gen_random_uuid();
  h     text := repeat('e', 64);
  good  text;
  o     uuid;
  v_sub uuid;
  v_item uuid;
  v_prop jsonb;
  v_msg text;
  bad   text;
begin
  good := 'submissions/' || s || '/images/' || it || '/representative/0-' || h || '.png';
  assert public.order_pi_image_key_is_canonical(s, good, it::text, 'representative', '0', h), '9. the canonical key passes';
  foreach bad in array array[
    'submissions/' || s || '/images/../../../other-bucket/secret.png',
    'submissions/' || s || '/images/' || it || '/representative/../../../../x/0-' || h || '.png',
    'submissions/' || s || '/images/%2e%2e/%2e%2e/0-' || h || '.png',
    'submissions/' || s || '/images/' || it || '/representative/0-' || h || '.png/../x.png',
    'submissions/' || s || '/images/' || it || '\representative\0-' || h || '.png',
    'submissions/' || s || '/images//' || it || '/representative/0-' || h || '.png',
    'submissions/' || gen_random_uuid() || '/images/' || it || '/representative/0-' || h || '.png',
    '/submissions/' || s || '/images/' || it || '/representative/0-' || h || '.png',
    'submissions/' || s || '/images/' || it || '/representative/0-' || h || '.pdf',
    'submissions/' || s || '/images/' || it || '/representative/0-' || h || '.png ']
  loop
    assert not public.order_pi_image_key_is_canonical(s, bad), '9. refused: ' || bad;
  end loop;
  assert not public.order_pi_image_key_is_canonical(s, good, gen_random_uuid()::text), '9. another line''s key is refused';
  assert not public.order_pi_image_key_is_canonical(s, good, it::text, 'representative', '0', repeat('f', 64)), '9. another picture''s hash is refused';

  -- The propose door: an unapproved proposal cannot carry a foreign key.
  o := pg_temp.fresh_order('ASSERT hold 9', 1000000, 400000);
  select source_order_submission_id into v_sub from public.orders where id = o;
  select id into v_item from public.order_submission_items where submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', 'ASSERT/private/other-client.png', '{}'::jsonb);
  foreach bad in array array[
    'submissions/' || v_sub || '/images/../../../ASSERT/private/other-client.png',
    'submissions/' || v_sub || '/images/%2e%2e/%2e%2e/%2e%2e/ASSERT/private/other-client.png',
    'submissions/' || gen_random_uuid() || '/images/' || v_item || '/representative/0-' || h || '.png',
    'submissions/' || v_sub || '/images/' || v_item || '/representative/0-' || h || '.png']   -- canonical, but no such object
  loop
    v_prop := jsonb_build_object(
      'payload', jsonb_build_object(
        'header', '{}'::jsonb, 'commercial', jsonb_build_object('grand_total', 1000000),
        'source', jsonb_build_object('workbook_path', (select source_workbook_path from public.order_submissions where id = v_sub)),
        'items', jsonb_build_array(jsonb_build_object('id', v_item, 'item_sequence', 'B001', 'product_name', 'ASSERT hold chair',
                                                      'quantity', 10, 'cost_per_piece', 100000, 'total_amount', 1000000,
                                                      'image_storage_path', bad)),
        'item_images', jsonb_build_array(jsonb_build_object('item_id', v_item, 'role', 'representative', 'position', 0,
                                                            'storage_path', bad, 'mime_type', 'image/png', 'sha256', h)),
        'seed_terms', '{}'::jsonb),
      'change_summary', '[]'::jsonb);
    begin
      perform public.propose_order_pi_edit_revision(o, current_setting('test.sales_id')::uuid, v_prop, 'ASSERT malicious photo');
      v_msg := 'NO ERROR';
    exception when others then get stacked diagnostics v_msg = message_text;
    end;
    perform set_config('request.jwt.claims', '', true);
    assert v_msg like 'ORDER_PI_EDIT_INVALID: a product photo does not belong to this PI%',
      '9. the proposal is refused before it is stored: ' || bad || ' → ' || v_msg;
  end loop;
  assert not exists (select 1 from public.order_pi_versions where order_id = o and status = 'pending'),
    '9. and no pending version exists to render';
  raise notice '9. photo keys: traversal, encoded, foreign, missing and mismatched keys are refused OK';
end $$;


-- ═══ 10. A RETURNED PI KEEPS AN APPROVED EXCEPTION IN ITS OLD WORDS ═════════

do $$
declare
  v_sub   uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_wb    text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_msg   text;
  s       public.order_submissions%rowtype;
begin
  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', v_sales, v_sales, '[]', '[]');
  update public.order_submissions
     set client_name = 'ASSERT hold 10', gross_product_amount = 1000000, discount_amount = 0,
         grand_total = 1000000, source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64)
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_sub, 32, 'B001', 'ASSERT hold 10 chair', 10, 100000, 1000000, 0);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select v_sub, i.id, 'representative', 0,
         'submissions/' || v_sub || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png', 'image/png', repeat('c', 64), i.source_row
    from public.order_submission_items i where i.submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', m.storage_path, jsonb_build_object('mimetype', 'image/png') from public.order_submission_item_images m where m.submission_id = v_sub;

  -- Submitted below 40% with a reason, approved, then returned for an unrelated fix.
  v_msg := pg_temp.try_as(v_sales, format('select public.submit_pi_for_review(%L, null, %L, null, null)', v_sub, 'Other: ASSERT client pays on delivery'));
  assert v_msg = 'OK', '10. submitted below 40%: ' || v_msg;
  assert pg_temp.try_as(v_admin, format('select public.approve_pi_advance_exception(%L)', v_sub)) = 'OK', '10. exception approved';
  assert pg_temp.try_as(v_admin, format('select public.request_order_submission_changes(%L, %L)', v_sub, 'ASSERT fix the address')) = 'OK',
    '10. returned for changes';
  -- As a row from before the three reasons existed (the guards that keep an
  -- approved reason frozen are lifted for this one fixture write only).
  alter table public.order_submissions disable trigger order_submissions_guard_advance_exception;
  alter table public.order_submissions disable trigger order_submissions_guard_exception_reason_code;
  update public.order_submissions set advance_exception_reason = 'client pays on delivery (old wording)',
                                      advance_exception_reason_code = null where id = v_sub;
  alter table public.order_submissions enable trigger order_submissions_guard_advance_exception;
  alter table public.order_submissions enable trigger order_submissions_guard_exception_reason_code;
  select * into s from public.order_submissions where id = v_sub;
  assert s.status = 'needs_changes' and s.advance_exception_status = 'approved', '10. returned with its approval standing';

  -- A new free text is still refused…
  v_msg := pg_temp.try_as(v_sales, format('select public.submit_pi_for_review(%L, %L, %L, null, null)', v_sub, 'fixed', 'client will pay later'));
  assert v_msg like 'ORDER_SUBMISSION_EXCEPTION_REASON_INVALID%', '10. a new free-text reason is refused: ' || v_msg;
  -- …but the standing approval resubmits in its own words, still approved.
  v_msg := pg_temp.try_as(v_sales, format('select public.submit_pi_for_review(%L, %L, %L, null, null)', v_sub, 'fixed', 'client pays on delivery (old wording)'));
  assert v_msg = 'OK', '10. the approved exception resubmits unchanged: ' || v_msg;
  select * into s from public.order_submissions where id = v_sub;
  assert s.advance_exception_status = 'approved' and s.advance_exception_reason = 'client pays on delivery (old wording)'
     and s.status <> 'needs_changes', '10. and stays approved, word for word: ' || s.status || ' / ' || s.advance_exception_status;
  raise notice '10. a returned PI keeps its approved exception in the words it was approved in OK';
end $$;

-- ═══ 11. REVIEW FIXES R1–R8 ═════════════════════════════════════════════════

-- A second operations reviewer, and a readiness read as someone.
do $$
begin
  perform set_config('test.ops2_id', 'a0d00000-0000-4000-8000-000000000006', true);
  insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
    ('a0d00000-0000-4000-8000-000000000006', 'ASSERT Hold Ops 2', 'hold-ops2@suite.test', 'member', 'operations', true, 'HOLD-OP2')
  on conflict (id) do update set is_active = true;
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  select 'a0d00000-0000-4000-8000-000000000006'::uuid, mpa.module_id, mpa.action_id, true, 'a0d00000-0000-4000-8000-000000000001'::uuid
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'orders'
    join public.permission_actions pa on pa.id = mpa.action_id and pa.action_key in ('view', 'align_production')
  on conflict do nothing;
end $$;
create function pg_temp.set_reviewer(p_user uuid) returns text language plpgsql as $$
begin
  return pg_temp.try_as(current_setting('test.admin_id')::uuid, format('select public.set_order_operations_reviewer(%L)', p_user));
end $$;
create function pg_temp.decide_as(p_user uuid, p_order uuid, p_decision text, p_reason text default null) returns text language plpgsql as $$
declare h uuid;
begin
  select id into h from public.order_operations_handoffs where order_id = p_order and superseded_at is null;
  return pg_temp.try_as(p_user, format('select public.decide_order_operations_handoff(%L, %L, %L)', h, p_decision, p_reason));
end $$;
create function pg_temp.recover_as(p_user uuid, p_order uuid, p_reason text) returns text language plpgsql as $$
begin
  return pg_temp.try_as(p_user, format('select public.recover_order_production_alignment(%L, %L)', p_order, p_reason));
end $$;
create function pg_temp.realign_seen_by(p_user uuid, p_order uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.order_advance_readiness(p_order) -> 'realign';
  perform pg_temp.restore();
  return v;
end $$;

-- 11a. R1: the CURRENT reviewer re-aligns; the acceptance record is untouched;
-- reassigning alone aligns nothing; the former reviewer and an admin cannot.
do $$
declare
  o      uuid;
  v_ops  uuid := current_setting('test.ops_id')::uuid;
  v_ops2 uuid := current_setting('test.ops2_id')::uuid;
  v_hand public.order_operations_handoffs;
  v_hold uuid;
  v_msg  text;
  v_ev   public.order_activity_log;
begin
  o := pg_temp.fresh_order('ASSERT hold 11a', 1000000, 400000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '11a. accepted by the first reviewer';
  select * into v_hand from public.order_operations_handoffs where order_id = o and superseded_at is null;
  assert pg_temp.set_reviewer(v_ops2) = 'OK', '11a. the reviewer is reassigned';
  assert pg_temp.alignment(o) = 'aligned'
     and (select assigned_to from public.order_operations_handoffs where id = v_hand.id) = v_ops,
    '11a. reassignment changes nothing on an aligned, accepted Order';

  assert pg_temp.amend(o, 1250000) = 'OK', '11a. raised below 40%';
  v_hold := (pg_temp.open_hold(o)).id;
  assert v_hold is not null, '11a. held';
  assert exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production' and user_id = v_ops2),
    '11a. the CURRENT reviewer is told';
  assert not exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production' and user_id = v_ops),
    '11a. the former one is not';
  perform pg_temp.pay_order(o, 100000, 'approved_unlinked');

  -- Reassigning (back and forth) aligns nothing by itself.
  assert pg_temp.set_reviewer(v_ops) = 'OK' and pg_temp.set_reviewer(v_ops2) = 'OK', '11a. reassigned twice';
  assert pg_temp.alignment(o) = 'not_aligned' and (pg_temp.open_hold(o)).id = v_hold,
    '11a. reassignment alone does not align a held Order, even when it is ready';

  assert (pg_temp.realign_seen_by(v_ops2, o) ->> 'by_viewer')::boolean
     and not (pg_temp.realign_seen_by(v_ops, o) ->> 'by_viewer')::boolean
     and not (pg_temp.realign_seen_by(current_setting('test.admin_id')::uuid, o) ->> 'recover_by_viewer')::boolean,
    '11a. readiness offers the realignment to the current reviewer only, and no recovery while they can act';

  v_msg := pg_temp.decide_as(v_ops, o, 'accepted');
  assert v_msg like 'ORDER_REALIGN_NOT_CURRENT_REVIEWER%', '11a. the former reviewer cannot re-align: ' || v_msg;
  v_msg := pg_temp.recover_as(current_setting('test.admin_id')::uuid, o, 'ASSERT operations is away today');
  assert v_msg like 'ORDER_REALIGN_REVIEWER_AVAILABLE%', '11a. no admin recovery while a reviewer can act: ' || v_msg;
  v_msg := pg_temp.decide_as(v_ops2, o, 'accepted', 'ASSERT checked the new value and payment');
  assert v_msg = 'OK' and pg_temp.alignment(o) = 'aligned', '11a. the current reviewer re-aligns: ' || v_msg;

  assert (select accepted_by from public.order_operations_handoffs where id = v_hand.id) = v_ops
     and (select accepted_at from public.order_operations_handoffs where id = v_hand.id) = v_hand.accepted_at
     and (select assigned_to from public.order_operations_handoffs where id = v_hand.id) = v_ops
     and (select status from public.order_operations_handoffs where id = v_hand.id) = 'accepted',
    '11a. the original acceptance record is preserved';
  select * into v_ev from public.order_activity_log where order_id = o and event_type = 'operations_handoff_realigned';
  assert v_ev.actor_id = v_ops2 and v_ev.payload ->> 'realigned_by' = v_ops2::text
     and v_ev.payload ->> 'accepted_by' = v_ops::text and (v_ev.payload ->> 'hold_id')::uuid = v_hold
     and v_ev.payload ->> 'realigned_at' is not null,
    '11a. the realignment records the new actor and time beside the acceptance: ' || coalesce(v_ev.payload::text, 'none');
  assert (select production_aligned_by from public.orders where id = o) = v_ops2
     and (select resolved_by from public.order_advance_holds where id = v_hold) = v_ops2,
    '11a. the Order and the hold name who re-aligned it';
  raise notice '11a. R1: the current reviewer re-aligns; acceptance kept; reassignment aligns nothing; former reviewer and admin refused OK';
end $$;

-- 11b. R1: no reviewer who can act → a recorded admin recovery, gate enforced.
do $$
declare
  o      uuid;
  v_ops2 uuid := current_setting('test.ops2_id')::uuid;
  v_adm  uuid := current_setting('test.admin_id')::uuid;
  v_hand public.order_operations_handoffs;
  v_msg  text;
  v_ev   public.order_activity_log;
begin
  o := pg_temp.fresh_order('ASSERT hold 11b', 1000000, 400000);
  assert pg_temp.set_reviewer(v_ops2) = 'OK', '11b. reviewer';
  assert pg_temp.decide_as(v_ops2, o, 'accepted') = 'OK', '11b. accepted and aligned';
  select * into v_hand from public.order_operations_handoffs where order_id = o and superseded_at is null;
  assert pg_temp.amend(o, 1250000) = 'OK' and (pg_temp.open_hold(o)).id is not null, '11b. held';

  -- The reviewer leaves.
  update public.users set is_active = false where id = v_ops2;
  assert (pg_temp.realign_seen_by(v_adm, o) ->> 'recover_by_viewer')::boolean
     and not (pg_temp.realign_seen_by(v_adm, o) ->> 'reviewer_available')::boolean,
    '11b. readiness offers the admin the recovery once no reviewer can act';
  assert not (pg_temp.realign_seen_by(current_setting('test.sales_id')::uuid, o) ->> 'recover_by_viewer')::boolean,
    '11b. and nobody else';

  v_msg := pg_temp.recover_as(current_setting('test.sales_id')::uuid, o, 'ASSERT not my call to make');
  assert v_msg like 'Only an administrator%', '11b. only an administrator: ' || v_msg;
  v_msg := pg_temp.recover_as(v_adm, o, 'short');
  assert v_msg like 'ORDER_REALIGN_RECOVERY_REASON_REQUIRED%', '11b. a reason is required: ' || v_msg;
  v_msg := pg_temp.recover_as(v_adm, o, 'ASSERT reviewer left; client confirmed');
  assert v_msg like 'ORDER_ADVANCE_BELOW_THRESHOLD%' and pg_temp.alignment(o) = 'not_aligned',
    '11b. the 40% gate still decides: ' || v_msg;

  perform pg_temp.pay_order(o, 100000, 'approved_unlinked');
  v_msg := pg_temp.recover_as(v_adm, o, 'ASSERT reviewer left; client confirmed');
  assert v_msg = 'OK' and pg_temp.alignment(o) = 'aligned', '11b. recovered once ready: ' || v_msg;
  select * into v_ev from public.order_activity_log where order_id = o and event_type = 'operations_handoff_realigned_by_admin';
  assert v_ev.actor_id = v_adm and v_ev.payload ->> 'reviewer_unavailable' = 'reviewer_inactive'
     and v_ev.payload ->> 'reason' = 'ASSERT reviewer left; client confirmed'
     and v_ev.payload ->> 'accepted_by' = v_ops2::text,
    '11b. the recovery is its own event, with the admin, the reason and why no reviewer could: ' || coalesce(v_ev.payload::text, 'none');
  assert (select accepted_by from public.order_operations_handoffs where id = v_hand.id) = v_ops2
     and (select accepted_at from public.order_operations_handoffs where id = v_hand.id) = v_hand.accepted_at,
    '11b. the acceptance is untouched';
  assert (select resolved_by from public.order_advance_holds where order_id = o) = v_adm, '11b. the hold names the admin';
  assert pg_temp.recover_as(v_adm, o, 'ASSERT again please') like 'ORDER_REALIGN_NOT_HELD%', '11b. not on hold any more';

  -- No reviewer at all: Operations is told why; the admin may recover.
  update public.users set is_active = true where id = v_ops2;
  o := pg_temp.fresh_order('ASSERT hold 11b2', 1000000, 400000);
  assert pg_temp.decide_as(v_ops2, o, 'accepted') = 'OK', '11b. second Order aligned';
  assert pg_temp.amend(o, 1250000) = 'OK', '11b. held';
  perform pg_temp.pay_order(o, 100000, 'approved_unlinked');
  delete from public.order_operations_reviewers where duty = 'pi_handoff';
  assert pg_temp.alignment(o) = 'not_aligned', '11b. clearing the reviewer aligns nothing';
  assert pg_temp.decide_as(v_ops2, o, 'accepted') like 'ORDER_REALIGN_NO_REVIEWER%', '11b. no reviewer: refused with its reason';
  assert pg_temp.recover_as(v_adm, o, 'ASSERT no reviewer assigned yet') = 'OK', '11b. recovered';
  assert (select payload ->> 'reviewer_unavailable' from public.order_activity_log
           where order_id = o and event_type = 'operations_handoff_realigned_by_admin') = 'no_reviewer', '11b. and says there was none';
  insert into public.order_operations_reviewers (duty, user_id, assigned_by)
  values ('pi_handoff', current_setting('test.ops_id')::uuid, v_adm);
  raise notice '11b. R1: admin recovery only when no reviewer can act, with a reason, 40%% gate enforced, recorded OK';
end $$;

-- 11c. R2 + R8: a LOWER value that leaves the Order short is said as lowered;
-- an inactive reviewer is not notified.
do $$
declare o uuid;
begin
  o := pg_temp.fresh_order('ASSERT hold 11c', 1000000, 400000);
  assert pg_temp.amend(o, 2000000) = 'OK' and pg_temp.approve_exception(o) = 'OK', '11c. approved at 20,00,000';
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '11c. aligned under the exception';
  update public.users set is_active = false where id = current_setting('test.ops_id')::uuid;
  assert pg_temp.amend(o, 1500000) = 'OK', '11c. lowered to 15,00,000 (26.67%)';
  update public.users set is_active = true where id = current_setting('test.ops_id')::uuid;
  assert pg_temp.alignment(o) = 'not_aligned' and (pg_temp.open_hold(o)).cause = 'value_changed', '11c. still short: held';
  assert exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                   and user_id = current_setting('test.admin_id')::uuid and body like 'After its value was lowered,%'),
    '11c. R2: the notice says the value was lowered';
  assert not exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                       and user_id = current_setting('test.ops_id')::uuid),
    '11c. R8: the inactive reviewer is not notified';
  raise notice '11c. R2 lowered wording; R8 inactive reviewer not told OK';
end $$;

-- 11d. R5: a hold opened inside a PI revision names the approving admin, who
-- is not notified of their own action.
do $$
declare o uuid;
begin
  o := pg_temp.fresh_order('ASSERT hold 11d', 1000000, 400000);
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '11d. aligned';
  perform pg_temp.revalue(o, 1250000, 'ASSERT a third room');
  assert (pg_temp.open_hold(o)).held_by = current_setting('test.admin_id')::uuid,
    '11d. the hold names the approving admin: ' || coalesce(to_jsonb(pg_temp.open_hold(o))::text, 'none');
  assert (select actor_id from public.order_activity_log where order_id = o and event_type = 'order_advance_hold_opened')
         = current_setting('test.admin_id')::uuid, '11d. and so does its history event';
  assert not exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                       and user_id = current_setting('test.admin_id')::uuid), '11d. the approving admin is not told of their own action';
  assert exists (select 1 from public.notifications where entity_id = o and type = 'order_update_production'
                   and user_id = current_setting('test.admin2_id')::uuid
                   and body like 'After a revised PI raised its value,%'), '11d. the other admin is, in the right words';
  assert current_setting('boe.pi_revision_actor', true) is null or current_setting('boe.pi_revision_actor', true) = '',
    '11d. the revision actor does not outlive the apply';
  raise notice '11d. R5: the revision''s hold is authored by the approving admin OK';
end $$;

-- 11e. R6: a reversal voids an exception FOR GOOD; re-verifying the same money
-- does not revive it.
do $$
declare o uuid; a uuid; v_msg text;
begin
  o := pg_temp.fresh_order('ASSERT hold 11e', 1000000, 400000);
  a := pg_temp.pay_order(o, 100000, 'approved_unlinked');
  assert pg_temp.amend(o, 2500000) = 'OK' and pg_temp.approve_exception(o) = 'OK', '11e. approved at 5,00,000 verified';
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '11e. aligned';
  assert pg_temp.try_as(current_setting('test.fin_id')::uuid,
    format('select public.reverse_payment_allocation(%L, %L)', a, 'ASSERT bounced')) = 'OK', '11e. reversed';
  assert (select count(*) from public.order_advance_exception_voids v
           join public.order_advance_exceptions e on e.id = v.exception_id where e.order_id = o) = 1,
    '11e. the approval is voided';
  assert exists (select 1 from public.order_activity_log where order_id = o and event_type = 'order_advance_exception_voided'),
    '11e. and the void is on the history';
  perform pg_temp.pay_order(o, 100000, 'approved_unlinked');
  assert (public.order_advance_position(o) ->> 'verified')::numeric = 500000, '11e. the same money is verified again';
  assert not (public.order_advance_position(o) ->> 'ready')::boolean,
    '11e. the voided approval does not come back: ' || public.order_advance_position(o)::text;
  v_msg := pg_temp.ops_decide(o, 'accepted');
  assert v_msg like 'ORDER_ADVANCE_BELOW_THRESHOLD%', '11e. re-aligning needs a new decision: ' || v_msg;
  assert pg_temp.approve_exception(o) = 'OK', '11e. a new approval is possible';
  assert pg_temp.ops_decide(o, 'accepted') = 'OK', '11e. and then it re-aligns';
  begin
    delete from public.order_advance_exception_voids where order_id = o;
    v_msg := 'NO ERROR';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'ORDER_ADVANCE_EXCEPTION_VOID_PERMANENT%', '11e. a void cannot be undone: ' || v_msg;
  assert pg_temp.try_as(current_setting('test.admin_id')::uuid, 'select count(*) from public.order_advance_exception_voids')
         like 'permission denied%', '11e. clients read no voids';
  raise notice '11e. R6: a reversal voids an exception for good; re-verifying the money does not revive it OK';
end $$;

-- 11f. R7: the PI's own exception is held to the money verified when the
-- admin DECIDED it, not when it was requested; a reversal below that voids it.
do $$
declare
  v_sub   uuid := gen_random_uuid();
  v_sales uuid := current_setting('test.sales_id')::uuid;
  v_admin uuid := current_setting('test.admin_id')::uuid;
  v_wb    text := 'submissions/' || v_sub || '/original/' || gen_random_uuid() || '.xlsx';
  v_p1    uuid := gen_random_uuid();
  v_p2    uuid := gen_random_uuid();
  v_res   jsonb;
  o       uuid;
  a2      uuid;
  s       public.order_submissions%rowtype;
begin
  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (v_sub, 'draft', v_sales, v_sales, '[]', '[]');
  update public.order_submissions
     set client_name = 'ASSERT hold 11f', gross_product_amount = 1000000, discount_amount = 0,
         grand_total = 1000000, source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64)
   where id = v_sub;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_sub, 32, 'B001', 'ASSERT hold 11f chair', 10, 100000, 1000000, 0);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select v_sub, i.id, 'representative', 0,
         'submissions/' || v_sub || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png', 'image/png', repeat('c', 64), i.source_row
    from public.order_submission_items i where i.submission_id = v_sub;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', m.storage_path, jsonb_build_object('mimetype', 'image/png') from public.order_submission_item_images m where m.submission_id = v_sub;
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_p1, 'ASSERT hold', 100000, current_date, 'hdfc', 'approved_unlinked', v_sales, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_p1, v_sub, 100000, 'order_submission', v_sales);
  assert pg_temp.try_as(v_sales, format('select public.submit_pi_for_review(%L, null, %L, null, null)', v_sub, 'Sample order')) = 'OK',
    '11f. requested at 10% verified';
  -- More money is verified before the admin decides.
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_p2, 'ASSERT hold', 150000, current_date, 'hdfc', 'approved_unlinked', v_sales, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_p2, v_sub, 150000, 'order_submission', v_sales) returning id into a2;
  assert pg_temp.try_as(v_admin, format('select public.approve_pi_advance_exception(%L)', v_sub)) = 'OK', '11f. decided';
  select * into s from public.order_submissions where id = v_sub;
  assert s.advance_exception_decided_verified = 250000 and s.advance_exception_percent = 10,
    '11f. the decision records the money verified NOW (2,50,000), the request its own snapshot (10%): '
    || coalesce(s.advance_exception_decided_verified::text, 'null') || ' / ' || coalesce(s.advance_exception_percent::text, 'null');
  assert exists (select 1 from public.order_submission_activity where submission_id = v_sub and action = 'advance_exception_approved'
                   and (metadata ->> 'decided_verified')::numeric = 250000 and (metadata ->> 'decided_percent')::numeric = 25),
    '11f. and logs it with its percentage';
  perform pg_temp.become(v_admin);
  if (select pi_approved_at from public.order_submissions where id = v_sub) is null then
    perform public.approve_pi_review(v_sub);
  end if;
  v_res := public.approve_order_submission(v_sub, v_sales, current_date, current_date + 30, 'reference');
  perform pg_temp.restore();
  o := (v_res ->> 'order_id')::uuid;
  assert (public.order_advance_position(o) ->> 'ready')::boolean and public.order_advance_position(o) #>> '{exception,source}' = 'pi',
    '11f. ready under the PI''s exception';
  -- Reverse the money added before the decision: 1,00,000 is still above the
  -- 10% requested, but below the 2,50,000 the admin decided on.
  select id into a2 from public.finance_payment_allocations where payment_request_id = v_p2 and status = 'active';
  assert pg_temp.try_as(current_setting('test.fin_id')::uuid,
    format('select public.reverse_payment_allocation(%L, %L)', a2, 'ASSERT bounced')) = 'OK', '11f. reversed';
  assert not (public.order_advance_position(o) ->> 'ready')::boolean,
    '11f. below the money it was decided on: not ready: ' || public.order_advance_position(o)::text;
  assert exists (select 1 from public.order_advance_exception_voids where order_id = o and exception_id is null),
    '11f. the PI''s own exception is voided for good';
  raise notice '11f. R7: the PI''s exception is held to the money verified at the decision OK';
end $$;

-- 11g. R4: an image row missing a part, or a line picture with no line id,
-- is refused even when the key is this PI's own existing picture.
do $$
declare o uuid; v_sub uuid; v_item uuid; v_key text; v_sha text; v_prop jsonb; v_msg text; v_case jsonb;
begin
  o := pg_temp.fresh_order('ASSERT hold 11g', 1000000, 400000);
  select source_order_submission_id into v_sub from public.orders where id = o;
  select item_id, storage_path, sha256 into v_item, v_key, v_sha from public.order_submission_item_images where submission_id = v_sub;
  foreach v_case in array array[
    jsonb_build_object('images', jsonb_build_array(jsonb_build_object('storage_path', v_key)), 'items_image', null),
    jsonb_build_object('images', jsonb_build_array(jsonb_build_object('storage_path', v_key, 'item_id', v_item, 'role', 'representative', 'position', 0)), 'items_image', null),
    jsonb_build_object('images', '[]'::jsonb, 'items_image', v_key, 'no_item_id', true)]
  loop
    v_prop := jsonb_build_object(
      'payload', jsonb_build_object(
        'header', '{}'::jsonb, 'commercial', jsonb_build_object('grand_total', 1000000),
        'source', jsonb_build_object('workbook_path', (select source_workbook_path from public.order_submissions where id = v_sub)),
        'items', jsonb_build_array((jsonb_build_object('item_sequence', 'B001', 'product_name', 'ASSERT hold chair',
                                                      'quantity', 10, 'cost_per_piece', 100000, 'total_amount', 1000000,
                                                      'image_storage_path', v_case ->> 'items_image')
                                   || case when v_case ? 'no_item_id' then '{}'::jsonb else jsonb_build_object('id', v_item) end)),
        'item_images', v_case -> 'images',
        'seed_terms', '{}'::jsonb),
      'change_summary', '[]'::jsonb);
    begin
      perform public.propose_order_pi_edit_revision(o, current_setting('test.sales_id')::uuid, v_prop, 'ASSERT partial photo row');
      v_msg := 'NO ERROR';
    exception when others then get stacked diagnostics v_msg = message_text;
    end;
    perform set_config('request.jwt.claims', '', true);
    assert v_msg like 'ORDER_PI_EDIT_INVALID: a product photo does not belong to this PI%',
      '11g. refused: ' || v_case::text || ' → ' || v_msg;
  end loop;
  raise notice '11g. R4: image rows with missing parts, and line pictures with no line, are refused OK';
end $$;

do $$ begin raise notice 'ALL ADVANCE-HOLD ASSERTIONS PASSED'; end $$;

rollback;
