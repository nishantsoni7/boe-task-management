-- ═══════════════════════════════════════════════════════════════════════════
-- Order Approval: a permanent owner grant, and auto-approval on self-submit
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT
--
-- The permission itself is NOT new. orders.approve_order — "Approve PI /
-- Confirm Order" — was registered by 20260908000000, is PROTECTED in
-- src/lib/permissions/levels.ts so no Viewer/Contributor/Manager preset can
-- reach it, and is already the authority every review door asks for. This
-- migration does not re-invent any of that.
--
-- Three things were missing, and they are all this file adds.
--
--   §2/§3  A PERMANENT HOLDER. The owner account held approve_order only
--          implicitly, through actor_has_module_permission's admin branch, and
--          nothing stopped the Control Centre from writing an explicit DENY
--          override against him. The deny would not have changed what the
--          database let him do — the admin branch short-circuits before the
--          resolver is consulted — which is worse, not better: every screen
--          would have read "Denied" while every RPC still said yes. So the
--          grant is made explicit, and the one row that carries it is made
--          unrevokable in the database.
--
--   §4     AND THE SAME ADMIN BRANCH, SEEN FROM THE OTHER SIDE. Because every
--          decision door asked actor_has_module_permission, PI approval was
--          not really a permission at all for anybody holding the admin role:
--          it could be withdrawn in the Control Centre, reported false by the
--          resolver, and still granted by the database. The owner could not
--          take it away from a colleague who happened to be an administrator.
--          §4 gives this ONE action a permission-only door, and changes the
--          meaning of the admin role nowhere else.
--
--   §5     AUTO-APPROVAL ON SELF-SUBMIT. A PI submitted by somebody who holds
--          approve_order has already been read by the only person who would
--          have reviewed it, and making them press Approve on their own upload
--          is ceremony. The PI DECISION is therefore stamped in the same
--          transaction as the submission — and nothing else is. It asks the
--          same §4 door the reviewer's Approve button asks, so a withdrawal
--          stops both at once.
--
-- WHAT AUTO-APPROVAL IS NOT. It is not a Confirmed Order.
-- approve_order_submission() is re-emitted by §4 for its authorization line
-- and for nothing else, and still requires, independently and under its own
-- locks: a CURRENT finance verification,
-- verified payment at or above the standard requirement or an approved advance
-- exception, a salesperson, a confirm date, a due date and a lead source. No
-- order number is reserved, no money is judged, no Finance record moves. The
-- PI decision gates none of those — it is read for display and stamped by the
-- two approval doors, and that is the whole of its effect (grep pi_approved_
-- across supabase/migrations).
--
-- IT DOES NOT DECIDE AN ADVANCE EXCEPTION EITHER. If the submission raises one,
-- it stays pending for a holder of orders.approve_advance_exception, which is a
-- separate action on purpose (20260913000000). Approving one's own PI is not
-- approving one's own commercial terms.
--
-- WHY THE FINANCE-VERIFICATION GATE IS NOT COPIED HERE. approve_pi_review()
-- refuses a PI finance has not verified for the submission under review. At
-- SUBMIT time that gate can never be satisfied: a submission takes a new
-- submitted_at, which is precisely what makes any earlier verification stale.
-- Copying the gate would mean auto-approval could never fire. It is left out on
-- the reasoning 20261119000000 §2 already states — the PI decision is about the
-- DOCUMENT, and it is separable from the payment condition — and the Order gate
-- that does depend on finance is re-derived by approve_order_submission()
-- regardless of what this stamp says.
--
-- EVERY WORKBOOK VALIDATION STILL RUNS, AND RUNS FIRST. The auto-approval block
-- is the LAST thing in the function. parse_blocking_issues, the client name,
-- the workbook's path, existence and type, the product lines, the
-- representative images and every image path have all already been checked and
-- have all already had their chance to raise. A PI with a single blocking issue
-- never reaches the block, and a raise inside the block rolls the submission
-- back with it.
--
-- ADDITIVE ONLY. No column is dropped, no policy is dropped, no row is
-- rewritten, no function changes signature, and no table is created or
-- altered. FIVE functions are re-emitted in full, and every one of them is
-- proved to differ only where this file says it does:
--
--   §4  request_order_submission_changes, reject_order_submission,
--       approve_pi_review, approve_order_submission — one authorization
--       expression each, and nothing else
--   §5  submit_pi_for_review_internal — three additions, and nothing else
--
-- src/lib/orders/orderApprovalAuthority.test.ts and
-- src/lib/orders/orderApprovalAutoApprove.test.ts extract both copies of each
-- and compare them, which is the method 20260901000000 established when it
-- re-authorized eleven functions the same way.
-- ═══════════════════════════════════════════════════════════════════════════

