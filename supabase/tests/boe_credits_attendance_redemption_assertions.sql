-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261103000000_boe_credits_attendance_redemption.sql,
-- executed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- src/lib/boeCredits/attendanceRedemption.test.ts reads the SQL text. This
-- runs it, and proves what the database itself guarantees about Phase 1C —
-- each refusal with its SQLSTATE and its marker.
--
--   §1  half day costs 1       ledger row: −1, type 'redemption', source
--                              'attendance_redemption', source_id = the
--                              record id, description, period; the record
--   §2  absent costs 2         −2; balance reaches 0
--   §3  insufficient balance   refused; no record, no ledger row
--   §4  duplicate ACTIVE       the same day again → refused by the function;
--                              a raw ledger post naming the same record →
--                              refused by post_boe_credit_transaction; a raw
--                              record insert for an active day → refused by
--                              the partial unique index
--   §5  another employee       actor ≠ employee and not an admin → 42501;
--                              an admin MAY act for the employee (re-pricing)
--                              and is recorded as the actor; an employee's
--                              browser session cannot execute at all
--   §6  locked period          redemption AND reversal refused; admitted
--                              again after the existing unlock
--   §7  not generated / date   no payroll_results row; date outside the
--                              month; future date; unknown kind; unknown
--                              period; unknown redemption
--   §8  history and isolation  balance = SUM; view; own rows only; the
--                              admin reads all; anon nothing
--   §9  immutability           UPDATE of any field / DELETE / hand-closing
--                              with a foreign reversal — all refused, for
--                              the service role too
--   §10 attendance intact      the function reads no attendance table and
--                              only READS payroll_results
--   §11 reversal               through the function: balance restored, the
--                              record closed with its reversal id and
--                              instant, the redemption row untouched; a
--                              second reversal refused; the ledger trigger
--                              closes a record reversed DIRECTLY too
--   §12 re-redeem              after a reversal the same day can be covered
--                              again — a new record, a new ledger row — and
--                              at no moment are two coverages active
--   §13 foundation untouched   the ledger's CHECK still names exactly the
--                              four kinds (the runner diffs the function
--                              definitions themselves)
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so it can be
-- run any number of times. It creates its own fictional employees and refuses
-- to run if public.users holds anybody.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through
--   run_boe_credits_attendance_redemption_local.sh.

\set ON_ERROR_STOP on

begin;

-- ─── helpers (the same idiom as boe_credits_assertions.sql) ─────────────────

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

create or replace function pg_temp.act_as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end $$;

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

-- Active coverage, exactly as src/lib/payroll/store.ts reads it.
create or replace function pg_temp.active_count(p_employee uuid, p_date date)
returns integer language sql as $$
  select count(*)::integer from public.boe_credit_attendance_redemptions
   where employee_id = p_employee and attendance_date = p_date and reversal_transaction_id is null
$$;

-- ─── fixtures ────────────────────────────────────────────────────────────────

do $$
begin
  if (select count(*) from public.users) <> 0 then
    raise exception 'REFUSING TO RUN: public.users is not empty — this is not a disposable database';
  end if;
end $$;

insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',        'admin@example.test', 'admin',  'management', true, false, 'T-ADM'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Test Employee One', 'one@example.test',   'member', 'sales',      true, false, 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Test Employee Two', 'two@example.test',   'member', 'sales',      true, false, 'T-002');

insert into public.payroll_periods (id, payroll_month, payroll_year, status) values
  ('91000000-0000-4000-8000-000000000091', 8,  2026, 'generated'),
  ('92000000-0000-4000-8000-000000000092', 12, 2099, 'generated');

insert into public.payroll_results (payroll_period_id, employee_id, monthly_salary) values
  ('91000000-0000-4000-8000-000000000091', 'e1000000-0000-4000-8000-0000000000e1', 20000),
  ('92000000-0000-4000-8000-000000000092', 'e1000000-0000-4000-8000-0000000000e1', 20000);

select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 3,  'manual', null, 'Fixture: three credits', 'a0000000-0000-4000-8000-00000000000a');
select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'admin_adjustment', 10, 'manual', null, 'Fixture: ten credits',   'a0000000-0000-4000-8000-00000000000a');

-- ═══ §0. Applied ═════════════════════════════════════════════════════════════

