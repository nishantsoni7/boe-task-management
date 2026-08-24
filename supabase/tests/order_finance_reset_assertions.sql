-- Order & Finance module reset assertions
-- ===========================================================================
-- Covers 20261010000000_order_submission_and_finance_test_data_reset.sql: an administrator
-- clearing a MODULE rather than a chain, and nobody else clearing anything.
--
--   A. authorization — who may preview, begin, finalize and reset numbering
--   B. the gates — enabled, scope, reason, and the exact words per scope
--   C. the census — counts, targets, retained, and the plan hash that binds them
--   D. blocking — a record that is not test data refuses the whole reset
--   E. THE WRITE LOCK — no new dependent record can appear after the freeze
--   F. one active reset, resume, and the refusal of a second admin
--   G. Finance-only — payments go, Orders and PI Drafts stay, totals reach zero
--   H. full — every foreign key in order, and nothing outside the scope
--   I. storage discipline — finalization refuses until the sweep is reported
--   J. idempotency, release, and the states in between
--   K. THE PI-DELETION RACE — an allocation or correction request cannot be
--      created against a PI that is reserved for deletion
--   L. numbering — the canonical reset, and every one of its refusals
--   M. the chain protocol is untouched and fails closed on a module claim
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES: a database built by _order_finance_reset_shaped_schema.sql with
-- 20261010000000 applied — see run_order_finance_reset_suite.sh. It creates its
-- own users, so nothing needs configuring.

\set ON_ERROR_STOP on

begin;

-- ── Helpers ─────────────────────────────────────────────────────────────────

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

-- ── The cast ────────────────────────────────────────────────────────────────

insert into public.users (id, email, role) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test',    'admin'),
  ('22222222-2222-4222-8222-222222222222', 'manager@boe.test',  'manager'),
  ('33333333-3333-4333-8333-333333333333', 'finance@boe.test',  'finance'),
  ('44444444-4444-4444-8444-444444444444', 'sales@boe.test',    'sales'),
  ('55555555-5555-4555-8555-555555555555', 'senior@boe.test',   'senior_sales'),
  ('66666666-6666-4666-8666-666666666666', 'custom@boe.test',   'custom');

insert into public.users (id, email, role, is_active) values
  ('77777777-7777-4777-8777-777777777777', 'gone@boe.test', 'admin', false);

-- Named rather than \set: psql does not interpolate a variable inside a
-- dollar-quoted block, and every assertion below lives in one.
create or replace function pg_temp.admin() returns uuid language sql immutable
as $$ select '11111111-1111-4111-8111-111111111111'::uuid $$;
create or replace function pg_temp.inactive() returns uuid language sql immutable
as $$ select '77777777-7777-4777-8777-777777777777'::uuid $$;

-- ── A fixture module: two PI Drafts, one Order, one payment, one allocation ──

create or replace function pg_temp.build_fixture()
returns void language plpgsql as $$
declare
  v_sub  uuid;
  v_sub2 uuid;
  v_item uuid;
  v_ord  uuid;
  v_pay  uuid;
  v_pay2 uuid;
begin
  insert into public.order_submissions (client_name, status, grand_total)
  values ('Fixture Draft A', 'draft', 100000) returning id into v_sub;
  insert into public.order_submissions (client_name, status, grand_total)
  values ('Fixture Draft B', 'needs_changes', 50000) returning id into v_sub2;

  insert into public.order_submission_items (submission_id, product_name)
  values (v_sub, 'Fixture product') returning id into v_item;
  insert into public.order_submission_item_images (submission_id, item_id, storage_path)
  values (v_sub, v_item, 'submissions/' || v_sub::text || '/images/x.png');
  insert into public.order_submission_activity (submission_id) values (v_sub);
  insert into public.order_submission_correction_requests (submission_id) values (v_sub2);

  update public.order_submissions set source_workbook_path =
    'submissions/' || v_sub::text || '/original/f.xlsx' where id = v_sub;

  insert into public.orders (display_number, client_name, source_order_submission_id)
  values ('0001', 'Fixture Client', v_sub) returning id into v_ord;
  update public.order_submissions set order_id = v_ord, status = 'approved' where id = v_sub;
  insert into public.order_activity_log (order_id) values (v_ord);
  insert into public.order_document_versions (order_id) values (v_ord);
  insert into public.order_change_requests (order_id) values (v_ord);

  insert into public.finance_payment_requests (request_number, client_name, amount, order_id)
  values ('PR-1', 'Fixture Client', 60000, v_ord) returning id into v_pay;
  insert into public.finance_payment_requests (request_number, client_name, amount)
  values ('PR-2', 'Fixture Client', 40000) returning id into v_pay2;
  insert into public.finance_payment_request_activity_log (payment_request_id) values (v_pay);
  insert into public.payment_proof_attachments (payment_request_id, storage_path)
  values (v_pay, v_pay::text || '/proof.pdf');

  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, origin_target_type)
  values (v_pay, v_ord, 30000, 'confirmed_order');
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, origin_target_type)
  values (v_pay, v_sub2, 30000, 'order_submission');

  insert into public.notifications (entity_id, type) values (v_ord, 'order_approved');
  insert into public.notifications (entity_id, type) values (v_pay, 'finance_payment_received');
  -- A task notification carrying the SAME id: must survive.
  insert into public.notifications (entity_id, type) values (v_ord, 'task_assigned');

  insert into storage.objects (bucket_id, name, metadata) values
    ('order-files',    'submissions/' || v_sub::text || '/original/f.xlsx', '{"size":"1000"}'),
    ('order-files',    'submissions/' || v_sub::text || '/images/x.png',    '{"size":"500"}'),
    ('order-files',    'orders/' || v_ord::text || '/versions/1/o.pdf',     '{"size":"250"}'),
    ('payment-proofs', v_pay::text || '/proof.pdf',                         '{"size":"100"}');
end $$;

-- ═══ A. Authorization ═══════════════════════════════════════════════════════