do $dep$
begin
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null
     -- The PERMISSION-ONLY helper §4 is built on. Same migration, and the one
     -- assert_order_amender already uses for the same reason.
     or to_regprocedure('public.actor_has_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260901000000 must be applied before this migration';
  end if;
  -- The four doors §4 re-emits must already exist at these exact signatures,
  -- or the re-emission would be creating something rather than replacing it.
  if to_regprocedure('public.request_order_submission_changes(uuid, text)') is null
     or to_regprocedure('public.reject_order_submission(uuid, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260908000000 / 20260910000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.approve_order_submission(uuid, uuid, date, date, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20261201000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.submit_pi_for_review_internal(uuid, text, text, text, text)') is null
     or to_regprocedure('public.approve_pi_review(uuid)') is null
     or to_regprocedure('public.order_submission_pi_approved(timestamptz, timestamptz, timestamptz)') is null then
    raise exception 'DEPENDENCY MISSING: 20261119000000 must be applied before this migration';
  end if;
  if not exists (select 1 from public.permission_actions where action_key = 'approve_order') then
    raise exception 'DEPENDENCY MISSING: 20260908000000 must register orders.approve_order';
  end if;
end $dep$;


-- ═══ 1. Who holds Order Approval permanently ════════════════════════════════
--
-- RESOLVED BY employee_code, NEVER BY A HARD-CODED uuid AND NEVER BY NAME.
-- This is the convention 20260697000000 established for named exceptions, for
-- two reasons that both still hold: a uuid in a migration is unreadable and
-- unverifiable, and full_name is neither unique nor stable.
--
--   TEST-001 → Nishant, the owner/administrator account
--              (email admin@bestofexports.com, team=admin, role=admin). The
--              same code 20260697000000, 20260719000000 and 20260723000000
--              already resolve him by.
--
-- A FUNCTION RATHER THAN A LITERAL REPEATED THREE TIMES, so the seed in §2, the
-- guard in §3 and anything that asks later all read one definition. Mirrored in
-- TypeScript by PERMANENT_ORDER_APPROVER_CODES in
-- src/lib/permissions/orderApproval.ts, and orderApproval.test.ts asserts the
-- two agree.
--
-- STABLE, not IMMUTABLE: it reads a table.

create or replace function public.is_permanent_order_approver(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = p_user_id
      and u.employee_code = 'TEST-001'
  );
$$;

comment on function public.is_permanent_order_approver(uuid) is
  'True for the seeded owner account (employee_code TEST-001) whose orders.approve_order grant may never be revoked or denied. Resolved by employee_code, never by a hard-coded uuid and never by full_name.';

revoke execute on function public.is_permanent_order_approver(uuid) from public, anon;
grant  execute on function public.is_permanent_order_approver(uuid) to authenticated;

-- THE PROTECTED TRIPLE, in one place. The guard in §3 asks this question twice
-- per UPDATE — once of the row as it was and once of the row as it will be —
-- and a guard that spelled the join out twice would be a guard with two chances
-- to drift.
--
-- It takes ids rather than keys because that is what the trigger has, and it
-- resolves them through the registry rather than trusting them: the module must
-- really be `orders` and the action must really be `approve_order`.

create or replace function public.is_permanent_order_approval_grant(
  p_user_id   uuid,
  p_module_id uuid,
  p_action_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.permission_modules pm
    join public.permission_actions pa on pa.id = p_action_id
    where pm.id = p_module_id
      and pm.module_key = 'orders'
      and pa.action_key = 'approve_order'
      and public.is_permanent_order_approver(p_user_id)
  );
$$;

comment on function public.is_permanent_order_approval_grant(uuid, uuid, uuid) is
  'True when this (employee, module, action) triple IS the permanent owner grant of orders.approve_order. The one definition the guard in §3 asks of a row before and after an update.';

revoke execute on function public.is_permanent_order_approval_grant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.is_permanent_order_approval_grant(uuid, uuid, uuid) to authenticated;


-- ═══ 2. The grant itself, made explicit ═════════════════════════════════════
--
-- Shaped exactly like 20260697000000 §5: an employee_permission_overrides row,
-- granted_by the owner's own id (the NOT NULL FK has to point somewhere, and
-- the owner resolving his own seeded grant is the honest answer).
--
-- ON CONFLICT DO UPDATE rather than DO NOTHING, and that difference is the
-- point: if a row already exists carrying allowed = false, or an active row was
-- soft-revoked before this migration ran, DO NOTHING would leave the deny in
-- place and the guard in §3 would then protect the WRONG state. This re-asserts
-- allowed = true and clears the revocation.
--
-- NOBODY ELSE IS GRANTED ANYTHING. Nitish and every other employee get this
-- permission the way the architecture already intends — the owner grants it
-- from the Control Centre, per employee, under Custom. No second role system,
-- no seeded list of reviewers.
--
-- The guard in §3 is created AFTER this statement on purpose: the seed is a
-- legitimate write that the guard would have nothing to say about, but ordering
-- it first means the seed can never be the thing that trips a guard it is
-- meant to be protected by.

insert into public.employee_permission_overrides
  (user_id, module_id, action_id, allowed, granted_by, granted_at)
select u.id, pm.id, pa.id, true, u.id, now()
from public.users u
cross join (select id from public.permission_modules where module_key = 'orders') pm
cross join (select id from public.permission_actions where action_key = 'approve_order') pa
where u.employee_code = 'TEST-001'
on conflict (user_id, module_id, action_id) do update
  set allowed    = true,
      revoked_by = null,
      revoked_at = null;


-- ═══ 3. That one row cannot be revoked, denied or deleted ═══════════════════
--
-- WHY A TRIGGER AND NOT A POLICY. The Control Centre writes overrides through
-- /api/control-center/permissions/employees/[id] with the SERVICE ROLE, which
-- is exempt from RLS. A policy would protect the row from a browser and not
-- from the route that actually writes it. A BEFORE trigger fires for every
-- role, service_role included, so this is the only placement that is true.
--
-- The API route refuses the same change with a sentence an administrator can
-- read, and both Control Centre screens already render an admin's row
-- read-only. This is the floor under all three: the screen explains, the route
-- explains, and the database refuses.
--
-- NARROW ON PURPOSE. Exactly one (user, module, action) triple is protected.
-- Every other override on the owner's account, and every override belonging to
-- anybody else, is written and revoked exactly as it is today — including other
-- people's approve_order, which is the whole point of the permission being
-- grantable.
--
-- WHAT IS STILL ALLOWED on the protected row: a re-grant (allowed stays true),
-- and a change of granted_by/granted_at. Only the four shapes that would take
-- the authority away are refused.
--
-- THE FOURTH SHAPE IS THE ONE THAT IS EASY TO MISS. (user_id, module_id,
-- action_id) is a UNIQUE key, not an immutable one, so an UPDATE can re-point
-- the protected row at a different employee, module or action. The row would
-- survive, every "is it still there" check would pass, and the owner would have
-- lost Order Approval. So the guard reads the triple BEFORE and AFTER and
-- refuses a move off the protected one — it is a removal wearing an update.

create or replace function public.guard_permanent_order_approval_grant()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $guard$
declare
  v_was_protected boolean := false;
  v_is_protected  boolean := false;
begin
  -- OLD and NEW are read ONLY in the branch that has them. A CASE spanning both
  -- would touch OLD on an INSERT, where PL/pgSQL does not promise to hand it
  -- over.
  if tg_op in ('UPDATE', 'DELETE') then
    v_was_protected := public.is_permanent_order_approval_grant(
      old.user_id, old.module_id, old.action_id);
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_is_protected := public.is_permanent_order_approval_grant(
      new.user_id, new.module_id, new.action_id);
  end if;

  -- The overwhelmingly common case: a write about somebody else, some other
  -- module, or some other action. Nothing below applies to it.
  if not v_was_protected and not v_is_protected then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'ORDER_APPROVAL_GRANT_PERMANENT: the owner account permanently holds Order Approval; this grant cannot be deleted'
      using errcode = '42501';
  end if;

  if v_was_protected and not v_is_protected then
    raise exception
      'ORDER_APPROVAL_GRANT_PERMANENT: the owner account permanently holds Order Approval; this grant cannot be re-pointed at another employee, module or action'
      using errcode = '42501';
  end if;

  if new.allowed is not true then
    raise exception
      'ORDER_APPROVAL_GRANT_PERMANENT: the owner account permanently holds Order Approval; this grant cannot be denied'
      using errcode = '42501';
  end if;

  if new.revoked_at is not null or new.revoked_by is not null then
    raise exception
      'ORDER_APPROVAL_GRANT_PERMANENT: the owner account permanently holds Order Approval; this grant cannot be revoked'
      using errcode = '42501';
  end if;

  return new;
