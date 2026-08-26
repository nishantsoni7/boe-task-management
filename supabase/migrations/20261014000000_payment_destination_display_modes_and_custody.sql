-- ═══════════════════════════════════════════════════════════════════════════
-- The destination a payment SHOWS, the four current payment modes, and the
-- PNB/Paytm custody trail
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Three changes, one migration, because they meet in the same two forms.
--
--
-- ── A. THE CONFIRMED-ORDER DISPLAY DEFECT ───────────────────────────────────
--
-- WHAT WAS OBSERVED. A Payment Request naming a Confirmed Order, approved by
-- Finance, produced:
--
--     exactly one active allocation, the Order credited in full   ← correct
--     status  = approved_unlinked                                 ← wrong
--     badge   = "Order No. Pending"                                ← wrong
--     Order Number = blank                                         ← wrong
--     Payment Against = "New Order — no order created yet"          ← wrong
--
-- THE MONEY WAS NEVER WRONG. 20261012000000 made active finance_payment_allocations
-- the sole financial source and 20261013000000 gave approval the conversion that
-- creates them, so every figure — the Order's received total, the payment's
-- attributed and available balances, the 40% gate — was right. What was wrong was
-- the CLASSIFICATION shown beside those figures.
--
-- THE MECHANISM, precisely. finance_payment_requests.payment_target_type is
-- derived by finance_payment_requests_derive_target (20260715000000 §2) from the
-- payment row's own linkage columns:
--
--     order_id is not null          -> 'confirmed_order'
--     order_request_id is not null  -> 'order_request'
--     otherwise                     -> 'unallocated'
--
-- and payment_against follows it ('existing_order' / 'new_order').
-- submit_payment_request (20261013000000 §3) DELIBERATELY leaves order_id NULL
-- for every destination — those columns became provenance in 20261012000000 and
-- it does not start writing money into them again. So a Confirmed-Order request
-- is born payment_target_type='unallocated', payment_against='new_order', and:
--
--   * approve_finance_payment_request branches on payment_target_type, so it
--     takes the else-branch and writes 'approved_unlinked' with a null
--     order_number — even though it has just created the Order's allocation;
--   * the STATUS_META badge maps approved_unlinked to "Order No. Pending";
--   * orderNoDisplay() reads order_number (null) then order_request_number
--     (null) then payment_against ('new_order') and prints
--     "New Order — no order created yet";
--   * "Payment Against" reads payment_target_type and prints "New Order".
--
-- Every one of those readers is asking a column that stopped being the answer
-- two migrations ago. The destination now lives in exactly two places, by
-- design:
--
--     BEFORE approval   finance_payment_allocation_intents, status 'pending'
--     AFTER  approval   finance_payment_allocations,        status 'active'
--
-- THE FIX IS A PROJECTION, NOT A COLUMN. §8 adds finance_payment_destinations:
-- a security_invoker view, one row per payment, that answers "which record is
-- this money for?" from those two tables and from nothing else. The application
-- reads it instead of payment_target_type / payment_against / order_number.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
--   * It does not set order_id, order_number or payment_target_type at
--     approval. See §8's "WHY PROVENANCE IS NOT WRITTEN AT APPROVAL" for the
--     three specific ways that would go wrong, each of which the projection
--     avoids by construction.
--   * It does not touch one financial expression. finance_received_payments is
--     not redefined here; order_linked_payment_total, the allocation capacity
--     rules, the verified-payment gate and every total are untouched. §9c reads
--     that back from the catalogue rather than asserting it in prose.
--   * finance_payment_destinations carries NO money. It names records; it does
--     not add up rupees, and §9f refuses to install a version that does. The
--     fully-allocated / partially-allocated question is already answered by
--     finance_received_payments.allocation_state, from the ledger, and is not
--     re-derived here.
--
--
-- ── B. THE FOUR PAYMENT MODES ───────────────────────────────────────────────
--
-- New entries offer exactly HDFC, PNB, Paytm and Canara, stored as 'hdfc',
-- 'pnb', 'paytm', 'canara'. What each one means internally is recorded in §1's
-- column comment and NOWHERE a screen can reach: the frontend prints the account
-- name and never the meaning.
--
-- HISTORY IS NOT REWRITTEN. See §1 for the compatibility decision and its
-- reasoning in full.
--
--
-- ── C. THE PNB/PAYTM CUSTODY TRAIL ──────────────────────────────────────────
--
-- PNB and Paytm are the two modes where a human being physically holds the
-- money between the customer and the company. §2 gives that an append-only
-- event log, generalising the five single-event columns 20260716000000 added
-- (collected_by_user_id, collected_from_text, handed_over_to_user_id,
-- handed_over_at, collection_handover_note) rather than standing a second system
-- beside them. Those columns are frozen as history and read by the same UI; no
-- new write touches them.
--
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- §1. Payment modes: four for new entries, nine in storage
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── THE COMPATIBILITY DECISION, AND WHY ─────────────────────────────────────
--
-- Three strategies were available.
--
--   1. REPLACE THE DOMAIN AND CONVERT THE HISTORY. Rejected. The stored
--      (payment_mode, received_in) PAIR is what named an account, never the mode
--      alone — src/app/finance/paymentDestinations.ts has said so since the four
--      accounts existed:
--
--          (bank_transfer, company_account) = HDFC
--          (bank_transfer, savings_account) = Canara
--          (cash,          cash_in_hand)    = Paytm
--          (other,         other)           = PNB
--
--      and 20260919000000 made received_in NULLABLE while 20261013000000 stopped
--      writing it at all. So every row recorded since carries a bare
--      'bank_transfer' with received_in NULL, which is HDFC or Canara and there
--      is no way to tell which. 'upi' and 'cheque' name no account at all.
--      Converting would either invent a fact or destroy one.
--
--   2. TRANSLATE ONLY THE UNAMBIGUOUS PAIRS. Rejected, and this is the closer
--      call. The four pairs above ARE unambiguous, and an UPDATE over them would
--      be defensible arithmetic. It is refused anyway because it is a rewrite of
--      financial history performed by a migration that cannot be reviewed
--      against the rows it changes — this repository has no read access to the
--      linked project, so the SET would run blind. And it buys nothing: every
--      reader already resolves those pairs to the same four account names
--      through paymentDestinationLabel(), so the screens say "HDFC" for a
--      converted row and for an unconverted one alike. A rewrite whose only
--      effect is on the stored bytes is a risk with no return.
--
--   3. WIDEN STORAGE, RESTRICT ENTRY.  ← CHOSEN
--      The CHECK becomes a VERSIONED domain: the four CURRENT values plus the
--      five LEGACY ones, each half labelled in the constraint's own name so the
--      distinction is visible in \d output and not only in this comment. Every
--      historical row stays exactly as it was written and stays readable. A new
--      entry may use only the four, enforced BY THE DATABASE in two independent
--      places:
--
--          finance_payment_requests_enforce_current_payment_mode
--              a trigger — refuses any INSERT outside the four, and any UPDATE
--              that CHANGES payment_mode to something outside the four. An
--              update that leaves a legacy value alone is untouched, so
--              correcting the amount on a 2026 'cheque' row still works.
--
--          the four payment-entry RPCs
--              refuse the same set by name, so a caller is told which four to
--              choose from rather than being handed a trigger's message.
--
-- ── WHAT THE FOUR MEAN ──────────────────────────────────────────────────────
-- Recorded HERE, in the database, and deliberately not in any table, view or
-- function the application reads: the product shows the account name alone.
--
--     hdfc    Current Account
--     pnb     Hawala
--     paytm   Cash
--     canara  Saving Account
--
-- The two that involve a person carrying money — pnb and paytm — are the two
-- §2's custody trail applies to. payment_mode_requires_custody() is the one
-- place that rule is written down.

do $$
declare
  v_name text;
begin
  -- BY DISCOVERY, NOT BY NAME. The constraint was declared inline in
  -- 20260628000200, so its name is PostgreSQL's own choice; asserting a guessed
  -- name would fail on a database that had ever had it renamed.
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.finance_payment_requests'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%payment_mode%'
  limit 1;

  if v_name is null then
    raise exception
      'the payment_mode domain CHECK is missing — this migration widens it and will not create the first one blind';
  end if;

  execute format('alter table public.finance_payment_requests drop constraint %I', v_name);
end $$;

alter table public.finance_payment_requests
  add constraint finance_payment_requests_payment_mode_current_or_legacy
  check (payment_mode in (
    -- CURRENT — the only four a new entry may use.
    'hdfc', 'pnb', 'paytm', 'canara',
    -- LEGACY — historical rows only, kept readable, refused for new entries by
    -- finance_payment_requests_enforce_current_payment_mode below.
    'bank_transfer', 'cash', 'upi', 'cheque', 'other'
  ));

comment on column public.finance_payment_requests.payment_mode is
  'How the money arrived, as one of the four BOE accounts a new entry may name: hdfc (Current Account), pnb (Hawala), paytm (Cash), canara (Saving Account). The five legacy values — bank_transfer, cash, upi, cheque, other — remain STORABLE so every historical row stays readable and is never rewritten, and remain REFUSED for new entries by finance_payment_requests_enforce_current_payment_mode. The bracketed meanings are internal and are never rendered by any screen. 20261014000000.';


-- ── The four current values, as one function ────────────────────────────────
-- Named once so the trigger, the four RPCs and §9's assertions all read the same
-- list. IMMUTABLE, so it may be used in an index or a CHECK later without
-- surprise.

