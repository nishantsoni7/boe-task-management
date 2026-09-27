-- ═══════════════════════════════════════════════════════════════════════════
-- 20270205000000  PRODUCTION BELOW 40% NEEDS AN ORDER-LEVEL EXCEPTION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Agreed rule: production may start only when the verified advance is at
-- least 40% of the CURRENT Order value, unless an authorised administrator
-- approves production below 40% with a reason (approve_order_advance_exception,
-- recorded in order_advance_exceptions with who, when and why).
--
-- Until now order_advance_position() also counted the PI's own below-40%
-- exception (approve_pi_advance_exception, which records no decision reason)
-- as "ready": an Order converted under it could be accepted for production
-- with nothing verified. That exception keeps its one job — letting the PI be
-- approved into an Order below 40% — and stops starting production.
--
-- ONE CHANGE: the 'ready' line. Every reader follows: the alignment trigger
-- (orders_alignment_requires_advance) refuses Operations' acceptance with
-- ORDER_ADVANCE_BELOW_THRESHOLD, approve_order_advance_exception is offered
-- (it refuses only when ready), and the screen shows the Order as blocked
-- with "an administrator approves production below 40%". The position still
-- reports the PI's exception under 'exception', for the record.
--
-- Refuses to run if an ALIGNED Order relies on the PI exception alone:
-- that Order would silently lose its footing. Production had none on
-- 2026-09-27 (0524 is 47.95% verified, standard route).
create or replace function public.order_advance_position(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o          public.orders%rowtype;
  s          public.order_submissions%rowtype;
  v_known    boolean;
  v_verified numeric;
  v_awaiting numeric;
  v_required numeric;
  v_short    numeric;
  v_version  uuid;
  v_exc      public.order_advance_exceptions%rowtype;
  v_pi_exc   boolean := false;
  v_hold     public.order_advance_holds%rowtype;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then return null; end if;

  -- NULL, zero and NaN are "no value on record": nothing to measure against.
  v_known := o.total_value is not null and o.total_value <> 'NaN'::numeric and o.total_value > 0;

  select coalesce(sum(a.allocated_amount), 0) into v_verified
    from public.finance_payment_allocations a join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_id = o.id and a.status = 'active' and public.finance_payment_status_is_verified(f.status);
  select coalesce(sum(a.allocated_amount), 0) into v_awaiting
    from public.finance_payment_allocations a join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_id = o.id and a.status = 'active' and f.status in ('pending_approval', 'needs_clarification');

  if v_known then
    v_required := public.order_submission_required_payment(o.total_value);
    v_short    := greatest(coalesce(public.order_submission_payment_shortfall(o.total_value, v_verified), v_required - v_verified), 0);
  end if;

  select v.id into v_version from public.order_pi_versions v
   where v.order_id = o.id and v.status = 'approved' limit 1;

  -- An administrator's exception for THIS value basis, still backed by the
  -- money it was given against.
  select * into v_exc from public.order_advance_exceptions e
   where e.order_id = o.id
     and e.value_epoch = o.value_epoch
     and e.order_value is not distinct from o.total_value
     and e.pi_version_id is not distinct from v_version
     and v_verified >= e.verified_at_grant
     and not exists (select 1 from public.order_advance_exception_voids x where x.exception_id = e.id)
   order by e.approved_at desc limit 1;

  -- The PI's own pre-conversion exception: only while the Order has never
  -- been re-valued, the PI still carries the figures it was decided on, the
  -- verified money has not fallen below what it was when the administrator
  -- DECIDED it (advance_exception_decided_verified; older decisions fall back
  -- to the recorded percentage), and no reversal has voided it.
  if o.source_order_submission_id is not null and o.value_epoch = 0 then
    select * into s from public.order_submissions where id = o.source_order_submission_id;
    v_pi_exc := coalesce(s.id is not null
      and s.grand_total is not distinct from o.total_value
      and v_verified >= public.order_pi_exception_floor(s.advance_exception_decided_verified, s.advance_exception_percent, o.total_value)
      and not exists (select 1 from public.order_advance_exception_voids x where x.order_id = o.id and x.exception_id is null)
      and public.order_submission_exception_current(
            s.advance_exception_status,
            s.advance_exception_decided_grand_total,     s.grand_total,
            s.advance_exception_decided_workbook_sha256, s.source_workbook_sha256,
            s.advance_exception_decided_payment_terms,   s.payment_terms,
            s.advance_exception_decided_billing_terms,   s.billing_terms), false);
  end if;

  select * into v_hold from public.order_advance_holds h where h.order_id = o.id and h.resolved_at is null;

  return jsonb_build_object(
    'order_value',  o.total_value,
    'value_known',  v_known,
    'value_epoch',  o.value_epoch,
    'pi_version_id', v_version,
    'verified',     v_verified,
    'awaiting',     v_awaiting,
    'required',     v_required,
    'shortfall',    v_short,
    'percent',      case when v_known then round(100 * v_verified / o.total_value, 2) end,
    'threshold_percent', public.order_submission_standard_advance_percent(),
    'below',        not v_known or v_short > 0,
    'exception',    case when v_exc.id is not null then jsonb_build_object(
                      'source', 'order', 'approved_by', v_exc.approved_by, 'approved_at', v_exc.approved_at,
                      'reason', v_exc.reason, 'order_value', v_exc.order_value)
                    when v_pi_exc then jsonb_build_object('source', 'pi', 'approved_by', s.advance_exception_decided_by,
                      'approved_at', s.advance_exception_decided_at)
                    end,
    'hold',         case when v_hold.id is not null then jsonb_build_object(
                      'id', v_hold.id, 'cause', v_hold.cause, 'held_at', v_hold.held_at,
                      'order_value', v_hold.order_value, 'previous_order_value', v_hold.previous_order_value,
                      'verified', v_hold.verified, 'percent', v_hold.percent, 'shortfall', v_hold.shortfall)
                    end,
    -- 20270205000000: production needs the verified 40% or an Order-level
    -- (administrator's, with a reason) exception. The PI's own exception lets
    -- the PI become an Order; it no longer starts production by itself.
    'ready',        (v_known and v_short = 0) or v_exc.id is not null);
end;
$$;
revoke execute on function public.order_advance_position(uuid) from public, anon, authenticated, service_role;

do $chk$
begin
  if exists (select 1 from public.orders o
              where o.production_alignment = 'aligned'
                and not (public.order_advance_position(o.id) ->> 'ready')::boolean
                and not exists (select 1 from public.order_advance_holds h where h.order_id = o.id and h.resolved_at is null)) then
    raise exception 'ADVANCE_GATE_BLOCKED: an aligned Order relies only on its PI''s below-40%% exception; decide it (Order-level exception or payment) before applying this';
  end if;
  if position('or v_pi_exc)' in (select prosrc from pg_proc where oid = 'public.order_advance_position(uuid)'::regprocedure)) > 0 then
    raise exception 'ASSERTION FAILED: order_advance_position still counts the PI exception as ready';
  end if;
end $chk$;
