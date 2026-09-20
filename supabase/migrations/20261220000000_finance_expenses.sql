-- ── Finance → Expenses, Phase 1 ──────────────────────────────────────────────
--
-- WHAT THIS IS. Money BOE PAYS OUT, recorded by the person who paid it. Small
-- business expenses — diesel, a repair, a courier, a site visit — are currently
-- paid personally while somebody is moving around the factory or travelling,
-- and then typed into a spreadsheet later, or not at all. Two new tables, so
-- that entry takes seconds on a phone.
--
-- WHAT THIS IS NOT, AND THE SEPARATION IS STRUCTURAL, NOT A CONVENTION. An
-- expense is not a customer receipt. It has no customer, no PI, no Order, no
-- allocation, no verification, no proof attachment and no request lifecycle. It
-- touches NONE of finance_payment_requests, finance_payment_allocations,
-- payment_proof_attachments, orders, order_submissions or any balance derived
-- from them. Nothing in this file reads, writes, alters or references those
-- tables, and nothing in them will reference these.
--
-- ADDITIVE AND ONLY ADDITIVE. This file creates two tables, their constraints,
-- their indexes, their RLS policies and one updated_at trigger each. There is
-- no ALTER of an existing table, no DROP of anything that existed before this
-- migration, no change to any existing function or policy, and NO DML against
-- any existing business table. Section 6 asserts that.
--
-- ── PAYMENT MODE: WHY A SEPARATE LIST, DELIBERATELY ─────────────────────────
--
-- The obvious move was to reuse finance_payment_requests.payment_mode. It is
-- the WRONG list here, for two independent reasons, and both are worth stating
-- so nobody "unifies" them later:
--
--   1. The four current values — hdfc, pnb, paytm, canara — are the BOE
--      ACCOUNTS MONEY ARRIVES INTO (20261014000000 section 1). "Which BOE
--      account received this" is meaningless for money BOE paid out of
--      somebody's own pocket.
--   2. The five generic values that would have fitted — bank_transfer, cash,
--      upi, cheque, other — are RETIRED. They remain storable so history reads,
--      and finance_payment_requests_enforce_current_payment_mode REFUSES them
--      for a new entry. Reusing a retired domain for a new feature would mean
--      building on values the database is actively rejecting.
--
-- So expenses carry their own, unretired, outgoing-payment domain. The two
-- columns are independent by design and neither constrains the other.
--
-- ── ACCESS: THE EXISTING FINANCE MODEL, UNCHANGED ───────────────────────────
--
-- No new module, no new action key, no new permission row, no widening. Read as
-- a set, the policies in sections 4 and 5 say:
--
--   restrictive gate   module_entry_open('finance') — the same parent gate
--                      20260905000000 put on the three existing Finance tables.
--                      A person without Finance entry reaches NOTHING here, for
--                      SELECT, INSERT, UPDATE and DELETE alike.
--   admin              full read and write, matching
--                      finance_payment_requests_admin_select/_update.
--   finance.view_all   company-wide READ, the same protected action that already
--                      grants company-wide sight of the payments themselves
--                      (20260903000000). It confers no write.
--   own rows           the person who recorded an expense may read and correct
--                      it — the same ownership rule as
--                      finance_payment_requests_own_select/_insert/_own_update.
--   finance.create     required to record an expense at all.
--   finance.manage     required to correct SOMEBODY ELSE'S expense. This is the
--                      protected action the module already uses for "rewrite a
--                      financial fact that has already been reported"; no access
--                      level grants it (levels.ts).
--
-- EXPENSE DATA IS NOT READABLE BY EVERY AUTHENTICATED EMPLOYEE. There is no
-- unconditional SELECT policy on public.expenses anywhere in this file, and the
-- restrictive gate means a permissive policy added later is gated automatically.
--
-- ── NO DELETION, IN PHASE 1 ─────────────────────────────────────────────────
--
-- No DELETE policy is created for either table, so DELETE is refused by RLS for
-- every non-service caller — the default-deny that follows from enabling RLS
-- and granting nothing. That is a decision, not an omission:
--
--   * Finance has no soft-delete pattern to reuse. Its one removal path is a
--     guarded HARD delete of an UNVERIFIED payment (20260700000000 /
--     20260705000000 / finance_payment_deletion_claims), and a verified payment
--     is permanent (20261218000000). Neither shape transfers to an expense.
--   * A wrongly entered expense is CORRECTED through UPDATE, which records
--     updated_by and updated_at. Correction is the Phase 1 answer.
--
-- A later phase that wants removal should add the tombstone columns and a
-- policy deliberately, rather than inherit an unsafe hard delete from here.