end;
$guard$;

comment on function public.guard_permanent_order_approval_grant() is
  'Refuses any write that would deny, revoke, delete or re-point the seeded owner''s orders.approve_order override. Fires for every role including service_role, which is why it is a trigger and not a policy. Touches no other employee, no other module and no other action.';

drop trigger if exists employee_permission_overrides_guard_permanent_order_approval
  on public.employee_permission_overrides;

create trigger employee_permission_overrides_guard_permanent_order_approval
  before insert or update or delete on public.employee_permission_overrides
  for each row execute function public.guard_permanent_order_approval_grant();

-- Reached only by the trigger above.
revoke execute on function public.guard_permanent_order_approval_grant() from public, anon, authenticated;




-- ═══ 4. Order Approval is NOT implied by the global admin role ══════════════
--
-- THE DEFECT THIS CORRECTS. Every decision door below asked
-- actor_has_module_permission('orders', 'approve_order'), and that helper is
-- `active admin OR the resolver` — the admin branch short-circuits before the
-- resolver is ever consulted (20260901000000). So the permission was real for
-- everybody except an administrator, for whom it was decoration: the Control
-- Centre could show it withdrawn, the resolver could report false, and the
-- database would still say yes. An owner could not take PI approval away from
-- a colleague who happened to hold the admin role.
--
-- THE CORRECTION IS ONE EXPRESSION, in one new function, substituted into the
-- four doors. Nothing else about them changes.
--
--   actor_can_approve_order()   the resolver ONLY — no role branch
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   * It does not change what the admin role means anywhere else. Every other
--     action in every other module still runs through
--     actor_has_module_permission and still has its admin branch. This file
--     narrows ONE action.
--
--   * It does not touch VISIBILITY. can_view_order_submission() and the
--     order_submissions_select policy keep asking
--     actor_has_module_permission, so an administrator still SEES every PI —
--     which is what support, correction and oversight need, and is not a
--     decision about anybody's order. Seeing a PI and approving one are
--     different authorities, and only the second one is being withdrawn.
--
--   * It does not touch Order DOCUMENT GENERATION
--     (request_order_document_generation and the two
--     order_document_versions policies, 20260925000000). Producing the Excel
--     and PDF for an already-confirmed Order decides nothing about whether the
--     order exists. Withdrawing it was not asked for and would be a second
--     change hiding inside this one.
--
--   * It does not touch orders.approve_advance_exception or
--     orders.align_production, which are separate actions with their own
--     admin branches, unchanged.
--
-- WHO CAN APPROVE AFTER THIS FILE
--
--   the owner (TEST-001)  always — the unrevokable override from §2, which the
--                         resolver reports like any other grant, so no second
--                         code path is needed to make him permanent
--   anybody else          only while an active employee_permission_overrides
--                         row grants them orders.approve_order, admin or not
--   nobody by role        the admin role alone grants this nowhere

create or replace function public.actor_can_approve_order()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.actor_has_permission('orders', 'approve_order')
$$;

comment on function public.actor_can_approve_order() is
  'Whether the caller may take an Order Management approval decision: approve or reject a PI, send one back, or confirm an Order. The PERMISSION-ONLY resolver — deliberately not actor_has_module_permission, whose admin branch would hand this authority to every administrator and make it impossible to withdraw. The seeded owner holds it through the unrevokable override in this migration, not through a branch here. actor_has_permission already requires an active, non-deleted employee.';

revoke execute on function public.actor_can_approve_order() from public, anon;
grant  execute on function public.actor_can_approve_order() to authenticated;


-- ── request_order_submission_changes ──
--
-- Copied from 20260908000000_order_pi_submissions.sql.
-- SEND BACK FOR CHANGES. A review decision on somebody else's PI: it takes
-- the record out of review and puts it back in the employee's hands. Same
-- authority as rejecting it, and it moves with it.

create or replace function public.request_order_submission_changes(
  p_submission_id uuid,
  p_note          text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_status text;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.actor_can_approve_order() then
    raise exception 'You do not have permission to review order submissions'
      using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'ORDER_SUBMISSION_NOTE_REQUIRED: say what needs to change'
      using errcode = 'P0001';
  end if;

  select s.status into v_status
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted record can be sent back (this one is %)', v_status
      using errcode = 'P0001';
  end if;

  update public.order_submissions
     set status = 'needs_changes',
         review_note = v_note
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'changes_requested', 'submitted', 'needs_changes', v_note, '{}'::jsonb
  );

  return jsonb_build_object('id', p_submission_id, 'status', 'needs_changes');
end;
$$;


-- ── reject_order_submission ──
--
-- Copied from 20260910000000_order_submission_phase_a_review.sql.
-- REJECT. The refusal half of "approve or reject a PI uploaded by another
-- user", and one of the two capabilities that must disappear the moment the
-- grant is withdrawn.

create or replace function public.reject_order_submission(
  p_submission_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_status text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.actor_can_approve_order() then
    raise exception 'You do not have permission to review order submissions'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'ORDER_SUBMISSION_REASON_REQUIRED: say why this is being rejected'
      using errcode = 'P0001';
  end if;

  select s.status into v_status
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted record can be rejected (this one is %)', v_status
      using errcode = 'P0001';
  end if;

  -- One statement: the status, the reviewer, the time and the reason land
  -- together or not at all, and the rejection consistency constraint from
  -- 20260908000000 refuses any half of it.
  update public.order_submissions
     set status      = 'rejected',
         rejected_by = v_actor,
         rejected_at = now(),
         review_note = v_reason
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'rejected', 'submitted', 'rejected', v_reason, '{}'::jsonb
  );

  -- The established shape: an id and a state. No commercial figure, no client
  -- name, no path — nothing a caller could not already read.
  return jsonb_build_object('id', p_submission_id, 'status', 'rejected');
end;
$$;


-- ── approve_pi_review ──
--
-- Copied from 20261119000000_order_submission_pi_review_gate_versions_and_production.sql.
-- APPROVE THE PI. The other half. This is the decision auto-approval records
-- on the submitter's behalf, so the two must answer to the same authority or
-- the door and the shortcut would disagree.

