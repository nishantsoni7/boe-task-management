-- ORDER 0524 ONE-TIME HANDOFF assertions (20261230000000)
-- ===========================================================================
-- EXECUTES the migration's own text against a fixture shaped like production's
-- Order 0524: a PI V1 approved by an admin BEFORE the handoff trigger existed
-- (the trigger is disabled for that one approval), no handoff, not aligned,
-- and an operations reviewer configured through the real Control Center door.
--
-- The migration pins production's ids. Here each pinned constant is replaced by
-- the fixture's (pg_temp.migration_for), the rest of the text is executed
-- exactly as written, and every replacement is checked to have happened.
--
--   * absent        the file UNMODIFIED, on a database without the Order,
--                   writes nothing
--   * stop          every expectation that no longer holds — number, id,
--                   approver, approval time, version count, alignment,
--                   reviewer identity, reviewer active — raises and writes
--                   nothing
--   * the fix       one awaiting handoff for V1, addressed to the reviewer;
--                   approved_by / approved_at are V1's own; created_at is now;
--                   one history entry with no actor marked as recorded late;
--                   one review notification, to the reviewer only; the version
--                   and the Order's alignment untouched
--   * repeat        a second run writes nothing — no second row, entry or
--                   notification
--   * authority     the approving admin and another admin cannot decide it,
--                   through the decision door OR the old alignment door; the
--                   reviewer can, and Cannot accept requires a reason
--
-- The migration text arrives as the session setting test.migration, set by
-- supabase/tests/run_order_0524_operations_handoff_local.sh before this file.
-- Runs inside ONE transaction that ends in ROLLBACK.
--
-- On success prints NOTICE 'ALL ORDER 0524 HANDOFF ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id',    '11111111-1111-1111-1111-111111111111', true); -- TEST-001, admin: the approver
  perform set_config('test.reviewer_id', '22222222-2222-2222-2222-222222222222', true); -- operations manager: the reviewer
  perform set_config('test.admin2_id',   '33333333-3333-3333-3333-333333333333', true); -- another active admin
  perform set_config('test.sales_id',    '55555555-5555-5555-5555-555555555555', true); -- the PI's salesperson
  perform set_config('test.pi', gen_random_uuid()::text, true);
  if coalesce(current_setting('test.migration', true), '') not like '%ORDER_0524_HANDOFF%' then
    raise exception 'ASSERT: test.migration is not set to the migration text; run through the runner';
  end if;
end $$;

-- ═══ 0. FIXTURES ════════════════════════════════════════════════════════════

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.reviewer_id')::uuid, 'ASSERT Reviewer',  'reviewer@example.test', 'manager', 'operations', true, 'ASSERT-OPS'),
  (current_setting('test.admin2_id')::uuid,   'ASSERT Admin Two', 'admin2@example.test',   'admin',   'management', true, 'ASSERT-ADM'),
  (current_setting('test.sales_id')::uuid,    'ASSERT Sales',     'sales@example.test',    'member',  'sales',      true, 'ASSERT-SAL')
on conflict (id) do nothing;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.reviewer_id')::uuid, pm.id, pa.id, true, current_setting('test.owner_id')::uuid
  from public.permission_modules pm join public.permission_actions pa on pa.action_key = 'view'
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

create function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'ASSERT FAILED: %', p_label; end if;
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

-- Everything the migration could write, counted in one place.
create function pg_temp.footprint() returns text language sql as $$
  select format('handoffs=%s activity=%s notifications=%s alignment_events=%s',
    (select count(*) from public.order_operations_handoffs),
    (select count(*) from public.order_activity_log where event_type = 'operations_handoff_recorded'),
    (select count(*) from public.notifications where type::text like 'order_operations_review%'),
    (select count(*) from public.order_activity_log where event_type = 'production_alignment_changed'));
$$;

-- The migration's text with its pinned constants replaced. Each replacement
-- must match exactly once, so a renamed constant cannot silently leave a
-- production id in place.
create function pg_temp.migration_for(
  p_display text, p_order uuid, p_version uuid, p_submission uuid,
  p_approved_by uuid, p_approved_at timestamptz, p_reviewer uuid
) returns text language plpgsql as $$
declare
  v_sql  text := current_setting('test.migration');
  v_pair text[];
  v_new  text;
