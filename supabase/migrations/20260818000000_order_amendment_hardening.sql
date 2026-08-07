-- Orders — make PRIVILEGES the primary control, and stop stale amendments.
--
-- Three findings from the review of 20260816000000. All three are defects in
-- that migration, not new features.
--
-- ── Finding 1: the GUC was the only thing protecting commercial columns ──────
--
-- 20260804 §1 refuses a commercial-column change unless the transaction-local
-- `boe.amendment_context` GUC is set. That was described as defence in depth.
-- It was not: it was the ONLY depth. Verified against the live database —
--
--   information_schema.role_table_grants, public.orders:
--     authenticated : SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER
--     anon          : SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER
--
-- — which is Supabase's blanket `grant all on all tables` default, never
-- narrowed for this table. RLS then decides WHICH ROWS may be updated, and
-- `orders_operations_update` (20260655) says "any row, for anyone on the
-- operations team". Nothing anywhere said WHICH COLUMNS. So for an operations
-- user, a trigger reading a session variable stood alone between them and
-- total_value.
--
-- That is the wrong shape regardless of whether the GUC is reachable today
-- (it is not: no exposed function takes a GUC name as a parameter, and
-- PostgREST cannot issue a bare SET). A session variable is a coordination
-- signal between a definer function and its own trigger. It must never be the
-- thing that decides whether a write is allowed, because it only has to become
-- settable ONCE — one future RPC that forwards a parameter into set_config,
-- one SQL-execution path — and the protection is gone silently.
--
-- The fix is a privilege, checked by Postgres before RLS and before any
-- trigger runs, and not overridable by anything a client can put in a
-- transaction:
--
--     revoke update on public.orders from authenticated, anon;
--     grant  update (status) on public.orders to authenticated;
--
-- After this, the GUC guard from 20260804 keeps doing exactly the job it is
-- suited to: catching the SERVICE ROLE and direct SQL, which hold their own
-- grants and are not constrained by the statement above.
--
-- ── Finding 2: an approved amendment could silently clobber a newer one ──────
--
-- order_change_requests stores only the PROPOSED values. Approval applied them
-- with no reference to what the requester was looking at. So:
--
--   1. Order value is 250,000. Sales raises "make it 300,000".
--   2. Admin amends directly to 400,000 (client added a wardrobe).
--   3. Admin approves the request from step 1.
--   4. Value is silently 300,000. The wardrobe is gone from the figure and
--      nothing in the audit trail says a decision was reversed.
--
-- Both amendments are individually audited, so this is not invisible — but it
-- is not DETECTED, and the second approver is given no reason to look. §3 adds
-- a server-captured baseline and refuses approval when the world has moved
-- under the request.
--
-- ── Finding 3: search_path omitted pg_temp ──────────────────────────────────
--
-- Every function in 20260804 sets `search_path = public`. When pg_temp is not
-- listed explicitly, Postgres searches it FIRST for relation names. Every table
-- reference in that migration is schema-qualified, so nothing is exploitable
-- today — but the qualification is the only thing holding it, and one
-- unqualified reference added later would be a temp-table shadowing hole in a
-- SECURITY DEFINER function. §4 pins pg_temp last on all ten.
--
-- Scope: privileges on one table, seven columns, one trigger, two function
-- replacements, ten search_path settings. No row is written. No policy is
-- dropped. Nothing outside Order amendments is touched.

-- ── 1. Privileges: only `status` is client-writable on public.orders ─────────
--
-- Why `status` alone. The application has exactly ONE client write path to
-- this table — StatusControl's `.update({ status })` in
-- src/app/orders/[id]/page.tsx. Nothing else, anywhere, updates an Order from
-- a client. `notes` is deliberately NOT granted even though 20260655's comment
-- mentions it and 20260804 left it in the freely-updatable tier: no UI has ever
-- written it, and it is already reachable through the amendment path, where it
-- gets an actor and a reason like every other commercial field. §5 moves it
-- into the guarded tier so the trigger and the grants agree.
--
-- DELETE and TRUNCATE go too. 20260705 §2 dropped the DELETE *policy* and added
-- a row trigger to make Confirmed Orders permanent, but left the DELETE and
-- TRUNCATE *grants* in place — and a row-level BEFORE DELETE trigger does not
-- fire on TRUNCATE at all, so the grant was a hole straight through that
-- guarantee. Not reachable via PostgREST, which exposes no TRUNCATE; revoked
-- because "unreachable today" is not the same as "cannot happen".
--
-- service_role keeps everything. Existing service-role routes must keep
-- working, and the 20260804 trigger is the layer that covers them.

