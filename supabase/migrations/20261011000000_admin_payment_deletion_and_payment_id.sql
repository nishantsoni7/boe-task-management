-- ═══════════════════════════════════════════════════════════════════════════
-- Finance usability, phase 3: Payment IDs, admin-only deletion of ANY payment,
-- and one atomic door for splitting an allocation across many targets
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
--
-- Numbered 111. Applies AFTER 20261009000000 (109, the split-payment-entry /
-- order-number-reservation migration) and 20261010000000 (110, the
-- module-reset and single-payment durable deletion claim protocol). Neither
-- file is edited: every change below is CREATE OR REPLACE / ALTER / new
-- object, so a raw SQL caller or the service role meets exactly the same
-- objects it always has, now doing slightly more.
--
-- ── WHAT THIS FILE DOES ───────────────────────────────────────────────────────
--
--   §1  PAYMENT ID. A short, immutable, human-readable identifier —
--       P-AA-0001 … P-AZ-9999, P-BA-0001 … — separate from the UUID primary
--       key, database-generated, concurrency-safe, never reused, backfilled
--       deterministically by created_at then id.
--
--   §2  THE DELETION CLAIM LEARNS A TOMBSTONE. finance_payment_deletion_claims
--       (110 §11) already outlives the payment it describes — that is the
--       whole point of the table. This section widens it to hold what a
--       permanent deletion record needs to say: the Payment ID (so a deleted
--       number is provably never reissued), the amount, the customer, the
--       reason, and the exact allocations that were released — without adding
--       a second table to say the same thing twice.
--
--   §3  ADMIN-ONLY, FOR EVERY STATUS. 110 §11 built the claim protocol for the
--       three unapproved statuses only, and let either an admin or the
--       submitter open one. The revised rule is narrower on WHO (admin only —
--       self-delete is withdrawn) and wider on WHAT (a Confirmed Payment may
--       now be deleted too, deliberately, as an exceptional action gated by a
--       reason and the typed Payment ID). Nothing about
--       finance_payment_requests_guard_approved_delete's protection for every
--       OTHER caller is weakened — see §3c.
--
--   §4  ONE ATOMIC SUBMISSION, MANY TARGETS. allocate_payment_to_target_internal
--       (109, restated from 918) already holds the capacity lock, the
--       duplicate rule and target eligibility for ONE target. This section
--       adds no new allocation rule — it adds the loop: one new door that
--       calls the existing implementation once per requested target, inside
--       one function invocation, so a bad target rolls the whole submission
--       back rather than leaving a partial split.
--
--   §5  THE TRUSTED CLASSIFICATION A PAGED LIST CAN FILTER ON. Zero / Partial /
--       Full Allocated, computed from the allocation ledger alone (never the
--       legacy direct-link fallback attributed_total already carries for a
--       different purpose) and exposed as a column on finance_received_payments
--       — a database predicate, because a state computed over one page of rows
--       in the browser would silently misclassify every row on the next page,
--       exactly the failure 20261004000000's own header warns against.
--
-- ── WHAT THIS FILE DOES NOT DO ────────────────────────────────────────────────
--
--   * It does not touch orders, order_submissions, order_requests, or any
--     table outside Finance's payment spine.
--   * It does not change finance.allocate's authorization. allocate_payment_to
--     _targets re-derives the same permission allocate_payment_to_target
--     already requires, once, before the loop — never a bypass.
--   * It does not weaken finance_payment_allocations_guard_delete,
--     finance_payment_requests_release_allocations, or any RLS policy.
--   * It does not reuse or restate request_number. Payment ID is a new,
--     independent, short-form identifier; request_number (PAY-REQ-YYYY-NNNN)
--     is untouched and remains exactly what it was.
--   * It creates no new table. The tombstone is the existing claim row, widened.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. What must already be here ────────────────────────────────────────────

