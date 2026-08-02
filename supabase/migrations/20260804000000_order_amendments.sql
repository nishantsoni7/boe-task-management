-- Orders — amending a Confirmed Order, and asking to amend one.
--
-- The hole this closes
-- --------------------
-- A Confirmed Order is born at conversion (20260702) and, from that moment, the
-- application can change exactly one thing about it: `status`. There is no path
-- — for anyone, including an admin — to correct the order value, the client
-- name, the confirm/due dates, the lead source or the assignment. Real orders
-- do change: the client adds an item, a discount is agreed, a date slips. Today
-- the only way to record that is direct SQL against production, which leaves no
-- actor, no reason and no audit trail.
--
-- Two doors, because two different people need one:
--
--   amend_order()                  admin, direct. The correction happens now.
--   order_change_requests + the    everyone else. They propose; an admin
--   approve/reject pair            approves; approval is what applies it.
--
-- Both doors funnel into ONE apply function, so an amendment is audited
-- identically no matter who initiated it, and there is a single place where the
-- rules about what may change can be got wrong.
--
-- The guard is the other half
-- ---------------------------
-- Opening a door is only safe once the wall exists. It did not:
-- `orders_operations_update` (20260655) grants UPDATE on public.orders to every
-- operations-team member with no column restriction at all. Its own comment
-- says "update status/notes", but the policy permits rewriting total_value,
-- client_name, requested_by — any column on the row. Section 1 makes the
-- comment true. That guard is a fix in its own right and would be worth
-- shipping even if nothing else in this file existed.
--
-- Scope discipline: this migration adds one table, one guard trigger and four
-- functions. It creates no status, no notification, no sequence; it does not
-- touch display_number, provenance, any payment, or the conversion RPC. It
-- writes no row and changes no existing row's data.

-- ── 1. The wall: commercial columns move only through an amendment ────────────
--
-- Why a GUC and not "exempt admins": an amendment must be auditable, and an
-- exemption for a ROLE audits nothing — it would let an admin's ordinary
-- PostgREST PATCH rewrite the order value with no activity row, which is the
-- state this migration exists to end. A GUC is a CONTEXT: it is set only by
-- apply_order_amendment() below, only after that function has validated the
-- actor and only in the same transaction that writes the audit row. It cannot
-- be set from PostgREST, is not carried in a JWT, and set_config(..., true)
-- evaporates at COMMIT or ROLLBACK, so it can never leak into a later
-- statement or another session.
--
-- Same idiom, deliberately, as in_test_data_cleanup() (20260705000000 §1).

create or replace function public.in_order_amendment()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('boe.amendment_context', true), '') = 'order_amendment';
$$;

revoke execute on function public.in_order_amendment() from public, anon, authenticated;

comment on function public.in_order_amendment() is
  'True only inside a transaction that apply_order_amendment() has authorized. Transaction-local; not settable by any client. Read by orders_guard_amendable_columns.';

-- Three tiers of column, and the trigger says which is which:
--
--   frozen      created_by / created_at. Provenance of the record itself.
--               Nothing may change these, amendment context included.
--               (display_number, source_order_request_id and
--               source_request_number already have their own guards, from
--               20260703 and 20260701; they are not re-guarded here.)
--
--   commercial  client_name, requested_by, assigned_to, confirm_date,
--               due_date, total_value, total_product_value, lead_source.
--               These are the terms of the deal. They move ONLY inside an
--               amendment, which means only with an actor and a reason on the
--               activity log.
--
--   operational status, notes. Day-to-day movement, already governed by RLS and
--               by the transition graph in the UI. Untouched by this trigger.
--
-- `is distinct from` throughout, so re-writing a column with the value it
-- already holds is never an error — a client PATCHing the whole row back
-- unchanged still succeeds, and only a real change is refused.

