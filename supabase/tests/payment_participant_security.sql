-- ═════════════════════════════════════════════════════════════════════════════
-- ROLE-BASED SECURITY TESTS: payment visibility and the Order total
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Runs against supabase/tests/_production_shaped_schema.sql as REAL ROLES —
-- `set local role authenticated` plus a JWT sub — so every policy, every
-- RESTRICTIVE gate and every nested SECURITY DEFINER is exercised the way
-- PostgREST would exercise it. Nothing here is asserted by reading SQL text.
--
-- IT IS RUN TWICE, and detects for itself which run it is in:
--
--   BEFORE  the base schema alone, carrying the applied definitions of
--           can_read_payment_as_participant() and order_linked_payment_total().
--           Cases G, L and M are expected to FAIL CLOSED here — that is, they
--           are expected to LEAK, and the file asserts the leak so the exposure
--           is demonstrated rather than asserted.
--   AFTER   the same schema with 20261004000000, 20261005000000 and
--           20261006000000 applied. Every case must now hold.
--
-- The discriminator is the existence of can_view_order_as_actor(), which only
-- 20261006000000 creates.
--
-- Run:  see supabase/tests/run_security_suite.sh

\set ON_ERROR_STOP on

begin;

-- ─── Fixtures ────────────────────────────────────────────────────────────────
--
-- ADMIN  role='admin'                       sees everything
-- OPS    team='operations'                  sees every Order
-- SALLY  requester of ORDER_X               Order participant
-- VIC    orders.view, unrelated to ORDER_X  the user G and L are about
-- PIA    creator of SUBMISSION_P            PI participant
-- PAM    orders.view, unrelated to the PI   the user I is about
-- SUB    submitted P_SUB                    the payment's own submitter
-- MAL    finance.view, unrelated            an unrelated Finance-module user
-- FIONA  finance.view + finance.view_all    company-wide Finance sight
-- VERA   finance.view + finance.verify      a verifier WITHOUT view_all

insert into public.users (id, full_name, role, team) values
  ('00000000-0000-0000-0000-00000000ad00','Admin',  'admin',   null),
  ('00000000-0000-0000-0000-0000000005ff','Ops',    'employee','operations'),
  ('00000000-0000-0000-0000-0000000005a1','Sally',  'employee','sales'),
  ('00000000-0000-0000-0000-0000000041c0','Vic',    'employee','sales'),
  ('00000000-0000-0000-0000-0000000009a1','Pia',    'employee','sales'),
  ('00000000-0000-0000-0000-0000000009a2','Pam',    'employee','sales'),
  ('00000000-0000-0000-0000-000000005b00','Sub',    'employee','finance'),
  ('00000000-0000-0000-0000-00000000aa10','Mal',    'employee','finance'),
  ('00000000-0000-0000-0000-0000000000f1','Fiona',  'employee','finance'),
  ('00000000-0000-0000-0000-0000000000e2','Vera',   'employee','finance');

insert into public.t_permission_grants (user_id, module_key, action_key) values
  ('00000000-0000-0000-0000-0000000005a1','orders','view'),
  ('00000000-0000-0000-0000-0000000041c0','orders','view'),
  ('00000000-0000-0000-0000-0000000009a1','orders','view'),
  ('00000000-0000-0000-0000-0000000009a2','orders','view'),
  ('00000000-0000-0000-0000-0000000005ff','orders','view'),
  ('00000000-0000-0000-0000-000000005b00','finance','view'),
  ('00000000-0000-0000-0000-00000000aa10','finance','view'),
  ('00000000-0000-0000-0000-0000000000f1','finance','view'),
  ('00000000-0000-0000-0000-0000000000f1','finance','view_all'),
  ('00000000-0000-0000-0000-0000000000e2','finance','view'),
  ('00000000-0000-0000-0000-0000000000e2','finance','verify'),
  -- Orders module ENTRY only. The participant predicate ANDs
  -- module_entry_open('orders') onto its PI branch (20260919000000 §2), so
  -- without this a verifier reaches no PI-allocated payment at all and case C
  -- would pass vacuously. Entry is not sight: Vera still holds no orders.view_all
  -- and is requester or assignee of nothing, so she must reach the PI-allocated
  -- payment and NOT the Order-allocated one.
  ('00000000-0000-0000-0000-0000000000e2','orders','view');

