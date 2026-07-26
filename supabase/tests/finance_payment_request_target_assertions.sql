-- Finance payment TARGET assertions (20260715000000)
-- ===========================================================================
-- Validates the three-target submission contract introduced by
-- 20260715000000_finance_payment_request_targets.sql:
--
--   * column   public.finance_payment_requests.payment_target_type
--   * CHECKs   finance_payment_requests_target_type_check
--              finance_payment_requests_target_type_origin
--              finance_payment_requests_request_link_invariant  (relaxed)
--              finance_payment_requests_one_link_target         (unchanged)
--   * trigger  finance_payment_requests_derive_target
--   * trigger  log_finance_payment_request_activity             (target audit)
--   * RPC      approve_finance_payment_request                  (request branch)
--   * RPC      convert_order_request_to_order                   (two guards)
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture —
-- including the Confirmed Order the conversion creates and the Order number it
-- allocates from public.order_number_cycle — is discarded. (Since 20260703 the
-- number cycle is a TABLE row, not a sequence, so a rolled-back conversion
-- returns the number to the pool. Verify order_number_cycle.next_number is
-- unchanged afterwards.)
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that bypasses RLS (standard Supabase `postgres`
--     connection) and may SET the `role` GUC to 'authenticated'.
--   * Replace the THREE real user UUIDs below:
--       test.admin_id  -> a public.users row with role = 'admin'
--       test.sales_id  -> a NON-admin, ELIGIBLE order assignee
--       test.sales2_id -> a SECOND, DISTINCT non-admin ELIGIBLE order assignee,
--                         with NO relationship to the fixture requests. Used to
--                         prove the authorization rule.
--
-- Reminder about role and RLS (reused from the attachment assertions):
-- `supabase db query -f` / a plain psql superuser connection BYPASSES RLS, so a
-- check that depends on RLS must `set_config('role','authenticated',true)`
-- first, and every write to a temp/fixture table must happen after `reset role`.
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back. Any failed
-- ASSERT aborts the transaction with an error.
--
-- NOTE: like the other files in this directory, this script is run in a
-- controlled, already-migrated environment; it is not executed by the JS suite.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id',  '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.sales_id',  '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.sales2_id', '44444444-4444-4444-4444-444444444444', true); -- REPLACE

  perform set_config('test.req_open',      gen_random_uuid()::text, true);
  perform set_config('test.req_clarify',   gen_random_uuid()::text, true);
  perform set_config('test.req_rejected',  gen_random_uuid()::text, true);
  perform set_config('test.req_converted', gen_random_uuid()::text, true);
  perform set_config('test.req_draft',     gen_random_uuid()::text, true);
  perform set_config('test.req_convert',   gen_random_uuid()::text, true);
end $$;

-- ── Fixtures (superuser connection; RLS bypassed) ─────────────────────────────
-- Five Order Requests owned by the salesperson, one per state the target rules
-- have to distinguish, plus one used exclusively by the conversion guards.
-- request_number is assigned by its own trigger.
insert into public.order_requests
  (id, client_name, requested_by, created_by, assigned_to, status, total_value, finalized_at)
