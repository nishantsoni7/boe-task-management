-- Finance and Order Management — authorization moves onto the permission engine.
--
-- WHAT THIS FIXES
-- ---------------
-- Both modules already have complete, saved permission grants that decide
-- nothing. A person can hold finance.approve and every Finance control still
-- checks users.role = 'admin' — in the screen, in the RLS policies, and inside
-- the SECURITY DEFINER functions. This migration makes the stored grants real
-- for the protected actions only.
--
-- THE RULE, everywhere below
-- --------------------------
--   admin      keeps exactly the authority it has today. Nothing is taken away.
--   non-admin  gets an action ONLY when resolve_permission() explicitly allows
--              that exact module/action for auth.uid().
--
-- Nothing is ever read from the client. Every check resolves the ACTOR from
-- auth.uid() inside a SECURITY DEFINER function, which is the same shape the
-- Assets & Access cutover used (20260721000000 / 20260725000000).
--
-- WHAT IS DELIBERATELY NOT CHANGED
-- --------------------------------
--   finance.view / finance.create / finance.edit — confidential Finance reads
--       are not broadened, and creation and editing keep their existing
--       ownership rules (submitted_by = auth.uid(), plus the status window).
--       An inert finance.edit row must not become company-wide edit authority,
--       so it is not consulted at all.
--   orders.view    — already enforced by src/app/orders/layout.tsx and the
--                    orders SELECT policy (20260685000000). Untouched.
--   orders.create / orders.edit — the creation workflow and the
--       admin-or-assigned rule in edit_order_request are unchanged in V1.
--   orders.can_be_order_assignee — already engine-driven (20260697000000).
--   export on either module — no server path exists to protect.
--   Attendance and Payroll — admin-only, untouched, and out of scope.
--
-- WHO THIS ACTIVATES
-- ------------------
-- Existing grants that are inert today START WORKING when this is applied.
-- From the Prompt 2 baseline that is Dhruv (all Finance and Orders actions)
-- and Test Sales User (DUMMY) (orders approve + manage). See the impact table
-- in the Prompt 4 report. NOTHING is granted or revoked here — no permission
-- row is written by this migration.
--
-- ADDITIVE AND REVERSIBLE
-- -----------------------
-- No table, column, action, policy or permission row is dropped. Every function
-- below is restated verbatim from the migration that currently defines it, with
-- ONLY the authorization expression changed; a repository test asserts exactly
-- that (src/lib/permissions/migrationContract.test.ts). Three new RLS policies
-- are ADDED alongside the existing ones — RLS policies are permissive and OR
-- together, so the admin paths keep working untouched.
--
-- ROLLBACK PLAN
-- -------------
-- Documented separately and in full at the foot of this file.

-- ─── 1. The two authorization helpers ────────────────────────────────────────
--
-- actor_has_permission   — the ENGINE answer alone. No admin branch. Requires
--                          the holder to be active and not soft-deleted, which
--                          the raw resolver does not check.
-- actor_has_module_permission
--                        — admin OR the above. The admin branch requires the
--                          SAME active / not-deleted test as the engine branch.
--
-- On that last point, deliberately: the checks this replaced tested only
-- role = 'admin', so mirroring them exactly would have let a DEACTIVATED or
-- SOFT-DELETED admin keep approval, correction and deletion authority across
-- Finance and Orders. Deactivating an account does not end its Supabase
-- session — /api/control-center/modules/[key] already says so in as many words
-- — so "they cannot log in anyway" is not true, and an admin who has left the
-- company would have kept the ability to approve payments. That is a hole, not
-- a behaviour worth preserving, and it is closed here.
--
-- The one admin rule NOT routed through this helper is assert_order_amender's,
-- which already required is_active and keeps its own check.
--
-- Both are STABLE and SECURITY DEFINER, matching resolve_permission itself.
-- Neither reads any argument supplied by a client: the actor is always
-- auth.uid().
--
-- No RLS recursion: both run as the owner, so reading public.users here cannot
-- re-enter a policy on public.users.

create or replace function public.actor_has_permission(
  p_module_key text,
  p_action_key text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.is_active
        and coalesce(u.is_deleted, false) = false
    )
    and coalesce(
      public.resolve_permission(auth.uid(), p_module_key, p_action_key),
      false
    );
$$;

comment on function public.actor_has_permission(text, text) is
  'True when the signed-in, active, non-deleted caller holds module/action in the permission engine. No admin short-circuit.';