insert into public.orders (id, display_number, requested_by, assigned_to) values
  ('00000000-0000-0000-0000-00000000d0e1','ORD-X','00000000-0000-0000-0000-0000000005a1', null),
  ('00000000-0000-0000-0000-00000000d0f1','ORD-Y', null, null);

insert into public.order_submissions (id, status, created_by) values
  ('00000000-0000-0000-0000-00000000b0a1','submitted','00000000-0000-0000-0000-0000000009a1');

-- P_SUB     pending, submitter-only, no allocation and no link
-- P_X       ₹10L, ₹4,00,000 allocated to ORDER_X
-- P_PI      ₹10L, ₹2,50,000 allocated to SUBMISSION_P
-- P_LEGACY  ₹10L, linked to ORDER_X, NO allocations       (worked example A)
-- P_C       ₹10L, linked to ORDER_X, ₹4,00,000 to ORDER_Y (worked example C)
-- P_REV     ₹10L, linked to ORDER_X, allocation REVERSED  (worked example E)
-- P_SPLIT   ₹10L, ₹4,00,000 to ORDER_X and ₹6,00,000 to ORDER_Y
insert into public.finance_payment_requests (id, amount, status, submitted_by, order_id) values
  ('00000000-0000-0000-0000-0000000c5b00', 250000.00,'pending',           '00000000-0000-0000-0000-000000005b00', null),
  ('00000000-0000-0000-0000-0000000c00a1',1000000.00,'approved_unlinked', '00000000-0000-0000-0000-0000000000f1', null),
  ('00000000-0000-0000-0000-0000000c00b1',1000000.00,'approved_unlinked', '00000000-0000-0000-0000-0000000000f1', null),
  ('00000000-0000-0000-0000-0000000c00c1',1000000.00,'approved_linked',   '00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000d0e1'),
  ('00000000-0000-0000-0000-0000000c00d1',1000000.00,'approved_linked',   '00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000d0e1'),
  ('00000000-0000-0000-0000-0000000c00e1',1000000.00,'approved_linked',   '00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000d0e1'),
  ('00000000-0000-0000-0000-0000000c00f1',1000000.00,'approved_unlinked', '00000000-0000-0000-0000-0000000000f1', null);

insert into public.finance_payment_allocations (id, payment_request_id, allocated_amount, status, order_id, order_submission_id) values
  ('00000000-0000-0000-0000-00000000a111','00000000-0000-0000-0000-0000000c00a1', 400000.00,'active',  '00000000-0000-0000-0000-00000000d0e1', null),
  ('00000000-0000-0000-0000-00000000a222','00000000-0000-0000-0000-0000000c00b1', 250000.00,'active',   null, '00000000-0000-0000-0000-00000000b0a1'),
  ('00000000-0000-0000-0000-00000000a333','00000000-0000-0000-0000-0000000c00d1', 400000.00,'active',  '00000000-0000-0000-0000-00000000d0f1', null),
  ('00000000-0000-0000-0000-00000000a444','00000000-0000-0000-0000-0000000c00e1', 900000.00,'reversed','00000000-0000-0000-0000-00000000d0f1', null),
  ('00000000-0000-0000-0000-00000000a555','00000000-0000-0000-0000-0000000c00f1', 400000.00,'active',  '00000000-0000-0000-0000-00000000d0e1', null),
  ('00000000-0000-0000-0000-00000000a666','00000000-0000-0000-0000-0000000c00f1', 600000.00,'active',  '00000000-0000-0000-0000-00000000d0f1', null);

insert into public.payment_proof_attachments (id, payment_request_id) values
  ('00000000-0000-0000-0000-0000000f0001','00000000-0000-0000-0000-0000000c00a1');

-- N. A stand-in for cancel_order_with_audit(): a SECURITY DEFINER that reads the
-- total into a local, exactly as the real one reads it into v_received. Its only
-- job here is to prove the gate survives being NESTED inside another definer —
-- which is the property an RLS-based gate would not have had.
create or replace function public.t_cancel_reads_total(p_order_id uuid)
returns numeric language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_received numeric;
begin
  v_received := public.order_linked_payment_total(p_order_id);
  return v_received;
end;
$$;
grant execute on function public.t_cancel_reads_total(uuid) to authenticated;

-- ─── The matrix ──────────────────────────────────────────────────────────────