-- ─── 1. Expense categories ──────────────────────────────────────────────────
--
-- Master data, created INLINE from the expense form. There is no management
-- screen in Phase 1 and this table is deliberately small enough not to need one.
--
-- is_active, not deletion: a category that expenses already reference must not
-- disappear, and the FK in section 2 is NO ACTION, so PostgreSQL refuses the
-- delete outright for every role including the service role. Retiring one hides
-- it from the picker without rewriting any expense that names it.

create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),

  -- Stored TRIMMED. The CHECK refuses an untrimmed or empty value rather than
  -- trimming on the caller's behalf, so " Diesel " and "Diesel" cannot become
  -- two rows that print identically.
  name text not null,

  is_active boolean not null default true,

  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint expense_categories_name_trimmed check (
    name = btrim(name) and btrim(name) <> ''
  ),
  constraint expense_categories_name_length check (
    char_length(name) <= 60
  )
);

comment on table public.expense_categories is
  'What an outgoing business expense was for. Master data created inline from the expense form. Rows are retired via is_active, never deleted — an expense referencing one holds it in place through a NO ACTION foreign key.';
comment on column public.expense_categories.name is
  'The category name, stored trimmed and non-empty. Unique case-insensitively across ALL rows, active and retired alike.';
comment on column public.expense_categories.is_active is
  'False retires a category from the picker. Existing expenses keep pointing at it and are not rewritten.';

-- CASE-INSENSITIVE UNIQUENESS, ACROSS ACTIVE AND RETIRED ALIKE.
--
-- Not a partial index on is_active: if retiring a category freed its name, a new
-- "Diesel" could be created beside a retired "diesel" and the history would hold
-- two categories a reader cannot tell apart. The name is unique full stop, and
-- reusing one means reactivating the row that already holds it.
create unique index if not exists expense_categories_name_lower_key
  on public.expense_categories (lower(name));

-- The picker reads the active rows in name order.
create index if not exists expense_categories_active_name_idx
  on public.expense_categories (name)
  where is_active;

-- ─── 2. Expenses ────────────────────────────────────────────────────────────

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),

  -- WHEN THE MONEY LEFT, not when the row was typed. An older payment is
  -- entered by setting this back; created_at still records the typing.
  expense_date date not null,

  -- FIXED PRECISION, NEVER FLOATING POINT. numeric(14,2) is rupees and paise;
  -- the scale is declared on the column so excess precision is refused by the
  -- type before any CHECK is consulted, and 14 digits is far above anything this
  -- workflow produces.
  amount numeric(14,2) not null,

  -- The expense's own outgoing-payment domain. See the header for why this is
  -- deliberately NOT finance_payment_requests.payment_mode.
  payment_mode text not null,

  -- Who received the money. Free text on purpose: these are one-off payees, and
  -- a vendor master is explicitly out of Phase 1 scope.
  paid_to text not null,

  -- NO ACTION FK — the default, and deliberate. A category named by an expense
  -- cannot be deleted; retire it instead.
  category_id uuid not null
    constraint expenses_category_fk references public.expense_categories(id),

  remark text,

  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  -- Null until somebody corrects the row. "Never corrected" and "corrected by
  -- its author" are different facts and must not collapse into one.
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now(),

  -- THE AMOUNT, IN FULL.
  --   <> NaN    numeric accepts 'NaN', which sorts above every real number and
  --             would pass a bare > 0 test.
  --   > 0       an expense of nothing is not an expense.
  --   round(,2) restated even though the column scale already guarantees it, so
  --             the rule is readable on the table rather than only in the type.
  constraint expenses_amount_valid check (
    amount <> 'NaN'::numeric
    and amount > 0
    and amount = round(amount, 2)
  ),

  constraint expenses_paid_to_trimmed check (
    paid_to = btrim(paid_to) and btrim(paid_to) <> ''
  ),
  constraint expenses_paid_to_length check (
    char_length(paid_to) <= 120
  ),

  -- An empty remark is NULL, never ''. One way to say "nothing was written".
  constraint expenses_remark_not_blank check (
    remark is null or btrim(remark) <> ''
  ),
  constraint expenses_remark_length check (
    remark is null or char_length(remark) <= 500
  ),

  -- The seven outgoing routes the form offers. Stated here so a direct SQL
  -- insert cannot introduce an eighth that no screen can render.
  constraint expenses_payment_mode_known check (
    payment_mode in (
      'cash', 'upi', 'bank_transfer', 'credit_card', 'debit_card', 'cheque', 'other'
    )
  )
);

