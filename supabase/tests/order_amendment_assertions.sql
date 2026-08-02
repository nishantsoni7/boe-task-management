-- Order amendment assertions
-- ===========================================================================
-- Covers 20260804000000_order_amendments.sql:
--
--   A. the commercial-column guard, including what it deliberately allows
--   B. amend_order()  — the admin's direct door
--   C. order_change_requests RLS — who may file, and against what
--   D. approve / reject — the proposal door, and its races
--   E. cancel_order()  — the reason and the money position
--   F. privileges — nothing internal became callable by a client role
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded. It does consume Order numbers if the fixtures below are created
-- through the normal INSERT path — public.orders_display_number_seq is a
-- SEQUENCE and nextval() is NOT transactional. That is the only trace this
-- script leaves.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that may set session GUCs (standard Supabase
--     `postgres`).
--   * Replace the THREE real user UUIDs below; all must exist and be distinct:
--       test.admin_id  -> a public.users row with role = 'admin', is_active
--       test.sales_a   -> a NON-admin, is_active. Owns the fixture Orders.
--       test.sales_b   -> a different NON-admin, is_active. Owns nothing.
--
-- Every guard under test is a trigger or a SECURITY DEFINER function, so this
-- script simulates the session with request.jwt.claims rather than SET ROLE —
-- the same idiom the other assertion scripts in this directory use.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id', '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.sales_a',  '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.sales_b',  '33333333-3333-3333-3333-333333333333', true); -- REPLACE
end $$;

-- ── Helpers ───────────────────────────────────────────────────────────────────

create or replace function pg_temp.fails_with(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $$;

-- Becomes the given user for the rest of the DO block.
create or replace function pg_temp.act_as(p_user text)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting(p_user), 'role', 'authenticated')::text, true);
end $$;

-- A Confirmed Order owned by sales_a, created directly so the fixture does not
-- depend on the whole Order Request → conversion chain being exercisable here.
create or replace function pg_temp.new_order(p_status text default 'running')
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into public.orders
    (client_name, requested_by, assigned_to, created_by, status,
     total_value, total_product_value, confirm_date, due_date, lead_source, notes)
  values
    ('QA-AMEND client', current_setting('test.sales_a')::uuid,
     current_setting('test.sales_a')::uuid, current_setting('test.admin_id')::uuid, p_status,
     250000, 210000, date '2026-07-01', date '2026-08-15', 'reference', 'original note')
  returning id into v_id;
  return v_id;
end $$;

create or replace function pg_temp.amend_events(p_order uuid)
returns integer
language sql
as $$
  select count(*)::int from public.order_activity_log
   where order_id = p_order and event_type = 'order_amended'
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. The guard: commercial columns are locked, operational ones are not
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_order uuid;
  v_err   text;
begin
  v_order := pg_temp.new_order();

  -- The whole point of the migration. Note this runs as the table OWNER, with
  -- no RLS in the way at all — the refusal comes from the trigger, which is
  -- what makes it hold for the service role and for direct SQL too.
  v_err := pg_temp.fails_with(format(
    $q$update public.orders set total_value = 999999 where id = %L$q$, v_order));
  assert v_err like '42501|ORDER_AMENDMENT_REQUIRED%',
    'a raw total_value update must be refused, got: ' || v_err;

  v_err := pg_temp.fails_with(format(
    $q$update public.orders set client_name = 'Rewritten' where id = %L$q$, v_order));
  assert v_err like '42501|ORDER_AMENDMENT_REQUIRED%',
    'a raw client_name update must be refused, got: ' || v_err;

  v_err := pg_temp.fails_with(format(
    $q$update public.orders set assigned_to = %L where id = %L$q$,
    current_setting('test.sales_b'), v_order));
  assert v_err like '42501|ORDER_AMENDMENT_REQUIRED%',
    'a raw reassignment must be refused, got: ' || v_err;

  -- Frozen, and frozen even for an amendment: the creation record.
  v_err := pg_temp.fails_with(format(
    $q$update public.orders set created_by = %L where id = %L$q$,
    current_setting('test.sales_b'), v_order));
  assert v_err like '42501|ORDER_FIELD_FROZEN%',
    'created_by must be frozen, got: ' || v_err;

  -- notes joined the guarded tier in 20260806000000 §5, so that the trigger
  -- and the column grants agree about it. It is a change to what the order
  -- says and now earns an actor and a reason like every other term.
  v_err := pg_temp.fails_with(format(
    $q$update public.orders set notes = 'sneaked in' where id = %L$q$, v_order));
  assert v_err like '42501|ORDER_AMENDMENT_REQUIRED%',
    'a raw notes update must be refused, got: ' || v_err;

  -- ALLOWED, and this half matters as much as the refusals. Operational
  -- movement must not have been broken by the guard. `status` is the ONLY
  -- column left outside it.
  update public.orders set status = 'on_hold' where id = v_order;
  assert (select status = 'on_hold' from public.orders where id = v_order),
    'status must remain freely updatable';

  -- A no-op rewrite of a guarded column is not a change and must not raise.
  update public.orders
     set total_value = (select total_value from public.orders where id = v_order)
   where id = v_order;

  update public.orders set status = 'running' where id = v_order;
  raise notice 'A. commercial-column guard OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. amend_order() — the admin's direct door
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_order   uuid;
  v_err     text;
  v_payload jsonb;
