-- ═══════════════════════════════════════════════════════════════════════════
-- 20261222000000 — Expenses, Phase 2: safe removal, and the capture inbox
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 1 (20261220000000) recorded an expense and let its author correct it,
-- and said in as many words that a later phase wanting removal "should add the
-- tombstone columns and a policy deliberately, rather than inherit an unsafe
-- hard delete from here". This is that phase, and it does exactly that.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--
--   §1  SOFT DELETION on public.expenses. Two nullable columns, one paired-null
--       CHECK, two partial indexes over the LIVE rows, two UPDATE policies and
--       one trigger. STILL NO DELETE POLICY: a hard delete remains refused by
--       RLS for every non-service caller, exactly as in Phase 1, and §5 asserts
--       it. Removing an expense sets a tombstone; the date, amount, payee,
--       category, remark, author and timestamps are never touched.
--
--   §2  public.expense_drafts. A capture — one line of text somebody typed or
--       spoke — plus whatever a deterministic parser could pull out of it. Its
--       columns are nullable BECAUSE A CAPTURE IS INCOMPLETE BY DESIGN. Not one
--       constraint on public.expenses is weakened to accommodate it; that is
--       the entire reason it is a second table.
--
--   §3  public.finalize_expense_draft(...). One draft becomes EXACTLY ONE
--       expense, under a row lock, idempotently: a second tap, a retried
--       request and two devices at once are handed back the SAME expense id and
--       write nothing.
--
-- ── WHAT THIS DOES NOT TOUCH, AND §5 ASSERTS IT ────────────────────────────
--
-- No existing expense row is read, rewritten or removed — the two new columns
-- land as NULL on every one of them, which is what "not deleted" means, so
-- every expense that exists today keeps counting exactly as it does today.
-- Nothing here reads, writes, alters or references finance_payment_requests,
-- finance_payment_allocations, payment_proof_attachments, orders,
-- order_submissions, users, or any balance derived from them. No existing
-- function is redefined. No existing policy is altered or dropped. No existing
-- category is renamed, retired or seeded over. There is NO DML against any
-- table in this file except the two ALTER TABLE ... ADD COLUMN statements,
-- which write NULL.
--
-- ── ACCESS: THE PHASE 1 MODEL, EXTENDED BY NOTHING ─────────────────────────
--
-- No new module, no new action key, no new permission row, no widening.
--
--   restrictive gate   module_entry_open('finance') on both tables, for all
--                      four commands, AND-ed with every permissive policy.
--   delete an expense  its author, or the protected finance.manage — EXACTLY
--                      the set who may already correct it. Removing a financial
--                      fact and rewriting one are the same authority, and
--                      inventing a third rule would mean somebody who may
--                      silently change an amount to ₹1 may not withdraw it.
--   drafts             created by finance.create (as an expense is), read by
--                      their author / finance.view_all / admin, acted on by
--                      their author or finance.manage.
--
-- A person without Finance entry reaches NOTHING here: not an expense, not a
-- draft, not the finalize function, for SELECT, INSERT, UPDATE or DELETE.
--
-- DEPENDENCIES: 20261220000000 (public.expenses, public.expense_categories),
-- 20260901000000 (actor_has_module_permission), 20260905000000
-- (module_entry_open), 20260609 (set_updated_at).
-- ═══════════════════════════════════════════════════════════════════════════


-- ── §0. The Phase 1 objects this builds on must be exactly as they were ─────
--
-- Read-only. Fails the migration rather than let a partially applied state look
-- successful, and names the dependency rather than failing later on a missing
-- column nobody can trace.

do $$
begin
  if to_regclass('public.expenses') is null
     or to_regclass('public.expense_categories') is null then
    raise exception 'DEPENDENCY MISSING: 20261220000000 (finance expenses) must be applied first';
  end if;
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260901000000 (actor_has_module_permission)';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260905000000 (module_entry_open)';
  end if;
  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'DEPENDENCY MISSING: set_updated_at()';
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- §1. Soft deletion on public.expenses
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── WHY A TOMBSTONE AND NOT A DELETE ───────────────────────────────────────
--
-- Deleting the row would destroy the only record that the money left, who said
-- so and who withdrew it. The business asked for deletion because a wrong
-- expense must stop counting — not because the evidence should stop existing.
-- Those are different requirements and only one of them is destructive.
--
-- ── WHY NOT REUSE FINANCE'S EXISTING REMOVAL PATH ──────────────────────────
--
-- Finance's one removal path is a guarded HARD delete of an UNVERIFIED payment
-- (20260700000000 / 20260705000000 / finance_payment_deletion_claims), and a
-- verified payment is permanent (20261218000000). An expense has no
-- verification step, so there is no "unverified" state in which a hard delete
-- would be safe, and the claims protocol exists to coordinate a two-party
-- deletion that has no analogue here. Neither shape transfers. This is the
-- tombstone Phase 1 said to add deliberately.

alter table public.expenses
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.users(id);

