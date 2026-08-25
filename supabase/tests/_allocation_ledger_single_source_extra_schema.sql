-- Supplement to _order_finance_reset_shaped_schema.sql for
-- 20261012000000_allocation_ledger_as_single_source.sql.
--
-- WHAT THIS ADDS, AND WHY IT IS SEPARATE. 112 replaces two objects the base
-- fixture chain does not build:
--
--   order_linked_payment_total(uuid)  — last defined by 20261006000000, and the
--                                       fixture chain stops before it
--   can_view_order_as_actor(uuid)     — the authorization probe it calls
--
-- and it drops four Link/Unlink RPCs the chain never creates.
--
-- EVERY ONE OF THESE IS BUILT IN ITS PRE-112 FORM, INCLUDING THE FALLBACK. That
-- is the point: the suite proves 112 CHANGES a real behaviour, so it first
-- reproduces the behaviour being changed. A fixture that started out already
-- correct would let a migration that does nothing pass.
--
-- Run AFTER _order_finance_reset_shaped_schema.sql, the real 20261010000000,
-- _admin_payment_deletion_and_payment_id_extra_schema.sql and the real
-- 20261011000000 — see run_allocation_ledger_single_source_suite.sh.

-- ── The Order columns order_linked_payment_total's authorization probe needs ──
alter table public.orders
  add column if not exists created_by uuid references public.users(id);

-- ── can_view_order_as_actor: a faithful stand-in ──────────────────────────────
-- Faithful to the SHAPE the real one has (20261006000000): admins see every
-- Order, everyone else sees the ones they created. The suite never depends on
-- the finer participant rules — it asserts arithmetic and exposure, and runs its
-- money assertions in the definer path (auth.uid() is null), exactly as the
-- cancellation RPCs do.
create or replace function public.can_view_order_as_actor(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id
      and (
        auth.uid() is null
        or exists (select 1 from public.users u
                    where u.id = auth.uid() and u.role = 'admin')
        or o.created_by = auth.uid()
      )
  );
$$;

-- ── order_linked_payment_total, EXACTLY as 20261006000000 leaves it ───────────
-- Copied verbatim, fallback and all. 112 replaces this.
create or replace function public.order_linked_payment_total(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with authorized as (
    select public.can_view_order_as_actor(p_order_id)
        or auth.uid() is null as ok
  ),
  candidates as (
    select f.id, f.amount, f.order_id
      from public.finance_payment_requests f
     where (select ok from authorized)
       and public.finance_payment_status_is_verified(f.status)
       and (
         f.order_id = p_order_id
         or exists (
           select 1
             from public.finance_payment_allocations a
            where a.payment_request_id = f.id
              and a.status = 'active'
              and a.order_id = p_order_id
         )
       )
  ),
  shares as (
    select
      c.id,
      c.amount,
      c.order_id,
      coalesce((
        select sum(a.allocated_amount)
          from public.finance_payment_allocations a
         where a.payment_request_id = c.id
           and a.status = 'active'
      ), 0) as active_total,
      coalesce((
        select sum(a.allocated_amount)
          from public.finance_payment_allocations a
         where a.payment_request_id = c.id
           and a.status = 'active'
           and a.order_id = p_order_id
      ), 0) as own_total
    from candidates c
  )
  select case when (select ok from authorized) then coalesce(sum(
    case
      when s.active_total > 0        then s.own_total
      when s.order_id = p_order_id   then s.amount
      else 0
    end
  ), 0) end
  from shares s;
$$;

revoke execute on function public.order_linked_payment_total(uuid) from public, anon;
grant  execute on function public.order_linked_payment_total(uuid) to authenticated;

-- ── The 40% gate's own inputs, from 20260913000000 and 20260921000000 ────────
-- 112 does not change these — they were ALREADY allocation-only, which is
-- exactly the claim §H checks. They are here so the suite can prove that
-- independently rather than assert it from the migration text.
create or replace function public.order_submission_standard_advance_percent()
returns numeric language sql immutable parallel safe
as $$ select 40::numeric $$;

create or replace function public.order_submission_required_payment(p_grand_total numeric)
returns numeric language sql immutable parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p_grand_total is null then null
    when p_grand_total = 'NaN'::numeric then null
    else p_grand_total * public.order_submission_standard_advance_percent() / 100
  end
$$;

-- Verbatim from 20260921000000 §3: active allocations naming the PI whose
-- parent payment Finance has verified. No linkage column enters it, and none
-- ever could — a PI has none.
create or replace function public.order_submission_verified_payment(p_submission_id uuid)
returns numeric language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(a.allocated_amount), 0)::numeric
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id
    and a.status = 'active'
    and public.finance_payment_status_is_verified(f.status)
