-- Order Requests ↔ Finance: give the requester the same view of their own
-- request that an admin has, and let them manage the payments they submitted
-- while the request is still open.
--
-- Problem this closes
-- -------------------
-- 20260698 gave admins a request-side payment linkage (order_request_id). The
-- requester — the salesperson who raised the request and usually collected the
-- advance — could see none of it: finance_payment_requests SELECT is scoped to
-- own submissions (20260628000200) or admin, so a payment an admin parked on
-- their request was invisible to them, and the Orders UI had to report
-- "Finance access required" instead of the real advance. They also had no way
-- to attach a payment they had already submitted to their own request.
--
-- What this migration does NOT do
-- -------------------------------
--   * It does not widen the suspense ledger. A non-admin still sees only
--     (a) payments they submitted and (b) payments already attached to a
--     request they own. There is no path here to browse other people's
--     payments.
--   * It does not create a new payment status, a new linkage column, or a
--     second workflow. Every mutation still goes through the same two RPCs
--     20260698 introduced.
--   * It does not relax anything for a CONVERTED request. Once converted, the
--     request is closed to its requester in both the app and the database.

-- ── 1. Requester visibility of payments attached to their own request ─────────
-- Additive SELECT policy (RLS policies are OR-ed), covering both sides of the
-- conversion boundary so the advance figure never blanks out at conversion:
--   * before conversion the payment carries order_request_id;
--   * conversion moves it to order_id (20260698 §7), and the request keeps
--     converted_order_id pointing at that Order.
-- Both branches are anchored to an order_requests row the caller already owns
-- under order_requests_requester_select, so this exposes strictly the payments
-- behind a figure they are entitled to see — never an unattached suspense row.

create policy "finance_payment_requests_order_request_owner_select"
  on public.finance_payment_requests
  for select to authenticated
  using (
    (
      finance_payment_requests.order_request_id is not null
      and exists (
        select 1 from public.order_requests r
        where r.id = finance_payment_requests.order_request_id
          and (r.created_by = auth.uid() or r.requested_by = auth.uid())
      )
    )
    or
    (
      finance_payment_requests.order_id is not null
      and exists (
        select 1 from public.order_requests r
        where r.converted_order_id = finance_payment_requests.order_id
          and (r.created_by = auth.uid() or r.requested_by = auth.uid())
      )
    )
  );

-- ── 2. Link: admin OR the requester, with their own payment ───────────────────
-- Body is the deployed 20260698 §5 function with two changes:
--
--   (a) Authorization is no longer admin-only. A non-admin may link only when
--       BOTH hold: they own the order request (the project's existing requester
--       rule — created_by OR requested_by, never assigned_to), AND they
--       submitted the payment. Either half alone is refused. The check runs
--       AFTER both rows are locked and read, so it is evaluated against real
--       committed state, not against anything the client sent.
--
--   (b) 'rejected' joins the eligible request statuses. A rejected request can
--       be reapplied (20260689) and converted afterwards, and the advance was
--       genuinely received — parking it is honest bookkeeping, not an approval.
--       'converted' remains excluded: a converted request must receive links
--       through its Order. Conversion itself is untouched — it still requires
--       status = 'submitted', so a rejected-and-linked payment simply transfers
--       when the request is reapplied and then converted.
--
-- Everything else — lock order (request first, then payment, matching
-- convert_order_request_to_order), the eligibility gates, the unchanged
-- 'approved_unlinked' status, the new_order-origin gate, both activity rows,
-- and the returned shape — is byte-for-byte the deployed behaviour.

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
  --    and BEFORE the payment is read at all. A caller who does not own this
  --    request therefore learns nothing about the payment id they passed — not
  --    even whether it exists.
  if not v_is_admin and not (v_req.created_by = v_actor or v_req.requested_by = v_actor) then
    raise exception 'Only an admin or the requester may link a payment to this order request'
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
  --     eligible payment; anyone else may attach only one they submitted.
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

