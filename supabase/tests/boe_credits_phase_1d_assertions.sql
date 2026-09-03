-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261104000000_boe_credits_phase_1d.sql, executed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- src/lib/boeCredits/phase1d.test.ts reads the SQL text. This runs it, on a
-- bare PostgreSQL container carrying the credits chain, and proves what the
-- database itself guarantees about Phase 1D — each refusal with its SQLSTATE
-- and its marker.
--
--   §0  applied              objects, the active settings row, the kept 1A row
--   §1  settings             credit_value must be positive; the three new
--                            columns are bounded
--   §2  attribution          the review month is the Asia/Kolkata month of
--                            submitted_at — 18:30Z on 31 Aug is September,
--                            18:29:59Z is August; the month row is created
--                            with the minimum snapshotted; the reward record
--                            names the card; a second reward for the same
--                            card is refused
--   §3  provisional          recorded 19, provisional 2, spendable 17; an
--                            attendance redemption and a payroll application
--                            are both refused beyond the SPENDABLE balance;
--                            the ledger row of a refusal is never written
--   §4  qualification        the third September review qualifies the month;
--                            its rewards become spendable; a fourth is
--                            spendable at once; August stays provisional
--   §5  reversal, open       reversing a reward before finalization removes
--                            it from the count; a qualified month is not
--                            reopened by a reversal
--   §6  lapse                E2's July: two rewards, one reversed, finalized
--                            below the minimum → ONE lapse row of exactly the
--                            still-valid credit; opening balance untouched;
--                            finalizing again creates nothing; a raw second
--                            lapse is refused by the index; a lapsed month's
--                            reward cannot be reversed
--   §7  finalize, qualified  E2's June: three rewards → qualified → finalized
--                            with no lapse; a later individual reversal is
--                            allowed and the month stays qualified
--   §8  finalize, refused    the current month; a month with no rewards; a
--                            non-admin; a date that is not a first-of-month
--   §9  payroll application  5 credits × ₹100 = ₹500 snapshotted; retry is a
--                            no-op; 5 → 3 is a reversal plus a new row with
--                            exactly one active; a settings change to ₹150
--                            leaves the existing application at ₹100; a new
--                            application uses ₹150; remove; remove again is
--                            not an error; another employee, an admin and
--                            zero credits are refused
--   §10 locked payroll       apply, change, remove and a DIRECT admin
--                            reversal are all refused on a locked month —
--                            for a payroll application and for an attendance
--                            redemption; admitted again after unlock
--   §11 attendance price     half day 8, absent 15 from the settings; a new
--                            settings row (1 / 2) prices the next redemption
--                            and never the previous record
--   §12 authorization / RLS  own rows only on the three new tables; the
--                            admin reads all; anon nothing; no client writes;
--                            the fifth kind needs an admin actor and a
--                            negative amount
--   §13 immutability         a lapsed month cannot reopen; a qualified month
--                            cannot un-qualify; rewards and applications are
--                            append-only; a closed application is closed
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so it can be
-- run any number of times. It creates its own fictional employees and refuses
-- to run if public.users holds anybody.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through
--   run_boe_credits_phase_1d_local.sh.

\set ON_ERROR_STOP on

begin;

-- ─── helpers (the same idiom as the Phase 1A/1C suites) ─────────────────────

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

-- The three figures, as the application reads them.
create or replace function pg_temp.recorded(p uuid) returns integer language sql as $$ select public.boe_credit_balance(p) $$;
create or replace function pg_temp.provisional(p uuid) returns integer language sql as $$ select public.boe_credit_provisional_credits(p) $$;
create or replace function pg_temp.spendable(p uuid) returns integer language sql as $$ select public.boe_credit_spendable_balance(p) $$;

create or replace function pg_temp.month_row(p uuid, m date) returns public.boe_credit_review_months language sql as $$
  select * from public.boe_credit_review_months where employee_id = p and review_month = m
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
  ('92000000-0000-4000-8000-000000000092', 'e1000000-0000-4000-8000-0000000000e1', 20000),
  ('91000000-0000-4000-8000-000000000091', 'e2000000-0000-4000-8000-0000000000e2', 20000);

-- The opening balances: the "17 previous credits" of the brief for E1, 10 for E2.
select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'admin_adjustment', 17, 'manual', null, 'Fixture: seventeen credits', 'a0000000-0000-4000-8000-00000000000a');
select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'admin_adjustment', 10, 'manual', null, 'Fixture: ten credits',       'a0000000-0000-4000-8000-00000000000a');

-- ═══ §0. Applied ═════════════════════════════════════════════════════════════

do $$
declare s public.boe_credit_settings%rowtype;
begin
  assert to_regclass('public.boe_credit_review_months') is not null, '§0 months table';
  assert to_regclass('public.boe_credit_review_rewards') is not null, '§0 rewards table';
  assert to_regclass('public.boe_credit_payroll_applications') is not null, '§0 applications table';
  assert to_regprocedure('public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid)') is not null, '§0 reward fn';
  assert to_regprocedure('public.finalize_boe_credit_review_month(uuid, date, uuid)') is not null, '§0 finalize fn';
  assert to_regprocedure('public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)') is not null, '§0 apply fn';
  assert to_regprocedure('public.remove_boe_credit_payroll_application(uuid, uuid, uuid)') is not null, '§0 remove fn';
  select * into s from public.boe_credit_settings order by created_at desc limit 1;
  assert s.review_reward_credits = 1 and s.credit_value = 100.00 and s.half_day_redemption_credits = 8
     and s.full_day_redemption_credits = 15 and s.minimum_monthly_reviews = 3, '§0 active settings';
  assert (select count(*) from public.boe_credit_settings) = 2, '§0 the Phase 1A row is kept as history';
  assert (select review_reward_credits from public.boe_credit_settings order by created_at asc limit 1) = 100, '§0 the Phase 1A row is unchanged';
  raise notice 'PASS  §0 migration applied; settings (1, 100.00, 8, 15, 3) active, 1A row kept';
