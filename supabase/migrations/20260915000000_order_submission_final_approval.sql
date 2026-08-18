-- PI submissions, Phase C — finance verification, final approval, and the one
-- transaction that turns an approved PI into a numbered Confirmed Order.
--
-- This is the phase every earlier one deferred to by name. 20260908000000 wrote
-- "Set only by the approval phase; nothing in 20260908000000 writes it" over
-- order_submissions.order_id; 20260910000000 asserted at apply time that its own
-- transition trigger never named 'approved'; 20260913000000 built
-- order_submission_advance_ready() and called it "the predicate the approval
-- phase must consult". This file is that phase, and it consults exactly those
-- things rather than restating them.
--
-- WHAT IT ADDS, IN ONE SENTENCE EACH
--
--   finance verification   a SECOND, separate authority signs off the
--                          commercial figures before the PI can be approved,
--                          and the sign-off goes stale the moment the record
--                          moves
--   final approval         one SECURITY DEFINER RPC that re-derives every
--                          eligibility rule under a row lock and, if they all
--                          hold, creates exactly one Order
--   the link               orders.source_order_submission_id, unique, immutable,
--                          the mirror of order_submissions.order_id
--
-- WHAT IT DELIBERATELY DOES NOT ADD
--
--   * No payment, payment request, receipt or reconciliation row. Finance
--     verification VERIFIES FIGURES; it does not record that money arrived, and
--     the dialog behind it says so in as many words.
--   * No second Order-number allocator, no sequence, no counter, and no
--     max(display_number)+1 anywhere. The number comes from the 20260703/20260704
--     cycle through the existing BEFORE INSERT trigger, or it does not come.
--   * No order_items table. Orders have never had product-line storage and
--     inventing one here would be a subsystem, not a phase. The approved
--     submission and its items remain the authoritative PI snapshot, reachable
--     from the Order through this migration's new column.
--   * No document generation. A numbered .xlsx and a faithful PDF are the next
--     bounded phase; see the note at the foot of this file.
--   * No post-approval amendment path, no split payment, no production tracking.
--
-- WHAT IT DOES NOT TOUCH
--
--   Not one applied migration is edited. Every function this file redefines is
--   redefined with CREATE OR REPLACE at its existing signature, so the live ACL
--   survives and no DROP discards a grant. No existing Order is renumbered, no
--   Order status is changed, no RLS policy is made more permissive than the
--   record's own module gate already allows, and the advance workflow's
--   columns, constraints, guard and RPCs are read but never rewritten.

-- ═══ 1. Finance verification, as columns ════════════════════════════════════
--
-- ON order_submissions, not in a table of its own, for the reason 20260914000000
-- gives for the deletion claim: at most one verification is current at a time,
-- and the row lock that decides "may this be approved" is then the same lock
-- that decides "is it verified". One decision instead of two that can disagree.
--
-- THE THIRD COLUMN IS THE WHOLE DESIGN. finance_verified_submission_at pins the
-- verification to the SUBMISSION IT WAS MADE AGAINST, by copying submitted_at at
-- the moment of verification. A resubmission takes a new submitted_at (the
-- transition trigger from 20260910000000 is its only writer), so a verification
-- carried over from an earlier version no longer matches and is not current —
-- even if the clearing trigger in section 6 were somehow bypassed. Version
-- binding and clearing are both present on purpose: the clearing keeps the row
-- honest to read, and the binding makes staleness impossible to fake.

alter table public.order_submissions
  add column if not exists finance_verified_by            uuid references public.users(id),
  add column if not exists finance_verified_at            timestamptz,
  add column if not exists finance_verified_submission_at timestamptz;

comment on column public.order_submissions.finance_verified_by is
  'The finance authority who verified this PI''s commercial figures and advance terms. Never a record that any payment was received, requested or reconciled.';
comment on column public.order_submissions.finance_verified_at is
  'When finance verification was recorded. Written only by verify_pi_finance_check().';