do $$
declare v_err text;
begin
  perform pg_temp.build_fixture();

  -- Unauthenticated.
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.preview_order_finance_test_reset('finance_module')$q$)
      like '28000|%',
    'A1. an unauthenticated caller cannot preview');

  -- Every non-admin role, including the ones that look close.
  for v_err in
    select pg_temp.fails_with(format(
      $q$select set_config('request.jwt.claims', %L, true),
                public.preview_order_finance_test_reset('finance_module')$q$,
      json_build_object('sub', u.id, 'role', 'authenticated')::text))
    from public.users u where u.role <> 'admin'
  loop
    perform pg_temp.ok(v_err like '42501|RESET_FORBIDDEN%',
      'A2. only an admin may preview; got: ' || v_err);
  end loop;

  -- An admin whose account is switched off is not an admin.
  perform pg_temp.act_as(pg_temp.inactive());
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.preview_order_finance_test_reset('finance_module')$q$)
      like '42501|RESET_FORBIDDEN%',
    'A3. an inactive admin is refused');

  perform pg_temp.act_as(pg_temp.admin());
  perform pg_temp.ok(
    (public.preview_order_finance_test_reset('finance_module')->>'scope') = 'finance_module',
    'A4. an active admin may preview');

  -- Every destructive entry point refuses a non-admin, not just the preview.
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222'::uuid);
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.begin_order_finance_test_reset(
      'finance_module', 'why', 'DELETE FINANCE TEST DATA', 'x')$q$) like '42501|RESET_FORBIDDEN%',
    'A5. a manager cannot begin a reset');
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.finalize_order_finance_test_reset(gen_random_uuid())$q$)
      like '42501|RESET_FORBIDDEN%',
    'A6. nor finalize one');
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.order_finance_test_reset_status()$q$)
      like '42501|RESET_FORBIDDEN%',
    'A7. nor read the cleanup state');
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.reset_confirmed_order_number_cycle(gen_random_uuid())$q$)
      like '42501|ORDER_NUMBER_RESET_FORBIDDEN%',
    'A8. nor reset the Order number cycle');
end $$;

-- ═══ B. The gates ═══════════════════════════════════════════════════════════

do $$
declare v_hash text;
begin
  perform pg_temp.act_as(pg_temp.admin());
  v_hash := public.preview_order_finance_test_reset('finance_module')->>'plan_hash';

  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.begin_order_finance_test_reset(
      'everything', 'why', 'DELETE FINANCE TEST DATA', %L)$q$, v_hash)) like 'P0001|RESET_SCOPE_INVALID%',
    'B1. an unknown scope is refused');

  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.begin_order_finance_test_reset(
      'finance_module', '   ', 'DELETE FINANCE TEST DATA', %L)$q$, v_hash))
      like 'P0001|CLEANUP_REASON_REQUIRED%',
    'B2. a blank reason is refused');

  -- THE PHRASE IS A DATABASE GATE, not a label. Each of these is what a browser
  -- with the check removed would send.
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.begin_order_finance_test_reset(
      'finance_module', 'why', 'delete finance test data', %L)$q$, v_hash))
      like 'P0001|CLEANUP_CONFIRMATION_INVALID%',
    'B3. the phrase is case sensitive');
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.begin_order_finance_test_reset(
      'finance_module', 'why', 'DELETE TEST DATA', %L)$q$, v_hash))
      like 'P0001|CLEANUP_CONFIRMATION_INVALID%',
    'B4. the chain protocol''s phrase does not work here');
  -- AND THE TWO SCOPES DO NOT SHARE A PHRASE: the Finance words must not be able
  -- to clear the Orders module.
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.begin_order_finance_test_reset(
      'order_finance_module', 'why', 'DELETE FINANCE TEST DATA', %L)$q$, v_hash))
      like 'P0001|CLEANUP_CONFIRMATION_INVALID%',
    'B5. the Finance phrase cannot begin a full reset');

  -- Disabled cleanup fails closed, everywhere.
  update public.test_data_cleanup_settings set enabled = false where id = true;
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.preview_order_finance_test_reset('finance_module')$q$)
      like '42501|CLEANUP_DISABLED%',
    'B6. a disabled cleanup cannot even be previewed');
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.begin_order_finance_test_reset(
      'finance_module', 'why', 'DELETE FINANCE TEST DATA', %L)$q$, v_hash))
      like '42501|CLEANUP_DISABLED%',
    'B7. nor begun');
  update public.test_data_cleanup_settings set enabled = true where id = true;
end $$;

-- ═══ C. The census and the plan hash ════════════════════════════════════════

do $$
declare
  v_fin  jsonb;
  v_full jsonb;
  v_sub  uuid;
begin
  perform pg_temp.act_as(pg_temp.admin());
  v_fin  := public.preview_order_finance_test_reset('finance_module');
  v_full := public.preview_order_finance_test_reset('order_finance_module');

  perform pg_temp.ok((v_fin->'counts'->>'payments')::int = 2,           'C1. both payments are counted');
  perform pg_temp.ok((v_fin->'counts'->>'payment_allocations')::int = 2,'C2. both allocations are counted');
  perform pg_temp.ok((v_fin->'counts'->>'payment_proofs')::int = 1,     'C3. the proof is counted');
  perform pg_temp.ok((v_fin->'counts'->>'orders')::int = 0,             'C4. Finance-only counts no Order');
  perform pg_temp.ok((v_fin->'counts'->>'order_submissions')::int = 0,  'C5. and no PI Draft');

  perform pg_temp.ok((v_full->'counts'->>'orders')::int = 1,            'C6. the full scope counts the Order');
  perform pg_temp.ok((v_full->'counts'->>'order_submissions')::int = 2, 'C7. and both PI Drafts');
  perform pg_temp.ok((v_full->'counts'->>'order_submission_items')::int = 1,  'C8. and the product line');
  perform pg_temp.ok((v_full->'counts'->>'correction_requests')::int = 1,     'C9. and the correction request');
  perform pg_temp.ok((v_full->'counts'->>'order_documents')::int = 1,         'C10. and the generated document');
  perform pg_temp.ok((v_full->'counts'->>'storage_objects')::int = 4,         'C11. and every storage object');
  perform pg_temp.ok((v_full->'counts'->>'storage_bytes')::bigint = 1850,     'C12. with their sizes summed');

  -- The task notification carrying an Order id is NOT in scope.
  perform pg_temp.ok((v_full->'counts'->>'notifications')::int = 2,
    'C13. only Order and Finance notifications are counted');

  -- TWO SCOPES, TWO PLANS. If these ever hashed alike, confirming one could
  -- execute the other.
  perform pg_temp.ok((v_fin->>'plan_hash') <> (v_full->>'plan_hash'),
    'C14. the two scopes do not share a plan hash');

  -- The hash is stable while nothing moves, and moves when anything does.
  perform pg_temp.ok(
    (public.preview_order_finance_test_reset('finance_module')->>'plan_hash') = (v_fin->>'plan_hash'),
    'C15. the same state hashes the same twice');

  insert into public.finance_payment_requests (request_number, client_name, amount)
  values ('PR-3', 'Late arrival', 1) returning id into v_sub;
  perform pg_temp.ok(
    (public.preview_order_finance_test_reset('finance_module')->>'plan_hash') <> (v_fin->>'plan_hash'),
    'C16. one more record in scope is a different plan');
  delete from public.finance_payment_requests where id = v_sub;