begin
  v_order := pg_temp.new_order();

  -- A non-admin cannot use this door at all.
  perform pg_temp.act_as('test.sales_a');
  v_err := pg_temp.fails_with(format(
    $q$select public.amend_order(%L, 'trying it on', p_total_value => 1)$q$, v_order));
  assert v_err like '42501|ORDER_AMENDMENT_FORBIDDEN%',
    'a non-admin must be refused by amend_order, got: ' || v_err;

  perform pg_temp.act_as('test.admin_id');

  -- A reason is mandatory.
  v_err := pg_temp.fails_with(format(
    $q$select public.amend_order(%L, '   ', p_total_value => 300000)$q$, v_order));
  assert v_err like '22023|ORDER_AMENDMENT_NO_REASON%',
    'an amendment with no reason must be refused, got: ' || v_err;

  -- Negative money is refused here as well as by the CHECK on the request table.
  v_err := pg_temp.fails_with(format(
    $q$select public.amend_order(%L, 'negative', p_total_value => -1)$q$, v_order));
  assert v_err like '22023|ORDER_VALUE_NEGATIVE%',
    'a negative order value must be refused, got: ' || v_err;

  -- An amendment that changes nothing writes no audit row; it raises.
  v_err := pg_temp.fails_with(format(
    $q$select public.amend_order(%L, 'no change', p_total_value => 250000)$q$, v_order));
  assert v_err like '22023|ORDER_AMENDMENT_NO_CHANGE%',
    'a no-op amendment must be refused, got: ' || v_err;
  assert pg_temp.amend_events(v_order) = 0,
    'a refused amendment must leave no audit row';

  -- The real thing.
  v_payload := public.amend_order(
    v_order, 'Client added two chairs',
    p_total_value => 300000, p_due_date => date '2026-09-01');

  assert (select total_value = 300000 and due_date = date '2026-09-01'
          from public.orders where id = v_order),
    'the amendment must have been applied';

  -- NULL means "leave alone" — the untouched fields are untouched.
  assert (select client_name = 'QA-AMEND client' and total_product_value = 210000
                 and lead_source = 'reference' and notes = 'original note'
          from public.orders where id = v_order),
    'fields not named in the amendment must be unchanged';

  assert pg_temp.amend_events(v_order) = 1, 'exactly one audit row must be written';

  -- The audit row records BOTH sides of every field that moved, and only those.
  assert (select payload -> 'changes' -> 'total_value' ->> 'from' = '250000'
                 and payload -> 'changes' -> 'total_value' ->> 'to' = '300000'
                 and payload -> 'changes' ? 'due_date'
                 and not (payload -> 'changes' ? 'client_name')
                 and payload ->> 'reason' = 'Client added two chairs'
                 and payload ->> 'source' = 'admin_direct'
                 and payload ->> 'actor_id' is null   -- actor lives in actor_id, not payload
          from public.order_activity_log
          where order_id = v_order and event_type = 'order_amended'),
    'the audit payload must carry from/to for exactly the changed fields';

  assert (select actor_id = current_setting('test.admin_id')::uuid
          from public.order_activity_log
          where order_id = v_order and event_type = 'order_amended'),
    'the audit row must name the amending admin';

  assert v_payload -> 'changes' ? 'total_value',
    'the return value must report what changed';

  -- A closed Order is closed to amendment.
  update public.orders set status = 'dispatched' where id = v_order;
  v_err := pg_temp.fails_with(format(
    $q$select public.amend_order(%L, 'too late', p_total_value => 400000)$q$, v_order));
  assert v_err like '42501|ORDER_CLOSED%',
    'a dispatched order must refuse amendment, got: ' || v_err;

  raise notice 'B. amend_order OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. order_change_requests — who may file one, and against what
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_order  uuid;
  v_closed uuid;
  v_err    text;
