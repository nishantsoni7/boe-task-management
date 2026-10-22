-- ═══════════════════════════════════════════════════════════════════════════
-- 20270407000000 — Allocating a payment to an OLD ORDER that is not in this system
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE GAP. Money often arrives for an order that predates this system and was
-- never entered into it. An allocation had to name a PI Draft or a Confirmed
-- Order that exists here (exactly one of order_submission_id / order_id), so
-- such a payment could not be allocated at all and stayed "Zero Allocated".
--
-- THE CHANGE. A third kind of allocation target, a LEGACY ORDER: a row of
-- finance_payment_allocations that names no record in this system, only the old
-- order's number and the client's name, as typed by the person allocating.
--
--   * The row is a real allocation. It spends part of the payment, so the
--     payment's allocated total, "Zero / Partially / Fully Allocated" and its
--     unallocated balance all count it. finance_received_payments computes those
--     from every ACTIVE allocation, so that view is NOT redefined here.
--   * It is NOT money for any Order or PI Draft here. Every Order total reads
--     allocations by order_id, a PI total by order_submission_id; a legacy row has
--     neither, so it can never reach the 40% payment gate or an Order's received
--     figure. That is the point of keeping it a separate kind rather than
--     inventing a placeholder Order.
--   * One payment holds at most one ACTIVE allocation per legacy order number
--     (compared ignoring case and spacing), the same rule it already has for an
--     Order or a PI Draft. Reversal keeps the row, exactly as before.
--   * Authority is unchanged: finance.allocate (and finance module entry) to
--     create, finance.allocate_correct to reverse.
--
-- WHAT IS RESTATED, and nothing wider (each is the latest deployed body with the
-- named additions): the immutability guard (finance_payment_allocations_guard_
-- transition, 20260921000000 §5) and the activity writer (log_finance_payment_
-- allocation_activity, 20260921000000 §6) learn the new columns;
-- allocate_payment_to_targets (20261011000000 §4) accepts a legacy target;
-- received_payment_allocation_targets (20270116000000 §5) returns legacy rows
-- (one column appended: target_client_name); payment_allocation_ledger_for_
-- correction (20261215000000) names them. record_payment_with_allocations_core
-- is wrapped, not rewritten: the deployed core is renamed ..._base and a thin
-- core takes the old-order rows out of the list, hands the rest to the base, and
-- allocates the old-order rows in the same transaction.
--
-- NOT TOUCHED: finance_payment_destinations (a payment whose only destination is
-- a legacy order still reads as having no Order or PI destination there; the
-- application names the legacy order from the allocation list), the RLS policies
-- of the allocations table (a legacy row is readable by exactly the people who
-- can already read how the payment is split: admin, finance.view_all, the
-- payment's submitter), and every Order / PI total.
--
-- KNOWN LIMIT. edit_payment_request on a still-pending payment whose single
-- allocation is a legacy order refuses to change its AMOUNT (the "follow the
-- amount" step needs an Order or PI to re-allocate to). Reverse it through
-- Correct Allocation first.
--
-- ROLLBACK: reverse any legacy allocations (Correct Allocation) and re-emit the
-- previous bodies; no data is lost by leaving the columns in place.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.finance_payment_allocations') is null
     or to_regprocedure('public.allocate_payment_to_targets(uuid, jsonb)') is null
     or to_regprocedure('public.record_payment_with_allocations_core(numeric, date, text, text, text, text, text, jsonb, jsonb)') is null
     or to_regprocedure('public.received_payment_allocation_targets(uuid[])') is null
     or to_regprocedure('public.payment_allocation_ledger_for_correction(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: the allocation model (20260918000000 .. 20270116000000) must be applied first';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- §1. The columns, and the rule that a row names exactly one kind of target
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.finance_payment_allocations
  add column if not exists legacy_order_no    text,
  add column if not exists legacy_client_name text;

comment on column public.finance_payment_allocations.legacy_order_no is
  'The OLD order number a legacy-order allocation was made against, typed by the allocator and stored trimmed, with runs of spaces collapsed, in upper case. Set only when neither order_submission_id nor order_id is. Names nothing in this system.';
comment on column public.finance_payment_allocations.legacy_client_name is
  'The client the old order belongs to, as typed by the allocator. Set together with legacy_order_no and never otherwise.';

-- The normal form of an old order number. Used by the allocator and by the
-- unique index, so "ab-12", " AB-12 " and "AB-12" are one order.
create or replace function public.normalize_legacy_order_no(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g')), '')
$$;

revoke execute on function public.normalize_legacy_order_no(text) from public, anon;
grant  execute on function public.normalize_legacy_order_no(text) to authenticated;

alter table public.finance_payment_allocations
  drop constraint if exists finance_payment_allocations_one_target;
alter table public.finance_payment_allocations
  add constraint finance_payment_allocations_one_target check (
    num_nonnulls(order_submission_id, order_id, legacy_order_no) = 1
  );

alter table public.finance_payment_allocations
  drop constraint if exists finance_payment_allocations_origin_known;
alter table public.finance_payment_allocations
  add constraint finance_payment_allocations_origin_known check (
    origin_target_type in ('order_submission', 'confirmed_order', 'legacy_order')
  );

-- A legacy row carries both facts, trimmed and bounded, and ONLY a legacy row
-- carries them or the legacy provenance.
alter table public.finance_payment_allocations
  drop constraint if exists finance_payment_allocations_legacy_shape;
alter table public.finance_payment_allocations
  add constraint finance_payment_allocations_legacy_shape check (
    (origin_target_type = 'legacy_order') = (legacy_order_no is not null)
    and (legacy_order_no is null) = (legacy_client_name is null)
    and (
      legacy_order_no is null
      or (
        order_submission_id is null
        and order_id is null
        and legacy_order_no = public.normalize_legacy_order_no(legacy_order_no)
        and length(legacy_order_no) <= 60
        and btrim(legacy_client_name) <> ''
        and legacy_client_name = btrim(legacy_client_name)
        and length(legacy_client_name) <= 120
      )
    )
  );

-- One ACTIVE claim per payment per legacy order, like the two indexes beside it.
create unique index if not exists finance_payment_allocations_unique_active_legacy
  on public.finance_payment_allocations (payment_request_id, legacy_order_no)
  where status = 'active' and legacy_order_no is not null;

create index if not exists finance_payment_allocations_legacy_order_idx
  on public.finance_payment_allocations (legacy_order_no)
  where legacy_order_no is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- §2. What may change about an allocation — the legacy columns are immutable
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260921000000 §5 verbatim (same attributes: SECURITY INVOKER, search_path)
-- plus the two new columns in the immutability clause. The PI-to-Order
-- conversion branch is unchanged and cannot apply to a legacy row, which has no
-- order_submission_id.

create or replace function public.finance_payment_allocations_guard_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_conversion boolean := false;
begin
  if old.status = 'active'
     and old.order_submission_id is not null
     and public.in_pi_submission_approval(old.order_submission_id)
     and new.order_submission_id is null
     and new.order_id is not null
     and new.id                 is not distinct from old.id
     and new.payment_request_id is not distinct from old.payment_request_id
     and new.allocated_amount   is not distinct from old.allocated_amount
     and new.origin_target_type is not distinct from old.origin_target_type
     and new.created_by         is not distinct from old.created_by
     and new.created_at         is not distinct from old.created_at
     and new.status             is not distinct from old.status
     and new.reversed_by        is not distinct from old.reversed_by
     and new.reversed_at        is not distinct from old.reversed_at
     and new.reversal_reason    is not distinct from old.reversal_reason
     and new.legacy_order_no    is not distinct from old.legacy_order_no
     and new.legacy_client_name is not distinct from old.legacy_client_name
     and exists (
       select 1 from public.orders o
       where o.id = new.order_id
         and o.source_order_submission_id = old.order_submission_id
     )
  then
    v_conversion := true;
  end if;

  if not v_conversion then
    if new.id                  is distinct from old.id
       or new.payment_request_id  is distinct from old.payment_request_id
       or new.order_submission_id is distinct from old.order_submission_id
       or new.order_id            is distinct from old.order_id
       or new.legacy_order_no     is distinct from old.legacy_order_no
       or new.legacy_client_name  is distinct from old.legacy_client_name
       or new.allocated_amount    is distinct from old.allocated_amount
       or new.origin_target_type  is distinct from old.origin_target_type
       or new.created_by          is distinct from old.created_by
       or new.created_at          is distinct from old.created_at
    then
      raise exception
        'ALLOCATION_IMMUTABLE: an allocation''s payment, target, amount, provenance and creation record cannot be changed. Reverse it and create another.'
        using errcode = '42501';
    end if;
  end if;

  if old.status = 'reversed' then
    if new.status is distinct from old.status then
      raise exception
        'ALLOCATION_REVERSAL_FINAL: a reversed allocation can never be made active again. Create a new allocation instead.'
        using errcode = '42501';
    end if;

    if new.reversed_by     is distinct from old.reversed_by
       or new.reversed_at     is distinct from old.reversed_at
       or new.reversal_reason is distinct from old.reversal_reason
    then
      raise exception
        'ALLOCATION_REVERSAL_IMMUTABLE: a recorded reversal cannot be rewritten.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.finance_payment_allocations_guard_transition()
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- §3. The audit trail names a legacy order
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260921000000 §6 verbatim, except that the payload of a legacy row says
-- target_type 'legacy_order' with the order number and client in place of a
-- target id (which a legacy row does not have).

create or replace function public.log_finance_payment_allocation_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid;
  v_event   text;
  v_payload jsonb;
begin
  if tg_op = 'INSERT' then
    v_event := 'allocation_created';
    v_actor := new.created_by;
  elsif old.status = 'active' and new.status = 'reversed' then
    v_event := 'allocation_reversed';
    v_actor := new.reversed_by;
  elsif old.status = 'active' and new.status = 'active'
        and old.order_submission_id is not null
        and new.order_submission_id is null
        and new.order_id is not null then
    v_event := 'allocation_moved';
    v_actor := auth.uid();
  else
    return null;
  end if;

  v_payload := jsonb_build_object(
    'allocation_id',      new.id,
    'target_type',        case when new.legacy_order_no is not null then 'legacy_order'
                               when new.order_submission_id is not null then 'order_submission'
                               else 'confirmed_order' end,
    'target_id',          coalesce(new.order_submission_id, new.order_id),
    'allocated_amount',   new.allocated_amount,
    'origin_target_type', new.origin_target_type
  );

  if new.legacy_order_no is not null then
    v_payload := v_payload || jsonb_build_object(
      'legacy_order_no',    new.legacy_order_no,
      'legacy_client_name', new.legacy_client_name
    );
  end if;

  if v_event = 'allocation_reversed' then
    v_payload := v_payload || jsonb_build_object(
      'reversal_reason', new.reversal_reason,
      'reversed_at',     new.reversed_at
    );
  end if;

  if v_event = 'allocation_moved' then
    v_payload := v_payload || jsonb_build_object(
      'moved_from_order_submission_id', old.order_submission_id,
      'moved_to_order_id',              new.order_id,
      'payment_request_id',             new.payment_request_id
    );
  end if;

  insert into public.finance_payment_request_activity_log
    (payment_request_id, actor_id, event_type, payload)
  values
    (new.payment_request_id, v_actor, v_event, v_payload);

  return null;
end;
$$;

revoke execute on function public.log_finance_payment_allocation_activity()
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- §4. Allocating to a legacy order — the one implementation
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The legacy counterpart of allocate_payment_to_target_internal. There is no
-- target record to lock or judge, so the order is simply: the payment's lock,
-- the rejected-money refusal, the one-claim-per-order rule, the derived balance
-- under the lock, then the write. Authorization belongs to the two doors that
-- call this; it is executable by no client role.

create or replace function public.allocate_payment_to_legacy_order_internal(
  p_payment_request_id uuid,
  p_legacy_order_no    text,
  p_legacy_client_name text,
  p_allocated_amount   numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_pay       public.finance_payment_requests%rowtype;
  v_order_no  text := public.normalize_legacy_order_no(p_legacy_order_no);
  v_client    text := nullif(btrim(coalesce(p_legacy_client_name, '')), '');
  v_allocated numeric;
  v_available numeric;
  v_id        uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required to allocate a payment' using errcode = '28000';
  end if;

  if v_order_no is null then
    raise exception 'ALLOCATION_LEGACY_ORDER_REQUIRED: enter the old order number.'
      using errcode = 'P0001';
  end if;
  if length(v_order_no) > 60 then
    raise exception 'ALLOCATION_LEGACY_ORDER_TOO_LONG: an old order number can be at most 60 characters.'
      using errcode = 'P0001';
  end if;
  if v_client is null then
    raise exception 'ALLOCATION_LEGACY_CLIENT_REQUIRED: enter the client the old order belongs to.'
      using errcode = 'P0001';
  end if;
  if length(v_client) > 120 then
    raise exception 'ALLOCATION_LEGACY_CLIENT_TOO_LONG: a client name can be at most 120 characters.'
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

  if exists (
    select 1 from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_request_id
      and a.status = 'active'
      and a.legacy_order_no = v_order_no
  ) then
    raise exception
      'ALLOCATION_DUPLICATE: payment % is already allocated to old order %. Reverse that allocation before creating another.',
      v_pay.request_number, v_order_no
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
    payment_request_id, legacy_order_no, legacy_client_name,
    allocated_amount, status, origin_target_type, created_by
  )
  values (
    p_payment_request_id, v_order_no, v_client,
    p_allocated_amount, 'active', 'legacy_order', v_actor
  )
  returning id into v_id;

  return jsonb_build_object(
    'allocation_id',        v_id,
    'payment_request_id',   p_payment_request_id,
    'request_number',       v_pay.request_number,
    'target_type',          'legacy_order',
    'target_id',            null,
    'legacy_order_no',      v_order_no,
    'legacy_client_name',   v_client,
    'allocated_amount',     p_allocated_amount,
    'payment_amount',       v_pay.amount,
    'unallocated_balance',  v_available - p_allocated_amount
  );
end;
$$;

revoke execute on function public.allocate_payment_to_legacy_order_internal(uuid, text, text, numeric)
  from public, anon, authenticated;

comment on function public.allocate_payment_to_legacy_order_internal(uuid, text, text, numeric) is
  'Allocates part or all of one payment to an OLD order that is not in this system, named by its number and client. Locks the payment, refuses rejected money and a second active claim on the same old order, and re-derives the balance under the lock. Authorization belongs to its two doors; executable by no client role. 20270407000000.';

-- ═══════════════════════════════════════════════════════════════════════════
-- §5. allocate_payment_to_targets accepts a legacy target
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20261011000000 §4 verbatim, plus: an item that carries `legacy_order_no` is a
-- legacy target ({legacy_order_no, legacy_client_name, allocated_amount}) and is
-- refused if it also names a PI or an Order.

create or replace function public.allocate_payment_to_targets(
  p_payment_request_id uuid,
  p_targets            jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_item    jsonb;
  v_result  jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count   int;
begin
  if v_actor is null then
    raise exception 'Authentication required to allocate a payment' using errcode = '28000';
  end if;

  if not public.actor_has_module_permission('finance', 'allocate') then
    raise exception 'You do not have permission to allocate payments' using errcode = '42501';
  end if;

  if p_targets is null or jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) = 0 then
    raise exception
      'ALLOCATION_TARGETS_REQUIRED: at least one allocation target is required'
      using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_targets) > 20 then
    raise exception
      'ALLOCATION_TARGETS_TOO_MANY: at most 20 allocation targets are allowed in one submission'
      using errcode = 'P0001';
  end if;

  v_count := 0;
  for v_item in select value from jsonb_array_elements(p_targets)
  loop
    if nullif(v_item->>'legacy_order_no', '') is not null then
      if nullif(v_item->>'order_submission_id', '') is not null
         or nullif(v_item->>'order_id', '') is not null then
        raise exception
          'ALLOCATION_TARGET_REQUIRED: name exactly one target — a PI submission, a Confirmed Order or an old order.'
          using errcode = 'P0001';
      end if;

      v_result := public.allocate_payment_to_legacy_order_internal(
        p_payment_request_id,
        v_item->>'legacy_order_no',
        v_item->>'legacy_client_name',
        nullif(v_item->>'allocated_amount', '')::numeric
      );
    else
      v_result := public.allocate_payment_to_target_internal(
        p_payment_request_id,
        nullif(v_item->>'order_submission_id', '')::uuid,
        nullif(v_item->>'order_id', '')::uuid,
        nullif(v_item->>'allocated_amount', '')::numeric
      );
    end if;
    v_results := v_results || jsonb_build_array(v_result);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('allocations', v_results, 'count', v_count);
end;
$$;

revoke execute on function public.allocate_payment_to_targets(uuid, jsonb) from public, anon;
grant  execute on function public.allocate_payment_to_targets(uuid, jsonb) to authenticated;

comment on function public.allocate_payment_to_targets(uuid, jsonb) is
  'Allocates a payment across up to 20 targets in one atomic submission. p_targets is a JSON array of {order_submission_id?, order_id?, allocated_amount} or, for an OLD order not in this system, {legacy_order_no, legacy_client_name, allocated_amount}. Requires finance.allocate once, then calls the single allocation implementation once per target inside this one transaction — a refusal on any target rolls the entire submission back, so a partial split is never committed. 20261011000000, 20270407000000.';

-- ═══════════════════════════════════════════════════════════════════════════
-- §6. Record Payment: old-order rows ride in the same allocation list
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The deployed core (20261014000000, as amended by 20270111120000) is renamed
-- and left exactly as it is. The new core has the same signature, so the
-- idempotency wrapper above it (20261219000000) is untouched and its
-- fingerprint covers the old-order rows too. An old-order row is
-- {kind:'legacy', order_no, client_name, amount}.
--
-- The base validates and writes every non-legacy row and the payment; the
-- old-order rows are then allocated through the one legacy implementation, in
-- the order listed, in the same transaction — a refusal on any row rolls the
-- whole entry back, payment included. The display customer is then re-derived
-- over ALL the targets with the rule the base uses: one distinct customer is
-- stored, none or several store NULL.

alter function public.record_payment_with_allocations_core(numeric, date, text, text, text, text, text, jsonb, jsonb)
  rename to record_payment_with_allocations_base;

revoke execute on function public.record_payment_with_allocations_base(numeric, date, text, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated;

create function public.record_payment_with_allocations_core(
  p_amount       numeric,
  p_payment_date date,
  p_payment_mode text,
  p_client_name  text,
  p_received_in  text    default null,
  p_reference    text    default null,
  p_remarks      text    default null,
  p_allocations  jsonb   default '[]'::jsonb,
  p_custody_events jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_regular    jsonb := '[]'::jsonb;
  v_row        jsonb;
  v_legacy     jsonb := '[]'::jsonb;
  v_index      integer := 0;
  v_share      numeric;
  v_legacy_sum numeric := 0;
  v_seen       text[] := array[]::text[];
  v_no         text;
  v_client     text;
  v_result     jsonb;
  v_payment    uuid;
  v_alloc      jsonb;
  v_results    jsonb;
  v_name       text;
  v_names      integer;
begin
  -- Not an array, or no old-order row at all: the deployed behaviour, untouched.
  if p_allocations is null
     or jsonb_typeof(p_allocations) <> 'array'
     or not exists (
       select 1 from jsonb_array_elements(p_allocations) e
       where jsonb_typeof(e) = 'object' and btrim(lower(coalesce(e->>'kind', ''))) = 'legacy'
     )
  then
    return public.record_payment_with_allocations_base(p_amount, p_payment_date, p_payment_mode,
      p_client_name, p_received_in, p_reference, p_remarks, p_allocations, p_custody_events);
  end if;

  -- The 20-row bound covers the whole list, old-order rows included.
  if jsonb_array_length(p_allocations) > 20 then
    raise exception
      'PAYMENT_ALLOCATIONS_TOO_MANY: a payment may be divided at most 20 ways in one entry.'
      using errcode = 'P0001';
  end if;

  -- Shape-check the old-order rows here, naming the row the person is looking at.
  for v_row in select jsonb_array_elements(p_allocations) loop
    v_index := v_index + 1;

    if jsonb_typeof(v_row) = 'object'
       and btrim(lower(coalesce(v_row->>'kind', ''))) = 'legacy' then
      v_no     := public.normalize_legacy_order_no(v_row->>'order_no');
      v_client := nullif(btrim(coalesce(v_row->>'client_name', '')), '');

      if v_no is null or length(v_no) > 60 then
        raise exception
          'PAYMENT_ALLOCATION_LEGACY_ORDER_INVALID: row % must name the old order number (at most 60 characters).', v_index
          using errcode = 'P0001';
      end if;
      if v_client is null or length(v_client) > 120 then
        raise exception
          'PAYMENT_ALLOCATION_LEGACY_CLIENT_INVALID: row % must name the old order''s client (at most 120 characters).', v_index
          using errcode = 'P0001';
      end if;

      begin
        v_share := (v_row->>'amount')::numeric;
      exception when others then
        v_share := null;
      end;
      if v_share is null
         or v_share = 'NaN'::numeric
         or v_share <= 0
         or v_share <> round(v_share, 2)
      then
        raise exception
          'PAYMENT_ALLOCATION_AMOUNT_INVALID: row % must allocate a positive amount in rupees and paise.', v_index
          using errcode = 'P0001';
      end if;

      if v_no = any (v_seen) then
        raise exception
          'ALLOCATION_DUPLICATE: old order % is listed twice. One payment holds one allocation per record.', v_no
          using errcode = 'P0001';
      end if;
      v_seen := v_seen || v_no;
      v_legacy_sum := v_legacy_sum + v_share;

      v_legacy := v_legacy || jsonb_build_array(jsonb_build_object(
        'row', v_index, 'order_no', v_no, 'client_name', v_client, 'amount', v_share));
    else
      v_regular := v_regular || jsonb_build_array(v_row);
    end if;
  end loop;

  if p_amount is not null and p_amount <> 'NaN'::numeric and v_legacy_sum > p_amount then
    raise exception
      'PAYMENT_ALLOCATIONS_EXCEED_AMOUNT: % allocated is more than the % received.', v_legacy_sum, p_amount
      using errcode = 'P0001';
  end if;

  -- The payment, and every Order / PI Draft row, exactly as before. The base
  -- also refuses the list when the REMAINING rows exceed the amount; the
  -- allocator below re-checks the grand total under the payment lock.
  v_result  := public.record_payment_with_allocations_base(p_amount, p_payment_date, p_payment_mode,
    p_client_name, p_received_in, p_reference, p_remarks, v_regular, p_custody_events);
  v_payment := (v_result->>'payment_request_id')::uuid;
  v_results := coalesce(v_result->'allocations', '[]'::jsonb);

  for v_row in select jsonb_array_elements(v_legacy) loop
    v_alloc := public.allocate_payment_to_legacy_order_internal(
      v_payment, v_row->>'order_no', v_row->>'client_name', (v_row->>'amount')::numeric);

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row',              (v_row->>'row')::integer,
      'kind',             'legacy',
      'target_id',        null,
      'legacy_order_no',  v_row->>'order_no',
      'allocation_id',    v_alloc->>'allocation_id',
      'allocated_amount', (v_row->>'amount')::numeric
    ));
  end loop;

  -- The display customer over ALL the targets: one distinct name, else NULL.
  select count(distinct n.name), min(n.name) into v_names, v_name
  from (
    select nullif(btrim(coalesce(o.client_name, s.client_name, a.legacy_client_name, '')), '') as name
    from public.finance_payment_allocations a
    left join public.orders            o on o.id = a.order_id
    left join public.order_submissions s on s.id = a.order_submission_id
    where a.payment_request_id = v_payment and a.status = 'active'
  ) n
  where n.name is not null;

  update public.finance_payment_requests
     set client_name = case when v_names = 1 then v_name end
   where id = v_payment
     and client_name is distinct from (case when v_names = 1 then v_name end);

  return v_result || jsonb_build_object(
    'allocation_count',    jsonb_array_length(p_allocations),
    'allocated_total',     coalesce((v_result->>'allocated_total')::numeric, 0) + v_legacy_sum,
    'unallocated_balance', p_amount - coalesce((v_result->>'allocated_total')::numeric, 0) - v_legacy_sum,
    'allocations',         v_results
  );
end;
$$;

revoke execute on function public.record_payment_with_allocations_core(numeric, date, text, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated;

comment on function public.record_payment_with_allocations_core(numeric, date, text, text, text, text, text, jsonb, jsonb) is
  'Takes old-order rows ({kind:''legacy'', order_no, client_name, amount}) out of the allocation list, hands the rest to record_payment_with_allocations_base (the 20261014000000 / 20270111120000 body, unchanged) and allocates the old-order rows in the same transaction, then re-derives the display customer over every target. Closed to clients; the idempotency wrapper calls it. 20270407000000.';

-- ═══════════════════════════════════════════════════════════════════════════
-- §7. Allocated Against: legacy rows are listed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20270116000000 §5 with ONE column appended (target_client_name, the client of
-- a legacy order; null for an Order or PI Draft) and legacy rows no longer
-- filtered out: target_type 'legacy_order', target_id null, target_reference the
-- old order number. A return type cannot change in place, so the function is
-- dropped and re-created with its grants.

drop function public.received_payment_allocation_targets(uuid[]);

create function public.received_payment_allocation_targets(
  p_payment_request_ids uuid[]
)
returns table (
  payment_request_id    uuid,
  allocation_id         uuid,
  target_type           text,
  target_id             uuid,
  target_reference      text,
  reserved_order_number text,
  allocated_amount      numeric,
  target_client_name    text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'ALLOCATION_TARGETS_AUTH_REQUIRED: sign in to read payment allocations.'
      using errcode = '28000';
  end if;

  if not coalesce(public.module_entry_open('finance'), false) then
    raise exception 'ALLOCATION_TARGETS_NOT_PERMITTED: Finance access is required.'
      using errcode = '42501';
  end if;

  if not coalesce(public.actor_has_module_permission('finance', 'view'), false) then
    raise exception 'ALLOCATION_TARGETS_NOT_PERMITTED: you do not have permission to view Finance payments.'
      using errcode = '42501';
  end if;

  if coalesce(cardinality(p_payment_request_ids), 0) > 50 then
    raise exception 'ALLOCATION_TARGETS_TOO_MANY: at most 50 payments may be read at once (got %).',
      cardinality(p_payment_request_ids)
      using errcode = '22023';
  end if;

  if coalesce(cardinality(p_payment_request_ids), 0) = 0 then
    return;
  end if;

  return query
  select
    a.payment_request_id,
    a.id,
    case when a.legacy_order_no is not null then 'legacy_order'
         when a.order_id is not null then 'order'
         else 'pi_draft' end,
    coalesce(a.order_id, a.order_submission_id),
    case
      when a.legacy_order_no is not null then a.legacy_order_no
      when a.order_id is not null then nullif(btrim(o.display_number), '')
      -- The draft's stable reference (20270114000000). Never source_order_number.
      else coalesce(nullif(btrim(s.draft_reference), ''),
                    nullif(btrim(regexp_replace(coalesce(s.source_workbook_name, ''), '^.*[\\/]', '')), ''))
    end,
    case when a.legacy_order_no is null and a.order_id is null
         then nullif(btrim(s.reserved_order_number), '') end,
    a.allocated_amount,
    a.legacy_client_name
  from public.finance_payment_requests f
  join public.finance_payment_allocations a on a.payment_request_id = f.id
  left join public.orders            o on o.id = a.order_id
  left join public.order_submissions s on s.id = a.order_submission_id
  where f.id = any (p_payment_request_ids)
    and public.finance_payment_status_is_verified(f.status)
    and public.received_payment_visible_to_actor(f.id)
    and a.status = 'active'
    and (a.order_id is not null or a.order_submission_id is not null or a.legacy_order_no is not null)
  order by a.payment_request_id, a.created_at, a.id;
end;
$$;

comment on function public.received_payment_allocation_targets(uuid[]) is
  'The ACTIVE allocation targets (type, id, safe reference, reserved Order number, amount, client of a legacy order) of at most 50 CONFIRMED payments, for the Confirmed Payments list''s Allocated Against cell and Allocation Status badge. A PI Draft is named by its draft reference, an Order by its number, an OLD order not in this system (target_type legacy_order, no target_id) by the number typed when it was allocated. Returns rows only to an authenticated caller with Finance module entry who holds finance.view as an active user (admin bypass), and only for payments that caller may already read. Never returns source_order_number, client or other Order/PI fields. 20261216000000, 20270116000000, 20270407000000.';

revoke execute on function public.received_payment_allocation_targets(uuid[]) from public, anon, service_role;
grant  execute on function public.received_payment_allocation_targets(uuid[]) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- §8. Correct Allocation: the ledger names a legacy order
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20261215000000 §1 verbatim; only the reference and client expressions learn
-- the legacy columns. Same signature, so it is replaced in place.

create or replace function public.payment_allocation_ledger_for_correction(
  p_payment_request_id uuid
)
returns table (
  allocation_id       uuid,
  status              text,
  allocated_amount    numeric,
  order_id            uuid,
  order_submission_id uuid,
  target_reference    text,
  client_name         text,
  created_at          timestamptz,
  reversed_at         timestamptz,
  reversal_reason     text,
  reversed_by_name    text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor   uuid := auth.uid();
  v_pay     public.finance_payment_requests%rowtype;
  v_visible boolean := false;
begin
  if v_actor is null then
    raise exception 'ALLOCATION_LEDGER_AUTH_REQUIRED: sign in to read a payment''s allocations.'
      using errcode = '28000';
  end if;

  if not coalesce(public.module_entry_open('finance'), false) then
    raise exception 'ALLOCATION_LEDGER_NOT_PERMITTED: Finance access is required to correct allocations.'
      using errcode = '42501';
  end if;

  if not coalesce(public.actor_has_module_permission('finance', 'allocate_correct'), false) then
    raise exception 'ALLOCATION_LEDGER_NOT_PERMITTED: you do not have permission to correct payment allocations.'
      using errcode = '42501';
  end if;

  select * into v_pay
  from public.finance_payment_requests f
  where f.id = p_payment_request_id;

  if found then
    v_visible :=
      v_pay.submitted_by = v_actor
      or exists (
        select 1 from public.users u
        where u.id = v_actor and u.role = 'admin'
      )
      or coalesce(public.resolve_permission(v_actor, 'finance', 'view_all'), false)
      or coalesce(public.can_read_payment_as_participant(v_pay.id), false)
      or (v_pay.order_request_id is not null and exists (
            select 1 from public.order_requests r
            where r.id = v_pay.order_request_id
              and (r.created_by = v_actor or r.requested_by = v_actor)))
      or (v_pay.order_id is not null and exists (
            select 1 from public.order_requests r
            where r.converted_order_id = v_pay.order_id
              and (r.created_by = v_actor or r.requested_by = v_actor)))
      or (v_pay.order_request_id is not null and exists (
            select 1 from public.order_requests r
            where r.id = v_pay.order_request_id
              and r.assigned_to = v_actor))
      or (v_pay.order_id is not null and exists (
            select 1 from public.order_requests r
            where r.converted_order_id = v_pay.order_id
              and r.assigned_to = v_actor));
  end if;

  if not coalesce(v_visible, false) then
    raise exception 'ALLOCATION_LEDGER_PAYMENT_NOT_FOUND: payment % was not found or is not visible to you.',
      p_payment_request_id
      using errcode = 'P0002';
  end if;

  return query
  select
    a.id,
    a.status,
    a.allocated_amount,
    a.order_id,
    a.order_submission_id,
    case
      when a.legacy_order_no is not null then a.legacy_order_no
      when a.order_id is not null then o.display_number
      else coalesce(nullif(btrim(s.source_order_number), ''),
                    nullif(btrim(s.source_workbook_name), ''),
                    'Draft')
    end,
    coalesce(o.client_name, s.client_name, a.legacy_client_name),
    a.created_at,
    a.reversed_at,
    a.reversal_reason,
    ru.full_name
  from public.finance_payment_allocations a
  left join public.orders            o  on o.id  = a.order_id
  left join public.order_submissions s  on s.id  = a.order_submission_id
  left join public.users             ru on ru.id = a.reversed_by
  where a.payment_request_id = p_payment_request_id
  order by a.created_at, a.id;
end;
$$;

revoke all on function public.payment_allocation_ledger_for_correction(uuid) from public;
revoke all on function public.payment_allocation_ledger_for_correction(uuid) from anon;
revoke all on function public.payment_allocation_ledger_for_correction(uuid) from service_role;
grant execute on function public.payment_allocation_ledger_for_correction(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- §9. Apply-time assertions
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.finance_payment_allocations'::regclass
    and c.conname = 'finance_payment_allocations_one_target';
  if v_def is null or position('legacy_order_no' in v_def) = 0 then
    raise exception 'ASSERT: the one-target rule must count legacy_order_no';
  end if;

  if exists (select 1 from public.finance_payment_allocations
              where num_nonnulls(order_submission_id, order_id, legacy_order_no) <> 1) then
    raise exception 'ASSERT: every allocation names exactly one target';
  end if;

  if to_regclass('public.finance_payment_allocations_unique_active_legacy') is null then
    raise exception 'ASSERT: the one-active-claim-per-legacy-order index is missing';
  end if;

  -- The internal doors are closed to clients.
  if has_function_privilege('authenticated',
       'public.allocate_payment_to_legacy_order_internal(uuid, text, text, numeric)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.allocate_payment_to_legacy_order_internal(uuid, text, text, numeric)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.record_payment_with_allocations_core(numeric, date, text, text, text, text, text, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.record_payment_with_allocations_base(numeric, date, text, text, text, text, text, jsonb, jsonb)', 'EXECUTE') then
    raise exception 'ASSERT: the allocation implementations must stay closed to client roles';
  end if;

  -- The doors that clients use are still executable by them and by nobody else.
  if not has_function_privilege('authenticated', 'public.allocate_payment_to_targets(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.allocate_payment_to_targets(uuid, jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.received_payment_allocation_targets(uuid[])', 'EXECUTE')
     or has_function_privilege('anon', 'public.received_payment_allocation_targets(uuid[])', 'EXECUTE')
     or has_function_privilege('service_role', 'public.received_payment_allocation_targets(uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.payment_allocation_ledger_for_correction(uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.payment_allocation_ledger_for_correction(uuid)', 'EXECUTE') then
    raise exception 'ASSERT: a client-facing allocation function lost or gained a privilege';
  end if;

  -- The transition guard stays a trigger function with the legacy columns frozen.
  if position('legacy_order_no' in pg_get_functiondef(
       'public.finance_payment_allocations_guard_transition()'::regprocedure)) = 0 then
    raise exception 'ASSERT: the transition guard must freeze the legacy columns';
  end if;
end $$;