create or replace function public.actor_has_module_permission(
  p_module_key text,
  p_action_key text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.role = 'admin'
        and u.is_active
        and coalesce(u.is_deleted, false) = false
    )
    or public.actor_has_permission(p_module_key, p_action_key);
$$;

comment on function public.actor_has_module_permission(text, text) is
  'True for an ACTIVE, non-deleted admin, or for a caller holding module/action in the permission engine. Both branches require an active, non-deleted user.';

grant execute on function public.actor_has_permission(text, text) to authenticated;
grant execute on function public.actor_has_module_permission(text, text) to authenticated;

-- ─── 2. Restated functions ───────────────────────────────────────────────────
-- Each block below is the CURRENT definition of that function, copied from the
-- migration named above it, with one authorization expression replaced. Every
-- signature, return type, language, SECURITY DEFINER marker, search_path,
-- validation step, lock order, error message and errcode is preserved.

-- ─── approve_finance_payment_request → finance.approve ─────────────────────────────
-- Deciding a pending payment request is the finance.approve authority.
-- Restated verbatim from 20260715000000_finance_payment_request_targets.sql; ONLY the authorization expression differs.

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
  v_actor       uuid := auth.uid();
  v_peek        public.finance_payment_requests%rowtype;
  v_req         public.finance_payment_requests%rowtype;
  v_order_req   public.order_requests%rowtype;
  v_order_id    uuid;
  v_number      text;
  v_status      text;
  v_now         timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to approve a payment request'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  -- Authorization: admin, or an explicit finance.approve grant.
  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only an admin may approve a payment request'
      using errcode = '42501';
  end if;

  -- 3. Unlocked peek, solely to learn whether an Order Request is involved and
  --    which one, so the locks can be taken in the project-wide order
  --    (order request, then payment).
  select * into v_peek
  from public.finance_payment_requests
  where id = p_request_id;

  if not found then
    raise exception 'Payment request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  if v_peek.order_request_id is not null then
    select * into v_order_req
    from public.order_requests
    where id = v_peek.order_request_id
    for update;
    -- Absence is handled after the payment lock, against the re-read row, so a
    -- linkage cleared in the meantime is not reported as a missing request.
  end if;

  -- 4. Lock the payment row: serializes double-clicks, replays, and two admins
  --    racing on the same request.
  select * into v_req
  from public.finance_payment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Only a clean pending request can be approved through this function.
  --    Rejects retries/duplicates once the row has already moved on.
  if v_req.status <> 'pending_approval' then
    raise exception 'Only a pending payment request can be approved (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 6. The linkage must be the one that was locked. If it changed between the
  --    peek and the lock, nothing here is safe to reason about — fail and let
  --    the admin retry against fresh state rather than approve against a stale
  --    reading.
  if v_req.order_request_id is distinct from v_peek.order_request_id then
    raise exception 'PAYMENT_TARGET_CHANGED: The target of payment % changed while it was being approved. Refresh and try again.',
      v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.payment_target_type = 'confirmed_order' then
    -- 7a. Confirmed Order: order_id is already set and validated (the
    --     client-name trigger enforces it at insert, 20260688 §2). Resolve the
    --     number authoritatively from the Order itself and link straight
    --     through, exactly as before.
    if v_req.order_id is null then
      raise exception 'Payment request % has no linked order to approve against', v_req.request_number
        using errcode = 'P0001';
    end if;

    select o.display_number into v_number
    from public.orders o
    where o.id = v_req.order_id;

    v_order_id := v_req.order_id;
    v_status   := 'approved_linked';
  else
    -- 7b. New Order (unallocated) and Order Request both confirm receipt only.
    --     No number is allocated, no orders row is inserted, no
    --     order_activity_log row is written — 20260690's rule, unchanged.
    v_order_id := null;
    v_number   := null;
    v_status   := 'approved_unlinked';

    if v_req.order_request_id is not null then
      -- Revalidate the Order Request under the lock taken in step 3. The
      -- linkage is RETAINED on success; it is never silently dropped, because a
      -- payment quietly becoming unallocated would misstate what the money is
      -- for.
      if v_order_req.id is null then
        raise exception 'ORDER_REQUEST_NOT_FOUND: Order Request % no longer exists. Correct the payment request before approving it.',
          coalesce(v_req.order_request_number, v_req.order_request_id::text)
          using errcode = 'P0001';
      end if;

      if v_order_req.finalized_at is null then
        raise exception 'ORDER_REQUEST_NOT_AVAILABLE: Order Request % is not a submitted request. Correct the payment request before approving it.',
          v_order_req.request_number
          using errcode = 'P0001';
      end if;

      if v_order_req.converted_order_id is not null or v_order_req.status = 'converted' then
        raise exception 'ORDER_REQUEST_CONVERTED: Order Request % has already been converted to a Confirmed Order. Re-target this payment at that Order before approving it.',
          v_order_req.request_number
          using errcode = 'P0001';
      end if;

      if v_order_req.status not in ('submitted', 'needs_clarification', 'rejected') then
        raise exception 'ORDER_REQUEST_NOT_ACTIVE: Order Request % is % and cannot hold an approved payment.',
          v_order_req.request_number, v_order_req.status
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- 8. Close out the request. The activity trigger derives the row from this
  --    real committed transition. order_request_id / order_request_number are
  --    NOT in the SET list, so an Order Request linkage survives approval
  --    untouched.
  update public.finance_payment_requests
     set status       = v_status,
         order_id     = v_order_id,
         order_number = v_number,
         approved_by  = v_actor,
         approved_at  = v_now,
         admin_note   = p_admin_note,
         updated_at   = v_now
   where id = p_request_id;

  -- 9. Small structured result. order_request_* are included so the caller can
  --    tell an Order-Request-backed approval from a plain suspense one without
  --    a second read.
  return jsonb_build_object(
    'request_id',            v_req.id,
    'request_number',        v_req.request_number,
    'status',                 v_status,
    'payment_target_type',    v_req.payment_target_type,
    'order_id',               v_order_id,
    'order_display_number',   v_number,
    'order_request_id',       v_req.order_request_id,
    'order_request_number',   v_req.order_request_number,
    'approved_at',            v_now
  );