begin
  v_order  := pg_temp.new_order();
  v_closed := pg_temp.new_order('cancelled');

  -- RLS has to actually be in force for this section to mean anything.
  set local role authenticated;

  -- The owner may file.
  perform pg_temp.act_as('test.sales_a');
  insert into public.order_change_requests
    (order_id, order_number_snapshot, request_type, reason, proposed_total_value)
  values (v_order, 'QA', 'edit', 'Client added two chairs', 300000);

  -- The partial unique index allows exactly one open request of each type.
  v_err := pg_temp.fails_with(format(
    $q$insert into public.order_change_requests
         (order_id, order_number_snapshot, request_type, reason, proposed_total_value)
       values (%L, 'QA', 'edit', 'again', 310000)$q$, v_order));
  assert v_err like '23505|%order_change_requests_one_pending_idx%',
    'a second open edit request must be refused, got: ' || v_err;

  -- ...but a cancellation request is a different type and is allowed alongside.
  insert into public.order_change_requests
    (order_id, order_number_snapshot, request_type, reason)
  values (v_order, 'QA', 'cancel', 'Client backed out');

  -- A stranger may not file against an Order they cannot see.
  perform pg_temp.act_as('test.sales_b');
  v_err := pg_temp.fails_with(format(
    $q$insert into public.order_change_requests
         (order_id, order_number_snapshot, request_type, reason, proposed_total_value)
       values (%L, 'QA', 'edit', 'not mine', 1)$q$, v_order));
  assert v_err like '42501|%row-level security%',
    'a non-participant must be refused, got: ' || v_err;

  -- ...and cannot read the owner's request either.
  assert (select count(*) from public.order_change_requests where order_id = v_order) = 0,
    'a non-participant must not see the owner''s change requests';

  -- Nobody may file against a closed Order.
  perform pg_temp.act_as('test.sales_a');
  v_err := pg_temp.fails_with(format(
    $q$insert into public.order_change_requests
         (order_id, order_number_snapshot, request_type, reason, proposed_total_value)
       values (%L, 'QA', 'edit', 'too late', 1)$q$, v_closed));
  assert v_err like '42501|%row-level security%',
    'a request against a cancelled order must be refused, got: ' || v_err;

  -- A request cannot be filed in someone else's name...
  v_err := pg_temp.fails_with(format(
    $q$insert into public.order_change_requests
         (order_id, order_number_snapshot, request_type, reason, proposed_total_value, requested_by)
       values (%L, 'QA', 'edit', 'spoofed', 1, %L)$q$,
    v_order, current_setting('test.sales_b')));
  assert v_err <> 'NO ERROR', 'a spoofed requested_by must be refused';

  -- ...nor pre-approved, nor filed with review fields already set.
  v_err := pg_temp.fails_with(format(
    $q$insert into public.order_change_requests
         (order_id, order_number_snapshot, request_type, reason, proposed_total_value, status)
       values (%L, 'QA', 'edit', 'self-approved', 1, 'approved')$q$, v_order));
  assert v_err <> 'NO ERROR', 'a self-approved request must be refused';

  -- There is no UPDATE policy for anyone, so a requester cannot approve their
  -- own request by updating the row.
  v_err := pg_temp.fails_with(format(
    $q$update public.order_change_requests set status = 'approved'
        where order_id = %L$q$, v_order));
  -- No policy means zero rows match, which PostgREST surfaces as "changed
  -- nothing" rather than an error — so assert on the effect, not the error.
  assert (select count(*) from public.order_change_requests
           where order_id = v_order and status <> 'pending') = 0,
    'a client UPDATE must never move a request out of pending';

  -- An edit request must propose something; a cancellation must propose nothing.
  v_err := pg_temp.fails_with(format(
    $q$insert into public.order_change_requests
         (order_id, order_number_snapshot, request_type, reason)
       values (%L, 'QA', 'edit', 'proposes nothing')$q$, v_order));
  assert v_err like '23514|%payload_matches_type%',
    'an edit request proposing nothing must be refused, got: ' || v_err;

  reset role;
  raise notice 'C. change-request RLS and constraints OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D. approve / reject
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_order uuid;
  v_req   uuid;
  v_err   text;