create or replace function public.payment_mode_is_current(p_mode text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(lower(coalesce(p_mode, ''))) in ('hdfc', 'pnb', 'paytm', 'canara');
$$;

comment on function public.payment_mode_is_current(text) is
  'True for the four payment modes a NEW entry may use: hdfc, pnb, paytm, canara. False for the five legacy values, which stay storable so history is never rewritten. 20261014000000.';

grant execute on function public.payment_mode_is_current(text) to authenticated;


-- ── Which modes carry a custody trail ───────────────────────────────────────
-- PNB (Hawala) and Paytm (Cash) are the two where a person physically holds the
-- money. The RULE IS THE MODE'S, not a form's: §2's RPC asks this function, and
-- a browser that drew the section for a bank account gets its events refused.

create or replace function public.payment_mode_requires_custody(p_mode text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(lower(coalesce(p_mode, ''))) in ('pnb', 'paytm');
$$;

comment on function public.payment_mode_requires_custody(text) is
  'True for the two payment modes whose money is physically carried by a person — pnb and paytm. The one place that rule is written down; the custody RPC and the forms both read it. 20261014000000.';

grant execute on function public.payment_mode_requires_custody(text) to authenticated;


-- ── New entries take the four, and only the four ────────────────────────────
--
-- A TRIGGER AND NOT A CHECK, because the rule is about the TRANSITION and not
-- about the row: a legacy row must keep its legacy value through every later
-- correction, and a CHECK cannot see `old`.
--
-- WHY IT IS NOT LEFT TO THE RPCs. All four entry doors validate the mode
-- themselves and say which four to choose from. They are not the boundary:
-- finance_payment_requests carries an own-row INSERT policy
-- (finance_payment_requests_own_insert) and an UPDATE policy for its submitter,
-- so a PostgREST client can write the table directly without passing through any
-- of them. This trigger is what makes "new submissions accept only the four
-- new modes" a property of the database.

create or replace function public.finance_payment_requests_enforce_current_payment_mode()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if not public.payment_mode_is_current(new.payment_mode) then
      raise exception
        'PAYMENT_MODE_RETIRED: % is a historical payment mode. Choose HDFC, PNB, Paytm or Canara.',
        new.payment_mode
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE. Only a CHANGE is judged. Leaving a historical value exactly as it
  -- was found is what keeps every old row correctable.
  if new.payment_mode is distinct from old.payment_mode
     and not public.payment_mode_is_current(new.payment_mode) then
    raise exception
      'PAYMENT_MODE_RETIRED: % is a historical payment mode and cannot be set on a payment. Choose HDFC, PNB, Paytm or Canara.',
      new.payment_mode
      using errcode = 'P0001';
  end if;

  return new;
end $$;

-- REVOKED, like every trigger function this project creates: a Supabase
-- project's `grant all on functions` default would otherwise leave a SECURITY
-- DEFINER function reachable by anon on paper.
revoke execute on function public.finance_payment_requests_enforce_current_payment_mode()
  from public, anon, authenticated, service_role;

comment on function public.finance_payment_requests_enforce_current_payment_mode() is
  'Refuses a payment written with, or corrected onto, a retired payment mode. An UPDATE that leaves a historical value untouched passes, which is what keeps every pre-20261014000000 row correctable. 20261014000000.';

drop trigger if exists finance_payment_requests_enforce_current_payment_mode
  on public.finance_payment_requests;
create trigger finance_payment_requests_enforce_current_payment_mode
  before insert or update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_enforce_current_payment_mode();


-- ═══════════════════════════════════════════════════════════════════════════
-- §2. finance_payment_custody_events — who held the money, and when
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ONE SYSTEM, NOT TWO. 20260716000000 gave a payment five columns for a single
-- collection and a single handover:
--
--     collected_by_user_id, collected_from_text,
--     handed_over_to_user_id, handed_over_at, collection_handover_note
--
-- That shape holds exactly one collection and exactly one handover, cannot say
-- WHEN the collection happened (only the handover has a date), and rewrites
-- itself on every correction. PNB (Hawala) and Paytm (Cash) both routinely pass
-- through more than one pair of hands, so the answer is a LOG, not more columns
-- — and a second parallel system for Hawala beside the existing one for Cash
-- would be the duplication this migration exists to avoid.
--
-- SO THE FIVE COLUMNS ARE GENERALISED, NOT DUPLICATED:
--
--   * they are FROZEN AS HISTORY. Nothing this migration writes touches them;
--     §4, §5 and §6 stop sending them entirely, and §5 stops clearing them, so a
--     row that recorded a collection in 2026 keeps saying so forever.
--   * the application reads them through ONE trail component
--     (src/lib/finance/custodyTrail.ts), which projects a legacy row's columns
--     into the same event shape this table stores and marks it as the legacy
--     record it is. One reader, two sources, no second vocabulary.
--   * every NEW event lands here.
--
-- APPEND ONLY. There is no UPDATE path at all — a BEFORE UPDATE trigger refuses
-- one outright, on top of there being no UPDATE policy and no UPDATE privilege —
-- and no DELETE policy or privilege for any client role. Correcting the record
-- means adding an event that says what actually happened, which is what an audit
-- trail is for. The only way a row leaves this table is with the payment it
-- belongs to, through the admin deletion protocol's cascade.

create table if not exists public.finance_payment_custody_events (
  id uuid primary key default gen_random_uuid(),

  -- CASCADE, for the same reason the intent table cascades: a custody event is
  -- meaningless without its payment, and what a DELETED payment was is recorded
  -- by the permanent tombstone (20261011000000), which is the record that has to
  -- survive.
  payment_request_id uuid not null
    references public.finance_payment_requests(id) on delete cascade,

  activity_type text not null
    check (activity_type in ('collected', 'handed_over')),

  -- DATE AND TIME, not a date. "Collected at 9pm, handed over at 10pm" is a
  -- real and common trail, and 20260716000000's `handed_over_at date` could not
  -- express it. Bounded against the future by the RPC, not by a CHECK, so the
  -- message names the field.
  occurred_at timestamptz not null,

  -- ── The people, one shape per activity ──
  -- 'collected'   names who collected it (and optionally, in the remark, from
  --               whom — an outside party has no BOE user record).
  -- 'handed_over' names both ends of the handover.
  collected_by_user_id uuid references public.users(id),
  handed_by_user_id    uuid references public.users(id),
  handed_to_user_id    uuid references public.users(id),

  remark text,

  -- THE MODE AS IT WAS WHEN THIS HAPPENED. A pending request may be corrected
  -- from PNB to Paytm; the events already recorded describe money that moved
  -- under the OLD mode and must keep saying so. Stamped server-side from the
  -- payment row, never accepted from a caller.
  payment_mode_at_event text not null
    check (payment_mode_at_event in ('pnb', 'paytm')),

  -- ── The audit pair ──
  -- WHO recorded it and WHEN they recorded it, which are different facts from
  -- who carried the money and when they carried it.
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),

  -- IDEMPOTENCY, CARRIED BY THE ROW. The client mints one stable key per event
  -- it is holding — a value that survives a failed round trip and a second click
  -- — and the unique index below turns a retry into a no-op. See §3.
  idempotency_key text not null check (btrim(idempotency_key) <> ''),

  -- The project-wide test-data marker, stamped by the same trigger every other
  -- Finance table uses so the reset protocol sees this table too.
  is_test_data boolean not null default false,

  -- ── Each activity names the people ITS shape needs, and no others ──
  constraint finance_payment_custody_events_people check (
    (activity_type = 'collected'
       and collected_by_user_id is not null
       and handed_by_user_id is null and handed_to_user_id is null)
    or
    (activity_type = 'handed_over'
       and handed_by_user_id is not null and handed_to_user_id is not null
       and collected_by_user_id is null)
  )
);

comment on table public.finance_payment_custody_events is
  'The append-only custody trail for the two payment modes whose money a person physically carries — pnb (Hawala) and paytm (Cash). One row per Collected or Handed Over activity, in the order it happened, stamped with the payment mode in force AT THE TIME so a corrected request keeps its earlier events understandable. NOT FINANCIAL: no total, balance, classification or gate reads this table, and a row here moves no money. Immutable once written: no UPDATE path exists for any role. 20261014000000.';

comment on column public.finance_payment_custody_events.occurred_at is
  'When the money actually changed hands. Distinct from created_at, which is when somebody recorded it.';
comment on column public.finance_payment_custody_events.payment_mode_at_event is
  'The payment''s mode at the moment this event was recorded, stamped server-side. A pending request corrected from PNB to Paytm keeps its earlier events labelled PNB — the money really did move under that mode.';
comment on column public.finance_payment_custody_events.idempotency_key is
  'A stable per-event key minted by the caller. Unique per payment, so a retried submission or a double click re-inserts nothing.';

-- ── Idempotency, and the natural duplicate ──────────────────────────────────
-- TWO unique indexes, and §3 inserts with a bare ON CONFLICT DO NOTHING so BOTH
-- are arbiters. The key catches a retry of the same event; the natural key
-- catches the same event submitted twice under two freshly minted keys, which is
-- what a double click on a re-rendered form produces. Two identical activities,
-- to the same second, between the same people, is not an event the business has.
create unique index if not exists finance_payment_custody_events_key_idx
  on public.finance_payment_custody_events (payment_request_id, idempotency_key);

create unique index if not exists finance_payment_custody_events_natural_idx
  on public.finance_payment_custody_events (
    payment_request_id, activity_type, occurred_at,
    coalesce(collected_by_user_id, handed_by_user_id),
    coalesce(handed_to_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Reading one payment's whole trail in order is the only access path.
create index if not exists finance_payment_custody_events_payment_idx
  on public.finance_payment_custody_events (payment_request_id, occurred_at, created_at);


-- ── Immutable, stated as a refusal and not as an absence ────────────────────
--
-- The privileges below already deny every client UPDATE, and there is no UPDATE
-- policy. This trigger is the third refusal, and it is the one that also binds
-- service_role and any future SECURITY DEFINER function: "previously saved
-- events cannot be rewritten" is a property of the table, not of who is asking.

create or replace function public.finance_payment_custody_events_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception
    'CUSTODY_EVENT_IMMUTABLE: a custody activity cannot be edited once saved. Add the activity that actually happened instead.'
    using errcode = '42501';
end $$;

revoke execute on function public.finance_payment_custody_events_immutable()
  from public, anon, authenticated, service_role;

comment on function public.finance_payment_custody_events_immutable() is
  'Refuses every UPDATE on finance_payment_custody_events, for every role. The trail is append-only.';

drop trigger if exists finance_payment_custody_events_immutable
  on public.finance_payment_custody_events;
create trigger finance_payment_custody_events_immutable
  before update on public.finance_payment_custody_events
  for each row execute function public.finance_payment_custody_events_immutable();


-- ── Test-data stamping, if the project's marker exists ──────────────────────
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'stamp_is_test_data'
  ) then
    execute 'drop trigger if exists finance_payment_custody_events_stamp_test_data
               on public.finance_payment_custody_events';
    execute 'create trigger finance_payment_custody_events_stamp_test_data
               before insert on public.finance_payment_custody_events
               for each row execute function public.stamp_is_test_data()';
  end if;
end $$;


-- ── Row-level security ──────────────────────────────────────────────────────
-- READ FOLLOWS THE PAYMENT, exactly as the intent table's does: whoever may see
-- the payment row may see who carried its money. WRITE BELONGS TO NOBODY — the
-- append door in §3 is SECURITY DEFINER, so there is deliberately no INSERT,
-- UPDATE or DELETE policy at all.

alter table public.finance_payment_custody_events enable row level security;

drop policy if exists finance_payment_custody_events_select
  on public.finance_payment_custody_events;
create policy finance_payment_custody_events_select
  on public.finance_payment_custody_events
  for select
  using (
    exists (
      select 1 from public.finance_payment_requests f
      where f.id = finance_payment_custody_events.payment_request_id
    )
  );

-- ── Table privileges: REVOKED BY NAME ───────────────────────────────────────
--
-- THE LESSON OF 20261013000000 §2, APPLIED FIRST RATHER THAN AFTER A FAILED
-- PUSH. A Supabase project bootstraps with
--
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role;
--
-- so `create table` above did NOT produce an empty ACL — it produced
-- `authenticated=arwdDxt/postgres`, every write privilege already granted. That
-- is invisible on a bare local database, which is exactly how 113's first
-- version reached production and failed there. Every write is therefore revoked
-- BY NAME, and supabase/tests/run_payment_custody_and_modes_privileges_suite.sh
-- models the default privileges so the fixture answers the question production
-- asks.
--
-- service_role KEEPS ITS DEFAULT ALL, as it does on every other Finance table.
-- The immutability trigger above binds it anyway.

revoke all on public.finance_payment_custody_events from public;

revoke insert, update, delete, truncate, references, trigger
  on public.finance_payment_custody_events from anon, authenticated;

-- ANON IS CLOSED OUTRIGHT, SELECT included: the policy is anchored to a payment
-- row anon cannot see, so the privilege has no purpose.
revoke select on public.finance_payment_custody_events from anon;

grant select on public.finance_payment_custody_events to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §3. Appending custody activities — one implementation, two doors
-- ═══════════════════════════════════════════════════════════════════════════
--
-- append_payment_custody_events_internal is the whole rule, callable by nobody.
-- The four payment-entry RPCs call it after their own authorization has already
-- passed; append_payment_custody_events is the standalone door, which derives
-- the actor and asks the permission question itself.
--
-- IDEMPOTENT BY THE ROW, NOT BY THE CALL. `on conflict do nothing` with no named
-- arbiter lets BOTH unique indexes refuse a duplicate: the caller's key catches a
-- retry of the same submission, and the natural key catches the same activity
-- resubmitted under a freshly minted key. The result reports how many rows were
-- actually written, so a caller can tell a retry from a first attempt.
--
-- THE MODE DECIDES, SERVER-SIDE. Events are accepted only while the payment's
-- mode is one a person carries. A form that drew the section for a bank account,
-- or left it filled in after the mode was changed, has its events REFUSED — a
-- hidden field is not an authorization and a stale one is not a fact.
--
-- IT NEVER REWRITES ANYTHING. The only statement below is an INSERT.

create or replace function public.append_payment_custody_events_internal(
  p_payment_request_id uuid,
  p_events             jsonb,
  p_actor              uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode     text;
  v_count    int;
  v_index    int := 0;
  v_row      jsonb;
  v_type     text;
  v_when     timestamptz;
  v_key      text;
  v_by       uuid;
  v_from     uuid;
  v_to       uuid;
  v_inserted int := 0;
  v_id       uuid;
begin
  if p_events is null or jsonb_typeof(p_events) = 'null' then
    return jsonb_build_object('appended', 0, 'requested', 0);
  end if;

  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'CUSTODY_EVENTS_INVALID: the custody activity list must be an array.'
      using errcode = 'P0001';
  end if;

  v_count := jsonb_array_length(p_events);
  if v_count = 0 then
    return jsonb_build_object('appended', 0, 'requested', 0);
  end if;

  -- A BOUND, so one call cannot take an unbounded number of row locks. Fifty
  -- hand-offs on one payment is far beyond any real trail.
  if v_count > 50 then
    raise exception
      'CUSTODY_EVENTS_TOO_MANY: at most 50 custody activities may be added in one save.'
      using errcode = 'P0001';
  end if;

  -- ── The payment, and the mode that decides whether a trail applies ──
  select f.payment_mode into v_mode
  from public.finance_payment_requests f
  where f.id = p_payment_request_id;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: that payment no longer exists.'
      using errcode = 'P0002';
  end if;

  if not public.payment_mode_requires_custody(v_mode) then
    raise exception
      'CUSTODY_MODE_NOT_APPLICABLE: a collection and handover trail is recorded only for PNB and Paytm payments.'
      using errcode = 'P0001';
  end if;

  for v_row in select jsonb_array_elements(p_events) loop
    v_index := v_index + 1;

    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'CUSTODY_EVENT_ROW_INVALID: activity % is not an activity.', v_index
        using errcode = 'P0001';
    end if;

    v_key := nullif(btrim(coalesce(v_row->>'key', '')), '');
    if v_key is null then
      raise exception
        'CUSTODY_EVENT_KEY_REQUIRED: activity % carries no idempotency key.', v_index
        using errcode = 'P0001';
    end if;

    v_type := btrim(lower(coalesce(v_row->>'activity_type', '')));
    if v_type not in ('collected', 'handed_over') then
      raise exception
        'CUSTODY_EVENT_TYPE_INVALID: activity % must be Collected or Handed Over.', v_index
        using errcode = 'P0001';
    end if;

    -- A malformed timestamp is a malformed REQUEST, said in its own words so it
    -- is never mistaken for a missing one.
    begin
      v_when := (v_row->>'occurred_at')::timestamptz;
    exception when others then
      v_when := null;
    end;

    if v_when is null then
      raise exception
        'CUSTODY_EVENT_TIME_REQUIRED: activity % needs the date and time it happened.', v_index
        using errcode = 'P0001';
    end if;

    -- Bounded rather than exact, for the same reason every other date rule in
    -- this module is bounded: the browser's clock and the server's need not
    -- agree to the second.
    if v_when > now() + interval '1 day' then
      raise exception
        'CUSTODY_EVENT_TIME_FUTURE: activity % cannot have happened in the future.', v_index
        using errcode = 'P0001';
    end if;

    v_by   := null;
    v_from := null;
    v_to   := null;

    begin
      if v_type = 'collected' then
        v_by := nullif(btrim(coalesce(v_row->>'collected_by', '')), '')::uuid;
      else
        v_from := nullif(btrim(coalesce(v_row->>'handed_by', '')), '')::uuid;
        v_to   := nullif(btrim(coalesce(v_row->>'handed_to', '')), '')::uuid;
      end if;
    exception when others then
      raise exception
        'CUSTODY_EVENT_PERSON_INVALID: activity % does not name a person.', v_index
        using errcode = 'P0001';
    end;

    if v_type = 'collected' and v_by is null then
      raise exception
        'CUSTODY_EVENT_COLLECTOR_REQUIRED: activity % must say who collected the money.', v_index
        using errcode = 'P0001';
    end if;

    -- BOTH ENDS, OR NEITHER. A handover with one end named is a record nobody
    -- can act on, which is the rule finance_payment_requests_handover_pair has
    -- stated for the legacy columns since 20260716000000.
    if v_type = 'handed_over' and (v_from is null or v_to is null) then
      raise exception
        'CUSTODY_EVENT_HANDOVER_INCOMPLETE: activity % must say who handed the money over and who received it.',
        v_index
        using errcode = 'P0001';
    end if;

    -- The people must be real. A uuid that names nobody would render as a blank
    -- in the trail, which is worse than a refusal here.
    foreach v_id in array array_remove(array[v_by, v_from, v_to], null) loop
      if not exists (select 1 from public.users u where u.id = v_id) then
        raise exception
          'CUSTODY_EVENT_PERSON_UNKNOWN: activity % names somebody who is not a BOE user.', v_index
          using errcode = 'P0001';
      end if;
    end loop;

    -- ── The insert, and the only statement in this function ──
    --
    -- NO ARBITER IS NAMED, deliberately: `do nothing` then covers the caller's
    -- key AND the natural key, so both kinds of duplicate collapse to a no-op
    -- rather than one of them raising.
    insert into public.finance_payment_custody_events
      (payment_request_id, activity_type, occurred_at,
       collected_by_user_id, handed_by_user_id, handed_to_user_id,
       remark, payment_mode_at_event, created_by, idempotency_key)
    values
      (p_payment_request_id, v_type, v_when,
       v_by, v_from, v_to,
       nullif(btrim(coalesce(v_row->>'remark', '')), ''),
       btrim(lower(v_mode)), p_actor, v_key)
    on conflict do nothing;

    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('appended', v_inserted, 'requested', v_count);
end $$;

comment on function public.append_payment_custody_events_internal(uuid, jsonb, uuid) is
  'Appends validated custody activities to one payment, stamping each with the payment''s CURRENT mode. Refuses outright for a mode nobody carries. Idempotent: ON CONFLICT DO NOTHING with no named arbiter, so a retried key and a re-minted duplicate both collapse to a no-op. Never updates or deletes. Executable by no role — the entry RPCs and append_payment_custody_events call it.';

revoke execute on function public.append_payment_custody_events_internal(uuid, jsonb, uuid)
  from public, anon, authenticated, service_role;


-- ── The standalone door: adding to a trail after the fact ───────────────────
--
-- WHO MAY APPEND, and it is a DATABASE rule rather than a hidden button:
--
--   * a holder of finance.approve or finance.manage — the Finance and Admin
--     authority — at any point in the payment's life, which is what makes
--     "record the handover that happened last week" possible on a payment that
--     has already been verified;
--   * the person who SUBMITTED the request, while it is still unapproved. That
--     is the same window finance_payment_requests_own_update and
--     edit_payment_request already give them, restated rather than widened.
--
-- Everybody else is refused here, before a row is read.
--
-- APPROVED PAYMENTS ARE STILL APPENDABLE by Finance, and that is deliberate:
-- a custody event is a statement about who carried cash, not about how much
-- money arrived. It moves no rupees, satisfies no gate and changes no
-- classification — so the post-approval freeze that protects the FIGURES has
-- nothing to say about it.

create or replace function public.append_payment_custody_events(
  p_payment_request_id uuid,
  p_events             jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_req   public.finance_payment_requests%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required to record a custody activity'
      using errcode = '28000';
  end if;

  if not public.module_entry_open('finance') then
    raise exception 'FINANCE_MODULE_CLOSED: the Finance module is not open to you.'
      using errcode = '42501';
  end if;

  select * into v_req
  from public.finance_payment_requests
  where id = p_payment_request_id;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: that payment no longer exists.'
      using errcode = 'P0002';
  end if;

  if not (
    public.actor_has_module_permission('finance', 'approve')
    or public.actor_has_module_permission('finance', 'manage')
    or (v_req.submitted_by = v_actor
        and v_req.status in ('pending_approval', 'needs_clarification', 'rejected'))
  ) then
    raise exception
      'CUSTODY_APPEND_NOT_PERMITTED: you do not have permission to add a collection or handover to this payment.'
      using errcode = '42501';
  end if;

  return public.append_payment_custody_events_internal(p_payment_request_id, p_events, v_actor);
end $$;

comment on function public.append_payment_custody_events(uuid, jsonb) is
  'Adds one or more custody activities to a payment''s trail. Permitted to a finance.approve or finance.manage holder at any time, and to the request''s own submitter while it is unapproved — checked here, in the database, not by which buttons a browser drew. Append-only and idempotent. 20261014000000.';

revoke execute on function public.append_payment_custody_events(uuid, jsonb) from public, anon;
grant execute on function public.append_payment_custody_events(uuid, jsonb) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §4. submit_payment_request — the four modes, and the custody trail
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Restated from 20261013000000 §3 with three changes and nothing else:
--
--   1. THE MODE DOMAIN is the four current accounts (§1).
--   2. THE FIVE CASH PARAMETERS ARE GONE, replaced by one p_custody_events
--      array. The five columns they wrote are history (§2) and this no longer
--      writes them at all.
--   3. THE CUSTODY ACTIVITIES ARE WRITTEN IN THE SAME TRANSACTION as the payment
--      and its intent, so a request and the trail somebody entered beside it can
--      never half-land.
--
-- Every other rule is carried across untouched: the destination validation, the
-- target eligibility, the server-derived customer, the pending intent, the
-- refusal to create an allocation, and the fact that there is no client-name
-- parameter.
--
-- THE OLD SIGNATURE IS DROPPED, not left beside this one. Two overloads that
-- differ only in their trailing defaults are ambiguous to a named-argument
-- caller like PostgREST, and an old door that still writes the retired columns
-- is not a dormant artefact — it is a live second way in.

drop function if exists public.submit_payment_request(text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text);

create or replace function public.submit_payment_request(
  p_destination     text,                     -- 'pi_draft' | 'confirmed_order' | 'suspense'
  p_target_id       uuid    default null,     -- the PI Draft or the Order; null for suspense
  p_amount          numeric default null,
  p_payment_date    date    default null,
  p_payment_mode    text    default null,
  p_proof_note      text    default null,
  p_sales_note      text    default null,
  -- ── The custody trail ──
  --
  -- The five single-event cash columns 20261013000000 accepted here are gone:
  -- what a person carrying money did is a LOG now, not a row's worth of columns
  -- (20261014000000 §2). Each element is one Collected or Handed Over activity,
  -- carrying its own idempotency key so a retried submission adds nothing.
  --
  -- WHAT DECIDES WHETHER A TRAIL IS RECORDED IS THE PAYMENT MODE, server-side:
  -- append_payment_custody_events_internal refuses events on any mode nobody
  -- carries, so a form field the browser happened to leave filled in after the
  -- mode changed is refused rather than stored.
  p_custody_events  jsonb   default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_dest     text := btrim(lower(coalesce(p_destination, '')));
  v_mode     text := btrim(lower(coalesce(p_payment_mode, '')));
  v_client   text;
  v_sub      public.order_submissions%rowtype;
  v_ord      public.orders%rowtype;
  v_target_t text;
  v_payment  uuid;
  v_number   text;
  v_intent   uuid;
  v_custody  jsonb;
begin
  -- ── 1. Actor and permission ──
  if v_actor is null then
    raise exception 'Authentication required to submit a payment request'
      using errcode = '28000';
  end if;

  if not public.module_entry_open('finance') then
    raise exception 'FINANCE_MODULE_CLOSED: the Finance module is not open to you.'
      using errcode = '42501';
  end if;

  -- ── 2. The shape of the request, before anything is read or written ──
  if v_dest not in ('pi_draft', 'confirmed_order', 'suspense') then
    raise exception
      'PAYMENT_DESTINATION_INVALID: choose PI Draft, Confirmed Order or Suspense Entry.'
      using errcode = 'P0001';
  end if;

  if v_dest = 'suspense' then
    if p_target_id is not null then
      raise exception
        'PAYMENT_TARGET_FORBIDDEN: a Suspense Entry names no PI Draft and no Order.'
        using errcode = 'P0001';
    end if;
  elsif p_target_id is null then
    raise exception
      'PAYMENT_TARGET_REQUIRED: choose the PI Draft or Order this payment is for.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'PAYMENT_AMOUNT_INVALID: enter a positive amount in rupees and paise.'
      using errcode = 'P0001';
  end if;

  if p_payment_date is null then
    raise exception 'PAYMENT_DATE_REQUIRED: enter the date the payment was received.'
      using errcode = 'P0001';
  end if;

  -- THE FOUR CURRENT ACCOUNTS (20261014000000 §1). The five legacy values stay
  -- STORABLE so history is never rewritten, and are refused for a NEW entry here
  -- and again by finance_payment_requests_enforce_current_payment_mode — so this
  -- message is what a caller reads, not a trigger's.
  if not public.payment_mode_is_current(v_mode) then
    raise exception
      'PAYMENT_MODE_INVALID: choose HDFC, PNB, Paytm or Canara.'
      using errcode = 'P0001';
  end if;

  -- ── 3. Resolve the target, and with it the customer ──
  --
  -- Read under this transaction and taken as the truth. The eligibility rules
  -- are the ones allocate_payment_to_target_internal will apply again at
  -- approval; checking them now means a person is told at submission rather
  -- than days later when Finance tries to approve.
  if v_dest = 'pi_draft' then
    select * into v_sub from public.order_submissions where id = p_target_id;
    if not found then
      raise exception 'PAYMENT_TARGET_NOT_FOUND: that PI Draft no longer exists.'
        using errcode = 'P0002';
    end if;
    if v_sub.status = 'rejected' then
      raise exception 'PAYMENT_TARGET_NOT_ACTIVE: a rejected PI Draft cannot receive a payment.'
        using errcode = 'P0001';
    end if;
    if v_sub.order_id is not null then
      raise exception
        'PAYMENT_TARGET_CONVERTED: that PI has been approved and is now an Order. Choose the Order instead.'
        using errcode = 'P0001';
    end if;
    v_client   := nullif(btrim(coalesce(v_sub.client_name, '')), '');
    v_target_t := 'pi_draft';

    if v_client is null then
      raise exception
        'PAYMENT_TARGET_NO_CLIENT: that PI Draft has no customer on file. Correct the PI before recording a payment against it.'
        using errcode = 'P0001';
    end if;

  elsif v_dest = 'confirmed_order' then
    select * into v_ord from public.orders where id = p_target_id;
    if not found then
      raise exception 'PAYMENT_TARGET_NOT_FOUND: that Order no longer exists.'
        using errcode = 'P0002';
    end if;
    if v_ord.status = 'cancelled' then
      raise exception 'PAYMENT_TARGET_NOT_ACTIVE: Order % is cancelled and cannot receive a payment.',
        v_ord.display_number using errcode = 'P0001';
    end if;
    v_client   := nullif(btrim(coalesce(v_ord.client_name, '')), '');
    v_target_t := 'confirmed_order';

    if v_client is null then
      raise exception
        'PAYMENT_TARGET_NO_CLIENT: that Order has no customer on file. Correct it on the Order Details page first.'
        using errcode = 'P0001';
    end if;

  else
    -- SUSPENSE. No target, and therefore no customer. NULL is the honest value
    -- and §1 is what makes it storable; nothing is invented to fill the column.
    v_client   := null;
    v_target_t := null;
  end if;

  -- ── 4. The payment row ──
  --
  -- pending_approval, exactly as the form's direct insert wrote it. No order_id
  -- and no order_request_id are set for ANY destination: those columns are
  -- provenance since 20261012000000 and this migration does not start writing
  -- money into them again. What the payment is for lives in the intent.
  --
  -- received_in IS NULL, ALWAYS. The four-account picker that used to derive it
  -- alongside payment_mode is gone from this form, and there is no honest value
  -- to put here in its place: the column has been nullable since
  -- 20260919000000 and null means the receiving account was not stated. Nothing
  -- is invented to fill it.
  --
  -- order_number IS NULL TOO. It denormalises a Confirmed Order's number, and
  -- no destination here writes order_id — so a value in it would name a link
  -- the row does not have.
  --
  -- THE FIVE LEGACY CASH COLUMNS ARE NOT WRITTEN EITHER (20261014000000 §2).
  -- They are history: every row that carries them keeps saying exactly what it
  -- always said, and every new custody fact is an event in
  -- finance_payment_custody_events instead. A new payment leaves them NULL,
  -- which is what "this payment has no legacy single-event record" means.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     proof_note, sales_note, status, submitted_by, payment_against)
  values
    (v_client, p_amount, p_payment_date, v_mode, null,
     nullif(btrim(coalesce(p_proof_note, '')), ''),
     nullif(btrim(coalesce(p_sales_note, '')), ''),
     'pending_approval', v_actor, 'new_order')
  returning id, request_number into v_payment, v_number;

  -- ── 5. The intent, for a targeted destination ──
  if v_target_t is not null then
    insert into public.finance_payment_allocation_intents
      (payment_request_id, target_type, order_submission_id, order_id,
       intended_amount, created_by)
    values
      (v_payment, v_target_t,
       case when v_target_t = 'pi_draft'        then p_target_id end,
       case when v_target_t = 'confirmed_order' then p_target_id end,
       p_amount, v_actor)
    returning id into v_intent;
  end if;

  -- ── 6. The custody trail, in the same transaction ──
  --
  -- Authorization is already settled: this caller has passed module entry and is
  -- the submitter of the row that was written one statement ago, so the internal
  -- door is called rather than the standalone one, which would ask the same
  -- question again. A refusal — a mode nobody carries, an incomplete handover, a
  -- person who is not a BOE user — raises out of this function and takes the
  -- payment and its intent with it. There is no half-submitted request.
  if p_custody_events is not null and jsonb_typeof(p_custody_events) = 'array'
     and jsonb_array_length(p_custody_events) > 0 then
    v_custody := public.append_payment_custody_events_internal(
      v_payment, p_custody_events, v_actor);
  else
    v_custody := jsonb_build_object('appended', 0, 'requested', 0);
  end if;

  return jsonb_build_object(
    'payment_request_id', v_payment,
    'request_number',     v_number,
    'destination',        v_dest,
    'client_name',        v_client,
    'intent_id',          v_intent,
    'allocation_created', false,
    'custody_events',     v_custody
  );
end $$;

comment on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb) is
  'The one door the Payment Request form writes through. Validates the destination, resolves the target, DERIVES the customer from it server-side (NULL for Suspense — never invented), writes the pending payment, its allocation INTENT and any custody activities in ONE transaction, and creates no allocation. There is no client-name parameter on purpose. received_in is always NULL and the five legacy cash columns are left NULL — the custody trail is an append-only event log now (20261014000000 §2), and whether one applies is decided by the payment mode server-side. Payment mode must be one of the four current accounts. 20261014000000.';

revoke execute on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb)
  from public, anon;
grant execute on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §5. edit_payment_request — correcting a request without erasing its trail
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Restated from 20261013000000 §8 with the same three changes as §4, and one
-- more that matters most:
--
--   IT NO LONGER CLEARS THE LEGACY CASH COLUMNS. 20261013000000 wrote all five
--   on every save, setting them to NULL whenever the mode was not Cash — so
--   correcting a request's mode DESTROYED the record of who had been holding the
--   money. Under a custody model that is precisely the forbidden behaviour:
--   changing a pending request away from PNB or Paytm must preserve its saved
--   activity as history. This function now leaves those columns exactly as it
--   found them, and adds new activities as events.
--
-- The lock ordering, the approved-race refusal, the permission rule, the
-- destination transitions, the intent reconciliation and all four post-conditions
-- are carried across verbatim.

drop function if exists public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, uuid, text, uuid, date, text);

create or replace function public.edit_payment_request(
  p_payment_request_id uuid,
  p_destination     text,
  p_target_id       uuid    default null,
  p_amount          numeric default null,
  p_payment_date    date    default null,
  p_payment_mode    text    default null,
  p_proof_note      text    default null,
  p_sales_note      text    default null,
  -- ── The custody activities to ADD ──
  --
  -- NOT THE WHOLE TRAIL, AND NOT A REPLACEMENT FOR IT. A correction may add what
  -- has happened since; it can never rewrite what was already recorded, because
  -- there is no code path anywhere that updates a custody event
  -- (20261014000000 §2's immutability trigger refuses one for every role).
  -- Removing an activity is therefore possible only while it is UNSAVED, in the
  -- browser, before it has ever been sent.
  p_custody_events  jsonb   default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_dest     text := btrim(lower(coalesce(p_destination, '')));
  v_mode     text := btrim(lower(coalesce(p_payment_mode, '')));
  v_req      public.finance_payment_requests%rowtype;
  v_sub      public.order_submissions%rowtype;
  v_ord      public.orders%rowtype;
  v_client   text;
  v_target_t text;
  v_custody  jsonb;
  v_is_admin boolean;
  v_status   text;
  v_intent   uuid;
  v_pending  numeric;
  v_active   numeric;
  v_n        int;
begin
  -- ── 1. Actor and module entry ──
  if v_actor is null then
    raise exception 'Authentication required to edit a payment request'
      using errcode = '28000';
  end if;

  if not public.module_entry_open('finance') then
    raise exception 'FINANCE_MODULE_CLOSED: the Finance module is not open to you.'
      using errcode = '42501';
  end if;

  -- ── 2. THE LOCK COMES BEFORE EVERY DECISION ──
  --
  -- Not a peek and then a lock: every rule below is read from the LOCKED row.
  -- approve_finance_payment_request takes the same lock on the same row before
  -- it re-reads the status, so an edit and an approval racing the same request
  -- serialize on this line. Whichever arrives second sees what the first
  -- committed and refuses by name — it cannot decide on a row it read earlier.
  select * into v_req
  from public.finance_payment_requests
  where id = p_payment_request_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: that payment request no longer exists.'
      using errcode = 'P0002';
  end if;

  -- ── 3. Approved money is not editable, and that is the race's answer ──
  if v_req.status in ('approved_linked', 'approved_unlinked') then
    raise exception
      'PAYMENT_ALREADY_APPROVED: payment % has been verified and can no longer be changed here.',
      v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.status not in ('pending_approval', 'needs_clarification', 'rejected') then
    raise exception 'PAYMENT_NOT_EDITABLE: payment % is % and cannot be corrected.',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- ── 4. The existing edit permission: the submitter, or an admin ──
  select exists (
    select 1 from public.users u where u.id = v_actor and u.role = 'admin'
  ) into v_is_admin;

  if not v_is_admin and v_req.submitted_by is distinct from v_actor then
    raise exception
      'PAYMENT_EDIT_NOT_PERMITTED: only the person who submitted this request, or an admin, may correct it.'
      using errcode = '42501';
  end if;

  -- ── 5. The shape of the correction ──
  if v_dest not in ('pi_draft', 'confirmed_order', 'suspense') then
    raise exception
      'PAYMENT_DESTINATION_INVALID: choose PI Draft, Confirmed Order or Suspense Entry.'
      using errcode = 'P0001';
  end if;

  if v_dest = 'suspense' then
    if p_target_id is not null then
      raise exception
        'PAYMENT_TARGET_FORBIDDEN: a Suspense Entry names no PI Draft and no Order.'
        using errcode = 'P0001';
    end if;
  elsif p_target_id is null then
    raise exception
      'PAYMENT_TARGET_REQUIRED: choose the PI Draft or Order this payment is for.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'PAYMENT_AMOUNT_INVALID: enter a positive amount in rupees and paise.'
      using errcode = 'P0001';
  end if;

  if p_payment_date is null then
    raise exception 'PAYMENT_DATE_REQUIRED: enter the date the payment was received.'
      using errcode = 'P0001';
  end if;

  -- THE FOUR CURRENT ACCOUNTS (20261014000000 §1). A correction may not put a
  -- retired mode back onto a payment; a row that already carries one and is
  -- corrected in some other respect keeps it, which is what
  -- finance_payment_requests_enforce_current_payment_mode allows and this agrees
  -- with — a legacy row is re-saved through the form under one of the four.
  if not public.payment_mode_is_current(v_mode) then
    raise exception
      'PAYMENT_MODE_INVALID: choose HDFC, PNB, Paytm or Canara.'
      using errcode = 'P0001';
  end if;

  -- ── 6. Resolve the target, and with it the customer ──
  --
  -- The SAME eligibility rules §3 applies at submission, applied again to the
  -- record that is being moved TO. A correction onto a converted PI or a
  -- cancelled Order is refused here rather than days later at approval.
  if v_dest = 'pi_draft' then
    select * into v_sub from public.order_submissions where id = p_target_id;
    if not found then
      raise exception 'PAYMENT_TARGET_NOT_FOUND: that PI Draft no longer exists.'
        using errcode = 'P0002';
    end if;
    if v_sub.status = 'rejected' then
      raise exception 'PAYMENT_TARGET_NOT_ACTIVE: a rejected PI Draft cannot receive a payment.'
        using errcode = 'P0001';
    end if;
    if v_sub.order_id is not null then
      raise exception
        'PAYMENT_TARGET_CONVERTED: that PI has been approved and is now an Order. Choose the Order instead.'
        using errcode = 'P0001';
    end if;
    v_client   := nullif(btrim(coalesce(v_sub.client_name, '')), '');
    v_target_t := 'pi_draft';
    if v_client is null then
      raise exception
        'PAYMENT_TARGET_NO_CLIENT: that PI Draft has no customer on file. Correct the PI before pointing a payment at it.'
        using errcode = 'P0001';
    end if;

  elsif v_dest = 'confirmed_order' then
    select * into v_ord from public.orders where id = p_target_id;
    if not found then
      raise exception 'PAYMENT_TARGET_NOT_FOUND: that Order no longer exists.'
        using errcode = 'P0002';
    end if;
    if v_ord.status = 'cancelled' then
      raise exception 'PAYMENT_TARGET_NOT_ACTIVE: Order % is cancelled and cannot receive a payment.',
        v_ord.display_number using errcode = 'P0001';
    end if;
    v_client   := nullif(btrim(coalesce(v_ord.client_name, '')), '');
    v_target_t := 'confirmed_order';
    if v_client is null then
      raise exception
        'PAYMENT_TARGET_NO_CLIENT: that Order has no customer on file. Correct it on the Order Details page first.'
        using errcode = 'P0001';
    end if;

  else
    -- SUSPENSE. The customer goes back to NULL, because the record it was read
    -- from is no longer this payment's destination. Keeping the old name would
    -- leave the payment claiming a customer it is no longer for.
    v_client   := null;
    v_target_t := null;
  end if;

  -- ── 7. Re-applying, exactly as the form did it ──
  --
  -- A submitter correcting a request that was sent back or rejected is
  -- resubmitting it. An ADMIN correcting somebody else's does not silently
  -- resubmit on their behalf — the same distinction the form drew.
  v_status := v_req.status;
  if v_req.status in ('needs_clarification', 'rejected')
     and v_req.submitted_by = v_actor then
    v_status := 'pending_approval';
  end if;

  -- ── 8. The payment row ──
  --
  -- WHAT IS DELIBERATELY ABSENT: order_id, order_number, order_request_id,
  -- order_request_number, received_in, submitted_by, request_number, approved_by
  -- and approved_at. The linkage columns are provenance since 20261012000000 and
  -- an edit does not start writing money into them; received_in has no form
  -- asking for it and nothing to fabricate; the rest are not a correction's to
  -- make.
  --
  -- AND THE FIVE LEGACY CASH COLUMNS (20261014000000 §2). 20261013000000 wrote
  -- them here, clearing all five whenever the mode was not Cash. That is exactly
  -- the behaviour a custody trail must not have: correcting a PNB request to
  -- Paytm, or to a bank account, would silently destroy the record of who had
  -- physically been holding the money. They are HISTORY now — read by the same
  -- trail component, written by nothing — so this leaves them precisely as it
  -- found them, and new activities go to finance_payment_custody_events.
  update public.finance_payment_requests
     set client_name              = v_client,
         amount                   = p_amount,
         payment_date             = p_payment_date,
         payment_mode             = v_mode,
         proof_note               = nullif(btrim(coalesce(p_proof_note, '')), ''),
         sales_note               = nullif(btrim(coalesce(p_sales_note, '')), ''),
         status                   = v_status,
         updated_at               = now()
   where id = p_payment_request_id;

  -- ── 9. The intent, reconciled in the same transaction ──
  --
  -- CANCEL FIRST, THEN PLACE. Cancelling every pending intent that is not the
  -- new target is what makes each transition below one rule rather than six:
  --
  --   PI → another PI          the old intent is cancelled, the new one placed
  --   PI → Confirmed Order     the old intent is cancelled, the new one placed
  --   Order → PI               the old intent is cancelled, the new one placed
  --   PI / Order → Suspense    every intent is cancelled, none is placed
  --   Suspense → PI / Order    there was none to cancel; one is placed
  --   Suspense → Suspense      nothing to cancel, nothing to place
  --   the SAME target again    nothing matches the cancel, the amount is
  --                            updated in place — so a repeated identical
  --                            correction is a no-op and leaves one row
  --
  -- CANCELLED, NOT DELETED. §6 already treats a cancelled intent as the audit
  -- record of an intention that did not happen; a correction is the same kind
  -- of event as a rejection and is kept the same way.
  update public.finance_payment_allocation_intents
     set status           = 'cancelled',
         cancelled_at     = now(),
         cancelled_reason = 'destination_changed'
   where payment_request_id = p_payment_request_id
     and status = 'pending'
     and (
       v_target_t is null
       or target_type is distinct from v_target_t
       or coalesce(order_submission_id, order_id) is distinct from p_target_id
     );

  if v_target_t is not null then
    -- The survivor, if the target did not change. The UPDATE re-fires the
    -- capacity trigger, which re-reads the payment amount THIS FUNCTION JUST
    -- WROTE — so lowering the amount below what is intended is refused here,
    -- by the rule that already owns that arithmetic.
    update public.finance_payment_allocation_intents
       set intended_amount = p_amount
     where payment_request_id = p_payment_request_id
       and status = 'pending'
       and target_type = v_target_t
       and coalesce(order_submission_id, order_id) = p_target_id
    returning id into v_intent;

    if v_intent is null then
      insert into public.finance_payment_allocation_intents
        (payment_request_id, target_type, order_submission_id, order_id,
         intended_amount, created_by)
      values
        (p_payment_request_id, v_target_t,
         case when v_target_t = 'pi_draft'        then p_target_id end,
         case when v_target_t = 'confirmed_order' then p_target_id end,
         p_amount, v_actor)
      returning id into v_intent;
    end if;
  end if;

  -- ── 10. Post-conditions, re-derived from the tables ──
  --
  -- Not a restatement of what the code above intended to do: a read of what it
  -- actually left behind. All three roll the whole correction back.
  select count(*) into v_n
  from public.finance_payment_allocation_intents
  where payment_request_id = p_payment_request_id and status = 'pending';

  if v_n > 1 then
    raise exception 'PAYMENT_EDIT_DUPLICATE_INTENT: this correction left % pending intents on one request', v_n
      using errcode = 'P0001';
  end if;
  if v_target_t is null and v_n <> 0 then
    raise exception 'PAYMENT_EDIT_SUSPENSE_INTENT: a Suspense Entry must hold no pending intent'
      using errcode = 'P0001';
  end if;
  if v_target_t is not null and v_n <> 1 then
    raise exception 'PAYMENT_EDIT_MISSING_INTENT: a targeted request must hold exactly one pending intent'
      using errcode = 'P0001';
  end if;

  -- AN EDIT ALLOCATES NOTHING. An unapproved payment has no active allocation
  -- before this runs and must have none after it; only approval converts.
  select coalesce(sum(a.allocated_amount), 0) into v_active
  from public.finance_payment_allocations a
  where a.payment_request_id = p_payment_request_id and a.status = 'active';

  if v_active <> 0 then
    raise exception
      'PAYMENT_EDIT_ALLOCATED: correcting a request must not attach money (found % allocated)', v_active
      using errcode = 'P0001';
  end if;

  select coalesce(sum(i.intended_amount), 0) into v_pending
  from public.finance_payment_allocation_intents i
  where i.payment_request_id = p_payment_request_id and i.status = 'pending';

  if v_pending > p_amount then
    raise exception
      'INTENT_EXCEEDS_PAYMENT: this request now intends % against an amount of %', v_pending, p_amount
      using errcode = 'P0001';
  end if;

  -- ── 11. The custody activities this correction ADDS ──
  --
  -- LAST, and after every post-condition, for the same reason the conversion is
  -- last in approval: the events describe the payment as it now stands, and the
  -- mode they are stamped with is the one this function has just written. A
  -- request corrected from PNB to Paytm stamps the new activities Paytm and
  -- leaves the earlier ones saying PNB, which is what actually happened.
  --
  -- A CORRECTION AWAY FROM PNB/PAYTM IS NOT AN ERROR AND DELETES NOTHING. The
  -- internal door refuses new events on a mode nobody carries, so a form that
  -- still had rows in hand is told; the events already saved are untouched and
  -- stay visible as the history of a payment that used to be carried.
  if p_custody_events is not null and jsonb_typeof(p_custody_events) = 'array'
     and jsonb_array_length(p_custody_events) > 0 then
    v_custody := public.append_payment_custody_events_internal(
      p_payment_request_id, p_custody_events, v_actor);
  else
    v_custody := jsonb_build_object('appended', 0, 'requested', 0);
  end if;

  return jsonb_build_object(
    'payment_request_id', p_payment_request_id,
    'request_number',     v_req.request_number,
    'destination',        v_dest,
    'client_name',        v_client,
    'status',             v_status,
    'intent_id',          v_intent,
    'pending_intents',    v_n,
    'allocation_created', false,
    'custody_events',     v_custody
  );
end $$;

comment on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb) is
  'Corrects a pending payment request, destination included, moving the row and its allocation intent in one transaction. Locks the payment FIRST so an edit racing an approval serializes and the loser is told by name (PAYMENT_ALREADY_APPROVED). Re-derives the customer from the new target — there is no client-name parameter — and sets it NULL for Suspense. Cancels intents rather than deleting them, leaves exactly one pending intent for a targeted destination and none for Suspense, and creates no allocation. Permission is the existing one: the submitter, or an admin, while the request is unapproved. Since 20261014000000 it also APPENDS custody activities — never rewriting one — and leaves the five legacy cash columns exactly as it found them, so a mode correction cannot destroy the record of who was carrying the money.';

revoke execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)
  from public, anon;
grant execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §6. record_payment_with_allocations — the four modes, and the custody trail
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Restated from 20261013000000 §7 with the mode domain replaced and one
-- parameter added. The permission gates, the destination-pair validation, the
-- allocation-list shape checks, the atomic write through
-- allocate_payment_to_target_internal, the derived customer, the PI activity
-- entries and the result shape are carried across unchanged.

drop function if exists public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb);

