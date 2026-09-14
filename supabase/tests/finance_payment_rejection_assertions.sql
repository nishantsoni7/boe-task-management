-- FINANCE PAYMENT DECISION assertions (20261211000000)
-- ===========================================================================
-- Proves, by EXECUTING the writes a PostgREST client can send, that a payment
-- decision belongs to a payment verifier who did not record the payment, and
-- that the Finance note belongs to Finance:
--
--   * SUBMITTER ONLY   cannot reject, send back or verify their own payment —
--                      by direct UPDATE or through either RPC — cannot write,
--                      replace or clear its Finance note, and cannot INSERT a
--                      payment already decided or carrying a Finance note; but
--                      still corrects amount, date, reference and sales note on
--                      their own pending payment, and still reapplies;
--   * SUBMITTER + VERIFIER  cannot approve, reject or send back their OWN
--                      payment by any door, but decides everybody else's;
--   * VERIFIER ONLY    rejects through reject_finance_payment_request() with a
--                      required reason, only while pending, recorded as the
--                      actor; the Finance dialog's direct reject still needs a
--                      reason; no direct verification;
--   * MANAGER          cannot un-verify a verified payment and cannot reject;
--                      still corrects a verified payment, including its note —
--                      but not the note of a payment they recorded;
--   * ADMIN            keeps the established override, including on a payment
--                      they recorded.
--
-- Before 20261211000000 is applied this file fails at the first submitter
-- assertion; after it, it prints ALL ASSERTIONS PASSED.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK. Creates its own
-- fixture accounts (fixed UUIDs below) and grants, so it needs a disposable,
-- fully migrated database and a role that bypasses RLS and may SET role.

\set ON_ERROR_STOP on

begin;

set constraints all immediate;   -- the PI-timeline echo fires per statement

insert into public.users (id, full_name, email, role, team, is_active) values
  ('d0000000-0000-4000-8000-00000000000a', 'ASSERT decision admin',       'assert.decision.admin@verify.local',     'admin',  'management', true),
  ('d0000000-0000-4000-8000-000000000001', 'ASSERT decision submitter',   'assert.decision.submitter@verify.local', 'member', 'sales',      true),
  ('d0000000-0000-4000-8000-000000000003', 'ASSERT decision verifier',    'assert.decision.verifier@verify.local',  'member', 'operations', true),
  ('d0000000-0000-4000-8000-000000000004', 'ASSERT decision manager',     'assert.decision.manager@verify.local',   'member', 'operations', true),
  ('d0000000-0000-4000-8000-000000000005', 'ASSERT decision viewer',      'assert.decision.viewer@verify.local',    'member', 'operations', true),
  ('d0000000-0000-4000-8000-000000000007', 'ASSERT decision sub+verifier', 'assert.decision.both@verify.local',     'member', 'operations', true);

-- Grants, never role inheritance.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select v.uid, pm.id, pa.id, true, 'd0000000-0000-4000-8000-00000000000a'
from (values
  ('d0000000-0000-4000-8000-000000000001'::uuid, 'finance', 'view'),
  ('d0000000-0000-4000-8000-000000000001'::uuid, 'finance', 'create'),
  ('d0000000-0000-4000-8000-000000000003'::uuid, 'finance', 'view'),
  ('d0000000-0000-4000-8000-000000000003'::uuid, 'finance', 'view_all'),
  ('d0000000-0000-4000-8000-000000000003'::uuid, 'finance', 'approve'),
  ('d0000000-0000-4000-8000-000000000004'::uuid, 'finance', 'view'),
  ('d0000000-0000-4000-8000-000000000004'::uuid, 'finance', 'view_all'),
  ('d0000000-0000-4000-8000-000000000004'::uuid, 'finance', 'manage'),
  ('d0000000-0000-4000-8000-000000000005'::uuid, 'finance', 'view'),
  ('d0000000-0000-4000-8000-000000000005'::uuid, 'finance', 'view_all'),
  ('d0000000-0000-4000-8000-000000000007'::uuid, 'finance', 'view'),
  ('d0000000-0000-4000-8000-000000000007'::uuid, 'finance', 'view_all'),
  ('d0000000-0000-4000-8000-000000000007'::uuid, 'finance', 'approve'),
  ('d0000000-0000-4000-8000-000000000007'::uuid, 'finance', 'create')
) as v(uid, module_key, action_key)
join public.permission_modules pm on pm.module_key = v.module_key
join public.permission_actions pa on pa.action_key = v.action_key;

