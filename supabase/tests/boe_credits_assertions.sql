-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261101000000_boe_credits_foundation.sql, executed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS. src/lib/boeCredits/migration.test.ts reads the SQL
-- text and checks that it SAYS the right things. That is worth having and it
-- is not enough: a policy can be present and wrong, a REVOKE can name a
-- signature that no longer exists, a CHECK can pass every row you thought of.
-- This file runs the migration's objects and proves the eight rules Phase 1A
-- promised, each refusal with its SQLSTATE and its marker — "it errored" is
-- compatible with a typo in the test.
--
--   §1  ledger math            +100 +100 −50 = 150, from the view, the
--                              function and a raw SUM
--   §2  zero and bad kinds     refused by the function AND by the table
--   §3  duplicate source       the same reward twice → one row, through the
--                              function and past it
--   §4  reversal               original untouched; one opposite row; no
--                              second reversal; no reversal of a reversal;
--                              no non-admin reversal
--   §5  admin adjustment       reason mandatory; actor must be an active
--                              admin; inactive/deleted/member/null refused
--   §6  employee isolation     E1 reads E1; E2's rows, balance and view row
--                              are invisible to E1; the admin reads everyone
--   §7  no self-award          insert/update/delete/execute all 42501 for an
--                              employee — and for an ADMIN'S browser session
--   §8  immutability           update/delete refused for the service role too
--   §9  settings               defaults (100, 1.00); readable by an employee;
--                              writable from no client; newest row wins
--   §10 sign, balance, target  wrong sign, overdraft, missing/deleted employee
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded. It creates its own four fictional employees and refuses to run
-- if public.users already holds anybody.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through run_boe_credits_local.sh,
--   which builds a disposable database and applies the migration first.
--
-- Every guard under test reads auth.uid(), so the script simulates a session
-- with request.jwt.claims and SET ROLE rather than a real login — the same
-- idiom the Review Workflow and Assets assertion scripts use. The service role
-- is simulated by RESET ROLE (the superuser that owns the tables), which like
-- service_role bypasses RLS and holds EXECUTE on the posting functions.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ─── helpers ─────────────────────────────────────────────────────────────────

-- Become one signed-in employee, the way PostgREST would present them.
create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

-- Back to the owner: no claims, no role. auth.uid() is null here, as it is
-- for a service-role call.
create or replace function pg_temp.act_as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end $$;

-- Run a statement and REQUIRE it to fail with an exact SQLSTATE and a marker
-- in its message. Modelled on pg_temp.must_refuse in
-- review_workflow_twelve_and_images_assertions.sql.
create or replace function pg_temp.must_refuse(
  p_sql text, p_sqlstate text, p_marker text, p_label text
)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception '% — refused, but with SQLSTATE % not %: %', p_label, v_state, p_sqlstate, v_msg;
    end if;
    if position(p_marker in v_msg) = 0 then
      raise exception '% — refused, but not with %: %', p_label, p_marker, v_msg;
    end if;
    raise notice 'PASS  % (% %)', p_label, v_state, p_marker;
    return;
  end;
  raise exception '% — WAS ALLOWED, and must not be', p_label;
end $$;

-- ─── fixtures ────────────────────────────────────────────────────────────────

do $$
begin
  if (select count(*) from public.users) <> 0 then
    raise exception 'REFUSING TO RUN: public.users is not empty — this is not a disposable database';
  end if;
end $$;

-- Four fictional people. The ids are fixed so the sections below can name them.
insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',       'admin@example.test',  'admin',  'management', true,  false, 'T-ADM'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Test Employee One','one@example.test',    'member', 'sales',      true,  false, 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Test Employee Two','two@example.test',    'member', 'sales',      true,  false, 'T-002'),
  ('a1000000-0000-4000-8000-00000000001a', 'Test Ex-Admin',    'ex@example.test',     'admin',  'management', false, false, 'T-EXA'),
  ('d0000000-0000-4000-8000-00000000000d', 'Test Deleted',     'gone@example.test',   'member', 'sales',      false, true,  'T-DEL');

