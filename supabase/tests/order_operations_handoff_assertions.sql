-- PI-TO-OPERATIONS HANDOFF assertions (20261229000000)
-- ===========================================================================
-- Validates, through the REAL doors:
--
--   * recording     approve_order_submission() records ONE awaiting handoff for
--                   V1, inside its own transaction; a retry records nothing new
--   * recipient     resolved through order_operations_reviewers + an ACTIVE user
--                   record; nobody assigned → unassigned, visibly, no admin in
--                   their place; assigning later readdresses the waiting ones
--   * notification  the reviewer is told once per handoff; the approver is told
--                   the decision; the approver is never told their own approval
--   * authority     decide_order_operations_handoff(): an admin who is not the
--                   reviewer is refused; an outsider is refused; the reviewer
--                   is not; a second acceptance is refused; a flag needs a
--                   reason; a flag can be followed by acceptance
--   * versions      approving V2 supersedes V1's handoff KEEPING its decision,
--                   records a new awaiting handoff, snapshots the alignment and
--                   the prior decision; accepting the superseded one is refused
--   * closure       a cancelled Order's handoff cannot be decided
--   * privileges    anon executes nothing; clients read only; the guard refuses
--                   deletion and any rewrite of an acceptance
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
  perform set_config('test.pi_a', gen_random_uuid()::text, true);
  perform set_config('test.pi_b', gen_random_uuid()::text, true);
  perform set_config('test.pi_c', gen_random_uuid()::text, true);
end $$;

-- ═══ 0. FIXTURES ════════════════════════════════════════════════════════════

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.reviewer_id')::uuid, 'ASSERT Reviewer', 'reviewer@example.test', 'member', 'operations', true, 'ASSERT-OPS'),
  (current_setting('test.admin2_id')::uuid,   'ASSERT Admin Two', 'admin2@example.test',  'admin',  'management', true, 'ASSERT-ADM'),
  (current_setting('test.outsider_id')::uuid, 'ASSERT Outsider', 'out@example.test',      'member', 'design',     true, 'ASSERT-OUT'),
  (current_setting('test.sales_id')::uuid,    'ASSERT Sales',    'sales@example.test',    'member', 'sales',      true, 'ASSERT-SAL')
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
create function pg_temp.restore() returns void language plpgsql as $$ begin execute 'reset role'; end $$;

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
  perform pg_temp.check(h.approved_by = current_setting('test.owner_id')::uuid, '1. the approver is recorded');
  perform pg_temp.check(h.production_alignment_at_approval = 'not_aligned', '1. alignment snapshot: not aligned');
  perform pg_temp.check((select count(*) from public.notifications where type::text like 'order_operations%') = 0,
    '1. no reviewer → no notification (and no admin notified in their place)');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o and event_type = 'operations_handoff_recorded') = 1,
    '1. one history event');
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

-- Deciding an unassigned handoff is refused for everybody, admin included.
select pg_temp.become(current_setting('test.owner_id')::uuid);
select pg_temp.expect_error(
  format('select public.decide_order_operations_handoff(%L, %L, null)', (pg_temp.live(current_setting('test.order_a')::uuid)).id, 'accepted'),
  'ORDER_OPERATIONS_HANDOFF_UNASSIGNED', '1c. an admin cannot accept an unassigned handoff');
select pg_temp.restore();

-- ═══ 2. ASSIGNING THE REVIEWER ═════════════════════════════════════════════

-- Not an admin → refused.
select pg_temp.become(current_setting('test.sales_id')::uuid);
select pg_temp.expect_error(
  format('select public.set_order_operations_reviewer(%L)', current_setting('test.reviewer_id')),
  'Only an administrator', '2a. a non-admin cannot assign the reviewer');
select pg_temp.restore();

-- An inactive person → refused.
update public.users set is_active = false where id = current_setting('test.outsider_id')::uuid;
select pg_temp.become(current_setting('test.owner_id')::uuid);
select pg_temp.expect_error(
  format('select public.set_order_operations_reviewer(%L)', current_setting('test.outsider_id')),
  'ORDER_OPERATIONS_REVIEWER_INACTIVE', '2b. an inactive account cannot be the reviewer');
select pg_temp.restore();
update public.users set is_active = true where id = current_setting('test.outsider_id')::uuid;
select pg_temp.become(current_setting('test.owner_id')::uuid);
-- A person who cannot open Orders → refused.
select pg_temp.expect_error(
  format('select public.set_order_operations_reviewer(%L)', current_setting('test.outsider_id')),
  'ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS', '2c. the reviewer must be able to open Orders');

