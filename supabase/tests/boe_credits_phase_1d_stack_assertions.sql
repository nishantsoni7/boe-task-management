-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261104000000 on the REAL Review Workflow chain
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The bare-container suite (boe_credits_phase_1d_assertions.sql) proves the
-- credits functions. This proves the one Phase 1D path that runs INSIDE the
-- Review Workflow: the verify transition, as a verifier calls it through
-- PostgREST, posting the reward and attributing it to the month of the
-- submission it confirms.
--
--   §0  applied        the transition returns jsonb; settings (1, 100, 8, 15, 3)
--   §1  verify         RW-000001 (submitted this month) → +1 for the HOLDER,
--                      review_month = this IST month, provisional; balances
--                      recorded 1 / provisional 1 / spendable 0
--   §2  retry          verifying again is refused (23514) before any reward
--   §3  month crossing RW-000004's submission is moved to 31 Aug 23:59:59
--                      IST; verified now → review_month = August
--   §4  resubmission   RW-000003 submitted in August, RETURNED, resubmitted
--                      now by the holder (screenshot attached) → verified →
--                      counts for THIS month, not August
--   §5  finalize       August for the holder: 1 of 3 → lapsed, −1, balances
--                      back; this month stays open with 2 of 3
--   §6  historical     the review verified before Phase 1B still has no reward
--   §7  authorization  a reviewer cannot verify; a browser session cannot
--                      call post_boe_credit_review_reward or finalize
--
-- Runs inside ONE transaction that ends in ROLLBACK. The people and the
-- historical review come from _boe_credits_review_reward_before.sql, applied
-- by the runner before the credits migrations.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through run_boe_credits_phase_1d_stack_local.sh.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
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

create or replace function pg_temp.submitted_review(p_id uuid, p_ref text, p_holder uuid, p_submitted_at timestamptz)
returns void language plpgsql as $$
begin
  insert into public.customer_review_test_cards (
    id, card_ref, test_category, test_title, test_body, status,
    approved_by, approved_at, booked_by, booked_at,
    sent_confirmed_by, sent_confirmed_at, submitted_by, submitted_at
  ) values (
    p_id, p_ref, 'cafe_test', 'Harness review ' || p_ref,
    'Harness filler long enough to clear the minimum body length. It describes nothing and is attributed to nobody. Ref ' || p_ref || '.',
    'submitted',
    'a0000000-0000-4000-8000-00000000000a', p_submitted_at - interval '3 days',
    p_holder, p_submitted_at - interval '2 days',
    p_holder, p_submitted_at - interval '1 day',
    p_holder, p_submitted_at
  );
end $$;