insert into public.payroll_periods (id, payroll_month, payroll_year)
values ('91000000-0000-4000-8000-000000000091', 8, 2026);

-- ═══ §0. The migration is applied ═══════════════════════════════════════════

do $$
begin
  assert to_regclass('public.boe_credit_transactions') is not null,
    '20261101000000 is NOT applied: boe_credit_transactions missing';
  assert to_regclass('public.boe_credit_settings') is not null,
    '20261101000000 is NOT applied: boe_credit_settings missing';
  assert to_regclass('public.boe_credit_balances') is not null,
    '20261101000000 is NOT applied: boe_credit_balances missing';
  assert to_regprocedure('public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)') is not null,
    '20261101000000 is NOT applied: post_boe_credit_transaction missing';
  raise notice 'PASS  §0 migration applied';
end $$;

-- ═══ §1. Ledger math: +100 +100 −50 = 150 ═══════════════════════════════════

select pg_temp.act_as_service();

do $$
declare
  v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_r1 uuid := 'c1000000-0000-4000-8000-0000000000c1';
  v_r2 uuid := 'c2000000-0000-4000-8000-0000000000c2';
  v_p  uuid := '91000000-0000-4000-8000-000000000091';
  v_id uuid;
  v_n  integer;
begin
  v_id := public.post_boe_credit_transaction(v_e1, 'review_reward', 100, 'customer_review', v_r1, null, null);
  assert v_id is not null, '§1 first reward returned no id';
  perform public.post_boe_credit_transaction(v_e1, 'review_reward', 100, 'customer_review', v_r2, 'second review', null);
  perform public.post_boe_credit_transaction(v_e1, 'redemption', -50, 'payroll_period', v_p, 'August payroll', null, v_p);

  select coalesce(sum(credits), 0) into v_n from public.boe_credit_transactions where employee_id = v_e1;
  assert v_n = 150, format('§1 raw SUM is %s, expected 150', v_n);

  select available_credits into v_n from public.boe_credit_balances where employee_id = v_e1;
  assert v_n = 150, format('§1 view says %s, expected 150', v_n);

  assert public.boe_credit_balance(v_e1) = 150, '§1 boe_credit_balance() disagrees with the view';

  select transaction_count into v_n from public.boe_credit_balances where employee_id = v_e1;
  assert v_n = 3, format('§1 view counts %s rows, expected 3', v_n);

  -- created_by null = the system; the redemption carries its payroll period
  assert (select created_by from public.boe_credit_transactions where source_id = v_r1) is null,
    '§1 a system-posted reward must have null created_by';
  assert (select payroll_period_id from public.boe_credit_transactions where transaction_type = 'redemption') = v_p,
    '§1 the redemption did not keep its payroll period';

  raise notice 'PASS  §1 ledger math: +100 +100 -50 = 150 (raw SUM, view, function agree)';
end $$;

-- ═══ §2. Zero and unknown kinds are refused — by the function and the table ═

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'review_reward', 0, 'customer_review', gen_random_uuid(), null, null) $q$,
  '22023', 'BOE_CREDITS_ZERO', '§2 zero credits through the function');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id)
      values ('e1000000-0000-4000-8000-0000000000e1', 'review_reward', 0, 'customer_review', gen_random_uuid()) $q$,
  '23514', 'credits', '§2 zero credits past the function — the CHECK');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'bonus', 10, 'customer_review', gen_random_uuid(), null, null) $q$,
  '22023', 'BOE_CREDITS_TYPE', '§2 unknown kind through the function');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id)
      values ('e1000000-0000-4000-8000-0000000000e1', 'bonus', 10, 'customer_review', gen_random_uuid()) $q$,
  '23514', 'transaction_type', '§2 unknown kind past the function — the CHECK');

-- ═══ §3. Duplicate source: the same reward twice is one row ═════════════════

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'review_reward', 100, 'customer_review', 'c1000000-0000-4000-8000-0000000000c1', null, null) $q$,
  '23505', 'BOE_CREDITS_DUPLICATE_SOURCE', '§3 the same review rewarded again, through the function');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id)
      values ('e1000000-0000-4000-8000-0000000000e1', 'review_reward', 100, 'customer_review', 'c1000000-0000-4000-8000-0000000000c1') $q$,
  '23505', 'boe_credit_transactions_one_per_source_idx', '§3 the same review rewarded again, past the function — the index');

