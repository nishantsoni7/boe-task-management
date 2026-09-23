-- PI-TO-OPERATIONS HANDOFF assertions (20261229000000)
-- ===========================================================================
-- Validates, through the REAL doors:
--
--   * recording     approve_order_submission() records ONE awaiting handoff for
--                   V1, inside its own transaction; a retry records nothing new
--   * recipient     resolved through order_operations_reviewers + an ACTIVE user
--                   record; nobody assigned → unassigned, visibly, no admin in
--                   their place
--   * assignment    choosing someone readdresses every live UNRESOLVED handoff
--                   (awaiting AND flagged); clearing UNASSIGNS them all; the
--                   former reviewer can then decide nothing; a deactivated
--                   reviewer can decide nothing and new handoffs go unassigned
--   * notification  the reviewer is told once per handoff; the approver is told
--                   the decision; the approver is never told their own approval
--   * ONE DECISION  accepting ALIGNS the Order; flagging / withdrawing takes the
--                   alignment back; set_order_production_alignment() on a
--                   handoff Order IS that decision — an admin holding
--                   orders.align_production is refused, the reviewer is not
--   * versions      approving V2 supersedes V1's handoff KEEPING its decision,
--                   RESETS the alignment (recorded), records a new awaiting
--                   handoff snapshotting the alignment and the prior decision;
--                   accepting the superseded one is refused
--   * legacy        an Order with no handoff keeps the 20261119 alignment rule
--   * closure       a cancelled Order's handoff cannot be decided
--   * privileges    anon executes nothing; clients read only; the guard refuses
--                   deletion and any silent edit of a decision
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES (disposable local stack, the whole chain through 20261229000000):
--   * psql as a role that bypasses RLS and may SET the `role` GUC.
--   * The `order-files` bucket exists (20260908000000).
--   * A user with employee_code TEST-001 (the owner's permanent approve_order
--     grant, 20261224000000) whose id is test.owner_id below.
--
-- On success prints NOTICE 'ALL HANDOFF ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id',    '11111111-1111-1111-1111-111111111111', true); -- TEST-001, admin
  perform set_config('test.reviewer_id', '22222222-2222-2222-2222-222222222222', true); -- operations, orders.view
  perform set_config('test.admin2_id',   '33333333-3333-3333-3333-333333333333', true); -- another active admin
  perform set_config('test.outsider_id', '44444444-4444-4444-4444-444444444444', true); -- no Orders relationship
  perform set_config('test.sales_id',    '55555555-5555-5555-5555-555555555555', true); -- the PI's owner
  perform set_config('test.reviewer2_id','66666666-6666-6666-6666-666666666666', true); -- a replacement reviewer
  perform set_config('test.viewer_id',   '77777777-7777-7777-7777-777777777777', true); -- orders.view only, team design
  perform set_config('test.pi_a', gen_random_uuid()::text, true);
  perform set_config('test.pi_b', gen_random_uuid()::text, true);
  perform set_config('test.pi_c', gen_random_uuid()::text, true);
  perform set_config('test.pi_d', gen_random_uuid()::text, true);
  perform set_config('test.pi_e', gen_random_uuid()::text, true);
  perform set_config('test.pi_f', gen_random_uuid()::text, true);
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

-- ═══ 1. NO REVIEWER ASSIGNED: recorded, unassigned, no admin substituted ═══

