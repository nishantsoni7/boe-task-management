-- Order Requests: let the ASSIGNEE participate in a request assigned to them.
--
-- Problem this closes
-- -------------------
-- An admin has always been able to create an Order Request and set assigned_to
-- to any eligible salesperson (20260697), and /api/orders/notify already sends
-- that person a distinct 'order_assigned' notification. But the notification
-- deep-linked to a request they could not open: every ownership predicate in
-- this module is the project's "requester" rule
--
--     created_by = auth.uid() OR requested_by = auth.uid()
--
-- and assigned_to is deliberately not part of it. Since 20260696 stopped
-- collecting requested_by as a form field, an admin-created request carries
-- created_by = requested_by = the admin, so the assignee matched nothing:
-- order_requests_requester_select hid the row, the nav badge and tab counts
-- (both pure RLS counts over the same table) omitted it, and
-- link_finance_payment_to_order_request refused them with 42501.
--
-- What this migration does
-- ------------------------
-- Adds the assignee as a THIRD participant, for exactly three capabilities:
--   1. read a request assigned to them (+ its activity trail, + the payments
--      parked on it, so the advance figure and "Linked by" column resolve);
--   2. link a payment they themselves submitted to such a request;
--   3. unlink one again while the request is still open.
--
-- What this migration deliberately does NOT do
-- --------------------------------------------
--   * No UPDATE of any kind. public.order_requests has had NO update policy
--     for any role since 20260683 §3 and 20260687 §3 dropped
--     order_requests_requester_update / _admin_update to "close the direct-
--     update bypass" — every mutation goes through a SECURITY DEFINER RPC.
--     Granting the assignee an UPDATE policy would reopen precisely that
--     bypass and hand them a power the admin does not have on this path.
--   * No change to resubmit_order_request / reapply_order_request. Answering a
--     clarification or reapplying after a rejection stays with the requester;
--     the assignee is not given a second door into those state transitions.
--   * No change to approval, conversion, rejection, clarification, deletion,
--     assignee eligibility, or status filtering.
--   * No widening of the suspense ledger. The payment half of both linkage
--     RPCs is untouched: a non-admin may still only attach or detach a payment
--     they submitted themselves. Being an assignee grants no visibility into
--     anyone else's payments.
--   * Nothing for a CONVERTED request beyond read. The status gate in the link
--     RPC and the order_requests_guard_converted trigger (20260699 §4) both
--     still apply unchanged.
--
-- Every policy below is additive. RLS policies for the same command are OR-ed,
-- so no existing policy is dropped, rewritten, or narrowed here — admin and
-- requester visibility are unchanged by construction.

-- ── 1. order_requests: the assignee may read their own assignment ─────────────
-- Read only. There is no corresponding UPDATE/DELETE policy, by design (see
-- the header note above).

create policy "order_requests_assignee_select" on public.order_requests
  for select to authenticated
  using (assigned_to = auth.uid());

-- ── 2. order_request_activity: same scope, so the trail is not half-blank ─────
-- Mirrors order_request_activity_requester_select, anchored to the assignment
-- instead of the requester rule. Without it an assignee could open a request
-- but see an empty history and a "—" in the "Linked by" column of the payments
-- panel, including for links they made themselves.

create policy "order_request_activity_assignee_select" on public.order_request_activity
  for select to authenticated
  using (
    exists (
      select 1 from public.order_requests r
      where r.id = order_request_activity.order_request_id
        and r.assigned_to = auth.uid()
    )
  );

-- ── 3. finance_payment_requests: payments attached to an assigned request ─────
-- The assignee counterpart of finance_payment_requests_order_request_owner_select
-- (20260699 §1), including both sides of the conversion boundary for the same
-- reason: before conversion the payment carries order_request_id; conversion
-- moves it to order_id while the request keeps converted_order_id pointing at
-- that Order. Without the second branch the advance figure would blank out at
-- the moment of conversion.
--
-- Both branches are anchored to an order_requests row the caller can already
-- read under §1, so this exposes strictly the payments behind a figure they are
-- entitled to see — never an unattached suspense row, and never a payment on
-- someone else's request.

create policy "finance_payment_requests_order_request_assignee_select"
  on public.finance_payment_requests
  for select to authenticated
  using (
    (
      finance_payment_requests.order_request_id is not null
      and exists (
        select 1 from public.order_requests r
        where r.id = finance_payment_requests.order_request_id
          and r.assigned_to = auth.uid()
      )
    )
    or
    (
      finance_payment_requests.order_id is not null
      and exists (
        select 1 from public.order_requests r
        where r.converted_order_id = finance_payment_requests.order_id
          and r.assigned_to = auth.uid()
      )
    )
  );