create or replace function public.approve_pi_review(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_sub   public.order_submissions%rowtype;
  v_now   timestamptz;
begin
  if not public.actor_can_approve_order() then
    raise exception 'You do not have permission to approve order submissions'
      using errcode = '42501';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be approved'
      using errcode = '55P03';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can be approved (this one is %)', v_sub.status
      using errcode = 'P0001';
  end if;

  if not public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED: this PI has not been verified by finance for the submission under review'
      using errcode = 'P0001';
  end if;

  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) in this PI must be fixed before it can be approved',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  -- Already decided against THIS submission: answer, do not re-record.
  if public.order_submission_pi_approved(
       v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at) then
    return jsonb_build_object(
      'id',               p_submission_id,
      'pi_approved',      true,
      'pi_approved_at',   v_sub.pi_approved_at,
      'already_approved', true
    );
  end if;

  v_now := now();

  update public.order_submissions
     set pi_approved_by            = v_actor,
         pi_approved_at            = v_now,
         pi_approved_submission_at = v_sub.submitted_at
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
    jsonb_build_object(
      'approved_submission_at', v_sub.submitted_at,
      'order_created',          false
    )
  );

  return jsonb_build_object(
    'id',               p_submission_id,
    'pi_approved',      true,
    'pi_approved_at',   v_now,
    'already_approved', false
  );
end;
$$;


-- ── approve_order_submission ──
--
-- Copied from 20261201000000_order_submission_confirmation_required_fields.sql.
-- CONFIRM THE ORDER. The action is called "Approve PI / Confirm Order" because
-- it is ONE capability with two halves, and splitting the authority between
-- them would leave somebody who cannot approve a PI able to turn one into a
-- numbered Order.
--
-- THE LONGEST RE-EMISSION IN THIS FILE, and nothing else in it moves. Every
-- finance-verification, payment-gate, required-field, locking and numbering
-- rule is copied character for character; the test extracts both copies and
-- compares them with the one substitution applied.