create or replace function public.record_payment_with_allocations(
  p_amount       numeric,
  p_payment_date date,
  p_payment_mode text,
  p_client_name  text,
  p_received_in  text    default null,
  p_reference    text    default null,
  p_remarks      text    default null,
  p_allocations  jsonb   default '[]'::jsonb,
  -- ── The custody activities recorded with this entry (20261014000000 §2) ──
  -- Appended in the same transaction, refused for any mode nobody carries.
  p_custody_events jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_client     text;
  v_mode       text;
  v_received   text;
  v_reference  text;
  v_remarks    text;
  v_payment_id uuid;
  v_number     text;
  v_count      integer;
  v_index      integer := 0;
  v_row        jsonb;
  v_kind       text;
  v_target     uuid;
  v_share      numeric;
  v_sum        numeric := 0;
  v_alloc      jsonb;
  v_results    jsonb := '[]'::jsonb;
  v_custody    jsonb;
begin
  -- ── 1. Authorization, before anything is read or written ──
  --
  -- TWO GATES, BOTH REQUIRED, BECAUSE THIS DOOR DOES TWO THINGS.
  --
  --   finance module entry  is what the RESTRICTIVE gate on
  --     finance_payment_requests demands of every write to that table
  --     (20260919000000 §2). A SECURITY DEFINER function bypasses RLS, so the
  --     gate is asked here explicitly rather than being silently skipped —
  --     this must not become a way around the policy the form obeys.
  --
  --   finance.allocate      is the protected action registered for allocating
  --     money (20260918000000), and it is what allocate_payment_to_target()
  --     requires of the person doing this after the fact. Entering the same
  --     allocations a minute earlier is the same act and needs the same
  --     authority. Wider Finance sight — finance.view, finance.view_all,
  --     finance.approve — reaches this line and is refused.
  --
  -- A person who may record a payment but not allocate one still has the
  -- Finance entry form, which is untouched. Nothing is taken away here.
  if not public.module_entry_open('finance') then
    raise exception 'PAYMENT_ENTRY_NOT_PERMITTED: you do not have access to Finance.'
      using errcode = '42501';
  end if;

  if not public.actor_has_module_permission('finance', 'allocate') then
    raise exception
      'PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED: you do not have permission to allocate payments.'
      using errcode = '42501';
  end if;

  -- ── 2. The payment-level facts ──
  --
  -- The same three mandatory fields the PI door requires, validated with the
  -- same rules and the same messages, plus the client the money is attributed
  -- to. A multi-destination payment has no single record to derive a client
  -- from — that is the whole point of it — so the payer is stated.
  if p_amount is null
     or p_amount = 'NaN'::numeric
     or p_amount <= 0
     or p_amount <> round(p_amount, 2)
  then
    raise exception
      'PAYMENT_AMOUNT_INVALID: the amount received must be a positive figure in rupees and paise.'
      using errcode = 'P0001';
  end if;

  if p_payment_date is null then
    raise exception 'PAYMENT_DATE_REQUIRED: a payment date is required.'
      using errcode = 'P0001';
  end if;

  -- Bounded rather than exact, for the same reason 20260919000000 bounds it:
  -- the browser's clock and the server's need not agree to the second.
  if p_payment_date > (now() at time zone 'utc')::date + 1 then
    raise exception 'PAYMENT_DATE_FUTURE: a payment date cannot be in the future.'
      using errcode = 'P0001';
  end if;

  -- THE FOUR CURRENT ACCOUNTS (20261014000000 §1), the same four every other
  -- entry door offers. The five legacy values stay storable for history and are
  -- refused for a new entry here and again by
  -- finance_payment_requests_enforce_current_payment_mode.
  v_mode := nullif(btrim(lower(coalesce(p_payment_mode, ''))), '');
  if v_mode is null or not public.payment_mode_is_current(v_mode) then
    raise exception
      'PAYMENT_MODE_INVALID: choose one of HDFC, PNB, Paytm or Canara.'
      using errcode = 'P0001';
  end if;

  -- The EXISTING closed domain, and NULL still means "not stated" (20260919000000
  -- §1). A value outside it is refused here rather than surfacing as a raw check
  -- violation.
  v_received := nullif(btrim(lower(coalesce(p_received_in, ''))), '');
  if v_received is not null
     and v_received not in ('company_account', 'cash_in_hand', 'savings_account', 'other')
  then
    raise exception
      'PAYMENT_DESTINATION_INVALID: choose one of Company Account, Cash in Hand, Savings Account or Other.'
      using errcode = 'P0001';
  end if;

  -- ── THE CUSTOMER IS DERIVED, NEVER TYPED (20261013000000) ──
  --
  -- p_client_name is IGNORED. It stays in the signature so no caller breaks,
  -- and its value is discarded so no caller can steer what this row says about
  -- whose money it is. The name comes from the targets, resolved below, after
  -- the allocation list has been validated — a name derived from a target that
  -- turns out to be ineligible would be a name attached to a payment that never
  -- gets written.
  --
  -- A payment with no allocations is a Suspense entry: no target, therefore no
  -- customer, therefore NULL. That is what §1 of 20261013000000 made storable,
  -- and it replaces the PAYMENT_CLIENT_REQUIRED refusal that used to stand here
  -- and force somebody to type something.
  v_client := null;

  v_reference := nullif(btrim(coalesce(p_reference, '')), '');
  v_remarks   := nullif(btrim(coalesce(p_remarks, '')), '');

  -- ── 3. The SHAPE of the allocation list, before a single row is written ──
  --
  -- Every structural complaint is raised here, so a malformed list costs no
  -- payment row and no rollback: the caller learns the list is wrong before
  -- anything at all has happened.
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception
      'PAYMENT_ALLOCATIONS_INVALID: the allocation list must be an array.'
      using errcode = 'P0001';
  end if;

  v_count := jsonb_array_length(p_allocations);

  -- A BOUND, so one request cannot take an unbounded number of row locks. Twenty
  -- destinations is far beyond any real payment and well short of anything that
  -- would hold the cycle or the payment lock long enough to matter.
  if v_count > 20 then
    raise exception
      'PAYMENT_ALLOCATIONS_TOO_MANY: a payment may be divided at most 20 ways in one entry.'
      using errcode = 'P0001';
  end if;

  for v_row in select jsonb_array_elements(p_allocations) loop
    v_index := v_index + 1;

    if jsonb_typeof(v_row) <> 'object' then
      raise exception
        'PAYMENT_ALLOCATION_ROW_INVALID: row % is not an allocation.', v_index
        using errcode = 'P0001';
    end if;

    v_kind := nullif(btrim(lower(coalesce(v_row->>'kind', ''))), '');
    if v_kind is null or v_kind not in ('order', 'submission') then
      raise exception
        'PAYMENT_ALLOCATION_KIND_INVALID: row % must name a Confirmed Order or a PI Draft.', v_index
        using errcode = 'P0001';
    end if;

    -- A malformed uuid is a malformed REQUEST, not a missing record: said in
    -- its own words so it is never mistaken for "that target is not available",
    -- which is what a caller sees when a real id is refused.
    begin
      v_target := (v_row->>'id')::uuid;
    exception when others then
      v_target := null;
    end;

    if v_target is null then
      raise exception
        'PAYMENT_ALLOCATION_TARGET_INVALID: row % does not name a record.', v_index
        using errcode = 'P0001';
    end if;

    -- Numeric parsing is likewise a shape question. round(,2) is asserted here
    -- as well as inside the allocator so the message names the ROW.
    begin
      v_share := (v_row->>'amount')::numeric;
    exception when others then
      v_share := null;
    end;

    if v_share is null
       or v_share = 'NaN'::numeric
       or v_share <= 0
       or v_share <> round(v_share, 2)
    then
      raise exception
        'PAYMENT_ALLOCATION_AMOUNT_INVALID: row % must allocate a positive amount in rupees and paise.',
        v_index
        using errcode = 'P0001';
    end if;

    v_sum := v_sum + v_share;
  end loop;

  -- THE WHOLE MAY NOT EXCEED THE PART IT COMES FROM. The allocator re-checks
  -- this under the payment lock for every row it writes and is the actual
  -- guarantee; this states it up front so the caller is told the total is wrong
  -- rather than being told the last row would not fit.
  if v_sum > p_amount then
    raise exception
      'PAYMENT_ALLOCATIONS_EXCEED_AMOUNT: % allocated is more than the % received.',
      v_sum, p_amount
      using errcode = 'P0001';
  end if;

  -- ── 4. The payment ──
  --
  -- NO DIRECT LINKAGE IS WRITTEN, on purpose. order_id and order_request_id are
  -- left NULL, so finance_payment_requests_derive_target (20260715000000)
  -- classifies the row as it classifies a PI payment, and the ALLOCATIONS are
  -- the only statement about where this money went. Under the canonical rule
  -- (PR #49) active allocations are authoritative and the direct link is only a
  -- fallback when there are none — so writing one here would be a second, weaker
  -- claim beside the true one.
  --
  -- request_number comes from the existing BEFORE INSERT trigger and the Finance
  -- activity row from the existing trigger. This function writes neither by hand.
  -- ── The display customer, from the targets themselves ──
  --
  -- THE RULE, stated once and asserted in the suite:
  --   no targets                    -> NULL   (a Suspense entry has no customer)
  --   every target, one customer    -> that customer
  --   targets naming two or more    -> NULL   (no single customer is the truth)
  --
  -- NULL for the mixed case rather than a summary string: "Multiple customers"
  -- is a sentence about a payment, not the name of a customer, and writing it
  -- into client_name would make it searchable as one and countable as one. The
  -- payment's allocations already name every customer individually, so nothing
  -- is lost — the application's shared formatter reads the allocation set and
  -- says "Multiple customers" at the point of display, where a sentence belongs.
  --
  -- The list has already been validated above, so every id here resolves.
  select case when count(distinct name) = 1 then min(name) end into v_client
  from (
    select nullif(btrim(coalesce(
             case when btrim(lower(t->>'kind')) = 'submission'
                  then (select s.client_name from public.order_submissions s
                         where s.id = (t->>'id')::uuid)
                  else (select o.client_name from public.orders o
                         where o.id = (t->>'id')::uuid)
             end, '')), '') as name
    from jsonb_array_elements(p_allocations) as t
  ) names
  where name is not null;

  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     status, submitted_by, sales_note, order_number)
  values
    (v_client, p_amount, p_payment_date, v_mode, v_received,
     'pending_approval', v_actor, v_remarks, v_reference)
  returning id, request_number into v_payment_id, v_number;

  -- ── 5. The allocations, each through the canonical door ──
  --
  -- In the order the caller listed them, so a refusal names the row the person
  -- is looking at. The FIRST failure aborts everything: there is no partial
  -- success to report and no state in which some of this payment landed.
  --
  -- A second row naming a target an earlier row already took is refused by the
  -- allocator as ALLOCATION_DUPLICATE — one active claim per payment per target
  -- is the model's rule, guaranteed by its partial unique indexes, and this
  -- inherits it rather than deciding a different answer.
  v_index := 0;
  for v_row in select jsonb_array_elements(p_allocations) loop
    v_index := v_index + 1;
    v_kind   := btrim(lower(v_row->>'kind'));
    v_target := (v_row->>'id')::uuid;
    v_share  := (v_row->>'amount')::numeric;

    v_alloc := public.allocate_payment_to_target_internal(
      p_payment_request_id  => v_payment_id,
      p_order_submission_id => case when v_kind = 'submission' then v_target end,
      p_order_id            => case when v_kind = 'order'      then v_target end,
      p_allocated_amount    => v_share
    );

    -- ── 5a. The PI's own timeline, for a PI destination ──
    --
    -- The same event record_pi_submission_payment() writes, for the same reason:
    -- somebody reading a PI Draft's history must see that money arrived against
    -- it, whichever door recorded it. An Order destination needs no counterpart —
    -- the Finance activity trigger already logged the payment, and the Order
    -- screen reads its allocations directly.
    if v_kind = 'submission' then
      perform public.log_order_submission_activity(
        v_target, v_actor, 'payment_recorded',
        (select s.status from public.order_submissions s where s.id = v_target),
        (select s.status from public.order_submissions s where s.id = v_target),
        null,
        jsonb_build_object(
          'payment_request_id', v_payment_id,
          'request_number',     v_number,
          'amount',             v_share,
          'payment_amount',     p_amount,
          'payment_mode',       v_mode,
          'payment_status',     'pending_approval',
          'allocation_id',      v_alloc->>'allocation_id',
          'split_entry',        true
        )
      );
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row',              v_index,
      'kind',             v_kind,
      'target_id',        v_target,
      'allocation_id',    v_alloc->>'allocation_id',
      'allocated_amount', v_share
    ));
  end loop;

  -- ── 5b. The custody trail, in the same transaction ──
  --
  -- After the allocations, so a refusal here rolls back a complete entry rather
  -- than half of one. Authorization is already settled above — this caller holds
  -- Finance entry AND finance.allocate — so the internal door is called rather
  -- than the standalone one.
  if p_custody_events is not null and jsonb_typeof(p_custody_events) = 'array'
     and jsonb_array_length(p_custody_events) > 0 then
    v_custody := public.append_payment_custody_events_internal(
      v_payment_id, p_custody_events, v_actor);
  else
    v_custody := jsonb_build_object('appended', 0, 'requested', 0);
  end if;

  -- ── 6. What the screen needs, and nothing it could not already read ──
  return jsonb_build_object(
    'payment_request_id',  v_payment_id,
    'request_number',      v_number,
    'amount',              p_amount,
    'payment_date',        p_payment_date,
    'payment_mode',        v_mode,
    'status',              'pending_approval',
    'allocation_count',    v_count,
    'allocated_total',     v_sum,
    'unallocated_balance', p_amount - v_sum,
    'allocations',         v_results,
    'custody_events',      v_custody
  );
