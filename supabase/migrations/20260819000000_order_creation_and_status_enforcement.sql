-- Orders — creation goes through conversion only, and the status graph becomes
-- a database rule.
--
-- Two findings from the review of 20260816/17/18, both recorded there as open
-- (D7 and R2) because each changes a different blast radius and deserved its
-- own migration.
--
-- ── D7: an authenticated user could create a Confirmed Order outright ────────
--
-- `orders_sales_insert` (20260655) permits INSERT where
-- `requested_by = auth.uid()`, and `authenticated` holds the table INSERT
-- grant. Together they let any signed-in user POST a row straight into
-- public.orders — bypassing the Order Request → review → conversion path
-- entirely, and burning a real number out of the display-number cycle on the
-- way, because orders_assign_display_number fires on INSERT regardless of who
-- issued it.
--
-- The policy is vestigial. It was written when sales inserted their own rows at
-- status 'requested', a status 20260702000000 retired; conversion has been the
-- only legitimate birth of an Order ever since. Verified before writing this:
-- no client code anywhere inserts into public.orders (the single client write
-- to the table is `.update({ status })` in src/app/orders/[id]/page.tsx), and
-- convert_order_request_to_order is SECURITY DEFINER owned by `postgres`, so it
-- keeps working when the client privilege goes.
--
-- ── R2: the status graph lived only in the browser ───────────────────────────
--
-- TRANSITION_GRAPH and allowedTransitions() are in
-- src/app/orders/[id]/page.tsx. The database accepted any value the CHECK
-- allowed, from anyone RLS let update the row — so `dispatched → running`, or
-- a salesperson cancelling an order, were refused by the UI and accepted by
-- PostgREST. 20260818 narrowed WHICH COLUMNS a client may write; it said
-- nothing about which VALUES, and `status` is deliberately the one column left
-- writable.
--
-- Cancellation is the sharp edge. cancel_order() requires a reason and records
-- the money received; a plain `.update({ status: 'cancelled' })` by an admin —
-- who does hold UPDATE (status) — bypassed both. §3 closes that: the value
-- 'cancelled' is reachable only from inside cancel_order_with_audit().
--
-- Scope: one policy dropped, one privilege revoked, two functions, one trigger.
-- No table, no column, no row. Nothing outside Orders is touched, and nothing
-- about the Assets permanent-delete work (20260803000000) is read or changed.

-- ── 1. D7 — no client role may create an Order ───────────────────────────────

drop policy if exists "orders_sales_insert" on public.orders;

revoke insert on public.orders from authenticated, anon;

-- `orders_admin_insert` is deliberately LEFT IN PLACE. With the privilege gone
-- it cannot be satisfied by any client, so it grants nothing today — but it is
-- correct as written, and keeping it means restoring a deliberate admin escape
-- hatch later is a one-line GRANT rather than a rediscovered policy. The
-- privilege is the control; the policy is documentation of intent.

comment on table public.orders is
  'Confirmed Orders. Created ONLY by convert_order_request_to_order() (20260819000000) — no client role holds INSERT. Client roles hold UPDATE on the `status` column only (20260818000000), and status VALUES are constrained by orders_enforce_status_transition. Every other column moves exclusively through amend_order() / approve_order_change_request(). No client role holds DELETE or TRUNCATE — a Confirmed Order is permanent business history.';

-- ── 2. The cancellation context ──────────────────────────────────────────────
--
-- Same idiom and the same limits as in_order_amendment() (20260816000000 §1),
-- and the same honesty about what it is for: this is NOT an authorization
-- check. Authorization for cancelling is assert_order_amender() inside
-- cancel_order(), and the privilege model from 20260818 is what stops anyone
-- writing other columns. This flag exists so the trigger in §4 can tell a
-- cancellation performed through the audited function from a bare status
-- update, which is a distinction no privilege can express.

create or replace function public.in_order_cancellation()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('boe.cancellation_context', true), '') = 'order_cancellation';
$$;

revoke execute on function public.in_order_cancellation() from public, anon, authenticated;

comment on function public.in_order_cancellation() is
  'True only inside cancel_order_with_audit(). Transaction-local; not settable by any client. Read by orders_enforce_status_transition.';

-- ── 3. cancel_order_with_audit opens that context ────────────────────────────
--
-- Replaces the 20260816000000 §5 function. The body is unchanged apart from the
-- two set_config calls bracketing the UPDATE, so the two can be diffed.