do $$
declare v_n integer;
begin
  select count(*) into v_n from public.boe_credit_transactions
   where source_type = 'customer_review' and source_id = 'c1000000-0000-4000-8000-0000000000c1';
  assert v_n = 1, format('§3 review c1 has %s reward rows, expected exactly 1', v_n);
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 150, '§3 balance moved on a refused duplicate';
  raise notice 'PASS  §3 one source, one reward — balance still 150';
end $$;

-- ═══ §4. Reversal: original untouched, one opposite row ═════════════════════

do $$
declare
  v_e1     uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_admin  uuid := 'a0000000-0000-4000-8000-00000000000a';
  v_orig   public.boe_credit_transactions%rowtype;
  v_before jsonb;
  v_after  jsonb;
  v_rev_id uuid;
  v_rev    public.boe_credit_transactions%rowtype;
  v_n      integer;
begin
  select * into v_orig from public.boe_credit_transactions
   where source_type = 'customer_review' and source_id = 'c1000000-0000-4000-8000-0000000000c1';
  v_before := to_jsonb(v_orig);

  v_rev_id := public.reverse_boe_credit_transaction(v_orig.id, v_admin, 'Posted against the wrong review');

  select to_jsonb(t) into v_after from public.boe_credit_transactions t where t.id = v_orig.id;
  assert v_after = v_before, '§4 the ORIGINAL row changed — a reversal must never touch it';

  select * into v_rev from public.boe_credit_transactions where id = v_rev_id;
  assert v_rev.transaction_type = 'reversal',               '§4 the new row is not a reversal';
  assert v_rev.credits = -v_orig.credits,                   '§4 the reversal does not negate the original';
  assert v_rev.employee_id = v_orig.employee_id,            '§4 the reversal is on a different employee';
  assert v_rev.source_type = 'boe_credit_transaction',      '§4 the reversal does not name its source kind';
  assert v_rev.source_id = v_orig.id,                       '§4 the reversal does not name the original';
  assert v_rev.created_by = v_admin,                        '§4 the reversal does not record the admin who posted it';
  assert v_rev.description = 'Posted against the wrong review', '§4 the reason was not kept';

  select count(*) into v_n from public.boe_credit_transactions where employee_id = v_e1;
  assert v_n = 4, format('§4 expected 4 rows (3 + the reversal), found %s', v_n);
  assert public.boe_credit_balance(v_e1) = 50, format('§4 balance after reversal is %s, expected 50', public.boe_credit_balance(v_e1));

  raise notice 'PASS  §4 reversal: original intact, one opposite row, balance 150 -> 50';
end $$;

select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(
        (select id from public.boe_credit_transactions where source_id = 'c1000000-0000-4000-8000-0000000000c1' and transaction_type = 'review_reward'),
        'a0000000-0000-4000-8000-00000000000a', 'again') $q$,
  '23505', 'BOE_CREDITS_DUPLICATE_SOURCE', '§4 a second reversal of the same row');

select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(
        (select id from public.boe_credit_transactions where transaction_type = 'reversal' limit 1),
        'a0000000-0000-4000-8000-00000000000a', 'undo the undo') $q$,
  '55000', 'BOE_CREDITS_REVERSAL', '§4 reversing a reversal');

select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(
        (select id from public.boe_credit_transactions where source_id = 'c2000000-0000-4000-8000-0000000000c2'),
        'e1000000-0000-4000-8000-0000000000e1', 'I changed my mind') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§4 a reversal by a non-admin actor');

select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(
        (select id from public.boe_credit_transactions where source_id = 'c2000000-0000-4000-8000-0000000000c2'),
        'a0000000-0000-4000-8000-00000000000a', '   ') $q$,
  '22023', 'BOE_CREDITS_REASON', '§4 a reversal without a reason');

select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a', 'x') $q$,
  'P0002', 'BOE_CREDITS_REVERSAL', '§4 reversing a row that does not exist');

