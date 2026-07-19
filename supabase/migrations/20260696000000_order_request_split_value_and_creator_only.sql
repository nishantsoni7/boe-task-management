-- Order Requests: split "Approx. Value" into Total Product Value / Total
-- Order Value, and stop collecting "Requested By" as a free-choice form
-- field.
--
-- Business definitions (fixed by product decision, not inferred):
--   total_product_value -> products only.
--   total_value          -> renamed in the UI to "Total Order Value"; the
--                           column itself is unchanged and keeps carrying
--                           the final complete order amount (products plus
--                           transport/packing/installation/taxes/other
--                           charges), exactly as it already does for the
--                           Order-side payment-completion math.
--
-- requested_by is no longer presented as an editable dropdown on Submit,
-- Resubmit, or Reapply. The authenticated user is saved automatically
-- (mirroring created_by, which was already auth.uid()-derived and remains
-- untouched). requested_by keeps existing values on already-submitted
-- requests, and the existing ownership rule (created_by = auth.uid() OR
-- requested_by = auth.uid(), used by resubmit_order_request /
-- reapply_order_request / the RLS select policies) is left exactly as is —
-- for new rows requested_by will simply equal created_by going forward.
--
-- assigned_to is untouched: this migration does not change its meaning or
-- behavior, only its UI label ("Assignee"), which requires no schema change.

-- ── 1. New column: total_product_value ───────────────────────────────────────
-- Nullable, no backfill: existing rows have no recorded product-only figure,
-- and their existing total_value is treated as "Total Order Value" (the
-- proposed legacy-data mapping approved before implementation).

alter table public.order_requests
  add column total_product_value numeric(12,2)
  check (total_product_value is null or total_product_value >= 0);

alter table public.orders
  add column total_product_value numeric(12,2)
  check (total_product_value is null or total_product_value >= 0);

-- Guard total_value the same way going forward, without validating rows that
-- already exist (NOT VALID skips the historical scan — this cannot fail the
-- migration on legacy data, and only new writes are checked).
alter table public.order_requests
  add constraint order_requests_total_value_nonneg
  check (total_value is null or total_value >= 0) not valid;

-- ── 2. resubmit_order_request: drop requested_by param, add total_product_value ─
-- Signature changes shape (uuid,text,uuid,uuid,date,date,numeric,text,text) ->
-- (uuid,text,uuid,date,date,numeric,numeric,text,text), so the old function
-- must be dropped rather than replaced in place.

drop function if exists public.resubmit_order_request(uuid, text, uuid, uuid, date, date, numeric, text, text);

create or replace function public.resubmit_order_request(
  p_order_request_id    uuid,
  p_client_name         text,
  p_assigned_to         uuid    default null,
  p_confirm_date        date    default null,
  p_due_date            date    default null,
  p_total_value         numeric default null,
  p_total_product_value numeric default null,
  p_lead_source         text    default null,
  p_notes               text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_req    public.order_requests%rowtype;
  v_client text;
  v_notes  text;
  v_now    timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required'
      using errcode = '28000';
  end if;

  -- 2. Lock the request first: serializes double-clicks and blocks a race with
  --    an admin converting or re-clarifying at the same moment.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 3. Ownership, checked against the CURRENT row (before any change), using the
  --    project's existing requester definition. requested_by is no longer a
  --    client-supplied parameter, so this check is unaffected by this change.
  if not (v_req.created_by = v_actor or v_req.requested_by = v_actor) then
    raise exception 'Only the requester may resubmit this order request'
      using errcode = '42501';
  end if;

  -- 4. Only a request actually awaiting clarification may be resubmitted. This
  --    rejects a repeat resubmission, a submitted request, and rejected or
  --    converted requests.
  if v_req.status <> 'needs_clarification' then
    raise exception 'Only an order request awaiting clarification can be resubmitted (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 5. Validate the required business fields (the table's own CHECK/FK
  --    constraints still police lead_source, the user references, and types).
  v_client := btrim(coalesce(p_client_name, ''));
  if v_client = '' then
    raise exception 'Client name is required'
      using errcode = 'P0001';
  end if;

  if p_total_value is not null and p_total_value < 0 then
    raise exception 'Total Order Value must not be negative'
      using errcode = 'P0001';
  end if;

  if p_total_product_value is not null and p_total_product_value < 0 then
    raise exception 'Total Product Value must not be negative'
      using errcode = 'P0001';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  -- 6. Apply the permitted edits and hand the request back for review in one
  --    statement, so the AFTER UPDATE trigger writes exactly one
  --    clarification_resubmitted row. requested_by is intentionally absent
  --    from this SET list: it keeps whatever value it already had.
  update public.order_requests
     set client_name          = v_client,
         assigned_to          = p_assigned_to,
         confirm_date         = p_confirm_date,
         due_date             = p_due_date,
         total_value          = p_total_value,
         total_product_value  = p_total_product_value,
         lead_source          = p_lead_source,
         notes                = v_notes,
         status               = 'submitted',
         clarification_note   = null,
         updated_at           = v_now
   where id = p_order_request_id;

  return jsonb_build_object(
    'order_request_id', v_req.id,
    'request_number',   v_req.request_number,
    'status',           'submitted',
    'updated_at',       v_now
  );
