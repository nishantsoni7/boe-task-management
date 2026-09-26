-- ════════════════════════════════════════════════════════════════════════════
-- 20270120000000 — PI → ORDER → FINANCE: NO ADMIN WAITS FOR THE OTHER ADMIN.
--                  EVERY AUTHORITY IS A CONTROL CENTER PERMISSION.
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE BUSINESS RULE (owner, 2026-09-26). The two Admins of this flow have
-- equal authority; an action taken by either must not wait for the other's
-- approval. A payment either Admin records is saved AND verified in the same
-- completed action, so it counts toward the 40% rule at once, and the other
-- Admin is told for information only. A payment recorded by Sales or any
-- other non-Admin stays pending until an Admin verifies or rejects it. Who
-- holds each authority is decided in Control Center, and nowhere in code.
--
-- WHAT WAS IN THE WAY (production, read SELECT-only, 2026-09-26). The second
-- Admin is users.role 'manager' and already holds finance.approve,
-- orders.approve_order, orders.approve_advance_exception and
-- orders.align_production through Control Center — but these decisions asked
-- users.role = 'admin' instead of any permission:
--
--   * PAYMENT_SELF_DECISION_FORBIDDEN (finance_payment_requests_guard_decision_
--     status, reject_finance_payment_request, request_finance_payment_
--     clarification): only a role admin could decide a payment they recorded.
--     And every payment door inserts pending_approval, so even an admin's own
--     entry needed a second, separate verification before it counted.
--   * approve_order_advance_exception — production below 40% on an Order.
--   * approve / reject / reapprove_order_pi_revision, and the "approver is
--     still an active admin" test in decide_order_pi_revision_operations and
--     reapprove_order_pi_revision.
--   * decide_order_document_submission_admin.
--   * recover_order_production_alignment and order_advance_readiness.
--   * the "every active admin" recipient lists of create_order_document_
--     submission, decide_order_document_submission_admin, order_pi_versions_
--     record_operations_handoff and order_advance_hold_recheck.
--
-- WHAT THIS DOES, AND ONLY THIS:
--
--   §1  ONE NEW PERMISSION, finance.verify_own_payment ("Verify own payments"),
--       registered deny-by-default and PROTECTED (src/lib/permissions/
--       levels.ts), so no preset hands it out: it is granted per person in
--       Control Center or not at all. NOTHING HERE GRANTS IT TO ANYBODY. Its
--       holder's payments are verified in the same action they are recorded,
--       and the holder may decide a pending payment they recorded. It needs
--       finance.approve as well — the verification door still asks for that.
--   §2  Two per-user permission readers, for decisions about a user other
--       than the caller (the approver of a staged revision, the recipients of
--       a notification, the actor passed by the approve-revision route):
--         user_holds_permission(uid, module, action)   the grant alone
--         user_has_module_permission(uid, module, action)
--                                                 role admin OR the grant —
--       each exactly the per-user form of actor_has_permission /
--       actor_has_module_permission (active, non-deleted, resolve_permission).
--   §3  complete_payment_entry(uuid): the LAST call of every "Record payment"
--       action, made by the screen after the proof (if any) is attached. For a
--       caller who may verify their own payments (§1), on a payment they
--       recorded that is still pending, it verifies it through
--       approve_finance_payment_request — the ONE verification door,
--       unchanged, with every check it makes — and tells the other holders, for
--       information only (the payment is already verified, so the record it
--       opens offers no decision). For anybody else, or a payment no longer
--       pending, it changes nothing and answers with the status, so the screen
--       may call it unconditionally.
--   §4  WHY A SEPARATE CALL AND NOT INSIDE THE ENTRY RPCs. Proof is attached
--       after the payment row exists, and payment_proof_attachments_insert and
--       the payment-proofs storage policy admit a submitter's upload only while
--       the payment is pending_approval. Verifying inside the entry RPC would
--       have left every Admin entry unable to carry its proof. So the three
--       entry doors are NOT changed: the screen records, attaches the proof,
--       then completes — one action for the person pressing Save. If the last
--       call never arrives, the payment is simply pending, and its holder may
--       verify it themselves (§5).
--   §5  Every role test listed above asks a permission instead:
--         payment separation rule            finance.verify_own_payment
--         Order below-40% approval, hold     orders.approve_advance_exception
--           notification                      (the authority the PI-level
--                                              exception already uses)
--         PI revision approve / reject /     orders.approve_order
--           re-approve, the approver check,  (the "Approve PI / Confirm Order"
--           document admin decision and its   authority, permission-only as
--           notifications                     actor_can_approve_order is)
--         recover alignment, readiness       orders.align_production
--       The payment guard's role-admin early return is left exactly as it is.
--
-- WHAT IT DOES NOT DO. users.role changes for nobody. No existing permission,
-- grant, policy, column or table changes, and no module outside this flow is
-- touched. The 40% rule, exception reasons, required-data checks, the PI
-- approval route, the Operations handoff and its reviewer, deletion and the
-- test-data reset tools are unchanged. Every restated function below is
-- production's live definition with only the named expressions replaced
-- (src/lib/orders/permissionGatedAdminDecisions.test.ts proves it against the
-- definitions each one replaces).
--
-- AFTER RELEASE, IN CONTROL CENTER: grant Finance → "Verify own payments" to
-- whoever should record-and-verify in one step. Until then every payment,
-- including an admin's, is recorded pending exactly as before — except that a
-- role admin still keeps the admin branch (as everywhere in actor_has_module_
-- permission) and so verifies on entry.
--
-- Rollback: re-apply the definitions this file replaces (the latest earlier
-- definition of each function in supabase/migrations) and drop §2–§3's
-- functions; the §1 action can stay registered and ungranted.
-- ════════════════════════════════════════════════════════════════════════════

