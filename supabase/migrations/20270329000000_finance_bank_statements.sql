-- Finance: bank statements and payment reconciliation.
--
-- WHAT THIS IS
--   The owner downloads the HDFC statements (the primary current account and
--   the secondary one) and uploads them. Every line is stored once; every credit
--   is then either LINKED to a payment somebody recorded, marked as an OLD ORDER
--   (a customer of an order that was never put into the app), marked as NOT
--   CUSTOMER MONEY (own transfer, FD redemption, refund ...), or left UNLINKED
--   for the owner to look at. Suggestions are computed by the app; this
--   migration never links, verifies or approves anything on its own.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does not touch finance_payment_requests, allocations, proofs or any
--     verification state. A link is a note beside a payment, not a decision on it.
--   * It holds no account numbers: the first import for an account records the
--     number the owner confirmed, in a private table, never in this file.
--
-- PERMISSION
--   finance.reconcile, protected (never granted by a preset), depends on
--   finance.view_all in the app (a reconciler must be able to read the
--   payments they match against). Admins hold it through the admin branch.
--
-- SHAPE
--   bank_statement_accounts      one row per account: which account number it is
--   bank_statement_imports       one row per uploaded file (audit)
--   bank_statement_lines         one row per bank line, de-duplicated by fingerprint
--   bank_line_payment_links      line <-> payment, amount-bearing, soft-unlinked
--   RPCs: preview_bank_statement, import_bank_statement, link_bank_line_to_payment,
--         unlink_bank_line_payment, classify_bank_line, clear_bank_line_classification
--   Tables are readable by reconcilers only and writable by nobody directly.

do $dep$
begin
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: public.actor_has_module_permission(text, text)';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: public.module_entry_open(text)';
  end if;
end $dep$;


-- ═══ §1. finance.reconcile ══════════════════════════════════════════════════