do $$
begin
  if to_regclass('public.finance_payment_deletion_claims') is null then
    raise exception 'DEPENDENCY MISSING: 20261010000000 §11 must be applied before this migration';
  end if;
  if to_regprocedure('public.begin_finance_payment_deletion(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20261010000000 §11 (begin_finance_payment_deletion) must be applied first';
  end if;
  if to_regprocedure('public.allocate_payment_to_target_internal(uuid,uuid,uuid,numeric)') is null then
    raise exception 'DEPENDENCY MISSING: 20260919000000 / 20261009000000 (allocate_payment_to_target_internal) must be applied first';
  end if;
  if to_regclass('public.finance_received_payments') is null then
    raise exception 'DEPENDENCY MISSING: 20261008000000 (finance_received_payments) must be applied first';
  end if;
  if to_regprocedure('public.in_test_data_cleanup()') is null then
    raise exception 'DEPENDENCY MISSING: 20260705000000 must be applied first';
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- §1. Payment ID — P-AA-0001, immutable, concurrency-safe, never reused
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ONE MONOTONIC COUNTER, not the per-year counter table request_number uses.
-- A Postgres SEQUENCE is the concurrency primitive already trusted everywhere
-- else in this schema for an ever-increasing number no two callers can share:
-- nextval() is atomic across sessions without a row lock, and — the property
-- that matters here — a value it hands out is never handed out again, even if
-- the transaction that called it rolls back. That second property is exactly
-- "never reused after deletion": the payment behind P-AA-0047 can be deleted,
-- but P-AA-0047 itself is never assigned to anything else, because nothing
-- ever asks the sequence to go backward.
--
-- FORMAT. Two base-26 letters (AA, AB, … AZ, BA, … ZZ) then four base-10
-- digits (0001-9999): 676 letter pairs × 9999 numbers = 6,758,324 payments
-- before capacity is exhausted, asserted defensively in the generator so a
-- capacity breach fails loudly instead of wrapping into a duplicate.

create sequence if not exists public.finance_payment_human_id_seq
  as bigint
  start with 1
  increment by 1
  no cycle;

revoke all on sequence public.finance_payment_human_id_seq from public, anon, authenticated;

create or replace function public.format_finance_payment_human_id(p_seq bigint)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
  v_group  bigint;
  v_first  int;
  v_second int;
  v_num    int;
begin
  if p_seq is null or p_seq < 1 then
    raise exception 'PAYMENT_ID_SEQUENCE_INVALID: % is not a valid Payment ID sequence value', p_seq
      using errcode = 'P0001';
  end if;

  v_group  := (p_seq - 1) / 9999;
  v_num    := ((p_seq - 1) % 9999)::int + 1;

  if v_group > (26 * 26 - 1) then
    raise exception
      'PAYMENT_ID_CAPACITY_EXCEEDED: the P-AA-0001 numbering space (676 letter pairs) is exhausted'
      using errcode = 'P0001';
  end if;

  v_first  := (v_group / 26)::int;
  v_second := (v_group % 26)::int;

  return 'P-' || chr(65 + v_first) || chr(65 + v_second) || '-' || lpad(v_num::text, 4, '0');
end;
$$;

revoke execute on function public.format_finance_payment_human_id(bigint) from public, anon;
grant  execute on function public.format_finance_payment_human_id(bigint) to authenticated;

comment on function public.format_finance_payment_human_id(bigint) is
  'Formats a nextval() draw from finance_payment_human_id_seq as P-AA-0001. Pure and immutable: the same sequence value always formats to the same string, so a value can be re-derived from an audit row for verification.';

-- ── 1a. The column ───────────────────────────────────────────────────────────

alter table public.finance_payment_requests
  add column if not exists human_payment_id text;

comment on column public.finance_payment_requests.human_payment_id is
  'The Payment ID shown to users: P-AA-0001 style, database-generated, immutable once assigned, never reused. The UUID primary key (id) remains the internal identifier; this is the only identifier the Finance UI should print.';

-- ── 1b. Backfill, deterministic, oldest first ────────────────────────────────
--
-- SAME IDIOM AS 20260673 §4: order by created_at then id so the chronological
-- order of existing records is preserved exactly, and the sequence — which
-- this migration owns exclusively up to this point, since no INSERT trigger
-- exists yet — hands out consecutive values with no gap and no race.

do $$
declare
  r record;
begin
  for r in
    select id
    from public.finance_payment_requests
    where human_payment_id is null
    order by created_at asc, id asc
  loop
    update public.finance_payment_requests
       set human_payment_id = public.format_finance_payment_human_id(
             nextval('public.finance_payment_human_id_seq'))
     where id = r.id;
  end loop;
end $$;

-- ── 1c. Assign on insert — always overwrites, so a client can never seed one ─

create or replace function public.assign_finance_payment_human_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.human_payment_id := public.format_finance_payment_human_id(
    nextval('public.finance_payment_human_id_seq'));
  return new;
end;
$$;

revoke execute on function public.assign_finance_payment_human_id() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_assign_human_id on public.finance_payment_requests;

create trigger finance_payment_requests_assign_human_id
  before insert on public.finance_payment_requests
  for each row execute function public.assign_finance_payment_human_id();

-- ── 1d. Immutability — every role, including admin ───────────────────────────

create or replace function public.prevent_finance_payment_human_id_change()
returns trigger
language plpgsql
as $$
begin
  if old.human_payment_id is not null and new.human_payment_id is distinct from old.human_payment_id then
    raise exception 'PAYMENT_ID_IMMUTABLE: human_payment_id cannot be changed once assigned'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.prevent_finance_payment_human_id_change() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_protect_human_id on public.finance_payment_requests;

create trigger finance_payment_requests_protect_human_id
  before update on public.finance_payment_requests
  for each row execute function public.prevent_finance_payment_human_id_change();

-- ── 1e. Uniqueness + NOT NULL ─────────────────────────────────────────────────

create unique index if not exists finance_payment_requests_human_id_uidx
  on public.finance_payment_requests (human_payment_id)
  where human_payment_id is not null;

do $$
begin
  if exists (select 1 from public.finance_payment_requests where human_payment_id is null) then
    raise exception 'PAYMENT_ID_BACKFILL_INCOMPLETE: every payment must carry a Payment ID before this column is required';
  end if;
end $$;

alter table public.finance_payment_requests
  alter column human_payment_id set not null;


-- ═══════════════════════════════════════════════════════════════════════════
-- §2. The deletion claim becomes the tombstone
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WIDENED, NOT DUPLICATED. finance_payment_deletion_claims (110 §11) already
-- has no foreign key to the payment it describes, on purpose, so it already
-- outlives the row. What it does not yet hold is enough to answer "what did
-- we delete, why, and what did it release" without going back to a payment
-- that no longer exists. These columns are that answer.

alter table public.finance_payment_deletion_claims
  add column if not exists human_payment_id  text,
  add column if not exists amount            numeric,
  add column if not exists customer_name     text,
  add column if not exists deletion_reason   text        not null default '',
  -- Snapshot of EVERY allocation row (active and reversed) the payment carried
  -- at claim time, taken before finalize releases them with the payment —
  -- {id, target_type: 'order'|'order_submission', target_id, amount, status}.
  -- This is what makes "released PI Draft allocations" and "released Order
  -- allocations" answerable from the tombstone alone, forever.
  add column if not exists allocation_details jsonb      not null default '[]'::jsonb;

comment on column public.finance_payment_deletion_claims.human_payment_id is
  'The Payment ID this claim froze, captured at claim time so the number is provably retired rather than merely absent from the (now-deleted) payment row.';
comment on column public.finance_payment_deletion_claims.amount is
  'The payment amount at the moment of deletion, for the permanent tombstone.';
comment on column public.finance_payment_deletion_claims.customer_name is
  'The client_name at the moment of deletion, for the permanent tombstone.';
comment on column public.finance_payment_deletion_claims.deletion_reason is
  'Why an admin deleted this payment. Required at begin_finance_payment_deletion time; never blank on a claim that reached "frozen".';
comment on column public.finance_payment_deletion_claims.allocation_details is
  'Every allocation (active and reversed) this payment carried at claim time, snapshotted before finalize releases them. The permanent record of exactly what was released and to what.';

-- Every status, not the unapproved three. A Confirmed Payment may now be
-- deleted by an admin, deliberately (see §3), so the claim must be able to
-- freeze one.
alter table public.finance_payment_deletion_claims
  drop constraint if exists finance_payment_deletion_claims_status_unapproved;
alter table public.finance_payment_deletion_claims
  drop constraint if exists finance_payment_deletion_claims_status_known;
alter table public.finance_payment_deletion_claims
  add constraint finance_payment_deletion_claims_status_known
  check (payment_status in (
    'pending_approval', 'needs_clarification', 'rejected',
    'approved_unlinked', 'approved_linked'
  ));


-- ═══════════════════════════════════════════════════════════════════════════
-- §3. Admin-only deletion, extended to Confirmed Payments
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 3a. Who may delete a payment, restated: admin only, any status ──────────
--
-- SELF-DELETE IS WITHDRAWN. 110 §11c derived deletability from the same two
-- DELETE policies the table has always carried — admin, or the submitter of
-- an unapproved payment. The revised rule is "Only an active Admin may delete
-- payments through the UI", full stop, so the submitter branch is removed
-- here. This function is the ONLY place that decision lives; nothing else
-- needs to change for the withdrawal to take effect everywhere it is checked.

create or replace function public.finance_payment_deletable_by(
  p_payment_id uuid,
  p_actor_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.finance_payment_requests f
    join public.users u on u.id = p_actor_id
    where f.id = p_payment_id
      and u.role = 'admin'
      and u.is_active
      and coalesce(u.is_deleted, false) = false
  )
$$;

comment on function public.finance_payment_deletable_by(uuid, uuid) is
  'Admin-only, for a payment of any status. Self-delete by the submitter is withdrawn: deletion is an administrator action for every payment, unapproved or confirmed. Re-derived independently of RLS so the RPC does not depend on the caller''s policy set.';

-- ── 3b. The transaction-local marker that stands the approved-delete guard
--       down, for exactly the payment this finalizer is deleting ───────────
--
-- SAME IDIOM AS in_test_data_cleanup() / in_payment_allocation_release(): a
-- SET LOCAL-scoped setting, readable only through a narrow predicate function
-- with EXECUTE revoked from every client role, true only inside the one
-- transaction that has already passed every gate below. It cannot be set by
-- anything a browser sends.

create or replace function public.in_finance_payment_deletion_finalization(p_payment_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('boe.payment_deletion_finalize', true), '') = p_payment_id::text
$$;

revoke execute on function public.in_finance_payment_deletion_finalization(uuid)
  from public, anon, authenticated, service_role;

comment on function public.in_finance_payment_deletion_finalization(uuid) is
  'True only inside the transaction that finalize_finance_payment_deletion has authorized for THIS payment id. Read by finance_payment_requests_guard_approved_delete so an admin-authorized, claim-protected deletion of a Confirmed Payment can proceed while every other caller still meets PAYMENT_APPROVED_PERMANENT.';

-- ── 3c. The production guard, widened by exactly one exemption ──────────────
--
-- EVERYTHING ELSE ABOUT finance_payment_requests_guard_approved_delete IS
-- UNCHANGED: in_test_data_cleanup() still stands it down for a module reset,
-- and every other caller — direct SQL, the service role, any RPC that is not
-- this one finalizer — still meets PAYMENT_APPROVED_PERMANENT for a verified
-- payment, exactly as 20260705000000 and 20260700000000 wrote it.

create or replace function public.finance_payment_requests_guard_approved_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.in_test_data_cleanup() then
    return old;
  end if;

  if old.status in ('approved_unlinked', 'approved_linked')
     and public.in_finance_payment_deletion_finalization(old.id)
  then
    return old;
  end if;

  if old.status in ('approved_unlinked', 'approved_linked') then
    raise exception
      'PAYMENT_APPROVED_PERMANENT: Payment % has been approved and is permanent bank payment history',
      old.request_number
      using errcode = '42501';
  end if;

  return old;
end;
$$;

revoke execute on function public.finance_payment_requests_guard_approved_delete() from public, anon, authenticated;

comment on function public.finance_payment_requests_guard_approved_delete() is
  'Refuses to delete an approved payment for every caller EXCEPT an authorized module reset (in_test_data_cleanup) or the one finalize_finance_payment_deletion transaction that has already passed admin authorization, the durable claim, the reason gate and the typed-Payment-ID confirmation for THIS payment id (in_finance_payment_deletion_finalization). No other route, including direct SQL and the service role, can delete a Confirmed Payment.';

-- ── 3d. begin — authorize (admin, any status), require reason + typed
--       Payment ID, freeze, and write the manifest + tombstone snapshot ────
--
-- SIGNATURE CHANGES from 110 §11d: the old 1-argument form is dropped rather
-- than overloaded, so there is exactly one begin_finance_payment_deletion and
-- no ambiguity about which a caller reaches.

drop function if exists public.begin_finance_payment_deletion(uuid);

create or replace function public.begin_finance_payment_deletion(
  p_payment_id         uuid,
  p_reason             text,
  p_confirm_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_pay      public.finance_payment_requests%rowtype;
  v_claim    public.finance_payment_deletion_claims%rowtype;
  v_paths    text[];
  v_allocs   jsonb;
  v_alloc_ids uuid[];
begin
  if v_actor is null then
    raise exception 'PAYMENT_DELETION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  -- THE ROW IS LOCKED FIRST, exactly as 110 §11d did, so the status the
  -- authorization and the manifest both read cannot move under this call.
  select * into v_pay from public.finance_payment_requests
   where id = p_payment_id for update;
  if not found then
    raise exception 'PAYMENT_DELETION_NOT_FOUND: payment % not found', p_payment_id
      using errcode = 'P0002';
  end if;

  if not public.finance_payment_deletable_by(p_payment_id, v_actor) then
    raise exception 'PAYMENT_DELETION_DENIED: you may not delete this payment'
      using errcode = '42501';
  end if;

  -- RESUME RATHER THAN REFUSE, before re-validating the reason/confirmation —
  -- a second call finishing an interrupted first one is not a fresh request
  -- and must not be asked to retype anything the first call already recorded.
  select * into v_claim from public.finance_payment_deletion_claims
   where payment_id = p_payment_id and finalized_at is null and released_at is null
   for update;
  if found then
    return jsonb_build_object(
      'claim_token',     v_claim.claim_token,
      'storage_paths',   to_jsonb(v_claim.storage_paths),
      'storage_removed', to_jsonb(v_claim.storage_removed),
      'resumed',         true
    );
  end if;

  -- ── Gate: a reason ──
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'PAYMENT_DELETION_REASON_REQUIRED: enter why this payment is being deleted'
      using errcode = 'P0001';
  end if;

  -- ── Gate: the exact Payment ID, typed ──
  if coalesce(btrim(p_confirm_payment_id), '') <> v_pay.human_payment_id then
    raise exception 'PAYMENT_DELETION_ID_MISMATCH: type % exactly to confirm deletion', v_pay.human_payment_id
      using errcode = 'P0001';
  end if;

  -- The manifest, from the rows themselves — never from anything a browser
  -- sent. Every proof key this payment owns, whatever the payment's status.
  select coalesce(array_agg(a.storage_path order by a.storage_path), '{}')
    into v_paths
  from public.payment_proof_attachments a
  where a.payment_request_id = p_payment_id
    and a.storage_path is not null;

  -- The tombstone snapshot: every allocation this payment carries, active or
  -- reversed, taken before finalize releases them with the payment.
  select coalesce(array_agg(al.id order by al.id), '{}'),
         coalesce(jsonb_agg(jsonb_build_object(
           'id',          al.id,
           'target_type', case when al.order_id is not null then 'order' else 'order_submission' end,
           'target_id',   coalesce(al.order_id, al.order_submission_id),
           'amount',      al.allocated_amount,
           'status',      al.status
         ) order by al.created_at, al.id), '[]'::jsonb)
    into v_alloc_ids, v_allocs
  from public.finance_payment_allocations al
  where al.payment_request_id = p_payment_id;

  insert into public.finance_payment_deletion_claims
    (payment_id, payment_number, payment_status, storage_paths, allocation_ids,
     claimed_by, claimed_by_email,
     human_payment_id, amount, customer_name, deletion_reason, allocation_details)
  values
    (p_payment_id, v_pay.request_number, v_pay.status, v_paths, v_alloc_ids,
     v_actor, (select email from public.users where id = v_actor),
     v_pay.human_payment_id, v_pay.amount, v_pay.client_name, btrim(p_reason), v_allocs)
  returning * into v_claim;

  return jsonb_build_object(
    'claim_token',     v_claim.claim_token,
    'storage_paths',   to_jsonb(v_claim.storage_paths),
    'storage_removed', to_jsonb(v_claim.storage_removed),
    'resumed',         false
  );
end;
$$;

revoke execute on function public.begin_finance_payment_deletion(uuid, text, text) from public, anon;
grant  execute on function public.begin_finance_payment_deletion(uuid, text, text) to authenticated;

comment on function public.begin_finance_payment_deletion(uuid, text, text) is
  'Admin-only, for a payment of ANY status. Requires a non-blank reason and the exact Payment ID typed back, locks the payment, freezes verification/proof/allocation mutation, and writes a durable claim carrying the full deletion manifest plus a permanent tombstone snapshot (Payment ID, amount, customer, reason, every allocation). Refuses a non-admin, a blank reason, or a mismatched Payment ID before any freeze is taken. A standing claim is resumed rather than re-validated.';

-- ── 3e. finalize — stand the approved-delete guard down for THIS payment,
--       then delete ─────────────────────────────────────────────────────────

create or replace function public.finalize_finance_payment_deletion(
  p_payment_id  uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_claim  public.finance_payment_deletion_claims%rowtype;
  v_pay    public.finance_payment_requests%rowtype;
  v_allocs integer;
begin
  if v_actor is null then
    raise exception 'PAYMENT_DELETION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  select * into v_claim from public.finance_payment_deletion_claims
   where payment_id = p_payment_id and claim_token = p_claim_token
   for update;
  if not found then
    raise exception 'PAYMENT_DELETION_CLAIM_INVALID: this deletion claim is not current'
      using errcode = '55P03';
  end if;

  if v_claim.finalized_at is not null then
    return v_claim.result || jsonb_build_object('already_deleted', true);
  end if;
  if v_claim.released_at is not null then
    raise exception 'PAYMENT_DELETION_CLAIM_INVALID: this deletion claim was released'
      using errcode = '55P03';
  end if;

  select * into v_pay from public.finance_payment_requests
   where id = p_payment_id for update;
  if not found then
    update public.finance_payment_deletion_claims
       set finalized_at = now(),
           result = jsonb_build_object('allocations_released', 0, 'row_absent', true)
     where id = v_claim.id;
    return jsonb_build_object('allocations_released', 0, 'already_deleted', true);
  end if;

  if not public.finance_payment_deletable_by(p_payment_id, v_actor) then
    raise exception 'PAYMENT_DELETION_DENIED: you may not delete this payment'
      using errcode = '42501';
  end if;

  if not (v_claim.storage_paths <@ v_claim.storage_removed) then
    raise exception
      'PAYMENT_DELETION_PROOF_PENDING: % proof object(s) are still in storage',
      cardinality(v_claim.storage_paths) - cardinality(v_claim.storage_removed)
      using errcode = '55P03';
  end if;

  select count(*) into v_allocs
  from public.finance_payment_allocations where payment_request_id = p_payment_id;

  -- STAND THE APPROVED-DELETE GUARD DOWN, for this payment id, for the rest of
  -- this transaction only. Everything up to this line has already proved: an
  -- active admin, a standing claim taken with a reason and the typed Payment
  -- ID, and a fully-swept proof manifest. Nothing else in this transaction
  -- reads or writes this setting.
  perform set_config('boe.payment_deletion_finalize', p_payment_id::text, true);

  update public.finance_payment_deletion_claims
     set finalized_at = now(),
         result = jsonb_build_object('allocations_released', v_allocs)
   where id = v_claim.id;

  -- finance_payment_requests_guard_approved_delete now permits this exact row;
  -- finance_payment_requests_release_allocations still deletes the
  -- allocations inside this same statement.
  delete from public.finance_payment_requests where id = p_payment_id;

  return jsonb_build_object('allocations_released', v_allocs, 'already_deleted', false);
end;
$$;

revoke execute on function public.finalize_finance_payment_deletion(uuid, uuid) from public, anon;
grant  execute on function public.finalize_finance_payment_deletion(uuid, uuid) to authenticated;

comment on function public.finalize_finance_payment_deletion(uuid, uuid) is
  'Admin-only, idempotent. Deletes the payment named by a claim already frozen with a reason and a typed-Payment-ID confirmation, for a payment of ANY status — refuses while a proof object remains outstanding, releases every allocation atomically with the delete, and marks the claim (the permanent tombstone) finalized. Stands finance_payment_requests_guard_approved_delete down for exactly this payment id, for this transaction only.';


-- ═══════════════════════════════════════════════════════════════════════════
-- §4. Allocate one payment across many targets, in one atomic submission
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NO NEW ALLOCATION RULE. allocate_payment_to_target_internal already holds
-- the capacity lock, re-derives the unallocated balance UNDER that lock on
-- every call, refuses a duplicate active claim and checks target eligibility
-- and visibility — and because every call inside this function shares the
-- same transaction and the same row lock (acquired once by the first call and
-- held for the rest), calling it N times sequentially is exactly as safe as
-- calling it once: the balance each call sees already includes every row this
-- same submission has inserted so far. If any target fails, the exception
-- unwinds the whole function and every earlier INSERT in this call rolls back
-- with it — there is no partial split.

create or replace function public.allocate_payment_to_targets(
  p_payment_request_id uuid,
  p_targets            jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_item    jsonb;
  v_result  jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count   int;
begin
  if v_actor is null then
    raise exception 'Authentication required to allocate a payment' using errcode = '28000';
  end if;

  if not public.actor_has_module_permission('finance', 'allocate') then
    raise exception 'You do not have permission to allocate payments' using errcode = '42501';
  end if;

  if p_targets is null or jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) = 0 then
    raise exception
      'ALLOCATION_TARGETS_REQUIRED: at least one allocation target is required'
      using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_targets) > 20 then
    raise exception
      'ALLOCATION_TARGETS_TOO_MANY: at most 20 allocation targets are allowed in one submission'
      using errcode = 'P0001';
  end if;

  v_count := 0;
  for v_item in select value from jsonb_array_elements(p_targets)
  loop
    v_result := public.allocate_payment_to_target_internal(
      p_payment_request_id,
      nullif(v_item->>'order_submission_id', '')::uuid,
      nullif(v_item->>'order_id', '')::uuid,
      nullif(v_item->>'allocated_amount', '')::numeric
    );
    v_results := v_results || jsonb_build_array(v_result);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('allocations', v_results, 'count', v_count);
end;
$$;

revoke execute on function public.allocate_payment_to_targets(uuid, jsonb) from public, anon;
grant  execute on function public.allocate_payment_to_targets(uuid, jsonb) to authenticated;

comment on function public.allocate_payment_to_targets(uuid, jsonb) is
  'Allocates a payment across up to 20 PI Draft / Confirmed Order targets in one atomic submission. p_targets is a JSON array of {order_submission_id?, order_id?, allocated_amount}. Requires finance.allocate once, then calls the single allocation implementation (allocate_payment_to_target_internal) once per target inside this one transaction — a refusal on any target rolls the entire submission back, so a partial split is never committed. No allocation rule is duplicated: capacity, duplicate-target and visibility checks are exactly those the single-target door already enforces.';


-- ═══════════════════════════════════════════════════════════════════════════
-- §5. The trusted classification, as a database predicate
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDS ONE COLUMN AT THE END of finance_received_payments: confirmed_
-- allocation_status. NOT a restatement of allocation_state (20261004000000),
-- which is deliberately attribution-based (folds in the legacy direct-link
-- fallback so Orders' conservation law holds) — this column answers a
-- narrower, literal question: how does the ALLOCATION LEDGER ALONE compare to
-- the payment amount, which is exactly what "Zero / Partially / Fully
-- Allocated" means for this phase's Confirmed Payments filters. Every other
-- column, and every other expression, is copied verbatim from 20261008000000
-- so nothing already relied upon changes shape, position or meaning.
--
-- 'over' IS FLAGGED, NEVER ROUNDED INTO 'full'. The capacity trigger refuses a
-- NEW allocation that would exceed the payment, but legacy data predating that
-- trigger (or a future bypass) is not proven impossible — so an over-allocated
-- payment reads 'over' here rather than the falsely reassuring 'full', exactly
-- as allocation_state already treats it for the attributed figure.

create or replace view public.finance_received_payments
with (security_invoker = true) as
select
  b.id,
  b.request_number,
  b.client_name,
  b.amount,
  b.payment_date,
  b.payment_mode,
  b.received_in,
  b.proof_note,
  b.order_number,
  b.order_id,
  b.order_request_id,
  b.order_request_number,
  b.sales_note,
  b.status,
  b.payment_against,
  b.submitted_by,
  b.approved_by,
  b.admin_note,
  b.created_at,
  b.approved_at,

  b.submitted_by_name,
  b.approved_by_name,

  b.allocated_order_id,
  b.allocated_order_number,

  b.is_order_allocated,

  b.allocated_total,
  b.attributed_total,
  b.allocation_state,

  b.order_attributed_total,
  b.pi_attributed_total,
  b.order_allocated_total,
  b.pi_allocated_total,
  b.active_allocation_count,
  b.attribution_complete,
  b.available_balance,
  b.is_linked_to_order,
  b.is_linked_to_pi,
  b.is_available_to_allocate,

  -- ═══ NEW ═══════════════════════════════════════════════════════════════════
  --
  -- The Payment ID — never a raw UUID in the normal Finance interface.
  b.human_payment_id,

  -- ── The pure-ledger classification, per Requirement 1's exact definitions ──
  --
  -- Zero:    allocated_total = 0
  -- Partial: 0 < allocated_total < amount
  -- Full:    allocated_total = amount
  -- Over:    allocated_total > amount (flagged, never 'full' — Admin review)
  case
    when b.amount is null           then null
    when b.allocated_total <= 0     then 'zero'
    when b.allocated_total > b.amount then 'over'
    when b.allocated_total = b.amount then 'full'
    else 'partial'
  end as confirmed_allocation_status

from (
  select
    f.id,
    f.request_number,
    f.client_name,
    f.amount,
    f.payment_date,
    f.payment_mode,
    f.received_in,
    f.proof_note,
    f.order_number,
    f.order_id,
    f.order_request_id,
    f.order_request_number,
    f.sales_note,
    f.status,
    f.payment_against,
    f.submitted_by,
    f.approved_by,
    f.admin_note,
    f.created_at,
    f.approved_at,
    f.human_payment_id,

    eb.full_name as submitted_by_name,
    ab.full_name as approved_by_name,

    alloc.order_id       as allocated_order_id,
    alloc.display_number as allocated_order_number,

    (alloc.order_id is not null) as is_order_allocated,

    coalesce(totals.allocated_total, 0)       as allocated_total,
    coalesce(totals.order_allocated_total, 0) as order_allocated_total,
    coalesce(totals.pi_allocated_total, 0)    as pi_allocated_total,
    coalesce(totals.active_allocation_count, 0)::integer as active_allocation_count,

    case
      when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
      when f.order_id is not null                  then f.amount
      else 0
    end as attributed_total,

    case
      when f.amount is null then null
      when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
                 when f.order_id is not null                  then f.amount
                 else 0 end) = 0                     then 'unallocated'
      when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
                 when f.order_id is not null                  then f.amount
                 else 0 end) > f.amount              then 'over'
      when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
                 when f.order_id is not null                  then f.amount
                 else 0 end) = f.amount              then 'full'
      else 'partial'
    end as allocation_state,

    case
      when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.order_allocated_total, 0)
      when f.order_id is not null                  then f.amount
      else 0
    end as order_attributed_total,

    case
      when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.pi_allocated_total, 0)
      else 0
    end as pi_attributed_total,

    coalesce(
      coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
      or f.submitted_by = auth.uid(),
      false
    ) as attribution_complete,

    case
      when not coalesce(
             coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
             or f.submitted_by = auth.uid(),
             false
           ) then null::numeric
      when f.amount is null then null::numeric
      else greatest(f.amount - (
             case
               when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
               when f.order_id is not null                  then f.amount
               else 0
             end), 0)
    end as available_balance,

    (
      coalesce(f.status, '') <> 'rejected'
      and coalesce(
        case
          when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.order_allocated_total, 0)
          when f.order_id is not null                  then f.amount
          else 0
        end, 0) > 0
    ) as is_linked_to_order,

    (
      coalesce(f.status, '') <> 'rejected'
      and coalesce(case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.pi_allocated_total, 0) else 0 end, 0) > 0
    ) as is_linked_to_pi,

    (
      coalesce(f.status, '') <> 'rejected'
      and coalesce(
            coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
            or f.submitted_by = auth.uid(),
            false
          )
      and f.amount is not null
      and greatest(f.amount - (
            case
              when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
              when f.order_id is not null                  then f.amount
              else 0
            end), 0) > 0
    ) as is_available_to_allocate

  from public.finance_payment_requests f
  left join public.users eb on eb.id = f.submitted_by
  left join public.users ab on ab.id = f.approved_by
  left join lateral (
    select a.order_id, o.display_number
    from public.finance_payment_allocations a
    left join public.orders o on o.id = a.order_id
    where a.payment_request_id = f.id
      and a.status = 'active'
      and a.order_id is not null
    order by a.created_at, a.id
    limit 1
  ) alloc on true
  left join lateral (
    select
      sum(a.allocated_amount)                                              as allocated_total,
      sum(a.allocated_amount) filter (where a.order_id is not null)        as order_allocated_total,
      sum(a.allocated_amount) filter (where a.order_submission_id is not null)
                                                                           as pi_allocated_total,
      count(*)                                                             as active_allocation_count
    from public.finance_payment_allocations a
    where a.payment_request_id = f.id
      and a.status = 'active'
  ) totals on true
) b;