do $dep$
begin
  if to_regprocedure('public.approve_finance_payment_request(uuid, text)') is null
     or to_regprocedure('public.resolve_permission(uuid, text, text)') is null
     or to_regprocedure('public.approve_order_pi_revision(uuid, uuid, jsonb)') is null
     or to_regprocedure('public.order_advance_readiness(uuid)') is null
     or to_regprocedure('public.finance_payment_requests_keep_reference()') is null then
    raise exception 'DEPENDENCY MISSING: 20270111120000 and 20270116000000 must be applied before this migration';
  end if;
  -- The Record Payment sequence this file completes is record → attach proof →
  -- complete_payment_entry. The proof can be attached at all only once the
  -- reset write guard runs as its owner (20270117000000).
  if not (select p.prosecdef from pg_proc p
           where p.oid = 'public.order_finance_reset_write_guard()'::regprocedure) then
    raise exception 'DEPENDENCY MISSING: 20270117000000 (the Order/Finance write guards run as their owner) must be applied before this migration';
  end if;
  -- And the reviewer who verifies a payment must be able to open its proof
  -- (20270118120000), or the second Admin verifies blind.
  if to_regprocedure('public.can_open_payment_proof(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270118120000 (a payment''s proof opens for its reviewers) must be applied before this migration';
  end if;
end $dep$;


-- ═══ §1. finance.verify_own_payment ═════════════════════════════════════════

insert into public.permission_actions (action_key, display_name, is_system)
values ('verify_own_payment', 'Verify Own Payments', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'verify_own_payment'
where pm.module_key = 'finance'
on conflict (module_id, action_id) do nothing;


-- ═══ §2. Per-user permission readers ════════════════════════════════════════

create or replace function public.user_holds_permission(p_user_id uuid, p_module_key text, p_action_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_user_id is not null
     and exists (select 1 from public.users u
                  where u.id = p_user_id and u.is_active and coalesce(u.is_deleted, false) = false)
     and coalesce(public.resolve_permission(p_user_id, p_module_key, p_action_key), false);
$fn$;

comment on function public.user_holds_permission(uuid, text, text) is
  'True when an ACTIVE, non-deleted user holds module/action in the permission engine (Control Center). No admin branch: the per-user form of actor_has_permission. 20270120000000.';

create or replace function public.user_has_module_permission(p_user_id uuid, p_module_key text, p_action_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_user_id is not null and (
    exists (select 1 from public.users u
             where u.id = p_user_id and u.role = 'admin'
               and u.is_active and coalesce(u.is_deleted, false) = false)
    or public.user_holds_permission(p_user_id, p_module_key, p_action_key));
$fn$;

comment on function public.user_has_module_permission(uuid, text, text) is
  'True for an ACTIVE, non-deleted admin, or for a user holding module/action in the permission engine: the per-user form of actor_has_module_permission. 20270120000000.';

-- Reading whether a user holds an action discloses no more than the Control
-- Center already shows; the screens and the approve-revision route ask it.
revoke execute on function public.user_holds_permission(uuid, text, text) from public, anon;
revoke execute on function public.user_has_module_permission(uuid, text, text) from public, anon;
grant  execute on function public.user_holds_permission(uuid, text, text) to authenticated, service_role;
grant  execute on function public.user_has_module_permission(uuid, text, text) to authenticated, service_role;


-- ═══ §3. A holder's own payment is verified in the same action ══════════════

create or replace function public.complete_payment_entry(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor    uuid := auth.uid();
  v_id       uuid := p_request_id;
  v_req      public.finance_payment_requests%rowtype;
  v_decision jsonb;
  v_status   text;
  v_name     text;
begin
  if v_actor is null then
    raise exception 'Authentication required to complete a payment entry' using errcode = '28000';
  end if;

  -- Only the caller's own payment; anything else is not theirs to ask about.
  select * into v_req from public.finance_payment_requests where id = v_id;
  if not found or v_req.submitted_by is distinct from v_actor then
    raise exception 'Payment request % not found', v_id using errcode = 'P0002';
  end if;

  -- Not a holder, or no longer pending: nothing to do, and no error.
  if v_req.status <> 'pending_approval'
     or not public.user_has_module_permission(v_actor, 'finance', 'verify_own_payment') then
    return jsonb_build_object('payment_request_id', v_id, 'request_number', v_req.request_number,
                              'status', v_req.status, 'verified_on_entry', false);
  end if;

  -- THE ONE VERIFICATION DOOR, unchanged: finance.approve, the row lock,
  -- pending only, the Order link, the allocation intents, approved_by and
  -- approved_at, and the activity entry under this person's own id. Anything
  -- it refuses rolls the whole entry back with it.
  v_decision := public.approve_finance_payment_request(v_id, null);
  v_status   := v_decision ->> 'status';

  -- The other Admins hear about it, for information only. The payment is
  -- already verified, so the record it opens offers no decision.
  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;

  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select a.id, null, v_id,
         (case when v_status = 'approved_linked' then 'finance_approved_linked'
               else 'finance_approved_suspense' end)::notification_type,
         format('For your information: %s recorded and verified payment %s (₹%s). No action is needed.',
                coalesce(v_name, 'An Admin'), v_req.request_number,
                to_char(v_req.amount, 'FM999999999990.00')),
         v_req.client_name,
         true
    from public.users a
   where a.id <> v_actor
     and public.user_has_module_permission(a.id, 'finance', 'verify_own_payment');

  return jsonb_build_object(
    'payment_request_id', v_id,
    'request_number',     v_req.request_number,
    'status',             v_status,
    'verified_on_entry',  true,
    'verified_by',        v_actor,
    'verified_at',        v_decision -> 'approved_at');
end;
$fn$;

comment on function public.complete_payment_entry(uuid) is
  'The last call of a Record Payment action. For a caller holding finance.verify_own_payment (or an admin), on their own pending payment, verifies it through approve_finance_payment_request and notifies the other holders for information; otherwise changes nothing and returns the status. 20270120000000.';

revoke execute on function public.complete_payment_entry(uuid) from public, anon;
grant  execute on function public.complete_payment_entry(uuid) to authenticated;


-- ═══ §5. The restated functions ═════════════════════════════════════════════
--
-- Each is production's live definition (pg_get_functiondef, 2026-09-26, equal
-- to the latest definition in supabase/migrations) with ONLY the expressions
-- named in the header replaced. CREATE OR REPLACE keeps every grant, comment
-- and trigger in place.

-- ─── finance_payment_requests_guard_decision_status ────────────────────────
CREATE OR REPLACE FUNCTION public.finance_payment_requests_guard_decision_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
       and not public.user_has_module_permission(v_actor, 'finance', 'verify_own_payment')
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
$function$;

-- ─── reject_finance_payment_request ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_finance_payment_request(p_request_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
     and not public.user_has_module_permission(v_actor, 'finance', 'verify_own_payment') then
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
$function$;

-- ─── request_finance_payment_clarification ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_finance_payment_clarification(p_request_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_req   public.finance_payment_requests%rowtype;
  v_now   timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Authentication required to send a payment back for clarification'
      using errcode = '28000';
  end if;

  -- The SAME authority as approving and rejecting (active, finance.approve),
  -- and nothing wider.
  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only a payment verifier may send a payment back for clarification'
      using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'PAYMENT_CLARIFICATION_NOTE_REQUIRED: say what needs clarifying before sending the payment back.'
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

  -- Separation of entry and decision, as reject_finance_payment_request.
  if v_req.submitted_by = v_actor
     and not public.user_has_module_permission(v_actor, 'finance', 'verify_own_payment') then
    raise exception 'PAYMENT_SELF_DECISION_FORBIDDEN: payment % was recorded by you; another payment verifier must decide it',
      v_req.request_number
      using errcode = '42501';
  end if;

  -- STALE IS AN ANSWER. Decided (or sent back) by someone else since the
  -- reviewer opened it: nothing changes, and the caller is told so.
  if v_req.status <> 'pending_approval' then
    return jsonb_build_object('changed', false, 'request_id', v_req.id,
                              'request_number', v_req.request_number, 'status', v_req.status);
  end if;

  -- One statement, so the activity and timeline triggers record this verifier.
  update public.finance_payment_requests
     set status     = 'needs_clarification',
         admin_note = v_note,
         updated_at = v_now
   where id = p_request_id;

  return jsonb_build_object('changed', true, 'request_id', v_req.id,
                            'request_number', v_req.request_number, 'status', 'needs_clarification');
end;
$function$;

-- ─── approve_order_advance_exception ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_order_advance_exception(p_order_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  o        public.orders%rowtype;
  v_pos    jsonb;
  v_id     uuid;
  v_name   text;
  v_rev    uuid;
begin
  if not exists (select 1 from public.users u where u.id = v_actor and public.user_has_module_permission(u.id, 'orders', 'approve_advance_exception')
                  and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'Only an administrator can approve production below the 40%% advance' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 10 then
    raise exception 'ORDER_ADVANCE_EXCEPTION_REASON_REQUIRED: say why production may go ahead below the 40%% advance (at least 10 characters)'
      using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'ORDER_ADVANCE_EXCEPTION_REASON_TOO_LONG: the reason may be at most 1000 characters' using errcode = 'P0001';
  end if;

  select user_id into v_rev from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002'; end if;
  if o.status in ('cancelled', 'dispatched') then
    raise exception 'ORDER_CLOSED: Order % is %', o.display_number, o.status using errcode = 'P0001';
  end if;

  v_pos := public.order_advance_position(o.id);
  if not (v_pos ->> 'below')::boolean then
    raise exception 'ORDER_ADVANCE_EXCEPTION_NOT_NEEDED: Order % already has the 40%% advance verified', o.display_number
      using errcode = 'P0001';
  end if;
  if (v_pos ->> 'ready')::boolean then
    raise exception 'ORDER_ADVANCE_EXCEPTION_ALREADY_APPROVED: Order % already has a below-40%% approval for its current value and PI version',
      o.display_number using errcode = 'P0001';
  end if;

  insert into public.order_advance_exceptions
    (order_id, order_value, value_epoch, pi_version_id, verified_at_grant, shortfall_at_grant, reason, approved_by)
  values (o.id, o.total_value, o.value_epoch, nullif(v_pos ->> 'pi_version_id', '')::uuid,
          (v_pos ->> 'verified')::numeric, (v_pos ->> 'shortfall')::numeric, v_reason, v_actor)
  returning id into v_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (o.id, v_actor, 'order_advance_exception_approved',
          jsonb_build_object('exception_id', v_id, 'order_value', o.total_value, 'value_epoch', o.value_epoch,
                             'pi_version_id', v_pos -> 'pi_version_id',
                             'verified', v_pos -> 'verified', 'percent', v_pos -> 'percent',
                             'shortfall', v_pos -> 'shortfall', 'reason', v_reason));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  if v_rev is not null and v_rev <> v_actor
     and exists (select 1 from public.users u where u.id = v_rev and u.is_active and coalesce(u.is_deleted, false) = false) then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_rev, null, o.id, 'order_operations_review_requested'::notification_type,
            format('Order %s: %s approved production below the 40%% advance.', o.display_number, coalesce(v_name, 'An administrator')),
            v_reason, true);
  end if;

  return jsonb_build_object('exception_id', v_id, 'order_id', o.id) || public.order_advance_position(o.id);
end;
$function$;

-- ─── approve_order_pi_revision ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_order_pi_revision(p_version_id uuid, p_actor_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_is_admin  boolean;
  v_ver       public.order_pi_versions%rowtype;
  v_current   public.order_pi_versions%rowtype;
  v_order     public.orders%rowtype;
  v_sub       public.order_submissions%rowtype;
  v_path      text;
  v_now       timestamptz := now();
  v_token     uuid;
  v_own_lease boolean := false;
  v_result    jsonb;
  v_codes     jsonb;
  v_relinked  jsonb := '[]'::jsonb;
  v_blocking  jsonb;
  v_amend     jsonb;
  v_seed      jsonb;
  v_pre_codes jsonb;
  v_pre_items jsonb;
  v_retired   text;
  v_map       jsonb := '{}'::jsonb;   -- new item id → the item id it continues
  v_review    jsonb := '[]'::jsonb;
  v_explicit  text;
  n           record;
  v_name      text;
  v_reason    text;
  v_handoff   uuid;
  v_client    text;
  v_confirm   date;
  v_due       date;
  v_total     numeric;
  v_product   numeric;
begin
  if p_actor_id is null then
    raise exception 'ORDER_SUBMISSION_ACTOR_REQUIRED: an acting employee is required'
      using errcode = '28000';
  end if;

  select coalesce(public.user_holds_permission(u.id, 'orders', 'approve_order'), false) into v_is_admin
  from public.users u
  where u.id = p_actor_id and u.is_active and coalesce(u.is_deleted, false) = false;
  if not found or not coalesce(v_is_admin, false) then
    raise exception 'You do not have permission to decide a revised PI'
      using errcode = '42501';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: a JSON object is required'
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id;
  if not found then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  -- LOCK ORDER: reviewers (SHARE) → orders → submission → versions → handoffs.
  perform 1 from public.order_operations_reviewers where duty = 'pi_handoff' for share;

  select * into v_order from public.orders where id = v_ver.order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    raise exception
      'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled and cannot take a revised PI', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = v_ver.submission_id for update;
  if not found or v_sub.order_id is distinct from v_order.id then
    raise exception
      'ORDER_PI_REVISION_INVALID: the PI behind Order % is not the one this version names', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id for update;
  if v_ver.status <> 'pending' then
    raise exception
      'ORDER_PI_REVISION_NOT_PENDING: PI version % is % and is no longer waiting for a decision',
      v_ver.version_number, v_ver.status
      using errcode = 'P0001';
  end if;

  select * into v_current from public.order_pi_versions
  where order_id = v_order.id and status = 'approved' for update;

  if v_current.id is not null and v_current.version_number >= v_ver.version_number then
    raise exception
      'ORDER_PI_REVISION_STALE: PI version % is older than the current approved version %',
      v_ver.version_number, v_current.version_number
      using errcode = 'P0001';
  end if;

  v_path := nullif(btrim(coalesce(p_payload -> 'source' ->> 'workbook_path', '')), '');
  if v_path is null or v_path is distinct from v_ver.workbook_path then
    raise exception
      'ORDER_PI_REVISION_FILE_MISMATCH: the parsed workbook is not the file this revision proposed'
      using errcode = 'P0001';
  end if;

  -- A route from before 20270113000000 does not send the terms to seed; it
  -- would seed them itself afterwards and delete pictures. Refused, as #205.
  if jsonb_typeof(p_payload -> 'seed_terms') is distinct from 'object' then
    raise exception
      'ORDER_PI_REVISION_CLIENT_UPDATE_REQUIRED: this version of the app cannot approve a revised PI. Reload once the update is live and approve it again.'
      using errcode = 'P0001';
  end if;

  -- ── THE ORDER'S VALUE MUST BE KNOWN ──
  -- The Order's value is amended to the revision's Grand Total. A revision
  -- whose Grand Total could not be read would leave the Order and its PI
  -- disagreeing, so it is refused in words.
  v_total := nullif(p_payload -> 'commercial' ->> 'grand_total', '')::numeric;
  if v_total is null or v_total < 0 then
    raise exception
      'ORDER_PI_REVISION_NO_GRAND_TOTAL: PI V% has no readable Grand Total, so the Order''s value cannot be amended to it. Correct the PI and propose it again.',
      v_ver.version_number
      using errcode = 'P0001';
  end if;

  -- What the Order will be amended to: #205's definition of a difference (a PI
  -- without a client, confirm date or due date leaves the Order's as it is).
  v_blocking := public.order_pi_revision_blocking_differences(p_payload, v_order.id);
  if jsonb_array_length(v_blocking) > 0 and v_order.status = 'dispatched' then
    raise exception
      'ORDER_CLOSED: Order % is dispatched and its terms can no longer be amended, so PI V% (which changes them) cannot be approved',
      v_order.display_number, v_ver.version_number
      using errcode = '42501';
  end if;

  -- ── WHICH PRODUCT EACH NEW LINE IS ──
  -- Decided BEFORE anything is written, from the lines in force now.
  --   edit       a continuing line keeps its item id (renamed or not); a line
  --              with an id not in force is new.
  --   workbook   the parse route derives item ids from the ROW, so an id says
  --              nothing about the product on it. A line continues the line in
  --              force with the SAME item number (column J) — unique on both
  --              sides. A blank or duplicated number is AMBIGUOUS: the admin
  --              matches it (payload.line_map: {new id: old id | "new"}) or the
  --              approval is refused with the lines to match, changing nothing.
  -- Either way an item number a line of this Order EVER held may only stay
  -- with the product that held it; on any other line it is refused.
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'seq', nullif(upper(btrim(coalesce(i.item_sequence, ''))), ''),
                                               'name', i.product_name,
                                               'code', (select 'BE' || lpad(c.boe_sequence::text, 3, '0') from public.order_product_codes c
                                                         where c.order_id = v_order.id and c.submission_item_id = i.id))
                            order by i.sort_order, i.source_row), '[]'::jsonb)
    into v_pre_items
    from public.order_submission_items i where i.submission_id = v_sub.id;

  if v_ver.source_kind = 'edit' then
    select coalesce(jsonb_object_agg(e ->> 'id', e ->> 'id'), '{}'::jsonb) into v_map
      from jsonb_array_elements(p_payload -> 'items') e
     where exists (select 1 from jsonb_array_elements(v_pre_items) p where p.value ->> 'id' = e ->> 'id');
  else
    for n in
      select e ->> 'id' as id, nullif(upper(btrim(coalesce(e ->> 'item_sequence', ''))), '') as seq,
             e ->> 'product_name' as name, e ->> 'quantity' as qty
        from jsonb_array_elements(p_payload -> 'items') e
    loop
      v_explicit := p_payload -> 'line_map' ->> n.id;
      if v_explicit = 'new' then
        continue;
      elsif v_explicit is not null then
        if not exists (select 1 from jsonb_array_elements(v_pre_items) p where p.value ->> 'id' = v_explicit) then
          raise exception 'ORDER_PI_REVISION_LINE_MAP_INVALID: a line of PI V% is matched to a product that is not in force',
            v_ver.version_number using errcode = 'P0001';
        end if;
        v_map := v_map || jsonb_build_object(n.id, v_explicit);
      elsif n.seq is null
         or (select count(*) from jsonb_array_elements(p_payload -> 'items') e2
              where nullif(upper(btrim(coalesce(e2 ->> 'item_sequence', ''))), '') = n.seq) > 1
         or (select count(*) from jsonb_array_elements(v_pre_items) p where p.value ->> 'seq' = n.seq) > 1 then
        v_review := v_review || jsonb_build_object('id', n.id, 'seq', n.seq, 'name', n.name, 'qty', n.qty,
          'why', case when n.seq is null then 'no item number' else 'item number used more than once' end);
      elsif exists (select 1 from jsonb_array_elements(v_pre_items) p where p.value ->> 'seq' = n.seq) then
        v_map := v_map || jsonb_build_object(n.id,
          (select p.value ->> 'id' from jsonb_array_elements(v_pre_items) p where p.value ->> 'seq' = n.seq));
      end if;   -- otherwise: a new product
    end loop;

    if (select count(*) from jsonb_each_text(v_map)) <> (select count(distinct value) from jsonb_each_text(v_map)) then
      raise exception 'ORDER_PI_REVISION_LINE_MAP_INVALID: two lines of PI V% continue the same product',
        v_ver.version_number using errcode = 'P0001';
    end if;
    if jsonb_array_length(v_review) > 0 then
      raise exception using errcode = 'P0001',
        message = format('ORDER_PI_REVISION_LINES_NEED_REVIEW: %s product line(s) of PI V%s cannot be matched to the lines in force by item number. Match each to the product it continues, or mark it new, and approve again.',
                         jsonb_array_length(v_review), v_ver.version_number),
        detail = jsonb_build_object('lines', v_review, 'candidates', v_pre_items)::text;
    end if;
  end if;

  -- A RETIRED ITEM NUMBER IS NEVER HANDED OUT AGAIN.
  select string_agg(distinct e ->> 'item_sequence', ', ') into v_retired
    from jsonb_array_elements(p_payload -> 'items') e
   where nullif(upper(btrim(coalesce(e ->> 'item_sequence', ''))), '') = any (
           public.order_item_sequences_ever_used(v_order.id)
           || array(select p.value ->> 'seq' from jsonb_array_elements(v_pre_items) p where p.value ->> 'seq' is not null))
     and not exists (select 1 from jsonb_array_elements(v_pre_items) p
                      where p.value ->> 'id' = v_map ->> (e ->> 'id')
                        and p.value ->> 'seq' = upper(btrim(e ->> 'item_sequence')));
  if v_retired is not null then
    if v_ver.source_kind = 'edit' then
      raise exception
        'ORDER_PI_EDIT_SEQUENCE_RETIRED: PI V% gives % to a product, but that item number already belonged to another product on this Order. Choose a new number.',
        v_ver.version_number, v_retired using errcode = 'P0001';
    end if;
    raise exception
      'ORDER_PI_REVISION_SEQUENCE_RETIRED: PI V% gives % to a product, but that item number belonged to another product on this Order. Renumber it in the workbook and upload it again.',
      v_ver.version_number, v_retired using errcode = 'P0001';
  end if;

  -- ── THE LEASE ──
  -- The workbook route parses under its own lease and sends its token; an edit
  -- revision has nothing to parse and arrives without one, so it is taken here.
  v_token := nullif(p_payload ->> 'processing_token', '')::uuid;
  if v_token is null then
    v_token := gen_random_uuid();
    v_own_lease := true;
    perform public.begin_order_submission_processing(v_sub.id, p_actor_id, v_token);
  end if;

  -- ── WHAT IS BEING REPLACED ──
  -- The codes each current line holds, and the lines themselves, before the
  -- parse deletes them; and the outgoing version's complete content, read
  -- back later by order_pi_version_detail().
  select coalesce(jsonb_agg(jsonb_build_object('code_id', c.id, 'item_id', c.submission_item_id)), '[]'::jsonb)
    into v_pre_codes
    from public.order_product_codes c
   where c.order_id = v_order.id and c.submission_item_id is not null;

  -- With each line's BOE code as it stood, so the outgoing version's PDF can
  -- print its own codes — a removed line's code is orphaned a moment later.
  if v_current.id is not null then
    insert into public.order_pi_version_contents (version_id, content)
    values (v_current.id, public.order_pi_content_of(v_sub.id) || jsonb_build_object('codes',
      coalesce((select jsonb_object_agg(c.submission_item_id::text, c.boe_sequence)
                  from public.order_product_codes c
                 where c.order_id = v_order.id and c.submission_item_id is not null), '{}'::jsonb)))
    on conflict (version_id) do nothing;
  end if;

  insert into public.order_pi_revision_staged_parses (
    version_id, submission_id, payload, staged_by, staged_at, superseded_snapshot, applied_at, applied_by)
  values (
    v_ver.id, v_sub.id, p_payload - 'processing_token', p_actor_id, v_now,
    jsonb_build_object(
      'version_id', v_current.id, 'version_number', v_current.version_number,
      'order', jsonb_build_object('client_name', v_order.client_name, 'confirm_date', v_order.confirm_date,
                                  'due_date', v_order.due_date, 'total_value', v_order.total_value,
                                  'total_product_value', v_order.total_product_value,
                                  'billing_percentage', v_sub.billing_percentage),
      'items',  coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order) from public.order_submission_items i where i.submission_id = v_sub.id), '[]'::jsonb),
      'images', coalesce((select jsonb_agg(to_jsonb(m)) from public.order_submission_item_images m where m.submission_id = v_sub.id), '[]'::jsonb)),
    v_now, p_actor_id);

  -- ── APPLY, through the unchanged parse writer ──
  v_reason := left('PI V' || v_ver.version_number::text || ' approved: ' || v_ver.revision_reason, 500);
  perform set_config('boe.pi_revision_apply', v_sub.id::text, true);
  -- Who is applying it: a production hold opened inside this apply is theirs
  -- (order_advance_hold_recheck), although this door runs as the service role.
  perform set_config('boe.pi_revision_actor', p_actor_id::text, true);
  perform set_config('boe.amendment_context', 'order_amendment', true);
  v_result := public.replace_order_submission_parse(v_sub.id, p_actor_id,
    p_payload || jsonb_build_object('processing_token', v_token, 'change_reason', v_reason));

  if (select source_workbook_path from public.order_submissions where id = v_sub.id) is distinct from v_ver.workbook_path then
    raise exception 'ORDER_PI_REVISION_NOT_APPLIED: the revised workbook was not recorded on the PI' using errcode = 'P0001';
  end if;

  -- ── THE ORDER'S FIVE AMENDABLE FIELDS: through the audited door ──
  -- The parse writer mirrors the PI onto the Order without an amendment
  -- record. Put the Order back exactly as it was, then move it to the
  -- revision's values through apply_order_amendment(), which writes the
  -- 'order_amended' entry with each field's old and new value, the approving
  -- admin and the time.
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders
     set client_name = v_order.client_name, confirm_date = v_order.confirm_date, due_date = v_order.due_date,
         total_value = v_order.total_value, total_product_value = v_order.total_product_value
   where id = v_order.id
     and (client_name, confirm_date, due_date, total_value, total_product_value)
         is distinct from (v_order.client_name, v_order.confirm_date, v_order.due_date,
                           v_order.total_value, v_order.total_product_value);
  perform set_config('boe.amendment_context', '', true);

  if jsonb_array_length(v_blocking) > 0 then
    select max(case when d ->> 'field' = 'client_name'         then d ->> 'pi_value' end),
           max(case when d ->> 'field' = 'confirm_date'        then d ->> 'pi_value' end)::date,
           max(case when d ->> 'field' = 'due_date'            then d ->> 'pi_value' end)::date,
           max(case when d ->> 'field' = 'total_product_value' then d ->> 'pi_value' end)::numeric
      into v_client, v_confirm, v_due, v_product
      from jsonb_array_elements(v_blocking) d;
    v_amend := public.apply_order_amendment(
      v_order.id, p_actor_id, v_reason, 'pi_revision', null,
      v_client,
      case when exists (select 1 from jsonb_array_elements(v_blocking) d where d ->> 'field' = 'total_value')
           then v_total end,
      v_product, v_confirm, v_due, null, null);
  end if;

  if v_own_lease then
    perform public.finish_order_submission_processing(v_sub.id, v_token);
  end if;

  v_seed := p_payload -> 'seed_terms';
  perform public.seed_order_submission_pi_terms(v_sub.id,
    v_seed ->> 'fabric_responsibility', v_seed ->> 'commercial_terms_note', v_seed ->> 'client_city');

  -- ── THE VERSION IN FORCE CHANGES ──
  -- (The handoff trigger records this version's operations handoff and resets
  -- an alignment that covered the previous one; the edit-terms trigger applies
  -- an edit revision's terms.)
  if v_current.id is not null then
    update public.order_pi_versions
       set status = 'superseded', superseded_at = v_now, superseded_by_version_id = v_ver.id
     where id = v_current.id;
  end if;
  update public.order_pi_versions
     set status = 'approved',
         decided_by = p_actor_id,
         decided_at = v_now,
         applied_at = v_now,
         workbook_sha256 = coalesce(nullif(lower(p_payload -> 'source' ->> 'workbook_sha256'), ''), workbook_sha256)
   where id = v_ver.id;
  perform set_config('boe.pi_revision_apply', '', true);
  perform set_config('boe.pi_revision_actor', '', true);

  -- ── PRODUCT CODES ──
  -- Each continuing line gets back the code the line it continues held (the
  -- parse orphaned it a moment ago); removed lines' codes stay retired; new
  -- lines get the next BOE sequence, above every code ever issued.
  with back as (
    update public.order_product_codes c
       set submission_item_id = (m.key)::uuid
      from jsonb_each_text(v_map) m
      join jsonb_array_elements(v_pre_codes) p on p.value ->> 'item_id' = m.value
     where c.id = (p.value ->> 'code_id')::uuid
       and c.submission_item_id is null
       and exists (select 1 from public.order_submission_items i
                    where i.submission_id = v_sub.id and i.id = (m.key)::uuid)
    returning c.submission_item_id, c.boe_sequence
  )
  select coalesce(jsonb_agg(jsonb_build_object('submission_item_id', submission_item_id,
                                               'boe_item_code', 'BE' || lpad(boe_sequence::text, 3, '0'))), '[]'::jsonb)
    into v_relinked from back;
  v_codes := public.assign_order_product_codes(v_order.id, p_actor_id);

  -- ── RECORDS ──
  select id into v_handoff from public.order_operations_handoffs
   where pi_version_id = v_ver.id and superseded_at is null;

  perform public.log_order_submission_activity(
    v_sub.id, p_actor_id, 'pi_revision_approved', 'approved', 'approved', null,
    jsonb_build_object('order_id', v_order.id, 'version_id', v_ver.id,
                       'version_number', v_ver.version_number,
                       'superseded_version_id', v_current.id,
                       'superseded_version_number', v_current.version_number,
                       'order_amendment', v_amend -> 'changes',
                       'superseded_documents', v_result -> 'superseded_documents'));

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, p_actor_id, 'pi_revision_approved',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'superseded_version_number', v_current.version_number,
                             'source_kind', v_ver.source_kind,
                             'order_amendment', v_amend -> 'changes',
                             'handoff_id', v_handoff,
                             'superseded_documents', v_result -> 'superseded_documents'));

  if jsonb_array_length(v_codes) > 0 or jsonb_array_length(v_relinked) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_order.id, p_actor_id, 'order_product_codes_assigned',
            jsonb_build_object('codes', v_codes, 'kept', v_relinked, 'version_id', v_ver.id));
  end if;

  -- The person who proposed it hears that it is now the PI in force.
  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = p_actor_id;
  if v_ver.uploaded_by is not null and v_ver.uploaded_by <> p_actor_id then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_ver.uploaded_by, null, v_order.id, 'order_operations_review_decided'::notification_type,
            format('Order %s: %s approved PI V%s — it is now the PI in force.', v_order.display_number,
                   coalesce(v_name, 'an administrator'), v_ver.version_number),
            case when v_amend is not null then 'The Order''s commercial values were amended to match it.'
                 else 'Operations has been sent it for review.' end,
            true);
  end if;

  return jsonb_build_object(
    'version_id',       v_ver.id,
    'version_number',   v_ver.version_number,
    'order_id',         v_order.id,
    'status',           'approved',
    'superseded_version_number', v_current.version_number,
    'order_amendment',  v_amend -> 'changes',
    'handoff_id',       v_handoff,
    'codes_kept',       jsonb_array_length(v_relinked),
    'codes_issued',     jsonb_array_length(v_codes),
    'parse',            v_result,
    -- Where the verified advance now stands against the amended value (§4d).
    'advance',          public.order_advance_position(v_order.id)
  );
