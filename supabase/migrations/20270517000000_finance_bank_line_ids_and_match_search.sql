-- ═══════════════════════════════════════════════════════════════════════════════
-- COMPARE AND LINK: a Bank Statements ID, a rejected suggestion that stays
-- rejected, and a search of the money not matched yet.
--
-- Owner, 2026-11-01. Verifying an HDFC payment stays exactly as 20270516000000 left
-- it. This adds only what the window needs around it:
--
--   bank_statement_lines.statement_no   a number for every bank line, shown as
--                                       BS-00412. One sequence across both accounts,
--                                       never reused. Existing lines are numbered
--                                       oldest first; a new upload carries on. A line
--                                       an overlapping upload finds again keeps its
--                                       number, though the skipped insert uses one up,
--                                       so the numbers can have gaps.
--   bank_match_dismissals               "Not this one": who rejected which credit for
--                                       which payment, and when. Undo keeps the row,
--                                       with who undid it. Rows are written only
--                                       through the two doors below.
--   dismiss_bank_match / restore_bank_match
--   search_bank_unmatched               credits with money left, by Bank Statements
--                                       ID, name, amount, UTR or date. A rejected
--                                       credit stays findable, so a mistaken rejection
--                                       can never block a payment.
--
-- A rejection is a note beside the suggestions, not a rule: nothing in the database
-- refuses to link a rejected credit, because the person may change their mind.
--
-- ROLLBACK:
--   drop function public.search_bank_unmatched(text, date);
--   drop function public.restore_bank_match(uuid, uuid);
--   drop function public.dismiss_bank_match(uuid, uuid);
--   drop table public.bank_match_dismissals;
--   drop index public.bank_statement_lines_statement_no_unique;
--   alter table public.bank_statement_lines drop column statement_no;
--   drop sequence public.bank_statement_line_no_seq;
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.assert_bank_reconcile_door()') is null
     or to_regprocedure('public.module_entry_open(text)') is null
     or to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'bank door helpers are missing';
  end if;
end;
$$;


-- ═══ §1. The Bank Statements ID ═══════════════════════════════════════════════

create sequence if not exists public.bank_statement_line_no_seq;
alter table public.bank_statement_lines add column if not exists statement_no bigint;

-- Oldest first, in statement order within a day. Only lines with no number yet, so a
-- second run changes nothing.
with base as (
  select coalesce(max(statement_no), 0) as top from public.bank_statement_lines
), numbered as (
  select l.id, row_number() over (order by l.line_date, l.account, l.seq, l.id) as rn
    from public.bank_statement_lines l
   where l.statement_no is null
)
update public.bank_statement_lines l
   set statement_no = b.top + n.rn
  from numbered n, base b
 where l.id = n.id;

select setval(
  'public.bank_statement_line_no_seq',
  greatest((select coalesce(max(statement_no), 0) from public.bank_statement_lines), 1),
  (select count(*) > 0 from public.bank_statement_lines));

alter sequence public.bank_statement_line_no_seq owned by public.bank_statement_lines.statement_no;
alter table public.bank_statement_lines
  alter column statement_no set default nextval('public.bank_statement_line_no_seq'),
  alter column statement_no set not null;

create unique index if not exists bank_statement_lines_statement_no_unique
  on public.bank_statement_lines (statement_no);

comment on column public.bank_statement_lines.statement_no is
  'The Bank Statements ID, shown as BS-00412. One sequence across both accounts, never reused; numbers can have gaps. 20270517000000.';


-- ═══ §2. Not this one ═════════════════════════════════════════════════════════

create table if not exists public.bank_match_dismissals (
  id           uuid        primary key default gen_random_uuid(),
  payment_id   uuid        not null references public.finance_payment_requests(id) on delete cascade,
  line_id      uuid        not null references public.bank_statement_lines(id) on delete cascade,
  dismissed_by uuid        not null references public.users(id),
  dismissed_at timestamptz not null default now(),
  undone_by    uuid        null references public.users(id),
  undone_at    timestamptz null,
  constraint bank_match_dismissals_undone_pair check ((undone_by is null) = (undone_at is null))
);

create unique index if not exists bank_match_dismissals_active_unique
  on public.bank_match_dismissals (payment_id, line_id) where undone_at is null;

comment on table public.bank_match_dismissals is
  '"Not this one": a credit a person rejected as a suggestion for a payment. A note beside the suggestions, not a rule. 20270517000000.';

alter table public.bank_match_dismissals enable row level security;
drop policy if exists bank_match_dismissals_module_entry_gate on public.bank_match_dismissals;
create policy bank_match_dismissals_module_entry_gate on public.bank_match_dismissals
  as restrictive for all to authenticated
  using (public.module_entry_open('finance')) with check (public.module_entry_open('finance'));
drop policy if exists bank_match_dismissals_reconcile_select on public.bank_match_dismissals;
create policy bank_match_dismissals_reconcile_select on public.bank_match_dismissals
  for select to authenticated
  using (public.actor_has_module_permission('finance', 'reconcile'));
revoke all on public.bank_match_dismissals from public, anon, authenticated;
grant select on public.bank_match_dismissals to authenticated;