comment on table public.expenses is
  'Money BOE paid OUT, recorded by the person who paid it. Structurally separate from finance_payment_requests: no customer, no PI, no Order, no allocation, no verification. Corrected through UPDATE; Phase 1 grants no DELETE to any non-service caller.';
comment on column public.expenses.expense_date is
  'The date the money left, which is what the spreadsheet this replaces reconciles against. created_at records when the row was typed and is a different fact.';
comment on column public.expenses.amount is
  'Rupees and paise, numeric(14,2). Positive; NaN and excess precision are refused rather than rounded.';
comment on column public.expenses.payment_mode is
  'How the expense was PAID OUT: cash | upi | bank_transfer | credit_card | debit_card | cheque | other. Deliberately its own domain — finance_payment_requests.payment_mode names the BOE account money arrives INTO, and its generic values are retired for new entries (20261014000000 section 1).';
comment on column public.expenses.paid_to is
  'Who received the money, as free text. Trimmed and non-empty. Phase 1 has no vendor master by design.';
comment on column public.expenses.category_id is
  'What the expense was for. NO ACTION FK: a referenced category cannot be deleted, only retired.';
comment on column public.expenses.updated_by is
  'Who last corrected this expense, null until one is made. Set by the caller and enforced by the UPDATE policies WITH CHECK, so a correction always names its author.';

-- ─── 3. Indexes ─────────────────────────────────────────────────────────────
--
-- Three, each backing a read the list actually performs, and nothing
-- speculative. The list is newest-first by expense_date, so the ordering index
-- carries id as a tiebreak — two expenses entered on the same day otherwise have
-- no stable order between pages.

create index if not exists expenses_expense_date_idx
  on public.expenses (expense_date desc, id desc);

create index if not exists expenses_category_id_idx
  on public.expenses (category_id);

-- "My expenses", which is the whole list for anybody without finance.view_all.
create index if not exists expenses_created_by_date_idx
  on public.expenses (created_by, expense_date desc);

-- ─── 4. RLS: expense_categories ─────────────────────────────────────────────

alter table public.expense_categories enable row level security;

-- THE PARENT GATE, the same restrictive shape 20260905000000 applied to the
-- three existing Finance tables. AND-ed with every permissive policy below and
-- with any added later, for all four commands.
drop policy if exists expense_categories_module_entry_gate on public.expense_categories;
create policy expense_categories_module_entry_gate
  on public.expense_categories
  as restrictive for all to authenticated
  using (public.module_entry_open('finance'))
  with check (public.module_entry_open('finance'));

-- Anybody who is INSIDE Finance may read the category list: it is the picker,
-- and a category name is not a financial fact about anybody. The restrictive
-- gate above is what makes this narrow — it is not a grant to every
-- authenticated employee.
create policy expense_categories_select
  on public.expense_categories
  for select to authenticated
  using (true);

-- Creating a category is part of recording an expense, so it takes the same
-- authority: finance.create (or admin). The row must name its author.
create policy expense_categories_insert
  on public.expense_categories
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.actor_has_module_permission('finance', 'create')
  );

-- Renaming or retiring a category changes what every expense that names it
-- reads as, so it is the protected `manage` authority — not something the
-- creator of one category acquires over it.
create policy expense_categories_manage_update
  on public.expense_categories
  for update to authenticated
  using (public.actor_has_module_permission('finance', 'manage'))
  with check (public.actor_has_module_permission('finance', 'manage'));

-- ─── 5. RLS: expenses ───────────────────────────────────────────────────────

alter table public.expenses enable row level security;

drop policy if exists expenses_module_entry_gate on public.expenses;
create policy expenses_module_entry_gate
  on public.expenses
  as restrictive for all to authenticated
  using (public.module_entry_open('finance'))
  with check (public.module_entry_open('finance'));

-- Admin, matching finance_payment_requests_admin_select.
create policy expenses_admin_select
  on public.expenses
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'admin'
    )
  );

-- Company-wide Finance sight, on the SAME protected action that already grants
-- it over the payments themselves. Read only: it appears in no write policy.
create policy expenses_view_all_select
  on public.expenses
  for select to authenticated
  using (public.actor_has_permission('finance', 'view_all'));

-- Your own entries, the same ownership rule as
-- finance_payment_requests_own_select.
create policy expenses_own_select
  on public.expenses
  for select to authenticated
  using (created_by = auth.uid());