select pg_temp.make_pi(current_setting('test.pi_a')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT A', 1000000);
select set_config('test.order_a', pg_temp.approve(current_setting('test.pi_a')::uuid)::text, true);

do $$
declare h public.order_operations_handoffs; o uuid := current_setting('test.order_a')::uuid;
begin
  h := pg_temp.live(o);
  perform pg_temp.check(h.id is not null, '1. a handoff is recorded for V1 at approval');
  perform pg_temp.check(h.version_number = 1 and h.status = 'awaiting', '1. it is V1, awaiting');
  perform pg_temp.check(h.assigned_to is null and h.assigned_at is null, '1. nobody assigned → unassigned, not an admin');
  perform pg_temp.check(h.unassigned_reason = 'no_reviewer', '1. …and the row says why');
  perform pg_temp.check(h.approved_by = current_setting('test.owner_id')::uuid, '1. the approver is recorded');
  perform pg_temp.check(h.production_alignment_at_approval = 'not_aligned', '1. alignment snapshot: not aligned');
  perform pg_temp.check(pg_temp.alignment(o) = 'not_aligned', '1. every Order is born not aligned');
  -- Nobody is addressed as reviewer. The ADMINISTRATORS are told there is
  -- nobody to address — that is what keeps an unassigned handoff from going
  -- unseen — and no non-admin hears anything.
  perform pg_temp.check((select count(*) from public.notifications n join public.users u on u.id = n.user_id
     where n.entity_id = o and u.role <> 'admin') = 0,
    '1. no reviewer → no non-admin is notified (nobody in the reviewer''s place)');
  perform pg_temp.check((select count(*) from public.notifications where entity_id = o
     and user_id = current_setting('test.owner_id')::uuid and title like '%no operations reviewer can take it%') = 1,
    '1. …and every active admin (the approver included) is told to assign one');
  perform pg_temp.check((select count(*) from public.notifications where entity_id = o
     and user_id = current_setting('test.admin2_id')::uuid) = 1, '1. …the other admin too');
  perform pg_temp.check(pg_temp.events(o, 'operations_handoff_recorded') = 1, '1. one history event');
  perform pg_temp.check((select pi_version_id from public.order_operations_handoffs where order_id = o)
     = (select id from public.order_pi_versions where order_id = o and status = 'approved'),
    '1. the handoff names the exact approved version id');
end $$;

-- Retrying the approval changes nothing: same Order, still one handoff.
do $$
declare v jsonb; o uuid := current_setting('test.order_a')::uuid;
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  v := public.approve_order_submission(current_setting('test.pi_a')::uuid, current_setting('test.sales_id')::uuid, current_date, current_date + 30, 'reference');
  perform pg_temp.restore();
  perform pg_temp.check((v ->> 'already_approved')::boolean, '1b. the retry reports already approved');
  perform pg_temp.check((select count(*) from public.order_operations_handoffs where order_id = o) = 1, '1b. still exactly one handoff');
end $$;

-- Deciding an unassigned handoff is refused for everybody, admin included —
-- through BOTH doors.
select pg_temp.expect_error(
  format('select pg_temp.decide(%L, %L, %L, null)', current_setting('test.owner_id'), (pg_temp.live(current_setting('test.order_a')::uuid)).id, 'accepted'),
  'ORDER_OPERATIONS_HANDOFF_UNASSIGNED', '1c. an admin cannot accept an unassigned handoff');
select pg_temp.expect_error(
  format('select pg_temp.align(%L, %L, true, null)', current_setting('test.owner_id'), current_setting('test.order_a')),
  'ORDER_OPERATIONS_HANDOFF_UNASSIGNED', '1d. nor align it through the alignment door — the two are one');
select pg_temp.check(pg_temp.alignment(current_setting('test.order_a')::uuid) = 'not_aligned', '1d. and the Order stays not aligned');

-- ═══ 2. ASSIGNING THE REVIEWER ═════════════════════════════════════════════

-- Not an admin → refused.
select pg_temp.become(current_setting('test.sales_id')::uuid);
select pg_temp.expect_error(
  format('select public.set_order_operations_reviewer(%L)', current_setting('test.reviewer_id')),
  'Only an administrator', '2a. a non-admin cannot assign the reviewer');
select pg_temp.restore();

-- An inactive person → refused.
update public.users set is_active = false where id = current_setting('test.outsider_id')::uuid;
select pg_temp.expect_error(
  format('select pg_temp.assign(%L)', current_setting('test.outsider_id')),
  'ORDER_OPERATIONS_REVIEWER_INACTIVE', '2b. an inactive account cannot be the reviewer');
update public.users set is_active = true where id = current_setting('test.outsider_id')::uuid;
-- A person who cannot open Orders → refused.
select pg_temp.expect_error(
  format('select pg_temp.assign(%L)', current_setting('test.outsider_id')),
  'ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS', '2c. the reviewer must be able to open Orders');

-- A person who holds orders.view but is NOT an admin, NOT on the operations
-- team and holds NO orders.view_all: they can open the module, not every
-- Order — so they cannot be the reviewer either.
insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.viewer_id')::uuid, 'ASSERT Viewer', 'viewer@example.test', 'member', 'design', true, 'ASSERT-VIEW')
on conflict (id) do nothing;
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.viewer_id')::uuid, pm.id, pa.id, true, current_setting('test.owner_id')::uuid
  from public.permission_modules pm join public.permission_actions pa on pa.action_key = 'view'
 where pm.module_key = 'orders'
on conflict do nothing;
do $$
declare v uuid := current_setting('test.viewer_id')::uuid; o uuid := current_setting('test.order_a')::uuid;
begin
  perform pg_temp.check(public.resolve_permission(v, 'orders', 'view'), '2c2. precondition: the viewer holds orders.view');
  perform pg_temp.check(not public.resolve_permission(v, 'orders', 'view_all'), '2c2. precondition: and not view_all');
  perform pg_temp.check(not public.operations_reviewer_can_open_order(v, o), '2c2. precondition: they cannot open Order A (not admin, not operations, not on it)');
  perform pg_temp.check(not public.operations_reviewer_covers_all_orders(v), '2c2. so they do not cover every Order');
  perform pg_temp.expect_error(
    format('select pg_temp.assign(%L)', v),
    'ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS', '2c2. orders.view alone does not make somebody the reviewer');
  perform pg_temp.check((select user_id from public.order_operations_reviewers where duty = 'pi_handoff') is null, '2c2. the assignment is unchanged');
  -- The bar, stated positively: operations team, or view_all, or admin.
  perform pg_temp.check(public.operations_reviewer_covers_all_orders(current_setting('test.reviewer_id')::uuid), '2c3. an operations-team member with orders.view covers every Order');
  perform pg_temp.check(public.operations_reviewer_covers_all_orders(current_setting('test.admin2_id')::uuid), '2c3. an active admin covers every Order');
end $$;

-- The real reviewer: assigned, and the waiting handoff readdressed + notified.
do $$
declare v jsonb; h public.order_operations_handoffs; o uuid := current_setting('test.order_a')::uuid;
begin
  v := pg_temp.assign(current_setting('test.reviewer_id')::uuid);
  perform pg_temp.check((v ->> 'reassigned_handoffs')::int = 1, '2d. the one waiting handoff was readdressed');
  h := pg_temp.live(o);
  perform pg_temp.check(h.assigned_to = current_setting('test.reviewer_id')::uuid and h.assigned_at is not null, '2d. assigned to the reviewer');
  perform pg_temp.check((select count(*) from public.notifications
     where user_id = current_setting('test.reviewer_id')::uuid and entity_id = o and type::text = 'order_operations_review_requested') = 1,
    '2d. the reviewer is notified once');
  perform pg_temp.check(pg_temp.events(o, 'operations_reviewer_assigned') = 1, '2d. the assignment is on the Order history');
  perform pg_temp.check((select user_id from public.order_operations_reviewers where duty = 'pi_handoff') = current_setting('test.reviewer_id')::uuid,
    '2d. the assignment row holds the reviewer id');
end $$;

-- ═══ 3. WITH A REVIEWER: approval notifies them, once ══════════════════════

select pg_temp.make_pi(current_setting('test.pi_b')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT B', 1000000);
select set_config('test.order_b', pg_temp.approve(current_setting('test.pi_b')::uuid)::text, true);

do $$
declare h public.order_operations_handoffs; o uuid := current_setting('test.order_b')::uuid; n record;
begin
  h := pg_temp.live(o);
  perform pg_temp.check(h.assigned_to = current_setting('test.reviewer_id')::uuid, '3. assigned at approval through the user record');
  select * into n from public.notifications where user_id = current_setting('test.reviewer_id')::uuid and entity_id = o;
  perform pg_temp.check(n.type::text = 'order_operations_review_requested', '3. the reviewer is told');
  perform pg_temp.check(n.title like '%PI V1%' and n.title like '%ASSERT Owner%', '3. the notification names the version and the approver');
  perform pg_temp.check((select count(*) from public.notifications where entity_id = o) = 1, '3. exactly one notification');
  perform pg_temp.check((select count(*) from public.notifications where user_id = current_setting('test.owner_id')::uuid and entity_id = o) = 0,
    '3. the approver is not told about their own approval');
end $$;

-- ═══ 3b. THE CONFIGURED REVIEWER CANNOT OPEN THIS ORDER ═══════════════════
--
-- Their access changed after they were assigned: still active, still
-- orders.view, but no longer on the operations team and never view_all. The
-- handoff is recorded UNASSIGNED with that reason, they are not addressed or
-- notified, and the administrators are told what to fix.

update public.users set team = 'sales' where id = current_setting('test.reviewer_id')::uuid;
select pg_temp.make_pi(current_setting('test.pi_f')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT F', 1000000);
select set_config('test.order_f', pg_temp.approve(current_setting('test.pi_f')::uuid)::text, true);

do $$
declare h public.order_operations_handoffs; o uuid := current_setting('test.order_f')::uuid; r uuid := current_setting('test.reviewer_id')::uuid; v jsonb;
begin
  perform pg_temp.check(not public.operations_reviewer_can_open_order(r, o), '3b. precondition: the configured reviewer cannot open F');
  h := pg_temp.live(o);
  perform pg_temp.check(h.assigned_to is null and h.unassigned_reason = 'reviewer_cannot_open_order',
    '3b. recorded unassigned, with the reason');
  perform pg_temp.check((select count(*) from public.notifications where entity_id = o and user_id = r) = 0,
    '3b. the reviewer who cannot open it is not notified');
  perform pg_temp.check((select count(*) from public.notifications where entity_id = o
     and user_id = current_setting('test.owner_id')::uuid and body like '%cannot open this Order%') = 1,
    '3b. the administrators are told why');
  perform pg_temp.check((select payload ->> 'unassigned_reason' from public.order_activity_log where order_id = o
     and event_type = 'operations_handoff_recorded') = 'reviewer_cannot_open_order', '3b. and the history says so');
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, null)', r, h.id, 'accepted'),
    'ORDER_OPERATIONS_HANDOFF_UNASSIGNED', '3b. they cannot accept it either');
  -- Re-saving the SAME person while their access is short is refused too.
  perform pg_temp.expect_error(
    format('select pg_temp.assign(%L)', r),
    'ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS', '3b. and cannot be (re)assigned while their access does not cover every Order');
  -- Access restored: re-assigning them readdresses F (and only F is waiting on it).
  update public.users set team = 'operations' where id = r;
  v := pg_temp.assign(r);
  perform pg_temp.check((v ->> 'reassigned_handoffs')::int = 1, '3c. once they can open every Order again, the waiting handoff is readdressed');
  h := pg_temp.live(o);
  perform pg_temp.check(h.assigned_to = r and h.unassigned_reason is null, '3c. F now waits on them, reason cleared');
end $$;

-- ═══ 4. AUTHORITY ON THE DECISION — one door, however it is reached ════════

-- An active admin who is NOT the reviewer: refused, through both doors.
select pg_temp.expect_error(
  format('select pg_temp.decide(%L, %L, %L, null)', current_setting('test.admin2_id'), (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'accepted'),
  'Only the assigned operations reviewer', '4a. being an admin is not being the reviewer');
select pg_temp.expect_error(
  format('select pg_temp.align(%L, %L, true, null)', current_setting('test.admin2_id'), current_setting('test.order_b')),
  'Only the assigned operations reviewer', '4a2. an admin holding orders.align_production cannot align a handoff Order');
-- The owner who approved it: refused too.
select pg_temp.expect_error(
  format('select pg_temp.decide(%L, %L, %L, null)', current_setting('test.owner_id'), (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'accepted'),
  'Only the assigned operations reviewer', '4b. the approver cannot accept in the reviewer''s place');
-- An outsider with no Orders access: refused before anything is read.
select pg_temp.expect_error(
  format('select pg_temp.decide(%L, %L, %L, null)', current_setting('test.outsider_id'), (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'accepted'),
  'Only the assigned operations reviewer', '4c. an outsider is refused');

-- The reviewer: a flag needs a reason; an unknown decision is refused.
select pg_temp.expect_error(
  format('select pg_temp.decide(%L, %L, %L, %L)', current_setting('test.reviewer_id'), (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'clarification_needed', '   '),
  'ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED', '4d. a flag with no reason is refused');
select pg_temp.expect_error(
  format('select pg_temp.align(%L, %L, false, null)', current_setting('test.reviewer_id'), current_setting('test.order_b')),
  'ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED', '4d2. un-aligning through the old door needs the same reason');
select pg_temp.expect_error(
  format('select pg_temp.decide(%L, %L, %L, null)', current_setting('test.reviewer_id'), (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'done'),
  'ORDER_OPERATIONS_HANDOFF_DECISION_UNKNOWN', '4e. only the two decisions exist');
select pg_temp.expect_error(
  format('select pg_temp.decide(%L, %L, %L, %L)', current_setting('test.reviewer_id'), (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'clarification_needed', repeat('x', 1001)),
  'ORDER_OPERATIONS_HANDOFF_REASON_TOO_LONG', '4f. the reason is bounded');

-- The reviewer flags it, then accepts after clarification — and acceptance ALIGNS.
do $$
declare h public.order_operations_handoffs; o uuid := current_setting('test.order_b')::uuid; v jsonb; r uuid := current_setting('test.reviewer_id')::uuid;
begin
  v := pg_temp.decide(r, (pg_temp.live(o)).id, 'clarification_needed', 'Fabric code on line 1 is not one we stock');
  h := pg_temp.live(o);
  perform pg_temp.check(h.status = 'clarification_needed' and h.clarification_by = r
    and h.clarification_reason like 'Fabric code%', '4g. flagged, with actor, time and reason');
  perform pg_temp.check(h.accepted_at is null and h.acceptance_withdrawn_at is null, '4g. a first flag is not a withdrawal');
  perform pg_temp.check((select count(*) from public.notifications where user_id = current_setting('test.owner_id')::uuid
     and entity_id = o and type::text = 'order_operations_review_decided') = 1, '4g. the approver is told');
  perform pg_temp.check(pg_temp.events(o, 'operations_handoff_clarification_needed') = 1, '4g. on the history');
  perform pg_temp.check(pg_temp.alignment(o) = 'not_aligned', '4g. flagged: not aligned (and no spurious alignment event)');
  perform pg_temp.check(pg_temp.events(o, 'production_alignment_changed') = 0, '4g. not aligned → not aligned writes no alignment event');
  -- flagging twice is refused
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, %L)', r, h.id, 'clarification_needed', 'again'),
    'ORDER_OPERATIONS_HANDOFF_ALREADY_FLAGGED', '4h. a second flag is refused');
  -- then accepted: the Order is aligned, by the reviewer, against this version
  v := pg_temp.decide(r, h.id, 'accepted', 'Fabric confirmed by phone');
  h := pg_temp.live(o);
  perform pg_temp.check(h.status = 'accepted' and h.accepted_by = r and h.accepted_at is not null,
    '4i. accepted after clarification, with actor and time');
  perform pg_temp.check(h.clarification_reason like 'Fabric code%', '4i. the earlier flag is kept for audit');
  perform pg_temp.check((select payload ->> 'after_clarification' from public.order_activity_log where order_id = o
     and event_type = 'operations_handoff_accepted') = 'true', '4i. history says it followed a clarification');
  perform pg_temp.check(v ->> 'production_alignment' = 'aligned', '4i. the decision reports the alignment it produced');
  perform pg_temp.check(pg_temp.alignment(o) = 'aligned', '4i. ACCEPTING ALIGNS THE ORDER');
  perform pg_temp.check((select production_aligned_by from public.orders where id = o) = r, '4i. aligned BY the reviewer');
  perform pg_temp.check((select production_alignment_note from public.orders where id = o) = 'Fabric confirmed by phone', '4i. the note travels');
  perform pg_temp.check((select payload ->> 'version_number' from public.order_activity_log where order_id = o
     and event_type = 'production_alignment_changed' and payload ->> 'to' = 'aligned') = '1',
    '4i. the alignment event names the version it covers');
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, null)', r, h.id, 'accepted'),
    'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED', '4j. a second acceptance is refused');
  perform pg_temp.expect_error(
    format('select pg_temp.align(%L, %L, true, null)', r, o),
    'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED', '4j2. and so is re-aligning through the old door');
end $$;

-- Withdrawing an acceptance: "Cannot accept" (or un-align) on an accepted
-- version, reason required, keeps the acceptance on record, takes the
-- alignment back; then accepting again re-aligns.
do $$
declare h public.order_operations_handoffs; o uuid := current_setting('test.order_b')::uuid; v jsonb; r uuid := current_setting('test.reviewer_id')::uuid; t timestamptz;
begin
  t := (pg_temp.live(o)).accepted_at;
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, null)', r, (pg_temp.live(o)).id, 'clarification_needed'),
    'ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED', '4k. a withdrawal needs a reason');
  v := pg_temp.align(r, o, false, 'Line 1 quantity looks wrong');
  h := pg_temp.live(o);
  perform pg_temp.check((v ->> 'withdrawn')::boolean, '4k. un-aligning an accepted version IS a withdrawal');
  perform pg_temp.check(h.status = 'clarification_needed', '4k. back to clarification needed');
  perform pg_temp.check(h.accepted_by = r and h.accepted_at = t, '4k. who accepted and when is KEPT');
  perform pg_temp.check(h.acceptance_withdrawn_by = r and h.acceptance_withdrawn_reason = 'Line 1 quantity looks wrong', '4k. the withdrawal says who and why');
  perform pg_temp.check(pg_temp.alignment(o) = 'not_aligned', '4k. the alignment is taken back');
  perform pg_temp.check(pg_temp.events(o, 'operations_handoff_acceptance_withdrawn') = 1, '4k. on the history as a withdrawal');
  perform pg_temp.check((select count(*) from public.notifications where user_id = current_setting('test.owner_id')::uuid
     and entity_id = o and title like '%withdrew%') = 1, '4k. the approver is told it was withdrawn');
  v := pg_temp.decide(r, h.id, 'accepted', 'Quantity confirmed');
  h := pg_temp.live(o);
  perform pg_temp.check(h.status = 'accepted' and h.acceptance_withdrawn_at is null and h.accepted_note = 'Quantity confirmed',
    '4l. accepted again; the new acceptance replaces the withdrawn one');
  perform pg_temp.check((select payload ->> 'after_withdrawal' from public.order_activity_log where order_id = o
     and event_type = 'operations_handoff_accepted' and payload ->> 'note' = 'Quantity confirmed') = 'true',
    '4l. history says it followed a withdrawal');
  perform pg_temp.check(pg_temp.alignment(o) = 'aligned', '4l. re-aligned');
end $$;

-- ═══ 5. A LATER VERSION: the acceptance and the alignment do not carry ═════

select set_config('test.v2_b', pg_temp.approve_revision(current_setting('test.order_b')::uuid, current_setting('test.owner_id')::uuid)::text, true);

do $$
declare h public.order_operations_handoffs; old public.order_operations_handoffs; o uuid := current_setting('test.order_b')::uuid; e record;
begin
  h := pg_temp.live(o);
  perform pg_temp.check(h.version_number = 2 and h.status = 'awaiting', '5. V2 has its own awaiting handoff');
  perform pg_temp.check(h.pi_version_id = current_setting('test.v2_b')::uuid, '5. tied to the exact V2 version id');
  perform pg_temp.check(h.prior_handoff_status = 'accepted', '5. it records that V1 had been accepted');
  perform pg_temp.check(h.production_alignment_at_approval = 'aligned', '5. and that the Order WAS aligned when V2 arrived');
  perform pg_temp.check(h.assigned_to = current_setting('test.reviewer_id')::uuid, '5. addressed to the reviewer');
  select * into old from public.order_operations_handoffs where order_id = o and version_number = 1;
  perform pg_temp.check(old.superseded_at is not null and old.superseded_by_version_id = current_setting('test.v2_b')::uuid,
    '5. V1''s handoff is superseded');
  perform pg_temp.check(old.status = 'accepted' and old.accepted_by is not null, '5. V1''s acceptance is preserved for audit');
  perform pg_temp.check((select count(*) from public.order_operations_handoffs where order_id = o and superseded_at is null) = 1,
    '5. exactly one live handoff');
  -- THE OLDER ALIGNMENT DOES NOT COVER V2
  perform pg_temp.check(pg_temp.alignment(o) = 'not_aligned', '5. THE ALIGNMENT IS RESET when a newer version is approved');
  perform pg_temp.check((select production_aligned_by from public.orders where id = o) is null, '5. and the aligned-by/at columns are cleared');
  select * into e from public.order_activity_log where order_id = o and event_type = 'production_alignment_changed'
    and payload ->> 'reason' = 'pi_version_approved';
  perform pg_temp.check(e.id is not null, '5. the reset is on the history');
  perform pg_temp.check(e.payload ->> 'covered_version_number' = '1' and e.payload ->> 'to' = 'not_aligned'
     and e.payload ->> 'previous_aligned_by' = current_setting('test.reviewer_id'), '5. …saying what the alignment had covered and who had set it');
  perform pg_temp.check((select count(*) from public.notifications where entity_id = o and type::text = 'order_operations_review_requested'
     and body like 'You accepted PI V1 earlier%') = 1, '5. the notification says the earlier acceptance does not carry');
  -- accepting the superseded V1 handoff is refused
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, null)', current_setting('test.reviewer_id'), old.id, 'accepted'),
    'ORDER_OPERATIONS_HANDOFF_SUPERSEDED', '5b. a stale (superseded) acceptance is refused');
  -- accepting V2 aligns again, against V2
  perform pg_temp.decide(current_setting('test.reviewer_id')::uuid, h.id, 'accepted', null);
  perform pg_temp.check(pg_temp.alignment(o) = 'aligned', '5c. accepting V2 aligns the Order again');
  -- (ids are random and every row shares one now(), so the event is found by
  -- what it says)
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o
     and event_type = 'production_alignment_changed' and payload ->> 'to' = 'aligned' and payload ->> 'version_number' = '2') = 1,
    '5c. …against V2');