create or replace function public.orders_guard_amendable_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Frozen: no context and no role unlocks these.
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception
      'ORDER_FIELD_FROZEN: The creation record of Order % cannot be changed', old.display_number
      using errcode = '42501';
  end if;

  if public.in_order_amendment() then
    return new;
  end if;

  if new.client_name         is distinct from old.client_name
     or new.requested_by        is distinct from old.requested_by
     or new.assigned_to         is distinct from old.assigned_to
     or new.confirm_date        is distinct from old.confirm_date
     or new.due_date            is distinct from old.due_date
     or new.total_value         is distinct from old.total_value
     or new.total_product_value is distinct from old.total_product_value
     or new.lead_source         is distinct from old.lead_source then
    raise exception
      'ORDER_AMENDMENT_REQUIRED: The terms of Order % can only be changed through an order amendment, which records who changed what and why',
      old.display_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.orders_guard_amendable_columns() from public, anon, authenticated;

drop trigger if exists orders_guard_amendable_columns on public.orders;

create trigger orders_guard_amendable_columns
  before update on public.orders
  for each row execute function public.orders_guard_amendable_columns();

-- ── 2. order_change_requests ──────────────────────────────────────────────────
--
-- Shape follows asset_change_requests (20260724000000): explicit proposed_*
-- columns rather than JSONB — they are the same fields the amend form has, and
-- a typed column is a column the database can constrain — a status CHECK rather
-- than an enum, and authorization in the body of a definer function rather than
-- in an UPDATE policy.
--
-- ON DELETE CASCADE, unlike the assets table's ON DELETE SET NULL: a Confirmed
-- Order is permanent (20260705 §2), so the only path that removes one is Test
-- Data Cleanup, which is removing the whole chain on purpose. There is no
-- surviving order for an orphaned request to document.

create table public.order_change_requests (
  id            uuid        primary key default gen_random_uuid(),

  order_id      uuid        not null references public.orders(id) on delete cascade,
  -- Captured at request time so the request still reads sensibly in a list
  -- without joining orders, and after a test-data chain has been cleaned up.
  order_number_snapshot text not null,

  -- 'cancel' is here rather than in the status graph because cancelling is the
  -- one lifecycle move a salesperson has a legitimate reason to ask for and no
  -- authority to make: allowedTransitions() returns [] for them, and cancelling
  -- an Order with money on it is a decision that needs the person who can see
  -- the money. An 'edit' proposes new terms; a 'cancel' proposes an ending.
  request_type  text        not null check (request_type in ('edit', 'cancel')),

  -- Defaulted from the session and pinned by the INSERT policy's WITH CHECK, so
  -- a request can never be filed in someone else's name.
  requested_by  uuid        not null default auth.uid() references public.users(id),
  reason        text        not null check (btrim(reason) <> ''),

  -- Proposed values for an edit. NULL means "leave this field alone", which is
  -- also why this door can never blank a field — see apply_order_amendment.
  proposed_client_name         text,
  proposed_total_value         numeric(12,2),
  proposed_total_product_value numeric(12,2),
  proposed_confirm_date        date,
  proposed_due_date            date,
  proposed_lead_source         text
                                 check (proposed_lead_source is null or proposed_lead_source in (
                                   'reference', 'repeat_customer', 'whatsapp', 'instagram', 'website'
                                 )),
  proposed_notes               text,

  status        text        not null default 'pending'
                            check (status in ('pending', 'approved', 'rejected')),

  reviewed_by   uuid        references public.users(id),
  reviewed_at   timestamptz,
  review_note   text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A cancellation carries no proposed values; an edit must propose at least
  -- one, or there is nothing for an admin to approve.
  constraint order_change_requests_payload_matches_type check (
    case request_type
      when 'cancel' then
        proposed_client_name is null and proposed_total_value is null
        and proposed_total_product_value is null and proposed_confirm_date is null
        and proposed_due_date is null and proposed_lead_source is null
        and proposed_notes is null
      when 'edit' then
        proposed_client_name is not null or proposed_total_value is not null
        or proposed_total_product_value is not null or proposed_confirm_date is not null
        or proposed_due_date is not null or proposed_lead_source is not null
        or proposed_notes is not null
    end
  ),

  -- Money is never negative. The order-value columns on public.orders carry no
  -- such check, so this is the first place either figure is constrained; the
  -- apply function re-checks it for the admin's direct door too.
  constraint order_change_requests_values_non_negative check (
    (proposed_total_value is null or proposed_total_value >= 0)
    and (proposed_total_product_value is null or proposed_total_product_value >= 0)
  ),

  -- A decision always records who made it and when.
  constraint order_change_requests_review_fields_complete check (
    (status =  'pending' and reviewed_by is null     and reviewed_at is null)
    or
    (status <> 'pending' and reviewed_by is not null and reviewed_at is not null)
  )
);