comment on column public.expenses.deleted_at is
  'When this expense was removed from the normal records. NULL on every expense that counts. The row is never destroyed: there is no DELETE policy on this table, in this migration or in 20261220000000.';
comment on column public.expenses.deleted_by is
  'Who removed it. Set together with deleted_at and enforced by expenses_deleted_pair; the UPDATE policies pin it to the caller, so a removal always names its author.';

-- BOTH OR NEITHER. A deleted_at with no deleted_by is an expense that vanished
-- with nobody accountable, and a deleted_by with no deleted_at is a row that
-- counts while naming somebody who removed it. Neither is a state this table
-- should be able to hold, so neither is representable.
--
-- NOT VALID, then VALIDATE, is deliberate: the ALTER above has just written
-- NULL into both columns for every existing row, so every existing row already
-- satisfies this — but validating in two steps takes only a SHARE UPDATE
-- EXCLUSIVE lock for the scan instead of holding ACCESS EXCLUSIVE over it, and
-- an expense table that has grown for years should not block a phone entering
-- an expense while it is checked.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.expenses'::regclass and conname = 'expenses_deleted_pair'
  ) then
    alter table public.expenses
      add constraint expenses_deleted_pair check (
        (deleted_at is null) = (deleted_by is null)
      ) not valid;
    alter table public.expenses validate constraint expenses_deleted_pair;
  end if;
end $$;

-- ── §1a. Indexes over the LIVE rows ────────────────────────────────────────
--
-- PARTIAL, on `deleted_at is null`, because that predicate is in every read the
-- list performs and in none of the reads that do not exist (there is no
-- recycle-bin screen in this phase). The three Phase 1 indexes are LEFT EXACTLY
-- AS THEY ARE — dropping and recreating them as partial ones would be a rewrite
-- of working indexes for a table that is small today, and they remain correct
-- for any query that does not filter on the tombstone.

create index if not exists expenses_live_date_idx
  on public.expenses (expense_date desc, id desc)
  where deleted_at is null;

create index if not exists expenses_live_created_by_date_idx
  on public.expenses (created_by, expense_date desc)
  where deleted_at is null;

-- ── §1b. Who may remove one ────────────────────────────────────────────────
--
-- TWO POLICIES, MIRRORING THE TWO CORRECTION POLICIES EXACTLY. Phase 1 has
-- expenses_own_update (the author) and expenses_manage_update (finance.manage),
-- and soft deletion travels on those same policies — it IS an UPDATE, setting
-- two columns. Nothing new is granted here at all: the policies below are the
-- Phase 1 policies restated, UNCHANGED, and are recreated only because §1c's
-- trigger changes what an UPDATE is allowed to do to a row that is already
-- tombstoned.
--
-- SO WHY RESTATE THEM? Because they are not restated: they are not touched.
-- This block is intentionally empty of policy changes, and §5 asserts that the
-- Phase 1 policies are still present, still permissive, and still exactly two
-- in number for UPDATE. The authority to delete is the authority to correct,
-- expressed by using the same two policies rather than by adding two more that
-- would have to be kept in step forever.

-- ── §1c. A tombstoned expense is frozen, for every caller ──────────────────
--
-- WHAT A POLICY CANNOT SAY. A WITH CHECK sees only the NEW row, so it cannot
-- express "this row was already deleted" or "deleted_at did not move". A
-- trigger can, and unlike RLS it also binds the service role — which matters
-- here, because the service role is the one caller that could otherwise quietly
-- resurrect or rewrite a removed expense.
--
-- THE FOUR RULES, and each one is a mistake somebody would otherwise make:
--
--   1. A DELETED EXPENSE IS IMMUTABLE. Not its amount, not its category, not
--      its remark, not its tombstone. "A deleted expense must not be editable"
--      is the requirement; this is the layer that makes it true regardless of
--      which screen, script or role attempts it.
--   2. UN-DELETING IS NOT AN UPDATE. Clearing deleted_at is refused. Recovery
--      is a deliberate, supervised act for a later phase with its own audit,
--      not something a stray PATCH can do.
--   3. A REMOVAL NAMES ITS AUTHOR, AND THE SERVER NAMES ITS MOMENT.
--      deleted_by must be the caller (auth.uid()); deleted_at is STAMPED HERE
--      from now() and is never accepted from the client — a phone's clock is
--      not evidence, and a backdated removal is worse than an undated one.
--   4. created_by REMAINS FROZEN. Phase 1's expenses_freeze_created_by trigger
--      is untouched and still runs; this one adds to it and replaces nothing.
--
-- ── deleted_by IS THE SIGNAL, AND deleted_at IS THE CONSEQUENCE ────────────
--
-- The caller sets ONE column to remove an expense: deleted_by. It does not send
-- deleted_at at all, and if it does, the value is discarded.
--
-- The first version of this trigger required both, and the suite caught it
-- immediately: the client set deleted_by alone (correctly — it has no business
-- inventing the moment) and the trigger refused the write as "not deleted but
-- naming who deleted it". A rule that demands a value it then overwrites is a
-- trap for whoever writes the next caller. One signal, one consequence.
--
-- auth.uid() IS NULL FOR THE SERVICE ROLE, so the "must be the caller" check is
-- applied only when there IS a caller identity — a supervised recovery script
-- acting as the service role may set deleted_by to the person it acts for,
-- which is the accountable answer. No client role reaches that branch: the
-- restrictive gate has already refused anon, and an authenticated caller always
-- has an auth.uid().

