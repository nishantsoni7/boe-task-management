-- PAYMENT CLASSIFICATION assertions — worked examples A–O
-- ===========================================================================
-- Proves, in the database and against real rows, the ONE classification both
-- Order Management and Finance read:
--
--   All Payments          every payment that is not rejected
--   Linked to Orders      is_linked_to_order — money attributed to Orders
--   Linked to PI Drafts   is_linked_to_pi    — money attributed to PI Drafts
--   Available to Allocate is_available_to_allocate — a positive balance
--
-- and the four properties the business decision names:
--
--   * a payment split between an Order and a PI appears in BOTH linked views;
--   * `Available` includes PARTIALLY allocated money, not only untouched money;
--   * an over-allocated historical payment stays visible and is never capped;
--   * rejected money is in no view at all.
--
-- IT IS THE SAME RULE, NOT A SECOND ONE. Every figure comes from the canonical
-- attribution rule (PR #49): active allocations are authoritative whenever any
-- exists, the payment's own order_id is the fallback only when none does, and a
-- reversed allocation counts for nothing. The two kind totals must sum to
-- `attributed_total` exactly — the assertion that would catch a second formula
-- creeping in — and A–H below are the attribution suite's own fixtures, so the
-- classification cannot be proved against a scenario the attribution rule does
-- not also answer.
--
-- THE SAME FIXTURES run on the TypeScript side, from
-- src/lib/finance/classificationFixtures.ts, and
-- src/lib/finance/classificationParity.test.ts requires this file to carry every
-- one of them with the same figures.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * psql as a role that bypasses RLS.
--   * 20261004000000, 20261005000000, 20261007000000 and 20261008000000 applied.
--   * at least one public.order_submissions row, to allocate PI money against.
--   * at least one public.users row to act as; and for case O to run rather than
--     skip, a second non-admin, non-deleted user to read as.
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- Throwaway targets. Real Order rows, because the allocation FK requires them.
--
-- NO source_order_request_id ANYWHERE: 20261007000000's provenance guard refuses
-- a new Order that carries one, and these fixtures are new Orders.
insert into public.orders (id, display_number)
values ('0e000000-0000-4000-8000-0000000000ca', 'ASSERT-CLS-ORDER-X'),
       ('0e000000-0000-4000-8000-0000000000cb', 'ASSERT-CLS-ORDER-Y')
on conflict (id) do nothing;

-- ═══ The fixtures ═══════════════════════════════════════════════════════════
--
-- Inserted directly rather than through the RPCs, because several of these
-- states cannot be CREATED through them any more — F is refused by the capacity
-- trigger — and the point is to prove the READ is right about data that exists,
-- however it came to.

do $$
declare
  v_x     uuid := '0e000000-0000-4000-8000-0000000000ca';
  v_y     uuid := '0e000000-0000-4000-8000-0000000000cb';
  v_pi    uuid;
  v_actor uuid;
begin
  select id into v_actor from public.users limit 1;
  select id into v_pi from public.order_submissions limit 1;
  if v_pi is null then
    raise exception 'this suite needs at least one order_submissions row to allocate against';
  end if;

  -- READ AS THE SUBMITTER. `available_balance` is NULL unless the caller's sight
  -- of the allocation table is complete for that payment, and a psql session with
  -- no JWT claim has auth.uid() NULL, so every balance below would come back NULL
  -- and A-N would be asserting nothing. Every fixture is submitted by v_actor, so
  -- claiming that identity is the smallest thing that makes the reads honest —
  -- and it is a claim, not a grant: section O drops it again and proves an
  -- incomplete reader is still told nothing.
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  perform set_config('test.cls_x',  v_x::text,     true);
  perform set_config('test.cls_y',  v_y::text,     true);
  perform set_config('test.cls_pi', v_pi::text,    true);
  perform set_config('test.cls_actor', v_actor::text, true);

  insert into public.finance_payment_requests
    (id, client_name, amount, payment_date, payment_mode, status, submitted_by, order_id, is_test_data)
  values
    -- A–H: the canonical attribution fixtures.
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'CLS A', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, v_x,  true),
    ('bbbbbbbb-0000-0000-0000-00000000000b', 'CLS B', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, v_x,  true),
    ('cccccccc-0000-0000-0000-00000000000c', 'CLS C', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, v_x,  true),
    ('dddddddd-0000-0000-0000-00000000000d', 'CLS D', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, v_x,  true),
    ('eeeeeeee-0000-0000-0000-00000000000e', 'CLS E', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, v_x,  true),
    ('ffffffff-0000-0000-0000-00000000000f', 'CLS F', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, null, true),
    ('99999999-0000-0000-0000-000000000009', 'CLS G', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, v_x,  true),
    ('88888888-0000-0000-0000-000000000008', 'CLS H', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, null, true),
    -- I: fully PI-linked.
    ('11111111-0000-0000-0000-000000000011', 'CLS I',  500000.00, current_date, 'upi', 'approved_unlinked', v_actor, null, true),
    -- J: the mixed Order/PI split, with money left over.
    ('22222222-0000-0000-0000-000000000022', 'CLS J', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, null, true),
    -- K: nothing points at it.
    ('33333333-0000-0000-0000-000000000033', 'CLS K',  250000.00, current_date, 'upi', 'approved_unlinked', v_actor, null, true),
    -- L: awaiting verification, partly allocated.
    ('44444444-0000-0000-0000-000000000044', 'CLS L',  400000.00, current_date, 'upi', 'pending_approval',  v_actor, null, true),
    -- M: rejected. Not money.
    ('55555555-0000-0000-0000-000000000055', 'CLS M',  900000.00, current_date, 'upi', 'rejected',          v_actor, null, true),
    -- N: paise, and a split that only balances in exact decimal arithmetic.
    ('66666666-0000-0000-0000-000000000066', 'CLS N',    1000.03, current_date, 'upi', 'approved_linked',   v_actor, null, true),
    -- O: the incomplete reader's payment. Its own figures are complete here;
    --    what O proves is asserted from a non-privileged session further down.
    ('77777777-0000-0000-0000-000000000077', 'CLS O', 1000000.00, current_date, 'upi', 'approved_unlinked', v_actor, null, true);

  -- B: ₹5L actively allocated to the SAME Order the link names.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('bbbbbbbb-0000-0000-0000-00000000000b', v_x, 500000.00, 'active', 'confirmed_order', v_actor, true);

  -- C: ₹4L actively allocated to a DIFFERENT Order. The direct link is overridden.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('cccccccc-0000-0000-0000-00000000000c', v_y, 400000.00, 'active', 'confirmed_order', v_actor, true);

  -- D: split ₹4L / ₹6L across both Orders, summing to the payment exactly.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('dddddddd-0000-0000-0000-00000000000d', v_x, 400000.00, 'active', 'confirmed_order', v_actor, true),
         ('dddddddd-0000-0000-0000-00000000000d', v_y, 600000.00, 'active', 'confirmed_order', v_actor, true);

  -- E: a REVERSED allocation is the only allocation, so the link still applies.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type,
     created_by, reversed_by, reversed_at, reversal_reason, is_test_data)
  values ('eeeeeeee-0000-0000-0000-00000000000e', v_y, 400000.00, 'reversed', 'confirmed_order',
          v_actor, v_actor, now(), 'assertion fixture', true);

  -- G: legacy-linked to an Order, actively allocated to a PI. The Order is
  --    overridden exactly as it is in C, so G is PI money, not Order money.
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('99999999-0000-0000-0000-000000000009', v_pi, 250000.00, 'active', 'order_submission', v_actor, true);

  -- H: a corrected allocation — the reversed row stays, only the active counts.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type,
     created_by, reversed_by, reversed_at, reversal_reason, is_test_data)
  values ('88888888-0000-0000-0000-000000000008', v_x, 900000.00, 'reversed', 'confirmed_order',
          v_actor, v_actor, now(), 'assertion fixture', true);
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('88888888-0000-0000-0000-000000000008', v_y, 300000.00, 'active', 'confirmed_order', v_actor, true);

  -- I: fully PI-linked.
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('11111111-0000-0000-0000-000000000011', v_pi, 500000.00, 'active', 'order_submission', v_actor, true);

  -- J: THE MIXED CASE. ₹3L to an Order, ₹4.5L to a PI, ₹2.5L still free.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, order_submission_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('22222222-0000-0000-0000-000000000022', v_x,  null, 300000.00, 'active', 'confirmed_order',  v_actor, true),
         ('22222222-0000-0000-0000-000000000022', null, v_pi, 450000.00, 'active', 'order_submission', v_actor, true);

  -- L: awaiting verification, ₹1L of ₹4L allocated to an Order.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('44444444-0000-0000-0000-000000000044', v_x, 100000.00, 'active', 'confirmed_order', v_actor, true);

  -- N: paise. ₹333.34 to an Order, ₹333.33 to a PI, ₹333.36 free.
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, order_submission_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('66666666-0000-0000-0000-000000000066', v_x,  null, 333.34, 'active', 'confirmed_order',  v_actor, true),
         ('66666666-0000-0000-0000-000000000066', null, v_pi, 333.33, 'active', 'order_submission', v_actor, true);

  -- O: ₹2L allocated to a PI. A PI participant sees this one and no other.
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('77777777-0000-0000-0000-000000000077', v_pi, 200000.00, 'active', 'order_submission', v_actor, true);

  -- F: active allocations EXCEEDING the payment. The capacity trigger refuses to
  -- create this, so the insert is made with the trigger disabled — the state is
  -- legacy data and the READ must still describe it correctly.
  alter table public.finance_payment_allocations disable trigger user;
  insert into public.finance_payment_allocations
    (payment_request_id, order_id, allocated_amount, status, origin_target_type, created_by, is_test_data)
  values ('ffffffff-0000-0000-0000-00000000000f', v_x, 1500000.00, 'active', 'confirmed_order', v_actor, true);
  alter table public.finance_payment_allocations enable trigger user;