-- A fixture that silently granted nothing would pass for the wrong reason.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-4000-8000-000000000001', true);
  assert public.module_entry_open('finance'), 'the submitter must have Finance entry';
  assert not public.actor_has_module_permission('finance', 'approve')
     and not public.actor_has_module_permission('finance', 'manage'), 'the submitter must hold neither approve nor manage';
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-4000-8000-000000000003', true);
  assert public.actor_has_module_permission('finance', 'approve'), 'the verifier must hold approve';
  assert not public.actor_has_module_permission('finance', 'manage'), 'the verifier must not hold manage';
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-4000-8000-000000000007', true);
  assert public.actor_has_module_permission('finance', 'approve'), 'the submitter+verifier must hold approve';
  assert not public.actor_has_module_permission('finance', 'manage'), 'the submitter+verifier must not hold manage';
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-4000-8000-000000000004', true);
  assert public.actor_has_module_permission('finance', 'manage'), 'the manager must hold manage';
  assert not public.actor_has_module_permission('finance', 'approve'), 'the manager must not hold approve';
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-4000-8000-000000000005', true);
  assert not public.actor_has_module_permission('finance', 'approve')
     and not public.actor_has_module_permission('finance', 'manage'), 'the viewer must hold no write authority';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- ── Helpers ──────────────────────────────────────────────────────────────────

create temp table assert_ctx (k text primary key, v text);

-- A PI Draft every fixture payment is allocated to, so the timeline echo and
-- its actor are observable.
do $$
declare v_pi uuid := gen_random_uuid();
begin
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, source_workbook_path,
     gross_product_amount, discount_amount, grand_total)
  values
    (v_pi, 'draft', 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
     'ASSERT decision PI', 'submissions/assert-decision/original/w.xlsx', 100000000, 0, 100000000);
  insert into assert_ctx values ('pi', v_pi::text);
end $$;

-- A fresh payment recorded by p_submitter, in the requested status, written as
-- the migration owner (no JWT), exactly as a fixture should be.
create function pg_temp.payment(p_submitter uuid, p_status text) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, proof_note, submitted_by)
  values (v_id, 'ASSERT', 1000, date '2026-09-01', 'hdfc', 'UTR-ASSERT', p_submitter);
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_id, (select v::uuid from assert_ctx where k = 'pi'), 1000, 'order_submission', p_submitter);
  if p_status = 'approved_unlinked' then
    update public.finance_payment_requests
       set status = 'approved_unlinked', approved_by = 'd0000000-0000-4000-8000-00000000000a',
           approved_at = now(), admin_note = 'fixture verified'
     where id = v_id;
  elsif p_status in ('rejected', 'needs_clarification') then
    update public.finance_payment_requests set status = p_status, admin_note = 'fixture' where id = v_id;
  end if;
  return v_id;
end $$;

-- Run one statement as p_user under RLS, the way PostgREST runs a request.
-- Returns 'ok <rows>', or '<SQLSTATE> <message>' when refused. The role and
-- JWT revert with the subtransaction either way.
create function pg_temp.try_as(p_user uuid, p_sql text, p_id uuid) returns text language plpgsql as $$
declare v_rows bigint;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', p_user::text, true);
    perform set_config('role', 'authenticated', true);
    execute p_sql using p_id;
    get diagnostics v_rows = row_count;
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return 'ok ' || v_rows;
  exception when others then
    return sqlstate || ' ' || sqlerrm;
  end;
end $$;

-- ═══ 1. SUBMITTER ONLY ══════════════════════════════════════════════════════
do $$
declare
  s constant uuid := 'd0000000-0000-4000-8000-000000000001';
  v uuid;
  r public.finance_payment_requests%rowtype;
  t text;
