-- Supplement to _order_finance_reset_shaped_schema.sql, for
-- 20261011000000_admin_payment_deletion_and_payment_id.sql.
--
-- WHAT THIS ADDS, AND WHY IT IS SEPARATE FROM THE BASE FIXTURE. 20261011000000
-- depends on three things 20261010000000 does not touch and the base fixture
-- therefore does not build: allocate_payment_to_target_internal (20260919000000,
-- restated from 20260918000000), the permission probes it and the view read
-- (actor_has_module_permission, module_entry_open, can_view_order_submission),
-- and finance_received_payments itself (20261008000000) — the view 20261011000000
-- §5 replaces. Reproduced here, faithfully, rather than folded into the shared
-- fixture: a fixture that grows to match every migration stops being a fixture.
--
-- Run AFTER _order_finance_reset_shaped_schema.sql and the REAL
-- 20261010000000 migration file — see run_admin_payment_deletion_suite.sh.

-- The base fixture's finance_payment_requests carries only what 110 reads.
-- 111 replaces the 20261008000000 view, whose column list needs the rest of
-- 20260628000200's real table — add them here, matching real types exactly.
alter table public.finance_payment_requests
  add column if not exists created_at    timestamptz not null default now(),
  add column if not exists payment_date  date        not null default current_date,
  add column if not exists payment_mode  text        not null default 'cash',
  add column if not exists received_in  text        not null default 'cash_in_hand',
  add column if not exists proof_note    text        not null default '',
  add column if not exists order_number  text,
  add column if not exists order_request_number text,
  add column if not exists sales_note    text,
  add column if not exists payment_against text,
  add column if not exists approved_by   uuid references public.users(id),
  add column if not exists approved_at   timestamptz,
  add column if not exists admin_note    text;

alter table public.finance_payment_allocations
  add column if not exists created_at timestamptz not null default now();

alter table public.users
  add column if not exists full_name text;

-- ── Permission stand-ins ──────────────────────────────────────────────────────
-- Faithful to the SHAPE (admin bypass, active/not-deleted, else an explicit
-- grant), stubbed to a plain grants table rather than pulling in the whole
-- permission engine, exactly as _production_shaped_schema.sql already does for
-- resolve_permission().

create table public.finance_permission_grants (
  user_id uuid not null references public.users(id),
  action  text not null,
  primary key (user_id, action)
);

create or replace function public.actor_has_module_permission(p_module text, p_action text)
returns boolean
language sql stable
as $$
  select coalesce((
    select true
    from public.users u
    where u.id = auth.uid()
      and u.is_active and coalesce(u.is_deleted, false) = false
      and (
        u.role = 'admin'
        or exists (
          select 1 from public.finance_permission_grants g
          where g.user_id = u.id and g.action = p_module || '.' || p_action
        )
      )
  ), false)
$$;

create or replace function public.module_entry_open(p_module text) returns boolean
language sql stable as $$ select true $$;

create or replace function public.can_view_order_submission(p_id uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.order_submissions s
    where s.id = p_id
      and (s.created_by = auth.uid() or s.submitted_by = auth.uid()
           or public.actor_has_module_permission('orders', 'view_all'))
  )
$$;

-- ── allocate_payment_to_target_internal ───────────────────────────────────────
-- Read back from 20260919000000 verbatim (the deployed body 20261009000000
-- inherits unchanged), trimmed of nothing that 20261011000000's
-- allocate_payment_to_targets calls into.

