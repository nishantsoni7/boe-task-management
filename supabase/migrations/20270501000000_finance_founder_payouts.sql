-- Finance: Founders' payouts.
--
-- WHAT THIS IS (owner request 2026-10-29)
--   BOE pays money out, at irregular times, into the partners' and their
--   families' bank accounts: "Nitish needed 1.5 lakh; put 75,000 each into
--   Namrata's and Jaishree's accounts", sometimes split three ways. One payout
--   is one occasion; each of its lines says which account received how much and
--   WHAT KIND of money it was (partner remuneration, the incentive for orders
--   converted, interest on capital, salary, or a plain drawing). The owner reads
--   the totals per account per financial year for income tax, and the app works
--   out (in TypeScript, never stored) how much more each person can take while
--   staying under the zero-tax line.
--
-- WHO
--   finance.founder_payouts, protected, and EXPLICIT GRANT ONLY: the door asks
--   actor_has_permission, which has no admin branch, so an administrator who was
--   not granted it sees nothing. Owner decision 2026-10-29: only the owner. It is
--   seeded for the owner account (employee_code TEST-001, the convention of
--   20261224000000) because both Control Centre screens render an
--   administrator's row read-only, so the owner could not grant it to himself.
--   Nobody else is granted anything.
--
-- SHAPE
--   founder_payout_accounts       the people paid: name, whose side, role in BOE,
--                                 bank + last digits (never a full account number)
--   founder_payouts               one payout: date, company account it left from,
--                                 note, bank reference; soft-deleted
--   founder_payout_lines          account + kind + amount, one row each
--   founder_payout_account_years  a person's other income in a tax year (planner)
--   founder_payout_firm_years     BOE's expected book profit in a tax year
--                                 (the partner-remuneration ceiling)
--   RLS on, NO policies, no table privileges for anon or authenticated: every
--   read and write goes through the SECURITY DEFINER functions below, each of
--   which asks the door first.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does not touch payments, allocations, custody, bank statements,
--     expenses, payroll or Orders. A payout here is a record for the owner, not
--     a Finance transaction.
--   * It stores no tax figures. Slabs, rebate, ceiling and TDS rules live in
--     src/lib/finance/founderPayoutTax.ts, one entry per tax year.
--   * It holds no account numbers: bank_label refuses five or more digits in a
--     row (the repository is public, and the last four digits are enough to
--     tell two accounts apart).
--
-- ROLLBACK
--   drop function public.founder_payout_firm_year_save(integer, numeric),
--     public.founder_payout_account_year_save(integer, uuid, numeric),
--     public.founder_payout_account_save(uuid, text, text, text, text, boolean),
--     public.founder_payout_delete(uuid, text),
--     public.founder_payout_save(uuid, date, text, text, text, jsonb, uuid),
--     public.founder_payouts_read(), public.assert_founder_payouts_door();
--   drop table public.founder_payout_firm_years, public.founder_payout_account_years,
--     public.founder_payout_lines, public.founder_payouts, public.founder_payout_accounts;
--   then DELETE (never allowed = false) the employee_permission_overrides,
--   module_permission_actions and permission_actions rows for founder_payouts.

do $dep$
begin
  if to_regprocedure('public.actor_has_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: public.actor_has_permission(text, text)';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: public.module_entry_open(text)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'users' and column_name = 'employee_code') then
    raise exception 'DEPENDENCY MISSING: public.users.employee_code';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'employee_permission_overrides' and column_name = 'revoked_at') then
    raise exception 'DEPENDENCY MISSING: public.employee_permission_overrides.revoked_at';
  end if;
end $dep$;


-- ═══ §1. finance.founder_payouts ════════════════════════════════════════════

