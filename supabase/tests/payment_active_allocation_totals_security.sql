-- ═════════════════════════════════════════════════════════════════════════════
-- SECURITY HARNESS: payment_active_allocation_totals(uuid[])
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS PROVES, AND WHY IT IS SELF-CONTAINED
-- ----------------------------------------------
-- The properties under test are properties of ROLES AND RLS: who may call the
-- function, which rows it answers for, and what it does when the caller can see
-- only part of the allocation table. None of that can be asserted by reading SQL
-- text, and none of it can be exercised against this repository's real schema
-- either — the migration set is not self-contained (see
-- docs/migrations-are-not-self-contained.md), so no database can be built from
-- it. So this file builds a FAITHFUL MINIATURE of the exact policy structure the
-- function relies on, installs the shipped body against it, and runs it as three
-- different users.
--
-- The miniature reproduces, unchanged in shape:
--   * finance_payment_requests with a permissive submitter policy, a permissive
--     participant policy calling the DEFINER predicate, and the RESTRICTIVE
--     module-entry gate (20260919000000);
--   * finance_payment_allocations with its two PAYMENT-anchored SELECT policies
--     (submitter, finance.view_all) and its TARGET-anchored one (Order
--     participant) (20260918000000 §10);
--   * public.orders under its own RLS;
--   * actor_has_module_permission(), auth.uid()-based (20260901000000 §1).
--
-- Run:  psql -f supabase/tests/payment_active_allocation_totals_security.sql
-- It creates its own objects and ends in a rollback, leaving nothing behind.

\set ON_ERROR_STOP on

begin;

-- ─── The miniature ───────────────────────────────────────────────────────────

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;

-- The grants Supabase's own database already carries, restated so this file runs
-- against a bare PostgreSQL as well.
grant usage on schema public to authenticated;
grant usage on schema auth   to authenticated;
grant execute on function auth.uid() to authenticated;

create table t_users (id uuid primary key, role text, is_active boolean default true,
                      is_deleted boolean default false, finance_view_all boolean default false);

create table t_orders (id uuid primary key, owner uuid not null);
alter table t_orders enable row level security;
grant select on t_orders to authenticated;
create policy t_orders_own on t_orders for select to authenticated using (owner = auth.uid());

create table t_payments (id uuid primary key, amount numeric not null,
                         submitted_by uuid, order_id uuid);
alter table t_payments enable row level security;
grant select on t_payments to authenticated;

create table t_allocs (id uuid primary key, payment_request_id uuid not null,
                       allocated_amount numeric not null, status text not null,
                       order_id uuid);
alter table t_allocs enable row level security;
grant select on t_allocs to authenticated;

-- actor_has_module_permission: auth.uid()-based, active + non-deleted, with the
-- admin short-circuit. Sound in ANY security context, which is the point.
create or replace function t_actor_has_module_permission(p_module text, p_action text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from t_users u
    where u.id = auth.uid() and u.is_active and not u.is_deleted
      and (u.role = 'admin' or (p_module = 'finance' and p_action = 'view_all' and u.finance_view_all))
  );
$$;

-- The participant predicate, faithful in shape to 20260919000000: a SECURITY
-- DEFINER whose Order branch is a bare EXISTS on an RLS-protected table.
create or replace function t_can_read_payment_as_participant(p_payment_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from t_allocs a
    where a.payment_request_id = p_payment_id
      and a.order_id is not null
      and exists (select 1 from t_orders o where o.id = a.order_id)
  );
$$;

-- Payment policies: submitter, finance.view_all, participant, and the
-- RESTRICTIVE module gate. The participant policy calls the DEFINER predicate,
-- exactly as the real one does — reading t_allocs inline here recurses, because
-- the allocation policies read t_payments, and that recursion is precisely why
-- the real predicate is a definer.
create policy t_pay_own     on t_payments for select to authenticated
  using (submitted_by = auth.uid());
create policy t_pay_viewall on t_payments for select to authenticated
  using (t_actor_has_module_permission('finance','view_all'));
create policy t_pay_part    on t_payments for select to authenticated
  using (t_can_read_payment_as_participant(t_payments.id));
create policy t_pay_gate    on t_payments as restrictive for all to authenticated
  using (true);

-- Allocation policies: two PAYMENT-anchored, one TARGET-anchored.
create policy t_all_owner   on t_allocs for select to authenticated
  using (exists (select 1 from t_payments p
                  where p.id = t_allocs.payment_request_id and p.submitted_by = auth.uid()));
create policy t_all_viewall on t_allocs for select to authenticated
  using (t_actor_has_module_permission('finance','view_all'));