values
  (current_setting('test.req_open')::uuid,     'ASSERT target open',      current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted',           1000000, now()),
  (current_setting('test.req_clarify')::uuid,  'ASSERT target clarify',   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'needs_clarification', 1000000, now()),
  (current_setting('test.req_rejected')::uuid, 'ASSERT target rejected',  current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'rejected',            1000000, now()),
  (current_setting('test.req_draft')::uuid,    'ASSERT target draft',     current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted',           1000000, null),
  (current_setting('test.req_convert')::uuid,  'ASSERT target convert',   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted',           1000000, now());

-- A disposable Confirmed Order, for the Confirmed Order target and for the
-- converted-request fixture. display_number is assigned by
-- orders_assign_display_number from the cycle; ROLLBACK returns it.
insert into public.orders (client_name, created_by, status)
values ('ASSERT target order client', current_setting('test.admin_id')::uuid, 'running');

do $$
declare v_order uuid;
begin
  select id into v_order from public.orders where client_name = 'ASSERT target order client';
  perform set_config('test.order_id', v_order::text, true);

  -- The converted request points at that Order, satisfying
  -- order_requests_converted_consistency.
  insert into public.order_requests
    (id, client_name, requested_by, created_by, assigned_to, status,
     converted_order_id, converted_at, finalized_at)
  values
    (current_setting('test.req_converted')::uuid, 'ASSERT target converted',
     current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
     current_setting('test.sales_id')::uuid, 'converted', v_order, now(), now());
end $$;

-- A reusable payment inserter: everything except the target is fixed, so each
-- assertion below states only what it is actually testing.
create or replace function pg_temp.new_payment(
  p_client   text,
  p_order_req uuid    default null,
  p_order    uuid     default null,
  p_order_no text     default null,
  p_amount   numeric  default 100000,
  p_submitter uuid    default null
) returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     order_request_id, order_id, order_number, submitted_by)
  values
    (p_client, p_amount, current_date, 'bank_transfer', 'company_account',
     p_order_req, p_order, p_order_no,
     coalesce(p_submitter, current_setting('test.sales_id')::uuid))
  returning id into v_id;
  return v_id;
end $$;

-- Captures the SQLSTATE and message of a failing statement so the ASSERT can
-- happen OUTSIDE the exception handler — a handler that swallows the assert
-- turns a hard failure into a silent pass.
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

-- ═══════════════════════════════════════════════════════════════════════════
-- A. The three targets are derived, not trusted  (tests 1, 2, 3, 9)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_unallocated uuid;
  v_request     uuid;
  v_confirmed   uuid;
  v_row         public.finance_payment_requests%rowtype;
  v_req_number  text;
  v_req_client  text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  -- 1. New Order: no linkage of any kind.
  v_unallocated := pg_temp.new_payment('ASSERT unallocated client');
  select * into v_row from public.finance_payment_requests where id = v_unallocated;
  assert v_row.payment_target_type = 'unallocated', 'no linkage must derive target unallocated';
  assert v_row.payment_against = 'new_order',       'unallocated must be new_order origin';
  assert v_row.order_id is null and v_row.order_number is null,                 'unallocated must store no order linkage';
  assert v_row.order_request_id is null and v_row.order_request_number is null, 'unallocated must store no request linkage';
  assert v_row.client_name = 'ASSERT unallocated client', 'unallocated keeps the typed client name';

  -- 2 + 9. Order Request: request linkage only, with number AND client name
  -- derived server-side from the request — note the deliberately FORGED values
  -- passed in (a wrong client name, a fabricated request number, and a target
  -- classification claiming this is a Confirmed Order payment), every one of
  -- which must be overwritten rather than trusted.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     order_request_id, order_request_number, payment_target_type, submitted_by)
  values
    ('ASSERT WRONG CLIENT', 100000, current_date, 'bank_transfer', 'company_account',
     current_setting('test.req_open')::uuid, 'ORD-REQ-FORGED', 'confirmed_order',
     current_setting('test.sales_id')::uuid)
  returning id into v_request;

  select request_number, client_name into v_req_number, v_req_client
  from public.order_requests where id = current_setting('test.req_open')::uuid;

  select * into v_row from public.finance_payment_requests where id = v_request;
  assert v_row.payment_target_type = 'order_request', 'a request linkage must derive target order_request';
  assert v_row.payment_against = 'new_order',         'an order_request payment is new_order origin';
  assert v_row.order_request_number = v_req_number,   'the request number must be derived, not taken from the payload';
  assert v_row.client_name = v_req_client,            'the client name must come from the selected request';
  assert v_row.order_id is null and v_row.order_number is null, 'an order_request payment must hold no confirmed-order linkage';
  assert v_row.status = 'pending_approval',           'submission is pending approval';

  -- 3. Confirmed Order: order linkage only, client name from the Order
  -- (enforce_finance_payment_request_client_name, 20260688).
  v_confirmed := pg_temp.new_payment(
    'ASSERT WRONG CLIENT', null, current_setting('test.order_id')::uuid, '9999');
  select * into v_row from public.finance_payment_requests where id = v_confirmed;
  assert v_row.payment_target_type = 'confirmed_order', 'an order linkage must derive target confirmed_order';
  assert v_row.payment_against = 'existing_order',      'a confirmed_order payment is existing_order origin';
  assert v_row.order_id = current_setting('test.order_id')::uuid, 'the order linkage must be stored';
  assert v_row.order_request_id is null and v_row.order_request_number is null,
    'a confirmed_order payment must hold no request linkage';
  assert v_row.client_name = 'ASSERT target order client', 'the client name must come from the selected Order';

  perform set_config('test.pay_unallocated', v_unallocated::text, true);
  perform set_config('test.pay_request',     v_request::text, true);
  perform set_config('test.pay_confirmed',   v_confirmed::text, true);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. Both link targets can never coexist  (test 4)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_err text;
begin
  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests
          set order_id = %L, order_number = '9999'
        where id = %L$q$,
    current_setting('test.order_id'), current_setting('test.pay_request')));
  assert v_err like '23514|%', 'setting both link targets must violate a CHECK, got: ' || v_err;
  assert v_err like '%one_link_target%', 'the refusal must be the one-target rule, got: ' || v_err;

  -- ...and from the other direction, on an insert.
  v_err := pg_temp.fails_with(format(
    $q$insert into public.finance_payment_requests
         (client_name, amount, payment_date, payment_mode, received_in,
          order_request_id, order_id, submitted_by)
       values ('ASSERT both', 1, current_date, 'bank_transfer', 'company_account', %L, %L, %L)$q$,
    current_setting('test.req_open'), current_setting('test.order_id'), current_setting('test.sales_id')));
  assert v_err like '23514|%', 'inserting both link targets must be refused, got: ' || v_err;

  -- A payload that DECLARES a Confirmed Order payment and names no Order is
  -- refused outright rather than quietly re-filed as a New Order payment — the
  -- failure 20260688 has always produced, preserved.
  v_err := pg_temp.fails_with(format(
    $q$insert into public.finance_payment_requests
         (client_name, amount, payment_date, payment_mode, received_in,
          payment_against, submitted_by)
       values ('ASSERT contradictory', 1, current_date, 'bank_transfer', 'company_account',
               'existing_order', %L)$q$,
    current_setting('test.sales_id')));
  assert v_err like '%existing order must be selected%',
    'declaring an existing-order payment with no Order must be refused, got: ' || v_err;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. Order Request selection is validated server-side  (tests 6, 7, 8)