create or replace function public.dismiss_bank_match(p_payment_id uuid, p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := public.assert_bank_reconcile_door();
begin
  if not exists (select 1 from public.finance_payment_requests p where p.id = p_payment_id) then
    raise exception 'BANK_PAYMENT_NOT_FOUND: that payment is not available' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bank_statement_lines l where l.id = p_line_id and l.deposit > 0) then
    raise exception 'BANK_LINE_NOT_FOUND: that bank credit is not available' using errcode = '22023';
  end if;
  insert into public.bank_match_dismissals (payment_id, line_id, dismissed_by)
  values (p_payment_id, p_line_id, v_actor)
  on conflict (payment_id, line_id) where undone_at is null do nothing;
end;
$fn$;

comment on function public.dismiss_bank_match(uuid, uuid) is
  'Not this one: stops a credit being suggested for a payment. finance.reconcile. Twice is the same as once. 20270517000000.';

create or replace function public.restore_bank_match(p_payment_id uuid, p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := public.assert_bank_reconcile_door();
begin
  update public.bank_match_dismissals d
     set undone_by = v_actor, undone_at = now()
   where d.payment_id = p_payment_id
     and d.line_id = p_line_id
     and d.undone_at is null;
end;
$fn$;

comment on function public.restore_bank_match(uuid, uuid) is
  'Undoes Not this one. The row stays, with who undid it. finance.reconcile. 20270517000000.';


-- ═══ §3. Search ═══════════════════════════════════════════════════════════════

-- Credits with money left and no person's mark on them: the money that can still be
-- matched. Reads through the door, because "money left" is the sum of active links
-- and a limit applied in the browser would be cut short by credits already used.
create or replace function public.search_bank_unmatched(p_query text, p_date date default null)
returns table (
  line_id      uuid,
  statement_no bigint,
  account      text,
  line_date    date,
  deposit      numeric,
  remaining    numeric,
  narration    text,
  bank_ref     text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
#variable_conflict use_column
declare
  v_text   text := btrim(left(coalesce(p_query, ''), 100));
  v_clean  text;
  v_no     bigint;
  v_amount numeric;
  v_like   text;
begin
  perform public.assert_bank_reconcile_door();

  if length(v_text) < 2 and p_date is null then
    return;
  end if;

  v_no := substring(lower(v_text) from '^bs-?0*([0-9]{1,15})$')::bigint;
  v_clean := regexp_replace(v_text, '[,₹[:space:]]', '', 'g');
  if v_clean ~ '^[0-9]{1,15}(\.[0-9]{1,2})?$' then
    v_amount := v_clean::numeric;
  end if;
  v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  select l.id, l.statement_no, l.account, l.line_date, l.deposit,
         l.deposit - coalesce(k.total, 0), l.narration, l.bank_ref
    from public.bank_statement_lines l
    left join lateral (
      select sum(x.amount) as total
        from public.bank_line_payment_links x
       where x.line_id = l.id and x.unlinked_at is null
    ) k on true
   where l.deposit > 0
     and l.classification is null
     and l.deposit - coalesce(k.total, 0) > 0
     and (
       (v_no is not null and l.statement_no = v_no)
       or (v_no is null and p_date is not null and l.line_date = p_date)
       or (v_no is null and v_text <> '' and (
             l.narration ilike v_like
             or l.bank_ref ilike v_like
             or (v_amount is not null and (
                   l.deposit = v_amount
                   or l.deposit - coalesce(k.total, 0) = v_amount
                   or l.statement_no::numeric = v_amount)))))
   order by l.line_date desc, l.statement_no desc
   limit 50;
end;
$fn$;

comment on function public.search_bank_unmatched(text, date) is
  'Credits with money left, by Bank Statements ID, name, amount, UTR or date. A rejected credit is still found. finance.reconcile. 20270517000000.';


-- ═══ §4. Who may call what ════════════════════════════════════════════════════

revoke all on function public.dismiss_bank_match(uuid, uuid) from public, anon;
revoke all on function public.restore_bank_match(uuid, uuid) from public, anon;
revoke all on function public.search_bank_unmatched(text, date) from public, anon;
grant execute on function public.dismiss_bank_match(uuid, uuid) to authenticated;
grant execute on function public.restore_bank_match(uuid, uuid) to authenticated;
grant execute on function public.search_bank_unmatched(text, date) to authenticated;

do $assert$
declare
  f text;
begin
  if exists (select 1 from public.bank_statement_lines where statement_no is null) then
    raise exception 'every bank line must have a Bank Statements ID';
  end if;
  if (select count(*) from public.bank_statement_lines)
     <> (select count(distinct statement_no) from public.bank_statement_lines) then
    raise exception 'Bank Statements IDs must be unique';
  end if;
  if has_table_privilege('authenticated', 'public.bank_match_dismissals', 'insert')
     or has_table_privilege('authenticated', 'public.bank_match_dismissals', 'update')
     or has_table_privilege('authenticated', 'public.bank_match_dismissals', 'delete') then
    raise exception 'bank_match_dismissals is written only through its doors';
  end if;
  foreach f in array array[
    'public.dismiss_bank_match(uuid, uuid)',
    'public.restore_bank_match(uuid, uuid)',
    'public.search_bank_unmatched(text, date)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '% must not be executable by anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must be executable by authenticated', f;
    end if;
  end loop;
end
$assert$;