end $$;

-- ═══ 6. REASSIGNMENT: replacement, clearing, deactivation, a flagged case ══

-- Fixture: C awaiting, D flagged, E accepted (all addressed to the reviewer).
select pg_temp.make_pi(current_setting('test.pi_c')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT C', 1000000);
select set_config('test.order_c', pg_temp.approve(current_setting('test.pi_c')::uuid)::text, true);
select pg_temp.make_pi(current_setting('test.pi_d')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT D', 1000000);
select set_config('test.order_d', pg_temp.approve(current_setting('test.pi_d')::uuid)::text, true);
select pg_temp.make_pi(current_setting('test.pi_e')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT E', 1000000);
select set_config('test.order_e', pg_temp.approve(current_setting('test.pi_e')::uuid)::text, true);
select pg_temp.decide(current_setting('test.reviewer_id')::uuid, (pg_temp.live(current_setting('test.order_d')::uuid)).id, 'clarification_needed', 'D: which finish?');
select pg_temp.decide(current_setting('test.reviewer_id')::uuid, (pg_temp.live(current_setting('test.order_e')::uuid)).id, 'accepted', null);

-- 6a. REPLACEMENT moves the awaiting AND the flagged case; not the accepted one.
do $$
declare v jsonb; r1 uuid := current_setting('test.reviewer_id')::uuid; r2 uuid := current_setting('test.reviewer2_id')::uuid;
  a uuid := current_setting('test.order_a')::uuid; c uuid := current_setting('test.order_c')::uuid;
  d uuid := current_setting('test.order_d')::uuid; e uuid := current_setting('test.order_e')::uuid; b uuid := current_setting('test.order_b')::uuid;
begin
  v := pg_temp.assign(r2);
  -- live and unresolved: A V1 (awaiting), C (awaiting), D (flagged), F (awaiting). Not B V2 or E (accepted).
  perform pg_temp.check((v ->> 'reassigned_handoffs')::int = 4, '6a. the awaiting AND the flagged handoffs move');
  perform pg_temp.check((pg_temp.live(c)).assigned_to = r2 and (pg_temp.live(d)).assigned_to = r2, '6a. C and D now wait on the replacement');
  perform pg_temp.check((pg_temp.live(d)).status = 'clarification_needed' and (pg_temp.live(d)).clarification_reason = 'D: which finish?',
    '6a. the flag and its reason survive the move');
  perform pg_temp.check((pg_temp.live(e)).assigned_to = r1 and (pg_temp.live(e)).status = 'accepted', '6a. the accepted one keeps its reviewer');
  perform pg_temp.check((select count(*) from public.notifications where user_id = r2 and type::text = 'order_operations_review_requested') = 4,
    '6a. the replacement is told once per Order');
  perform pg_temp.check((select count(*) from public.notifications where user_id = r2 and entity_id = d and title like '%flagged for clarification%') = 1,
    '6a. …and told that D is flagged');
  perform pg_temp.check(pg_temp.events(d, 'operations_reviewer_assigned') = 1, '6a. logged on the Order');
  -- THE FORMER REVIEWER CAN NO LONGER DECIDE, through either door.
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, null)', r1, (pg_temp.live(c)).id, 'accepted'),
    'Only the assigned operations reviewer', '6b. the former reviewer cannot accept');
  perform pg_temp.expect_error(
    format('select pg_temp.align(%L, %L, true, null)', r1, d),
    'Only the assigned operations reviewer', '6b. nor align the flagged one');
  -- The replacement resolves the flagged case.
  perform pg_temp.decide(r2, (pg_temp.live(d)).id, 'accepted', 'finish confirmed');
  perform pg_temp.check((pg_temp.live(d)).status = 'accepted' and pg_temp.alignment(d) = 'aligned', '6c. the replacement accepts D, which aligns it');
end $$;

-- 6d. CLEARING unassigns every live unresolved handoff, visibly.
do $$
declare v jsonb; a uuid := current_setting('test.order_a')::uuid; c uuid := current_setting('test.order_c')::uuid;
  d uuid := current_setting('test.order_d')::uuid; r2 uuid := current_setting('test.reviewer2_id')::uuid;
begin
  perform pg_temp.decide(r2, (pg_temp.live(c)).id, 'clarification_needed', 'C: image missing');
  v := pg_temp.assign(null);
  -- live and unresolved now: A V1 (awaiting), C (flagged), F (awaiting). D is accepted.
  perform pg_temp.check((v ->> 'unassigned_handoffs')::int = 3 and (v ->> 'reassigned_handoffs')::int = 0, '6d. clearing unassigns the awaiting and the flagged handoffs');
  perform pg_temp.check((pg_temp.live(a)).assigned_to is null and (pg_temp.live(c)).assigned_to is null, '6d. both show unassigned');
  perform pg_temp.check((pg_temp.live(a)).unassigned_reason = 'no_reviewer' and (pg_temp.live(c)).unassigned_reason = 'no_reviewer',
    '6d. …with the reason: nobody is configured');
  perform pg_temp.check((pg_temp.live(c)).status = 'clarification_needed', '6d. the flag is kept — clearing resolves nothing');
  perform pg_temp.check((pg_temp.live(d)).assigned_to = r2, '6d. the accepted one keeps its reviewer');
  perform pg_temp.check(pg_temp.events(c, 'operations_reviewer_unassigned') = 1, '6d. logged as an unassignment');
  perform pg_temp.check((select user_id from public.order_operations_reviewers where duty = 'pi_handoff') is null, '6d. the assignment is cleared');
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, null)', r2, (pg_temp.live(c)).id, 'accepted'),
    'ORDER_OPERATIONS_HANDOFF_UNASSIGNED', '6e. the former reviewer cannot decide an unassigned handoff');
