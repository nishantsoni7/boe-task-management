-- Assertions for 20261014000000_payment_destination_display_modes_and_custody.sql
--
-- THREE CLAIMS UNDER TEST:
--
--   A. A payment SHOWS the record it is for — from its pending intent before
--      approval and from its active allocations after — and never from the
--      provenance columns that produced "New Order — no order created yet" for a
--      Confirmed Order that had just been allocated in full.
--   B. A new entry may use only HDFC, PNB, Paytm and Canara, and every
--      historical row stays readable and correctable.
--   C. PNB and Paytm carry an append-only custody trail that survives a mode
--      change, refuses an edit, and cannot be duplicated by a retry.
--
-- Every comparison is exact. Run through
-- run_payment_custody_and_modes_suite.sh, which applies the real migrations
-- first. One transaction, rolled back: nothing is left behind.

\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

-- The projection, for one payment, as one row. Named once so no assertion
-- rewrites the query and quietly tests something adjacent.
create or replace function pg_temp.dest(p_payment uuid)
returns public.finance_payment_destinations
language sql as $$
  select * from public.finance_payment_destinations where payment_request_id = p_payment;
$$;

-- ── Actors ───────────────────────────────────────────────────────────────────
insert into public.users (id, email, role, full_name) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test',    'admin',       'Admin'),
  ('22222222-2222-4222-8222-222222222222', 'sales@boe.test',    'salesperson', 'Sales'),
  ('33333333-3333-4333-8333-333333333333', 'nobody@boe.test',   'viewer',      'Nobody'),
  ('44444444-4444-4444-8444-444444444444', 'carrier@boe.test',  'salesperson', 'Carrier'),
  ('55555555-5555-4555-8555-555555555555', 'cashier@boe.test',  'salesperson', 'Cashier');

-- ── Targets ──────────────────────────────────────────────────────────────────
insert into public.orders (id, display_number, status, client_name, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'ORD-A', 'running', 'Kalyan Interiors', '11111111-1111-4111-8111-111111111111'),
  ('b0000000-0000-4000-8000-00000000000b', 'ORD-B', 'running', 'Menon Builders',   '11111111-1111-4111-8111-111111111111');

insert into public.order_submissions (id, client_name, status, created_by, source_order_number, source_workbook_name) values
  ('d0000000-0000-4000-8000-00000000000d', 'Kalyan Interiors', 'draft', '22222222-2222-4222-8222-222222222222', 'PI-4471', 'kalyan.xlsx'),
  ('e0000000-0000-4000-8000-00000000000e', 'Rao Associates',   'draft', '22222222-2222-4222-8222-222222222222', null,      'rao-quote.xlsx');

-- ── Module entry and the two protected actions the suite exercises ───────────
insert into public.finance_permission_grants (user_id, action) values
  ('22222222-2222-4222-8222-222222222222', 'finance.create'),
  ('22222222-2222-4222-8222-222222222222', 'finance.allocate');

do $$ begin perform pg_temp.act_as('11111111-1111-4111-8111-111111111111'); end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE DEFECT ITSELF — a Confirmed-Order request, before and after approval
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This is the production-shaped reproduction, replayed against the fix. Before
-- 20261014000000 the approved half of it read: status approved_unlinked, badge
-- "Order No. Pending", Order Number blank, Payment Against "New Order — no order
-- created yet". Every one of those came from a column that stopped being the
-- answer at 20261012000000.
do $$
declare
  v_res jsonb; v_pay uuid; v_d public.finance_payment_destinations;
  v_row public.finance_payment_requests%rowtype;
  v_allocs int; v_amount numeric;