comment on column public.order_submissions.finance_verified_submission_at is
  'The submitted_at this verification was made against. A resubmission takes a new submitted_at, so a carried-over verification stops matching and stops being current. Cleared outright by the guard in section 6 whenever the PI moves.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_submissions'::regclass
      and conname  = 'order_submissions_finance_verification_complete'
  ) then
    -- A verification is never half-written: an actor with no time, or a time
    -- bound to no submission, is not a sign-off anybody can rely on.
    alter table public.order_submissions
      add constraint order_submissions_finance_verification_complete check (
        (finance_verified_by is null
         and finance_verified_at is null
         and finance_verified_submission_at is null)
        or
        (finance_verified_by is not null
         and finance_verified_at is not null
         and finance_verified_submission_at is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_submissions'::regclass
      and conname  = 'order_submissions_finance_verification_needs_submission'
  ) then
    -- Nothing that was never submitted can carry a verification. Stated as a
    -- table constraint so a direct UPDATE and a service-role write are refused
    -- by the same rule a browser is.
    alter table public.order_submissions
      add constraint order_submissions_finance_verification_needs_submission check (
        finance_verified_at is null or submitted_at is not null
      );
  end if;
end $$;

-- Only a verified row is indexed: verification is transient and this is read to
-- find what is waiting.
create index if not exists order_submissions_finance_verified_idx
  on public.order_submissions (finance_verified_at)
  where finance_verified_at is not null;

-- ═══ 2. One submission, one Order — in both directions ══════════════════════
--
-- order_submissions.order_id already exists, already carries
-- order_submissions_order_id_key (unique, partial) and already carries
-- order_submissions_order_link_requires_approval. That is one half of the
-- relationship. This is the other, and it is the exact mirror of what
-- 20260701000000 did for Order Requests, deliberately so.
--
-- WHY BOTH HALVES. The submission-side index stops one submission naming two
-- Orders. Without the Order-side index, two submissions could name the same
-- Order — a shape neither is checked against by the other, and one an
-- interrupted retry could genuinely produce. Two partial unique indexes pointing
-- in opposite directions make "exactly one Order per approved PI" a database
-- guarantee rather than a property of the RPC that happens to write it.
--
-- FK deletion behaviour is the DEFAULT (NO ACTION), also deliberately: Postgres
-- will refuse to delete an order_submissions row any Order still names as its
-- source, for every role including the service role. That is what makes
-- "an approved PI is never erased" true even though 20260914000000's deletion
-- path exists — and that path already refuses anything outside
-- draft/needs_changes/rejected, so the two guards agree.

alter table public.orders
  add column if not exists source_order_submission_id uuid references public.order_submissions(id);

comment on column public.orders.source_order_submission_id is
  'The PI submission this Order was created from, if any. Set only by approve_order_submission() and immutable thereafter. NO ACTION FK: an approved PI can never be hard-deleted while an Order names it.';

create unique index if not exists orders_source_order_submission_id_uidx
  on public.orders (source_order_submission_id)
  where source_order_submission_id is not null;

-- Provenance is read-only, for every role. orders_admin_update and
-- orders_operations_update grant UPDATE over the whole row, so without this an
-- administrator could silently re-point an Order at a different PI and the audit
-- trail would be unfalsifiable. Same idiom, and deliberately the same shape, as
-- prevent_order_source_request_change (20260701000000): setting it from NULL is
-- allowed exactly once — which is what lets the approval RPC populate it on an
-- Order it has just inserted — and a no-op write of the same value passes, so
-- ordinary status and notes updates never trip it.
--
-- A SEPARATE TRIGGER from orders_protect_source_request rather than an edit to
-- it: 20260701000000 is applied and is not this file's to rewrite.
create or replace function public.prevent_order_source_submission_change()
returns trigger
language plpgsql
as $$
begin
  if old.source_order_submission_id is not null
     and new.source_order_submission_id is distinct from old.source_order_submission_id then
    raise exception
      'ORDER_SOURCE_SUBMISSION_IMMUTABLE: the PI an Order was created from cannot be changed once set'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.prevent_order_source_submission_change()
  from public, anon, authenticated;

drop trigger if exists orders_protect_source_submission on public.orders;
create trigger orders_protect_source_submission
  before update on public.orders
  for each row execute function public.prevent_order_source_submission_change();

-- ═══ 3. The approval context ════════════════════════════════════════════════
--
-- Same idiom, and the same honesty about what it is for, as
-- in_order_cancellation() (20260819000000 §2) and
-- order_submission_purge_in_progress() (20260914000000 §3): THIS IS NOT AN
-- AUTHORIZATION CHECK. Authorization is the permission gate inside
-- approve_order_submission(). This flag exists so the triggers in sections 4 and
-- 5 can tell an approval performed through the audited RPC from a bare UPDATE —
-- a distinction no privilege and no policy can express, because the service role
-- bypasses both.
--
-- Transaction-local (the third argument to set_config is true), named for the
-- ONE submission being approved, and unset again before the RPC returns. A
-- marker naming a specific id cannot authorise a second record swept into the
-- same transaction.

create or replace function public.in_pi_submission_approval(p_submission_id uuid)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_marker text := current_setting('boe.pi_submission_approval_id', true);
begin
  return p_submission_id is not null
     and v_marker is not null
     and v_marker <> ''
     and v_marker = p_submission_id::text;
exception when others then
  -- A marker that is not a uuid, or any other surprise, is not authorization.
  return false;
end;
$$;

comment on function public.in_pi_submission_approval(uuid) is
  'True only inside approve_order_submission(), and only for the submission that call is approving. Not an authorization check — it distinguishes the audited approval path from a bare UPDATE, for callers RLS cannot reach.';

revoke execute on function public.in_pi_submission_approval(uuid)
  from public, anon, authenticated, service_role;

-- ═══ 4. The transition graph, with one move added ═══════════════════════════
--
-- The graph after this migration:
--
--   draft         → submitted
--   needs_changes → submitted
--   submitted     → needs_changes
--   submitted     → rejected
--   submitted     → approved      ← NEW, and only inside the approval RPC
--
-- 'approved' is now reachable, and reachable from exactly one state by exactly
-- one path. Every other caller — a browser, the service role, psql, a future RPC
-- written in haste — still raises, which is what keeps "an Order exists only
-- because somebody with the authority approved a submitted PI" an invariant of
-- the database rather than a property of the application.
--
-- APPROVAL IS TERMINAL. There is no transition OUT of 'approved', and there must
-- not be one: an Order now exists against the record, carries an official number
-- and is visible to the business. Reopening the PI would leave a numbered Order
-- attached to a record that claims not to have been approved. A commercial
-- change after approval is an Order amendment, which is a different phase and a
-- different table.
--
-- Restated from 20260910000000 §2 with the submitted → approved branch added and
-- the submitted_at rules preserved exactly. CREATE OR REPLACE at the same
-- signature, so the existing revokes survive.

create or replace function public.order_submissions_enforce_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception
        'ORDER_SUBMISSION_TRANSITION_INVALID: a submission must be created as draft, not %', new.status
        using errcode = '42501';
    end if;
    -- A submission is created as a draft, so it has no submission time. Stated
    -- rather than assumed, so an INSERT carrying one cannot pre-date itself.
    new.submitted_at := null;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'draft'            and new.status = 'submitted')
    or (old.status = 'needs_changes' and new.status = 'submitted')
    or (old.status = 'submitted'     and new.status = 'needs_changes')
    or (old.status = 'submitted'     and new.status = 'rejected')
    or (old.status = 'submitted'     and new.status = 'approved')
  ) then
    raise exception
      'ORDER_SUBMISSION_TRANSITION_INVALID: % cannot move from % to %',
      old.id, old.status, new.status
      using errcode = '42501';
  end if;

  -- THE APPROVAL PATH IS THE ONLY APPROVAL PATH. A legal transition is still
  -- refused unless it is happening inside approve_order_submission(), for THIS
  -- submission. Nothing a client can send opens that context.
  if new.status = 'approved' and not public.in_pi_submission_approval(old.id) then
    raise exception
      'ORDER_SUBMISSION_APPROVAL_PATH_REQUIRED: a PI can only be approved through approve_order_submission(), which allocates the Order number and creates the Order in the same transaction'
      using errcode = '42501';
  end if;

  -- THE ONLY WRITER OF submitted_at. now() is the transaction's own clock, so
  -- the value cannot be supplied, shifted or back-dated by the caller.
  if new.status = 'submitted' then
    new.submitted_at := now();
  else
    -- Returning a record for changes, rejecting it or approving it does not
    -- change WHEN it was submitted, and must not silently erase it either.
    new.submitted_at := old.submitted_at;
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_enforce_status_transition()
  from public, anon, authenticated;

