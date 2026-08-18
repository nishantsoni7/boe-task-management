-- Order Management, Phase B: the advance requirement a PI carries into review,
-- and the exception an employee may ask management to allow.
--
-- WHAT THIS IS
-- ------------
-- BOE requires 40% of the grand total as an advance before an order is worked.
-- Until now that rule lived only in the commercial summary on screen: a number
-- the reader could see and nobody had to answer. This migration turns it into a
-- DECLARATION the submitter must make, and gives management one decision to take
-- on it.
--
--   standard    the employee accepts the 40% requirement.
--   exception   the employee proposes LESS — anything from 0% up to, but not
--               including, 40% — with a mandatory reason, and management
--               approves or rejects that proposal.
--
-- WHAT THIS IS NOT — AND THE PROOF IS STRUCTURAL, NOT A PROMISE
-- -------------------------------------------------------------
-- THIS RECORDS A COMMERCIAL CONDITION. IT IS NOT A PAYMENT.
--
-- Nothing here creates, links, requests, confirms or reconciles money received.
-- There is no payment column, no finance_payment_requests reference, no proof,
-- no receipt, no allocation and no status claiming any of those things. The
-- words used throughout are "advance requirement", "proposed advance" and
-- "exception request", never "advance received".
--
-- And nothing here approves a PI. 'approved' remains reachable from NOTHING for
-- every caller including the service role and direct SQL — the transition
-- trigger from 20260908000000/20260910000000 is untouched, and the assertions at
-- the foot of this file fail the migration if that ever stops being true. There
-- is no approval RPC, no order number, no display number, no Order row, no
-- PI-to-Order conversion and no document generation.
--
-- APPROVING AN ADVANCE EXCEPTION IS NOT APPROVING A PI. An approved exception
-- leaves the record exactly where it was — 'submitted' — and makes the advance
-- condition eligible for the later order-approval phase. That is all it does.
--
-- NOTHING APPLIED IS EDITED
-- -------------------------
-- 20260908000000, 20260909000000, 20260910000000 and 20260911000000 are already
-- applied and are not touched. This file is purely additive: eight new columns,
-- six new CHECK constraints, one CHECK widened by exactly three values, one new
-- trigger, six new functions, one function restated with an identical signature
-- (submit_order_submission_internal, which becomes a one-line delegate so there
-- is still exactly ONE implementation of submitting), and one new permission.
--
-- advance_exception_reason ALREADY EXISTS. 20260908000000 reserved it for
-- exactly this purpose and left it unwritten. It is used here as what it was
-- reserved to be — the employee's mandatory reason for proposing less than the
-- standard — rather than duplicated under a second name that would mean the
-- same thing.
--
-- THE PHASE C FOUNDATION
-- ----------------------
-- public.order_submission_advance_ready(condition, percent, status) is the
-- reusable server-side rule the later approval phase must consult:
--
--   advance-ready  ⇔  standard 40% is selected
--                     OR an exception below 40% (0% included) is APPROVED
--
-- Pending, rejected, incomplete, malformed and undeclared conditions are not
-- advance-ready, and the assertions at the foot of this file prove each of those
-- cases against the function itself. It is a predicate. It grants nothing, and
-- there is deliberately no RPC that acts on it.

-- ═══ 1. The declaration, as columns ═════════════════════════════════════════
--
-- All NULLABLE, and NULL means UNDECLARED. That is not laziness: every PI
-- submitted before this migration was submitted without anyone being asked, and
-- inventing a declaration for those records — defaulting them to 'standard' —
-- would put words in an employee's mouth and make a record advance-ready that
-- nobody ever agreed to. An undeclared record is honestly undeclared, and the
-- predicate in section 4 refuses it.
--
-- advance_exception_percent IS PLAIN `numeric`, NOT numeric(4,2), DELIBERATELY.
-- A constrained scale would silently ROUND 12.345 to 12.35 and store a figure
-- the employee never typed. Plain numeric plus the scale CHECK in section 2
-- REFUSES it instead, for every caller including direct SQL and the service
-- role. Rejecting is the required behaviour; rounding is not.

alter table public.order_submissions
  add column advance_condition                  text,
  add column advance_exception_percent          numeric,
  add column advance_exception_status           text,
  add column advance_exception_requested_by     uuid references public.users(id),
  add column advance_exception_requested_at     timestamptz,
  add column advance_exception_decided_by       uuid references public.users(id),
  add column advance_exception_decided_at       timestamptz,
  add column advance_exception_rejection_reason text;

comment on column public.order_submissions.advance_condition is
  'The advance requirement this submission was sent under: ''standard'' (the configured 40% rule) or ''exception'' (a proposed lower percentage awaiting, or carrying, a decision). NULL means the PI was submitted before Phase B and declared nothing, which is never advance-ready.';
comment on column public.order_submissions.advance_exception_percent is
  'The percentage of grand_total the employee PROPOSES as the advance: at least 0 and strictly below the standard 40, to at most two decimal places. A commercial condition only — no payment is implied, requested or recorded.';
comment on column public.order_submissions.advance_exception_status is
  'Where the exception request stands: ''pending'', ''approved'' or ''rejected''. NULL whenever the record carries no exception.';
comment on column public.order_submissions.advance_exception_requested_by is
  'The submission owner who proposed the exception. Written only by submitting the PI.';
comment on column public.order_submissions.advance_exception_requested_at is
  'When the current exception request was made. Reset whenever a revised exception is proposed.';
comment on column public.order_submissions.advance_exception_decided_by is
  'The authorised approver who accepted or refused the proposal. Requires orders.approve_advance_exception, which no preset grants.';
comment on column public.order_submissions.advance_exception_decided_at is
  'When the exception decision was taken.';
comment on column public.order_submissions.advance_exception_rejection_reason is
  'Why the proposed advance was refused. Mandatory on a rejection, and forbidden on every other state. Becomes the PI''s visible correction instruction.';

-- The RUPEE FIGURE IS NOT STORED. It is derived, always, from the persisted
-- grand_total and the persisted percentage, by
-- public.order_submission_advance_amount(). Storing it would create a second
-- fact that could disagree with the first the moment a corrected PI changed the
-- total, and there would be no way to tell which one the business meant.

create index order_submissions_advance_exception_status_idx
  on public.order_submissions (advance_exception_status)
  where advance_exception_status is not null;

-- ═══ 2. What the persisted model may and may not say ════════════════════════
--
-- Nothing below is enforced only in an RPC. These are table constraints, so a
-- direct UPDATE from psql and a write by the service role — which bypasses RLS
-- entirely — are refused by exactly the same rules a browser is.
--
-- Before adding them: prove the reserved column really is unwritten, so a
-- constraint failure cannot be mistaken for a bug in this file.

do $$
declare
  v_n integer;
begin
  select count(*) into v_n
  from public.order_submissions
  where advance_exception_reason is not null;

  if v_n > 0 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_UNSAFE: % record(s) already carry advance_exception_reason, which 20260908000000 reserved and left unwritten; investigate before declaring a condition over them',
      v_n
      using errcode = 'P0001';
  end if;
end $$;

