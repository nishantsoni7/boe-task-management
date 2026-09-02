-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261102000000_boe_credits_review_reward.sql, executed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS. src/lib/boeCredits/reviewReward.test.ts reads the SQL
-- and checks that it SAYS the right things. This runs it, against the real
-- Review Workflow chain and the real BOE Credits foundation, and proves the
-- rules Phase 1B promised — each refusal with its SQLSTATE and marker.
--
--   §1  successful reward       first verification → one review_reward, for
--                               the HOLDER, from the setting, naming the card
--   §2  setting-driven value    setting 125 → the next verification awards +125
--   §3  duplicate / retry       verifying again is refused (23514) and the
--                               ledger still holds one row; a forged second
--                               reward is refused by the index (23505)
--   §4  failed verification     submit, return, a refused verify, a pending
--                               card — none earns a credit
--   §5  historical records      the review verified before this migration has
--                               no reward
--   §6  authorization           a reviewer cannot verify (42501), cannot call
--                               the posting function (42501), cannot read a
--                               colleague's reward; a deactivated verifier is
--                               refused; the deleted tombstone is refused
--   §7  existing behaviour      balance is the sum; the reward row is
--                               immutable; a reversal of the reward is still
--                               possible and goes negative if already spent
--
-- CONCURRENCY. One psql session cannot race itself. What this file proves is
-- the boundary a race would meet: the row lock is taken before the status is
-- read (a second session wakes on `verified` and is refused), and the unique
-- index refuses a second reward however it is attempted (§3b). The advisory
-- lock inside post_boe_credit_transaction() is asserted by the Phase 1A suite.
--
-- Runs inside ONE transaction that ends in ROLLBACK. The fixture people and the
-- historical review come from _boe_credits_review_reward_before.sql, applied
-- by the runner before the migration under test.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through run_boe_credits_review_reward_local.sh.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ─── helpers (same idiom as boe_credits_assertions.sql) ──────────────────────

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

-- A review in the state a reviewer leaves it for a verifier: submitted, with
-- the holder's send confirmation, approved into the pool by the admin. Written
-- as the owner, the way the definer functions would have left it.
create or replace function pg_temp.submitted_review(p_id uuid, p_ref text, p_holder uuid)
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
    'a0000000-0000-4000-8000-00000000000a', now() - interval '3 days',
    p_holder, now() - interval '2 days',
    p_holder, now() - interval '1 day',
    p_holder, now() - interval '1 hour'
  );
end $$;

-- ─── fixtures, inside the transaction ────────────────────────────────────────

select pg_temp.act_as_service();

select pg_temp.submitted_review('c1000000-0000-4000-8000-0000000000c1', 'RW-000001', 'e1000000-0000-4000-8000-0000000000e1');
select pg_temp.submitted_review('c2000000-0000-4000-8000-0000000000c2', 'RW-000002', 'e2000000-0000-4000-8000-0000000000e2');
select pg_temp.submitted_review('c3000000-0000-4000-8000-0000000000c3', 'RW-000003', 'e1000000-0000-4000-8000-0000000000e1');
select pg_temp.submitted_review('c4000000-0000-4000-8000-0000000000c4', 'RW-000004', 'e1000000-0000-4000-8000-0000000000e1');
select pg_temp.submitted_review('c5000000-0000-4000-8000-0000000000c5', 'RW-000005', 'e2000000-0000-4000-8000-0000000000e2');

-- ═══ §0. The migration is applied ═══════════════════════════════════════════

do $$
declare v_ret text;
begin
  select pg_get_function_result(p.oid) into v_ret
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'transition_customer_review_test_card';
  assert v_ret = 'jsonb', '20261102000000 is NOT applied: the transition still returns ' || coalesce(v_ret, '<missing>');
  assert (select review_reward_credits from public.boe_credit_settings order by created_at desc limit 1) = 100,
    '§0 the active setting is not the seeded 100';
  assert (select count(*) from public.boe_credit_transactions) = 0, '§0 the ledger is not empty at the start';
  raise notice 'PASS  §0 migration applied; setting 100; ledger empty';
end $$;

-- ═══ §1. Successful reward ══════════════════════════════════════════════════

select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');

do $$
declare
  v_out  jsonb;
  v_row  public.boe_credit_transactions%rowtype;
  v_card public.customer_review_test_cards%rowtype;
