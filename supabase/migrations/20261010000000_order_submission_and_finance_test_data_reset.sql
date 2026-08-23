-- ═══════════════════════════════════════════════════════════════════════════
-- CLEARING A MODULE, NOT A RECORD
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
--
-- APPLY ORDER — READ THIS FIRST. This file is numbered 110 and must be applied
-- AFTER 20261009000000 (the split-payment / Order-number-reservation migration,
-- which lives on claude/boe-order-finance-verify-ml0o9y and is itself still
-- unapplied). Nothing here DEPENDS on 109 — the deletion dependency graph is
-- identical with and without it, and this file is written to apply cleanly on
-- either schema — but 109 carries the lower number, and pushing 110 first would
-- leave 109 permanently out of order behind the last applied remote migration.
-- The two branches are stacked, not parallel: claude/boe-order-finance-verify
-- descends from this branch, so BOTH files end up in one tree. Push 109, then
-- 110. Nothing before 109 is edited: 107 and 108 are frozen by SHA-256 in
-- participantAndOrderTotalSecurity.test.ts and are untouched.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────
--
-- 20260706000000 built Test Data Cleanup around a CHAIN: one Order, or one
-- Order Request, or one payment, with everything that belongs to it. That is
-- the right shape for removing a finalized test transaction, and it stays.
--
-- It is the wrong shape for the thing the testers actually need. Orders, PI
-- Drafts, payments and allocations reference each other through eleven NO
-- ACTION foreign keys, so clearing a module one chain at a time means meeting
-- those keys one at a time, in an order nobody can derive from the screen — and
-- a standalone PI Draft, the most common piece of test debris, is not a chain
-- root at all. There is no root type for it, and it therefore had no route out.
--
-- So: two scopes over the SAME protocol.
--
--   finance_module        every test payment and everything that exists only to
--                         serve it. Orders and PI Drafts survive, and their
--                         payment figures return to zero because the rows those
--                         figures are computed from are gone.
--   order_finance_module  that, and then the Orders, the PI Drafts and the
--                         retired Order Requests, in foreign-key order.
--
-- ── WHAT IS DELIBERATELY REUSED RATHER THAN REBUILT ────────────────────────
--
-- Everything that already works: test_data_cleanup_settings (the enabled /
-- permanently-disabled switch is the feature flag, and there is no second one),
-- test_data_cleanup_claims (the durable reservation, widened here rather than
-- duplicated), test_data_cleanup_audit (the permanent record, which this
-- cleanup never deletes), in_test_data_cleanup() (the transaction-local marker
-- that stands the production guards down, and which no client can set), and
-- reset_confirmed_order_number_cycle() (already admin-only, already requires a
-- FINALIZED claim token, already refuses while any Order, any submitted or
-- approved PI, or any allocation survives).
--
-- A SECOND CLAIM TABLE WOULD HAVE BEEN THE EASIER WRITE AND THE WORSE DESIGN.
-- The number-cycle reset keys off test_data_cleanup_claims.claim_token; a
-- parallel table would have needed that function re-emitted to learn about it,
-- and then there would be two answers to "is a cleanup running".
--
-- ── WHAT IS NEW, AND WHY EACH PIECE HAD TO BE ──────────────────────────────
--
--   THE FILE IS NAMED FOR BOTH HALVES, and not for tidiness. Three suites —
--   submissionSchema, finalApprovalSchema and finalApprovalScope — guard the PI
--   submission tables against outside phases reshaping or writing them, and take
--   the filename as the declaration of which feature a migration belongs to.
--   This one genuinely reshapes order_submissions (§1) and deletes from it and
--   its three children (§9), so it says so rather than slipping past a check
--   whose whole job is to notice exactly that.
--
--   §1  order_submissions.is_test_data. 20260916000000 §11 deliberately did not
--       add it, and gave a good reason: an APPROVED PI inherits its
--       classification from the Order it produced, through a one-to-one
--       immutable link, and a second flag could only disagree with the first.
--       That reason holds and is preserved — the backfill below reads the Order
--       wherever there is one. It simply does not cover a PI Draft that never
--       became an Order, which has no Order to inherit from and is exactly what
--       a module reset is full of.
--
--   §3  THE CLEANUP LOCK. The existing freeze is BEFORE UPDATE on two tables.
--       It cannot stop a NEW payment, allocation, PI or correction request
--       appearing between the census and the finalization, and it says nothing
--       about the Finance tables at all. A census that can be overtaken is not
--       a census.
--
--   §4  THE PI-DELETION RACE, closed in the database. Traced writer by writer:
--       approve_order_submission() is already refused, because it UPDATEs the
--       PI row and meets 20260914000000's claim guard. allocate_payment_to_target()
--       is NOT: it reads the PI without FOR UPDATE and writes only the
--       allocation, so nothing fires. request_order_submission_correction() is
--       NOT: it locks the PI row but never reads deletion_claim_token. Two of
--       the three external writers could therefore create a blocker AFTER the
--       delete route's check and BEFORE its storage sweep — the window that
--       ends with a destroyed workbook and a surviving PI. Two sequential API
--       checks cannot close that. Two triggers can, and do.
--
-- ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
--
--   * It deletes nothing on the way in, and it does not enable anything. The
--     settings row is not written.
--   * It does not weaken one production protection. prevent_order_delete,
--     prevent_converted_order_request_delete,
--     finance_payment_requests_guard_approved_delete and
--     finance_payment_allocations_guard_delete all stay armed, and stand down
--     only for a transaction the finalizer below has already validated — the
--     same exemption they have had since 20260705000000.
--   * It does not restate a deployed function. The chain protocol is untouched:
--     a bulk claim fed to finalize_test_data_cleanup() fails closed on its own,
--     because resolve_test_data_cleanup_chain() refuses an unknown root type.
--     Asserted at the end of this file rather than assumed.
--   * It does not touch RLS on any business table, any grant to a client role,
--     any numbering sequence, or auth.users.
--   * It does not revive the Order Request workflow. Retirement (20261007000000)
--     is untouched; a retired request is only ever a DELETE target here.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. What must already be here ────────────────────────────────────────────

do $$
begin
  if to_regprocedure('public.begin_test_data_cleanup(text, uuid, text, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260916000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.in_test_data_cleanup()') is null then
    raise exception 'DEPENDENCY MISSING: 20260705000000 must be applied before this migration';
  end if;
  if to_regclass('public.finance_payment_allocations') is null then
    raise exception 'DEPENDENCY MISSING: 20260918000000 must be applied before this migration';
  end if;
  if to_regclass('public.order_submission_correction_requests') is null then
    raise exception 'DEPENDENCY MISSING: 20260930000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.reset_confirmed_order_number_cycle(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260926000000 must be applied before this migration';
  end if;
end $$;


-- ═══ 1. A PI Draft can say whether it is test data ══════════════════════════
--
-- THE COLUMN MEANS WHAT IT MEANS EVERYWHERE ELSE: not "somebody ticked this
-- record" but "this record was created while the system was in its testing
-- phase". stamp_test_data_flag() decides it at INSERT from the settings row and
-- ignores whatever the caller sent, exactly as it does for orders,
-- order_requests, finance_payment_requests and finance_payment_allocations.
-- Once the phase ends the trigger can only ever write false, and every PI from
-- go-live onwards is real and protected with nothing to remember.

alter table public.order_submissions
  add column if not exists is_test_data boolean not null default false;