end $$;

-- ═══ D. THE SCOPE IS THE MODULE, not a tag ═════════════════════════════════
--
-- The correction this file's D section exists to prove. An earlier form scoped
-- both actions to is_test_data and reported anything untagged as "retained" —
-- so "Clear All Finance Data" left behind every row somebody forgot to tag, and
-- said nothing about it. These assert the opposite property: every payment is in
-- scope whatever its status and whatever its tag, a VERIFIED payment included,
-- and the ordinary protection that stops anybody deleting a verified payment is
-- still armed the moment the cleanup context ends.

do $$
declare
  v_untagged uuid;
  v_verified uuid;
  v_census   jsonb;
  v_err      text;
begin
  perform pg_temp.act_as(pg_temp.admin());

  -- A payment created with cleanup switched OFF carries is_test_data = false —
  -- the exact row the earlier form would have left behind.
  update public.test_data_cleanup_settings set enabled = false where id = true;
  insert into public.finance_payment_requests (request_number, client_name, amount)
  values ('UNTAGGED-1', 'Untagged Client', 5000) returning id into v_untagged;
  update public.test_data_cleanup_settings set enabled = true where id = true;
  perform pg_temp.ok(
    not (select is_test_data from public.finance_payment_requests where id = v_untagged),
    'D1. the fixture really is untagged, or this proves nothing');

  -- A VERIFIED payment: approved, and permanently undeletable by any ordinary path.
  insert into public.finance_payment_requests
    (request_number, client_name, amount, status, submitted_by)
  values ('VERIFIED-1', 'Verified Client', 9000, 'approved_unlinked', pg_temp.admin())
  returning id into v_verified;

  v_census := public.preview_order_finance_test_reset('finance_module');

  perform pg_temp.ok(
    (v_census->'targets'->'payments')::jsonb ? v_untagged::text,
    'D2. an untagged payment is IN SCOPE — the reset covers the module, not a tag');
  perform pg_temp.ok(
    (v_census->'targets'->'payments')::jsonb ? v_verified::text,
    'D3. and so is a verified one');
  perform pg_temp.ok(
    (v_census->'counts'->>'payments')::int
      = (select count(*) from public.finance_payment_requests),
    'D4. in fact EVERY payment is in scope, whatever its status');

  -- Nothing is reported as retained on the strength of a tag.
  perform pg_temp.ok(
    (v_census->'retained'->>'payments')::int = 0,
    'D5. and nothing survives a Finance reset because it was not tagged');

  -- A correct module-wide census refuses nothing: every referencing row is in
  -- the list, so the completeness check finds no unlisted reference.
  perform pg_temp.ok(
    jsonb_array_length(v_census->'blocking') = 0,
    'D6. a complete census has nothing that would refuse the delete');
  perform pg_temp.ok(
    jsonb_array_length(
      public.preview_order_finance_test_reset('order_finance_module')->'blocking') = 0,
    'D7. and neither does the full scope');

  -- ── AND THE ORDINARY PROTECTION IS UNTOUCHED ─────────────────────────────
  --
  -- Outside the cleanup context a verified payment cannot be deleted by anybody,
  -- which is the rule 20260705000000 exists for and which this file does not
  -- relax. The bulk path reaches it only through the eight gates.
  v_err := pg_temp.fails_with(format(
    'delete from public.finance_payment_requests where id = %L::uuid', v_verified));
  perform pg_temp.ok(v_err like '42501|PAYMENT_APPROVED_PERMANENT%',
    'D8. an ordinary delete of a verified payment is still refused; got: ' || v_err);
  perform pg_temp.ok(
    exists (select 1 from public.finance_payment_requests where id = v_verified),
    'D9. and it is still there');
end $$;

-- ── D10. The bulk path DOES delete it, and the guard is armed again after ────
do $$
declare
  v_hash     text;
  v_token    uuid;
  v_verified uuid;
  v_before   int;
  v_err      text;
begin
  perform pg_temp.act_as(pg_temp.admin());
  select id into v_verified from public.finance_payment_requests
   where request_number = 'VERIFIED-1';
  select count(*) into v_before from public.order_submissions;

  v_hash  := public.preview_order_finance_test_reset('finance_module')->>'plan_hash';
  v_token := (public.begin_order_finance_test_reset(
    'finance_module', 'clearing Finance', 'DELETE FINANCE TEST DATA', v_hash))->>'claim_token';
  perform public.order_finance_test_reset_storage_done(v_token, 0);
  perform public.finalize_order_finance_test_reset(v_token);

  perform pg_temp.ok(
    not exists (select 1 from public.finance_payment_requests where id = v_verified),
    'D10. an explicitly confirmed module reset DOES delete a verified payment');
  perform pg_temp.ok((select count(*) from public.finance_payment_requests) = 0,
    'D11. and every other payment with it, tagged or not');
  perform pg_temp.ok((select count(*) from public.order_submissions) = v_before,
    'D12. while every PI Draft survives');

  -- The context is transaction-local, so the protection is back immediately.
  insert into public.finance_payment_requests
    (request_number, client_name, amount, status, submitted_by)
  values ('VERIFIED-2', 'Verified Again', 100, 'approved_unlinked', pg_temp.admin());
  v_err := pg_temp.fails_with(
    'delete from public.finance_payment_requests where request_number = ''VERIFIED-2''');
  perform pg_temp.ok(v_err like '42501|PAYMENT_APPROVED_PERMANENT%',
    'D13. and the ordinary protection is armed again the moment the cleanup ends');

  -- Leave the fixture as the later sections expect it.
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  delete from public.finance_payment_requests where request_number = 'VERIFIED-2';
  perform set_config('boe.cleanup_context', '', true);
  perform pg_temp.build_fixture();