end $$;

-- ═══ §1. Settings bounds ═════════════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_settings (review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews) values (1, 0, 8, 15, 3) $q$,
  '23514', 'boe_credit_settings_credit_value_positive', '§1 credit_value 0');
select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_settings (review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews) values (1, 100, 0, 15, 3) $q$,
  '23514', 'half_day_redemption_credits', '§1 half day 0');
select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_settings (review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews) values (1, 100, 8, -1, 3) $q$,
  '23514', 'full_day_redemption_credits', '§1 full day negative');
select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_settings (review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews) values (1, 100, 8, 15, 0) $q$,
  '23514', 'minimum_monthly_reviews', '§1 minimum 0');

-- ═══ §2. Attribution: the month of the successful submission, in IST ═════════

do $$
declare
  v_e1  uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_adm uuid := 'a0000000-0000-4000-8000-00000000000a';
  v_out jsonb;
  v_tx  public.boe_credit_transactions%rowtype;
  v_r   public.boe_credit_review_rewards%rowtype;
  v_m   public.boe_credit_review_months%rowtype;
begin
  -- 18:30:00Z on 31 August is 00:00 IST on 1 September.
  v_out := public.post_boe_credit_review_reward(v_e1, 'c1000000-0000-4000-8000-0000000000c1', 'TEST-001', timestamptz '2026-08-31T18:30:00Z', v_adm);
  assert (v_out->>'credits')::integer = 1, format('§2 credits %s', v_out->>'credits');
  assert (v_out->>'review_month')::date = date '2026-09-01', format('§2 review month %s, expected 2026-09-01', v_out->>'review_month');
  assert v_out->>'month_status' = 'open' and (v_out->>'provisional')::boolean, '§2 first reward is provisional';
  assert (v_out->>'qualifying_review_count')::integer = 1 and (v_out->>'minimum_reviews')::integer = 3, '§2 count/minimum';

  select * into v_tx from public.boe_credit_transactions where id = (v_out->>'transaction_id')::uuid;
  assert v_tx.transaction_type = 'review_reward' and v_tx.credits = 1 and v_tx.source_type = 'customer_review'
     and v_tx.source_id = 'c1000000-0000-4000-8000-0000000000c1' and v_tx.created_by = v_adm
     and v_tx.description = 'Review verified · TEST-001', '§2 ledger row';

  select * into v_r from public.boe_credit_review_rewards where transaction_id = v_tx.id;
  assert found and v_r.card_id = 'c1000000-0000-4000-8000-0000000000c1' and v_r.card_ref = 'TEST-001'
     and v_r.review_month = date '2026-09-01' and v_r.submitted_at = timestamptz '2026-08-31T18:30:00Z', '§2 reward record';

  v_m := pg_temp.month_row(v_e1, date '2026-09-01');
  assert v_m.id = v_r.review_month_id and v_m.status = 'open' and v_m.minimum_reviews_snapshot = 3
     and v_m.qualifying_review_count = 1 and v_m.earned_review_credits = 1 and v_m.qualified_at is null, '§2 month row';

  -- 18:29:59Z on 31 August is 23:59:59 IST on 31 August.
  v_out := public.post_boe_credit_review_reward(v_e1, 'c2000000-0000-4000-8000-0000000000c2', 'TEST-002', timestamptz '2026-08-31T18:29:59Z', v_adm);
  assert (v_out->>'review_month')::date = date '2026-08-01', format('§2 review month %s, expected 2026-08-01', v_out->>'review_month');
  assert (pg_temp.month_row(v_e1, date '2026-08-01')).qualifying_review_count = 1, '§2 August count';

  raise notice 'PASS  §2 attribution by IST month of submitted_at; month row created with the minimum snapshotted';
end $$;

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_review_reward('e1000000-0000-4000-8000-0000000000e1', 'c1000000-0000-4000-8000-0000000000c1', 'TEST-001', timestamptz '2026-09-02T10:00:00Z', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '23505', 'BOE_CREDITS_DUPLICATE_SOURCE', '§2 the same review rewarded twice');
select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_review_reward('e1000000-0000-4000-8000-0000000000e1', 'c9000000-0000-4000-8000-0000000000c9', 'TEST-009', null, 'a0000000-0000-4000-8000-00000000000a') $q$,
  '22023', 'BOE_CREDITS_REVIEW_MONTH', '§2 a reward with no submission instant');

-- ═══ §3. Provisional credits cannot be spent ═════════════════════════════════

do $$
declare v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1';
begin
  assert pg_temp.recorded(v_e1) = 19, format('§3 recorded %s, expected 19', pg_temp.recorded(v_e1));
  assert pg_temp.provisional(v_e1) = 2, format('§3 provisional %s, expected 2', pg_temp.provisional(v_e1));
  assert pg_temp.spendable(v_e1) = 17, format('§3 spendable %s, expected 17', pg_temp.spendable(v_e1));
  assert (select spendable_credits from public.boe_credit_balances where employee_id = v_e1) = 17, '§3 view spendable';
  assert (select provisional_credits from public.boe_credit_balances where employee_id = v_e1) = 2, '§3 view provisional';
  assert (select available_credits from public.boe_credit_balances where employee_id = v_e1) = 19, '§3 view recorded';
  raise notice 'PASS  §3a recorded 19 / provisional 2 / spendable 17';
end $$;

-- 18 would fit the recorded balance and not the spendable one.
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', 18, 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§3 a payroll application of 18 against 17 spendable (19 recorded)');