-- ═══ §5. Admin adjustment: reason mandatory, actor an active admin ══════════

do $$
declare
  v_e1    uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  v_id    uuid;
  v_row   public.boe_credit_transactions%rowtype;
begin
  v_id := public.post_boe_credit_transaction(v_e1, 'admin_adjustment', 25, 'manual', null, '  Missed August reward  ', v_admin);
  select * into v_row from public.boe_credit_transactions where id = v_id;
  assert v_row.credits = 25 and v_row.source_type = 'manual' and v_row.source_id is null, '§5 adjustment row has the wrong shape';
  assert v_row.description = 'Missed August reward', '§5 the reason was not trimmed and kept';
  assert v_row.created_by = v_admin, '§5 the actor was not recorded';
  assert v_row.created_at is not null, '§5 no timestamp';
  assert public.boe_credit_balance(v_e1) = 75, '§5 balance after +25 is not 75';

  -- a negative correction is the same shape
  perform public.post_boe_credit_transaction(v_e1, 'admin_adjustment', -5, 'manual', null, 'Rounding', v_admin);
  assert public.boe_credit_balance(v_e1) = 70, '§5 balance after -5 is not 70';

  -- a second manual entry is allowed: no source id, so the uniqueness rule does not apply
  perform public.post_boe_credit_transaction(v_e1, 'admin_adjustment', 5, 'manual', null, 'Rounding, corrected', v_admin);
  assert public.boe_credit_balance(v_e1) = 75, '§5 balance after the third adjustment is not 75';

  raise notice 'PASS  §5 admin adjustment: +25 -5 +5 with reasons and actor, balance 75';
end $$;

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'manual', null, '', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '22023', 'BOE_CREDITS_REASON', '§5 an adjustment without a reason');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id, description, created_by)
      values ('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'manual', null, null, 'a0000000-0000-4000-8000-00000000000a') $q$,
  '23514', 'boe_credit_transactions_shape_check', '§5 an adjustment without a reason, past the function — the CHECK');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'manual', null, 'reason', 'e2000000-0000-4000-8000-0000000000e2') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§5 an adjustment by a member');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'manual', null, 'reason', 'a1000000-0000-4000-8000-00000000001a') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§5 an adjustment by a DEACTIVATED admin');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'manual', null, 'reason', null) $q$,
  '42501', 'BOE_CREDITS_DENIED', '§5 an adjustment with no actor at all');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'manual', null, 'reason', gen_random_uuid()) $q$,
  'P0002', 'BOE_CREDITS_ACTOR', '§5 an adjustment by an actor who does not exist');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'customer_review', gen_random_uuid(), 'reason', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '22023', 'BOE_CREDITS_SOURCE', '§5 an adjustment that smuggles a source');

-- ═══ §6. Employee isolation ═════════════════════════════════════════════════

-- Give E2 a ledger of their own first, as the service.
select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'review_reward', 100, 'customer_review', 'c3000000-0000-4000-8000-0000000000c3', null, null);
select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'admin_adjustment', 40, 'manual', null, 'Welcome credits', 'a0000000-0000-4000-8000-00000000000a');

select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');

do $$
declare v_n integer; v_other integer;
begin
  assert auth.uid() = 'e1000000-0000-4000-8000-0000000000e1', '§6 the session is not E1';
  assert current_user = 'authenticated', '§6 the role is not authenticated';

  select count(*) into v_n from public.boe_credit_transactions;
  assert v_n = 7, format('§6 E1 sees %s rows, expected their own 7', v_n);
  select count(*) into v_other from public.boe_credit_transactions where employee_id <> auth.uid();
  assert v_other = 0, format('§6 E1 can see %s of somebody else''s rows', v_other);

  select count(*) into v_n from public.boe_credit_balances;
  assert v_n = 1, format('§6 E1 sees %s balance rows, expected 1', v_n);
  assert (select available_credits from public.boe_credit_balances) = 75, '§6 E1''s own balance is wrong';

  assert public.boe_credit_balance('e2000000-0000-4000-8000-0000000000e2') = 0,
    '§6 boe_credit_balance() leaked E2''s balance to E1';
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 75,
    '§6 boe_credit_balance() is wrong for E1''s own id';

  assert public.can_manage_boe_credits() = false, '§6 a member is not management';

  raise notice 'PASS  §6 E1 reads exactly their own 7 rows and 1 balance; E2 is invisible';
