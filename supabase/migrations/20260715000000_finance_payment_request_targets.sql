-- Finance ↔ Orders — three explicit payment submission targets.
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20260714000000.
--
-- ── The problem ───────────────────────────────────────────────────────────────
--
-- A payment can be submitted against three genuinely different stages of the
-- sales lifecycle:
--
--   1. New Order       — money arrived, there is no Order Request and no
--                        Confirmed Order yet. The payment stays unallocated.
--   2. Order Request   — an Order Request exists and has not been approved or
--                        converted. The payment belongs to that proposed order,
--                        and an admin reviewing the request has to see it BEFORE
--                        deciding whether to approve.
--   3. Confirmed Order — the order is approved and carries a number. The payment
--                        belongs to that Order.
--
-- The database supports 1 and 3 at submission time and 2 only AFTER financial
-- approval: `finance_payment_requests_request_link_invariant` (20260698 §1)
-- requires `status = 'approved_unlinked'` for a row that carries
-- order_request_id. So a salesperson could not name the Order Request their
-- advance belonged to while submitting, and the admin reviewing that request saw
-- nothing until Finance had already approved the money separately.
--
-- ── The data contract this migration establishes ──────────────────────────────
--
-- New column `payment_target_type text not null` with exactly three values:
--
--     'unallocated' | 'order_request' | 'confirmed_order'
--
-- It records WHICH TARGET THE SUBMITTER CHOSE. That is not the same question as
-- "what is this payment attached to right now", which the linkage columns
-- (order_id / order_request_id) already answer and which legitimately changes
-- over the payment's life — most importantly at Order Request conversion, which
-- moves a request-targeted payment onto the Order it produced. Keeping the two
-- questions in separate columns is what lets conversion preserve provenance
-- instead of erasing it.
--
-- `payment_against` (20260658) is NOT renamed, NOT dropped, and NOT re-purposed.
-- It stays exactly what it has always been — the two-valued origin flag every
-- existing branch reads — and it is now DERIVED from payment_target_type so the
-- two can never disagree:
--
--     unallocated     -> payment_against = 'new_order'
--     order_request   -> payment_against = 'new_order'
--     confirmed_order -> payment_against = 'existing_order'
--
-- CHECK `finance_payment_requests_target_type_origin` states that equivalence
-- directly, so it survives any future edit to the trigger below.
--
-- payment_target_type is ALWAYS SERVER-DERIVED and never trusted from a client
-- payload — see §3. A client expresses its choice by which linkage columns it
-- sends, which is also what the mutual-exclusivity CHECK already governs, so
-- there is exactly one thing for a caller to get right instead of two that could
-- contradict each other.
--
-- ── What this migration deliberately does NOT do ──────────────────────────────
--
--   * It does not add a payment status. A request-linked payment that has been
--     financially approved stays 'approved_unlinked' — the status that means
--     "money confirmed received, not yet attached to a Confirmed Order". Every
--     advance/received total in the app sums approved_linked rows filtered by
--     order_id, so nothing double-counts, and Received Payments routing
--     (paymentRouting.ts) is untouched.
--   * It does not weaken any RLS policy. No policy is created, dropped or
--     altered here.
--   * It does not change link_finance_payment_to_order_request /
--     unlink_finance_payment_from_order_request. Those own POST-APPROVAL
--     linkage and keep their own (deliberately wider) rules, including the
--     'rejected' request status 20260699 admitted on purpose.

-- ═════════════════════════════════════════════════════════════════════════════
-- §1. The target column
-- ═════════════════════════════════════════════════════════════════════════════
-- Added nullable, backfilled from real state, and only then made NOT NULL with a
-- default — so historical rows keep a faithful classification rather than all
-- collapsing onto the default.

alter table public.finance_payment_requests
  add column if not exists payment_target_type text;

-- Backfill from the ORIGIN flag, which is the only pre-existing record of what
-- the submitter chose:
--
--   payment_against = 'existing_order'                 -> confirmed_order
--   payment_against = 'new_order' + order_request_id   -> order_request
--   payment_against = 'new_order'                      -> unallocated
--
-- order_id is deliberately NOT consulted. A new_order payment that has since
-- been linked to an Order (directly, or swept there by conversion) still
-- ORIGINATED as a new_order submission, and classifying it by its current
-- linkage would both misstate its origin and violate the
-- ..._target_type_origin CHECK added below, which ties the two columns
-- together. Pre-migration there is no record anywhere of which of the two
-- new_order routes such a row took; 'unallocated' is the truthful reading of
-- "submitted without naming a target".
update public.finance_payment_requests
   set payment_target_type =
     case
       when payment_against = 'existing_order' then 'confirmed_order'
       when order_request_id is not null       then 'order_request'
       else                                         'unallocated'
     end
 where payment_target_type is null;

alter table public.finance_payment_requests
  alter column payment_target_type set default 'unallocated';

alter table public.finance_payment_requests
  alter column payment_target_type set not null;

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_target_type_check;