begin
  v_order := pg_temp.new_order();

  insert into public.order_change_requests
    (order_id, order_number_snapshot, request_type, requested_by, reason,
     proposed_total_value, proposed_client_name)
  values (v_order, 'QA', 'edit', current_setting('test.sales_a')::uuid,
          'Client added two chairs', 300000, 'QA-AMEND client Pvt Ltd')
  returning id into v_req;

  -- Only an admin reviews.
  perform pg_temp.act_as('test.sales_a');
  v_err := pg_temp.fails_with(format(
    $q$select public.approve_order_change_request(%L)$q$, v_req));
  assert v_err like '42501|ORDER_AMENDMENT_FORBIDDEN%',
    'a non-admin must not approve, got: ' || v_err;

  perform pg_temp.act_as('test.admin_id');
  perform public.approve_order_change_request(v_req, 'Confirmed with client');

  assert (select total_value = 300000 and client_name = 'QA-AMEND client Pvt Ltd'
          from public.orders where id = v_order),
    'approval must apply every proposed field';

  assert (select status = 'approved'
                 and reviewed_by = current_setting('test.admin_id')::uuid
                 and reviewed_at is not null
                 and review_note = 'Confirmed with client'
          from public.order_change_requests where id = v_req),
    'approval must record the decision';

  -- The audit row credits the approving admin and names the request it came from.
  assert (select payload ->> 'source' = 'change_request'
                 and payload ->> 'request_id' = v_req::text
                 and actor_id = current_setting('test.admin_id')::uuid
          from public.order_activity_log
          where order_id = v_order and event_type = 'order_amended'),
    'an approved request must be audited as a change_request amendment';

  -- Approving twice is refused — the second admin finds it already reviewed.
  v_err := pg_temp.fails_with(format(
    $q$select public.approve_order_change_request(%L)$q$, v_req));
  assert v_err like '42501|ORDER_CHANGE_REQUEST_REVIEWED%',
    'a second approval must be refused, got: ' || v_err;
  assert pg_temp.amend_events(v_order) = 1,
    'a refused second approval must not write a second audit row';

  -- Rejection moves the request and nothing else.
  insert into public.order_change_requests
    (order_id, order_number_snapshot, request_type, requested_by, reason, proposed_total_value)
  values (v_order, 'QA', 'edit', current_setting('test.sales_b')::uuid, 'speculative', 999)
  returning id into v_req;

  perform public.reject_order_change_request(v_req, 'Not agreed with client');

  assert (select status = 'rejected' from public.order_change_requests where id = v_req),
    'rejection must record the decision';
  assert (select total_value = 300000 from public.orders where id = v_order),
    'rejection must leave the order untouched';
  assert pg_temp.amend_events(v_order) = 1,
    'rejection must write no audit row on the order';

  -- An approval whose amendment would be refused leaves the request pending:
  -- the whole transaction rolls back together.
  insert into public.order_change_requests
    (order_id, order_number_snapshot, request_type, requested_by, reason, proposed_total_value)
  values (v_order, 'QA', 'edit', current_setting('test.sales_a')::uuid, 'no-op', 300000)
  returning id into v_req;

  v_err := pg_temp.fails_with(format(
    $q$select public.approve_order_change_request(%L)$q$, v_req));
  assert v_err like '22023|ORDER_AMENDMENT_NO_CHANGE%',
    'approving a no-op must be refused, got: ' || v_err;
  assert (select status = 'pending' from public.order_change_requests where id = v_req),
    'a refused approval must leave the request pending';

  raise notice 'D. approve / reject OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. cancel_order() — the reason, and the money position
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_order   uuid;
  v_err     text;
  v_result  jsonb;