-- ═══════════════════════════════════════════════════════════════════════════

-- 6a. Unauthorized, with RLS APPLIED: an unrelated salesperson cannot even see
--     the request, so the selection fails closed.
do $$
declare v_err text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales2_id'), 'role', 'authenticated')::text, true);

  v_err := pg_temp.fails_with(format(
    $q$insert into public.finance_payment_requests
         (client_name, amount, payment_date, payment_mode, received_in, order_request_id, submitted_by)
       values ('ASSERT outsider', 1, current_date, 'bank_transfer', 'company_account', %L, %L)$q$,
    current_setting('test.req_open'), current_setting('test.sales2_id')));
  assert v_err like '42501|%', 'an unrelated user must be refused, got: ' || v_err;
  assert v_err like '%ORDER_REQUEST_NOT_AVAILABLE%', 'RLS-invisible request must fail closed, got: ' || v_err;
end $$;

reset role;

-- 6b. Unauthorized, with RLS BYPASSED: proves the EXPLICIT participation check
--     refuses too, so the rule does not rest on row visibility alone.
do $$
declare v_err text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales2_id'), 'role', 'authenticated')::text, true);

  v_err := pg_temp.fails_with(format(
    $q$insert into public.finance_payment_requests
         (client_name, amount, payment_date, payment_mode, received_in, order_request_id, submitted_by)
       values ('ASSERT outsider 2', 1, current_date, 'bank_transfer', 'company_account', %L, %L)$q$,
    current_setting('test.req_open'), current_setting('test.sales2_id')));
  assert v_err like '42501|%', 'the explicit participation check must refuse, got: ' || v_err;
  assert v_err like '%ORDER_REQUEST_NOT_PERMITTED%', 'expected the participation refusal, got: ' || v_err;
end $$;