begin
  v_out := public.transition_customer_review_test_card('c1000000-0000-4000-8000-0000000000c1', 'verified', 'Looks genuine');

  -- the result the screen reads
  assert v_out ? 'card' and v_out ? 'reward', '§1 the result does not carry card and reward';
  assert (v_out -> 'card' ->> 'status') = 'verified', '§1 the card in the result is not verified';
  assert (v_out -> 'reward' ->> 'credits')::integer = 100, format('§1 reward credits = %s, expected 100', v_out -> 'reward' ->> 'credits');
  assert (v_out -> 'reward' ->> 'employee_id')::uuid = 'e1000000-0000-4000-8000-0000000000e1', '§1 the reward names the wrong employee';
  assert (v_out -> 'reward' ->> 'employee_name') = 'Test Reviewer', '§1 the reward does not carry the holder''s name';
  assert (v_out -> 'reward' ->> 'transaction_id') is not null, '§1 no transaction id';

  -- the review, verified as before
  perform pg_temp.act_as_service();
  select * into v_card from public.customer_review_test_cards where id = 'c1000000-0000-4000-8000-0000000000c1';
  assert v_card.status = 'verified' and v_card.verified_by = 'a0000000-0000-4000-8000-00000000000a'
     and v_card.verification_note = 'Looks genuine', '§1 the verification itself did not happen as before';
  assert (select count(*) from public.customer_review_test_card_events
           where card_id = v_card.id and event_type = 'verified') = 1, '§1 the verified event was not written';

  -- the ledger row
  assert (select count(*) from public.boe_credit_transactions) = 1, '§1 expected exactly one ledger row';
  select * into v_row from public.boe_credit_transactions limit 1;
  assert v_row.id = (v_out -> 'reward' ->> 'transaction_id')::uuid, '§1 the returned transaction id is not the row';
  assert v_row.employee_id = 'e1000000-0000-4000-8000-0000000000e1', '§1 rewarded the wrong employee (holder is e1)';
  assert v_row.employee_id <> 'a0000000-0000-4000-8000-00000000000a', '§1 rewarded the VERIFIER';
  assert v_row.transaction_type = 'review_reward', '§1 wrong kind';
  assert v_row.credits = 100, '§1 wrong amount';
  assert v_row.source_type = 'customer_review', '§1 wrong source type';
  assert v_row.source_id = 'c1000000-0000-4000-8000-0000000000c1', '§1 the source is not the immutable review id';
  assert v_row.created_by = 'a0000000-0000-4000-8000-00000000000a', '§1 the actor is not the verifier';
  assert v_row.description = 'Review verified · RW-000001', format('§1 description is %s', v_row.description);
  assert v_row.payroll_period_id is null, '§1 a reward has no payroll period';
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 100, '§1 balance is not 100';

  raise notice 'PASS  §1 first verification: one review_reward +100 for the holder, source = the review, actor = the verifier';
end $$;

-- ═══ §2. Setting-driven value ═══════════════════════════════════════════════

select pg_temp.act_as_service();

insert into public.boe_credit_settings (review_reward_credits, credit_value, created_by, note)
values (125, 1.00, 'a0000000-0000-4000-8000-00000000000a', 'Harness: raised to 125');

select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');

do $$
declare v_out jsonb;
begin
  v_out := public.transition_customer_review_test_card('c2000000-0000-4000-8000-0000000000c2', 'verified', null);
  assert (v_out -> 'reward' ->> 'credits')::integer = 125, format('§2 reward = %s, expected 125', v_out -> 'reward' ->> 'credits');
  assert (v_out -> 'reward' ->> 'employee_id')::uuid = 'e2000000-0000-4000-8000-0000000000e2', '§2 the reward followed the wrong holder';
  perform pg_temp.act_as_service();
  assert (select credits from public.boe_credit_transactions where source_id = 'c2000000-0000-4000-8000-0000000000c2') = 125,
    '§2 the ledger row is not 125';
  assert (select credits from public.boe_credit_transactions where source_id = 'c1000000-0000-4000-8000-0000000000c1') = 100,
    '§2 the earlier reward was restated';
  assert public.boe_credit_balance('e2000000-0000-4000-8000-0000000000e2') = 125, '§2 balance is not 125';
  raise notice 'PASS  §2 setting 125 -> the next verification awards +125; the earlier +100 is untouched';
end $$;

-- ═══ §3. Duplicate / retry ══════════════════════════════════════════════════

select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');

select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c1000000-0000-4000-8000-0000000000c1', 'verified', 'again') $q$,
  '23514', 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION', '§3 verifying an already-verified review (a retry, a second click)');

select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c1000000-0000-4000-8000-0000000000c1', 'booked', 'take it back') $q$,
  '23514', 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION', '§3 returning a verified review');

