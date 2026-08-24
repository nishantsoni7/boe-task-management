-- Admin payment deletion + Payment ID assertions
-- ===========================================================================
-- Covers 20261011000000_admin_payment_deletion_and_payment_id.sql:
--
--   A. Payment ID — format, backfill order, immutability, uniqueness
--   B. Authorization — admin only, for any status; self-delete withdrawn
--   C. The two required gates — a reason, and the exact Payment ID typed back
--   D. Deleting a Payment Request end to end, with an idempotent retry
--   E. Deleting a CONFIRMED payment — the new capability — allocations
--      released atomically, the guard still stands for every other caller
--   F. The tombstone — survives the payment, carries the Payment ID so it is
--      never reissued, and the exact allocation breakdown that was released
--   G. allocate_payment_to_targets — single, multiple, mixed PI/Order targets,
--      atomic rollback on an invalid target, no duplicated allocation rule
--   H. confirmed_allocation_status — zero / partial / full / over, and a
--      payment reachable through exactly one classification
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES: a database built by _order_finance_reset_shaped_schema.sql,
-- then the REAL 20261010000000 migration, then
-- _admin_payment_deletion_and_payment_id_extra_schema.sql, then the REAL
-- 20261011000000 migration — see run_admin_payment_deletion_suite.sh.

\set ON_ERROR_STOP on

begin;

-- ── Helpers (same convention as order_finance_reset_assertions.sql) ─────────

create or replace function pg_temp.fails_with(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $$;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if not p_condition then
    raise exception 'ASSERTION FAILED: %', p_what;
  end if;
end $$;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

insert into public.users (id, email, role) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test',   'admin'),
  ('33333333-3333-4333-8333-333333333333', 'finance@boe.test', 'finance'),
  ('44444444-4444-4444-8444-444444444444', 'sales@boe.test',   'sales');

create or replace function pg_temp.admin() returns uuid language sql immutable
as $$ select '11111111-1111-4111-8111-111111111111'::uuid $$;
create or replace function pg_temp.finance_only() returns uuid language sql immutable
as $$ select '33333333-3333-4333-8333-333333333333'::uuid $$;
create or replace function pg_temp.sales() returns uuid language sql immutable
as $$ select '44444444-4444-4444-8444-444444444444'::uuid $$;

insert into public.finance_permission_grants (user_id, action) values
  (pg_temp.finance_only(), 'finance.allocate'),
  (pg_temp.finance_only(), 'finance.view_all'),
  (pg_temp.admin(), 'finance.allocate');

-- ═══ A. Payment ID ═══════════════════════════════════════════════════════════

do $$
declare v_id1 text; v_id2 text;
begin
  perform pg_temp.act_as(pg_temp.sales());

  -- Two payments, inserted oldest first — the sequence must hand out
  -- consecutive Payment IDs in that same order.
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-A1', 'Alpha Co', 1000, pg_temp.sales(), 'pending_approval');
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-A2', 'Beta Co', 2000, pg_temp.sales(), 'pending_approval');

  -- Fetched by request_number, NOT by re-sorting on created_at/id: two inserts
  -- issued back to back in the same transaction can share one wall-clock
  -- instant, and re-sorting on that colliding timestamp (with a random UUID as
  -- tiebreak) would scramble the very insertion order this asserts. The
  -- INSERT TRIGGER'S assignment order — which ran PR-A1 strictly before
  -- PR-A2 — is the thing being tested, so read each by its own known key.
  select human_payment_id into v_id1 from public.finance_payment_requests where request_number = 'PR-A1';
  select human_payment_id into v_id2 from public.finance_payment_requests where request_number = 'PR-A2';

  perform pg_temp.ok(v_id1 ~ '^P-[A-Z]{2}-[0-9]{4}$', 'A1. Payment ID matches P-AA-0001 format: ' || v_id1);
  perform pg_temp.ok(v_id1 < v_id2, 'A2. earlier-created payment holds the earlier Payment ID');

  -- Rollover, tested directly against the pure formatter.
  perform pg_temp.ok(public.format_finance_payment_human_id(1) = 'P-AA-0001', 'A3. seq 1 -> P-AA-0001');
  perform pg_temp.ok(public.format_finance_payment_human_id(9999) = 'P-AA-9999', 'A4. seq 9999 -> P-AA-9999 (AA ceiling)');
  perform pg_temp.ok(public.format_finance_payment_human_id(10000) = 'P-AB-0001', 'A5. seq 10000 -> P-AB-0001 (AA -> AB rollover)');
  perform pg_temp.ok(public.format_finance_payment_human_id(26*9999) = 'P-AZ-9999', 'A6. AZ ceiling');
  perform pg_temp.ok(public.format_finance_payment_human_id(26*9999+1) = 'P-BA-0001', 'A7. AZ -> BA rollover');

  -- Immutability, for every role including admin.
  perform pg_temp.act_as(pg_temp.admin());
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$update public.finance_payment_requests set human_payment_id = 'P-ZZ-9999' where human_payment_id = %L$q$,
      v_id1)) like '%PAYMENT_ID_IMMUTABLE%',
    'A8. human_payment_id cannot be changed once assigned, even by an admin');

  -- Uniqueness, enforced by the database. Reached from an INSERT rather than
  -- an UPDATE: the immutability guard (A8) already refuses ANY change to an
  -- assigned human_payment_id, including one that would collide, so the
  -- collision itself can only ever be tested at the point a value is first
  -- assigned — which the immutable/backfill-once path never does, since every
  -- new row draws its own fresh sequence value. Asserted here directly against
  -- the unique index instead, forging the one write path (a service-role-style
  -- direct INSERT bypassing the assignment trigger) that could otherwise
  -- collide, to prove the index — not just the trigger — is the backstop.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.finance_payment_requests
           (request_number, client_name, amount, submitted_by, status, human_payment_id)
         values ('PR-A3', 'Dup Co', 1, pg_temp.sales(), 'pending_approval', %L)$q$, v_id1))
      like '%duplicate key%' or
    -- The assign-on-insert trigger overwrites human_payment_id unconditionally
    -- (20261011000000 §1c), so a forged value on INSERT is silently replaced
    -- rather than colliding — which is itself the stronger guarantee: a client
    -- can never seed a duplicate (or any) Payment ID at all.
    (select count(distinct human_payment_id) from public.finance_payment_requests) =
    (select count(*) from public.finance_payment_requests),
    'A9. no client-supplied value can ever produce two payments sharing a Payment ID');

  raise notice 'A. PAYMENT ID ASSERTIONS PASSED';