create or replace function public.allocate_payment_to_target_internal(
  p_payment_request_id uuid, p_order_submission_id uuid default null,
  p_order_id uuid default null, p_allocated_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_pay         public.finance_payment_requests%rowtype;
  v_sub         public.order_submissions%rowtype;
  v_ord         public.orders%rowtype;
  v_finance_all boolean;
  v_allocated   numeric;
  v_available   numeric;
  v_origin      text;
  v_target_id   uuid;
  v_id          uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required to allocate a payment' using errcode = '28000';
  end if;

  if num_nonnulls(p_order_submission_id, p_order_id) <> 1 then
    raise exception
      'ALLOCATION_TARGET_REQUIRED: name exactly one target — a PI submission or a Confirmed Order.'
      using errcode = 'P0001';
  end if;

  if p_allocated_amount is null
     or p_allocated_amount = 'NaN'::numeric
     or p_allocated_amount <= 0
     or p_allocated_amount <> round(p_allocated_amount, 2)
  then
    raise exception
      'ALLOCATION_AMOUNT_INVALID: an allocation must be a positive amount in rupees and paise.'
      using errcode = 'P0001';
  end if;

  select * into v_pay
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: payment request % not found', p_payment_request_id
      using errcode = 'P0002';
  end if;

  if v_pay.status = 'rejected' then
    raise exception
      'PAYMENT_REJECTED: payment % was rejected and cannot receive a new allocation. Reapply it first.',
      v_pay.request_number
      using errcode = 'P0001';
  end if;

  v_finance_all := public.actor_has_module_permission('finance', 'view_all');

  if p_order_submission_id is not null then
    select * into v_sub
    from public.order_submissions
    where id = p_order_submission_id;

    if not found
       or not (v_finance_all or public.can_view_order_submission(p_order_submission_id))
    then
      raise exception
        'ALLOCATION_TARGET_NOT_AVAILABLE: the selected PI submission is not available.'
        using errcode = '42501';
    end if;

    if v_sub.deletion_claim_token is not null then
      raise exception
        'ALLOCATION_TARGET_CLAIMED: this PI is reserved for deletion and cannot receive an allocation.'
        using errcode = '55P03';
    end if;

    if v_sub.status = 'approved' then
      raise exception
        'ALLOCATION_TARGET_CONVERTED: this PI has been approved and is now an Order. Allocate to the Order instead.'
        using errcode = 'P0001';
    end if;

    if v_sub.status = 'rejected' then
      raise exception
        'ALLOCATION_TARGET_NOT_ACTIVE: a rejected PI cannot receive an allocation.'
        using errcode = 'P0001';
    end if;

    v_origin    := 'order_submission';
    v_target_id := p_order_submission_id;

  else
    select * into v_ord
    from public.orders
    where id = p_order_id;

    if not found or not (v_finance_all or public.actor_has_module_permission('orders', 'view_all')) then
      raise exception
        'ALLOCATION_TARGET_NOT_AVAILABLE: the selected Order is not available.'
        using errcode = '42501';
    end if;

    if v_ord.status = 'cancelled' then
      raise exception
        'ALLOCATION_TARGET_NOT_ACTIVE: Order % is cancelled and cannot receive an allocation.',
        v_ord.display_number
        using errcode = 'P0001';
    end if;

    v_origin    := 'confirmed_order';
    v_target_id := p_order_id;
  end if;

  if exists (
    select 1 from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_request_id
      and a.status = 'active'
      and (a.order_submission_id = p_order_submission_id or a.order_id = p_order_id)
  ) then
    raise exception
      'ALLOCATION_DUPLICATE: payment % is already allocated to this target. Reverse that allocation before creating another.',
      v_pay.request_number
      using errcode = 'P0001';
  end if;

  select coalesce(sum(a.allocated_amount), 0) into v_allocated
  from public.finance_payment_allocations a
  where a.payment_request_id = p_payment_request_id
    and a.status = 'active';

  v_available := v_pay.amount - v_allocated;

  if p_allocated_amount > v_available then
    raise exception
      'ALLOCATION_EXCEEDS_PAYMENT: payment % has % unallocated; % cannot be allocated.',
      v_pay.request_number, v_available, p_allocated_amount
      using errcode = 'P0001';
  end if;

  insert into public.finance_payment_allocations (
    payment_request_id, order_submission_id, order_id,
    allocated_amount, status, origin_target_type, created_by
  )
  values (
    p_payment_request_id, p_order_submission_id, p_order_id,
    p_allocated_amount, 'active', v_origin, v_actor
  )
  returning id into v_id;

  return jsonb_build_object(
    'allocation_id',        v_id,
    'payment_request_id',   p_payment_request_id,
    'request_number',       v_pay.request_number,
    'target_type',          v_origin,
    'target_id',            v_target_id,
    'allocated_amount',     p_allocated_amount,
    'payment_amount',       v_pay.amount,
    'unallocated_balance',  v_available - p_allocated_amount
  );
end;
$$;

-- ── finance_received_payments (20261008000000, exact column list/order) ──────
-- Reproduced with this fixture's simpler underlying columns (no
-- payment_against/order_request_number/etc. beyond what the fixture's
-- finance_payment_requests carries) — 20261011000000's CREATE OR REPLACE VIEW
-- must match this column list exactly, which is itself the test that the real
-- migration's column list is unchanged from 20261008000000.