insert into public.permission_actions (action_key, display_name, is_system)
values ('founder_payouts', 'Founders'' Payouts', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'founder_payouts'
where pm.module_key = 'finance'
on conflict (module_id, action_id) do nothing;

-- The owner's grant, shaped exactly like 20261224000000 §2. DO UPDATE, not DO
-- NOTHING, so a row left behind as a deny or a soft revocation is corrected.
insert into public.employee_permission_overrides
  (user_id, module_id, action_id, allowed, granted_by, granted_at)
select u.id, pm.id, pa.id, true, u.id, now()
from public.users u
cross join (select id from public.permission_modules where module_key = 'finance') pm
cross join (select id from public.permission_actions where action_key = 'founder_payouts') pa
where u.employee_code = 'TEST-001'
on conflict (user_id, module_id, action_id) do update
  set allowed    = true,
      revoked_by = null,
      revoked_at = null;


-- ═══ §2. Tables ═════════════════════════════════════════════════════════════

create table if not exists public.founder_payout_accounts (
  id            uuid        primary key default gen_random_uuid(),
  display_name  text        not null check (length(btrim(display_name)) between 1 and 80),
  -- Whose share money into this account is (a partner's name, e.g. the owner's
  -- or Nitish's). A label, not a user: family accounts belong to a side too.
  side          text        not null check (length(btrim(side)) between 1 and 40),
  -- What the money is to the person, for tax. 'family' = does not work in BOE,
  -- so a payment is not their income (owner decision for Jaishree, 2026-10-29).
  tax_role      text        not null default 'unset'
                  check (tax_role in ('working_partner', 'employee', 'family', 'unset')),
  bank_label    text        null
                  check (bank_label is null or (length(bank_label) <= 40 and bank_label !~ '[0-9]{5}')),
  is_active     boolean     not null default true,
  created_by    uuid        not null references public.users(id),
  created_at    timestamptz not null default now(),
  updated_by    uuid        null references public.users(id),
  updated_at    timestamptz not null default now()
);

create unique index if not exists founder_payout_accounts_name_unique
  on public.founder_payout_accounts (lower(btrim(display_name)));

create table if not exists public.founder_payouts (
  id               uuid        primary key default gen_random_uuid(),
  paid_on          date        not null check (paid_on >= date '2020-04-01'),
  -- The company account the money left from: the five BOE accounts of
  -- PAYMENT_MODES (src/lib/finance/paymentEntry.ts), plus cash and other.
  paid_from        text        not null
                     check (paid_from in ('hdfc', 'hdfc_sec', 'pnb', 'paytm', 'canara', 'cash', 'other')),
  note             text        null check (note is null or length(note) <= 300),
  bank_reference   text        null check (bank_reference is null or length(bank_reference) <= 80),
  idempotency_key  uuid        null,
  created_by       uuid        not null references public.users(id),
  created_at       timestamptz not null default now(),
  updated_by       uuid        null references public.users(id),
  updated_at       timestamptz not null default now(),
  deleted_by       uuid        null references public.users(id),
  deleted_at       timestamptz null,
  delete_reason    text        null check (delete_reason is null or length(delete_reason) <= 300),
  constraint founder_payouts_delete_pair check ((deleted_at is null) = (deleted_by is null)),
  constraint founder_payouts_reason_only_when_deleted check (deleted_at is not null or delete_reason is null)
);

create unique index if not exists founder_payouts_idempotency_unique
  on public.founder_payouts (created_by, idempotency_key) where idempotency_key is not null;
create index if not exists founder_payouts_paid_on_idx
  on public.founder_payouts (paid_on desc) where deleted_at is null;

create table if not exists public.founder_payout_lines (
  id          uuid          primary key default gen_random_uuid(),
  payout_id   uuid          not null references public.founder_payouts(id) on delete cascade,
  account_id  uuid          not null references public.founder_payout_accounts(id),
  kind        text          not null
                check (kind in ('partner_remuneration', 'incentive', 'interest_on_capital', 'salary', 'drawings')),
  -- Rupees with paise, the unit of bank_statement_lines, so a later link to a
  -- bank debit compares exactly.
  amount      numeric(14,2) not null check (amount > 0 and amount <= 100000000),
  position    smallint      not null check (position between 0 and 49),
  constraint founder_payout_lines_one_kind_per_account unique (payout_id, account_id, kind)
);

create index if not exists founder_payout_lines_account_idx
  on public.founder_payout_lines (account_id);

-- tax_year is the year the financial year STARTS: 2026 = 2026-27 (1 April 2026
-- to 31 March 2027).
create table if not exists public.founder_payout_account_years (
  tax_year      smallint      not null check (tax_year between 2020 and 2100),
  account_id    uuid          not null references public.founder_payout_accounts(id),
  other_income  numeric(14,2) not null default 0 check (other_income >= 0),
  updated_by    uuid          not null references public.users(id),
  updated_at    timestamptz   not null default now(),
  primary key (tax_year, account_id)
);

create table if not exists public.founder_payout_firm_years (
  tax_year              smallint      primary key check (tax_year between 2020 and 2100),
  -- May be negative: a loss year still allows remuneration (the ₹3 lakh floor).
  expected_book_profit  numeric(16,2) null,
  updated_by            uuid          not null references public.users(id),
  updated_at            timestamptz   not null default now()
);


-- ═══ §3. Row level security: on, with no policies — RPC only ═══════════════

do $rls$
declare
  t text;
begin
  foreach t in array array['founder_payout_accounts', 'founder_payouts', 'founder_payout_lines',
                           'founder_payout_account_years', 'founder_payout_firm_years']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $rls$;


-- ═══ §4. The door ═══════════════════════════════════════════════════════════

create or replace function public.assert_founder_payouts_door()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'FOUNDERS_UNAUTHENTICATED: sign in first' using errcode = '42501';
  end if;
  -- EXPLICIT GRANT ONLY. actor_has_permission has no admin branch, on purpose:
  -- these are the founders' own finances, not the company's, and being an
  -- administrator of BOE One is not a reason to read them.
  if not public.module_entry_open('finance')
     or not public.actor_has_permission('finance', 'founder_payouts') then
    raise exception 'FOUNDERS_FORBIDDEN: finance.founder_payouts is required' using errcode = '42501';
  end if;
  return v_actor;
end;
$fn$;


-- ═══ §5. Read everything (the data is small: a few hundred lines a year) ════

create or replace function public.founder_payouts_read()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.assert_founder_payouts_door();
  return jsonb_build_object(
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'display_name', a.display_name, 'side', a.side, 'tax_role', a.tax_role,
               'bank_label', a.bank_label, 'is_active', a.is_active, 'created_at', a.created_at)
             order by lower(a.side), lower(a.display_name))
        from public.founder_payout_accounts a), '[]'::jsonb),
    'payouts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'paid_on', p.paid_on, 'paid_from', p.paid_from, 'note', p.note,
               'bank_reference', p.bank_reference, 'created_at', p.created_at, 'updated_at', p.updated_at,
               'lines', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', l.id, 'account_id', l.account_id, 'kind', l.kind, 'amount', l.amount)
                        order by l.position)
                   from public.founder_payout_lines l
                  where l.payout_id = p.id), '[]'::jsonb))
             order by p.paid_on desc, p.created_at desc)
        from public.founder_payouts p
       where p.deleted_at is null), '[]'::jsonb),
    'account_years', coalesce((
      select jsonb_agg(jsonb_build_object('tax_year', y.tax_year, 'account_id', y.account_id, 'other_income', y.other_income))
        from public.founder_payout_account_years y), '[]'::jsonb),
    'firm_years', coalesce((
      select jsonb_agg(jsonb_build_object('tax_year', f.tax_year, 'expected_book_profit', f.expected_book_profit))
        from public.founder_payout_firm_years f), '[]'::jsonb)
  );