alter table public.finance_payment_requests
  add constraint finance_payment_requests_target_type_check
  check (payment_target_type in ('unallocated', 'order_request', 'confirmed_order'));

-- The origin flag and the target classification are two views of one decision.
-- Stated as a constraint rather than left to the trigger, so a direct SQL write
-- that bypasses the trigger (there is none today) still cannot produce a row
-- whose two classifications disagree.
alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_target_type_origin;

alter table public.finance_payment_requests
  add constraint finance_payment_requests_target_type_origin
  check (
    (payment_target_type = 'confirmed_order') = (payment_against = 'existing_order')
  );

comment on column public.finance_payment_requests.payment_target_type is
  'Which of the three submission targets the payment was raised against: unallocated (New Order) | order_request | confirmed_order. Server-derived (see finance_payment_requests_derive_target), frozen once the payment is approved, and NOT the same as the payment''s current linkage — conversion moves an order_request-targeted payment onto an Order while this column keeps recording where it came from.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §2. Order Request linkage across the whole pre-approval lifecycle
-- ═════════════════════════════════════════════════════════════════════════════
-- The 20260698 invariant allowed order_request_id ONLY while
-- status = 'approved_unlinked'. That is exactly what blocked selecting an Order
-- Request at submission time, and it also meant a clarification or rejection
-- would have had to strip the linkage the salesperson chose.
--
-- Replaced with: the pair still moves in lock-step, and the linkage is valid in
-- every status EXCEPT 'approved_linked'. approved_linked means the money is
-- attached to a Confirmed Order, which is the one state where a request linkage
-- would be a contradiction rather than a stage.
--
-- `finance_payment_requests_one_link_target` (20260698 §1) is deliberately left
-- exactly as it is: it already forbids order_id and order_request_id together,
-- which is the mutual-exclusivity rule, and it is now the ONLY thing enforcing
-- it (the old invariant enforced it as a side effect via the status chain).
-- `finance_payment_requests_status_order_invariant` (20260692) is untouched too.

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_request_link_invariant;

alter table public.finance_payment_requests
  add constraint finance_payment_requests_request_link_invariant
  check (
    (order_request_id is null and order_request_number is null)
    or
    (order_request_id is not null
     and order_request_number is not null
     and status <> 'approved_linked'
     and payment_target_type <> 'confirmed_order')
  );

-- "Every payment on this Order Request" is now a lifecycle-wide query (the
-- request detail panel reads pre-approval rows too), not only the conversion
-- sweep, so the partial index earns its keep more than before. Already created
-- by 20260698 §1; asserted rather than duplicated.
create index if not exists finance_payment_requests_order_request_idx
  on public.finance_payment_requests (order_request_id)
  where order_request_id is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- §3. Server-derived target + Order Request validation (BEFORE INSERT/UPDATE)
-- ═════════════════════════════════════════════════════════════════════════════
-- This is the single point where a client-supplied Order Request selection is
-- checked and where every authoritative value is derived. It fires on EVERY
-- write path into the table — the direct PostgREST insert the submission form
-- uses, the owner's edit, an admin's PATCH, and the SECURITY DEFINER linkage
-- RPCs — which is why it is a trigger and not validation inside one RPC.
--
-- NOT SECURITY DEFINER, on purpose. It reads public.order_requests and writes
-- columns of the row already being mutated under the caller's own RLS, so it
-- needs no elevated privilege — the same reasoning (and the same shape) as
-- enforce_finance_payment_request_client_name (20260688 §2). Least privilege:
-- for a client call, RLS on order_requests independently hides a request the
-- caller has no business seeing, so the explicit authorization check below and
-- row visibility have to BOTH pass. search_path is still pinned.
--
-- Trigger NAME matters: PostgreSQL fires same-timing row triggers in name order,
-- and `finance_payment_requests_derive_target` sorts before
-- `finance_payment_requests_enforce_client_name`. That ordering is required —
-- this function derives payment_against, and the client-name trigger branches on
-- it.
--
-- ── The derivation rule ──
--   INSERT, or UPDATE of a row that is still PRE-APPROVAL:
--       payment_target_type := confirmed_order  when order_id         is not null
--                              order_request    when order_request_id is not null
--                              unallocated      otherwise
--   UPDATE of a row that is already APPROVED:
--       payment_target_type := old.payment_target_type  (frozen)
--
-- Freezing on approved rows is what preserves provenance through conversion:
-- convert_order_request_to_order sets order_id and clears order_request_id in
-- one statement, and the payment keeps recording that it was raised against an
-- Order Request. It is also what keeps the two linkage RPCs working unchanged.

create or replace function public.finance_payment_requests_derive_target()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_req      public.order_requests%rowtype;
  v_editable boolean;