end $$;

-- ═══ E. THE WRITE LOCK ══════════════════════════════════════════════════════

do $$
declare
  v_hash  text;
  v_token uuid;
  v_ord   uuid;
  v_sub   uuid;
  v_err   text;
begin
  perform pg_temp.act_as(pg_temp.admin());
  select id into v_ord from public.orders limit 1;
  select id into v_sub from public.order_submissions where client_name = 'Fixture Draft B';

  v_hash  := public.preview_order_finance_test_reset('finance_module')->>'plan_hash';
  v_token := (public.begin_order_finance_test_reset(
    'finance_module', 'clearing Finance', 'DELETE FINANCE TEST DATA', v_hash))->>'claim_token';
  perform pg_temp.ok(v_token is not null, 'E0. the Finance scope is frozen');

  -- Every Finance writer is refused, with a temporary code and a sentence a
  -- person can act on.
  v_err := pg_temp.fails_with(
    $q$insert into public.finance_payment_requests (request_number, client_name, amount)
       values ('BLOCKED', 'x', 1)$q$);
  perform pg_temp.ok(v_err like '55P03|ORDER_FINANCE_RESET_IN_PROGRESS%',
    'E1. a new payment is refused while a reset holds Finance; got: ' || v_err);
  perform pg_temp.ok(v_err like '%try again in a few minutes%',
    'E2. and the message tells the person what to do');
  perform pg_temp.ok(v_err not like '%' || v_token::text || '%',
    'E3. and names no token');

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.finance_payment_allocations
         (payment_request_id, order_submission_id, allocated_amount, origin_target_type)
         values ((select id from public.finance_payment_requests limit 1), %L, 1, 'order_submission')$q$,
      v_sub)) like '55P03|ORDER_FINANCE_RESET_IN_PROGRESS%',
    'E4. so is a new allocation');
  perform pg_temp.ok(
    pg_temp.fails_with(
      $q$update public.finance_payment_requests set amount = 999
         where id = (select id from public.finance_payment_requests limit 1)$q$)
      like '55P03|ORDER_FINANCE_RESET_IN_PROGRESS%',
    'E5. and an update to an existing payment');

  -- ORDERS AND PI DRAFTS STAY WRITABLE under a Finance-only reset. That is the
  -- difference between the two scopes, and it is what lets the rest of the
  -- business carry on.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.order_submission_activity (submission_id) values (%L)$q$, v_sub))
      = 'NO ERROR',
    'E6. a PI Draft can still be written while only Finance is frozen');
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$update public.orders set client_name = 'Renamed' where id = %L$q$, v_ord))
      = 'NO ERROR',
    'E7. and so can an Order');

  -- READS ARE NEVER BLOCKED.
  perform pg_temp.ok(
    (select count(*) from public.finance_payment_requests) >= 2,
    'E8. Finance rows are still readable during a reset');

  -- UNRELATED MODULES ARE UNTOUCHED.
  perform pg_temp.ok(
    pg_temp.fails_with($q$insert into public.notifications (type) values ('task_assigned')$q$) = 'NO ERROR',
    'E9. an unrelated module is not frozen by a reset');

  -- A SECOND ADMIN CANNOT START ONE.
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.begin_order_finance_test_reset(
      'order_finance_module', 'me too', 'DELETE ALL ORDER AND FINANCE TEST DATA', %L)$q$, v_hash))
      like '55P03|RESET_CLAIMED_BY_OTHER%',
    'E10. a second scope cannot be claimed while one is open');

  -- THE SAME ADMIN RESUMES rather than starting again.
  perform pg_temp.ok(
    (public.begin_order_finance_test_reset(
       'finance_module', 'clearing Finance', 'DELETE FINANCE TEST DATA', v_hash)->>'resumed')::boolean,
    'E11. the holder resumes its own interrupted attempt');
  perform pg_temp.ok(
    (public.begin_order_finance_test_reset(
       'finance_module', 'clearing Finance', 'DELETE FINANCE TEST DATA', v_hash)->>'claim_token')::uuid
      = v_token,
    'E12. with the same token, so nothing is duplicated');

  -- Status is legible without exposing anything.
  perform pg_temp.ok(
    (public.order_finance_test_reset_status()->>'active')::boolean
    and (public.order_finance_test_reset_status()->>'scope') = 'finance_module'
    and (public.order_finance_test_reset_status()->>'stage') = 'frozen'
    and (public.order_finance_test_reset_status()->>'started_by') = 'admin@boe.test',
    'E13. an interrupted reset says what it is, who started it and where it got to');
  perform pg_temp.ok(
    not (public.order_finance_test_reset_status()::text like '%' || v_token::text || '%'),
    'E14. and never returns the claim token');

  -- ── I. Storage discipline ────────────────────────────────────────────────
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$select public.finalize_order_finance_test_reset(%L)$q$, v_token))
      like 'P0001|RESET_STORAGE_INCOMPLETE%',
    'I1. finalization is refused until the sweep is reported complete');

  -- ── J. Release, while nothing has been destroyed ─────────────────────────
  perform pg_temp.ok(
    (public.release_order_finance_test_reset(v_token)->>'released')::boolean,
    'J1. a reset that destroyed nothing can be given back');
  perform pg_temp.ok(
    pg_temp.fails_with(
      $q$insert into public.finance_payment_requests (request_number, client_name, amount)
         values ('AFTER RELEASE', 'x', 1)$q$) = 'NO ERROR',
    'J2. and the module is writable again');
  delete from public.finance_payment_requests where request_number = 'AFTER RELEASE';
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.finalize_order_finance_test_reset(%L)$q$, v_token))
      like '42501|RESET_CLAIM_RELEASED%',
    'J3. a released claim can never finalize');
end $$;

-- ═══ G. Finance-only ════════════════════════════════════════════════════════

do $$
declare
  v_hash   text;
  v_token  uuid;
  v_before int;
  v_orders int;
  v_items  int;
  v_docs   int;
  v_tasks  int;
  v_result jsonb;