do $$
declare v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1'; v_out jsonb;
begin
  assert not exists (select 1 from public.boe_credit_payroll_applications), '§3 a refused application left a row';
  assert (select count(*) from public.boe_credit_transactions where employee_id = v_e1 and transaction_type = 'redemption') = 0, '§3 a refused application left a ledger row';

  -- A half day at 8 leaves 9 spendable (11 recorded).
  v_out := public.redeem_boe_credits_for_attendance(v_e1, '91000000-0000-4000-8000-000000000091', date '2026-08-12', 'half_day', v_e1);
  assert (v_out->>'credits')::integer = 8, format('§3 half day cost %s, expected 8', v_out->>'credits');
  assert (v_out->>'available_credits')::integer = 9, format('§3 spendable after %s, expected 9', v_out->>'available_credits');
  assert pg_temp.recorded(v_e1) = 11 and pg_temp.spendable(v_e1) = 9, '§3 figures after the half day';
  raise notice 'PASS  §3b half day costs 8 from the settings; spendable 9 / recorded 11';
end $$;

select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', date '2026-08-13', 'absent', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§3 an absent day (15) against 9 spendable');
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', 10, 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§3 a payroll application of 10 against 9 spendable (11 recorded)');

-- ═══ §4. Qualification ═══════════════════════════════════════════════════════

do $$
declare
  v_e1  uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_adm uuid := 'a0000000-0000-4000-8000-00000000000a';
  v_out jsonb;
  v_m   public.boe_credit_review_months%rowtype;
begin
  v_out := public.post_boe_credit_review_reward(v_e1, 'c3000000-0000-4000-8000-0000000000c3', 'TEST-003', timestamptz '2026-09-10T05:00:00Z', v_adm);
  assert v_out->>'month_status' = 'open' and (v_out->>'qualifying_review_count')::integer = 2, '§4 two reviews: still open';
  assert pg_temp.provisional(v_e1) = 3 and pg_temp.spendable(v_e1) = 9, '§4 two September rewards + August still provisional';

  v_out := public.post_boe_credit_review_reward(v_e1, 'c4000000-0000-4000-8000-0000000000c4', 'TEST-004', timestamptz '2026-09-20T05:00:00Z', v_adm);
  assert v_out->>'month_status' = 'qualified' and not (v_out->>'provisional')::boolean, '§4 the third review qualifies the month';
  assert (v_out->>'qualifying_review_count')::integer = 3, '§4 count 3';
  v_m := pg_temp.month_row(v_e1, date '2026-09-01');
  assert v_m.status = 'qualified' and v_m.qualified_at is not null and v_m.finalized_at is null, '§4 month qualified, not yet finalized';
  -- September's three are spendable now; August's one is still provisional.
  assert pg_temp.recorded(v_e1) = 13, format('§4 recorded %s, expected 13', pg_temp.recorded(v_e1));
  assert pg_temp.provisional(v_e1) = 1, format('§4 provisional %s, expected 1 (August)', pg_temp.provisional(v_e1));
  assert pg_temp.spendable(v_e1) = 12, format('§4 spendable %s, expected 12', pg_temp.spendable(v_e1));

  -- A fourth review in a qualified month is spendable at once.
  v_out := public.post_boe_credit_review_reward(v_e1, 'c5000000-0000-4000-8000-0000000000c5', 'TEST-005', timestamptz '2026-09-25T05:00:00Z', v_adm);
  assert v_out->>'month_status' = 'qualified' and not (v_out->>'provisional')::boolean and (v_out->>'qualifying_review_count')::integer = 4, '§4 fourth review';
  assert pg_temp.spendable(v_e1) = 13 and pg_temp.provisional(v_e1) = 1, '§4 fourth reward spendable immediately';

  raise notice 'PASS  §4 third review qualifies September; its rewards spendable; the fourth immediately; August still provisional';
end $$;

-- ═══ §5. Reversal before finalization; a qualified month is not reopened ═════

do $$
declare
  v_e1  uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_adm uuid := 'a0000000-0000-4000-8000-00000000000a';
  v_tx  uuid;
  v_m   public.boe_credit_review_months%rowtype;
begin
  -- Reverse the fourth September reward: the count drops to 3, the month stays qualified.
  select id into v_tx from public.boe_credit_transactions where source_id = 'c5000000-0000-4000-8000-0000000000c5' and transaction_type = 'review_reward';
  perform public.reverse_boe_credit_transaction(v_tx, v_adm, 'Review withdrawn');
  v_m := pg_temp.month_row(v_e1, date '2026-09-01');
  assert v_m.status = 'qualified' and v_m.qualifying_review_count = 3 and v_m.earned_review_credits = 3, '§5 count after reversal';
  assert pg_temp.spendable(v_e1) = 12, format('§5 spendable %s, expected 12', pg_temp.spendable(v_e1));

  -- Reverse two of September's three: below the minimum, but qualification is not undone.
  select id into v_tx from public.boe_credit_transactions where source_id = 'c4000000-0000-4000-8000-0000000000c4' and transaction_type = 'review_reward';
  perform public.reverse_boe_credit_transaction(v_tx, v_adm, 'Review withdrawn');
  v_m := pg_temp.month_row(v_e1, date '2026-09-01');
  assert v_m.status = 'qualified' and v_m.qualifying_review_count = 2, '§5 a qualified month stays qualified below the minimum';
  assert pg_temp.spendable(v_e1) = 11, '§5 spendable after the second reversal';

  -- Reverse August's only reward while August is open: its provisional credit goes away with it.
  select id into v_tx from public.boe_credit_transactions where source_id = 'c2000000-0000-4000-8000-0000000000c2' and transaction_type = 'review_reward';
  perform public.reverse_boe_credit_transaction(v_tx, v_adm, 'Review withdrawn');
  v_m := pg_temp.month_row(v_e1, date '2026-08-01');
  assert v_m.status = 'open' and v_m.qualifying_review_count = 0 and v_m.earned_review_credits = 0, '§5 August count 0';
  assert pg_temp.provisional(v_e1) = 0, format('§5 provisional %s, expected 0', pg_temp.provisional(v_e1));
  assert pg_temp.recorded(v_e1) = 11 and pg_temp.spendable(v_e1) = 11, format('§5 recorded %s / spendable %s, expected 11 / 11', pg_temp.recorded(v_e1), pg_temp.spendable(v_e1));

  raise notice 'PASS  §5 reversals adjust the count; a qualified month never reopens; a reversed provisional reward is neither provisional nor spendable';