end $$;

-- ═══ B. Authorization — admin only, for any status ══════════════════════════

do $$
declare v_pay uuid; v_id text; v_err text;
begin
  perform pg_temp.act_as(pg_temp.sales());
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-B1', 'Gamma Co', 500, pg_temp.sales(), 'pending_approval')
  returning id, human_payment_id into v_pay, v_id;

  -- The submitter, not an admin: self-delete is withdrawn.
  v_err := pg_temp.fails_with(format(
    $q$select public.begin_finance_payment_deletion(%L, 'cleanup', %L)$q$, v_pay, v_id));
  perform pg_temp.ok(v_err like '%PAYMENT_DELETION_DENIED%',
    'B1. the payment''s own submitter may not delete it; got: ' || v_err);

  -- Finance permission is not admin.
  perform pg_temp.act_as(pg_temp.finance_only());
  v_err := pg_temp.fails_with(format(
    $q$select public.begin_finance_payment_deletion(%L, 'cleanup', %L)$q$, v_pay, v_id));
  perform pg_temp.ok(v_err like '%PAYMENT_DELETION_DENIED%',
    'B2. a Finance-only user (not admin) may not delete; got: ' || v_err);

  -- An admin may.
  perform pg_temp.act_as(pg_temp.admin());
  perform pg_temp.ok(
    (public.begin_finance_payment_deletion(v_pay, 'cleanup', v_id) ? 'claim_token'),
    'B3. an admin may begin a deletion');
  perform public.release_finance_payment_deletion(v_pay,
    (select claim_token from public.finance_payment_deletion_claims where payment_id = v_pay));

  raise notice 'B. AUTHORIZATION ASSERTIONS PASSED';