begin
  -- ── 1. Target classification, always server-derived ────────────────────────
  -- 'editable' = the payment is still in the submitter's hands. Exactly the
  -- three request-stage statuses (REQUEST_STAGE_STATUSES in
  -- src/app/finance/paymentRouting.ts); both approved_* states are excluded.
  v_editable := new.status in ('pending_approval', 'needs_clarification', 'rejected');

  -- A caller that explicitly declares an existing-order payment and supplies no
  -- Order is refused rather than silently re-filed as a New Order payment. This
  -- is the same failure enforce_finance_payment_request_client_name (20260688
  -- §2) has always produced; stated here because that trigger runs after this
  -- one and now sees a payment_against this function has already derived.
  if tg_op = 'INSERT'
     and new.payment_against = 'existing_order'
     and new.order_id is null then
    raise exception 'An existing order must be selected for an existing-order payment request'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    new.payment_target_type :=
      case
        when new.order_id         is not null then 'confirmed_order'
        when new.order_request_id is not null then 'order_request'
        else                                       'unallocated'
      end;
  elsif old.status in ('pending_approval', 'needs_clarification', 'rejected') then
    new.payment_target_type :=
      case
        when new.order_id         is not null then 'confirmed_order'
        when new.order_request_id is not null then 'order_request'
        else                                       'unallocated'
      end;
  else
    -- Approved: frozen. Any client-supplied value is discarded rather than
    -- rejected, so the linkage RPCs and the conversion transfer — none of which
    -- send this column — pass through untouched.
    new.payment_target_type := old.payment_target_type;
  end if;

  -- ── 2. payment_against follows the target, never the payload ───────────────
  new.payment_against :=
    case new.payment_target_type
      when 'confirmed_order' then 'existing_order'
      else                        'new_order'
    end;

  -- ── 3. The Order Request selection ─────────────────────────────────────────
  if new.order_request_id is null then
    -- The denormalised number can never outlive the id it describes.
    new.order_request_number := null;
    return new;
  end if;

  -- Only validate when the linkage is actually being established. An UPDATE
  -- that leaves order_request_id untouched (an amount correction, an admin
  -- note, the conversion transfer's own no-op on other columns) must not be
  -- able to fail because the request has since moved on.
  if tg_op = 'UPDATE' and new.order_request_id is not distinct from old.order_request_id then
    return new;
  end if;

  -- Read WITHOUT a locking clause, deliberately.
  --
  -- `SELECT ... FOR SHARE` would have serialized this against a concurrent
  -- conversion, but it CANNOT be used here: PostgreSQL applies UPDATE policies
  -- as well as SELECT policies to a locking read, and public.order_requests has
  -- had NO UPDATE POLICY FOR ANY ROLE since 20260683/20260687 moved every
  -- mutation into a SECURITY DEFINER RPC. A locking read would therefore be
  -- filtered to zero rows for every ordinary client — i.e. it would refuse every
  -- legitimate submission — and it additionally requires UPDATE privilege on the
  -- table. A plain read is the only correct choice here.
  --
  -- The narrow consequence, and why it is safe: a submission that commits in the
  -- window between the conversion RPC's undecided-payment count and its commit
  -- can attach a pending payment to a request that has just become converted.
  -- Nothing is corrupted — the payment is simply pending against a converted
  -- request — and approve_finance_payment_request revalidates the request and
  -- REFUSES with ORDER_REQUEST_CONVERTED rather than silently unallocating it.
  -- The owner then re-targets the payment at the Confirmed Order. That is
  -- exactly the actionable failure the approval-time revalidation exists for.
  --
  -- READ COMMITTED gives this statement a fresh snapshot, so a conversion that
  -- has already committed IS seen and refused below.
  select * into v_req
  from public.order_requests
  where id = new.order_request_id;

  -- Not found covers three cases and deliberately reports them identically: the
  -- request does not exist, it was deleted, or the caller cannot see it under
  -- order_requests RLS. A caller must never learn that a request they have no
  -- access to exists.
  if not found then
    raise exception 'ORDER_REQUEST_NOT_AVAILABLE: The selected Order Request is not available.'
      using errcode = '42501';
  end if;

  -- An unfinalized draft (20260711) is not a submitted request at all: it has no
  -- verified Main PI and appears in no list or count. Its own creator can still
  -- SELECT it, so this has to be an explicit check rather than an RLS side
  -- effect.
  if v_req.finalized_at is null then
    raise exception 'ORDER_REQUEST_NOT_AVAILABLE: The selected Order Request is not available.'
      using errcode = '42501';
  end if;

  -- Authorization. Skipped when there is no authenticated user — a service-role
  -- or direct-SQL maintenance path, exempt exactly as every other guard on this
  -- schema is (order_requests_guard_converted,
  -- finance_payment_requests_guard_approved, validate_order_request_assignee).
  --
  -- The rule is the module's PARTICIPANT rule (isRequestParticipant, 20260707):
  -- an admin, the creator, the person it was requested for, or the person it is
  -- assigned to. An unrelated salesperson cannot attach money to someone else's
  -- Order Request, and RLS has already hidden it from them independently.
  if v_actor is not null
     and not (v_req.created_by   = v_actor
           or v_req.requested_by = v_actor
           or v_req.assigned_to  = v_actor)
     and not exists (
       select 1 from public.users u where u.id = v_actor and u.role = 'admin'
     )
  then
    raise exception 'ORDER_REQUEST_NOT_PERMITTED: You cannot attach a payment to this Order Request.'
      using errcode = '42501';
  end if;

  -- State eligibility, checked ONLY on the submission/edit path. A payment that
  -- is already approved reaches this line solely through
  -- link_finance_payment_to_order_request, which runs its own — deliberately
  -- wider, 'rejected' included (20260699 §2) — eligibility check under a
  -- FOR UPDATE lock. Re-imposing a narrower rule here would silently revoke that
  -- decision.
  if v_editable then
    if v_req.converted_order_id is not null or v_req.status = 'converted' then
      raise exception 'ORDER_REQUEST_CONVERTED: Order Request % has already been converted to a Confirmed Order. Select the Confirmed Order instead.',
        v_req.request_number
        using errcode = 'P0001';
    end if;

    -- Active = still on the approvable track. 'rejected' is excluded here on
    -- purpose: a rejected request is not a proposed order anyone should be
    -- attaching new money to. (It can still RECEIVE an already-approved payment
    -- through the admin linkage RPC, which is a different, deliberate decision.)
    if v_req.status not in ('submitted', 'needs_clarification') then
      raise exception 'ORDER_REQUEST_NOT_ACTIVE: Order Request % is % and cannot receive a new payment request.',
        v_req.request_number, v_req.status
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 4. Authoritative values, derived — never taken from the payload ────────
  new.order_request_number := v_req.request_number;

  -- Client name follows the selected request, exactly as it follows the selected
  -- Order for an existing_order payment (20260688 §2).
  --
  -- Restricted to the pre-approval statuses on purpose. Once a payment is
  -- approved its client_name is a recorded historical fact, and
  -- finance_payment_requests_guard_approved (20260699 §5 / 20260700 §2) raises
  -- for a non-admin if it changes — so re-deriving it here would break the
  -- member half of link_finance_payment_to_order_request.
  if v_editable then
    if v_req.client_name is null or btrim(v_req.client_name) = '' then
      raise exception 'ORDER_REQUEST_NO_CLIENT: Order Request % has no client name on file.',
        v_req.request_number
        using errcode = 'P0001';
    end if;
    new.client_name := v_req.client_name;
  end if;

  return new;
end;
$$;

revoke execute on function public.finance_payment_requests_derive_target()
  from public, anon, authenticated;

drop trigger if exists finance_payment_requests_derive_target
  on public.finance_payment_requests;

create trigger finance_payment_requests_derive_target
  before insert or update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_derive_target();

-- ═════════════════════════════════════════════════════════════════════════════
-- §4. Audit — the target at submission, and target changes before approval
-- ═════════════════════════════════════════════════════════════════════════════
-- One new event type. The list below is the DEPLOYED 20260698 §2 set (verified
-- against that migration, which is the newest one to touch this constraint) plus
-- 'target_changed' — a UNION, never a retyped list, because a drop-and-recreate
-- CHECK silently revokes anything omitted and an empty table hides it until the
-- first real write.

alter table public.finance_payment_request_activity_log
  drop constraint if exists finance_payment_request_activity_log_event_type_check;

alter table public.finance_payment_request_activity_log
  add constraint finance_payment_request_activity_log_event_type_check
  check (event_type in (
    'request_submitted',
    'order_linked',
    'order_unlinked',
    'order_link_changed',
    'order_request_linked',
    'order_request_unlinked',
    'target_changed',
    'status_changed'
  ));

-- Body is the deployed 20260698 §3 version with three additions:
--
--   (a) the INSERT payload now names the target the payment was submitted
--       against, so "which of the three did the salesperson pick" is answerable
--       from the audit trail alone;
--   (b) a new 'target_changed' branch for PRE-APPROVAL target corrections,
--       placed ahead of the existing linkage branches. It exists because
--       switching from an Order Request to a Confirmed Order changes two columns
--       at once, which the old branch set would have recorded as an unlink with
--       the new link invisible;
--   (c) the request-side timeline (order_request_activity) now receives a
--       payment_linked row at SUBMISSION time, and linked/unlinked rows when a
--       pre-approval target changes.
--
-- (c) cannot double-log: order_request_activity rows for linkage are otherwise
-- written only by link_/unlink_finance_payment_to/from_order_request, and both
-- of those operate exclusively on 'approved_unlinked' payments — a status this
-- function's request-side block never fires for. The two writers partition the
-- lifecycle cleanly at the approval boundary.
--
-- Deliberately unchanged: the order_linked / order_unlinked / order_link_changed
-- / order_request_linked / order_request_unlinked / status_changed branches, the
-- conversion-transfer provenance payload, and the `return null` for a plain
-- field edit.

create or replace function public.log_finance_payment_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid  := auth.uid();
  v_event   text;
  v_payload jsonb := '{}'::jsonb;
begin
  if (tg_op = 'INSERT') then
    v_event := 'request_submitted';
    -- Which target was chosen, and against what. Identifiers and numbers only —
    -- no amount, no proof, nothing the payment row does not already carry.
    v_payload := jsonb_build_object('payment_target_type', new.payment_target_type);
    if (new.order_request_id is not null) then
      v_payload := v_payload || jsonb_build_object(
        'order_request_id',     new.order_request_id,
        'order_request_number', new.order_request_number
      );
    end if;
    if (new.order_id is not null) then
      v_payload := v_payload || jsonb_build_object(
        'order_id',     new.order_id,
        'order_number', new.order_number
      );
    end if;

  -- Pre-approval target correction. Checked FIRST among the UPDATE branches so a
  -- two-column switch (Order Request -> Confirmed Order) reads as the single
  -- decision it was. Scoped to a row that was, and still is, in the submitter's
  -- hands, so it can never shadow an approval transition or an RPC linkage
  -- change (both of which act on approved_* rows).
  elsif (old.status in ('pending_approval', 'needs_clarification', 'rejected')
         and new.status in ('pending_approval', 'needs_clarification', 'rejected')
         and (new.payment_target_type is distinct from old.payment_target_type
              or new.order_request_id  is distinct from old.order_request_id
              or new.order_id          is distinct from old.order_id)) then
    v_event := 'target_changed';
    v_payload := jsonb_build_object(
      'from_target_type',         old.payment_target_type,
      'to_target_type',           new.payment_target_type,
      'from_order_request_id',     old.order_request_id,
      'from_order_request_number', old.order_request_number,
      'to_order_request_id',       new.order_request_id,
      'to_order_request_number',   new.order_request_number,
      'from_order_id',             old.order_id,
      'from_order_number',         old.order_number,
      'to_order_id',               new.order_id,
      'to_order_number',           new.order_number
    );
    -- A creator's edit can move the row back to pending_approval in the same
    -- statement. Recorded here rather than lost, since only one event is
    -- emitted per UPDATE.
    if (new.status is distinct from old.status) then
      v_payload := v_payload || jsonb_build_object(
        'from_status', old.status,
        'to_status',   new.status
      );
    end if;

  -- order_id transitions that uniquely prove a link action.
  elsif (new.status = 'approved_linked' and old.status = 'approved_linked'
         and new.order_id is distinct from old.order_id) then
    v_event := 'order_link_changed';
    v_payload := jsonb_build_object(
      'from_order_id',     old.order_id,
      'from_order_number', old.order_number,
      'to_order_id',       new.order_id,
      'to_order_number',   new.order_number
    );

  elsif (old.status = 'approved_unlinked' and new.status = 'approved_linked') then
    v_event := 'order_linked';
    v_payload := jsonb_build_object('order_id', new.order_id, 'order_number', new.order_number);
    -- Conversion transfer: the payment was parked on an Order Request and this
    -- same UPDATE moved it onto the Order created from that request.
    if (old.order_request_id is not null) then
      v_payload := v_payload || jsonb_build_object(
        'from_order_request_id',     old.order_request_id,
        'from_order_request_number', old.order_request_number
      );
    end if;

  elsif (old.status = 'approved_linked' and new.status = 'approved_unlinked') then
    v_event := 'order_unlinked';
    v_payload := jsonb_build_object('order_id', old.order_id, 'order_number', old.order_number);

  -- Order-request link transitions on an approved payment: the two linkage RPCs.
  elsif (new.order_request_id is distinct from old.order_request_id) then
    if (new.order_request_id is not null) then
      v_event := 'order_request_linked';
      v_payload := jsonb_build_object(
        'order_request_id',     new.order_request_id,
        'order_request_number', new.order_request_number
      );
      if (old.order_request_id is not null) then
        v_payload := v_payload || jsonb_build_object(
          'from_order_request_id',     old.order_request_id,
          'from_order_request_number', old.order_request_number
        );
      end if;
    else
      v_event := 'order_request_unlinked';
      v_payload := jsonb_build_object(
        'order_request_id',     old.order_request_id,
        'order_request_number', old.order_request_number
      );
    end if;

  -- Any other status change: record the transition, do not infer the UI action.
  elsif (new.status is distinct from old.status) then
    v_event := 'status_changed';
    v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
    if (new.admin_note is not null) then
      v_payload := v_payload || jsonb_build_object('note', new.admin_note);
    end if;

  else
    -- No status change, no order-link change, no request-link change: a plain
    -- field edit or updated_at-only touch. Nothing is recorded.
    return null;
  end if;

  insert into public.finance_payment_request_activity_log
    (payment_request_id, actor_id, event_type, payload)
  values (new.id, v_actor, v_event, v_payload);

  -- ── Request-side timeline, for the pre-approval half of the lifecycle ──────
  -- The Order Request has to show that a payment was associated with it FROM
  -- SUBMISSION, not only once Finance approved. Same payload convention the two
  -- linkage RPCs use (payment_id, request_number, amount, client_name), so one
  -- renderer covers both writers.
  if (v_event = 'request_submitted' and new.order_request_id is not null) then
    insert into public.order_request_activity
      (order_request_id, event_type, actor_id, details)
    values (
      new.order_request_id, 'payment_linked', v_actor,
      jsonb_build_object(
        'payment_id',     new.id,
        'request_number', new.request_number,
        'amount',         new.amount,
        'client_name',    new.client_name
      )
    );
  elsif (v_event = 'target_changed') then
    if (old.order_request_id is not null) then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, details)
      values (
        old.order_request_id, 'payment_unlinked', v_actor,
        jsonb_build_object(
          'payment_id',     new.id,
          'request_number', new.request_number,
          'amount',         new.amount,
          'reason',         'Payment target changed before approval'
        )
      );
    end if;
    if (new.order_request_id is not null) then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, details)
      values (
        new.order_request_id, 'payment_linked', v_actor,
        jsonb_build_object(
          'payment_id',     new.id,
          'request_number', new.request_number,
          'amount',         new.amount,
          'client_name',    new.client_name
        )
      );
    end if;
  end if;

  return null;  -- AFTER trigger; return value ignored.