create or replace function public.expenses_guard_removal()
returns trigger
language plpgsql
as $$
begin
  -- 1. ALREADY REMOVED → nothing about it may change, by anybody. This is the
  -- branch that makes a deleted expense uneditable and un-deletable at once:
  -- an UPDATE that would clear deleted_at is an UPDATE to a removed row.
  if old.deleted_at is not null then
    raise exception 'This expense has been deleted and can no longer be changed'
      using errcode = '42501';
  end if;

  -- 2. IT IS BEING REMOVED NOW, signalled by deleted_by.
  if new.deleted_by is not null then
    if auth.uid() is not null and new.deleted_by is distinct from auth.uid() then
      raise exception 'A deleted expense must name the person who deleted it'
        using errcode = '42501';
    end if;

    -- THE SERVER'S CLOCK, ALWAYS. Whatever the client sent is discarded.
    new.deleted_at := now();

    -- REMOVAL CHANGES THE TOMBSTONE AND NOTHING ELSE. Editing an expense on
    -- the way out would mean the surviving record is not what was actually
    -- recorded, which defeats the reason the row is kept at all.
    if new.expense_date is distinct from old.expense_date
       or new.amount is distinct from old.amount
       or new.payment_mode is distinct from old.payment_mode
       or new.paid_to is distinct from old.paid_to
       or new.category_id is distinct from old.category_id
       or new.remark is distinct from old.remark then
      raise exception 'An expense cannot be edited and deleted in the same step'
        using errcode = '42501';
    end if;

    return new;
  end if;

  -- 3. AN ORDINARY CORRECTION. A deleted_at with no deleted_by would be an
  -- expense that vanished with nobody accountable; the paired CHECK refuses it
  -- too, and this says so in words a person can read.
  if new.deleted_at is not null then
    raise exception 'A deleted expense must name the person who deleted it'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.expenses_guard_removal() is
  'Freezes a soft-deleted expense against every caller including the service role: no edit, no un-delete, no removal without a named author, and deleted_at is stamped from the server clock. Runs alongside expenses_freeze_created_by, which it does not replace.';

drop trigger if exists expenses_guard_removal on public.expenses;
create trigger expenses_guard_removal
  before update on public.expenses
  for each row execute function public.expenses_guard_removal();


-- ═══════════════════════════════════════════════════════════════════════════
-- §2. public.expense_drafts — Quick Capture and the Needs Details inbox
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── WHY A SEPARATE TABLE ───────────────────────────────────────────────────
--
-- Every column of public.expenses that matters is NOT NULL with a CHECK behind
-- it, and that is the whole value of the table: no row in it is half-entered,
-- so any total over it is a real total. A capture is incomplete by design. To
-- hold one in public.expenses, expense_date, amount, payment_mode, paid_to and
-- category_id would all have to become nullable and every constraint protecting
-- them would have to become conditional — weakening, for every expense that
-- already exists, the guarantees that make the table worth having.
--
-- So the drafts live here, where nullable columns are correct rather than a
-- concession, and public.expenses is not altered in any way by this section.
--
-- ── A DRAFT IS NOT AN EXPENSE, STRUCTURALLY ────────────────────────────────
--
-- A draft cannot appear in the expense list, reach a total, reach a category
-- total, teach the category matcher or appear in reporting — not because each
-- of those filters it out, but because NONE OF THEM READS THIS TABLE. The only
-- link that exists runs the other way: expense_id, set once, when a draft has
-- already become an expense.
--
-- ── NEEDS DETAILS, NOT APPROVAL ────────────────────────────────────────────
--
-- Nobody else has to look at these. A draft waits for its own author to finish
-- it. There is no approver, no reviewer, no second permission and no state
-- meaning "rejected" — calling this queue "approval" would invent a person who
-- does not exist in the workflow.