end $$;

-- ═══ §6. Lapse ═══════════════════════════════════════════════════════════════

do $$
declare
  v_e2  uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_adm uuid := 'a0000000-0000-4000-8000-00000000000a';
  v_out jsonb;
  v_tx  uuid;
  v_m   public.boe_credit_review_months%rowtype;
  v_l   public.boe_credit_transactions%rowtype;
begin
  perform public.post_boe_credit_review_reward(v_e2, 'd1000000-0000-4000-8000-0000000000d1', 'TEST-101', timestamptz '2026-07-05T05:00:00Z', v_adm);
  perform public.post_boe_credit_review_reward(v_e2, 'd2000000-0000-4000-8000-0000000000d2', 'TEST-102', timestamptz '2026-07-15T05:00:00Z', v_adm);
  assert pg_temp.recorded(v_e2) = 12 and pg_temp.provisional(v_e2) = 2 and pg_temp.spendable(v_e2) = 10, '§6 July: two provisional';

  -- One of the two is withdrawn before the month closes.
  select id into v_tx from public.boe_credit_transactions where source_id = 'd2000000-0000-4000-8000-0000000000d2' and transaction_type = 'review_reward';
  perform public.reverse_boe_credit_transaction(v_tx, v_adm, 'Review withdrawn');
  assert pg_temp.recorded(v_e2) = 11 and pg_temp.provisional(v_e2) = 1, '§6 after the reversal: one provisional';

  -- Finalize July: 1 of 3 → lapsed, and the lapse is exactly the one still-valid credit.
  v_out := public.finalize_boe_credit_review_month(v_e2, date '2026-07-01', v_adm);
  assert v_out->>'status' = 'lapsed', format('§6 status %s', v_out->>'status');
  assert (v_out->>'lapsed_credits')::integer = 1, format('§6 lapsed %s, expected 1 (the reversed one is not lapsed again)', v_out->>'lapsed_credits');
  assert not (v_out->>'already_finalized')::boolean, '§6 first finalization';
  select * into v_l from public.boe_credit_transactions where id = (v_out->>'lapse_transaction_id')::uuid;
  assert v_l.transaction_type = 'review_month_lapse' and v_l.credits = -1 and v_l.source_type = 'boe_credit_review_month'
     and v_l.created_by = v_adm and v_l.description = 'July 2026 review credits lapsed · 1 of 3 reviews', format('§6 lapse row: %s %s %L', v_l.transaction_type, v_l.credits, v_l.description);
  v_m := pg_temp.month_row(v_e2, date '2026-07-01');
  assert v_m.status = 'lapsed' and v_m.finalized_at is not null and v_m.finalized_by = v_adm and v_m.lapse_transaction_id = v_l.id, '§6 month row';
  assert v_l.source_id = v_m.id, '§6 the lapse names the month row';

  -- 10 + 2 − 1 (reversal) − 1 (lapse) = 10: the opening ten are untouched.
  assert pg_temp.recorded(v_e2) = 10, format('§6 recorded %s, expected 10', pg_temp.recorded(v_e2));
  assert pg_temp.provisional(v_e2) = 0 and pg_temp.spendable(v_e2) = 10, '§6 spendable 10 after the lapse';

  -- Finalizing again creates nothing.
  v_out := public.finalize_boe_credit_review_month(v_e2, date '2026-07-01', v_adm);
  assert (v_out->>'already_finalized')::boolean and v_out->>'status' = 'lapsed' and (v_out->>'lapsed_credits')::integer = 0, '§6 second finalization is a no-op';
  assert (select count(*) from public.boe_credit_transactions where employee_id = v_e2 and transaction_type = 'review_month_lapse') = 1, '§6 exactly one lapse row';
  assert pg_temp.recorded(v_e2) = 10, '§6 balance unchanged by the second call';

  raise notice 'PASS  §6 lapse removes exactly the still-valid credit; opening balance kept; idempotent';
end $$;

-- A raw second lapse for the same month is refused by the one-row-per-source index.
select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'review_month_lapse', -1, 'boe_credit_review_month',
        (select id from public.boe_credit_review_months where employee_id = 'e2000000-0000-4000-8000-0000000000e2' and review_month = date '2026-07-01'),
        'forged', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '23505', 'BOE_CREDITS_DUPLICATE_SOURCE', '§6 a second lapse for the same month');

-- The lapse row itself is final too.
select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(
        (select lapse_transaction_id from public.boe_credit_review_months where employee_id = 'e2000000-0000-4000-8000-0000000000e2' and review_month = date '2026-07-01'),
        'a0000000-0000-4000-8000-00000000000a', 'undo the close') $q$,
  '55000', 'BOE_CREDITS_REVERSAL', '§6 reversing the lapse row itself');

-- A lapsed month's reward cannot be reversed: its credit is already gone.
select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(
        (select id from public.boe_credit_transactions where source_id = 'd1000000-0000-4000-8000-0000000000d1' and transaction_type = 'review_reward'),
        'a0000000-0000-4000-8000-00000000000a', 'too late') $q$,
  '55000', 'BOE_CREDITS_MONTH_LAPSED', '§6 reversing a reward whose month lapsed');

-- ═══ §7. Finalizing a qualified month ════════════════════════════════════════

do $$
declare
  v_e2  uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_adm uuid := 'a0000000-0000-4000-8000-00000000000a';
  v_out jsonb;
  v_tx  uuid;
  v_m   public.boe_credit_review_months%rowtype;