end $$;

-- 6f. DEACTIVATION: an inactive reviewer can decide nothing; new handoffs go unassigned.
do $$
declare r2 uuid := current_setting('test.reviewer2_id')::uuid; c uuid := current_setting('test.order_c')::uuid; v jsonb;
begin
  perform pg_temp.assign(r2);
  perform pg_temp.check((pg_temp.live(c)).assigned_to = r2, '6f. re-assigned to reviewer 2');
  update public.users set is_active = false where id = r2;
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, null)', r2, (pg_temp.live(c)).id, 'accepted'),
    'This account is not active', '6f. a deactivated reviewer is refused at the door');
  perform pg_temp.check((pg_temp.live(c)).assigned_to = r2, '6f. the handoff still names them (visibly stale, for an admin to reassign)');
  -- a new version approved now finds no ACTIVE reviewer → unassigned
  perform pg_temp.approve_revision(c, current_setting('test.owner_id')::uuid);
  perform pg_temp.check((pg_temp.live(c)).version_number = 2 and (pg_temp.live(c)).assigned_to is null,
    '6g. a new handoff is recorded unassigned while the assigned reviewer is inactive');
  perform pg_temp.check((pg_temp.live(c)).unassigned_reason = 'reviewer_inactive', '6g. …with the reason: the reviewer is inactive');
  perform pg_temp.check((select count(*) from public.notifications where entity_id = c
     and user_id = current_setting('test.owner_id')::uuid and body like '%no longer an active account%') = 1,
    '6g. …and the administrators are told');
  -- r2 was told about C twice while active (the 6a replacement, the 6f
  -- re-assignment); the approval of V2 while inactive adds nothing.
  perform pg_temp.check((select count(*) from public.notifications where user_id = r2 and entity_id = c) = 2,
    '6g. and the inactive reviewer is not notified again');
  update public.users set is_active = true where id = r2;