end $$;

-- ═══ A–N: every figure, row by row ══════════════════════════════════════════

do $$
declare
  r         record;
  v_label   text;
  v_order   numeric;
  v_pi      numeric;
  v_avail   numeric;
  v_count   int;
begin
  for r in
    select * from (values
      -- id                                       label  order_att    pi_att     available   count
      ('aaaaaaaa-0000-0000-0000-00000000000a', 'A', 1000000.00,       0.00,       0.00,  0),
      ('bbbbbbbb-0000-0000-0000-00000000000b', 'B',  500000.00,       0.00,  500000.00,  1),
      ('cccccccc-0000-0000-0000-00000000000c', 'C',  400000.00,       0.00,  600000.00,  1),
      ('dddddddd-0000-0000-0000-00000000000d', 'D', 1000000.00,       0.00,       0.00,  2),
      ('eeeeeeee-0000-0000-0000-00000000000e', 'E', 1000000.00,       0.00,       0.00,  0),
      ('99999999-0000-0000-0000-000000000009', 'G',       0.00,  250000.00,  750000.00,  1),
      ('88888888-0000-0000-0000-000000000008', 'H',  300000.00,       0.00,  700000.00,  1),
      ('11111111-0000-0000-0000-000000000011', 'I',       0.00,  500000.00,       0.00,  1),
      ('22222222-0000-0000-0000-000000000022', 'J',  300000.00,  450000.00,  250000.00,  2),
      ('33333333-0000-0000-0000-000000000033', 'K',       0.00,       0.00,  250000.00,  0),
      ('44444444-0000-0000-0000-000000000044', 'L',  100000.00,       0.00,  300000.00,  1),
      ('55555555-0000-0000-0000-000000000055', 'M',       0.00,       0.00,  900000.00,  0),
      ('66666666-0000-0000-0000-000000000066', 'N',     333.34,     333.33,     333.36,  2)
    ) as t(id, label, order_att, pi_att, available, alloc_count)
  loop
    select p.order_attributed_total, p.pi_attributed_total, p.available_balance,
           p.active_allocation_count
      into v_order, v_pi, v_avail, v_count
    from public.finance_received_payments p
    where p.id = r.id::uuid;

    if v_order is distinct from r.order_att then
      raise exception '%: order_attributed_total expected %, got %', r.label, r.order_att, v_order;
    end if;
    if v_pi is distinct from r.pi_att then
      raise exception '%: pi_attributed_total expected %, got %', r.label, r.pi_att, v_pi;
    end if;
    if v_avail is distinct from r.available then
      raise exception '%: available_balance expected %, got %', r.label, r.available, v_avail;
    end if;
    if v_count is distinct from r.alloc_count then
      raise exception '%: active_allocation_count expected %, got % (a reversed allocation must not count)',
        r.label, r.alloc_count, v_count;
    end if;
  end loop;

  raise notice 'A-N figures pass';