begin
  v_order := pg_temp.new_order();

  -- order_number is required alongside order_id for approved_linked, by
  -- finance_payment_requests_status_order_invariant (20260692000000).
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in, proof_note,
     status, submitted_by, order_id, order_number, payment_against)
  values
    ('QA-AMEND client', 50000, current_date, 'bank_transfer', 'company_account',
     'QA fixture', 'approved_linked', current_setting('test.sales_a')::uuid,
     v_order, (select display_number from public.orders where id = v_order),
     'existing_order'),
    -- A pending payment is NOT received money and must not be counted.
    ('QA-AMEND client', 70000, current_date, 'bank_transfer', 'company_account',
     'QA fixture pending', 'pending_approval', current_setting('test.sales_a')::uuid,
     v_order, null, 'existing_order');

  assert public.order_linked_payment_total(v_order) = 50000,
    'only approved_linked money counts toward the received total';

  perform pg_temp.act_as('test.admin_id');

  v_err := pg_temp.fails_with(format($q$select public.cancel_order(%L, '')$q$, v_order));
  assert v_err like '22023|ORDER_CANCEL_NO_REASON%',
    'a cancellation with no reason must be refused, got: ' || v_err;

  v_result := public.cancel_order(v_order, 'Client shifted product line');

  assert (select status = 'cancelled' from public.orders where id = v_order),
    'the order must be cancelled';
  assert (v_result ->> 'received_at_cancellation')::numeric = 50000,
    'the cancellation must report the received total';

  -- Cancellation is not a refund: no payment moved, no payment re-statused.
  assert (select count(*) from public.finance_payment_requests
           where order_id = v_order and status = 'approved_linked') = 1,
    'cancellation must not touch linked payments';

  assert (select payload ->> 'reason' = 'Client shifted product line'
                 and (payload ->> 'received_at_cancellation')::numeric = 50000
                 and payload ->> 'to' = 'cancelled'
          from public.order_activity_log
          where order_id = v_order and event_type = 'status_changed'
          order by created_at desc limit 1),
    'the cancellation audit row must carry the reason and the money position';

  -- Cancelling twice is refused.
  v_err := pg_temp.fails_with(format(
    $q$select public.cancel_order(%L, 'again')$q$, v_order));
  assert v_err like '42501|ORDER_ALREADY_CANCELLED%',
    'a second cancellation must be refused, got: ' || v_err;

  raise notice 'E. cancel_order OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. Privileges — no internal function became client-callable
