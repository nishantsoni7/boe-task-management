-- Finance ↔ Order Requests — link a suspense payment to an Order Request.
--
-- BOE often receives an advance BEFORE an Order Request is converted into a
-- Confirmed Order. Today a received payment can only be linked to public.orders
-- (order_id / order_number, states owned by the 20260690/20260691 RPCs). This
-- migration lets an admin park a suspense payment on an eligible Order Request
-- and have the conversion RPC transfer that linkage onto the Order it creates.
--
-- Data model (smallest safe increment, mirroring the existing order linkage):
--   * order_request_id      uuid  NULL  FK -> order_requests(id)
--   * order_request_number  text  NULL  denormalized display copy — safe to
--     denormalize because request_number is trigger-immutable
--     (order_requests_protect_number, 20260680). Both columns are maintained
--     ONLY by the RPCs below, never by client updates.
--
-- State model — deliberately NO new payment status. A request-linked payment
-- stays 'approved_unlinked': every advance/received total in the app sums only
-- approved_linked rows filtered by order_id, so a request-linked payment can
-- never be double-counted (it is counted zero times until conversion, once
-- after). Mutual exclusivity with order_id needs no new clause: the CHECK
-- below allows order_request_id only when status = 'approved_unlinked', and
-- finance_payment_requests_status_order_invariant (20260692) already forces
-- order_id IS NULL for that status — so the database cannot hold both
-- linkages at once.
--
-- FK deletion behaviour: default NO ACTION (not SET NULL) — hard-deleting an
-- order request that still holds payments is refused, exactly as order
-- deletion is already refused while approved_linked payments exist
-- (src/app/api/orders/[id]/route.ts). There is no request-delete UI today;
-- if one is added, it must unlink payments first.

-- ── 1. Columns, constraint, index ─────────────────────────────────────────────

alter table public.finance_payment_requests
  add column if not exists order_request_id uuid references public.order_requests(id),
  add column if not exists order_request_number text;

-- id and number move in lock-step, and only a suspense payment may carry them.
-- Existing rows all have both NULL, so this validates trivially.
alter table public.finance_payment_requests
  add constraint finance_payment_requests_request_link_invariant
  check (
    (order_request_id is null and order_request_number is null)
    or
    (order_request_id is not null
     and order_request_number is not null
     and status = 'approved_unlinked')
  );

-- One commercial target at a time. Technically implied by the two invariants
-- above (order_request_id requires approved_unlinked, which requires
-- order_id IS NULL), but stated directly so the one-target rule is enforced
-- and documented in its own right, not only via constraint interaction.
alter table public.finance_payment_requests
  add constraint finance_payment_requests_one_link_target
  check (not (order_id is not null and order_request_id is not null));

-- Conversion-transfer lookup: "all payments parked on this request". Partial —
-- almost every payment row has order_request_id NULL.
create index if not exists finance_payment_requests_order_request_idx
  on public.finance_payment_requests (order_request_id)
  where order_request_id is not null;

-- ── 2. Finance activity log — two new event types ─────────────────────────────
-- Same derive-from-real-transition architecture as 20260675/20260677: the
-- trigger below is the only writer, and the new events are provable from the
-- row transition alone (order_request_id changed while status stayed
-- approved_unlinked). No client-supplied audit rows.

alter table public.finance_payment_request_activity_log
  drop constraint finance_payment_request_activity_log_event_type_check;

alter table public.finance_payment_request_activity_log
  add constraint finance_payment_request_activity_log_event_type_check
  check (event_type in (
    'request_submitted',
    'order_linked',
    'order_unlinked',
    'order_link_changed',
    'order_request_linked',
    'order_request_unlinked',
    'status_changed'
  ));

-- ── 3. Extend the Finance activity trigger ────────────────────────────────────
-- Body is the deployed 20260677 version plus:
--   * order_linked now also records from_order_request_id/number when the link
--     is a conversion transfer (the same UPDATE that sets order_id clears
--     order_request_id, so OLD still carries the request linkage here);
--   * a new branch for order_request_id changes with status unchanged
--     (approved_unlinked -> approved_unlinked), producing order_request_linked
--     / order_request_unlinked. A direct swap between two requests (possible
--     only via raw PATCH, never via the RPCs) is recorded honestly as
--     order_request_linked with the previous linkage in the payload.

create or replace function public.log_finance_payment_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid  := auth.uid();
  v_event   text;
  v_payload jsonb := '{}'::jsonb;