alter table public.order_submissions
  add constraint order_submissions_advance_condition_known check (
    advance_condition is null or advance_condition in ('standard', 'exception')
  ),

  add constraint order_submissions_advance_exception_status_known check (
    advance_exception_status is null
    or advance_exception_status in ('pending', 'approved', 'rejected')
  ),

  -- THE PERCENTAGE, IN FULL.
  --
  --   >= 0        0% is a legitimate proposal: "let us proceed with no advance".
  --   <  40       at or above the standard is not an exception. The literal 40
  --               is written out rather than calling the standard-rule function,
  --               because a CHECK is not re-validated when a function it calls
  --               is replaced — a constraint that could silently stop meaning
  --               what it says is worse than a duplicated number. The assertions
  --               at the foot of this file prove the two agree.
  --   = round(,2) at most two decimal places. Excessive precision is REFUSED,
  --               never rounded into something the employee did not type.
  --   <> NaN      numeric accepts 'NaN', and NaN sorts ABOVE every real number,
  --               so the range test alone would already refuse it. Stated
  --               anyway, because a reader should not have to know that.
  add constraint order_submissions_advance_exception_percent_valid check (
    advance_exception_percent is null
    or (
      advance_exception_percent <> 'NaN'::numeric
      and advance_exception_percent >= 0
      and advance_exception_percent < 40
      and advance_exception_percent = round(advance_exception_percent, 2)
    )
  ),

  -- STANDARD CARRIES NOTHING. Neither does an undeclared record.
  --
  -- `is not distinct from` and not `=`: a NULL condition makes `=` evaluate to
  -- NULL, and a CHECK passes on NULL. That is the hole this spelling closes —
  -- an undeclared record would otherwise be free to carry a full exception.
  add constraint order_submissions_advance_exception_fields_need_exception check (
    advance_condition is not distinct from 'exception'
    or (
      advance_exception_percent is null
      and advance_exception_reason is null
      and advance_exception_status is null
      and advance_exception_requested_by is null
      and advance_exception_requested_at is null
      and advance_exception_decided_by is null
      and advance_exception_decided_at is null
      and advance_exception_rejection_reason is null
    )
  ),

  -- AN EXCEPTION IS NEVER HALF-WRITTEN. A percentage with no reason, or a
  -- request with no requester, is not a proposal anybody can act on.
  add constraint order_submissions_advance_exception_is_complete check (
    advance_condition is distinct from 'exception'
    or (
      advance_exception_percent is not null
      and advance_exception_reason is not null
      and btrim(advance_exception_reason) <> ''
      and advance_exception_status is not null
      and advance_exception_requested_by is not null
      and advance_exception_requested_at is not null
    )
  ),

  -- THE THREE DECISION STATES, EACH COMPLETE AND EACH EXCLUSIVE.
  --
  --   pending    no decision actor, no decision time, no rejection reason
  --   approved   decision actor AND time, and no rejection reason
  --   rejected   decision actor AND time, and a non-blank rejection reason
  add constraint order_submissions_advance_decision_consistency check (
    advance_exception_status is null
    or (advance_exception_status = 'pending'
        and advance_exception_decided_by is null
        and advance_exception_decided_at is null
        and advance_exception_rejection_reason is null)
    or (advance_exception_status = 'approved'
        and advance_exception_decided_by is not null
        and advance_exception_decided_at is not null
        and advance_exception_rejection_reason is null)
    or (advance_exception_status = 'rejected'
        and advance_exception_decided_by is not null
        and advance_exception_decided_at is not null
        and advance_exception_rejection_reason is not null
        and btrim(advance_exception_rejection_reason) <> '')
  ),

  -- FAIL CLOSED ON AN UNKNOWN AMOUNT.
  --
  -- Both conditions are a percentage OF something. A PI whose I122 held text
  -- rather than a figure has no grand total to take a percentage of, so no
  -- advance condition may be declared against it at all — not standard, and
  -- certainly not an exception whose rupee value nobody could compute.
  add constraint order_submissions_advance_needs_grand_total check (
    advance_condition is null or grand_total is not null
  );

-- ═══ 3. The standard rule, and the one calculation ══════════════════════════
--
-- ONE FORMULA, ONE SOURCE. The browser has PI_ADVANCE_PERCENT and
-- computeAdvanceAmount() in src/lib/pi/previewView.ts; the database has these
-- two. Both round to paise the same way, and a repository test reads the number
-- out of this file so the two cannot drift apart silently.

create or replace function public.order_submission_standard_advance_percent()
returns numeric
language sql
immutable
parallel safe
as $$ select 40::numeric $$;

comment on function public.order_submission_standard_advance_percent() is
  'The standard advance BOE requires against a confirmed order, as a percentage of the persisted grand total. The single database-side source of the 40% rule.';

revoke execute on function public.order_submission_standard_advance_percent() from public, anon;
grant  execute on function public.order_submission_standard_advance_percent() to authenticated;

-- The rupee figure, derived and never stored.
--
-- Rounded to paise so the result is a real amount rather than a floating
-- artefact, and NULL — never a guess — whenever either input is absent or NaN.
create or replace function public.order_submission_advance_amount(
  p_grand_total numeric,
  p_percent     numeric
)
returns numeric
language sql
immutable
parallel safe
as $$
  select case
    when p_grand_total is null or p_percent is null then null
    when p_grand_total = 'NaN'::numeric or p_percent = 'NaN'::numeric then null
    else round(p_grand_total * p_percent / 100, 2)
  end
$$;

comment on function public.order_submission_advance_amount(numeric, numeric) is
  'The advance a percentage of a grand total comes to, rounded to paise. Derived on demand: the figure is never stored, so it cannot disagree with the total it came from. Says nothing about payment.';

revoke execute on function public.order_submission_advance_amount(numeric, numeric) from public, anon;
grant  execute on function public.order_submission_advance_amount(numeric, numeric) to authenticated;

-- ═══ 4. Advance-ready — the predicate the approval phase must consult ═══════
--
-- THE WHOLE RULE, IN ONE PLACE:
--
--   advance-ready  ⇔  'standard'
--                     OR ('exception' AND approved AND 0 <= percent < 40)
--
-- Everything else is NOT ready: pending, rejected, undeclared, a malformed
-- percentage, an exception with no decision, a decision on no exception.
--
-- IT GRANTS NOTHING. It answers a question. There is no RPC in this migration
-- that acts on the answer, and the database still refuses every transition to
-- 'approved' regardless of what it returns.