begin
  foreach v_pair slice 1 in array array[
    array['c_display_number',  'text',        p_display],
    array['c_order_id',        'uuid',        p_order::text],
    array['c_version_id',      'uuid',        p_version::text],
    array['c_submission_id',   'uuid',        p_submission::text],
    array['c_approved_by',     'uuid',        p_approved_by::text],
    array['c_approved_at',     'timestamptz', p_approved_at::text],
    array['c_reviewer_id',     'uuid',        p_reviewer::text]]
  loop
    if (select count(*) from regexp_matches(v_sql, v_pair[1] || '\s+constant ' || v_pair[2] || '\s+:= ''[^'']*''', 'g')) <> 1 then
      raise exception 'ASSERT: the migration does not declare % exactly once', v_pair[1];
    end if;
    v_new := regexp_replace(v_sql, '(' || v_pair[1] || '\s+constant ' || v_pair[2] || '\s+:= )''[^'']*''', '\1''' || v_pair[3] || '''');
    v_sql := v_new;
  end loop;
  return v_sql;
end $$;

-- The fixture's own values, and one call with any of them overridden.
create function pg_temp.run(p_over jsonb default '{}') returns void language plpgsql as $$
begin
  execute pg_temp.migration_for(
    coalesce(p_over ->> 'display',     current_setting('test.display')),
    coalesce(p_over ->> 'order',       current_setting('test.order_id'))::uuid,
    coalesce(p_over ->> 'version',     current_setting('test.version_id'))::uuid,
    coalesce(p_over ->> 'submission',  current_setting('test.pi'))::uuid,
    coalesce(p_over ->> 'approved_by', current_setting('test.owner_id'))::uuid,
    coalesce(p_over ->> 'approved_at', current_setting('test.approved_at'))::timestamptz,
    coalesce(p_over ->> 'reviewer',    current_setting('test.reviewer_id'))::uuid);
end $$;

-- A submitted PI, as 20261229's assertions build it.
do $$
declare
  p_id    uuid := current_setting('test.pi')::uuid;
  p_owner uuid := current_setting('test.owner_id')::uuid;
  p_total numeric := 100000;
  v_item  uuid := gen_random_uuid();
  v_wb    text := 'submissions/' || p_id::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha   text := repeat('a', 64);
  v_img   text;
begin
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total,
     source_workbook_path, source_workbook_sha256, source_workbook_name, parse_warnings, parse_blocking_issues, reservation_required)
  values (p_id, 'draft', p_owner, p_owner, 'ASSERT 0524', p_total, 0, p_total, v_wb, v_sha, 'pi.xlsx', '[]', '[]', false);
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
  select id, p_id, amount, 'order_submission', p_owner from public.finance_payment_requests where client_name = 'ASSERT' and amount = p_total * 0.4;
  update public.order_submissions set status = 'submitted', submitted_at = now() where id = p_id;
end $$;

-- ── THE LEGACY APPROVAL: V1 approved before the handoff trigger existed ──
alter table public.order_pi_versions disable trigger order_pi_versions_record_operations_handoff;
do $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  v := public.approve_order_submission(current_setting('test.pi')::uuid, current_setting('test.sales_id')::uuid,
                                       current_date, current_date + 30, 'reference');
  perform pg_temp.restore();
  perform set_config('test.order_id', v ->> 'order_id', true);
end $$;
alter table public.order_pi_versions enable trigger order_pi_versions_record_operations_handoff;
-- ...and two days ago, as 0524's was: otherwise the approval and the handoff
-- share this transaction's now() and "kept the approval time" proves nothing.
-- The version guard freezes decided_at, so it steps aside for this one write.
alter table public.order_pi_versions disable trigger order_pi_versions_guard;
update public.order_pi_versions set decided_at = now() - interval '2 days'
 where order_id = current_setting('test.order_id')::uuid;
alter table public.order_pi_versions enable trigger order_pi_versions_guard;

-- The reviewer, configured through the real Control Center door.
do $$
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.set_order_operations_reviewer(current_setting('test.reviewer_id')::uuid);
  perform pg_temp.restore();
end $$;

do $$
declare
  v_order   public.orders%rowtype;
  v_version public.order_pi_versions%rowtype;
begin
  select * into v_order from public.orders where id = current_setting('test.order_id')::uuid;
  select * into v_version from public.order_pi_versions where order_id = v_order.id;
  perform set_config('test.display', v_order.display_number, true);
  perform set_config('test.version_id', v_version.id::text, true);
  perform set_config('test.approved_at', v_version.decided_at::text, true);

  perform pg_temp.check(v_order.status = 'running', 'fixture: the Order is running, as 0524 is');
  perform pg_temp.check(v_order.production_alignment = 'not_aligned', 'fixture: not aligned');
  perform pg_temp.check(v_version.version_number = 1 and v_version.status = 'approved'
                        and v_version.decided_by = current_setting('test.owner_id')::uuid, 'fixture: V1 approved by the admin');
  perform pg_temp.check(not exists (select 1 from public.order_operations_handoffs where order_id = v_order.id),
                        'fixture: the legacy approval has NO handoff, as 0524 has none');
  perform pg_temp.check(not exists (select 1 from public.orders where display_number = '0524'),
                        'fixture: no Order in this database is numbered 0524');
  perform pg_temp.check((select user_id from public.order_operations_reviewers where duty = 'pi_handoff')
                        = current_setting('test.reviewer_id')::uuid, 'fixture: the reviewer is configured');
end $$;

-- ═══ 1. ABSENT: the file as written, on a database without the Order ═══════

do $$
declare v_before text := pg_temp.footprint();
begin
  execute current_setting('test.migration');
  perform pg_temp.check(pg_temp.footprint() = v_before, 'absent: the unmodified file writes nothing here');
end $$;

-- ═══ 2. STOP: every expectation that no longer holds ═══════════════════════

do $$
declare
  v_before text := pg_temp.footprint();
  v_order  uuid := current_setting('test.order_id')::uuid;
begin
  perform pg_temp.expect_error($q$select pg_temp.run('{"display":"9999"}')$q$,
    'ORDER_0524_HANDOFF_MISMATCH', 'the Order carries another number');
  perform pg_temp.expect_error(format($q$select pg_temp.run('{"order":"%s"}')$q$, gen_random_uuid()),
    'ORDER_0524_HANDOFF_MISMATCH: an Order numbered', 'the number exists under another id');
  perform pg_temp.expect_error(format($q$select pg_temp.run('{"approved_by":"%s"}')$q$, current_setting('test.admin2_id')),
    'PI V1 approval is by', 'another approver');
  perform pg_temp.expect_error(format($q$select pg_temp.run('{"approved_at":"%s"}')$q$, (current_setting('test.approved_at')::timestamptz - interval '1 second')::text),
    'PI V1 approval is by', 'another approval time');
  perform pg_temp.expect_error(format($q$select pg_temp.run('{"version":"%s"}')$q$, gen_random_uuid()),
    'is not Order', 'another version');
  perform pg_temp.expect_error(format($q$select pg_temp.run('{"submission":"%s"}')$q$, gen_random_uuid()),
    'is not built from PI submission', 'another submission');
  perform pg_temp.expect_error(format($q$select pg_temp.run('{"reviewer":"%s"}')$q$, current_setting('test.admin2_id')),
    'the configured operations reviewer is', 'the configured reviewer is not the one named');

  -- The reviewer is no longer active: stop, do not address an inactive account.
  perform pg_temp.expect_error(format($q$
    do $d$ begin
      update public.users set is_active = false where id = '%s';
      perform pg_temp.run();
    end $d$ $q$, current_setting('test.reviewer_id')),
    'is not an active account', 'the reviewer was deactivated');

  -- The Order was aligned in the meantime (the legacy door still works on it).
  perform pg_temp.expect_error(format($q$
    do $d$ begin
      perform pg_temp.become('%s');
      perform public.set_order_production_alignment('%s', true, 'aligned the old way');
      perform pg_temp.restore();
      perform pg_temp.run();
    end $d$ $q$, current_setting('test.owner_id'), v_order),
    'production alignment is aligned', 'the Order was aligned');

  -- A revised version is waiting.
  perform pg_temp.expect_error(format($q$
    do $d$ begin
      insert into public.order_pi_versions (order_id, submission_id, version_number, status, workbook_path, workbook_name, uploaded_by, revision_reason)
      values ('%s', '%s', 2, 'pending', 'submissions/x/original/rev.xlsx', 'rev.xlsx', '%s', 'ASSERT');
      perform pg_temp.run();
    end $d$ $q$, v_order, current_setting('test.pi'), current_setting('test.sales_id')),
    'has 2 PI versions', 'a second version exists');

  -- The Order was cancelled, through the one cancellation door.
  perform pg_temp.expect_error(format($q$
    do $d$ begin
      perform pg_temp.become('%s');
      perform public.cancel_order('%s', 'ASSERT cancelled');
      perform pg_temp.restore();
      perform pg_temp.run();
    end $d$ $q$, current_setting('test.owner_id'), v_order),
    'expected running', 'the Order is no longer running');

  perform pg_temp.check(pg_temp.footprint() = v_before, 'stop: no refusal wrote anything (' || v_before || ')');
end $$;

-- ═══ 3. THE FIX ════════════════════════════════════════════════════════════

do $$
declare
  v_order_id   uuid := current_setting('test.order_id')::uuid;
  v_reviewer   uuid := current_setting('test.reviewer_id')::uuid;
  v_owner      uuid := current_setting('test.owner_id')::uuid;
  v_version_before jsonb;
  v_order_before   jsonb;
  v_h          public.order_operations_handoffs%rowtype;
  v_log        public.order_activity_log%rowtype;
  v_n          public.notifications%rowtype;
begin
  select to_jsonb(v) into v_version_before from public.order_pi_versions v where order_id = v_order_id;
  select to_jsonb(o) - 'updated_at' into v_order_before from public.orders o where id = v_order_id;

  perform pg_temp.run();

  perform pg_temp.check((select count(*) from public.order_operations_handoffs where order_id = v_order_id) = 1, 'fix: exactly one handoff');
  select * into v_h from public.order_operations_handoffs where order_id = v_order_id;
  perform pg_temp.check(v_h.pi_version_id = current_setting('test.version_id')::uuid and v_h.version_number = 1, 'fix: for V1');
  perform pg_temp.check(v_h.submission_id = current_setting('test.pi')::uuid, 'fix: the Order''s own PI');
  perform pg_temp.check(v_h.status = 'awaiting', 'fix: awaiting — nothing accepted');
  perform pg_temp.check(v_h.accepted_by is null and v_h.clarification_by is null, 'fix: no decision recorded');
  perform pg_temp.check(v_h.approved_by = v_owner, 'fix: the historic approver');
  perform pg_temp.check(v_h.approved_at = current_setting('test.approved_at')::timestamptz
                        and v_h.approved_at = now() - interval '2 days', 'fix: the historic approval time, unchanged');
  perform pg_temp.check(v_h.assigned_to = v_reviewer and v_h.unassigned_reason is null, 'fix: addressed to the configured reviewer');
  perform pg_temp.check(v_h.assigned_at = now() and v_h.created_at = now(), 'fix: the handoff itself is recorded now');
  perform pg_temp.check(v_h.production_alignment_at_approval = 'not_aligned' and v_h.prior_handoff_status is null
                        and v_h.superseded_at is null, 'fix: the live handoff, snapshotting not_aligned');

  perform pg_temp.check((select count(*) from public.order_activity_log
                          where order_id = v_order_id and event_type = 'operations_handoff_recorded') = 1, 'fix: one history entry');
  select * into v_log from public.order_activity_log where order_id = v_order_id and event_type = 'operations_handoff_recorded';
  perform pg_temp.check(v_log.actor_id is null, 'fix: no person is named as having done it');
  perform pg_temp.check((v_log.payload ->> 'handoff_id')::uuid = v_h.id
                        and (v_log.payload ->> 'recorded_for_existing_approval')::boolean
                        and v_log.payload ->> 'recorded_by_migration' = '20261230000000_order_0524_operations_handoff_for_existing_approval'
                        and (v_log.payload ->> 'approved_at')::timestamptz = v_h.approved_at
                        and (v_log.payload ->> 'approved_by')::uuid = v_owner
                        and (v_log.payload ->> 'assigned_to')::uuid = v_reviewer
                        and (v_log.payload ->> 'version_number')::int = 1, 'fix: the entry says what happened, and that it is late');

  perform pg_temp.check((select count(*) from public.notifications where entity_id = v_order_id and type::text like 'order_operations_review%') = 1,
                        'fix: one notification');
  select * into v_n from public.notifications where entity_id = v_order_id and type::text like 'order_operations_review%';
  perform pg_temp.check(v_n.user_id = v_reviewer and v_n.type = 'order_operations_review_requested', 'fix: the review request, to the reviewer');
  perform pg_temp.check(v_n.title = format('Order %s: existing PI V1 sent for your operations review', current_setting('test.display')),
                        'fix: the title says V1 was sent now: ' || v_n.title);
  perform pg_temp.check(v_n.body = format('Original approval: Test Owner, %s. PI V1 was approved before operations review was recorded and has been sent to you now. Open the Order, review PI V1, then choose Accept for production or Cannot accept.',
                                          to_char((now() - interval '2 days') at time zone 'Asia/Kolkata', 'FMDD FMMonth YYYY')),
                        'fix: the body names the original approver and date: ' || v_n.body);
  perform pg_temp.check(v_n.title not like '%approved by%', 'fix: not worded as a new approval');
  perform pg_temp.check(not v_n.is_read, 'fix: unread');

  perform pg_temp.check((select to_jsonb(v) from public.order_pi_versions v where order_id = v_order_id) = v_version_before,
                        'fix: the PI version row is untouched (no V2, no new approval time or approver)');
  perform pg_temp.check((select to_jsonb(o) - 'updated_at' from public.orders o where id = v_order_id) = v_order_before,
                        'fix: the Order row is untouched — alignment included');
end $$;

-- ═══ 4. REPEAT: harmless ═══════════════════════════════════════════════════

do $$
declare v_before text := pg_temp.footprint();
begin
  perform pg_temp.run();
  perform pg_temp.check(pg_temp.footprint() = v_before, 'repeat: a second run writes nothing');
  -- and the unique version key would refuse a concurrent second insert anyway
  perform pg_temp.expect_error(format($q$
    insert into public.order_operations_handoffs (order_id, pi_version_id, submission_id, version_number, approved_at, production_alignment_at_approval, unassigned_reason)
    values ('%s', '%s', '%s', 1, now(), 'not_aligned', 'no_reviewer')$q$,
    current_setting('test.order_id'), current_setting('test.version_id'), current_setting('test.pi')),
    'duplicate key', 'repeat: one handoff per version, at the table');
end $$;

-- ═══ 5. AUTHORITY: only the assigned reviewer decides ══════════════════════

do $$
declare
  v_order uuid := current_setting('test.order_id')::uuid;
  v_h     uuid := (select id from public.order_operations_handoffs where order_id = current_setting('test.order_id')::uuid);
  v_admin uuid;
begin
  foreach v_admin in array array[current_setting('test.owner_id')::uuid, current_setting('test.admin2_id')::uuid] loop
    perform pg_temp.expect_error(format($q$
      do $d$ begin
        perform pg_temp.become('%s');
        perform public.decide_order_operations_handoff('%s', 'accepted', null);
      end $d$ $q$, v_admin, v_h),
      'Only the assigned operations reviewer can decide this handoff', 'an admin cannot accept');
    perform pg_temp.expect_error(format($q$
      do $d$ begin
        perform pg_temp.become('%s');
        perform public.decide_order_operations_handoff('%s', 'clarification_needed', 'no');
      end $d$ $q$, v_admin, v_h),
      'Only the assigned operations reviewer can decide this handoff', 'an admin cannot flag');
    -- THE OLD HEADER DOOR: an admin who could align this Order yesterday cannot now.
    perform pg_temp.expect_error(format($q$
      do $d$ begin
        perform pg_temp.become('%s');
        perform public.set_order_production_alignment('%s', true, null);
      end $d$ $q$, v_admin, v_order),
      'Only the assigned operations reviewer can decide this handoff', 'an admin cannot align through the old door');
  end loop;
  perform pg_temp.check((select status from public.order_operations_handoffs where id = v_h) = 'awaiting'
                        and (select production_alignment from public.orders where id = v_order) = 'not_aligned',
                        'authority: nothing moved');

  -- Both admins still SEE it (status and history) through RLS.
  perform pg_temp.become(current_setting('test.admin2_id')::uuid);
  perform pg_temp.check((select count(*) from public.order_operations_handoffs where order_id = v_order) = 1, 'another admin reads the handoff');
  perform pg_temp.restore();

  -- The reviewer: Cannot accept needs a reason; with one, it is recorded.
  perform pg_temp.expect_error(format($q$
    do $d$ begin
      perform pg_temp.become('%s');
      perform public.decide_order_operations_handoff('%s', 'clarification_needed', '  ');
    end $d$ $q$, current_setting('test.reviewer_id'), v_h),
    'ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED', 'the reviewer must give a reason');
  perform pg_temp.become(current_setting('test.reviewer_id')::uuid);
  perform public.decide_order_operations_handoff(v_h, 'accepted', null);
  perform pg_temp.restore();
  perform pg_temp.check((select status from public.order_operations_handoffs where id = v_h) = 'accepted'
                        and (select production_alignment from public.orders where id = v_order) = 'aligned',
                        'the reviewer accepts, and that aligns the Order');
end $$;

do $$ begin raise notice 'ALL ORDER 0524 HANDOFF ASSERTIONS PASSED'; end $$;

rollback;
