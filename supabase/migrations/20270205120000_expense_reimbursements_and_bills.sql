-- ═══════════════════════════════════════════════════════════════════════════
-- 20270205120000 — Expenses, Phase 3: who paid, reimbursement batches, bills
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
--
--   §1  Three NULLABLE columns on public.expenses:
--         paid_from         'company' | 'personal' | NULL
--         paid_by           the person who paid personally (only when personal)
--         reimbursement_id  the batch that reimbursed it (only when personal)
--       NULL paid_from is "not recorded" — every expense that exists today. It is
--       NOT read as company-paid and NOT read as personal: an older expense stays
--       unknown until somebody who may correct it says which it was.
--
--   §2  public.expense_reimbursements — one row per reimbursement: the date, the
--       ONE challan / payment reference, the count and total it covered, who
--       recorded it. public.expense_reimbursement_items — which expenses it
--       covered, with the amount and payer as they were at that moment.
--
--   §3  Guards. reimbursement_id moves only inside the two RPCs below; a
--       reimbursed expense's amount, source and payer are frozen and it cannot
--       be deleted; paying on SOMEBODY ELSE'S behalf takes finance.manage.
--
--   §4  record_expense_reimbursement() and reverse_expense_reimbursement(). A
--       batch pays ONE payer: a selection spanning several is refused. One
--       transaction each, expenses locked FOR UPDATE in id order, so two people
--       reimbursing the same expense at once produce one reimbursement and one
--       clear refusal. A partial unique index on the items is the independent
--       second guarantee.
--
--       CORRECTION IS REVERSAL, NOT A TOGGLE — the shape reverse_payment_
--       allocation() already uses in Finance. A wrong reimbursement is reversed
--       with a reason; the batch row, its items, who recorded it and who
--       reversed it all remain. Its expenses return to pending and can be
--       reimbursed again in a new batch.
--
--   §5  Bills: a PRIVATE bucket 'expense-bills' and public.expense_bill_
--       attachments. The storage read rule is bound to the recorded row, as
--       payment_proof_object_readable() is (20270118120000); files are opened
--       with short-lived signed URLs, never a public URL.
--
--   §6  finalize_expense_draft() takes the payment source too, so completing a
--       capture records it like the form does. Same body otherwise.
--
-- AUTHORITY — THE EXISTING FINANCE ACTIONS, NO NEW ONES
--
--   record an expense, attach a bill   as today: its author, or finance.manage
--   say somebody ELSE paid it          finance.manage (as correcting their row)
--   read an expense                    as today (author, finance.view_all, admin)
--                                      PLUS its recorded payer, read only
--   add a bill                         also the recorded payer of a personal
--                                      expense entered on their behalf
--   remove a bill                      its author or finance.manage; the payer
--                                      only a bill THEY uploaded; nobody once
--                                      the expense is reimbursed
--   read a reimbursement batch         finance.view_all / admin (and its recorder);
--                                      others see only their own expense's
--                                      date, reference and amount
--   record / reverse a reimbursement   finance.manage AND company-wide Finance
--                                      sight (finance.view_all, or role admin),
--                                      with Finance module entry
--   read a bill                        whoever may read the expense
--
-- ADDITIVE. No existing column, constraint, policy or row is changed; the three
-- new columns land NULL on every existing expense and §7 asserts it. The only
-- existing object redefined is finalize_expense_draft (two parameters added,
-- both defaulted, so the deployed client's 7-argument call still resolves).
--
-- ROLLOUT: MIGRATION FIRST, THEN MERGE. A merge to main deploys to production
-- automatically (Vercel), and the new screens read columns and functions this
-- file creates, so this file must be applied to production and checked with
-- supabase/tests/expense_reimbursement_production_check.sql BEFORE the PR is
-- merged. The app currently in production keeps working against it (it never
-- sends the new columns and its 7-argument finalize call still resolves).
--
-- ROLLBACK (only if needed, and only while no reimbursement or bill exists):
-- revert the app first; then drop, in order, the storage policies expense_bills_*,
-- the table expense_bill_attachments, the bucket (emptied through the Storage
-- API), the functions and tables of §2–§4, the policy expenses_paid_by_select,
-- the trigger expenses_guard_reimbursement, the three columns, and restore
-- finalize_expense_draft's 7-argument body and grants from 20261222000000 /
-- 20261223000000. A DB-level
-- "payment source is required on new expenses" rule is deliberately NOT here:
-- it would refuse the old client's saves in the window between migration and
-- deploy. The new form requires it; a follow-up can enforce it once deployed.
--
-- DEPENDENCIES: 20261220000000, 20261222000000, 20261223000000,
-- 20260901000000 (actor_has_*), 20260905000000 (module_entry_open).
-- ═══════════════════════════════════════════════════════════════════════════

do $dep$
begin
  if to_regclass('public.expenses') is null or to_regclass('public.expense_drafts') is null then
    raise exception 'DEPENDENCY MISSING: 20261220000000 / 20261222000000 (expenses) must be applied first';
  end if;
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null
     or to_regprocedure('public.actor_has_permission(text, text)') is null
     or to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: the Finance permission helpers';
  end if;
  if to_regprocedure('public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)') is null
     and to_regprocedure('public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text, text, uuid)') is null then
    raise exception 'DEPENDENCY MISSING: finalize_expense_draft (20261222000000), which §6 extends';
  end if;
end $dep$;


-- ═══ §1. Who paid, and the reimbursement batch table the link needs ═════════

create table if not exists public.expense_reimbursements (
  id uuid primary key default gen_random_uuid(),
  -- The date the money went back to the person, as Finance records it.
  reimbursed_on date not null,
  -- ONE PAYMENT TO ONE PERSON. Every expense in the batch was paid by this
  -- person (record_expense_reimbursement refuses a mixed selection), so the
  -- reference below names a single transfer to a single payee.
  payer_id uuid not null references public.users(id),
  -- THE ONE challan / payment reference for the whole batch. Stored once, here;
  -- an expense reaches it through reimbursement_id, never as a copied string.
  reference text not null,
  note text,
  expense_count integer not null,
  total_amount numeric not null,
  status text not null default 'recorded',
  recorded_by uuid not null references public.users(id),
  recorded_at timestamptz not null default now(),
  reversed_by uuid references public.users(id),
  reversed_at timestamptz,
  reversal_reason text,

  constraint expense_reimbursements_reference_valid check (
    reference = btrim(reference) and reference <> '' and char_length(reference) <= 120
  ),
  constraint expense_reimbursements_note_valid check (
    note is null or (btrim(note) <> '' and char_length(note) <= 500)
  ),
  constraint expense_reimbursements_count_positive check (expense_count > 0),
  constraint expense_reimbursements_total_valid check (
    total_amount <> 'NaN'::numeric and total_amount > 0 and total_amount = round(total_amount, 2)
  ),
  constraint expense_reimbursements_status_known check (status in ('recorded', 'reversed')),
  constraint expense_reimbursements_reversal_consistent check (
    (status = 'recorded' and reversed_by is null and reversed_at is null and reversal_reason is null)
    or (status = 'reversed' and reversed_by is not null and reversed_at is not null
        and reversal_reason is not null and btrim(reversal_reason) <> ''
        and char_length(reversal_reason) <= 500)
  )
);

comment on table public.expense_reimbursements is
  'One reimbursement to ONE payer of personally-paid expenses: its date, its single challan / payment reference, and who recorded it. Readable only by company-wide Finance sight (and its recorder); anybody else sees their own expense''s reimbursement through expense_reimbursement_receipts(). Written only by record_expense_reimbursement(); corrected only by reverse_expense_reimbursement(), which keeps the row. Never deleted. 20270205120000.';

create index if not exists expense_reimbursements_recorded_idx
  on public.expense_reimbursements (reimbursed_on desc, recorded_at desc);

alter table public.expenses
  add column if not exists paid_from text,
  add column if not exists paid_by uuid,
  add column if not exists reimbursement_id uuid;

do $cols$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.expenses'::regclass and conname = 'expenses_paid_by_fk') then
    alter table public.expenses
      add constraint expenses_paid_by_fk foreign key (paid_by) references public.users(id) not valid;
    alter table public.expenses validate constraint expenses_paid_by_fk;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.expenses'::regclass and conname = 'expenses_reimbursement_fk') then
    alter table public.expenses
      add constraint expenses_reimbursement_fk foreign key (reimbursement_id)
        references public.expense_reimbursements(id) not valid;
    alter table public.expenses validate constraint expenses_reimbursement_fk;
  end if;

  -- NULL IS "NOT RECORDED", a value of its own. Only the two named sources
  -- are storable beside it.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.expenses'::regclass and conname = 'expenses_paid_from_known') then
    alter table public.expenses
      add constraint expenses_paid_from_known check (
        paid_from is null or paid_from in ('company', 'personal')
      ) not valid;
    alter table public.expenses validate constraint expenses_paid_from_known;
  end if;

  -- A PAYER EXACTLY WHEN PAID PERSONALLY. NULL-SAFE ON PURPOSE: a CHECK passes
  -- when its expression is NULL, so `paid_from = 'personal'` alone would let an
  -- unrecorded source carry a payer. The suite proves this form refuses it.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.expenses'::regclass and conname = 'expenses_paid_by_matches_source') then
    alter table public.expenses
      add constraint expenses_paid_by_matches_source check (
        coalesce(paid_from = 'personal', false) = (paid_by is not null)
      ) not valid;
    alter table public.expenses validate constraint expenses_paid_by_matches_source;
  end if;

  -- COMPANY-PAID IS NEVER REIMBURSED, and neither is an unknown one.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.expenses'::regclass and conname = 'expenses_reimbursed_is_personal') then
    alter table public.expenses
      add constraint expenses_reimbursed_is_personal check (
        reimbursement_id is null or coalesce(paid_from = 'personal', false)
      ) not valid;
    alter table public.expenses validate constraint expenses_reimbursed_is_personal;
  end if;
end $cols$;

comment on column public.expenses.paid_from is
  'company = paid from a BOE account, never reimbursed; personal = paid by paid_by, to be reimbursed; NULL = not recorded (every expense entered before 20270205120000). NULL is never read as either.';
comment on column public.expenses.paid_by is
  'Who paid personally. Set exactly when paid_from = personal. Naming somebody other than yourself takes finance.manage.';
comment on column public.expenses.reimbursement_id is
  'The reimbursement that currently covers this expense, NULL while pending. Moved only by record_/reverse_expense_reimbursement(); the history is in expense_reimbursement_items.';

-- The pending list is the one Finance works from.
create index if not exists expenses_pending_reimbursement_idx
  on public.expenses (expense_date desc, id desc)
  where deleted_at is null and paid_from = 'personal' and reimbursement_id is null;
create index if not exists expenses_reimbursement_id_idx
  on public.expenses (reimbursement_id) where reimbursement_id is not null;
create index if not exists expenses_paid_by_idx
  on public.expenses (paid_by) where paid_by is not null;


-- ═══ §2. The items: which expenses a reimbursement covered ══════════════════

create table if not exists public.expense_reimbursement_items (
  id uuid primary key default gen_random_uuid(),
  reimbursement_id uuid not null references public.expense_reimbursements(id),
  expense_id uuid not null references public.expenses(id),
  -- AS THEY WERE WHEN REIMBURSED. The expense's own amount and payer are frozen
  -- while it is reimbursed (§3), so these agree with it; they are kept so a
  -- reversed batch still says exactly what it paid.
  amount numeric not null,
  paid_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  constraint expense_reimbursement_items_amount_valid check (
    amount <> 'NaN'::numeric and amount > 0 and amount = round(amount, 2)
  )
);

comment on table public.expense_reimbursement_items is
  'Which expenses a reimbursement covered, with the amount and payer at that moment. reversed_at is set when the reimbursement is reversed; the row is kept. At most one un-reversed item per expense. 20270205120000.';

create unique index if not exists expense_reimbursement_items_once_per_batch
  on public.expense_reimbursement_items (reimbursement_id, expense_id);
-- ONE ACTIVE REIMBURSEMENT PER EXPENSE, whatever wrote it — the second, independent
-- guarantee behind the row locks in §4.
create unique index if not exists expense_reimbursement_items_one_active
  on public.expense_reimbursement_items (expense_id) where reversed_at is null;


-- ═══ §3. Guards ═════════════════════════════════════════════════════════════

-- ── THE PAYER MAY READ AN EXPENSE RECORDED ON THEIR BEHALF ──
--
-- Before this, an expense was readable by its author, finance.view_all and admin.
-- When Finance records an expense somebody ELSE paid (paid_by <> created_by,
-- which only finance.manage can do), the person owed the money could not see it,
-- nor whether it had been reimbursed. This adds exactly that person, READ ONLY:
-- no UPDATE policy names paid_by, so they cannot correct, delete or reclassify
-- it, and bills stay attachable only by the author or finance.manage. The
-- restrictive module gate still applies — without Finance entry they see
-- nothing. Existing expenses have paid_by NULL, so no current row changes
-- audience.
drop policy if exists expenses_paid_by_select on public.expenses;
create policy expenses_paid_by_select
  on public.expenses
  for select to authenticated
  using (paid_by = auth.uid());

-- WHO MAY SEE AN EXPENSE, as one function the storage rule can ask. Mirrors the
-- four SELECT policies on public.expenses (admin, finance.view_all, author,
-- payer) and the restrictive module gate.
create or replace function public.can_view_expense(p_expense_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid() is not null
     and public.module_entry_open('finance')
     and exists (
       select 1 from public.expenses e
        where e.id = p_expense_id
          and (e.created_by = auth.uid()
               or e.paid_by = auth.uid()
               or public.actor_has_module_permission('finance', 'view_all'))
     );
$fn$;
revoke all on function public.can_view_expense(uuid) from public, anon;
grant execute on function public.can_view_expense(uuid) to authenticated;

-- WHO MAY RECORD OR REVERSE A REIMBURSEMENT. finance.manage — the protected
-- action this module already requires to rewrite somebody else's expense — and
-- company-wide sight of the expenses being paid back.
create or replace function public.can_record_expense_reimbursement()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid() is not null
     and public.module_entry_open('finance')
     and public.actor_has_module_permission('finance', 'manage')
     and public.actor_has_module_permission('finance', 'view_all');
$fn$;
revoke all on function public.can_record_expense_reimbursement() from public, anon;
grant execute on function public.can_record_expense_reimbursement() to authenticated;

create or replace function public.expenses_guard_reimbursement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  -- coalesce: an unset setting reads as NULL, and `NOT NULL` would let the
  -- guard below pass silently.
  v_rpc boolean := coalesce(current_setting('boe.expense_reimbursement_write', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.reimbursement_id is not null then
      raise exception 'An expense is reimbursed through Record reimbursement, not when it is entered'
        using errcode = '42501';
    end if;
  else
    -- THE LINK MOVES ONLY INSIDE THE TWO RPCs.
    if new.reimbursement_id is distinct from old.reimbursement_id and not v_rpc then
      raise exception 'A reimbursement is recorded or reversed only through Finance''s reimbursement action'
        using errcode = '42501';
    end if;

    -- A REIMBURSED EXPENSE KEEPS WHAT WAS PAID BACK. Its amount, source and
    -- payer are what the reimbursement paid; reverse the reimbursement first.
    if old.reimbursement_id is not null and new.reimbursement_id is not distinct from old.reimbursement_id then
      if new.amount is distinct from old.amount
         or new.paid_from is distinct from old.paid_from
         or new.paid_by is distinct from old.paid_by then
        raise exception 'This expense has been reimbursed, so its amount and who paid it cannot change. Reverse the reimbursement first.'
          using errcode = '42501';
      end if;
      if new.deleted_by is not null and old.deleted_by is null then
        raise exception 'A reimbursed expense cannot be deleted. Reverse the reimbursement first.'
          using errcode = '42501';
      end if;
    end if;

    -- Once recorded, the source is never "forgotten" back to unknown.
    if old.paid_from is not null and new.paid_from is null then
      raise exception 'Choose how this expense was paid; it cannot go back to not recorded'
        using errcode = '42501';
    end if;
  end if;

  -- PAID ON SOMEBODY ELSE'S BEHALF takes finance.manage — the same authority as
  -- correcting their expense. Checked only when the payer is being set or
  -- changed, and only for a signed-in caller (the service role has none).
  if new.paid_by is not null
     and auth.uid() is not null
     and new.paid_by <> auth.uid()
     and (tg_op = 'INSERT' or new.paid_by is distinct from old.paid_by)
     and not public.actor_has_module_permission('finance', 'manage') then
    raise exception 'Only Finance can record an expense as paid by somebody else'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;
revoke all on function public.expenses_guard_reimbursement() from public, anon, authenticated;

drop trigger if exists expenses_guard_reimbursement on public.expenses;
create trigger expenses_guard_reimbursement
  before insert or update on public.expenses
  for each row execute function public.expenses_guard_reimbursement();

-- A REIMBURSEMENT IS RECORDED ONCE AND REVERSED AT MOST ONCE. Nothing else about
-- it ever changes, and it is never deleted — by any caller, service role included.
create or replace function public.expense_reimbursements_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'A reimbursement cannot be deleted; reverse it instead' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'recorded' then
      raise exception 'A reimbursement is created as recorded' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status <> 'recorded' or new.status <> 'reversed'
     or (to_jsonb(new) - array['status', 'reversed_by', 'reversed_at', 'reversal_reason'])
        is distinct from (to_jsonb(old) - array['status', 'reversed_by', 'reversed_at', 'reversal_reason']) then
    raise exception 'A reimbursement can only be reversed, once, and nothing else about it can change'
      using errcode = '42501';
  end if;
  new.reversed_at := now();
  return new;
end;
$fn$;
revoke all on function public.expense_reimbursements_guard() from public, anon, authenticated;

drop trigger if exists expense_reimbursements_guard on public.expense_reimbursements;
create trigger expense_reimbursements_guard
  before insert or update or delete on public.expense_reimbursements
  for each row execute function public.expense_reimbursements_guard();

create or replace function public.expense_reimbursement_items_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Reimbursement history cannot be deleted' using errcode = '42501';
  end if;
  if old.reversed_at is not null or new.reversed_at is null
     or (to_jsonb(new) - 'reversed_at') is distinct from (to_jsonb(old) - 'reversed_at') then
    raise exception 'Reimbursement history can only be marked reversed, once' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.expense_reimbursement_items_guard() from public, anon, authenticated;

drop trigger if exists expense_reimbursement_items_guard on public.expense_reimbursement_items;
create trigger expense_reimbursement_items_guard
  before update or delete on public.expense_reimbursement_items
  for each row execute function public.expense_reimbursement_items_guard();


-- ═══ §3a. RLS on the two new tables: read-only to clients ═══════════════════

alter table public.expense_reimbursements enable row level security;
alter table public.expense_reimbursement_items enable row level security;
revoke all on table public.expense_reimbursements from public, anon, authenticated;
revoke all on table public.expense_reimbursement_items from public, anon, authenticated;
grant select on table public.expense_reimbursements to authenticated;
grant select on table public.expense_reimbursement_items to authenticated;

drop policy if exists expense_reimbursements_module_entry_gate on public.expense_reimbursements;
create policy expense_reimbursements_module_entry_gate
  on public.expense_reimbursements
  as restrictive for all to authenticated
  using (public.module_entry_open('finance'))
  with check (public.module_entry_open('finance'));

drop policy if exists expense_reimbursement_items_module_entry_gate on public.expense_reimbursement_items;
create policy expense_reimbursement_items_module_entry_gate
  on public.expense_reimbursement_items
  as restrictive for all to authenticated
  using (public.module_entry_open('finance'))
  with check (public.module_entry_open('finance'));

-- An item is readable exactly when its expense is (the expenses policies decide).
drop policy if exists expense_reimbursement_items_select on public.expense_reimbursement_items;
create policy expense_reimbursement_items_select
  on public.expense_reimbursement_items
  for select to authenticated
  using (exists (select 1 from public.expenses e where e.id = expense_id));

-- THE BATCH IS FINANCE'S. Its total, count and note describe the whole payment,
-- so the row is readable only by company-wide Finance sight (admin included) and
-- by whoever recorded it. An employee sees THEIR OWN expense's reimbursement —
-- date, reference, that expense's amount, who recorded it — through
-- expense_reimbursement_receipts() below, which returns nothing about any other
-- expense in the batch.
drop policy if exists expense_reimbursements_select on public.expense_reimbursements;
create policy expense_reimbursements_select
  on public.expense_reimbursements
  for select to authenticated
  using (
    public.actor_has_module_permission('finance', 'view_all')
    or recorded_by = auth.uid()
  );


-- ── Each reader's own reimbursements, and nothing else about the batch ──
--
-- One row per requested expense the caller may see AND that is currently
-- reimbursed: that expense's own amount (its item), the date, the reference and
-- who recorded it. Never the batch total, count, note, or any other expense —
-- the caller asks by expense id and can_view_expense() decides each one.
create or replace function public.expense_reimbursement_receipts(p_expense_ids uuid[])
returns table (
  expense_id uuid,
  reimbursement_id uuid,
  reimbursed_on date,
  reference text,
  amount numeric,
  recorded_by uuid,
  recorded_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select i.expense_id, r.id, r.reimbursed_on, r.reference, i.amount, r.recorded_by, r.recorded_at
    from public.expense_reimbursement_items i
    join public.expense_reimbursements r on r.id = i.reimbursement_id
   where i.expense_id = any(coalesce(p_expense_ids, '{}'))
     and i.reversed_at is null
     and r.status = 'recorded'
     and public.can_view_expense(i.expense_id);
$fn$;
comment on function public.expense_reimbursement_receipts(uuid[]) is
  'Per-expense reimbursement facts (date, reference, that expense''s amount, recorder) for expenses the caller may read. Never exposes a batch''s total, count, note or other expenses. 20270205120000.';
revoke all on function public.expense_reimbursement_receipts(uuid[]) from public, anon;
grant execute on function public.expense_reimbursement_receipts(uuid[]) to authenticated;


-- ═══ §4. The two doors ══════════════════════════════════════════════════════

create or replace function public.record_expense_reimbursement(
  p_expense_ids uuid[],
  p_reimbursed_on date,
  p_reference text,
  p_expected_total numeric,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
  v_ids uuid[];
  v_reference text := btrim(coalesce(p_reference, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_found int;
  v_deleted int;
  v_company int;
  v_unknown int;
  v_already int;
  v_total numeric;
  v_payers int;
  v_payer uuid;
  v_id uuid;
  v_problems text[] := '{}';
begin
  if v_actor is null then
    raise exception 'EXPENSE_REIMBURSEMENT_FORBIDDEN: sign in to record a reimbursement' using errcode = '42501';
  end if;
  if not public.can_record_expense_reimbursement() then
    raise exception 'EXPENSE_REIMBURSEMENT_FORBIDDEN: only Finance can record a reimbursement' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_expense_ids, '{}')) x where x is not null;
  if cardinality(v_ids) = 0 then
    raise exception 'EXPENSE_REIMBURSEMENT_INVALID: choose at least one expense' using errcode = '22023';
  end if;
  if cardinality(v_ids) <> cardinality(p_expense_ids) then
    raise exception 'EXPENSE_REIMBURSEMENT_INVALID: an expense was listed twice' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 200 then
    raise exception 'EXPENSE_REIMBURSEMENT_INVALID: reimburse at most 200 expenses at once' using errcode = '22023';
  end if;
  if v_reference = '' or char_length(v_reference) > 120 then
    raise exception 'EXPENSE_REIMBURSEMENT_INVALID: enter the challan / payment reference (up to 120 characters)' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'EXPENSE_REIMBURSEMENT_INVALID: keep the note to 500 characters' using errcode = '22023';
  end if;
  if p_reimbursed_on is null or p_reimbursed_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'EXPENSE_REIMBURSEMENT_INVALID: choose the reimbursement date (not in the future)' using errcode = '22023';
  end if;

  -- THE LOCK, in id order so two overlapping batches cannot deadlock. A second
  -- caller waits here and then reads the first caller's result below.
  perform 1 from public.expenses where id = any(v_ids) order by id for update;

  select count(*),
         count(*) filter (where deleted_at is not null),
         count(*) filter (where deleted_at is null and paid_from = 'company'),
         count(*) filter (where deleted_at is null and paid_from is null),
         count(*) filter (where deleted_at is null and paid_from = 'personal' and reimbursement_id is not null),
         coalesce(sum(amount) filter (where deleted_at is null), 0)
    into v_found, v_deleted, v_company, v_unknown, v_already, v_total
    from public.expenses where id = any(v_ids);

  if v_found <> cardinality(v_ids) then
    v_problems := v_problems || format('%s no longer exist', cardinality(v_ids) - v_found);
  end if;
  if v_deleted > 0 then v_problems := v_problems || format('%s deleted', v_deleted); end if;
  if v_company > 0 then v_problems := v_problems || format('%s paid from a company account', v_company); end if;
  if v_unknown > 0 then v_problems := v_problems || format('%s with no payment source recorded', v_unknown); end if;
  if v_already > 0 then v_problems := v_problems || format('%s already reimbursed', v_already); end if;
  if cardinality(v_problems) > 0 then
    raise exception 'EXPENSE_REIMBURSEMENT_NOT_PENDING: only pending personal expenses can be reimbursed — the selection includes %',
      array_to_string(v_problems, ', ') using errcode = '23514';
  end if;

  -- ONE PAYER PER REIMBURSEMENT. A challan / payment reference names one
  -- transfer to one person; expenses paid by different people are reimbursed
  -- in separate batches, each with its own date and reference.
  select count(distinct paid_by), min(paid_by::text)::uuid into v_payers, v_payer
    from public.expenses where id = any(v_ids);
  if v_payers <> 1 then
    raise exception 'EXPENSE_REIMBURSEMENT_MIXED_PAYERS: the selection was paid by % different people — reimburse one payer at a time, each with its own reference',
      v_payers using errcode = '23514';
  end if;

  -- WHAT THE PERSON CONFIRMED. If an amount changed after the screen showed it,
  -- the total they agreed to is not the total being recorded.
  if p_expected_total is null or v_total <> p_expected_total then
    raise exception 'EXPENSE_REIMBURSEMENT_STALE: the selected amounts changed since they were shown (now %). Refresh and check again.',
      v_total using errcode = '40001';
  end if;

  insert into public.expense_reimbursements (reimbursed_on, payer_id, reference, note, expense_count, total_amount, recorded_by)
  values (p_reimbursed_on, v_payer, v_reference, v_note, cardinality(v_ids), v_total, v_actor)
  returning id into v_id;

  insert into public.expense_reimbursement_items (reimbursement_id, expense_id, amount, paid_by)
  select v_id, e.id, e.amount, e.paid_by from public.expenses e where e.id = any(v_ids);

  perform set_config('boe.expense_reimbursement_write', 'on', true);
  update public.expenses set reimbursement_id = v_id where id = any(v_ids);
  perform set_config('boe.expense_reimbursement_write', 'off', true);

  return jsonb_build_object('reimbursement_id', v_id, 'expense_count', cardinality(v_ids), 'total_amount', v_total);
end;
$fn$;

comment on function public.record_expense_reimbursement(uuid[], date, text, numeric, text) is
  'Records ONE reimbursement to ONE payer over several of their pending personal expenses, atomically, under row locks. Refuses company-paid, unrecorded, deleted and already-reimbursed expenses, a selection spanning more than one payer, and a total that no longer matches what was confirmed. finance.manage + company-wide Finance sight. 20270205120000.';

create or replace function public.reverse_expense_reimbursement(
  p_reimbursement_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_batch public.expense_reimbursements;
  v_count int;
begin
  if v_actor is null or not public.can_record_expense_reimbursement() then
    raise exception 'EXPENSE_REIMBURSEMENT_FORBIDDEN: only Finance can reverse a reimbursement' using errcode = '42501';
  end if;
  if v_reason = '' or char_length(v_reason) > 500 then
    raise exception 'EXPENSE_REIMBURSEMENT_INVALID: say why this reimbursement is being reversed (up to 500 characters)' using errcode = '22023';
  end if;

  select * into v_batch from public.expense_reimbursements where id = p_reimbursement_id for update;
  if not found then
    raise exception 'EXPENSE_REIMBURSEMENT_NOT_FOUND: that reimbursement does not exist' using errcode = 'P0002';
  end if;
  if v_batch.status <> 'recorded' then
    raise exception 'EXPENSE_REIMBURSEMENT_ALREADY_REVERSED: this reimbursement was already reversed' using errcode = '23514';
  end if;

  perform 1 from public.expenses where reimbursement_id = v_batch.id order by id for update;

  update public.expense_reimbursements
     set status = 'reversed', reversed_by = v_actor, reversed_at = now(), reversal_reason = v_reason
   where id = v_batch.id;
  update public.expense_reimbursement_items set reversed_at = now()
   where reimbursement_id = v_batch.id and reversed_at is null;

  perform set_config('boe.expense_reimbursement_write', 'on', true);
  update public.expenses set reimbursement_id = null where reimbursement_id = v_batch.id;
  get diagnostics v_count = row_count;
  perform set_config('boe.expense_reimbursement_write', 'off', true);

  return jsonb_build_object('reimbursement_id', v_batch.id, 'expenses_returned_to_pending', v_count);
end;
$fn$;

comment on function public.reverse_expense_reimbursement(uuid, text) is
  'Reverses a recorded reimbursement with a reason. Keeps the reimbursement and its items; its expenses return to pending. finance.manage + company-wide Finance sight. 20270205120000.';

revoke all on function public.record_expense_reimbursement(uuid[], date, text, numeric, text) from public, anon;
grant execute on function public.record_expense_reimbursement(uuid[], date, text, numeric, text) to authenticated;
revoke all on function public.reverse_expense_reimbursement(uuid, text) from public, anon;
grant execute on function public.reverse_expense_reimbursement(uuid, text) to authenticated;


-- ═══ §5. Bills ══════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expense-bills', 'expense-bills', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.expense_bill_attachments (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id),
  -- {expense_id}/{uuid}.{ext} inside the private bucket. Never a URL.
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  uploaded_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  removed_by uuid references public.users(id),
  removed_at timestamptz,
  constraint expense_bill_attachments_path_valid check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg|jpeg|webp)$'
    and split_part(storage_path, '/', 1) = expense_id::text
  ),
  constraint expense_bill_attachments_name_valid check (char_length(file_name) between 1 and 200),
  constraint expense_bill_attachments_mime_known check (
    mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  ),
  constraint expense_bill_attachments_size_valid check (size_bytes > 0 and size_bytes <= 10485760),
  constraint expense_bill_attachments_removed_pair check ((removed_at is null) = (removed_by is null))
);

comment on table public.expense_bill_attachments is
  'Bills / invoices supporting an expense. Files live in the private expense-bills bucket and are opened through short-lived signed URLs. A removed bill keeps its row (removed_by / removed_at); a reimbursed expense''s bills cannot be removed. 20270205120000.';

create unique index if not exists expense_bill_attachments_path_key
  on public.expense_bill_attachments (storage_path);
create index if not exists expense_bill_attachments_live_idx
  on public.expense_bill_attachments (expense_id) where removed_at is null;

-- WHO MAY ADD OR REMOVE A BILL: exactly who may correct the expense — its author,
-- or finance.manage — while it is not deleted.
create or replace function public.can_attach_expense_bill(p_expense_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid() is not null
     and public.module_entry_open('finance')
     and exists (
       select 1 from public.expenses e
         join public.users u on u.id = auth.uid()
        where e.id = p_expense_id
          and e.deleted_at is null
          and u.is_active and coalesce(u.is_deleted, false) = false
          and (e.created_by = u.id or public.actor_has_module_permission('finance', 'manage'))
     );
$fn$;
revoke all on function public.can_attach_expense_bill(uuid) from public, anon;
grant execute on function public.can_attach_expense_bill(uuid) to authenticated;

-- WHO MAY ADD A BILL: everybody above, PLUS the named payer of a personal expense
-- Finance entered on their behalf — they are the one holding the bill. The
-- payer may remove only a bill THEY uploaded (expense_bill_attachments_remove);
-- their access to the expense itself stays read only (no UPDATE policy names
-- paid_by).
create or replace function public.can_add_expense_bill(p_expense_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.can_attach_expense_bill(p_expense_id)
      or (auth.uid() is not null
          and public.module_entry_open('finance')
          and exists (
            select 1 from public.expenses e
              join public.users u on u.id = auth.uid()
             where e.id = p_expense_id
               and e.deleted_at is null
               and e.paid_from = 'personal'
               and e.paid_by = u.id
               and u.is_active and coalesce(u.is_deleted, false) = false
          ));
$fn$;
revoke all on function public.can_add_expense_bill(uuid) from public, anon;
grant execute on function public.can_add_expense_bill(uuid) to authenticated;

-- Storage INSERT: a well-formed key under an expense the caller may add a bill to.
-- The key is validated BEFORE its first segment is cast, so a malformed name is
-- refused, never an error.
create or replace function public.can_upload_expense_bill(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_name is null or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg|jpeg|webp)$' then
    return false;
  end if;
  return public.can_add_expense_bill(split_part(p_name, '/', 1)::uuid);
end;
$fn$;
revoke all on function public.can_upload_expense_bill(text) from public, anon;
grant execute on function public.can_upload_expense_bill(text) to authenticated;

-- Storage SELECT: BOUND TO THE RECORD. A file named by a bill row opens for
-- whoever may read that expense; an upload no row names yet opens only for its
-- uploader (Storage's remove() needs SELECT, and the form removes its own upload
-- when saving the row fails). A guessed path opens nothing.
create or replace function public.expense_bill_object_readable(p_name text, p_owner_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_expense uuid;
begin
  if auth.uid() is null or p_name is null then
    return false;
  end if;
  select a.expense_id into v_expense from public.expense_bill_attachments a where a.storage_path = p_name;
  if found then
    return public.can_view_expense(v_expense);
  end if;
  return p_owner_id is not null and p_owner_id = auth.uid()::text;
end;
$fn$;
revoke all on function public.expense_bill_object_readable(text, text) from public, anon;
grant execute on function public.expense_bill_object_readable(text, text) to authenticated;

-- A bill row may only name a file the caller actually uploaded to that key.
create or replace function public.expense_bill_object_uploaded_by_caller(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from storage.objects o
     where o.bucket_id = 'expense-bills' and o.name = p_name
       and o.owner_id = auth.uid()::text
  );
$fn$;
revoke all on function public.expense_bill_object_uploaded_by_caller(text) from public, anon;
grant execute on function public.expense_bill_object_uploaded_by_caller(text) to authenticated;

drop policy if exists expense_bills_insert on storage.objects;
create policy expense_bills_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'expense-bills' and public.can_upload_expense_bill(name));

drop policy if exists expense_bills_select on storage.objects;
create policy expense_bills_select on storage.objects
  for select to authenticated
  using (bucket_id = 'expense-bills' and public.expense_bill_object_readable(name, owner_id));

-- Only an upload that no bill row names, by its own uploader: the compensation
-- path for a failed save. A recorded bill's file is never deleted by a client.
drop policy if exists expense_bills_delete on storage.objects;
create policy expense_bills_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'expense-bills'
    and owner_id = auth.uid()::text
    and not exists (select 1 from public.expense_bill_attachments a where a.storage_path = name)
  );

create or replace function public.expense_bill_attachments_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'A bill is removed, never deleted' using errcode = '42501';
  end if;
  if old.removed_at is not null then
    raise exception 'This bill was already removed' using errcode = '42501';
  end if;
  if new.removed_by is null
     or (to_jsonb(new) - array['removed_by', 'removed_at']) is distinct from (to_jsonb(old) - array['removed_by', 'removed_at']) then
    raise exception 'A bill can only be removed; its file and details cannot change' using errcode = '42501';
  end if;
  if auth.uid() is not null and new.removed_by <> auth.uid() then
    raise exception 'A removed bill must name the person who removed it' using errcode = '42501';
  end if;
  if exists (select 1 from public.expenses e where e.id = old.expense_id and e.reimbursement_id is not null) then
    raise exception 'The bills of a reimbursed expense cannot be removed. Reverse the reimbursement first.'
      using errcode = '42501';
  end if;
  new.removed_at := now();
  return new;
end;
$fn$;
revoke all on function public.expense_bill_attachments_guard() from public, anon, authenticated;

drop trigger if exists expense_bill_attachments_guard on public.expense_bill_attachments;
create trigger expense_bill_attachments_guard
  before update or delete on public.expense_bill_attachments
  for each row execute function public.expense_bill_attachments_guard();

alter table public.expense_bill_attachments enable row level security;
revoke all on table public.expense_bill_attachments from public, anon, authenticated;
grant select, insert on table public.expense_bill_attachments to authenticated;
grant update (removed_by, removed_at) on table public.expense_bill_attachments to authenticated;

drop policy if exists expense_bill_attachments_module_entry_gate on public.expense_bill_attachments;
create policy expense_bill_attachments_module_entry_gate
  on public.expense_bill_attachments
  as restrictive for all to authenticated
  using (public.module_entry_open('finance'))
  with check (public.module_entry_open('finance'));

-- Readable exactly when the expense is (the expenses policies decide).
drop policy if exists expense_bill_attachments_select on public.expense_bill_attachments;
create policy expense_bill_attachments_select
  on public.expense_bill_attachments
  for select to authenticated
  using (exists (select 1 from public.expenses e where e.id = expense_id));

drop policy if exists expense_bill_attachments_insert on public.expense_bill_attachments;
create policy expense_bill_attachments_insert
  on public.expense_bill_attachments
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and removed_by is null and removed_at is null
    and public.can_add_expense_bill(expense_id)
    and public.expense_bill_object_uploaded_by_caller(storage_path)
  );

drop policy if exists expense_bill_attachments_remove on public.expense_bill_attachments;
-- WHO MAY REMOVE A BILL: whoever may correct the expense (its author or
-- finance.manage), or the named payer for a bill THEY uploaded. Never once the
-- expense is reimbursed — expense_bill_attachments_guard refuses that for every
-- caller. Removal is a tombstone (removed_by / removed_at); the row and the file
-- stay, so the history is kept.
create policy expense_bill_attachments_remove
  on public.expense_bill_attachments
  for update to authenticated
  using (
    public.can_attach_expense_bill(expense_id)
    or (uploaded_by = auth.uid() and public.can_add_expense_bill(expense_id))
  )
  with check (
    (public.can_attach_expense_bill(expense_id)
     or (uploaded_by = auth.uid() and public.can_add_expense_bill(expense_id)))
    and removed_by = auth.uid()
  );


-- ═══ §6. Completing a capture records the payment source too ════════════════
--
-- The body is 20261222000000's, unchanged, plus two defaulted parameters and two
-- columns in the insert. The old 7-argument signature is dropped because a
-- second overload would make PostgREST's 7-argument call ambiguous; the new one
-- accepts that same call. Grants restated WITHOUT anon (20261223000000).

drop function if exists public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text);

create or replace function public.finalize_expense_draft(
  p_draft_id uuid,
  p_expense_date date,
  p_amount numeric,
  p_payment_mode text,
  p_paid_to text,
  p_category_id uuid,
  p_remark text default null,
  p_paid_from text default null,
  p_paid_by uuid default null
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
  if v_actor is null then
    raise exception 'You must be signed in to complete a capture'
      using errcode = '42501';
  end if;
  if not public.module_entry_open('finance') then
    raise exception 'You do not have access to Finance'
      using errcode = '42501';
  end if;
  if not public.actor_has_module_permission('finance', 'create') then
    raise exception 'You do not have permission to record an expense'
      using errcode = '42501';
  end if;

  select * into v_draft
  from public.expense_drafts
  where id = p_draft_id
  for update;

  if not found then
    raise exception 'That capture no longer exists'
      using errcode = 'P0002';
  end if;

  if v_draft.created_by <> v_actor
     and not public.actor_has_module_permission('finance', 'manage') then
    raise exception 'You do not have permission to complete this capture'
      using errcode = '42501';
  end if;

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

  v_remark := nullif(btrim(coalesce(p_remark, '')), '');

  -- paid_by is kept only for a personal payment, and defaults to the caller.
  -- The table's CHECKs and expenses_guard_reimbursement decide the rest,
  -- including that naming somebody else takes finance.manage.
  insert into public.expenses (
    expense_date, amount, payment_mode, paid_to, category_id, remark, created_by,
    paid_from, paid_by
  ) values (
    p_expense_date, p_amount, p_payment_mode, btrim(p_paid_to), p_category_id, v_remark,
    v_actor,
    p_paid_from,
    case when p_paid_from = 'personal' then coalesce(p_paid_by, v_actor) end
  )
  returning id into v_expense_id;

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

comment on function public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text, text, uuid) is
  'Turns one pending capture into EXACTLY ONE expense, in one transaction, under a row lock. A retry returns the first call''s expense id with created=false and writes nothing. Records the payment source (20270205120000). Re-derives Finance entry, finance.create and ownership-or-finance.manage; created_by comes from auth.uid().';

revoke all on function public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text, text, uuid) from public, anon;
grant execute on function public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text, text, uuid) to authenticated;


-- ═══ §7. Assertions ═════════════════════════════════════════════════════════

do $assert$
declare
  v_count int;
begin
  -- Every existing expense is still unknown, unreimbursed and live-as-before.
  select count(*) into v_count from public.expenses
   where paid_from is not null or paid_by is not null or reimbursement_id is not null;
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED: % existing expenses were classified by this migration', v_count;
  end if;

  if (select public from storage.buckets where id = 'expense-bills') is distinct from false then
    raise exception 'ASSERTION FAILED: the expense-bills bucket must be private';
  end if;

  -- No client role may DELETE any of the new tables, or execute a door as anon.
  select count(*) into v_count from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('expense_reimbursements', 'expense_reimbursement_items', 'expense_bill_attachments')
     and privilege_type in ('DELETE', 'TRUNCATE') and grantee in ('anon', 'authenticated');
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED: a client role can delete reimbursement or bill history (% grants)', v_count;
  end if;
  select count(*) into v_count from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('expense_reimbursements', 'expense_reimbursement_items', 'expense_bill_attachments')
     and grantee = 'anon';
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED: anon holds % grants on the new expense tables', v_count;
  end if;
  if has_function_privilege('anon', 'public.record_expense_reimbursement(uuid[], date, text, numeric, text)', 'execute')
     or has_function_privilege('anon', 'public.reverse_expense_reimbursement(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text, text, uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can execute an expense door';
  end if;

  -- The Phase 1/2 UPDATE policies are still exactly the two.
  select count(*) into v_count from pg_policies
   where schemaname = 'public' and tablename = 'expenses' and cmd = 'UPDATE' and permissive = 'PERMISSIVE';
  if v_count <> 2 then
    raise exception 'ASSERTION FAILED: expected the 2 existing UPDATE policies on expenses, found %', v_count;
  end if;

  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'expense_reimbursement_items_one_active') then
    raise exception 'ASSERTION FAILED: the one-active-reimbursement index is missing';
  end if;

  -- The batch row is Finance's: exactly one permissive SELECT policy, and it
  -- does not admit an expense's author.
  select count(*) into v_count from pg_policies
   where schemaname = 'public' and tablename = 'expense_reimbursements'
     and cmd = 'SELECT' and permissive = 'PERMISSIVE';
  if v_count <> 1 or exists (select 1 from pg_policies
       where schemaname = 'public' and tablename = 'expense_reimbursements'
         and coalesce(qual, '') like '%created_by%') then
    raise exception 'ASSERTION FAILED: a reimbursement batch is readable beyond Finance';
  end if;
  if has_function_privilege('anon', 'public.expense_reimbursement_receipts(uuid[])', 'execute') then
    raise exception 'ASSERTION FAILED: anon can execute expense_reimbursement_receipts';
  end if;
  -- The payer's policy is read-only: still exactly the 2 existing UPDATE
  -- policies (checked above), and the new one is SELECT.
  if (select cmd from pg_policies where schemaname = 'public' and tablename = 'expenses'
        and policyname = 'expenses_paid_by_select') is distinct from 'SELECT' then
    raise exception 'ASSERTION FAILED: expenses_paid_by_select must exist and be SELECT only';
  end if;
end $assert$;