do $$
declare
  corrected boolean := to_regprocedure('public.can_view_order_as_actor(uuid)') is not null;
  phase     text;
  v_n       int;
  v_total   numeric;
  v_total2  numeric;
  ADMINU uuid := '00000000-0000-0000-0000-00000000ad00';
  SALLY  uuid := '00000000-0000-0000-0000-0000000005a1';
  VIC    uuid := '00000000-0000-0000-0000-0000000041c0';
  PIA    uuid := '00000000-0000-0000-0000-0000000009a1';
  PAM    uuid := '00000000-0000-0000-0000-0000000009a2';
  SUB    uuid := '00000000-0000-0000-0000-000000005b00';
  MAL    uuid := '00000000-0000-0000-0000-00000000aa10';
  FIONA  uuid := '00000000-0000-0000-0000-0000000000f1';
  VERA   uuid := '00000000-0000-0000-0000-0000000000e2';
  ORDER_X uuid := '00000000-0000-0000-0000-00000000d0e1';
  ORDER_Y uuid := '00000000-0000-0000-0000-00000000d0f1';
  GHOSTO  uuid := '00000000-0000-0000-0000-0000000000ff';
  P_SUB uuid := '00000000-0000-0000-0000-0000000c5b00';
  P_X   uuid := '00000000-0000-0000-0000-0000000c00a1';
  P_PI  uuid := '00000000-0000-0000-0000-0000000c00b1';
  GHOSTP uuid := '00000000-0000-0000-0000-0000000cffff';
