-- 20260920000000 — a Finance approver can verify a payment
-- ===========================================================================
-- HOTFIX. Reported as "Finance/Admin cannot verify a payment entered against a
-- PI", against PAY-REQ-2026-0038.
--
-- Most of that report is a UI defect and is fixed in the UI: verification was
-- reachable only from the review modal, which opened only by clicking a table
-- row, while the row's explicit View button opened the details modal, which had
-- no verification control at all. That needs no migration.
--
-- Underneath it, however, sat a SECOND and independent defect, and this
-- migration is only about that one:
--
--   A non-admin holding finance.approve could not verify ANY payment.
--   Not a PI payment, not an Order payment, not an Order Request payment.
--
-- WHY. 20260901000000 §4a added finance_payment_requests_guard_pending_decision
-- so that a finance.approve holder could DECIDE a pending request without being
-- able to rewrite it — the WITH CHECK of an RLS policy sees only the new row, so
-- it cannot say "the amount may not change". Its intent, in its own words, was
-- that "everyone else may change only the three decision columns" (status,
-- admin_note, updated_at).
--
-- But approve_finance_payment_request writes five: it also stamps approved_by
-- and approved_at, which is the whole point of an audit trail. The guard listed
-- both among the columns it refuses, so the sanctioned approval path raised
--
--   42501  Payment PAY-REQ-… may be approved or rejected, not edited
--
-- for every non-admin approver. Admins were exempt from the guard, so this never
-- showed up in admin testing — which is why the original report reads as a PI
-- problem rather than as this.
--
-- THE FIX, and why it is shaped this way. The guard is about a DIRECT client
-- UPDATE. approve_finance_payment_request is not that: it is SECURITY DEFINER,
-- it authenticates, it requires finance.approve, it takes a row lock, it
-- confirms the row is still pending, and the statement it then runs is fixed —
-- a caller cannot add a column to it. So the RPC marks the one payment it is
-- deciding, transaction-locally, and the guard steps aside for exactly that row.
--
-- This is the project's existing capability-marker pattern, used verbatim from
-- in_payment_allocation_release (20260918000000 §7): a marker pinned to a single
-- id, set immediately before the statement and cleared immediately after, behind
-- a predicate function no client role may execute.
--
-- WHAT THIS DOES NOT DO:
--   * It does not widen who may verify. The gate is still, and only,
--     actor_has_module_permission('finance', 'approve') — admin, or an explicit
--     finance.approve grant. finance.view, finance.view_all, finance.manage and
--     finance.allocate remain no route to verification.
--   * It does not change what verification writes, or what it means. Both
--     function bodies below are the DEPLOYED ones, extracted with
--     pg_get_functiondef and patched programmatically rather than retyped.
--   * It does not touch the guard's protection of anything else: a non-admin,
--     non-submitter still cannot edit a pending payment's amount, date, mode,
--     client or linkage.
--   * It does not touch the Order approval gate or the declared-advance rule.
--
-- FORWARD-ONLY. Both functions are restated with CREATE OR REPLACE at their
-- existing signatures, so grants and ACLs are preserved and no dependency is
-- dropped.

-- ─── 1. The capability marker ────────────────────────────────────────────────
--
-- True only inside the RPC's own UPDATE, and only for the payment it is
-- deciding. Transaction-local, so a failure between here and COMMIT cannot leak
-- it, and pinned to one id, so a second payment in the same transaction is not
-- covered by the first one's marker.

create or replace function public.in_finance_payment_verification(p_request_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(current_setting('boe.finance_payment_verification', true), ''), '')
         = p_request_id::text
$$;

comment on function public.in_finance_payment_verification(uuid) is
  'True only inside a transaction where approve_finance_payment_request() is verifying THIS payment. Transaction-local, pinned to one payment id, and not settable by any client.';

-- Not a client-callable function. It exists for the guard trigger, which runs
-- SECURITY DEFINER and therefore does not need the grant.
revoke execute on function public.in_finance_payment_verification(uuid)
  from public, anon, authenticated;

-- ─── 2. The guard steps aside for the sanctioned door ────────────────────────
--
-- Deployed body, unchanged except for the one pass-through marked below. Every
-- other exemption and every refused column is exactly as 20260901000000 §4a
-- left it.

