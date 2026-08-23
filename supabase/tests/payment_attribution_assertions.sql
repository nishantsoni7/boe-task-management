-- PAYMENT ATTRIBUTION assertions — worked examples A–F
-- ===========================================================================
-- Proves the canonical attribution rule, in the database, against real rows:
--
--   1. If a payment has ANY active allocation, allocations are authoritative.
--      Each Order or PI receives only its own active allocated share, and the
--      payment's direct order_id is ignored entirely — including when it names
--      the same Order.
--   2. If it has NO active allocation, the direct linkage attributes the WHOLE
--      payment to the Order it names.
--   3. Reversed allocations are withdrawn claims and count for nothing.
--   4. What is left after active allocations is unallocated.
--   5. Attribution summed across every target, plus what is unallocated, is
--      exactly the payment amount — never more.
--
-- THE DEFECT THIS EXISTS TO PREVENT RETURNING
-- -------------------------------------------
-- The rule used to be "the legacy link wins": a payment carrying order_id = X
-- was credited to X at its FULL amount whatever its allocations said. Both can
-- exist — allocate_payment_to_target() does not refuse a payment that already
-- carries an order_id — so a ₹10,00,000 payment linked to X and allocated
-- ₹4,00,000 to Y was credited ₹10,00,000 to X *and* ₹4,00,000 to Y. ₹14,00,000
-- of attribution for ₹10,00,000 of money, with the whole overstatement landing
-- on the Order that had received nothing. Example C is that case.
--
-- THE SAME FIXTURES run on the TypeScript side, from
-- src/lib/finance/attributionFixtures.ts, and
-- src/lib/finance/attributionParity.test.ts requires this file to carry every
-- one of them with the same figures. The two implementations are therefore
-- compared on identical data rather than on two similar-looking scenarios.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * psql as a role that bypasses RLS.
--   * 20261004000000 and 20261005000000 applied.
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- Throwaway targets. Real Order rows, because the allocation FK requires them.
insert into public.orders (id, display_number)
values ('0e000000-0000-4000-8000-00000000000a', 'ASSERT-ORDER-X'),
       ('0e000000-0000-4000-8000-00000000000b', 'ASSERT-ORDER-Y')
on conflict (id) do nothing;

-- ═══ The fixtures ═══════════════════════════════════════════════════════════
--
-- Six payments of ₹10,00,000, differing only in how they are attached. Inserted
-- directly rather than through the RPCs, because several of these states cannot
-- be CREATED through them any more — example F in particular is refused by the
-- capacity trigger — and the point is to prove the READ is right about data that
-- exists, however it came to.

do $$
declare
  v_x   uuid := '0e000000-0000-4000-8000-00000000000a';
  v_y   uuid := '0e000000-0000-4000-8000-00000000000b';
  v_pi  uuid;
  v_actor uuid;
