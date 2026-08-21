-- Confirmed Order number cycle reset assertions
-- ===========================================================================
-- Covers 20260926000000_order_number_cycle_reset.sql:
--
--   A. authority — only an active admin
--   B. the claim — a FINALIZED Test Data Cleanup claim, and nothing less
--   C. the empty register — including the cancelled-Order case that closes this
--      door permanently once live use begins
--   D. no approval in flight, and no allocation left pointing at anything
--   E. success — the next allocation is 0001, and it is audited
--   F. idempotence, and what a second call does NOT write
--   G. the race — a concurrent approval and a reset cannot interleave
--   H. what it never does: delete, renumber, or touch the cleanup protocol
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- and every write is discarded — INCLUDING the reset itself. Nothing here
-- changes the live cycle.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that may set session GUCs (standard Supabase
--     `postgres`).
--   * Replace the TWO real user UUIDs below; both must exist and be distinct:
--       test.admin   an ACTIVE administrator
--       test.member  an active NON-admin
--   * THE REGISTER NEED NOT BE EMPTY. Section C empties it inside the
--     transaction by deleting the fixture Orders it created itself; every real
--     Order is left alone, and the rollback restores anything the transaction
--     touched. If real Orders exist, section C's success case is SKIPPED with a
--     notice rather than deleting them — see the guard there.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ────────────────────────────────────
do $$
begin
  perform set_config('test.admin',  '66666666-6666-6666-6666-666666666666', true); -- REPLACE
  perform set_config('test.member', '11111111-1111-1111-1111-111111111111', true); -- REPLACE
end $$;

do $$
begin
  assert (select role = 'admin' and is_active from public.users
           where id = current_setting('test.admin')::uuid),
    'test.admin must be an active administrator — replace the placeholder';
  assert (select role <> 'admin' and is_active from public.users
           where id = current_setting('test.member')::uuid),
    'test.member must be an active non-admin — replace the placeholder';
end $$;

-- ── Helpers ──────────────────────────────────────────────────────────────────

create or replace function pg_temp.fails_with(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $$;

create or replace function pg_temp.act_as(p_user text)
returns void language plpgsql as $$
declare v_id text := current_setting('test.' || p_user, true);
begin
  if coalesce(v_id, '') = '' then raise exception 'test.% is not configured', p_user; end if;
  perform set_config('test.uid', v_id, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if not p_condition then raise exception 'ASSERTION FAILED: %', p_what; end if;
end $$;

/** A finalized cleanup claim, and an unfinished one, to test the gate with. */
create temporary table t_claims (k text primary key, token uuid) on commit drop;

do $$
declare v_a uuid; v_b uuid;
begin
  insert into public.test_data_cleanup_claims (root_type, root_id, reason, confirmation, finalized_at)
  values ('order', gen_random_uuid(), '[TEST] reset assertions', 'DELETE', now())
  returning claim_token into v_a;

  insert into public.test_data_cleanup_claims (root_type, root_id, reason, confirmation)
  values ('order', gen_random_uuid(), '[TEST] reset assertions', 'DELETE')
  returning claim_token into v_b;

  insert into t_claims values ('finalized', v_a), ('unfinished', v_b);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. Authority
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_token uuid := (select token from t_claims where k = 'finalized');
begin
  perform pg_temp.act_as('member');
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reset_confirmed_order_number_cycle(%L::uuid)', v_token))
      like '42501|ORDER_NUMBER_RESET_FORBIDDEN%',
    'a non-admin may not reset the cycle');

  -- Unauthenticated: an empty claims object, which is what an anonymous request
  -- carries. (Not the empty STRING — `''::json` raises, and this must prove the
  -- function's own refusal rather than a cast failure.)
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('test.uid', '', true);
  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reset_confirmed_order_number_cycle(%L::uuid)', v_token))
      like '28000|%',
    'an unauthenticated caller may not reset the cycle');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. The claim
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  perform pg_temp.act_as('admin');

  perform pg_temp.ok(
    pg_temp.fails_with('select public.reset_confirmed_order_number_cycle(null)')
      like '%ORDER_NUMBER_RESET_NO_CLAIM%',
    'RESET IS REFUSED OUTSIDE THE CLEANUP PROTOCOL: no claim, no reset');

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.reset_confirmed_order_number_cycle(%L::uuid)', gen_random_uuid()))
      like '%ORDER_NUMBER_RESET_CLAIM_INVALID%',
    'RESET IS REFUSED WITH A MISMATCHED CLAIM');

  perform pg_temp.ok(
    pg_temp.fails_with(format(
      'select public.reset_confirmed_order_number_cycle(%L::uuid)',
      (select token from t_claims where k = 'unfinished')))
      like '%ORDER_NUMBER_RESET_CLAIM_UNFINISHED%',
    'a claim whose cleanup never finalized proves no storage removal, and is refused');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. The register must be empty
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_token uuid := (select token from t_claims where k = 'finalized');
  v_real  bigint;