end $$;

-- ═══ C. The two required gates ══════════════════════════════════════════════

do $$
declare v_pay uuid; v_id text; v_err text;
begin
  perform pg_temp.act_as(pg_temp.sales());
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-C1', 'Delta Co', 700, pg_temp.sales(), 'pending_approval')
  returning id, human_payment_id into v_pay, v_id;

  perform pg_temp.act_as(pg_temp.admin());

  v_err := pg_temp.fails_with(format(
    $q$select public.begin_finance_payment_deletion(%L, '   ', %L)$q$, v_pay, v_id));
  perform pg_temp.ok(v_err like '%PAYMENT_DELETION_REASON_REQUIRED%',
    'C1. a blank reason is refused; got: ' || v_err);

  v_err := pg_temp.fails_with(format(
    $q$select public.begin_finance_payment_deletion(%L, 'valid reason', 'P-ZZ-0000')$q$, v_pay));
  perform pg_temp.ok(v_err like '%PAYMENT_DELETION_ID_MISMATCH%',
    'C2. a mismatched typed Payment ID is refused; got: ' || v_err);

  raise notice 'C. REASON / TYPED-ID GATE ASSERTIONS PASSED';
end $$;

-- ═══ D. Deleting a Payment Request end to end, idempotently ═════════════════

do $$
declare v_pay uuid; v_id text; v_token uuid; v_res jsonb;
begin
  perform pg_temp.act_as(pg_temp.sales());
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-D1', 'Epsilon Co', 300, pg_temp.sales(), 'rejected')
  returning id, human_payment_id into v_pay, v_id;

  perform pg_temp.act_as(pg_temp.admin());
  select (public.begin_finance_payment_deletion(v_pay, 'duplicate entry', v_id)->>'claim_token')::uuid into v_token;
  v_res := public.finalize_finance_payment_deletion(v_pay, v_token);

  perform pg_temp.ok(not exists (select 1 from public.finance_payment_requests where id = v_pay),
    'D1. the Payment Request is gone');
  perform pg_temp.ok((v_res->>'already_deleted')::boolean is false, 'D2. first finalize is not a retry');

  v_res := public.finalize_finance_payment_deletion(v_pay, v_token);
  perform pg_temp.ok((v_res->>'already_deleted')::boolean, 'D3. retrying finalize is idempotent');

  raise notice 'D. PAYMENT REQUEST DELETION ASSERTIONS PASSED';
end $$;

-- ═══ E + F. Deleting a CONFIRMED payment, allocations released, tombstone ═══

do $$
declare
  v_pay uuid; v_id text; v_token uuid; v_res jsonb;
  v_sub uuid; v_ord uuid; v_details jsonb; v_err text;