insert into public.permission_actions (action_key, display_name, is_system)
values ('reconcile', 'Reconcile Bank Statements', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'reconcile'
where pm.module_key = 'finance'
on conflict (module_id, action_id) do nothing;


-- ═══ §2. Tables ═════════════════════════════════════════════════════════════

create table if not exists public.bank_statement_accounts (
  account         text        primary key check (account in ('hdfc', 'hdfc_sec')),
  account_number  text        not null check (length(btrim(account_number)) between 4 and 40),
  set_by          uuid        not null references public.users(id),
  set_at          timestamptz not null default now(),
  constraint bank_statement_accounts_number_unique unique (account_number)
);

create table if not exists public.bank_statement_imports (
  id               uuid        primary key default gen_random_uuid(),
  account          text        not null references public.bank_statement_accounts(account),
  period_from      date        not null,
  period_to        date        not null,
  opening_balance  numeric(16,2) not null,
  closing_balance  numeric(16,2) not null,
  line_count       integer     not null check (line_count > 0),
  new_line_count   integer     not null check (new_line_count >= 0),
  file_name        text        null check (file_name is null or length(file_name) <= 200),
  imported_by      uuid        not null references public.users(id),
  imported_at      timestamptz not null default now(),
  constraint bank_statement_imports_period_ordered check (period_from <= period_to)
);

create table if not exists public.bank_statement_lines (
  id                   uuid        primary key default gen_random_uuid(),
  import_id            uuid        not null references public.bank_statement_imports(id),
  account              text        not null references public.bank_statement_accounts(account),
  seq                  integer     not null,
  line_date            date        not null,
  value_date           date        null,
  narration            text        not null check (length(narration) <= 600),
  bank_ref             text        null check (bank_ref is null or length(bank_ref) <= 80),
  withdrawal           numeric(14,2) not null default 0 check (withdrawal >= 0),
  deposit              numeric(14,2) not null default 0 check (deposit >= 0),
  balance              numeric(16,2) not null,
  fingerprint          text        not null,
  classification       text        null
                         check (classification in ('old_order', 'not_customer_money')),
  non_customer_kind    text        null
                         check (non_customer_kind in
                           ('own_transfer', 'fd_redemption', 'refund', 'interest', 'bank_test', 'other')),
  old_order_customer   text        null check (old_order_customer is null or length(old_order_customer) <= 120),
  old_order_ref        text        null check (old_order_ref is null or length(old_order_ref) <= 60),
  note                 text        null check (note is null or length(note) <= 300),
  classified_by        uuid        null references public.users(id),
  classified_at        timestamptz null,
  created_at           timestamptz not null default now(),
  constraint bank_statement_lines_one_direction
    check ((withdrawal = 0) <> (deposit = 0)),
  constraint bank_statement_lines_fingerprint_unique unique (account, fingerprint),
  -- Only credits are classified, and a classification carries its own detail.
  constraint bank_statement_lines_classification_shape check (
    (classification is null
       and non_customer_kind is null and old_order_customer is null
       and old_order_ref is null and classified_by is null and classified_at is null)
    or (classification = 'old_order'
       and deposit > 0 and non_customer_kind is null
       and old_order_customer is not null and length(btrim(old_order_customer)) > 0
       and classified_by is not null and classified_at is not null)
    or (classification = 'not_customer_money'
       and deposit > 0 and non_customer_kind is not null
       and old_order_customer is null and old_order_ref is null
       and classified_by is not null and classified_at is not null)
  )
);

create index if not exists bank_statement_lines_account_date_idx
  on public.bank_statement_lines (account, line_date desc, seq desc);
create index if not exists bank_statement_lines_credit_idx
  on public.bank_statement_lines (account, line_date desc) where deposit > 0;

create table if not exists public.bank_line_payment_links (
  id            uuid        primary key default gen_random_uuid(),
  line_id       uuid        not null references public.bank_statement_lines(id),
  payment_id    uuid        not null references public.finance_payment_requests(id),
  amount        numeric(14,2) not null check (amount > 0),
  linked_by     uuid        not null references public.users(id),
  linked_at     timestamptz not null default now(),
  unlinked_by   uuid        null references public.users(id),
  unlinked_at   timestamptz null,
  constraint bank_line_payment_links_unlink_pair
    check ((unlinked_by is null) = (unlinked_at is null))
);

create unique index if not exists bank_line_payment_links_active_unique
  on public.bank_line_payment_links (line_id, payment_id) where unlinked_at is null;
create index if not exists bank_line_payment_links_payment_idx
  on public.bank_line_payment_links (payment_id) where unlinked_at is null;


-- ═══ §3. Row level security: readable by reconcilers, writable by RPC only ══

do $rls$
declare
  t text;
begin
  foreach t in array array['bank_statement_accounts', 'bank_statement_imports',
                           'bank_statement_lines', 'bank_line_payment_links']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_module_entry_gate', t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      'using (public.module_entry_open(''finance'')) with check (public.module_entry_open(''finance''))',
      t || '_module_entry_gate', t);
    execute format('drop policy if exists %I on public.%I', t || '_reconcile_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using (public.actor_has_module_permission(''finance'', ''reconcile''))',
      t || '_reconcile_select', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $rls$;


-- ═══ §4. Helpers ════════════════════════════════════════════════════════════

create or replace function public.bank_line_fingerprint(
  p_line_date date, p_bank_ref text, p_withdrawal numeric, p_deposit numeric,
  p_balance numeric, p_narration text
) returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select md5(concat_ws('|',
    p_line_date::text,
    coalesce(p_bank_ref, ''),
    round(coalesce(p_withdrawal, 0), 2)::text,
    round(coalesce(p_deposit, 0), 2)::text,
    round(p_balance, 2)::text,
    p_narration));
$fn$;

create or replace function public.assert_bank_reconcile_door()
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
    raise exception 'BANK_UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not public.module_entry_open('finance')
     or not public.actor_has_module_permission('finance', 'reconcile') then
    raise exception 'BANK_FORBIDDEN: finance.reconcile is required' using errcode = '42501';
  end if;
  return v_actor;
end;
$fn$;

revoke all on function public.assert_bank_reconcile_door() from public, anon;
grant execute on function public.assert_bank_reconcile_door() to authenticated;
revoke all on function public.bank_line_fingerprint(date, text, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.bank_line_fingerprint(date, text, numeric, numeric, numeric, text) to authenticated;


-- ═══ §5. Preview: what would an import do? Writes nothing. ═════════════════

create or replace function public.preview_bank_statement(
  p_account_number text,
  p_account        text,
  p_lines          jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_known_account  text;
  v_account        text;
  v_existing       integer := 0;
  v_total          integer;
  v_last_balance   numeric;
  v_last_date      date;
  v_first_date     date;
begin
  perform public.assert_bank_reconcile_door();

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'BANK_LINES_INVALID' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_lines);

  select a.account into v_known_account
    from public.bank_statement_accounts a
   where a.account_number = btrim(p_account_number);
  v_account := coalesce(v_known_account, p_account);

  if v_account is not null then
    select count(*) into v_existing
      from jsonb_to_recordset(p_lines) as l(
             line_date date, bank_ref text, withdrawal numeric, deposit numeric,
             balance numeric, narration text)
      join public.bank_statement_lines b
        on b.account = v_account
       and b.fingerprint = public.bank_line_fingerprint(
             l.line_date, l.bank_ref, l.withdrawal, l.deposit, l.balance, l.narration);

    select min((x->>'line_date')::date) into v_first_date from jsonb_array_elements(p_lines) x;

    select b.balance, b.line_date into v_last_balance, v_last_date
      from public.bank_statement_lines b
     where b.account = v_account and b.line_date < v_first_date
     order by b.line_date desc, b.seq desc
     limit 1;
  end if;

  return jsonb_build_object(
    'known_account',        v_known_account,
    'total_lines',          v_total,
    'existing_lines',       v_existing,
    'new_lines',            v_total - v_existing,
    'stored_balance_before', v_last_balance,
    'stored_balance_date',  v_last_date
  );
end;
$fn$;

revoke all on function public.preview_bank_statement(text, text, jsonb) from public, anon;
grant execute on function public.preview_bank_statement(text, text, jsonb) to authenticated;


-- ═══ §6. Import ═════════════════════════════════════════════════════════════

create or replace function public.import_bank_statement(
  p_account         text,
  p_account_number  text,
  p_period_from     date,
  p_period_to       date,
  p_opening_balance numeric,
  p_closing_balance numeric,
  p_file_name       text,
  p_lines           jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor     uuid;
  v_number    text := btrim(coalesce(p_account_number, ''));
  v_bound     text;
  v_import    uuid;
  v_total     integer;
  v_new       integer;
  r           record;
  v_prev      numeric := p_opening_balance;
  v_calc      numeric;
begin
  v_actor := public.assert_bank_reconcile_door();

  if p_account not in ('hdfc', 'hdfc_sec') then
    raise exception 'BANK_ACCOUNT_INVALID' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'BANK_LINES_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 3000 then
    raise exception 'BANK_TOO_MANY_LINES: import in smaller periods' using errcode = '22023';
  end if;
  if p_period_from is null or p_period_to is null or p_period_from > p_period_to then
    raise exception 'BANK_PERIOD_INVALID' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_lines);

  -- Serialise imports per account so two uploads cannot interleave.
  perform pg_advisory_xact_lock(hashtext('bank_statement_import:' || p_account));

  -- Which account number is this? The first import for an account records the
  -- number the owner confirmed; every later one must carry the same number.
  select account into v_bound from public.bank_statement_accounts where account_number = v_number;
  if v_bound is not null and v_bound <> p_account then
    raise exception 'BANK_ACCOUNT_MISMATCH: this statement belongs to the other account' using errcode = '22023';
  end if;
  if exists (select 1 from public.bank_statement_accounts where account = p_account and account_number <> v_number) then
    raise exception 'BANK_ACCOUNT_MISMATCH: the account number differs from the one recorded' using errcode = '22023';
  end if;
  if v_bound is null then
    insert into public.bank_statement_accounts (account, account_number, set_by)
    values (p_account, v_number, v_actor);
  end if;

  -- The balance chain must close to the paisa, line by line: a statement that
  -- does not add up is a truncated or damaged download, and is refused.
  for r in
    select (x.ord)::integer as seq, x.ln->>'line_date' as line_date,
           coalesce((x.ln->>'withdrawal')::numeric, 0) as withdrawal,
           coalesce((x.ln->>'deposit')::numeric, 0)    as deposit,
           (x.ln->>'balance')::numeric                 as balance
      from jsonb_array_elements(p_lines) with ordinality as x(ln, ord)
     order by x.ord
  loop
    if (r.withdrawal = 0) = (r.deposit = 0) or r.withdrawal < 0 or r.deposit < 0 then
      raise exception 'BANK_LINE_INVALID: line % must be exactly one of withdrawal or deposit', r.seq using errcode = '22023';
    end if;
    v_calc := round(v_prev + r.deposit - r.withdrawal, 2);
    if v_calc <> round(r.balance, 2) then
      raise exception 'BANK_CHAIN_BROKEN: line % does not follow from the one before it', r.seq using errcode = '22023';
    end if;
    v_prev := r.balance;
  end loop;
  if round(v_prev, 2) <> round(p_closing_balance, 2) then
    raise exception 'BANK_CHAIN_BROKEN: the last balance does not equal the closing balance' using errcode = '22023';
  end if;

  insert into public.bank_statement_imports
    (account, period_from, period_to, opening_balance, closing_balance,
     line_count, new_line_count, file_name, imported_by)
  values (p_account, p_period_from, p_period_to, p_opening_balance, p_closing_balance,
          v_total, 0, left(p_file_name, 200), v_actor)
  returning id into v_import;

  insert into public.bank_statement_lines
    (import_id, account, seq, line_date, value_date, narration, bank_ref,
     withdrawal, deposit, balance, fingerprint)
  select v_import, p_account, x.ord::integer,
         (x.ln->>'line_date')::date,
         nullif(x.ln->>'value_date', '')::date,
         left(btrim(x.ln->>'narration'), 600),
         nullif(btrim(coalesce(x.ln->>'bank_ref', '')), ''),
         round(coalesce((x.ln->>'withdrawal')::numeric, 0), 2),
         round(coalesce((x.ln->>'deposit')::numeric, 0), 2),
         round((x.ln->>'balance')::numeric, 2),
         public.bank_line_fingerprint(
           (x.ln->>'line_date')::date,
           nullif(btrim(coalesce(x.ln->>'bank_ref', '')), ''),
           coalesce((x.ln->>'withdrawal')::numeric, 0),
           coalesce((x.ln->>'deposit')::numeric, 0),
           (x.ln->>'balance')::numeric,
           left(btrim(x.ln->>'narration'), 600))
    from jsonb_array_elements(p_lines) with ordinality as x(ln, ord)
  on conflict (account, fingerprint) do nothing;

  get diagnostics v_new = row_count;
  update public.bank_statement_imports set new_line_count = v_new where id = v_import;

  return jsonb_build_object('import_id', v_import, 'total_lines', v_total,
                            'new_lines', v_new, 'skipped_lines', v_total - v_new);
end;
$fn$;

revoke all on function public.import_bank_statement(text, text, date, date, numeric, numeric, text, jsonb) from public, anon;
grant execute on function public.import_bank_statement(text, text, date, date, numeric, numeric, text, jsonb) to authenticated;


-- ═══ §7. Link / unlink ══════════════════════════════════════════════════════

create or replace function public.link_bank_line_to_payment(
  p_line_id    uuid,
  p_payment_id uuid,
  p_amount     numeric default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor       uuid;
  v_line        public.bank_statement_lines%rowtype;
  v_pay         public.finance_payment_requests%rowtype;
  v_line_used   numeric;
  v_pay_used    numeric;
  v_amount      numeric;
  v_id          uuid;
begin
  v_actor := public.assert_bank_reconcile_door();

  select * into v_line from public.bank_statement_lines where id = p_line_id for update;
  if not found then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_line.deposit <= 0 then
    raise exception 'BANK_LINE_NOT_A_CREDIT: only money in can be linked' using errcode = '22023';
  end if;
  if v_line.classification is not null then
    raise exception 'BANK_LINE_CLASSIFIED: clear the old-order / not-customer-money mark first' using errcode = '22023';
  end if;

  select * into v_pay from public.finance_payment_requests where id = p_payment_id for update;
  if not found or v_pay.deleted_at is not null then
    raise exception 'BANK_PAYMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_pay.status = 'rejected' then
    raise exception 'BANK_PAYMENT_REJECTED: a rejected payment cannot be linked' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_line_used
    from public.bank_line_payment_links where line_id = p_line_id and unlinked_at is null;
  select coalesce(sum(amount), 0) into v_pay_used
    from public.bank_line_payment_links where payment_id = p_payment_id and unlinked_at is null;

  if v_line_used >= v_line.deposit then
    raise exception 'BANK_LINE_OVER_LINKED: this credit is already fully linked' using errcode = '22023';
  end if;
  if v_pay_used >= v_pay.amount then
    raise exception 'BANK_PAYMENT_OVER_LINKED: this payment is already fully linked' using errcode = '22023';
  end if;

  v_amount := coalesce(p_amount, least(v_line.deposit - v_line_used, v_pay.amount - v_pay_used));
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception 'BANK_LINK_AMOUNT_INVALID' using errcode = '22023';
  end if;
  if v_line_used + v_amount > v_line.deposit then
    raise exception 'BANK_LINE_OVER_LINKED: the bank line has only % left', v_line.deposit - v_line_used using errcode = '22023';
  end if;
  if v_pay_used + v_amount > v_pay.amount then
    raise exception 'BANK_PAYMENT_OVER_LINKED: the payment has only % left to link', v_pay.amount - v_pay_used using errcode = '22023';
  end if;

  insert into public.bank_line_payment_links (line_id, payment_id, amount, linked_by)
  values (p_line_id, p_payment_id, v_amount, v_actor)
  returning id into v_id;
  return v_id;
end;
$fn$;

create or replace function public.unlink_bank_line_payment(p_link_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid;
  n       integer;
begin
  v_actor := public.assert_bank_reconcile_door();
  update public.bank_line_payment_links
     set unlinked_by = v_actor, unlinked_at = now()
   where id = p_link_id and unlinked_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'BANK_LINK_NOT_FOUND' using errcode = 'P0002'; end if;
end;
$fn$;

revoke all on function public.link_bank_line_to_payment(uuid, uuid, numeric) from public, anon;
revoke all on function public.unlink_bank_line_payment(uuid) from public, anon;
grant execute on function public.link_bank_line_to_payment(uuid, uuid, numeric) to authenticated;
grant execute on function public.unlink_bank_line_payment(uuid) to authenticated;


-- ═══ §8. Old order / not customer money ═════════════════════════════════════

create or replace function public.classify_bank_line(
  p_line_id        uuid,
  p_classification text,
  p_kind           text default null,
  p_customer       text default null,
  p_order_ref      text default null,
  p_note           text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid;
  v_line  public.bank_statement_lines%rowtype;
begin
  v_actor := public.assert_bank_reconcile_door();

  select * into v_line from public.bank_statement_lines where id = p_line_id for update;
  if not found then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_line.deposit <= 0 then
    raise exception 'BANK_LINE_NOT_A_CREDIT' using errcode = '22023';
  end if;
  if exists (select 1 from public.bank_line_payment_links where line_id = p_line_id and unlinked_at is null) then
    raise exception 'BANK_LINE_LINKED: unlink its payment first' using errcode = '22023';
  end if;

  if p_classification = 'old_order' then
    if p_customer is null or length(btrim(p_customer)) = 0 then
      raise exception 'BANK_CUSTOMER_REQUIRED: name the customer of the old order' using errcode = '22023';
    end if;
    update public.bank_statement_lines
       set classification = 'old_order', non_customer_kind = null,
           old_order_customer = left(btrim(p_customer), 120),
           old_order_ref = nullif(left(btrim(coalesce(p_order_ref, '')), 60), ''),
           note = nullif(left(btrim(coalesce(p_note, '')), 300), ''),
           classified_by = v_actor, classified_at = now()
     where id = p_line_id;
  elsif p_classification = 'not_customer_money' then
    if p_kind is null or p_kind not in ('own_transfer', 'fd_redemption', 'refund', 'interest', 'bank_test', 'other') then
      raise exception 'BANK_KIND_INVALID' using errcode = '22023';
    end if;
    update public.bank_statement_lines
       set classification = 'not_customer_money', non_customer_kind = p_kind,
           old_order_customer = null, old_order_ref = null,
           note = nullif(left(btrim(coalesce(p_note, '')), 300), ''),
           classified_by = v_actor, classified_at = now()
     where id = p_line_id;
  else
    raise exception 'BANK_CLASSIFICATION_INVALID' using errcode = '22023';
  end if;
end;
$fn$;

create or replace function public.clear_bank_line_classification(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  n integer;
begin
  perform public.assert_bank_reconcile_door();
  update public.bank_statement_lines
     set classification = null, non_customer_kind = null, old_order_customer = null,
         old_order_ref = null, note = null, classified_by = null, classified_at = null
   where id = p_line_id and classification is not null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
end;
$fn$;

revoke all on function public.classify_bank_line(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.clear_bank_line_classification(uuid) from public, anon;
grant execute on function public.classify_bank_line(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.clear_bank_line_classification(uuid) to authenticated;


-- ═══ §9. Self-assertions ════════════════════════════════════════════════════

do $assert$
begin
  if not exists (
    select 1 from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'finance'
    join public.permission_actions pa on pa.id = mpa.action_id and pa.action_key = 'reconcile'
    where mpa.default_allowed = false
  ) then
    raise exception 'ASSERTION FAILED: finance.reconcile is not registered deny-by-default';
  end if;

  if has_table_privilege('authenticated', 'public.bank_statement_lines', 'insert')
     or has_table_privilege('authenticated', 'public.bank_statement_lines', 'update')
     or has_table_privilege('authenticated', 'public.bank_statement_lines', 'delete')
     or has_table_privilege('authenticated', 'public.bank_line_payment_links', 'insert')
     or has_table_privilege('authenticated', 'public.bank_line_payment_links', 'update') then
    raise exception 'ASSERTION FAILED: a client role can write a bank table directly';
  end if;

  if has_function_privilege('anon', 'public.import_bank_statement(text, text, date, date, numeric, numeric, text, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.link_bank_line_to_payment(uuid, uuid, numeric)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can execute a bank RPC';
  end if;

  if public.bank_line_fingerprint(date '2026-10-01', 'X1', 0, 10.5, 100.5, 'a')
     <> public.bank_line_fingerprint(date '2026-10-01', 'X1', 0.00, 10.50, 100.50, 'a') then
    raise exception 'ASSERTION FAILED: the fingerprint depends on numeric scale';
  end if;
end $assert$;