end $$;

select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');

do $$
declare v_n integer;
begin
  assert public.can_manage_boe_credits() = true, '§6 the admin is not management';
  select count(*) into v_n from public.boe_credit_transactions;
  assert v_n = 9, format('§6 the admin sees %s rows, expected all 9', v_n);
  select count(*) into v_n from public.boe_credit_balances;
  assert v_n = 2, format('§6 the admin sees %s balance rows, expected 2', v_n);
  assert public.boe_credit_balance('e2000000-0000-4000-8000-0000000000e2') = 140, '§6 the admin reads E2''s balance wrong';
  raise notice 'PASS  §6 the admin reads everyone: 9 rows, 2 balances';
end $$;

select pg_temp.act_as('a1000000-0000-4000-8000-00000000001a');

do $$
declare v_n integer;
begin
  assert public.can_manage_boe_credits() = false, '§6 a DEACTIVATED admin still counts as management';
  select count(*) into v_n from public.boe_credit_transactions;
  assert v_n = 0, format('§6 a deactivated admin sees %s rows, expected 0', v_n);
  raise notice 'PASS  §6 a deactivated admin sees nothing';
end $$;

select pg_temp.act_as_anon();

select pg_temp.must_refuse(
  $q$ select count(*) from public.boe_credit_transactions $q$,
  '42501', 'permission denied', '§6 anon cannot read the ledger');
select pg_temp.must_refuse(
  $q$ select count(*) from public.boe_credit_balances $q$,
  '42501', 'permission denied', '§6 anon cannot read the balances');
select pg_temp.must_refuse(
  $q$ select count(*) from public.boe_credit_settings $q$,
  '42501', 'permission denied', '§6 anon cannot read the settings');

-- ═══ §7. No self-award — and no browser write at all, admin included ════════

select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id)
      values (auth.uid(), 'review_reward', 1000, 'customer_review', gen_random_uuid()) $q$,
  '42501', 'permission denied', '§7 an employee inserting their own reward');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, description)
      values (auth.uid(), 'admin_adjustment', 1000, 'manual', 'me') $q$,
  '42501', 'permission denied', '§7 an employee inserting their own adjustment');

select pg_temp.must_refuse(
  $q$ update public.boe_credit_transactions set credits = 1000 $q$,
  '42501', 'permission denied', '§7 an employee editing an amount');

select pg_temp.must_refuse(
  $q$ delete from public.boe_credit_transactions $q$,
  '42501', 'permission denied', '§7 an employee deleting history');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction(auth.uid(), 'review_reward', 1000, 'customer_review', gen_random_uuid(), null, null) $q$,
  '42501', 'permission denied', '§7 an employee calling the posting function');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction(auth.uid(), 'admin_adjustment', 1000, 'manual', null, 'me', auth.uid()) $q$,
  '42501', 'permission denied', '§7 an employee calling the posting function as an adjustment');

select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction((select id from public.boe_credit_transactions where transaction_type = 'redemption'), auth.uid(), 'give it back') $q$,
  '42501', 'permission denied', '§7 an employee reversing their own redemption');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_settings (review_reward_credits, credit_value) values (100000, 1000) $q$,
  '42501', 'permission denied', '§7 an employee changing the settings');

-- The same is true of an ADMIN'S browser session: management authority does
-- not include a client-side write. The route on the service role is the door.
select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, description, created_by)
      values ('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'manual', 'from the browser', auth.uid()) $q$,
  '42501', 'permission denied', '§7 an admin inserting from a browser session');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 10, 'manual', null, 'from the browser', auth.uid()) $q$,
  '42501', 'permission denied', '§7 an admin calling the posting function from a browser session');