end;
$function$;

-- ─── reject_order_pi_revision ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_order_pi_revision(p_version_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_is_admin boolean;
  v_ver      public.order_pi_versions%rowtype;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now      timestamptz := now();
begin
  select coalesce(public.user_holds_permission(u.id, 'orders', 'approve_order'), false) into v_is_admin
  from public.users u where u.id = v_actor;
  if not coalesce(v_is_admin, false) then
    raise exception 'You do not have permission to decide a revised PI'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception
      'ORDER_PI_REVISION_DECISION_REASON_REQUIRED: say why the revised PI is refused'
      using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception
      'ORDER_PI_REVISION_REASON_TOO_LONG: the reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id for update;
  if not found then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  if v_ver.status <> 'pending' then
    raise exception
      'ORDER_PI_REVISION_NOT_PENDING: PI version % is % and is no longer waiting for a decision',
      v_ver.version_number, v_ver.status
      using errcode = 'P0001';
  end if;

  update public.order_pi_versions
     set status = 'rejected',
         decided_by = v_actor,
         decided_at = v_now,
         decision_reason = v_reason
   where id = p_version_id;

  perform public.log_order_submission_activity(
    v_ver.submission_id, v_actor, 'pi_revision_rejected', 'approved', 'approved', v_reason,
    jsonb_build_object('order_id', v_ver.order_id, 'version_id', v_ver.id,
                       'version_number', v_ver.version_number)
  );

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_ver.order_id, v_actor, 'pi_revision_rejected',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'reason', v_reason));

  return jsonb_build_object(
    'version_id',     v_ver.id,
    'version_number', v_ver.version_number,
    'order_id',       v_ver.order_id,
    'status',         'rejected'
  );