-- ═══ 5. order_id and the approval audit fields are written once ═════════════
--
-- The status trigger above says WHEN a record may become approved. This says
-- what may be written alongside it, and it says it for every caller.
--
-- order_id is the link to a real, numbered Order. Left unguarded, anything
-- holding an UPDATE could point an approved submission at a different Order,
-- clear the link, or attach one to a record that was never approved. The table
-- constraint order_submissions_order_link_requires_approval (20260908000000)
-- already refuses the last of those; this refuses the rest.

create or replace function public.order_submissions_guard_order_link()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- A submission is created as an empty draft. It links to no Order and has
    -- no approval audit, and stating that here stops a row being INSERTed with
    -- an Order already attached by anything holding an INSERT privilege.
    if new.order_id is not null
       or new.approved_by is not null
       or new.approved_at is not null then
      raise exception
        'ORDER_SUBMISSION_APPROVAL_INVALID: a submission is created unapproved and linked to no Order'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- ONCE SET, FROZEN. Not re-pointed, not cleared, by anybody.
  if old.order_id is not null and new.order_id is distinct from old.order_id then
    raise exception
      'ORDER_SUBMISSION_ORDER_LINK_IMMUTABLE: the Order created from PI % cannot be changed or unlinked', old.id
      using errcode = '42501';
  end if;

  -- Set from NULL exactly once, and only inside the approval transaction.
  if old.order_id is null and new.order_id is not null
     and not public.in_pi_submission_approval(old.id) then
    raise exception
      'ORDER_SUBMISSION_APPROVAL_PATH_REQUIRED: a PI is linked to an Order only by approve_order_submission()'
      using errcode = '42501';
  end if;

  -- The approval audit moves only as part of an actual approval. A "helpful"
  -- data fix that restamps who approved something is refused.
  if (new.approved_by is distinct from old.approved_by
      or new.approved_at is distinct from old.approved_at)
     and not (new.status = 'approved' and old.status = 'submitted'
              and public.in_pi_submission_approval(old.id)) then
    raise exception
      'ORDER_SUBMISSION_FIELD_FROZEN: the approval record of % is written only by approving it', old.id
      using errcode = '42501';
  end if;

  -- AN APPROVED PI CARRIES AN ORDER, IN THE SAME STATEMENT. Splitting the two
  -- would leave a window in which an approved record had no Order and the
  -- number had been allocated to nothing.
  if new.status = 'approved' and old.status = 'submitted' and new.order_id is null then
    raise exception
      'ORDER_SUBMISSION_APPROVAL_INVALID: approving % must attach the Order it created, in the same statement', old.id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_guard_order_link()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_guard_order_link on public.order_submissions;
create trigger order_submissions_guard_order_link
  before insert or update on public.order_submissions
  for each row execute function public.order_submissions_guard_order_link();

-- ═══ 6. A verification goes stale the moment the record moves ═══════════════
--
-- WHY A TRIGGER AND NOT A CONDITION IN EIGHT FUNCTIONS. The transitions that
-- must invalidate a verification live in submit_order_submission,
-- submit_order_submission_with_note, submit_order_submission_with_advance,
-- request_order_submission_changes, reject_order_submission,
-- reject_pi_advance_exception and replace_order_submission_parse — all applied,
-- all immutable, and every one of them ending in an UPDATE of this row.
-- Restating seven functions to add one clause to each would be seven chances to
-- drift from what is deployed. One trigger on the UPDATE they all share is
-- smaller, catches every one of them, and catches the next one too — including
-- direct SQL and the service role, neither of which RLS or a grant can reach.
-- This is the same reasoning 20260914000000 §4 gives, applied to the same table.
--
-- TRIGGER ORDER. Triggers of the same timing fire in NAME order, and the six on
-- this table now sort:
--
--   order_submissions_enforce_status_transition   the status graph, first
--   order_submissions_guard_advance_exception     the advance decision
--   order_submissions_guard_deletion_claim        the deletion reservation
--   order_submissions_guard_finance_verification  this one
--   order_submissions_guard_frozen_columns        the creation record
--   order_submissions_guard_order_link            the Order link
--   order_submissions_set_updated_at              the stamp, last
--
-- so by the time this runs, an illegal status move has already been refused and
-- new.status is a status the graph actually permits.
--
-- APPROVAL DOES NOT CLEAR IT. The verification is part of the approved record's
-- history — who signed the figures off, and when — and erasing it at the moment
-- it is finally used would destroy the audit answer to "was this verified?".
-- Every other move away from 'submitted' clears it, because every other move
-- means the figures are about to change or the record is closed.