select pg_temp.must_refuse(
  $q$ update public.boe_credit_transactions set description = 'edited' $q$,
  '42501', 'permission denied', '§7 an admin editing history from a browser session');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_settings (review_reward_credits, credit_value, created_by) values (150, 1, auth.uid()) $q$,
  '42501', 'permission denied', '§7 an admin writing settings from a browser session');

-- ═══ §8. Immutability holds for the service role too ════════════════════════

select pg_temp.act_as_service();

select pg_temp.must_refuse(
  $q$ update public.boe_credit_transactions set credits = credits + 1 where transaction_type = 'review_reward' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§8 the service role editing an amount');

select pg_temp.must_refuse(
  $q$ update public.boe_credit_transactions set source_id = gen_random_uuid() where transaction_type = 'review_reward' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§8 the service role rewriting a source');

select pg_temp.must_refuse(
  $q$ delete from public.boe_credit_transactions where transaction_type = 'reversal' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§8 the service role deleting a row');

select pg_temp.must_refuse(
  $q$ update public.boe_credit_settings set credit_value = 99 $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§8 the service role editing a settings row');

select pg_temp.must_refuse(
  $q$ delete from public.boe_credit_settings $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§8 the service role deleting a settings row');

-- ═══ §9. Settings: defaults, readable, client-unwritable, newest wins ═══════

do $$
declare v_reward integer; v_value numeric; v_n integer;
begin
  select count(*) into v_n from public.boe_credit_settings;
  assert v_n = 1, format('§9 expected exactly 1 seeded settings row, found %s', v_n);
  select review_reward_credits, credit_value into v_reward, v_value
    from public.boe_credit_settings order by created_at desc limit 1;
  assert v_reward = 100, format('§9 review_reward_credits is %s, expected 100', v_reward);
  assert v_value = 1.00, format('§9 credit_value is %s, expected 1.00', v_value);
  raise notice 'PASS  §9 defaults: review reward 100, credit value 1.00';
end $$;

select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');

do $$
declare v_n integer;
begin
  select count(*) into v_n from public.boe_credit_settings;
  assert v_n = 1, '§9 an employee cannot read the settings they will be shown';
  raise notice 'PASS  §9 an employee can read the settings';
end $$;

select pg_temp.act_as('d0000000-0000-4000-8000-00000000000d');

do $$
declare v_n integer;
begin
  select count(*) into v_n from public.boe_credit_settings;
  assert v_n = 0, '§9 a deleted user can still read the settings';
  raise notice 'PASS  §9 a deleted user reads nothing';
end $$;

select pg_temp.act_as_service();

do $$
declare v_reward integer; v_value numeric;
begin
  -- A save is a NEW row (what the admin route does on the service role).
  insert into public.boe_credit_settings (review_reward_credits, credit_value, created_by, note)
  values (150, 2.50, 'a0000000-0000-4000-8000-00000000000a', 'Raised for the season');
  select review_reward_credits, credit_value into v_reward, v_value
    from public.boe_credit_settings order by created_at desc limit 1;
  assert v_reward = 150 and v_value = 2.50, '§9 the newest row is not the active one';
  assert (select count(*) from public.boe_credit_settings) = 2, '§9 the earlier row was lost';
  raise notice 'PASS  §9 a new settings row becomes active; the history is kept';
end $$;

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_settings (review_reward_credits, credit_value) values (0, 1) $q$,
  '23514', 'review_reward_credits', '§9 a zero reward is refused by the CHECK');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_settings (review_reward_credits, credit_value) values (100, -1) $q$,
  '23514', 'credit_value', '§9 a negative credit value is refused by the CHECK');

-- ═══ §10. Sign, overdraft, and a target that does not exist ═════════════════

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'review_reward', -5, 'customer_review', gen_random_uuid(), null, null) $q$,
  '22023', 'BOE_CREDITS_SIGN', '§10 a negative review reward');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'redemption', 5, 'payroll_period', gen_random_uuid(), null, null) $q$,
  '22023', 'BOE_CREDITS_SIGN', '§10 a positive redemption');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'redemption', -1000, 'payroll_period', gen_random_uuid(), null, null) $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§10 a redemption larger than the balance');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'review_reward', 10, 'manual', null, null, null) $q$,
  '22023', 'BOE_CREDITS_SOURCE', '§10 a reward with no source');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction(gen_random_uuid(), 'review_reward', 10, 'customer_review', gen_random_uuid(), null, null) $q$,
  'P0002', 'BOE_CREDITS_EMPLOYEE', '§10 a reward for somebody who does not exist');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('d0000000-0000-4000-8000-00000000000d', 'review_reward', 10, 'customer_review', gen_random_uuid(), null, null) $q$,
  'P0002', 'BOE_CREDITS_EMPLOYEE', '§10 a reward for a deleted employee');