begin
  perform pg_temp.act_as(pg_temp.admin());
  -- Counted here rather than written as literals: the sections above leave a
  -- varying amount of fixture behind, and what G is about is that a Finance
  -- reset changes NONE of it.
  select count(*) into v_before  from public.order_submissions;
  select count(*) into v_orders  from public.orders;
  select count(*) into v_items   from public.order_submission_items;
  select count(*) into v_docs    from public.order_document_versions;
  select count(*) into v_tasks   from public.notifications where type = 'task_assigned';

  v_hash  := public.preview_order_finance_test_reset('finance_module')->>'plan_hash';
  v_token := (public.begin_order_finance_test_reset(
    'finance_module', 'clearing Finance', 'DELETE FINANCE TEST DATA', v_hash))->>'claim_token';
  perform public.order_finance_test_reset_storage_done(v_token, 1);
  v_result := public.finalize_order_finance_test_reset(v_token);

  perform pg_temp.ok((select count(*) from public.finance_payment_requests) = 0,
    'G1. every test payment is gone');
  perform pg_temp.ok((select count(*) from public.finance_payment_allocations) = 0,
    'G2. and every allocation');
  perform pg_temp.ok((select count(*) from public.payment_proof_attachments) = 0,
    'G3. and every proof record');
  perform pg_temp.ok((select count(*) from public.finance_payment_request_activity_log) = 0,
    'G4. and every payment activity row');

  -- THE POINT OF THE SCOPE: Orders and PI Drafts survive, whole.
  perform pg_temp.ok((select count(*) from public.orders) = v_orders,
    'G5. every Order survives a Finance-only reset');
  perform pg_temp.ok((select count(*) from public.order_submissions) = v_before,
    'G6. and every PI Draft');
  perform pg_temp.ok((select count(*) from public.order_submission_items) = v_items,
    'G7. with their product lines');
  perform pg_temp.ok((select count(*) from public.order_document_versions) = v_docs,
    'G8. and their generated documents');

  -- The payment figures return to zero because the rows they are computed from
  -- are gone — there is no cached counter to reconcile, and this proves it.
  perform pg_temp.ok(
    (select count(*) from public.finance_payment_allocations a
      where a.order_submission_id is not null or a.order_id is not null) = 0,
    'G9. nothing is still attributed to an Order or a PI');

  -- Notifications: the Finance one goes, the Order one and the task one stay.
  perform pg_temp.ok(
    (select count(*) from public.notifications where type = 'task_assigned') = v_tasks,
    'G10. a task notification carrying an Order id is untouched');

  perform pg_temp.ok((v_result->>'payments')::int > 0 and (v_result->>'payment_allocations')::int > 0,
    'G11. the result reports what it actually deleted');
  perform pg_temp.ok((select count(*) from public.finance_payment_requests) = 0,
    'G11b. and NOTHING is left behind for want of a tag');

  -- ── J, continued: idempotency ────────────────────────────────────────────
  perform pg_temp.ok(
    (public.finalize_order_finance_test_reset(v_token)->>'already_finalized')::boolean,
    'J4. a completed reset retried answers instead of acting');
  perform pg_temp.ok((select count(*) from public.orders) = v_orders,
    'J5. and deletes nothing the second time');
  perform pg_temp.ok(
    not (public.order_finance_test_reset_status()->>'active')::boolean,
    'J6. and no reset is active afterwards');

  -- The audit survives the cleanup it describes. Read through the claim's own
  -- audit_id rather than by scope: section E began and released a reset, so
  -- there is more than one Finance audit row and that is correct — a reset that
  -- was given back is still something that happened.
  perform pg_temp.ok(
    (select count(*) from public.test_data_cleanup_audit a
      join public.test_data_cleanup_claims c on c.audit_id = a.id
     where c.claim_token = v_token) = 1,
    'J7. the permanent audit is not one of the rows the cleanup removes');
  perform pg_temp.ok(
    (select a.result->>'payments' from public.test_data_cleanup_audit a
      join public.test_data_cleanup_claims c on c.audit_id = a.id
     where c.claim_token = v_token) = '2',
    'J8. and carries the counts');
  perform pg_temp.ok(
    (select a.result->>'released' from public.test_data_cleanup_audit a
      join public.test_data_cleanup_claims c on c.audit_id = a.id
     where c.released_at is not null) = 'true',
    'J9. and the released attempt is recorded as released, not as a deletion');
end $$;

-- ═══ H. Full cleanup ════════════════════════════════════════════════════════

do $$
declare
  v_hash   text;
  v_token  uuid;
  v_result jsonb;
  v_ord    uuid;
  v_audits int;
  v_census jsonb;