begin
  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order',
    p_target_id   => 'a0000000-0000-4000-8000-00000000000a',
    p_amount      => 100000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  v_pay := (v_res->>'payment_request_id')::uuid;

  -- ── BEFORE APPROVAL: the destination comes from the pending INTENT ──
  v_d := pg_temp.dest(v_pay);
  if v_d.destination_source <> 'intent' then
    raise exception '1: a pending request must read its destination from its intent, got %', v_d.destination_source;
  end if;
  if v_d.destination_kind <> 'confirmed_order' then
    raise exception '1: a pending Confirmed-Order request must read confirmed_order, got %', v_d.destination_kind;
  end if;
  if v_d.destination_order_number <> 'ORD-A' then
    raise exception '1: the chosen Order must be shown BEFORE approval, got %', coalesce(v_d.destination_order_number, '<null>');
  end if;
  if v_d.destination_order_id <> 'a0000000-0000-4000-8000-00000000000a' then
    raise exception '1: wrong Order id before approval';
  end if;
  if v_d.destination_reference <> 'ORD-A' then
    raise exception '1: the reference must be the Order number, got %', coalesce(v_d.destination_reference, '<null>');
  end if;
  if v_d.destination_customer_count <> 1 then
    raise exception '1: one Order names one customer, got %', v_d.destination_customer_count;
  end if;

  -- THE ROW'S OWN PROVENANCE IS STILL 'unallocated' / 'new_order' — unchanged,
  -- and that is deliberate. What changed is that nothing reads it any more.
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.payment_target_type <> 'unallocated' or v_row.payment_against <> 'new_order' then
    raise exception '1: the provenance columns were rewritten (% / %) — 20261014000000 must not start writing money into them',
      v_row.payment_target_type, v_row.payment_against;
  end if;

  -- ── APPROVAL ──
  perform public.approve_finance_payment_request(v_pay, 'verified');

  select * into v_row from public.finance_payment_requests where id = v_pay;

  -- THE MONEY WAS NEVER WRONG: exactly one active allocation, the Order in full.
  select count(*), coalesce(sum(allocated_amount), 0) into v_allocs, v_amount
  from public.finance_payment_allocations
  where payment_request_id = v_pay and status = 'active'
    and order_id = 'a0000000-0000-4000-8000-00000000000a';
  if v_allocs <> 1 then raise exception '1: expected exactly one active allocation, got %', v_allocs; end if;
  if v_amount <> 100000 then raise exception '1: the Order must receive the full amount, got %', v_amount; end if;

  -- ── AFTER APPROVAL: the destination comes from the ALLOCATION ──
  v_d := pg_temp.dest(v_pay);
  if v_d.destination_source <> 'allocation' then
    raise exception '1: an approved payment must read its destination from its allocations, got %', v_d.destination_source;
  end if;
  if v_d.destination_kind <> 'confirmed_order' then
    raise exception '1: THE DEFECT — an approved Confirmed-Order payment reads %, not confirmed_order', v_d.destination_kind;
  end if;
  if v_d.destination_order_number <> 'ORD-A' then
    raise exception '1: THE DEFECT — the Order Number is % after a complete allocation',
      coalesce(v_d.destination_order_number, '<blank>');
  end if;
  if v_d.destination_kind = 'suspense' then
    raise exception '1: THE DEFECT — a fully allocated Confirmed Order still reads as Suspense/Unallocated';
  end if;

  -- The ledger status is 'full', from finance_received_payments, from the ledger
  -- alone. That is where "fully allocated" is answered, and it is not re-derived.
  if (select allocation_state from public.finance_received_payments where id = v_pay) <> 'full' then
    raise exception '1: a completely allocated payment must read allocation_state=full';
  end if;

  raise notice '1. THE DEFECT — Confirmed Order shown before approval, and from its allocation after';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. PI Draft, Suspense, and the PI's own reference
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pi uuid; v_pi2 uuid; v_susp uuid; v_d public.finance_payment_destinations;
begin
  -- 2a. Pending PI Draft — from the intent, referenced by the PI's own number.
  v_res := public.submit_payment_request(
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 60000, p_payment_date => current_date, p_payment_mode => 'canara');
  v_pi := (v_res->>'payment_request_id')::uuid;

  v_d := pg_temp.dest(v_pi);
  if v_d.destination_source <> 'intent' or v_d.destination_kind <> 'pi_draft' then
    raise exception '2a: a pending PI request must read pi_draft from its intent, got % / %',
      v_d.destination_source, v_d.destination_kind;
  end if;
  if v_d.destination_reference <> 'PI-4471' then
    raise exception '2a: a PI is referenced by its own source number, got %', coalesce(v_d.destination_reference, '<null>');
  end if;
  if v_d.destination_order_number is not null or v_d.destination_order_id is not null then
    raise exception '2a: a PI destination must carry no Order identifiers';
  end if;

  -- 2b. A PI with no printed number falls back to the workbook name — the same
  --     pair every PI picker in the application shows.
  v_res := public.submit_payment_request(
    p_destination => 'pi_draft', p_target_id => 'e0000000-0000-4000-8000-00000000000e',
    p_amount => 20000, p_payment_date => current_date, p_payment_mode => 'paytm',
    p_custody_events => jsonb_build_array(jsonb_build_object(
      'key', 'k-2b', 'activity_type', 'collected',
      'occurred_at', (now() - interval '1 hour')::text,
      'collected_by', '44444444-4444-4444-8444-444444444444')));
  v_pi2 := (v_res->>'payment_request_id')::uuid;
  if (pg_temp.dest(v_pi2)).destination_reference <> 'rao-quote.xlsx' then
    raise exception '2b: a PI with no source number must fall back to its workbook name';
  end if;

  -- 2c. Suspense — neither allocation nor intent, and it says so.
  v_res := public.submit_payment_request(
    p_destination => 'suspense', p_amount => 5000,
    p_payment_date => current_date, p_payment_mode => 'pnb',
    p_custody_events => jsonb_build_array(jsonb_build_object(
      'key', 'k-2c', 'activity_type', 'collected',
      'occurred_at', (now() - interval '2 hours')::text,
      'collected_by', '44444444-4444-4444-8444-444444444444')));
  v_susp := (v_res->>'payment_request_id')::uuid;

  v_d := pg_temp.dest(v_susp);
  if v_d.destination_source <> 'none' or v_d.destination_kind <> 'suspense' then
    raise exception '2c: a Suspense request must read none/suspense, got % / %',
      v_d.destination_source, v_d.destination_kind;
  end if;
  if v_d.destination_reference is not null then
    raise exception '2c: a Suspense entry names no record and must carry no reference';
  end if;
  if v_d.destination_order_count <> 0 or v_d.destination_submission_count <> 0 then
    raise exception '2c: a Suspense entry must count no destination records';
  end if;

  -- 2d. Approved PI Draft — from the allocation.
  perform public.approve_finance_payment_request(v_pi, 'verified');
  v_d := pg_temp.dest(v_pi);
  if v_d.destination_source <> 'allocation' or v_d.destination_kind <> 'pi_draft' then
    raise exception '2d: an approved PI payment must read pi_draft from its allocation, got % / %',
      v_d.destination_source, v_d.destination_kind;
  end if;
  if v_d.destination_submission_id <> 'd0000000-0000-4000-8000-00000000000d' then
    raise exception '2d: wrong PI after approval';
  end if;

  raise notice '2. PI DRAFT AND SUSPENSE — intent before approval, allocation after, honest blanks';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. MIXED AND MULTIPLE — a safe label, never one arbitrary Order
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_d public.finance_payment_destinations;
begin
  -- 3a. TWO ORDERS. Not a mixture of kinds — but still not one Order Number.
  v_res := public.record_payment_with_allocations(
    p_amount => 100000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_client_name => null,
    p_allocations => jsonb_build_array(
      jsonb_build_object('kind', 'order', 'id', 'a0000000-0000-4000-8000-00000000000a', 'amount', 40000),
      jsonb_build_object('kind', 'order', 'id', 'b0000000-0000-4000-8000-00000000000b', 'amount', 60000)));
  v_pay := (v_res->>'payment_request_id')::uuid;

  v_d := pg_temp.dest(v_pay);
  if v_d.destination_kind <> 'mixed' then
    raise exception '3a: two Orders must read mixed, got %', v_d.destination_kind;
  end if;
  if v_d.destination_order_number is not null then
    raise exception '3a: THE MISLEADING SINGLE ORDER NUMBER — a two-Order payment printed %', v_d.destination_order_number;
  end if;
  if v_d.destination_order_id is not null then
    raise exception '3a: a mixed destination must withhold the Order id';
  end if;
  if v_d.destination_order_count <> 2 then
    raise exception '3a: expected 2 Orders, got %', v_d.destination_order_count;
  end if;
  if v_d.destination_customer_count <> 2 then
    raise exception '3a: two Orders with two customers must count 2, got %', v_d.destination_customer_count;
  end if;

  -- 3b. AN ORDER AND A PI DRAFT, recorded as one payment. Also mixed, and its
  --     stored client_name is NULL because two customers cannot both be it.
  v_res := public.record_payment_with_allocations(
    p_amount => 90000, p_payment_date => current_date, p_payment_mode => 'canara',
    p_client_name => 'ignored',
    p_allocations => jsonb_build_array(
      jsonb_build_object('kind', 'order', 'id', 'b0000000-0000-4000-8000-00000000000b', 'amount', 50000),
      jsonb_build_object('kind', 'submission', 'id', 'e0000000-0000-4000-8000-00000000000e', 'amount', 40000)));
  v_pay := (v_res->>'payment_request_id')::uuid;

  v_d := pg_temp.dest(v_pay);
  if v_d.destination_kind <> 'mixed' then
    raise exception '3b: an Order + PI payment must read mixed, got %', v_d.destination_kind;
  end if;
  if v_d.destination_order_number is not null or v_d.destination_submission_id is not null then
    raise exception '3b: a mixed destination must withhold BOTH single-target identifiers';
  end if;
  if v_d.destination_order_count <> 1 or v_d.destination_submission_count <> 1 then
    raise exception '3b: expected 1 Order and 1 PI, got % / %',
      v_d.destination_order_count, v_d.destination_submission_count;
  end if;

  -- 3c. PARTIAL STAYS PARTIAL, and it is the LEDGER that says so — not this view.
  v_res := public.record_payment_with_allocations(
    p_amount => 100000, p_payment_date => current_date, p_payment_mode => 'hdfc',
    p_client_name => null,
    p_allocations => jsonb_build_array(
      jsonb_build_object('kind', 'order', 'id', 'a0000000-0000-4000-8000-00000000000a', 'amount', 30000)));
  v_pay := (v_res->>'payment_request_id')::uuid;

  v_d := pg_temp.dest(v_pay);
  if v_d.destination_kind <> 'confirmed_order' or v_d.destination_order_number <> 'ORD-A' then
    raise exception '3c: a partly allocated payment still names the record it went to';
  end if;
  if (select allocation_state from public.finance_received_payments where id = v_pay) <> 'partial' then
    raise exception '3c: a partly allocated payment must read allocation_state=partial';
  end if;
  if (select available_balance from public.finance_received_payments where id = v_pay) <> 70000 then
    raise exception '3c: the unallocated balance must still be 70000';
  end if;

  raise notice '3. MIXED / MULTIPLE / PARTIAL — a safe label, no arbitrary Order Number, ledger still decides money';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. REVERSAL — removing the allocation removes the linkage, with no lag
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The single strongest reason provenance is not written at approval. A stored
-- 'approved_linked' with an Order number would survive this; a derived one
-- cannot.
do $$
declare
  v_res jsonb; v_pay uuid; v_d public.finance_payment_destinations;
  v_row public.finance_payment_requests%rowtype;