-- ═══════════════════════════════════════════════════════════════════════════
do $$
begin
  assert not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'apply_order_amendment', 'cancel_order_with_audit',
        'orders_guard_amendable_columns', 'in_order_amendment')
      and (has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('anon', p.oid, 'execute'))
  ), 'no internal amendment function may be executable by anon or authenticated';

  -- ...while the four public doors must be.
  assert (
    select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('amend_order', 'cancel_order',
                        'approve_order_change_request', 'reject_order_change_request')
      and has_function_privilege('authenticated', p.oid, 'execute')
  ) = 4, 'all four public doors must be executable by authenticated';

  -- The table has no UPDATE and no DELETE policy, for anyone.
  assert not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'order_change_requests'
      and cmd in ('UPDATE', 'DELETE')
  ), 'order_change_requests must carry no UPDATE or DELETE policy';

  raise notice 'F. privileges OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. 20260806000000 — privileges are the PRIMARY control
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The review finding this section exists for: before 20260806, the ONLY thing
-- standing between an operations user and total_value was a trigger reading a
-- session variable. These assertions are about the privilege layer, which
-- Postgres checks before RLS and before any trigger runs.
do $$
declare v_cols text;
begin
  -- authenticated may update EXACTLY ONE column.
  select string_agg(column_name, ',' order by column_name) into v_cols
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'orders'
     and grantee = 'authenticated' and privilege_type = 'UPDATE';

  assert v_cols = 'status',
    'authenticated must hold UPDATE on `status` and nothing else, got: ' || coalesce(v_cols, '<none>');

  -- ...and no table-wide UPDATE that would make the column grant moot.
  assert not exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'orders'
       and grantee in ('authenticated', 'anon') and privilege_type = 'UPDATE'
  ), 'no client role may hold table-wide UPDATE on orders';

  -- A Confirmed Order is permanent. 20260705 dropped the DELETE policy but
  -- left the grants; a row-level BEFORE DELETE trigger never fires on TRUNCATE.
  assert not exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'orders'
       and grantee in ('authenticated', 'anon')
       and privilege_type in ('DELETE', 'TRUNCATE')
  ), 'no client role may hold DELETE or TRUNCATE on orders';

  -- anon holds no write privilege at all.
  assert not exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'orders'
       and grantee = 'anon'
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ), 'anon must hold no write privilege on orders';

  -- service_role keeps its grants on purpose: existing service routes depend on
  -- them, and the 20260804 trigger is the layer that covers that role.
  assert exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'orders'
       and grantee = 'service_role' and privilege_type = 'UPDATE'
  ), 'service_role must retain UPDATE; the trigger is what guards it';

  -- Every amendment function pins pg_temp last, so a temp table cannot shadow
  -- a relation inside a SECURITY DEFINER body.
  assert not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'in_order_amendment', 'orders_guard_amendable_columns',
        'apply_order_amendment', 'order_linked_payment_total',
        'cancel_order_with_audit', 'assert_order_amender', 'amend_order',
        'cancel_order', 'approve_order_change_request',
        'reject_order_change_request', 'capture_order_change_baseline')
      and not (coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public, pg_temp%')
  ), 'every amendment function must set search_path = public, pg_temp';

  raise notice 'G. privileges and search_path OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- H. 20260806000000 — baseline capture and stale-approval refusal
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_order uuid;
  v_req   uuid;
  v_err   text;
begin
  v_order := pg_temp.new_order();

  -- The baseline is captured server-side and OVERWRITES whatever the client
  -- sent. A requester who could supply their own baseline could suppress the
  -- staleness gate simply by echoing the current value back.
  insert into public.order_change_requests
    (order_id, order_number_snapshot, request_type, requested_by, reason,
     proposed_total_value, baseline_total_value)
  values (v_order, 'QA', 'edit', current_setting('test.sales_a')::uuid,
          'Client added two chairs', 300000, 999999)   -- forged baseline
  returning id into v_req;

  assert (select baseline_total_value = 250000 and baseline_client_name = 'QA-AMEND client'
          from public.order_change_requests where id = v_req),
    'the baseline must be captured from the order, never accepted from the client';

  -- The clobbering scenario. An admin amends directly, THEN opens the older
  -- request. Approving it would silently undo the newer figure.
  perform pg_temp.act_as('test.admin_id');
  perform public.amend_order(v_order, 'Client also added a wardrobe', p_total_value => 400000);

  v_err := pg_temp.fails_with(format(
    $q$select public.approve_order_change_request(%L)$q$, v_req));
  assert v_err like '40001|ORDER_CHANGE_REQUEST_STALE%',
    'approving a request raised against a superseded value must be refused, got: ' || v_err;

  -- Refused, not auto-rejected: a human decides whether the proposal still
  -- makes sense against the new figure.
  assert (select status = 'pending' from public.order_change_requests where id = v_req),
    'a stale request must stay pending';
  assert (select total_value = 400000 from public.orders where id = v_order),
    'the newer value must survive the refused approval';

  -- Staleness is per-field. A request proposing total_value is NOT stale
  -- because somebody moved the due date.
  insert into public.order_change_requests
    (order_id, order_number_snapshot, request_type, requested_by, reason, proposed_total_value)
  values (v_order, 'QA', 'edit', current_setting('test.sales_b')::uuid, 'fresh', 450000)
  returning id into v_req;

  perform public.amend_order(v_order, 'Date slipped', p_due_date => date '2026-12-01');

  perform public.approve_order_change_request(v_req);
  assert (select total_value = 450000 from public.orders where id = v_order),
    'unrelated movement must not block an approval';

  raise notice 'H. baseline capture and staleness OK';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