end;
$function$;

-- ─── reapprove_order_pi_revision ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reapprove_order_pi_revision(p_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_order_id uuid;
  v_order    public.orders%rowtype;
  v_ver      public.order_pi_versions%rowtype;
  v_stage    public.order_pi_revision_staged_parses%rowtype;
  v_now      timestamptz := now();
  v_name     text;
begin
  if not exists (select 1 from public.users u where u.id = v_actor and public.user_holds_permission(u.id, 'orders', 'approve_order')
                  and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'You do not have permission to decide a revised PI' using errcode = '42501';
  end if;

  select order_id into v_order_id from public.order_pi_versions where id = p_version_id;
  if v_order_id is null then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  -- LOCK ORDER, as every decision: reviewers → orders → submission → versions.
  perform 1 from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_ver from public.order_pi_versions where id = p_version_id;
  perform 1 from public.order_submissions where id = v_ver.submission_id for update;
  select * into v_ver from public.order_pi_versions where id = p_version_id for update;

  if v_ver.status <> 'admin_approved' then
    raise exception 'ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS: PI V% is % — only a revision awaiting operations can be re-approved. Refresh to see its current state.',
      v_ver.version_number, v_ver.status using errcode = 'P0001';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;
  select * into v_stage from public.order_pi_revision_staged_parses where version_id = v_ver.id for update;
  if not found or v_stage.applied_at is not null then
    raise exception 'ORDER_PI_REVISION_NOT_STAGED: PI V% has no approved parse waiting to be applied', v_ver.version_number using errcode = 'P0001';
  end if;
  if exists (select 1 from public.users u where u.id = v_stage.staged_by and public.user_holds_permission(u.id, 'orders', 'approve_order')
              and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'ORDER_PI_REVISION_APPROVER_ACTIVE: PI V% was approved by an administrator who is still active; it does not need re-approval',
      v_ver.version_number using errcode = 'P0001';
  end if;

  perform set_config('boe.pi_revision_reapprove', v_ver.id::text, true);
  update public.order_pi_revision_staged_parses set staged_by = v_actor, staged_at = v_now where version_id = v_ver.id;
  update public.order_pi_versions set decided_by = v_actor, decided_at = v_now where id = v_ver.id;
  perform set_config('boe.pi_revision_reapprove', '', true);

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, v_actor, 'pi_revision_admin_reapproved',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'previously_approved_by', v_stage.staged_by, 'operations_reviewer', v_ver.operations_reviewer));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  if v_ver.operations_reviewer is not null and v_ver.operations_reviewer <> v_actor then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_ver.operations_reviewer, null, v_order.id, 'order_operations_review_requested'::notification_type,
            format('Order %s: PI V%s re-approved by %s — it can be accepted now.',
                   v_order.display_number, v_ver.version_number, coalesce(v_name, 'an administrator')),
            'The administrator who first approved it is no longer active.', true);
  end if;

  return jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                            'status', 'admin_approved', 'reapproved_by', v_actor,
                            'previously_approved_by', v_stage.staged_by);
end;
$function$;