end;
$$;

revoke execute on function public.log_finance_payment_request_activity()
  from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §5. Post-approval freeze — the new column joins the frozen set
-- ═════════════════════════════════════════════════════════════════════════════
-- Body is the deployed 20260700 §2 version (itself byte-identical to 20260699
-- §5) with `payment_target_type` added to the frozen column list. Without it a
-- non-admin's raw PATCH could re-classify an approved payment's origin, which is
-- precisely the provenance the conversion transfer relies on. §3 already
-- discards a client-supplied value on an approved row, so this is the second,
-- independent statement of the same rule.

create or replace function public.finance_payment_requests_guard_approved()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- Service-role / direct SQL, and admins, are exempt.
  if v_actor is null then
    return new;
  end if;

  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return new;
  end if;

  if old.status not in ('approved_unlinked', 'approved_linked') then
    return new;
  end if;

  if new.client_name        is distinct from old.client_name
     or new.amount             is distinct from old.amount
     or new.payment_date       is distinct from old.payment_date
     or new.payment_mode       is distinct from old.payment_mode
     or new.received_in        is distinct from old.received_in
     or new.proof_note         is distinct from old.proof_note
     or new.sales_note         is distinct from old.sales_note
     or new.payment_against    is distinct from old.payment_against
     or new.payment_target_type is distinct from old.payment_target_type
     or new.status             is distinct from old.status
     or new.order_id           is distinct from old.order_id
     or new.order_number       is distinct from old.order_number
     or new.submitted_by       is distinct from old.submitted_by
     or new.approved_by        is distinct from old.approved_by
     or new.approved_at        is distinct from old.approved_at
     or new.created_at         is distinct from old.created_at
     or new.admin_note         is distinct from old.admin_note
  then
    raise exception 'Payment % has been approved and can no longer be edited', old.request_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.finance_payment_requests_guard_approved()
  from public, anon, authenticated;