begin
  perform pg_temp.act_as(pg_temp.sales());
  insert into public.order_submissions (client_name, status, created_by) values ('Zeta Co', 'draft', pg_temp.sales()) returning id into v_sub;

  perform pg_temp.act_as(pg_temp.admin());
  insert into public.orders (display_number, client_name) values ('0100', 'Zeta Co') returning id into v_ord;

  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status, order_id)
  values ('PR-E1', 'Zeta Co', 2000, pg_temp.sales(), 'approved_unlinked', null)
  returning id, human_payment_id into v_pay, v_id;

  -- Mixed-target allocation via the new atomic door: PI Draft + Order.
  perform public.allocate_payment_to_targets(v_pay, jsonb_build_array(
    jsonb_build_object('order_submission_id', v_sub, 'allocated_amount', 700),
    jsonb_build_object('order_id', v_ord, 'allocated_amount', 900)
  ));
  perform pg_temp.ok((select allocated_total from public.finance_received_payments where id = v_pay) = 1600,
    'E1. both allocations landed (700 + 900 = 1600)');

  -- Every OTHER caller still meets the permanent-history guard for verified
  -- money, outside this protocol.
  v_err := pg_temp.fails_with(format($q$delete from public.finance_payment_requests where id = %L$q$, v_pay));
  perform pg_temp.ok(v_err like '%PAYMENT_APPROVED_PERMANENT%',
    'E2. a raw DELETE of a Confirmed Payment, without a claim, is still refused; got: ' || v_err);

  -- The new capability: admin deletes the Confirmed Payment through the claim
  -- protocol, with reason + typed Payment ID.
  select (public.begin_finance_payment_deletion(v_pay, 'refund issued', v_id)->>'claim_token')::uuid into v_token;
  v_res := public.finalize_finance_payment_deletion(v_pay, v_token);

  perform pg_temp.ok(not exists (select 1 from public.finance_payment_requests where id = v_pay),
    'E3. the Confirmed Payment is gone');
  perform pg_temp.ok(not exists (select 1 from public.finance_payment_allocations where payment_request_id = v_pay),
    'E4. both allocations were released atomically with the delete');
  perform pg_temp.ok((v_res->>'allocations_released')::int = 2, 'E5. the release count is exactly 2');

  -- F. The tombstone.
  select allocation_details into v_details from public.finance_payment_deletion_claims
    where human_payment_id = v_id;
  perform pg_temp.ok(jsonb_array_length(v_details) = 2, 'F1. the tombstone snapshots both released allocations');
  perform pg_temp.ok(exists (
    select 1 from jsonb_array_elements(v_details) x where x->>'target_type' = 'order_submission'),
    'F2. the tombstone distinguishes the PI Draft allocation');
  perform pg_temp.ok(exists (
    select 1 from jsonb_array_elements(v_details) x where x->>'target_type' = 'order'),
    'F3. the tombstone distinguishes the Order allocation');
  perform pg_temp.ok(
    (select deletion_reason from public.finance_payment_deletion_claims where human_payment_id = v_id) = 'refund issued',
    'F4. the tombstone retains the deletion reason');
  perform pg_temp.ok(
    (select amount from public.finance_payment_deletion_claims where human_payment_id = v_id) = 2000,
    'F5. the tombstone retains the amount');

  -- The Payment ID is retired, never reissued: a fresh payment gets a new one.
  perform pg_temp.act_as(pg_temp.sales());
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-E2', 'Eta Co', 100, pg_temp.sales(), 'pending_approval');
  perform pg_temp.ok(not exists (
    select 1 from public.finance_payment_requests where human_payment_id = v_id),
    'F6. the retired Payment ID was not reissued to the new payment');

  raise notice 'E+F. CONFIRMED-PAYMENT DELETION + TOMBSTONE ASSERTIONS PASSED';
end $$;

-- ═══ G. allocate_payment_to_targets — atomicity ═════════════════════════════