-- 7 + 8. Converted, rejected and draft requests are all refused at submission.
do $$
declare v_err text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  v_err := pg_temp.fails_with(format(
    $q$select pg_temp.new_payment('ASSERT converted', %L)$q$, current_setting('test.req_converted')));
  assert v_err like '%ORDER_REQUEST_CONVERTED%', 'a converted request must be refused, got: ' || v_err;

  v_err := pg_temp.fails_with(format(
    $q$select pg_temp.new_payment('ASSERT rejected', %L)$q$, current_setting('test.req_rejected')));
  assert v_err like '%ORDER_REQUEST_NOT_ACTIVE%', 'a rejected request must be refused, got: ' || v_err;

  v_err := pg_temp.fails_with(format(
    $q$select pg_temp.new_payment('ASSERT draft', %L)$q$, current_setting('test.req_draft')));
  assert v_err like '%ORDER_REQUEST_NOT_AVAILABLE%', 'an unfinalized draft must be refused, got: ' || v_err;

  v_err := pg_temp.fails_with(
    $q$select pg_temp.new_payment('ASSERT ghost', '00000000-0000-0000-0000-000000000000')$q$);
  assert v_err like '%ORDER_REQUEST_NOT_AVAILABLE%', 'a non-existent request must be refused, got: ' || v_err;

  -- A needs_clarification request IS still selectable: it is on the approvable
  -- track and the salesperson is answering the reviewer's question.
  perform pg_temp.new_payment('ASSERT clarify ok', current_setting('test.req_clarify')::uuid);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D. Linkage survives the whole pre-approval lifecycle  (tests 10, 11, 12)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_pay uuid := current_setting('test.pay_request')::uuid;
  v_req uuid := current_setting('test.req_open')::uuid;
begin
  -- 10. pending_approval — already asserted in block A, restated as the baseline.
  assert (select order_request_id from public.finance_payment_requests where id = v_pay) = v_req,
    'the linkage must survive pending_approval';

  -- 11. needs_clarification.
  update public.finance_payment_requests
     set status = 'needs_clarification', admin_note = 'ASSERT clarify'
   where id = v_pay;
  assert (select order_request_id from public.finance_payment_requests where id = v_pay) = v_req,
    'the linkage must survive needs_clarification';

  -- 12. rejected — the owner must be able to correct the payment without losing
  --     the request it was intended for.
  update public.finance_payment_requests set status = 'rejected' where id = v_pay;
  assert (select order_request_id from public.finance_payment_requests where id = v_pay) = v_req,
    'the linkage must survive rejection';
  assert (select payment_target_type from public.finance_payment_requests where id = v_pay) = 'order_request',
    'the target classification must survive rejection';

  -- Back to pending for the approval assertions below.
  update public.finance_payment_requests set status = 'pending_approval' where id = v_pay;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. Financial approval retains the Order Request link  (tests 13, 21, 22)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_result jsonb;
  v_row    public.finance_payment_requests%rowtype;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);

  -- 13. Order Request target.
  v_result := public.approve_finance_payment_request(
    current_setting('test.pay_request')::uuid, 'ASSERT approved');
  select * into v_row from public.finance_payment_requests where id = current_setting('test.pay_request')::uuid;
  assert v_row.status = 'approved_unlinked',   'an order_request payment approves to suspense, not to a linked payment';
  assert v_row.order_request_id = current_setting('test.req_open')::uuid,
    'financial approval must RETAIN the Order Request linkage';
  assert v_row.order_request_number is not null, 'the derived request number must survive approval';
  assert v_row.order_id is null and v_row.order_number is null,
    'approval must not invent a Confirmed Order';
  assert v_row.payment_target_type = 'order_request', 'the target must survive approval';
  assert v_result ->> 'order_request_id' = current_setting('test.req_open'),
    'the RPC result must report the retained linkage';

  -- 21. The existing unallocated New Order workflow.
  perform public.approve_finance_payment_request(current_setting('test.pay_unallocated')::uuid, null);
  select * into v_row from public.finance_payment_requests where id = current_setting('test.pay_unallocated')::uuid;
  assert v_row.status = 'approved_unlinked', 'a New Order payment must still approve to suspense';
  assert v_row.order_id is null and v_row.order_request_id is null,
    'a New Order payment must still approve with no linkage at all';

  -- 22. The existing Confirmed Order workflow.
  perform public.approve_finance_payment_request(current_setting('test.pay_confirmed')::uuid, null);
  select * into v_row from public.finance_payment_requests where id = current_setting('test.pay_confirmed')::uuid;
  assert v_row.status = 'approved_linked', 'a Confirmed Order payment must still approve straight to linked';
  assert v_row.order_id = current_setting('test.order_id')::uuid, 'the order linkage must be preserved';
  assert v_row.order_number is not null, 'the order number must be resolved from the Order itself';
