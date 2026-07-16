-- Order Requests Phase 2B — link approved Finance payments during conversion.
--
-- Extends the Phase 2A conversion so an admin may OPTIONALLY select eligible
-- Finance Payment Requests and have them linked to the Order created by the
-- same conversion transaction:
--
--   public.convert_order_request_to_order(
--     p_order_request_id    uuid,
--     p_payment_request_ids uuid[] default '{}'::uuid[]
--   )
--
-- Signature note: adding a parameter via CREATE OR REPLACE would OVERLOAD the
-- Phase 2A function rather than replace it, leaving two candidates that
-- PostgREST could not resolve for a one-argument call. The 1-arg version is
-- therefore dropped and replaced by this single, unambiguous 2-arg definition.
-- The default keeps zero-payment conversion working exactly as in Phase 2A.
--
-- Finance activity note: NO new Finance event type is introduced. The deployed
-- trigger log_finance_payment_request_activity() already derives, from the real
-- row transition, exactly the event this phase needs:
--     old.status = 'approved_unlinked' and new.status = 'approved_linked'
--       -> 'order_linked', payload { order_id, order_number }, actor auth.uid()
-- Linking through this RPC therefore produces exactly one order_linked row per
-- payment, through the existing architecture. Adding a payment_linked_to_order
-- event would duplicate that transition and create a second, competing linking
-- architecture, so it is deliberately not added.
--
-- Nothing here changes the Payment Request status model, Finance approval rules,
-- Payment Request numbering, official Order numbering, Finance RLS, or the
-- existing standalone Finance linking flow (finance/page.tsx), which continues
-- to link payments by direct update under the admin RLS policy.

-- ── 1. Order Request activity: record how many payments were linked ───────────
-- request_converted stays the single request-level conversion event (no second
-- payment event is added — the per-payment detail already lives in Finance
-- activity, and the Order↔request link is already recorded here and on the
-- Order). Its details gain linked_payment_count only.
--
-- The count is read from the payments now attached to the created Order, which
-- is why the RPC below links payments BEFORE flipping the request to converted.
-- Activity therefore remains entirely trigger-derived from real committed state
-- and is never client-supplied.

create or replace function public.log_order_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_order_number text;
  v_linked_count integer;
begin
  if (tg_op = 'INSERT') then
    insert into public.order_request_activity
      (order_request_id, event_type, actor_id, from_status, to_status)
    values (new.id, 'request_submitted', v_actor, null, new.status);

  elsif (new.status is distinct from old.status) then
    if (new.status = 'converted') then
      select o.display_number into v_order_number
      from public.orders o
      where o.id = new.converted_order_id;

      select count(*) into v_linked_count
      from public.finance_payment_requests f
      where f.order_id = new.converted_order_id;

      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'request_converted', v_actor, old.status, new.status,
              jsonb_build_object(
                'converted_order_id',   new.converted_order_id,
                'order_display_number', v_order_number,
                'linked_payment_count', v_linked_count
              ));
    else
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'status_changed', v_actor, old.status, new.status);
    end if;

  -- else: a plain field edit / updated_at touch — nothing to record.
  end if;

  return null;  -- AFTER trigger; return value is ignored.
end;
$$;

revoke execute on function public.log_order_request_activity() from public, anon, authenticated;

-- ── 2. Replace the conversion RPC with the payment-aware signature ────────────

drop function if exists public.convert_order_request_to_order(uuid);

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

  -- 3. Normalize the selection BEFORE taking any lock: null array -> empty,
  --    null elements dropped, duplicates collapsed. Sorting by id here is what
  --    makes the lock order below deterministic. Duplicate ids therefore cannot
  --    produce duplicate links or duplicate activity rows.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_ids
  from unnest(coalesce(p_payment_request_ids, '{}'::uuid[])) as t(x)
  where x is not null;

  v_count := coalesce(array_length(v_ids, 1), 0);

  -- 4. Lock the request row: serializes double-clicks, replays, and two admins
  --    racing on the same request.
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

  if v_count > 0 then
    -- 6. Lock every selected payment, in ascending uuid order. Ordering the
    --    lock acquisition means two concurrent conversions selecting overlapping
    --    payments queue on the same first row instead of deadlocking. The
    --    LockRows step runs above the sort, so rows are locked in sorted order.
    perform 1
    from public.finance_payment_requests
    where id = any(v_ids)
    order by id
    for update;

    -- 7. Revalidate AFTER the locks are held — never trust the list the client
    --    was shown. A payment linked by another admin between the modal opening
    --    and this call is now visible here and rejects the whole operation.
    --    This single count covers all failure modes at once: a missing id, a
    --    non-approved_unlinked status, or an already-populated order_id each
    --    make the eligible count fall short of the selected count.
    select count(*) into v_eligible
    from public.finance_payment_requests
    where id = any(v_ids)
      and status   = 'approved_unlinked'
      and order_id is null;

    -- 8. All-or-nothing: one bad payment aborts the entire conversion, so no
    --    Order is created and the request stays submitted.
    if v_eligible <> v_count then
      raise exception 'STALE_PAYMENTS: one or more selected payment requests are no longer eligible for linking'
        using errcode = 'P0001';
    end if;
  end if;

  -- 9. Allocate the official Order number only once every check has passed, via
  --    the existing generator, so a rejected attempt never burns one.
  v_number := public.next_order_display_number();

  -- 10. Exactly one official Order (status left to the orders default).
  insert into public.orders (
    display_number, client_name, requested_by, assigned_to,
    confirm_date, due_date, total_value, lead_source, notes, created_by
  )
  values (
    v_number, v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.lead_source,
    v_req.notes, v_actor
  )
  returning id into v_order_id;

  -- 11. Link the selected payments to the Order just created. Every value is
  --     server-derived: the client's chosen Order id/number can never reach
  --     this update. Each row's approved_unlinked -> approved_linked transition
  --     fires the existing Finance activity trigger, producing exactly one
  --     order_linked event per payment.
  if v_count > 0 then
    update public.finance_payment_requests
       set status       = 'approved_linked',
           order_id     = v_order_id,
           order_number = v_number,
           updated_at   = v_now
     where id = any(v_ids);
  end if;

  -- 12. Close out the request. Runs after linking so the request_converted
  --     activity row can record linked_payment_count from real state.
  update public.order_requests
     set status             = 'converted',
         converted_order_id = v_order_id,
         converted_at       = v_now,
         updated_at         = v_now
   where id = p_order_request_id;

  -- 13. Order-side provenance (no amounts or payment details in the payload).
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_request',
    jsonb_build_object(
      'order_request_id',     v_req.id,
      'request_number',       v_req.request_number,
      'linked_payment_count', v_count
    )
  );

  -- 14. Structured result — identifiers and counts only, no private payment data.
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

-- The DROP above discarded Phase 2A's grants, so re-establish them on the new
-- signature: clear the defaults, then grant to the only role the application
-- ever authenticates as. This project has no admin database role, so admin-only
-- runtime authorization stays enforced by the explicit check inside the body.
revoke execute on function public.convert_order_request_to_order(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function public.convert_order_request_to_order(uuid, uuid[]) to authenticated;
