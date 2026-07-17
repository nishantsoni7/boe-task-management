-- Finance Phase C — guarded, row-locked link/unlink for suspense payments.
--
-- Problem: the Received Payments page (finance/received/page.tsx) links and
-- unlinks approved_unlinked <-> approved_linked payments with a plain client
-- .update() — no row lock, no re-validation of current state before writing.
-- Two admins racing on the same payment would silently last-write-wins
-- instead of one succeeding and one failing cleanly.
--
-- Fix: two SECURITY DEFINER RPCs, following the exact lock -> revalidate ->
-- mutate -> log pattern already established by approve_finance_payment_request
-- (20260688000000/20260690000000) and convert_order_request_to_order
-- (20260681000000/20260682000000). Reuses order_activity_log's existing
-- freeform jsonb payload for audit detail (payment_linked / payment_unlinked
-- event types are already documented there) — no new audit table.
--
-- Mandatory business distinction (payment_against, 20260658, confirmed never
-- mutated anywhere in the app): a payment that originated as 'new_order' may
-- be unlinked back to suspense through this general workflow. A payment that
-- originated as 'existing_order' was validated against a real order at
-- submission time (client_name is server-derived from that order — see the
-- trigger in 20260688000000) and must NOT be freely detachable here; the
-- unlink RPC rejects it outright.

-- ── 1. Link an approved_unlinked payment to an existing Order ─────────────────
--
-- Authorization: SECURITY DEFINER, admin-only (checked in-body against
-- public.users.role = 'admin' — this project has no admin database role and
-- no is_admin() helper, matching every sibling RPC).
--
-- Concurrency: the payment row is locked FOR UPDATE first, then the target
-- order row. Two admins racing to link the SAME payment serialize on the
-- payment lock: the first commits status = 'approved_linked'; the second
-- blocks, then re-reads the committed row and fails the
-- status = 'approved_unlinked' check — one success, one explicit failure,
-- never last-write-wins. Locking the order row too guards against linking
-- into an order that is concurrently being cancelled. Multiple DIFFERENT
-- payments may still link to the SAME order concurrently (each transaction
-- only ever holds its own payment row first, so there is no lock-order cycle
-- with a concurrent link of a different payment to the same order).

create or replace function public.link_finance_payment_to_order(
  p_payment_request_id uuid,
  p_order_id            uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_pay    public.finance_payment_requests%rowtype;
  v_order  public.orders%rowtype;
  v_now    timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to link a payment to an order'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may link a payment to an order'
      using errcode = '42501';
  end if;

  -- 3. Validate inputs
  if p_payment_request_id is null then
    raise exception 'A payment request is required' using errcode = 'P0001';
  end if;
  if p_order_id is null then
    raise exception 'An order is required' using errcode = 'P0001';
  end if;

  -- 4. Lock the payment row: serializes double-clicks, replays, and two
  --    admins racing on the same payment.
  select * into v_pay
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_payment_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Only a payment that has actually been confirmed received, and is not
  --    already attached to an order, may be linked. approved_unlinked IS the
  --    "received but not yet attached" state (set only by
  --    approve_finance_payment_request), so this single check both confirms
  --    receipt and confirms eligibility.
  if v_pay.status <> 'approved_unlinked' then
    raise exception 'Only a payment awaiting order linkage can be linked (% is %)',
      v_pay.request_number, v_pay.status
      using errcode = 'P0001';
  end if;

  if v_pay.order_id is not null then
    raise exception 'Payment % is already linked to an order', v_pay.request_number
      using errcode = 'P0001';
  end if;

  -- 6. Lock and validate the target order.
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Order % not found', p_order_id
      using errcode = 'P0002';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Cannot link a payment to cancelled order %', v_order.display_number
      using errcode = 'P0001';
  end if;

  -- 7. Link. order_number is a display/reference copy only — order_id is the
  --    source of truth (enforced by finance_payment_requests_approved_linked_
  --    requires_order_id, 20260670).
  update public.finance_payment_requests
     set status       = 'approved_linked',
         order_id     = v_order.id,
         order_number = v_order.display_number,
         updated_at   = v_now
   where id = p_payment_request_id;

  -- 8. Order activity — existing payment_linked convention (payment_id,
  --    amount, client_name), extended with request_number as a human-readable
  --    identifier (the payment's own currency is implicit/INR throughout this
  --    app — there is no currency column on finance_payment_requests to
  --    surface, and none is added here). actor and timestamp are NOT
  --    duplicated into payload: order_activity_log already carries actor_id
  --    and created_at as dedicated columns.
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order.id, v_actor, 'payment_linked',
    jsonb_build_object(
      'payment_id',     v_pay.id,
      'request_number', v_pay.request_number,
      'amount',         v_pay.amount,
      'client_name',    v_pay.client_name
    )
  );

  -- 9. Stable structured result.
  return jsonb_build_object(
    'payment_request_id',   v_pay.id,
    'request_number',       v_pay.request_number,
    'status',               'approved_linked',
    'order_id',              v_order.id,
    'order_display_number',  v_order.display_number,
    'linked_at',             v_now
  );