-- ─── decide_order_pi_revision_operations ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.decide_order_pi_revision_operations(p_version_id uuid, p_decision text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor     uuid := public.assert_order_submission_actor();
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_order_id  uuid;
  v_reviewer  uuid;
  v_order     public.orders%rowtype;
  v_sub       public.order_submissions%rowtype;
  v_ver       public.order_pi_versions%rowtype;
  v_current   public.order_pi_versions%rowtype;
  v_stage     public.order_pi_revision_staged_parses%rowtype;
  v_blocking  jsonb;
  v_token     uuid := gen_random_uuid();
  v_result    jsonb;
  v_codes     jsonb;
  v_handoff   uuid;
  v_now       timestamptz := now();
  v_seed      jsonb;
  v_name      text;
  v_pre       record;
  v_text      text;
begin
  if p_decision is null or p_decision not in ('accepted', 'rejected') then
    raise exception 'ORDER_PI_REVISION_DECISION_UNKNOWN: the decision must be accepted or rejected' using errcode = 'P0001';
  end if;
  if p_decision = 'rejected' and v_reason is null then
    raise exception 'ORDER_PI_REVISION_REASON_REQUIRED: say why the revised PI cannot be accepted — Sales and the approving admin will see it'
      using errcode = 'P0001';
  end if;
  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception 'ORDER_PI_REVISION_REASON_TOO_LONG: the reason may be at most 1000 characters' using errcode = 'P0001';
  end if;

  select order_id into v_order_id from public.order_pi_versions where id = p_version_id;
  if v_order_id is null then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  -- LOCK ORDER: reviewers → orders → submission → versions (→ handoffs, inside
  -- the handoff decision below).
  select user_id into v_reviewer from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_ver from public.order_pi_versions where id = p_version_id;
  select * into v_sub from public.order_submissions where id = v_ver.submission_id for update;
  select * into v_ver from public.order_pi_versions where id = p_version_id for update;
  select * into v_current from public.order_pi_versions where order_id = v_order_id and status = 'approved' for update;

  -- ── Authority: the reviewer assigned now, able to open this Order ──
  if v_reviewer is null then
    raise exception 'ORDER_PI_REVISION_NO_REVIEWER: no operations reviewer is assigned; an administrator must assign one in Control Center'
      using errcode = 'P0001';
  end if;
  if v_reviewer <> v_actor then
    raise exception 'Only the assigned operations reviewer can accept or reject a revised PI' using errcode = '42501';
  end if;
  if not public.can_view_order_as_actor(v_order_id) then
    raise exception 'You do not have access to this Order' using errcode = '42501';
  end if;

  -- ── State: a revision awaiting operations, on an open Order ──
  if v_ver.status <> 'admin_approved' then
    raise exception 'ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS: PI V% is % — it is not awaiting an operations decision. Refresh to see its current state.',
      v_ver.version_number, v_ver.status using errcode = 'P0001';
  end if;
  if v_ver.operations_reviewer is distinct from v_actor then
    raise exception 'Only the assigned operations reviewer can accept or reject a revised PI' using errcode = '42501';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;
  select * into v_stage from public.order_pi_revision_staged_parses where version_id = v_ver.id;
  if not found or v_stage.applied_at is not null then
    raise exception 'ORDER_PI_REVISION_NOT_STAGED: PI V% has no approved parse waiting to be applied', v_ver.version_number using errcode = 'P0001';
  end if;
  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;

  -- ── REJECT: nothing current moves ──
  if p_decision = 'rejected' then
    update public.order_pi_versions
       set status = 'rejected',
           decision_reason = left('Operations: ' || v_reason, 1000),
           operations_decided_by = v_actor, operations_decided_at = v_now, operations_reason = v_reason
     where id = v_ver.id;
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_order.id, v_actor, 'pi_revision_operations_rejected',
            jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number, 'reason', v_reason,
                               'current_version_number', v_current.version_number));
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select distinct x.uid, null::uuid, v_order.id, 'order_operations_review_decided'::notification_type,
           format('Order %s: %s rejected PI V%s. PI V%s stays in force.', v_order.display_number,
                  coalesce(v_name, 'Operations'), v_ver.version_number, v_current.version_number),
           v_reason, true
      from (select v_ver.uploaded_by as uid union all select v_ver.decided_by) x
     where x.uid is not null and x.uid <> v_actor;
    return jsonb_build_object('version_id', v_ver.id, 'status', 'rejected');
  end if;

  -- ── ACCEPT ──
  -- 1. THE AMENDMENT GATE: the Order must already carry V2's commercial values.
  v_blocking := public.order_pi_revision_blocking_differences(v_stage.payload, v_order.id);
  if jsonb_array_length(v_blocking) > 0 then
    select string_agg(format('%s: Order has %s, PI V%s has %s', d ->> 'label',
                             coalesce(d ->> 'order_value', 'nothing'), v_ver.version_number, coalesce(d ->> 'pi_value', 'nothing')), '; ')
      into v_text from jsonb_array_elements(v_blocking) d;
    raise exception 'ORDER_PI_REVISION_AMENDMENT_REQUIRED: PI V% changes the Order''s commercial data (%). Amend the Order to these values first (Request a Change, approved by an admin), then accept PI V%.',
      v_ver.version_number, v_text, v_ver.version_number using errcode = 'P0001';
  end if;

  -- 2. The approving admin's authority is what the parse writer re-checks.
  if not exists (select 1 from public.users u where u.id = v_stage.staged_by and public.user_holds_permission(u.id, 'orders', 'approve_order')
                  and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'ORDER_PI_REVISION_APPROVER_INACTIVE: the administrator who approved PI V% is no longer active. An active administrator must re-approve PI V% before it can be accepted, or you can reject it.',
      v_ver.version_number, v_ver.version_number using errcode = 'P0001';
  end if;

  -- 3. Keep what is about to be replaced.
  select o.client_name, o.confirm_date, o.due_date, o.total_value, o.total_product_value into v_pre
    from public.orders o where o.id = v_order.id;
  update public.order_pi_revision_staged_parses
     set superseded_snapshot = jsonb_build_object(
           'version_id', v_current.id, 'version_number', v_current.version_number,
           'order', jsonb_build_object('client_name', v_order.client_name, 'confirm_date', v_order.confirm_date,
                                       'due_date', v_order.due_date, 'total_value', v_order.total_value,
                                       'total_product_value', v_order.total_product_value,
                                       'billing_percentage', v_sub.billing_percentage),
           'items',  coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order) from public.order_submission_items i where i.submission_id = v_sub.id), '[]'::jsonb),
           'images', coalesce((select jsonb_agg(to_jsonb(m)) from public.order_submission_item_images m where m.submission_id = v_sub.id), '[]'::jsonb)),
         applied_at = v_now, applied_by = v_actor
   where version_id = v_ver.id;

  -- 4. Apply the staged parse through the unchanged writer, under a lease.
  perform set_config('boe.pi_revision_apply', v_sub.id::text, true);
  perform public.begin_order_submission_processing(v_sub.id, v_stage.staged_by, v_token);
  perform set_config('boe.amendment_context', 'order_amendment', true);
  v_result := public.replace_order_submission_parse(v_sub.id, v_stage.staged_by,
    v_stage.payload || jsonb_build_object(
      'processing_token', v_token,
      'change_reason', left('PI revision V' || v_ver.version_number::text || ' accepted by operations: ' || v_ver.revision_reason, 500)));
  -- ACCEPTANCE NEVER WRITES THE AMENDABLE FIELDS: they were reconciled above;
  -- this restores anything the writer's own rules moved (a PI with no due date).
  -- The writer clears the amendment context on its way out, so it is set again
  -- for this one restoring write.
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders
     set client_name = v_pre.client_name, confirm_date = v_pre.confirm_date, due_date = v_pre.due_date,
         total_value = v_pre.total_value, total_product_value = v_pre.total_product_value
   where id = v_order.id
     and (client_name, confirm_date, due_date, total_value, total_product_value)
         is distinct from (v_pre.client_name, v_pre.confirm_date, v_pre.due_date, v_pre.total_value, v_pre.total_product_value);
  perform set_config('boe.amendment_context', '', true);
  perform public.finish_order_submission_processing(v_sub.id, v_token);
  v_seed := v_stage.payload -> 'seed_terms';
  if v_seed is not null and jsonb_typeof(v_seed) = 'object' then
    perform public.seed_order_submission_pi_terms(v_sub.id,
      v_seed ->> 'fabric_responsibility', v_seed ->> 'commercial_terms_note', v_seed ->> 'client_city');
  end if;

  if (select source_workbook_path from public.order_submissions where id = v_sub.id) is distinct from v_ver.workbook_path then
    raise exception 'ORDER_PI_REVISION_NOT_APPLIED: the revised workbook was not recorded on the PI' using errcode = 'P0001';
  end if;

  -- 5. The version in force changes — only here.
  if v_current.id is not null then
    update public.order_pi_versions
       set status = 'superseded', superseded_at = v_now, superseded_by_version_id = v_ver.id
     where id = v_current.id;
  end if;
  update public.order_pi_versions
     set status = 'approved', operations_decided_by = v_actor, operations_decided_at = v_now,
         operations_reason = v_reason, applied_at = v_now
   where id = v_ver.id;
  perform set_config('boe.pi_revision_apply', '', true);

  v_codes := public.assign_order_product_codes(v_order.id, v_actor);

  -- 6. The existing handoff (recorded by the trigger above) is accepted by the
  --    same person in the same transaction: ONE operations decision, which
  --    also aligns the Order for production against V2.
  select id into v_handoff from public.order_operations_handoffs
   where pi_version_id = v_ver.id and superseded_at is null;
  if v_handoff is not null then
    perform public.decide_order_operations_handoff(v_handoff, 'accepted', v_reason);
    -- The trigger's "awaiting your review" message to the reviewer was written
    -- in this transaction for a decision this transaction has already made.
    delete from public.notifications
     where user_id = v_actor and entity_id = v_order.id and created_at = v_now
       and type = 'order_operations_review_requested'::notification_type;
  end if;

  perform public.log_order_submission_activity(
    v_sub.id, v_actor, 'pi_revision_approved', 'approved', 'approved', v_reason,
    jsonb_build_object('order_id', v_order.id, 'version_id', v_ver.id, 'version_number', v_ver.version_number,
                       'superseded_version_number', v_current.version_number,
                       'approved_by_admin', v_stage.staged_by, 'accepted_by_operations', v_actor,
                       'superseded_documents', v_result -> 'superseded_documents'));
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, v_actor, 'pi_revision_applied',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'superseded_version_number', v_current.version_number,
                             'approved_by', v_stage.staged_by, 'note', v_reason,
                             'superseded_documents', v_result -> 'superseded_documents'));
  if jsonb_array_length(v_codes) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_order.id, v_actor, 'order_product_codes_assigned', jsonb_build_object('codes', v_codes, 'version_id', v_ver.id));
  end if;

  -- Sales hears that their revision is now in force, once.
  if v_ver.uploaded_by is not null and v_ver.uploaded_by <> v_actor then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_ver.uploaded_by, null, v_order.id, 'order_operations_review_decided'::notification_type,
            format('Order %s: %s accepted PI V%s — it is now the PI in force.', v_order.display_number,
                   coalesce(v_name, 'Operations'), v_ver.version_number),
            v_reason, true);
  end if;

  return jsonb_build_object('version_id', v_ver.id, 'status', 'approved', 'order_id', v_order.id,
                            'superseded_version_number', v_current.version_number, 'handoff_id', v_handoff);
end;
$function$;

