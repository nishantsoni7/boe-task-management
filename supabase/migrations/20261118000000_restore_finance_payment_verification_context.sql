-- ═══════════════════════════════════════════════════════════════════════════
-- Restore the payment-approval guard context
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. A non-admin holding finance.approve cannot approve a payment
-- somebody else submitted. The attempt fails with
--
--   Payment PAY-REQ-2026-nnnn may be approved or rejected, not edited  (42501)
--
-- HOW IT HAPPENED. 20260901000000 §4a made
-- finance_payment_requests_guard_pending_decision() refuse a non-admin,
-- non-submitter who writes approved_by / approved_at / order_id / order_number
-- on a pending payment. approve_finance_payment_request() writes exactly those
-- columns, so the sanctioned approval door tripped its own guard.
--
-- 20260920000000 fixed that by opening ONE hole in the guard —
-- in_finance_payment_verification(old.id) — and having the RPC mark the single
-- payment it is deciding, transaction-locally, for the duration of its own
-- UPDATE. That migration asserted on itself that the RPC both SETS and CLEARS
-- the marker.
--
-- 20261013000000 §5 then re-emitted approve_finance_payment_request in full to
-- attach allocation intents, and the two set_config lines were not carried
-- across. Nothing failed at apply time, because that migration asserted on the
-- allocation behaviour it was adding and not on the marker it was dropping. The
-- guard and the predicate both survived intact; only the caller stopped
-- speaking to them.
--
-- WHAT THIS MIGRATION DOES. Re-emits approve_finance_payment_request as
-- 20261013000000 left it, plus the two marker lines, and NOTHING else. The
-- guard is not touched, no exemption is widened, no grant is changed, and the
-- required permission is still finance.approve.
--
-- WHY ONLY THE APPROVAL PATH. Rejection and needs_clarification are written by
-- the Finance UI as a direct UPDATE of admin_note, status and updated_at —
-- three columns the guard already permits a non-admin non-submitter to write.
-- They never needed the marker and are untouched here.
--
-- WHY THE WINDOW IS THIS NARROW. The marker is cleared immediately after the
-- decision statement, before apply_payment_allocation_intents() runs. Anything
-- after that statement sees old.status <> 'pending_approval' and leaves the
-- guard by its first branch, so it needs no marker and must not have one.
--
-- ADDITIVE. No column, policy, trigger or grant changes. One function body.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.approve_finance_payment_request(uuid, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20261013000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.in_finance_payment_verification(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260920000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.apply_payment_allocation_intents(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: apply_payment_allocation_intents is required by the re-emitted body';
  end if;
end $$;


-- ─── The RPC, as 20261013000000 left it, plus the marker ────────────────────

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
  v_intents     jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required to approve a payment request'
      using errcode = '28000';
  end if;

  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only an admin may approve a payment request'
      using errcode = '42501';
  end if;

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
  end if;

  select * into v_req
  from public.finance_payment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  if v_req.status <> 'pending_approval' then
    raise exception 'Only a pending payment request can be approved (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  if v_req.order_request_id is distinct from v_peek.order_request_id then
    raise exception 'PAYMENT_TARGET_CHANGED: The target of payment % changed while it was being approved. Refresh and try again.',
      v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.payment_target_type = 'confirmed_order' then
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
    v_order_id := null;
    v_number   := null;
    v_status   := 'approved_unlinked';

    if v_req.order_request_id is not null then
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

  perform set_config('boe.finance_payment_verification', p_request_id::text, true);

  update public.finance_payment_requests
     set status       = v_status,
         order_id     = v_order_id,
         order_number = v_number,
         approved_by  = v_actor,
         approved_at  = v_now,
         admin_note   = p_admin_note,
         updated_at   = v_now
   where id = p_request_id;

  perform set_config('boe.finance_payment_verification', '', true);

  -- ── NEW: verification attaches the money ──
  --
  -- Inside this transaction and after the status is verified. A failure here —
  -- a PI deleted since submission, an Order cancelled, a balance no longer
  -- sufficient — raises out of approve_finance_payment_request entirely, so the
  -- status update above rolls back with it. There is no state in which the
  -- payment is approved and its intent half-converted.
  v_intents := public.apply_payment_allocation_intents(p_request_id);

  return jsonb_build_object(
    'request_id',            v_req.id,
    'request_number',        v_req.request_number,
    'status',                 v_status,
    'payment_target_type',    v_req.payment_target_type,
    'order_id',               v_order_id,
    'order_display_number',   v_number,
    'order_request_id',       v_req.order_request_id,
    'order_request_number',   v_req.order_request_number,
    'approved_at',            v_now,
    'allocations_applied',    coalesce(v_intents->'applied_count', to_jsonb(0)),
    'allocations',            coalesce(v_intents->'applied', '[]'::jsonb)
  );
end;
$$;
comment on function public.approve_finance_payment_request(uuid, text) is
  'Verifies a pending payment for a caller holding finance.approve, links it to its Order where one is named, and applies its allocation intents. Since 20261118000000 it again marks the payment it is deciding (boe.finance_payment_verification) for the duration of its own decision UPDATE, which is the only way the pending-decision guard admits a non-admin approver stamping approved_by and approved_at.';

revoke execute on function public.approve_finance_payment_request(uuid, text) from public, anon;
grant  execute on function public.approve_finance_payment_request(uuid, text) to authenticated;


-- ─── Assertions ─────────────────────────────────────────────────────────────
--
-- 20260920000000 asserted the marker on itself and 20261013000000 did not,
-- which is exactly how it was lost. These assert it on the DEPLOYED body, so a
-- future re-emit that drops it again fails at apply time rather than in
-- production.

do $$
declare
  v_def   text := pg_get_functiondef('public.approve_finance_payment_request(uuid, text)'::regprocedure);
  v_guard text := pg_get_functiondef('public.finance_payment_requests_guard_pending_decision()'::regprocedure);
  v_set   integer;
  v_clear integer;
  v_upd   integer;
  v_n     integer;
begin
  if v_def not like '%set_config(''boe.finance_payment_verification'', p_request_id::text, true)%' then
    raise exception 'ASSERTION FAILED: the RPC does not mark the payment it is deciding';
  end if;
  if v_def not like '%set_config(''boe.finance_payment_verification'', '''', true)%' then
    raise exception 'ASSERTION FAILED: the RPC does not clear its marker';
  end if;

  -- The marker must BRACKET the decision UPDATE: set before it, cleared after.
  v_set   := position('set_config(''boe.finance_payment_verification'', p_request_id::text, true)' in v_def);
  v_clear := position('set_config(''boe.finance_payment_verification'', '''', true)' in v_def);
  v_upd   := position('update public.finance_payment_requests' in v_def);
  if v_set > v_upd then
    raise exception 'ASSERTION FAILED: the marker is set after the statement it must cover';
  end if;
  if v_clear < v_upd then
    raise exception 'ASSERTION FAILED: the marker is cleared before the statement it must cover';
  end if;

  -- Authorization is unchanged: approve, and nothing wider.
  if v_def not like '%actor_has_module_permission(''finance'', ''approve'')%' then
    raise exception 'ASSERTION FAILED: verification is no longer gated on finance.approve';
  end if;
  if v_def like '%actor_has_module_permission(''finance'', ''view_all'')%'
     or v_def like '%actor_has_module_permission(''finance'', ''manage'')%'
     or v_def like '%actor_has_module_permission(''finance'', ''allocate'')%' then
    raise exception 'ASSERTION FAILED: verification became reachable through a wider permission';
  end if;

  -- The actor is still derived server-side, never taken from an argument.
  if v_def not like '%auth.uid()%' then
    raise exception 'ASSERTION FAILED: the acting employee is no longer derived from auth.uid()';
  end if;

  -- The guard itself is untouched and still refuses everything it refused.
  select count(*) into v_n
  from regexp_matches(v_guard, 'new\.[a-z_]+\s+is distinct from', 'g');
  if v_n < 17 then
    raise exception 'ASSERTION FAILED: the pending-decision guard refuses only % column(s)', v_n;
  end if;
  if v_guard not like '%in_finance_payment_verification(old.id)%' then
    raise exception 'ASSERTION FAILED: the guard no longer consults the verification marker';
  end if;

  -- Exactly one approval function, at one signature. No second door.
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'approve_finance_payment_request';
  if v_n <> 1 then
    raise exception 'ASSERTION FAILED: % approval function(s) exist; expected exactly one', v_n;
  end if;

  -- The predicate stays unreachable by every client role.
  if has_function_privilege('authenticated', 'public.in_finance_payment_verification(uuid)', 'execute')
     or has_function_privilege('anon', 'public.in_finance_payment_verification(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: a client role can call in_finance_payment_verification';
  end if;

  -- The RPC stays callable by authenticated and by nobody wider.
  if not has_function_privilege('authenticated', 'public.approve_finance_payment_request(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot call the approval RPC';
  end if;
  if has_function_privilege('anon', 'public.approve_finance_payment_request(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can call the approval RPC';
  end if;

  raise notice '20261118000000 applied: the payment-approval guard context is restored.';
end $$;
