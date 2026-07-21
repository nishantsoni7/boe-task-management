-- Confirmed Orders — retire the obsolete 'requested' status.
--
-- Business context: Order Requests and Confirmed Orders are now two distinct
-- entities. 20260701000000 gave every Order a first-class pointer back to the
-- request it came from, and the application (P2) removed converted requests
-- from the Order Requests module entirely. What remains is the last piece of
-- the old single-entity model: the Order status 'requested'.
--
-- That status is now meaningless, and actively misleading. It was the state an
-- Order sat in while its request was still being reviewed — but under the new
-- model an Order does not exist until the request has already been reviewed and
-- converted. Every Order that exists is, by construction, an approved and
-- confirmed Order. A Confirmed Order whose status reads "Requested" describes a
-- review step that happened on a different entity entirely, and offers a
-- 'requested -> running' transition that no longer corresponds to any real
-- decision anyone makes.
--
-- So the workflow now begins at 'running', and 'requested' is removed from the
-- domain rather than merely hidden in the UI. Hiding it in the application
-- would leave the database able to produce a status the application cannot
-- render, which is exactly the drift this project has avoided elsewhere.
--
-- Live state this migration was written against (inspected on the deployed
-- database, 2026-07-21, not inferred from migration files):
--
--   orders_status_check   CHECK (status = ANY (ARRAY['requested','running',
--                         'on_hold','ready_for_dispatch','dispatched','cancelled']))
--   orders.status DEFAULT 'requested'::text
--   public.orders          1 row total, 1 with status = 'requested'
--   convert_order_request_to_order(uuid,uuid[])
--                         inserts the Order WITHOUT naming status, i.e. it
--                         relies on the column default — which is why the
--                         default and the function must both be corrected, and
--                         why changing only one of them would be a silent trap
--                         for the next person to touch either.
--
-- Nothing else in the database references the literal 'requested': no RLS
-- policy, no view, no other CHECK constraint, no other column default, and no
-- other function (verified against pg_policies, pg_views, pg_constraint,
-- information_schema.columns and pg_get_functiondef over every function in
-- public). convert_order_request_to_order is also the ONLY function that
-- inserts into public.orders.
--
-- Scope discipline: this migration retires one status. It does not change Order
-- numbering or the display_number format, does not add any Order Request
-- deletion path, does not delete or alter a single order_requests row, does not
-- touch payment linking, and does not alter any RLS policy or grant.

-- ── 1. Migrate the existing rows ──────────────────────────────────────────────
-- Runs BEFORE the constraint is swapped, so it executes under the OLD check,
-- where both the source and target values are legal — no window in which the
-- table violates its own constraint.
--
-- 'running' is the correct destination, not merely the convenient one: under
-- the old graph 'requested' had exactly two exits, 'running' and 'cancelled',
-- and an Order sitting in 'requested' is one nobody has cancelled. Its work is
-- open. That is what 'running' means.
--
-- The WHERE clause is the whole safety story: rows in any other status are not
-- read, not locked for update, and not touched. orders_set_updated_at will bump
-- updated_at on the migrated rows only, which is accurate — their status really
-- did change. orders_protect_source_request also fires on these rows and passes,
-- because this statement does not touch either provenance column.

update public.orders
   set status = 'running'
 where status = 'requested';

-- ── 2. Remove 'requested' from the allowed set ────────────────────────────────
-- Drop-then-add rather than a NOT VALID add: the table is small, every row was
-- just brought into compliance by section 1, and a validated constraint is what
-- makes "no Order can ever be 'requested' again" a database guarantee rather
-- than an application convention. `if exists` keeps the migration re-runnable.

alter table public.orders
  drop constraint if exists orders_status_check;

alter table public.orders
  add constraint orders_status_check check (
    status = any (array['running', 'on_hold', 'ready_for_dispatch', 'dispatched', 'cancelled'])
  );

-- ── 3. New default ────────────────────────────────────────────────────────────
-- Required for correctness, not tidiness: with 'requested' no longer permitted
-- by the CHECK, a default of 'requested' would make every INSERT that omits
-- status fail outright.

alter table public.orders
  alter column status set default 'running';

comment on column public.orders.status is
  'Confirmed Order workflow state. Begins at ''running'' — an Order exists only after its Order Request was reviewed and converted, so there is no pre-approval state here. The former ''requested'' value was retired in 20260702000000.';

-- ── 4. Conversion RPC — state the status explicitly ───────────────────────────
-- The deployed 20260701000000 body, reproduced verbatim from pg_get_functiondef
-- on the live database, with exactly one change: step 12 now names `status` in
-- the INSERT and supplies 'running'.
--
-- Naming it is the point. The previous body deliberately left status to the
-- column default, which meant the Order's starting state was decided somewhere
-- the reader of this function could not see. Section 3 already makes the
-- default correct, so this line is not what fixes the behaviour — it is what
-- makes the behaviour legible, and what keeps a future change to the column
-- default from silently redefining what conversion produces.
--
-- Everything else is untouched, and deliberately so: the admin authorization
-- recheck, the row lock, the conversion-eligibility rechecks, the deterministic
-- payment lock ordering, the all-or-nothing STALE_PAYMENTS revalidation under
-- the held locks, the pure linkage transfer (never a copy), the P1 provenance
-- columns source_order_request_id / source_request_number, the request close-out
-- to 'converted', the order_activity_log row, and the returned jsonb shape.
--
-- CREATE OR REPLACE with the signature unchanged, so the existing ACL
-- (postgres=X, service_role=X, authenticated=X; anon and public revoked)
-- survives. The revoke/grant below re-asserts exactly that live state rather
-- than changing it — a DROP would have discarded it.

create or replace function public.convert_order_request_to_order(
  p_order_request_id    uuid,
  p_payment_request_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- 12. Exactly one official Order, starting at 'running' (20260702000000).
  --     Stated explicitly rather than left to the column default: conversion
  --     IS the approval, so the Order it produces is confirmed and its work is
  --     open from its first moment. There is no pre-approval Order state.
  --     source_order_request_id / source_request_number are written here, in
  --     the creating INSERT, so provenance exists from the Order's first
  --     moment and is covered by this transaction's rollback like everything
  --     else. Both are frozen immediately afterwards by
  --     orders_protect_source_request.
  insert into public.orders (
    display_number, client_name, requested_by, assigned_to,
    confirm_date, due_date, total_value, total_product_value, lead_source, notes, created_by,
    status,
    source_order_request_id, source_request_number
  )
  values (
    v_number, v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.total_product_value,
    v_req.lead_source, v_req.notes, v_actor,
    'running',
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
$function$;

revoke execute on function public.convert_order_request_to_order(uuid, uuid[]) from public, anon;
grant  execute on function public.convert_order_request_to_order(uuid, uuid[]) to authenticated;