drop trigger if exists finance_payment_requests_guard_approved on public.finance_payment_requests;

create trigger finance_payment_requests_guard_approved
  before update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_approved();

-- ═════════════════════════════════════════════════════════════════════════════
-- §6. Approval — revalidate the Order Request, and KEEP the linkage
-- ═════════════════════════════════════════════════════════════════════════════
-- Body is the deployed 20260690 version with the request-target branch added.
-- Everything that migration guarantees is preserved: admin-only authorization,
-- the row lock, the pending_approval-only guard, idempotency against
-- double-clicks, and — critically — the rule that confirming receipt of a
-- new-order payment NEVER creates an Order or allocates a number.
--
-- ── Lock ordering ──
-- convert_order_request_to_order locks the ORDER REQUEST first and its payments
-- second. This function must therefore not lock the payment and then reach for
-- the request, or the two could deadlock. It reads the payment WITHOUT a lock
-- purely to discover which request (if any) it names, takes the request lock
-- first, then locks the payment, then re-reads and re-checks everything under
-- that lock. A payment whose linkage changed in the gap is refused rather than
-- approved against a request it no longer names.
--
-- ── What approval does to a request-linked payment ──
-- status -> 'approved_unlinked', order_id/order_number stay null, and
-- order_request_id/order_request_number are RETAINED. That is the operational
-- state the business means by "linked to an Order Request, financially approved,
-- not yet attached to a Confirmed Order because conversion has not happened".
-- The name 'approved_unlinked' predates the request linkage and describes the
-- ORDER linkage only; nothing here relies on the name.

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
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to approve a payment request'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
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
  update public.finance_payment_requests
     set status       = v_status,
         order_id     = v_order_id,
         order_number = v_number,
         approved_by  = v_actor,
         approved_at  = v_now,
         admin_note   = p_admin_note,
         updated_at   = v_now
   where id = p_request_id;

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
$$;