create or replace function public.approve_order_submission(
  p_submission_id uuid,
  p_assigned_to   uuid,
  p_confirm_date  date,
  p_due_date      date,
  p_lead_source   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := public.assert_order_submission_actor();
  v_sub          public.order_submissions%rowtype;
  v_order_id     uuid;
  v_number       text;
  v_now          timestamptz;
  v_item_count   integer;
  v_bad          integer;
  v_bad_row      integer;
  v_client       text;
  v_verified     numeric;
  v_unverified   numeric;
  v_required     numeric;
  v_shortfall    numeric;
  v_route        text;
  v_exception_current boolean;
  v_moved_count  integer := 0;
  v_moved_amount numeric := 0;
  v_stranded     integer;
  v_pi_stamped   boolean := false;
  v_codes        jsonb;
  v_lead_source  text;
  v_salesperson  uuid;
begin
  -- ── 1. Authorization, server-side, before anything is read ──
  if not public.actor_can_approve_order() then
    raise exception 'You do not have permission to approve order submissions'
      using errcode = '42501';
  end if;

  -- ── 2. The lock, before any mutable state is judged ──
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- ── 3. Already approved: answer with what exists ──
  if v_sub.status = 'approved' and v_sub.order_id is not null then
    select o.display_number into v_number
    from public.orders o where o.id = v_sub.order_id;

    return jsonb_build_object(
      'submission_id',    p_submission_id,
      'order_id',         v_sub.order_id,
      'display_number',   v_number,
      'already_approved', true
    );
  end if;

  -- ── 4. A deletion reservation freezes the record for everybody ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be approved'
      using errcode = '55P03';
  end if;

  -- ── 5. Only a submitted PI can be approved ──
  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can be approved (this one is %)', v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_ALREADY_LINKED: this PI is already linked to an Order'
      using errcode = 'P0001';
  end if;

  -- ── 5b. The four fields a Confirmed Order cannot be built without ──
  --
  -- WHY HERE. Before the payment gate, before the diagnostics, before the
  -- workbook and image checks and before anything is written: a conversion
  -- refused for a missing field must leave the PI exactly as it found it.
  --
  -- WHY IN THE DATABASE. The screen asks for all four and will not submit
  -- without them, and that is a courtesy rather than a control. A stale client,
  -- a replayed request and a hand-made PostgREST call all arrive here.
  --
  -- HISTORICAL ORDERS ARE UNTOUCHED. This is a rule about CREATING an Order,
  -- expressed in the function that creates one. public.orders keeps every
  -- column nullable, so the Orders that predate this migration still read and
  -- still open.
  if p_assigned_to is null then
    raise exception
      'ORDER_CONFIRMATION_SALESPERSON_REQUIRED: a salesperson is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  select id into v_salesperson from public.users where id = p_assigned_to;
  if v_salesperson is null then
    raise exception
      'ORDER_CONFIRMATION_SALESPERSON_UNKNOWN: that salesperson is not a BOE user'
      using errcode = 'P0001';
  end if;

  if p_confirm_date is null then
    raise exception
      'ORDER_CONFIRMATION_CONFIRM_DATE_REQUIRED: a confirm date is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  if p_due_date is null then
    raise exception
      'ORDER_CONFIRMATION_DUE_DATE_REQUIRED: a due date is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  v_lead_source := nullif(btrim(coalesce(p_lead_source, '')), '');
  if v_lead_source is null then
    raise exception
      'ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED: a lead source is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  -- The SAME five values public.orders has always accepted. The CHECK
  -- constraint would refuse anything else at the INSERT; naming it here means
  -- the refusal is a sentence about the field rather than a constraint name.
  if v_lead_source not in ('reference', 'repeat_customer', 'whatsapp', 'instagram', 'website') then
    raise exception
      'ORDER_CONFIRMATION_LEAD_SOURCE_INVALID: that lead source is not one BOE records'
      using errcode = 'P0001';
  end if;

  -- ── 6. Finance verification must be CURRENT ──
  if not public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED: this PI has not been verified by finance for the submission under review'
      using errcode = 'P0001';
  end if;

  v_now := now();

  -- ── 6b. The PI decision, if it has not been taken against this submission ──
  if not public.order_submission_pi_approved(
       v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at) then
    update public.order_submissions
       set pi_approved_by            = v_actor,
           pi_approved_at            = v_now,
           pi_approved_submission_at = v_sub.submitted_at
     where id = p_submission_id;
    v_pi_stamped := true;
    v_sub.pi_approved_by            := v_actor;
    v_sub.pi_approved_at            := v_now;
    v_sub.pi_approved_submission_at := v_sub.submitted_at;
  end if;

  -- ── 6a. The total the requirement is a percentage of ──
  if v_sub.grand_total is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored grand total'
      using errcode = 'P0001';
  end if;

  -- ── 7. The PAYMENT gate, live, under locks ──
  perform 1
  from public.finance_payment_requests f
  where f.id in (
    select a.payment_request_id
    from public.finance_payment_allocations a
    where a.order_submission_id = p_submission_id
  )
  order by f.id
  for update;

  perform 1
  from public.finance_payment_allocations a
  where a.order_submission_id = p_submission_id
  order by a.id
  for update;

  v_verified   := public.order_submission_verified_payment(p_submission_id);
  v_unverified := public.order_submission_unverified_payment(p_submission_id);
  v_required   := public.order_submission_required_payment(v_sub.grand_total);
  v_shortfall  := public.order_submission_payment_shortfall(v_sub.grand_total, v_verified);

  v_exception_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  if v_verified >= v_required then
    v_route := 'standard';
  elsif v_exception_current then
    v_route := 'exception';
  else
    v_route := null;
  end if;

  if v_route is null then
    if v_sub.advance_exception_status = 'pending' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_PENDING: The reduced-payment exception is still pending.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'rejected' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REJECTED: The reduced-payment exception was rejected. Update the PI before resubmitting.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'approved' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_STALE: The reduced-payment approval was given for different commercial terms and must be approved again.'
        using errcode = 'P0001';
    end if;

    if v_unverified > 0 then
      raise exception
        'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION: Payment is awaiting Finance verification. % more verified payment is required for standard approval, or Admin approval is required to proceed below 40%%.',
        '₹' || to_char(v_shortfall, 'FM999999999990.00')
        using errcode = 'P0001';
    end if;

    raise exception
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT: % more verified payment is required for standard approval. Admin approval is required to proceed below 40%%.',
      '₹' || to_char(v_shortfall, 'FM999999999990.00')
      using errcode = 'P0001';
  end if;

  -- ── 8. No blocking diagnostics ──
  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) in this PI must be fixed before it can be approved',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  -- ── 9. The fields an Order cannot be built without ──
  v_client := nullif(btrim(coalesce(v_sub.client_name, '')), '');
  if v_client is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  -- ── 10. The workbook: shape, then existence, then type ──
  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

  if v_sub.source_workbook_path !~
     ('^submissions/' || p_submission_id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the workbook is not stored under submissions/%/original/', p_submission_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: the PI workbook is missing from storage, or is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  -- ── 11. The product lines still satisfy the submission invariants ──
  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and (
      select count(*) from public.order_submission_item_images m
      where m.item_id = i.id and m.role = 'representative'
    ) <> 1;

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) do not have exactly one representative image (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and m.storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || m.item_id::text
         || '/' || m.role || '/' || m.position::text || '-' || m.sha256
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % image path(s) do not name this submission and their own product line',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(m.anchor_row) into v_bad, v_bad_row
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = m.storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % image(s) are missing from storage or are not a PNG, JPEG or WEBP (first anchored at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── 12. Everything holds. Open the approval context. ──
  perform set_config('boe.pi_submission_approval_id', p_submission_id::text, true);

  if v_pi_stamped then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
      jsonb_build_object(
        'approved_submission_at', v_sub.submitted_at,
        'order_created',          true
      )
    );
  end if;

  -- ── 13. Exactly one Order ──
  insert into public.orders (
    client_name, requested_by, assigned_to, confirm_date, due_date,
    total_value, total_product_value, lead_source,
    billing_percentage,
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    p_assigned_to,
    p_confirm_date,
    p_due_date,
    v_sub.grand_total,
    v_sub.gross_product_amount,
    v_lead_source,
    v_sub.billing_percentage,
    v_actor,
    'running',
    p_submission_id
  )
  returning id, display_number into v_order_id, v_number;

  -- ── 13b. Permanent BOE item codes, assigned the moment the Order exists ──
  v_codes := public.assign_order_product_codes(v_order_id, v_actor);

  -- ── 14. The submission becomes approved, and names its Order ──
  update public.order_submissions
     set status      = 'approved',
         approved_by = v_actor,
         approved_at = v_now,
         order_id    = v_order_id
   where id = p_submission_id;

  -- ── 14a. The money follows the record. It is MOVED, never copied. ──
  with moved as (
    update public.finance_payment_allocations
       set order_submission_id = null,
           order_id            = v_order_id
     where order_submission_id = p_submission_id
       and status = 'active'
    returning allocated_amount
  )
  select count(*), coalesce(sum(allocated_amount), 0)
    into v_moved_count, v_moved_amount
  from moved;

  select count(*) into v_stranded
  from public.finance_payment_allocations
  where order_submission_id = p_submission_id and status = 'active';

  if v_stranded > 0 then
    raise exception
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED: % allocation(s) still name this PI after conversion; no Order may be created over stranded money',
      v_stranded
      using errcode = 'P0001';
  end if;

  -- ── 14b. V1 of the Order's PI history: the document it was approved from ──
  insert into public.order_pi_versions (
    order_id, submission_id, version_number, status,
    workbook_path, workbook_name, workbook_sha256,
    uploaded_by, uploaded_at, revision_reason,
    decided_by, decided_at
  ) values (
    v_order_id, p_submission_id, 1, 'approved',
    v_sub.source_workbook_path, v_sub.source_workbook_name, v_sub.source_workbook_sha256,
    coalesce(v_sub.submitted_by, v_sub.created_by), coalesce(v_sub.submitted_at, v_now), null,
    v_actor, v_now
  );

  -- ── 15. Both trails ──
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'approved', 'submitted', 'approved', null,
    jsonb_build_object(
      'order_id',             v_order_id,
      'order_display_number', v_number,
      'item_count',           v_item_count,
      'payment_route',        v_route,
      'verified_payment',     v_verified,
      'unverified_payment',   v_unverified,
      'attached_payment',     v_verified + v_unverified,
      'required_payment',     v_required,
      'grand_total',          v_sub.grand_total,
      'pi_approved_at',       v_sub.pi_approved_at,
      'pi_approved_by',       v_sub.pi_approved_by
    )
  );

  if v_moved_count > 0 then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'payment_allocations_moved', 'approved', 'approved', null,
      jsonb_build_object(
        'order_id',           v_order_id,
        'allocation_count',   v_moved_count,
        'allocated_total',    v_moved_amount
      )
    );
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_pi_submission',
    jsonb_build_object(
      'order_submission_id',       p_submission_id,
      'item_count',                v_item_count,
      'payment_route',             v_route,
      'moved_allocation_count',    v_moved_count,
      'moved_allocated_total',     v_moved_amount,
      'production_alignment',      'not_aligned'
    )
  );

  if jsonb_array_length(v_codes) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_order_id, v_actor, 'order_product_codes_assigned',
      jsonb_build_object('codes', v_codes)
    );
  end if;

  -- ── 16. Close the context before returning ──
  perform set_config('boe.pi_submission_approval_id', '', true);

  -- ── 17. Identifiers only. Nothing the caller could not already read. ──
  return jsonb_build_object(
    'submission_id',    p_submission_id,
    'order_id',         v_order_id,
    'display_number',   v_number,
    'already_approved', false
  );
