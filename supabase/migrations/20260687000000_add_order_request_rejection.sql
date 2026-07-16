-- Order Requests Phase 3B — admin rejection.
--
-- Implements the terminal transition:  submitted -> rejected
--
--   public.reject_order_request(p_order_request_id, p_rejection_reason)
--     Admin-only. submitted -> rejected, storing a required, trimmed reason.
--
-- Reapply-after-rejection, reversal, and reopening are explicitly out of scope
-- for this phase. Conversion, clarification, payment linking, official Order
-- numbering, and all Finance behaviour are untouched. A rejected request is
-- already unreachable by convert_order_request_to_order and
-- resubmit_order_request, since both require status = 'submitted' /
-- 'needs_clarification' respectively — this migration adds no new checks
-- there.
--
-- ── Admin direct-update bypass found during the Phase 3B review ─────────────
-- order_requests_admin_update (20260680000000) grants admin an unrestricted
-- UPDATE (USING/WITH CHECK both just re-check users.role = 'admin', with no
-- column or state restriction). Every admin mutation actually used by the
-- application already goes through a SECURITY DEFINER RPC — convert_order_
-- request_to_order and request_order_request_clarification — and SECURITY
-- DEFINER functions run as the function owner, which bypasses RLS entirely,
-- so neither of them relies on this policy. grep over src/ confirms no
-- frontend code performs a direct .update() on order_requests. The policy is
-- therefore pure bypass surface: with it in place, an admin session could
-- PATCH order_requests directly through PostgREST to set status = 'rejected'
-- and rejection_reason to anything, with no reason validation, no row lock,
-- and no request_rejected activity row (the trigger's fallback would log a
-- generic status_changed instead).
--
-- Mirroring the Phase 3A precedent for order_requests_requester_update: the
-- policy is dropped rather than narrowed, since removing it costs no existing
-- functionality (verified above) and a narrowed policy would still be an
-- unused, error-prone parallel path to the RPCs.

-- ── 1. Allow the new activity event ──────────────────────────────────────────

alter table public.order_request_activity
  drop constraint order_request_activity_event_type_check;

alter table public.order_request_activity
  add constraint order_request_activity_event_type_check
  check (event_type in (
    'request_submitted',
    'status_changed',
    'request_converted',
    'clarification_requested',
    'clarification_resubmitted',
    'request_rejected'
  ));

-- ── 2. Map submitted -> rejected to its own event ────────────────────────────
-- Narrow extension of the existing trigger (unchanged otherwise): the new
-- transition now produces one specific request_rejected event instead of a
-- generic status_changed, so there is no redundant second entry for the same
-- rejection. details carries the trimmed rejection reason, which is what
-- keeps it permanently traceable in activity history.

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

    elsif (old.status = 'submitted' and new.status = 'needs_clarification') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'clarification_requested', v_actor, old.status, new.status,
              jsonb_build_object('clarification_note', new.clarification_note));

    elsif (old.status = 'needs_clarification' and new.status = 'submitted') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'clarification_resubmitted', v_actor, old.status, new.status);

    elsif (old.status = 'submitted' and new.status = 'rejected') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'request_rejected', v_actor, old.status, new.status,
              jsonb_build_object('rejection_reason', new.rejection_reason));

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

-- ── 3. Close the admin direct-update bypass ──────────────────────────────────

drop policy if exists "order_requests_admin_update" on public.order_requests;

-- ── 4. Admin: reject request ──────────────────────────────────────────────────
-- SECURITY DEFINER, matching request_order_request_clarification /
-- convert_order_request_to_order: authorization is enforced explicitly in the
-- body against the project's established admin pattern (public.users.role =
-- 'admin'), never by the caller's own RLS. The only client inputs are which
-- request to reject and why; status, actor_id, created_by, request_number,
-- and the conversion fields are not reachable through this signature.

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
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
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

revoke execute on function public.reject_order_request(uuid, text) from public, anon, authenticated;
grant  execute on function public.reject_order_request(uuid, text) to authenticated;
