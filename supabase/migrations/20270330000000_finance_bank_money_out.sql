-- Finance: bank statements, money out.
--
-- A debit on the statement is either
--   * LINKED to an expense somebody recorded in the app,
--   * marked NOT AN EXPENSE (a supplier payment, salary, tax or GST, a loan EMI,
--     a transfer to the company's own other account, bank charges, other), or
--   * UNEXPLAINED — nobody has said yet.
--
-- Most debits on the statements are NOT expenses recorded in the app (supplier
-- NEFT/RTGS payments, tax, EMIs), so "not an expense" is a first-class answer,
-- and supplier payments are marked with the payee's name only: there is no
-- purchases module for them to link to.
--
-- This changes nothing about credits, payments or expenses. It adds two columns
-- to bank_statement_lines (debit_kind, debit_payee), widens the classification
-- check with 'not_expense', adds bank_line_expense_links, and four RPCs.
-- Like every bank RPC, each begins with assert_bank_reconcile_door().

do $dep$
begin
  if to_regprocedure('public.assert_bank_reconcile_door()') is null then
    raise exception 'DEPENDENCY MISSING: 20270329000000 (bank statements) must be applied before this migration';
  end if;
end $dep$;


-- ═══ §1. Columns and the widened classification ═════════════════════════════

alter table public.bank_statement_lines
  add column if not exists debit_kind text null
    constraint bank_statement_lines_debit_kind_check
    check (debit_kind in ('supplier_payment', 'salary', 'tax', 'loan_emi', 'own_transfer', 'bank_charges', 'other')),
  add column if not exists debit_payee text null
    constraint bank_statement_lines_debit_payee_check
    check (debit_payee is null or length(debit_payee) <= 120);

-- The two checks created in 20270329000000, replaced by their widened forms.
alter table public.bank_statement_lines drop constraint if exists bank_statement_lines_classification_check;
alter table public.bank_statement_lines drop constraint if exists bank_statement_lines_classification_shape;

alter table public.bank_statement_lines
  add constraint bank_statement_lines_classification_check
    check (classification in ('old_order', 'not_customer_money', 'not_expense'));

alter table public.bank_statement_lines
  add constraint bank_statement_lines_classification_shape check (
    (classification is null
       and non_customer_kind is null and old_order_customer is null and old_order_ref is null
       and debit_kind is null and debit_payee is null
       and classified_by is null and classified_at is null)
    or (classification = 'old_order'
       and deposit > 0 and non_customer_kind is null and debit_kind is null and debit_payee is null
       and old_order_customer is not null and length(btrim(old_order_customer)) > 0
       and classified_by is not null and classified_at is not null)
    or (classification = 'not_customer_money'
       and deposit > 0 and non_customer_kind is not null and debit_kind is null and debit_payee is null
       and old_order_customer is null and old_order_ref is null
       and classified_by is not null and classified_at is not null)
    or (classification = 'not_expense'
       and withdrawal > 0 and debit_kind is not null and non_customer_kind is null
       and old_order_customer is null and old_order_ref is null
       and classified_by is not null and classified_at is not null)
  );


-- ═══ §2. Debit ↔ expense links ══════════════════════════════════════════════

create table if not exists public.bank_line_expense_links (
  id            uuid        primary key default gen_random_uuid(),
  line_id       uuid        not null references public.bank_statement_lines(id),
  expense_id    uuid        not null references public.expenses(id),
  amount        numeric(14,2) not null check (amount > 0),
  linked_by     uuid        not null references public.users(id),
  linked_at     timestamptz not null default now(),
  unlinked_by   uuid        null references public.users(id),
  unlinked_at   timestamptz null,
  constraint bank_line_expense_links_unlink_pair
    check ((unlinked_by is null) = (unlinked_at is null))
);

create unique index if not exists bank_line_expense_links_active_unique
  on public.bank_line_expense_links (line_id, expense_id) where unlinked_at is null;
create index if not exists bank_line_expense_links_expense_idx
  on public.bank_line_expense_links (expense_id) where unlinked_at is null;

alter table public.bank_line_expense_links enable row level security;
drop policy if exists bank_line_expense_links_module_entry_gate on public.bank_line_expense_links;
create policy bank_line_expense_links_module_entry_gate
  on public.bank_line_expense_links as restrictive for all to authenticated
  using (public.module_entry_open('finance')) with check (public.module_entry_open('finance'));
drop policy if exists bank_line_expense_links_reconcile_select on public.bank_line_expense_links;
create policy bank_line_expense_links_reconcile_select
  on public.bank_line_expense_links for select to authenticated
  using (public.actor_has_module_permission('finance', 'reconcile'));
revoke all on public.bank_line_expense_links from public, anon, authenticated;
grant select on public.bank_line_expense_links to authenticated;


-- ═══ §3. RPCs ═══════════════════════════════════════════════════════════════

create or replace function public.link_bank_debit_to_expense(
  p_line_id    uuid,
  p_expense_id uuid,
  p_amount     numeric default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor     uuid;
  v_line      public.bank_statement_lines%rowtype;
  v_exp       public.expenses%rowtype;
  v_line_used numeric;
  v_exp_used  numeric;
  v_amount    numeric;
  v_id        uuid;
begin
  v_actor := public.assert_bank_reconcile_door();

  select * into v_line from public.bank_statement_lines where id = p_line_id for update;
  if not found then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_line.withdrawal <= 0 then
    raise exception 'BANK_LINE_NOT_A_DEBIT: only money out can be linked to an expense' using errcode = '22023';
  end if;
  if v_line.classification is not null then
    raise exception 'BANK_LINE_CLASSIFIED: clear the not-an-expense mark first' using errcode = '22023';
  end if;

  select * into v_exp from public.expenses where id = p_expense_id for update;
  if not found or v_exp.deleted_at is not null then
    raise exception 'BANK_EXPENSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(sum(amount), 0) into v_line_used
    from public.bank_line_expense_links where line_id = p_line_id and unlinked_at is null;
  select coalesce(sum(amount), 0) into v_exp_used
    from public.bank_line_expense_links where expense_id = p_expense_id and unlinked_at is null;

  if v_line_used >= v_line.withdrawal then
    raise exception 'BANK_LINE_OVER_LINKED: this debit is already fully linked' using errcode = '22023';
  end if;
  if v_exp_used >= v_exp.amount then
    raise exception 'BANK_EXPENSE_OVER_LINKED: this expense is already fully linked' using errcode = '22023';
  end if;

  v_amount := coalesce(p_amount, least(v_line.withdrawal - v_line_used, v_exp.amount - v_exp_used));
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception 'BANK_LINK_AMOUNT_INVALID' using errcode = '22023';
  end if;
  if v_line_used + v_amount > v_line.withdrawal then
    raise exception 'BANK_LINE_OVER_LINKED: the bank line has only % left', v_line.withdrawal - v_line_used using errcode = '22023';
  end if;
  if v_exp_used + v_amount > v_exp.amount then
    raise exception 'BANK_EXPENSE_OVER_LINKED: the expense has only % left to link', v_exp.amount - v_exp_used using errcode = '22023';
  end if;

  insert into public.bank_line_expense_links (line_id, expense_id, amount, linked_by)
  values (p_line_id, p_expense_id, v_amount, v_actor)
  returning id into v_id;
  return v_id;
end;
$fn$;

create or replace function public.unlink_bank_debit_expense(p_link_id uuid)
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
  update public.bank_line_expense_links
     set unlinked_by = v_actor, unlinked_at = now()
   where id = p_link_id and unlinked_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'BANK_LINK_NOT_FOUND' using errcode = 'P0002'; end if;
end;
$fn$;

-- Mark debits as "not an expense", one or many in ONE transaction (every row or
-- none). p_items: [{"line_id": uuid, "kind": text, "payee": text, "note": text}].
create or replace function public.classify_bank_debits(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid;
  r       record;
  v_line  public.bank_statement_lines%rowtype;
  v_n     integer := 0;
begin
  v_actor := public.assert_bank_reconcile_door();
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'BANK_ITEMS_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'BANK_ITEMS_TOO_MANY: mark at most 500 debits at once' using errcode = '22023';
  end if;

  for r in
    select (x->>'line_id')::uuid as line_id, x->>'kind' as kind,
           nullif(left(btrim(coalesce(x->>'payee', '')), 120), '') as payee,
           nullif(left(btrim(coalesce(x->>'note', '')), 300), '') as note
      from jsonb_array_elements(p_items) x
     order by 1
  loop
    if r.kind is null or r.kind not in ('supplier_payment', 'salary', 'tax', 'loan_emi', 'own_transfer', 'bank_charges', 'other') then
      raise exception 'BANK_KIND_INVALID' using errcode = '22023';
    end if;
    select * into v_line from public.bank_statement_lines where id = r.line_id for update;
    if not found then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
    if v_line.withdrawal <= 0 then
      raise exception 'BANK_LINE_NOT_A_DEBIT' using errcode = '22023';
    end if;
    if exists (select 1 from public.bank_line_expense_links where line_id = r.line_id and unlinked_at is null) then
      raise exception 'BANK_LINE_LINKED: unlink its expense first' using errcode = '22023';
    end if;
    update public.bank_statement_lines
       set classification = 'not_expense', debit_kind = r.kind, debit_payee = r.payee,
           non_customer_kind = null, old_order_customer = null, old_order_ref = null,
           note = r.note, classified_by = v_actor, classified_at = now()
     where id = r.line_id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$fn$;

-- Re-emitted from 20270329000000 with the two new columns cleared as well.
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
         old_order_ref = null, debit_kind = null, debit_payee = null,
         note = null, classified_by = null, classified_at = null
   where id = p_line_id and classification is not null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
end;
$fn$;

revoke all on function public.link_bank_debit_to_expense(uuid, uuid, numeric) from public, anon;
revoke all on function public.unlink_bank_debit_expense(uuid) from public, anon;
revoke all on function public.classify_bank_debits(jsonb) from public, anon;
revoke all on function public.clear_bank_line_classification(uuid) from public, anon;
grant execute on function public.link_bank_debit_to_expense(uuid, uuid, numeric) to authenticated;
grant execute on function public.unlink_bank_debit_expense(uuid) to authenticated;
grant execute on function public.classify_bank_debits(jsonb) to authenticated;
grant execute on function public.clear_bank_line_classification(uuid) to authenticated;


-- ═══ §4. Self-assertions ════════════════════════════════════════════════════

do $assert$
begin
  if has_table_privilege('authenticated', 'public.bank_line_expense_links', 'insert')
     or has_table_privilege('authenticated', 'public.bank_line_expense_links', 'update')
     or has_table_privilege('authenticated', 'public.bank_line_expense_links', 'delete') then
    raise exception 'ASSERTION FAILED: a client role can write bank_line_expense_links directly';
  end if;
  if has_function_privilege('anon', 'public.classify_bank_debits(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.link_bank_debit_to_expense(uuid, uuid, numeric)', 'execute')
     or has_function_privilege('anon', 'public.clear_bank_line_classification(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can execute a bank RPC';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bank_statement_lines_classification_shape'
                  and pg_get_constraintdef(oid) like '%not_expense%') then
    raise exception 'ASSERTION FAILED: the classification shape does not know not_expense';
  end if;
end $assert$;