end;
$$;


-- ═══ 5. Submitting a PI: an approver who submits has already approved ═══════
--
-- RE-EMITTED IN FULL from 20261119000000 §4, the house rule for this function.
-- It differs in exactly three places and nowhere else:
--
--   1. four locals are declared (v_can_approve, v_submitted_at, v_pi_now,
--      v_auto_approved);
--   2. ONE block is appended after the existing activity logging, explained
--      where it stands;
--   3. the returned object carries two more keys.
--
-- Everything else — the length checks, the orders.create check, the ownership
-- rule for an exception, the attached-payment route, every completeness and
-- storage check, the three write shapes, the survival of an identical approved
-- exception and the trail's figures — is character-for-character what was
-- applied. src/lib/orders/orderApprovalAutoApprove.test.ts proves it by
-- extracting both copies and comparing them.

create or replace function public.submit_pi_for_review_internal(
  p_submission_id uuid,
  p_note          text,
  p_reason        text,
  p_payment_terms text,
  p_billing_terms text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_item_count integer;
  v_incomplete integer;
  v_bad        integer;
  v_bad_row    integer;
  v_note       text := nullif(btrim(coalesce(p_note, '')), '');
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_pay_terms  text := nullif(btrim(coalesce(p_payment_terms, '')), '');
  v_bill_terms text := nullif(btrim(coalesce(p_billing_terms, '')), '');
  v_verified   numeric;
  v_unverified numeric;
  v_attached   numeric;
  v_required   numeric;
  v_percent    numeric;
  v_attached_percent numeric;
  v_standard   numeric := public.order_submission_standard_advance_percent();
  v_route      text;
  v_keep       boolean := false;
  v_requested  boolean := false;
  v_meta       jsonb;
  -- ── Added by 20261224000000, for the auto-approval block at the foot ──
  v_can_approve   boolean := false;
  v_submitted_at  timestamptz;
  v_pi_now        timestamptz;
  v_auto_approved boolean := false;
begin
  if not public.actor_has_module_permission('orders', 'create') then
    raise exception 'You do not have permission to submit an order submission'
      using errcode = '42501';
  end if;

  if v_note is not null and char_length(v_note) > 1000 then
    raise exception
      'ORDER_SUBMISSION_NOTE_TOO_LONG: a reply may be at most 1000 characters (this one is %)',
      char_length(v_note)
      using errcode = 'P0001';
  end if;

  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  if v_pay_terms is not null and char_length(v_pay_terms) > 500 then
    raise exception
      'ORDER_SUBMISSION_TERMS_TOO_LONG: payment terms may be at most 500 characters (these are %)',
      char_length(v_pay_terms)
      using errcode = 'P0001';
  end if;

  if v_bill_terms is not null and char_length(v_bill_terms) > 500 then
    raise exception
      'ORDER_SUBMISSION_TERMS_TOO_LONG: billing terms may be at most 500 characters (these are %)',
      char_length(v_bill_terms)
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if not public.can_edit_order_submission(p_submission_id) then
    raise exception 'This order submission cannot be submitted by you in its current state'
      using errcode = '42501';
  end if;

  if v_sub.grand_total is null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored grand total, so its payment position cannot be judged'
      using errcode = 'P0001';
  end if;

  -- The live payment position, under the same locks the approval takes:
  -- payments before allocations, both in id order.
  perform 1
  from public.finance_payment_requests f
  where f.id in (
    select a.payment_request_id
    from public.finance_payment_allocations a
    where a.order_submission_id = p_submission_id
  )
  order by f.id
  for update;

  perform 1
  from public.finance_payment_allocations a
  where a.order_submission_id = p_submission_id
  order by a.id
  for update;

  v_verified   := public.order_submission_verified_payment(p_submission_id);
  v_unverified := public.order_submission_unverified_payment(p_submission_id);
  v_attached   := v_verified + v_unverified;
  v_required   := public.order_submission_required_payment(v_sub.grand_total);

  -- THE ROUTE IS CHOSEN ON ATTACHED PAYMENT. Money the client has paid and
  -- Finance has not yet looked at is not a reason to make the employee argue
  -- for an exception; it is a reason for Finance to look. Below 40% attached —
  -- zero included — the business must be told why before it is asked.
  v_route := case when v_attached >= v_required then 'standard' else 'exception' end;

  v_attached_percent := case
    when v_attached = 0 then 0
    else coalesce(public.order_submission_advance_percent_of(v_sub.grand_total, v_attached), 0)
  end;

  if v_route = 'exception' then
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED: say why an Order should be confirmed below the standard %% requirement'
        using errcode = 'P0001';
    end if;

    if v_pay_terms is null then
      raise exception
        'ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED: enter the agreed payment terms before asking to proceed below the standard requirement'
        using errcode = 'P0001';
    end if;

    if not (v_sub.created_by = v_actor or v_sub.submitted_by = v_actor) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_OWNER: only the owner of this PI may request an advance exception'
        using errcode = '42501';
    end if;

    -- THE SNAPSHOT keeps its applied meaning: verified payment, truncated and
    -- never rounded. On this route verified <= attached < the requirement, so
    -- the "strictly below 40" row constraint holds by construction.
    v_percent := case
      when v_verified = 0 then 0
      else coalesce(
        public.order_submission_advance_percent_of(v_sub.grand_total, v_verified), 0)
    end;

    if v_percent >= v_standard then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_TOTAL_NOT_POSITIVE: this PI has no positive grand total to measure a payment percentage against'
        using errcode = 'P0001';
    end if;

    v_keep := coalesce(
      v_sub.advance_condition = 'exception'
      and v_sub.advance_exception_reason is not distinct from v_reason
      and public.order_submission_exception_current(
            v_sub.advance_exception_status,
            v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
            v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
            v_sub.advance_exception_decided_payment_terms,   v_pay_terms,
            v_sub.advance_exception_decided_billing_terms,   v_bill_terms),
      false
    );
  end if;

  -- ── The completeness checks, identical to every other submission path ──
  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) must be fixed in the workbook before this can be submitted',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.client_name), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

  if v_sub.source_workbook_path !~
     ('^submissions/' || p_submission_id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the workbook is not stored under submissions/%/original/', p_submission_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: no file exists in order-files at the recorded workbook path'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX: the stored workbook is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_incomplete
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_incomplete > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_incomplete
      using errcode = 'P0001';
  end if;

  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and (
      select count(*) from public.order_submission_item_images m
      where m.item_id = i.id and m.role = 'representative'
    ) <> 1;

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) do not have exactly one representative image (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and m.storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || m.item_id::text
         || '/' || m.role || '/' || m.position::text || '-' || m.sha256
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % image path(s) do not name this submission and their own product line',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(m.anchor_row) into v_bad, v_bad_row
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = m.storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % image(s) are missing from storage or are not a PNG, JPEG or WEBP (first anchored at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── The write: one statement on every path ──
  if v_route = 'standard' then
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_condition = 'standard',
           advance_declared_amount = null,
           advance_exception_percent = null,
           advance_exception_reason = null,
           advance_exception_status = null,
           advance_exception_requested_by = null,
           advance_exception_requested_at = null,
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null
     where id = p_submission_id;

  elsif v_keep then
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_declared_amount = null,
           advance_exception_percent = v_percent
     where id = p_submission_id;

  else
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_condition = 'exception',
           advance_declared_amount = null,
           advance_exception_percent = v_percent,
           advance_exception_reason = v_reason,
           advance_exception_status = 'pending',
           advance_exception_requested_by = v_actor,
           advance_exception_requested_at = now(),
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null
     where id = p_submission_id;
    v_requested := true;
  end if;

  v_meta := jsonb_build_object(
    'advance_condition',  v_route,
    'advance_percent',    case when v_route = 'standard' then v_standard else v_percent end,
    'standard_percent',   v_standard,
    'grand_total',        v_sub.grand_total,
    'advance_amount',     v_verified,
    'verified_payment',   v_verified,
    'unverified_payment', v_unverified,
    'attached_payment',   v_attached,
    'attached_percent',   v_attached_percent,
    'required_payment',   v_required,
    'payment_terms',      v_pay_terms,
    'billing_terms',      v_bill_terms
  );

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
      || v_meta
  );

  if v_requested then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'advance_exception_requested', v_sub.status, 'submitted', v_reason,
      v_meta || jsonb_build_object('exception_status', 'pending')
    );
  end if;

  -- ══ AUTO-APPROVAL, and nothing but the PI decision ════════════════════════
  --
  -- LAST, so that it is unreachable by a PI that failed anything above it.
  -- Every workbook, completeness, image and storage check has already run and
  -- already had its chance to raise; a PI carrying a single blocking issue was
  -- refused hundreds of lines ago and never arrives here. Nothing in this block
  -- re-judges the document — it records a decision about one that has just
  -- been proved submittable.
  --
  -- THE PERMISSION IS ASKED OF THE ENGINE, AT THE MOMENT OF THE CALL. Not of a
  -- role name, not of a column on the record, and not of anything the browser
  -- sent. actor_can_approve_order() — §4's permission-only door, the SAME one
  -- the reviewer's Approve button goes through — resolves auth.uid() against
  -- the four precedence levels every time.
  --
  -- THE ADMIN ROLE IS NOT A BACK DOOR HERE, and that is the whole reason §4
  -- exists. Asking the admin-branching helper would have auto-approved every
  -- administrator's own uploads no matter what the Control Centre said, which
  -- is the defect this file corrects rather than reproduces.
  --
  -- So withdrawing somebody's approve_order stops the very next submission
  -- from being auto-approved, with no cache to wait for and nothing to
  -- redeploy. It rewrites no decision already recorded: a PI approved while
  -- the permission was held keeps its stamp and its trail, because this block
  -- only ever writes forward.
  --
  -- A SECOND STATEMENT, NOT A LONGER FIRST ONE, and that is forced rather than
  -- chosen. order_submissions_guard_pi_approval (20261119000000 §1) CLEARS the
  -- three pi_approved_ columns on any update that moves status, which every
  -- write above does — draft/needs_changes → submitted. Folding the stamp into
  -- those statements would therefore have written it and thrown it away in the
  -- same breath. Stamped here, the guard sees submitted → submitted and applies
  -- its other rule instead: the decision must be bound to the submission it was
  -- made against.
  --
  -- WHICH IS WHY submitted_at IS READ BACK. It is assigned by the status
  -- transition trigger from the transaction clock and is deliberately not
  -- something any caller can supply, so the only way to bind the decision to
  -- this submission is to ask the row what the trigger wrote.
  --
  -- THE TRAIL SAYS BOTH THINGS. 'submitted' was logged above with this actor as
  -- the uploader; 'pi_approved' is logged here with this actor as the approver,
  -- carrying auto_approved = true so a reader can tell a decision that was
  -- taken from one that was merely implied. Requirement and consequence: on an
  -- auto-approved PI the uploader and the approver are the same person, and the
  -- history says so in two separate events rather than pretending otherwise.
  v_can_approve := public.actor_can_approve_order();

  if v_can_approve then
    select submitted_at into v_submitted_at
    from public.order_submissions
    where id = p_submission_id;

    v_pi_now := now();

    update public.order_submissions
       set pi_approved_by            = v_actor,
           pi_approved_at            = v_pi_now,
           pi_approved_submission_at = v_submitted_at
     where id = p_submission_id;

    v_auto_approved := true;

    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
      jsonb_build_object(
        'approved_submission_at', v_submitted_at,
        'order_created',          false,
        'auto_approved',          true,
        'submitted_by',           v_actor
      )
    );
  end if;

  return jsonb_build_object(
    'id',                  p_submission_id,
    'status',              'submitted',
    'item_count',          v_item_count,
    'payment_route',       v_route,
    'verified_payment',    v_verified,
    'unverified_payment',  v_unverified,
    'attached_payment',    v_attached,
    'required_payment',    v_required,
    'exception_requested', v_requested,
    -- Added by 20261224000000. Additive: every key above is unchanged, so a
    -- caller that reads only exception_requested is unaffected.
    'pi_auto_approved',    v_auto_approved,
    'pi_approved_at',      v_pi_now
  );