create or replace function public.order_submissions_guard_finance_verification()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.finance_verified_by is not null
       or new.finance_verified_at is not null
       or new.finance_verified_submission_at is not null then
      raise exception
        'ORDER_SUBMISSION_FINANCE_INVALID: a submission is created with no finance verification'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- ── The record is moving ──
  if new.status is distinct from old.status then
    if new.status = 'approved' then
      -- Kept, verbatim. The approval RPC has already proved it was current.
      return new;
    end if;

    -- Returned, rejected, resubmitted or replaced: whatever finance signed off
    -- is no longer the thing under review. CLEARED, not merely disregarded, so
    -- nothing downstream can read a stale sign-off and believe it.
    new.finance_verified_by            := null;
    new.finance_verified_at            := null;
    new.finance_verified_submission_at := null;
    return new;
  end if;

  -- ── The verification itself ──
  if new.finance_verified_at is not distinct from old.finance_verified_at
     and new.finance_verified_by is not distinct from old.finance_verified_by
     and new.finance_verified_submission_at is not distinct from old.finance_verified_submission_at then
    return new;
  end if;

  -- Clearing is always permitted: a withdrawal of a sign-off is never the
  -- dangerous direction.
  if new.finance_verified_at is null then
    return new;
  end if;

  -- Recording one is permitted only on a PI that is under review right now, and
  -- only bound to the submission actually in front of the verifier.
  if new.status <> 'submitted' or old.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_UNDER_REVIEW: only a submitted PI can be verified by finance'
      using errcode = '42501';
  end if;

  if new.finance_verified_submission_at is distinct from new.submitted_at then
    raise exception
      'ORDER_SUBMISSION_FINANCE_INVALID: a finance verification must be bound to the submission it was made against'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_guard_finance_verification()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_guard_finance_verification on public.order_submissions;
create trigger order_submissions_guard_finance_verification
  before insert or update on public.order_submissions
  for each row execute function public.order_submissions_guard_finance_verification();

-- ═══ 7. Is this record's finance verification CURRENT? ══════════════════════
--
-- The reusable rule, in one place, so the RPC and the screen cannot disagree
-- about it. Deliberately shaped like order_submission_advance_ready(): it takes
-- VALUES rather than an id, is immutable, and authorises nothing.
--
--   current  ⇔  a verification exists AND it is bound to THIS submitted_at
--
-- Two independent reasons a stale one fails: the guard in section 6 has already
-- cleared it, and the binding would not match even if it had not.

create or replace function public.order_submission_finance_verified(
  p_finance_verified_at            timestamptz,
  p_finance_verified_submission_at timestamptz,
  p_submitted_at                   timestamptz
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(
    p_finance_verified_at is not null
    and p_finance_verified_submission_at is not null
    and p_submitted_at is not null
    and p_finance_verified_submission_at = p_submitted_at,
    false
  )
$$;

comment on function public.order_submission_finance_verified(timestamptz, timestamptz, timestamptz) is
  'True only when a finance verification exists AND is bound to the submission currently under review. A verification carried over from an earlier submission is not current. Reads; authorises nothing.';

revoke execute on function public.order_submission_finance_verified(timestamptz, timestamptz, timestamptz)
  from public, anon;
grant  execute on function public.order_submission_finance_verified(timestamptz, timestamptz, timestamptz)
  to authenticated;

-- ═══ 8. Who may verify finance ══════════════════════════════════════════════
--
-- THE TWO-AUTHORITY RULE, AND WHY IT IS NOT SOFTENED.
--
-- orders.approve_order is the authority to REVIEW a PI. finance.approve is the
-- authority to decide money. Signing off that the commercial figures and the
-- advance terms are right is the second of those, and the business has chosen to
-- keep it separable from the first — so holding approve_order confers NO finance
-- authority here, in either direction, exactly as 20260913000000 keeps
-- approve_advance_exception separate from approve_order.
--
-- The rule:
--
--   an ACTIVE admin                              may verify
--   anybody else: effective finance.approve       AND Finance module entry
--
-- Finance module entry is required as well as the action, and not as decoration:
-- an employee whose Finance access has been switched off should not keep signing
-- off Finance decisions because an action row survived. That is the same
-- withEntry() rule deriveFinanceCapabilities uses in the browser, so the control
-- a person is shown matches what this refuses.
--
-- module_entry_open's own admin branch does not test is_active, which is why the
-- admin case is stated FIRST and separately with the active test — and why the
-- second branch is ANDed with actor_has_permission, which requires an active,
-- non-deleted account of its own accord. A deactivated admin therefore fails
-- both branches rather than passing the second.

create or replace function public.can_verify_pi_finance()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.role = 'admin'
        and u.is_active
        and coalesce(u.is_deleted, false) = false
    )
    or (
      public.actor_has_permission('finance', 'approve')
      and public.module_entry_open('finance')
    );
$$;

comment on function public.can_verify_pi_finance() is
  'True for an ACTIVE admin, or for a caller holding effective finance.approve WITH Finance module entry. orders.approve_order confers nothing here: reviewing a PI and signing off its commercial figures are two authorities, and this is the second.';

revoke execute on function public.can_verify_pi_finance() from public, anon;
grant  execute on function public.can_verify_pi_finance() to authenticated;

-- ═══ 9. A finance verifier can SEE the PI they are asked to verify ══════════
--
-- THE ONE PLACE THIS MIGRATION WIDENS ANYTHING, and it is widened by the
-- smallest amount that makes the workflow possible.
--
-- 20260908000000's visibility rule is: the owner, the named reviewer, an active
-- admin, or a holder of orders.approve_order. A pure finance verifier is none of
-- those, so before this section they could not read a single PI — and asking
-- somebody to verify commercial figures they cannot see is not a workflow.
--
-- WHAT IS ADDED, EXACTLY: a finance verifier may read a submission that is
-- 'submitted' or 'approved'. Not a draft, not a returned record, not a rejected
-- one. A PI that has not been handed to management is nobody's to verify, and a
-- closed one is nobody's to reopen.
--
-- WHAT IS NOT WEAKENED: the RESTRICTIVE module_entry_open('orders') gate on all
-- three tables is untouched and still ANDs with everything below, so a finance
-- verifier without Order Management access reaches no record here at all. The
-- write rules are untouched — can_write_order_submission_file is still the
-- OWNER only, so a verifier reads every file and writes none, which is what
-- keeps "the workbook the approver read is the workbook the employee uploaded"
-- true for this new reader too. No client INSERT, UPDATE or DELETE policy is
-- added to any of the three tables, and none exists.
--
-- CREATE OR REPLACE at the same signature, so the existing revoke/grant survives.