end;
$$;

comment on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb) is
  'Records one payment and divides it across PI Drafts and Confirmed Orders in a single transaction. Since 20261013000000 the customer is DERIVED from the targets — one distinct customer becomes the stored name, no targets or several distinct customers store NULL — and p_client_name is ignored. received_in stays optional and is never fabricated. Since 20261014000000 the payment mode must be one of the four current accounts, and custody activities are appended in the same transaction.';

revoke execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb)
  to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §7. record_pi_submission_payment — Order Management asks the same four
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Restated VERBATIM from 20260919000000 with ONE expression changed: the payment
-- mode domain. Signature, return type, SECURITY DEFINER marker, search_path,
-- authorization branches, lock order, PI eligibility rules, the derived client
-- name, the full-amount allocation, the activity entry and the result shape are
-- all exactly as they were.
--
-- WHY IT HAD TO CHANGE AT ALL. This is the fourth door into
-- finance_payment_requests, and it validated the five legacy values. Left alone
-- it would refuse every one of the four modes the product now offers, so the PI
-- payment card would have stopped working the moment the form was updated.
--
-- NO CUSTODY TRAIL HERE, DELIBERATELY. The trail belongs to the two payment-entry
-- forms that ask for it (§4, §6). A PNB or Paytm payment recorded from a PI can
-- still have its trail filled in afterwards through append_payment_custody_events,
-- which is the same door "record the handover later" already uses.