$$;

revoke execute on function public.order_submission_verified_payment(uuid)
  from public, anon, authenticated, service_role;

-- ── finance_payment_allocations_enforce_capacity, from 20260918000000 §5 ──────
-- The base fixture chain does not build it, and 112's apply-time assertions
-- require it: a migration that made allocations authoritative while quietly
-- losing the invariant that keeps them under the payment amount would be worse
-- than the defect it fixes. Copied faithfully — payment-side only, locking the
-- parent row FOR UPDATE, excluding this row by id so INSERT and UPDATE are one
-- statement.
create or replace function public.finance_payment_allocations_enforce_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_amount    numeric;
  v_allocated numeric;
begin
  if new.status <> 'active' then
    return new;
  end if;

  select f.amount into v_amount
  from public.finance_payment_requests f
  where f.id = new.payment_request_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: payment request % does not exist', new.payment_request_id
      using errcode = 'P0002';
  end if;

  select coalesce(sum(a.allocated_amount), 0) into v_allocated
  from public.finance_payment_allocations a
  where a.payment_request_id = new.payment_request_id
    and a.status = 'active'
    and a.id <> new.id;

  if v_allocated + new.allocated_amount > v_amount then
    raise exception
      'ALLOCATION_EXCEEDS_PAYMENT: allocating % would take the active allocated total to % against a payment of %',
      new.allocated_amount, v_allocated + new.allocated_amount, v_amount
      using errcode = 'P0001';
  end if;

  return new;
end $$;

drop trigger if exists finance_payment_allocations_enforce_capacity
  on public.finance_payment_allocations;
create trigger finance_payment_allocations_enforce_capacity
  before insert or update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_enforce_capacity();

-- ── The four Link/Unlink RPCs, in their real signatures ───────────────────────
-- Bodies are stand-ins: the suite proves they are DROPPED, and the drop is by
-- signature. What matters is that four functions with these exact identities
-- exist before 112 runs, carry the grants 20260901000000 gives them, and can in
-- fact write order_id — which is what makes dropping them worth doing.
create or replace function public.link_finance_payment_to_order(
  p_payment_request_id uuid,
  p_order_id           uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.finance_payment_requests
     set order_id = p_order_id, status = 'approved_linked'
   where id = p_payment_request_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.link_finance_payment_to_order_request(
  p_payment_request_id uuid,
  p_order_request_id   uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.finance_payment_requests
     set order_request_id = p_order_request_id
   where id = p_payment_request_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.unlink_finance_payment_from_order(
  p_payment_request_id uuid,
  p_reason             text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.finance_payment_requests
     set order_id = null, status = 'approved_unlinked'
   where id = p_payment_request_id;
  return jsonb_build_object('ok', true, 'reason', p_reason);
end $$;

create or replace function public.unlink_finance_payment_from_order_request(
  p_payment_request_id uuid,
  p_reason             text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.finance_payment_requests
     set order_request_id = null
   where id = p_payment_request_id;
  return jsonb_build_object('ok', true, 'reason', p_reason);
end $$;

revoke execute on function public.link_finance_payment_to_order(uuid, uuid)              from public, anon;
grant  execute on function public.link_finance_payment_to_order(uuid, uuid)              to authenticated;
revoke execute on function public.unlink_finance_payment_from_order(uuid, text)          from public, anon;
grant  execute on function public.unlink_finance_payment_from_order(uuid, text)          to authenticated;
revoke execute on function public.unlink_finance_payment_from_order_request(uuid, text)  from public, anon;
grant  execute on function public.unlink_finance_payment_from_order_request(uuid, text)  to authenticated;
-- link_..._to_order_request is executable by NO client role: 20261007000000
-- revoked it when the Order Request workflow was retired.
revoke execute on function public.link_finance_payment_to_order_request(uuid, uuid)
  from public, anon, authenticated;

-- ── Row-level security, ON, as production has it ─────────────────────────────
-- The shaped fixture builds tables without it; the real policies come from
-- migrations this chain does not replay. Enabling it HERE — before 112 — is what
-- makes §K's assertion mean something: it proves the migration did not turn RLS
-- off, which is a thing a careless `alter table` in a later revision could do.
-- The suite runs as the superuser, which bypasses RLS, so this changes no
-- assertion's arithmetic.
alter table public.finance_payment_allocations enable row level security;
alter table public.finance_payment_requests    enable row level security;

-- anon must be able to reach neither table directly. Asserted in §K.
revoke all on public.finance_payment_allocations from anon;
revoke all on public.finance_payment_requests    from anon;
