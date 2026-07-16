-- Finance: defer new-order number allocation to admin approval; make proof optional;
-- derive existing-order client name server-side.
--
-- Problem: NewPaymentConfirmationModal (src/app/finance/page.tsx) currently
-- calls next_order_display_number() and inserts a real public.orders row
-- BEFORE admin approval, for every payment_against = 'new_order' submission.
-- An order number is therefore consumed and a live 'requested' order created
-- the instant a salesperson submits a request, regardless of whether an admin
-- ever approves it.
--
-- Fix, following the exact pattern already established by
-- convert_order_request_to_order() (20260681000000 / 20260682000000):
--   * The client no longer allocates anything on submit. A new_order request
--     is inserted with order_id = NULL, order_number = NULL.
--   * A single SECURITY DEFINER RPC, approve_finance_payment_request(), is the
--     only path that allocates an order number and creates the Order row. It
--     locks the request row FOR UPDATE, revalidates status = 'pending_approval'
--     inside the lock, and only then calls next_order_display_number() — so a
--     rejected/failed approval never burns a number, and a retried/duplicated
--     approval call finds the row already approved_linked and is rejected
--     before it can allocate a second number.
--   * existing_order requests already carry a real order_id from submission
--     (selected by the user from a search) and are left untouched by the
--     allocation branch — the RPC simply promotes them to approved_linked.
--
-- Also in this migration (small, same-table changes bundled to avoid a churn
-- of near-identical migrations):
--   * proof_note becomes nullable — Payment Proof / Reference is no longer a
--     required field. No other proof validation (file type/size, storage
--     rules) is touched.
--   * client_name for an existing_order request is authoritatively derived
--     from the selected order inside a BEFORE INSERT OR UPDATE trigger, never
--     trusted from the client payload — mirrors created_by/request_number
--     immutability patterns already used on this table and on order_requests.

-- ── 1. Payment Proof / Reference is optional ───────────────────────────────────

alter table public.finance_payment_requests
  alter column proof_note drop not null;

-- ── 2. Server-derived client_name for existing-order requests ─────────────────
-- Fires on INSERT and on UPDATE (so a later order_id change, e.g. via the
-- Received Payments "Link"/"Change" flow, keeps client_name in sync too).
-- new_order requests are untouched here — their client_name is genuinely
-- user-entered (no order exists yet to derive it from).

create or replace function public.enforce_finance_payment_request_client_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_client_name text;
begin
  if new.payment_against = 'existing_order' then
    if new.order_id is null then
      raise exception 'An existing order must be selected for an existing-order payment request'
        using errcode = 'P0001';
    end if;

    select o.client_name into v_client_name
    from public.orders o
    where o.id = new.order_id;

    if not found or v_client_name is null or btrim(v_client_name) = '' then
      raise exception 'Selected order has no client name on file. Correct it on the Order Details page before submitting a payment request.'
        using errcode = 'P0001';
    end if;

    new.client_name := v_client_name;
  end if;

  return new;
end;
$$;

-- Not SECURITY DEFINER: only reads public.orders (readable to any authenticated
-- caller who can already see it via orders RLS for the id they submitted) and
-- writes columns of the row already being mutated under existing RLS. No
-- elevated privilege is required. search_path is still pinned defensively.
revoke execute on function public.enforce_finance_payment_request_client_name()
  from public, anon, authenticated;

drop trigger if exists finance_payment_requests_enforce_client_name
  on public.finance_payment_requests;

create trigger finance_payment_requests_enforce_client_name
  before insert or update on public.finance_payment_requests
  for each row execute function public.enforce_finance_payment_request_client_name();

-- ── 3. Approval RPC — the only path that allocates a new order number ─────────
--
-- Authorization: SECURITY DEFINER is required because the function must
-- insert into public.orders (and, for new_order requests, allocate from the
-- orders_display_number_seq sequence) as a single trusted unit, independent of
-- the caller's own RLS — same rationale as convert_order_request_to_order().
-- This project has no admin database role, so admin-only authorization is
-- enforced explicitly in the body against public.users.role = 'admin', the
-- established pattern every Finance/Orders policy already uses.
--
-- Concurrency / idempotency: the target row is locked FOR UPDATE before any
-- check. Only status = 'pending_approval' may be approved through this
-- function, and the row is flipped to 'approved_linked' before the function
-- returns. A second call (retry, double-click, or two admins racing) blocks on
-- the lock, then sees the already-approved_linked row once it acquires it, and
-- is rejected by the status check — so it can never allocate or assign a
-- second order number. If any step raises, the whole transaction rolls back:
-- no order row survives and no payment-request field changes, so a failed
-- approval consumes nothing except (potentially) a skipped sequence value,
-- which is the same accepted, documented behavior as every other caller of
-- next_order_display_number() (20260671) and convert_order_request_to_order()
-- (20260681000000) — numbers are never duplicated or reused, only ever
-- skipped-and-left-skipped on failure.

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

  v_order_id := v_req.order_id;

  if v_req.payment_against = 'new_order' then
    if v_order_id is null then
      -- 5. Allocate the official Order number only now that every check has
      --    passed, via the existing generator — a rejected/failed approval
      --    never burns a number.
      v_number := public.next_order_display_number();

      insert into public.orders (
        display_number, client_name, requested_by, created_by, status
      )
      values (
        v_number, v_req.client_name, v_req.submitted_by, v_actor, 'requested'
      )
      returning id into v_order_id;

      insert into public.order_activity_log (order_id, actor_id, event_type, payload)
      values (
        v_order_id, v_actor, 'order_created_from_payment_request',
        jsonb_build_object(
          'payment_request_id', v_req.id,
          'request_number',     v_req.request_number
        )
      );
    else
      -- Already has an order (e.g. a prior partial correction) — resolve the
      -- number authoritatively from the order row rather than trusting the
      -- stored order_number text column.
      select o.display_number into v_number
      from public.orders o
      where o.id = v_order_id;
    end if;
  else
    -- existing_order: order_id must already be set (enforced by the
    -- client-name trigger above at insert time). Resolve the number
    -- authoritatively from the order itself.
    if v_order_id is null then
      raise exception 'Payment request % has no linked order to approve against', v_req.request_number
        using errcode = 'P0001';
    end if;

    select o.display_number into v_number
    from public.orders o
    where o.id = v_order_id;
  end if;

  -- 6. Close out the request. finance_payment_requests_log_activity (20260675)
  --    derives the 'request_approved_linked' activity row from this real
  --    committed transition — nothing extra to insert here.
  update public.finance_payment_requests
     set status       = 'approved_linked',
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
    'order_id',             v_order_id,
    'order_display_number', v_number,
    'approved_at',          v_now
  );
end;
$$;

-- Clear the defaults, then re-grant to the only role the application ever
-- authenticates as. Admin-only runtime authorization is enforced by the
-- explicit check inside the function body (step 2), not by the grant.
revoke execute on function public.approve_finance_payment_request(uuid, text) from public, anon, authenticated;
grant  execute on function public.approve_finance_payment_request(uuid, text) to authenticated;