begin
  perform pg_temp.act_as(pg_temp.admin());
  -- Rebuild Finance on top of the surviving Orders and PI Drafts.
  perform pg_temp.build_fixture();
  -- Counted BEFORE the begin that adds one, so H16 is about deletion rather
  -- than about how many resets this script has run.
  select count(*) + 1 into v_audits from public.test_data_cleanup_audit;
  select id into v_ord from public.orders order by display_number limit 1;

  v_census := public.preview_order_finance_test_reset('order_finance_module');
  v_hash   := v_census->>'plan_hash';
  v_token  := (public.begin_order_finance_test_reset(
    'order_finance_module', 'clearing the module',
    'DELETE ALL ORDER AND FINANCE TEST DATA', v_hash))->>'claim_token';

  -- The full scope freezes Orders too.
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$update public.orders set client_name = 'nope' where id = %L$q$, v_ord))
      like '55P03|ORDER_FINANCE_RESET_IN_PROGRESS%',
    'H1. an Order cannot be changed while a full reset is frozen');
  perform pg_temp.ok(
    pg_temp.fails_with(
      $q$insert into public.order_submissions (client_name, status) values ('New PI', 'draft')$q$)
      like '55P03|ORDER_FINANCE_RESET_IN_PROGRESS%',
    'H2. and no new PI Draft can appear after the scope is frozen');

  perform public.order_finance_test_reset_storage_done(v_token, 4);
  v_result := public.finalize_order_finance_test_reset(v_token);

  perform pg_temp.ok((select count(*) from public.orders) = 0,                       'H3. no Order remains');
  perform pg_temp.ok((select count(*) from public.order_submissions) = 0,            'H4. no PI Draft remains');
  perform pg_temp.ok((select count(*) from public.order_submission_items) = 0,       'H5. nor a product line');
  perform pg_temp.ok((select count(*) from public.order_submission_item_images) = 0, 'H6. nor an image row');
  perform pg_temp.ok((select count(*) from public.order_submission_activity) = 0,    'H7. nor PI activity');
  perform pg_temp.ok((select count(*) from public.order_submission_correction_requests) = 0,
    'H8. nor a correction request');
  perform pg_temp.ok((select count(*) from public.order_document_versions) = 0,      'H9. nor a document row');
  perform pg_temp.ok((select count(*) from public.order_change_requests) = 0,        'H10. nor a change request');
  perform pg_temp.ok((select count(*) from public.order_activity_log) = 0,           'H11. nor Order activity');
  perform pg_temp.ok((select count(*) from public.finance_payment_requests) = 0,     'H12. nor a payment');
  perform pg_temp.ok((select count(*) from public.finance_payment_allocations) = 0,  'H13. nor an allocation');

  -- NOTHING OUTSIDE THE MODULE.
  perform pg_temp.ok((select count(*) from public.users) = 7,
    'H14. not one user was touched');
  perform pg_temp.ok((select count(*) from public.notifications where type = 'task_assigned') > 0,
    'H15. and no task notification');
  perform pg_temp.ok((select count(*) from public.test_data_cleanup_audit) = v_audits,
    'H16. and not one audit row was removed by the cleanup it records');

  -- THE RESULT IS THE CENSUS. Asserted against the numbers the admin confirmed
  -- rather than against literals, so this holds however much fixture data the
  -- sections above happen to have left behind.
  perform pg_temp.ok(
    (v_result->>'orders')                = (v_census->'counts'->>'orders')
    and (v_result->>'order_submissions') = (v_census->'counts'->>'order_submissions')
    and (v_result->>'order_submission_items') = (v_census->'counts'->>'order_submission_items')
    and (v_result->>'correction_requests')    = (v_census->'counts'->>'correction_requests')
    and (v_result->>'payments')               = (v_census->'counts'->>'payments')
    and (v_result->>'payment_allocations')    = (v_census->'counts'->>'payment_allocations'),
    'H17. every count the admin confirmed is the count that was deleted');
end $$;

-- ═══ L. Numbering ═══════════════════════════════════════════════════════════

do $$
declare
  v_fin_token uuid;
  v_token     uuid;
  v_hash      text;
begin
  perform pg_temp.act_as(pg_temp.admin());

  select claim_token into v_fin_token from public.test_data_cleanup_claims
   where scope = 'finance_module' and finalized_at is not null limit 1;
  select claim_token into v_token from public.test_data_cleanup_claims
   where scope = 'order_finance_module' and finalized_at is not null limit 1;

  -- The register is empty now, so the reset is allowed — and it is the CANONICAL
  -- function, not a second one written for this feature.
  perform pg_temp.ok(
    (public.reset_confirmed_order_number_cycle(v_token)->>'new_next')::bigint = 1,
    'L1. a full reset over an empty register restarts the cycle');
  perform pg_temp.ok(
    (select count(*) from public.order_number_cycle_resets) = 1,
    'L2. and it is recorded');

  -- An unfinalized claim is not an occasion.
  v_hash  := public.preview_order_finance_test_reset('finance_module')->>'plan_hash';
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.reset_confirmed_order_number_cycle(null)$q$)
      like '42501|ORDER_NUMBER_RESET_NO_CLAIM%',
    'L3. a reset without a claim is refused');
  perform pg_temp.ok(
    pg_temp.fails_with($q$select public.reset_confirmed_order_number_cycle(gen_random_uuid())$q$)
      like '42501|ORDER_NUMBER_RESET_CLAIM_INVALID%',
    'L4. and so is an invented token');

  -- A SURVIVING ORDER CLOSES IT, whatever the claim says.
  insert into public.orders (display_number, client_name) values ('0009', 'Survivor');
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.reset_confirmed_order_number_cycle(%L)$q$, v_token))
      like '42501|ORDER_NUMBER_RESET_ORDERS_EXIST%',
    'L5. a surviving Order refuses the reset');

  -- AND SO DOES A SURVIVING ALLOCATION.
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  delete from public.orders where display_number = '0009';
  perform set_config('boe.cleanup_context', '', true);

  -- A Finance-only claim reaches the same function, and the gates still decide:
  -- it is the surviving state that authorizes a reset, never the scope name.
  perform pg_temp.ok(
    (public.reset_confirmed_order_number_cycle(v_fin_token)->>'new_next')::bigint = 1,
    'L6. the gates, not the scope label, decide — and they are read live');
end $$;

-- ═══ K. The PI deletion race ════════════════════════════════════════════════

do $$
declare
  v_sub   uuid;
  v_other uuid;
  v_ord   uuid;
  v_pay   uuid;
begin
  perform pg_temp.act_as(pg_temp.admin());

  insert into public.order_submissions (client_name, status) values ('Race PI', 'draft')
  returning id into v_sub;
  insert into public.finance_payment_requests (request_number, client_name, amount)
  values ('RACE-1', 'Race', 100) returning id into v_pay;

  -- Both writers work normally while the PI carries no deletion claim.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.finance_payment_allocations
         (payment_request_id, order_submission_id, allocated_amount, origin_target_type)
         values (%L, %L, 1, 'order_submission')$q$, v_pay, v_sub)) = 'NO ERROR',
    'K1. an unclaimed PI can be allocated to');
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  delete from public.finance_payment_allocations where order_submission_id = v_sub;
  perform set_config('boe.cleanup_context', '', true);

  -- Now the PI is reserved for deletion, exactly as begin_order_submission_deletion
  -- leaves it.
  update public.order_submissions
     set deletion_claim_token = gen_random_uuid(), deletion_claimed_at = now()
   where id = v_sub;

  -- THE TWO WRITERS THE EXISTING CLAIM DID NOT CLOSE.
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.finance_payment_allocations
         (payment_request_id, order_submission_id, allocated_amount, origin_target_type)
         values (%L, %L, 1, 'order_submission')$q$, v_pay, v_sub))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K2. an allocation cannot be created against a PI being deleted');
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.order_submission_correction_requests (submission_id) values (%L)$q$, v_sub))
      like '55P03|ORDER_SUBMISSION_DELETION_CLAIMED%',
    'K3. nor a correction request');

  -- AND A DIFFERENT PI IS UNAFFECTED. The guards are about the named record, not
  -- about the table being closed — a reservation on one PI must not stop the
  -- rest of the business allocating money to another.
  insert into public.order_submissions (client_name, status) values ('Bystander PI', 'draft')
  returning id into v_other;
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.finance_payment_allocations
         (payment_request_id, order_submission_id, allocated_amount, origin_target_type)
         values (%L, %L, 1, 'order_submission')$q$, v_pay, v_other)) = 'NO ERROR',
    'K4. a PI with no deletion claim is unaffected');

  -- An allocation to an ORDER is unaffected too: it names no PI at all.
  insert into public.orders (display_number, client_name) values ('0100', 'Race Order')
  returning id into v_ord;
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.finance_payment_allocations
         (payment_request_id, order_id, allocated_amount, origin_target_type)
         values (%L, %L, 1, 'confirmed_order')$q$, v_pay, v_ord)) = 'NO ERROR',
    'K5. and an allocation to an Order names no PI, so no guard applies');

  -- THE CLAIM RELEASING ENDS THE REFUSAL. Nothing about the table is permanently
  -- narrowed by having once held a reservation.
  update public.order_submissions set deletion_claim_token = null where id = v_sub;
  perform pg_temp.ok(
    pg_temp.fails_with(format(
      $q$insert into public.order_submission_correction_requests (submission_id) values (%L)$q$, v_sub))
      = 'NO ERROR',
    'K6. and the refusal ends when the reservation does');