create or replace function public.record_pi_submission_payment(
  p_submission_id   uuid,
  p_amount          numeric,
  p_payment_date    date,
  p_payment_mode    text,
  p_reference       text default null,
  p_remarks         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_client     text;
  v_mode       text;
  v_reference  text;
  v_remarks    text;
  v_payment_id uuid;
  v_number     text;
  v_alloc      jsonb;
begin
  -- ── 1. The shape of the request, before anything is locked ──
  --
  -- The three mandatory fields, and only those. Reference, remark and proof are
  -- optional by product decision; received_in is optional by §1.
  if p_amount is null
     or p_amount = 'NaN'::numeric
     or p_amount <= 0
     or p_amount <> round(p_amount, 2)
  then
    raise exception
      'PAYMENT_AMOUNT_INVALID: the amount received must be a positive figure in rupees and paise.'
      using errcode = 'P0001';
  end if;

  if p_payment_date is null then
    raise exception 'PAYMENT_DATE_REQUIRED: a payment date is required.'
      using errcode = 'P0001';
  end if;

  -- A payment cannot have been received in the future. Bounded rather than
  -- exact: the client's clock and the server's need not agree to the second.
  if p_payment_date > (now() at time zone 'utc')::date + 1 then
    raise exception 'PAYMENT_DATE_FUTURE: a payment date cannot be in the future.'
      using errcode = 'P0001';
  end if;

  -- THE FOUR CURRENT ACCOUNTS (20261014000000 §1), the same four the two Finance
  -- entry doors offer — Order Management and Finance ask this question once, and
  -- a PI payment recorded from the Orders module is the same kind of entry.
  -- Re-derived here so a client cannot send a value the table's own CHECK, or
  -- finance_payment_requests_enforce_current_payment_mode, would then reject with
  -- a constraint error.
  v_mode := nullif(btrim(lower(coalesce(p_payment_mode, ''))), '');
  if v_mode is null or not public.payment_mode_is_current(v_mode) then
    raise exception
      'PAYMENT_MODE_INVALID: choose one of HDFC, PNB, Paytm or Canara.'
      using errcode = 'P0001';
  end if;

  v_reference := nullif(btrim(coalesce(p_reference, '')), '');
  v_remarks   := nullif(btrim(coalesce(p_remarks, '')), '');

  -- ── 2. The PI, locked before its state is judged ──
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: that PI no longer exists'
      using errcode = 'P0002';
  end if;

  -- ── 3. Authorization ──
  --
  -- Three routes, and the RPC is the only place they are combined:
  --   * an active admin, through the project's established bypass;
  --   * the PI's own people — whoever uploaded it, created it, or is named as
  --     its reviewer. This is can_view_order_submission's rule minus its
  --     finance-verifier branch, which is deliberate: verifying figures is not
  --     the same authority as recording that money arrived;
  --   * an explicit finance.allocate holder, which is the protected action
  --     Phase 1 registered for exactly this.
  --
  -- Wider Finance access alone is NOT a route. finance.view, finance.approve and
  -- finance.view_all reach this line and are refused, so nobody acquires payment
  -- ENTRY against a PI as a side effect of being able to see or verify payments.
  -- COALESCED TO false, AND THAT IS NOT DECORATION. assigned_to is nullable, so
  -- `v_sub.assigned_to = v_actor` is NULL whenever a PI has no named reviewer —
  -- which is the common case — and `false or false or false or NULL` is NULL, not
  -- false. `if not NULL` does not fire, so without this coalesce the whole check
  -- would silently pass for EVERY unrelated caller on any PI with no reviewer.
  -- Three-valued logic, in an authorization branch, failing open.
  if not coalesce(
    public.actor_has_module_permission('finance', 'allocate')
    or v_sub.submitted_by = v_actor
    or v_sub.created_by   = v_actor
    or v_sub.assigned_to  = v_actor
  , false) then
    raise exception
      'PI_PAYMENT_NOT_PERMITTED: you do not have permission to record a payment against this PI.'
      using errcode = '42501';
  end if;

  -- ── 4. The PI must still be a PI ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot receive a payment'
      using errcode = '55P03';
  end if;

  -- Once a PI has become an Order the money belongs to the Order, and the
  -- existing Finance route records it there. Two ways of saying the same thing
  -- would let one PI's payments land on both sides of its own approval.
  if v_sub.status = 'approved' or v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_CONVERTED: this PI has been approved and is now an Order. Record the payment against the Order instead.'
      using errcode = 'P0001';
  end if;

  if v_sub.status = 'rejected' then
    raise exception
      'ORDER_SUBMISSION_REJECTED: a rejected PI cannot receive a payment.'
      using errcode = 'P0001';
  end if;

  -- Draft, submitted and needs_changes all remain open, which is the confirmed
  -- rule: money arrives when the customer sends it, not when review reaches a
  -- particular stage.

  -- ── 5. The client is the PI's, never the caller's ──
  v_client := nullif(btrim(coalesce(v_sub.client_name, '')), '');
  if v_client is null then
    raise exception
      'ORDER_SUBMISSION_NO_CLIENT: this PI has no client name on file, so a payment cannot be attributed.'
      using errcode = 'P0001';
  end if;

  -- ── 6. The payment ──
  --
  -- payment_against / payment_target_type are left to
  -- finance_payment_requests_derive_target (20260715000000), which sees no
  -- order_id and no order_request_id and derives 'new_order' / 'unallocated'.
  -- That is the truthful classification: at this moment the money is attached to
  -- no Confirmed Order and no Order Request. Which PI it belongs to is the
  -- ALLOCATION's job, which is the whole reason Phase 1 exists.
  --
  -- received_in is omitted entirely — see §1.
  -- status is 'pending_approval', the column default and the status the product
  -- shows as Awaiting Verification. Finance decides from here, unchanged.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, status, submitted_by, sales_note, order_number)
  values
    (v_client, p_amount, p_payment_date, v_mode, 'pending_approval', v_actor, v_remarks, v_reference)
  returning id, request_number into v_payment_id, v_number;

  -- ── 7. The allocation, through Phase 1's own door ──
  --
  -- Allocated IN FULL to this PI. Splitting is not part of this phase, so there
  -- is no parameter for a partial figure and no way for a caller to request one.
  --
  -- If this raises — an ineligible target, a capacity failure, a lost race — the
  -- whole transaction rolls back and the payment above never existed. That is the
  -- atomicity guarantee, and it is structural rather than compensating: there is
  -- no catch, no cleanup path, and no state in which one row survives the other.
  v_alloc := public.allocate_payment_to_target_internal(
    p_payment_request_id  => v_payment_id,
    p_order_submission_id => p_submission_id,
    p_order_id            => null,
    p_allocated_amount    => p_amount
  );

  -- ── 8. One concise PI event ──
  --
  -- The amount and the status, and no more: the payment card carries the detail,
  -- and the Finance activity log carries the full trail. Recorded against the
  -- PI's CURRENT status on both sides, because recording a payment does not move
  -- the PI through review.
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'payment_recorded', v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'payment_request_id', v_payment_id,
      'request_number',     v_number,
      'amount',             p_amount,
      'payment_mode',       v_mode,
      'payment_status',     'pending_approval',
      'allocation_id',      v_alloc->>'allocation_id'
    )
  );

  -- ── 9. What the screen needs, and nothing it could not already read ──
  return jsonb_build_object(
    'payment_request_id', v_payment_id,
    'request_number',     v_number,
    'allocation_id',      v_alloc->>'allocation_id',
    'amount',             p_amount,
    'payment_date',       p_payment_date,
    'payment_mode',       v_mode,
    'status',             'pending_approval'
  );