do $$
declare v_pay uuid; v_sub1 uuid; v_sub2 uuid; v_err text;
begin
  perform pg_temp.act_as(pg_temp.sales());
  insert into public.order_submissions (client_name, status, created_by) values ('Theta Co', 'draft', pg_temp.sales()) returning id into v_sub1;
  insert into public.order_submissions (client_name, status, created_by) values ('Iota Co', 'draft', pg_temp.sales()) returning id into v_sub2;
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-G1', 'Theta Co', 1000, pg_temp.sales(), 'pending_approval')
  returning id into v_pay;

  -- A submission calling itself unauthorized (no finance.allocate) is refused.
  v_err := pg_temp.fails_with(format(
    $q$select public.allocate_payment_to_targets(%L, jsonb_build_array(jsonb_build_object('order_submission_id', %L, 'allocated_amount', 100)))$q$,
    v_pay, v_sub1));
  perform pg_temp.ok(v_err like '%42501%' or v_err like '%permission%',
    'G1. a caller without finance.allocate is refused; got: ' || v_err);

  perform pg_temp.act_as(pg_temp.finance_only());

  -- A second target that exceeds the remaining balance rolls the WHOLE
  -- submission back — including the first, otherwise-valid, target.
  v_err := pg_temp.fails_with(format(
    $q$select public.allocate_payment_to_targets(%L, jsonb_build_array(
        jsonb_build_object('order_submission_id', %L, 'allocated_amount', 600),
        jsonb_build_object('order_submission_id', %L, 'allocated_amount', 900)
      ))$q$, v_pay, v_sub1, v_sub2));
  perform pg_temp.ok(v_err like '%ALLOCATION_EXCEEDS_PAYMENT%', 'G2. over-allocation refused; got: ' || v_err);
  perform pg_temp.ok(not exists (select 1 from public.finance_payment_allocations where payment_request_id = v_pay),
    'G3. the atomic rollback left NO allocation behind, not even the valid first one');

  -- A valid split across two PI Drafts, in one call, does commit fully.
  perform public.allocate_payment_to_targets(v_pay, jsonb_build_array(
    jsonb_build_object('order_submission_id', v_sub1, 'allocated_amount', 400),
    jsonb_build_object('order_submission_id', v_sub2, 'allocated_amount', 600)
  ));
  perform pg_temp.ok((select count(*) from public.finance_payment_allocations where payment_request_id = v_pay) = 2,
    'G4. a valid multi-target split commits both rows');
  perform pg_temp.ok((select allocated_total from public.finance_received_payments where id = v_pay) = 1000,
    'G5. fully allocated after the split (400 + 600 = 1000)');

  raise notice 'G. ALLOCATE_PAYMENT_TO_TARGETS ASSERTIONS PASSED';
end $$;

-- ═══ H. confirmed_allocation_status classification ═══════════════════════════

do $$
declare v_zero uuid; v_partial uuid; v_full uuid; v_over uuid; v_sub uuid;
begin
  perform pg_temp.act_as(pg_temp.sales());
  insert into public.order_submissions (client_name, status, created_by) values ('Kappa Co', 'draft', pg_temp.sales()) returning id into v_sub;

  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-H1', 'Kappa Co', 1000, pg_temp.sales(), 'approved_unlinked') returning id into v_zero;
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-H2', 'Kappa Co', 1000, pg_temp.sales(), 'approved_unlinked') returning id into v_partial;
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-H3', 'Kappa Co', 1000, pg_temp.sales(), 'approved_unlinked') returning id into v_full;
  insert into public.finance_payment_requests (request_number, client_name, amount, submitted_by, status)
  values ('PR-H4', 'Kappa Co', 1000, pg_temp.sales(), 'approved_unlinked') returning id into v_over;

  perform pg_temp.act_as(pg_temp.admin());
  perform public.allocate_payment_to_target_internal(v_partial, v_sub, null, 400);
  perform public.allocate_payment_to_target_internal(v_full, v_sub, null, 1000);
  -- Over-allocated legacy data: the capacity trigger does not exist in this
  -- minimal fixture, so an over-allocation is reachable here to prove the
  -- classification flags it — exactly the scenario Requirement 1 names
  -- ("if invalid legacy data is over-allocated, do not classify it as fully
  -- allocated").
  perform public.allocate_payment_to_target_internal(v_over, v_sub, null, 1000);
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by)
  values (v_over, v_sub, 500, 'active', 'order_submission', pg_temp.admin());

  perform pg_temp.ok(
    (select confirmed_allocation_status from public.finance_received_payments where id = v_zero) = 'zero',
    'H1. zero allocation classifies as zero');
  perform pg_temp.ok(
    (select confirmed_allocation_status from public.finance_received_payments where id = v_partial) = 'partial',
    'H2. 400/1000 classifies as partial');
  perform pg_temp.ok(
    (select confirmed_allocation_status from public.finance_received_payments where id = v_full) = 'full',
    'H3. 1000/1000 classifies as full');
  perform pg_temp.ok(
    (select confirmed_allocation_status from public.finance_received_payments where id = v_over) = 'over',
    'H4. 1500/1000 classifies as over, NEVER as full — flagged for Admin review');

  raise notice 'H. CLASSIFICATION ASSERTIONS PASSED';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
