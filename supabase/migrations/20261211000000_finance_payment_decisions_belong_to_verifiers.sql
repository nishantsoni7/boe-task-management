-- ═══════════════════════════════════════════════════════════════════════════
-- A payment decision belongs to a payment verifier who did not record it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. Found by EXECUTING every write a PostgREST client can send, as
-- every Finance role, against the deployed policy and trigger stack on
-- finance_payment_requests — not by reading it.
--
-- Permissive UPDATE policies are OR-ed, and PostgreSQL ORs their USING clauses
-- and their WITH CHECK clauses SEPARATELY. A row admitted by one policy's USING
-- may therefore leave through a DIFFERENT policy's WITH CHECK:
--
--   finance_payment_requests_own_update       USING      the submitter, on a
--                                                        pending / sent-back /
--                                                        rejected row
--   finance_payment_requests_approver_decide  WITH CHECK status in (rejected,
--                                                        needs_clarification)
--                                                        — and nothing about WHO
--   finance_payment_requests_manager_correct  WITH CHECK status in (approved_*)
--                                                        — and nothing about WHO
--
-- So, with nothing more than Finance entry (finance.view), the person who
-- RECORDED a payment could, by a direct API call:
--
--   * reject their own pending payment, or send it back for clarification;
--   * mark their own pending or rejected payment approved_unlinked — a payment
--     the PI timeline then shows as payment_verified, with no verifier stamped
--     and none of its allocation intents applied;
--   * write, replace or clear admin_note — the Finance decision note the
--     Finance and PI screens show as "Finance note" / "Rejection reason";
--
-- a finance.approve holder could set approved_* directly, skipping
-- approve_finance_payment_request() and everything it does, and could decide a
-- payment they had recorded themselves; a finance.manage holder could move an
-- ALREADY VERIFIED payment to rejected or send it back — the one thing
-- manager_correct was written to forbid; and anybody with Finance entry could
-- INSERT a payment that was verified (stamping any approver), rejected, or
-- carrying a Finance note from birth, because finance_payment_requests_own_insert
-- checks only submitted_by.
--
-- The trail recorded the true actor every time (auth.uid()), so none of this
-- was invisible. It was a decision taken by somebody without the authority to
-- take it.
--
-- WHY A TRIGGER AND NOT A POLICY. RLS cannot pair OLD with NEW: WITH CHECK
-- sees only the new row, USING only the old one. "Rejected, but only from
-- pending, only by a verifier, and never by the person who recorded it" is a
-- statement about the TRANSITION and the ACTOR together, so it lives where both
-- rows are visible — a BEFORE trigger shaped exactly like its siblings
-- finance_payment_requests_guard_pending_decision and
-- finance_payment_requests_guard_approved. It sits UNDER every door — the
-- approval RPC, the rejection RPC, the Finance dialogs' direct UPDATE, a
-- hand-written API call — so no door can be forgotten.
--
-- WHAT THIS MIGRATION DOES
--
--   1. finance_payment_requests_guard_decision_status(), BEFORE INSERT OR
--      UPDATE. Admins and service-role / direct SQL (auth.uid() is null) pass
--      through, exactly as in the sibling guards. For everybody else:
--
--      Recording is not deciding.
--        * A new payment is born pending_approval, with no approver stamped and
--          no Finance note — which is what every payment-entry RPC inserts.
--
--      Separation of entry and decision.
--        * Nobody approves, rejects or sends back a payment they recorded
--          (submitted_by), whatever permissions they hold. This covers
--          approve_finance_payment_request(), whose status UPDATE fires this
--          trigger, as well as the rejection RPC and every direct UPDATE.
--
--      Status transitions.
--        * into approved_*   only inside approve_finance_payment_request(),
--                            recognised by the transaction-local marker that
--                            RPC already sets for the one payment it decides;
--        * out of approved_* never;
--        * into rejected or  only from pending_approval, and only for a caller
--          needs_clarification holding finance.approve — the approval gate; a
--                            rejection must carry a reason.
--
--      The Finance note (admin_note).
--        * The person who recorded the payment never creates, edits, replaces
--          or clears it.
--        * Anyone else changes it only as part of a decision they are allowed
--          to make — approving (the RPC), rejecting or sending back a pending
--          payment (finance.approve) — or while correcting an already verified
--          payment (finance.manage, the existing correction authority).
--
--      Everything else — the submitter's own amount, date, mode, reference
--      (proof_note) and sales_note on a pending payment, reapplication into
--      pending_approval, link/unlink between the two approved statuses, every
--      manager correction of a verified payment — is left to the policies and
--      guards that already decide it.
--
--   2. reject_finance_payment_request(uuid, text), the rejection door: the same
--      authorization as approval (actor_has_module_permission('finance',
--      'approve')), never for the person who recorded the payment (unless an
--      admin), a required reason, the row locked, pending only, and status +
--      reason written in one statement so the existing activity and timeline
--      triggers record the verifier as the actor.
--
-- WHAT IT DOES NOT DO. No policy is dropped, created or altered. No column,
-- constraint or grant on the table changes. approve_finance_payment_request()
-- is not re-emitted; the separation rule reaches it through its own UPDATE. No
-- amount, allocation, summary or numbering logic is touched.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.in_finance_payment_verification(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260920000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260901000000 must be applied before this migration';
  end if;
  if pg_get_functiondef('public.approve_finance_payment_request(uuid, text)'::regprocedure)
       not like '%set_config(''boe.finance_payment_verification'', p_request_id::text, true)%' then
    raise exception 'DEPENDENCY MISSING: 20261118000000 must be applied first — without the approval marker this guard would refuse every non-admin verification';
  end if;
end $$;


-- ─── 1. The decision guard ──────────────────────────────────────────────────

create or replace function public.finance_payment_requests_guard_decision_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_self         boolean;
  v_was_verified boolean;
  v_is_verified  boolean;
begin
  -- Neither a decision nor the Finance note. Every other column is someone
  -- else's guard.
  if tg_op = 'UPDATE'
     and new.status     is not distinct from old.status
     and new.admin_note is not distinct from old.admin_note then
    return new;
  end if;

  -- Service-role / direct SQL, and admins, exactly as the sibling guards.
  if v_actor is null then
    return new;
  end if;

  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return new;
  end if;

  -- RECORDING a payment is not deciding it. Every payment-entry RPC inserts
  -- pending_approval with no approver and no Finance note; a hand-written
  -- insert may not do more.
  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending_approval'
       or new.approved_by is not null
       or new.approved_at is not null then
      raise exception 'A payment is recorded as awaiting verification; only Finance can decide it'
        using errcode = '42501';
    end if;
    if new.admin_note is not null then
      raise exception 'FINANCE_NOTE_PROTECTED: the Finance note on a payment is written by Finance, not by the person recording it'
        using errcode = '42501';
    end if;
    return new;
  end if;

  v_self         := old.submitted_by = v_actor or new.submitted_by = v_actor;
  v_was_verified := old.status in ('approved_linked', 'approved_unlinked');
  v_is_verified  := new.status in ('approved_linked', 'approved_unlinked');

  if new.status is distinct from old.status then

    -- SEPARATION OF ENTRY AND DECISION. Checked before anything else, so it
    -- holds inside approve_finance_payment_request() too: the marker proves the
    -- sanctioned door, not that the right person is standing in it.
    if coalesce(v_self, false)
       and ((v_is_verified and not v_was_verified)
            or new.status in ('rejected', 'needs_clarification')) then
      raise exception 'PAYMENT_SELF_DECISION_FORBIDDEN: payment % was recorded by you; another payment verifier must decide it', old.request_number
        using errcode = '42501';
    end if;

    if v_is_verified and not v_was_verified then
      -- VERIFYING is one door. approve_finance_payment_request() has already
      -- required finance.approve, locked the row and confirmed it is pending
      -- when it marks this payment; nothing else sets the marker.
      if not public.in_finance_payment_verification(old.id) then
        raise exception 'Payment % can be verified only through Verify Payment', old.request_number
          using errcode = '42501';
      end if;

    elsif v_was_verified and not v_is_verified then
      -- A VERIFIED payment is not un-verified by a status write. Moving between
      -- the two approved statuses (link / unlink) is not caught here.
      raise exception 'Payment % has been verified and its status can no longer be changed', old.request_number
        using errcode = '42501';

    elsif new.status in ('rejected', 'needs_clarification') then
      -- REJECTING or SENDING BACK is the verifier's decision on a pending payment.
      if old.status is distinct from 'pending_approval'
         or not public.actor_has_module_permission('finance', 'approve') then
        raise exception 'Payment % can be rejected or sent back only by a payment verifier while it awaits verification', old.request_number
          using errcode = '42501';
      end if;
      if new.status = 'rejected' and nullif(btrim(coalesce(new.admin_note, '')), '') is null then
        raise exception 'PAYMENT_REJECTION_REASON_REQUIRED: enter a reason before rejecting this payment.'
          using errcode = '22023';
      end if;
    end if;
  end if;

  -- THE FINANCE NOTE. Reaching here with a changed status means the transition
  -- above was allowed, so a pending → rejected / needs_clarification change is
  -- already a permitted verifier decision.
  if new.admin_note is distinct from old.admin_note then
    if coalesce(v_self, false) then
      raise exception 'FINANCE_NOTE_PROTECTED: the Finance note on payment % is written by Finance, not by the person who recorded it', old.request_number
        using errcode = '42501';
    end if;
    if not (
         public.in_finance_payment_verification(old.id)
      or (old.status = 'pending_approval' and new.status in ('rejected', 'needs_clarification'))
      or (v_was_verified and v_is_verified and public.actor_has_module_permission('finance', 'manage'))
    ) then
      raise exception 'FINANCE_NOTE_PROTECTED: the Finance note on payment % changes only with a Finance decision or correction', old.request_number
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.finance_payment_requests_guard_decision_status() is
  'Pairs OLD and NEW on finance_payment_requests, which RLS cannot. For a non-admin: a new payment is pending_approval with no approver and no admin_note; nobody approves, rejects or sends back a payment they recorded; into approved_* only inside approve_finance_payment_request(); never out of approved_*; into rejected / needs_clarification only from pending_approval, only with finance.approve, and a rejection needs a reason; admin_note is never changed by the submitter, and by anyone else only with a permitted decision or a finance.manage correction of a verified payment. Admin and service-role writes pass through.';

revoke execute on function public.finance_payment_requests_guard_decision_status()
  from public, anon, authenticated;

drop trigger if exists finance_payment_requests_guard_decision_status on public.finance_payment_requests;

create trigger finance_payment_requests_guard_decision_status
  before insert or update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_decision_status();


-- ─── 2. The rejection door ──────────────────────────────────────────────────

create or replace function public.reject_finance_payment_request(
  p_request_id uuid,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_req    public.finance_payment_requests%rowtype;
  v_now    timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Authentication required to reject a payment request'
      using errcode = '28000';
  end if;

  -- The SAME authority as approve_finance_payment_request, and nothing wider.
  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only a payment verifier may reject a payment request'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'PAYMENT_REJECTION_REASON_REQUIRED: enter a reason before rejecting this payment.'
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

  -- Separation of entry and decision. The guard refuses it too; saying it here
  -- first gives the caller the reason rather than a generic refusal.
  if v_req.submitted_by = v_actor
     and not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    raise exception 'PAYMENT_SELF_DECISION_FORBIDDEN: payment % was recorded by you; another payment verifier must decide it',
      v_req.request_number
      using errcode = '42501';
  end if;

  if v_req.status <> 'pending_approval' then
    raise exception 'Only a pending payment request can be rejected (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- One statement: status and reason land together, and the activity-log and
  -- timeline triggers record auth.uid() — this verifier — as the actor.
  update public.finance_payment_requests
     set status     = 'rejected',
         admin_note = v_reason,
         updated_at = v_now
   where id = p_request_id;

  return jsonb_build_object(
    'request_id',     v_req.id,
    'request_number', v_req.request_number,
    'status',         'rejected',
    'rejected_at',    v_now
  );
end;
$$;

comment on function public.reject_finance_payment_request(uuid, text) is
  'Rejects a pending payment for a caller holding finance.approve — the approval authority — who did not record it (admins excepted). Requires a non-blank reason, locks the row, refuses anything not pending_approval, and writes status and reason in one statement so the activity trail records the verifier.';

revoke execute on function public.reject_finance_payment_request(uuid, text) from public, anon;
grant  execute on function public.reject_finance_payment_request(uuid, text) to authenticated;


-- ─── Assertions, on the DEPLOYED objects ────────────────────────────────────

do $$
declare
  v_guard  text := pg_get_functiondef('public.finance_payment_requests_guard_decision_status()'::regprocedure);
  v_reject text := pg_get_functiondef('public.reject_finance_payment_request(uuid, text)'::regprocedure);
  v_n      integer;
begin
  -- The trigger exists, is enabled, is BEFORE INSERT OR UPDATE and row-level.
  select count(*) into v_n
  from pg_trigger t
  where t.tgrelid = 'public.finance_payment_requests'::regclass
    and t.tgname  = 'finance_payment_requests_guard_decision_status'
    and t.tgenabled = 'O'
    and (t.tgtype & 1) = 1      -- ROW
    and (t.tgtype & 2) = 2      -- BEFORE
    and (t.tgtype & 4) = 4      -- INSERT
    and (t.tgtype & 16) = 16;   -- UPDATE
  if v_n <> 1 then
    raise exception 'ASSERTION FAILED: the decision guard is not an enabled BEFORE INSERT OR UPDATE row trigger';
  end if;

  -- The guard's rules are the ones described above.
  if v_guard not like '%tg_op = ''INSERT''%' or v_guard not like '%new.status is distinct from ''pending_approval''%' then
    raise exception 'ASSERTION FAILED: the guard does not confine a new payment to pending_approval';
  end if;
  if v_guard not like '%PAYMENT_SELF_DECISION_FORBIDDEN%' or v_guard not like '%old.submitted_by = v_actor%' then
    raise exception 'ASSERTION FAILED: the guard does not separate recording a payment from deciding it';
  end if;
  if position('PAYMENT_SELF_DECISION_FORBIDDEN' in v_guard) > position('in_finance_payment_verification(old.id)' in v_guard) then
    raise exception 'ASSERTION FAILED: the separation rule must be checked before the approval marker admits a verification';
  end if;
  if v_guard not like '%in_finance_payment_verification(old.id)%' then
    raise exception 'ASSERTION FAILED: the guard does not recognise the approval RPC';
  end if;
  if v_guard not like '%actor_has_module_permission(''finance'', ''approve'')%' then
    raise exception 'ASSERTION FAILED: the guard does not require finance.approve for a rejection';
  end if;
  if v_guard not like '%old.status is distinct from ''pending_approval''%' then
    raise exception 'ASSERTION FAILED: the guard does not confine a rejection to a pending payment';
  end if;
  if v_guard not like '%PAYMENT_REJECTION_REASON_REQUIRED%' then
    raise exception 'ASSERTION FAILED: the guard does not require a reason for a direct rejection';
  end if;
  if v_guard not like '%FINANCE_NOTE_PROTECTED%' or v_guard not like '%new.admin_note is distinct from old.admin_note%' then
    raise exception 'ASSERTION FAILED: the guard does not protect the Finance note';
  end if;

  -- The RPC: security definer, the approval gate, separation, a reason, a lock,
  -- pending only, the actor from auth.uid(), and no wider permission.
  if not (select prosecdef from pg_proc where oid = 'public.reject_finance_payment_request(uuid, text)'::regprocedure) then
    raise exception 'ASSERTION FAILED: reject_finance_payment_request is not SECURITY DEFINER';
  end if;
  if v_reject not like '%actor_has_module_permission(''finance'', ''approve'')%' then
    raise exception 'ASSERTION FAILED: rejection is not gated on finance.approve';
  end if;
  if v_reject like '%''view_all''%' or v_reject like '%''manage''%' or v_reject like '%''allocate''%' then
    raise exception 'ASSERTION FAILED: rejection became reachable through a wider permission';
  end if;
  if v_reject not like '%PAYMENT_SELF_DECISION_FORBIDDEN%' then
    raise exception 'ASSERTION FAILED: rejection does not refuse the person who recorded the payment';
  end if;
  if v_reject not like '%PAYMENT_REJECTION_REASON_REQUIRED%' then
    raise exception 'ASSERTION FAILED: rejection does not require a reason';
  end if;
  if v_reject not like '%for update%' or v_reject not like '%v_req.status <> ''pending_approval''%' then
    raise exception 'ASSERTION FAILED: rejection does not lock the row and require it to be pending';
  end if;
  if v_reject not like '%auth.uid()%' then
    raise exception 'ASSERTION FAILED: the rejecting employee is not derived from auth.uid()';
  end if;

  -- Grants: authenticated may reject; anon may not; nobody calls the guard.
  if not has_function_privilege('authenticated', 'public.reject_finance_payment_request(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot call the rejection RPC';
  end if;
  if has_function_privilege('anon', 'public.reject_finance_payment_request(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can call the rejection RPC';
  end if;
  if has_function_privilege('authenticated', 'public.finance_payment_requests_guard_decision_status()', 'execute')
     or has_function_privilege('anon', 'public.finance_payment_requests_guard_decision_status()', 'execute') then
    raise exception 'ASSERTION FAILED: a client role can call the decision guard';
  end if;

  -- Nothing else moved: the four UPDATE policies are the four that existed,
  -- approval is still one function at one signature, and still marks its row.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public' and tablename = 'finance_payment_requests' and cmd = 'UPDATE'
    and policyname in ('finance_payment_requests_admin_update',
                       'finance_payment_requests_own_update',
                       'finance_payment_requests_approver_decide',
                       'finance_payment_requests_manager_correct');
  if v_n <> 4 or (select count(*) from pg_policies
                  where schemaname = 'public' and tablename = 'finance_payment_requests' and cmd = 'UPDATE') <> 4 then
    raise exception 'ASSERTION FAILED: the UPDATE policy set on finance_payment_requests changed';
  end if;

  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'approve_finance_payment_request';
  if v_n <> 1 then
    raise exception 'ASSERTION FAILED: % approval function(s) exist; expected exactly one', v_n;
  end if;
  if pg_get_functiondef('public.approve_finance_payment_request(uuid, text)'::regprocedure)
       not like '%set_config(''boe.finance_payment_verification'', p_request_id::text, true)%' then
    raise exception 'ASSERTION FAILED: the approval RPC no longer marks the payment it decides';
  end if;

  raise notice '20261211000000 applied: payment decisions belong to payment verifiers who did not record them.';
end $$;