end;
$$;

comment on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text) is
  'Records ONE payment against a PI submission and allocates it in full to that PI, in a single transaction — both rows or neither. Requires only amount, date and mode. The actor, the client name, the status and the allocation are server-derived and cannot be supplied. Permitted for an admin, the PI''s own uploader/creator/reviewer, or an explicit finance.allocate holder; wider Finance access alone is not a route. Creates a pending_approval payment: it asserts that money was reported, never that it was verified. Since 20261014000000 the payment mode must be one of the four current accounts.';

revoke execute on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text) from public, anon;
grant  execute on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §8. finance_payment_destinations — which record a payment is FOR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE FIX FOR THE CONFIRMED-ORDER DISPLAY DEFECT, stated as one projection so no
-- screen has to assemble the answer itself and no two screens can assemble it
-- differently.
--
-- ── THE SOURCE RULE, in three lines ─────────────────────────────────────────
--
--     any ACTIVE allocation         -> the destination is what those allocations name
--     otherwise, any PENDING intent -> the destination is what those intents name
--     otherwise                     -> Suspense / Unallocated
--
-- ALLOCATIONS TAKE PRECEDENCE, ALWAYS, and that single ordering is what makes
-- every required case fall out rather than needing a branch of its own:
--
--   * a PENDING request written by submit_payment_request has an intent and no
--     allocation, so it shows the PI Draft or Confirmed Order somebody chose —
--     BEFORE Finance approves, which is what the form promised;
--   * a PENDING payment written by record_payment_with_allocations has real
--     active allocations already (that door allocates as it records) and no
--     intent, so it shows them;
--   * an APPROVED request shows its allocations, because approval converted the
--     intent — its status is 'applied', so it is no longer pending and cannot
--     compete;
--   * REVERSING or removing the last active allocation of an approved payment
--     leaves no active allocation and no pending intent, so the payment reads
--     Suspense / Unallocated IMMEDIATELY. There is no stale 'linked' state to
--     clean up, because there was never a stored one;
--   * a SUSPENSE entry has neither, and says so.
--
-- ── WHY PROVENANCE IS NOT WRITTEN AT APPROVAL ───────────────────────────────
--
-- The smaller diff would have been to set order_id, order_number and
-- payment_target_type inside approve_finance_payment_request once the conversion
-- produced an Order allocation, leaving every existing reader alone. It is
-- refused, for three specific reasons and not as a matter of taste:
--
--   1. IT CANNOT SURVIVE A REVERSAL. finance_payment_allocations is reversible by
--      design — reverse_payment_allocation exists and Allocate Funds uses it —
--      and finance_payment_requests_guard_approved freezes an approved row's
--      columns. A payment whose only Order allocation was reversed would keep
--      saying approved_linked, with an Order number, forever: a stored claim of
--      linkage the ledger no longer supports. That is the exact class of defect
--      20261012000000 was written to end, reintroduced one migration later.
--
--   2. IT CANNOT NAME A SPLIT. order_id and order_number hold ONE Order. A
--      payment allocated across two Orders, or across an Order and a PI Draft,
--      would have to pick one and print it as though it were the whole truth —
--      precisely the "misleading single Order Number" this change exists to
--      prevent. The projection answers `mixed` instead, and WITHHOLDS the number
--      rather than choosing a winner.
--
--   3. IT WOULD MAKE order_id LOAD-BEARING AGAIN. The moment approval writes it,
--      something will read it, and the direct-link model 20261012000000 removed
--      is back in fact if not in name. Leaving it as dead provenance is what
--      keeps that impossible.
--
-- The projection has none of those problems because it stores nothing: it is
-- re-derived on every read, from the two tables that actually hold the answer.
-- approve_finance_payment_request is therefore NOT redefined by this migration.
--
-- ── WHAT THIS VIEW IS NOT ───────────────────────────────────────────────────
--
-- IT CARRIES NO MONEY. Not an amount, not a total, not a balance, not a
-- percentage. It names records and counts them. §9f reads the column list back
-- from the catalogue and refuses to install a version that grew a money column,
-- because the moment a rupee appears here there are two places to add up a
-- payment and 20261012000000's guarantee becomes a coincidence.
--
-- The fully-allocated / partially-allocated question is ALREADY answered, from
-- the ledger alone, by finance_received_payments.allocation_state and
-- confirmed_allocation_status. This does not re-derive it, and the application
-- keeps reading it from there.
--
-- IT IS NOT ADDED TO finance_received_payments. That projection is left exactly
-- as 20261012000000 wrote it — this migration does not redefine it — so its
-- financial columns provably still read finance_payment_allocations and nothing
-- else, and 20261013000000 §9c's "INTENT LEAKED INTO THE PROJECTION" assertion
-- stays true on a replay. Both Finance surfaces read this view alongside their
-- existing list query, by payment id, in one bounded second request per page —
-- the pattern Received Payments already uses for its target labels.
--
-- SECURITY_INVOKER, like every projection in this module: every underlying
-- policy is evaluated as the caller, so it can show nothing the base tables
-- would not. A destination record the caller may not read yields a NULL
-- reference rather than hiding the payment — "not visible to you" is a different
-- fact from "there is no destination", and the application says so.