end;
$$;

revoke execute on function public.link_finance_payment_to_order(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.link_finance_payment_to_order(uuid, uuid) to authenticated;

-- ── 2. Unlink an approved_linked payment back to suspense ─────────────────────
--
-- Only a payment that originated as 'new_order' may be unlinked through this
-- general workflow (see business-distinction note above). An 'existing_order'
-- payment is rejected outright — correcting one of those requires deliberate
-- admin judgement outside this workflow, not a one-click detach.

create or replace function public.unlink_finance_payment_from_order(
  p_payment_request_id uuid,
  p_reason              text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor            uuid := auth.uid();
  v_pay              public.finance_payment_requests%rowtype;
  v_reason           text;
  v_previous_order_id     uuid;
  v_previous_order_number text;
  v_now              timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to unlink a payment'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may unlink a payment from an order'
      using errcode = '42501';
  end if;

  -- 3. A reason is mandatory and must be real content, not whitespace.
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reason is required to unlink a payment' using errcode = 'P0001';
  end if;

  if p_payment_request_id is null then
    raise exception 'A payment request is required' using errcode = 'P0001';
  end if;

  -- 4. Lock the payment row: serializes double-clicks, replays, and two
  --    admins racing on the same payment.
  select * into v_pay
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_payment_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Only a currently-linked payment can be unlinked.
  if v_pay.status <> 'approved_linked' then
    raise exception 'Only a linked payment can be unlinked (% is %)',
      v_pay.request_number, v_pay.status
      using errcode = 'P0001';
  end if;

  if v_pay.order_id is null then
    raise exception 'Payment % has no linked order to unlink from', v_pay.request_number
      using errcode = 'P0001';
  end if;

  -- 6. Mandatory business distinction: only a payment that originated as a
  --    new-order request may be freely detached here. An existing-order
  --    payment was validated against a real, already-selected order at
  --    submission time and must not be returned to suspense through this
  --    general workflow.
  if v_pay.payment_against <> 'new_order' then
    raise exception 'Only a payment originating as a new-order request can be unlinked through this workflow (% originated as %)',
      v_pay.request_number, v_pay.payment_against
      using errcode = 'P0001';
  end if;

  -- 7. Capture the original link before clearing it, for the activity row.
  v_previous_order_id     := v_pay.order_id;
  v_previous_order_number := v_pay.order_number;

  update public.finance_payment_requests
     set status       = 'approved_unlinked',
         order_id     = null,
         order_number = null,
         updated_at   = v_now
   where id = p_payment_request_id;

  -- 8. Order activity, recorded against the ORIGINAL order — existing
  --     payment_unlinked convention (payment_id), extended with
  --     request_number, amount, the order number that was cleared, and the
  --     mandatory reason. No new audit table: this reuses order_activity_log's
  --     existing jsonb payload. actor_id / created_at are dedicated columns
  --     on order_activity_log already, so they are not repeated in payload.
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_previous_order_id, v_actor, 'payment_unlinked',
    jsonb_build_object(
      'payment_id',            v_pay.id,
      'request_number',        v_pay.request_number,
      'amount',                v_pay.amount,
      'previous_order_number', v_previous_order_number,
      'reason',                v_reason
    )
  );

  -- 9. Stable structured result.
  return jsonb_build_object(
    'payment_request_id',      v_pay.id,
    'request_number',          v_pay.request_number,
    'status',                  'approved_unlinked',
    'previous_order_id',       v_previous_order_id,
    'previous_order_number',   v_previous_order_number,
    'reason',                  v_reason,
    'unlinked_at',             v_now
  );
end;
$$;

revoke execute on function public.unlink_finance_payment_from_order(uuid, text) from public, anon, authenticated;
grant  execute on function public.unlink_finance_payment_from_order(uuid, text) to authenticated;