-- ── 3. Unlink: admin OR the requester, with their own payment ─────────────────
-- Same authorization change as §2, evaluated against the request the payment is
-- CURRENTLY parked on (never a client-supplied request id, which this function
-- does not accept at all). The mandatory reason, the new_order-origin gate, the
-- single-row lock, and both activity rows are unchanged from 20260698 §6.
--
-- No converted-request case exists here: conversion clears order_request_id in
-- the same statement that sets order_id, so a converted request holds no
-- request-linked payments and step 5 refuses before authorization is reached.

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
       or not (v_req.created_by = v_actor or v_req.requested_by = v_actor) then
      raise exception 'Only an admin or the requester may unlink a payment from this order request'
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

-- ── 4. Post-conversion lock on an order request (independent of RLS) ───────────
-- order_requests_requester_update (20260680) already excludes 'converted' from
-- its USING clause, so a requester's UPDATE of a converted request is filtered
-- to zero rows. This trigger restates the rule as a hard failure rather than a
-- silent no-op, and — unlike a policy — it survives any future policy edit and
-- applies to every write path into the table, not just PostgREST.
--
-- auth.uid() IS NULL means no authenticated user: a service-role/direct-SQL
-- maintenance path, which bypasses RLS by design and is deliberately exempt.
-- Every PostgREST caller is `to authenticated`, so this can never be an
-- anonymous request slipping through.

create or replace function public.order_requests_guard_converted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return new;
  end if;

  if old.status = 'converted' and not exists (
    select 1 from public.users u where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Order request % has been converted and can no longer be edited', old.request_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.order_requests_guard_converted() from public, anon, authenticated;

drop trigger if exists order_requests_guard_converted on public.order_requests;

create trigger order_requests_guard_converted
  before update on public.order_requests
  for each row execute function public.order_requests_guard_converted();

-- ── 5. Post-approval lock on a payment's business fields (independent of RLS) ──
-- finance_payment_requests_own_update (20260653/20260695) only lets a creator
-- update their own row while it is pending/needs_clarification/rejected, so an
-- approved payment is already closed to them. This trigger states the rule
-- directly on the table so it holds regardless of which policy authorized the
-- write.
--
-- The one thing a non-admin may still change on an approved payment is its
-- request linkage, and only through the two SECURITY DEFINER RPCs above (which
-- run with the caller's auth.uid(), so they pass through this trigger like any
-- other write). Those RPCs touch exactly order_request_id, order_request_number
-- and updated_at — every other column is frozen here, so a raw PATCH cannot
-- ride along on that allowance to alter an amount, a date, or a status.

create or replace function public.finance_payment_requests_guard_approved()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- Service-role / direct SQL, and admins, are exempt.
  if v_actor is null then
    return new;
  end if;

  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return new;
  end if;

  if old.status not in ('approved_unlinked', 'approved_linked') then
    return new;
  end if;

  if new.client_name     is distinct from old.client_name
     or new.amount          is distinct from old.amount
     or new.payment_date    is distinct from old.payment_date
     or new.payment_mode    is distinct from old.payment_mode
     or new.received_in     is distinct from old.received_in
     or new.proof_note      is distinct from old.proof_note
     or new.sales_note      is distinct from old.sales_note
     or new.payment_against is distinct from old.payment_against
     or new.status          is distinct from old.status
     or new.order_id        is distinct from old.order_id
     or new.order_number    is distinct from old.order_number
     or new.submitted_by    is distinct from old.submitted_by
     or new.approved_by     is distinct from old.approved_by
     or new.approved_at     is distinct from old.approved_at
     or new.created_at      is distinct from old.created_at
     or new.admin_note      is distinct from old.admin_note
  then
    raise exception 'Payment % has been approved and can no longer be edited', old.request_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.finance_payment_requests_guard_approved() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_guard_approved on public.finance_payment_requests;

create trigger finance_payment_requests_guard_approved
  before update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_approved();