create table if not exists public.expense_drafts (
  id uuid primary key default gen_random_uuid(),

  -- WHAT WAS ACTUALLY SAID, VERBATIM — the one column that is never null and
  -- never rewritten. Everything else in this row is a machine's reading of it,
  -- and the reading is only trustworthy while the original survives beside it.
  raw_text text not null,

  -- ── The parse. Every column below is NULLABLE ON PURPOSE. ──
  --
  -- NULL means "the sentence did not say", which is a different fact from any
  -- value that could be put there. Nothing is defaulted, inferred or invented.

  -- THE ONE EXCEPTION, and it is a stated one rather than a guess: a capture is
  -- made minutes after the payment, an expense must have a date, and the screen
  -- shows this value and says when it was assumed rather than heard.
  parsed_date date not null default current_date,

  parsed_amount numeric(14,2),
  parsed_paid_to text,
  parsed_payment_mode text,
  parsed_remark text,

  -- NO ACTION FK, as on public.expenses: a referenced category cannot be
  -- deleted, only retired. Null on capture — matching happens at completion
  -- time, against the categories that exist THEN.
  category_id uuid
    constraint expense_drafts_category_fk references public.expense_categories(id),

  status text not null default 'pending',

  -- ── The finalized link ──
  --
  -- UNIQUE (§2a), so one draft can name one expense and one expense can be
  -- named by one draft. This is the database half of "a draft cannot be
  -- finalized twice"; finalize_expense_draft's row lock is the other half, and
  -- the two are independent.
  --
  -- NO ACTION FK: an expense that came from a draft cannot be hard-deleted out
  -- from under it — which is moot, because no DELETE policy exists on either
  -- table, and correct anyway.
  expense_id uuid
    constraint expense_drafts_expense_fk references public.expenses(id),
  finalized_at timestamptz,

  -- ── The discard trail ──
  --
  -- A discarded capture is NOT removed. Who discarded it and when are kept, for
  -- the same reason a deleted expense is kept: "it was thrown away" and "it
  -- never existed" must not look the same.
  discarded_by uuid references public.users(id),
  discarded_at timestamptz,

  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- SOMETHING MUST HAVE BEEN SAID. A draft with no text is a row nobody can
  -- ever act on: there is nothing to complete it from and nothing to show in
  -- the inbox, so it would sit there forever. This is the ONLY thing a capture
  -- is required to have.
  constraint expense_drafts_raw_text_present check (
    raw_text = btrim(raw_text) and btrim(raw_text) <> ''
  ),
  constraint expense_drafts_raw_text_length check (
    char_length(raw_text) <= 500
  ),

  -- THE SAME AMOUNT RULE AS A FINALIZED EXPENSE, minus the requirement that
  -- there be one. numeric accepts 'NaN', which sorts above every real number
  -- and would pass a bare > 0 test; a parsed amount that is present must be a
  -- real, positive figure, so a draft cannot carry a number the expense form
  -- would then refuse.
  constraint expense_drafts_amount_valid check (
    parsed_amount is null
    or (parsed_amount <> 'NaN'::numeric and parsed_amount > 0
        and parsed_amount = round(parsed_amount, 2))
  ),

  constraint expense_drafts_paid_to_valid check (
    parsed_paid_to is null
    or (parsed_paid_to = btrim(parsed_paid_to) and btrim(parsed_paid_to) <> ''
        and char_length(parsed_paid_to) <= 120)
  ),

  constraint expense_drafts_remark_valid check (
    parsed_remark is null
    or (btrim(parsed_remark) <> '' and char_length(parsed_remark) <= 500)
  ),

  -- The SAME seven outgoing routes public.expenses accepts, so a parsed mode is
  -- never one the expense form cannot render. Null is "not heard".
  constraint expense_drafts_payment_mode_known check (
    parsed_payment_mode is null
    or parsed_payment_mode in (
      'cash', 'upi', 'bank_transfer', 'credit_card', 'debit_card', 'cheque', 'other'
    )
  ),

  constraint expense_drafts_status_known check (
    status in ('pending', 'finalized', 'discarded')
  ),

  -- ── THE STATUS AND ITS EVIDENCE CANNOT DISAGREE ──
  --
  -- Each state is defined by the columns that must and must not be set, so
  -- "finalized" without an expense, or "pending" with one, is not representable
  -- — whatever wrote it, RPC or service role.
  constraint expense_drafts_state_consistent check (
    (status = 'pending'
      and expense_id is null and finalized_at is null
      and discarded_by is null and discarded_at is null)
    or (status = 'finalized'
      and expense_id is not null and finalized_at is not null
      and discarded_by is null and discarded_at is null)
    or (status = 'discarded'
      and expense_id is null and finalized_at is null
      and discarded_by is not null and discarded_at is not null)
  )
);

comment on table public.expense_drafts is
  'A Quick Capture: one line somebody typed or spoke, plus whatever a deterministic parser found in it. Separate from public.expenses BECAUSE ITS COLUMNS ARE MEANT TO BE NULL — no constraint on public.expenses is weakened for it. A draft never reaches a list, a total, a category total, the suggestion matcher or reporting; nothing that reads expenses reads this table. Rows are finalized or discarded, never deleted: this migration grants no DELETE.';
comment on column public.expense_drafts.raw_text is
  'What was actually said or typed, verbatim and never rewritten. Every other parsed column is a reading of this, and only trustworthy while it survives beside them.';
comment on column public.expense_drafts.parsed_date is
  'The date the money left. Defaults to today when the sentence named none — the one value that is assumed rather than left null, because an expense must have a date and the screen states which it is.';
comment on column public.expense_drafts.parsed_amount is
  'The amount, if one was heard. NULL means the sentence did not say, and the inbox shows the amount as missing; it is never a zero and never a guess.';