begin
  perform public.post_boe_credit_review_reward(v_e2, 'd3000000-0000-4000-8000-0000000000d3', 'TEST-103', timestamptz '2026-06-03T05:00:00Z', v_adm);
  perform public.post_boe_credit_review_reward(v_e2, 'd4000000-0000-4000-8000-0000000000d4', 'TEST-104', timestamptz '2026-06-13T05:00:00Z', v_adm);
  perform public.post_boe_credit_review_reward(v_e2, 'd5000000-0000-4000-8000-0000000000d5', 'TEST-105', timestamptz '2026-06-23T05:00:00Z', v_adm);
  assert (pg_temp.month_row(v_e2, date '2026-06-01')).status = 'qualified', '§7 June qualified';
  assert pg_temp.spendable(v_e2) = 13, '§7 spendable 13';

  v_out := public.finalize_boe_credit_review_month(v_e2, date '2026-06-01', v_adm);
  assert v_out->>'status' = 'qualified' and (v_out->>'lapsed_credits')::integer = 0 and v_out->>'lapse_transaction_id' is null, '§7 finalized as qualified, nothing lapsed';
  v_m := pg_temp.month_row(v_e2, date '2026-06-01');
  assert v_m.finalized_at is not null and v_m.finalized_by = v_adm and v_m.lapse_transaction_id is null, '§7 month row';
  assert pg_temp.recorded(v_e2) = 13, '§7 balance unchanged';

  -- Cancelling one old June review afterwards: its own credit goes, the month stays qualified and finalized.
  select id into v_tx from public.boe_credit_transactions where source_id = 'd5000000-0000-4000-8000-0000000000d5' and transaction_type = 'review_reward';
  perform public.reverse_boe_credit_transaction(v_tx, v_adm, 'Review withdrawn after the month closed');
  v_m := pg_temp.month_row(v_e2, date '2026-06-01');
  assert v_m.status = 'qualified' and v_m.qualifying_review_count = 2 and v_m.finalized_at is not null, '§7 not reopened, not lapsed';
  assert pg_temp.recorded(v_e2) = 12 and pg_temp.spendable(v_e2) = 12, '§7 exactly that credit removed';

  v_out := public.finalize_boe_credit_review_month(v_e2, date '2026-06-01', v_adm);
  assert (v_out->>'already_finalized')::boolean and v_out->>'status' = 'qualified', '§7 re-finalizing a qualified month changes nothing';

  raise notice 'PASS  §7 qualified month finalizes without a lapse; a later individual reversal does not reopen it';
end $$;

-- ═══ §8. Finalization refusals ═══════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$ select public.finalize_boe_credit_review_month('e1000000-0000-4000-8000-0000000000e1', date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date, 'a0000000-0000-4000-8000-00000000000a') $q$,
  '55000', 'BOE_CREDITS_MONTH_OPEN', '§8 the current month');
select pg_temp.must_refuse(
  $q$ select public.finalize_boe_credit_review_month('e1000000-0000-4000-8000-0000000000e1', date '2026-05-01', 'a0000000-0000-4000-8000-00000000000a') $q$,
  'P0002', 'BOE_CREDITS_REVIEW_MONTH', '§8 a month with no rewards');