begin
  if (tg_op = 'INSERT') then
    v_event := 'request_submitted';

  -- order_id transitions that uniquely prove a link action.
  elsif (new.status = 'approved_linked' and old.status = 'approved_linked'
         and new.order_id is distinct from old.order_id) then
    v_event := 'order_link_changed';
    v_payload := jsonb_build_object(
      'from_order_id',     old.order_id,
      'from_order_number', old.order_number,
      'to_order_id',       new.order_id,
      'to_order_number',   new.order_number
    );

  elsif (old.status = 'approved_unlinked' and new.status = 'approved_linked') then
    v_event := 'order_linked';
    v_payload := jsonb_build_object('order_id', new.order_id, 'order_number', new.order_number);
    -- Conversion transfer: the payment was parked on an Order Request and this
    -- same UPDATE moved it onto the Order created from that request.
    if (old.order_request_id is not null) then
      v_payload := v_payload || jsonb_build_object(
        'from_order_request_id',     old.order_request_id,
        'from_order_request_number', old.order_request_number
      );
    end if;

  elsif (old.status = 'approved_linked' and new.status = 'approved_unlinked') then
    v_event := 'order_unlinked';
    v_payload := jsonb_build_object('order_id', old.order_id, 'order_number', old.order_number);

  -- Order-request link transitions: status stays approved_unlinked (the CHECK
  -- in section 1 forbids order_request_id in any other status), only the
  -- request linkage changed.
  elsif (new.order_request_id is distinct from old.order_request_id) then
    if (new.order_request_id is not null) then
      v_event := 'order_request_linked';
      v_payload := jsonb_build_object(
        'order_request_id',     new.order_request_id,
        'order_request_number', new.order_request_number
      );
      if (old.order_request_id is not null) then
        v_payload := v_payload || jsonb_build_object(
          'from_order_request_id',     old.order_request_id,
          'from_order_request_number', old.order_request_number
        );
      end if;
    else
      v_event := 'order_request_unlinked';
      v_payload := jsonb_build_object(
        'order_request_id',     old.order_request_id,
        'order_request_number', old.order_request_number
      );
    end if;

  -- Any other status change: record the transition, do not infer the UI action.
  elsif (new.status is distinct from old.status) then
    v_event := 'status_changed';
    v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
    if (new.admin_note is not null) then
      v_payload := v_payload || jsonb_build_object('note', new.admin_note);
    end if;

  else
    -- No status change, no order-link change, no request-link change: a plain
    -- field edit or updated_at-only touch. Nothing is recorded.
    return null;
  end if;

  insert into public.finance_payment_request_activity_log
    (payment_request_id, actor_id, event_type, payload)
  values (new.id, v_actor, v_event, v_payload);

  return null;  -- AFTER trigger; return value ignored.
end;
$$;

revoke execute on function public.log_finance_payment_request_activity() from public, anon, authenticated;

-- ── 4. Order-request activity — payment link events ───────────────────────────
-- Mirrors order_activity_log's existing payment_linked / payment_unlinked
-- convention (20260691) on the request side. Rows are written only by the
-- SECURITY DEFINER RPCs below (client INSERT grants on order_request_activity
-- were revoked in 20260680); from_status/to_status stay NULL because linking
-- never changes the request's status.

alter table public.order_request_activity
  drop constraint order_request_activity_event_type_check;

alter table public.order_request_activity
  add constraint order_request_activity_event_type_check
  check (event_type in (
    'request_submitted',
    'status_changed',
    'request_converted',
    'clarification_requested',
    'clarification_resubmitted',
    'request_rejected',
    'reapplication_submitted',
    'payment_linked',
    'payment_unlinked'
  ));

