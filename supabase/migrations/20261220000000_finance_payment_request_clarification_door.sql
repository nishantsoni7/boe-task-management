-- ═══════════════════════════════════════════════════════════════════════════
-- Sending a payment back for clarification gets its own server-gated door
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. Found 2026-09-19 during the PR #172 launch audit and verified
-- read-only against production's catalog.
--
-- The Finance review modal (/finance, Payment Requests → Review) sent "Needs
-- Clarification" and "Reject" as a DIRECT client UPDATE of
-- finance_payment_requests. That table carries
-- finance_payment_requests_reset_write_guard, which runs
-- public.order_finance_reset_write_guard() (20261010000000). The guard is NOT
-- security definer, so it runs as the caller, and its first two statements call
-- public.in_test_data_cleanup() and public.open_order_finance_reset_scope() —
-- neither of which authenticated may EXECUTE (has_function_privilege = false in
-- production). So every direct client write to the table fails with
--
--   permission denied for function in_test_data_cleanup
--
-- and a verifier cannot send a payment back or reject it from Finance.
--
-- WHY NOT MAKE THE GUARD SECURITY DEFINER. That would bring back every direct
-- client write that RLS admits, on all sixteen Order and Finance tables the guard
-- sits on — writes that have been refused since 20261010000000 and are not
-- covered by any test that executes them. The review modal needs two decisions,
-- not a wider table. So the guard stays exactly as it is.
--
-- WHAT THIS MIGRATION DOES
--
--   request_finance_payment_clarification(uuid, text), the clarification door.
--   It is reject_finance_payment_request() (20261211000000) with one word
--   changed: the same authority as approval (actor_has_module_permission(
--   'finance', 'approve')), never for the person who recorded the payment
--   (unless an admin), a required note, the row locked, pending only, and
--   status + note written in one statement — so the activity log, the status
--   timestamps and the Order echo record the verifier as the actor, exactly as a
--   rejection does.
--
--   It is SECURITY DEFINER with a fixed search_path, so its UPDATE passes the
--   reset write guard as the function owner. The guard still REFUSES it while a
--   module reset is in flight: stepping aside is decided by the guard, not by
--   who calls it.
--
--   Rejection already has its door (reject_finance_payment_request); the
--   frontend now uses it. It is not re-emitted here.
--
-- WHAT IT DOES NOT DO. No table, column, policy, trigger or grant on any table
-- changes. order_finance_reset_write_guard(), the decision guard and both
-- existing decision RPCs are untouched. No permission action is added.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.reject_finance_payment_request(uuid, text)') is null
     or to_regprocedure('public.finance_payment_requests_guard_decision_status()') is null then
    raise exception 'DEPENDENCY MISSING: 20261211000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260901000000 must be applied before this migration';
  end if;
end $$;


create or replace function public.request_finance_payment_clarification(
  p_request_id uuid,
  p_note       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_req   public.finance_payment_requests%rowtype;
  v_now   timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Authentication required to send a payment request back for clarification'
      using errcode = '28000';
  end if;

  -- The SAME authority as approve_finance_payment_request and
  -- reject_finance_payment_request, and nothing wider.
  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only a payment verifier may send a payment request back for clarification'
      using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'PAYMENT_CLARIFICATION_NOTE_REQUIRED: explain what clarification is needed.'
      using errcode = '22023';
  end if;

  select * into v_req
  from public.finance_payment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  -- Separation of entry and decision. The decision guard refuses it too; saying
  -- it here first gives the caller the reason rather than a generic refusal.
  if v_req.submitted_by = v_actor
     and not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    raise exception 'PAYMENT_SELF_DECISION_FORBIDDEN: payment % was recorded by you; another payment verifier must decide it',
      v_req.request_number
      using errcode = '42501';
  end if;

  if v_req.status <> 'pending_approval' then
    raise exception 'Only a pending payment request can be sent back for clarification (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- One statement: status and note land together, and the activity-log and
  -- timeline triggers record auth.uid() — this verifier — as the actor.
  update public.finance_payment_requests
     set status     = 'needs_clarification',
         admin_note = v_note,
         updated_at = v_now
   where id = p_request_id;

  return jsonb_build_object(
    'request_id',     v_req.id,
    'request_number', v_req.request_number,
    'status',         'needs_clarification',
    'clarification_requested_at', v_now
  );
end;
$$;

comment on function public.request_finance_payment_clarification(uuid, text) is
  'Sends a pending payment back for clarification, for a caller holding finance.approve — the approval authority — who did not record it (admins excepted). Requires a non-blank note, locks the row, refuses anything not pending_approval, and writes status and note in one statement so the activity trail records the verifier. The twin of reject_finance_payment_request.';

revoke execute on function public.request_finance_payment_clarification(uuid, text) from public, anon;
grant  execute on function public.request_finance_payment_clarification(uuid, text) to authenticated;


-- ─── Assertions, on the DEPLOYED objects ────────────────────────────────────

do $$
declare
  v_body text := pg_get_functiondef('public.request_finance_payment_clarification(uuid, text)'::regprocedure);
  v_cfg  text[];
begin
  if not (select prosecdef from pg_proc where oid = 'public.request_finance_payment_clarification(uuid, text)'::regprocedure) then
    raise exception 'ASSERTION FAILED: request_finance_payment_clarification is not SECURITY DEFINER';
  end if;
  select proconfig into v_cfg from pg_proc where oid = 'public.request_finance_payment_clarification(uuid, text)'::regprocedure;
  if v_cfg is null or not ('search_path=public, pg_temp' = any(v_cfg)) then
    raise exception 'ASSERTION FAILED: request_finance_payment_clarification has no fixed search_path (%)', v_cfg;
  end if;

  if v_body not like '%actor_has_module_permission(''finance'', ''approve'')%' then
    raise exception 'ASSERTION FAILED: clarification is not gated on finance.approve';
  end if;
  if v_body like '%''view_all''%' or v_body like '%''manage''%' or v_body like '%''allocate''%' then
    raise exception 'ASSERTION FAILED: clarification became reachable through a wider permission';
  end if;
  if v_body not like '%PAYMENT_SELF_DECISION_FORBIDDEN%' then
    raise exception 'ASSERTION FAILED: clarification does not refuse the person who recorded the payment';
  end if;
  if v_body not like '%PAYMENT_CLARIFICATION_NOTE_REQUIRED%' then
    raise exception 'ASSERTION FAILED: clarification does not require a note';
  end if;
  if v_body not like '%for update%' or v_body not like '%v_req.status <> ''pending_approval''%' then
    raise exception 'ASSERTION FAILED: clarification does not lock the row and require it to be pending';
  end if;
  if v_body not like '%auth.uid()%' then
    raise exception 'ASSERTION FAILED: the verifier is not derived from auth.uid()';
  end if;

  if not has_function_privilege('authenticated', 'public.request_finance_payment_clarification(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot call the clarification RPC';
  end if;
  if has_function_privilege('anon', 'public.request_finance_payment_clarification(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can call the clarification RPC';
  end if;

  raise notice '20261220000000 applied: a verifier sends a payment back for clarification through request_finance_payment_clarification().';
end $$;
