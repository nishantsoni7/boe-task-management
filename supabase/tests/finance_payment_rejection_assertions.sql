-- FINANCE PAYMENT DECISION assertions (20261211000000)
-- ===========================================================================
-- Proves, by EXECUTING the writes a PostgREST client can send, that a payment
-- decision belongs to a payment verifier:
--
--   * the person who recorded a payment cannot reject it, send it back, or
--     verify it — neither by a direct UPDATE nor through the rejection RPC —
--     and cannot INSERT one that is already decided;
--   * a finance.approve holder rejects through reject_finance_payment_request()
--     with a required reason, only while the payment is pending, and the
--     activity trail and the PI timeline record THAT verifier as the actor;
--   * a finance.approve holder cannot verify by a direct UPDATE — only through
--     approve_finance_payment_request();
--   * a finance.manage holder cannot un-verify a verified payment, but still
--     corrects one;
--   * everything that worked before still works: reapplication, the Finance
--     review dialog's direct reject / clarify for a verifier, verification,
--     payment entry, admin decisions.
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
  ('d0000000-0000-4000-8000-00000000000a', 'ASSERT decision admin',     'assert.decision.admin@verify.local',     'admin',  'management', true),
  ('d0000000-0000-4000-8000-000000000001', 'ASSERT decision submitter', 'assert.decision.submitter@verify.local', 'member', 'sales',      true),
  ('d0000000-0000-4000-8000-000000000003', 'ASSERT decision verifier',  'assert.decision.verifier@verify.local',  'member', 'operations', true),
  ('d0000000-0000-4000-8000-000000000004', 'ASSERT decision manager',   'assert.decision.manager@verify.local',   'member', 'operations', true),
  ('d0000000-0000-4000-8000-000000000005', 'ASSERT decision viewer',    'assert.decision.viewer@verify.local',    'member', 'operations', true);

-- Grants, never role inheritance. The submitter has Finance ENTRY — the
-- precondition of the defect — and nothing that decides a payment.
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
  ('d0000000-0000-4000-8000-000000000005'::uuid, 'finance', 'view_all')
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

-- A fresh payment by the submitter, in the requested status, written as the
-- migration owner (no JWT), exactly as a fixture should be.
create function pg_temp.payment(p_status text) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, proof_note, submitted_by)
  values (v_id, 'ASSERT', 1000, current_date, 'hdfc', 'UTR-ASSERT', 'd0000000-0000-4000-8000-000000000001');
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_id, (select v::uuid from assert_ctx where k = 'pi'), 1000, 'order_submission',
          'd0000000-0000-4000-8000-000000000001');
  if p_status = 'approved_unlinked' then
    update public.finance_payment_requests
       set status = 'approved_unlinked', approved_by = 'd0000000-0000-4000-8000-00000000000a', approved_at = now()
     where id = v_id;
  elsif p_status in ('rejected', 'needs_clarification') then
    update public.finance_payment_requests set status = p_status, admin_note = 'fixture' where id = v_id;
  end if;
  return v_id;
end $$;

-- Run one statement as p_user under RLS, the way PostgREST runs a request.
-- Returns 'ok <rows>' or the SQLSTATE it was refused with. The role and JWT
-- revert with the subtransaction either way.
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
    return sqlstate;
  end;
end $$;

-- ═══ 1. THE SUBMITTER CANNOT DECIDE THEIR OWN PAYMENT ═══════════════════════
do $$
declare
  s constant uuid := 'd0000000-0000-4000-8000-000000000001';
  v uuid;
  r public.finance_payment_requests%rowtype;