create policy t_all_order   on t_allocs for select to authenticated
  using (t_allocs.order_id is not null
         and exists (select 1 from t_orders o where o.id = t_allocs.order_id));

-- ─── The function under test: the shipped body, retargeted at the miniature ──

create or replace function t_payment_active_allocation_totals(p_payment_ids uuid[])
returns table (payment_request_id uuid, active_total numeric)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    f.id,
    case
      when t_actor_has_module_permission('finance', 'view_all')
        or f.submitted_by = auth.uid()
        then coalesce(v.visible_total, 0)
      when coalesce(v.visible_total, 0) > 0
        then v.visible_total
      else null::numeric
    end
  from t_payments f
  left join lateral (
    select sum(a.allocated_amount) as visible_total
      from t_allocs a
     where a.payment_request_id = f.id
       and a.status = 'active'
  ) v on true
  where f.id = any(coalesce(p_payment_ids, '{}'::uuid[]));
$$;

revoke execute on function t_payment_active_allocation_totals(uuid[]) from public;
grant  execute on function t_payment_active_allocation_totals(uuid[]) to authenticated;

-- THE COUNTERFACTUAL: the same question asked the way the earlier draft asked it
-- — SECURITY DEFINER, gated per id by the participant predicate. Kept so the
-- reason for SECURITY INVOKER is demonstrated rather than asserted.
create or replace function t_definer_variant(p_payment_ids uuid[])
returns table (payment_request_id uuid, active_total numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.id, coalesce((select sum(a.allocated_amount) from t_allocs a
                          where a.payment_request_id = f.id and a.status = 'active'), 0)
  from t_payments f
  where f.id = any(coalesce(p_payment_ids, '{}'::uuid[]))
    and t_can_read_payment_as_participant(f.id);
$$;
grant execute on function t_definer_variant(uuid[]) to authenticated;

-- ─── Fixtures ────────────────────────────────────────────────────────────────
--
-- SALLY    owns ORDER_X and nothing else
-- MALLORY  owns nothing at all
-- FIONA    holds finance.view_all and submitted every payment below

insert into t_users values
  ('00000000-0000-0000-0000-0000000000a1','employee', true, false, false),
  ('00000000-0000-0000-0000-0000000000a2','employee', true, false, false),
  ('00000000-0000-0000-0000-0000000000a3','employee', true, false, true);

insert into t_orders values
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a1'),  -- ORDER_X
  ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a3');  -- ORDER_Y

-- P_A  worked example A: linked to ORDER_X, NO allocations at all.
-- P_C  worked example C: linked to ORDER_X, ₹4,00,000 allocated to ORDER_Y.
-- P_D  ₹4,00,000 to ORDER_X and ₹6,00,000 to ORDER_Y, plus a reversed row.
-- P_E  reachable by nobody but its submitter: no allocations, no link.
insert into t_payments values
  ('00000000-0000-0000-0000-00000000a0d1', 1000000.00, '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-00000000a0d3', 1000000.00, '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-00000000a0d4', 1000000.00, '00000000-0000-0000-0000-0000000000a3', null),
  ('00000000-0000-0000-0000-00000000a0d5',  250000.00, '00000000-0000-0000-0000-0000000000a3', null);

insert into t_allocs values
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000a0d3', 400000.00,'active',  '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-00000000a0d4', 400000.00,'active',  '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000b3','00000000-0000-0000-0000-00000000a0d4', 600000.00,'active',  '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000b4','00000000-0000-0000-0000-00000000a0d4', 900000.00,'reversed','00000000-0000-0000-0000-0000000000e1');

-- ─── Assertions ──────────────────────────────────────────────────────────────
--
-- THE PROPERTY THAT MATTERS is not a hand-listed expectation per user. It is an
-- EQUIVALENCE: for any caller and any array, the set of ids the function answers
-- for is exactly the set of ids that caller could have SELECTed from the payment
-- table themselves. Asserted that way the test stays true however the payment
-- policies change — which is the same reason the function asks RLS rather than
-- restating it.

do $$
declare
  v_n        int;
  v_total    numeric;
  v_mismatch int;
  P_A   uuid := '00000000-0000-0000-0000-00000000a0d1';
  P_C   uuid := '00000000-0000-0000-0000-00000000a0d3';
  P_D   uuid := '00000000-0000-0000-0000-00000000a0d4';
  P_E   uuid := '00000000-0000-0000-0000-00000000a0d5';
  GHOST uuid := '00000000-0000-0000-0000-00000000ffff';
  SALLY   uuid := '00000000-0000-0000-0000-0000000000a1';
  MALLORY uuid := '00000000-0000-0000-0000-0000000000a2';
  FIONA   uuid := '00000000-0000-0000-0000-0000000000a3';
  v_ids  uuid[] := array['00000000-0000-0000-0000-00000000a0d1'::uuid,
                         '00000000-0000-0000-0000-00000000a0d3'::uuid,
                         '00000000-0000-0000-0000-00000000a0d4'::uuid,
                         '00000000-0000-0000-0000-00000000a0d5'::uuid,
                         '00000000-0000-0000-0000-00000000ffff'::uuid];
  v_user uuid;
begin
  -- ═══ ITEMS 5, 6, 7: answered ids === readable ids, for every caller ════════
  foreach v_user in array array[MALLORY, SALLY, FIONA] loop
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', v_user::text, true);

    select count(*) into v_mismatch from (
      select payment_request_id as id from t_payment_active_allocation_totals(v_ids)
      except
      select id from t_payments where id = any(v_ids)
    ) x;
    if v_mismatch <> 0 then
      raise exception
        'ITEM 6 FAILED for %: the function answered for % id(s) the caller cannot read', v_user, v_mismatch;
    end if;

    select count(*) into v_mismatch from (
      select id from t_payments where id = any(v_ids)
      except
      select payment_request_id from t_payment_active_allocation_totals(v_ids)
    ) x;
    if v_mismatch <> 0 then
      raise exception
        'ITEM 5 FAILED for %: the function withheld % id(s) the caller CAN read', v_user, v_mismatch;
    end if;

    select count(*) into v_n from t_payment_active_allocation_totals(v_ids);
    raise notice 'ITEMS 5/6/7 pass — caller % : answered ids === readable ids (% of 5)', v_user, v_n;
  end loop;

  -- A ghost id is never answered for, by anybody, so the function is not an
  -- existence oracle: unreadable and non-existent look identical.
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', FIONA::text, true);
  select count(*) into v_n from t_payment_active_allocation_totals(array[GHOST]);
  if v_n <> 0 then raise exception 'ITEM 6 FAILED: answered for a non-existent payment'; end if;
  raise notice 'ITEM 6 pass  — unreadable and non-existent are indistinguishable';

  -- And a real exclusion actually occurs, so the equivalence is not vacuous.
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', MALLORY::text, true);
  select count(*) into v_n from t_payment_active_allocation_totals(array[P_E]);
  if v_n <> 0 then
    raise exception 'ITEM 6 FAILED: Mallory obtained a total for a payment she cannot read';
  end if;
  raise notice 'ITEM 6 pass  — a genuinely unreachable payment yields no row (exclusion is real)';

  -- ═══ WORKED EXAMPLE A — the regression this correction fixes ══════════════
  -- A payment with NO allocations must report a KNOWN 0 to a reader who can
  -- vouch for it, so the direct-link fallback fires and the Order is credited in
  -- full. The gated SECURITY DEFINER draft returned NO ROW here, for anybody.
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', FIONA::text, true);
  select active_total into v_total from t_payment_active_allocation_totals(array[P_A]);
  if v_total is null then
    raise exception
      'EXAMPLE A FAILED: no allocations reported NULL to finance.view_all, so the Order would show zero received';
  end if;
  if v_total <> 0 then raise exception 'EXAMPLE A FAILED: expected 0, got %', v_total; end if;
  raise notice 'EXAMPLE A pass — no allocations reports a KNOWN 0, so the fallback fires';

  select count(*) into v_n from t_definer_variant(array[P_A]);
  if v_n <> 0 then
    raise exception 'COUNTERFACTUAL BROKEN: the definer draft should return no row for example A';
  end if;
  raise notice 'COUNTERFACTUAL — the SECURITY DEFINER draft returned NO ROW for example A, even to finance.view_all';

  -- ═══ ITEM 11 — a TARGET-anchored reader still gets a rule-1 answer ════════
  -- Sally sees only the ₹4,00,000 naming ORDER_X, not the ₹6,00,000 naming
  -- ORDER_Y. The figure is partial and still correct FOR THE RULE, because it is
  -- non-zero: allocations decide, and her own share is complete.
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', SALLY::text, true);
  select active_total into v_total from t_payment_active_allocation_totals(array[P_D]);
  if v_total is null or v_total <= 0 then
    raise exception 'ITEM 11 FAILED: a target-anchored reader got % for an allocated payment', v_total;
  end if;
  raise notice 'ITEM 11 pass — partial sight yields %, non-zero, so rule 1 still fires correctly', v_total;

  -- ═══ ITEM 11 — the ambiguous case resolves to NULL, never to 0 ════════════
  select count(*) into v_n from t_payment_active_allocation_totals(array[P_C]);
  if v_n > 0 then
    select active_total into v_total from t_payment_active_allocation_totals(array[P_C]);
    if v_total = 0 then
      raise exception
        'ITEM 11 FAILED: an unknowable total was reported as 0, which would fire the direct-link fallback and restore the over-attribution';
    end if;
    raise notice 'ITEM 11 pass — a reader who cannot vouch for 0 is given % , not 0', coalesce(v_total::text, 'NULL');
  else
    raise notice 'ITEM 11 pass — P_C is not readable by this caller, so no total is offered at all';
  end if;

  -- ═══ ITEM 8 — null, empty and duplicate arrays ════════════════════════════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', FIONA::text, true);

  select count(*) into v_n from t_payment_active_allocation_totals(null);
  if v_n <> 0 then raise exception 'ITEM 8 FAILED: a NULL array returned % rows', v_n; end if;

  select count(*) into v_n from t_payment_active_allocation_totals(array[]::uuid[]);
  if v_n <> 0 then raise exception 'ITEM 8 FAILED: an empty array returned % rows', v_n; end if;

  select count(*) into v_n from t_payment_active_allocation_totals(array[null::uuid, null::uuid]);
  if v_n <> 0 then raise exception 'ITEM 8 FAILED: an array of NULL ids returned % rows', v_n; end if;

  select count(*) into v_n from t_payment_active_allocation_totals(array[P_D, P_D, P_D, P_D, P_D]);
  if v_n <> 1 then raise exception 'ITEM 8 FAILED: 5 copies of one id produced % rows', v_n; end if;

  select active_total into v_total
    from t_payment_active_allocation_totals(array[P_D, P_D, P_D, P_D, P_D]);
  if v_total <> 1000000.00 then
    raise exception 'ITEM 8 FAILED: duplicated ids inflated the total to %', v_total;
  end if;
  raise notice 'ITEM 8 pass  — null, empty and duplicate arrays are safe and cannot inflate a total';

  -- ═══ ITEM 9 — a large array bypasses nothing and duplicates nothing ═══════
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', MALLORY::text, true);
  select count(*) into v_mismatch from (
    select payment_request_id as id from t_payment_active_allocation_totals(
      (select array_agg(g.id) from (
         select P_E as id from generate_series(1, 5000)
         union all select GHOST from generate_series(1, 5000)) g))
    except
    select id from t_payments
  ) x;
  if v_mismatch <> 0 then
    raise exception 'ITEM 9 FAILED: a 10,000-id array leaked % unreadable id(s)', v_mismatch;
  end if;

  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', FIONA::text, true);
  select count(*) into v_n from t_payment_active_allocation_totals(
    (select array_agg(g.id) from (select P_D as id from generate_series(1, 5000)) g));
  if v_n <> 1 then raise exception 'ITEM 9 FAILED: 5,000 copies of one id produced % rows', v_n; end if;
  raise notice 'ITEM 9 pass  — a 10,000-id array neither bypasses the gate nor duplicates a total';

  -- ═══ THE MECHANISM BEHIND EXPOSURE 1, kept as a demonstration ════════════
  -- t_can_read_payment_as_participant below is the shape the APPLIED
  -- can_read_payment_as_participant() has: a SECURITY DEFINER whose Order branch
  -- is a bare EXISTS on the orders table. Inside a definer, RLS on that table is
  -- evaluated for the OWNER, so the branch degenerates to "the Order exists" and
  -- the predicate is true for callers who can open no Order at all.
  --
  -- 20261006000000 §2 corrects it, and payment_participant_security.sql proves
  -- the correction against real roles. This block stays because it isolates the
  -- MECHANISM in four lines, which is the thing worth not forgetting.
  reset role; set local role authenticated;
  perform set_config('request.jwt.claim.sub', MALLORY::text, true);
  select count(*) into v_n from t_orders;
  if v_n <> 0 then raise exception 'HARNESS BROKEN: Mallory should see no Order, sees %', v_n; end if;
  if t_can_read_payment_as_participant(P_D) then
    raise notice 'MECHANISM reproduced — a bare EXISTS inside a definer makes a caller who can open NO Order a "participant" (corrected by 20261006000000 §2)';
  else
    raise notice 'MECHANISM did not reproduce — re-check the definer semantics';
  end if;

  reset role;
  raise notice 'ALL SECURITY ASSERTIONS PASSED';
end $$;

rollback;