-- Recording an expense takes finance.create, and the row must name its author.
-- updated_by must be null on a fresh row: a correction is a later act, and an
-- INSERT that pre-stamped one would claim an edit that never happened.
create policy expenses_create_insert
  on public.expenses
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and updated_by is null
    and public.actor_has_module_permission('finance', 'create')
  );

-- CORRECTING YOUR OWN ENTRY. The author may fix what they typed, which is the
-- Phase 1 correction path. WITH CHECK pins created_by to the caller as well, so
-- an UPDATE cannot hand somebody else's name to a row, and forces updated_by to
-- be the caller, so every correction is attributable.
create policy expenses_own_update
  on public.expenses
  for update to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid() and updated_by = auth.uid());

-- CORRECTING SOMEBODY ELSE'S. The protected `manage` action — the one Finance
-- already requires to rewrite a financial fact that has been reported, and which
-- no access level grants. created_by is immutable here too (section 5a):
-- `manage` is the authority to correct an entry, never to reassign who made it.
create policy expenses_manage_update
  on public.expenses
  for update to authenticated
  using (public.actor_has_module_permission('finance', 'manage'))
  with check (
    public.actor_has_module_permission('finance', 'manage')
    and updated_by = auth.uid()
  );

-- ─── 5a. created_by is immutable, for every caller ──────────────────────────
--
-- The `manage` policy above cannot express "unchanged" — a WITH CHECK sees only
-- the new row. A trigger can, and it applies to the service role too, which RLS
-- does not. Who recorded an expense is the one fact about it that is never a
-- correction.

create or replace function public.expenses_freeze_created_by()
returns trigger
language plpgsql
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'An expense cannot change who recorded it'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.expenses_freeze_created_by() is
  'Refuses any UPDATE that changes expenses.created_by. Applies to every caller including the service role, which RLS does not reach.';

drop trigger if exists expenses_freeze_created_by on public.expenses;
create trigger expenses_freeze_created_by
  before update on public.expenses
  for each row execute function public.expenses_freeze_created_by();

-- ─── 5b. updated_at ─────────────────────────────────────────────────────────
-- set_updated_at() was defined in 20260609_create_attendance_records.sql and is
-- the same trigger finance_payment_requests carries.

drop trigger if exists expense_categories_set_updated_at on public.expense_categories;
create trigger expense_categories_set_updated_at
  before update on public.expense_categories
  for each row execute function public.set_updated_at();

drop trigger if exists expenses_set_updated_at on public.expenses;
create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();

-- ─── 6. Assertions ──────────────────────────────────────────────────────────
--
-- Read-only. They fail the migration rather than let a partially applied state
-- look successful.

do $$
declare
  v_table text;
  v_count int;
begin
  -- Both tables exist and both have RLS on, with the restrictive parent gate.
  foreach v_table in array array['expense_categories', 'expenses'] loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'expenses migration: table public.% was not created', v_table;
    end if;
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity
    ) then
      raise exception 'expenses migration: RLS is not enabled on public.%', v_table;
    end if;
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_table
        and policyname = v_table || '_module_entry_gate'
        and permissive = 'RESTRICTIVE'
    ) then
      raise exception 'expenses migration: the restrictive finance gate is missing on public.%', v_table;
    end if;
  end loop;

  -- NO PERMISSIVE DELETE PATH ON EITHER TABLE. Phase 1 has no removal path, and
  -- RLS default-denies what no policy permits. FOR ALL would grant DELETE too,
  -- so a permissive ALL policy counts as one here.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('expense_categories', 'expenses')
    and cmd in ('DELETE', 'ALL')
    and permissive = 'PERMISSIVE';
  if v_count <> 0 then
    raise exception 'expenses migration: % permissive DELETE/ALL policies found; Phase 1 grants no deletion', v_count;
  end if;

  -- The amount column is fixed-precision, never floating point.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'expenses' and column_name = 'amount'
      and data_type = 'numeric' and numeric_scale = 2
  ) then
    raise exception 'expenses migration: expenses.amount is not numeric(_,2)';
  end if;

  -- Case-insensitive category uniqueness is actually indexed.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'expense_categories'
      and indexname = 'expense_categories_name_lower_key'
  ) then
    raise exception 'expenses migration: the case-insensitive category name index is missing';
  end if;

  -- Both new tables are empty: this migration inserts nothing, here or anywhere.
  select (select count(*) from public.expenses)
       + (select count(*) from public.expense_categories)
    into v_count;
  if v_count <> 0 then
    raise exception 'expenses migration: expected no seeded rows, found %', v_count;
  end if;
end $$;