revoke update, delete, truncate, references, trigger
  on public.orders from authenticated, anon;

grant update (status) on public.orders to authenticated;

-- anon keeps no write privilege of any kind. It never had a matching RLS
-- policy, so this changes no behaviour; it removes the standing grant that
-- would have become one the moment a permissive policy was added.
revoke insert on public.orders from anon;

comment on table public.orders is
  'Confirmed Orders. Client roles hold UPDATE on the `status` column ONLY (20260818000000); every other column moves exclusively through amend_order() / approve_order_change_request(). No client role holds DELETE or TRUNCATE — a Confirmed Order is permanent business history.';

-- ── 2. Baseline capture ──────────────────────────────────────────────────────
--
-- What the Order held at the moment the request was filed, for exactly the
-- seven fields a request can propose. Captured by a trigger rather than
-- accepted from the client: a requester who could supply their own baseline
-- could suppress the staleness check in §3 by sending whatever the current
-- value happens to be, which is precisely the check they must not be able to
-- opt out of.

alter table public.order_change_requests
  add column if not exists baseline_client_name         text,
  add column if not exists baseline_total_value         numeric(12,2),
  add column if not exists baseline_total_product_value numeric(12,2),
  add column if not exists baseline_confirm_date        date,
  add column if not exists baseline_due_date            date,
  add column if not exists baseline_lead_source         text,
  add column if not exists baseline_notes               text;

create or replace function public.capture_order_change_baseline()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = new.order_id;

  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists'
      using errcode = 'P0002';
  end if;

  -- Unconditional assignment. Anything the client sent in these columns is
  -- discarded, which is what makes the baseline trustworthy.
  new.baseline_client_name         := v_order.client_name;
  new.baseline_total_value         := v_order.total_value;
  new.baseline_total_product_value := v_order.total_product_value;
  new.baseline_confirm_date        := v_order.confirm_date;
  new.baseline_due_date            := v_order.due_date;
  new.baseline_lead_source         := v_order.lead_source;
  new.baseline_notes               := v_order.notes;

  return new;
end;
$$;

revoke execute on function public.capture_order_change_baseline() from public, anon, authenticated;

drop trigger if exists order_change_requests_capture_baseline on public.order_change_requests;

create trigger order_change_requests_capture_baseline
  before insert on public.order_change_requests
  for each row execute function public.capture_order_change_baseline();

-- ── 3. Approval refuses a stale request ──────────────────────────────────────
--
-- Replaces the 20260804 §7 function. The only change is the staleness gate
-- between the lock and the apply; everything else is byte-identical, so the
-- two can be diffed.
--
-- Granularity is deliberate: only the fields THIS request proposes are
-- compared. A request that proposes a new total_value is not stale because
-- somebody else changed the due date — that is a different fact, and refusing
-- on it would train admins to re-submit blindly, which is the failure mode the
-- check exists to prevent.
--
-- A stale request is REFUSED, not auto-rejected. It stays pending so a human
-- decides whether the proposal still makes sense against the new figure. The
-- database must not conclude on someone's behalf that a superseded proposal is
-- dead — it might still be exactly right.

