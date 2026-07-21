-- Confirmed Orders — first-class provenance back to the originating Order Request.
--
-- Business context: Order Requests and Confirmed Orders are being separated into
-- two distinct entities. Converted requests will disappear from the Order
-- Requests module entirely (including for admins), and are to be retained in the
-- database permanently — never hard-deleted. Once the request is no longer
-- reachable through its own module, the ONLY way to answer "where did this Order
-- come from?" must be the Order itself.
--
-- Today that answer lives exclusively on the request row
-- (order_requests.converted_order_id). That is a problem for two independent
-- reasons:
--
--   1. Direction. Order -> Request requires scanning order_requests by
--      converted_order_id. Once the requests module hides converted rows, the
--      Order detail page has no supported forward pointer to render.
--
--   2. Visibility. order_requests RLS is requester-or-admin only
--      (order_requests_requester_select / _admin_select). The orders table is
--      additionally readable by the operations team and by the permission engine
--      (20260685000000). An operations user looking at an Order therefore cannot
--      read the request at all, and would see no provenance whatsoever.
--
-- Storing the pair on public.orders fixes both: provenance is carried by the row
-- that the viewer already has permission to read, and needs no widening of
-- order_requests RLS.
--
-- Denormalizing source_request_number alongside the id is safe here for the same
-- reason finance_payment_requests.order_request_number is safe (20260698000000):
-- request_number is immutable at the database level via the
-- order_requests_protect_number trigger (20260680000000), so the copy can never
-- drift from the source.
--
-- Scope discipline: this migration adds provenance ONLY. It does not hide
-- converted requests, does not touch the 'requested' order status, does not
-- change Order numbering, and does not alter any RLS policy. The conversion RPC
-- is replaced only to populate the two new columns; every other line of its body
-- is the deployed 20260698000000 definition, unchanged.

-- ── 1. Columns ────────────────────────────────────────────────────────────────
--
-- FK deletion behaviour is the DEFAULT (NO ACTION), deliberately, and it is the
-- point of this section rather than an incidental choice: it makes "a converted
-- Order Request is never hard-deleted" a database guarantee instead of a UI
-- convention. Postgres will refuse to delete an order_requests row that any
-- Order still names as its source, for every role including admin and the
-- service role, regardless of which application path attempts it.
--
-- The reverse direction is already protected the same way: order_requests
-- .converted_order_id -> orders(id) is also NO ACTION (20260680000000), so an
-- Order carrying a source request cannot be deleted either. The two FKs are
-- independent guards pointing in opposite directions, and neither replaces the
-- other.

alter table public.orders
  add column if not exists source_order_request_id uuid references public.order_requests(id),
  add column if not exists source_request_number   text;

comment on column public.orders.source_order_request_id is
  'The Order Request this Order was created from, if any. Set only by convert_order_request_to_order() and immutable thereafter. NO ACTION FK: the source request can never be hard-deleted.';

comment on column public.orders.source_request_number is
  'Denormalized display copy of the source request''s request_number. Safe to denormalize: request_number is immutable (order_requests_protect_number).';

-- ── 2. Backfill existing converted relationships ──────────────────────────────
-- Derived from the authoritative reverse link, which is already one-to-one
-- (order_requests_converted_order_id_uidx, 20260681000000), so this correlated
-- update cannot produce an ambiguous match. Orders with no originating request
-- (created by any earlier historical path) are left NULL, which is the correct
-- representation of "not created from a request" — not a gap to be filled.
--
-- The WHERE guard keeps this migration re-runnable and prevents it from
-- overwriting a value the RPC has already set.

update public.orders o
   set source_order_request_id = r.id,
       source_request_number   = r.request_number
  from public.order_requests r
 where r.converted_order_id = o.id
   and o.source_order_request_id is null;

-- ── 3. One Order per source request ───────────────────────────────────────────
-- The mirror of order_requests_converted_order_id_uidx. Without it, two Orders
-- could name the same originating request, which would contradict the
-- one-request-one-Order relationship that the reverse index already enforces.
-- Partial, because almost every Order predating this feature has NULL here and
-- multiple NULLs must remain legal.

create unique index if not exists orders_source_order_request_id_uidx
  on public.orders (source_order_request_id)
  where source_order_request_id is not null;

-- ── 4. Provenance is read-only, in the database ───────────────────────────────
-- orders_admin_update (20260655) and orders_operations_update grant UPDATE on
-- the whole row, so without this guard an admin could silently re-point an
-- Order at a different request, or clear its provenance, and the audit trail
-- would be unfalsifiable. Same immutability idiom already proven on this
-- project by prevent_order_request_number_change() and
-- prevent_order_request_created_by_change() (20260680 / 20260681).
--
-- Once set, both columns are frozen for every role. Setting them from NULL is
-- allowed exactly once, which is what lets the conversion RPC populate them on
-- an Order it has just inserted; and a no-op write of the same value is allowed
-- so ordinary row updates (status changes, notes) never trip the guard.

create or replace function public.prevent_order_source_request_change()
returns trigger
language plpgsql
as $$
begin
  if old.source_order_request_id is not null
     and new.source_order_request_id is distinct from old.source_order_request_id then
    raise exception 'source_order_request_id is immutable and cannot be changed once set'
      using errcode = '42501';
  end if;

  if old.source_request_number is not null
     and new.source_request_number is distinct from old.source_request_number then
    raise exception 'source_request_number is immutable and cannot be changed once set'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.prevent_order_source_request_change() from public, anon, authenticated;

drop trigger if exists orders_protect_source_request on public.orders;

create trigger orders_protect_source_request
  before update on public.orders
  for each row execute function public.prevent_order_source_request_change();

-- ── 5. Conversion RPC — populate the provenance pair ──────────────────────────
-- This is the deployed 20260698000000 body with exactly two fields added to the
-- Order insert (step 12). Verified against the live database before editing:
-- one overload only, matching this definition. Nothing else in the body is
-- changed — the lock order, the payment-transfer set rebuild under held locks,
-- the STALE_PAYMENTS all-or-nothing rule, the number allocation point, the
-- request close-out, and the activity payloads are all untouched.
--
-- The signature is unchanged, so CREATE OR REPLACE preserves the existing
-- grants and no DROP is required (a DROP would discard them, as 20260682000000
-- documents).
--
-- Provenance is written in the same INSERT that creates the Order, inside the
-- same transaction as the request close-out, so an Order created from a request
-- can never exist without its provenance, and a rolled-back conversion leaves
-- neither.

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
  --     source_order_request_id / source_request_number are written here, in
  --     the creating INSERT, so provenance exists from the Order's first
  --     moment and is covered by this transaction's rollback like everything
  --     else. Both are frozen immediately afterwards by
  --     orders_protect_source_request.
  insert into public.orders (
    display_number, client_name, requested_by, assigned_to,
    confirm_date, due_date, total_value, total_product_value, lead_source, notes, created_by,
    source_order_request_id, source_request_number
  )
  values (
    v_number, v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.total_product_value,
    v_req.lead_source, v_req.notes, v_actor,
    v_req.id, v_req.request_number
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

-- Signature unchanged, so the existing grants survive CREATE OR REPLACE. They
-- are restated here only to keep the end state explicit and self-documenting.
revoke execute on function public.convert_order_request_to_order(uuid, uuid[]) from public, anon;
grant  execute on function public.convert_order_request_to_order(uuid, uuid[]) to authenticated;