end;
$fn$;


-- ═══ §6. Record or change a payout, all its lines in one step ═══════════════
--
-- p_payout_id null = a new payout; otherwise the payout's header is updated and
-- its lines REPLACED by p_lines. p_lines is an array of
-- {"account_id": uuid, "kind": text, "amount": number}. A new payout carrying an
-- idempotency key already used by the same person returns that payout instead
-- of making a second one (a double tap, a retried request).

create or replace function public.founder_payout_save(
  p_payout_id        uuid,
  p_paid_on          date,
  p_paid_from        text,
  p_note             text,
  p_bank_reference   text,
  p_lines            jsonb,
  p_idempotency_key  uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid;
  v_id      uuid;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_line    jsonb;
  v_pos     integer := 0;
  v_account uuid;
  v_kind    text;
  v_amount  numeric;
begin
  v_actor := public.assert_founder_payouts_door();

  if p_paid_on is null or p_paid_on > v_today then
    raise exception 'FOUNDERS_INVALID: the date must be today or earlier' using errcode = '22023';
  end if;
  if p_paid_on < date '2020-04-01' then
    raise exception 'FOUNDERS_INVALID: the date is too far in the past' using errcode = '22023';
  end if;
  if p_paid_from is null or p_paid_from not in ('hdfc', 'hdfc_sec', 'pnb', 'paytm', 'canara', 'cash', 'other') then
    raise exception 'FOUNDERS_INVALID: choose the company account the money left from' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'FOUNDERS_INVALID: add at least one account' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 50 then
    raise exception 'FOUNDERS_INVALID: at most 50 lines in one payout' using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 300 or length(coalesce(p_bank_reference, '')) > 80 then
    raise exception 'FOUNDERS_INVALID: the note or the reference is too long' using errcode = '22023';
  end if;

  if p_payout_id is null then
    if p_idempotency_key is not null then
      perform pg_advisory_xact_lock(hashtextextended('founder_payout:' || v_actor::text || ':' || p_idempotency_key::text, 0));
      select id into v_id from public.founder_payouts
       where created_by = v_actor and idempotency_key = p_idempotency_key;
      if found then
        return v_id;
      end if;
    end if;
    insert into public.founder_payouts (paid_on, paid_from, note, bank_reference, idempotency_key, created_by)
    values (p_paid_on, p_paid_from, nullif(btrim(p_note), ''), nullif(btrim(p_bank_reference), ''),
            p_idempotency_key, v_actor)
    returning id into v_id;
  else
    update public.founder_payouts
       set paid_on = p_paid_on,
           paid_from = p_paid_from,
           note = nullif(btrim(p_note), ''),
           bank_reference = nullif(btrim(p_bank_reference), ''),
           updated_by = v_actor,
           updated_at = now()
     where id = p_payout_id and deleted_at is null
    returning id into v_id;
    if v_id is null then
      raise exception 'FOUNDERS_NOT_FOUND: this payout does not exist or was deleted' using errcode = 'P0002';
    end if;
    delete from public.founder_payout_lines where payout_id = v_id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'FOUNDERS_INVALID: a line is not readable' using errcode = '22023';
    end if;
    begin
      v_account := nullif(v_line->>'account_id', '')::uuid;
      v_amount  := (v_line->>'amount')::numeric;
    exception when others then
      raise exception 'FOUNDERS_INVALID: a line is not readable' using errcode = '22023';
    end;
    v_kind := v_line->>'kind';
    if v_account is null or not exists (select 1 from public.founder_payout_accounts where id = v_account) then
      raise exception 'FOUNDERS_INVALID: a line names an account that does not exist' using errcode = '22023';
    end if;
    if v_kind is null or v_kind not in ('partner_remuneration', 'incentive', 'interest_on_capital', 'salary', 'drawings') then
      raise exception 'FOUNDERS_INVALID: choose what kind of payment each line is' using errcode = '22023';
    end if;
    if v_amount is null or v_amount <= 0 or v_amount > 100000000 or v_amount <> round(v_amount, 2) then
      raise exception 'FOUNDERS_INVALID: each amount must be more than zero, in rupees and paise' using errcode = '22023';
    end if;
    if exists (select 1 from public.founder_payout_lines
                where payout_id = v_id and account_id = v_account and kind = v_kind) then
      raise exception 'FOUNDERS_INVALID: the same account appears twice with the same kind; add the amounts together' using errcode = '22023';
    end if;
    insert into public.founder_payout_lines (payout_id, account_id, kind, amount, position)
    values (v_id, v_account, v_kind, v_amount, v_pos);
    v_pos := v_pos + 1;
  end loop;

  return v_id;
end;
$fn$;


-- ═══ §7. Delete a payout (soft; it leaves every total) ══════════════════════

create or replace function public.founder_payout_delete(p_payout_id uuid, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid;
begin
  v_actor := public.assert_founder_payouts_door();
  if length(coalesce(p_reason, '')) > 300 then
    raise exception 'FOUNDERS_INVALID: the reason is too long' using errcode = '22023';
  end if;
  update public.founder_payouts
     set deleted_at = now(), deleted_by = v_actor, delete_reason = nullif(btrim(p_reason), '')
   where id = p_payout_id and deleted_at is null;
  if not found then
    raise exception 'FOUNDERS_NOT_FOUND: this payout does not exist or was already deleted' using errcode = 'P0002';
  end if;
end;
$fn$;


-- ═══ §8. Add or change an account ═══════════════════════════════════════════

create or replace function public.founder_payout_account_save(
  p_account_id    uuid,
  p_display_name  text,
  p_side          text,
  p_tax_role      text,
  p_bank_label    text,
  p_is_active     boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid;
  v_id    uuid;
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_side  text := btrim(coalesce(p_side, ''));
  v_bank  text := nullif(btrim(coalesce(p_bank_label, '')), '');
begin
  v_actor := public.assert_founder_payouts_door();

  if length(v_name) not between 1 and 80 then
    raise exception 'FOUNDERS_INVALID: type a name (up to 80 characters)' using errcode = '22023';
  end if;
  if length(v_side) not between 1 and 40 then
    raise exception 'FOUNDERS_INVALID: say whose side this account is on' using errcode = '22023';
  end if;
  if p_tax_role is null or p_tax_role not in ('working_partner', 'employee', 'family', 'unset') then
    raise exception 'FOUNDERS_INVALID: choose the role in BOE' using errcode = '22023';
  end if;
  if v_bank is not null and (length(v_bank) > 40 or v_bank ~ '[0-9]{5}') then
    raise exception 'FOUNDERS_INVALID: type the bank and only the last 4 digits, never the full account number' using errcode = '22023';
  end if;
  if exists (select 1 from public.founder_payout_accounts
              where lower(btrim(display_name)) = lower(v_name)
                and (p_account_id is null or id <> p_account_id)) then
    raise exception 'FOUNDERS_INVALID: an account with this name already exists' using errcode = '22023';
  end if;

  if p_account_id is null then
    insert into public.founder_payout_accounts (display_name, side, tax_role, bank_label, is_active, created_by)
    values (v_name, v_side, p_tax_role, v_bank, coalesce(p_is_active, true), v_actor)
    returning id into v_id;
  else
    update public.founder_payout_accounts
       set display_name = v_name, side = v_side, tax_role = p_tax_role, bank_label = v_bank,
           is_active = coalesce(p_is_active, true), updated_by = v_actor, updated_at = now()
     where id = p_account_id
    returning id into v_id;
    if v_id is null then
      raise exception 'FOUNDERS_NOT_FOUND: this account does not exist' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$fn$;


-- ═══ §9. The planner's two inputs per tax year ══════════════════════════════

create or replace function public.founder_payout_account_year_save(
  p_tax_year      integer,
  p_account_id    uuid,
  p_other_income  numeric
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid;
begin
  v_actor := public.assert_founder_payouts_door();
  if p_tax_year is null or p_tax_year not between 2020 and 2100 then
    raise exception 'FOUNDERS_INVALID: unknown financial year' using errcode = '22023';
  end if;
  if not exists (select 1 from public.founder_payout_accounts where id = p_account_id) then
    raise exception 'FOUNDERS_NOT_FOUND: this account does not exist' using errcode = 'P0002';
  end if;
  if p_other_income is null or p_other_income < 0 or p_other_income > 100000000
     or p_other_income <> round(p_other_income, 2) then
    raise exception 'FOUNDERS_INVALID: other income must be zero or more' using errcode = '22023';
  end if;
  insert into public.founder_payout_account_years (tax_year, account_id, other_income, updated_by)
  values (p_tax_year, p_account_id, p_other_income, v_actor)
  on conflict (tax_year, account_id) do update
    set other_income = excluded.other_income, updated_by = excluded.updated_by, updated_at = now();
end;
$fn$;

create or replace function public.founder_payout_firm_year_save(
  p_tax_year              integer,
  p_expected_book_profit  numeric
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid;
begin
  v_actor := public.assert_founder_payouts_door();
  if p_tax_year is null or p_tax_year not between 2020 and 2100 then
    raise exception 'FOUNDERS_INVALID: unknown financial year' using errcode = '22023';
  end if;
  if p_expected_book_profit is not null
     and (abs(p_expected_book_profit) > 1e10 or p_expected_book_profit <> round(p_expected_book_profit, 2)) then
    raise exception 'FOUNDERS_INVALID: the book profit is not a usable amount' using errcode = '22023';
  end if;
  insert into public.founder_payout_firm_years (tax_year, expected_book_profit, updated_by)
  values (p_tax_year, p_expected_book_profit, v_actor)
  on conflict (tax_year) do update
    set expected_book_profit = excluded.expected_book_profit, updated_by = excluded.updated_by, updated_at = now();
end;
$fn$;


-- ═══ §10. Who may call what ═════════════════════════════════════════════════

revoke all on function public.assert_founder_payouts_door() from public, anon;
revoke all on function public.founder_payouts_read() from public, anon;
revoke all on function public.founder_payout_save(uuid, date, text, text, text, jsonb, uuid) from public, anon;
revoke all on function public.founder_payout_delete(uuid, text) from public, anon;
revoke all on function public.founder_payout_account_save(uuid, text, text, text, text, boolean) from public, anon;
revoke all on function public.founder_payout_account_year_save(integer, uuid, numeric) from public, anon;
revoke all on function public.founder_payout_firm_year_save(integer, numeric) from public, anon;

grant execute on function public.assert_founder_payouts_door() to authenticated;
grant execute on function public.founder_payouts_read() to authenticated;
grant execute on function public.founder_payout_save(uuid, date, text, text, text, jsonb, uuid) to authenticated;
grant execute on function public.founder_payout_delete(uuid, text) to authenticated;
grant execute on function public.founder_payout_account_save(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function public.founder_payout_account_year_save(integer, uuid, numeric) to authenticated;
grant execute on function public.founder_payout_firm_year_save(integer, numeric) to authenticated;

comment on function public.assert_founder_payouts_door() is
  'Founders'' payouts door: signed in, Finance entry, and an EXPLICIT finance.founder_payouts grant (actor_has_permission, no admin branch). 20270501000000.';


-- ═══ §11. Self-assertion (runs on apply) ════════════════════════════════════

do $assert$
declare
  t      text;
  v_fn   text;
  v_body text := pg_get_functiondef('public.assert_founder_payouts_door()'::regprocedure);
begin
  foreach t in array array['founder_payout_accounts', 'founder_payouts', 'founder_payout_lines',
                           'founder_payout_account_years', 'founder_payout_firm_years']
  loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'ASSERT: RLS must be on for %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'ASSERT: % must have no policies (RPC only)', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete')
       or has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'ASSERT: % must not be reachable directly by anon or authenticated', t;
    end if;
  end loop;

  if v_body not like '%actor_has_permission(''finance'', ''founder_payouts'')%' then
    raise exception 'ASSERT: the door must ask actor_has_permission for finance.founder_payouts';
  end if;
  if v_body like '%actor_has_module_permission%' or v_body like '%''admin''%' then
    raise exception 'ASSERT: the door must have no admin branch';
  end if;

  foreach v_fn in array array[
    'public.assert_founder_payouts_door()',
    'public.founder_payouts_read()',
    'public.founder_payout_save(uuid, date, text, text, text, jsonb, uuid)',
    'public.founder_payout_delete(uuid, text)',
    'public.founder_payout_account_save(uuid, text, text, text, text, boolean)',
    'public.founder_payout_account_year_save(integer, uuid, numeric)',
    'public.founder_payout_firm_year_save(integer, numeric)'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'ASSERT: anon must not execute %', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'ASSERT: authenticated must execute %', v_fn;
    end if;
    if not (select prosecdef from pg_proc where oid = v_fn::regprocedure) then
      raise exception 'ASSERT: % must be SECURITY DEFINER', v_fn;
    end if;
  end loop;

  if not exists (
    select 1
      from public.module_permission_actions mpa
      join public.permission_actions pa on pa.id = mpa.action_id
      join public.permission_modules pm on pm.id = mpa.module_id
     where pm.module_key = 'finance' and pa.action_key = 'founder_payouts' and mpa.default_allowed = false
  ) then
    raise exception 'ASSERT: finance.founder_payouts must be registered and deny-by-default';
  end if;

  if exists (select 1 from public.users where employee_code = 'TEST-001')
     and not exists (
       select 1
         from public.employee_permission_overrides o
         join public.users u on u.id = o.user_id and u.employee_code = 'TEST-001'
         join public.permission_actions pa on pa.id = o.action_id and pa.action_key = 'founder_payouts'
         join public.permission_modules pm on pm.id = o.module_id and pm.module_key = 'finance'
        where o.allowed and o.revoked_at is null) then
    raise exception 'ASSERT: the owner account must hold finance.founder_payouts';
  end if;
end $assert$;