end $$;

-- Approval-time revalidation: a payment naming a request that has since been
-- converted is REFUSED with an actionable error, never silently unallocated.
do $$
declare
  v_pay uuid;
  v_err text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);
  v_pay := pg_temp.new_payment('ASSERT will convert under it', current_setting('test.req_clarify')::uuid);

  -- Force the request into the converted state behind the payment's back.
  update public.order_requests
     set status = 'converted',
         converted_order_id = current_setting('test.order_id')::uuid,
         converted_at = now()
   where id = current_setting('test.req_clarify')::uuid;

  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);
  v_err := pg_temp.fails_with(format(
    $q$select public.approve_finance_payment_request(%L, null)$q$, v_pay));
  assert v_err like '%ORDER_REQUEST_CONVERTED%',
    'approving against a converted request must fail with a clear error, got: ' || v_err;
  assert (select status from public.finance_payment_requests where id = v_pay) = 'pending_approval',
    'the refused approval must leave the payment untouched';
  assert (select order_request_id from public.finance_payment_requests where id = v_pay) is not null,
    'the refused approval must NOT silently unallocate the payment';

  -- Restore, so the fixture does not leak into later blocks.
  update public.order_requests
     set status = 'needs_clarification', converted_order_id = null, converted_at = null
   where id = current_setting('test.req_clarify')::uuid;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. Target is FROZEN once approved
-- ═══════════════════════════════════════════════════════════════════════════
do $$
begin
  update public.finance_payment_requests
     set payment_target_type = 'unallocated'
   where id = current_setting('test.pay_request')::uuid;
  assert (select payment_target_type from public.finance_payment_requests
          where id = current_setting('test.pay_request')::uuid) = 'order_request',
    'an approved payment''s target must be frozen, not re-derived';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. Conversion guards  (tests 17, 18, 19, 20)
-- ═══════════════════════════════════════════════════════════════════════════

-- 17. No approved linked payment -> conversion is refused, and NOTHING is
--     created: no Order, no converted request, no allocated number.
do $$
declare
  v_err       text;
  v_orders    bigint;
  v_next      bigint;
  v_next_post bigint;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);

  select count(*) into v_orders from public.orders;
  select next_number into v_next from public.order_number_cycle;

  v_err := pg_temp.fails_with(format(
    $q$select public.convert_order_request_to_order(%L, '{}'::uuid[])$q$,
    current_setting('test.req_convert')));
  assert v_err like '%ORDER_REQUEST_NO_APPROVED_PAYMENT%',
    'conversion with no approved payment must be refused, got: ' || v_err;
  assert v_err like '%At least one approved payment must be linked before this Order Request can be approved.%',
    'the refusal must use the agreed wording, got: ' || v_err;

  select next_number into v_next_post from public.order_number_cycle;
  assert (select count(*) from public.orders) = v_orders,
    'a refused conversion must not create an Order';
  assert v_next_post = v_next, 'a refused conversion must not advance the Order number cycle';
  assert (select status from public.order_requests where id = current_setting('test.req_convert')::uuid) = 'submitted',
    'a refused conversion must leave the request submitted';
  assert (select converted_order_id from public.order_requests where id = current_setting('test.req_convert')::uuid) is null,
    'a refused conversion must not mark the request converted';
end $$;