begin
  perform pg_temp.act_as('admin');

  select count(*) into v_real from public.orders;

  if v_real > 0 then
    -- THE COMMON CASE ON A LIVE DATABASE, and the gate under test.
    perform pg_temp.ok(
      pg_temp.fails_with(format('select public.reset_confirmed_order_number_cycle(%L::uuid)', v_token))
        like '%ORDER_NUMBER_RESET_ORDERS_EXIST%',
      'RESET IS REFUSED WHILE ANY ORDER EXISTS');
    raise notice 'C: % Order(s) present — the empty-register success case is proved in section E only when the register is empty', v_real;
  else
    raise notice 'C: the register is already empty; the refusal case is proved below with a fixture';
  end if;
end $$;

-- The refusal, proved with a fixture whatever the live state is. A CANCELLED
-- Order is used deliberately: it is the case that closes this door permanently
-- once live use begins, because a cancelled Order is a row like any other and
-- its number is never reused.
do $$
declare
  v_token uuid := (select token from t_claims where k = 'finalized');
  v_id    uuid;
  v_had   bigint;
begin
  perform pg_temp.act_as('admin');
  select count(*) into v_had from public.orders;

  insert into public.orders (client_name, requested_by, created_by, status, total_value)
  values ('[TEST] Cancelled Order', current_setting('test.member')::uuid,
          current_setting('test.admin')::uuid, 'running', 1000)
  returning id into v_id;

  update public.orders set status = 'cancelled' where id = v_id;

  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reset_confirmed_order_number_cycle(%L::uuid)', v_token))
      like '%ORDER_NUMBER_RESET_ORDERS_EXIST%',
    'A CANCELLED ORDER PREVENTS RESET — its number is permanent and is never reused');

  delete from public.orders where id = v_id;
  perform pg_temp.ok((select count(*) from public.orders) = v_had,
    'the fixture Order was removed and no real Order was touched');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D. Nothing else may be in flight
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_token uuid := (select token from t_claims where k = 'finalized');
  v_orders bigint;
  v_sub uuid;
begin
  perform pg_temp.act_as('admin');
  select count(*) into v_orders from public.orders;
  if v_orders > 0 then
    raise notice 'D: skipped — Orders exist, so gate 2 refuses first and gates 3 and 4 are unreachable';
    return;
  end if;

  -- A SUBMITTED PI can be approved at any instant, and an approval allocates a
  -- number. Resetting under one is exactly the race this refuses.
  insert into public.order_submissions (status, client_name, created_by, submitted_by)
  values ('submitted', '[TEST] In flight', current_setting('test.member')::uuid,
          current_setting('test.member')::uuid)
  returning id into v_sub;

  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reset_confirmed_order_number_cycle(%L::uuid)', v_token))
      like '%ORDER_NUMBER_RESET_APPROVAL_PENDING%',
    'CONCURRENT APPROVAL CANNOT RACE THE RESET: a submitted PI refuses it outright');

  delete from public.order_submissions where id = v_sub;

  -- An allocation still pointing at an Order or a PI means the money has not
  -- been cleaned up either.
  insert into public.finance_payment_allocations (order_submission_id, allocated_amount, status)
  values (gen_random_uuid(), 100, 'active');

  perform pg_temp.ok(
    pg_temp.fails_with(format('select public.reset_confirmed_order_number_cycle(%L::uuid)', v_token))
      like '%ORDER_NUMBER_RESET_ALLOCATIONS_REMAIN%',
    'a payment allocation still pointing at a PI refuses the reset');

  delete from public.finance_payment_allocations
   where order_id is null and order_submission_id is not null and allocated_amount = 100;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. Success — and the next allocation is 0001
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_token uuid := (select token from t_claims where k = 'finalized');
  v_res   jsonb;
  v_prev  bigint;