do $$
begin
  -- A redemption that exactly empties the balance is allowed: 75 - 75 = 0.
  perform public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'redemption', -75, 'payroll_period', gen_random_uuid(), 'spend it all', null);
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 0, '§10 emptying the balance did not reach 0';
  raise notice 'PASS  §10 sign rules, overdraft refused, exact spend-down allowed';
end $$;

-- ═══ §11. Negative balance: a reversal may go below zero; a redemption never ═
--
-- The two halves of one rule. An employee cannot SPEND more than they have,
-- and a negative balance stops them spending until it is positive again. But
-- history is never rewritten: if a reward is invalidated after its credits
-- were already spent, the reversal must still be posted, and the balance it
-- produces is negative. E2 has 100 (reward c3) + 40 (adjustment) = 140.

do $$
declare
  v_e2    uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_admin uuid := 'a0000000-0000-4000-8000-00000000000a';
  v_r3    uuid;
begin
  assert public.boe_credit_balance(v_e2) = 140, '§11 E2 does not start at 140';

  -- spend everything
  perform public.post_boe_credit_transaction(v_e2, 'redemption', -140, 'payroll_period', gen_random_uuid(), 'September payroll', null);
  assert public.boe_credit_balance(v_e2) = 0, '§11 E2 did not reach 0';

  -- the reward is later invalidated: the reversal is posted, and the balance goes negative
  select id into v_r3 from public.boe_credit_transactions
   where employee_id = v_e2 and transaction_type = 'review_reward';
  perform public.reverse_boe_credit_transaction(v_r3, v_admin, 'Review found to be invalid');
  assert public.boe_credit_balance(v_e2) = -100,
    format('§11 balance after reversing a spent reward is %s, expected -100', public.boe_credit_balance(v_e2));
  assert (select available_credits from public.boe_credit_balances where employee_id = v_e2) = -100,
    '§11 the view does not show the negative balance';

  raise notice 'PASS  §11 reversal of an already-spent reward: 140 -> 0 -> -100, recorded, nothing rewritten';
end $$;

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'redemption', -1, 'payroll_period', gen_random_uuid(), null, null) $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§11 a redemption while the balance is negative');

do $$
declare v_e2 uuid := 'e2000000-0000-4000-8000-0000000000e2';
begin
  -- an administrator brings the balance back to exactly zero: still nothing to spend
  perform public.post_boe_credit_transaction(v_e2, 'admin_adjustment', 100, 'manual', null, 'Goodwill after the invalid review', 'a0000000-0000-4000-8000-00000000000a');
  assert public.boe_credit_balance(v_e2) = 0, '§11 balance after +100 adjustment is not 0';
end $$;

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'redemption', -1, 'payroll_period', gen_random_uuid(), null, null) $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§11 a redemption at exactly zero');

do $$
declare v_e2 uuid := 'e2000000-0000-4000-8000-0000000000e2';
begin
  -- once positive again, spending resumes, down to zero and no further
  perform public.post_boe_credit_transaction(v_e2, 'review_reward', 100, 'customer_review', gen_random_uuid(), null, null);
  perform public.post_boe_credit_transaction(v_e2, 'redemption', -100, 'payroll_period', gen_random_uuid(), null, null);
  assert public.boe_credit_balance(v_e2) = 0, '§11 spend-down after recovery did not reach 0';
  raise notice 'PASS  §11 negative balance blocks redemption until positive; then spending resumes to exactly zero';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