CREATE OR REPLACE FUNCTION public.finance_payment_requests_guard_pending_decision()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return new;
  end if;

  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return new;
  end if;

  -- THE SANCTIONED APPROVAL DOOR. approve_finance_payment_request marks the one
  -- payment it is deciding, transaction-locally, for the duration of its own
  -- UPDATE. By the time that marker is set the RPC has already authenticated
  -- the caller, required finance.approve, locked the row and confirmed it is
  -- still pending; the statement it then runs is fixed and writes only the
  -- decision columns plus approved_by/approved_at.
  --
  -- Without this, a non-admin finance.approve holder could not verify ANY
  -- payment: this guard lets them write status/admin_note/updated_at, but the
  -- RPC also stamps WHO verified and WHEN, and that stamp tripped the guard.
  if public.in_finance_payment_verification(old.id) then
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
$function$;

comment on function public.finance_payment_requests_guard_pending_decision() is
  'Restricts a non-admin, non-submitter updating a pending payment request to the decision columns (status, admin_note, updated_at), except inside approve_finance_payment_request(), which also stamps approved_by/approved_at on the one payment it is verifying.';

-- ─── 3. The RPC marks the payment it is deciding ─────────────────────────────
--
-- Deployed body, unchanged except for the two set_config calls around its own
-- UPDATE. No authorization, no status rule, no linkage rule and no returned
-- field is altered.

CREATE OR REPLACE FUNCTION public.approve_finance_payment_request(p_request_id uuid, p_admin_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Transaction-local and pinned to THIS payment, so nothing else in the same
  -- transaction inherits it. Cleared immediately after the statement.
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
$function$;

comment on function public.approve_finance_payment_request(uuid, text) is
  'Verifies a pending payment request: admin or finance.approve only. A confirmed-order payment links straight through to approved_linked; every other payment — including one recorded against a PI — confirms receipt only, landing in approved_unlinked with order_id left null and its allocation untouched.';

-- ─── 4. Apply-time assertions ────────────────────────────────────────────────
--
-- These run against the real deployed objects at apply time, so a migration that
-- lands in a shape the code above did not intend fails loudly here rather than
-- quietly in production.

do $$
declare v_def text;
begin
  -- The marker predicate exists and is reachable by no client role.
  if to_regprocedure('public.in_finance_payment_verification(uuid)') is null then
    raise exception 'in_finance_payment_verification(uuid) was not created';
  end if;

  if has_function_privilege('authenticated', 'public.in_finance_payment_verification(uuid)', 'execute')
     or has_function_privilege('anon', 'public.in_finance_payment_verification(uuid)', 'execute') then
    raise exception 'in_finance_payment_verification must not be executable by a client role';
  end if;

  -- The guard still refuses the columns it was created to refuse. If a future
  -- edit drops one of these, this migration's claim that it "does not touch the
  -- guard's protection of anything else" stops being true.
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'finance_payment_requests_guard_pending_decision';

  if v_def not like '%in_finance_payment_verification(old.id)%' then
    raise exception 'the guard did not gain the verification pass-through';
  end if;

  if v_def not like '%new.amount%' or v_def not like '%new.payment_date%'
     or v_def not like '%new.client_name%' or v_def not like '%new.order_id%'
     or v_def not like '%new.request_number%' then
    raise exception 'the guard no longer refuses the columns it was created to refuse';
  end if;

  -- Verification is still gated on finance.approve and nothing else.
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'approve_finance_payment_request';

  if v_def not like '%actor_has_module_permission(''finance'', ''approve'')%' then
    raise exception 'verification is no longer gated on finance.approve';
  end if;

  if v_def like '%''view_all''%' or v_def like '%''manage''%' or v_def like '%''allocate''%' then
    raise exception 'verification must not consult view_all, manage or allocate';
  end if;

  -- The marker is set and cleared around the UPDATE, not left open.
  if v_def not like '%set_config(''boe.finance_payment_verification'', p_request_id::text, true)%'
     or v_def not like '%set_config(''boe.finance_payment_verification'', '''', true)%' then
    raise exception 'the RPC must both set and clear its verification marker';
  end if;

  -- Exactly one verification function, at exactly one signature. No second
  -- approval flow was introduced by this hotfix.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'approve_finance_payment_request') <> 1 then
    raise exception 'approve_finance_payment_request must remain a single function at a single signature';
  end if;
end $$;