begin
  select id into v_actor from public.users limit 1;
  select id into v_pi from public.order_submissions limit 1;

  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, status, submitted_by, order_id, is_test_data)
  values
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'ASSERT A', 1000000.00, current_date, 'upi', 'approved_linked',   v_actor, v_x,  true),
    ('bbbbbbbb-0000-0000-0000-00000000000b', 'ASSERT B', 1000000.00, current_date, 'upi', 'approved_linked',   v_actor, v_x,  true),
    ('cccccccc-0000-0000-0000-00000000000c', 'ASSERT C', 1000000.00, current_date, 'upi', 'approved_linked',   v_actor, v_x,  true),
    ('dddddddd-0000-0000-0000-00000000000d', 'ASSERT D', 1000000.00, current_date, 'upi', 'approved_linked',   v_actor, v_x,  true),
    ('eeeeeeee-0000-0000-0000-00000000000e', 'ASSERT E', 1000000.00, current_date, 'upi', 'approved_linked',   v_actor, v_x,  true),
    ('ffffffff-0000-0000-0000-00000000000f', 'ASSERT F', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, null, true);

  -- B: ₹5L actively allocated to the SAME Order the link names.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('bbbbbbbb-0000-0000-0000-00000000000b', v_x, 500000.00, 'active', 'order', v_actor, true);

  -- C: ₹4L actively allocated to a DIFFERENT Order. THE HEADLINE CASE.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('cccccccc-0000-0000-0000-00000000000c', v_y, 400000.00, 'active', 'order', v_actor, true);

  -- D: split ₹4L / ₹6L across both, summing to the payment exactly.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('dddddddd-0000-0000-0000-00000000000d', v_x, 400000.00, 'active', 'order', v_actor, true),
         ('dddddddd-0000-0000-0000-00000000000d', v_y, 600000.00, 'active', 'order', v_actor, true);

  -- E: a REVERSED allocation is the only allocation, so the link still applies.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type,
     created_by, reversed_by, reversed_at, reversal_reason, is_test_data)
  values ('eeeeeeee-0000-0000-0000-00000000000e', v_y, 400000.00, 'reversed', 'order',
          v_actor, v_actor, now(), 'assertion fixture', true);

  -- F: active allocations EXCEEDING the payment. The capacity trigger refuses to
  -- create this, so the insert is made with the trigger disabled — the state is
  -- legacy data and the READ must still describe it correctly.
  alter table public.finance_payment_allocations disable trigger user;
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('ffffffff-0000-0000-0000-00000000000f', v_x, 1500000.00, 'active', 'order', v_actor, true);
  alter table public.finance_payment_allocations enable trigger user;

  perform set_config('test.x', v_x::text, true);
  perform set_config('test.y', v_y::text, true);
end $$;

-- ═══ A–F: what each Order is attributed ═════════════════════════════════════

do $$
declare
  v_x uuid := current_setting('test.x')::uuid;
  v_y uuid := current_setting('test.y')::uuid;
  v_got numeric;
begin
  -- A. ₹10L linked to X, no active allocations → X gets ₹10L.
  select coalesce(sum(case when act.t > 0 then own.t else f.amount end), 0) into v_got
  from public.finance_payment_requests f
  cross join lateral (select coalesce(sum(a.allocated_amount),0) t from public.finance_payment_allocations a
                       where a.payment_request_id = f.id and a.status='active') act
  cross join lateral (select coalesce(sum(a.allocated_amount),0) t from public.finance_payment_allocations a
                       where a.payment_request_id = f.id and a.status='active' and a.order_id = v_x) own
  where f.id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if v_got <> 1000000.00 then raise exception 'A: expected 1000000.00, got %', v_got; end if;

  -- B. ₹5L allocated to the same Order → X gets ₹5L, NOT the legacy ₹10L.
  select coalesce(sum(case when act.t > 0 then own.t else f.amount end), 0) into v_got
  from public.finance_payment_requests f
  cross join lateral (select coalesce(sum(a.allocated_amount),0) t from public.finance_payment_allocations a
                       where a.payment_request_id = f.id and a.status='active') act
  cross join lateral (select coalesce(sum(a.allocated_amount),0) t from public.finance_payment_allocations a
                       where a.payment_request_id = f.id and a.status='active' and a.order_id = v_x) own
  where f.id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if v_got <> 500000.00 then raise exception 'B: expected 500000.00, got %', v_got; end if;

  raise notice 'A, B pass';
end $$;

-- The examples above are re-checked through the SHIPPED function below, which is
-- what the application actually calls. The inline form exists only to isolate
-- each case; if the two ever disagree, the shipped one is the answer that counts.

-- ═══ The shipped function, over the whole fixture set ═══════════════════════

do $$
declare
  v_x uuid := current_setting('test.x')::uuid;
  v_y uuid := current_setting('test.y')::uuid;
  v_x_total numeric;
  v_y_total numeric;
begin
  v_x_total := public.order_linked_payment_total(v_x);
  v_y_total := public.order_linked_payment_total(v_y);

  -- X: A ₹10L (legacy fallback) + B ₹5L (own allocation) + C ₹0 (overridden)
  --    + D ₹4L (own share) + E ₹10L (fallback, reversal ignored)
  --    + F ₹15L (over-allocation, preserved)
  if v_x_total <> 4400000.00 then
    raise exception 'Order X: expected 4400000.00, got %', v_x_total;
  end if;

  -- Y: C ₹4L + D ₹6L. E's reversed ₹4L must NOT appear.
  if v_y_total <> 1000000.00 then
    raise exception 'Order Y: expected 1000000.00, got %', v_y_total;
  end if;

  raise notice 'shipped function: X=% Y=%', v_x_total, v_y_total;