revoke execute on function public.approve_finance_payment_request(uuid, text) from public, anon, authenticated;
grant  execute on function public.approve_finance_payment_request(uuid, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- §7. Conversion — the approved-payment guard, and a sweep that only takes
--     money Finance has actually confirmed
-- ═════════════════════════════════════════════════════════════════════════════
-- Body is the deployed 20260703 §11 version (the newest definition of this
-- function; 20260704 and 20260705 do not redefine it) with three changes, all in
-- the payment half. CREATE OR REPLACE with the signature unchanged, so the live
-- ACL survives; the revoke/grant at the end re-asserts it.
--
--   (a) The automatic sweep is now scoped to APPROVED request-linked payments.
--       Before this migration only an approved payment could carry
--       order_request_id at all, so `where f.order_request_id = …` and
--       "approved" meant the same thing. §2 makes pre-approval linkage legal, so
--       the filter has to say what it always meant — otherwise a single pending
--       payment on the request would enter the lock set, fail the eligibility
--       recount, and make EVERY conversion of that request fail with
--       STALE_PAYMENTS.
--
--   (b) GUARD ONE — an Order Request cannot be converted with no approved
--       payment behind it. Evaluated under the held locks, before any Order
--       number is allocated and before any row is written, so a refused
--       conversion creates nothing, converts nothing, and advances no counter.
--
--   (c) GUARD TWO — an Order Request cannot be converted while a payment
--       attached to it is still awaiting a Finance decision. This is what makes
--       "the admin sees every payment before approving the request" a rule
--       rather than a hope, and it is also what keeps the approval path in §6
--       from ever meeting a converted request in practice. A REJECTED linked
--       payment does not block: that decision has been taken, and the payment
--       stays on the request as history without ever being transferred.
--
-- Untouched and deliberately so: admin authorization, the request lock, the
-- conversion-eligibility rechecks, deterministic payment lock ordering, the
-- all-or-nothing STALE_PAYMENTS revalidation, the 'running' status, the
-- provenance columns, the pure linkage transfer, the request close-out, the
-- order_activity_log row, and the returned jsonb shape.

create or replace function public.convert_order_request_to_order(
  p_order_request_id    uuid,
  p_payment_request_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor     uuid := auth.uid();
  v_req       public.order_requests%rowtype;
  v_number    text;
  v_order_id  uuid;
  v_now       timestamptz := now();
  v_manual    uuid[];
  v_ids       uuid[];
  v_count     integer;
  v_eligible  integer;
  v_undecided integer;
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

  -- 3. Normalize the manual selection: null array -> empty, null elements
  --    dropped, duplicates collapsed.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_manual
  from unnest(coalesce(p_payment_request_ids, '{}'::uuid[])) as t(x)
  where x is not null;

  -- 4. Lock the request row: serializes double-clicks, replays, two admins
  --    racing on the same request, and any concurrent
  --    link_finance_payment_to_order_request (it takes the request lock first
  --    too).
  --
  --    It does NOT serialize a concurrent payment SUBMISSION naming this
  --    request: finance_payment_requests_derive_target reads the request without
  --    a locking clause, because a locking read would be filtered to zero rows
  --    by the absent UPDATE policy on order_requests (see that function). A
  --    submission landing in the window between step 10b and this transaction's
  --    commit therefore leaves a pending payment on a converted request —
  --    harmless, and refused with a clear error by
  --    approve_finance_payment_request rather than silently unallocated.
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Recheck every Phase 2A conversion rule.
  if v_req.converted_order_id is not null or v_req.converted_at is not null then
    raise exception 'Order request % has already been converted', v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'Only a submitted order request can be converted (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 6. Build the lock set: the admin's manual selection UNION every APPROVED
  --    payment currently parked on this request, sorted so the lock acquisition
  --    below is deterministic (deadlock-free with any concurrent conversion
  --    locking an overlapping set). Pre-approval and rejected linked payments
  --    are excluded here — they are not received money and must not be swept
  --    into a Confirmed Order.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_ids
  from (
    select unnest(v_manual) as x
    union
    select f.id
    from public.finance_payment_requests f
    where f.order_request_id = p_order_request_id
      and f.status = 'approved_unlinked'
  ) as t
  where x is not null;

  if coalesce(array_length(v_ids, 1), 0) > 0 then
    -- 7. Lock every payment in ascending uuid order.
    perform 1
    from public.finance_payment_requests
    where id = any(v_ids)
    order by id
    for update;

    -- 8. Rebuild the link set UNDER the held locks: the manual selection plus
    --    the APPROVED payments STILL parked on this request. A payment unparked
    --    by a concurrent unlink between step 6 and the locks is thereby dropped
    --    (left locked but untouched) instead of being silently swept into the
    --    new Order against that admin's action.
    select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
      into v_ids
    from (
      select unnest(v_manual) as x
      union
      select f.id
      from public.finance_payment_requests f
      where f.id = any(v_ids)
        and f.order_request_id = p_order_request_id
        and f.status = 'approved_unlinked'
    ) as t
    where x is not null;
  end if;

  v_count := coalesce(array_length(v_ids, 1), 0);

  if v_count > 0 then
    -- 9. Revalidate AFTER the locks are held — never trust the list the client
    --    was shown. Eligible = approved_unlinked, no order, and either no
    --    request linkage or parked on THIS request.
    select count(*) into v_eligible
    from public.finance_payment_requests
    where id = any(v_ids)
      and status   = 'approved_unlinked'
      and order_id is null
      and (order_request_id is null or order_request_id = p_order_request_id);

    -- 10. All-or-nothing: one bad payment aborts the entire conversion, so no
    --     Order is created and the request stays submitted.
    if v_eligible <> v_count then
      raise exception 'STALE_PAYMENTS: one or more selected payment requests are no longer eligible for linking'
        using errcode = 'P0001';
    end if;
  end if;

  -- 10a. GUARD ONE — approving an Order Request means confirming that real money
  --      arrived against it. v_count is the fully revalidated transfer set and
  --      every member is 'approved_unlinked', so this counts financially
  --      approved payments and nothing else. Pending, needs-clarification and
  --      rejected payments were excluded in steps 6 and 8 and cannot reach here.
  if v_count = 0 then
    raise exception 'ORDER_REQUEST_NO_APPROVED_PAYMENT: At least one approved payment must be linked before this Order Request can be approved.'
      using errcode = 'P0001';
  end if;

  -- 10b. GUARD TWO — nothing attached to this request may still be awaiting a
  --      Finance decision. Those payments would not transfer (steps 6/8), so
  --      converting now would leave money the salesperson raised against this
  --      order stranded on a request that no longer accepts payments. The admin
  --      must approve or reject each one first. 'rejected' is a decision and
  --      does not block.
  --
  --      Not lockable as a set (the rows are not known in advance). The
  --      FOR UPDATE held since step 4 blocks a concurrent
  --      link_finance_payment_to_order_request, but NOT a concurrent submission
  --      (see the note on step 4). A pending payment that lands in that window
  --      is refused at approval time with ORDER_REQUEST_CONVERTED, which is an
  --      actionable error rather than a silent misclassification.
  select count(*) into v_undecided
  from public.finance_payment_requests
  where order_request_id = p_order_request_id
    and status in ('pending_approval', 'needs_clarification');

  if v_undecided > 0 then
    raise exception 'ORDER_REQUEST_PAYMENTS_UNDECIDED: % payment request(s) linked to % are still awaiting a finance decision. Approve or reject them before converting this Order Request.',
      v_undecided, v_req.request_number
      using errcode = 'P0001';
  end if;

  -- 11. The Order number is allocated by orders_assign_display_number
  --     (20260703000000) as part of the INSERT below, under a FOR UPDATE lock on
  --     the cycle row, and it advances only if this transaction commits. Both
  --     guards above run BEFORE this point, so a refused conversion consumes
  --     nothing.

  -- 12. Exactly one official Order, starting at 'running' (20260702000000).
  insert into public.orders (
    client_name, requested_by, assigned_to,
    confirm_date, due_date, total_value, total_product_value, lead_source, notes, created_by,
    status,
    source_order_request_id, source_request_number
  )
  values (
    v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.total_product_value,
    v_req.lead_source, v_req.notes, v_actor,
    'running',
    v_req.id, v_req.request_number
  )
  returning id, display_number into v_order_id, v_number;

  -- 13. Link every payment in the set to the Order just created, clearing any
  --     request parking in the same statement. Amount, dates, mode, proof,
  --     submitter, and prior activity rows are untouched — this is a pure
  --     linkage transfer, never a copy. payment_target_type is NOT in the SET
  --     list and is frozen for approved rows by
  --     finance_payment_requests_derive_target, so a transferred payment keeps
  --     recording that it was raised against an Order Request.
  update public.finance_payment_requests
     set status               = 'approved_linked',
         order_id             = v_order_id,
         order_number         = v_number,
         order_request_id     = null,
         order_request_number = null,
         updated_at           = v_now
   where id = any(v_ids);

  -- 14. Close out the request. Runs after linking so the request_converted
  --     activity row can record linked_payment_count from real state.
  update public.order_requests
     set status             = 'converted',
         converted_order_id = v_order_id,
         converted_at       = v_now,
         updated_at         = v_now
   where id = p_order_request_id;

  -- 15. Order-side provenance (no amounts or payment details in the payload).
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_request',
    jsonb_build_object(
      'order_request_id',     v_req.id,
      'request_number',       v_req.request_number,
      'linked_payment_count', v_count
    )
  );

  -- 16. Structured result — identifiers and counts only, no private payment data.
  return jsonb_build_object(
    'order_request_id',           v_req.id,
    'request_number',             v_req.request_number,
    'order_id',                   v_order_id,
    'order_display_number',       v_number,
    'converted_at',               v_now,
    'linked_payment_count',       v_count,
    'linked_payment_request_ids', to_jsonb(v_ids)
  );
end;
$function$;

revoke execute on function public.convert_order_request_to_order(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function public.convert_order_request_to_order(uuid, uuid[]) to authenticated;