create or replace function public.order_submission_advance_ready(
  p_advance_condition        text,
  p_advance_percent          numeric,
  p_advance_exception_status text
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  -- coalesce, because a NULL condition makes every comparison NULL and a NULL
  -- answer to "is this ready?" must read as no.
  select coalesce(
    p_advance_condition = 'standard'
    or (
      p_advance_condition = 'exception'
      and p_advance_exception_status = 'approved'
      and p_advance_percent is not null
      and p_advance_percent <> 'NaN'::numeric
      and p_advance_percent >= 0
      and p_advance_percent < public.order_submission_standard_advance_percent()
    ),
    false
  )
$$;

comment on function public.order_submission_advance_ready(text, numeric, text) is
  'True only when the standard advance requirement is selected, or an exception below the standard — zero included — has been APPROVED. Pending, rejected, malformed and undeclared conditions are false. The reusable rule the later order-approval phase must satisfy before a PI can be approved; it authorises nothing by itself.';

revoke execute on function public.order_submission_advance_ready(text, numeric, text) from public, anon;
grant  execute on function public.order_submission_advance_ready(text, numeric, text) to authenticated;

-- The same rule, asked about one stored record.
--
-- SECURITY DEFINER, and gated on can_view_order_submission, so it cannot be used
-- to learn anything about a submission the caller may not read: an id they have
-- no business with answers false, exactly as a missing id does.
--
-- THIS IS THE READING ROUTE, NOT THE DECIDING ROUTE. Because it answers false
-- for a caller who cannot see the record, a future SECURITY DEFINER approval
-- function must NOT ask this one — it would be asking on behalf of whoever
-- happens to be signed in, and orders.approve_advance_exception deliberately
-- confers no visibility of its own. A server-side decision path already holds
-- the locked row, so it consults
-- public.order_submission_advance_ready(condition, percent, status) directly.
-- That is the rule; this is the convenience for a screen.
create or replace function public.order_submission_is_advance_ready(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select public.order_submission_advance_ready(
             s.advance_condition,
             s.advance_exception_percent,
             s.advance_exception_status)
    from public.order_submissions s
    where s.id = p_submission_id
      and public.can_view_order_submission(s.id)
  ), false)
$$;

comment on function public.order_submission_is_advance_ready(uuid) is
  'Whether one stored submission satisfies the advance requirement, for a caller who may already see it. False for an unreadable or missing id, so a server-side decision path must consult order_submission_advance_ready(text, numeric, text) on the row it holds rather than this. Reads; decides nothing.';

revoke execute on function public.order_submission_is_advance_ready(uuid) from public, anon;
grant  execute on function public.order_submission_is_advance_ready(uuid) to authenticated;

-- ═══ 5. When the declaration and the decision may move ══════════════════════
--
-- The constraints in section 2 say what a row may LOOK like. This says when it
-- may CHANGE, which is the half a CHECK cannot express — and it says it for
-- every caller, the service role and direct SQL included.
--
--   the declaration        is written only by submitting the PI
--   a request becomes      pending only as the PI becomes submitted
--   a decision is taken    only on a PENDING request, on a SUBMITTED PI
--   approval               leaves the PI submitted
--   rejection              returns the PI for correction, in the same statement
--   the exception clears   only by resubmitting under the standard requirement
--
-- TRIGGER ORDER MATTERS AND IS NOT ACCIDENTAL. Triggers of the same timing fire
-- in NAME order, and the four on this table sort:
--
--   order_submissions_enforce_status_transition   the status graph, first
--   order_submissions_guard_advance_exception     this one
--   order_submissions_guard_frozen_columns        the creation record
--   order_submissions_set_updated_at              the stamp, last
--
-- so by the time this runs, an illegal status move has already been refused and
-- new.status is a status the graph actually permits.

create or replace function public.order_submissions_guard_advance_exception()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- A submission is created as an empty draft. It has declared nothing, and
    -- stating that here stops a row being INSERTed with an approved exception
    -- already on it by anything holding an INSERT privilege.
    if new.advance_condition is not null or new.advance_exception_status is not null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: a submission is created with no advance declaration'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- The declaration itself is the employee's, made at submission time only.
  if new.advance_condition is distinct from old.advance_condition
     and not (new.status = 'submitted' and old.status in ('draft', 'needs_changes')) then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_INVALID: the advance condition of % is set only by submitting it', old.id
      using errcode = '42501';
  end if;

  if new.advance_exception_status is not distinct from old.advance_exception_status then
    return new;
  end if;

  if new.advance_exception_status = 'pending' then
    if new.status <> 'submitted' or old.status not in ('draft', 'needs_changes') then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: an advance exception is requested only by submitting the PI'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.advance_exception_status in ('approved', 'rejected') then
    -- A stale decision, a double click and a decision on a record that has
    -- already moved on all land here and all fail.
    if old.advance_exception_status is distinct from 'pending' or old.status <> 'submitted' then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_PENDING: only a pending advance exception on a submitted PI can be decided'
        using errcode = '42501';
    end if;

    -- Approving the advance condition is NOT approving the PI. The record stays
    -- exactly where it was.
    if new.advance_exception_status = 'approved' and new.status <> 'submitted' then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: approving an advance exception must leave the PI submitted'
        using errcode = '42501';
    end if;

    -- Refusing the proposed advance is not refusing the PI. It goes back for
    -- correction, in the same statement as the decision or not at all.
    if new.advance_exception_status = 'rejected' and new.status <> 'needs_changes' then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: rejecting an advance exception must return the PI for correction'
        using errcode = '42501';
    end if;

    return new;
  end if;

  -- Cleared. That is what choosing the standard requirement on a resubmission
  -- does, and it is the only thing that may do it: the historical events stay in
  -- the append-only trail, and only the ACTIONABLE state leaves the row.
  if new.advance_exception_status is null then
    if new.advance_condition is distinct from 'standard' or new.status <> 'submitted' then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_INVALID: an advance exception is cleared only by resubmitting under the standard requirement'
        using errcode = '42501';
    end if;
    return new;
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_guard_advance_exception()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_guard_advance_exception on public.order_submissions;
create trigger order_submissions_guard_advance_exception
  before insert or update on public.order_submissions
  for each row execute function public.order_submissions_guard_advance_exception();

-- ═══ 6. The activity action set, widened by exactly three ═══════════════════
--
-- The set is CLOSED on purpose, so a phase that produces new kinds of event
-- extends it in its own migration. These three are what this phase produces:
--
--   advance_exception_requested   the employee proposed less than the standard
--   advance_exception_approved    management accepted the proposal
--   advance_exception_rejected    management refused it, and the PI went back
--
-- ONE EVENT FOR ONE MANAGEMENT ACTION. A rejection both refuses the proposal and
-- returns the PI, and it deliberately does NOT also write 'changes_requested':
-- two entries for one click reads as two decisions. The single
-- advance_exception_rejected row carries previous_status 'submitted' and
-- new_status 'needs_changes', so the trail states the whole outcome once.
--
-- Selecting the STANDARD requirement adds no action of its own. It is already
-- permanently recorded by the submission state and by the safe metadata on the
-- 'submitted' event, and a fourth action would be noise invented to fill a gap
-- that is not there.
--
-- Located by its definition rather than by an assumed name, as Phase A did.

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
    and pg_get_constraintdef(c.oid) like '%changes_requested%';

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
    'advance_exception_rejected'
  ));

-- ═══ 7. Permission: orders.approve_advance_exception ════════════════════════
--
-- A SEPARATE, PROTECTED AUTHORITY. Deliberately NOT orders.approve_order.
--
-- orders.approve_order is the authority to review a PI: send it back, reject it,
-- and eventually approve it. Deciding whether BOE will start an order on less
-- than its standard advance — zero included — is a commercial decision about
-- money at risk, and the business has chosen to keep it separable. Reusing
-- approve_order would have handed it, silently and retroactively, to everybody
-- who can already send a PI back.
--
-- The two are independent in BOTH directions, and the RPCs below prove it:
--
--   holding approve_order only              cannot decide an exception
--   holding approve_advance_exception only  cannot approve, reject or return a
--                                           PI, cannot see Finance, cannot see
--                                           every order, and reaches no payment
--
-- default_allowed = false, and it is registered in PROTECTED_ACTIONS in
-- src/lib/permissions/levels.ts so no Viewer / Contributor / Manager preset can
-- reach it. It is granted explicitly, per person, through Access Control, or not
-- at all. NOTHING HERE GRANTS IT TO ANYBODY.
--
-- The module parent gate is unchanged and still applies: actor_has_permission
-- resolves through the same engine, and the restrictive module_entry_open policy
-- on order_submissions means somebody without Order Management access reaches no
-- record to decide anything about.