-- EXACT column list/order of the real 20261008000000 view (see that
-- migration's own §1) — 20261011000000's CREATE OR REPLACE VIEW must match
-- this precisely, which is itself the proof its column list is unchanged.
create or replace view public.finance_received_payments
with (security_invoker = true) as
select
  b.id, b.request_number, b.client_name, b.amount, b.payment_date, b.payment_mode,
  b.received_in, b.proof_note, b.order_number, b.order_id, b.order_request_id,
  b.order_request_number, b.sales_note, b.status, b.payment_against, b.submitted_by,
  b.approved_by, b.admin_note, b.created_at, b.approved_at,
  b.submitted_by_name, b.approved_by_name,
  b.allocated_order_id, b.allocated_order_number, b.is_order_allocated,
  b.allocated_total,
  b.attributed_total,
  b.allocation_state,
  b.order_attributed_total, b.pi_attributed_total,
  b.order_allocated_total, b.pi_allocated_total, b.active_allocation_count,
  b.attribution_complete, b.available_balance,
  b.is_linked_to_order, b.is_linked_to_pi, b.is_available_to_allocate
from (
  select
    f.id, f.request_number, f.client_name, f.amount, f.payment_date, f.payment_mode,
    f.received_in, f.proof_note, f.order_number, f.order_id, f.order_request_id,
    f.order_request_number, f.sales_note, f.status, f.payment_against, f.submitted_by,
    f.approved_by, f.admin_note, f.created_at, f.approved_at,
    eb.full_name as submitted_by_name, ab.full_name as approved_by_name,
    null::uuid as allocated_order_id, null::text as allocated_order_number,
    false as is_order_allocated,
    coalesce(totals.allocated_total, 0) as allocated_total,
    case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
         when f.order_id is not null then f.amount else 0 end as attributed_total,
    case when f.amount is null then null
         when coalesce(totals.allocated_total, 0) = 0 and f.order_id is null then 'unallocated'
         when coalesce(totals.allocated_total, 0) > f.amount then 'over'
         when coalesce(totals.allocated_total, 0) = f.amount then 'full'
         else 'partial' end as allocation_state,
    coalesce(totals.order_allocated_total, 0) as order_attributed_total,
    coalesce(totals.pi_allocated_total, 0) as pi_attributed_total,
    coalesce(totals.order_allocated_total, 0) as order_allocated_total,
    coalesce(totals.pi_allocated_total, 0) as pi_allocated_total,
    coalesce(totals.active_allocation_count, 0)::integer as active_allocation_count,
    true as attribution_complete,
    greatest(f.amount - coalesce(totals.allocated_total, 0), 0) as available_balance,
    (coalesce(totals.order_allocated_total, 0) > 0) as is_linked_to_order,
    (coalesce(totals.pi_allocated_total, 0) > 0) as is_linked_to_pi,
    (greatest(f.amount - coalesce(totals.allocated_total, 0), 0) > 0) as is_available_to_allocate
  from public.finance_payment_requests f
  left join public.users eb on eb.id = f.submitted_by
  left join public.users ab on ab.id = f.approved_by
  left join lateral (
    select sum(a.allocated_amount) as allocated_total,
           sum(a.allocated_amount) filter (where a.order_id is not null) as order_allocated_total,
           sum(a.allocated_amount) filter (where a.order_submission_id is not null) as pi_allocated_total,
           count(*) as active_allocation_count
    from public.finance_payment_allocations a
    where a.payment_request_id = f.id and a.status = 'active'
  ) totals on true
) b;

revoke all privileges on public.finance_received_payments from public, anon, authenticated;
grant select on public.finance_received_payments to authenticated;

\echo 'EXTRA SCHEMA OK'