begin
  v := pg_temp.payment(s, 'pending_approval');

  -- No decision, by any door.
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''self'', updated_at = now() where id = $1', v);
  assert t like '42501%', 'submitter: direct reject of own payment (the client write) must be refused, got ' || t;
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''needs_clarification'', admin_note = ''self'' where id = $1', v);
  assert t like '42501%', 'submitter: direct send-back must be refused, got ' || t;
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''approved_unlinked'' where id = $1', v);
  assert t like '42501%', 'submitter: direct verification must be refused, got ' || t;
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''approved_unlinked'', approved_by = auth.uid(), approved_at = now() where id = $1', v);
  assert t like '42501%', 'submitter: self-stamped verification must be refused, got ' || t;
  t := pg_temp.try_as(s, 'select public.reject_finance_payment_request($1, ''self'')', v);
  assert t like '42501%', 'submitter: rejection RPC must be refused, got ' || t;
  t := pg_temp.try_as(s, 'select public.approve_finance_payment_request($1, null)', v);
  assert t like '42501%', 'submitter: approval RPC must be refused, got ' || t;

  -- No Finance note.
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set admin_note = ''Verified by Finance'' where id = $1', v);
  assert t like '42501%FINANCE_NOTE_PROTECTED%', 'submitter: writing the Finance note on own pending payment must be refused, got ' || t;

  select * into r from public.finance_payment_requests where id = v;
  assert r.status = 'pending_approval' and r.admin_note is null and r.approved_by is null,
    'every refused write must leave the payment exactly as it was';

  -- Still theirs to correct while pending: amount, date, reference, sales note.
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set amount = 1200 where id = $1', v) = 'ok 1',
    'submitter: amount must stay editable on own pending payment';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set payment_date = date ''2026-08-31'' where id = $1', v) = 'ok 1',
    'submitter: payment date must stay editable';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set proof_note = ''UTR-CORRECTED'' where id = $1', v) = 'ok 1',
    'submitter: reference must stay editable';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set sales_note = ''paid in two parts'' where id = $1', v) = 'ok 1',
    'submitter: their own sales note must stay editable';
  select * into r from public.finance_payment_requests where id = v;
  assert r.amount = 1200 and r.payment_date = date '2026-08-31' and r.proof_note = 'UTR-CORRECTED'
     and r.sales_note = 'paid in two parts' and r.admin_note is null, 'the corrections must have landed';

  -- A rejected payment: no verification, no send-back, no touching its reason —
  -- but reapplication still works and keeps Finance's reason.
  v := pg_temp.payment(s, 'rejected');
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''approved_unlinked'' where id = $1', v);
  assert t like '42501%', 'submitter: verifying own rejected payment must be refused, got ' || t;
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''needs_clarification'' where id = $1', v);
  assert t like '42501%', 'submitter: moving own rejected payment to needs_clarification must be refused, got ' || t;
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set admin_note = null where id = $1', v);
  assert t like '42501%FINANCE_NOTE_PROTECTED%', 'submitter: clearing the rejection reason must be refused, got ' || t;
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set admin_note = ''actually fine'' where id = $1', v);
  assert t like '42501%FINANCE_NOTE_PROTECTED%', 'submitter: replacing the rejection reason must be refused, got ' || t;
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''pending_approval'' where id = $1', v) = 'ok 1',
    'submitter: reapplying a rejected payment must still work';
  assert (select admin_note from public.finance_payment_requests where id = v) = 'fixture',
    'reapplication must keep Finance''s reason';

  v := pg_temp.payment(s, 'needs_clarification');
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''self'' where id = $1', v);
  assert t like '42501%', 'submitter: rejecting a payment Finance sent back must be refused, got ' || t;
  t := pg_temp.try_as(s, 'update public.finance_payment_requests set admin_note = ''answered'' where id = $1', v);
  assert t like '42501%FINANCE_NOTE_PROTECTED%', 'submitter: replacing the clarification note must be refused, got ' || t;
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''pending_approval'' where id = $1', v) = 'ok 1',
    'submitter: answering a clarification by reapplying must still work';

  -- Recording is not deciding.
  t := pg_temp.try_as(s, 'insert into public.finance_payment_requests (client_name, amount, payment_date, payment_mode, submitted_by, status, approved_by, approved_at) values (''ASSERT'', 1, current_date, ''hdfc'', auth.uid(), ''approved_unlinked'', auth.uid(), now())', null);
  assert t like '42501%', 'submitter: inserting a verified payment must be refused, got ' || t;
  t := pg_temp.try_as(s, 'insert into public.finance_payment_requests (client_name, amount, payment_date, payment_mode, submitted_by, status, admin_note) values (''ASSERT'', 1, current_date, ''hdfc'', auth.uid(), ''rejected'', ''self'')', null);
  assert t like '42501%', 'submitter: inserting a rejected payment must be refused, got ' || t;
  t := pg_temp.try_as(s, 'insert into public.finance_payment_requests (client_name, amount, payment_date, payment_mode, submitted_by, admin_note) values (''ASSERT'', 1, current_date, ''hdfc'', auth.uid(), ''Verified by Finance'')', null);
  assert t like '42501%FINANCE_NOTE_PROTECTED%', 'submitter: inserting a payment with a Finance note must be refused, got ' || t;
  assert pg_temp.try_as(s, 'insert into public.finance_payment_requests (client_name, amount, payment_date, payment_mode, submitted_by, sales_note) values (''ASSERT'', 1, current_date, ''hdfc'', auth.uid(), ''from the site visit'')', null) = 'ok 1',
    'submitter: a pending payment with a sales note must still be recordable';
  assert pg_temp.try_as(s, 'select public.submit_payment_request(''suspense'', null, 1000, current_date, ''hdfc'', ''UTR-ENTRY'', ''sales note'', ''[]''::jsonb)', null) = 'ok 1',
    'submitter: payment entry through submit_payment_request must still work';