-- 20a. An UNDECIDED linked payment blocks conversion even when an approved one
--      also exists — the admin has to finish reviewing first.
do $$
declare
  v_approved  uuid;
  v_pending   uuid;
  v_err       text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);
  v_approved := pg_temp.new_payment('ASSERT convert approved', current_setting('test.req_convert')::uuid, null, null, 250000);
  v_pending  := pg_temp.new_payment('ASSERT convert pending',  current_setting('test.req_convert')::uuid, null, null, 90000);
  perform set_config('test.pay_convert_approved', v_approved::text, true);
  perform set_config('test.pay_convert_pending',  v_pending::text,  true);

  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);
  perform public.approve_finance_payment_request(v_approved, null);

  v_err := pg_temp.fails_with(format(
    $q$select public.convert_order_request_to_order(%L, '{}'::uuid[])$q$,
    current_setting('test.req_convert')));
  assert v_err like '%ORDER_REQUEST_PAYMENTS_UNDECIDED%',
    'an undecided linked payment must block conversion, got: ' || v_err;
end $$;

-- 18 + 19 + 20b. With the pending payment rejected, conversion succeeds; the
--                approved payment transfers and the rejected one does not.
do $$
declare
  v_result   jsonb;
  v_order_id uuid;
  v_pay      public.finance_payment_requests%rowtype;
begin
  update public.finance_payment_requests
     set status = 'rejected', admin_note = 'ASSERT reject'
   where id = current_setting('test.pay_convert_pending')::uuid;

  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);

  v_result := public.convert_order_request_to_order(
    current_setting('test.req_convert')::uuid, '{}'::uuid[]);
  v_order_id := (v_result ->> 'order_id')::uuid;

  assert (v_result ->> 'linked_payment_count')::int = 1,
    'exactly the one approved payment must transfer';
  assert (select status from public.order_requests where id = current_setting('test.req_convert')::uuid) = 'converted',
    'the request must be converted';

  -- 19. The approved payment moved onto the Confirmed Order.
  select * into v_pay from public.finance_payment_requests
   where id = current_setting('test.pay_convert_approved')::uuid;
  assert v_pay.status = 'approved_linked',      'the transferred payment must become approved_linked';
  assert v_pay.order_id = v_order_id,           'the transferred payment must point at the new Order';
  assert v_pay.order_number is not null,        'the transferred payment must carry the Order number';
  assert v_pay.order_request_id is null,        'the transfer must clear the request linkage';
  assert v_pay.order_request_number is null,    'the transfer must clear the denormalised request number';
  assert v_pay.payment_target_type = 'order_request',
    'the transfer must PRESERVE where the payment came from';

  -- 20b. The rejected payment did not transfer and is not received money.
  select * into v_pay from public.finance_payment_requests
   where id = current_setting('test.pay_convert_pending')::uuid;
  assert v_pay.status = 'rejected',   'a rejected payment must stay rejected';
  assert v_pay.order_id is null,      'a rejected payment must NOT transfer to the Order';

  perform set_config('test.converted_order_id', v_order_id::text, true);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- H. Audit language  (tests 14, 24)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_payload jsonb;
  v_count   integer;
begin
  -- The submission event names the chosen target AND the record.
  select payload into v_payload
  from public.finance_payment_request_activity_log
  where payment_request_id = current_setting('test.pay_request')::uuid
    and event_type = 'request_submitted';
  assert v_payload ->> 'payment_target_type' = 'order_request',
    'the submission event must record which target was chosen';
  assert v_payload ->> 'order_request_number' is not null,
    'the submission event must name the Order Request';

  -- The New Order submission records its target too, with no linkage.
  select payload into v_payload
  from public.finance_payment_request_activity_log
  where payment_request_id = current_setting('test.pay_unallocated')::uuid
    and event_type = 'request_submitted';
  assert v_payload ->> 'payment_target_type' = 'unallocated',
    'a New Order submission must record the unallocated target';
  assert v_payload ->> 'order_request_number' is null,
    'a New Order submission must name no record';

  -- 14. The Order Request timeline shows the payment FROM SUBMISSION, before any
  --     approval — exactly one row, written by the trigger, not by an RPC.
  select count(*) into v_count
  from public.order_request_activity
  where order_request_id = current_setting('test.req_open')::uuid
    and event_type = 'payment_linked'
    and (details ->> 'payment_id')::uuid = current_setting('test.pay_request')::uuid;
  assert v_count = 1,
    'the request timeline must record the payment association exactly once at submission';

  -- The conversion transfer is recorded with its provenance, so the Finance
  -- trail reads "transferred from Order Request …" rather than a bare link.
  select payload into v_payload
  from public.finance_payment_request_activity_log
  where payment_request_id = current_setting('test.pay_convert_approved')::uuid
    and event_type = 'order_linked';
  assert v_payload ->> 'from_order_request_number' is not null,
    'the conversion transfer must record which request the payment came from';

  -- Approval is a status transition, never a second "linked" event: the linkage
  -- did not change, so no order_request_linked row may exist for it.
  select count(*) into v_count
  from public.finance_payment_request_activity_log
  where payment_request_id = current_setting('test.pay_request')::uuid
    and event_type = 'order_request_linked';
  assert v_count = 0,
    'approval must not emit a duplicate linkage event';