insert into public.permission_actions (action_key, display_name, is_system)
values ('approve_advance_exception', 'Approve Advance Exceptions', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'approve_advance_exception'
where pm.module_key = 'orders'
on conflict (module_id, action_id) do nothing;

-- ═══ 8. Submitting, with a declaration ══════════════════════════════════════
--
-- ONE IMPLEMENTATION, THREE DOORS — the arrangement 20260911000000 established,
-- extended rather than replaced.
--
--   submit_order_submission(uuid)                      unchanged, authenticated
--   submit_order_submission_with_note(uuid, text)      unchanged, authenticated
--   submit_order_submission_with_advance(...)          NEW,       authenticated
--   submit_order_submission_internal(uuid, text)       one-line delegate, no role
--   submit_order_submission_advance_internal(...)      the implementation, no role
--
-- THE TWO EXISTING RPCs KEEP THEIR EXACT NAMES, SIGNATURES, ARGUMENT NAMES,
-- RETURN SHAPE, PRIVILEGES AND BEHAVIOUR. Their bodies are not even restated:
-- they already call submit_order_submission_internal(uuid, text), whose
-- signature is identical here and whose body now delegates onward with
-- p_declare_advance = false.
--
-- WHAT p_declare_advance = false MEANS, PRECISELY: leave the advance declaration
-- on the record EXACTLY as it is. A submission that says nothing about the
-- advance changes nothing about it — it does not clear an approved exception, it
-- does not invent a standard declaration, and it cannot turn a rejected
-- exception into a ready one. So an old client, a cached PostgREST schema and
-- any existing caller all keep working, and none of them can reach a state the
-- new door would refuse.
--
-- SEPARATE NAMES, NOT AN OVERLOAD. PostgREST resolves a function by the argument
-- names in the request body, so two functions sharing a name would be picked
-- apart by which keys a caller happened to send.

create or replace function public.submit_order_submission_advance_internal(
  p_submission_id     uuid,
  p_note              text,
  p_declare_advance   boolean,
  p_advance_condition text,
  p_advance_percent   numeric,
  p_advance_reason    text
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
  -- Trimmed and folded, so "  Standard  " and "standard" are the same choice and
  -- a reason of pure whitespace is indistinguishable from no reason at all.
  v_condition  text := nullif(btrim(lower(coalesce(p_advance_condition, ''))), '');
  v_reason     text := nullif(btrim(coalesce(p_advance_reason, '')), '');
  v_percent    numeric := p_advance_percent;
  v_standard   numeric := public.order_submission_standard_advance_percent();
  v_effective  numeric;
  v_keep       boolean := false;
  v_requested  boolean := false;
  v_advance    jsonb   := '{}'::jsonb;
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

  -- ── The declaration's SHAPE, before the row is locked ──
  --
  -- Every one of these is the caller's own mistake and needs nothing from the
  -- record, so refusing early costs the database nothing and holds no lock.
  if p_declare_advance then
    if v_condition is null or v_condition not in ('standard', 'exception') then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID: choose the standard advance requirement or request an exception'
        using errcode = 'P0001';
    end if;

    if v_condition = 'standard' then
      -- The standard requirement is exactly the configured rule. A percentage or
      -- a reason arriving with it means the caller has sent two different
      -- answers, and guessing which one they meant is not this function's job.
      if p_advance_percent is not null or v_reason is not null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID: the standard advance requirement carries no percentage and no reason'
          using errcode = 'P0001';
      end if;
    else
      if v_percent is null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: enter the advance percentage being proposed'
          using errcode = 'P0001';
      end if;
      -- NaN first, and by name: it compares ABOVE every real number, so leaving
      -- it to the range test would refuse it with a message about being too high.
      if v_percent = 'NaN'::numeric then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: the advance percentage is not a number'
          using errcode = 'P0001';
      end if;
      if v_percent < 0 or v_percent >= v_standard then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: an exception must be at least 0%% and below the standard %%%',
          v_standard
          using errcode = 'P0001';
      end if;
      if v_percent <> round(v_percent, 2) then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: the advance percentage may have at most two decimal places'
          using errcode = 'P0001';
      end if;
      if v_reason is null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_REASON_REQUIRED: say why a lower advance is being proposed'
          using errcode = 'P0001';
      end if;
      if char_length(v_reason) > 1000 then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
          char_length(v_reason)
          using errcode = 'P0001';
      end if;
    end if;
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

  -- ── The declaration's FIT with this record ──
  if p_declare_advance then
    -- FAIL CLOSED ON AN UNKNOWN AMOUNT. Nobody may declare a percentage of a
    -- total the record does not have; the same rule is a table constraint, so
    -- this is the readable half of a refusal that happens either way.
    if v_sub.grand_total is null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored grand total, so an advance requirement cannot be declared against it'
        using errcode = 'P0001';
    end if;

    -- ONLY THE OWNER MAY PROPOSE AN EXCEPTION. can_edit_order_submission admits
    -- an active admin as well, which is right for correcting a record and wrong
    -- for asking the business a commercial question in somebody else's name.
    if v_condition = 'exception'
       and not (v_sub.created_by = v_actor or v_sub.submitted_by = v_actor) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_OWNER: only the owner of this PI may request an advance exception'
        using errcode = '42501';
    end if;
  end if;

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

  -- ── The workbook: shape, then existence, then type ──
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

  -- ── Exactly one representative image per product line ──
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

  -- ── Every recorded image: the key must name THIS submission, THIS item, its
  --    own role and its own position ──
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

  -- ── Every recorded image: a real object, of a real image type ──
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

  -- ── The write ──
  --
  -- ONE STATEMENT ON EVERY PATH, so the status and the advance declaration land
  -- together or not at all. review_note is cleared exactly as the applied
  -- migration established: management's outstanding request has been answered.

  if not p_declare_advance then
    -- Nothing was declared, so nothing about the advance moves. Whatever the
    -- record already carried it still carries.
    update public.order_submissions
       set status = 'submitted',
           review_note = null
     where id = p_submission_id;

  elsif v_condition = 'standard' then
    -- MOVING TO THE STRICTER CHOICE NEEDS NO APPROVAL, and it clears the whole
    -- actionable exception state from the row. The permanent record of what was
    -- once asked for, and what was decided, stays in the append-only trail —
    -- nothing there is deleted or rewritten.
    v_effective := v_standard;
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           advance_condition = 'standard',
           advance_exception_percent = null,
           advance_exception_reason = null,
           advance_exception_status = null,
           advance_exception_requested_by = null,
           advance_exception_requested_at = null,
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null
     where id = p_submission_id;

  else
    v_effective := v_percent;

    -- AN APPROVED EXCEPTION SURVIVES A RESUBMISSION THAT DOES NOT CHANGE IT.
    --
    -- A PI returned for an unrelated correction comes back with the same
    -- proposal the business already accepted, and asking management to accept it
    -- a second time would be make-work. Anything else — a different percentage,
    -- different words, a move from standard, a previously rejected or pending
    -- request — becomes a FRESH pending decision with fresh requester and time
    -- and cleared decision fields.
    --
    -- Numeric equality is by VALUE, so 5 and 5.00 are the same proposal.
    v_keep := coalesce(
      v_sub.advance_condition = 'exception'
      and v_sub.advance_exception_status = 'approved'
      and v_sub.advance_exception_percent = v_percent
      and v_sub.advance_exception_reason is not distinct from v_reason,
      false
    );

    if v_keep then
      update public.order_submissions
         set status = 'submitted',
             review_note = null
       where id = p_submission_id;
    else
      update public.order_submissions
         set status = 'submitted',
             review_note = null,
             advance_condition = 'exception',
             advance_exception_percent = v_percent,
             advance_exception_reason = v_reason,
             advance_exception_status = 'pending',
             advance_exception_requested_by = v_actor,
             advance_exception_requested_at = now(),
             advance_exception_decided_by = null,
             advance_exception_decided_at = null,
             advance_exception_rejection_reason = null
       where id = p_submission_id;
      v_requested := true;
    end if;
  end if;

  -- submitted_at is stamped by the status transition trigger (20260910000000)
  -- and by nothing here.

  if p_declare_advance then
    v_advance := jsonb_build_object(
      'advance_condition', v_condition,
      'advance_percent',   v_effective,
      'standard_percent',  v_standard,
      'grand_total',       v_sub.grand_total,
      'advance_amount',    public.order_submission_advance_amount(v_sub.grand_total, v_effective)
    );
  end if;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
      || v_advance
  );

  -- The exception request is its OWN event, separate from the submission, so a
  -- reader can see the proposal without reading the submission's bookkeeping.
  if v_requested then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'advance_exception_requested', v_sub.status, 'submitted', v_reason,
      v_advance || jsonb_build_object('exception_status', 'pending')
    );
  end if;

  -- The established return shape, unchanged, so the two existing doors answer
  -- exactly what they always answered.
  return jsonb_build_object('id', p_submission_id, 'status', 'submitted', 'item_count', v_item_count);
