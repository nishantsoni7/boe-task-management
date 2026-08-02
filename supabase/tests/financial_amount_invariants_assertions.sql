-- Financial amount invariant assertions
-- ===========================================================================
-- Covers 20260805000000_financial_amount_invariants.sql.
--
-- TWO PARTS, and they are used at different moments:
--
--   PART 1  A read-only SURVEY of existing rows. Run this FIRST, on the real
--           database, before running any VALIDATE CONSTRAINT statement. It
--           lists every row that would make validation fail. It writes
--           nothing and takes no locks beyond a plain read.
--
--   PART 2  Assertions that the constraints actually refuse new bad writes.
--           Runs inside a transaction that ends in ROLLBACK.
--
-- PREREQUISITES: migrations applied; run with psql as `postgres`. Part 2 needs
-- one real active user UUID for the fixture rows.

\set ON_ERROR_STOP on

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — survey. Read-only. Anything listed must be corrected before the
-- VALIDATE CONSTRAINT statements at the foot of the migration are run.
-- ═══════════════════════════════════════════════════════════════════════════

\echo '--- Payments with a non-positive amount (must be empty) ---'
select id, request_number, client_name, amount, status, created_at
  from public.finance_payment_requests
 where amount is null or amount <= 0
 order by created_at;

\echo '--- Orders with a negative value (must be empty) ---'
select id, display_number, client_name, total_value, total_product_value, status
  from public.orders
 where total_value < 0 or total_product_value < 0
 order by display_number;

\echo '--- Order Requests with a negative value (must be empty) ---'
select id, request_number, client_name, total_value, total_product_value, status
  from public.order_requests
 where total_value < 0 or total_product_value < 0
 order by request_number;

-- Not a constraint, but the figure worth eyeballing at the same time: any
-- Confirmed Order whose approved receipts already exceed its value. These are
-- legitimate (an overpayment is a real event) — they are listed so the count is
-- known rather than discovered later.
\echo '--- Orders receipted above their value (informational) ---'
select o.display_number, o.client_name, o.status, o.total_value,
       sum(f.amount) as received,
       sum(f.amount) - coalesce(o.total_value, 0) as overpaid
  from public.orders o
  join public.finance_payment_requests f
    on f.order_id = o.id and f.status = 'approved_linked'
 group by o.id, o.display_number, o.client_name, o.status, o.total_value
having sum(f.amount) > coalesce(o.total_value, 0)
 order by overpaid desc;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — the constraints refuse new bad writes.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

do $$
begin
  perform set_config('test.sales_a', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
end $$;

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

do $$
declare
  v_err   text;
  v_order uuid;
begin
  -- A zero payment is not an event, and a negative one is not a payment.
  -- Both matter: order_linked_payment_total() sums this column, and
  -- convert_order_request_to_order() counts rows in it.
  for v_err in
    select pg_temp.fails_with(format(
      $q$insert into public.finance_payment_requests
           (client_name, amount, payment_date, payment_mode, received_in,
            proof_note, status, submitted_by)
         values ('QA invariant', %s, current_date, 'cash', 'cash_in_hand',
                 'QA', 'pending_approval', %L)$q$,
      amt, current_setting('test.sales_a')))
    from unnest(array['0', '-1', '-50000']) as amt
  loop
    assert v_err like '23514|%finance_payment_requests_amount_positive%',
      'a non-positive payment amount must be refused, got: ' || v_err;
  end loop;

  -- A positive one is accepted, so the constraint is not simply refusing
  -- everything — the half of this test that would otherwise pass vacuously.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     proof_note, status, submitted_by)
  values ('QA invariant', 1, current_date, 'cash', 'cash_in_hand',
          'QA', 'pending_approval', current_setting('test.sales_a')::uuid);

  -- Orders: negative refused, zero and NULL allowed.
  insert into public.orders (client_name, created_by, status, total_value)
  values ('QA invariant', current_setting('test.sales_a')::uuid, 'running', 0)
  returning id into v_order;

  insert into public.orders (client_name, created_by, status, total_value)
  values ('QA invariant null', current_setting('test.sales_a')::uuid, 'running', null);

  v_err := pg_temp.fails_with(format(
    $q$insert into public.orders (client_name, created_by, status, total_value)
       values ('QA invariant neg', %L, 'running', -1)$q$,
    current_setting('test.sales_a')));
  assert v_err like '23514|%orders_total_value_non_negative%',
    'a negative order value must be refused, got: ' || v_err;

  v_err := pg_temp.fails_with(format(
    $q$insert into public.orders (client_name, created_by, status, total_product_value)
       values ('QA invariant neg product', %L, 'running', -1)$q$,
    current_setting('test.sales_a')));
  assert v_err like '23514|%orders_total_product_value_non_negative%',
    'a negative product value must be refused, got: ' || v_err;

  raise notice 'PART 2: amount invariants OK';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
