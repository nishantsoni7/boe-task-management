-- Finance Phase B — new-order payment approval must never create an order.
--
-- Problem (confirmed against production order display_number '16' / payment
-- PAY-REQ-2026-0017, remediation tracked separately, not touched by this
-- migration): approve_finance_payment_request() (20260688000000) treats
-- confirming payment receipt and creating an order as one event for a
-- payment_against = 'new_order' request — the moment an admin marks the
-- payment received, it allocates an order number and inserts an orders row.
-- Those are two separate business events and must not be coupled.
--
-- Fix: for a new_order request, approval now ONLY confirms receipt. It sets
-- status = 'approved_unlinked' and leaves order_id / order_number null. The
-- number-allocation function and the orders table are not touched at all —
-- see the code below for what this branch actually does — and no
-- order_activity_log row is written (there is no order to log against). The
-- payment becomes visible in Suspense / Non-linked Payments, to be attached
-- to a real Order later via the Order Request conversion flow (Phase D) or
-- the guarded Finance linking RPC (Phase C).
--
-- existing_order requests are entirely unchanged: order_id already carries a
-- real, admin-validated order (enforced at insert by the client_name trigger
-- from 20260688000000), so approval still resolves the order's display
-- number and moves straight to approved_linked.
--
-- Everything else about this function — admin-only authorization, the
-- FOR UPDATE lock, the pending_approval-only guard, idempotency against
-- double-clicks/retries — is unchanged from 20260688000000.

create or replace function public.approve_finance_payment_request(
  p_request_id uuid,
  p_admin_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_req      public.finance_payment_requests%rowtype;
  v_order_id uuid;
  v_number   text;
  v_status   text;
  v_now      timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to approve a payment request'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may approve a payment request'
      using errcode = '42501';
  end if;

  -- 3. Lock the request row: serializes double-clicks, replays, and two admins
  --    racing on the same request.
  select * into v_req
  from public.finance_payment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  -- 4. Only a clean pending request can be approved through this function.
  --    Rejects retries/duplicates once the row has already moved on.
  if v_req.status <> 'pending_approval' then
    raise exception 'Only a pending payment request can be approved (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  if v_req.payment_against = 'new_order' then
    -- 5. Confirming receipt is NOT order creation. No number is allocated, no
    --    orders row is inserted, no order_activity_log row is written (there
    --    is no order to log against). The payment moves to suspense, where it
    --    stays until it is deliberately attached to a real Order (Order
    --    Request conversion, or the guarded Finance linking RPC).
    v_order_id := null;
    v_number   := null;
    v_status   := 'approved_unlinked';
  else
    -- existing_order: order_id must already be set (enforced by the
    -- client-name trigger at insert time, 20260688000000). Resolve the
    -- number authoritatively from the order itself and go straight to
    -- approved_linked, exactly as before.
    if v_req.order_id is null then
      raise exception 'Payment request % has no linked order to approve against', v_req.request_number
        using errcode = 'P0001';
    end if;

    select o.display_number into v_number
    from public.orders o
    where o.id = v_req.order_id;

    v_order_id := v_req.order_id;
    v_status   := 'approved_linked';
  end if;

  -- 6. Close out the request. finance_payment_requests_log_activity (20260675)
  --    derives the activity row from this real committed transition —
  --    nothing extra to insert here for either branch.
  update public.finance_payment_requests
     set status       = v_status,
         order_id     = v_order_id,
         order_number = v_number,
         approved_by  = v_actor,
         approved_at  = v_now,
         admin_note   = p_admin_note,
         updated_at   = v_now
   where id = p_request_id;

  -- 7. Small structured result.
  return jsonb_build_object(
    'request_id',           v_req.id,
    'request_number',       v_req.request_number,
    'status',                v_status,
    'order_id',              v_order_id,
    'order_display_number',  v_number,
    'approved_at',            v_now
  );
end;
$$;

-- Clear the defaults, then re-grant to the only role the application ever
-- authenticates as. Admin-only runtime authorization is enforced by the
-- explicit check inside the function body (step 2), not by the grant.
revoke execute on function public.approve_finance_payment_request(uuid, text) from public, anon, authenticated;
grant  execute on function public.approve_finance_payment_request(uuid, text) to authenticated;