create or replace view public.finance_payment_destinations
with (security_invoker = true) as
select
  f.id as payment_request_id,

  -- WHERE THE ANSWER CAME FROM. Not shown to anybody; read by the tests, and by
  -- the next person trying to understand why a row says what it says.
  coalesce(d.src, 'none') as destination_source,

  -- THE KIND, and the ONLY place 'mixed' is decided.
  --
  -- Anything that is not exactly one Order or exactly one PI Draft is `mixed`,
  -- INCLUDING two Orders and no PI. That is deliberate: "two Orders" cannot be
  -- rendered as an Order Number either, and a reader shown one of them is
  -- misinformed in exactly the same way as a reader shown one half of an
  -- Order/PI split.
  case
    when coalesce(d.order_count, 0) = 1 and coalesce(d.submission_count, 0) = 0
      then 'confirmed_order'
    when coalesce(d.order_count, 0) = 0 and coalesce(d.submission_count, 0) = 1
      then 'pi_draft'
    when coalesce(d.order_count, 0) + coalesce(d.submission_count, 0) = 0
      then 'suspense'
    else 'mixed'
  end as destination_kind,

  coalesce(d.order_count, 0)::integer      as destination_order_count,
  coalesce(d.submission_count, 0)::integer as destination_submission_count,

  -- HOW MANY DISTINCT CUSTOMERS the destination records name. client_name on the
  -- payment is NULL when its targets name more than one (20261013000000 §7), and
  -- this is what lets the shared formatter say "Multiple customers" at the point
  -- of display instead of printing a blank.
  coalesce(d.customer_count, 0)::integer   as destination_customer_count,

  -- ── THE SINGLE-TARGET IDENTIFIERS, WITHHELD UNLESS THEY ARE THE WHOLE TRUTH ──
  --
  -- Populated ONLY when the kind is that exact single kind. A mixed destination
  -- returns NULL here, which is what forces every reader to render the mixed
  -- label rather than quietly falling back to "the first Order we found".
  case
    when coalesce(d.order_count, 0) = 1 and coalesce(d.submission_count, 0) = 0
      then d.one_order_id
  end as destination_order_id,

  case
    when coalesce(d.order_count, 0) = 1 and coalesce(d.submission_count, 0) = 0
      then o.display_number
  end as destination_order_number,

  case
    when coalesce(d.order_count, 0) = 0 and coalesce(d.submission_count, 0) = 1
      then d.one_submission_id
  end as destination_submission_id,

  -- HOW THE RECORD IDENTIFIES ITSELF, in the words the person recognises: an
  -- Order's number, or a PI's own source number / workbook name — the same two
  -- fields every PI picker in this module shows.
  case
    when coalesce(d.order_count, 0) = 1 and coalesce(d.submission_count, 0) = 0
      then o.display_number
    when coalesce(d.order_count, 0) = 0 and coalesce(d.submission_count, 0) = 1
      then coalesce(
             nullif(btrim(coalesce(s.source_order_number, '')), ''),
             nullif(btrim(coalesce(s.source_workbook_name, '')), '')
           )
  end as destination_reference

from public.finance_payment_requests f

-- ── The one answer, chosen inside the union rather than after it ────────────
--
-- The intent branch carries `not exists (any active allocation)`, so the two
-- sources are MUTUALLY EXCLUSIVE by construction: at most one `src` group can
-- ever be produced, the GROUP BY yields at most one row, and there is no
-- precedence rule left to get wrong anywhere else in this view.
left join lateral (
  select
    r.src,
    count(distinct r.order_id)                                    as order_count,
    count(distinct r.order_submission_id)                         as submission_count,
    count(distinct r.client_name)                                 as customer_count,
    (array_agg(distinct r.order_id)
       filter (where r.order_id is not null))[1]                  as one_order_id,
    (array_agg(distinct r.order_submission_id)
       filter (where r.order_submission_id is not null))[1]       as one_submission_id
  from (
    -- ACTIVE ALLOCATIONS — what the money is actually attributed to.
    select
      'allocation'::text as src,
      a.order_id,
      a.order_submission_id,
      nullif(btrim(coalesce(ao.client_name, asub.client_name, '')), '') as client_name
    from public.finance_payment_allocations a
    left join public.orders            ao   on ao.id   = a.order_id
    left join public.order_submissions asub on asub.id = a.order_submission_id
    where a.payment_request_id = f.id
      and a.status = 'active'

    union all

    -- PENDING INTENTS — what an unverified request says it is for, and ONLY
    -- while nothing has been allocated yet.
    select
      'intent'::text,
      i.order_id,
      i.order_submission_id,
      nullif(btrim(coalesce(io_.client_name, isub.client_name, '')), '')
    from public.finance_payment_allocation_intents i
    left join public.orders            io_  on io_.id  = i.order_id
    left join public.order_submissions isub on isub.id = i.order_submission_id
    where i.payment_request_id = f.id
      and i.status = 'pending'
      and not exists (
        select 1
        from public.finance_payment_allocations a2
        where a2.payment_request_id = f.id
          and a2.status = 'active'
      )
  ) r
  group by r.src
) d on true

-- The named record, for its number.
left join public.orders            o on o.id = d.one_order_id
left join public.order_submissions s on s.id = d.one_submission_id;

comment on view public.finance_payment_destinations is
  'WHICH RECORD a payment is for, derived on every read from ACTIVE finance_payment_allocations first and PENDING finance_payment_allocation_intents second, and from nothing else — never from order_id, order_number, order_request_id, payment_against or payment_target_type, which have been provenance since 20261012000000. Carries NO money: it names and counts records, and the allocated/partial/full question stays with finance_received_payments.allocation_state. A destination that is not exactly one Order or exactly one PI Draft reads ''mixed'' and withholds the identifiers, so no screen can print one arbitrary Order Number for a split payment. SECURITY INVOKER. 20261014000000.';

revoke all privileges on public.finance_payment_destinations from public, anon, authenticated;
grant select on public.finance_payment_destinations to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §9. Apply-time assertions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Read back from the catalogue, not from this file: what matters is what the
-- database ended up holding. Every one of them runs on the production push, in
-- the same transaction as the statements above, so a migration that half-applied
-- its intent does not commit.

do $$
declare
  v_def  text;
  v_name text;
  v_n    int;
  v_col  text;