-- ─── decide_order_document_submission_admin ────────────────────────────────
CREATE OR REPLACE FUNCTION public.decide_order_document_submission_admin(p_submission_id uuid, p_decision text, p_reason text, p_snapshot text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_order_id uuid;
  v_order    public.orders%rowtype;
  v_s        public.order_document_submissions%rowtype;
  v_reason   text;
  v_reviewer uuid;
  v_label    text;
begin
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'ORDER_DOCUMENT_DECISION_UNKNOWN: the decision must be approved or rejected' using errcode = 'P0001';
  end if;
  v_reason := public.order_document_reason(p_reason, p_decision = 'rejected');
  if exists (select 1 from public.order_document_submissions where id = p_submission_id and stage = 'initial') then
    raise exception 'ORDER_DOCUMENT_DECIDED_WITH_PI: documents sent with a PI are approved or returned with that PI, not here'
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.users u where u.id = v_actor and public.user_holds_permission(u.id, 'orders', 'approve_order')) then
    raise exception 'Only an administrator can make the admin decision on a document submission' using errcode = '42501';
  end if;

  select order_id into v_order_id from public.order_document_submissions where id = p_submission_id;
  if v_order_id is null then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_NOT_FOUND: that submission no longer exists' using errcode = 'P0002';
  end if;
  perform 1 from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_s from public.order_document_submissions where id = p_submission_id for update;

  if v_s.stage = 'initial' then
    raise exception 'ORDER_DOCUMENT_DECIDED_WITH_PI: documents sent with a PI are approved or returned with that PI, not here'
      using errcode = 'P0001';
  end if;
  if v_s.status <> 'pending_admin' then
    raise exception 'ORDER_DOCUMENT_ALREADY_DECIDED: this submission has already been decided (it is now %). Refresh to see its current state.',
      v_s.status using errcode = 'P0001';
  end if;
  if p_snapshot is distinct from v_s.snapshot_sha256 then
    raise exception 'ORDER_DOCUMENT_SNAPSHOT_MISMATCH: the files you reviewed are not the files of this submission. Refresh and review again.'
      using errcode = 'P0001';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_DOCUMENT_ORDER_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;

  v_label := public.order_document_categories_label(v_s.includes_design_files, v_s.includes_client_po);

  if p_decision = 'rejected' then
    update public.order_document_submissions
       set status = 'rejected_admin', admin_decided_by = v_actor, admin_decided_at = now(), admin_reason = v_reason
     where id = v_s.id;
    perform public.order_document_log_event(v_s.id, v_s.order_id, v_actor, 'admin_rejected', 'pending_admin', 'rejected_admin', v_reason);
    if v_s.submitted_by <> v_actor then
      insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
      values (v_s.submitted_by, null, v_s.order_id, 'order_document_review_decided'::notification_type,
              format('Order %s: your %s submission was rejected by admin.', v_order.display_number, v_label), v_reason, true);
    end if;
    return jsonb_build_object('id', v_s.id, 'status', 'rejected_admin');
  end if;

  -- Approved: the next owner is the assigned operations reviewer, if they can
  -- open this Order. Otherwise it waits unassigned and the admins are told.
  select r.user_id into v_reviewer
    from public.order_operations_reviewers r
    join public.users u on u.id = r.user_id
   where r.duty = 'pi_handoff' and u.is_active and coalesce(u.is_deleted, false) = false
     and public.operations_reviewer_can_open_order(r.user_id, v_s.order_id);

  update public.order_document_submissions
     set status = 'awaiting_operations', admin_decided_by = v_actor, admin_decided_at = now(),
         admin_reason = v_reason, operations_reviewer = v_reviewer
   where id = v_s.id;
  perform public.order_document_log_event(v_s.id, v_s.order_id, v_actor, 'admin_approved', 'pending_admin', 'awaiting_operations', v_reason);

  if v_reviewer is not null then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_reviewer, null, v_s.order_id, 'order_document_review_requested'::notification_type,
            format('Order %s: %s approved by admin — awaiting your operations acceptance.', v_order.display_number, v_label),
            null, true);
  else
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select u.id, null, v_s.order_id, 'order_document_review_requested'::notification_type,
           format('Order %s: %s awaits operations acceptance, but no operations reviewer is assigned.', v_order.display_number, v_label),
           'Assign one in Control Center → Operations Handoff.', true
      from public.users u
     where public.user_holds_permission(u.id, 'orders', 'approve_order') and u.is_active and coalesce(u.is_deleted, false) = false;
  end if;

  return jsonb_build_object('id', v_s.id, 'status', 'awaiting_operations', 'operations_reviewer', v_reviewer);
end;
$function$;

-- ─── create_order_document_submission ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_order_document_submission(p_submission_id uuid, p_order_id uuid, p_design_mode text, p_note text, p_files jsonb, p_resubmission_of uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor   uuid := public.assert_order_submission_actor();
  v_order   public.orders%rowtype;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_file    jsonb;
  v_path    text;
  v_name    text;
  v_parts   record;
  v_obj     record;
  v_design  boolean := false;
  v_po      boolean := false;
  v_n_design integer := 0;
  v_n_po    integer := 0;
  v_sha     text;
  v_prior   public.order_document_submissions%rowtype;
begin
  if p_submission_id is null or p_order_id is null then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_INVALID: submission and Order are required' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'ORDER_DOCUMENT_NOTE_TOO_LONG: the note may be at most 1000 characters' using errcode = 'P0001';
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'ORDER_DOCUMENT_FILES_REQUIRED: attach at least one file' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_files) > 25 then
    raise exception 'ORDER_DOCUMENT_TOO_MANY_FILES: at most 25 files per submission' using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_DOCUMENT_ORDER_NOT_FOUND: that Order does not exist' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_DOCUMENT_ORDER_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;
  if not public.can_submit_order_document(p_order_id) then
    raise exception 'Only the Order''s salesperson, requester or PI owner (with Orders create access), or an admin, can submit documents'
      using errcode = '42501';
  end if;
  -- A retried submit with the same id answers rather than double-inserting.
  if exists (select 1 from public.order_document_submissions where id = p_submission_id) then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_EXISTS: this submission was already sent' using errcode = 'P0001';
  end if;

  -- First pass: categories, from the keys.
  for v_file in select * from jsonb_array_elements(p_files) loop
    v_path := v_file->>'path';
    select * into v_parts from public.order_document_file_key_parts(v_path);
    if v_parts.order_id is null or v_parts.order_id <> p_order_id or v_parts.submission_id <> p_submission_id then
      raise exception 'ORDER_DOCUMENT_FILE_PATH_INVALID: % is not a file of this submission', coalesce(v_path, '(none)')
        using errcode = 'P0001';
    end if;
    if v_parts.category = 'design_files' then v_design := true; v_n_design := v_n_design + 1;
    else v_po := true; v_n_po := v_n_po + 1; end if;
  end loop;
  if v_n_po > 5 then
    raise exception 'ORDER_DOCUMENT_TOO_MANY_FILES: at most 5 Client PO files per submission' using errcode = 'P0001';
  end if;
  if v_design and coalesce(p_design_mode, '') not in ('add', 'replace') then
    raise exception 'ORDER_DOCUMENT_DESIGN_MODE_REQUIRED: say whether the design files are added to or replace the current ones'
      using errcode = 'P0001';
  end if;

  -- One unresolved submission per category, said in words.
  if v_design and exists (select 1 from public.order_document_submissions
                           where order_id = p_order_id and includes_design_files
                             and status in ('pending_admin', 'awaiting_operations')) then
    raise exception 'ORDER_DOCUMENT_CATEGORY_PENDING: Design Files on Order % already have a submission under review. Wait for its decision before submitting another.',
      v_order.display_number using errcode = 'P0001';
  end if;
  if v_po and exists (select 1 from public.order_document_submissions
                       where order_id = p_order_id and includes_client_po
                         and status in ('pending_admin', 'awaiting_operations')) then
    raise exception 'ORDER_DOCUMENT_CATEGORY_PENDING: The Client PO on Order % already has a submission under review. Wait for its decision before submitting another.',
      v_order.display_number using errcode = 'P0001';
  end if;

  if p_resubmission_of is not null then
    select * into v_prior from public.order_document_submissions where id = p_resubmission_of;
    if not found or v_prior.order_id <> p_order_id
       or v_prior.status not in ('rejected_admin', 'rejected_operations') then
      raise exception 'ORDER_DOCUMENT_RESUBMISSION_INVALID: only a rejected submission of this Order can be corrected'
        using errcode = 'P0001';
    end if;
  end if;

  -- Second pass: every file must be a stored object this caller uploaded, of
  -- an allowed type and size — read from storage, never from the caller.
  for v_file in select * from jsonb_array_elements(p_files) loop
    v_path := v_file->>'path';
    v_name := nullif(btrim(coalesce(v_file->>'file_name', '')), '');
    if v_name is null or char_length(v_name) > 200 then
      raise exception 'ORDER_DOCUMENT_FILE_NAME_INVALID: every file needs a name of at most 200 characters' using errcode = 'P0001';
    end if;
    select o.id, o.owner_id, (o.metadata->>'mimetype') as mime, (o.metadata->>'size')::bigint as size
      into v_obj
      from storage.objects o where o.bucket_id = 'order-files' and o.name = v_path;
    if not found then
      raise exception 'ORDER_DOCUMENT_FILE_MISSING: % was not uploaded', v_name using errcode = 'P0001';
    end if;
    if v_obj.owner_id is distinct from v_actor::text then
      raise exception 'ORDER_DOCUMENT_FILE_NOT_YOURS: % was uploaded by somebody else', v_name using errcode = '42501';
    end if;
    if v_obj.mime is null or v_obj.mime not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
      raise exception 'ORDER_DOCUMENT_FILE_TYPE: % must be a PDF, PNG, JPEG or WebP file', v_name using errcode = 'P0001';
    end if;
    if v_obj.size is null or v_obj.size <= 0 or v_obj.size > 10485760 then
      raise exception 'ORDER_DOCUMENT_FILE_SIZE: % must be between 1 byte and 10 MB', v_name using errcode = 'P0001';
    end if;
  end loop;
  if (select count(distinct e->>'path') from jsonb_array_elements(p_files) e) <> jsonb_array_length(p_files) then
    raise exception 'ORDER_DOCUMENT_FILE_DUPLICATE: a file is listed twice' using errcode = 'P0001';
  end if;

  -- THE SNAPSHOT HASH, computed from the stored objects BEFORE the row exists,
  -- so it is written once and never rewritten.
  select encode(sha256(convert_to(string_agg(
           split_part(o.name, '/', 4) || '|' || o.name || '|' || o.id::text || '|'
             || (o.metadata->>'size') || '|' || (o.metadata->>'mimetype'),
           E'\n' order by o.name), 'UTF8')), 'hex')
    into v_sha
    from jsonb_array_elements(p_files) e
    join storage.objects o on o.bucket_id = 'order-files' and o.name = e->>'path';

  insert into public.order_document_submissions
    (id, order_id, includes_design_files, includes_client_po, design_mode, note,
     status, snapshot_sha256, file_count, resubmission_of, submitted_by)
  values
    (p_submission_id, p_order_id, v_design, v_po, case when v_design then p_design_mode end, v_note,
     'pending_admin', v_sha, jsonb_array_length(p_files), p_resubmission_of, v_actor);

  insert into public.order_document_submission_files
    (submission_id, category, storage_path, storage_object_id, file_name, mime_type, size_bytes)
  select p_submission_id, split_part(o.name, '/', 4), o.name, o.id, btrim(e->>'file_name'),
         o.metadata->>'mimetype', (o.metadata->>'size')::bigint
    from jsonb_array_elements(p_files) e
    join storage.objects o on o.bucket_id = 'order-files' and o.name = e->>'path';

  perform public.order_document_log_event(p_submission_id, p_order_id, v_actor, 'submitted', null, 'pending_admin', v_note);

  -- The next owner: every active admin except the submitter.
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select u.id, null, p_order_id, 'order_document_review_requested'::notification_type,
         format('Order %s: %s submitted for admin review.', v_order.display_number,
                public.order_document_categories_label(v_design, v_po)),
         v_note, true
    from public.users u
   where public.user_holds_permission(u.id, 'orders', 'approve_order') and u.is_active and coalesce(u.is_deleted, false) = false and u.id <> v_actor;

  return jsonb_build_object('id', p_submission_id, 'order_id', p_order_id, 'status', 'pending_admin',
                            'snapshot_sha256', v_sha, 'file_count', jsonb_array_length(p_files));