create or replace function public.can_view_order_submission(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.order_submissions s
    where s.id = p_submission_id
      and (
        s.created_by  = auth.uid()
        or s.submitted_by = auth.uid()
        or s.assigned_to  = auth.uid()
        or public.actor_has_module_permission('orders', 'approve_order')
        or (s.status in ('submitted', 'approved') and public.can_verify_pi_finance())
      )
  );
$$;

comment on function public.can_view_order_submission(uuid) is
  'True for the submission owner, its named reviewer, an active admin, a holder of orders.approve_order, or a finance verifier looking at a submitted or approved record. The single visibility rule shared by the tables and the storage policies. Still ANDed with the RESTRICTIVE Order Management entry gate.';

-- The parent table's own policy, kept in step with the helper. ALTER rather than
-- drop-and-recreate: the policy keeps its identity, its name and its place, and
-- 20260908000000 is not edited.
alter policy "order_submissions_select" on public.order_submissions
  using (
    created_by = auth.uid()
    or submitted_by = auth.uid()
    or assigned_to = auth.uid()
    or public.actor_has_module_permission('orders', 'approve_order')
    or (status in ('submitted', 'approved') and public.can_verify_pi_finance())
  );

-- ═══ 10. The activity action set, widened by exactly two ════════════════════
--
-- The set is CLOSED on purpose, so a phase that produces new kinds of event
-- extends it in its own migration — a visible change rather than a silent new
-- event type. These two are what this phase produces:
--
--   finance_verified   a finance authority signed off the commercial figures
--   approved           management approved the PI and the Order was created
--
-- ONE EVENT FOR ONE MANAGEMENT ACTION. Approval both approves the PI and creates
-- the Order, and it writes ONE entry carrying both facts in its metadata; two
-- entries for one decision reads as two decisions.
--
-- The constraint is located by its definition rather than by an assumed name, so
-- this works whichever migration last rewrote it.

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  join pg_class t      on t.oid = c.conrelid
  join pg_namespace n  on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'order_submission_activity'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%advance_exception_requested%';

  if v_name is null then
    raise exception 'the order_submission_activity action constraint was not found';
  end if;

  execute format('alter table public.order_submission_activity drop constraint %I', v_name);
end $$;

alter table public.order_submission_activity
  add constraint order_submission_activity_action_check
  check (action in (
    'submission_created',
    'parse_replaced',
    'submitted',
    'changes_requested',
    'rejected',
    'advance_exception_requested',
    'advance_exception_approved',
    'advance_exception_rejected',
    'finance_verified',
    'approved'
  ));

-- ═══ 11. Finance verification, as an RPC ════════════════════════════════════
--
-- Written the way every write path on this table is written, and for the same
-- reasons: an active actor, the authoritative permission helper, a row lock
-- taken BEFORE the state is judged, one atomic write, one append-only activity
-- row, and a small fixed JSON result carrying nothing the caller could not
-- already read.
--
-- WHAT IT DOES NOT DO, stated because the word "finance" invites the assumption:
-- it creates no payment, no payment request, no receipt and no reconciliation
-- entry; it reads no Finance table; and it does not approve the PI or bring an
-- Order into existence. It records that somebody with finance authority has
-- checked the figures.
--
-- WHY THE LOCK COMES FIRST. Two verifiers acting in the same moment, or a
-- verification racing a Needs Changes, must resolve to exactly one outcome. The
-- `for update` serializes them, so the status this function judges is the status
-- it writes against.
--
-- IDEMPOTENT BY CONSTRUCTION. A repeated call on a record that is ALREADY
-- verified against this same submission returns the existing verification and
-- writes nothing — no second activity row, no restamped time, no new verifier.
-- A double click is therefore not a second decision, and the trail does not
-- claim two people verified one PI.

create or replace function public.verify_pi_finance_check(p_submission_id uuid)
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
  if not public.can_verify_pi_finance() then
    raise exception
      'ORDER_SUBMISSION_FINANCE_FORBIDDEN: you do not have permission to verify a PI for finance'
      using errcode = '42501';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- A record reserved for deletion is frozen for everybody. Named here with its
  -- own message rather than left to the 20260914000000 guard, so the screen can
  -- say something a person can act on.
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be verified'
      using errcode = '55P03';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_UNDER_REVIEW: only a submitted PI can be verified by finance (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  -- Already verified against THIS submission: answer, do not re-record.
  if public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    return jsonb_build_object(
      'id',                 p_submission_id,
      'finance_verified',   true,
      'finance_verified_at', v_sub.finance_verified_at,
      'already_verified',   true
    );
  end if;

  v_now := now();

  update public.order_submissions
     set finance_verified_by            = v_actor,
         finance_verified_at            = v_now,
         finance_verified_submission_at = v_sub.submitted_at
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'finance_verified', 'submitted', 'submitted', null,
    -- No amount, no percentage, no client name: the trail already shows the
    -- record this happened to, and a figure repeated into an event is a figure
    -- that can disagree with the record later.
    jsonb_build_object('verified_submission_at', v_sub.submitted_at)
  );

  return jsonb_build_object(
    'id',                  p_submission_id,
    'finance_verified',    true,
    'finance_verified_at', v_now,
    'already_verified',    false
  );
end;
$$;

comment on function public.verify_pi_finance_check(uuid) is
  'Records that a finance authority has verified a submitted PI''s commercial figures and advance terms. Records NO payment, request, receipt or reconciliation. Does not approve the PI and creates no Order. Idempotent: a repeat call on an already-verified submission changes nothing and writes no second event.';

revoke execute on function public.verify_pi_finance_check(uuid) from public, anon;
grant  execute on function public.verify_pi_finance_check(uuid) to authenticated;

