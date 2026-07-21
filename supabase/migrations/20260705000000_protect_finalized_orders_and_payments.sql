-- Orders & Finance — make finalized business records permanently undeletable.
--
-- Business rule: once a record represents real business activity it is history,
-- not data. Confirmed Orders, converted Order Requests, and approved bank
-- payments (both linked Received Payments and unlinked/suspense payments) can
-- never be removed through any ordinary path. Unfinished records — unapproved
-- Payment Requests, unconverted Order Requests — stay deletable, because they
-- represent a mistake rather than an event.
--
-- Live state this migration was written against (inspected on the deployed
-- database, 2026-07-21, not inferred from migration files):
--
--   orders                          1 row  ('0017', running, provenance set)
--   order_requests                  2 rows (1 converted, 1 needs_clarification)
--   finance_payment_requests        0 rows
--   payment_proof_attachments       0 rows;  payment-proofs bucket: 0 objects
--
--   orders_admin_delete             DELETE to authenticated, USING (role='admin')
--                                   -> an admin could delete ANY Confirmed Order
--   order_requests_admin_delete     same shape, including converted requests
--   finance_payment_requests_admin_delete
--                                   same shape, including approved payments
--   finance_payment_requests_guard_approved_delete()
--                                   BEFORE DELETE trigger that EXEMPTS admins and
--                                   exempts auth.uid() IS NULL -> the approved
--                                   payment guard did not actually hold for the
--                                   two roles most able to use it
--   /api/orders/[id] DELETE         a SERVICE-ROLE route; RLS does not apply to
--                                   it at all, so policies alone can never be the
--                                   whole answer for Orders
--
-- Three-layer defence, because each layer alone has a hole:
--
--   1. RLS policies      — remove or narrow, so PostgREST refuses the statement.
--                          Does not constrain the service role.
--   2. BEFORE DELETE triggers — fire for EVERY path including the service role
--                          and direct SQL. This is the actual guarantee.
--   3. Application       — remove the buttons and neuter the API route, so the
--                          UI stops offering something the database refuses.
--                          (Not in this file; see the source changes.)
--
-- Scope discipline: this migration removes delete capability and adds one
-- narrow RPC. It creates no table, deletes no row, touches no Order number, no
-- sequence, no cycle, no provenance FK, and no SELECT/INSERT/UPDATE policy.

-- ── 1. The cleanup escape hatch ───────────────────────────────────────────────
--
-- The guards below are absolute, which would make the Test Data Cleanup of
-- 20260706000000 impossible — so they consult one transaction-local marker that
-- only that flow sets.
--
-- Why a GUC rather than "exempt admins" (which is exactly the hole this
-- migration is closing): a GUC is not an identity, it is a CONTEXT. It cannot be
-- set by PostgREST, is not carried in a JWT, and there is no RPC that sets it
-- except the cleanup executor — which validates admin, the enabled setting, the
-- typed confirmation, and per-row test-data eligibility *before* setting it. And
-- because set_config(..., true) is transaction-local, it evaporates at COMMIT or
-- ROLLBACK; it can never leak into a later statement or another session.
--
-- Defined here, next to the guards that read it, so the two cannot drift.

create or replace function public.in_test_data_cleanup()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('boe.cleanup_context', true), '') = 'test_data_cleanup';
$$;

revoke execute on function public.in_test_data_cleanup() from public, anon, authenticated;

comment on function public.in_test_data_cleanup() is
  'True only inside a transaction that execute_test_data_cleanup() has authorized. Transaction-local; not settable by any client. Read by the delete guards on orders / order_requests / finance_payment_requests.';

-- ── 2. Confirmed Orders are permanent ─────────────────────────────────────────
--
-- The policy is DROPPED rather than narrowed: after 20260702 retired the
-- 'requested' status, EVERY row in public.orders is a Confirmed Order, so there
-- is no remaining category of Order that an admin should ever be able to delete.
-- A narrowed policy would imply one exists.
--
-- No replacement DELETE policy is created. With RLS enabled and no DELETE policy
-- at all, PostgREST refuses the statement for every client role.

drop policy if exists "orders_admin_delete" on public.orders;

-- The trigger is what makes it true for the service role and for direct SQL.
-- Without this, /api/orders/[id] would still be able to delete an Order, since a
-- service-role client bypasses RLS entirely.

create or replace function public.prevent_order_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.in_test_data_cleanup() then
    return old;
  end if;

  raise exception
    'ORDER_DELETE_BLOCKED: Confirmed Order % is permanent business history and cannot be deleted',
    old.display_number
    using errcode = '42501';
end;
$$;