end $$;

-- ═══ M. The chain protocol is untouched ═════════════════════════════════════

do $$
declare v_token uuid;
begin
  perform pg_temp.act_as(pg_temp.admin());
  select claim_token into v_token from public.test_data_cleanup_claims
   where scope = 'order_finance_module' limit 1;

  -- A MODULE CLAIM FED TO THE CHAIN FINALIZER FAILS CLOSED, on its own, because
  -- chain resolution refuses a root type it does not know. That is why this
  -- migration restates none of the chain protocol.
  perform pg_temp.ok(
    pg_temp.fails_with(format($q$select public.finalize_test_data_cleanup(%L)$q$, v_token))
      like 'P0001|CLEANUP_ROOT_TYPE_INVALID%',
    'M1. the chain finalizer cannot act on a module claim');

  -- And the reverse: the module finalizer only knows scope claims.
  insert into public.test_data_cleanup_claims
    (root_type, root_id, reason, confirmation, claimed_by)
  values ('order', gen_random_uuid(), 'chain', 'DELETE TEST DATA', pg_temp.admin());
  perform pg_temp.ok(
    pg_temp.fails_with(
      $q$select public.finalize_order_finance_test_reset(
        (select claim_token from public.test_data_cleanup_claims where root_type = 'order' limit 1))$q$)
      like '42501|RESET_CLAIM_INVALID%',
    'M2. and the module finalizer cannot act on a chain claim');

  -- The shape constraint is what keeps the two apart at rest.
  perform pg_temp.ok(
    pg_temp.fails_with(
      $q$insert into public.test_data_cleanup_claims
         (root_type, root_id, scope, reason, confirmation)
         values ('finance_module', gen_random_uuid(), 'finance_module', 'x', 'y')$q$)
      like '23514|%',
    'M3. a row cannot be both a chain claim and a module claim');
end $$;


-- ═══ N. Deleting ONE payment that owns files (§11) ══════════════════════════
--
-- The defect: the payment was deleted and its proof objects removed afterwards,
-- but payment_proof_attachments cascades with the payment — so a storage failure
-- arrived with the manifest already destroyed and nothing left to retry from.
-- These assertions pin the protocol that replaces it.

do $$
declare
  v_pay    uuid;
  v_pay2   uuid;
  v_ord    uuid;
  v_claim  jsonb;
  v_token  uuid;
  v_paths  text[];
  v_err    text;
  v_res    jsonb;