do $$
begin
  assert to_regclass('public.boe_credit_attendance_redemptions') is not null, '20261103000000 is NOT applied';
  assert to_regprocedure('public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)') is not null, 'redeem function missing';
  assert to_regprocedure('public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)') is not null, 'reverse function missing';
  raise notice 'PASS  §0 migration applied';
end $$;

-- ═══ §1. A half day costs 1 credit ══════════════════════════════════════════

do $$
declare
  v_e1  uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_p   uuid := '91000000-0000-4000-8000-000000000091';
  v_out jsonb;
  v_tx  public.boe_credit_transactions%rowtype;
  v_rec public.boe_credit_attendance_redemptions%rowtype;
begin
  v_out := public.redeem_boe_credits_for_attendance(v_e1, v_p, date '2026-08-12', 'half_day', v_e1);

  assert (v_out->>'credits')::integer = 1, format('§1 credits %s, expected 1', v_out->>'credits');
  assert (v_out->>'available_credits')::integer = 2, format('§1 balance %s, expected 2', v_out->>'available_credits');
  assert public.boe_credit_balance(v_e1) = 2, '§1 the derived balance is not 2';

  select * into v_tx from public.boe_credit_transactions where id = (v_out->>'transaction_id')::uuid;
  assert v_tx.transaction_type = 'redemption', '§1 ledger row is not type redemption';
  assert v_tx.credits = -1, format('§1 ledger credits %s, expected -1', v_tx.credits);
  assert v_tx.source_type = 'attendance_redemption', format('§1 ledger source_type is %s', v_tx.source_type);
  assert v_tx.source_id = (v_out->>'redemption_id')::uuid, '§1 ledger source_id is not the record id';
  assert v_tx.payroll_period_id = v_p, '§1 ledger payroll_period_id';
  assert v_tx.created_by = v_e1, '§1 ledger actor is the employee';
  assert v_tx.description = 'Attendance redemption · 12 Aug 2026 · Half Day', format('§1 description is %L', v_tx.description);

  select * into v_rec from public.boe_credit_attendance_redemptions where id = (v_out->>'redemption_id')::uuid;
  assert found, '§1 no redemption record';
  assert v_rec.employee_id = v_e1 and v_rec.attendance_date = date '2026-08-12', '§1 record identity';
  assert v_rec.transaction_id = v_tx.id, '§1 record does not name its ledger row';
  assert v_rec.deduction_type = 'half_day' and v_rec.credits = 1, '§1 record kind/credits';
  assert v_rec.payroll_period_id = v_p and v_rec.created_by = v_e1, '§1 record period/actor';
  assert v_rec.reversal_transaction_id is null and v_rec.reversed_at is null, '§1 a new record is active';
  assert pg_temp.active_count(v_e1, date '2026-08-12') = 1, '§1 active count';

  raise notice 'PASS  §1 half day: -1 credit, redemption / attendance_redemption, record active';
end $$;

-- ═══ §2. An absent day costs 2 credits ══════════════════════════════════════

do $$
declare
  v_e1  uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_out jsonb;
begin
  v_out := public.redeem_boe_credits_for_attendance(v_e1, '91000000-0000-4000-8000-000000000091', date '2026-08-13', 'absent', v_e1);
  assert (v_out->>'credits')::integer = 2, '§2 credits';
  assert public.boe_credit_balance(v_e1) = 0, format('§2 balance %s, expected 0', public.boe_credit_balance(v_e1));
  assert (select credits from public.boe_credit_transactions where id = (v_out->>'transaction_id')::uuid) = -2, '§2 ledger credits';
  assert (select description from public.boe_credit_transactions where id = (v_out->>'transaction_id')::uuid)
       = 'Attendance redemption · 13 Aug 2026 · Absent', '§2 description';
  raise notice 'PASS  §2 absent: -2 credits, balance 0';
end $$;

-- ═══ §3. Insufficient balance ═══════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-14', 'half_day', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§3 a half day with 0 credits');

do $$
begin
  assert not exists (select 1 from public.boe_credit_attendance_redemptions where attendance_date = date '2026-08-14'), '§3 a refused redemption left a record';
  assert (select count(*) from public.boe_credit_transactions where employee_id = 'e1000000-0000-4000-8000-0000000000e1' and transaction_type = 'redemption') = 2, '§3 a refused redemption left a ledger row';
  raise notice 'PASS  §3 nothing written on refusal';
