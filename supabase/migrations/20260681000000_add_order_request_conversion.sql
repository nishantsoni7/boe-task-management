-- Order Requests Phase 2A — controlled admin conversion to an official Order.
--
-- Adds the single database-controlled operation that turns a submitted Order
-- Request into exactly one official public.orders row:
--   public.convert_order_request_to_order(p_order_request_id uuid)
--
-- Design invariants:
--   * Only an admin may convert (enforced server-side inside the function, not
--     by frontend visibility).
--   * Only status = 'submitted' converts. needs_clarification / rejected /
--     converted are rejected.
--   * The official Order number is allocated ONLY during conversion, and only
--     via the existing generator public.next_order_display_number(). Nothing
--     here changes official Order numbering or its format.
--   * Atomic: the Order insert, the request update, and both activity rows
--     commit or roll back together.
--   * Concurrency-safe: the request row is taken FOR UPDATE before validation,
--     so double-clicks, replays, and two admins racing cannot produce two
--     Orders from one request.
--
-- Payment linking is deliberately NOT implemented here — that is Phase 2B.
-- Nothing in this migration alters Finance tables, policies, or statuses, and
-- no existing Order or request rows are modified by the migration itself.

-- ── 1. Phase 1 defect fix — created_by must be immutable ──────────────────────
-- Concrete defect found during the Phase 2A security review and reproduced
-- against the deployed database:
--
--   order_requests_requester_update's WITH CHECK is
--     ((created_by = auth.uid()) OR (requested_by = auth.uid())) AND ...
--   The OR means a user who is merely requested_by satisfies the check via the
--   requested_by branch REGARDLESS of what created_by becomes. A normal
--   authenticated requester could therefore rewrite created_by to any user id
--   (verified: 1 row updated, no error), which both falsifies the audit trail
--   and hands SELECT visibility of the request to an unrelated third party
--   (order_requests_requester_select grants access on created_by = auth.uid()).
--
-- Smallest correction: make created_by immutable at the database level for
-- every role, mirroring the existing prevent_order_request_number_change()
-- guard from 20260680000000. The Phase 1 migration itself is left untouched.
-- requested_by is intentionally NOT frozen: it is a legitimate business field
-- (who the request is for), and changing it requires already having access to
-- the request, so it grants no escalation.

create or replace function public.prevent_order_request_created_by_change()
returns trigger
language plpgsql
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'created_by is immutable and cannot be changed once set';
  end if;
  return new;
end;
$$;

revoke execute on function public.prevent_order_request_created_by_change() from public, anon, authenticated;

drop trigger if exists order_requests_protect_created_by on public.order_requests;

create trigger order_requests_protect_created_by
  before update on public.order_requests
  for each row execute function public.prevent_order_request_created_by_change();

-- ── 2. Least-privilege hardening on the Order Request tables ──────────────────
-- Not a live vulnerability: every policy on order_requests targets the
-- authenticated role, and order_request_seq has RLS enabled with no policies at
-- all, so RLS already denies anon on both. But anon still carries the default
-- Supabase table grants here, which is unnecessary surface for tables no
-- anonymous flow ever touches. Revoking keeps these tables safe even if a
-- future policy is ever written with a broader role, and matches the hardening
-- 20260680000000 already applied to order_request_activity.

revoke all on public.order_requests    from anon;
revoke all on public.order_request_seq from anon, authenticated;

-- ── 3. Activity: allow the request_converted event ────────────────────────────

alter table public.order_request_activity
  drop constraint order_request_activity_event_type_check;

alter table public.order_request_activity
  add constraint order_request_activity_event_type_check
  check (event_type in ('request_submitted', 'status_changed', 'request_converted'));

-- ── 4. Activity trigger: emit one request_converted, not a generic duplicate ──
-- Replaces the Phase 1 function body. Conversion is still derived from the REAL
-- committed row transition (never client-supplied), keeps actor_id = auth.uid(),
-- and stays in the same transaction as the mutation. The only change is that a
-- submitted -> converted transition now produces a single, specific
-- request_converted row instead of a generic status_changed row, so there is no
-- redundant second entry for the same conversion.
--
-- details carries traceability fields only (the created Order's id and its
-- official number). Client name, financial values, and other request data are
-- deliberately not duplicated into the JSON — they already live on the request
-- and the Order.