end $$;

-- ═══ F: the historical over-allocation stays visible and uncapped ═══════════

do $$
declare
  v_att   numeric;
  v_avail numeric;
  v_state text;
begin
  select attributed_total, available_balance, allocation_state
    into v_att, v_avail, v_state
  from public.finance_received_payments
  where id = 'ffffffff-0000-0000-0000-00000000000f';

  if v_state <> 'over' then
    raise exception 'F: expected allocation_state over, got %', v_state;
  end if;
  if v_att <> 1500000.00 then
    raise exception 'F: the over-allocation was silently capped to %', v_att;
  end if;
  -- No balance to offer: floored at zero, never negative.
  if v_avail <> 0.00 then
    raise exception 'F: an over-allocated payment must offer no balance, got %', v_avail;
  end if;
  if (select is_available_to_allocate from public.finance_received_payments
       where id = 'ffffffff-0000-0000-0000-00000000000f') then
    raise exception 'F: an over-allocated payment must not appear in Available';
  end if;

  raise notice 'F: over-allocation is visible, uncapped, and offers nothing to allocate';
end $$;

-- ═══ The four views, as narrowings ══════════════════════════════════════════

do $$
declare
  r       record;
  v_o     boolean;
  v_p     boolean;
  v_a     boolean;
begin
  for r in
    select * from (values
      -- id                                       label  orders  pi     available
      ('aaaaaaaa-0000-0000-0000-00000000000a', 'A', true,  false, false),
      ('bbbbbbbb-0000-0000-0000-00000000000b', 'B', true,  false, true ),
      ('cccccccc-0000-0000-0000-00000000000c', 'C', true,  false, true ),
      ('dddddddd-0000-0000-0000-00000000000d', 'D', true,  false, false),
      ('eeeeeeee-0000-0000-0000-00000000000e', 'E', true,  false, false),
      ('ffffffff-0000-0000-0000-00000000000f', 'F', true,  false, false),
      ('99999999-0000-0000-0000-000000000009', 'G', false, true,  true ),
      ('88888888-0000-0000-0000-000000000008', 'H', true,  false, true ),
      ('11111111-0000-0000-0000-000000000011', 'I', false, true,  false),
      ('22222222-0000-0000-0000-000000000022', 'J', true,  true,  true ),
      ('33333333-0000-0000-0000-000000000033', 'K', false, false, true ),
      ('44444444-0000-0000-0000-000000000044', 'L', true,  false, true ),
      ('55555555-0000-0000-0000-000000000055', 'M', false, false, false),
      ('66666666-0000-0000-0000-000000000066', 'N', true,  true,  true )
    ) as t(id, label, in_orders, in_pi, in_available)
  loop
    select is_linked_to_order, is_linked_to_pi, is_available_to_allocate
      into v_o, v_p, v_a
    from public.finance_received_payments where id = r.id::uuid;

    if v_o is distinct from r.in_orders then
      raise exception '%: is_linked_to_order expected %, got %', r.label, r.in_orders, v_o;
    end if;
    if v_p is distinct from r.in_pi then
      raise exception '%: is_linked_to_pi expected %, got %', r.label, r.in_pi, v_p;
    end if;
    if v_a is distinct from r.in_available then
      raise exception '%: is_available_to_allocate expected %, got %', r.label, r.in_available, v_a;
    end if;
  end loop;

  raise notice 'the four views classify every fixture correctly';