end $$;

select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 5, 'manual', null, 'Fixture: five more', 'a0000000-0000-4000-8000-00000000000a');

-- ═══ §4. Duplicate ACTIVE coverage — three layers ═══════════════════════════

select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-12', 'half_day', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '23505', 'BOE_CREDITS_ALREADY_COVERED', '§4 the same day again, through the function');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'redemption', -1, 'attendance_redemption',
        (select id from public.boe_credit_attendance_redemptions where attendance_date = date '2026-08-12'), null, 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '23505', 'BOE_CREDITS_DUPLICATE_SOURCE', '§4 a raw ledger post naming the same record');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_attendance_redemptions (employee_id, attendance_date, deduction_type, credits, transaction_id, payroll_period_id)
      select 'e1000000-0000-4000-8000-0000000000e1', date '2026-08-12', 'half_day', 1, t.id, '91000000-0000-4000-8000-000000000091'
        from public.boe_credit_transactions t where t.employee_id = 'e2000000-0000-4000-8000-0000000000e2' limit 1 $q$,
  '23505', 'boe_credit_attendance_redemptions_active_unique', '§4 a raw record insert for an active day');

do $$
begin
  assert (select count(*) from public.boe_credit_attendance_redemptions where employee_id = 'e1000000-0000-4000-8000-0000000000e1') = 2, '§4 record count changed';
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 5, '§4 balance changed';
  raise notice 'PASS  §4 one active coverage per day at every layer';
end $$;

-- ═══ §5. Another employee; an admin on the employee's behalf ════════════════

select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-18', 'half_day', 'e2000000-0000-4000-8000-0000000000e2') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§5 E2 redeeming against E1');
select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e2000000-0000-4000-8000-0000000000e2', '91000000-0000-4000-8000-000000000091', date '2026-08-18', 'half_day', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§5 E1 acting for E2');
select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-18', 'half_day', null) $q$,
  '42501', 'BOE_CREDITS_DENIED', '§5 no actor');

do $$
declare v_out jsonb; v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1';
begin
  -- The re-pricing path: an active admin acts for the employee and is recorded.
  v_out := public.redeem_boe_credits_for_attendance(v_e1, '91000000-0000-4000-8000-000000000091', date '2026-08-18', 'half_day', 'a0000000-0000-4000-8000-00000000000a');
  assert (select created_by from public.boe_credit_transactions where id = (v_out->>'transaction_id')::uuid) = 'a0000000-0000-4000-8000-00000000000a', '§5 admin actor not recorded on the ledger';
  assert (select created_by from public.boe_credit_attendance_redemptions where id = (v_out->>'redemption_id')::uuid) = 'a0000000-0000-4000-8000-00000000000a', '§5 admin actor not recorded on the record';
  assert public.boe_credit_balance(v_e1) = 4, '§5 balance after the admin-made redemption';
  raise notice 'PASS  §5 an active admin may redeem on the employee''s behalf, and is recorded as the actor';
end $$;

-- an INACTIVE admin may not
update public.users set is_active = false where id = 'a0000000-0000-4000-8000-00000000000a';
select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-19', 'half_day', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§5 an inactive admin acting for E1');
update public.users set is_active = true where id = 'a0000000-0000-4000-8000-00000000000a';

select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');
select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-19', 'half_day', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '42501', 'permission denied', '§5 an employee session executing redeem');
select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_attendance_redemption((select id from public.boe_credit_attendance_redemptions limit 1), 'e1000000-0000-4000-8000-0000000000e1', 'x') $q$,
  '42501', 'permission denied', '§5 an employee session executing reverse');
select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_attendance_redemptions (employee_id, attendance_date, deduction_type, credits, transaction_id, payroll_period_id)
      values ('e1000000-0000-4000-8000-0000000000e1', date '2026-08-19', 'half_day', 1, gen_random_uuid(), '91000000-0000-4000-8000-000000000091') $q$,
  '42501', 'permission denied', '§5 an employee session inserting a record');
select pg_temp.act_as_service();

-- ═══ §6. Locked period: neither redemption nor reversal ═════════════════════

update public.payroll_periods set status = 'locked' where id = '91000000-0000-4000-8000-000000000091';