-- The real reviewer: assigned, and the waiting handoff readdressed + notified.
do $$
declare v jsonb; h public.order_operations_handoffs; o uuid := current_setting('test.order_a')::uuid;
begin
  v := public.set_order_operations_reviewer(current_setting('test.reviewer_id')::uuid);
  perform pg_temp.check((v ->> 'reassigned_handoffs')::int = 1, '2d. the one waiting handoff was readdressed');
  h := pg_temp.live(o);
  perform pg_temp.check(h.assigned_to = current_setting('test.reviewer_id')::uuid and h.assigned_at is not null, '2d. assigned to the reviewer');
  perform pg_temp.check((select count(*) from public.notifications
     where user_id = current_setting('test.reviewer_id')::uuid and entity_id = o and type::text = 'order_operations_review_requested') = 1,
    '2d. the reviewer is notified once');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o and event_type = 'operations_reviewer_assigned') = 1,
    '2d. the assignment is on the Order history');
  perform pg_temp.check((select user_id from public.order_operations_reviewers where duty = 'pi_handoff') = current_setting('test.reviewer_id')::uuid,
    '2d. the assignment row holds the reviewer id');
end $$;
select pg_temp.restore();

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

-- ═══ 4. AUTHORITY ON THE DECISION ══════════════════════════════════════════