end $$;

-- ═══ J: the mixed payment appears in BOTH linked views ══════════════════════
--
-- The case a single-bucket classification would have to lie about. Asserted on
-- its own because it is the reason the three narrowings are not a partition.

do $$
declare
  v_o boolean; v_p boolean; v_a boolean;
begin
  select is_linked_to_order, is_linked_to_pi, is_available_to_allocate
    into v_o, v_p, v_a
  from public.finance_received_payments
  where id = '22222222-0000-0000-0000-000000000022';

  if not (v_o and v_p and v_a) then
    raise exception
      'J: a payment split between an Order and a PI with money left over must appear in Orders, PI Drafts AND Available (got %/%/%)',
      v_o, v_p, v_a;
  end if;
  raise notice 'J: a mixed payment appears in every applicable view';
end $$;

-- ═══ M: rejected money is in no view ════════════════════════════════════════

do $$
begin
  if exists (
    select 1 from public.finance_received_payments
    where id = '55555555-0000-0000-0000-000000000055'
      and (is_linked_to_order or is_linked_to_pi or is_available_to_allocate)
  ) then
    raise exception 'M: a rejected payment must appear in no view';
  end if;
  raise notice 'M: rejected money is in no view';
end $$;

-- ═══ L: awaiting money classifies, and stays distinguishable ════════════════

do $$
declare
  v_status text;
begin
  select status into v_status from public.finance_received_payments
   where id = '44444444-0000-0000-0000-000000000044';
  if v_status <> 'pending_approval' then
    raise exception 'L: the verification state must remain readable on the row, got %', v_status;
  end if;
  if not (select is_linked_to_order and is_available_to_allocate
            from public.finance_received_payments
           where id = '44444444-0000-0000-0000-000000000044') then
    raise exception 'L: awaiting money is real money and must classify like any other';
  end if;
  raise notice 'L: awaiting-verification money classifies, and is still marked awaiting';
end $$;