select pg_temp.must_refuse(
  $q$ select public.finalize_boe_credit_review_month('e1000000-0000-4000-8000-0000000000e1', date '2026-08-01', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§8 the employee finalizing their own month');
select pg_temp.must_refuse(
  $q$ select public.finalize_boe_credit_review_month('e1000000-0000-4000-8000-0000000000e1', date '2026-08-15', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '22023', 'BOE_CREDITS_REVIEW_MONTH', '§8 a date that is not the first of a month');

do $$
declare v_out jsonb; v_m public.boe_credit_review_months%rowtype;
begin
  -- E1's August: its only reward was reversed in §5, so there is nothing to lapse.
  v_out := public.finalize_boe_credit_review_month('e1000000-0000-4000-8000-0000000000e1', date '2026-08-01', 'a0000000-0000-4000-8000-00000000000a');
  assert v_out->>'status' = 'lapsed' and (v_out->>'lapsed_credits')::integer = 0 and v_out->>'lapse_transaction_id' is null, '§8 zero-credit lapse posts no row';
  v_m := pg_temp.month_row('e1000000-0000-4000-8000-0000000000e1', date '2026-08-01');
  assert v_m.status = 'lapsed' and v_m.lapse_transaction_id is null and v_m.finalized_at is not null, '§8 month row';
  assert pg_temp.recorded('e1000000-0000-4000-8000-0000000000e1') = 11, '§8 balance unchanged';
  raise notice 'PASS  §8 finalization refusals; a month with nothing left to lapse posts no ledger row';
end $$;

-- ═══ §9. Payroll credit application ══════════════════════════════════════════

do $$
declare
  v_e1  uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_p   uuid := '91000000-0000-4000-8000-000000000091';
  v_out jsonb;
  v_a   public.boe_credit_payroll_applications%rowtype;
  v_old public.boe_credit_payroll_applications%rowtype;
  v_tx  public.boe_credit_transactions%rowtype;
begin
  assert pg_temp.spendable(v_e1) = 11, format('§9 opening spendable %s, expected 11', pg_temp.spendable(v_e1));

  v_out := public.apply_boe_credits_to_payroll(v_e1, v_p, 5, v_e1);
  assert (v_out->>'credits_used')::integer = 5 and (v_out->>'credit_value')::numeric = 100.00 and (v_out->>'credit_amount')::numeric = 500.00, format('§9 %s', v_out);
  assert (v_out->>'spendable_credits')::integer = 6 and not (v_out->>'unchanged')::boolean and v_out->>'replaced_application_id' is null, '§9 first application';
  select * into v_a from public.boe_credit_payroll_applications where id = (v_out->>'application_id')::uuid;
  assert v_a.employee_id = v_e1 and v_a.payroll_period_id = v_p and v_a.credits_used = 5
     and v_a.credit_value_snapshot = 100.00 and v_a.credit_amount_snapshot = 500.00
     and v_a.created_by = v_e1 and v_a.reversal_transaction_id is null, '§9 application row';
  select * into v_tx from public.boe_credit_transactions where id = v_a.redemption_transaction_id;
  assert v_tx.transaction_type = 'redemption' and v_tx.credits = -5 and v_tx.source_type = 'payroll_redemption'
     and v_tx.source_id = v_a.id and v_tx.payroll_period_id = v_p and v_tx.created_by = v_e1
     and v_tx.description = 'Applied to payroll · August 2026', format('§9 ledger row %L', v_tx.description);

  -- A retry with the same number changes nothing.
  v_out := public.apply_boe_credits_to_payroll(v_e1, v_p, 5, v_e1);
  assert (v_out->>'unchanged')::boolean and (v_out->>'application_id')::uuid = v_a.id, '§9 retry is a no-op';
  assert (select count(*) from public.boe_credit_transactions where employee_id = v_e1 and source_type = 'payroll_redemption') = 1, '§9 no second redemption';

  -- 5 → 3: +5 reversal, −3 new, exactly one active.
  v_out := public.apply_boe_credits_to_payroll(v_e1, v_p, 3, v_e1);
  assert (v_out->>'credits_used')::integer = 3 and (v_out->>'credit_amount')::numeric = 300.00 and (v_out->>'replaced_application_id')::uuid = v_a.id, '§9 replacement';
  select * into v_old from public.boe_credit_payroll_applications where id = v_a.id;
  assert v_old.reversal_transaction_id is not null and v_old.reversed_at is not null and v_old.credits_used = 5 and v_old.credit_amount_snapshot = 500.00, '§9 the old application is closed, not edited';
  select * into v_tx from public.boe_credit_transactions where id = v_old.reversal_transaction_id;
  assert v_tx.transaction_type = 'reversal' and v_tx.credits = 5 and v_tx.created_by = v_e1 and v_tx.source_id = v_old.redemption_transaction_id, '§9 the reversal, by the employee';
  assert (select count(*) from public.boe_credit_payroll_applications where employee_id = v_e1 and payroll_period_id = v_p and reversal_transaction_id is null) = 1, '§9 one active';
  assert pg_temp.spendable(v_e1) = 8, format('§9 spendable %s, expected 8', pg_temp.spendable(v_e1));

  -- The rate changes to ₹150. The existing application keeps ₹100 / ₹300.
  insert into public.boe_credit_settings (review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews, note, created_at)
  values (1, 150.00, 8, 15, 3, 'test: rate change', clock_timestamp());
  v_out := public.apply_boe_credits_to_payroll(v_e1, v_p, 3, v_e1);
  assert (v_out->>'unchanged')::boolean and (v_out->>'credit_value')::numeric = 100.00 and (v_out->>'credit_amount')::numeric = 300.00, '§9 same credits after a rate change: NOT re-priced';
  select * into v_a from public.boe_credit_payroll_applications where employee_id = v_e1 and payroll_period_id = v_p and reversal_transaction_id is null;
  assert v_a.credit_value_snapshot = 100.00 and v_a.credit_amount_snapshot = 300.00, '§9 snapshot kept';

  -- A NEW application uses the new rate.
  v_out := public.apply_boe_credits_to_payroll(v_e1, v_p, 4, v_e1);
  assert (v_out->>'credit_value')::numeric = 150.00 and (v_out->>'credit_amount')::numeric = 600.00, '§9 new application at ₹150';
  assert pg_temp.spendable(v_e1) = 7, '§9 spendable 7';

  -- Remove.
  v_out := public.remove_boe_credit_payroll_application(v_e1, v_p, v_e1);
  assert (v_out->>'removed')::boolean and (v_out->>'spendable_credits')::integer = 11, '§9 removal restores the credits';
  assert (select count(*) from public.boe_credit_payroll_applications where employee_id = v_e1 and payroll_period_id = v_p and reversal_transaction_id is null) = 0, '§9 nothing active';
  v_out := public.remove_boe_credit_payroll_application(v_e1, v_p, v_e1);
  assert not (v_out->>'removed')::boolean, '§9 removing nothing is not an error';
  assert (select count(*) from public.boe_credit_payroll_applications where employee_id = v_e1) = 3, '§9 history: three application rows';

  raise notice 'PASS  §9 payroll application: snapshots, idempotent retry, replace = reverse + new, rate change never re-prices, remove';
end $$;

select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', 1, 'e2000000-0000-4000-8000-0000000000e2') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§9 E2 applying E1''s credits');
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', 1, 'a0000000-0000-4000-8000-00000000000a') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§9 an admin applying for E1');
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', 0, 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '22023', 'BOE_CREDITS_ZERO', '§9 zero credits');
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', -3, 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '22023', 'BOE_CREDITS_ZERO', '§9 negative credits');
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e2000000-0000-4000-8000-0000000000e2', '92000000-0000-4000-8000-000000000092', 1, 'e2000000-0000-4000-8000-0000000000e2') $q$,
  '55000', 'BOE_CREDITS_NOT_GENERATED', '§9 a month with no generated result for E2');
select pg_temp.must_refuse(
  $q$ select public.remove_boe_credit_payroll_application('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§9 an admin removing E1''s application');

-- ═══ §10. A locked payroll month freezes credit use ═════════════════════════

do $$
declare v_out jsonb;
begin
  -- An application on the 2099 period, then lock it.
  v_out := public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '92000000-0000-4000-8000-000000000092', 2, 'e1000000-0000-4000-8000-0000000000e1');
  assert (v_out->>'credit_value')::numeric = 150.00, '§10 fixture application';
  update public.payroll_periods set status = 'locked' where id = '92000000-0000-4000-8000-000000000092';
  update public.payroll_periods set status = 'locked' where id = '91000000-0000-4000-8000-000000000091';