select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-20', 'half_day', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '55000', 'BOE_CREDITS_PERIOD_LOCKED', '§6 a redemption on a locked month');
select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_attendance_redemption((select id from public.boe_credit_attendance_redemptions where attendance_date = date '2026-08-12'), 'a0000000-0000-4000-8000-00000000000a', 'locked month') $q$,
  '55000', 'BOE_CREDITS_PERIOD_LOCKED', '§6 a reversal on a locked month');

update public.payroll_periods set status = 'generated' where id = '91000000-0000-4000-8000-000000000091';

do $$
declare v_out jsonb;
begin
  v_out := public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-20', 'half_day', 'e1000000-0000-4000-8000-0000000000e1');
  assert (v_out->>'credits')::integer = 1, '§6 after unlock';
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 3, '§6 balance after unlock';
  raise notice 'PASS  §6 locked refused both ways; admitted again after the existing unlock';
end $$;

-- ═══ §7. Not generated, date rules, unknown kind / period / redemption ══════

select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e2000000-0000-4000-8000-0000000000e2', '91000000-0000-4000-8000-000000000091', date '2026-08-12', 'half_day', 'e2000000-0000-4000-8000-0000000000e2') $q$,
  '55000', 'BOE_CREDITS_NOT_GENERATED', '§7 E2 has no generated result');
select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-07-31', 'half_day', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '22023', 'BOE_CREDITS_DATE', '§7 a date outside the month');
select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '92000000-0000-4000-8000-000000000092', date '2099-12-01', 'half_day', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '22023', 'BOE_CREDITS_DATE', '§7 a future date');
select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-21', 'late_arrival', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '22023', 'BOE_CREDITS_REDEMPTION_TYPE', '§7 a late mark is not a kind credits cover');
select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', gen_random_uuid(), date '2026-08-21', 'half_day', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  'P0002', 'BOE_CREDITS_PERIOD', '§7 an unknown period');
select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_attendance_redemption(gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a', 'nothing there') $q$,
  'P0002', 'BOE_CREDITS_REDEMPTION', '§7 an unknown redemption');

-- ═══ §8. History, balance, isolation ════════════════════════════════════════

do $$
declare
  v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_e2 uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_n  integer;
begin
  assert public.boe_credit_balance(v_e1) = (select sum(credits) from public.boe_credit_transactions where employee_id = v_e1), '§8 balance is not the SUM';
  assert (select available_credits from public.boe_credit_balances where employee_id = v_e1) = 3, '§8 view';
  assert (select count(*) from public.boe_credit_transactions where employee_id = v_e1 and transaction_type = 'redemption') = 4, '§8 four redemption rows';
  assert (select count(*) from public.boe_credit_attendance_redemptions where employee_id = v_e1 and reversal_transaction_id is null) = 4, '§8 four active records';

  perform pg_temp.act_as(v_e1);
  select count(*) into v_n from public.boe_credit_attendance_redemptions;
  assert v_n = 4, format('§8 E1 sees %s record rows, expected 4 (own)', v_n);
  perform pg_temp.act_as(v_e2);
  select count(*) into v_n from public.boe_credit_attendance_redemptions;
  assert v_n = 0, format('§8 E2 sees %s record rows, expected 0', v_n);
  perform pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');
  select count(*) into v_n from public.boe_credit_attendance_redemptions;
  assert v_n = 4, format('§8 the admin sees %s record rows, expected 4', v_n);
  perform pg_temp.act_as_service();
  raise notice 'PASS  §8 balance = SUM; own rows only; management reads all';
end $$;

select pg_temp.act_as_anon();
select pg_temp.must_refuse($q$ select count(*) from public.boe_credit_attendance_redemptions $q$, '42501', 'permission denied', '§8 anon reading the records');
select pg_temp.act_as_service();

-- ═══ §9. Immutability — for the service role too ═══════════════════════════