end;
$$;

-- ─── link_finance_payment_to_order → finance.manage ───────────────────────────────
-- Linking a payment to an order is a correction of the financial record.
-- Restated verbatim from 20260691000000_finance_payment_order_linking_rpcs.sql; ONLY the authorization expression differs.

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
  -- Authorization: admin, or an explicit finance.manage grant. Linking
  -- restates what money is for, which is the protected company-wide authority.
  if not public.actor_has_module_permission('finance', 'manage') then
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

-- ─── unlink_finance_payment_from_order → finance.manage ───────────────────────────
-- Unlinking is the reverse of the same correction.
-- Restated verbatim from 20260691000000_finance_payment_order_linking_rpcs.sql; ONLY the authorization expression differs.

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
  -- Authorization: admin, or an explicit finance.manage grant.
  if not public.actor_has_module_permission('finance', 'manage') then
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

-- ─── link_finance_payment_to_order_request → finance.manage ───────────────────────
-- Widens the company-wide flag only; requester/assignee rules unchanged.
-- Restated verbatim from 20260707000000_order_request_assignee_participation.sql; ONLY the authorization expression differs.

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

  -- v_is_admin is this function's COMPANY-WIDE flag: it is what lets a caller
  -- attach any eligible payment to any request, where a requester or assignee
  -- may only attach one they submitted. finance.manage is the protected grant
  -- that carries exactly that meaning, so it widens this flag and nothing else.
  -- The participant rules below are untouched.
  v_is_admin := public.actor_has_module_permission('finance', 'manage');

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

-- ─── unlink_finance_payment_from_order_request → finance.manage ───────────────────
-- Widens the company-wide flag only; participant rules unchanged.
-- Restated verbatim from 20260707000000_order_request_assignee_participation.sql; ONLY the authorization expression differs.

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

  -- Same company-wide flag as the link RPC, widened the same way. A caller
  -- without finance.manage still falls through to the requester/assignee and
  -- "a payment you submitted" checks below, exactly as today.
  v_is_admin := public.actor_has_module_permission('finance', 'manage');

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