create index order_change_requests_order_id_idx     on public.order_change_requests (order_id);
create index order_change_requests_requested_by_idx on public.order_change_requests (requested_by);
create index order_change_requests_status_idx       on public.order_change_requests (status);
create index order_change_requests_created_at_idx   on public.order_change_requests (created_at desc);

-- One open request of each type per order per person. Partial, so a reviewed
-- request never blocks the next one, and two people may each have one open.
create unique index order_change_requests_one_pending_idx
  on public.order_change_requests (order_id, requested_by, request_type)
  where status = 'pending';

drop trigger if exists order_change_requests_set_updated_at on public.order_change_requests;
create trigger order_change_requests_set_updated_at
  before update on public.order_change_requests
  for each row execute function public.set_updated_at();

-- ── 3. RLS — order_change_requests ────────────────────────────────────────────
--
-- There is no UPDATE policy and no DELETE policy, for anyone including the
-- admin. That is the point: a client cannot move a request from pending to
-- approved, cannot write reviewed_by/reviewed_at, and cannot erase a decision.
-- Review happens only through the definer functions in section 5.

alter table public.order_change_requests enable row level security;

-- File a request as yourself, pending, with no review fields — and only against
-- an Order you can already see. The EXISTS re-states orders_sales_select's rule
-- rather than relying on it: RLS on public.orders does not constrain what this
-- table's WITH CHECK can reference, so without it any authenticated user could
-- file a request against any order id they guessed.
create policy "order_change_requests_insert_own" on public.order_change_requests
  for insert to authenticated
  with check (
    requested_by = auth.uid()
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and review_note is null
    and exists (
      select 1 from public.users u
       where u.id = auth.uid() and u.is_active
    )
    and exists (
      select 1 from public.orders o
       where o.id = order_change_requests.order_id
         -- Not against an Order that has already finished. Neither a new figure
         -- nor a cancellation means anything once it has shipped or died.
         and o.status not in ('dispatched', 'cancelled')
         and (
           o.requested_by = auth.uid()
           or o.assigned_to = auth.uid()
           or exists (select 1 from public.users a
                       where a.id = auth.uid() and a.role = 'admin')
           or exists (select 1 from public.users t
                       where t.id = auth.uid() and t.team = 'operations')
         )
    )
  );