-- ── 5. Link a suspense payment to an Order Request ────────────────────────────
--
-- Same lock -> revalidate -> mutate -> log template as
-- link_finance_payment_to_order (20260691). Lock ORDER matters: the request
-- row is locked BEFORE the payment row, matching convert_order_request_to_order
-- (request first, then payments) so a link racing a conversion of the same
-- request serializes on the request lock instead of deadlocking.
--
-- Eligible request statuses: 'submitted' and 'needs_clarification' — the two
-- active, convertible-track states. A converted request must receive links via
-- its Order; a rejected request only becomes linkable again through
-- reapplication (rejected -> submitted, 20260689).

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
  v_actor uuid := auth.uid();
  v_pay   public.finance_payment_requests%rowtype;
  v_req   public.order_requests%rowtype;
  v_now   timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to link a payment to an order request'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may link a payment to an order request'
      using errcode = '42501';
  end if;

  -- 3. Validate inputs
  if p_payment_request_id is null then
    raise exception 'A payment request is required' using errcode = 'P0001';
  end if;
  if p_order_request_id is null then
    raise exception 'An order request is required' using errcode = 'P0001';
  end if;

  -- 4. Lock the request row FIRST (see lock-order note above), then validate.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  if v_req.status not in ('submitted', 'needs_clarification') then
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

  -- 5. Lock the payment row: serializes double-clicks, replays, and two
  --    admins racing on the same payment.
  select * into v_pay
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_payment_request_id
      using errcode = 'P0002';
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
  -- originated as a new-order request may be parked on one. An existing_order
  -- payment was validated against a real, already-selected Order at submission
  -- time and must never be re-routed toward a request. (In practice every
  -- suspense payment is new_order-origin — existing_order payments approve
  -- straight to approved_linked — but the rule is enforced here, not assumed.)
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

-- ── 6. Unlink a payment from an Order Request (back to plain suspense) ────────
-- Mirror of unlink_finance_payment_from_order (20260691): admin-only, reason
-- mandatory, payment_against = 'new_order' gate kept (every suspense payment
-- is new_order-origin by construction — existing_order payments approve
-- straight to approved_linked — but the gate is restated so this path can
-- never become a detour around that business rule). Only the payment row is
-- locked; holding a single lock cannot form a cycle with the request-first
-- lock order used by link/convert.

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
  v_actor           uuid := auth.uid();
  v_pay             public.finance_payment_requests%rowtype;
  v_reason          text;
  v_prev_request_id     uuid;
  v_prev_request_number text;
  v_now             timestamptz := now();
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
    raise exception 'Only an admin may unlink a payment from an order request'
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

  -- 4. Lock the payment row.
  select * into v_pay
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_payment_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Only a currently request-linked payment can be unlinked here.
  if v_pay.order_request_id is null then
    raise exception 'Payment % has no linked order request to unlink from', v_pay.request_number
      using errcode = 'P0001';
  end if;

  -- 6. Same origin gate as the order unlink (see note above).
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
    'payment_request_id',           v_pay.id,
    'request_number',               v_pay.request_number,
    'status',                       'approved_unlinked',
    'previous_order_request_id',     v_prev_request_id,
    'previous_order_request_number', v_prev_request_number,
    'reason',                        v_reason,
    'unlinked_at',                   v_now
  );
end;
$$;

revoke execute on function public.unlink_finance_payment_from_order_request(uuid, text) from public, anon, authenticated;
grant  execute on function public.unlink_finance_payment_from_order_request(uuid, text) to authenticated;

-- ── 7. Conversion RPC: transfer request-linked payments automatically ─────────
-- Body is the deployed 20260696 version with one addition: the payments parked
-- on this request via order_request_id are merged into the set to link, and
-- the linking UPDATE clears the request linkage in the same statement — so
-- each transferred payment atomically becomes approved_linked/order_id-set/
-- order_request_id-null, satisfying every CHECK, firing exactly one
-- order_linked activity event (with from_order_request_* payload), and never
-- existing in an intermediate state. Signature unchanged, so CREATE OR REPLACE
-- keeps existing grants.