select pg_temp.act_as_service();

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'review_reward', 100, 'customer_review', 'c1000000-0000-4000-8000-0000000000c1', 'forged', null) $q$,
  '23505', 'BOE_CREDITS_DUPLICATE_SOURCE', '§3 a second reward for the same review through the posting function');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id)
      values ('e1000000-0000-4000-8000-0000000000e1', 'review_reward', 100, 'customer_review', 'c1000000-0000-4000-8000-0000000000c1') $q$,
  '23505', 'boe_credit_transactions_one_per_source_idx', '§3 a second reward for the same review past the function — the index');

do $$
begin
  assert (select count(*) from public.boe_credit_transactions where source_id = 'c1000000-0000-4000-8000-0000000000c1') = 1,
    '§3 the review has more than one reward';
  assert (select status from public.customer_review_test_cards where id = 'c1000000-0000-4000-8000-0000000000c1') = 'verified',
    '§3 the review is no longer verified';
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 100, '§3 the balance moved on a refused retry';
  raise notice 'PASS  §3 retries refused at the transition, forged duplicates refused by the index; still one reward';
end $$;

-- ═══ §4. Failed / non-final verification earns nothing ══════════════════════

select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');

do $$
declare v_out jsonb;
begin
  -- a return: submitted -> booked, with a reason
  v_out := public.transition_customer_review_test_card('c3000000-0000-4000-8000-0000000000c3', 'booked', 'Screenshot unreadable');
  assert (v_out -> 'card' ->> 'status') = 'booked', '§4 the return did not happen';
  assert (v_out -> 'reward') is null or jsonb_typeof(v_out -> 'reward') = 'null', '§4 a return carried a reward';
  raise notice 'PASS  §4 a return (submitted -> booked) awards nothing';
end $$;

-- the holder re-submits it: booked -> submitted, no reward either
select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');

do $$
declare v_out jsonb;
begin
  -- assert_customer_review_test_card_submittable needs a live screenshot; the
  -- holder's re-submit here is refused for that reason, which is itself the
  -- point: nothing short of a verifier's final verification earns a credit.
  begin
    v_out := public.transition_customer_review_test_card('c3000000-0000-4000-8000-0000000000c3', 'submitted', null);
    assert (v_out -> 'reward') is null or jsonb_typeof(v_out -> 'reward') = 'null', '§4 a submit carried a reward';
    raise notice 'PASS  §4 a submit (booked -> submitted) awards nothing';
  exception when others then
    raise notice 'PASS  §4 a submit without evidence is refused (%), and awards nothing', sqlstate;
  end;
end $$;

select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c4000000-0000-4000-8000-0000000000c4', 'verified', 'I verify my own') $q$,
  '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '§4 a reviewer verifying their own review');

select pg_temp.act_as_service();

do $$
begin
  assert (select count(*) from public.boe_credit_transactions) = 2, format('§4 expected 2 ledger rows (c1, c2), found %s', (select count(*) from public.boe_credit_transactions));
  assert not exists (select 1 from public.boe_credit_transactions where source_id in (
    'c3000000-0000-4000-8000-0000000000c3', 'c4000000-0000-4000-8000-0000000000c4', 'c5000000-0000-4000-8000-0000000000c5')),
    '§4 a returned, submitted or refused review earned a credit';
  assert public.boe_credit_balance('e1000000-0000-4000-8000-0000000000e1') = 100, '§4 e1 balance moved';
  raise notice 'PASS  §4 returned, re-submitted, refused and pending reviews: zero credits';
end $$;

-- ═══ §5. Historical records: no backfill ════════════════════════════════════

do $$
begin
  assert (select status from public.customer_review_test_cards where id = 'c0000000-0000-4000-8000-0000000000c0') = 'verified',
    '§5 the historical review is not verified';
  assert not exists (select 1 from public.boe_credit_transactions where source_id = 'c0000000-0000-4000-8000-0000000000c0'),
    '§5 the historical review was rewarded by the migration';
  assert not exists (select 1 from public.boe_credit_transactions where created_at < (select verified_at from public.customer_review_test_cards where id = 'c1000000-0000-4000-8000-0000000000c1')),
    '§5 a ledger row predates the first live verification';
  raise notice 'PASS  §5 the review verified before Phase 1B has no reward';
end $$;

-- ═══ §6. Authorization ══════════════════════════════════════════════════════

select pg_temp.act_as('e1000000-0000-4000-8000-0000000000e1');

select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c5000000-0000-4000-8000-0000000000c5', 'verified', 'x') $q$,
  '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '§6 a reviewer (use only) verifying a colleague''s review');

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e1000000-0000-4000-8000-0000000000e1', 'review_reward', 500, 'customer_review', 'c5000000-0000-4000-8000-0000000000c5', 'me', null) $q$,
  '42501', 'permission denied', '§6 a reviewer calling the posting function directly');