comment on column public.expense_drafts.status is
  'pending (in the Needs Details inbox) | finalized (became exactly one expense, kept for audit) | discarded (not wanted, kept with who and when). Terminal states are frozen by expense_drafts_guard_transitions.';
comment on column public.expense_drafts.expense_id is
  'The ONE expense this became. UNIQUE, so no two drafts can claim one expense and no draft can produce two — the database half of "a draft cannot be finalized twice"; finalize_expense_draft''s row lock is the other half.';

-- ── §2a. Indexes ───────────────────────────────────────────────────────────

-- ONE EXPENSE PER DRAFT, ONE DRAFT PER EXPENSE. A partial unique index rather
-- than a column constraint, because the many pending and discarded rows all
-- carry NULL here and should not be indexed at all.
create unique index if not exists expense_drafts_expense_id_key
  on public.expense_drafts (expense_id)
  where expense_id is not null;

-- THE INBOX, which is the only list this table has: somebody's pending
-- captures, newest first. Partial on `status = 'pending'`, because finalized
-- and discarded rows exist for audit and are never listed.
create index if not exists expense_drafts_pending_idx
  on public.expense_drafts (created_by, created_at desc)
  where status = 'pending';

-- ── §2b. updated_at, and created_by frozen ─────────────────────────────────

drop trigger if exists expense_drafts_set_updated_at on public.expense_drafts;
create trigger expense_drafts_set_updated_at
  before update on public.expense_drafts
  for each row execute function public.set_updated_at();

-- WHO CAPTURED IT IS NEVER A CORRECTION, exactly as on public.expenses. Applies
-- to the service role too, which RLS does not reach.
create or replace function public.expense_drafts_freeze_created_by()
returns trigger
language plpgsql
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'A capture cannot change who recorded it'
      using errcode = '42501';
  end if;
  if new.raw_text is distinct from old.raw_text then
    raise exception 'A capture cannot change what was said'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.expense_drafts_freeze_created_by() is
  'Refuses any UPDATE that changes expense_drafts.created_by or raw_text. The transcript is the evidence the parse is read against; rewriting it would make the parse unauditable. Applies to every caller including the service role.';

drop trigger if exists expense_drafts_freeze_created_by on public.expense_drafts;
create trigger expense_drafts_freeze_created_by
  before update on public.expense_drafts
  for each row execute function public.expense_drafts_freeze_created_by();

-- ── §2c. Status transitions ────────────────────────────────────────────────
--
-- pending → finalized, pending → discarded, and NOTHING ELSE.
--
-- WHAT THIS STOPS, and each is a real failure mode rather than a hypothetical:
--
--   * A finalized draft being finalized again — the second tap, the retried
--     request, the two open tabs. The unique index on expense_id would catch a
--     second DISTINCT expense; this catches the attempt itself, and with the
--     row lock in §3 means the retry never gets as far as inserting one.
--   * A finalized draft being reopened to "fix" it — the expense exists and is
--     corrected through the expense form; reopening the draft would give one
--     payment two editable representations.
--   * A discarded draft coming back. It was thrown away deliberately.
--
-- discarded_by IS PINNED TO THE CALLER here as well as in the policy, for the
-- same reason deleted_by is: a discard names who did it, and the service role
-- must not be able to forge that quietly either.

create or replace function public.expense_drafts_guard_transitions()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'pending' then
    raise exception 'This capture has already been %', old.status
      using errcode = '42501';
  end if;

  if new.status = 'finalized' then
    if new.expense_id is null then
      raise exception 'A finalized capture must name the expense it became'
        using errcode = '42501';
    end if;
    -- STAMPED FROM THE SERVER CLOCK, never accepted from a client.
    new.finalized_at := now();

  elsif new.status = 'discarded' then
    if auth.uid() is not null and new.discarded_by is distinct from auth.uid() then
      raise exception 'A discarded capture must name the person who discarded it'
        using errcode = '42501';
    end if;
    if new.discarded_by is null then
      raise exception 'A discarded capture must name the person who discarded it'
        using errcode = '42501';
    end if;
    new.discarded_at := now();

  elsif new.status = 'pending' then
    -- Still pending: the parse may be corrected in place before completion.
    if new.expense_id is not null or new.finalized_at is not null
       or new.discarded_by is not null or new.discarded_at is not null then
      raise exception 'A pending capture cannot carry a finalized or discarded record'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.expense_drafts_guard_transitions() is
  'Allows pending → finalized and pending → discarded only. A finalized or discarded capture is frozen, so it cannot be finalized twice, reopened or resurrected — by any caller, the service role included. Stamps finalized_at and discarded_at from the server clock.';

drop trigger if exists expense_drafts_guard_transitions on public.expense_drafts;
create trigger expense_drafts_guard_transitions
  before update on public.expense_drafts
  for each row execute function public.expense_drafts_guard_transitions();

-- ── §2d. RLS ───────────────────────────────────────────────────────────────

alter table public.expense_drafts enable row level security;