-- ═══ 12. Final approval, and the Order it creates ═══════════════════════════
--
-- THE ONE AUTHORITATIVE PATH. Everything happens here, in one transaction, or
-- none of it happens:
--
--    1. the actor is authenticated, active, and holds the authority
--    2. the submission row is LOCKED before any mutable state is judged
--    3. every eligibility rule is re-derived from the locked row — never from
--       anything the caller sent, which is why this function takes exactly one
--       argument and that argument is an id
--    4. exactly one row is inserted into public.orders
--    5. the Order NUMBER is allocated by the existing trigger, from the existing
--       cycle, inside this transaction
--    6. the submission is marked approved and linked to the Order
--    7. one append-only activity row records the Order id and its number
--
-- WHY THE NUMBER IS NOT MENTIONED IN THE INSERT. orders_assign_display_number
-- (20260703000000 §7) is a BEFORE INSERT trigger that assigns display_number
-- UNCONDITIONALLY, discarding whatever a caller supplied. RETURNING reads back
-- the value it actually assigned. There is no second allocator, no sequence, no
-- max()+1, and no way for this function — or a browser — to choose a number.
--
-- WHY A FAILED APPROVAL BURNS NOTHING. The cycle lives in an ordinary table row
-- and is advanced under FOR UPDATE inside the caller's transaction, so a failure
-- at ANY later step rolls the advancement back with everything else. That is
-- precisely what the retired sequence could not do.
--
-- CONCURRENCY, IN FULL. Two reviewers pressing Approve at the same instant both
-- reach step 2; one wins the lock, commits, and advances the cycle. The second
-- then re-reads the row it was waiting on, sees status 'approved' and a
-- populated order_id, and takes the already-approved branch — it allocates
-- nothing and creates nothing. A retry after a successful commit does the same.
-- If both somehow reached the insert, orders_source_order_submission_id_uidx and
-- order_submissions_order_id_key would each refuse the second, so the guarantee
-- does not rest on the lock alone.
--
-- STORAGE IS NOT IN THIS TRANSACTION, deliberately. Nothing here uploads,
-- generates or depends on a file, so a Storage failure can never leave a PI
-- half-approved. Derived documents are a separate, idempotent step — see the
-- note at the foot of this file.

create or replace function public.approve_order_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_order_id   uuid;
  v_number     text;
  v_now        timestamptz;
  v_item_count integer;
  v_bad        integer;
  v_bad_row    integer;
  v_client     text;
begin
  -- ── 1. Authorization, server-side, before anything is read ──
  if not public.actor_has_module_permission('orders', 'approve_order') then
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
  --
  -- A retry after a successful commit, a second reviewer who lost the race, a
  -- double click that survived the browser's own guard. None of them may
  -- allocate a number or create an Order, and none of them is an ERROR either —
  -- the caller asked for this PI to be approved and it is.
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

  -- Belt and braces against a record that claims not to be approved while
  -- naming an Order. The table constraint already refuses that shape; this turns
  -- an impossible state into a clear refusal rather than a duplicate Order.
  if v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_ALREADY_LINKED: this PI is already linked to an Order'
      using errcode = 'P0001';
  end if;

  -- ── 6. Finance verification must be CURRENT ──
  if not public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED: this PI has not been verified by finance for the submission under review'
      using errcode = 'P0001';
  end if;

  -- ── 7. The advance requirement, through the rule Phase B already owns ──
  --
  -- order_submission_advance_ready(text, numeric, text) and NOT
  -- order_submission_is_advance_ready(uuid): the second answers on behalf of
  -- whoever is signed in and returns false for a caller who cannot see the
  -- record, which is exactly the wrong question for a definer function holding
  -- the locked row. 20260913000000 says so in as many words, and this obeys it.
  --
  -- Standard 40% needs no decision. A reduced or zero advance needs an APPROVED
  -- exception; pending and rejected are both refused here, and so is an
  -- undeclared record.
  if not public.order_submission_advance_ready(
       v_sub.advance_condition, v_sub.advance_exception_percent, v_sub.advance_exception_status) then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_NOT_READY: the advance requirement on this PI is not settled (condition %, exception %)',
      coalesce(v_sub.advance_condition, 'undeclared'),
      coalesce(v_sub.advance_exception_status, 'none')
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

  if v_sub.grand_total is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored grand total'
      using errcode = 'P0001';
  end if;

  -- ── 10. The workbook: shape, then existence, then type ──
  --
  -- Re-derived at APPROVAL time and not trusted from submission time. The
  -- anchored pattern pins the whole key — the literal prefix, THIS submission's
  -- id, the original/ folder, and a single final segment with no slash — so a
  -- traversal, an absolute key or another submission's folder cannot satisfy it.
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

  -- ── Pictures live in order_submission_item_images, NOT on the item row ──
  --
  -- 20260909000000 moved them: a product line has exactly ONE representative
  -- image and any number of customization images, each a child row, each with a
  -- role and a position in its storage key. order_submission_items
  -- .image_storage_path is the pre-20260909 shape and is no longer the
  -- authoritative record, so approval must not judge it — checking it would
  -- refuse every PI submitted since that migration, which is every PI.
  --
  -- These three checks are the SAME three submit_order_submission_advance_internal
  -- applies, deliberately: what was true when the employee submitted must still
  -- be true when the Order is created, and the two paths must agree about what
  -- "still true" means.
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

  -- m.item_id, m.role, m.position and m.sha256 are all interpolated into the
  -- pattern, so a row whose key names a different item, a different role, a
  -- different slot or different bytes is refused even though the string looks
  -- perfectly well formed. That is the check that stops one product's
  -- photograph being presented as another's.
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
  v_now := now();
  perform set_config('boe.pi_submission_approval_id', p_submission_id::text, true);

  -- ── 13. Exactly one Order ──
  --
  -- THE MAPPING, AND WHY EACH FIELD IS WHAT IT IS.
  --
  --   client_name          the PI's own client, non-blank by the check above.
  --   requested_by         the employee the PI was submitted on behalf of. They
  --                        raised the business, so the Order is theirs to be
  --                        found by.
  --   created_by           the APPROVER. The same convention
  --                        convert_order_request_to_order uses: the person who
  --                        brought the Order into existence.
  --   assigned_to          nothing. Assignment is an operational decision taken
  --                        after the Order exists, and inventing one here would
  --                        put a name on somebody's work without being asked.
  --   confirm_date         the PI's own confirmation date (Master!A113) when it
  --                        parsed to a real date, and today otherwise. The
  --                        document's own statement of when the client confirmed
  --                        is the established business field; the approval date
  --                        is the honest fallback, never a guess.
  --   due_date             NULL, deliberately. dispatch_commitment is free TEXT
  --                        — "30 days", "mid-October" — and orders.due_date is a
  --                        DATE. There is no safe conversion, and a made-up
  --                        delivery date is worse than none.
  --   total_value          the stored grand total, non-null by the check above.
  --   total_product_value  gross_product_amount: the sum of the product lines
  --                        before discount, fabric, packing, transport and GST.
  --                        That is the same thing the column means on an Order
  --                        Request.
  --   lead_source          nothing. A PI does not record one, and the column is
  --                        a closed CHECK set.
  --   notes                nothing, deliberately. Addresses, the commercial
  --                        breakdown and the advance terms all live on the
  --                        submission, which this Order names — folding any of
  --                        them into free text would create a second copy that
  --                        can disagree with the first.
  --   status               'running'. Stated rather than left to the column
  --                        default, exactly as 20260702000000 requires: approval
  --                        IS the confirmation, so the Order's work is open from
  --                        its first moment. There is no pre-approval state.
  --   display_number       NOT LISTED. The BEFORE INSERT trigger assigns it and
  --                        RETURNING reads back what it actually assigned.
  --
  -- Provenance is written in the SAME INSERT that creates the Order, so an Order
  -- created from a PI can never exist without naming it, and a rolled-back
  -- approval leaves neither.
  insert into public.orders (
    client_name, requested_by, confirm_date, total_value, total_product_value,
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    coalesce(v_sub.order_confirmation_date, v_now::date),
    v_sub.grand_total,
    v_sub.gross_product_amount,
    v_actor,
    'running',
    p_submission_id
  )
  returning id, display_number into v_order_id, v_number;

  -- ── 14. The submission becomes approved, and names its Order ──
  --
  -- ONE STATEMENT. The status, the approver, the time and the link land together
  -- or not at all; order_submissions_approval_consistency (20260908000000),
  -- order_submissions_order_link_requires_approval and the guard in section 5
  -- each refuse any half of it.
  update public.order_submissions
     set status      = 'approved',
         approved_by = v_actor,
         approved_at = v_now,
         order_id    = v_order_id
   where id = p_submission_id;

  -- ── 15. Both trails ──
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'approved', 'submitted', 'approved', null,
    jsonb_build_object(
      'order_id',             v_order_id,
      'order_display_number', v_number,
      'item_count',           v_item_count
    )
  );

  -- The Order's own provenance, in the words order_activity_log already uses for
  -- a conversion. No amount and no client detail: the Order row carries those.
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_pi_submission',
    jsonb_build_object(
      'order_submission_id', p_submission_id,
      'item_count',          v_item_count
    )
  );

  -- ── 16. Close the context before returning ──
  --
  -- Transaction-local either way, so a failure between here and COMMIT cannot
  -- leak it — the whole transaction is gone. Cleared explicitly so nothing later
  -- in the SAME transaction (a batch, a future caller) inherits an open door.
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