begin
  -- ═════════════════════════════════════════════════════════════════════════
  -- 9a. THE PAYMENT-MODE DOMAIN IS VERSIONED, NOT REPLACED
  -- ═════════════════════════════════════════════════════════════════════════
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.finance_payment_requests'::regclass
    and c.conname = 'finance_payment_requests_payment_mode_current_or_legacy';

  if v_def is null then
    raise exception 'the versioned payment_mode CHECK was not installed';
  end if;

  -- THE FOUR CURRENT VALUES, each named.
  foreach v_name in array array['hdfc', 'pnb', 'paytm', 'canara'] loop
    if position('''' || v_name || '''' in v_def) = 0 then
      raise exception 'the payment_mode CHECK does not accept the current mode %', v_name;
    end if;
  end loop;

  -- AND THE FIVE LEGACY ONES, WHICH IS THE WHOLE COMPATIBILITY DECISION. If a
  -- later revision drops them from the CHECK, every historical row becomes
  -- un-updatable and this is where that is caught.
  foreach v_name in array array['bank_transfer', 'cash', 'upi', 'cheque', 'other'] loop
    if position('''' || v_name || '''' in v_def) = 0 then
      raise exception
        'the payment_mode CHECK dropped the legacy value % — historical rows must stay storable and readable', v_name;
    end if;
  end loop;

  -- The old five-value constraint must be GONE, or the four new modes are
  -- refused by a constraint nobody looked at.
  select count(*) into v_n
  from pg_constraint c
  where c.conrelid = 'public.finance_payment_requests'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%payment_mode%'
    and c.conname <> 'finance_payment_requests_payment_mode_current_or_legacy';
  if v_n <> 0 then
    raise exception 'a second payment_mode CHECK survived (% of them) — the four current modes would be refused by it', v_n;
  end if;

  -- THE FOUR, AS A FUNCTION, and the two that carry a custody trail.
  if not (public.payment_mode_is_current('hdfc')
          and public.payment_mode_is_current('pnb')
          and public.payment_mode_is_current('paytm')
          and public.payment_mode_is_current('canara')) then
    raise exception 'payment_mode_is_current does not accept all four current modes';
  end if;
  foreach v_name in array array['bank_transfer', 'cash', 'upi', 'cheque', 'other', '', 'card'] loop
    if public.payment_mode_is_current(v_name) then
      raise exception 'payment_mode_is_current accepts %, which is not one of the four', v_name;
    end if;
  end loop;
  if public.payment_mode_is_current(null) then
    raise exception 'payment_mode_is_current accepts NULL';
  end if;

  if not (public.payment_mode_requires_custody('pnb')
          and public.payment_mode_requires_custody('paytm')) then
    raise exception 'the custody rule must apply to pnb and paytm';
  end if;
  foreach v_name in array array['hdfc', 'canara', 'cash', 'bank_transfer', 'other'] loop
    if public.payment_mode_requires_custody(v_name) then
      raise exception 'the custody rule must NOT apply to %', v_name;
    end if;
  end loop;

  -- THE ENTRY RESTRICTION IS A TRIGGER, on both INSERT and UPDATE.
  select count(*) into v_n
  from pg_trigger t
  where t.tgrelid = 'public.finance_payment_requests'::regclass
    and t.tgname = 'finance_payment_requests_enforce_current_payment_mode'
    and not t.tgisinternal;
  if v_n <> 1 then
    raise exception 'the current-payment-mode trigger is not installed';
  end if;

  select pg_get_functiondef('public.finance_payment_requests_enforce_current_payment_mode()'::regprocedure)
    into v_def;
  if v_def !~* 'tg_op\s*=\s*''INSERT''' then
    raise exception 'the payment-mode trigger must judge an INSERT';
  end if;
  if v_def !~* 'is distinct from old\.payment_mode' then
    raise exception
      'the payment-mode trigger must judge only a CHANGE on UPDATE — otherwise every correction of a historical row is refused';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 9b. THE CUSTODY TABLE HAS THE SHAPE THE MODEL NEEDS
  -- ═════════════════════════════════════════════════════════════════════════
  if to_regclass('public.finance_payment_custody_events') is null then
    raise exception 'finance_payment_custody_events was not created';
  end if;

  foreach v_name in array array[
    'id', 'payment_request_id', 'activity_type', 'occurred_at',
    'collected_by_user_id', 'handed_by_user_id', 'handed_to_user_id',
    'remark', 'payment_mode_at_event', 'created_by', 'created_at',
    'idempotency_key', 'is_test_data'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'finance_payment_custody_events'
        and column_name = v_name
    ) then
      raise exception 'finance_payment_custody_events is missing %', v_name;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_payment_custody_events'::regclass
      and conname = 'finance_payment_custody_events_people'
  ) then
    raise exception 'the custody table is missing its per-activity people rule';
  end if;

  -- TWO unique indexes, and both matter: the caller''s key defeats a retry, the
  -- natural key defeats a re-minted duplicate.
  foreach v_name in array array[
    'finance_payment_custody_events_key_idx',
    'finance_payment_custody_events_natural_idx'
  ] loop
    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = v_name
    ) then
      raise exception 'the custody table is missing the unique index %', v_name;
    end if;
  end loop;

  -- IMMUTABLE, and stated as a refusal.
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.finance_payment_custody_events'::regclass
      and t.tgname = 'finance_payment_custody_events_immutable'
      and not t.tgisinternal
  ) then
    raise exception 'a saved custody event must be un-editable — the immutability trigger is missing';
  end if;

  if not (select relrowsecurity from pg_class
           where oid = 'public.finance_payment_custody_events'::regclass) then
    raise exception 'RLS must be enabled on finance_payment_custody_events';
  end if;

  -- READ ONLY, AND REVOKED BY NAME. The lesson of 20261013000000 §9f: a Supabase
  -- project grants ALL on every new table, so revoking from PUBLIC and anon alone
  -- leaves `authenticated` holding every write privilege.
  foreach v_name in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('authenticated', 'public.finance_payment_custody_events', v_name) then
      raise exception
        'the custody table must be read-only for authenticated (holds %) — revoke it BY NAME. Writes go through append_payment_custody_events.',
        v_name;
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.finance_payment_custody_events', 'select') then
    raise exception 'authenticated must keep SELECT on the custody table — the RLS policy is what narrows it';
  end if;
  foreach v_name in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('anon', 'public.finance_payment_custody_events', v_name) then
      raise exception 'anon must hold no privilege on the custody table (holds %)', v_name;
    end if;
  end loop;

  -- NO WRITE POLICY AT ALL. The SECURITY DEFINER door is the only way in.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public' and tablename = 'finance_payment_custody_events'
    and cmd <> 'SELECT';
  if v_n <> 0 then
    raise exception 'the custody table must carry no INSERT, UPDATE or DELETE policy (found %)', v_n;
  end if;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 9c. THE ALLOCATION LEDGER IS STILL THE ONLY FINANCIAL SOURCE
  -- ═════════════════════════════════════════════════════════════════════════
  --
  -- This migration adds two DISPLAY objects that read the intent table and a new
  -- event table. Neither may reach a figure. Checked against the definitions
  -- rather than asserted in a comment.

  for v_name in
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'order_linked_payment_total',
        'order_submission_verified_payment',
        'order_submission_unverified_payment',
        'pi_submission_payment_summary',
        'allocate_payment_to_target_internal',
        'finance_payment_allocations_enforce_capacity',
        'payment_active_allocation_totals'
      )
  loop
    if pg_get_functiondef(('public.' || v_name)::regproc)
         ~* '(finance_payment_allocation_intents|finance_payment_custody_events|finance_payment_destinations)' then
      raise exception
        'A DISPLAY OBJECT LEAKED INTO A FINANCIAL FIGURE: %() reads an intent, custody or destination object. Only ACTIVE finance_payment_allocations may decide money.',
        v_name;
    end if;
  end loop;

  -- THE PROJECTION IS UNTOUCHED BY THIS MIGRATION, and its own guarantee holds.
  select pg_get_viewdef('public.finance_received_payments'::regclass, true) into v_def;
  if v_def ~* '(finance_payment_allocation_intents|finance_payment_custody_events|finance_payment_destinations)' then
    raise exception
      'finance_received_payments must not read a display object — 20261014000000 does not redefine it, so this means something else did';
  end if;

  -- The direct-link fallback must STILL be absent from both objects
  -- (20261012000000, re-checked here because §8 exists precisely so that nobody
  -- is ever tempted to bring it back).
  if v_def ~* 'order_id\s+IS\s+NOT\s+NULL\s+THEN\s+\S*amount' then
    raise exception 'the direct-link fallback returned to finance_received_payments';
  end if;
  select pg_get_functiondef('public.order_linked_payment_total(uuid)'::regprocedure) into v_def;
  if v_def ~* 'order_id\s*=\s*p_order_id\s+then\s+\S*amount' then
    raise exception 'the direct-link fallback returned to order_linked_payment_total';
  end if;

  -- APPROVAL DOES NOT WRITE PROVENANCE FROM AN ALLOCATION. If a later revision
  -- makes approval derive order_id from what it just allocated, the three
  -- failures §8 documents come back, and this is where that is refused.
  select pg_get_functiondef('public.approve_finance_payment_request(uuid, text)'::regprocedure) into v_def;
  if v_def !~* 'apply_payment_allocation_intents' then
    raise exception 'approval must still convert pending intents';
  end if;
  if v_def ~* 'finance_payment_allocations' then
    raise exception
      'approval must not read the allocation ledger to decide the payment row''s linkage columns — see §8, "WHY PROVENANCE IS NOT WRITTEN AT APPROVAL"';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 9d. 20261013000000'S INTENT MODEL IS PRESERVED, NOT LOOSENED
  -- ═════════════════════════════════════════════════════════════════════════
  foreach v_name in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('authenticated', 'public.finance_payment_allocation_intents', v_name) then
      raise exception 'the intent table must still be read-only for authenticated (holds %)', v_name;
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.finance_payment_allocation_intents', 'select') then
    raise exception 'authenticated must keep SELECT on the intent table — the detail modals read it';
  end if;
  foreach v_name in array array['select', 'insert', 'update', 'delete'] loop
    if has_table_privilege('anon', 'public.finance_payment_allocation_intents', v_name) then
      raise exception 'anon must still hold no privilege on the intent table (holds %)', v_name;
    end if;
  end loop;

  if has_function_privilege('authenticated', 'public.apply_payment_allocation_intents(uuid)', 'execute') then
    raise exception 'apply_payment_allocation_intents must still be callable by no client role';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 9e. RPC EXPOSURE — the new doors are open, the old ones are gone
  -- ═════════════════════════════════════════════════════════════════════════
  foreach v_name in array array[
    'public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb)',
    'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)',
    'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb)',
    'public.append_payment_custody_events(uuid, jsonb)',
    'public.record_pi_submission_payment(uuid, numeric, date, text, text, text)'
  ] loop
    if not has_function_privilege('authenticated', v_name, 'execute') then
      raise exception 'authenticated cannot call %', v_name;
    end if;
    if has_function_privilege('anon', v_name, 'execute') then
      raise exception 'anon must not call %', v_name;
    end if;
  end loop;

  -- THE SUPERSEDED SIGNATURES MUST NOT SURVIVE. Two overloads differing only in
  -- their trailing defaults are ambiguous to a named-argument caller, and the old
  -- ones still write the retired cash columns and accept the retired modes.
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      (p.proname = 'submit_payment_request' and p.pronargs <> 8)
      or (p.proname = 'edit_payment_request' and p.pronargs <> 9)
      or (p.proname = 'record_payment_with_allocations' and p.pronargs <> 9)
    );
  if v_n <> 0 then
    raise exception 'a superseded payment-entry signature survived (% of them)', v_n;
  end if;

  -- THE CONVERSION DOOR IS STILL CALLABLE BY NOBODY, and so is the custody one.
  foreach v_name in array array[
    'public.append_payment_custody_events_internal(uuid, jsonb, uuid)',
    'public.finance_payment_requests_enforce_current_payment_mode()',
    'public.finance_payment_custody_events_immutable()'
  ] loop
    if has_function_privilege('authenticated', v_name, 'execute')
       or has_function_privilege('anon', v_name, 'execute') then
      raise exception 'the internal function % must not be executable by a client role', v_name;
    end if;
  end loop;

  -- The two shared predicates ARE public: the forms read them, and they decide
  -- nothing a client could not work out from its own list.
  foreach v_name in array array[
    'public.payment_mode_is_current(text)',
    'public.payment_mode_requires_custody(text)'
  ] loop
    if not has_function_privilege('authenticated', v_name, 'execute') then
      raise exception 'authenticated must be able to call %', v_name;
    end if;
  end loop;

  -- THE ENTRY DOORS MUST NOT WRITE THE RETIRED CASH COLUMNS.
  foreach v_name in array array[
    'public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb)',
    'public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)'
  ] loop
    v_def := pg_get_functiondef(v_name::regprocedure);
    foreach v_col in array array[
      'collected_by_user_id', 'collected_from_text',
      'handed_over_to_user_id', 'handed_over_at', 'collection_handover_note'
    ] loop
      if position(v_col in v_def) > 0 then
        raise exception
          '% still writes the legacy cash column % — those five are history and a correction that clears them destroys the record of who carried the money',
          v_name, v_col;
      end if;
    end loop;
    if v_def !~* 'append_payment_custody_events_internal' then
      raise exception '% must write the custody trail in its own transaction', v_name;
    end if;
    if v_def !~* 'payment_mode_is_current' then
      raise exception '% must refuse a retired payment mode', v_name;
    end if;
  end loop;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 9f. THE DESTINATION PROJECTION NAMES RECORDS AND CARRIES NO MONEY
  -- ═════════════════════════════════════════════════════════════════════════
  if to_regclass('public.finance_payment_destinations') is null then
    raise exception 'finance_payment_destinations was not created';
  end if;

  foreach v_name in array array[
    'payment_request_id', 'destination_source', 'destination_kind',
    'destination_order_count', 'destination_submission_count',
    'destination_customer_count', 'destination_order_id',
    'destination_order_number', 'destination_submission_id',
    'destination_reference'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'finance_payment_destinations'
        and column_name = v_name
    ) then
      raise exception 'finance_payment_destinations is missing %', v_name;
    end if;
  end loop;

  -- NOT ONE RUPEE. The moment a money column appears here there are two places
  -- to add up a payment, and 20261012000000's single-source guarantee becomes a
  -- coincidence rather than a property.
  for v_col in
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'finance_payment_destinations'
  loop
    if v_col ~* '(amount|total|balance|sum|value|rupee|percent)' then
      raise exception
        'finance_payment_destinations grew a money column (%). It names records; the ledger decides money.', v_col;
    end if;
  end loop;

  select pg_get_viewdef('public.finance_payment_destinations'::regclass, true) into v_def;
  if v_def ~* '(allocated_amount|intended_amount)' then
    raise exception 'finance_payment_destinations reads an amount column — it must name records, not add them up';
  end if;

  -- AND IT MUST NOT READ THE RETIRED PROVENANCE. This is the whole defect: the
  -- old readers asked payment_target_type / payment_against / order_number, and
  -- those columns stopped being the answer at 20261012000000.
  foreach v_name in array array['payment_target_type', 'payment_against', 'order_request_id'] loop
    if v_def ~* ('\m' || v_name || '\M') then
      raise exception
        'finance_payment_destinations reads %, which has been provenance since 20261012000000 and is the source of the defect this view exists to fix',
        v_name;
    end if;
  end loop;

  -- BOTH SOURCES, IN THE RIGHT ORDER.
  if v_def !~* 'finance_payment_allocations' then
    raise exception 'the destination view must derive an approved payment''s destination from active allocations';
  end if;
  if v_def !~* 'finance_payment_allocation_intents' then
    raise exception 'the destination view must derive a pending request''s destination from its pending intent';
  end if;

  -- SECURITY INVOKER, or it would show a caller records their policies hide.
  if not exists (
    select 1 from pg_class c
    where c.oid = 'public.finance_payment_destinations'::regclass
      and c.reloptions::text like '%security_invoker=true%'
  ) then
    raise exception 'finance_payment_destinations must be security_invoker';
  end if;

  if not has_table_privilege('authenticated', 'public.finance_payment_destinations', 'select') then
    raise exception 'authenticated cannot read finance_payment_destinations';
  end if;
  foreach v_name in array array['select', 'insert', 'update', 'delete'] loop
    if has_table_privilege('anon', 'public.finance_payment_destinations', v_name) then
      raise exception 'anon must hold no privilege on finance_payment_destinations (holds %)', v_name;
    end if;
  end loop;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 9g. THE PROTOCOLS THIS MIGRATION MUST NOT HAVE DISTURBED
  -- ═════════════════════════════════════════════════════════════════════════
  foreach v_name in array array[
    'begin_finance_payment_deletion', 'finalize_finance_payment_deletion',
    'allocate_payment_to_targets', 'allocate_payment_to_target_internal',
    'finance_payment_status_is_verified', 'apply_payment_allocation_intents',
    'approve_finance_payment_request'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
    ) then
      raise exception 'this migration lost %', v_name;
    end if;
  end loop;

  -- The Link/Unlink surface stays gone.
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'link_finance_payment_to_order', 'link_finance_payment_to_order_request',
      'unlink_finance_payment_from_order', 'unlink_finance_payment_from_order_request'
    );
  if v_n <> 0 then
    raise exception '% Link/Unlink function(s) came back', v_n;
  end if;

  raise notice 'PAYMENT DESTINATION DISPLAY, MODES AND CUSTODY — apply-time assertions passed';
end $$;