end $$;

-- ═══ 2. SUBMITTER + VERIFIER ════════════════════════════════════════════════
do $$
declare
  s constant uuid := 'd0000000-0000-4000-8000-000000000001';
  b constant uuid := 'd0000000-0000-4000-8000-000000000007';
  v uuid;
  r public.finance_payment_requests%rowtype;
  t text;
begin
  v := pg_temp.payment(b, 'pending_approval');

  t := pg_temp.try_as(b, 'select public.approve_finance_payment_request($1, ''self check'')', v);
  assert t like '42501%PAYMENT_SELF_DECISION_FORBIDDEN%', 'sub+verifier: the approval RPC must refuse own payment, got ' || t;
  t := pg_temp.try_as(b, 'select public.reject_finance_payment_request($1, ''self check'')', v);
  assert t like '42501%PAYMENT_SELF_DECISION_FORBIDDEN%', 'sub+verifier: the rejection RPC must refuse own payment, got ' || t;
  t := pg_temp.try_as(b, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''self'', updated_at = now() where id = $1', v);
  assert t like '42501%PAYMENT_SELF_DECISION_FORBIDDEN%', 'sub+verifier: the Finance dialog''s direct reject must refuse own payment, got ' || t;
  t := pg_temp.try_as(b, 'update public.finance_payment_requests set status = ''needs_clarification'', admin_note = ''self'', updated_at = now() where id = $1', v);
  assert t like '42501%PAYMENT_SELF_DECISION_FORBIDDEN%', 'sub+verifier: the direct send-back must refuse own payment, got ' || t;
  t := pg_temp.try_as(b, 'update public.finance_payment_requests set status = ''approved_unlinked'' where id = $1', v);
  assert t like '42501%', 'sub+verifier: direct verification of own payment must be refused, got ' || t;
  t := pg_temp.try_as(b, 'update public.finance_payment_requests set admin_note = ''self'' where id = $1', v);
  assert t like '42501%FINANCE_NOTE_PROTECTED%', 'sub+verifier: the Finance note on own payment must be refused, got ' || t;

  select * into r from public.finance_payment_requests where id = v;
  assert r.status = 'pending_approval' and r.approved_by is null and r.admin_note is null,
    'own payment must be untouched after every refusal';

  -- The same person decides somebody else's payment.
  v := pg_temp.payment(s, 'pending_approval');
  assert pg_temp.try_as(b, 'select public.approve_finance_payment_request($1, ''matched statement'')', v) = 'ok 1',
    'sub+verifier: must verify somebody else''s payment';
  select * into r from public.finance_payment_requests where id = v;
  assert r.status = 'approved_unlinked' and r.approved_by = b and r.admin_note = 'matched statement',
    'verification must stamp the verifier and keep the note';

  v := pg_temp.payment(s, 'pending_approval');
  assert pg_temp.try_as(b, 'select public.reject_finance_payment_request($1, ''duplicate'')', v) = 'ok 1',
    'sub+verifier: must reject somebody else''s payment';
end $$;

-- ═══ 3. VERIFIER ONLY ═══════════════════════════════════════════════════════
do $$
declare
  s constant uuid := 'd0000000-0000-4000-8000-000000000001';
  f constant uuid := 'd0000000-0000-4000-8000-000000000003';
  v uuid;
  r public.finance_payment_requests%rowtype;
  a_before public.finance_payment_allocations%rowtype;
  a_after  public.finance_payment_allocations%rowtype;
  t text;
begin
  v := pg_temp.payment(s, 'pending_approval');
  select * into a_before from public.finance_payment_allocations where payment_request_id = v;

  t := pg_temp.try_as(f, 'select public.reject_finance_payment_request($1, ''   '')', v);
  assert t like '22023%', 'verifier: a blank reason must be refused, got ' || t;
  assert (select status from public.finance_payment_requests where id = v) = 'pending_approval',
    'a refused rejection must not move the payment';

  assert pg_temp.try_as(f, 'select public.reject_finance_payment_request($1, ''  Duplicate of PAY-1  '')', v) = 'ok 1',
    'verifier: must reject a pending payment through the RPC';
  select * into r from public.finance_payment_requests where id = v;
  assert r.status = 'rejected' and r.admin_note = 'Duplicate of PAY-1' and r.rejected_at is not null,
    'status and trimmed reason must land together';
  assert r.amount = 1000 and r.proof_note = 'UTR-ASSERT' and r.approved_by is null,
    'rejection must change nothing but the decision';
  select * into a_after from public.finance_payment_allocations where payment_request_id = v;
  assert a_after.id = a_before.id and a_after.allocated_amount = a_before.allocated_amount
     and a_after.status = a_before.status and a_after.order_submission_id = a_before.order_submission_id,
    'rejection must not change the allocation';
  assert exists (
    select 1 from public.finance_payment_request_activity_log
    where payment_request_id = v and event_type = 'status_changed' and actor_id = f
      and payload->>'from_status' = 'pending_approval' and payload->>'to_status' = 'rejected'),
    'the Finance trail must record the verifier as the actor of the rejection';
  assert exists (
    select 1 from public.order_submission_activity
    where metadata->>'payment_id' = v::text and action = 'payment_rejected' and actor_id = f),
    'the PI timeline must record the verifier as the actor of the rejection';

  t := pg_temp.try_as(f, 'select public.reject_finance_payment_request($1, ''again'')', v);
  assert t like 'P0001%', 'verifier: a rejected payment must not be rejected again, got ' || t;

  -- The Finance review dialog's direct write: still works, still needs a reason.
  v := pg_temp.payment(s, 'pending_approval');
  assert pg_temp.try_as(f, 'update public.finance_payment_requests set status = ''needs_clarification'', admin_note = ''which account?'', updated_at = now() where id = $1', v) = 'ok 1',
    'verifier: sending a payment back from Finance must still work';
  v := pg_temp.payment(s, 'pending_approval');
  t := pg_temp.try_as(f, 'update public.finance_payment_requests set status = ''rejected'', updated_at = now() where id = $1', v);
  assert t like '22023%', 'verifier: a direct rejection without a reason must be refused, got ' || t;
  assert pg_temp.try_as(f, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''declined'', updated_at = now() where id = $1', v) = 'ok 1',
    'verifier: rejecting from Finance with a reason must still work';

  -- No note without a decision; no verification except the RPC.
  v := pg_temp.payment(s, 'pending_approval');
  t := pg_temp.try_as(f, 'update public.finance_payment_requests set admin_note = ''looks fine'' where id = $1', v);
  assert t like '42501%', 'verifier: a Finance note without a decision must be refused, got ' || t;
  t := pg_temp.try_as(f, 'update public.finance_payment_requests set status = ''approved_unlinked'' where id = $1', v);
  assert t like '42501%', 'verifier: direct verification must be refused, got ' || t;
  assert pg_temp.try_as(f, 'select public.approve_finance_payment_request($1, ''matched HDFC'')', v) = 'ok 1',
    'verifier: must verify through the RPC';
  select * into r from public.finance_payment_requests where id = v;
  assert r.status = 'approved_unlinked' and r.approved_by = f and r.admin_note = 'matched HDFC',
    'verification must stamp the verifier';
  t := pg_temp.try_as(f, 'select public.reject_finance_payment_request($1, ''too late'')', v);
  assert t like 'P0001%', 'verifier: a verified payment must not be rejected, got ' || t;
end $$;

-- ═══ 4. MANAGER (and viewer) ════════════════════════════════════════════════
do $$
declare
  s constant uuid := 'd0000000-0000-4000-8000-000000000001';
  m constant uuid := 'd0000000-0000-4000-8000-000000000004';
  w constant uuid := 'd0000000-0000-4000-8000-000000000005';
  v uuid;
  t text;
begin
  v := pg_temp.payment(s, 'approved_unlinked');
  t := pg_temp.try_as(m, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''reversal'' where id = $1', v);
  assert t like '42501%', 'manager: rejecting a verified payment must be refused, got ' || t;
  t := pg_temp.try_as(m, 'update public.finance_payment_requests set status = ''needs_clarification'' where id = $1', v);
  assert t like '42501%', 'manager: sending a verified payment back must be refused, got ' || t;
  t := pg_temp.try_as(m, 'update public.finance_payment_requests set status = ''pending_approval'' where id = $1', v);
  assert t like '42501%', 'manager: un-verifying a payment must be refused, got ' || t;
  assert pg_temp.try_as(m, 'update public.finance_payment_requests set proof_note = ''UTR-CORRECTED'' where id = $1', v) = 'ok 1',
    'manager: correcting a verified payment must still work';
  assert pg_temp.try_as(m, 'update public.finance_payment_requests set admin_note = ''corrected reference'' where id = $1', v) = 'ok 1',
    'manager: correcting the Finance note of a verified payment must still work';
  assert (select status from public.finance_payment_requests where id = v) = 'approved_unlinked',
    'the verified payment must still be verified';

  -- A manager who recorded the payment still corrects it, but not its Finance note.
  v := pg_temp.payment(m, 'approved_unlinked');
  t := pg_temp.try_as(m, 'update public.finance_payment_requests set admin_note = ''self'' where id = $1', v);
  assert t like '42501%FINANCE_NOTE_PROTECTED%', 'manager: the Finance note of own payment must be refused, got ' || t;
  assert pg_temp.try_as(m, 'update public.finance_payment_requests set proof_note = ''UTR-CORRECTED'' where id = $1', v) = 'ok 1',
    'manager: correcting own verified payment''s details must still work';

  v := pg_temp.payment(s, 'pending_approval');
  t := pg_temp.try_as(m, 'select public.reject_finance_payment_request($1, ''no'')', v);
  assert t like '42501%', 'finance.manage must not reject, got ' || t;
  t := pg_temp.try_as(w, 'select public.reject_finance_payment_request($1, ''no'')', v);
  assert t like '42501%', 'finance.view_all must not reject, got ' || t;
  assert (select status from public.finance_payment_requests where id = v) = 'pending_approval',
    'the payment must be untouched';
end $$;

-- ═══ 5. ADMIN, AND THE GRANTS ═══════════════════════════════════════════════
do $$
declare
  s constant uuid := 'd0000000-0000-4000-8000-000000000001';
  a constant uuid := 'd0000000-0000-4000-8000-00000000000a';
  v uuid;
begin
  -- The established override: an admin decides even a payment they recorded.
  v := pg_temp.payment(a, 'pending_approval');
  assert pg_temp.try_as(a, 'select public.approve_finance_payment_request($1, null)', v) = 'ok 1',
    'admin: must verify a payment they recorded';
  v := pg_temp.payment(a, 'pending_approval');
  assert pg_temp.try_as(a, 'select public.reject_finance_payment_request($1, ''admin decision'')', v) = 'ok 1',
    'admin: must reject a payment they recorded';

  v := pg_temp.payment(s, 'pending_approval');
  assert pg_temp.try_as(a, 'update public.finance_payment_requests set admin_note = ''admin note'' where id = $1', v) = 'ok 1',
    'admin: the Finance note is unchanged for an admin';
  assert pg_temp.try_as(a, 'update public.finance_payment_requests set status = ''rejected'' where id = $1', v) = 'ok 1',
    'admin: an admin''s direct decision is unchanged';

  assert has_function_privilege('authenticated', 'public.reject_finance_payment_request(uuid, text)', 'execute'),
    'authenticated must be able to call the rejection RPC';
  assert not has_function_privilege('anon', 'public.reject_finance_payment_request(uuid, text)', 'execute'),
    'anon must not be able to call the rejection RPC';
  assert not has_function_privilege('authenticated', 'public.finance_payment_requests_guard_decision_status()', 'execute'),
    'no client role may call the guard';
end $$;

reset role;
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