begin
  phase := case when corrected then 'AFTER ' else 'BEFORE' end;
  raise notice '─── phase % ───', phase;

  -- ═══ A. The payment's own submitter can read it ═══════════════════════════
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', SUB::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_SUB;
  if v_n <> 1 then raise exception '% A FAILED: the submitter cannot read their own payment', phase; end if;
  raise notice '% A pass — submitter reads their own payment', phase;

  -- ═══ B. An unrelated Finance-module user cannot ═══════════════════════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', MAL::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_SUB;
  if v_n <> 0 then raise exception '% B FAILED: an unrelated Finance user read a payment', phase; end if;
  raise notice '% B pass — unrelated Finance-module user reads nothing', phase;

  -- ═══ C. A verifier WITHOUT view_all gets exactly what the rules intend ════
  -- can_view_order_submission admits a finance verifier to a submitted or
  -- approved PI, so Vera is a participant of the PI-allocated payment and of
  -- nothing else. Both halves are asserted.
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', VERA::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_PI;
  if v_n <> 1 then raise exception '% C FAILED: the verifier cannot reach the PI-allocated payment', phase; end if;
  select count(*) into v_n from public.finance_payment_requests where id = P_SUB;
  if v_n <> 0 then raise exception '% C FAILED: the verifier reached a payment no rule gives them', phase; end if;
  -- The other half: Orders module ENTRY is not Order SIGHT. Vera can open no
  -- Order, so the Order-allocated payment must stay out of reach once the
  -- correction lands. Before it, this is the exposure itself.
  select count(*) into v_n from public.finance_payment_requests where id = P_X;
  if corrected and v_n <> 0 then
    raise exception 'AFTER  C FAILED: the verifier reached an Order-allocated payment they cannot see';
  end if;
  raise notice '% C pass — verifier sees the PI payment, and % Order-allocated payment(s)', phase, v_n;

  -- ═══ D. finance.view_all reads it ═════════════════════════════════════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', FIONA::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_SUB;
  if v_n <> 1 then raise exception '% D FAILED: finance.view_all cannot read the payment', phase; end if;
  raise notice '% D pass — finance.view_all reads it', phase;

  -- ═══ E. Admin reads it ════════════════════════════════════════════════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', ADMINU::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_SUB;
  if v_n <> 1 then raise exception '% E FAILED: admin cannot read the payment', phase; end if;
  raise notice '% E pass — admin reads it', phase;

  -- ═══ F. A user who CAN view the allocated Order reads the payment ════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', SALLY::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_X;
  if v_n <> 1 then raise exception '% F FAILED: the Order participant cannot read the allocated payment', phase; end if;
  -- and the proof metadata travels with it, by the same predicate
  select count(*) into v_n from public.payment_proof_attachments where payment_request_id = P_X;
  if v_n <> 1 then raise exception '% F FAILED: the Order participant cannot read the proof metadata', phase; end if;
  raise notice '% F pass — Order participant reads the payment and its proof metadata', phase;

  -- ═══ G. A user who CANNOT view the allocated Order must not ══════════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', VIC::text, true);
  select count(*) into v_n from public.orders where id = ORDER_X;
  if v_n <> 0 then raise exception 'HARNESS BROKEN: Vic should not see ORDER_X'; end if;

  select count(*) into v_n from public.finance_payment_requests where id = P_X;
  if corrected then
    if v_n <> 0 then
      raise exception 'AFTER  G FAILED: a user who cannot open the Order still read its allocated payment';
    end if;
    select count(*) into v_n from public.payment_proof_attachments where payment_request_id = P_X;
    if v_n <> 0 then
      raise exception 'AFTER  G FAILED: proof metadata still leaked to a non-participant';
    end if;
    raise notice 'AFTER  G pass — Order allocation no longer grants payment sight to a non-viewer';
  else
    if v_n = 0 then
      raise exception 'BEFORE G: the exposure did not reproduce — re-check the applied definition';
    end if;
    raise notice 'BEFORE G EXPOSED — a user who can open NO Order read % payment row(s)', v_n;
  end if;

  -- ═══ H. A user who CAN view the allocated PI reads the payment ═══════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', PIA::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_PI;
  if v_n <> 1 then raise exception '% H FAILED: the PI participant cannot read the allocated payment', phase; end if;
  raise notice '% H pass — PI participant reads the payment', phase;

  -- ═══ I. A user who CANNOT view the allocated PI must not ═════════════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', PAM::text, true);
  select count(*) into v_n from public.order_submissions where id = '00000000-0000-0000-0000-00000000b0a1';
  if v_n <> 0 then raise exception 'HARNESS BROKEN: Pam should not see the PI'; end if;
  select count(*) into v_n from public.finance_payment_requests where id = P_PI;
  if v_n <> 0 then raise exception '% I FAILED: a non-viewer of the PI read its allocated payment', phase; end if;
  raise notice '% I pass — PI allocation grants nothing to a non-viewer (sound in both phases)', phase;

  -- ═══ J. A mixed array leaks only the accessible rows ═════════════════════
  -- payment_active_allocation_totals only exists once 20261005000000 is applied.
  if to_regprocedure('public.payment_active_allocation_totals(uuid[])') is not null then
    reset role; set local role authenticated;
    perform set_config('request.jwt.claim.sub', SALLY::text, true);
    select count(*) into v_n from (
      select payment_request_id as id
        from public.payment_active_allocation_totals(array[P_SUB, P_X, P_PI, GHOSTP])
      except
      select id from public.finance_payment_requests
    ) x;
    if v_n <> 0 then
      raise exception '% J FAILED: the batched RPC answered for % id(s) the caller cannot read', phase, v_n;
    end if;
    select count(*) into v_n
      from public.payment_active_allocation_totals(array[P_SUB, P_X, P_PI, GHOSTP]);
    raise notice '% J pass — mixed 4-id array returned % accessible row(s), no others', phase, v_n;
  end if;

  -- ═══ K. An authorised Order viewer gets the total ════════════════════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', SALLY::text, true);
  select public.order_linked_payment_total(ORDER_X) into v_total;
  if corrected then
    -- P_X 4L + P_LEGACY 10L + P_C 0 + P_REV 10L + P_SPLIT 4L
    if v_total is distinct from 2800000.00 then
      raise exception 'AFTER  K FAILED: expected 2800000.00 for ORDER_X, got %', v_total;
    end if;
    raise notice 'AFTER  K pass — authorised Order viewer gets %', v_total;
  else
    raise notice 'BEFORE K — the pre-correction body returns % (legacy links only)', v_total;
  end if;

  -- ═══ L. An unauthorised user gets no financial information ═══════════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', VIC::text, true);
  select public.order_linked_payment_total(ORDER_X) into v_total;
  if corrected then
    if v_total is not null then
      raise exception 'AFTER  L FAILED: a user who cannot view the Order obtained %', v_total;
    end if;
    raise notice 'AFTER  L pass — unauthorised caller gets NULL, not a figure and not an error';
  else
    if v_total is null then
      raise exception 'BEFORE L: the exposure did not reproduce';
    end if;
    raise notice 'BEFORE L EXPOSED — an unauthorised caller obtained the total: %', v_total;
  end if;

  -- ═══ M. Unknown and inaccessible Order UUIDs are indistinguishable ═══════
  select public.order_linked_payment_total(GHOSTO) into v_total2;
  if corrected then
    if v_total is distinct from v_total2 then
      raise exception
        'AFTER  M FAILED: inaccessible gives % but unknown gives % — a financial oracle', v_total, v_total2;
    end if;
    raise notice 'AFTER  M pass — inaccessible and unknown both give %, indistinguishable',
      coalesce(v_total::text, 'NULL');
  else
    raise notice 'BEFORE M — inaccessible gives %, unknown gives %',
      coalesce(v_total::text,'NULL'), coalesce(v_total2::text,'NULL');
  end if;

  -- ═══ N. The Cancel path, NESTED inside another SECURITY DEFINER ══════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', SALLY::text, true);
  select public.t_cancel_reads_total(ORDER_X) into v_total;
  if corrected then
    if v_total is distinct from 2800000.00 then
      raise exception
        'AFTER  N FAILED: the cancel path read % instead of 2800000.00 — the gate did not survive nesting', v_total;
    end if;
    raise notice 'AFTER  N pass — cancel path, one definer deep, still reads the true total %', v_total;
    -- and it refuses the same caller L refuses
    reset role; set local role authenticated;
    perform set_config('request.jwt.claim.sub', VIC::text, true);
    select public.t_cancel_reads_total(ORDER_X) into v_total;
    if v_total is not null then
      raise exception 'AFTER  N FAILED: the nested path leaked % to an unauthorised caller', v_total;
    end if;
    raise notice 'AFTER  N pass — and the nested path refuses an unauthorised caller too';
  else
    raise notice 'BEFORE N — cancel path reads %', v_total;
  end if;

  -- ═══ O. Canonical attribution survives the gating ════════════════════════
  if corrected then
    reset role; set local role authenticated;
    perform set_config('request.jwt.claim.sub', ADMINU::text, true);
    select public.order_linked_payment_total(ORDER_X) into v_total;
    if v_total is distinct from 2800000.00 then
      raise exception 'AFTER  O FAILED: ORDER_X expected 2800000.00, got %', v_total;
    end if;
    -- P_C ₹4L + P_SPLIT ₹6L. P_REV's reversed allocation contributes nothing,
    -- and its payment falls back to the ORDER_X link instead.
    select public.order_linked_payment_total(ORDER_Y) into v_total2;
    if v_total2 is distinct from 1000000.00 then
      raise exception 'AFTER  O FAILED: ORDER_Y expected 1000000.00, got %', v_total2;
    end if;
    -- Conservation across the two Orders for the four payments that touch both:
    -- legacy 10L + C 10L + reversed 10L + split 10L = 40L, of which X takes 24L
    -- (10+0+10+4) and Y takes 10L (4+6); the remaining 6L of P_C is unallocated.
    raise notice 'AFTER  O pass — ORDER_X %, ORDER_Y %: legacy, allocated, reversed and split all canonical',
      v_total, v_total2;
  end if;

  -- ═══ P. A caller-controlled search_path cannot change any answer ═════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', SALLY::text, true);

  -- Shadow objects in the one schema an unprivileged caller CAN create in.
  create temporary table orders (id uuid primary key, requested_by uuid, assigned_to uuid);
  insert into orders values (ORDER_X, SALLY, SALLY), (ORDER_Y, SALLY, SALLY), (GHOSTO, SALLY, SALLY);
  create temporary table users (id uuid primary key, role text, team text);
  insert into users values (SALLY, 'admin', 'operations');
  create or replace function pg_temp.resolve_permission(uuid, text, text)
    returns boolean language sql immutable as $f$ select true $f$;

  perform set_config('search_path', 'pg_temp, public', true);

  select public.order_linked_payment_total(ORDER_X) into v_total;
  if corrected and v_total is distinct from 2800000.00 then
    raise exception 'AFTER  P FAILED: a shadowed search_path changed the total to %', v_total;
  end if;

  select public.order_linked_payment_total(GHOSTO) into v_total2;
  if corrected and v_total2 is not null then
    raise exception 'AFTER  P FAILED: shadow objects made an unknown Order answer %', v_total2;
  end if;

  select count(*) into v_n from public.finance_payment_requests where id = P_SUB;
  if v_n <> 0 then
    raise exception '% P FAILED: shadow objects granted payment sight (% rows)', phase, v_n;
  end if;

  perform set_config('search_path', 'public', true);
  raise notice '% P pass — pinned search_path and qualified names ignore every shadow object', phase;

  reset role;
  raise notice '─── phase % : ALL CASES HELD ───', phase;
end $$;

rollback;