-- Read your own; an admin reads all.
create policy "order_change_requests_select" on public.order_change_requests
  for select to authenticated
  using (
    requested_by = auth.uid()
    or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- ── 4. The one apply path ─────────────────────────────────────────────────────
--
-- Every amendment — admin-direct or approved-request — lands here, so the audit
-- row, the non-negative check and the no-op rule are written once.
--
-- COALESCE on every field is what makes NULL mean "leave alone". It also means
-- no door in this migration can blank a field back to NULL; clearing a due date
-- is deliberately not offered rather than half-offered through a sentinel.
--
-- The audit row records the OLD and NEW value of each field that actually
-- moved, which is the whole reason the guard in section 1 forces traffic
-- through here. A no-op amendment raises instead of writing an empty audit row:
-- an activity entry that says nothing changed is worse than no entry.

create or replace function public.apply_order_amendment(
  p_order_id       uuid,
  p_actor_id       uuid,
  p_reason         text,
  p_source         text,      -- 'admin_direct' | 'change_request'
  p_request_id     uuid,      -- null for the admin-direct door
  p_client_name         text,
  p_total_value         numeric,
  p_total_product_value numeric,
  p_confirm_date        date,
  p_due_date            date,
  p_lead_source         text,
  p_notes               text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old     public.orders%rowtype;
  v_new     public.orders%rowtype;
  v_changes jsonb := '{}'::jsonb;
begin
  -- Lock the Order. Two amendments racing serialize here, so the "before"
  -- values written to the audit log are the ones actually replaced — never a
  -- snapshot another transaction has already overwritten.
  select * into v_old from public.orders where id = p_order_id for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists'
      using errcode = 'P0002';
  end if;

  if v_old.status in ('dispatched', 'cancelled') then
    raise exception
      'ORDER_CLOSED: Order % is % and its terms can no longer be amended',
      v_old.display_number, v_old.status
      using errcode = '42501';
  end if;

  if (p_total_value is not null and p_total_value < 0)
     or (p_total_product_value is not null and p_total_product_value < 0) then
    raise exception 'ORDER_VALUE_NEGATIVE: An order value cannot be negative'
      using errcode = '22023';
  end if;

  if p_client_name is not null and btrim(p_client_name) = '' then
    raise exception 'ORDER_CLIENT_NAME_EMPTY: An order must always name a client'
      using errcode = '22023';
  end if;

  -- Open the context, apply, close it. The set_config is transaction-local, so
  -- the reset below is belt-and-braces for the rest of THIS transaction rather
  -- than cleanup of anything that could outlive it.
  perform set_config('boe.amendment_context', 'order_amendment', true);

  update public.orders
     set client_name         = coalesce(btrim(p_client_name), client_name),
         total_value         = coalesce(p_total_value,         total_value),
         total_product_value = coalesce(p_total_product_value, total_product_value),
         confirm_date        = coalesce(p_confirm_date,        confirm_date),
         due_date            = coalesce(p_due_date,            due_date),
         lead_source         = coalesce(p_lead_source,         lead_source),
         notes               = coalesce(p_notes,               notes)
   where id = p_order_id
  returning * into v_new;

  perform set_config('boe.amendment_context', '', true);

  -- Build the diff from what the database actually stored, not from the
  -- arguments: a value equal to the one already there is not a change, and
  -- must not appear in the audit row as though it were.
  if v_new.client_name is distinct from v_old.client_name then
    v_changes := v_changes || jsonb_build_object('client_name',
      jsonb_build_object('from', v_old.client_name, 'to', v_new.client_name));
  end if;
  if v_new.total_value is distinct from v_old.total_value then
    v_changes := v_changes || jsonb_build_object('total_value',
      jsonb_build_object('from', v_old.total_value, 'to', v_new.total_value));
  end if;
  if v_new.total_product_value is distinct from v_old.total_product_value then
    v_changes := v_changes || jsonb_build_object('total_product_value',
      jsonb_build_object('from', v_old.total_product_value, 'to', v_new.total_product_value));
  end if;
  if v_new.confirm_date is distinct from v_old.confirm_date then
    v_changes := v_changes || jsonb_build_object('confirm_date',
      jsonb_build_object('from', v_old.confirm_date, 'to', v_new.confirm_date));
  end if;
  if v_new.due_date is distinct from v_old.due_date then
    v_changes := v_changes || jsonb_build_object('due_date',
      jsonb_build_object('from', v_old.due_date, 'to', v_new.due_date));
  end if;
  if v_new.lead_source is distinct from v_old.lead_source then
    v_changes := v_changes || jsonb_build_object('lead_source',
      jsonb_build_object('from', v_old.lead_source, 'to', v_new.lead_source));
  end if;
  if v_new.notes is distinct from v_old.notes then
    v_changes := v_changes || jsonb_build_object('notes',
      jsonb_build_object('from', v_old.notes, 'to', v_new.notes));
  end if;

  if v_changes = '{}'::jsonb then
    raise exception
      'ORDER_AMENDMENT_NO_CHANGE: Every value submitted matches what Order % already holds',
      v_old.display_number
      using errcode = '22023';
  end if;

  -- The audit row. order_activity_log has no INSERT policy for sales, and this
  -- is a definer function, so the entry is written for whoever amended —
  -- including a salesperson whose request was just approved — without widening
  -- anyone's ability to write to the log directly.
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    p_order_id,
    p_actor_id,
    'order_amended',
    jsonb_build_object(
      'source',     p_source,
      'reason',     p_reason,
      'request_id', p_request_id,
      'changes',    v_changes
    )
  );

  return jsonb_build_object(
    'order_id',       p_order_id,
    'display_number', v_new.display_number,
    'changes',        v_changes
  );
end;
$$;

-- Internal only. Both public doors below call it; nothing else may, because it
-- performs no authorization of its own — its callers do.
revoke execute on function public.apply_order_amendment(
  uuid, uuid, text, text, uuid, text, numeric, numeric, date, date, text, text
) from public, anon, authenticated;

comment on function public.apply_order_amendment(
  uuid, uuid, text, text, uuid, text, numeric, numeric, date, date, text, text
) is
  'Internal. Applies an order amendment and writes its order_amended audit row inside one transaction. Performs NO authorization — amend_order() and approve_order_change_request() are the authorized doors.';

-- ── 5. Cancelling, and the money already on the order ─────────────────────────
--
-- Cancellation is separated from apply_order_amendment because it is not a
-- change of terms: it ends the order, it is reachable from the status graph as
-- well as from here, and — the reason it needs its own function — it has to
-- report the money.
--
-- What it deliberately does NOT do is touch that money. Payments linked to a
-- cancelled Order stay linked and stay approved_linked: the money genuinely
-- arrived, and a cancellation is not a refund. Refunding is a separate,
-- deliberate act by whoever moves the funds. What this function guarantees is
-- that nobody cancels an Order without the received figure being written into
-- the activity log next to the decision.

create or replace function public.order_linked_payment_total(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)
    from public.finance_payment_requests
   where order_id = p_order_id
     and status = 'approved_linked';
$$;

revoke execute on function public.order_linked_payment_total(uuid) from public, anon;
grant  execute on function public.order_linked_payment_total(uuid) to authenticated;

comment on function public.order_linked_payment_total(uuid) is
  'Total approved_linked money received against one Order. SECURITY DEFINER so a salesperson who can see the Order sees the true received figure without being granted the finance ledger.';

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
set search_path = public
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

  update public.orders set status = 'cancelled' where id = p_order_id;

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

-- ── 6. Door one: the admin amends directly ────────────────────────────────────

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

  if not exists (
    select 1 from public.users where id = v_uid and is_active and role = 'admin'
  ) then
    raise exception 'ORDER_AMENDMENT_FORBIDDEN: Only an administrator can amend an order'
      using errcode = '42501';
  end if;

  return v_uid;
end;
$$;

revoke execute on function public.assert_order_amender() from public, anon;
grant  execute on function public.assert_order_amender() to authenticated;

create or replace function public.amend_order(
  p_order_id            uuid,
  p_reason              text,
  p_client_name         text    default null,
  p_total_value         numeric default null,
  p_total_product_value numeric default null,
  p_confirm_date        date    default null,
  p_due_date            date    default null,
  p_lead_source         text    default null,
  p_notes               text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.assert_order_amender();
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ORDER_AMENDMENT_NO_REASON: An amendment must say why'
      using errcode = '22023';
  end if;

  return public.apply_order_amendment(
    p_order_id, v_uid, btrim(p_reason), 'admin_direct', null,
    p_client_name, p_total_value, p_total_product_value,
    p_confirm_date, p_due_date, p_lead_source, p_notes
  );
end;
$$;

revoke execute on function public.amend_order(uuid, text, text, numeric, numeric, date, date, text, text)
  from public, anon;
grant  execute on function public.amend_order(uuid, text, text, numeric, numeric, date, date, text, text)
  to authenticated;

comment on function public.amend_order(uuid, text, text, numeric, numeric, date, date, text, text) is
  'Admin-only. Amends a Confirmed Order''s commercial terms and writes an order_amended audit row. NULL leaves a field alone; a reason is mandatory; a no-op is refused.';

-- Admin-direct cancellation, so the received figure is captured on this path
-- too. The status dropdown's plain UPDATE remains possible for the other
-- transitions; cancelling routes here instead.
create or replace function public.cancel_order(
  p_order_id uuid,
  p_reason   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.assert_order_amender();
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ORDER_CANCEL_NO_REASON: A cancellation must say why'
      using errcode = '22023';
  end if;

  return public.cancel_order_with_audit(p_order_id, v_uid, btrim(p_reason), 'admin_direct', null);
end;
$$;

revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant  execute on function public.cancel_order(uuid, text) to authenticated;

-- ── 7. Door two: approve or reject a change request ───────────────────────────

create or replace function public.approve_order_change_request(
  p_request_id  uuid,
  p_review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := public.assert_order_amender();
  v_req    public.order_change_requests;
  v_result jsonb;
begin
  -- FOR UPDATE: two admins clicking Approve at once serialize here, and the
  -- second finds the row already reviewed rather than applying it twice.
  select * into v_req
    from public.order_change_requests
   where id = p_request_id
   for update;

  if not found then
    raise exception 'ORDER_CHANGE_REQUEST_MISSING: This request no longer exists'
      using errcode = '42501';
  end if;

  if v_req.status <> 'pending' then
    raise exception 'ORDER_CHANGE_REQUEST_REVIEWED: This request has already been reviewed'
      using errcode = '42501';
  end if;

  if v_req.request_type = 'cancel' then
    v_result := public.cancel_order_with_audit(
      v_req.order_id, v_uid, v_req.reason, 'change_request', v_req.id
    );
  else
    v_result := public.apply_order_amendment(
      v_req.order_id, v_uid, v_req.reason, 'change_request', v_req.id,
      v_req.proposed_client_name,
      v_req.proposed_total_value,
      v_req.proposed_total_product_value,
      v_req.proposed_confirm_date,
      v_req.proposed_due_date,
      v_req.proposed_lead_source,
      v_req.proposed_notes
    );
  end if;

  -- Reached only when the change above succeeded. Every refusal — a closed
  -- order, a no-op, a negative value — has already raised and rolled the whole
  -- transaction back, so no request is ever marked approved without its effect.
  update public.order_change_requests
     set status      = 'approved',
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = p_review_note
   where id = p_request_id;

  return v_result || jsonb_build_object('request_id', p_request_id, 'decision', 'approved');
end;
$$;

revoke execute on function public.approve_order_change_request(uuid, text) from public, anon;
grant  execute on function public.approve_order_change_request(uuid, text) to authenticated;

create or replace function public.reject_order_change_request(
  p_request_id  uuid,
  p_review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.assert_order_amender();
  v_req public.order_change_requests;
begin
  select * into v_req
    from public.order_change_requests
   where id = p_request_id
   for update;

  if not found then
    raise exception 'ORDER_CHANGE_REQUEST_MISSING: This request no longer exists'
      using errcode = '42501';
  end if;

  if v_req.status <> 'pending' then
    raise exception 'ORDER_CHANGE_REQUEST_REVIEWED: This request has already been reviewed'
      using errcode = '42501';
  end if;

  update public.order_change_requests
     set status      = 'rejected',
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = p_review_note
   where id = p_request_id;

  -- The Order is untouched; only the request moved. Nothing is written to
  -- order_activity_log, because nothing happened to the Order.
  return jsonb_build_object(
    'request_id', p_request_id,
    'order_id',   v_req.order_id,
    'decision',   'rejected'
  );
end;
$$;

revoke execute on function public.reject_order_change_request(uuid, text) from public, anon;
grant  execute on function public.reject_order_change_request(uuid, text) to authenticated;

-- ── 8. What this migration deliberately does NOT do ───────────────────────────
--
--   * No refund. A cancellation records the received figure; it does not move,
--     reverse or re-status a single payment. Refunds need a signed direction on
--     the money and a destination, which is a Finance change, not this one.
--   * No notification. Pending requests surface in the admin Action Queue,
--     which is where the other two pending-decision categories already live.
--     notifications.type is a Postgres ENUM and adding a value to it is a
--     separate, deploy-ordered change.
--   * No new status on public.orders, and no change to the transition graph.
--   * No widening of who can SEE an Order. The insert policy re-states the
--     existing visibility rule; it does not extend it.
--   * display_number, source_order_request_id, source_request_number and
--     is_test_data keep the guards they already have, untouched.