end;
$$;

revoke execute on function public.resubmit_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) from public, anon, authenticated;
grant  execute on function public.resubmit_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) to authenticated;

-- ── 3. reapply_order_request: same change, mirroring resubmit_order_request ──

drop function if exists public.reapply_order_request(uuid, text, uuid, uuid, date, date, numeric, text, text);

create or replace function public.reapply_order_request(
  p_order_request_id    uuid,
  p_client_name         text,
  p_assigned_to         uuid    default null,
  p_confirm_date        date    default null,
  p_due_date            date    default null,
  p_total_value         numeric default null,
  p_total_product_value numeric default null,
  p_lead_source         text    default null,
  p_notes               text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_req    public.order_requests%rowtype;
  v_client text;
  v_notes  text;
  v_now    timestamptz := now();
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required'
      using errcode = '28000';
  end if;

  -- 2. Lock the request first: serializes double-clicks and blocks a race
  --    with a concurrent admin action (e.g. a second rejection attempt) or a
  --    second reapplication call on the same row.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 3. Ownership, checked against the CURRENT row (before any change), using
  --    the project's existing requester definition. requested_by is no
  --    longer a client-supplied parameter, so this check is unaffected.
  if not (v_req.created_by = v_actor or v_req.requested_by = v_actor) then
    raise exception 'Only the requester may reapply this order request'
      using errcode = '42501';
  end if;

  -- 4. Only a rejected request may be reapplied. This also rejects a repeat
  --    reapplication (once already submitted, status is no longer
  --    'rejected'), and submitted, needs_clarification, or converted
  --    requests.
  if v_req.status <> 'rejected' then
    raise exception 'Only a rejected order request can be reapplied (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 5. Validate the required business fields (the table's own CHECK/FK
  --    constraints still police lead_source, the user references, and types).
  v_client := btrim(coalesce(p_client_name, ''));
  if v_client = '' then
    raise exception 'Client name is required'
      using errcode = 'P0001';
  end if;

  if p_total_value is not null and p_total_value < 0 then
    raise exception 'Total Order Value must not be negative'
      using errcode = 'P0001';
  end if;

  if p_total_product_value is not null and p_total_product_value < 0 then
    raise exception 'Total Product Value must not be negative'
      using errcode = 'P0001';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  -- 6. Apply the permitted edits and hand the request back for review in one
  --    statement, so the AFTER UPDATE trigger writes exactly one
  --    reapplication_submitted row. requested_by is intentionally absent
  --    from this SET list: it keeps whatever value it already had.
  update public.order_requests
     set client_name          = v_client,
         assigned_to          = p_assigned_to,
         confirm_date         = p_confirm_date,
         due_date             = p_due_date,
         total_value          = p_total_value,
         total_product_value  = p_total_product_value,
         lead_source          = p_lead_source,
         notes                = v_notes,
         status               = 'submitted',
         rejection_reason     = null,
         updated_at           = v_now
   where id = p_order_request_id;

  return jsonb_build_object(
    'order_request_id', v_req.id,
    'request_number',   v_req.request_number,
    'status',           'submitted',
    'updated_at',        v_now
  );
end;
$$;

revoke execute on function public.reapply_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) from public, anon, authenticated;
grant  execute on function public.reapply_order_request(uuid, text, uuid, date, date, numeric, numeric, text, text) to authenticated;

-- ── 4. Conversion RPC: carry total_product_value onto the new Order too ─────
-- Signature is unchanged (p_order_request_id uuid, p_payment_request_ids
-- uuid[] default '{}'), so CREATE OR REPLACE is sufficient here — no DROP
-- needed, and existing grants stay intact.

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
    confirm_date, due_date, total_value, total_product_value, lead_source, notes, created_by
  )
  values (
    v_number, v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.total_product_value,
    v_req.lead_source, v_req.notes, v_actor
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