-- THE PARENT GATE, the same restrictive shape 20260905000000 applied to the
-- three original Finance tables and 20261220000000 applied to the two expense
-- ones. AND-ed with every permissive policy below and with any added later, for
-- all four commands. A person without Finance entry reaches NOTHING here.
drop policy if exists expense_drafts_module_entry_gate on public.expense_drafts;
create policy expense_drafts_module_entry_gate
  on public.expense_drafts
  as restrictive for all to authenticated
  using (public.module_entry_open('finance'))
  with check (public.module_entry_open('finance'));

-- Admin, matching expenses_admin_select.
create policy expense_drafts_admin_select
  on public.expense_drafts
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'admin'
    )
  );

-- Company-wide Finance sight, on the SAME protected action that already grants
-- it over the expenses and the payments. Read only: it appears in no write
-- policy.
create policy expense_drafts_view_all_select
  on public.expense_drafts
  for select to authenticated
  using (public.actor_has_permission('finance', 'view_all'));

-- Your own captures — which is the whole inbox for anybody without view_all.
create policy expense_drafts_own_select
  on public.expense_drafts
  for select to authenticated
  using (created_by = auth.uid());

-- CAPTURING TAKES THE SAME AUTHORITY AS RECORDING AN EXPENSE: finance.create.
-- A capture is the first half of entering an expense, so it cannot be a lower
-- bar than the second half. The row must name its author, must start pending,
-- and must carry no finalized or discarded record — an INSERT that pre-stamped
-- one would claim an act that never happened.
create policy expense_drafts_create_insert
  on public.expense_drafts
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'pending'
    and expense_id is null
    and finalized_at is null
    and discarded_by is null
    and discarded_at is null
    and public.actor_has_module_permission('finance', 'create')
  );

-- COMPLETING OR DISCARDING YOUR OWN. The author finishes what they started;
-- created_by is pinned by WITH CHECK as well as by the trigger.
create policy expense_drafts_own_update
  on public.expense_drafts
  for update to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

-- SOMEBODY ELSE'S, on the protected finance.manage — the same action that
-- allows correcting and removing somebody else's expense. No access level
-- grants it (levels.ts).
create policy expense_drafts_manage_update
  on public.expense_drafts
  for update to authenticated
  using (public.actor_has_module_permission('finance', 'manage'))
  with check (public.actor_has_module_permission('finance', 'manage'));

-- NO DELETE POLICY, HERE OR ANYWHERE. RLS default-denies what no policy
-- permits, so DELETE is refused for every non-service caller. §5 asserts it.


-- ═══════════════════════════════════════════════════════════════════════════
-- §3. finalize_expense_draft — one draft, exactly one expense
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── WHY AN RPC RATHER THAN TWO WRITES FROM THE BROWSER ─────────────────────
--
-- "Create the expense, then mark the draft finalized" is two statements, and a
-- browser cannot make them one. Every failure between them leaves the worse of
-- the two outcomes: an expense that no draft points at (so the capture stays in
-- the inbox and is completed AGAIN, producing a second expense for one payment),
-- or a draft marked finalized pointing at nothing.
--
-- Inside one function they are one transaction, and the row lock makes the
-- ordering total rather than probable.
--
-- ── HOW A SECOND TAP IS ANSWERED ───────────────────────────────────────────
--
-- `select ... for update` on the draft SERIALISES every concurrent call: the
-- second waits for the first to commit and then reads its result. If the draft
-- is already finalized it returns THAT EXPENSE'S ID with created=false and
-- writes nothing — not an error, because from the person's point of view the
-- thing they asked for has happened. A retried request after a lost response
-- lands in exactly the same branch and is equally harmless.
--
-- Three independent mechanisms therefore stop a double finalization, and each
-- catches what the others cannot: the row lock (concurrent), the status guard
-- in §2c (sequential), and the unique index on expense_id (anything at all).
--
-- ── SECURITY DEFINER, AND WHAT THAT DOES NOT MEAN ──────────────────────────
--
-- It runs as the owner so it can write both tables in one transaction without
-- depending on the caller's table privileges. It re-derives authority itself,
-- first thing, before any lock or read: Finance entry, finance.create for the
-- expense it is about to record, and ownership-or-finance.manage over the
-- draft. A caller who could not have inserted this expense through the table
-- cannot insert it through this function. created_by is taken from auth.uid()
-- and never from a parameter, so it cannot be forged.