select pg_temp.must_refuse(
  $q$ update public.boe_credit_attendance_redemptions set credits = 0 where attendance_date = date '2026-08-12' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§9 UPDATE of a field on a record');
select pg_temp.must_refuse(
  $q$ delete from public.boe_credit_attendance_redemptions where attendance_date = date '2026-08-12' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§9 DELETE of a record');
select pg_temp.must_refuse(
  $q$ update public.boe_credit_attendance_redemptions set reversal_transaction_id = null, reversed_at = null where attendance_date = date '2026-08-12' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§9 an UPDATE that closes nothing');

-- Hand-closing with a reversal that belongs to a DIFFERENT ledger row.
do $$
declare v_e2 uuid := 'e2000000-0000-4000-8000-0000000000e2'; v_r uuid; v_rev uuid;
begin
  v_r := public.post_boe_credit_transaction(v_e2, 'review_reward', 100, 'customer_review', gen_random_uuid(), null, null);
  v_rev := public.reverse_boe_credit_transaction(v_r, 'a0000000-0000-4000-8000-00000000000a', 'fixture: a foreign reversal');
  perform set_config('boe.foreign_reversal', v_rev::text, true);
end $$;
select pg_temp.must_refuse(
  format($q$ update public.boe_credit_attendance_redemptions set reversal_transaction_id = %L, reversed_at = now() where attendance_date = date '2026-08-12' $q$,
         current_setting('boe.foreign_reversal')),
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§9 hand-closing a record with a foreign reversal');

-- ═══ §10. Attendance truth is not touched ═══════════════════════════════════

do $$
declare v_src text;
begin
  for v_src in
    select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('redeem_boe_credits_for_attendance', 'reverse_boe_credit_attendance_redemption', 'boe_credit_redemption_closed_by_reversal')
  loop
    assert position('attendance_records' in v_src) = 0, '§10 a function reads attendance_records';
    assert position('attendance_day_corrections' in v_src) = 0, '§10 a function reads attendance_day_corrections';
    assert position('payroll_deduction_lines' in v_src) = 0, '§10 a function touches payroll_deduction_lines';
    assert position('update public.payroll_results' in v_src) = 0, '§10 a function writes payroll_results';
  end loop;
  assert to_regclass('public.attendance_records') is null, '§10 this chain does not even carry attendance_records';
  raise notice 'PASS  §10 no attendance or payroll-result write; the attendance tables are not needed';
end $$;

-- ═══ §11. Reversal: restored, closed, untouched; not twice; direct path too ═

do $$
declare
  v_e1  uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_rec public.boe_credit_attendance_redemptions%rowtype;
  v_out jsonb;
  v_rev public.boe_credit_transactions%rowtype;
  v_tx_before public.boe_credit_transactions%rowtype;
begin
  select * into v_rec from public.boe_credit_attendance_redemptions where employee_id = v_e1 and attendance_date = date '2026-08-13';
  select * into v_tx_before from public.boe_credit_transactions where id = v_rec.transaction_id;

  v_out := public.reverse_boe_credit_attendance_redemption(v_rec.id, 'a0000000-0000-4000-8000-00000000000a', 'Attendance changed: 13 Aug 2026 corrected to Present — credits restored');

  assert (v_out->>'credits')::integer = 2, '§11 restored credits';
  assert public.boe_credit_balance(v_e1) = 5, format('§11 balance %s after reversing the 2-credit day, expected 5', public.boe_credit_balance(v_e1));

  select * into v_rev from public.boe_credit_transactions where id = (v_out->>'reversal_transaction_id')::uuid;
  assert v_rev.transaction_type = 'reversal' and v_rev.credits = 2 and v_rev.source_id = v_rec.transaction_id, '§11 the reversal row';
  assert v_rev.created_by = 'a0000000-0000-4000-8000-00000000000a', '§11 the reversal actor is the admin';
  assert v_rev.description like 'Attendance changed:%', '§11 the reason is on the reversal row';

  select * into v_rec from public.boe_credit_attendance_redemptions where id = v_rec.id;
  assert v_rec.reversal_transaction_id = v_rev.id and v_rec.reversed_at = v_rev.created_at, '§11 the record was not closed with its reversal';
  assert v_rec.credits = 2 and v_rec.deduction_type = 'absent' and v_rec.transaction_id = v_tx_before.id, '§11 the record changed something else';
  assert (select row(t.credits, t.description, t.created_at) from public.boe_credit_transactions t where t.id = v_tx_before.id)
       = row(v_tx_before.credits, v_tx_before.description, v_tx_before.created_at), '§11 the original ledger row was touched';
  assert pg_temp.active_count(v_e1, date '2026-08-13') = 0, '§11 the day still reads as covered';

  raise notice 'PASS  §11 reversal: balance restored, record closed by its reversal, history intact';
end $$;

select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_attendance_redemption((select id from public.boe_credit_attendance_redemptions where attendance_date = date '2026-08-13'), 'a0000000-0000-4000-8000-00000000000a', 'again') $q$,
  '55000', 'BOE_CREDITS_ALREADY_REVERSED', '§11 a second reversal');
select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_attendance_redemption((select id from public.boe_credit_attendance_redemptions where attendance_date = date '2026-08-12'), 'e1000000-0000-4000-8000-0000000000e1', 'employee reversing') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§11 a non-admin actor on a reversal');

-- The DIRECT path: reversing the ledger row itself (the foundation's function)
-- closes the record through the trigger, so the two can never disagree.
do $$
declare v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1'; v_rec public.boe_credit_attendance_redemptions%rowtype; v_rev uuid;
begin
  select * into v_rec from public.boe_credit_attendance_redemptions where employee_id = v_e1 and attendance_date = date '2026-08-18';
  v_rev := public.reverse_boe_credit_transaction(v_rec.transaction_id, 'a0000000-0000-4000-8000-00000000000a', 'Reversed directly on the ledger');
  select * into v_rec from public.boe_credit_attendance_redemptions where id = v_rec.id;
  assert v_rec.reversal_transaction_id = v_rev, '§11 a direct ledger reversal did not close the record';
  assert pg_temp.active_count(v_e1, date '2026-08-18') = 0, '§11 direct reversal: still active';
  raise notice 'PASS  §11 a direct ledger reversal closes the record too';
end $$;

-- ═══ §12. Re-redeem after a reversal: allowed, and never two active ═════════

do $$
declare
  v_e1   uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_out  jsonb;
  v_old  uuid;
begin
  select id into v_old from public.boe_credit_attendance_redemptions where employee_id = v_e1 and attendance_date = date '2026-08-13';
  assert pg_temp.active_count(v_e1, date '2026-08-13') = 0, '§12 precondition';

  -- The day is eligible again; a NEW record and a NEW ledger row cover it.
  v_out := public.redeem_boe_credits_for_attendance(v_e1, '91000000-0000-4000-8000-000000000091', date '2026-08-13', 'absent', v_e1);
  assert (v_out->>'redemption_id')::uuid <> v_old, '§12 the old record was reused';
  assert pg_temp.active_count(v_e1, date '2026-08-13') = 1, '§12 exactly one active';
  assert (select count(*) from public.boe_credit_attendance_redemptions where employee_id = v_e1 and attendance_date = date '2026-08-13') = 2, '§12 history: two records for the day';
  assert (select count(*) from public.boe_credit_transactions where employee_id = v_e1 and transaction_type = 'redemption' and source_id in (select id from public.boe_credit_attendance_redemptions where attendance_date = date '2026-08-13')) = 2, '§12 history: two ledger rows';
  assert public.boe_credit_balance(v_e1) = 4, format('§12 balance %s, expected 4', public.boe_credit_balance(v_e1));
  raise notice 'PASS  §12 redeem -> reverse -> redeem again: new row, one active, full history';
end $$;

select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-13', 'absent', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '23505', 'BOE_CREDITS_ALREADY_COVERED', '§12 a third redemption while the second is active');

-- Even a raw insert cannot make a second active row for the day.
select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_attendance_redemptions (employee_id, attendance_date, deduction_type, credits, transaction_id, payroll_period_id)
      select 'e1000000-0000-4000-8000-0000000000e1', date '2026-08-13', 'absent', 2, t.id, '91000000-0000-4000-8000-000000000091'
        from public.boe_credit_transactions t where t.employee_id = 'e2000000-0000-4000-8000-0000000000e2' and t.transaction_type = 'admin_adjustment' limit 1 $q$,
  '23505', 'boe_credit_attendance_redemptions_active_unique', '§12 a raw second active row');

-- ═══ §13. The foundation is untouched ═══════════════════════════════════════

do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.boe_credit_transactions'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%review_reward%';
  assert v_def like '%''redemption''%' and v_def like '%''reversal''%' and v_def like '%''admin_adjustment''%', '§13 the four kinds';
  assert v_def not like '%credit_redeemed%', '§13 the CHECK was widened';
  assert (select count(*) from pg_trigger where tgrelid = 'public.boe_credit_transactions'::regclass and not tgisinternal) = 2,
    '§13 the ledger carries its append-only trigger and the one new AFTER INSERT trigger, and nothing else';
  raise notice 'PASS  §13 ledger vocabulary and constraints unchanged';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