comment on column public.order_submissions.is_test_data is
  'True only for PI submissions created during system testing. Set once at INSERT from test_data_cleanup_settings and immutable thereafter. An approved PI ALSO inherits its Order''s classification, and the two agree by construction — the backfill in 20261010000000 §1 read the Order wherever one existed.';

-- ── The backfill, and why it is written this way ────────────────────────────
--
-- Two passes, and the order matters.
--
--   1. Every PI that produced an Order takes THAT ORDER'S classification. This
--      is the inheritance 20260916000000 §11 described, made explicit rather
--      than recomputed on every read. Where an Order exists it is the authority
--      and this column never contradicts it.
--
--   2. Every remaining PI — a Draft that never became an Order — takes what
--      stamp_test_data_flag() WOULD have written had this column existed when
--      the row was inserted: the current phase. That is not a guess about the
--      individual record; it is the same fact the trigger reads, applied to
--      rows that predate the trigger. If cleanup is disabled or permanently
--      disabled, every one of them is false and nothing becomes deletable.
--
-- BOTH RUN BEFORE THE IMMUTABILITY TRIGGER IS ARMED, because afterwards no
-- statement in the system can write this column at all.

update public.order_submissions s
   set is_test_data = o.is_test_data
  from public.orders o
 where o.source_order_submission_id = s.id
   and s.is_test_data is distinct from o.is_test_data;

update public.order_submissions s
   set is_test_data = true
 where not exists (
         select 1 from public.orders o where o.source_order_submission_id = s.id)
   and coalesce(
         (select st.enabled and not st.permanently_disabled
            from public.test_data_cleanup_settings st where st.id = true),
         false)
   and s.is_test_data is distinct from true;

drop trigger if exists order_submissions_stamp_test_data on public.order_submissions;
create trigger order_submissions_stamp_test_data
  before insert on public.order_submissions
  for each row execute function public.stamp_test_data_flag();

drop trigger if exists order_submissions_protect_test_data on public.order_submissions;
create trigger order_submissions_protect_test_data
  before update on public.order_submissions
  for each row execute function public.prevent_test_data_flag_change();


-- ═══ 2. The claim learns about a scope ══════════════════════════════════════
--
-- ONE TABLE, TWO SHAPES. A CHAIN claim names a root record; a SCOPE claim names
-- a module. Exactly one of the two, enforced by a CHECK, so a row can never be
-- read as both and no function has to guess which it is holding.
--
-- The frozen census is not a summary for the screen — it is the DELETE LIST.
-- Finalization removes the ids recorded here and no others, so a row created
-- after the freeze is outside the scope by construction rather than by timing.

alter table public.test_data_cleanup_claims
  alter column root_id drop not null;

alter table public.test_data_cleanup_claims
  add column if not exists scope             text,
  add column if not exists census            jsonb       not null default '{}'::jsonb,
  add column if not exists targets           jsonb       not null default '{}'::jsonb,
  add column if not exists plan_hash         text,
  add column if not exists stage             text        not null default 'claimed',
  add column if not exists storage_manifest  jsonb       not null default '{}'::jsonb,
  add column if not exists failure           text,
  add column if not exists released_at       timestamptz;

do $$
begin
  -- The root_type allow-list gains the two scopes. Dropped and recreated rather
  -- than replaced in place: a CHECK cannot be altered, and re-adding it
  -- re-validates every existing row, which is the proof that nothing already
  -- stored falls outside the new list.
  alter table public.test_data_cleanup_claims
    drop constraint if exists test_data_cleanup_claims_root_type_known;
  alter table public.test_data_cleanup_claims
    add constraint test_data_cleanup_claims_root_type_known
    check (root_type in ('order', 'order_request', 'payment',
                         'finance_module', 'order_finance_module'));

  alter table public.test_data_cleanup_claims
    drop constraint if exists test_data_cleanup_claims_shape;
  alter table public.test_data_cleanup_claims
    add constraint test_data_cleanup_claims_shape
    check (
      (scope is null     and root_id is not null and root_type in ('order', 'order_request', 'payment'))
      or
      (scope is not null and root_id is null     and scope = root_type
       and scope in ('finance_module', 'order_finance_module'))
    );

  alter table public.test_data_cleanup_claims
    drop constraint if exists test_data_cleanup_claims_stage_known;
  alter table public.test_data_cleanup_claims
    add constraint test_data_cleanup_claims_stage_known
    check (stage in ('claimed', 'frozen', 'storage_removed', 'completed', 'released'));
end $$;

comment on column public.test_data_cleanup_claims.census is
  'The exact counts the admin was shown and confirmed. Re-taken and compared at finalization: a scope that has moved is refused, never silently widened.';
comment on column public.test_data_cleanup_claims.targets is
  'The frozen id lists this cleanup will delete, and nothing else. A row created after the freeze is outside the scope by construction.';
comment on column public.test_data_cleanup_claims.storage_manifest is
  'The exact object keys and id-derived prefixes this cleanup may remove, read from the database at claim time. A browser can neither supply nor enlarge it.';

-- ONE ACTIVE MODULE RESET AT A TIME, across both scopes and every admin. A
-- partial unique index on a constant: at most one row can satisfy the predicate,
-- so a second admin pressing the button meets a database refusal rather than a
-- disabled button.
create unique index if not exists test_data_cleanup_claims_open_scope_uidx
  on public.test_data_cleanup_claims ((true))
  where scope is not null and finalized_at is null and released_at is null;


-- ═══ 3. THE CLEANUP LOCK ════════════════════════════════════════════════════
--
-- WHY A TRIGGER ON EVERY TABLE AND NOT A CHECK IN EVERY WRITER. The writers are
-- record_pi_submission_payment, allocate_payment_to_target, the Finance entry
-- form's direct PostgREST insert, request_order_submission_correction,
-- resolve_order_submission_correction, replace_order_submission_parse, the four
-- submit_order_submission_* forms, approve_order_submission, the document
-- generation claim, payment verification and allocation reversal — plus, on the
-- other branch, record_payment_with_allocations. Restating twelve applied
-- functions to add one condition to each is twelve chances to drift, and it
-- still misses the service role and a raw UPDATE. A trigger on the table catches
-- every writer, including the ones that do not exist yet.
--
-- READS ARE NOT AFFECTED. Nothing here is a policy; every SELECT still works,
-- so the rest of the system stays legible while a reset runs.
--
-- UNRELATED MODULES ARE NOT TOUCHED. Payroll, attendance, tasks, assets,
-- showroom and access control carry no guard and cannot be blocked by one.

create or replace function public.open_order_finance_reset_scope()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.scope
  from public.test_data_cleanup_claims c
  where c.scope is not null
    and c.finalized_at is null
    and c.released_at is null
  limit 1
$$;

comment on function public.open_order_finance_reset_scope() is
  'The scope of the module reset currently in flight, or NULL. Read by the write guards and by the status RPC; never by a client directly.';

revoke execute on function public.open_order_finance_reset_scope()
  from public, anon, authenticated, service_role;

-- The guard itself. TG_ARGV[0] names which half of the graph this table belongs
-- to, so a Finance-only reset freezes Finance and leaves Orders and PI Drafts
-- fully writable — which is what "Orders and PI Drafts must remain" means in
-- practice for anyone working while the reset runs.
create or replace function public.order_finance_reset_write_guard()
returns trigger
language plpgsql
as $$
declare
  v_scope text;
  v_side  text := tg_argv[0];