create or replace function public.cancel_order_with_audit(
  p_order_id uuid,
  p_actor_id uuid,
  p_reason   text,
  p_source   text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders%rowtype;
  v_received numeric;
begin
  select * into v_order from public.orders where id = p_order_id for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists'
      using errcode = 'P0002';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'ORDER_ALREADY_CANCELLED: Order % is already cancelled', v_order.display_number
      using errcode = '42501';
  end if;

  if v_order.status = 'dispatched' then
    raise exception
      'ORDER_DISPATCHED: Order % has already been dispatched and cannot be cancelled',
      v_order.display_number
      using errcode = '42501';
  end if;

  v_received := public.order_linked_payment_total(p_order_id);

  perform set_config('boe.cancellation_context', 'order_cancellation', true);
  update public.orders set status = 'cancelled' where id = p_order_id;
  perform set_config('boe.cancellation_context', '', true);

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    p_order_id, p_actor_id, 'status_changed',
    jsonb_build_object(
      'from', v_order.status, 'to', 'cancelled',
      'reason', p_reason, 'source', p_source, 'request_id', p_request_id,
      -- Recorded even when zero. "No money had been received" is itself a fact
      -- worth being able to prove later.
      'received_at_cancellation', v_received
    )
  );

  return jsonb_build_object(
    'order_id',       p_order_id,
    'display_number', v_order.display_number,
    'received_at_cancellation', v_received
  );
end;
$$;

revoke execute on function public.cancel_order_with_audit(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;

-- ── 4. The status graph, in the database ─────────────────────────────────────
--
-- Deliberately mirrors TRANSITION_GRAPH in src/app/orders/[id]/page.tsx
-- EXACTLY, including what it does not allow. `ready_for_dispatch → running` has
-- been discussed as a desirable reversal, but the UI does not offer it today
-- and adding it here alone would create a transition nothing can reach — so the
-- two stay in step and the reversal is left as a deliberate, separate change to
-- both.
--
-- Three gates, in order of how specific they are:
--
--   graph   — is this transition legal at all? Applies to EVERY caller,
--             including the service role and direct SQL. dispatched and
--             cancelled are terminal, which is what makes "a cancelled order
--             can never be dispatched" a database invariant rather than a
--             convention.
--   path    — 'cancelled' only from inside cancel_order_with_audit().
--   role    — admin: any legal transition. operations: the three operational
--             ones. Everyone else: none.
--
-- The role gate is skipped when auth.uid() is null, which is the service role
-- and direct psql. That is intentional and is the same boundary the rest of
-- this module draws: a session with no identity has no role to check, and the
-- graph gate above still applies to it. It is not a bypass for any client —
-- PostgREST always carries an identity.

create or replace function public.orders_enforce_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_role    text;
  v_team    text;
  v_allowed text[];
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'running'            then array['on_hold', 'ready_for_dispatch', 'cancelled']
    when 'on_hold'            then array['running', 'cancelled']
    when 'ready_for_dispatch' then array['dispatched', 'cancelled']
    else array[]::text[]      -- dispatched and cancelled are terminal
  end;

  if not (new.status = any (v_allowed)) then
    raise exception
      'ORDER_STATUS_TRANSITION_INVALID: Order % cannot move from % to %',
      old.display_number, old.status, new.status
      using errcode = '42501';
  end if;

  if new.status = 'cancelled' and not public.in_order_cancellation() then
    raise exception
      'ORDER_CANCEL_PATH_REQUIRED: Order % can only be cancelled through cancel_order(), which records a reason and the money received against it',
      old.display_number
      using errcode = '42501';
  end if;

  if v_uid is not null then
    select u.role::text, u.team into v_role, v_team
      from public.users u where u.id = v_uid;

    if v_role is distinct from 'admin' then
      if v_team = 'operations' then
        if not (new.status = any (array['running', 'on_hold', 'ready_for_dispatch'])) then
          raise exception
            'ORDER_STATUS_FORBIDDEN: Operations cannot move Order % to %',
            old.display_number, new.status
            using errcode = '42501';
        end if;
      else
        raise exception
          'ORDER_STATUS_FORBIDDEN: You cannot change the status of Order %',
          old.display_number
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.orders_enforce_status_transition() from public, anon, authenticated;

drop trigger if exists orders_enforce_status_transition on public.orders;

-- Fires after orders_guard_amendable_columns (alphabetical order among BEFORE
-- triggers: orders_enforce_* < orders_guard_*, so this one actually runs
-- first). Order between them does not matter — they guard disjoint concerns,
-- and either raising aborts the statement.
create trigger orders_enforce_status_transition
  before update on public.orders
  for each row execute function public.orders_enforce_status_transition();

-- ── 5. What this migration deliberately does NOT do ──────────────────────────
--
--   * No dispatch validation. Moving to 'dispatched' still requires no invoice,
--     no e-way bill, no transporter and no addresses. That gate is specified in
--     docs/Module Docs/FINANCE_ORDER_WORKFLOW.md §4.2 and is a phase of its
--     own; half a dispatch gate is worse than none.
--   * No `ready_for_dispatch → running` reversal — see §4.
--   * No change to convert_order_request_to_order, to the approved-payment
--     conversion prerequisite, or to Order numbering.
--   * Nothing about the Assets permanent-delete work (20260803000000), which is
--     a separate workstream with its own open findings.