end $$;

-- ═══ 7. A CANCELLED ORDER ══════════════════════════════════════════════════

do $$
declare o uuid := current_setting('test.order_a')::uuid;
begin
  perform pg_temp.assign(current_setting('test.reviewer_id')::uuid);
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.cancel_order(o, 'ASSERT cancelled');
  perform pg_temp.restore();
  perform pg_temp.expect_error(
    format('select pg_temp.decide(%L, %L, %L, null)', current_setting('test.reviewer_id'), (pg_temp.live(o)).id, 'accepted'),
    'ORDER_OPERATIONS_HANDOFF_CLOSED', '7. a cancelled Order''s handoff cannot be accepted');
  perform pg_temp.expect_error(
    format('select pg_temp.align(%L, %L, true, null)', current_setting('test.reviewer_id'), o),
    'ORDER_OPERATIONS_HANDOFF_CLOSED', '7. nor aligned');
end $$;

-- ═══ 8. A LEGACY ORDER keeps the 20261119 alignment rule ═══════════════════
--
-- Simulated by removing the handoff under the test-data-cleanup context (the
-- only path that may delete one): what remains is an Order that predates
-- handoff recording.
do $$
declare o uuid := current_setting('test.order_e')::uuid; v jsonb;
begin
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  delete from public.order_operations_handoffs where order_id = o;
  perform set_config('boe.cleanup_context', '', true);
  -- E was aligned by acceptance; without a handoff it now reads as a legacy alignment.
  perform pg_temp.check(pg_temp.alignment(o) = 'aligned', '8. the legacy alignment is untouched');
  -- an align_production holder (an admin) may take it back and set it, as before
  v := pg_temp.align(current_setting('test.admin2_id')::uuid, o, false, 'legacy note');
  perform pg_temp.check((v ->> 'unchanged')::boolean = false and pg_temp.alignment(o) = 'not_aligned', '8a. an admin un-aligns a legacy Order');
  v := pg_temp.align(current_setting('test.admin2_id')::uuid, o, true, 'legacy align');
  perform pg_temp.check(pg_temp.alignment(o) = 'aligned', '8b. and aligns it');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o
     and event_type = 'production_alignment_changed' and payload ->> 'legacy_order' = 'true' and payload ->> 'to' = 'aligned') = 1,
    '8b. the event says it was the legacy rule');
  -- but somebody without the permission still cannot
  perform pg_temp.expect_error(
    format('select pg_temp.align(%L, %L, false, null)', current_setting('test.sales_id'), o),
    'You do not have permission to align', '8c. the 20261119 permission rule is unchanged for legacy Orders');
  -- a revised PI on it starts the new rule: alignment reset, handoff recorded
  perform pg_temp.approve_revision(o, current_setting('test.owner_id')::uuid);
  perform pg_temp.check((pg_temp.live(o)).version_number = 2 and (pg_temp.live(o)).prior_handoff_status is null,
    '8d. the first handoff on a legacy Order records no prior decision');
  perform pg_temp.check((pg_temp.live(o)).production_alignment_at_approval = 'aligned' and pg_temp.alignment(o) = 'not_aligned',
    '8d. …and the legacy alignment is reset, remembered on the handoff');
  perform pg_temp.expect_error(
    format('select pg_temp.align(%L, %L, true, null)', current_setting('test.admin2_id'), o),
    'Only the assigned operations reviewer', '8e. from here on, only the reviewer can align it');