begin
  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order', p_target_id => 'b0000000-0000-4000-8000-00000000000b',
    p_amount => 25000, p_payment_date => current_date, p_payment_mode => 'hdfc');
  v_pay := (v_res->>'payment_request_id')::uuid;
  perform public.approve_finance_payment_request(v_pay, null);

  if (pg_temp.dest(v_pay)).destination_kind <> 'confirmed_order' then
    raise exception '4: setup — the approved payment must name its Order';
  end if;

  -- THE REVERSAL, as the ledger records one: the row stays, its status changes.
  update public.finance_payment_allocations
     set status = 'reversed'
   where payment_request_id = v_pay;

  v_d := pg_temp.dest(v_pay);
  if v_d.destination_source <> 'none' or v_d.destination_kind <> 'suspense' then
    raise exception '4: FALSE LINKED STATUS — a reversed payment still reads % / %',
      v_d.destination_source, v_d.destination_kind;
  end if;
  if v_d.destination_order_number is not null then
    raise exception '4: FALSE LINKED STATUS — a reversed payment still prints Order %', v_d.destination_order_number;
  end if;

  -- THE APPLIED INTENT MUST NOT COME BACK AS THE ANSWER. It is 'applied', not
  -- 'pending', so it cannot resurrect a destination the ledger has withdrawn.
  if exists (
    select 1 from public.finance_payment_allocation_intents
    where payment_request_id = v_pay and status = 'pending'
  ) then
    raise exception '4: a converted intent must stay applied, never return to pending';
  end if;

  -- And the ledger agrees the money is free again.
  if (select allocation_state from public.finance_received_payments where id = v_pay) <> 'unallocated' then
    raise exception '4: a reversed payment must read allocation_state=unallocated';
  end if;

  -- The payment row itself is untouched by any of this, which is the point.
  select * into v_row from public.finance_payment_requests where id = v_pay;
  if v_row.order_id is not null or v_row.order_number is not null then
    raise exception '4: approval must not have written provenance — found order_id/order_number';
  end if;

  raise notice '4. REVERSAL — the linkage goes with the allocation, and no stale linked state survives';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. APPROVAL RETRY — idempotent, no duplicate allocation, same destination
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_allocs int; v_failed boolean := false;
begin
  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 15000, p_payment_date => current_date, p_payment_mode => 'pnb',
    p_custody_events => jsonb_build_array(jsonb_build_object(
      'key', 'k-5', 'activity_type', 'collected',
      'occurred_at', now()::text,
      'collected_by', '44444444-4444-4444-8444-444444444444')));
  v_pay := (v_res->>'payment_request_id')::uuid;

  perform public.approve_finance_payment_request(v_pay, null);
  begin
    perform public.approve_finance_payment_request(v_pay, null);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception '5: approving an already-approved payment must be refused';
  end if;

  select count(*) into v_allocs
  from public.finance_payment_allocations
  where payment_request_id = v_pay and status = 'active';
  if v_allocs <> 1 then
    raise exception '5: a retried approval created % active allocations', v_allocs;
  end if;
  if (pg_temp.dest(v_pay)).destination_kind <> 'confirmed_order' then
    raise exception '5: the destination must be unchanged by a refused retry';
  end if;

  raise notice '5. APPROVAL RETRY — refused, one allocation, destination unchanged';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. THE PROJECTION NEVER READS THE RETIRED DIRECT LINK
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A payment carrying a legacy order_id and NO active allocation must read as
-- Suspense/Unallocated. If the direct-link fallback ever comes back, this is
-- where it is caught — from behaviour, not from a regexp over a definition.
do $$
declare
  v_pay uuid; v_d public.finance_payment_destinations;