end $$;

select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '92000000-0000-4000-8000-000000000092', 3, 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '55000', 'BOE_CREDITS_PERIOD_LOCKED', '§10 changing an application on a locked month');
select pg_temp.must_refuse(
  $q$ select public.remove_boe_credit_payroll_application('e1000000-0000-4000-8000-0000000000e1', '92000000-0000-4000-8000-000000000092', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '55000', 'BOE_CREDITS_PERIOD_LOCKED', '§10 removing an application on a locked month');
select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(
        (select redemption_transaction_id from public.boe_credit_payroll_applications where payroll_period_id = '92000000-0000-4000-8000-000000000092' and reversal_transaction_id is null),
        'a0000000-0000-4000-8000-00000000000a', 'admin trying directly') $q$,
  '55000', 'BOE_CREDITS_PERIOD_LOCKED', '§10 a DIRECT admin reversal of a locked month''s payroll application');
select pg_temp.must_refuse(
  $q$ select public.reverse_boe_credit_transaction(
        (select transaction_id from public.boe_credit_attendance_redemptions where attendance_date = date '2026-08-12'),
        'a0000000-0000-4000-8000-00000000000a', 'admin trying directly') $q$,
  '55000', 'BOE_CREDITS_PERIOD_LOCKED', '§10 a DIRECT admin reversal of a locked month''s attendance redemption');
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', 1, 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '55000', 'BOE_CREDITS_PERIOD_LOCKED', '§10 a new application on a locked month');

do $$
declare v_out jsonb;
begin
  assert (select credits_used from public.boe_credit_payroll_applications where payroll_period_id = '92000000-0000-4000-8000-000000000092' and reversal_transaction_id is null) = 2, '§10 the application is frozen';
  update public.payroll_periods set status = 'generated' where id in ('91000000-0000-4000-8000-000000000091', '92000000-0000-4000-8000-000000000092');
  v_out := public.remove_boe_credit_payroll_application('e1000000-0000-4000-8000-0000000000e1', '92000000-0000-4000-8000-000000000092', 'e1000000-0000-4000-8000-0000000000e1');
  assert (v_out->>'removed')::boolean, '§10 admitted again after unlock';
  raise notice 'PASS  §10 locked month: apply, change, remove and direct reversal all refused; unlock admits';
end $$;

-- ═══ §11. Attendance price follows the settings; history does not ════════════

do $$
declare
  v_e2  uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_p   uuid := '91000000-0000-4000-8000-000000000091';
  v_out jsonb;
  v_first uuid;
begin
  assert pg_temp.spendable(v_e2) = 12, '§11 E2 opening 12';
  v_out := public.redeem_boe_credits_for_attendance(v_e2, v_p, date '2026-08-05', 'half_day', v_e2);
  assert (v_out->>'credits')::integer = 8, '§11 half day 8';
  v_first := (v_out->>'redemption_id')::uuid;
  assert pg_temp.spendable(v_e2) = 4, '§11 spendable 4';

  -- Re-price for the future only.
  insert into public.boe_credit_settings (review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews, note, created_at)
  values (1, 150.00, 1, 2, 3, 'test: attendance price change', clock_timestamp());
  v_out := public.redeem_boe_credits_for_attendance(v_e2, v_p, date '2026-08-06', 'absent', v_e2);
  assert (v_out->>'credits')::integer = 2, format('§11 absent now costs %s, expected 2', v_out->>'credits');
  assert (select credits from public.boe_credit_attendance_redemptions where id = v_first) = 8, '§11 the earlier record still says 8';
  assert (select credits from public.boe_credit_transactions where source_id = v_first) = -8, '§11 the earlier ledger row still says -8';
  assert pg_temp.spendable(v_e2) = 2, '§11 spendable 2';

  -- Back to the Phase 1D prices for the sections below.
  insert into public.boe_credit_settings (review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews, note, created_at)
  values (1, 100.00, 8, 15, 3, 'test: restore', clock_timestamp());
  raise notice 'PASS  §11 attendance costs 8 / 15 from the settings; a change prices the next redemption only';
end $$;

select pg_temp.must_refuse(
  $q$ select public.redeem_boe_credits_for_attendance('e2000000-0000-4000-8000-0000000000e2', '91000000-0000-4000-8000-000000000091', date '2026-08-07', 'absent', 'e2000000-0000-4000-8000-0000000000e2') $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§11 absent (15) against 2 spendable');

-- ═══ §12. Authorization ══════════════════════════════════════════════════════

do $$
declare v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1'; v_e2 uuid := 'e2000000-0000-4000-8000-0000000000e2';
begin
  perform pg_temp.act_as(v_e1);
  assert (select count(*) from public.boe_credit_review_months) = (select count(*) from public.boe_credit_review_months m where m.employee_id = v_e1), '§12 E1 sees only own months';
  assert (select count(*) from public.boe_credit_review_months) >= 2, '§12 E1 sees own months';
  assert (select count(*) from public.boe_credit_review_rewards where employee_id <> v_e1) = 0, '§12 E1 sees no other rewards';
  assert (select count(*) from public.boe_credit_payroll_applications where employee_id <> v_e1) = 0, '§12 E1 sees no other applications';
  assert (select count(*) from public.boe_credit_payroll_applications) = 4, '§12 E1 sees own applications';
  assert (select spendable_credits from public.boe_credit_balances where employee_id = v_e1) = pg_temp.spendable(v_e1), '§12 own spendable through the view';
  assert (select count(*) from public.boe_credit_balances) = 1, '§12 E1 sees one balance row';

  perform pg_temp.act_as(v_e2);
  assert (select count(*) from public.boe_credit_review_months where employee_id = v_e1) = 0, '§12 E2 cannot read E1 months';
  assert (select count(*) from public.boe_credit_payroll_applications) = 0, '§12 E2 has no applications and sees none';

  perform pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');
  assert (select count(distinct employee_id) from public.boe_credit_review_months) = 2, '§12 the admin reads every month';
  assert (select count(*) from public.boe_credit_balances) = 2, '§12 the admin reads every balance';

  perform pg_temp.act_as_anon();
  perform pg_temp.act_as_service();
  raise notice 'PASS  §12a own rows / management / RLS on the three tables and the view';
end $$;

select pg_temp.act_as_anon();
select pg_temp.must_refuse($q$ select count(*) from public.boe_credit_review_months $q$, '42501', 'permission denied', '§12 anon reading months');
select pg_temp.must_refuse($q$ select count(*) from public.boe_credit_payroll_applications $q$, '42501', 'permission denied', '§12 anon reading applications');
select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');
select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_review_months (employee_id, review_month, minimum_reviews_snapshot) values ('e1000000-0000-4000-8000-0000000000e1', date '2026-01-01', 1) $q$,
  '42501', 'permission denied', '§12 an employee inserting a month');