begin
  v := pg_temp.payment('pending_approval');

  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''self'', updated_at = now() where id = $1', v) = '42501',
    'the submitter must not reject their own payment by a direct update (the client write)';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''needs_clarification'', admin_note = ''self'' where id = $1', v) = '42501',
    'the submitter must not send their own payment back';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''approved_unlinked'' where id = $1', v) = '42501',
    'the submitter must not verify their own payment';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''approved_unlinked'', approved_by = auth.uid(), approved_at = now() where id = $1', v) = '42501',
    'the submitter must not verify and stamp themselves';
  assert pg_temp.try_as(s, 'select public.reject_finance_payment_request($1, ''self'')', v) = '42501',
    'the submitter must not reject through the RPC';
  assert pg_temp.try_as(s, 'select public.approve_finance_payment_request($1, null)', v) = '42501',
    'the submitter must not verify through the RPC';

  select * into r from public.finance_payment_requests where id = v;
  assert r.status = 'pending_approval' and r.admin_note is null and r.approved_by is null,
    'every refused decision must leave the payment exactly as it was';

  -- Still theirs to correct while pending: the edit path is unchanged.
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set proof_note = ''UTR-CORRECTED'' where id = $1', v) = 'ok 1',
    'the submitter must still be able to correct their own pending payment';

  -- A sent-back or rejected payment is reapplied, never decided, by its submitter.
  v := pg_temp.payment('rejected');
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''approved_unlinked'' where id = $1', v) = '42501',
    'the submitter must not verify their own rejected payment';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''needs_clarification'' where id = $1', v) = '42501',
    'the submitter must not move their rejected payment to needs_clarification';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''pending_approval'' where id = $1', v) = 'ok 1',
    'the submitter must still be able to reapply a rejected payment';

  v := pg_temp.payment('needs_clarification');
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''rejected'' where id = $1', v) = '42501',
    'the submitter must not reject a payment Finance sent back to them';
  assert pg_temp.try_as(s, 'update public.finance_payment_requests set status = ''pending_approval'' where id = $1', v) = 'ok 1',
    'the submitter must still be able to answer a clarification by reapplying';
end $$;

-- ═══ 2. NOBODY RECORDS A PAYMENT THAT IS ALREADY DECIDED ════════════════════
do $$
declare
  s constant uuid := 'd0000000-0000-4000-8000-000000000001';
begin
  assert pg_temp.try_as(s, 'insert into public.finance_payment_requests (client_name, amount, payment_date, payment_mode, submitted_by, status, approved_by, approved_at) values (''ASSERT'', 1, current_date, ''hdfc'', auth.uid(), ''approved_unlinked'', auth.uid(), now())', null) = '42501',
    'a payment must not be inserted already verified';
  assert pg_temp.try_as('d0000000-0000-4000-8000-000000000003', 'insert into public.finance_payment_requests (client_name, amount, payment_date, payment_mode, submitted_by, status, approved_by, approved_at) values (''ASSERT'', 1, current_date, ''hdfc'', auth.uid(), ''approved_unlinked'', auth.uid(), now())', null) = '42501',
    'not even by a verifier: verifying is the RPC';
  assert pg_temp.try_as(s, 'insert into public.finance_payment_requests (client_name, amount, payment_date, payment_mode, submitted_by, status, admin_note) values (''ASSERT'', 1, current_date, ''hdfc'', auth.uid(), ''rejected'', ''self'')', null) = '42501',
    'a payment must not be inserted already rejected';
  assert pg_temp.try_as(s, 'insert into public.finance_payment_requests (client_name, amount, payment_date, payment_mode, submitted_by) values (''ASSERT'', 1, current_date, ''hdfc'', auth.uid())', null) = 'ok 1',
    'a pending payment must still be recordable directly';
  assert pg_temp.try_as(s, 'select public.submit_payment_request(''suspense'', null, 1000, current_date, ''hdfc'', ''UTR-ENTRY'', null, ''[]''::jsonb)', null) = 'ok 1',
    'payment entry through submit_payment_request must still work';
end $$;

-- ═══ 3. THE VERIFIER REJECTS THROUGH THE RPC, AND IS RECORDED ═══════════════
do $$
declare
  f constant uuid := 'd0000000-0000-4000-8000-000000000003';
  v uuid;
  r public.finance_payment_requests%rowtype;