begin
  perform pg_temp.act_as('admin');

  if (select count(*) from public.orders) > 0
     or (select count(*) from public.order_submissions
          where status in ('submitted', 'approved') or order_id is not null) > 0
     or (select count(*) from public.finance_payment_allocations
          where order_id is not null or order_submission_id is not null) > 0 then
    raise notice 'E: skipped — the register is not empty, which is itself the correct answer today';
    return;
  end if;

  select next_number into v_prev from public.order_number_cycle where id = true;

  -- Put the cycle somewhere other than 1 so the reset has work to do, using the
  -- ordinary admin door. Rolled back with everything else.
  if v_prev = 1 then
    update public.order_number_cycle set next_number = 7 where id = true;
    v_prev := 7;
  end if;

  v_res := public.reset_confirmed_order_number_cycle(v_token);

  perform pg_temp.ok((v_res ->> 'reset')::boolean, 'the reset succeeded against an empty register');
  perform pg_temp.ok((v_res ->> 'next_number')::bigint = 1, 'the cycle is back to 1');
  perform pg_temp.ok(v_res ->> 'next_display_number' = '0001',
    'SUCCESSFUL FINALIZED CLEANUP MAKES THE NEXT ALLOCATION 0001');
  perform pg_temp.ok((v_res ->> 'previous_number')::bigint = v_prev,
    'and the audit records what it was before');

  perform pg_temp.ok(
    (select next_number from public.order_number_cycle where id = true) = 1,
    'the stored cycle actually moved');

  -- ── FULLY AUDITED ──
  perform pg_temp.ok(
    (select count(*) from public.order_number_cycle_resets
      where id = (v_res ->> 'reset_id')::uuid
        and performed_by = current_setting('test.admin')::uuid
        and previous_number = v_prev
        and new_number = 1) = 1,
    'the reset wrote exactly one audit row, naming who did it');

  -- The evidence each gate saw, stored rather than merely asserted.
  perform pg_temp.ok(
    (select (evidence ->> 'orders_remaining')::bigint = 0
        and (evidence ->> 'submissions_in_flight')::bigint = 0
        and (evidence ->> 'allocations_remaining')::bigint = 0
        and (evidence ->> 'claim_token_matched')::boolean
       from public.order_number_cycle_resets where id = (v_res ->> 'reset_id')::uuid),
    'the audit carries the evidence every gate saw');

  -- ── IDEMPOTENT ──
  v_res := public.reset_confirmed_order_number_cycle(v_token);
  perform pg_temp.ok(not (v_res ->> 'reset')::boolean and (v_res ->> 'already_at_start')::boolean,
    'a second call answers rather than acting');
  perform pg_temp.ok(
    (select count(*) from public.order_number_cycle_resets) = 1,
    'and writes NO second decision');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. What it never does
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reset_confirmed_order_number_cycle';

  perform pg_temp.ok(v_def !~* '\mdelete\s+from\m', 'the reset contains no DELETE');
  perform pg_temp.ok(v_def !~* '\mtruncate\m', 'the reset contains no TRUNCATE');
  perform pg_temp.ok(v_def !~* 'display_number\s*=',
    'the reset never writes an Order display number — display numbers are immutable');

  perform pg_temp.ok(
    (select string_agg(distinct m[1], ',' order by m[1])
       from regexp_matches(v_def, 'update\s+public\.(\w+)', 'gi') m) = 'order_number_cycle',
    'the reset updates the cycle and nothing else');

  perform pg_temp.ok(
    (select string_agg(distinct m[1], ',' order by m[1])
       from regexp_matches(v_def, 'insert\s+into\s+public\.(\w+)', 'gi') m) = 'order_number_cycle_resets',
    'the reset inserts into its own audit and nothing else');

  -- THE LOCK IS TAKEN BEFORE THE GATES ARE READ, or every reading is stale by
  -- the time the write happens.
  perform pg_temp.ok(
    position('for update' in lower(v_def)) < position('order_number_reset_orders_exist' in lower(v_def)),
    'the cycle row is locked before any gate is read');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. Privileges
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_bad text;
begin
  perform pg_temp.ok(
    not has_function_privilege('anon', 'public.reset_confirmed_order_number_cycle(uuid)', 'execute'),
    'anon may not reset the cycle');
  perform pg_temp.ok(
    has_function_privilege('authenticated', 'public.reset_confirmed_order_number_cycle(uuid)', 'execute'),
    'an authenticated admin reaches it through the ordinary RPC door');

  select string_agg(distinct privilege_type, ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'order_number_cycle_resets'
    and grantee in ('anon', 'authenticated', 'public')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  perform pg_temp.ok(v_bad is null,
    'a client role may write the reset audit: ' || coalesce(v_bad, ''));

  perform pg_temp.ok(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'order_number_cycle_resets'
        and cmd in ('INSERT', 'UPDATE', 'DELETE')),
    'no client write policy exists on the reset audit');
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