end $$;

-- ═══ C, specifically: the ₹14L that must never happen again ════════════════

do $$
declare
  v_x uuid := current_setting('test.x')::uuid;
  v_y uuid := current_setting('test.y')::uuid;
  v_x_share numeric;
  v_y_share numeric;
begin
  -- Isolate payment C by measuring the difference its removal makes.
  select public.order_linked_payment_total(v_x) into v_x_share;
  select public.order_linked_payment_total(v_y) into v_y_share;

  delete from public.finance_payment_allocations
   where payment_request_id = 'cccccccc-0000-0000-0000-00000000000c';
  delete from public.finance_payment_requests
   where id = 'cccccccc-0000-0000-0000-00000000000c';

  -- X must be UNCHANGED by C's removal: C contributed nothing to X, because its
  -- money went to Y. Under the old rule X would drop by ₹10,00,000.
  if public.order_linked_payment_total(v_x) <> v_x_share then
    raise exception
      'C: Order X changed by % when C was removed — the direct link is still being counted',
      v_x_share - public.order_linked_payment_total(v_x);
  end if;

  -- Y must drop by exactly C's allocation.
  if v_y_share - public.order_linked_payment_total(v_y) <> 400000.00 then
    raise exception 'C: Order Y should have dropped by 400000.00';
  end if;

  raise notice 'C: the direct link contributes nothing when the money is allocated elsewhere';
end $$;

-- ═══ Conservation ═══════════════════════════════════════════════════════════
--
-- For every payment that is not over-allocated:
--     attributed across every target  +  unallocated  =  the payment amount
--
-- Measured from the projection, which is where the application reads it.

do $$
declare
  r record;
  v_unallocated numeric;
begin
  for r in
    select id, amount, allocated_total, attributed_total, allocation_state
      from public.finance_received_payments
     where id::text in (
       'aaaaaaaa-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-00000000000b',
       'dddddddd-0000-0000-0000-00000000000d','eeeeeeee-0000-0000-0000-00000000000e',
       'ffffffff-0000-0000-0000-00000000000f')
  loop
    v_unallocated := greatest(r.amount - r.attributed_total, 0);

    if r.allocation_state = 'over' then
      -- F alone. The excess must remain VISIBLE, not rebalanced away.
      if r.attributed_total <= r.amount then
        raise exception 'over-allocation on % was silently capped', r.id;
      end if;
      continue;
    end if;

    if r.attributed_total + v_unallocated <> r.amount then
      raise exception
        'conservation broken on %: attributed % + unallocated % <> amount %',
        r.id, r.attributed_total, v_unallocated, r.amount;
    end if;
  end loop;

  raise notice 'conservation holds for every payment that is not over-allocated';
end $$;

-- ═══ The projection's own states ════════════════════════════════════════════

do $$
declare
  r record;
begin
  for r in select id, amount, allocated_total, attributed_total, allocation_state
             from public.finance_received_payments where id::text like 'aaaaaaaa%'
                or id::text like 'bbbbbbbb%' or id::text like 'ffffffff%'
  loop
    -- A: no allocations, but a direct link → attributed in FULL, not unallocated.
    if r.id::text like 'aaaaaaaa%' then
      if r.allocated_total <> 0 then raise exception 'A: allocated_total should be 0'; end if;
      if r.attributed_total <> r.amount then raise exception 'A: attributed_total should be the amount'; end if;
      if r.allocation_state <> 'full' then
        raise exception 'A: a linked payment with no allocations must read full, got %', r.allocation_state;
      end if;
    end if;
    -- B: allocations exist, so they decide.
    if r.id::text like 'bbbbbbbb%' and r.allocation_state <> 'partial' then
      raise exception 'B: expected partial, got %', r.allocation_state;
    end if;
    -- F: over stays over.
    if r.id::text like 'ffffffff%' and r.allocation_state <> 'over' then
      raise exception 'F: expected over, got %', r.allocation_state;
    end if;
  end loop;
  raise notice 'projection states: A=full B=partial F=over';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