end $$;

-- ═══ 9. PRIVILEGES AND THE GUARD ═══════════════════════════════════════════

do $$
begin
  perform pg_temp.check(not has_function_privilege('anon', 'public.decide_order_operations_handoff(uuid, text, text)', 'EXECUTE'), '9. anon cannot decide');
  perform pg_temp.check(not has_function_privilege('anon', 'public.set_order_operations_reviewer(uuid)', 'EXECUTE'), '9. anon cannot assign');
  perform pg_temp.check(not has_function_privilege('authenticated', 'public.order_operations_handoff_set_alignment(uuid, uuid, boolean, text, jsonb)', 'EXECUTE'), '9. clients cannot write alignment directly');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_operations_handoffs', 'INSERT'), '9. clients cannot insert handoffs');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_operations_handoffs', 'UPDATE'), '9. clients cannot update handoffs');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_operations_reviewers', 'UPDATE'), '9. clients cannot rewrite the assignment');
  perform pg_temp.check(has_table_privilege('authenticated', 'public.order_operations_handoffs', 'SELECT'), '9. clients read handoffs (under RLS)');
end $$;

-- The reviewer can see the handoffs of an Order they may open; the outsider sees none.
do $$
declare n int;
begin
  perform pg_temp.become(current_setting('test.reviewer_id')::uuid);
  select count(*) into n from public.order_operations_handoffs where order_id = current_setting('test.order_b')::uuid;
  perform pg_temp.restore();
  perform pg_temp.check(n = 2, '9b. the reviewer reads both of B''s handoffs under RLS');
  perform pg_temp.become(current_setting('test.outsider_id')::uuid);
  select count(*) into n from public.order_operations_handoffs;
  perform pg_temp.restore();
  perform pg_temp.check(n = 0, '9c. an outsider reads nothing');