begin
  -- The authorized cleanup transaction, which is the one write that is meant to
  -- happen while a reset is in flight.
  if public.in_test_data_cleanup() then
    return coalesce(new, old);
  end if;

  v_scope := public.open_order_finance_reset_scope();
  if v_scope is null then
    return coalesce(new, old);
  end if;

  if v_side = 'finance' or v_scope = 'order_finance_module' then
    -- 55P03 is lock_not_available: a retryable "busy", not a fault. The message
    -- is written for the person who just pressed Save, and names no id, no
    -- table and no admin.
    raise exception
      'ORDER_FINANCE_RESET_IN_PROGRESS: an administrator is clearing Order and Finance test data. Please try again in a few minutes.'
      using errcode = '55P03';
  end if;

  return coalesce(new, old);
end;
$$;

comment on function public.order_finance_reset_write_guard() is
  'Refuses a write to an Order or Finance table while a module reset holds the scope that covers it. Binds every caller including the service role and direct SQL, and stands down only inside the authorized cleanup transaction. Reads are unaffected.';

revoke execute on function public.order_finance_reset_write_guard()
  from public, anon, authenticated, service_role;

do $$
declare
  v_table text;
  v_side  text;
begin
  foreach v_table in array array[
    -- Finance: frozen by BOTH scopes.
    'finance_payment_requests',
    'finance_payment_allocations',
    'payment_proof_attachments',
    'finance_payment_request_activity_log'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      v_table || '_reset_write_guard', v_table);
    execute format(
      'create trigger %I before insert or update or delete on public.%I'
      || ' for each row execute function public.order_finance_reset_write_guard(%L)',
      v_table || '_reset_write_guard', v_table, 'finance');
  end loop;

  foreach v_table in array array[
    -- Orders and PI Drafts: frozen by the full scope only.
    'orders',
    'order_activity_log',
    'order_change_requests',
    'order_document_versions',
    'order_submissions',
    'order_submission_items',
    'order_submission_item_images',
    'order_submission_activity',
    'order_submission_correction_requests',
    'order_requests',
    'order_request_activity',
    'order_request_attachments'
  ] loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'CLEANUP LOCK INCOMPLETE: public.% does not exist', v_table;
    end if;
    execute format(
      'drop trigger if exists %I on public.%I',
      v_table || '_reset_write_guard', v_table);
    execute format(
      'create trigger %I before insert or update or delete on public.%I'
      || ' for each row execute function public.order_finance_reset_write_guard(%L)',
      v_table || '_reset_write_guard', v_table, 'orders');
  end loop;
end $$;


-- ═══ 4. The individual PI deletion race, closed ═════════════════════════════
--
-- 20260914000000 freezes a PI the moment a deletion claim is taken, and
-- /api/orders/submissions/delete establishes what still refers to the PI before
-- it reserves anything. Between that check and the storage sweep there is a
-- window, and the freeze does not cover all of it:
--
--   approve_order_submission()              CLOSED — it UPDATEs the PI row and
--                                           meets the existing claim guard
--   allocate_payment_to_target()            OPEN   — reads the PI without FOR
--                                           UPDATE, writes only the allocation
--   request_order_submission_correction()   OPEN   — locks the PI row but never
--                                           reads deletion_claim_token
--
-- Either open writer can create a blocker after the check and before the sweep,
-- and the sweep then destroys the workbook of a PI that can no longer be
-- finalized. These two triggers close it where every caller meets it.
--
-- THEY ARE NARROW ON PURPOSE. They refuse only an INSERT that NAMES a PI which
-- is at that moment reserved for deletion. Nothing else about either table
-- changes, and a PI with no claim behaves exactly as before.

create or replace function public.finance_payment_allocations_guard_pi_deletion()
returns trigger
language plpgsql
as $$
begin
  if public.in_test_data_cleanup() then
    return new;
  end if;
  if new.order_submission_id is not null and exists (
    select 1 from public.order_submissions s
    where s.id = new.order_submission_id
      and s.deletion_claim_token is not null
  ) then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is being deleted and cannot receive a payment allocation'
      using errcode = '55P03';
  end if;
  return new;
end;
$$;

revoke execute on function public.finance_payment_allocations_guard_pi_deletion()
  from public, anon, authenticated, service_role;

drop trigger if exists finance_payment_allocations_guard_pi_deletion
  on public.finance_payment_allocations;
create trigger finance_payment_allocations_guard_pi_deletion
  before insert on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_guard_pi_deletion();

create or replace function public.order_submission_corrections_guard_deletion()
returns trigger
language plpgsql
as $$
begin
  if public.in_test_data_cleanup() then
    return new;
  end if;
  if exists (
    select 1 from public.order_submissions s
    where s.id = new.submission_id
      and s.deletion_claim_token is not null
  ) then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is being deleted and cannot take a correction request'
      using errcode = '55P03';
  end if;
  return new;
end;
$$;

revoke execute on function public.order_submission_corrections_guard_deletion()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submission_corrections_guard_deletion
  on public.order_submission_correction_requests;
create trigger order_submission_corrections_guard_deletion
  before insert on public.order_submission_correction_requests
  for each row execute function public.order_submission_corrections_guard_deletion();


-- ═══ 5. The census, and the plan it produces ════════════════════════════════
--
-- ONE FUNCTION ANSWERS THE PREVIEW AND THE FREEZE, so the numbers on the screen
-- and the ids that get deleted cannot be produced by two pieces of code that
-- drift. The preview shows it; begin re-takes it and hashes it; finalize
-- re-takes it a third time and refuses if it moved.
--
-- EVERY ARRAY IS SORTED. The plan hash is only meaningful if the same database
-- state produces the same bytes, and array_agg without an ORDER BY does not
-- promise that.
--
-- BLOCKING IS NOT THE SAME AS RETAINED. A retained record is one the scope
-- simply does not cover — a real payment, a real Order — and it survives
-- quietly. A BLOCKING record is one that a foreign key will not let go of while
-- something in scope is deleted: a real payment allocated to a test PI, a real
-- Order whose source is a test PI. Those are refusals, because the alternative
-- is deleting a real financial record to make a test reset succeed.