-- A live screenshot, the way the upload route leaves one, so a resubmission passes the submittability check.
create or replace function pg_temp.screenshot_for(p_card uuid, p_holder uuid)
returns void language plpgsql as $$
begin
  insert into public.customer_review_test_card_screenshots (card_id, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values (p_card, p_card::text || '/shot.png', 'shot.png', 'image/png', 1234, repeat('a', 64), p_holder);
end $$;

create or replace function pg_temp.recorded(p uuid) returns integer language sql as $$ select public.boe_credit_balance(p) $$;
create or replace function pg_temp.provisional(p uuid) returns integer language sql as $$ select public.boe_credit_provisional_credits(p) $$;
create or replace function pg_temp.spendable(p uuid) returns integer language sql as $$ select public.boe_credit_spendable_balance(p) $$;

-- ─── fixtures ────────────────────────────────────────────────────────────────

select pg_temp.act_as_service();

-- RW-000001: submitted this month (an hour ago).
select pg_temp.submitted_review('c1000000-0000-4000-8000-0000000000c1', 'RW-000001', 'e1000000-0000-4000-8000-0000000000e1', now() - interval '1 hour');
-- RW-000003: submitted on 20 August IST; will be returned and resubmitted now.
select pg_temp.submitted_review('c3000000-0000-4000-8000-0000000000c3', 'RW-000003', 'e1000000-0000-4000-8000-0000000000e1', timestamptz '2026-08-20T05:00:00Z');
-- RW-000004: submitted at 23:59:59 IST on 31 August — the boundary.
select pg_temp.submitted_review('c4000000-0000-4000-8000-0000000000c4', 'RW-000004', 'e1000000-0000-4000-8000-0000000000e1', timestamptz '2026-08-31T18:29:59Z');
-- RW-000002: the second reviewer's, this month.
select pg_temp.submitted_review('c2000000-0000-4000-8000-0000000000c2', 'RW-000002', 'e2000000-0000-4000-8000-0000000000e2', now() - interval '2 hours');

-- ═══ §0 ═════════════════════════════════════════════════════════════════════

do $$
declare v_ret text; s public.boe_credit_settings%rowtype;
begin
  select pg_get_function_result(p.oid) into v_ret
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'transition_customer_review_test_card';
  assert v_ret = 'jsonb', '§0 the transition does not return jsonb';
  assert to_regprocedure('public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid)') is not null, '§0 reward fn missing';
  select * into s from public.boe_credit_settings order by created_at desc limit 1;
  assert s.review_reward_credits = 1 and s.credit_value = 100 and s.half_day_redemption_credits = 8
     and s.full_day_redemption_credits = 15 and s.minimum_monthly_reviews = 3, '§0 settings';
  assert (select count(*) from public.boe_credit_transactions) = 0, '§0 ledger not empty';
  raise notice 'PASS  §0 applied on the real chain; settings (1, 100, 8, 15, 3); ledger empty';
end $$;

-- ═══ §1. Verify → reward for the holder, attributed to this month, provisional ═

select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');

do $$
declare
  v_out   jsonb;
  v_e1    uuid := 'e1000000-0000-4000-8000-0000000000e1';
  v_month date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v_tx    public.boe_credit_transactions%rowtype;
  v_r     public.boe_credit_review_rewards%rowtype;
begin
  v_out := public.transition_customer_review_test_card('c1000000-0000-4000-8000-0000000000c1', 'verified', 'Looks right');
  assert v_out->'card'->>'status' = 'verified', '§1 card status';
  assert (v_out->'reward'->>'credits')::integer = 1, format('§1 credits %s', v_out->'reward'->>'credits');
  assert (v_out->'reward'->>'employee_id')::uuid = v_e1, '§1 the HOLDER is rewarded';
  assert v_out->'reward'->>'employee_name' = 'Test Reviewer', '§1 holder name';
  assert (v_out->'reward'->>'review_month')::date = v_month, format('§1 review month %s, expected %s', v_out->'reward'->>'review_month', v_month);
  assert v_out->'reward'->>'month_status' = 'open' and (v_out->'reward'->>'provisional')::boolean, '§1 provisional';
  assert (v_out->'reward'->>'qualifying_review_count')::integer = 1 and (v_out->'reward'->>'minimum_reviews')::integer = 3, '§1 count/min';

  perform pg_temp.act_as_service();
  select * into v_tx from public.boe_credit_transactions where id = (v_out->'reward'->>'transaction_id')::uuid;
  assert v_tx.employee_id = v_e1 and v_tx.transaction_type = 'review_reward' and v_tx.credits = 1
     and v_tx.source_type = 'customer_review' and v_tx.source_id = 'c1000000-0000-4000-8000-0000000000c1'
     and v_tx.created_by = 'a0000000-0000-4000-8000-00000000000a' and v_tx.description = 'Review verified · RW-000001', '§1 ledger row';
  select * into v_r from public.boe_credit_review_rewards where transaction_id = v_tx.id;
  assert found and v_r.card_ref = 'RW-000001' and v_r.review_month = v_month, '§1 reward record';
  assert pg_temp.recorded(v_e1) = 1 and pg_temp.provisional(v_e1) = 1 and pg_temp.spendable(v_e1) = 0, '§1 balances 1/1/0';
  assert (select count(*) from public.customer_review_test_card_events where card_id = 'c1000000-0000-4000-8000-0000000000c1' and event_type = 'verified') = 1, '§1 event';
  perform pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');
  raise notice 'PASS  §1 verify → +1 for the holder, this month, provisional; balances 1 / 1 / 0';
end $$;

-- ═══ §2. Retry ══════════════════════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c1000000-0000-4000-8000-0000000000c1', 'verified', 'again') $q$,
  '23514', 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION', '§2 verifying a verified review');

do $$
begin
  perform pg_temp.act_as_service();
  assert (select count(*) from public.boe_credit_transactions where source_id = 'c1000000-0000-4000-8000-0000000000c1') = 1, '§2 still one reward';
  perform pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');
end $$;

-- ═══ §3. The month boundary ═════════════════════════════════════════════════

do $$
declare v_out jsonb;
begin
  v_out := public.transition_customer_review_test_card('c4000000-0000-4000-8000-0000000000c4', 'verified', null);
  assert (v_out->'reward'->>'review_month')::date = date '2026-08-01', format('§3 review month %s, expected 2026-08-01', v_out->'reward'->>'review_month');
  assert (v_out->'reward'->>'qualifying_review_count')::integer = 1, '§3 August count 1';
  raise notice 'PASS  §3 submitted 23:59:59 IST on 31 Aug, verified now → August';
end $$;

-- ═══ §4. Returned and resubmitted: the LATER submission counts ═══════════════

do $$
declare v_out jsonb; v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1';
begin
  -- The verifier returns it.
  v_out := public.transition_customer_review_test_card('c3000000-0000-4000-8000-0000000000c3', 'booked', 'Screenshot unreadable');
  assert v_out->'card'->>'status' = 'booked' and v_out->>'reward' is null, '§4 return earns nothing';
  assert (v_out->'card'->>'submitted_at')::timestamptz = timestamptz '2026-08-20T05:00:00Z', '§4 the old submission instant survives the return';

  -- The holder attaches a screenshot and resubmits, now.
  perform pg_temp.act_as_service();
  perform pg_temp.screenshot_for('c3000000-0000-4000-8000-0000000000c3', v_e1);
  perform pg_temp.act_as(v_e1);
  v_out := public.transition_customer_review_test_card('c3000000-0000-4000-8000-0000000000c3', 'submitted', null);
  assert v_out->'card'->>'status' = 'submitted', '§4 resubmitted';
  assert (v_out->'card'->>'submitted_at')::timestamptz > now() - interval '1 minute', '§4 submitted_at is the resubmission';

  -- Verified: counts for THIS month.
  perform pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');
  v_out := public.transition_customer_review_test_card('c3000000-0000-4000-8000-0000000000c3', 'verified', null);
  assert (v_out->'reward'->>'review_month')::date = date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date, format('§4 review month %s', v_out->'reward'->>'review_month');
  assert (v_out->'reward'->>'qualifying_review_count')::integer = 2, '§4 this month now counts 2';
  assert v_out->'reward'->>'month_status' = 'open', '§4 still below 3';

  perform pg_temp.act_as_service();
  assert pg_temp.recorded(v_e1) = 3 and pg_temp.provisional(v_e1) = 3 and pg_temp.spendable(v_e1) = 0, format('§4 balances %s/%s/%s', pg_temp.recorded(v_e1), pg_temp.provisional(v_e1), pg_temp.spendable(v_e1));
  perform pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');
  raise notice 'PASS  §4 returned in August, resubmitted now → counts for this month; balances 3 / 3 / 0';
end $$;

-- ═══ §5. Finalize August: 1 of 3 → lapsed ═══════════════════════════════════

do $$
declare v_out jsonb; v_e1 uuid := 'e1000000-0000-4000-8000-0000000000e1'; v_m public.boe_credit_review_months%rowtype;
begin
  perform pg_temp.act_as_service();
  v_out := public.finalize_boe_credit_review_month(v_e1, date '2026-08-01', 'a0000000-0000-4000-8000-00000000000a');
  assert v_out->>'status' = 'lapsed' and (v_out->>'lapsed_credits')::integer = 1, format('§5 %s', v_out);
  assert pg_temp.recorded(v_e1) = 2 and pg_temp.provisional(v_e1) = 2 and pg_temp.spendable(v_e1) = 0, '§5 balances 2/2/0';
  select * into v_m from public.boe_credit_review_months where employee_id = v_e1 and review_month = date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  assert v_m.status = 'open' and v_m.qualifying_review_count = 2, '§5 this month untouched';
  v_out := public.finalize_boe_credit_review_month(v_e1, date '2026-08-01', 'a0000000-0000-4000-8000-00000000000a');
  assert (v_out->>'already_finalized')::boolean, '§5 idempotent';
  assert (select count(*) from public.boe_credit_transactions where transaction_type = 'review_month_lapse') = 1, '§5 one lapse';
  raise notice 'PASS  §5 August lapsed (−1), this month open at 2 of 3; finalize idempotent';
end $$;

-- ═══ §6. Historical ═════════════════════════════════════════════════════════

do $$
begin
  assert (select count(*) from public.boe_credit_transactions where source_id = 'c0000000-0000-4000-8000-0000000000c0') = 0, '§6 the pre-1B review has no reward';
  raise notice 'PASS  §6 the review verified before Phase 1B still earns nothing';
end $$;

-- ═══ §7. Authorization ══════════════════════════════════════════════════════

select pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c2000000-0000-4000-8000-0000000000c2', 'verified', 'self') $q$,
  '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '§7 a reviewer verifying (their own review)');
select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_review_reward('e2000000-0000-4000-8000-0000000000e2', 'c2000000-0000-4000-8000-0000000000c2', 'RW-000002', now(), 'e2000000-0000-4000-8000-0000000000e2') $q$,
  '42501', 'permission denied', '§7 a browser session calling the reward function');
select pg_temp.must_refuse(
  $q$ select public.finalize_boe_credit_review_month('e1000000-0000-4000-8000-0000000000e1', date '2026-08-01', 'a0000000-0000-4000-8000-00000000000a') $q$,
  '42501', 'permission denied', '§7 a browser session calling finalize');
select pg_temp.must_refuse(
  $q$ select public.apply_boe_credits_to_payroll('e2000000-0000-4000-8000-0000000000e2', gen_random_uuid(), 1, 'e2000000-0000-4000-8000-0000000000e2') $q$,
  '42501', 'permission denied', '§7 a browser session calling apply');

do $$
begin
  perform pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');
  assert (select count(*) from public.boe_credit_review_months) = 2, '§7 E1 reads own two months';
  assert (select count(*) from public.boe_credit_review_rewards) = 3, '§7 E1 reads own three rewards';
  assert (select spendable_credits from public.boe_credit_balances where employee_id = 'e1000000-0000-4000-8000-0000000000e1') = 0, '§7 own view row';
  perform pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
  assert (select count(*) from public.boe_credit_review_months) = 0, '§7 E2 sees none of E1''s months';
  perform pg_temp.act_as_service();
  raise notice 'PASS  §7 own rows only; no client role reaches a write function';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