begin
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, proof_note, status, submitted_by,
     order_id, order_number)
  values
    ('Legacy Co', 77000, current_date, 'hdfc', 'legacy', 'approved_linked',
     '22222222-2222-4222-8222-222222222222',
     'a0000000-0000-4000-8000-00000000000a', 'ORD-A')
  returning id into v_pay;

  v_d := pg_temp.dest(v_pay);
  if v_d.destination_source <> 'none' or v_d.destination_kind <> 'suspense' then
    raise exception '6: THE DIRECT-LINK FALLBACK RETURNED — a payment with order_id and no allocation reads % / %',
      v_d.destination_source, v_d.destination_kind;
  end if;
  if v_d.destination_order_number is not null then
    raise exception '6: THE DIRECT-LINK FALLBACK RETURNED — order_number was read as a destination';
  end if;

  -- And the ledger says the same: no allocation, nothing attributed.
  if (select attributed_total from public.finance_received_payments where id = v_pay) <> 0 then
    raise exception '6: the legacy order_id attributed money';
  end if;

  raise notice '6. RETIRED DIRECT LINK — order_id names no destination and attributes nothing';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. PAYMENT MODES — four for new entries, nine in storage
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_mode text; v_pay uuid; v_failed boolean; v_res jsonb;
begin
  -- 7a. All four are accepted by the submission door.
  foreach v_mode in array array['hdfc', 'pnb', 'paytm', 'canara'] loop
    v_res := public.submit_payment_request(
      p_destination => 'suspense', p_amount => 1000,
      p_payment_date => current_date, p_payment_mode => v_mode,
      p_custody_events => '[]'::jsonb);
    v_pay := (v_res->>'payment_request_id')::uuid;
    if (select payment_mode from public.finance_payment_requests where id = v_pay) <> v_mode then
      raise exception '7a: % was not stored as itself', v_mode;
    end if;
  end loop;

  -- 7b. All five legacy values are refused for a NEW entry, by every door.
  foreach v_mode in array array['bank_transfer', 'cash', 'upi', 'cheque', 'other'] loop
    v_failed := false;
    begin
      perform public.submit_payment_request(
        p_destination => 'suspense', p_amount => 1000,
        p_payment_date => current_date, p_payment_mode => v_mode);
    exception when others then
      v_failed := sqlerrm like '%PAYMENT_MODE_INVALID%';
    end;
    if not v_failed then
      raise exception '7b: submit_payment_request accepted the retired mode %', v_mode;
    end if;

    v_failed := false;
    begin
      perform public.record_payment_with_allocations(
        p_amount => 1000, p_payment_date => current_date, p_payment_mode => v_mode,
        p_client_name => null);
    exception when others then
      v_failed := sqlerrm like '%PAYMENT_MODE_INVALID%';
    end;
    if not v_failed then
      raise exception '7b: record_payment_with_allocations accepted the retired mode %', v_mode;
    end if;
  end loop;

  -- 7c. AND THE TABLE ITSELF REFUSES ONE, so a direct PostgREST insert that never
  --     touches an RPC is refused too. This is the part a hidden dropdown cannot
  --     do.
  v_failed := false;
  begin
    insert into public.finance_payment_requests
      (client_name, amount, payment_date, payment_mode, proof_note, status, submitted_by)
    values ('Direct Co', 500, current_date, 'upi', 'x', 'pending_approval',
            '22222222-2222-4222-8222-222222222222');
  exception when others then
    v_failed := sqlerrm like '%PAYMENT_MODE_RETIRED%';
  end;
  if not v_failed then
    raise exception '7c: a direct INSERT with a retired mode was accepted — the rule is not the database''s';
  end if;

  raise notice '7. PAYMENT MODES — the four accepted, the five refused, at the table and at every door';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. HISTORY — a legacy row stays readable, correctable and its own mode
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_pay uuid; v_failed boolean := false;
begin
  -- A row as it existed BEFORE this migration. The trigger is stood down for one
  -- statement, exactly as history reached the table: without it.
  alter table public.finance_payment_requests
    disable trigger finance_payment_requests_enforce_current_payment_mode;
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in, proof_note, status, submitted_by)
  values ('Historic Co', 42000, current_date - 200, 'bank_transfer', 'company_account',
          'UTR-OLD', 'approved_unlinked', '22222222-2222-4222-8222-222222222222')
  returning id into v_pay;
  alter table public.finance_payment_requests
    enable trigger finance_payment_requests_enforce_current_payment_mode;

  -- 8a. IT IS STILL THERE, AND STILL SAYS WHAT IT SAID. Nothing was rewritten.
  if (select payment_mode from public.finance_payment_requests where id = v_pay) <> 'bank_transfer' then
    raise exception '8a: a historical payment mode was rewritten';
  end if;
  if (select received_in from public.finance_payment_requests where id = v_pay) <> 'company_account' then
    raise exception '8a: a historical received_in was rewritten';
  end if;

  -- 8b. IT IS STILL CORRECTABLE. An update that leaves the mode alone passes —
  --     otherwise every pre-20261014000000 row would be frozen.
  update public.finance_payment_requests set admin_note = 'reviewed' where id = v_pay;
  if (select admin_note from public.finance_payment_requests where id = v_pay) <> 'reviewed' then
    raise exception '8b: a historical row could not be corrected';
  end if;

  -- 8c. BUT IT MAY NOT BE MOVED TO ANOTHER RETIRED MODE.
  begin
    update public.finance_payment_requests set payment_mode = 'cheque' where id = v_pay;
  exception when others then
    v_failed := sqlerrm like '%PAYMENT_MODE_RETIRED%';
  end;
  if not v_failed then
    raise exception '8c: a historical row was moved onto another retired mode';
  end if;

  -- 8d. AND IT MAY BE BROUGHT FORWARD ONTO ONE OF THE FOUR.
  update public.finance_payment_requests set payment_mode = 'hdfc' where id = v_pay;
  if (select payment_mode from public.finance_payment_requests where id = v_pay) <> 'hdfc' then
    raise exception '8d: a historical row could not be corrected onto a current mode';
  end if;

  raise notice '8. HISTORY — legacy rows readable, correctable, never silently converted';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. THE CUSTODY TRAIL — PNB and Paytm only
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_mode text; v_failed boolean;
begin
  foreach v_mode in array array['hdfc', 'canara'] loop
    v_res := public.submit_payment_request(
      p_destination => 'suspense', p_amount => 3000,
      p_payment_date => current_date, p_payment_mode => v_mode);
    v_pay := (v_res->>'payment_request_id')::uuid;

    v_failed := false;
    begin
      perform public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
        'key', 'k-9-' || v_mode, 'activity_type', 'collected',
        'occurred_at', now()::text,
        'collected_by', '44444444-4444-4444-8444-444444444444')));
    exception when others then
      v_failed := sqlerrm like '%CUSTODY_MODE_NOT_APPLICABLE%';
    end;
    if not v_failed then
      raise exception '9: a custody activity was accepted on %, which nobody carries', v_mode;
    end if;
  end loop;

  -- And a bank-account submission that sends events anyway is refused OUTRIGHT —
  -- the whole request, not just the events. A hidden field is not an
  -- authorization and a stale one is not a fact.
  v_failed := false;
  begin
    perform public.submit_payment_request(
      p_destination => 'suspense', p_amount => 3000,
      p_payment_date => current_date, p_payment_mode => 'hdfc',
      p_custody_events => jsonb_build_array(jsonb_build_object(
        'key', 'k-9-stale', 'activity_type', 'collected',
        'occurred_at', now()::text,
        'collected_by', '44444444-4444-4444-8444-444444444444')));
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_MODE_NOT_APPLICABLE%';
  end;
  if not v_failed then
    raise exception '9: a stale custody section was stored on a bank payment';
  end if;

  raise notice '9. CUSTODY SCOPE — PNB and Paytm only, decided server-side';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. MANY ACTIVITIES, IN ORDER, AND INCOMPLETE ONES REFUSED
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_n int; v_types text[]; v_failed boolean;
begin
  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 80000, p_payment_date => current_date, p_payment_mode => 'pnb',
    p_custody_events => jsonb_build_array(
      jsonb_build_object('key', 'k-10-a', 'activity_type', 'collected',
        'occurred_at', (now() - interval '3 hours')::text,
        'collected_by', '44444444-4444-4444-8444-444444444444',
        'remark', 'collected at the site office'),
      jsonb_build_object('key', 'k-10-b', 'activity_type', 'handed_over',
        'occurred_at', (now() - interval '2 hours')::text,
        'handed_by', '44444444-4444-4444-8444-444444444444',
        'handed_to', '55555555-5555-4555-8555-555555555555')));
  v_pay := (v_res->>'payment_request_id')::uuid;

  if (v_res->'custody_events'->>'appended')::int <> 2 then
    raise exception '10: expected 2 activities appended, got %', v_res->'custody_events'->>'appended';
  end if;

  select count(*), array_agg(activity_type order by occurred_at, created_at, id)
    into v_n, v_types
  from public.finance_payment_custody_events where payment_request_id = v_pay;
  if v_n <> 2 then raise exception '10: expected 2 stored activities, got %', v_n; end if;
  if v_types <> array['collected', 'handed_over'] then
    raise exception '10: activities must read in the order they happened, got %', v_types;
  end if;

  -- THE MODE AT THE TIME, stamped server-side and never accepted from a caller.
  if exists (select 1 from public.finance_payment_custody_events
             where payment_request_id = v_pay and payment_mode_at_event <> 'pnb') then
    raise exception '10: every activity must be stamped with the mode in force';
  end if;

  -- A HANDOVER WITH ONE END NAMED IS REFUSED.
  v_failed := false;
  begin
    perform public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
      'key', 'k-10-half', 'activity_type', 'handed_over',
      'occurred_at', now()::text,
      'handed_by', '44444444-4444-4444-8444-444444444444')));
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_EVENT_HANDOVER_INCOMPLETE%';
  end;
  if not v_failed then raise exception '10: a one-ended handover was accepted'; end if;

  -- A COLLECTION WITH NOBODY NAMED IS REFUSED.
  v_failed := false;
  begin
    perform public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
      'key', 'k-10-nobody', 'activity_type', 'collected', 'occurred_at', now()::text)));
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_EVENT_COLLECTOR_REQUIRED%';
  end;
  if not v_failed then raise exception '10: a collection with no collector was accepted'; end if;

  -- AND SO IS ONE WITH NO TIME, OR A TIME IN THE FUTURE.
  v_failed := false;
  begin
    perform public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
      'key', 'k-10-notime', 'activity_type', 'collected',
      'collected_by', '44444444-4444-4444-8444-444444444444')));
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_EVENT_TIME_REQUIRED%';
  end;
  if not v_failed then raise exception '10: an activity with no date and time was accepted'; end if;

  v_failed := false;
  begin
    perform public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
      'key', 'k-10-future', 'activity_type', 'collected',
      'occurred_at', (now() + interval '30 days')::text,
      'collected_by', '44444444-4444-4444-8444-444444444444')));
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_EVENT_TIME_FUTURE%';
  end;
  if not v_failed then raise exception '10: an activity in the future was accepted'; end if;

  -- NOTHING PARTIAL SURVIVED ANY OF THOSE REFUSALS.
  select count(*) into v_n from public.finance_payment_custody_events where payment_request_id = v_pay;
  if v_n <> 2 then raise exception '10: a refused activity left % rows behind', v_n - 2; end if;

  raise notice '10. MANY ACTIVITIES — chronological, mode-stamped, and every incomplete one refused whole';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. IDEMPOTENCE — a retry and a double click add nothing
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_n int; v_out jsonb; v_event jsonb;
begin
  v_res := public.submit_payment_request(
    p_destination => 'suspense', p_amount => 9000,
    p_payment_date => current_date, p_payment_mode => 'paytm');
  v_pay := (v_res->>'payment_request_id')::uuid;

  v_event := jsonb_build_object(
    'key', 'k-11', 'activity_type', 'collected',
    'occurred_at', '2026-08-01 10:00:00+00',
    'collected_by', '44444444-4444-4444-8444-444444444444');

  v_out := public.append_payment_custody_events(v_pay, jsonb_build_array(v_event));
  if (v_out->>'appended')::int <> 1 then raise exception '11: the first append wrote nothing'; end if;

  -- THE SAME KEY AGAIN: a retried round trip.
  v_out := public.append_payment_custody_events(v_pay, jsonb_build_array(v_event));
  if (v_out->>'appended')::int <> 0 then
    raise exception '11: a retried append wrote % row(s)', v_out->>'appended';
  end if;

  -- A FRESHLY MINTED KEY, same activity: a double click on a re-rendered form.
  -- The natural key is what catches this one.
  v_out := public.append_payment_custody_events(v_pay,
    jsonb_build_array(v_event || jsonb_build_object('key', 'k-11-different')));
  if (v_out->>'appended')::int <> 0 then
    raise exception '11: a re-minted duplicate wrote % row(s)', v_out->>'appended';
  end if;

  select count(*) into v_n from public.finance_payment_custody_events where payment_request_id = v_pay;
  if v_n <> 1 then raise exception '11: the trail holds % activities where 1 was recorded', v_n; end if;

  raise notice '11. IDEMPOTENCE — a retry and a double click both add nothing';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 12. IMMUTABLE — a saved activity cannot be edited or deleted
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_id uuid; v_failed boolean; v_n int;
begin
  v_res := public.submit_payment_request(
    p_destination => 'suspense', p_amount => 4000,
    p_payment_date => current_date, p_payment_mode => 'pnb',
    p_custody_events => jsonb_build_array(jsonb_build_object(
      'key', 'k-12', 'activity_type', 'collected', 'occurred_at', now()::text,
      'collected_by', '44444444-4444-4444-8444-444444444444')));
  v_pay := (v_res->>'payment_request_id')::uuid;
  select id into v_id from public.finance_payment_custody_events where payment_request_id = v_pay;

  -- 12a. NOT EVEN AS THE OWNER OF THE TABLE. The refusal is the table's.
  v_failed := false;
  begin
    update public.finance_payment_custody_events set remark = 'rewritten' where id = v_id;
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_EVENT_IMMUTABLE%';
  end;
  if not v_failed then raise exception '12a: a saved custody activity was edited'; end if;

  -- 12b. AND THERE IS NO WRITE POLICY FOR ANY CLIENT ROLE — checked as data
  --      rather than trusted, because a policy added later would be invisible.
  select count(*) into v_n from pg_policies
  where schemaname = 'public' and tablename = 'finance_payment_custody_events' and cmd <> 'SELECT';
  if v_n <> 0 then raise exception '12b: the custody table grew % write policy/policies', v_n; end if;

  -- 12c. AND NO CLIENT ROLE HOLDS A WRITE PRIVILEGE.
  if has_table_privilege('authenticated', 'public.finance_payment_custody_events', 'insert')
     or has_table_privilege('authenticated', 'public.finance_payment_custody_events', 'update')
     or has_table_privilege('authenticated', 'public.finance_payment_custody_events', 'delete') then
    raise exception '12c: authenticated may write the custody table directly';
  end if;

  raise notice '12. IMMUTABLE — no edit, no write policy, no write privilege';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13. WHO MAY APPEND — the database decides, not a hidden button
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_failed boolean; v_out jsonb;
begin
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');
  v_res := public.submit_payment_request(
    p_destination => 'suspense', p_amount => 7000,
    p_payment_date => current_date, p_payment_mode => 'paytm');
  v_pay := (v_res->>'payment_request_id')::uuid;

  -- 13a. THE SUBMITTER, while the request is unapproved.
  v_out := public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
    'key', 'k-13-own', 'activity_type', 'collected', 'occurred_at', now()::text,
    'collected_by', '55555555-5555-4555-8555-555555555555')));
  if (v_out->>'appended')::int <> 1 then raise exception '13a: the submitter could not add to their own trail'; end if;

  -- 13b. SOMEBODY ELSE ENTIRELY, with no Finance authority, may not — even
  --      though the RPC is executable by every signed-in user.
  perform pg_temp.act_as('44444444-4444-4444-8444-444444444444');
  v_failed := false;
  begin
    perform public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
      'key', 'k-13-other', 'activity_type', 'collected', 'occurred_at', now()::text,
      'collected_by', '44444444-4444-4444-8444-444444444444')));
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_APPEND_NOT_PERMITTED%' or sqlerrm like '%FINANCE_MODULE_CLOSED%';
  end;
  if not v_failed then raise exception '13b: an unrelated user appended to somebody else''s custody trail'; end if;

  -- 13c. AN ADMIN MAY, AND MAY STILL AFTER APPROVAL. Recording a handover that
  --      happened last week is the reason the standalone door exists.
  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');
  perform public.approve_finance_payment_request(v_pay, null);
  v_out := public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
    'key', 'k-13-late', 'activity_type', 'handed_over', 'occurred_at', now()::text,
    'handed_by', '55555555-5555-4555-8555-555555555555',
    'handed_to', '11111111-1111-4111-8111-111111111111',
    'remark', 'handed over after verification')));
  if (v_out->>'appended')::int <> 1 then
    raise exception '13c: Finance could not add a handover to an approved payment';
  end if;

  -- 13d. AND THE SUBMITTER MAY NOT, ONCE IT IS APPROVED. Their window is the
  --      same one every other correction has.
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');
  v_failed := false;
  begin
    perform public.append_payment_custody_events(v_pay, jsonb_build_array(jsonb_build_object(
      'key', 'k-13-toolate', 'activity_type', 'collected', 'occurred_at', now()::text,
      'collected_by', '22222222-2222-4222-8222-222222222222')));
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_APPEND_NOT_PERMITTED%';
  end;
  if not v_failed then
    raise exception '13d: the submitter kept appending after the payment was verified';
  end if;

  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');
  raise notice '13. AUTHORIZATION — submitter while unapproved, Finance always, nobody else ever';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 14. A MODE CHANGE PRESERVES THE HISTORY IT ALREADY HAS
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_n int; v_modes text[]; v_failed boolean;
begin
  v_res := public.submit_payment_request(
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 30000, p_payment_date => current_date, p_payment_mode => 'pnb',
    p_custody_events => jsonb_build_array(jsonb_build_object(
      'key', 'k-14-a', 'activity_type', 'collected',
      'occurred_at', (now() - interval '5 hours')::text,
      'collected_by', '44444444-4444-4444-8444-444444444444')));
  v_pay := (v_res->>'payment_request_id')::uuid;

  -- 14a. PNB → PAYTM. The earlier activity keeps saying PNB; the new one says
  --      Paytm. Both are true of the money at the time.
  perform public.edit_payment_request(
    p_payment_request_id => v_pay,
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 30000, p_payment_date => current_date, p_payment_mode => 'paytm',
    p_custody_events => jsonb_build_array(jsonb_build_object(
      'key', 'k-14-b', 'activity_type', 'handed_over',
      'occurred_at', (now() - interval '1 hour')::text,
      'handed_by', '44444444-4444-4444-8444-444444444444',
      'handed_to', '55555555-5555-4555-8555-555555555555')));

  select count(*), array_agg(payment_mode_at_event order by occurred_at)
    into v_n, v_modes
  from public.finance_payment_custody_events where payment_request_id = v_pay;
  if v_n <> 2 then raise exception '14a: expected 2 activities after the correction, got %', v_n; end if;
  if v_modes <> array['pnb', 'paytm'] then
    raise exception '14a: the earlier activity must keep its own mode, got %', v_modes;
  end if;

  -- 14b. PAYTM → HDFC. A mode nobody carries. THE SAVED ACTIVITY IS NOT DELETED;
  --      only new ones are refused.
  perform public.edit_payment_request(
    p_payment_request_id => v_pay,
    p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
    p_amount => 30000, p_payment_date => current_date, p_payment_mode => 'hdfc');

  select count(*) into v_n from public.finance_payment_custody_events where payment_request_id = v_pay;
  if v_n <> 2 then
    raise exception '14b: correcting the mode away from PNB/Paytm destroyed % custody activity/activities', 2 - v_n;
  end if;

  v_failed := false;
  begin
    perform public.edit_payment_request(
      p_payment_request_id => v_pay,
      p_destination => 'pi_draft', p_target_id => 'd0000000-0000-4000-8000-00000000000d',
      p_amount => 30000, p_payment_date => current_date, p_payment_mode => 'hdfc',
      p_custody_events => jsonb_build_array(jsonb_build_object(
        'key', 'k-14-c', 'activity_type', 'collected', 'occurred_at', now()::text,
        'collected_by', '44444444-4444-4444-8444-444444444444')));
  exception when others then
    v_failed := sqlerrm like '%CUSTODY_MODE_NOT_APPLICABLE%';
  end;
  if not v_failed then raise exception '14b: a new activity was accepted on a mode nobody carries'; end if;

  -- 14c. AND THE FIVE LEGACY COLUMNS WERE NEVER TOUCHED BY ANY OF IT.
  if exists (
    select 1 from public.finance_payment_requests
    where id = v_pay
      and (collected_by_user_id is not null or handed_over_to_user_id is not null
           or handed_over_at is not null or collection_handover_note is not null
           or collected_from_text is not null)
  ) then
    raise exception '14c: a correction wrote the retired single-event cash columns';
  end if;

  -- 14d. A DESTINATION CHANGE DOES NOT DISTURB THE TRAIL EITHER.
  perform public.edit_payment_request(
    p_payment_request_id => v_pay,
    p_destination => 'confirmed_order', p_target_id => 'b0000000-0000-4000-8000-00000000000b',
    p_amount => 30000, p_payment_date => current_date, p_payment_mode => 'pnb');
  select count(*) into v_n from public.finance_payment_custody_events where payment_request_id = v_pay;
  if v_n <> 2 then raise exception '14d: changing the destination changed the custody trail'; end if;

  if (pg_temp.dest(v_pay)).destination_order_number <> 'ORD-B' then
    raise exception '14d: the corrected destination must be what the projection shows';
  end if;

  raise notice '14. MODE AND DESTINATION CHANGES — history preserved, new events refused when they must be';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 15. THE LEDGER IS UNDISTURBED — no custody or intent object moves a rupee
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb; v_pay uuid; v_before numeric; v_after numeric;
begin
  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');
  v_before := public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a');

  -- A pending request and a whole custody trail against that Order.
  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order', p_target_id => 'a0000000-0000-4000-8000-00000000000a',
    p_amount => 250000, p_payment_date => current_date, p_payment_mode => 'pnb',
    p_custody_events => jsonb_build_array(
      jsonb_build_object('key', 'k-15-a', 'activity_type', 'collected',
        'occurred_at', (now() - interval '6 hours')::text,
        'collected_by', '44444444-4444-4444-8444-444444444444'),
      jsonb_build_object('key', 'k-15-b', 'activity_type', 'handed_over',
        'occurred_at', (now() - interval '4 hours')::text,
        'handed_by', '44444444-4444-4444-8444-444444444444',
        'handed_to', '55555555-5555-4555-8555-555555555555')));
  v_pay := (v_res->>'payment_request_id')::uuid;

  v_after := public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a');
  if v_after <> v_before then
    raise exception '15: an unverified request with a custody trail moved the Order total from % to %', v_before, v_after;
  end if;
  if (select attributed_total from public.finance_received_payments where id = v_pay) <> 0 then
    raise exception '15: an unverified request attributed money';
  end if;
  if (select count(*) from public.finance_payment_allocations where payment_request_id = v_pay) <> 0 then
    raise exception '15: an unverified request created an allocation';
  end if;

  -- Approval moves it, and by exactly the amount.
  perform public.approve_finance_payment_request(v_pay, null);
  if public.order_linked_payment_total('a0000000-0000-4000-8000-00000000000a') <> v_before + 250000 then
    raise exception '15: approval did not attribute the full amount to the Order';
  end if;

  raise notice '15. LEDGER UNDISTURBED — intent and custody move no money; approval moves exactly the amount';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 16. ANON HOLDS NOTHING
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_name text;
begin
  foreach v_name in array array['select', 'insert', 'update', 'delete'] loop
    if has_table_privilege('anon', 'public.finance_payment_custody_events', v_name) then
      raise exception '16: anon holds % on the custody table', v_name;
    end if;
    if has_table_privilege('anon', 'public.finance_payment_destinations', v_name) then
      raise exception '16: anon holds % on the destination projection', v_name;
    end if;
    if has_table_privilege('anon', 'public.finance_payment_allocation_intents', v_name) then
      raise exception '16: anon holds % on the intent table', v_name;
    end if;
  end loop;

  foreach v_name in array array[
    'public.append_payment_custody_events(uuid, jsonb)',
    'public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb)',
    'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)',
    'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb)'
  ] loop
    if has_function_privilege('anon', v_name, 'execute') then
      raise exception '16: anon may call %', v_name;
    end if;
  end loop;

  raise notice '16. ANON — no table privilege, no RPC, on any object this migration touches';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