create or replace function public.finalize_expense_draft(
  p_draft_id uuid,
  p_expense_date date,
  p_amount numeric,
  p_payment_mode text,
  p_paid_to text,
  p_category_id uuid,
  p_remark text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_draft public.expense_drafts;
  v_expense_id uuid;
  v_remark text;
begin
  -- ── Authority, before anything is read or locked ──
  if v_actor is null then
    raise exception 'You must be signed in to complete a capture'
      using errcode = '42501';
  end if;
  if not public.module_entry_open('finance') then
    raise exception 'You do not have access to Finance'
      using errcode = '42501';
  end if;
  -- The same permission the expense INSERT policy requires. This function must
  -- not be a second, easier door to recording an expense.
  if not public.actor_has_module_permission('finance', 'create') then
    raise exception 'You do not have permission to record an expense'
      using errcode = '42501';
  end if;

  -- ── The lock. Everything below happens once, in order. ──
  select * into v_draft
  from public.expense_drafts
  where id = p_draft_id
  for update;

  if not found then
    raise exception 'That capture no longer exists'
      using errcode = 'P0002';
  end if;

  -- Ownership, or the protected finance.manage — the draft rules, re-derived.
  if v_draft.created_by <> v_actor
     and not public.actor_has_module_permission('finance', 'manage') then
    raise exception 'You do not have permission to complete this capture'
      using errcode = '42501';
  end if;

  -- ── ALREADY DONE IS NOT AN ERROR ──
  -- The second tap, the retry after a lost response, the second open tab. The
  -- expense the FIRST call created is returned; nothing is written.
  if v_draft.status = 'finalized' then
    return jsonb_build_object(
      'created', false,
      'expense_id', v_draft.expense_id,
      'draft_id', v_draft.id,
      'status', v_draft.status
    );
  end if;

  if v_draft.status <> 'pending' then
    raise exception 'This capture was discarded and cannot be completed'
      using errcode = '42501';
  end if;

  -- ── The expense. Every value comes from the FORM, not from the parse: the
  -- person has just reviewed and corrected these on a normal final review. The
  -- table's own CHECK constraints refuse a bad amount, an untrimmed payee, a
  -- blank remark and an unknown mode — they are not restated here, so there is
  -- exactly one definition of a valid expense and it is the table's.
  v_remark := nullif(btrim(coalesce(p_remark, '')), '');

  insert into public.expenses (
    expense_date, amount, payment_mode, paid_to, category_id, remark, created_by
  ) values (
    p_expense_date, p_amount, p_payment_mode, btrim(p_paid_to), p_category_id, v_remark,
    -- FROM auth.uid(), NEVER FROM A PARAMETER. There is no way to record an
    -- expense in somebody else's name through this function.
    v_actor
  )
  returning id into v_expense_id;

  -- ── The link. The guard trigger stamps finalized_at from the server clock
  -- and refuses this if the status has moved under us.
  update public.expense_drafts
  set status = 'finalized',
      expense_id = v_expense_id,
      finalized_at = now(),
      category_id = p_category_id
  where id = v_draft.id;

  return jsonb_build_object(
    'created', true,
    'expense_id', v_expense_id,
    'draft_id', v_draft.id,
    'status', 'finalized'
  );
end;
$$;

comment on function public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text) is
  'Turns one pending capture into EXACTLY ONE expense, in one transaction, under a row lock. A retry or a second tap returns the first call''s expense id with created=false and writes nothing. Re-derives Finance entry, finance.create and ownership-or-finance.manage itself; created_by comes from auth.uid() and cannot be forged.';

-- Only signed-in callers. The function's own checks do the rest, and the
-- restrictive module gate on both tables applies to everything it touches.
revoke all on function public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text) from public;
grant execute on function public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §4. Table grants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The three verbs a client role needs, and NOT delete. RLS decides which rows;
-- a grant decides which verbs exist at all.

grant select, insert, update on public.expense_drafts to authenticated;

-- ── DELETE IS REVOKED BY NAME, ON ALL THREE EXPENSE TABLES ─────────────────
--
-- WHY THIS IS NEEDED AT ALL. Supabase's project bootstrap grants ALL PRIVILEGES
-- on tables in `public` to anon and authenticated, and sets default privileges
-- that do the same for tables created later. So every expense table has carried
-- a DELETE *privilege* since the day it was created, even though Phase 1 said —
-- correctly — that deletion is refused. It is refused by RLS, which
-- default-denies a command no policy permits, and that is a real refusal.
--
-- WHAT THIS CHANGES. Nothing that is possible today becomes impossible, and
-- nothing impossible becomes possible: a DELETE from a client role was refused
-- before this line and is refused after it. What changes is WHERE it is refused
-- — at the privilege check rather than at the policy check — so the guarantee
-- no longer rests on the continued absence of a policy somebody might add in
-- five years without reading the header. It is the difference between "no
-- policy permits this" and "this role cannot issue this command".
--
-- service_role IS DELIBERATELY UNTOUCHED. Backups, a future supervised recovery
-- path and the migration tooling itself run as the owner or service role, and
-- taking the ability away from them would not make anything safer — it would
-- only mean a genuine recovery had to re-grant it in a hurry.
revoke delete on public.expenses from anon, authenticated;
revoke delete on public.expense_categories from anon, authenticated;
revoke delete on public.expense_drafts from anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §5. Assertions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Read-only. They fail the migration rather than let a partially applied state
-- look successful. Several of them exist to catch a LATER edit to this file, not
-- a mistake in it.

do $$
declare
  v_count int;
  v_live int;