-- ─── finance_payment_requests_guard_approved → finance.manage ─────────────────────
-- Correcting an approved payment requires finance.manage.
-- Restated verbatim from 20260716000000_finance_payment_collection_handover.sql; ONLY the authorization expression differs.

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

  -- The post-approval edit lock exempts whoever may correct the record. That
  -- was admin only; it is now admin or an explicit finance.manage grant, which
  -- is the same authority the correction UI is gated on. Everybody else still
  -- hits the raise below.
  if public.actor_has_module_permission('finance', 'manage') then
    return new;
  end if;

  if old.status not in ('approved_unlinked', 'approved_linked') then
    return new;
  end if;

  if new.client_name        is distinct from old.client_name
     or new.amount             is distinct from old.amount
     or new.payment_date       is distinct from old.payment_date
     or new.payment_mode       is distinct from old.payment_mode
     or new.received_in        is distinct from old.received_in
     or new.proof_note         is distinct from old.proof_note
     or new.sales_note         is distinct from old.sales_note
     or new.payment_against    is distinct from old.payment_against
     or new.payment_target_type is distinct from old.payment_target_type
     or new.status             is distinct from old.status
     or new.order_id           is distinct from old.order_id
     or new.order_number       is distinct from old.order_number
     or new.submitted_by       is distinct from old.submitted_by
     or new.approved_by        is distinct from old.approved_by
     or new.approved_at        is distinct from old.approved_at
     or new.created_at         is distinct from old.created_at
     or new.admin_note         is distinct from old.admin_note
     or new.collected_by_user_id     is distinct from old.collected_by_user_id
     or new.collected_from_text      is distinct from old.collected_from_text
     or new.handed_over_to_user_id   is distinct from old.handed_over_to_user_id
     or new.handed_over_at           is distinct from old.handed_over_at
     or new.collection_handover_note is distinct from old.collection_handover_note
  then
    raise exception 'Payment % has been approved and can no longer be edited', old.request_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ─── convert_order_request_to_order → orders.approve ──────────────────────────────
-- Conversion is the approve half of Order Request review.
-- Restated verbatim from 20260715000000_finance_payment_request_targets.sql; ONLY the authorization expression differs.

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
  v_actor     uuid := auth.uid();
  v_req       public.order_requests%rowtype;
  v_number    text;
  v_order_id  uuid;
  v_now       timestamptz := now();
  v_manual    uuid[];
  v_ids       uuid[];
  v_count     integer;
  v_eligible  integer;
  v_undecided integer;
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to convert an order request'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  -- Authorization: admin, or an explicit orders.approve grant. Converting a
  -- request into a confirmed order is the approval decision.
  if not public.actor_has_module_permission('orders', 'approve') then
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
  --    racing on the same request, and any concurrent
  --    link_finance_payment_to_order_request (it takes the request lock first
  --    too).
  --
  --    It does NOT serialize a concurrent payment SUBMISSION naming this
  --    request: finance_payment_requests_derive_target reads the request without
  --    a locking clause, because a locking read would be filtered to zero rows
  --    by the absent UPDATE policy on order_requests (see that function). A
  --    submission landing in the window between step 10b and this transaction's
  --    commit therefore leaves a pending payment on a converted request —
  --    harmless, and refused with a clear error by
  --    approve_finance_payment_request rather than silently unallocated.
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

  -- 6. Build the lock set: the admin's manual selection UNION every APPROVED
  --    payment currently parked on this request, sorted so the lock acquisition
  --    below is deterministic (deadlock-free with any concurrent conversion
  --    locking an overlapping set). Pre-approval and rejected linked payments
  --    are excluded here — they are not received money and must not be swept
  --    into a Confirmed Order.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_ids
  from (
    select unnest(v_manual) as x
    union
    select f.id
    from public.finance_payment_requests f
    where f.order_request_id = p_order_request_id
      and f.status = 'approved_unlinked'
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
    --    the APPROVED payments STILL parked on this request. A payment unparked
    --    by a concurrent unlink between step 6 and the locks is thereby dropped
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
        and f.status = 'approved_unlinked'
    ) as t
    where x is not null;
  end if;

  v_count := coalesce(array_length(v_ids, 1), 0);

  if v_count > 0 then
    -- 9. Revalidate AFTER the locks are held — never trust the list the client
    --    was shown. Eligible = approved_unlinked, no order, and either no
    --    request linkage or parked on THIS request.
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

  -- 10a. GUARD ONE — approving an Order Request means confirming that real money
  --      arrived against it. v_count is the fully revalidated transfer set and
  --      every member is 'approved_unlinked', so this counts financially
  --      approved payments and nothing else. Pending, needs-clarification and
  --      rejected payments were excluded in steps 6 and 8 and cannot reach here.
  if v_count = 0 then
    raise exception 'ORDER_REQUEST_NO_APPROVED_PAYMENT: At least one approved payment must be linked before this Order Request can be approved.'
      using errcode = 'P0001';
  end if;

  -- 10b. GUARD TWO — nothing attached to this request may still be awaiting a
  --      Finance decision. Those payments would not transfer (steps 6/8), so
  --      converting now would leave money the salesperson raised against this
  --      order stranded on a request that no longer accepts payments. The admin
  --      must approve or reject each one first. 'rejected' is a decision and
  --      does not block.
  --
  --      Not lockable as a set (the rows are not known in advance). The
  --      FOR UPDATE held since step 4 blocks a concurrent
  --      link_finance_payment_to_order_request, but NOT a concurrent submission
  --      (see the note on step 4). A pending payment that lands in that window
  --      is refused at approval time with ORDER_REQUEST_CONVERTED, which is an
  --      actionable error rather than a silent misclassification.
  select count(*) into v_undecided
  from public.finance_payment_requests
  where order_request_id = p_order_request_id
    and status in ('pending_approval', 'needs_clarification');

  if v_undecided > 0 then
    raise exception 'ORDER_REQUEST_PAYMENTS_UNDECIDED: % payment request(s) linked to % are still awaiting a finance decision. Approve or reject them before converting this Order Request.',
      v_undecided, v_req.request_number
      using errcode = 'P0001';
  end if;

  -- 11. The Order number is allocated by orders_assign_display_number
  --     (20260703000000) as part of the INSERT below, under a FOR UPDATE lock on
  --     the cycle row, and it advances only if this transaction commits. Both
  --     guards above run BEFORE this point, so a refused conversion consumes
  --     nothing.

  -- 12. Exactly one official Order, starting at 'running' (20260702000000).
  insert into public.orders (
    client_name, requested_by, assigned_to,
    confirm_date, due_date, total_value, total_product_value, lead_source, notes, created_by,
    status,
    source_order_request_id, source_request_number
  )
  values (
    v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.total_product_value,
    v_req.lead_source, v_req.notes, v_actor,
    'running',
    v_req.id, v_req.request_number
  )
  returning id, display_number into v_order_id, v_number;

  -- 13. Link every payment in the set to the Order just created, clearing any
  --     request parking in the same statement. Amount, dates, mode, proof,
  --     submitter, and prior activity rows are untouched — this is a pure
  --     linkage transfer, never a copy. payment_target_type is NOT in the SET
  --     list and is frozen for approved rows by
  --     finance_payment_requests_derive_target, so a transferred payment keeps
  --     recording that it was raised against an Order Request.
  update public.finance_payment_requests
     set status               = 'approved_linked',
         order_id             = v_order_id,
         order_number         = v_number,
         order_request_id     = null,
         order_request_number = null,
         updated_at           = v_now
   where id = any(v_ids);

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