end $$;

-- The guard: no deletion, no silent edit of a decision, no un-superseding.
select pg_temp.expect_error(
  format('delete from public.order_operations_handoffs where order_id = %L', current_setting('test.order_b')),
  'ORDER_OPERATIONS_HANDOFF_PERMANENT', '9d. handoffs are never deleted');
select pg_temp.expect_error(
  format('update public.order_operations_handoffs set status = %L, accepted_by = null, accepted_at = null where order_id = %L and version_number = 2', 'awaiting', current_setting('test.order_b')),
  'ORDER_OPERATIONS_HANDOFF', '9e. an acceptance cannot be erased back to awaiting, even by the owner role');
select pg_temp.expect_error(
  format('update public.order_operations_handoffs set accepted_note = %L where order_id = %L and version_number = 2', 'edited', current_setting('test.order_b')),
  'ORDER_OPERATIONS_HANDOFF_DECISION_IS_AN_EVENT', '9f. a decision''s words cannot be edited in place');
select pg_temp.expect_error(
  format('update public.order_operations_handoffs set version_number = 9 where order_id = %L and version_number = 2', current_setting('test.order_b')),
  'ORDER_OPERATIONS_HANDOFF_FROZEN', '9g. identity is frozen');
-- A direct write to the alignment columns is still refused outside the context.
-- (B is aligned after 5c, so the write below is a real change, not a no-op)
select pg_temp.check(pg_temp.alignment(current_setting('test.order_b')::uuid) = 'aligned', '9h. precondition: B is aligned');
select pg_temp.expect_error(
  format('update public.orders set production_alignment = %L where id = %L', 'not_aligned', current_setting('test.order_b')),
  'ORDER_PRODUCTION_ALIGNMENT_PATH_REQUIRED', '9h. the alignment columns still move only through the context');

do $$ begin raise notice 'ALL HANDOFF ASSERTIONS PASSED'; end $$;

rollback;