end;
$function$;

-- ─── order_pi_versions_record_operations_handoff ───────────────────────────
CREATE OR REPLACE FUNCTION public.order_pi_versions_record_operations_handoff()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order        public.orders%rowtype;
  v_prior        public.order_operations_handoffs%rowtype;
  v_configured   uuid;
  v_reviewer     uuid;
  v_unassigned   text;
  v_handoff_id   uuid;
  v_now          timestamptz := now();
  v_approver     text;
  v_alignment    text;
begin
  -- Only the moment a version BECOMES the one in force.
  if new.status <> 'approved' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then
    return null;
  end if;
  -- Idempotent: one handoff per version, whatever path re-runs.
  if exists (select 1 from public.order_operations_handoffs h where h.pi_version_id = new.id) then
    return null;
  end if;

  select * into v_order from public.orders where id = new.order_id;
  if not found then
    return null;
  end if;
  v_alignment := v_order.production_alignment;

  -- WHO THE REVIEWER IS RIGHT NOW — read under a SHARE lock on the one
  -- settings row. set_order_operations_reviewer() takes the UPDATE lock on
  -- that same row before it changes anything, so the two serialize: either
  -- this approval reads the reviewer AFTER a Control Center change committed,
  -- or the change waits for this approval to commit and then readdresses the
  -- handoff written here. Nothing can be addressed to a reviewer who was
  -- replaced mid-approval. On the revision path this lock is already held:
  -- approve_order_pi_revision takes it before it locks the Order (§6b), since
  -- taking it only here, with the Order held FOR UPDATE, deadlocks against
  -- the assignment. On the first approval the Order is this transaction's
  -- own new row, which nobody else can wait on. (Lock order: see the header.)
  select r.user_id into v_configured
    from public.order_operations_reviewers r
   where r.duty = 'pi_handoff'
     for share;

  -- ADDRESSED ONLY TO SOMEBODY WHO CAN OPEN THIS ORDER, as they are now:
  -- active, not deleted, with module entry and this Order's own visibility.
  -- Otherwise the handoff is recorded UNASSIGNED with the reason, and the
  -- administrators are told. Never an admin in the reviewer's place.
  if v_configured is null then
    v_reviewer := null;
    v_unassigned := 'no_reviewer';
  elsif not exists (
    select 1 from public.users u
    where u.id = v_configured and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    v_reviewer := null;
    v_unassigned := 'reviewer_inactive';
  elsif not public.operations_reviewer_can_open_order(v_configured, new.order_id) then
    v_reviewer := null;
    v_unassigned := 'reviewer_cannot_open_order';
  else
    v_reviewer := v_configured;
    v_unassigned := null;
  end if;

  -- The earlier version's handoff, whatever it decided, is now history. Its
  -- decision columns are untouched; only the supersession is stamped.
  update public.order_operations_handoffs
     set superseded_at = v_now,
         superseded_by_version_id = new.id
   where order_id = new.order_id
     and superseded_at is null
  returning * into v_prior;

  insert into public.order_operations_handoffs (
    order_id, pi_version_id, submission_id, version_number,
    approved_by, approved_at,
    assigned_to, assigned_at, unassigned_reason,
    production_alignment_at_approval, prior_handoff_status
  ) values (
    new.order_id, new.id, new.submission_id, new.version_number,
    new.decided_by, coalesce(new.decided_at, v_now),
    v_reviewer, case when v_reviewer is null then null else v_now end, v_unassigned,
    v_alignment, v_prior.status
  )
  returning id into v_handoff_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (new.order_id, new.decided_by, 'operations_handoff_recorded',
          jsonb_build_object(
            'handoff_id', v_handoff_id,
            'version_id', new.id,
            'version_number', new.version_number,
            'assigned_to', v_reviewer,
            'unassigned_reason', v_unassigned,
            'production_alignment', v_alignment,
            'superseded_handoff_id', v_prior.id,
            'superseded_handoff_status', v_prior.status,
            'superseded_version_number', v_prior.version_number));

  -- UNASSIGNED IS AN ADMINISTRATOR'S PROBLEM, and they are told at once —
  -- every active administrator, the approver included, because the fix
  -- (assign somebody in Control Center) is theirs and not the reviewer's.
  -- This is what keeps a handoff recorded before a reviewer is configured,
  -- or while the configured one cannot open the Order, from going unseen.
  if v_reviewer is null then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select u.id, null, new.order_id, 'order_operations_review_requested'::notification_type,
           format('Order %s: PI V%s approved, but no operations reviewer can take it. Assign one in Control Center.',
                  v_order.display_number, new.version_number),
           case v_unassigned
             when 'reviewer_inactive' then 'The configured operations reviewer is no longer an active account.'
             when 'reviewer_cannot_open_order' then 'The configured operations reviewer cannot open this Order. Choose an admin, a member of the operations team, or a holder of orders.view_all.'
             else 'No operations reviewer is configured. Control Center → Operations Handoff.'
           end,
           true
      from public.users u
     where public.user_holds_permission(u.id, 'orders', 'approve_order') and u.is_active and coalesce(u.is_deleted, false) = false;
  end if;

  -- AN OLDER ALIGNMENT NEVER COVERS A NEWER VERSION. If the Order was aligned
  -- for production, that alignment was for the version just superseded (or,
  -- on a legacy Order, for whatever was current before tracking); the new
  -- version is unaccepted, so the Order goes back to not_aligned NOW, with the
  -- reset on its history saying what the alignment had covered. Nothing about
  -- the earlier alignment or acceptance is erased.
  if v_alignment = 'aligned' then
    perform public.order_operations_handoff_set_alignment(
      new.order_id, new.decided_by, false, null,
      jsonb_build_object('reason', 'pi_version_approved',
                         'version_id', new.id, 'version_number', new.version_number,
                         'covered_version_number', v_prior.version_number,
                         'covered_handoff_status', v_prior.status,
                         'handoff_id', v_handoff_id));
  end if;

  -- The reviewer hears about it — unless they are the approver, who was
  -- looking at the screen. The handoff itself is still recorded as awaiting:
  -- approving is not accepting, even for the same person.
  if v_reviewer is not null and v_reviewer is distinct from new.decided_by then
    select nullif(btrim(u.full_name), '') into v_approver from public.users u where u.id = new.decided_by;
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (
      v_reviewer, null, new.order_id, 'order_operations_review_requested'::notification_type,
      format('Order %s: PI V%s approved by %s. Awaiting your operations review.',
             v_order.display_number, new.version_number, coalesce(v_approver, 'an administrator')),
      case
        when v_prior.status = 'accepted' then
          format('You accepted PI V%s earlier. Open the Order, review what changed in V%s, then choose Accept for production or Cannot accept.',
                 v_prior.version_number, new.version_number)
        when v_alignment = 'aligned' then
          format('This Order was aligned for production before PI V%s; that alignment has been reset. Review PI V%s and choose Accept for production or Cannot accept.',
                 new.version_number, new.version_number)
        else
          format('Open the Order, review PI V%s, then choose Accept for production or Cannot accept.',
                 new.version_number)
      end,
      true
    );
  end if;

  return null;
end;
$function$;

-- ─── order_advance_hold_recheck ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_advance_hold_recheck(p_order_id uuid, p_cause text, p_detail jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  o         public.orders%rowtype;
  v_pos     jsonb;
  -- Who caused it. A PI revision is applied by the service role on an
  -- administrator's behalf: that administrator is the author (review R5).
  v_actor   uuid := coalesce(auth.uid(), nullif(current_setting('boe.pi_revision_actor', true), '')::uuid);
  v_hold    uuid;
  v_in_rev  boolean := nullif(current_setting('boe.pi_revision_apply', true), '') is not null;
  v_dir     text;
  v_what    text;
  v_title   text;
  v_body    text;
begin
  if p_order_id is null or public.in_test_data_cleanup() then
    return false;
  end if;

  -- The Order's row lock first: an alignment in flight either committed
  -- before this (and is seen below) or waits and then sees this write.
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.production_alignment is distinct from 'aligned'
     or o.status in ('cancelled', 'dispatched') then
    return false;
  end if;

  -- Already held: a PI revision re-values the Order more than once inside its
  -- apply (parse, restore, amendment) before its handoff removes the alignment.
  if exists (select 1 from public.order_advance_holds h where h.order_id = o.id and h.resolved_at is null) then
    return false;
  end if;

  v_pos := public.order_advance_position(o.id);
  if (v_pos ->> 'ready')::boolean then
    return false;
  end if;

  if v_actor is not null and not exists (select 1 from public.users u where u.id = v_actor) then
    v_actor := null;
  end if;

  insert into public.order_advance_holds
    (order_id, cause, order_value, previous_order_value, value_epoch, verified, percent, shortfall, detail, held_by)
  values (o.id, p_cause, o.total_value, nullif(p_detail ->> 'previous_order_value', '')::numeric, o.value_epoch,
          (v_pos ->> 'verified')::numeric, nullif(v_pos ->> 'percent', '')::numeric,
          nullif(v_pos ->> 'shortfall', '')::numeric, coalesce(p_detail, '{}'::jsonb), v_actor)
  returning id into v_hold;

  -- The direction is said only when both figures are known (review R2): a
  -- LOWER value can leave an Order short too, when an approval it relied on
  -- was for the old value.
  v_dir := public.order_value_change_word(nullif(p_detail ->> 'previous_order_value', '')::numeric, o.total_value);
  v_what := case p_cause
    when 'value_changed' then case when v_dir = 'changed' then 'its value changed' else 'its value was ' || v_dir end
    when 'pi_revision'   then 'a revised PI ' || v_dir || ' its value'
    else 'verified payment against it was reduced' end;

  -- A revision's own handoff removes the alignment in this transaction.
  if not v_in_rev then
    perform public.order_operations_handoff_set_alignment(
      o.id, v_actor, false,
      format('Production readiness removed: the verified advance fell below 40%% after %s.', v_what),
      jsonb_build_object('reason', 'advance_hold', 'hold_id', v_hold, 'cause', p_cause));
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (o.id, v_actor, 'order_advance_hold_opened',
          jsonb_build_object('hold_id', v_hold, 'cause', p_cause,
                             'order_value', o.total_value, 'value_known', v_pos -> 'value_known',
                             'verified', v_pos -> 'verified', 'percent', v_pos -> 'percent',
                             'shortfall', v_pos -> 'shortfall') || coalesce(p_detail, '{}'::jsonb));

  v_title := format('Order %s: production readiness removed — advance below 40%%.', o.display_number);
  v_body  := case when (v_pos ->> 'value_known')::boolean then
               format('After %s, ₹%s is verified — %s%% of ₹%s. ₹%s more verified payment, or an administrator''s below-40%% approval, is needed before Operations can align production again.',
                      v_what,
                      to_char((v_pos ->> 'verified')::numeric, 'FM99999999999990.00'),
                      v_pos ->> 'percent',
                      to_char(o.total_value, 'FM99999999999990.00'),
                      to_char((v_pos ->> 'shortfall')::numeric, 'FM99999999999990.00'))
             else format('After %s, the Order has no value on record, so its advance cannot be measured. An administrator''s below-40%% approval is needed before Operations can align production again.', v_what)
             end;
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select r.user_id, null, o.id, 'order_update_production'::notification_type, v_title, v_body, true
    from (select u.id as user_id from public.users u
           where public.user_has_module_permission(u.id, 'orders', 'approve_advance_exception') and u.is_active and coalesce(u.is_deleted, false) = false
          union
          -- The operations reviewer only while they can act on it (review R8):
          -- an inactive or deleted reviewer is not told; the administrators are.
          select r.user_id from public.order_operations_reviewers r
            join public.users u on u.id = r.user_id
           where r.duty = 'pi_handoff' and u.is_active and coalesce(u.is_deleted, false) = false) r
   where r.user_id is distinct from v_actor;

  return true;
end;
$function$;

-- ─── recover_order_production_alignment ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recover_order_production_alignment(p_order_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor   uuid := public.assert_order_submission_actor();
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now     timestamptz := now();
  v_order   public.orders%rowtype;
  v_h       public.order_operations_handoffs%rowtype;
  v_rev     uuid;
  v_why     text;
  v_hold    uuid;
  v_name    text;
begin
  if not exists (select 1 from public.users u where u.id = v_actor and public.user_has_module_permission(u.id, 'orders', 'align_production')
                  and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'Only an administrator can recover a production alignment' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 10 then
    raise exception 'ORDER_REALIGN_RECOVERY_REASON_REQUIRED: say why production is being aligned again without an operations reviewer (at least 10 characters)'
      using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'ORDER_REALIGN_RECOVERY_REASON_TOO_LONG: the reason may be at most 1000 characters' using errcode = 'P0001';
  end if;

  -- Lock order as decide_order_operations_handoff: reviewer row, Order, handoff.
  select r.user_id into v_rev from public.order_operations_reviewers r where r.duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  select * into v_h from public.order_operations_handoffs h
   where h.order_id = p_order_id and h.superseded_at is null
   for update;
  if not found then
    raise exception 'ORDER_REALIGN_NOT_HELD: Order % has no operations handoff to align against', v_order.display_number
      using errcode = 'P0001';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;
  if v_h.status <> 'accepted'
     or not exists (select 1 from public.order_pi_versions v where v.id = v_h.pi_version_id and v.status = 'approved')
     or exists (select 1 from public.order_pi_versions v
                 where v.order_id = v_h.order_id and v.status = 'approved' and v.id <> v_h.pi_version_id) then
    raise exception 'ORDER_REALIGN_NOT_ACCEPTED: the PI version in force on Order % is not accepted by operations; it needs their review, not a recovery',
      v_order.display_number using errcode = 'P0001';
  end if;
  select h.id into v_hold from public.order_advance_holds h where h.order_id = v_order.id and h.resolved_at is null;
  if v_order.production_alignment = 'aligned' or v_hold is null then
    raise exception 'ORDER_REALIGN_NOT_HELD: Order % is not on a production hold', v_order.display_number
      using errcode = 'P0001';
  end if;

  -- Only when no reviewer can act.
  if v_rev is not null and public.operations_reviewer_can_open_order(v_rev, v_order.id) then
    select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_rev;
    raise exception 'ORDER_REALIGN_REVIEWER_AVAILABLE: % is the operations reviewer and can align production again; an administrator recovers only when no reviewer can',
      coalesce(v_name, 'An active reviewer') using errcode = 'P0001';
  end if;
  v_why := case when v_rev is null then 'no_reviewer'
                when not exists (select 1 from public.users u where u.id = v_rev and u.is_active and coalesce(u.is_deleted, false) = false)
                  then 'reviewer_inactive'
                else 'reviewer_cannot_open_order' end;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, v_actor, 'operations_handoff_realigned_by_admin',
          jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                             'version_number', v_h.version_number, 'reason', v_reason,
                             'realigned_by', v_actor, 'realigned_at', v_now,
                             'accepted_by', v_h.accepted_by, 'accepted_at', v_h.accepted_at,
                             'reviewer_id', v_rev, 'reviewer_unavailable', v_why, 'hold_id', v_hold));
  -- The gate (orders_alignment_requires_advance) refuses this while the Order is short.
  perform public.order_operations_handoff_set_alignment(
    v_order.id, v_actor, true, v_reason,
    jsonb_build_object('reason', 'operations_handoff_realigned_by_admin', 'handoff_id', v_h.id,
                       'version_id', v_h.pi_version_id, 'version_number', v_h.version_number,
                       'reviewer_unavailable', v_why));

  return jsonb_build_object('order_id', v_order.id, 'handoff_id', v_h.id, 'version_number', v_h.version_number,
                            'production_alignment', 'aligned', 'recovered_by', v_actor, 'reviewer_unavailable', v_why);
end;
$function$;

-- ─── order_advance_readiness ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_advance_readiness(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_pos   jsonb;
  v_rev   uuid;
  v_avail boolean;
begin
  if not coalesce(public.can_view_order_as_actor(p_order_id), false) then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  v_pos := public.order_advance_position(p_order_id);
  -- WHO MAY ALIGN A HELD ORDER AGAIN (review R1), for the screen to draw; the
  -- doors decide again under lock. The current operations reviewer when one
  -- can act; otherwise an administrator's recovery.
  if jsonb_typeof(v_pos -> 'hold') = 'object' then
    select r.user_id into v_rev from public.order_operations_reviewers r where r.duty = 'pi_handoff';
    v_avail := v_rev is not null and public.operations_reviewer_can_open_order(v_rev, p_order_id);
    v_pos := v_pos || jsonb_build_object('realign', jsonb_build_object(
      'reviewer_id', v_rev,
      'reviewer_available', v_avail,
      'by_viewer', v_avail and v_rev = auth.uid(),
      'recover_by_viewer', not v_avail and exists (
        select 1 from public.users u where u.id = auth.uid() and public.user_has_module_permission(u.id, 'orders', 'align_production')
           and u.is_active and coalesce(u.is_deleted, false) = false)));
  end if;
  return v_pos;
end;
$function$;


-- ═══ Assertions, on the DEPLOYED objects ════════════════════════════════════

do $assert$
declare
  v_fn   text;
  v_def  text;
  v_n    integer;
begin
  -- §1: registered on Finance, deny-by-default, granted to nobody by this file.
  select count(*) into v_n
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'finance'
    join public.permission_actions pa on pa.id = mpa.action_id and pa.action_key = 'verify_own_payment'
   where mpa.default_allowed = false;
  if v_n <> 1 then
    raise exception 'ASSERTION FAILED: finance.verify_own_payment is not registered deny-by-default';
  end if;

  -- §5: no decision in this flow asks users.role any more — except the payment
  -- guard's untouched early return.
  foreach v_fn in array array[
    'reject_finance_payment_request(uuid,text)',
    'request_finance_payment_clarification(uuid,text)',
    'approve_order_advance_exception(uuid,text)',
    'approve_order_pi_revision(uuid,uuid,jsonb)',
    'reject_order_pi_revision(uuid,text)',
    'reapprove_order_pi_revision(uuid)',
    'decide_order_pi_revision_operations(uuid,text,text)',
    'decide_order_document_submission_admin(uuid,text,text,text)',
    'create_order_document_submission(uuid,uuid,text,text,jsonb,uuid)',
    'order_pi_versions_record_operations_handoff()',
    'order_advance_hold_recheck(uuid,text,jsonb)',
    'recover_order_production_alignment(uuid,text)',
    'order_advance_readiness(uuid)'
  ] loop
    v_def := pg_get_functiondef(('public.' || v_fn)::regprocedure);
    if v_def ~ $re$role\s*=\s*'admin'$re$ then
      raise exception 'ASSERTION FAILED: % still decides by users.role', v_fn;
    end if;
    if v_def !~ 'public\.user_(holds|has_module)_permission\(' then
      raise exception 'ASSERTION FAILED: % asks no permission', v_fn;
    end if;
  end loop;

  v_def := pg_get_functiondef('public.finance_payment_requests_guard_decision_status()'::regprocedure);
  if v_def not like '%PAYMENT_SELF_DECISION_FORBIDDEN%'
     or v_def not like '%user_has_module_permission(v_actor, ''finance'', ''verify_own_payment'')%' then
    raise exception 'ASSERTION FAILED: the separation rule does not ask finance.verify_own_payment';
  end if;
  if position('PAYMENT_SELF_DECISION_FORBIDDEN' in v_def) > position('in_finance_payment_verification(old.id)' in v_def) then
    raise exception 'ASSERTION FAILED: the separation rule must still be checked before the approval marker';
  end if;

  -- §3: for signed-in callers only, and only through the one verification door.
  if has_function_privilege('anon', 'public.complete_payment_entry(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.complete_payment_entry(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: complete_payment_entry is not exactly for signed-in callers';
  end if;
  v_def := pg_get_functiondef('public.complete_payment_entry(uuid)'::regprocedure);
  if v_def not like '%approve_finance_payment_request(v_id, null)%'
     or v_def not like '%v_req.submitted_by is distinct from v_actor%' then
    raise exception 'ASSERTION FAILED: complete_payment_entry must verify only the caller''s own payment, through the one verification door';
  end if;
  if has_function_privilege('anon', 'public.user_holds_permission(uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'public.user_has_module_permission(uuid,text,text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can read permissions';
  end if;

  raise notice '20270120000000 applied: the flow''s Admin decisions ask Control Center permissions.';
end $assert$;