comment on function public.approve_order_submission(uuid) is
  'Approves a submitted PI and creates exactly one Confirmed Order, in one transaction, for a caller holding orders.approve_order. Re-derives every eligibility rule from the locked row: finance verification current, advance requirement settled, no blocking issues, the workbook and every product image still stored, no deletion reservation, not already approved. The Order number comes only from orders_assign_display_number; a failed approval consumes none. Records no payment of any kind.';

revoke execute on function public.approve_order_submission(uuid) from public, anon;
grant  execute on function public.approve_order_submission(uuid) to authenticated;

-- ═══ 13. Assertions ═════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_bad text;
  v_n   integer;
  v_def text;
begin
  -- ── The transition trigger admits approval, and ONLY through the RPC ──
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'order_submissions_enforce_status_transition';

  if v_def is null then
    raise exception 'the status transition trigger function is missing';
  end if;
  if v_def not like '%new.status = ''approved''%' then
    raise exception 'the transition trigger does not admit submitted -> approved';
  end if;
  if v_def not like '%in_pi_submission_approval%' then
    raise exception 'the transition trigger admits approval without requiring the approval path';
  end if;

  -- Every guard is still attached. A trigger dropped by a careless later edit
  -- would take a whole invariant with it and change nothing visible.
  for v_bad in select unnest(array[
      'order_submissions_enforce_status_transition',
      'order_submissions_guard_advance_exception',
      'order_submissions_guard_deletion_claim',
      'order_submissions_guard_finance_verification',
      'order_submissions_guard_frozen_columns',
      'order_submissions_guard_order_link'
    ])
  loop
    if not exists (
      select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where c.relname = 'order_submissions' and t.tgname = v_bad and not t.tgisinternal
    ) then
      raise exception 'trigger % is not attached to order_submissions', v_bad;
    end if;
  end loop;

  -- ── There is exactly ONE Order-number allocator, and this file added none ──
  select count(*) into v_n
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'allocate_confirmed_order_number';
  if v_n <> 1 then
    raise exception 'expected exactly one confirmed Order number allocator, found %', v_n;
  end if;

  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'orders' and t.tgname = 'orders_assign_display_number' and not t.tgisinternal
  ) then
    raise exception 'the Order number stamping trigger is missing; approval would create unnumbered Orders';
  end if;

  -- The approval RPC must not name a number source of its own.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'approve_order_submission';

  if v_def like '%allocate_confirmed_order_number%'
     or v_def like '%next_order_display_number%'
     or v_def like '%order_number_cycle%'
     or v_def ~* 'max\s*\(\s*display_number' then
    raise exception 'approve_order_submission reaches for an Order number itself; the trigger is the only allocator';
  end if;
  if v_def ~* 'insert\s+into\s+public\.(finance_payment_requests|payment_proof_attachments)' then
    raise exception 'approve_order_submission writes a payment record; this phase records none';
  end if;

  -- ── No client role may create an Order or write a submission ──
  select string_agg(format('%s:%s', table_name, privilege_type), ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('orders', 'order_submissions', 'order_submission_items', 'order_submission_activity')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'DELETE', 'TRUNCATE');
  if v_bad is not null then
    raise exception 'client roles hold creation privileges that would bypass the workflow: %', v_bad;
  end if;

  -- Still no client write policy on any of the three submission tables.
  select string_agg(p.polname, ', ') into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('order_submissions', 'order_submission_items', 'order_submission_activity')
    and p.polpermissive
    and p.polcmd in ('a', 'w', 'd');
  if v_bad is not null then
    raise exception 'unexpected client write policies: %', v_bad;
  end if;

  -- The module entry gates are still RESTRICTIVE, so section 9 widened nothing
  -- outside Order Management.
  select count(*) into v_n
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polname = c.relname || '_module_entry_gate'
    and c.relname in ('order_submissions', 'order_submission_items', 'order_submission_activity')
    and not p.polpermissive;
  if v_n <> 3 then
    raise exception 'expected 3 RESTRICTIVE module entry gates on the submission tables, found %', v_n;
  end if;

  -- The file WRITE predicate is untouched: a verifier reads and never writes.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'can_write_order_submission_file';
  if v_def like '%can_verify_pi_finance%' then
    raise exception 'the file write predicate now admits a finance verifier; verification is read-only';
  end if;

  -- ── Every SECURITY DEFINER function this migration adds pins search_path ──
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in (
      'order_submissions_enforce_status_transition',
      'can_view_order_submission',
      'can_verify_pi_finance',
      'verify_pi_finance_check',
      'approve_order_submission'
    )
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
      where cfg like 'search_path=%'
    );
  if v_bad is not null then
    raise exception 'these SECURITY DEFINER functions have a mutable search_path: %', v_bad;
  end if;

  -- ── The internal helpers are reachable by nobody ──
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'in_pi_submission_approval',
      'order_submissions_guard_order_link',
      'order_submissions_guard_finance_verification',
      'prevent_order_source_submission_change'
    )
    and (
      has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
    );
  if v_bad is not null then
    raise exception 'these internal functions are executable by a client role: %', v_bad;
  end if;

  -- ── The two new RPCs ARE reachable by a signed-in caller ──
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('verify_pi_finance_check', 'approve_order_submission')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'these RPCs are not executable by authenticated: %', v_bad;
  end if;

  -- ...and neither is reachable by anon.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('verify_pi_finance_check', 'approve_order_submission')
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'these RPCs are executable by anon: %', v_bad;
  end if;

  -- ── One submission, one Order, in both directions ──
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders_source_order_submission_id_uidx'
  ) then
    raise exception 'the Order-side uniqueness index is missing; two PIs could name one Order';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'order_submissions_order_id_key'
  ) then
    raise exception 'the submission-side uniqueness index is missing; one PI could name two Orders';
  end if;

  -- ── Nothing has been approved by this file, and no Order was created ──
  select count(*) into v_n from public.order_submissions where status = 'approved';
  if v_n <> 0 then
    raise exception 'a submission is already approved; this migration approves nothing';
  end if;
  select count(*) into v_n from public.orders where source_order_submission_id is not null;
  if v_n <> 0 then
    raise exception 'an Order already names a PI submission; this migration creates none';
  end if;
  select count(*) into v_n from public.order_submissions where finance_verified_at is not null;
  if v_n <> 0 then
    raise exception 'a submission is already finance-verified; this migration verifies nothing';
  end if;

  -- ── No permission has been granted to anybody ──
  select count(*) into v_n
  from public.employee_permission_overrides epo
  join public.permission_actions pa on pa.id = epo.action_id
  where pa.action_key in ('approve_order', 'approve')
    and epo.allowed;
  if v_n > 0 then
    -- Informational only: this migration grants nothing, and must not fail
    -- because somebody legitimately held a grant beforehand.
    null;
  end if;