-- An active admin who is NOT the reviewer: refused.
select pg_temp.become(current_setting('test.admin2_id')::uuid);
select pg_temp.expect_error(
  format('select public.decide_order_operations_handoff(%L, %L, null)', (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'accepted'),
  'Only the assigned operations reviewer', '4a. being an admin is not being the reviewer');
select pg_temp.restore();
-- The owner who approved it: refused too.
select pg_temp.become(current_setting('test.owner_id')::uuid);
select pg_temp.expect_error(
  format('select public.decide_order_operations_handoff(%L, %L, null)', (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'accepted'),
  'Only the assigned operations reviewer', '4b. the approver cannot accept in the reviewer''s place');
select pg_temp.restore();
-- An outsider with no Orders access: refused before anything is read.
select pg_temp.become(current_setting('test.outsider_id')::uuid);
select pg_temp.expect_error(
  format('select public.decide_order_operations_handoff(%L, %L, null)', (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'accepted'),
  'You do not have access to Orders', '4c. an outsider is refused');
select pg_temp.restore();

-- The reviewer: a flag needs a reason; an unknown decision is refused.
select pg_temp.become(current_setting('test.reviewer_id')::uuid);
select pg_temp.expect_error(
  format('select public.decide_order_operations_handoff(%L, %L, %L)', (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'clarification_needed', '   '),
  'ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED', '4d. a flag with no reason is refused');
select pg_temp.expect_error(
  format('select public.decide_order_operations_handoff(%L, %L, null)', (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'done'),
  'ORDER_OPERATIONS_HANDOFF_DECISION_UNKNOWN', '4e. only the two decisions exist');
select pg_temp.expect_error(
  format('select public.decide_order_operations_handoff(%L, %L, %L)', (pg_temp.live(current_setting('test.order_b')::uuid)).id, 'clarification_needed', repeat('x', 1001)),
  'ORDER_OPERATIONS_HANDOFF_REASON_TOO_LONG', '4f. the reason is bounded');

-- The reviewer flags it, then accepts after clarification.
do $$
declare h public.order_operations_handoffs; o uuid := current_setting('test.order_b')::uuid; v jsonb;
begin
  v := public.decide_order_operations_handoff((pg_temp.live(o)).id, 'clarification_needed', 'Fabric code on line 1 is not one we stock');
  h := pg_temp.live(o);
  perform pg_temp.check(h.status = 'clarification_needed' and h.clarification_by = current_setting('test.reviewer_id')::uuid
    and h.clarification_reason like 'Fabric code%', '4g. flagged, with actor, time and reason');
  perform pg_temp.check((select count(*) from public.notifications where user_id = current_setting('test.owner_id')::uuid
     and entity_id = o and type::text = 'order_operations_review_decided') = 1, '4g. the approver is told');
  perform pg_temp.check((select count(*) from public.order_activity_log where order_id = o
     and event_type = 'operations_handoff_clarification_needed') = 1, '4g. on the history');
  -- flagging twice is refused
  perform pg_temp.expect_error(
    format('select public.decide_order_operations_handoff(%L, %L, %L)', h.id, 'clarification_needed', 'again'),
    'ORDER_OPERATIONS_HANDOFF_ALREADY_FLAGGED', '4h. a second flag is refused');
  -- then accepted
  v := public.decide_order_operations_handoff(h.id, 'accepted', 'Fabric confirmed by phone');
  h := pg_temp.live(o);
  perform pg_temp.check(h.status = 'accepted' and h.accepted_by = current_setting('test.reviewer_id')::uuid and h.accepted_at is not null,
    '4i. accepted after clarification, with actor and time');
  perform pg_temp.check(h.clarification_reason like 'Fabric code%', '4i. the earlier flag is kept for audit');
  perform pg_temp.check((select payload ->> 'after_clarification' from public.order_activity_log where order_id = o
     and event_type = 'operations_handoff_accepted') = 'true', '4i. history says it followed a clarification');
  perform pg_temp.expect_error(
    format('select public.decide_order_operations_handoff(%L, %L, null)', h.id, 'accepted'),
    'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED', '4j. a second acceptance is refused');
  perform pg_temp.expect_error(
    format('select public.decide_order_operations_handoff(%L, %L, %L)', h.id, 'clarification_needed', 'too late'),
    'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED', '4k. an acceptance cannot be turned into a flag');
end $$;
select pg_temp.restore();

-- ═══ 5. A LATER VERSION: the acceptance does not carry over ════════════════

-- Align the Order for production against V1 first, so the snapshot has something to say.
do $$
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.set_order_production_alignment(current_setting('test.order_b')::uuid, true, 'aligned on V1');
  perform pg_temp.restore();
end $$;

select set_config('test.v2_b', pg_temp.approve_revision(current_setting('test.order_b')::uuid, current_setting('test.owner_id')::uuid)::text, true);

do $$
declare h public.order_operations_handoffs; old public.order_operations_handoffs; o uuid := current_setting('test.order_b')::uuid;
begin
  h := pg_temp.live(o);
  perform pg_temp.check(h.version_number = 2 and h.status = 'awaiting', '5. V2 has its own awaiting handoff');
  perform pg_temp.check(h.pi_version_id = current_setting('test.v2_b')::uuid, '5. tied to the exact V2 version id');
  perform pg_temp.check(h.prior_handoff_status = 'accepted', '5. it records that V1 had been accepted');
  perform pg_temp.check(h.production_alignment_at_approval = 'aligned', '5. and that the Order was already aligned');
  perform pg_temp.check(h.assigned_to = current_setting('test.reviewer_id')::uuid, '5. addressed to the reviewer');
  select * into old from public.order_operations_handoffs where order_id = o and version_number = 1;
  perform pg_temp.check(old.superseded_at is not null and old.superseded_by_version_id = current_setting('test.v2_b')::uuid,
    '5. V1''s handoff is superseded');
  perform pg_temp.check(old.status = 'accepted' and old.accepted_by is not null, '5. V1''s acceptance is preserved for audit');
  perform pg_temp.check((select count(*) from public.order_operations_handoffs where order_id = o and superseded_at is null) = 1,
    '5. exactly one live handoff');
  perform pg_temp.check((select production_alignment from public.orders where id = o) = 'aligned',
    '5. production alignment itself is NOT moved by the handoff');
  -- (every row in this transaction shares one now(), so the V2 notification is
  -- found by what it says rather than by order)
  perform pg_temp.check((select count(*) from public.notifications where entity_id = o and type::text = 'order_operations_review_requested'
     and body like 'You accepted PI V1 earlier%') = 1, '5. the notification says the earlier acceptance does not carry');
  -- accepting the superseded V1 handoff is refused
  perform pg_temp.become(current_setting('test.reviewer_id')::uuid);
  perform pg_temp.expect_error(
    format('select public.decide_order_operations_handoff(%L, %L, null)', old.id, 'accepted'),
    'ORDER_OPERATIONS_HANDOFF_SUPERSEDED', '5b. a stale (superseded) acceptance is refused');
  perform pg_temp.restore();
end $$;

-- ═══ 6. A CANCELLED ORDER ══════════════════════════════════════════════════

select pg_temp.make_pi(current_setting('test.pi_c')::uuid, current_setting('test.sales_id')::uuid, 'ASSERT C', 1000000);
select set_config('test.order_c', pg_temp.approve(current_setting('test.pi_c')::uuid)::text, true);
do $$
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.cancel_order(current_setting('test.order_c')::uuid, 'ASSERT cancelled');
  perform pg_temp.restore();
  perform pg_temp.become(current_setting('test.reviewer_id')::uuid);
  perform pg_temp.expect_error(
    format('select public.decide_order_operations_handoff(%L, %L, null)', (pg_temp.live(current_setting('test.order_c')::uuid)).id, 'accepted'),
    'ORDER_OPERATIONS_HANDOFF_CLOSED', '6. a cancelled Order''s handoff cannot be accepted');
  perform pg_temp.restore();
end $$;

-- Reassigning the reviewer skips the cancelled Order's handoff and readdresses the live awaiting one.
do $$
declare v jsonb;
begin
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  v := public.set_order_operations_reviewer(current_setting('test.admin2_id')::uuid);
  perform pg_temp.restore();
  -- Live and awaiting: A's V1 (never decided) and B's V2. Not C (cancelled),
  -- and not B's V1 (decided, superseded).
  perform pg_temp.check((v ->> 'reassigned_handoffs')::int = 2, '6b. only the live awaiting handoffs (A V1, B V2) move; cancelled C does not');
  perform pg_temp.check((pg_temp.live(current_setting('test.order_b')::uuid)).assigned_to = current_setting('test.admin2_id')::uuid,
    '6b. V2 of B now waits on the new reviewer');
  perform pg_temp.check((select accepted_by from public.order_operations_handoffs where order_id = current_setting('test.order_b')::uuid and version_number = 1)
     = current_setting('test.reviewer_id')::uuid, '6b. the decided V1 keeps who decided it');
  -- clearing the assignment
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  v := public.set_order_operations_reviewer(null);
  perform pg_temp.restore();
  perform pg_temp.check((select user_id from public.order_operations_reviewers where duty = 'pi_handoff') is null, '6c. cleared');
end $$;

-- ═══ 7. PRIVILEGES AND THE GUARD ═══════════════════════════════════════════

do $$
begin
  perform pg_temp.check(not has_function_privilege('anon', 'public.decide_order_operations_handoff(uuid, text, text)', 'EXECUTE'), '7. anon cannot decide');
  perform pg_temp.check(not has_function_privilege('anon', 'public.set_order_operations_reviewer(uuid)', 'EXECUTE'), '7. anon cannot assign');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_operations_handoffs', 'INSERT'), '7. clients cannot insert handoffs');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_operations_handoffs', 'UPDATE'), '7. clients cannot update handoffs');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.order_operations_reviewers', 'UPDATE'), '7. clients cannot rewrite the assignment');
  perform pg_temp.check(has_table_privilege('authenticated', 'public.order_operations_handoffs', 'SELECT'), '7. clients read handoffs (under RLS)');
end $$;

-- The reviewer can see the handoff of an Order they may open; the outsider sees none.
do $$
declare n int;
begin
  perform pg_temp.become(current_setting('test.reviewer_id')::uuid);
  select count(*) into n from public.order_operations_handoffs where order_id = current_setting('test.order_b')::uuid;
  perform pg_temp.restore();
  perform pg_temp.check(n = 2, '7b. the reviewer reads both of B''s handoffs under RLS');
  perform pg_temp.become(current_setting('test.outsider_id')::uuid);
  select count(*) into n from public.order_operations_handoffs;
  perform pg_temp.restore();
  perform pg_temp.check(n = 0, '7c. an outsider reads nothing');
end $$;

-- The guard: no deletion, no rewrite of an acceptance, no un-superseding.
select pg_temp.expect_error(
  format('delete from public.order_operations_handoffs where order_id = %L', current_setting('test.order_b')),
  'ORDER_OPERATIONS_HANDOFF_PERMANENT', '7d. handoffs are never deleted');
select pg_temp.expect_error(
  format('update public.order_operations_handoffs set status = %L, accepted_by = null, accepted_at = null where order_id = %L and version_number = 1', 'awaiting', current_setting('test.order_b')),
  'ORDER_OPERATIONS_HANDOFF', '7e. an acceptance cannot be undone, even by the owner role');
select pg_temp.expect_error(
  format('update public.order_operations_handoffs set version_number = 9 where order_id = %L and version_number = 2', current_setting('test.order_b')),
  'ORDER_OPERATIONS_HANDOFF_FROZEN', '7f. identity is frozen');

do $$ begin raise notice 'ALL HANDOFF ASSERTIONS PASSED'; end $$;

rollback;