end;
$$;

revoke execute on function public.submit_pi_for_review_internal(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_pi_for_review_internal(uuid, text, text, text, text) is
  'The implementation of submitting a PI for review. Since 20261119000000 the route is chosen on ATTACHED payment (verified + awaiting verification): at or above 40% no reason is owed; below it — zero included — a reason and Payment Terms are mandatory and the existing reduced-payment exception is raised. Since 20261224000000 a submitter who holds orders.approve_order also has the PI DECISION stamped in the same transaction, after every validation has passed; that decision creates no Order, reserves no order number and settles no advance exception. Gates no Order. Executable by no role: reached only by its door, as the definer.';

-- The door is UNCHANGED and is deliberately not re-emitted: it is one line over
-- the function above, so it inherits the new behaviour without a new signature,
-- a new grant, or a second place for the rule to live.


-- ═══ 6. Assertions ══════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $assert$
declare
  v_n   integer;
  v_def text;
begin
  -- ── The owner is who this file thinks he is ──
  --
  -- employee_code is UNIQUELY indexed where non-null
  -- (20260608000100_add_employee_fields.sql), so "exactly one" is a database
  -- guarantee rather than a hope. The count is asserted anyway because ZERO is
  -- the case that matters: an environment without this account must fail the
  -- migration loudly rather than seed nothing and leave the guard protecting a
  -- row that does not exist.
  select count(*) into v_n from public.users where employee_code = 'TEST-001';
  if v_n <> 1 then
    raise exception 'OWNER ACCOUNT: expected exactly one user with employee_code TEST-001, found %', v_n;
  end if;

  -- And it is the owner/administrator account 20260697000000 and 20260719000000
  -- both resolve by this code — not a code that has since been reused for
  -- somebody else. Cheap, and it is the difference between pinning the right
  -- row and pinning a row.
  select count(*) into v_n
  from public.users
  where employee_code = 'TEST-001'
    and role = 'admin'
    and is_active
    and coalesce(is_deleted, false) = false;
  if v_n <> 1 then
    raise exception
      'OWNER ACCOUNT: TEST-001 is not an active, non-deleted admin account; refusing to pin Order Approval to it';
  end if;

  select count(*) into v_n
  from public.employee_permission_overrides eo
  join public.users u              on u.id  = eo.user_id
  join public.permission_modules pm on pm.id = eo.module_id
  join public.permission_actions pa on pa.id = eo.action_id
  where u.employee_code = 'TEST-001'
    and pm.module_key = 'orders'
    and pa.action_key = 'approve_order'
    and eo.allowed
    and eo.revoked_at is null;
  if v_n <> 1 then
    raise exception 'OWNER GRANT: orders.approve_order is not actively granted to TEST-001 (% active rows)', v_n;
  end if;

  -- The resolver agrees. This is the check that matters: the row is only a
  -- means, and what the rest of the system reads is resolve_permission.
  if not (
    select public.resolve_permission(u.id, 'orders', 'approve_order')
    from public.users u where u.employee_code = 'TEST-001'
  ) then
    raise exception 'OWNER GRANT: the resolver does not report orders.approve_order for TEST-001';
  end if;

  -- The guard is installed, and installed as a real row-level trigger rather
  -- than something PostgreSQL made on its own behalf.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'employee_permission_overrides_guard_permanent_order_approval'
      and tgrelid = 'public.employee_permission_overrides'::regclass
      and not tgisinternal
  ) then
    raise exception 'GUARD: the permanent-grant trigger is not installed';
  end if;

  -- The guard actually refuses. Attempted, caught, rolled back to the
  -- savepoint: the seeded row is left exactly as §2 wrote it.
  begin
    update public.employee_permission_overrides eo
       set allowed = false
      from public.users u, public.permission_modules pm, public.permission_actions pa
     where eo.user_id = u.id and eo.module_id = pm.id and eo.action_id = pa.id
       and u.employee_code = 'TEST-001'
       and pm.module_key = 'orders'
       and pa.action_key = 'approve_order';
    raise exception 'GUARD: denying the owner''s orders.approve_order was allowed';
  exception
    when insufficient_privilege then
      null;  -- 42501, the refusal this migration installed
  end;

  -- Auto-approval is in the submit door, and it asks the engine.
  select prosrc into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'submit_pi_for_review_internal';

  if v_def not like '%actor_can_approve_order()%' then
    raise exception 'AUTO-APPROVAL: the submit door does not resolve orders.approve_order';
  end if;
  if v_def not like '%pi_approved_submission_at = v_submitted_at%' then
    raise exception 'AUTO-APPROVAL: the PI decision is not bound to the submission it was made against';
  end if;
  if v_def not like '%ORDER_SUBMISSION_BLOCKED%' then
    raise exception 'AUTO-APPROVAL: the blocking-issue check was lost in the re-emission';
  end if;

  -- The Order gate did not move. This file must not have touched it.
  -- By arity, not by a spelled-out argument list: the five-argument overload is
  -- the conversion (20261201000000), the one-argument one is that migration's
  -- compatibility blocker.
  select prosrc into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'approve_order_submission'
    and p.pronargs = 5;

  if v_def is null or v_def not like '%ORDER_SUBMISSION_FINANCE_NOT_VERIFIED%' then
    raise exception 'ORDER GATE: approve_order_submission no longer requires a current finance verification';
  end if;

  -- ── THE ADMIN BYPASS IS GONE FROM EVERY DECISION DOOR ──
  --
  -- Asked of pg_proc rather than of the file, so a door somebody re-emits
  -- later with the old helper is caught here and not at the next incident.
  -- The five are the four review doors plus the submit door's auto-approval.
  select count(*) into v_n
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.proname, p.pronargs) in (
      ('request_order_submission_changes', 2), ('reject_order_submission', 2),
      ('approve_pi_review', 1), ('approve_order_submission', 5),
      ('submit_pi_for_review_internal', 5))
    and p.prosrc like '%actor_has_module_permission(''orders'', ''approve_order'')%';
  if v_n <> 0 then
    raise exception
      'ADMIN BYPASS: % approval door(s) still resolve approve_order through the admin-branching helper', v_n;
  end if;

  select count(*) into v_n
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.proname, p.pronargs) in (
      ('request_order_submission_changes', 2), ('reject_order_submission', 2),
      ('approve_pi_review', 1), ('approve_order_submission', 5),
      ('submit_pi_for_review_internal', 5))
    and p.prosrc like '%actor_can_approve_order()%';
  if v_n <> 5 then
    raise exception
      'ADMIN BYPASS: expected 5 doors on the permission-only authority, found %', v_n;
  end if;

  -- And the permission-only door really is permission-only.
  select prosrc into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'actor_can_approve_order';
  if v_def is null or v_def like '%actor_has_module_permission%' or v_def like '%admin%' then
    raise exception 'ADMIN BYPASS: actor_can_approve_order still consults the admin role';
  end if;

  -- ── VISIBILITY IS DELIBERATELY UNCHANGED ──
  -- An administrator still SEES every PI. If this ever stops being true it is
  -- a decision somebody made, not something this file did by accident.
  select prosrc into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'can_view_order_submission';
  if v_def is null or v_def not like '%actor_has_module_permission(''orders'', ''approve_order'')%' then
    raise exception 'VISIBILITY: can_view_order_submission was changed; administrators have lost sight of PIs';
  end if;
end $assert$;