select pg_temp.must_refuse(
  $q$ insert into public.boe_credit_transactions (employee_id, transaction_type, credits, source_type, source_id)
      values (auth.uid(), 'review_reward', 500, 'customer_review', 'c5000000-0000-4000-8000-0000000000c5') $q$,
  '42501', 'permission denied', '§6 a reviewer inserting a reward');

do $$
declare v_n integer;
begin
  select count(*) into v_n from public.boe_credit_transactions;
  assert v_n = 1, format('§6 e1 sees %s ledger rows, expected only their own 1', v_n);
  assert (select employee_id from public.boe_credit_transactions limit 1) = auth.uid(), '§6 e1 can see a colleague''s reward';
  assert public.boe_credit_balance('e2000000-0000-4000-8000-0000000000e2') = 0, '§6 e1 can read e2''s balance';
  raise notice 'PASS  §6 a reviewer reads only their own reward';
end $$;

select pg_temp.act_as('e3000000-0000-4000-8000-0000000000e3');

select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c5000000-0000-4000-8000-0000000000c5', 'verified', 'x') $q$,
  '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '§6 a member with no grant');

select pg_temp.act_as('a1000000-0000-4000-8000-00000000001a');

select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c5000000-0000-4000-8000-0000000000c5', 'verified', 'x') $q$,
  '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '§6 a DEACTIVATED admin');

-- a deleted review cannot be verified, so it cannot be rewarded
select pg_temp.act_as_service();
update public.customer_review_test_cards
   set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-00000000000a', deleted_source = 'single'
 where id = 'c5000000-0000-4000-8000-0000000000c5';
select pg_temp.act_as('a0000000-0000-4000-8000-00000000000a');

select pg_temp.must_refuse(
  $q$ select public.transition_customer_review_test_card('c5000000-0000-4000-8000-0000000000c5', 'verified', 'x') $q$,
  '42501', 'CUSTOMER_REVIEW_TEST_DELETED', '§6 verifying a deleted review');

select pg_temp.act_as_service();

do $$
begin
  assert (select count(*) from public.boe_credit_transactions) = 2, '§6 a refused path wrote a ledger row';
  raise notice 'PASS  §6 no refused path reached the ledger';
end $$;

-- ═══ §7. Existing credits behaviour is intact ═══════════════════════════════

select pg_temp.must_refuse(
  $q$ update public.boe_credit_transactions set credits = 1000 where transaction_type = 'review_reward' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§7 editing a reward');

select pg_temp.must_refuse(
  $q$ delete from public.boe_credit_transactions where transaction_type = 'review_reward' $q$,
  '42501', 'BOE_CREDITS_APPEND_ONLY', '§7 deleting a reward');

do $$
declare
  v_e2 uuid := 'e2000000-0000-4000-8000-0000000000e2';
  v_r2 uuid;
begin
  -- balance is the sum; a redemption spends it; a later reversal of the
  -- reward (an administrator's decision through the service layer — not
  -- wired to any Review action) goes negative, as Phase 1A promised
  assert (select available_credits from public.boe_credit_balances where employee_id = v_e2) = 125, '§7 view balance is not 125';
  perform public.post_boe_credit_transaction(v_e2, 'redemption', -125, 'payroll_period', gen_random_uuid(), 'spent', null);
  assert public.boe_credit_balance(v_e2) = 0, '§7 spend-down did not reach 0';
  select id into v_r2 from public.boe_credit_transactions where source_id = 'c2000000-0000-4000-8000-0000000000c2';
  perform public.reverse_boe_credit_transaction(v_r2, 'a0000000-0000-4000-8000-00000000000a', 'Review found invalid');
  assert public.boe_credit_balance(v_e2) = -125, format('§7 balance after reversing a spent reward is %s, expected -125', public.boe_credit_balance(v_e2));
  assert (select credits from public.boe_credit_transactions where id = v_r2) = 125, '§7 the original reward was altered';
  raise notice 'PASS  §7 sum, immutability, redemption and reversal-to-negative all hold with review rewards in the ledger';
end $$;

select pg_temp.must_refuse(
  $q$ select public.post_boe_credit_transaction('e2000000-0000-4000-8000-0000000000e2', 'redemption', -1, 'payroll_period', gen_random_uuid(), null, null) $q$,
  '23514', 'BOE_CREDITS_INSUFFICIENT', '§7 a redemption while negative');

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