begin
  -- ── The tombstone exists, and every existing expense is LIVE ──
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'expenses'
      and column_name = 'deleted_at' and is_nullable = 'YES'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'expenses'
      and column_name = 'deleted_by' and is_nullable = 'YES'
  ) then
    raise exception 'expense lifecycle: the tombstone columns are missing or not nullable';
  end if;

  -- NOTHING WAS DELETED BY THIS MIGRATION. The ALTER wrote NULL, so every row
  -- that existed a moment ago still counts. If this ever fails, the migration
  -- has done something it must never do.
  select count(*) into v_count from public.expenses where deleted_at is not null;
  if v_count <> 0 then
    raise exception 'expense lifecycle: % expenses are already tombstoned; this migration must delete nothing', v_count;
  end if;

  -- ── STILL NO DELETE PATH, on any of the three tables ──
  -- FOR ALL would grant DELETE too, so a permissive ALL policy counts as one.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('expense_categories', 'expenses', 'expense_drafts')
    and cmd in ('DELETE', 'ALL')
    and permissive = 'PERMISSIVE';
  if v_count <> 0 then
    raise exception 'expense lifecycle: % permissive DELETE/ALL policies found; deletion is a tombstone, never a DELETE', v_count;
  end if;

  -- And no DELETE privilege either, which is refused before any policy is read.
  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('expenses', 'expense_drafts', 'expense_categories')
    and privilege_type = 'DELETE'
    and grantee in ('authenticated', 'anon');
  if v_count <> 0 then
    raise exception 'expense lifecycle: DELETE is granted to a client role on an expense table (% grants)', v_count;
  end if;

  -- ── THE PHASE 1 UPDATE POLICIES ARE UNTOUCHED ──
  -- Soft deletion travels on them; it does not add a third. If a later edit adds
  -- one, this fails and the author has to say why.
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'expenses' and policyname = 'expenses_own_update')
     or not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'expenses' and policyname = 'expenses_manage_update') then
    raise exception 'expense lifecycle: a Phase 1 expense UPDATE policy is missing';
  end if;
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public' and tablename = 'expenses'
    and cmd = 'UPDATE' and permissive = 'PERMISSIVE';
  if v_count <> 2 then
    raise exception 'expense lifecycle: expected exactly the 2 Phase 1 UPDATE policies on expenses, found %', v_count;
  end if;

  -- ── The drafts table, its gate and its guards ──
  if to_regclass('public.expense_drafts') is null then
    raise exception 'expense lifecycle: public.expense_drafts was not created';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'expense_drafts' and c.relrowsecurity
  ) then
    raise exception 'expense lifecycle: RLS is not enabled on public.expense_drafts';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'expense_drafts'
      and policyname = 'expense_drafts_module_entry_gate' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'expense lifecycle: the restrictive finance gate is missing on public.expense_drafts';
  end if;

  -- NO UNCONDITIONAL SELECT. Draft text is a financial fact about somebody, and
  -- it must not become readable to every authenticated employee by a policy
  -- that says `using (true)`.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'expense_drafts'
      and cmd = 'SELECT' and permissive = 'PERMISSIVE'
      and coalesce(qual, '') in ('true', '(true)')
  ) then
    raise exception 'expense lifecycle: an unconditional SELECT policy exists on public.expense_drafts';
  end if;

  -- ONE DRAFT, ONE EXPENSE — the index that makes double finalization
  -- impossible even if every other guard were removed.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'expense_drafts'
      and indexname = 'expense_drafts_expense_id_key'
  ) then
    raise exception 'expense lifecycle: the unique expense_id index is missing';
  end if;

  -- The four triggers that bind the service role as well as the client roles.
  if not exists (select 1 from pg_trigger where tgrelid = 'public.expenses'::regclass
                   and tgname = 'expenses_guard_removal' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgrelid = 'public.expenses'::regclass
                   and tgname = 'expenses_freeze_created_by' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgrelid = 'public.expense_drafts'::regclass
                   and tgname = 'expense_drafts_guard_transitions' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgrelid = 'public.expense_drafts'::regclass
                   and tgname = 'expense_drafts_freeze_created_by' and not tgisinternal) then
    raise exception 'expense lifecycle: a guard trigger is missing';
  end if;

  -- The finalize door exists and is executable by exactly the intended role.
  if to_regprocedure('public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)') is null then
    raise exception 'expense lifecycle: finalize_expense_draft is missing';
  end if;

  -- ── NOTHING WAS SEEDED ──
  -- This migration inserts no draft, no expense and no category, here or
  -- anywhere above.
  select count(*) into v_count from public.expense_drafts;
  if v_count <> 0 then
    raise exception 'expense lifecycle: expected no seeded drafts, found %', v_count;
  end if;

  -- ── AND EVERY EXISTING EXPENSE STILL COUNTS ──
  -- Stated as a positive fact rather than inferred: the number of live expenses
  -- equals the number of expenses.
  select count(*) into v_count from public.expenses;
  select count(*) into v_live from public.expenses where deleted_at is null;
  if v_count <> v_live then
    raise exception 'expense lifecycle: % of % expenses are not live after this migration', v_count - v_live, v_count;
  end if;
end $$;