create or replace function public.approve_order_change_request(
  p_request_id  uuid,
  p_review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := public.assert_order_amender();
  v_req    public.order_change_requests;
  v_order  public.orders%rowtype;
  v_stale  text[] := '{}';
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
    -- A cancellation proposes no field values, so it has no baseline to be
    -- stale against. The status checks inside cancel_order_with_audit are the
    -- whole of its concurrency story.
    v_result := public.cancel_order_with_audit(
      v_req.order_id, v_uid, v_req.reason, 'change_request', v_req.id
    );
  else
    -- Lock the Order in the SAME order apply_order_amendment takes it, so the
    -- staleness read cannot be overtaken between this check and the write, and
    -- the two functions can never deadlock against each other.
    select * into v_order from public.orders where id = v_req.order_id for update;

    if not found then
      raise exception 'ORDER_NOT_FOUND: That Order no longer exists'
        using errcode = 'P0002';
    end if;

    -- Compare only the fields this request actually proposes. A NULL baseline
    -- against a NULL current value is not a change, which `is distinct from`
    -- gets right and `<>` would not.
    if v_req.proposed_client_name is not null
       and v_order.client_name is distinct from v_req.baseline_client_name then
      v_stale := v_stale || 'client name';
    end if;
    if v_req.proposed_total_value is not null
       and v_order.total_value is distinct from v_req.baseline_total_value then
      v_stale := v_stale || 'total order value';
    end if;
    if v_req.proposed_total_product_value is not null
       and v_order.total_product_value is distinct from v_req.baseline_total_product_value then
      v_stale := v_stale || 'total product value';
    end if;
    if v_req.proposed_confirm_date is not null
       and v_order.confirm_date is distinct from v_req.baseline_confirm_date then
      v_stale := v_stale || 'confirm date';
    end if;
    if v_req.proposed_due_date is not null
       and v_order.due_date is distinct from v_req.baseline_due_date then
      v_stale := v_stale || 'due date';
    end if;
    if v_req.proposed_lead_source is not null
       and v_order.lead_source is distinct from v_req.baseline_lead_source then
      v_stale := v_stale || 'lead source';
    end if;
    if v_req.proposed_notes is not null
       and v_order.notes is distinct from v_req.baseline_notes then
      v_stale := v_stale || 'notes';
    end if;

    if array_length(v_stale, 1) > 0 then
      raise exception
        'ORDER_CHANGE_REQUEST_STALE: Order % changed after this request was raised (%). Review the current values before approving.',
        v_order.display_number, array_to_string(v_stale, ', ')
        using errcode = '40001';
    end if;

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
  -- order, a no-op, a negative value, a stale baseline — has already raised and
  -- rolled the whole transaction back, so no request is ever marked approved
  -- without its effect.
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

-- ── 4. search_path: pin pg_temp last on every function from 20260804 ─────────
--
-- ALTER FUNCTION rather than CREATE OR REPLACE, so the bodies are not restated
-- and this migration cannot silently ship a different implementation of one of
-- them.

alter function public.in_order_amendment()                            set search_path = public, pg_temp;
alter function public.orders_guard_amendable_columns()                set search_path = public, pg_temp;
alter function public.apply_order_amendment(uuid, uuid, text, text, uuid, text, numeric, numeric, date, date, text, text)
                                                                      set search_path = public, pg_temp;
alter function public.order_linked_payment_total(uuid)                set search_path = public, pg_temp;
alter function public.cancel_order_with_audit(uuid, uuid, text, text, uuid)
                                                                      set search_path = public, pg_temp;
alter function public.assert_order_amender()                          set search_path = public, pg_temp;
alter function public.amend_order(uuid, text, text, numeric, numeric, date, date, text, text)
                                                                      set search_path = public, pg_temp;
alter function public.cancel_order(uuid, text)                        set search_path = public, pg_temp;
alter function public.reject_order_change_request(uuid, text)         set search_path = public, pg_temp;

-- ── 5. `notes` joins the guarded tier ────────────────────────────────────────
--
-- 20260804 put notes in the operational tier, next to status. §1 revoked the
-- privilege that made that reachable, so leaving it there would only mean the
-- trigger and the grants disagreed about the same column. A notes change is a
-- change to what the order says; it gets an actor and a reason like the rest.

create or replace function public.orders_guard_amendable_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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
     or new.lead_source         is distinct from old.lead_source
     or new.notes               is distinct from old.notes then
    raise exception
      'ORDER_AMENDMENT_REQUIRED: The terms of Order % can only be changed through an order amendment, which records who changed what and why',
      old.display_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.orders_guard_amendable_columns() from public, anon, authenticated;

-- ── 6. What this migration deliberately does NOT do ──────────────────────────
--
--   * It does not revoke INSERT on public.orders from authenticated, and does
--     not drop `orders_sales_insert` (20260655) — which still lets an
--     authenticated user create an Order directly, bypassing the Order Request
--     → conversion → numbering path entirely. That policy is vestigial: it was
--     written when sales inserted their own rows at status 'requested', a
--     status 20260702000000 retired. It is a real hole and it is recorded as
--     finding D7, but closing it changes who can create an Order, which is a
--     different blast radius from this migration and deserves its own review
--     and its own end-to-end conversion test.
--   * It does not touch the equivalent blanket grants on any other table.
--     public.orders is narrowed because this branch is about Order integrity;
--     a project-wide privilege audit is a separate task (finding D8).
--   * It does not weaken, re-scope or drop any RLS policy.
--   * It adds no status, no notification and no client-callable function.