select pg_temp.must_refuse(
  $q$ update public.boe_credit_review_months set status = 'qualified', qualified_at = now() where employee_id = 'e1000000-0000-4000-8000-0000000000e1' $q$,
  '42501', 'permission denied', '§12 an employee qualifying their own month');
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e1000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-000000000091', 1, 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '42501', 'permission denied', '§12 an employee session calling the apply function');
select pg_temp.must_refuse(
  $q$ select public.finalize_boe_credit_review_month('e1000000-0000-4000-8000-0000000000e1', date '2026-08-01', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '42501', 'permission denied', '§12 an employee session calling finalize');
select pg_temp.act_as_service();

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'review_month_lapse', -1, 'boe_credit_review_month',
        (select id from public.boe_credit_review_months where employee_id = 'e1000000-0000-4000-8000-0000000000e1' and review_month = date '2026-09-01'),
        'forged', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§12 a lapse posted by a non-admin actor');
select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'review_month_lapse', 1, 'boe_credit_review_month',
        (select id from public.boe_credit_review_months where employee_id = 'e1000000-0000-4000-8000-0000000000e1' and review_month = date '2026-09-01'),
        'forged', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '22023', 'BOE_CREDITS_SIGN', '§12 a positive lapse');
select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'review_month_lapse', -1, 'boe_credit_review_month',
        (select id from public.boe_credit_review_months where employee_id = 'e1000000-0000-4000-8000-0000000000e1' and review_month = date '2026-09-01'),
        'forged', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '22023', 'BOE_CREDITS_SOURCE', '§12 a lapse naming another employee''s month');
select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'reversal', -1, 'boe_credit_transaction',
        (select id from public.boe_credit_transactions where source_id = 'c3000000-0000-4000-8000-0000000000c3' and transaction_type = 'review_reward'),
        'self-service', 'e1000000-0000-4000-8000-0000000000e1') $q$,
  '42501', 'BOE_CREDITS_DENIED', '§12 an employee reversing their own REWARD (only a payroll application is theirs to reverse)');

-- ═══ §13. Immutability ═══════════════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$ update public.boe_credit_review_months set status = 'open' where employee_id = 'e2000000-0000-4000-8000-0000000000e2' and review_month = date '2026-07-01' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 reopening a lapsed month');
select pg_temp.must_refuse(
  $q$ update public.boe_credit_review_months set status = 'open', qualified_at = null where employee_id = 'e2000000-0000-4000-8000-0000000000e2' and review_month = date '2026-06-01' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 un-qualifying a qualified month');
select pg_temp.must_refuse(
  $q$ update public.boe_credit_review_months set minimum_reviews_snapshot = 1 where employee_id = 'e1000000-0000-4000-8000-0000000000e1' and review_month = date '2026-09-01' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 rewriting a month''s minimum');
select pg_temp.must_refuse(
  $q$ delete from public.boe_credit_review_months where employee_id = 'e1000000-0000-4000-8000-0000000000e1' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 deleting a month');
select pg_temp.must_refuse(
  $q$ update public.boe_credit_review_rewards set review_month = date '2026-10-01' where card_id = 'c1000000-0000-4000-8000-0000000000c1' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 re-attributing a reward');
select pg_temp.must_refuse(
  $q$ delete from public.boe_credit_review_rewards where card_id = 'c1000000-0000-4000-8000-0000000000c1' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 deleting a reward record');
select pg_temp.must_refuse(
  $q$ update public.boe_credit_payroll_applications set credit_amount_snapshot = 9999 where employee_id = 'e1000000-0000-4000-8000-0000000000e1' and reversal_transaction_id is not null $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 editing a closed application');
select pg_temp.must_refuse(
  $q$ delete from public.boe_credit_payroll_applications $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 deleting an application');
select pg_temp.must_refuse(
  $q$ update public.boe_credit_transactions set credits = 99 where transaction_type = 'review_month_lapse' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§13 editing the lapse row');

do $$
declare v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1'; v_e2 uuid := 'e2000000-0000-4000-8000-0000000000e2';
begin
  -- The whole ledger still sums to what the sections above established.
  assert pg_temp.recorded(v_e1) = 11 and pg_temp.spendable(v_e1) = 11 and pg_temp.provisional(v_e1) = 0, format('§13 E1 final: %s / %s / %s', pg_temp.recorded(v_e1), pg_temp.spendable(v_e1), pg_temp.provisional(v_e1));
  assert pg_temp.recorded(v_e2) = 2 and pg_temp.spendable(v_e2) = 2, format('§13 E2 final: %s', pg_temp.recorded(v_e2));
  raise notice 'PASS  §13 lapsed and qualified months are final; records append-only; balances reconcile';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