begin
  v := pg_temp.payment('pending_approval');

  assert pg_temp.try_as(f, 'select public.reject_finance_payment_request($1, ''   '')', v) = '22023',
    'a blank reason must be refused';
  assert (select status from public.finance_payment_requests where id = v) = 'pending_approval',
    'a refused rejection must not move the payment';

  assert pg_temp.try_as(f, 'select public.reject_finance_payment_request($1, ''  Duplicate of PAY-1  '')', v) = 'ok 1',
    'the verifier must be able to reject a pending payment';
  select * into r from public.finance_payment_requests where id = v;
  assert r.status = 'rejected', 'the payment must be rejected';
  assert r.admin_note = 'Duplicate of PAY-1', 'the reason must be stored, trimmed, in the same statement';
  assert r.rejected_at is not null, 'the rejection time must be stamped';
  assert r.amount = 1000 and r.proof_note = 'UTR-ASSERT' and r.approved_by is null,
    'rejection must change nothing but the decision';

  assert exists (
    select 1 from public.finance_payment_request_activity_log
    where payment_request_id = v and event_type = 'status_changed' and actor_id = f
      and payload->>'from_status' = 'pending_approval' and payload->>'to_status' = 'rejected'),
    'the Finance trail must record the verifier as the actor of the rejection';
  assert exists (
    select 1 from public.order_submission_activity
    where metadata->>'payment_id' = v::text and action = 'payment_rejected' and actor_id = f),
    'the PI timeline must record the verifier as the actor of the rejection';

  assert pg_temp.try_as(f, 'select public.reject_finance_payment_request($1, ''again'')', v) = 'P0001',
    'a rejected payment must not be rejected again';
  v := pg_temp.payment('approved_unlinked');
  assert pg_temp.try_as(f, 'select public.reject_finance_payment_request($1, ''too late'')', v) = 'P0001',
    'a verified payment must not be rejected through the RPC';

  -- The Finance review dialog's own direct write still works for a verifier.
  v := pg_temp.payment('pending_approval');
  assert pg_temp.try_as(f, 'update public.finance_payment_requests set status = ''needs_clarification'', admin_note = ''which account?'', updated_at = now() where id = $1', v) = 'ok 1',
    'the verifier must still be able to send a payment back from Finance';
  v := pg_temp.payment('pending_approval');
  assert pg_temp.try_as(f, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''declined'', updated_at = now() where id = $1', v) = 'ok 1',
    'the verifier must still be able to reject from Finance';

  -- Verifying is the approval RPC, never a direct status write.
  v := pg_temp.payment('pending_approval');
  assert pg_temp.try_as(f, 'update public.finance_payment_requests set status = ''approved_unlinked'' where id = $1', v) = '42501',
    'the verifier must not verify by a direct update';
  assert pg_temp.try_as(f, 'select public.approve_finance_payment_request($1, null)', v) = 'ok 1',
    'the verifier must still verify through the RPC';
  select * into r from public.finance_payment_requests where id = v;
  assert r.status = 'approved_unlinked' and r.approved_by = f, 'verification must stamp the verifier';
end $$;

-- ═══ 4. WIDE FINANCE ACCESS IS NOT DECISION AUTHORITY ═══════════════════════
do $$
declare
  m constant uuid := 'd0000000-0000-4000-8000-000000000004';
  w constant uuid := 'd0000000-0000-4000-8000-000000000005';
  v uuid;
begin
  v := pg_temp.payment('approved_unlinked');
  assert pg_temp.try_as(m, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''reversal'' where id = $1', v) = '42501',
    'the manager must not reject a verified payment';
  assert pg_temp.try_as(m, 'update public.finance_payment_requests set status = ''needs_clarification'' where id = $1', v) = '42501',
    'the manager must not send a verified payment back';
  assert pg_temp.try_as(m, 'update public.finance_payment_requests set proof_note = ''UTR-CORRECTED'' where id = $1', v) = 'ok 1',
    'the manager must still be able to correct a verified payment';
  assert (select status from public.finance_payment_requests where id = v) = 'approved_unlinked',
    'the verified payment must still be verified';

  v := pg_temp.payment('pending_approval');
  assert pg_temp.try_as(m, 'select public.reject_finance_payment_request($1, ''no'')', v) = '42501',
    'finance.manage must not reject';
  assert pg_temp.try_as(w, 'select public.reject_finance_payment_request($1, ''no'')', v) = '42501',
    'finance.view_all must not reject';
  assert (select status from public.finance_payment_requests where id = v) = 'pending_approval',
    'the payment must be untouched';
end $$;

-- ═══ 5. ADMIN, AND THE GRANTS ═══════════════════════════════════════════════
do $$
declare
  a constant uuid := 'd0000000-0000-4000-8000-00000000000a';
  v uuid;
begin
  v := pg_temp.payment('pending_approval');
  assert pg_temp.try_as(a, 'select public.reject_finance_payment_request($1, ''admin decision'')', v) = 'ok 1',
    'an admin must be able to reject through the RPC';
  v := pg_temp.payment('pending_approval');
  assert pg_temp.try_as(a, 'update public.finance_payment_requests set status = ''rejected'', admin_note = ''admin'' where id = $1', v) = 'ok 1',
    'an admin''s direct decision is unchanged';

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