comment on view public.finance_received_payments is
  'Every payment row a caller may already read, the canonical attribution classification (20261008000000), the Payment ID, and confirmed_allocation_status — the PURE allocation-ledger classification (zero | partial | full | over) that Requirement 1''s Confirmed Payments filters read, deliberately distinct from allocation_state''s attribution-inclusive figure. SECURITY INVOKER, unchanged from every prior revision.';

revoke all privileges on public.finance_received_payments from public, anon, authenticated;
grant select on public.finance_received_payments to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §6. Apply-time assertions
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_opt  text;
  v_cols text[];
  v_tbl  text;
  v_n    int;
begin
  -- ── The view is still SECURITY INVOKER ──
  select coalesce(
           (select option_value from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'),
           'false')
    into v_opt
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'finance_received_payments';

  if v_opt is distinct from 'true' then
    raise exception
      'finance_received_payments must remain security_invoker=true (found "%")', v_opt;
  end if;

  select array_agg(a.attname::text order by a.attnum) into v_cols
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.finance_received_payments'::regclass
    and a.attnum > 0 and not a.attisdropped;

  if v_cols is null or not ('human_payment_id' = any (v_cols))
     or not ('confirmed_allocation_status' = any (v_cols))
  then
    raise exception 'finance_received_payments is missing human_payment_id or confirmed_allocation_status';
  end if;

  -- ── Every payment has exactly one Payment ID, and it is well-formed ──
  select count(*) into v_n
  from public.finance_payment_requests
  where human_payment_id is null
     or human_payment_id !~ '^P-[A-Z]{2}-[0-9]{4}$';
  if v_n > 0 then
    raise exception 'PAYMENT_ID_MALFORMED: % payment(s) have a missing or malformed human_payment_id', v_n;
  end if;

  select count(distinct human_payment_id) into v_n from public.finance_payment_requests;
  if v_n <> (select count(*) from public.finance_payment_requests) then
    raise exception 'PAYMENT_ID_NOT_UNIQUE: human_payment_id is not unique across finance_payment_requests';
  end if;

  -- ── The chronological order the backfill promises: oldest still owns the
  --    lowest sequence value ──
  if exists (
    select 1
    from (
      select id, human_payment_id, created_at,
             lag(human_payment_id) over (order by created_at, id) as prev_id
      from public.finance_payment_requests
    ) x
    where x.prev_id is not null and x.human_payment_id < x.prev_id
  ) then
    raise exception 'PAYMENT_ID_BACKFILL_ORDER: a later-created payment holds an earlier Payment ID';
  end if;

  -- ── The deletion protocol is admin-only for every status now ──
  if (select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'finance_payment_deletable_by')
     like '%submitted_by%'
  then
    raise exception 'finance_payment_deletable_by still grants self-delete; the revised rule is admin-only';
  end if;

  -- ── The production protections are still armed ──
  foreach v_tbl in array array[
    'finance_payment_requests_guard_approved_delete',
    'finance_payment_allocations_guard_delete',
    'finance_payment_requests_guard_deletion_claim',
    'payment_proof_attachments_guard_deletion_claim',
    'finance_payment_allocations_guard_deletion_claim'
  ] loop
    if not exists (select 1 from pg_trigger where tgname = v_tbl and tgenabled <> 'D') then
      raise exception 'production protection % is missing or disabled', v_tbl;
    end if;
  end loop;

  -- ── The claim still outlives the payment it describes ──
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_payment_deletion_claims'::regclass
      and contype = 'f'
      and confrelid = 'public.finance_payment_requests'::regclass
  ) then
    raise exception
      'finance_payment_deletion_claims must not reference the payment it describes; the claim (tombstone) outlives it';
  end if;

  -- ── The multi-target door exists and duplicates no rule ──
  if to_regprocedure('public.allocate_payment_to_targets(uuid,jsonb)') is null then
    raise exception 'allocate_payment_to_targets is missing';
  end if;
  if (select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'allocate_payment_to_targets')
     not like '%allocate_payment_to_target_internal%'
  then
    raise exception 'allocate_payment_to_targets must call allocate_payment_to_target_internal, not reimplement it';
  end if;
end $$;

-- ── What still has to happen outside this file ──────────────────────────────
--
--   1. Apply 20261009000000 and 20261010000000 first, in that order, if they
--      have not already been applied to the target database.
--   2. Apply this file.
--   3. Deploy the application. DeletePaymentModal now sends a reason and the
--      typed Payment ID; the previous 1-argument begin_finance_payment_deletion
--      is gone, so deploying the database first gives the OLD client a
--      function-signature error rather than a silently wrong call.