revoke execute on function public.prevent_order_delete() from public, anon, authenticated;

drop trigger if exists orders_prevent_delete on public.orders;

create trigger orders_prevent_delete
  before delete on public.orders
  for each row execute function public.prevent_order_delete();

-- ── 3. Converted Order Requests are permanent; unconverted ones stay deletable ─
--
-- A converted request is the documented origin of a Confirmed Order, and
-- orders.source_order_request_id (20260701, NO ACTION) already refuses to let it
-- go. That FK is left exactly as it is — nothing here weakens provenance. What
-- this section adds is the SAME answer for a converted request that has somehow
-- lost its Order, and a clear message instead of a raw FK violation.
--
-- The admin policy is narrowed rather than dropped, because deleting a
-- mistakenly-submitted request that was never converted is legitimate cleanup,
-- not history destruction.

drop policy if exists "order_requests_admin_delete" on public.order_requests;

create policy "order_requests_admin_delete_unconverted"
  on public.order_requests
  for delete to authenticated
  using (
    status <> 'converted'
    and converted_order_id is null
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

create or replace function public.prevent_converted_order_request_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.in_test_data_cleanup() then
    return old;
  end if;

  if old.status = 'converted' or old.converted_order_id is not null then
    raise exception
      'ORDER_REQUEST_CONVERTED_PERMANENT: Order Request % created a Confirmed Order and is retained as permanent source history',
      old.request_number
      using errcode = '42501';
  end if;

  return old;
end;
$$;

revoke execute on function public.prevent_converted_order_request_delete() from public, anon, authenticated;

drop trigger if exists order_requests_prevent_converted_delete on public.order_requests;

create trigger order_requests_prevent_converted_delete
  before delete on public.order_requests
  for each row execute function public.prevent_converted_order_request_delete();

-- ── 4. Approved bank payments are permanent ───────────────────────────────────
--
-- Both approved statuses are real money that arrived:
--   approved_linked    — a Received Payment attached to an Order
--   approved_unlinked  — a Received Payment sitting in Suspense, not yet attached
-- Suspense is NOT a draft state. The money is in the bank either way, so both are
-- protected identically. (There is no separate received_payments or suspense
-- table; these are statuses of this one table.)
--
-- The broad admin policy is replaced with the same rule the creator already has:
-- unapproved statuses only. An admin keeps the ability to clear out a bad
-- Payment Request that was never approved.

drop policy if exists "finance_payment_requests_admin_delete" on public.finance_payment_requests;

create policy "finance_payment_requests_admin_delete_unapproved"
  on public.finance_payment_requests
  for delete to authenticated
  using (
    status in ('pending_approval', 'needs_clarification', 'rejected')
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

-- The 20260700 §3 guard is replaced. Its two exemptions were precisely the hole:
--
--   * "admins are exempt" was written when the Received Payments page's Delete
--     action was considered the sanctioned way to remove an approved payment.
--     That action is being removed; approved payments are now permanent, so the
--     exemption has nothing left to authorize.
--   * "auth.uid() IS NULL is exempt" let every service-role route and any direct
--     SQL delete an approved payment silently.
--
-- Both are replaced by the single cleanup-context check. Everything else about
-- the guard — the statuses, the message shape, the errcode — is unchanged.

create or replace function public.finance_payment_requests_guard_approved_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.in_test_data_cleanup() then
    return old;
  end if;

  if old.status in ('approved_unlinked', 'approved_linked') then
    raise exception
      'PAYMENT_APPROVED_PERMANENT: Payment % has been approved and is permanent bank payment history',
      old.request_number
      using errcode = '42501';
  end if;

  return old;
end;
$$;

revoke execute on function public.finance_payment_requests_guard_approved_delete() from public, anon, authenticated;

-- Trigger itself is unchanged and already installed by 20260700 §3; recreated
-- only so this migration is self-contained and re-runnable.
drop trigger if exists finance_payment_requests_guard_approved_delete on public.finance_payment_requests;

create trigger finance_payment_requests_guard_approved_delete
  before delete on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_approved_delete();

-- ── 5. Unlink payments and delete an unconverted Order Request ────────────────
--
-- The one place a normal deletion genuinely needs a transaction, and therefore
-- the one place that needs an RPC.
--
-- finance_payment_requests.order_request_id is a NO ACTION FK, so a request with
-- payments parked on it cannot be deleted while they are attached. Those parked
-- payments are approved_unlinked — real money in Suspense — so the answer is to
-- DETACH them and keep them, never to delete them. Doing that from the client
-- would mean two round trips with a window in between where the payments are
-- detached but the request survives, silently losing the link.
--
-- Deliberately NOT built for Payment Requests. An unapproved Payment Request can
-- carry order_id (an 'existing_order' payment awaiting approval) but can never
-- carry order_request_id — finance_payment_requests_request_link_invariant
-- requires status='approved_unlinked' for that pair. And order_id lives on the
-- row being deleted, so it disappears with it; there is nothing to coordinate.
-- The existing client delete, now that section 4 has narrowed its policy, is
-- already correct and already covers proof-file cleanup.

create or replace function public.admin_delete_order_request(
  p_order_request_id  uuid,
  p_unlink_payments   boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_req        public.order_requests%rowtype;
  v_payments   jsonb;
  v_count      integer;
  v_now        timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to delete an order request'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may delete an order request'
      using errcode = '42501';
  end if;

  -- 3. Lock the request. Serializes against a concurrent conversion, which takes
  --    the same row lock first — so the status re-check below cannot be stale.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'ORDER_REQUEST_NOT_FOUND: That Order Request no longer exists'
      using errcode = 'P0002';
  end if;

  -- 4. Re-check convertedness UNDER the lock. The trigger in section 3 would
  --    also catch this, but raising here gives the caller the request number and
  --    the Order it produced rather than a generic refusal.
  if v_req.status = 'converted' or v_req.converted_order_id is not null then
    raise exception
      'ORDER_REQUEST_CONVERTED_PERMANENT: Order Request % created a Confirmed Order and is retained as permanent source history',
      v_req.request_number
      using errcode = '42501';
  end if;

  -- 5. Collect the parked payments while they are still attached, in one place,
  --    so the result can tell the caller exactly what was preserved.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',             f.id,
           'request_number', f.request_number,
           'amount',         f.amount,
           'status',         f.status
         ) order by f.request_number), '[]'::jsonb),
         count(*)
    into v_payments, v_count
  from public.finance_payment_requests f
  where f.order_request_id = p_order_request_id;

  if v_count > 0 then
    if not p_unlink_payments then
      raise exception
        'ORDER_REQUEST_HAS_PAYMENTS: % payment(s) are still linked to Order Request %. Unlink them to continue.',
        v_count, v_req.request_number
        using errcode = 'P0001';
    end if;

    -- 6. Lock every payment in a deterministic order, matching the convention
    --    convert_order_request_to_order uses, so the two can never deadlock.
    perform 1
    from public.finance_payment_requests
    where order_request_id = p_order_request_id
    order by id
    for update;

    -- 7. Detach, never delete. These are approved_unlinked rows — real money in
    --    Suspense. Clearing the pair together satisfies
    --    finance_payment_requests_request_link_invariant, and the status stays
    --    approved_unlinked, which is exactly where an unparked payment belongs.
    --    The finance activity trigger records an order_request_unlinked row.
    update public.finance_payment_requests
       set order_request_id     = null,
           order_request_number = null,
           updated_at           = v_now
     where order_request_id = p_order_request_id;
  end if;

  -- 8. order_request_activity cascades with the row (ON DELETE CASCADE).
  delete from public.order_requests where id = p_order_request_id;

  -- 9. Notifications carry no foreign key, so nothing removes them implicitly.
  --    Scoped to this request's uuid, so no unrelated notification can be hit.
  delete from public.notifications
   where entity_id = p_order_request_id
     and type::text like 'order%';

  return jsonb_build_object(
    'order_request_id',   p_order_request_id,
    'request_number',     v_req.request_number,
    'unlinked_payments',  v_payments,
    'unlinked_count',     v_count
  );
end;
$$;

revoke execute on function public.admin_delete_order_request(uuid, boolean) from public, anon;
grant  execute on function public.admin_delete_order_request(uuid, boolean) to authenticated;

comment on function public.admin_delete_order_request(uuid, boolean) is
  'Admin-only. Deletes an UNCONVERTED Order Request, optionally detaching (never deleting) any approved payments parked on it, in one transaction. Converted requests are refused — they are permanent source history.';

-- ── 6. What this migration deliberately does NOT do ───────────────────────────
--
--   * No provenance FK is weakened. orders.source_order_request_id and
--     order_requests.converted_order_id both keep NO ACTION.
--   * finance_payment_requests_own_delete (creator, unapproved only) is
--     untouched — it was already correct.
--   * payment_proof_attachments_delete and the payment_proofs storage policy are
--     untouched; proof cleanup after a legitimate unapproved-request delete keeps
--     working exactly as 20260700 built it.
--   * No sequence, no order_number_cycle value, and no display_number is read or
--     written. Deleting records never returns numbers to the pool.
--   * No row is deleted by this migration.