create or replace function public.order_finance_test_reset_census(p_scope text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_full      boolean := (p_scope = 'order_finance_module');
  v_payments  uuid[];
  v_orders    uuid[];
  v_subs      uuid[];
  v_requests  uuid[];
  v_allocs    uuid[];
  v_proofs    text[];
  v_blocking  jsonb;
  v_targets   jsonb;
  v_counts    jsonb;
  v_storage   jsonb;
  v_bytes     bigint;
begin
  if p_scope not in ('finance_module', 'order_finance_module') then
    raise exception 'RESET_SCOPE_INVALID: % is not a cleanup scope', coalesce(p_scope, 'null')
      using errcode = 'P0001';
  end if;

  select coalesce(array_agg(f.id order by f.id), '{}')
    into v_payments
  from public.finance_payment_requests f where f.is_test_data;

  if v_full then
    select coalesce(array_agg(o.id order by o.id), '{}')
      into v_orders
    from public.orders o where o.is_test_data;

    select coalesce(array_agg(s.id order by s.id), '{}')
      into v_subs
    from public.order_submissions s where s.is_test_data;

    -- HISTORICAL ORDER REQUESTS. The workflow is retired (20261007000000) and
    -- stays retired; this only ever DELETES. A request is in scope when it is
    -- test data AND either it converted nothing, or the Order it converted is
    -- itself in this same cleanup — which is the "no surviving record refers to
    -- them" rule, evaluated here rather than trusted.
    select coalesce(array_agg(r.id order by r.id), '{}')
      into v_requests
    from public.order_requests r
    where r.is_test_data
      and (r.converted_order_id is null or r.converted_order_id = any (v_orders));
  else
    v_orders   := '{}';
    v_subs     := '{}';
    v_requests := '{}';
  end if;

  -- Allocations: those spending a payment in scope, and those naming a target in
  -- scope. The second half is what makes a full reset able to delete a PI at all.
  select coalesce(array_agg(a.id order by a.id), '{}')
    into v_allocs
  from public.finance_payment_allocations a
  where a.payment_request_id = any (v_payments)
     or (v_full and (a.order_id = any (v_orders) or a.order_submission_id = any (v_subs)));

  select coalesce(array_agg(p.storage_path order by p.storage_path), '{}')
    into v_proofs
  from public.payment_proof_attachments p
  where p.payment_request_id = any (v_payments);

  -- ── What a foreign key will not let go of ─────────────────────────────────
  select coalesce(jsonb_agg(x order by x->>'kind', x->>'label'), '[]'::jsonb)
    into v_blocking
  from (
    -- A REAL payment allocated to something this reset would delete. The
    -- allocation cannot be removed (it is financial history), and its NO ACTION
    -- foreign key therefore refuses the PI or the Order.
    select jsonb_build_object(
             'kind', 'real_payment_allocation',
             'label', f.request_number,
             'reason', 'a payment that is not test data is allocated to a record in this scope') as x
    from public.finance_payment_allocations a
    join public.finance_payment_requests f on f.id = a.payment_request_id
    where v_full
      and not f.is_test_data
      and (a.order_id = any (v_orders) or a.order_submission_id = any (v_subs))
    union all
    -- A REAL Confirmed Order whose source is a test PI, or a test request.
    select jsonb_build_object(
             'kind', 'real_order_provenance',
             'label', o.display_number,
             'reason', 'an Order that is not test data names a record in this scope as its source')
    from public.orders o
    where v_full
      and not o.is_test_data
      and (o.source_order_submission_id = any (v_subs)
        or o.source_order_request_id    = any (v_requests))
    union all
    -- A REAL payment still naming a retired request this reset would delete.
    select jsonb_build_object(
             'kind', 'real_payment_request_link',
             'label', f.request_number,
             'reason', 'a payment that is not test data still names an Order Request in this scope')
    from public.finance_payment_requests f
    where v_full
      and not f.is_test_data
      and f.order_request_id = any (v_requests)
  ) blockers;

  -- ── Storage, counted from the object table rather than guessed ────────────
  begin
    select count(*),
           coalesce(sum(nullif(o.metadata->>'size', '')::bigint), 0)
      into v_storage, v_bytes
    from storage.objects o
    where (o.bucket_id = 'payment-proofs' and o.name = any (v_proofs))
       or (v_full and o.bucket_id = 'order-files' and exists (
             select 1 from unnest(v_subs) sid
             where o.name like 'submissions/' || sid::text || '/%'))
       or (v_full and o.bucket_id = 'order-files' and exists (
             select 1 from unnest(v_orders) oid
             where o.name like 'orders/' || oid::text || '/%'))
       or (v_full and o.bucket_id = 'order-request-attachments' and exists (
             select 1 from unnest(v_requests) rid
             where o.name like rid::text || '/%'));
  exception when others then
    -- A preview that cannot count objects is still a truthful preview; it must
    -- not become a failure, and it must not report zero as if it had looked.
    v_storage := null;
    v_bytes   := null;
  end;

  v_targets := jsonb_build_object(
    'payments',     to_jsonb(v_payments),
    'allocations',  to_jsonb(v_allocs),
    'orders',       to_jsonb(v_orders),
    'submissions',  to_jsonb(v_subs),
    'order_requests', to_jsonb(v_requests),
    'payment_proofs', to_jsonb(v_proofs)
  );

  v_counts := jsonb_build_object(
    'payments',            coalesce(array_length(v_payments, 1), 0),
    'payment_allocations', coalesce(array_length(v_allocs, 1), 0),
    'payment_proofs',      coalesce(array_length(v_proofs, 1), 0),
    'payment_activity',    (select count(*) from public.finance_payment_request_activity_log l
                             where l.payment_request_id = any (v_payments)),
    'orders',              coalesce(array_length(v_orders, 1), 0),
    'order_activity',      (select count(*) from public.order_activity_log l
                             where l.order_id = any (v_orders)),
    'order_change_requests', (select count(*) from public.order_change_requests c
                               where c.order_id = any (v_orders)),
    'order_documents',     (select count(*) from public.order_document_versions d
                             where d.order_id = any (v_orders)),
    'order_submissions',   coalesce(array_length(v_subs, 1), 0),
    'order_submission_items', (select count(*) from public.order_submission_items i
                                where i.submission_id = any (v_subs)),
    'order_submission_item_images', (select count(*) from public.order_submission_item_images i
                                      where i.submission_id = any (v_subs)),
    'order_submission_activity', (select count(*) from public.order_submission_activity e
                                   where e.submission_id = any (v_subs)),
    'correction_requests', (select count(*) from public.order_submission_correction_requests c
                             where c.submission_id = any (v_subs)),
    'order_requests',      coalesce(array_length(v_requests, 1), 0),
    'order_request_attachments', (select count(*) from public.order_request_attachments a
                                   where a.order_request_id = any (v_requests)),
    'order_request_activity', (select count(*) from public.order_request_activity a
                                where a.order_request_id = any (v_requests)),
    'notifications',       (select count(*) from public.notifications n
                             where n.entity_id = any (v_payments || v_orders || v_requests)
                               and (n.type::text like 'order%' or n.type::text like 'finance%')),
    'storage_objects',     v_storage,
    'storage_bytes',       v_bytes
  );

  return jsonb_build_object(
    'scope',    p_scope,
    'counts',   v_counts,
    'targets',  v_targets,
    'blocking', v_blocking,
    -- Named so an admin can see that a real record survives on purpose.
    'retained', jsonb_build_object(
      'payments',          (select count(*) from public.finance_payment_requests f where not f.is_test_data),
      'orders',            (select count(*) from public.orders o where not o.is_test_data),
      'order_submissions', (select count(*) from public.order_submissions s where not s.is_test_data)
    ),
    -- The plan the admin confirms. It covers the scope, every id and every
    -- count, so a scope that grows by one row between the preview and the press
    -- produces a different hash and is refused rather than executed.
    'plan_hash', md5(p_scope || '|' || v_targets::text || '|' || v_counts::text)
  );
end;
$$;

comment on function public.order_finance_test_reset_census(text) is
  'The exact scope of one module reset: the ids it would delete, the counts behind them, what a foreign key would refuse, what survives, and a hash of all of it. Reads only. Taken three times — for the preview, for the freeze and for the final re-check — so a scope that moves is refused rather than silently widened.';

revoke execute on function public.order_finance_test_reset_census(text)
  from public, anon, authenticated, service_role;

-- The admin-facing wrapper. Separated from the census itself so the gates live
-- in one place and the census stays a pure reading.
create or replace function public.preview_order_finance_test_reset(p_scope text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_set   public.test_data_cleanup_settings%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
      and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'RESET_FORBIDDEN: Only an active admin may preview a module reset'
      using errcode = '42501';
  end if;

  select * into v_set from public.test_data_cleanup_settings where id = true;
  if not found or v_set.permanently_disabled or not v_set.enabled then
    raise exception
      'CLEANUP_DISABLED: Test Data Cleanup has been permanently disabled. Order and Finance records cannot be cleared.'
      using errcode = '42501';
  end if;

  return public.order_finance_test_reset_census(p_scope);
end;
$$;

comment on function public.preview_order_finance_test_reset(text) is
  'Admin-only, read-only. The counts an administrator is shown before confirming a module reset, with the plan hash that binds them to what will actually be deleted.';

revoke all     on function public.preview_order_finance_test_reset(text) from public, anon;
grant  execute on function public.preview_order_finance_test_reset(text) to authenticated;


-- ═══ 6. begin — every gate, then the freeze ═════════════════════════════════
--
-- NOTHING IS DESTROYED HERE. This proves the caller may do it, proves the scope
-- is what they were shown, writes the permanent audit, and takes the claim that
-- freezes the module. If any gate refuses, no claim exists and no object has
-- been touched.
--
-- THE CONFIRMATION PHRASE IS CHECKED HERE, in the database, because a phrase
-- checked only in the browser is not a gate — it is a label.

create or replace function public.begin_order_finance_test_reset(
  p_scope        text,
  p_reason       text,
  p_confirmation text,
  p_plan_hash    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_email    text;
  v_set      public.test_data_cleanup_settings%rowtype;
  v_existing public.test_data_cleanup_claims%rowtype;
  v_census   jsonb;
  v_phrase   text;
  v_audit    uuid;
  v_token    uuid;
begin
  -- ── Gate 1: an active admin ──
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select u.email into v_email
  from public.users u
  where u.id = v_actor and u.role = 'admin'
    and u.is_active and coalesce(u.is_deleted, false) = false;
  if v_email is null then
    raise exception 'RESET_FORBIDDEN: Only an active admin may clear Order and Finance test data'
      using errcode = '42501';
  end if;

  -- ── Gate 2: enabled, and locked so a concurrent permanent-disable cannot
  --    slip past between the check and the claim ──
  select * into v_set from public.test_data_cleanup_settings where id = true for update;
  if not found or v_set.permanently_disabled or not v_set.enabled then
    raise exception
      'CLEANUP_DISABLED: Test Data Cleanup has been permanently disabled. Order and Finance records cannot be cleared.'
      using errcode = '42501';
  end if;

  -- ── Gate 3: a known scope ──
  if p_scope not in ('finance_module', 'order_finance_module') then
    raise exception 'RESET_SCOPE_INVALID: % is not a cleanup scope', coalesce(p_scope, 'null')
      using errcode = 'P0001';
  end if;

  -- ── Gate 4: a reason ──
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'CLEANUP_REASON_REQUIRED: Enter why this test data is being removed'
      using errcode = 'P0001';
  end if;

  -- ── Gate 5: the exact words, and they differ per scope on purpose ──
  v_phrase := case p_scope
    when 'finance_module'       then 'DELETE FINANCE TEST DATA'
    else                             'DELETE ALL ORDER AND FINANCE TEST DATA'
  end;
  if coalesce(btrim(p_confirmation), '') <> v_phrase then
    raise exception 'CLEANUP_CONFIRMATION_INVALID: Type % exactly to confirm', v_phrase
      using errcode = 'P0001';
  end if;

  -- ── Resume, or refuse ──
  --
  -- An open claim is either THIS admin's interrupted attempt at THIS scope — in
  -- which case it is handed straight back, which is what makes the operation
  -- resumable — or somebody else's, which is a refusal. It is never taken over:
  -- an interrupted reset may already have removed files, and a second admin
  -- inheriting it silently is how two people destroy one module twice.
  select * into v_existing
  from public.test_data_cleanup_claims
  where scope is not null and finalized_at is null and released_at is null
  for update;

  if found then
    if v_existing.scope = p_scope and v_existing.claimed_by = v_actor then
      return jsonb_build_object(
        'claim_token', v_existing.claim_token,
        'scope',       v_existing.scope,
        'resumed',     true,
        'stage',       v_existing.stage,
        'census',      v_existing.census,
        'targets',     v_existing.targets,
        'storage_manifest', v_existing.storage_manifest,
        'audit_id',    v_existing.audit_id);
    end if;
    raise exception
      'RESET_CLAIMED_BY_OTHER: a module reset started by % at % is still in progress',
      coalesce(v_existing.claimed_by_email, 'another administrator'),
      to_char(v_existing.claimed_at, 'DD Mon HH24:MI')
      using errcode = '55P03';
  end if;

  -- ── Gate 6: the scope is the one the admin was shown ──
  v_census := public.order_finance_test_reset_census(p_scope);

  if jsonb_array_length(v_census->'blocking') > 0 then
    raise exception
      'RESET_BLOCKED: records that are not test data would have to be deleted: %',
      (select string_agg(coalesce(x->>'label', x->>'kind'), ', ')
         from jsonb_array_elements(v_census->'blocking') x)
      using errcode = '42501';
  end if;

  if coalesce(p_plan_hash, '') <> (v_census->>'plan_hash') then
    raise exception
      'RESET_PLAN_STALE: the records in scope have changed since the preview was taken. Review the new counts and confirm again.'
      using errcode = 'P0001';
  end if;

  -- ── The permanent audit, written BEFORE anything is frozen ────────────────
  --
  -- In test_data_cleanup_audit, which this cleanup never deletes — the audit of
  -- a deletion must not be one of the rows the deletion removes.
  insert into public.test_data_cleanup_audit (
    performed_by, performed_by_email, reason, confirmation,
    root_type, root_id, root_number, deleted_records, table_counts, storage_paths
  ) values (
    v_actor, v_email, p_reason, p_confirmation,
    p_scope, null, p_scope, v_census->'targets', v_census->'counts',
    v_census->'targets'->'payment_proofs'
  )
  returning id into v_audit;

  insert into public.test_data_cleanup_claims (
    root_type, root_id, root_number, scope,
    reason, confirmation, claimed_by, claimed_by_email,
    census, targets, plan_hash, stage, storage_manifest, audit_id
  ) values (
    p_scope, null, p_scope, p_scope,
    p_reason, p_confirmation, v_actor, v_email,
    v_census->'counts', v_census->'targets', v_census->>'plan_hash', 'frozen',
    jsonb_build_object(
      'payment_proofs', v_census->'targets'->'payment_proofs',
      'submissions',    v_census->'targets'->'submissions',
      'orders',         v_census->'targets'->'orders',
      'order_requests', v_census->'targets'->'order_requests'),
    v_audit
  )
  returning claim_token into v_token;

  return jsonb_build_object(
    'claim_token', v_token,
    'scope',       p_scope,
    'resumed',     false,
    'stage',       'frozen',
    'census',      v_census->'counts',
    'targets',     v_census->'targets',
    'storage_manifest', jsonb_build_object(
      'payment_proofs', v_census->'targets'->'payment_proofs',
      'submissions',    v_census->'targets'->'submissions',
      'orders',         v_census->'targets'->'orders',
      'order_requests', v_census->'targets'->'order_requests'),
    'audit_id',    v_audit);
end;
$$;

comment on function public.begin_order_finance_test_reset(text, text, text, text) is
  'Admin-only. Freezes one Order/Finance module scope for deletion and returns the exact ids and storage keys it owns. Destroys nothing: while the claim stands no caller — through any route, including the service role — may write to the tables the scope covers. Refuses a stale plan, a scope containing a record that is not test data, and a reset already running.';

revoke all     on function public.begin_order_finance_test_reset(text, text, text, text) from public, anon;
grant  execute on function public.begin_order_finance_test_reset(text, text, text, text) to authenticated;


-- ═══ 7. Where a reset has got to ════════════════════════════════════════════
--
-- THE TOKEN IS NOT IN HERE. An interrupted reset has to be legible when the
-- admin reopens the page — what it was, who started it, when, which stage it
-- reached and what went wrong — and none of that requires the capability to
-- finish it. The token is handed back only to the admin who owns the claim, by
-- begin, inside the server route.

create or replace function public.order_finance_test_reset_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_claim public.test_data_cleanup_claims%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
      and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'RESET_FORBIDDEN: Only an active admin may read cleanup state'
      using errcode = '42501';
  end if;

  select * into v_claim
  from public.test_data_cleanup_claims
  where scope is not null and finalized_at is null and released_at is null
  limit 1;

  if not found then
    return jsonb_build_object('active', false);
  end if;

  return jsonb_build_object(
    'active',       true,
    'scope',        v_claim.scope,
    'started_at',   v_claim.claimed_at,
    'started_by',   coalesce(v_claim.claimed_by_email, 'an administrator'),
    'mine',         v_claim.claimed_by = v_actor,
    'stage',        v_claim.stage,
    'failure',      v_claim.failure,
    'reason',       v_claim.reason,
    'census',       v_claim.census);
end;
$$;

comment on function public.order_finance_test_reset_status() is
  'Admin-only. What an interrupted module reset was, who started it, when, the last stage it completed and why it stopped. Never returns the claim token, the storage manifest or any id.';

revoke all     on function public.order_finance_test_reset_status() from public, anon;
grant  execute on function public.order_finance_test_reset_status() to authenticated;


-- ═══ 8. Two markers the route sets, and nothing else does ═══════════════════
--
-- The route is the only thing that knows whether the sweep finished, because the
-- sweep happens outside the database. It says so here, and finalization will not
-- move without it — which is the whole of "database finalization only after
-- storage cleanup is confirmed", expressed as a state the database holds rather
-- than a promise the caller makes.

create or replace function public.order_finance_test_reset_storage_done(
  p_claim_token uuid,
  p_removed     integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim public.test_data_cleanup_claims%rowtype;
begin
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin'
      and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'RESET_FORBIDDEN: Only an active admin may run a module reset'
      using errcode = '42501';
  end if;

  select * into v_claim from public.test_data_cleanup_claims
  where claim_token = p_claim_token and scope is not null for update;

  if not found then
    raise exception 'RESET_CLAIM_INVALID: this cleanup claim is not valid' using errcode = '42501';
  end if;
  if v_claim.finalized_at is not null then
    return jsonb_build_object('stage', 'completed');
  end if;

  update public.test_data_cleanup_claims
     set stage   = 'storage_removed',
         failure = null,
         result  = result || jsonb_build_object('storage_removed', p_removed)
   where id = v_claim.id;

  return jsonb_build_object('stage', 'storage_removed');
end;
$$;

revoke all     on function public.order_finance_test_reset_storage_done(uuid, integer) from public, anon;
grant  execute on function public.order_finance_test_reset_storage_done(uuid, integer) to authenticated;

create or replace function public.order_finance_test_reset_failed(
  p_claim_token uuid,
  p_failure     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin'
      and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'RESET_FORBIDDEN: Only an active admin may run a module reset'
      using errcode = '42501';
  end if;

  -- Bounded and stripped: this text is shown to an administrator on the page,
  -- so it must be a sentence rather than a Postgres error carrying a statement.
  update public.test_data_cleanup_claims
     set failure = left(coalesce(nullif(btrim(p_failure), ''), 'The reset did not complete.'), 400)
   where claim_token = p_claim_token
     and scope is not null
     and finalized_at is null
     and released_at is null;
end;
$$;

revoke all     on function public.order_finance_test_reset_failed(uuid, text) from public, anon;
grant  execute on function public.order_finance_test_reset_failed(uuid, text) to authenticated;


-- ═══ 9. finalize — erase exactly what was frozen ════════════════════════════
--
-- THE POINT OF NO RETURN, and it is reached only by presenting the claim that
-- froze the module, with the storage sweep already reported complete.
--
-- ONE TRANSACTION. A failure at any step rolls back every earlier step, so
-- there is no state in which the allocations are gone and the payments survive.
--
-- IT DELETES IDS, NOT PREDICATES. Every statement below is scoped to an array
-- read out of the claim. A payment created after the freeze is not in the array
-- and is not deleted — which is a stronger promise than the write lock alone,
-- and the reason both exist.
--
-- THE ORDER IS THE FOREIGN KEYS' ORDER, derived from pg_constraint and asserted
-- at the end of this file. Nothing is disabled, nothing is truncated, no
-- constraint is dropped and no cascade is relied on for anything that is not
-- counted first.

create or replace function public.finalize_order_finance_test_reset(p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_claim    public.test_data_cleanup_claims%rowtype;
  v_census   jsonb;
  v_full     boolean;
  v_payments uuid[];
  v_allocs   uuid[];
  v_orders   uuid[];
  v_subs     uuid[];
  v_requests uuid[];
  v_result   jsonb;
  n_notif    integer := 0;
  n_alloc    integer := 0;
  n_proof    integer := 0;
  n_pactv    integer := 0;
  n_pay      integer := 0;
  n_docs     integer := 0;
  n_ochg     integer := 0;
  n_oactv    integer := 0;
  n_corr     integer := 0;
  n_sactv    integer := 0;
  n_imgs     integer := 0;
  n_items    integer := 0;
  n_subs     integer := 0;
  n_ratt     integer := 0;
  n_ractv    integer := 0;
  n_reqs     integer := 0;
  n_ord      integer := 0;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
      and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'RESET_FORBIDDEN: Only an active admin may clear Order and Finance test data'
      using errcode = '42501';
  end if;

  select * into v_claim
  from public.test_data_cleanup_claims
  where claim_token = p_claim_token and scope is not null
  for update;

  if not found then
    raise exception 'RESET_CLAIM_INVALID: this cleanup claim is not valid' using errcode = '42501';
  end if;

  -- ── Already done: answer, do not act ──────────────────────────────────────
  if v_claim.finalized_at is not null then
    return v_claim.result || jsonb_build_object('already_finalized', true);
  end if;
  if v_claim.released_at is not null then
    raise exception 'RESET_CLAIM_RELEASED: this cleanup was given back and must be started again'
      using errcode = '42501';
  end if;

  -- ── The storage sweep must have been reported complete ────────────────────
  if v_claim.stage <> 'storage_removed' then
    raise exception
      'RESET_STORAGE_INCOMPLETE: the files have not been confirmed removed, so the records must not be deleted'
      using errcode = 'P0001';
  end if;

  v_full     := v_claim.scope = 'order_finance_module';
  v_payments := coalesce((select array_agg(x::uuid order by x::uuid)
                            from jsonb_array_elements_text(v_claim.targets->'payments') x), '{}');
  v_allocs   := coalesce((select array_agg(x::uuid order by x::uuid)
                            from jsonb_array_elements_text(v_claim.targets->'allocations') x), '{}');
  v_orders   := coalesce((select array_agg(x::uuid order by x::uuid)
                            from jsonb_array_elements_text(v_claim.targets->'orders') x), '{}');
  v_subs     := coalesce((select array_agg(x::uuid order by x::uuid)
                            from jsonb_array_elements_text(v_claim.targets->'submissions') x), '{}');
  v_requests := coalesce((select array_agg(x::uuid order by x::uuid)
                            from jsonb_array_elements_text(v_claim.targets->'order_requests') x), '{}');

  -- ── Re-take the census and refuse anything that moved ─────────────────────
  --
  -- The write lock has held since the freeze, so nothing should have changed.
  -- Checked anyway: "frozen" is a claim about triggers that have not been edited
  -- yet, and this is the last moment anything can be refused.
  v_census := public.order_finance_test_reset_census(v_claim.scope);

  if jsonb_array_length(v_census->'blocking') > 0 then
    raise exception
      'RESET_BLOCKED: records that are not test data would have to be deleted: %',
      (select string_agg(coalesce(x->>'label', x->>'kind'), ', ')
         from jsonb_array_elements(v_census->'blocking') x)
      using errcode = '42501';
  end if;

  if (v_census->>'plan_hash') is distinct from v_claim.plan_hash then
    raise exception
      'RESET_SCOPE_CHANGED: the records in scope are no longer the ones that were frozen'
      using errcode = '42501';
  end if;

  -- ── Lock every parent row this transaction will delete ────────────────────
  perform 1 from public.finance_payment_requests where id = any (v_payments) order by id for update;
  perform 1 from public.orders            where id = any (v_orders)   order by id for update;
  perform 1 from public.order_submissions where id = any (v_subs)     order by id for update;
  perform 1 from public.order_requests    where id = any (v_requests) order by id for update;

  -- ── Stand the production guards down, for this transaction only ───────────
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);

  -- 1. Notifications. No foreign key, so nothing removes them implicitly, and
  --    the filter is deliberately narrow: an entity id this reset is deleting
  --    AND an Order or Finance notification type. A task notification that
  --    happens to carry the same id is not touched.
  delete from public.notifications
   where entity_id = any (v_payments || v_orders || v_requests)
     and (type::text like 'order%' or type::text like 'finance%');
  get diagnostics n_notif = row_count;

  -- 2. Allocations FIRST. Three NO ACTION foreign keys — to the payment, to the
  --    Order and to the PI — so nothing downstream can go while one survives.
  delete from public.finance_payment_allocations where id = any (v_allocs);
  get diagnostics n_alloc = row_count;

  -- 3. Payment children, deleted explicitly and counted rather than left to the
  --    cascades, so the result reports what happened.
  delete from public.payment_proof_attachments where payment_request_id = any (v_payments);
  get diagnostics n_proof = row_count;
  delete from public.finance_payment_request_activity_log where payment_request_id = any (v_payments);
  get diagnostics n_pactv = row_count;

  -- 4. The payments themselves.
  delete from public.finance_payment_requests where id = any (v_payments);
  get diagnostics n_pay = row_count;

  if v_full then
    -- 5. Order children. order_document_versions is NO ACTION by design
    --    (20260925000000) and must go explicitly.
    delete from public.order_document_versions where order_id = any (v_orders);
    get diagnostics n_docs = row_count;
    delete from public.order_change_requests where order_id = any (v_orders);
    get diagnostics n_ochg = row_count;
    delete from public.order_activity_log where order_id = any (v_orders);
    get diagnostics n_oactv = row_count;

    -- 6. PI children. Correction requests BEFORE activity: a resolved request
    --    names the activity row that answered it, with NO ACTION.
    delete from public.order_submission_correction_requests where submission_id = any (v_subs);
    get diagnostics n_corr = row_count;
    delete from public.order_submission_activity where submission_id = any (v_subs);
    get diagnostics n_sactv = row_count;
    delete from public.order_submission_item_images where submission_id = any (v_subs);
    get diagnostics n_imgs = row_count;
    delete from public.order_submission_items where submission_id = any (v_subs);
    get diagnostics n_items = row_count;

    -- 7. Retired Order Request children.
    delete from public.order_request_attachments where order_request_id = any (v_requests);
    get diagnostics n_ratt = row_count;
    delete from public.order_request_activity where order_request_id = any (v_requests);
    get diagnostics n_ractv = row_count;

    -- 8. Release both directions of the mutual provenance foreign keys, so each
    --    parent can go while the other still exists. Nothing else about these
    --    rows is written.
    update public.orders
       set source_order_submission_id = null,
           source_order_request_id    = null,
           source_request_number      = null
     where id = any (v_orders);

    update public.order_requests
       set converted_order_id = null
     where id = any (v_requests);

    -- 9. PI Drafts, then requests, then Orders. order_submissions.order_id and
    --    order_requests.converted_order_id both name public.orders with NO
    --    ACTION, so the Order is last.
    delete from public.order_submissions where id = any (v_subs);
    get diagnostics n_subs = row_count;
    delete from public.order_requests where id = any (v_requests);
    get diagnostics n_reqs = row_count;
    delete from public.orders where id = any (v_orders);
    get diagnostics n_ord = row_count;
  end if;

  perform set_config('boe.cleanup_context', '', true);

  v_result := jsonb_build_object(
    'scope',                        v_claim.scope,
    'notifications',                n_notif,
    'payment_allocations',          n_alloc,
    'payment_proofs',               n_proof,
    'payment_activity',             n_pactv,
    'payments',                     n_pay,
    'order_documents',              n_docs,
    'order_change_requests',        n_ochg,
    'order_activity',               n_oactv,
    'correction_requests',          n_corr,
    'order_submission_activity',    n_sactv,
    'order_submission_item_images', n_imgs,
    'order_submission_items',       n_items,
    'order_request_attachments',    n_ratt,
    'order_request_activity',       n_ractv,
    'order_submissions',            n_subs,
    'order_requests',               n_reqs,
    'orders',                       n_ord,
    'storage_removed',              coalesce(v_claim.result->>'storage_removed', '0')::integer);

  update public.test_data_cleanup_audit set result = v_result where id = v_claim.audit_id;

  -- The claim is kept, not deleted: it is the record that this scope was cleared
  -- under this token, it is what makes a repeated finalize answer instead of
  -- act, and reset_confirmed_order_number_cycle() reads it as the occasion for a
  -- numbering reset.
  update public.test_data_cleanup_claims
     set finalized_at = now(), stage = 'completed', failure = null, result = v_result
   where id = v_claim.id;

  return v_result || jsonb_build_object('already_finalized', false, 'audit_id', v_claim.audit_id);
end;
$$;

comment on function public.finalize_order_finance_test_reset(uuid) is
  'Admin-only. Deletes exactly the ids one module reset froze, in foreign-key order, in one transaction, on presentation of its claim and only once the storage sweep has been reported complete. Re-takes the census first and refuses a scope that has moved. Idempotent: a finalized claim answers with its recorded result.';

revoke all     on function public.finalize_order_finance_test_reset(uuid) from public, anon;
grant  execute on function public.finalize_order_finance_test_reset(uuid) to authenticated;


-- ═══ 10. release — give the module back, whole ══════════════════════════════
--
-- Called from the route's failure path, and only where it is provably safe: a
-- listing that failed before any remove request went out. It returns rather than
-- raises, because a release that threw would replace the real error with a
-- cleanup error and lose the reason the operation failed.

create or replace function public.release_order_finance_test_reset(p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim public.test_data_cleanup_claims%rowtype;
begin
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin'
      and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    return jsonb_build_object('released', false, 'reason', 'not_permitted');
  end if;

  select * into v_claim from public.test_data_cleanup_claims
  where claim_token = p_claim_token and scope is not null for update;

  if not found then
    return jsonb_build_object('released', false, 'reason', 'not_found');
  end if;
  if v_claim.finalized_at is not null then
    return jsonb_build_object('released', false, 'reason', 'already_finalized');
  end if;
  if v_claim.released_at is not null then
    return jsonb_build_object('released', true, 'reason', 'already_released');
  end if;

  -- A claim that has reached storage_removed has files behind it and must NOT be
  -- handed back: releasing there unfreezes a module whose objects are already
  -- gone. It stays, and one more attempt finishes it.
  if v_claim.stage = 'storage_removed' then
    return jsonb_build_object('released', false, 'reason', 'storage_already_removed');
  end if;

  update public.test_data_cleanup_claims
     set released_at = now(), stage = 'released'
   where id = v_claim.id;

  update public.test_data_cleanup_audit
     set result = jsonb_build_object('released', true, 'released_at', now())
   where id = v_claim.audit_id;

  return jsonb_build_object('released', true);
end;
$$;

comment on function public.release_order_finance_test_reset(uuid) is
  'Gives back a module reset that destroyed nothing, leaving every record and every object exactly as it was. Refuses once the storage sweep has been reported complete, because by then the files are gone and the freeze is what keeps the state recoverable. Returns rather than raises: it is called from a failure path.';

revoke all     on function public.release_order_finance_test_reset(uuid) from public, anon;
grant  execute on function public.release_order_finance_test_reset(uuid) to authenticated;


-- ═══ 11. Apply-time assertions ══════════════════════════════════════════════
--
-- The migration refuses ITSELF rather than shipping a partial facility. Every
-- assertion below is about something this file claims in prose above, checked
-- against the catalog it just wrote.

do $$
declare
  v_missing text;
  v_tbl     text;
  v_no_act  text[];
begin
  -- ── The classification landed, and is immutable ──
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.order_submissions'::regclass
      and attname = 'is_test_data' and not attisdropped and attnotnull
  ) then
    raise exception 'order_submissions.is_test_data must exist and be NOT NULL';
  end if;
  for v_missing in
    select t from unnest(array['order_submissions_stamp_test_data',
                              'order_submissions_protect_test_data']) t
    where not exists (
      select 1 from pg_trigger g
      where g.tgrelid = 'public.order_submissions'::regclass and g.tgname = t and g.tgenabled <> 'D')
  loop
    raise exception 'trigger % is missing or disabled on order_submissions', v_missing;
  end loop;

  -- ── The write lock covers every table the scopes name ──
  foreach v_tbl in array array[
    'finance_payment_requests', 'finance_payment_allocations',
    'payment_proof_attachments', 'finance_payment_request_activity_log',
    'orders', 'order_activity_log', 'order_change_requests', 'order_document_versions',
    'order_submissions', 'order_submission_items', 'order_submission_item_images',
    'order_submission_activity', 'order_submission_correction_requests',
    'order_requests', 'order_request_activity', 'order_request_attachments'
  ] loop
    if not exists (
      select 1 from pg_trigger g
      where g.tgrelid = ('public.' || v_tbl)::regclass
        and g.tgname = v_tbl || '_reset_write_guard'
        and g.tgenabled <> 'D'
    ) then
      raise exception 'the cleanup write lock is not armed on public.%', v_tbl;
    end if;
  end loop;

  -- ── The two race closers ──
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.finance_payment_allocations'::regclass
      and tgname = 'finance_payment_allocations_guard_pi_deletion' and tgenabled <> 'D')
  then
    raise exception 'an allocation could still be created against a PI being deleted';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.order_submission_correction_requests'::regclass
      and tgname = 'order_submission_corrections_guard_deletion' and tgenabled <> 'D')
  then
    raise exception 'a correction request could still be created against a PI being deleted';
  end if;

  -- ── THE DELETE ORDER IS THE CATALOG'S ──
  --
  -- Every NO ACTION foreign key into the four parents this file deletes, read
  -- from pg_constraint. If a later phase adds a fifth and does not teach the
  -- finalizer about it, the finalizer would meet a raw constraint error with
  -- the storage sweep already done — the exact failure mode 20261010000000
  -- exists to end. So the list is asserted here, at apply time.
  --
  -- 'a' is NO ACTION and 'r' is RESTRICT: the two rules that REFUSE a delete.
  -- 'c' (cascade) and 'n' (set null) resolve themselves and are deliberately
  -- absent — finance_payment_requests.order_id is SET NULL and blocks nothing.
  select coalesce(array_agg(entry order by entry), '{}') into v_no_act
  from (
    select n.nspname || '.' || cl.relname || '.' ||
           (select string_agg(a.attname, ',' order by k.ord)
              from unnest(c.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as entry
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where c.contype = 'f'
      and c.confdeltype in ('a', 'r')
      and c.confrelid in (
        'public.orders'::regclass, 'public.order_submissions'::regclass,
        'public.order_requests'::regclass, 'public.finance_payment_requests'::regclass)
  ) refs;

  if v_no_act <> array[
    'public.finance_payment_allocations.order_id',
    'public.finance_payment_allocations.order_submission_id',
    'public.finance_payment_allocations.payment_request_id',
    'public.finance_payment_requests.order_request_id',
    'public.order_document_versions.order_id',
    'public.order_requests.converted_order_id',
    'public.order_submission_correction_requests.submission_id',
    'public.order_submissions.order_id',
    'public.orders.source_order_request_id',
    'public.orders.source_order_submission_id'
  ] then
    raise exception
      'the NO ACTION references into the cleanup parents are not the ones the finalizer handles; found: %',
      array_to_string(v_no_act, ', ');
  end if;

  -- ── The chain protocol is untouched, and fails closed on a scope claim ──
  if to_regprocedure('public.finalize_test_data_cleanup(uuid)') is null then
    raise exception 'the chain finalizer must still exist; this file replaces nothing';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_test_data_cleanup_chain'
      and pg_get_functiondef(p.oid) like '%finance_module%')
  then
    raise exception 'chain resolution must know nothing about module scopes';
  end if;

  -- ── Nothing was enabled, and nothing was deleted, by this file ──
  if exists (
    select 1 from public.test_data_cleanup_claims where scope is not null)
  then
    raise exception 'a module reset claim already exists; this migration takes none';
  end if;

  -- ── The production protections are still armed ──
  foreach v_tbl in array array[
    'orders_prevent_delete',
    'order_requests_prevent_converted_delete',
    'finance_payment_requests_guard_approved_delete',
    'finance_payment_allocations_guard_delete'
  ] loop
    if not exists (select 1 from pg_trigger where tgname = v_tbl and tgenabled <> 'D') then
      raise exception 'production protection % is missing or disabled', v_tbl;
    end if;
  end loop;
end $$;

-- ── What still has to happen outside this file ──────────────────────────────
--
--   1. Apply 20261009000000 FIRST — see the header. It carries the lower number
--      and this one must not go in front of it.
--   2. Apply this file.
--   3. Deploy the application. The Control Center page calls the five RPCs
--      above; deploying it first gives an administrator a screen whose buttons
--      answer with "function does not exist".
--
-- Nothing here enables Test Data Cleanup, and nothing here clears a record. The
-- first module reset is an administrator's deliberate act on a deployed screen.