-- ── 4. link RPC: admin OR requester OR assignee, with their own payment ───────
-- Byte-for-byte the deployed 20260699 §2 body (verified against pg_proc.prosrc
-- before writing this migration) with exactly two changes, both in step 4:
-- `or v_req.assigned_to = v_actor` is added to the request-half authorization,
-- and the error message now names the assignee. The lock order (request first,
-- then payment — matching convert_order_request_to_order), every eligibility
-- gate, the unchanged 'approved_unlinked' status, the new_order-origin gate,
-- both activity rows, and the returned shape are untouched.
--
-- Step 5b — the payment half — is deliberately NOT relaxed. An assignee is
-- still refused any payment they did not submit, so this adds no route into
-- the suspense ledger.

create or replace function public.link_finance_payment_to_order_request(
  p_payment_request_id uuid,
  p_order_request_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_is_admin boolean;
  v_pay      public.finance_payment_requests%rowtype;
  v_req      public.order_requests%rowtype;
  v_now      timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to link a payment to an order request'
      using errcode = '28000';
  end if;

  v_is_admin := exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  );

  -- 2. Validate inputs
  if p_payment_request_id is null then
    raise exception 'A payment request is required' using errcode = 'P0001';
  end if;
  if p_order_request_id is null then
    raise exception 'An order request is required' using errcode = 'P0001';
  end if;

  -- 3. Lock the request row FIRST (see lock-order note above), then validate.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  if v_req.status not in ('submitted', 'needs_clarification', 'rejected') then
    raise exception 'Only an active order request can receive a payment link (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- Redundant with the status check (converted_consistency CHECK, 20260680),
  -- restated so this function's own guarantees don't depend on that constraint.
  if v_req.converted_order_id is not null then
    raise exception 'Order request % has already been converted', v_req.request_number
      using errcode = 'P0001';
  end if;

  -- 4. Authorization, half one: the request end, checked against the locked row
  --    and BEFORE the payment is read at all. A caller who is neither the
  --    requester nor the assignee therefore learns nothing about the payment id
  --    they passed — not even whether it exists.
  if not v_is_admin
     and not (v_req.created_by  = v_actor
           or v_req.requested_by = v_actor
           or v_req.assigned_to  = v_actor) then
    raise exception 'Only an admin, the requester, or the assignee may link a payment to this order request'
      using errcode = '42501';
  end if;

  -- 5. Lock the payment row: serializes double-clicks, replays, and two people
  --    racing on the same payment.
  select * into v_pay
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_payment_request_id
      using errcode = 'P0002';
  end if;

  -- 5b. Authorization, half two: the payment end. An admin may attach any
  --     eligible payment; anyone else — requester or assignee alike — may
  --     attach only one they submitted.
  if not v_is_admin and v_pay.submitted_by <> v_actor then
    raise exception 'You may only link a payment you submitted'
      using errcode = '42501';
  end if;

  -- 6. Only a confirmed-received payment with NO current commercial linkage
  --    may be parked on a request. approved_unlinked already implies
  --    order_id IS NULL (20260692 invariant); order_request_id must be null
  --    too — relinking means unlink first, exactly as with orders.
  if v_pay.status <> 'approved_unlinked' then
    raise exception 'Only a payment awaiting order linkage can be linked (% is %)',
      v_pay.request_number, v_pay.status
      using errcode = 'P0001';
  end if;

  if v_pay.order_id is not null then
    raise exception 'Payment % is already linked to an order', v_pay.request_number
      using errcode = 'P0001';
  end if;

  if v_pay.order_request_id is not null then
    raise exception 'Payment % is already linked to an order request', v_pay.request_number
      using errcode = 'P0001';
  end if;

  -- An Order Request represents a FUTURE new order, so only a payment that
  -- originated as a new-order request may be parked on one.
  if v_pay.payment_against <> 'new_order' then
    raise exception 'Only a payment originating as a new-order request can be linked to an order request (% originated as %)',
      v_pay.request_number, v_pay.payment_against
      using errcode = 'P0001';
  end if;

  -- 7. Link. Status deliberately unchanged: the payment is still not attached
  --    to a Confirmed Order, so it must stay out of every advance total.
  update public.finance_payment_requests
     set order_request_id     = v_req.id,
         order_request_number = v_req.request_number,
         updated_at           = v_now
   where id = p_payment_request_id;
  -- The AFTER UPDATE trigger records order_request_linked on the payment side.

  -- 8. Request-side activity — mirrors order_activity_log's payment_linked
  --    payload convention (payment_id, request_number, amount, client_name).
  insert into public.order_request_activity
    (order_request_id, event_type, actor_id, details)
  values (
    v_req.id, 'payment_linked', v_actor,
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
    'status',               'approved_unlinked',
    'order_request_id',     v_req.id,
    'order_request_number', v_req.request_number,
    'linked_at',            v_now
  );