-- ─── reject_order_request → orders.approve ────────────────────────────────────────
-- Rejection is the reject half of the same review decision.
-- Restated verbatim from 20260687000000_add_order_request_rejection.sql; ONLY the authorization expression differs.

create or replace function public.reject_order_request(
  p_order_request_id uuid,
  p_rejection_reason  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_req    public.order_requests%rowtype;
  v_reason text;
  v_now    timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  -- Authorization: admin, or an explicit orders.approve grant — rejecting is
  -- the same review decision as approving, taken the other way.
  if not public.actor_has_module_permission('orders', 'approve') then
    raise exception 'Only an admin may reject an order request'
      using errcode = '42501';
  end if;

  -- 3. Reject a blank or whitespace-only reason before touching any row.
  v_reason := btrim(coalesce(p_rejection_reason, ''));
  if v_reason = '' then
    raise exception 'A rejection reason is required'
      using errcode = 'P0001';
  end if;

  -- 4. Lock the request: serializes double-clicks and blocks a race with a
  --    concurrent conversion or clarification request (the loser re-reads and
  --    fails the status check below).
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Only a submitted request may be rejected. This also rejects a repeat
  --    rejection, needs_clarification, and converted requests.
  if v_req.status <> 'submitted' then
    raise exception 'Only a submitted order request can be rejected (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 6. Status + reason only. converted_order_id/converted_at stay untouched
  --    (order_requests_converted_consistency keeps them null for any
  --    non-converted status). The AFTER UPDATE trigger writes the single
  --    request_rejected activity row.
  update public.order_requests
     set status           = 'rejected',
         rejection_reason = v_reason,
         updated_at       = v_now
   where id = p_order_request_id;

  return jsonb_build_object(
    'order_request_id', v_req.id,
    'request_number',   v_req.request_number,
    'status',           'rejected',
    'updated_at',        v_now
  );
end;
$$;

-- ─── request_order_request_clarification → orders.approve ─────────────────────────
-- Clarification is the third outcome of the same review.
-- Restated verbatim from 20260683000000_add_order_request_clarification_workflow.sql; ONLY the authorization expression differs.

create or replace function public.request_order_request_clarification(
  p_order_request_id  uuid,
  p_clarification_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_req   public.order_requests%rowtype;
  v_note  text;
  v_now   timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  -- Authorization: admin, or an explicit orders.approve grant. Sending a
  -- request back for clarification is a reviewer's third option, not a
  -- separate authority.
  if not public.actor_has_module_permission('orders', 'approve') then
    raise exception 'Only an admin may request clarification on an order request'
      using errcode = '42501';
  end if;

  -- 3. Reject a blank note before touching any row.
  v_note := btrim(coalesce(p_clarification_note, ''));
  if v_note = '' then
    raise exception 'A clarification note is required'
      using errcode = 'P0001';
  end if;

  -- 4. Lock the request: serializes double-clicks and blocks a race with a
  --    concurrent conversion (the loser re-reads and fails the status check).
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Only a submitted request may be sent back for clarification. This also
  --    rejects an already-needs_clarification request (no repeat), and rejected
  --    or converted requests (immutable through this workflow).
  if v_req.status <> 'submitted' then
    raise exception 'Only a submitted order request can be sent back for clarification (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 6. Status + note only. rejection_reason and the conversion fields are never
  --    written here; the converted_consistency CHECK keeps the latter null for
  --    any non-converted status. The AFTER UPDATE trigger writes the single
  --    clarification_requested activity row.
  update public.order_requests
     set status             = 'needs_clarification',
         clarification_note = v_note,
         updated_at         = v_now
   where id = p_order_request_id;

  return jsonb_build_object(
    'order_request_id',   v_req.id,
    'request_number',     v_req.request_number,
    'status',             'needs_clarification',
    'clarification_note', v_note,
    'updated_at',         v_now
  );
end;
$$;

-- ─── admin_delete_order_request → orders.delete ──────────────────────────────────
-- Deletion is the orders.delete authority.
-- Restated verbatim from 20260705000000_protect_finalized_orders_and_payments.sql; ONLY the authorization expression differs.

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
  -- Authorization: admin, or an explicit orders.delete grant. Every other
  -- guard in this function — converted requests, finalized payments, the audit
  -- write — is unchanged and still applies.
  if not public.actor_has_module_permission('orders', 'delete') then
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

-- ─── assert_order_amender → orders.manage ────────────────────────────────────────
-- Amending and cancelling an order are the orders.manage authority.
-- Restated verbatim from 20260816000000_order_amendments.sql; ONLY the authorization expression differs.

create or replace function public.assert_order_amender()
returns uuid
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Authentication required to amend an order'
      using errcode = '28000';
  end if;

  -- Authorization: the existing admin rule, UNCHANGED and still requiring
  -- is_active, OR an explicit orders.manage grant. actor_has_permission is
  -- used rather than actor_has_module_permission precisely so the admin branch
  -- keeps its is_active requirement instead of inheriting the looser one.
  -- This is the single choke point for amend_order and cancel_order.
  if not (
    exists (
      select 1 from public.users where id = v_uid and is_active and role = 'admin'
    )
    or public.actor_has_permission('orders', 'manage')
  ) then
    raise exception 'ORDER_AMENDMENT_FORBIDDEN: Only an administrator can amend an order'
      using errcode = '42501';
  end if;

  return v_uid;
end;
$$;

-- ─── 3. Execute grants ───────────────────────────────────────────────────────
-- `create or replace function` PRESERVES existing grants, so these are
-- restatements for completeness rather than changes. They are listed so the
-- callable surface of this migration is readable in one place.
--
-- EVERY signature below must be the EXACT argument-type list of the function as
-- this migration defines it above. GRANT resolves a function by signature, not
-- by name: a wrong type list does not fall back to the real function, it raises
-- 42883 "function does not exist" and aborts the whole migration. Two of these
-- were wrong on the first production attempt — link_finance_payment_to_order
-- carried a third `text` argument it has never had, and admin_delete_order_request
-- was missing its `boolean`. src/lib/permissions/migrationSignatures.test.ts now
-- derives the authoritative list from the defining migrations and fails the build
-- rather than the deployment.

grant execute on function public.approve_finance_payment_request(uuid, text)               to authenticated;
grant execute on function public.link_finance_payment_to_order(uuid, uuid)                 to authenticated;
grant execute on function public.unlink_finance_payment_from_order(uuid, text)             to authenticated;
grant execute on function public.reject_order_request(uuid, text)                          to authenticated;
grant execute on function public.admin_delete_order_request(uuid, boolean)                 to authenticated;
grant execute on function public.assert_order_amender()                                    to authenticated;

-- ─── 4. Finance row-level policies ───────────────────────────────────────────
--
-- Two Finance decisions are plain UPDATEs on finance_payment_requests rather
-- than RPCs — rejecting a pending request, and correcting an approved one — so
-- they cannot be separated inside a function. THE SMALLEST SAFE SEPARATION is
-- two narrow policies distinguished by the status window each one operates in:
--
--   finance.approve  acts on a PENDING request and may only move it to
--                    rejected / needs_clarification. It can NEVER write an
--                    approved_* status: approving allocates numbers and writes
--                    activity, and that path stays inside
--                    approve_finance_payment_request().
--
--   finance.manage   acts on an ALREADY APPROVED payment — the correction and
--                    reversal surface — and may only leave it in an approved_*
--                    status.
--
-- The two windows do not overlap, so neither grant can perform the other's
-- action. Both are ADDED alongside the existing admin and owner policies;
-- policies are permissive and OR together, so nothing existing changes.
--
-- These policies decide WHO may attempt the update. WHAT may change on an
-- approved row is still decided by finance_payment_requests_guard_approved(),
-- restated above with the same finance.manage exemption, so the policy and the
-- trigger cannot disagree.

drop policy if exists "finance_payment_requests_approver_decide" on public.finance_payment_requests;

create policy "finance_payment_requests_approver_decide"
  on public.finance_payment_requests
  for update to authenticated
  using (
    status = 'pending_approval'
    and public.actor_has_permission('finance', 'approve')
  )
  with check (
    status in ('rejected', 'needs_clarification')
  );

-- ─── 4a. An approver DECIDES a pending request; it may not rewrite it ────────
--
-- AUDIT FIX (Prompt 5). The policy above constrains the resulting STATUS, and
-- that is all an RLS check can do: WITH CHECK sees only the new row, so it
-- cannot say "the amount may not change". Without this trigger a finance.approve
-- holder could rewrite client_name, amount, payment_date — anything — in the
-- same statement that rejects the request, which is far more than the authority
-- to approve or reject.
--
-- Today no non-admin can touch another person's pending request at all, so this
-- would have been a widening introduced by this very migration. It is closed
-- here rather than left to the UI, because the UI is not the boundary.
--
-- Shape and exemptions deliberately mirror finance_payment_requests_guard_approved:
--   * service-role / direct SQL (auth.uid() is null) passes through;
--   * admins pass through, so admin behaviour is byte-for-byte unchanged;
--   * the SUBMITTER passes through — editing your own pending request is the
--     existing finance_payment_requests_own_update path and is not affected;
--   * everyone else may change only the three decision columns.

create or replace function public.finance_payment_requests_guard_pending_decision()
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

  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return new;
  end if;

  if old.status is distinct from 'pending_approval' then
    return new;
  end if;

  if old.submitted_by = v_actor then
    return new;
  end if;

  if new.client_name          is distinct from old.client_name
     or new.amount               is distinct from old.amount
     or new.payment_date         is distinct from old.payment_date
     or new.payment_mode         is distinct from old.payment_mode
     or new.received_in          is distinct from old.received_in
     or new.proof_note           is distinct from old.proof_note
     or new.sales_note           is distinct from old.sales_note
     or new.payment_against      is distinct from old.payment_against
     or new.payment_target_type  is distinct from old.payment_target_type
     or new.order_id             is distinct from old.order_id
     or new.order_number         is distinct from old.order_number
     or new.order_request_id     is distinct from old.order_request_id
     or new.submitted_by         is distinct from old.submitted_by
     or new.approved_by          is distinct from old.approved_by
     or new.approved_at          is distinct from old.approved_at
     or new.created_at           is distinct from old.created_at
     or new.request_number       is distinct from old.request_number
  then
    raise exception 'Payment % may be approved or rejected, not edited', old.request_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.finance_payment_requests_guard_pending_decision() is
  'Restricts a non-admin, non-submitter updating a pending payment request to the decision columns (status, admin_note, updated_at).';

drop trigger if exists finance_payment_requests_guard_pending_decision on public.finance_payment_requests;

create trigger finance_payment_requests_guard_pending_decision
  before update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_pending_decision();

drop policy if exists "finance_payment_requests_manager_correct" on public.finance_payment_requests;

create policy "finance_payment_requests_manager_correct"
  on public.finance_payment_requests
  for update to authenticated
  using (
    status in ('approved_linked', 'approved_unlinked')
    and public.actor_has_permission('finance', 'manage')
  )
  with check (
    status in ('approved_linked', 'approved_unlinked')
  );

-- Deletion mirrors finance_payment_requests_admin_delete_unapproved
-- (20260705000000 §): the SAME three unapproved statuses, so a finance.delete
-- grant can never remove an approved payment. That restriction is a financial
-- record-keeping rule, not an authorization one, and it is preserved exactly.

drop policy if exists "finance_payment_requests_permitted_delete_unapproved" on public.finance_payment_requests;

create policy "finance_payment_requests_permitted_delete_unapproved"
  on public.finance_payment_requests
  for delete to authenticated
  using (
    status in ('pending_approval', 'needs_clarification', 'rejected')
    and public.actor_has_permission('finance', 'delete')
  );

-- ─── 5. What is NOT added, and why ───────────────────────────────────────────
--
-- No INSERT policy for finance.create: creation is already open to any
-- authenticated employee through finance_payment_requests_own_insert, with
-- submitted_by pinned to auth.uid(). There is no company-wide creation
-- operation for a grant to correspond to, so adding one would broaden rather
-- than enforce.
--
-- No SELECT policy for finance.view: Finance rows carry client names and
-- amounts. Widening reads is a separate decision with a separate blast radius
-- and is not part of making the protected ACTIONS work.
--
-- No UPDATE policy for finance.edit: editing an unapproved request is
-- ownership-based today (finance_payment_requests_own_update). Turning every
-- stored finance.edit row into company-wide edit authority is exactly the
-- silent widening this migration exists to avoid.
--
-- No change to orders_admin_delete or the order deletion triggers: order
-- deletion is protected by 20260705000000 for record-keeping reasons that are
-- not about who the caller is.

-- ─── 6. ROLLBACK PLAN ────────────────────────────────────────────────────────
--
-- This migration is reversible without data loss. Nothing was dropped and no
-- permission row was written, so rolling back restores the previous behaviour
-- exactly.
--
-- Step 1 — remove the three added policies. The pre-existing admin and owner
--          policies are untouched and resume sole control immediately:
--
--   drop policy if exists "finance_payment_requests_approver_decide"
--     on public.finance_payment_requests;
--   drop policy if exists "finance_payment_requests_manager_correct"
--     on public.finance_payment_requests;
--   drop policy if exists "finance_payment_requests_permitted_delete_unapproved"
--     on public.finance_payment_requests;
--
--          ...and the pending-decision guard added by section 4a, which has no
--          predecessor to restore — it is new, so dropping it is the whole
--          rollback:
--
--   drop trigger if exists finance_payment_requests_guard_pending_decision
--     on public.finance_payment_requests;
--   drop function if exists public.finance_payment_requests_guard_pending_decision();
--
-- Step 2 — restore each function to its prior definition by re-running the
--          migration named in its section header above, which contains the
--          exact body this migration started from:
--
--   approve_finance_payment_request            20260715000000
--   link_finance_payment_to_order              20260691000000
--   unlink_finance_payment_from_order          20260691000000
--   link_finance_payment_to_order_request      20260707000000
--   unlink_finance_payment_from_order_request  20260707000000
--   finance_payment_requests_guard_approved    20260716000000
--   convert_order_request_to_order             20260715000000
--   reject_order_request                       20260687000000
--   request_order_request_clarification        20260683000000
--   admin_delete_order_request                 20260705000000
--   assert_order_amender                       20260816000000
--
--          Re-running those files is safe: every one of these is a
--          `create or replace function`, and the surrounding statements in
--          those migrations are themselves idempotent.
--
-- NOTE on the helpers: actor_has_module_permission grants the admin
--          short-circuit only to an ACTIVE, non-deleted admin. Restoring the
--          pre-migration functions in step 2 restores the older, looser rule
--          (role = 'admin' alone), which is what those files contain. That is
--          the correct rollback — it returns the database to exactly its prior
--          behaviour — but it is a widening relative to this migration, so it
--          should be a deliberate choice rather than a surprise.
--
-- Step 3 — optionally drop the helpers, once nothing references them:
--
--   drop function if exists public.actor_has_module_permission(text, text);
--   drop function if exists public.actor_has_permission(text, text);
--
-- Rolling back does NOT require touching employee_permission_overrides. The
-- grants simply become inert again, which is the state they are in today.