create or replace function public.convert_order_request_to_order(
  p_order_request_id    uuid,
  p_payment_request_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_req      public.order_requests%rowtype;
  v_number   text;
  v_order_id uuid;
  v_now      timestamptz := now();
  v_manual   uuid[];
  v_ids      uuid[];
  v_count    integer;
  v_eligible integer;
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to convert an order request'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may convert an order request'
      using errcode = '42501';
  end if;

  -- 3. Normalize the manual selection: null array -> empty, null elements
  --    dropped, duplicates collapsed.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_manual
  from unnest(coalesce(p_payment_request_ids, '{}'::uuid[])) as t(x)
  where x is not null;

  -- 4. Lock the request row: serializes double-clicks, replays, two admins
  --    racing on the same request, AND any concurrent
  --    link_finance_payment_to_order_request on this request (it takes the
  --    request lock first too, so no NEW payment can be parked on this
  --    request for the rest of this transaction).
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Recheck every Phase 2A conversion rule.
  if v_req.converted_order_id is not null or v_req.converted_at is not null then
    raise exception 'Order request % has already been converted', v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'Only a submitted order request can be converted (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 6. Build the lock set: the admin's manual selection UNION every payment
  --    currently parked on this request, sorted so the lock acquisition below
  --    is deterministic (deadlock-free with any concurrent conversion locking
  --    an overlapping set).
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_ids
  from (
    select unnest(v_manual) as x
    union
    select f.id
    from public.finance_payment_requests f
    where f.order_request_id = p_order_request_id
  ) as t
  where x is not null;

  if coalesce(array_length(v_ids, 1), 0) > 0 then
    -- 7. Lock every payment in ascending uuid order.
    perform 1
    from public.finance_payment_requests
    where id = any(v_ids)
    order by id
    for update;

    -- 8. Rebuild the link set UNDER the held locks: the manual selection plus
    --    the payments STILL parked on this request. A payment unparked by a
    --    concurrent unlink between step 6 and the locks is thereby dropped
    --    (left locked but untouched) instead of being silently swept into the
    --    new Order against that admin's action.
    select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
      into v_ids
    from (
      select unnest(v_manual) as x
      union
      select f.id
      from public.finance_payment_requests f
      where f.id = any(v_ids)
        and f.order_request_id = p_order_request_id
    ) as t
    where x is not null;
  end if;

  v_count := coalesce(array_length(v_ids, 1), 0);

  if v_count > 0 then
    -- 9. Revalidate AFTER the locks are held — never trust the list the client
    --    was shown. Eligible = approved_unlinked, no order, and either no
    --    request linkage or parked on THIS request. A payment parked on a
    --    DIFFERENT request, or linked/consumed meanwhile, fails the count
    --    (a missing id, a wrong status, or a populated order_id each make the
    --    eligible count fall short).
    select count(*) into v_eligible
    from public.finance_payment_requests
    where id = any(v_ids)
      and status   = 'approved_unlinked'
      and order_id is null
      and (order_request_id is null or order_request_id = p_order_request_id);

    -- 10. All-or-nothing: one bad payment aborts the entire conversion, so no
    --     Order is created and the request stays submitted.
    if v_eligible <> v_count then
      raise exception 'STALE_PAYMENTS: one or more selected payment requests are no longer eligible for linking'
        using errcode = 'P0001';
    end if;
  end if;

  -- 11. Allocate the official Order number only once every check has passed,
  --     via the existing generator, so a rejected attempt never burns one.
  v_number := public.next_order_display_number();

  -- 12. Exactly one official Order (status left to the orders default).
  insert into public.orders (
    display_number, client_name, requested_by, assigned_to,
    confirm_date, due_date, total_value, total_product_value, lead_source, notes, created_by
  )
  values (
    v_number, v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.total_product_value,
    v_req.lead_source, v_req.notes, v_actor
  )
  returning id into v_order_id;

  -- 13. Link every payment in the set to the Order just created, clearing any
  --     request parking in the same statement. Amount, dates, mode, proof,
  --     submitter, and prior activity rows are untouched — this is a pure
  --     linkage transfer, never a copy.
  if v_count > 0 then
    update public.finance_payment_requests
       set status               = 'approved_linked',
           order_id             = v_order_id,
           order_number         = v_number,
           order_request_id     = null,
           order_request_number = null,
           updated_at           = v_now
     where id = any(v_ids);
  end if;

  -- 14. Close out the request. Runs after linking so the request_converted
  --     activity row can record linked_payment_count from real state.
  update public.order_requests
     set status             = 'converted',
         converted_order_id = v_order_id,
         converted_at       = v_now,
         updated_at         = v_now
   where id = p_order_request_id;

  -- 15. Order-side provenance (no amounts or payment details in the payload).
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_request',
    jsonb_build_object(
      'order_request_id',     v_req.id,
      'request_number',       v_req.request_number,
      'linked_payment_count', v_count
    )
  );

  -- 16. Structured result — identifiers and counts only, no private payment data.
  return jsonb_build_object(
    'order_request_id',           v_req.id,
    'request_number',             v_req.request_number,
    'order_id',                   v_order_id,
    'order_display_number',       v_number,
    'converted_at',               v_now,
    'linked_payment_count',       v_count,
    'linked_payment_request_ids', to_jsonb(v_ids)
  );
end;
$$;

revoke execute on function public.convert_order_request_to_order(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function public.convert_order_request_to_order(uuid, uuid[]) to authenticated;