end;
$$;

revoke execute on function public.link_finance_payment_to_order_request(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.link_finance_payment_to_order_request(uuid, uuid) to authenticated;

-- ── 5. Unlink RPC: the same authorization change, and only that ───────────────
-- Evaluated against the request the payment is CURRENTLY parked on (never a
-- client-supplied request id, which this function does not accept at all).
-- The mandatory reason, the new_order-origin gate, the single-row lock, and
-- both activity rows are unchanged from the deployed 20260699 §3 body.
--
-- Symmetry with §4 is the point: an assignee who can attach a payment must be
-- able to detach the one they attached, or a mislink becomes an admin ticket.
-- The `v_pay.submitted_by <> v_actor` gate below keeps that bounded to their
-- own payments.

create or replace function public.unlink_finance_payment_from_order_request(
  p_payment_request_id uuid,
  p_reason             text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor               uuid := auth.uid();
  v_is_admin            boolean;
  v_pay                 public.finance_payment_requests%rowtype;
  v_req                 public.order_requests%rowtype;
  v_reason              text;
  v_prev_request_id     uuid;
  v_prev_request_number text;
  v_now                 timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to unlink a payment'
      using errcode = '28000';
  end if;

  v_is_admin := exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  );

  -- 2. A reason is mandatory and must be real content, not whitespace.
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'A reason is required to unlink a payment' using errcode = 'P0001';
  end if;

  if p_payment_request_id is null then
    raise exception 'A payment request is required' using errcode = 'P0001';
  end if;

  -- 3. Lock the payment row.
  select * into v_pay
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_payment_request_id
      using errcode = 'P0002';
  end if;

  -- 4. Only a currently request-linked payment can be unlinked here.
  if v_pay.order_request_id is null then
    raise exception 'Payment % has no linked order request to unlink from', v_pay.request_number
      using errcode = 'P0001';
  end if;

  -- 5. Authorization, against the request the payment actually sits on.
  if not v_is_admin then
    select * into v_req
    from public.order_requests
    where id = v_pay.order_request_id;

    if not found
       or not (v_req.created_by  = v_actor
            or v_req.requested_by = v_actor
            or v_req.assigned_to  = v_actor) then
      raise exception 'Only an admin, the requester, or the assignee may unlink a payment from this order request'
        using errcode = '42501';
    end if;
    if v_pay.submitted_by <> v_actor then
      raise exception 'You may only unlink a payment you submitted'
        using errcode = '42501';
    end if;
  end if;

  -- 6. Same origin gate as the order unlink.
  if v_pay.payment_against <> 'new_order' then
    raise exception 'Only a payment originating as a new-order request can be unlinked through this workflow (% originated as %)',
      v_pay.request_number, v_pay.payment_against
      using errcode = 'P0001';
  end if;

  -- 7. Capture the original link before clearing it, for the activity rows.
  v_prev_request_id     := v_pay.order_request_id;
  v_prev_request_number := v_pay.order_request_number;

  update public.finance_payment_requests
     set order_request_id     = null,
         order_request_number = null,
         updated_at           = v_now
   where id = p_payment_request_id;
  -- The AFTER UPDATE trigger records order_request_unlinked on the payment side.

  -- 8. Request-side activity, recorded against the ORIGINAL request.
  insert into public.order_request_activity
    (order_request_id, event_type, actor_id, details)
  values (
    v_prev_request_id, 'payment_unlinked', v_actor,
    jsonb_build_object(
      'payment_id',     v_pay.id,
      'request_number', v_pay.request_number,
      'amount',         v_pay.amount,
      'reason',         v_reason
    )
  );

  -- 9. Stable structured result.
  return jsonb_build_object(
    'payment_request_id',            v_pay.id,
    'request_number',                v_pay.request_number,
    'status',                        'approved_unlinked',
    'previous_order_request_id',     v_prev_request_id,
    'previous_order_request_number', v_prev_request_number,
    'reason',                        v_reason,
    'unlinked_at',                   v_now
  );
end;
$$;

revoke execute on function public.unlink_finance_payment_from_order_request(uuid, text) from public, anon, authenticated;
grant  execute on function public.unlink_finance_payment_from_order_request(uuid, text) to authenticated;