-- ═══ N: exact decimal arithmetic ════════════════════════════════════════════
--
-- 1000.03 - 333.34 - 333.33 is 333.36 and nothing else. A float would give
-- 333.35999999999996 and a conservation check that never quite holds.

do $$
declare
  v_amount numeric; v_att numeric; v_avail numeric;
begin
  select amount, attributed_total, available_balance
    into v_amount, v_att, v_avail
  from public.finance_received_payments
  where id = '66666666-0000-0000-0000-000000000066';

  if v_att <> 666.67 then raise exception 'N: attributed expected 666.67, got %', v_att; end if;
  if v_avail <> 333.36 then raise exception 'N: available expected 333.36, got %', v_avail; end if;
  if v_att + v_avail <> v_amount then
    raise exception 'N: % + % <> %', v_att, v_avail, v_amount;
  end if;
  raise notice 'N: exact decimal arithmetic holds to the paisa';
end $$;

-- ═══ The kind split IS the attribution rule, not a second formula ═══════════
--
-- order_attributed_total + pi_attributed_total = attributed_total, for EVERY
-- payment in the database, not only the fixtures. This is the assertion that
-- catches a second formula creeping in.

do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
  from public.finance_received_payments
  where coalesce(order_attributed_total, 0) + coalesce(pi_attributed_total, 0)
        is distinct from coalesce(attributed_total, 0);

  if v_bad <> 0 then
    raise exception
      'the kind split disagrees with attributed_total on % payment(s): there are now two attribution formulas', v_bad;
  end if;
  raise notice 'the kind split sums to the canonical attributed total on every payment';
end $$;

-- ═══ Conservation ══════════════════════════════════════════════════════════
--
--     attributed  +  available  =  the payment amount
--
-- for every payment that is not over-allocated and whose balance is stated.

do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
  from public.finance_received_payments
  where available_balance is not null
    and amount is not null
    and allocation_state is distinct from 'over'
    and attributed_total + available_balance is distinct from amount;

  if v_bad <> 0 then
    raise exception 'conservation broken on % payment(s)', v_bad;
  end if;
  raise notice 'conservation holds on every payment whose balance is stated';
end $$;

-- ═══ O: the incomplete reader is told nothing rather than something wrong ═══
--
-- Read as a NON-PRIVILEGED session. A reader without company-wide Finance sight,
-- who did not submit the payment, must get available_balance = NULL — never a
-- number computed from a partial view of the allocations, which would OVERSTATE
-- the free balance and get the same rupees allocated twice.

do $$
declare
  v_outsider uuid;
begin
  select id into v_outsider
  from public.users
  where id <> current_setting('test.cls_actor')::uuid
    and coalesce(is_deleted, false) = false
    and role <> 'admin'
  limit 1;

  if v_outsider is null then
    raise notice 'O: skipped — no non-admin user to read as';
    perform set_config('test.cls_outsider', '', true);
  else
    perform set_config('test.cls_outsider', v_outsider::text, true);
  end if;
end $$;

do $$
declare
  v_outsider text := current_setting('test.cls_outsider', true);
  v_complete boolean;
  v_avail    numeric;
begin
  if coalesce(v_outsider, '') = '' then
    raise notice 'O: skipped';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_outsider, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);

  -- Read the completeness flag as that session. The view is security_invoker, so
  -- this is exactly what that reader would compute.
  select coalesce(
           coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
           or f.submitted_by = auth.uid(),
           false),
         case
           when coalesce(
                  coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
                  or f.submitted_by = auth.uid(),
                  false)
             then greatest(f.amount - 0, 0)
           else null::numeric
         end
    into v_complete, v_avail
  from public.finance_payment_requests f
  where f.id = '77777777-0000-0000-0000-000000000077';

  if v_complete then
    raise notice 'O: skipped — the chosen reader turns out to hold company-wide Finance sight';
  elsif v_avail is not null then
    raise exception
      'O: an incomplete reader was given a balance of % instead of NULL; free money would be overstated', v_avail;
  else
    raise notice 'O: an incomplete reader is told nothing rather than something wrong';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ═══ The projection is still SECURITY INVOKER and still SELECT-only ═════════

do $$
declare
  v_opt text;
begin
  select coalesce(
           (select option_value from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'),
           'false')
    into v_opt
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'finance_received_payments';

  if v_opt is distinct from 'true' then
    raise exception 'finance_received_payments must be security_invoker (found "%")', v_opt;
  end if;

  if has_table_privilege('authenticated', 'public.finance_received_payments', 'insert')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'update')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'delete') then
    raise exception 'authenticated must hold SELECT only on finance_received_payments';
  end if;

  raise notice 'the projection is invoker-scoped and read-only';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