create or replace function public.log_order_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_order_number text;
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

      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'request_converted', v_actor, old.status, new.status,
              jsonb_build_object(
                'converted_order_id',   new.converted_order_id,
                'order_display_number', v_order_number
              ));
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

-- ── 5. Enforce the one-request-one-Order relationship ─────────────────────────
-- order_requests_converted_consistency (20260680000000) already guarantees the
-- forward direction: a request carries at most one converted_order_id, and only
-- while status = 'converted'. Nothing yet prevents the REVERSE — two different
-- requests both pointing at the same Order. converted_order_id has only a plain
-- FK and no unique index, so this partial unique index is what actually makes
-- the relationship one-to-one.

create unique index order_requests_converted_order_id_uidx
  on public.order_requests (converted_order_id)
  where converted_order_id is not null;

-- ── 6. The conversion RPC ─────────────────────────────────────────────────────
-- SECURITY DEFINER is required: the function must insert into public.orders and
-- public.order_activity_log and update the request as a single trusted unit,
-- independent of the caller's own RLS. Authorization is therefore enforced
-- explicitly in the body against the project's established admin pattern
-- (public.users.role = 'admin', the same EXISTS test every Orders policy uses —
-- there is no is_admin() helper and no admin database role in this project).
--
-- Every security-relevant value is derived server-side:
--   display_number     <- public.next_order_display_number()
--   created_by / actor <- auth.uid()
--   status             <- the orders table default ('requested')
--   converted_*        <- computed here
-- The only client input is which request to convert.

create or replace function public.convert_order_request_to_order(
  p_order_request_id uuid
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

  -- 3. Lock the request row: serializes double-clicks, replays, and two admins
  --    racing on the same request. A concurrent caller blocks here and then
  --    re-reads the committed row, so it sees status = 'converted' and is
  --    rejected by the checks below instead of creating a second Order.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  -- 4. Existence
  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 5/6. State validation — only a clean, unconverted 'submitted' request.
  if v_req.converted_order_id is not null or v_req.converted_at is not null then
    raise exception 'Order request % has already been converted', v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'Only a submitted order request can be converted (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 7. Allocate the official Order number using the existing generator, only
  --    now that every check has passed, so a rejected attempt never burns one.
  --    (nextval does not roll back: a failed conversion after this point skips
  --    a number rather than reusing it — the documented, intended behaviour of
  --    orders_display_number_seq from 20260671.)
  v_number := public.next_order_display_number();

  -- 8/9. Exactly one official Order. Only fields that exist on both sides are
  --      mapped; status is left to the orders default ('requested') so the
  --      existing Order lifecycle and transition graph are unchanged.
  insert into public.orders (
    display_number, client_name, requested_by, assigned_to,
    confirm_date, due_date, total_value, lead_source, notes, created_by
  )
  values (
    v_number, v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.lead_source,
    v_req.notes, v_actor
  )
  returning id into v_order_id;

  -- 10. Close out the request in the same transaction. The AFTER UPDATE trigger
  --     writes the single request_converted activity row from this transition.
  update public.order_requests
     set status             = 'converted',
         converted_order_id = v_order_id,
         converted_at       = v_now,
         updated_at         = v_now
   where id = p_order_request_id;

  -- Order-side provenance, reusing the existing free-form order_activity_log.
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_request',
    jsonb_build_object(
      'order_request_id', v_req.id,
      'request_number',   v_req.request_number
    )
  );

  -- 11. Small structured result.
  return jsonb_build_object(
    'order_request_id',     v_req.id,
    'request_number',       v_req.request_number,
    'order_id',             v_order_id,
    'order_display_number', v_number,
    'converted_at',         v_now
  );
end;
$$;

-- Clear the defaults, then re-grant to the only role the application ever
-- authenticates as. This project has no admin database role and no way to grant
-- by application role, so admin-only runtime authorization is enforced by the
-- explicit check inside the function (step 2) rather than by the grant.
revoke execute on function public.convert_order_request_to_order(uuid) from public, anon, authenticated;
grant  execute on function public.convert_order_request_to_order(uuid) to authenticated;