end $$;

-- Pre-approval target CHANGE is audited on both sides, once each.
do $$
declare
  v_pay     uuid;
  v_payload jsonb;
  v_count   integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);
  v_pay := pg_temp.new_payment('ASSERT retarget', current_setting('test.req_open')::uuid);

  -- Switch it to the Confirmed Order target, clearing the request linkage in the
  -- same statement — exactly what buildTargetPayload sends.
  update public.finance_payment_requests
     set order_request_id = null, order_request_number = null,
         order_id = current_setting('test.order_id')::uuid, order_number = '9999',
         payment_against = 'existing_order'
   where id = v_pay;

  assert (select payment_target_type from public.finance_payment_requests where id = v_pay) = 'confirmed_order',
    'a pre-approval target change must be re-derived';

  select payload into v_payload
  from public.finance_payment_request_activity_log
  where payment_request_id = v_pay and event_type = 'target_changed';
  assert v_payload ->> 'from_target_type' = 'order_request', 'the change must record where it came from';
  assert v_payload ->> 'to_target_type'   = 'confirmed_order', 'the change must record where it went';

  select count(*) into v_count
  from public.order_request_activity
  where order_request_id = current_setting('test.req_open')::uuid
    and event_type = 'payment_unlinked'
    and (details ->> 'payment_id')::uuid = v_pay;
  assert v_count = 1, 'the request timeline must record the payment leaving, exactly once';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- I. Finance routing counts do not regress  (test 23)
-- ═══════════════════════════════════════════════════════════════════════════
-- The two Received Payments pages and the sidebar badges are scoped to the two
-- APPROVED statuses first, then split by linkage. A pre-approval payment — even
-- one attached to an Order Request — must be counted by neither.
do $$
declare
  v_linked   bigint;
  v_unlinked bigint;
  v_pending  bigint;
begin
  select count(*) into v_linked
  from public.finance_payment_requests
  where status in ('approved_unlinked', 'approved_linked')
    and (order_id is not null or order_request_id is not null);

  select count(*) into v_unlinked
  from public.finance_payment_requests
  where status in ('approved_unlinked', 'approved_linked')
    and order_id is null and order_request_id is null;

  select count(*) into v_pending
  from public.finance_payment_requests
  where status in ('pending_approval', 'needs_clarification', 'rejected')
    and order_request_id is not null;

  assert v_pending > 0, 'the fixture must include a pre-approval request-linked payment';
  assert (select count(*) from public.finance_payment_requests
          where status in ('approved_unlinked', 'approved_linked')) = v_linked + v_unlinked,
    'every received payment must land on exactly one Received Payments page';

  -- The decisive one: a request-linked payment that has NOT been approved is
  -- counted by neither Received Payments page, so attaching money to an Order
  -- Request at submission time cannot inflate either badge.
  assert not exists (
    select 1 from public.finance_payment_requests f
    where f.status in ('pending_approval', 'needs_clarification', 'rejected')
      and f.order_request_id is not null
      and (
        -- the Linked page's scope
        (f.status in ('approved_unlinked', 'approved_linked')
         and (f.order_id is not null or f.order_request_id is not null))
        or
        -- the Non-Linked page's scope
        (f.status in ('approved_unlinked', 'approved_linked')
         and f.order_id is null and f.order_request_id is null)
      )
  ), 'a pre-approval request-linked payment must appear on neither Received Payments page';
end $$;

reset role;
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