end $$;

-- ═══ 14. What this migration deliberately does NOT do ═══════════════════════
--
--   * NO NUMBERED .xlsx. Producing one means editing the uploaded workbook, and
--     the repository has no facility that can do it faithfully: xlsx@0.18.5 does
--     not round-trip images, merged cells or print settings (the point
--     src/lib/xlsxMediaOptimizer.ts opens with), and src/lib/pi/workbookReader.ts
--     is deliberately read-only. A rebuild that silently dropped a client's
--     pictures and page setup would be worse than no file at all. The reserved
--     path orders/{order_id}/versions/{version}/approved.xlsx that
--     20260908000000 set aside stays reserved and unwritten.
--   * NO PDF. There is no faithful Excel-to-PDF facility here — pdfkit draws a
--     PDF from scratch (the showroom quotation route) and cannot render a
--     workbook. A low-fidelity HTML reconstruction presented as the official PI
--     is exactly what must not be built, so nothing is built and nothing in the
--     employee UI mentions a pending document.
--     Both are the next bounded phase.
--   * NO payment linking, split-payment allocation, payment recording or
--     reconciliation. Finance verification verifies figures; it moves no money
--     and writes no Finance row.
--   * NO post-approval commercial amendment. An approved PI is terminal here;
--     changing an Order's terms is amend_order()'s job and a different phase.
--   * NO production tracking, no dispatch gate, no notification.
--   * NO change to Order Request conversion, to the number cycle's configuration
--     RPCs, or to any existing Order's number or status.