end;
$$;

revoke execute on function public.submit_order_submission_advance_internal(uuid, text, boolean, text, numeric, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_order_submission_advance_internal(uuid, text, boolean, text, numeric, text) is
  'The single implementation of submitting a PI for review, with an optional employee reply and an optional advance declaration. Executable by no role: reached only by the wrappers, as their definer.';

-- ── 8a. The delegate the two unchanged doors already call ───────────────────
--
-- Identical name, identical signature, identical argument names, identical
-- privileges. submit_order_submission(uuid) and
-- submit_order_submission_with_note(uuid, text) are not restated at all: they
-- call this, and this now calls the implementation with nothing declared.

create or replace function public.submit_order_submission_internal(
  p_submission_id uuid,
  p_note          text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.submit_order_submission_advance_internal(
    p_submission_id, p_note, false, null, null, null);
end;
$$;

revoke execute on function public.submit_order_submission_internal(uuid, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_order_submission_internal(uuid, text) is
  'Submits a PI with an optional employee reply and NO change to its advance declaration. Executable by no role: reached only by submit_order_submission() and submit_order_submission_with_note(), whose behaviour is unchanged.';

-- ── 8b. The new door ────────────────────────────────────────────────────────
--
-- Identical authority to the other two — the same implementation underneath —
-- differing only in carrying the employee's advance declaration.

create or replace function public.submit_order_submission_with_advance(
  p_submission_id     uuid,
  p_note              text,
  p_advance_condition text,
  p_advance_percent   numeric,
  p_advance_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.submit_order_submission_advance_internal(
    p_submission_id, p_note, true, p_advance_condition, p_advance_percent, p_advance_reason);
end;
$$;

revoke execute on function public.submit_order_submission_with_advance(uuid, text, text, numeric, text)
  from public, anon;
grant  execute on function public.submit_order_submission_with_advance(uuid, text, text, numeric, text)
  to authenticated;

comment on function public.submit_order_submission_with_advance(uuid, text, text, numeric, text) is
  'Submits a PI for review under a declared advance requirement: ''standard'' for the configured 40% rule, or ''exception'' with a percentage of at least 0 and below 40 and a mandatory reason. Only the owner may propose an exception, a missing grand total fails closed, and no payment is created, requested or implied.';

-- ═══ 9. The two decisions ═══════════════════════════════════════════════════
--
-- Written the same way as reject_order_submission and for the same reasons: an
-- active actor, the authoritative permission helper, a row lock taken BEFORE the
-- state is judged, one atomic write, one append-only activity row, and a small
-- fixed JSON result.
--
-- WHY THE LOCK COMES FIRST. Two approvers acting at the same moment must not
-- both succeed, and a decision racing a Needs Changes must resolve to exactly
-- one outcome. `for update` serializes them, so the state each function judges
-- is the state it writes against — and a double click finds the request no
-- longer pending and is refused.
--
-- WHAT NEITHER FUNCTION CAN DO. Neither can approve a PI, set order_id, allocate
-- a number, touch a payment, or decide anything on a record that is not
-- currently 'submitted' with a PENDING exception. The last of those is enforced
-- twice: here with a readable business error, and by the guard trigger in
-- section 5 regardless of what any caller attempts.

create or replace function public.approve_pi_advance_exception(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_sub   public.order_submissions%rowtype;
begin
  -- NOT orders.approve_order. Holding that alone is deliberately not enough.
  if not public.actor_has_module_permission('orders', 'approve_advance_exception') then
    raise exception 'You do not have permission to decide advance exceptions'
      using errcode = '42501';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can have its advance exception decided (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.advance_condition is distinct from 'exception'
     or v_sub.advance_exception_status is distinct from 'pending' then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_NOT_PENDING: this PI has no advance exception waiting for a decision'
      using errcode = 'P0001';
  end if;

  -- THE PI STAYS SUBMITTED. Accepting the advance condition is not accepting the
  -- PI: it makes the condition eligible for the later order-approval phase and
  -- does nothing else.
  update public.order_submissions
     set advance_exception_status = 'approved',
         advance_exception_decided_by = v_actor,
         advance_exception_decided_at = now(),
         advance_exception_rejection_reason = null
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'advance_exception_approved', 'submitted', 'submitted', null,
    jsonb_build_object(
      'advance_condition', 'exception',
      'advance_percent',   v_sub.advance_exception_percent,
      'standard_percent',  public.order_submission_standard_advance_percent(),
      'grand_total',       v_sub.grand_total,
      'advance_amount',    public.order_submission_advance_amount(
                             v_sub.grand_total, v_sub.advance_exception_percent),
      'exception_status',  'approved'
    )
  );

  return jsonb_build_object(
    'id', p_submission_id,
    'status', 'submitted',
    'advance_exception_status', 'approved'
  );
end;
$$;

revoke execute on function public.approve_pi_advance_exception(uuid) from public, anon;
grant  execute on function public.approve_pi_advance_exception(uuid) to authenticated;

comment on function public.approve_pi_advance_exception(uuid) is
  'Accepts a pending advance exception on a submitted PI, for a caller holding orders.approve_advance_exception. The PI stays submitted: this approves the advance condition only, never the PI, and creates no payment.';

-- ── 9b. Refusing the proposal, and returning the PI, in one write ───────────
--
-- THE REASON IS MANDATORY, and it becomes the PI's visible correction
-- instruction: an employee told "no" with nothing to act on submits the same
-- proposal again.
--
-- THE PI IS NOT REJECTED. Refusing a proposed advance is a comment on one
-- commercial term, not on the order; the record goes back to the employee, who
-- may return with the standard requirement or with a revised proposal.

create or replace function public.reject_pi_advance_exception(
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
  v_sub    public.order_submissions%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.actor_has_module_permission('orders', 'approve_advance_exception') then
    raise exception 'You do not have permission to decide advance exceptions'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_DECISION_REASON_REQUIRED: say why the proposed advance is being refused'
      using errcode = 'P0001';
  end if;

  if char_length(v_reason) > 1000 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can have its advance exception decided (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.advance_condition is distinct from 'exception'
     or v_sub.advance_exception_status is distinct from 'pending' then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_NOT_PENDING: this PI has no advance exception waiting for a decision'
      using errcode = 'P0001';
  end if;

  -- ONE STATEMENT: the refusal, the reason and the PI's return happen together
  -- or not at all. The consistency constraints in section 2 and the guard in
  -- section 5 refuse any half of it.
  update public.order_submissions
     set advance_exception_status = 'rejected',
         advance_exception_decided_by = v_actor,
         advance_exception_decided_at = now(),
         advance_exception_rejection_reason = v_reason,
         status = 'needs_changes',
         review_note = v_reason
   where id = p_submission_id;

  -- ONE EVENT FOR ONE ACTION. No 'changes_requested' row is written beside this:
  -- the previous and new status on this row already say the PI was returned, and
  -- two entries would read as two separate management decisions.
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'advance_exception_rejected', 'submitted', 'needs_changes', v_reason,
    jsonb_build_object(
      'advance_condition', 'exception',
      'advance_percent',   v_sub.advance_exception_percent,
      'standard_percent',  public.order_submission_standard_advance_percent(),
      'grand_total',       v_sub.grand_total,
      'advance_amount',    public.order_submission_advance_amount(
                             v_sub.grand_total, v_sub.advance_exception_percent),
      'exception_status',  'rejected',
      'pi_returned',       true
    )
  );

  return jsonb_build_object(
    'id', p_submission_id,
    'status', 'needs_changes',
    'advance_exception_status', 'rejected'
  );
end;
$$;

revoke execute on function public.reject_pi_advance_exception(uuid, text) from public, anon;
grant  execute on function public.reject_pi_advance_exception(uuid, text) to authenticated;

comment on function public.reject_pi_advance_exception(uuid, text) is
  'Refuses a pending advance exception on a submitted PI and returns the PI for correction, in one atomic write, for a caller holding orders.approve_advance_exception. The reason is mandatory and becomes the visible correction instruction. The PI itself is not rejected.';

-- ═══ 10. Assertions ═════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_bad text;
  v_n   integer;
  v_def text;
begin
  -- ── The standard rule is 40, and the percentage CHECK agrees with it ──
  if public.order_submission_standard_advance_percent() <> 40 then
    raise exception 'the standard advance percentage is not 40';
  end if;

  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'order_submissions'
    and c.conname = 'order_submissions_advance_exception_percent_valid';
  if v_def is null then
    raise exception 'the advance percentage constraint is missing';
  end if;
  if position(public.order_submission_standard_advance_percent()::text in v_def) = 0 then
    raise exception
      'the advance percentage constraint does not bound at the standard %; the two have drifted apart',
      public.order_submission_standard_advance_percent();
  end if;

  -- ── The derived amount is derived, and rounded to paise ──
  if public.order_submission_advance_amount(100000, 40) <> 40000 then
    raise exception 'the standard advance on 1,00,000 is not 40,000';
  end if;
  if public.order_submission_advance_amount(100000, 0) <> 0 then
    raise exception 'a zero-percent advance is not zero';
  end if;
  if public.order_submission_advance_amount(123456.78, 12.5) <> 15432.10 then
    raise exception 'the derived advance is not rounded to paise';
  end if;
  if public.order_submission_advance_amount(null, 40) is not null then
    raise exception 'an unknown grand total must derive no amount';
  end if;
  if public.order_submission_advance_amount(100000, 'NaN'::numeric) is not null then
    raise exception 'a NaN percentage must derive no amount';
  end if;

  -- ── The Phase C predicate, case by case ──
  if not public.order_submission_advance_ready('standard', null, null) then
    raise exception 'the standard requirement must be advance-ready';
  end if;
  if not public.order_submission_advance_ready('exception', 0, 'approved') then
    raise exception 'an approved zero-percent exception must be advance-ready';
  end if;
  if not public.order_submission_advance_ready('exception', 39.99, 'approved') then
    raise exception 'an approved exception just below the standard must be advance-ready';
  end if;
  for v_bad in
    select unnest(array['pending', 'rejected'])
  loop
    if public.order_submission_advance_ready('exception', 10, v_bad) then
      raise exception 'a % exception must NOT be advance-ready', v_bad;
    end if;
  end loop;
  if public.order_submission_advance_ready(null, null, null) then
    raise exception 'an undeclared condition must NOT be advance-ready';
  end if;
  if public.order_submission_advance_ready('exception', null, 'approved') then
    raise exception 'an approved exception with no percentage must NOT be advance-ready';
  end if;
  if public.order_submission_advance_ready('exception', 40, 'approved') then
    raise exception 'an exception at the standard is not an exception and must NOT be advance-ready';
  end if;
  if public.order_submission_advance_ready('exception', 50, 'approved') then
    raise exception 'an exception above the standard must NOT be advance-ready';
  end if;
  if public.order_submission_advance_ready('exception', -1, 'approved') then
    raise exception 'a negative exception must NOT be advance-ready';
  end if;
  if public.order_submission_advance_ready('exception', 'NaN'::numeric, 'approved') then
    raise exception 'a NaN exception must NOT be advance-ready';
  end if;
  if public.order_submission_advance_ready('exception', 10, null) then
    raise exception 'an undecided exception must NOT be advance-ready';
  end if;
  if public.order_submission_advance_ready('nonsense', 10, 'approved') then
    raise exception 'an unknown condition must NOT be advance-ready';
  end if;

  -- ── Approval is STILL reachable from nothing ──
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'order_submissions_enforce_status_transition';
  if v_def is null then
    raise exception 'the status transition trigger function is missing';
  end if;
  if v_def like '%''approved''%' then
    raise exception 'the transition trigger names approved; this phase must not make it reachable';
  end if;

  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_order_submission', 'allocate_order_submission_number')
  ) then
    raise exception 'an approval or numbering function exists; that belongs to a later phase';
  end if;

  if exists (select 1 from public.order_submissions where status = 'approved') then
    raise exception 'a submission is approved; this phase cannot approve anything';
  end if;
  if exists (select 1 from public.order_submissions where order_id is not null) then
    raise exception 'a submission is linked to an Order; this phase creates none';
  end if;

  -- ── All four triggers on order_submissions are attached and enabled ──
  select string_agg(format('%s(%s)', t.tgname, t.tgenabled), ', ') into v_bad
  from pg_trigger t
  join pg_class c     on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'order_submissions'
    and not t.tgisinternal
    and t.tgenabled <> 'O';
  if v_bad is not null then
    raise exception 'These triggers on order_submissions are not enabled: %', v_bad;
  end if;

  select count(*) into v_n
  from pg_trigger t
  join pg_class c     on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'order_submissions'
    and not t.tgisinternal;
  if v_n <> 4 then
    raise exception 'Expected 4 triggers on order_submissions, found %', v_n;
  end if;

  -- The advance guard must fire on INSERT as well as UPDATE, or a row could be
  -- created carrying a decided exception by anything holding an INSERT
  -- privilege — which is the service role, and it bypasses RLS.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'order_submissions'
      and t.tgname = 'order_submissions_guard_advance_exception'
      and not t.tgisinternal
      -- tgtype bit 2 = INSERT, bit 4 = UPDATE, bit 0 = BEFORE (row-level bit 1)
      and (t.tgtype & 4) <> 0
      and (t.tgtype & 16) <> 0
  ) then
    raise exception 'the advance guard is not attached for both INSERT and UPDATE';
  end if;

  -- ── Every new function: SECURITY DEFINER where it matters, pinned path ──
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('submit_order_submission_advance_internal',
                      'submit_order_submission_internal',
                      'submit_order_submission_with_advance',
                      'approve_pi_advance_exception',
                      'reject_pi_advance_exception',
                      'order_submission_is_advance_ready',
                      'order_submissions_guard_advance_exception')
    and (
      not p.prosecdef
      or not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
        where cfg like 'search_path=%'
      )
    );
  if v_bad is not null then
    raise exception 'These functions are not SECURITY DEFINER with a pinned search_path: %', v_bad;
  end if;

  -- ── The internal implementation and the guard reach NO role ──
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('submit_order_submission_advance_internal',
                      'submit_order_submission_internal',
                      'order_submissions_guard_advance_exception')
    and (
      has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('service_role', p.oid, 'EXECUTE')
    );
  if v_bad is not null then
    raise exception '% is executable by a role; the advance checks could be bypassed', v_bad;
  end if;

  -- ── The three client doors: authenticated only, never anon or PUBLIC ──
  select count(*) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('submit_order_submission_with_advance',
                         'approve_pi_advance_exception',
                         'reject_pi_advance_exception',
                         'order_submission_is_advance_ready',
                         'order_submission_advance_ready',
                         'order_submission_advance_amount',
                         'order_submission_standard_advance_percent')
    and grantee in ('anon', 'PUBLIC');
  if v_n > 0 then
    raise exception 'an advance function is executable by anon or PUBLIC';
  end if;

  select count(distinct routine_name) into v_n
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('submit_order_submission_with_advance',
                         'approve_pi_advance_exception',
                         'reject_pi_advance_exception')
    and grantee = 'authenticated';
  if v_n <> 3 then
    raise exception 'all three advance RPCs must be executable by authenticated (found %)', v_n;
  end if;

  -- ── The Phase A doors are untouched, down to their argument names ──
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'submit_order_submission'
      and p.prokind  = 'f'
      and p.pronargs = 1
      and p.proargtypes[0] = 'uuid'::regtype
      and array_length(p.proargnames, 1) = 1
      and p.proargnames[1] = 'p_submission_id'
  ) then
    raise exception 'submit_order_submission(p_submission_id uuid) is missing or its signature changed';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'submit_order_submission_with_note'
      and p.prokind  = 'f'
      and p.pronargs = 2
      and p.proargtypes[0] = 'uuid'::regtype
      and p.proargtypes[1] = 'text'::regtype
      and array_length(p.proargnames, 1) = 2
      and p.proargnames[1] = 'p_submission_id'
      and p.proargnames[2] = 'p_note'
  ) then
    raise exception 'submit_order_submission_with_note(uuid, text) is missing or its signature changed';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'submit_order_submission_internal'
      and p.prokind  = 'f'
      and p.pronargs = 2
      and p.proargtypes[0] = 'uuid'::regtype
      and p.proargtypes[1] = 'text'::regtype
      and array_length(p.proargnames, 1) = 2
      and p.proargnames[1] = 'p_submission_id'
      and p.proargnames[2] = 'p_note'
  ) then
    raise exception 'submit_order_submission_internal(uuid, text) changed shape; the unchanged doors would break';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'submit_order_submission_with_advance'
      and p.prokind  = 'f'
      and p.pronargs = 5
      and p.proargtypes[0] = 'uuid'::regtype
      and p.proargtypes[1] = 'text'::regtype
      and p.proargtypes[2] = 'text'::regtype
      and p.proargtypes[3] = 'numeric'::regtype
      and p.proargtypes[4] = 'text'::regtype
      and array_length(p.proargnames, 1) = 5
      and p.proargnames[1] = 'p_submission_id'
      and p.proargnames[2] = 'p_note'
      and p.proargnames[3] = 'p_advance_condition'
      and p.proargnames[4] = 'p_advance_percent'
      and p.proargnames[5] = 'p_advance_reason'
  ) then
    raise exception 'submit_order_submission_with_advance has the wrong signature';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'approve_pi_advance_exception'
      and p.pronargs = 1
      and p.proargtypes[0] = 'uuid'::regtype
      and p.proargnames[1] = 'p_submission_id'
  ) then
    raise exception 'approve_pi_advance_exception has the wrong signature';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'reject_pi_advance_exception'
      and p.pronargs = 2
      and p.proargtypes[0] = 'uuid'::regtype
      and p.proargtypes[1] = 'text'::regtype
      and p.proargnames[1] = 'p_submission_id'
      and p.proargnames[2] = 'p_reason'
  ) then
    raise exception 'reject_pi_advance_exception has the wrong signature';
  end if;

  -- ── No accidental overload: one function per name ──
  --
  -- PostgREST resolves an overloaded name by which argument keys a caller
  -- happened to send, so a second variant of any of these would silently change
  -- which function a client reaches.
  for v_bad in
    select unnest(array['submit_order_submission',
                        'submit_order_submission_with_note',
                        'submit_order_submission_with_advance',
                        'submit_order_submission_internal',
                        'submit_order_submission_advance_internal',
                        'approve_pi_advance_exception',
                        'reject_pi_advance_exception',
                        'order_submission_advance_ready',
                        'order_submission_is_advance_ready',
                        'order_submission_advance_amount',
                        'order_submission_standard_advance_percent'])
  loop
    select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_bad;
    if v_n <> 1 then
      raise exception '% is overloaded (% variants); PostgREST would resolve it by argument names', v_bad, v_n;
    end if;
  end loop;

  -- ── The decisions really do require the NEW permission and lock the row ──
  for v_bad in
    select unnest(array['approve_pi_advance_exception', 'reject_pi_advance_exception'])
  loop
    select p.prosrc into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_bad;

    if v_def not like '%actor_has_module_permission(''orders'', ''approve_advance_exception'')%' then
      raise exception '% does not require orders.approve_advance_exception', v_bad;
    end if;
    if v_def like '%''approve_order''%' then
      raise exception '% must not accept orders.approve_order as the authority for a financial exception', v_bad;
    end if;
    if v_def not like '%for update%' then
      raise exception '% does not lock the submission row before judging it', v_bad;
    end if;
    if v_def not like '%assert_order_submission_actor%' then
      raise exception '% does not derive its actor from auth.uid()', v_bad;
    end if;
    if v_def not like '%log_order_submission_activity%' then
      raise exception '% does not record what it did', v_bad;
    end if;
  end loop;

  -- ── The submission path enforces the whole declaration ──
  select p.prosrc into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'submit_order_submission_advance_internal';

  for v_bad in select unnest(array[
    'assert_order_submission_actor',
    'actor_has_module_permission',
    'can_edit_order_submission',
    'for update',
    'ORDER_SUBMISSION_BLOCKED',
    'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING',
    'ORDER_SUBMISSION_ADVANCE_NOT_OWNER',
    'ORDER_SUBMISSION_ADVANCE_REASON_REQUIRED',
    'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID',
    'log_order_submission_activity'
  ]) loop
    if v_def not like '%' || v_bad || '%' then
      raise exception 'the submission implementation no longer performs: %', v_bad;
    end if;
  end loop;

  -- Nothing in it approves, numbers, converts or pays.
  for v_bad in select unnest(array['order_number', 'display_number', 'allocate_confirmed',
                                   'finance_payment', 'payment_request', 'order_id']) loop
    if v_def like '%' || v_bad || '%' then
      raise exception 'the submission implementation references %, which belongs to a later phase', v_bad;
    end if;
  end loop;

  -- ── The activity action set: eight values, and not one more ──
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'order_submission_activity'
    and c.conname = 'order_submission_activity_action_check';
  if v_def is null then
    raise exception 'the activity action constraint is missing';
  end if;
  for v_bad in select unnest(array['submission_created', 'parse_replaced', 'submitted',
                                   'changes_requested', 'rejected',
                                   'advance_exception_requested', 'advance_exception_approved',
                                   'advance_exception_rejected'])
  loop
    if v_def not like '%''' || v_bad || '''%' then
      raise exception 'the activity action constraint does not admit %', v_bad;
    end if;
  end loop;
  for v_bad in select unnest(array['order_number_allocated', 'advance_recorded',
                                   'payment_recorded', 'payment_received', 'order_created'])
  loop
    if v_def like '%' || v_bad || '%' then
      raise exception 'the activity action constraint admits %, which belongs to a later phase', v_bad;
    end if;
  end loop;

  -- ── History is still append-only, and the logger still reaches no role ──
  select string_agg(p.polname, ', ') into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'order_submission_activity'
    and p.polcmd in ('a', 'w', 'd');
  if v_bad is not null then
    raise exception 'order_submission_activity has write policies: %', v_bad;
  end if;

  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'log_order_submission_activity'
      and (
        has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'log_order_submission_activity is executable by a role; history would be forgeable';
  end if;

  -- ── No client role gained a table write ──
  select string_agg(format('%s:%s', table_name, privilege_type), ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('order_submissions', 'order_submission_items',
                       'order_submission_activity', 'order_submission_item_images')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_bad is not null then
    raise exception 'client roles hold write privileges: %', v_bad;
  end if;

  -- ── RLS and the module gates are untouched ──
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('order_submissions', 'order_submission_items',
                      'order_submission_activity', 'order_submission_item_images')
    and not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'RLS is not enabled on: %', v_bad;
  end if;

  select count(*) into v_n
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polname = c.relname || '_module_entry_gate'
    and c.relname in ('order_submissions', 'order_submission_items',
                      'order_submission_activity', 'order_submission_item_images')
    and not p.polpermissive;
  if v_n <> 4 then
    raise exception 'expected 4 restrictive module entry gates, found %', v_n;
  end if;

  -- ── The new permission: registered, deny-by-default, granted to nobody ──
  if not exists (
    select 1
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    join public.permission_actions pa on pa.id = mpa.action_id
    where pm.module_key = 'orders'
      and pa.action_key = 'approve_advance_exception'
      and mpa.default_allowed = false
  ) then
    raise exception 'orders.approve_advance_exception is not registered as deny-by-default';
  end if;

  -- It must not have been handed to a ROLE, which is how a preset would reach
  -- everybody holding that role at once.
  select count(*) into v_n
  from public.role_permissions rp
  join public.permission_modules pm on pm.id = rp.module_id
  join public.permission_actions pa on pa.id = rp.action_id
  where pm.module_key = 'orders'
    and pa.action_key = 'approve_advance_exception'
    and rp.allowed;
  if v_n > 0 then
    raise exception
      '% role(s) already grant orders.approve_advance_exception; it is granted per person or not at all', v_n;
  end if;

  -- And orders.approve_order is still its own, separate authority.
  if not exists (
    select 1
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    join public.permission_actions pa on pa.id = mpa.action_id
    where pm.module_key = 'orders'
      and pa.action_key = 'approve_order'
      and mpa.default_allowed = false
  ) then
    raise exception 'orders.approve_order is no longer registered as deny-by-default';
  end if;

  -- ── Nothing about payment or Finance was added ──
  select string_agg(column_name, ', ') into v_bad
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'order_submissions'
    and (column_name like '%payment%' or column_name like '%paid%' or column_name like '%receipt%');
  if v_bad is not null then
    raise exception 'order_submissions gained payment columns: %', v_bad;
  end if;

  -- ── The advance columns arrived with the shape this phase describes ──
  select string_agg(column_name, ', ') into v_bad
  from (
    select c.column_name
    from unnest(array['advance_condition', 'advance_exception_percent', 'advance_exception_status',
                      'advance_exception_requested_by', 'advance_exception_requested_at',
                      'advance_exception_decided_by', 'advance_exception_decided_at',
                      'advance_exception_rejection_reason', 'advance_exception_reason']) as want(column_name)
    left join information_schema.columns c
      on c.table_schema = 'public'
     and c.table_name = 'order_submissions'
     and c.column_name = want.column_name
     and c.is_nullable = 'YES'
    where c.column_name is null
  ) missing;
  if v_bad is not null then
    raise exception 'these advance columns are missing or not nullable: %', v_bad;
  end if;

  -- The percentage must be UNCONSTRAINED numeric, so excessive precision is
  -- refused by the CHECK rather than silently rounded by the column type.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_submissions'
      and column_name = 'advance_exception_percent'
      and numeric_scale is not null
  ) then
    raise exception
      'advance_exception_percent has a fixed scale; excessive precision would be rounded rather than refused';
  end if;

  -- ── Every consistency constraint is present and VALIDATED ──
  select string_agg(want.name, ', ') into v_bad
  from unnest(array['order_submissions_advance_condition_known',
                    'order_submissions_advance_exception_status_known',
                    'order_submissions_advance_exception_percent_valid',
                    'order_submissions_advance_exception_fields_need_exception',
                    'order_submissions_advance_exception_is_complete',
                    'order_submissions_advance_decision_consistency',
                    'order_submissions_advance_needs_grand_total']) as want(name)
  where not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'order_submissions'
      and c.conname = want.name
      and c.contype = 'c'
      and c.convalidated
  );
  if v_bad is not null then
    raise exception 'these advance constraints are missing or unvalidated: %', v_bad;
  end if;

  -- ── No record was given a declaration by this migration ──
  select count(*) into v_n from public.order_submissions where advance_condition is not null;
  if v_n > 0 then
    raise exception
      '% record(s) carry an advance condition; this migration declares nothing on anybody''s behalf', v_n;
  end if;
end $$;