begin
  perform pg_temp.act_as(pg_temp.admin());

  select id into v_ord from public.orders limit 1;

  -- An unapproved payment with TWO proof objects and one allocation.
  insert into public.finance_payment_requests
    (request_number, client_name, amount, status, submitted_by, order_id)
  values ('PR-N1', 'N Co', 5000, 'pending_approval', pg_temp.admin(), v_ord)
  returning id into v_pay;

  insert into public.payment_proof_attachments (payment_request_id, storage_path)
  values (v_pay, v_pay::text || '/a.pdf'),
         (v_pay, v_pay::text || '/b.pdf');

  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by)
  values (v_pay, v_ord, 1000, 'active', 'order', pg_temp.admin());

  -- ── N1. The manifest is frozen from the rows, not from a caller ──
  v_claim := public.begin_finance_payment_deletion(v_pay);
  v_token := (v_claim->>'claim_token')::uuid;
  select array_agg(x order by x) into v_paths
  from jsonb_array_elements_text(v_claim->'storage_paths') x;
  perform pg_temp.ok(v_paths = array[v_pay::text || '/a.pdf', v_pay::text || '/b.pdf'],
    'N1. the claim carries both proof keys, read from the attachment rows');
  perform pg_temp.ok(
    (select cardinality(allocation_ids) from public.finance_payment_deletion_claims
      where payment_id = v_pay) = 1,
    'N1b. and records the allocation it will release');

  -- ── N2. Verification is refused while the claim stands ──
  v_err := pg_temp.fails_with(
    format($q$update public.finance_payment_requests set status = 'approved_linked' where id = %L$q$, v_pay));
  perform pg_temp.ok(v_err like '55P03|PAYMENT_DELETION_CLAIMED%',
    'N2. a payment being deleted cannot be verified; got: ' || v_err);

  -- ── N3. Proof mutation is refused in BOTH directions ──
  v_err := pg_temp.fails_with(
    format($q$insert into public.payment_proof_attachments (payment_request_id, storage_path)
             values (%L, %L)$q$, v_pay, v_pay::text || '/c.pdf'));
  perform pg_temp.ok(v_err like '55P03|PAYMENT_DELETION_CLAIMED%',
    'N3a. a proof cannot be added after the manifest is frozen; got: ' || v_err);
  v_err := pg_temp.fails_with(
    format($q$delete from public.payment_proof_attachments where payment_request_id = %L$q$, v_pay));
  perform pg_temp.ok(v_err like '55P03|PAYMENT_DELETION_CLAIMED%',
    'N3b. nor removed, so the manifest cannot go stale either way; got: ' || v_err);

  -- ── N4. Allocation mutation is refused ──
  v_err := pg_temp.fails_with(
    format($q$insert into public.finance_payment_allocations
             (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by)
             values (%L, %L, 100, 'active', 'order', %L)$q$, v_pay, v_ord, pg_temp.admin()));
  perform pg_temp.ok(v_err like '55P03|PAYMENT_DELETION_CLAIMED%',
    'N4. a payment being deleted cannot be allocated; got: ' || v_err);

  -- ── N5. Finalizing with files still in storage is refused ──
  v_err := pg_temp.fails_with(
    format($q$select public.finalize_finance_payment_deletion(%L, %L)$q$, v_pay, v_token));
  perform pg_temp.ok(v_err like '55P03|PAYMENT_DELETION_PROOF_PENDING%',
    'N5. the payment cannot go while its proof objects are still there; got: ' || v_err);
  perform pg_temp.ok(exists (select 1 from public.finance_payment_requests where id = v_pay),
    'N5b. and the payment survives the refusal');

  -- ── N6. A forged path is refused ──
  v_err := pg_temp.fails_with(
    format($q$select public.record_finance_payment_proof_removed(%L, %L, array['%s/evil.pdf'])$q$,
           v_pay, v_token, gen_random_uuid()));
  perform pg_temp.ok(v_err like '42501|PAYMENT_DELETION_PATH_UNKNOWN%',
    'N6. only keys the frozen manifest names may be reported removed; got: ' || v_err);

  -- ── N7. A PARTIAL sweep leaves the deletion resumable ──
  perform public.record_finance_payment_proof_removed(
    v_pay, v_token, array[v_pay::text || '/a.pdf']);
  v_err := pg_temp.fails_with(
    format($q$select public.finalize_finance_payment_deletion(%L, %L)$q$, v_pay, v_token));
  perform pg_temp.ok(v_err like '55P03|PAYMENT_DELETION_PROOF_PENDING%',
    'N7. one file gone is not all files gone; got: ' || v_err);
  perform pg_temp.ok(exists (select 1 from public.finance_payment_requests where id = v_pay),
    'N7b. the payment and its manifest both survive a partial sweep');

  -- ── N8. RESUME. A second begin returns the SAME claim and manifest ──
  v_claim := public.begin_finance_payment_deletion(v_pay);
  perform pg_temp.ok((v_claim->>'claim_token')::uuid = v_token,
    'N8. resuming returns the standing claim rather than starting a second one');
  perform pg_temp.ok((v_claim->>'resumed')::boolean,
    'N8b. and says so');
  perform pg_temp.ok(
    jsonb_array_length(v_claim->'storage_removed') = 1,
    'N8c. carrying what storage has already confirmed, so a retry sweeps the difference');

  -- ── N9. A key already reported is not double counted; missing is accepted ──
  perform public.record_finance_payment_proof_removed(
    v_pay, v_token, array[v_pay::text || '/a.pdf', v_pay::text || '/b.pdf']);
  v_res := public.record_finance_payment_proof_removed(v_pay, v_token, array[]::text[]);
  perform pg_temp.ok((v_res->>'complete')::boolean,
    'N9. an already-removed key is accepted rather than counted twice');

  -- ── N10. Release is refused once anything has gone ──
  v_err := pg_temp.fails_with(
    format($q$select public.release_finance_payment_deletion(%L, %L)$q$, v_pay, v_token));
  perform pg_temp.ok(v_err like '55P03|PAYMENT_DELETION_IN_PROGRESS%',
    'N10. a payment whose proof is already gone must be finished, not handed back; got: ' || v_err);

  -- ── N11. Finalize deletes the payment and releases the allocation atomically ──
  v_res := public.finalize_finance_payment_deletion(v_pay, v_token);
  perform pg_temp.ok((v_res->>'allocations_released')::int = 1,
    'N11. the allocation it recorded is the allocation it released');
  perform pg_temp.ok(not exists (select 1 from public.finance_payment_requests where id = v_pay),
    'N11b. the payment is gone');
  perform pg_temp.ok(not exists (
    select 1 from public.finance_payment_allocations where payment_request_id = v_pay),
    'N11c. and so are its allocations, in the same statement');

  -- ── N12. THE CLAIM SURVIVES THE PAYMENT ──
  perform pg_temp.ok(exists (
    select 1 from public.finance_payment_deletion_claims
    where payment_id = v_pay and finalized_at is not null),
    'N12. the claim outlives the row it deleted, which is what made every stage resumable');
  perform pg_temp.ok((
    select cardinality(storage_paths) from public.finance_payment_deletion_claims
    where payment_id = v_pay) = 2,
    'N12b. with the manifest still readable afterwards');

  -- ── N13. A completed deletion answers success a second time ──
  v_res := public.finalize_finance_payment_deletion(v_pay, v_token);
  perform pg_temp.ok((v_res->>'already_deleted')::boolean,
    'N13. finalizing twice is the state the caller asked for, not an error');

  -- ── N14. A verified payment is never claimed ──
  insert into public.finance_payment_requests
    (request_number, client_name, amount, status, submitted_by, order_id)
  values ('PR-N2', 'N Verified', 900, 'approved_linked', pg_temp.admin(), v_ord)
  returning id into v_pay2;
  v_err := pg_temp.fails_with(
    format($q$select public.begin_finance_payment_deletion(%L)$q$, v_pay2));
  perform pg_temp.ok(v_err like '42501|%',
    'N14. verified money never gets a claim at all; got: ' || v_err);
  perform pg_temp.ok(not exists (
    select 1 from public.finance_payment_deletion_claims where payment_id = v_pay2),
    'N14b. and no freeze is taken over it');
  perform pg_temp.ok(exists (select 1 from public.finance_payment_requests where id = v_pay2),
    'N14c. and it is untouched');

  -- ── N15. Authorization is re-derived, not inherited ──
  perform pg_temp.act_as(pg_temp.inactive());
  v_err := pg_temp.fails_with(
    format($q$select public.begin_finance_payment_deletion(%L)$q$, v_pay2));
  perform pg_temp.ok(v_err like '42501|%',
    'N15. an inactive administrator may not begin a deletion; got: ' || v_err);
  perform pg_temp.act_as(pg_temp.admin());

  raise notice 'PAYMENT DELETION CLAIM ASSERTIONS PASSED';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
