-- ── 20270205120000, PROVEN ──────────────────────────────────────────────────
--
-- Run by run_expense_reimbursement_suite.sh against a disposable database that
-- holds the shaped base, the storage shape, the four earlier expense migrations,
-- ONE legacy expense entered before this migration, and 20270205120000.
--
-- Every behavioural check runs as a CLIENT ROLE (`set local role authenticated`
-- plus a jwt sub), so RLS, the column grants and the triggers are all in force.

\set ON_ERROR_STOP on

insert into public.users (id, full_name, role) values
  ('11111111-1111-1111-1111-111111111111', 'Creator',     'employee'),
  ('22222222-2222-2222-2222-222222222222', 'Finance',     'employee'),
  ('33333333-3333-3333-3333-333333333333', 'Outsider',    'employee'),
  ('44444444-4444-4444-4444-444444444444', 'Admin',       'admin'),
  ('55555555-5555-5555-5555-555555555555', 'Colleague',   'employee'),
  ('66666666-6666-6666-6666-666666666666', 'Manage only', 'employee')
on conflict (id) do nothing;

insert into public.test_module_entry (user_id, module_key) values
  ('11111111-1111-1111-1111-111111111111', 'finance'),
  ('22222222-2222-2222-2222-222222222222', 'finance'),
  ('55555555-5555-5555-5555-555555555555', 'finance'),
  ('66666666-6666-6666-6666-666666666666', 'finance')
on conflict do nothing;

-- Finance (222) holds manage AND view_all, which is what recording a
-- reimbursement requires. 666 holds manage without company-wide sight: the
-- control that proves view_all is part of the rule.
insert into public.test_permissions (user_id, module_key, action_key) values
  ('11111111-1111-1111-1111-111111111111', 'finance', 'create'),
  ('22222222-2222-2222-2222-222222222222', 'finance', 'create'),
  ('22222222-2222-2222-2222-222222222222', 'finance', 'manage'),
  ('22222222-2222-2222-2222-222222222222', 'finance', 'view_all'),
  ('55555555-5555-5555-5555-555555555555', 'finance', 'create'),
  ('66666666-6666-6666-6666-666666666666', 'finance', 'create'),
  ('66666666-6666-6666-6666-666666666666', 'finance', 'manage')
on conflict do nothing;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok: %', p_what;
end $$;

-- Runs p_sql and asserts it raises, with p_fragment in the message.
create or replace function pg_temp.refused(p_sql text, p_fragment text, p_what text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_fragment in sqlerrm) = 0 then
      raise exception 'FAILED: % — refused, but with "%"', p_what, sqlerrm;
    end if;
    raise notice 'ok: %', p_what;
    return;
  end;
  raise exception 'FAILED: % — it was allowed', p_what;
end $$;

-- A record of the ids the checks below create, so later blocks can find them.
create table public.test_ids (k text primary key, id uuid not null);
grant all on public.test_ids to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE LEGACY EXPENSE IS UNKNOWN, NOT CLASSIFIED
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v record;
begin
  select * into v from public.expenses where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  perform pg_temp.ok(v.paid_from is null and v.paid_by is null and v.reimbursement_id is null,
    'the legacy expense is neither company-paid nor personal, and not reimbursed');
  perform pg_temp.ok(v.amount = 1000.00 and v.paid_to = 'Legacy payee', 'and is otherwise unchanged');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ENTRY: THE SOURCE, THE PAYER, AND WHO MAY NAME SOMEBODY ELSE
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_cat uuid := (select id from public.expense_categories limit 1);
declare v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from)
  values (current_date, 500.00, 'upi', 'Company vendor', v_cat, auth.uid(), 'company') returning id into v_id;
  insert into public.test_ids values ('company', v_id);
  perform pg_temp.ok(true, 'a company-paid expense is recorded');

  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
  values (current_date, 120.50, 'cash', 'Diesel', v_cat, auth.uid(), 'personal', auth.uid()) returning id into v_id;
  insert into public.test_ids values ('p1', v_id);
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
  values (current_date - 1, 79.50, 'cash', 'Courier', v_cat, auth.uid(), 'personal', auth.uid()) returning id into v_id;
  insert into public.test_ids values ('p2', v_id);
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
  values (current_date - 2, 300.00, 'cash', 'Repair', v_cat, auth.uid(), 'personal', auth.uid()) returning id into v_id;
  insert into public.test_ids values ('p3', v_id);
  perform pg_temp.ok(true, 'personal expenses paid by the recorder are recorded');

  perform pg_temp.refused(format(
    $q$insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
       values (current_date, 10, 'cash', 'X', %L, auth.uid(), 'personal', '55555555-5555-5555-5555-555555555555')$q$, v_cat),
    'Only Finance can record an expense as paid by somebody else',
    'an employee cannot say a colleague paid');

  perform pg_temp.refused(format(
    $q$insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
       values (current_date, 10, 'cash', 'X', %L, auth.uid(), 'company', auth.uid())$q$, v_cat),
    'expenses_paid_by_matches_source', 'a company-paid expense cannot carry a payer');
  perform pg_temp.refused(format(
    $q$insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from)
       values (current_date, 10, 'cash', 'X', %L, auth.uid(), 'personal')$q$, v_cat),
    'expenses_paid_by_matches_source', 'a personal expense must name who paid');
  perform pg_temp.refused(format(
    $q$insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_by)
       values (current_date, 10, 'cash', 'X', %L, auth.uid(), auth.uid())$q$, v_cat),
    'expenses_paid_by_matches_source', 'an unrecorded source cannot carry a payer');
  perform pg_temp.refused(format(
    $q$insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from)
       values (current_date, 10, 'cash', 'X', %L, auth.uid(), 'petty')$q$, v_cat),
    'expenses_paid_from_known', 'an unknown source value is refused');

  -- The old client's insert, with no source at all, still works.
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by)
  values (current_date, 42.00, 'cash', 'Old client', v_cat, auth.uid()) returning id into v_id;
  insert into public.test_ids values ('oldclient', v_id);
  perform pg_temp.ok(true, 'an insert that does not send the new columns still succeeds (release window)');

  perform pg_temp.refused(format(
    $q$update public.expenses set reimbursement_id = gen_random_uuid(), updated_by = auth.uid() where id = %L$q$,
    (select id from public.test_ids where k = 'p1')),
    'only through Finance', 'an author cannot set the reimbursement link directly');
  reset role;

  -- Finance may record an expense a colleague paid.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
  values (current_date, 60.00, 'cash', 'Tea for visitors', v_cat, auth.uid(), 'personal', '55555555-5555-5555-5555-555555555555')
  returning id into v_id;
  insert into public.test_ids values ('colleague', v_id);
  perform pg_temp.ok(true, 'finance.manage records an expense paid by a colleague');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. WHO MAY RECORD A REIMBURSEMENT
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_ids uuid[] := array[(select id from public.test_ids where k = 'p1'), (select id from public.test_ids where k = 'p2')];
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(%L::uuid[], current_date, 'R1', 200.00)$q$, v_ids),
    'EXPENSE_REIMBURSEMENT_FORBIDDEN', 'the author of the expenses cannot reimburse them');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', true);
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(%L::uuid[], current_date, 'R1', 200.00)$q$, v_ids),
    'EXPENSE_REIMBURSEMENT_FORBIDDEN', 'finance.manage without company-wide sight cannot reimburse');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(%L::uuid[], current_date, 'R1', 200.00)$q$, v_ids),
    'EXPENSE_REIMBURSEMENT_FORBIDDEN', 'somebody outside Finance cannot reimburse');
  reset role;

  perform pg_temp.ok(not has_function_privilege('anon', 'public.record_expense_reimbursement(uuid[], date, text, numeric, text)', 'execute'),
    'anon cannot execute record_expense_reimbursement');
  perform pg_temp.ok(not has_function_privilege('anon', 'public.reverse_expense_reimbursement(uuid, text)', 'execute'),
    'anon cannot execute reverse_expense_reimbursement');
  perform pg_temp.ok((select count(*) from public.expense_reimbursements) = 0, 'no refused call wrote a reimbursement');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. MIXED, STALE AND MALFORMED SELECTIONS WRITE NOTHING
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  p1 uuid := (select id from public.test_ids where k = 'p1');
  p2 uuid := (select id from public.test_ids where k = 'p2');
  co uuid := (select id from public.test_ids where k = 'company');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(array[%L, %L]::uuid[], current_date, 'R1', 620.50)$q$, p1, co),
    'paid from a company account', 'a company-paid expense cannot be reimbursed (mixed selection)');
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(array[%L, %L]::uuid[], current_date, 'R1', 1120.50)$q$,
      p1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    'no payment source recorded', 'a legacy expense cannot be reimbursed until its source is recorded');
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(array[%L, %L]::uuid[], current_date, 'R1', 999.00)$q$, p1, p2),
    'EXPENSE_REIMBURSEMENT_STALE', 'a total that differs from the confirmed one is refused');
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(array[%L, %L]::uuid[], current_date, 'R1', 241.00)$q$, p1, p1),
    'listed twice', 'the same expense twice is refused');
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(array[%L]::uuid[], current_date, '   ', 120.50)$q$, p1),
    'challan / payment reference', 'a blank reference is refused');
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(array[%L]::uuid[], current_date + 5, 'R1', 120.50)$q$, p1),
    'not in the future', 'a future date is refused');
  perform pg_temp.refused($q$select public.record_expense_reimbursement(array[gen_random_uuid()], current_date, 'R1', 1)$q$,
    'no longer exist', 'an unknown expense is refused');
  reset role;

  perform pg_temp.ok((select count(*) from public.expense_reimbursements) = 0
    and (select count(*) from public.expense_reimbursement_items) = 0
    and (select count(*) from public.expenses where reimbursement_id is not null) = 0,
    'none of the refused selections wrote a batch, an item or a link');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. ONE BATCH OVER SEVERAL EXPENSES, ATOMICALLY; NO DUPLICATE
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  p1 uuid := (select id from public.test_ids where k = 'p1');
  p2 uuid := (select id from public.test_ids where k = 'p2');
  v jsonb;
  v_batch public.expense_reimbursements;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  v := public.record_expense_reimbursement(array[p1, p2], current_date, '  CHALLAN-17  ', 200.00, 'September petty cash');
  insert into public.test_ids values ('batch1', (v->>'reimbursement_id')::uuid);
  perform pg_temp.ok((v->>'expense_count')::int = 2 and (v->>'total_amount')::numeric = 200.00,
    'Finance records one reimbursement over two expenses (₹120.50 + ₹79.50 = ₹200.00)');

  select * into v_batch from public.expense_reimbursements where id = (v->>'reimbursement_id')::uuid;
  perform pg_temp.ok(v_batch.reference = 'CHALLAN-17' and v_batch.recorded_by = auth.uid()
    and v_batch.status = 'recorded' and v_batch.note = 'September petty cash',
    'the batch holds the trimmed reference once, the note, and who recorded it');
  perform pg_temp.ok((select count(*) from public.expenses where reimbursement_id = v_batch.id) = 2,
    'both expenses point at the batch');
  perform pg_temp.ok((select count(*) from public.expense_reimbursement_items
                      where reimbursement_id = v_batch.id and reversed_at is null) = 2,
    'and the batch lists exactly those two, with their amounts');

  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(array[%L]::uuid[], current_date, 'R2', 120.50)$q$, p1),
    'already reimbursed', 'an expense cannot be reimbursed twice');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. A REIMBURSED EXPENSE IS FROZEN WHERE IT MATTERS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare p1 uuid := (select id from public.test_ids where k = 'p1');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform pg_temp.refused(format($q$update public.expenses set amount = 1, updated_by = auth.uid() where id = %L$q$, p1),
    'has been reimbursed', 'its amount cannot change');
  perform pg_temp.refused(format($q$update public.expenses set paid_from = 'company', paid_by = null, updated_by = auth.uid() where id = %L$q$, p1),
    'has been reimbursed', 'it cannot become company-paid');
  perform pg_temp.refused(format($q$update public.expenses set deleted_by = auth.uid(), updated_by = auth.uid() where id = %L$q$, p1),
    'cannot be deleted', 'it cannot be deleted');
  update public.expenses set remark = 'corrected remark', updated_by = auth.uid() where id = p1;
  perform pg_temp.ok(found, 'its remark can still be corrected');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. WHO SEES A REIMBURSEMENT
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare b uuid := (select id from public.test_ids where k = 'batch1');
begin
  -- THE AUTHOR SEES THEIR OWN EXPENSE'S REIMBURSEMENT, NOT THE BATCH. Asked of
  -- the table and of an embed, the batch row (total, count, note) is invisible;
  -- the receipts function answers per expense, with that expense's own amount.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform pg_temp.ok((select count(*) from public.expense_reimbursements) = 0,
    'the author of reimbursed expenses cannot read the batch row (its total, count or note)');
  perform pg_temp.ok((select count(*) from public.expenses e
                       join public.expense_reimbursements r on r.id = e.reimbursement_id) = 0,
    'nor reach it by joining from their own expense');
  perform pg_temp.ok((select count(*) = 1 and min(amount) = 120.50 and min(reference) = 'CHALLAN-17'
                      from public.expense_reimbursement_receipts(array[(select id from public.test_ids where k = 'p1')])),
    'the receipt gives their expense''s date, reference and its OWN amount (₹120.50, not the ₹200 batch)');
  reset role;

  -- Somebody else asking for the same expense's receipt gets nothing.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  perform pg_temp.ok((select count(*) from public.expense_reimbursement_receipts(
      array[(select id from public.test_ids where k = 'p1'), (select id from public.test_ids where k = 'p2')])) = 0,
    'a colleague asking for another person''s receipts gets none');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform pg_temp.ok((select total_amount = 200.00 and expense_count = 2
                        and payer_id = '11111111-1111-1111-1111-111111111111'
                      from public.expense_reimbursements where id = b),
    'Finance sees the complete batch: total, count and the one payer');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  perform pg_temp.ok((select count(*) from public.expense_reimbursements) = 0
    and (select count(*) from public.expense_reimbursement_items) = 0,
    'a colleague inside Finance, without company-wide sight, sees none of it');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  perform pg_temp.ok((select count(*) from public.expense_reimbursements) = 0, 'somebody outside Finance sees nothing');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  perform pg_temp.ok((select count(*) from public.expense_reimbursements where id = b) = 1, 'an admin sees it');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. CORRECTION IS REVERSAL, AND THE HISTORY STAYS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  b uuid := (select id from public.test_ids where k = 'batch1');
  p1 uuid := (select id from public.test_ids where k = 'p1');
  p2 uuid := (select id from public.test_ids where k = 'p2');
  v jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform pg_temp.refused(format($q$select public.reverse_expense_reimbursement(%L, 'mine')$q$, b),
    'EXPENSE_REIMBURSEMENT_FORBIDDEN', 'the author cannot reverse a reimbursement');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform pg_temp.refused(format($q$select public.reverse_expense_reimbursement(%L, '  ')$q$, b),
    'say why', 'a reversal needs a reason');
  v := public.reverse_expense_reimbursement(b, 'Wrong challan number');
  perform pg_temp.ok((v->>'expenses_returned_to_pending')::int = 2, 'Finance reverses it; two expenses return to pending');
  perform pg_temp.ok((select status = 'reversed' and reversed_by = auth.uid() and reversal_reason = 'Wrong challan number'
                        and reference = 'CHALLAN-17' and reversed_at is not null
                      from public.expense_reimbursements where id = b),
    'the reversed batch keeps its reference and names who reversed it and why');
  perform pg_temp.ok((select count(*) from public.expense_reimbursement_items where reimbursement_id = b and reversed_at is not null) = 2,
    'its items are kept, marked reversed');
  perform pg_temp.ok((select count(*) from public.expenses where id in (p1, p2) and reimbursement_id is null) = 2,
    'the expenses are pending again');
  perform pg_temp.refused(format($q$select public.reverse_expense_reimbursement(%L, 'again')$q$, b),
    'already reversed', 'a reimbursement cannot be reversed twice');

  v := public.record_expense_reimbursement(array[p1, p2], current_date, 'CHALLAN-18', 200.00);
  insert into public.test_ids values ('batch2', (v->>'reimbursement_id')::uuid);
  perform pg_temp.ok(true, 'the same expenses can be reimbursed again in a new batch after a reversal');
  perform pg_temp.ok((select count(*) from public.expense_reimbursement_items where expense_id = p1) = 2,
    'and p1''s history now shows both batches');
  reset role;
end $$;

-- The history is immutable even for the table owner / service role.
do $$
declare b uuid := (select id from public.test_ids where k = 'batch2');
begin
  perform pg_temp.refused(format($q$update public.expense_reimbursements set reference = 'EDITED' where id = %L$q$, b),
    'can only be reversed', 'the reference of a recorded batch cannot be rewritten, even by the owner');
  perform pg_temp.refused(format($q$delete from public.expense_reimbursements where id = %L$q$, b),
    'cannot be deleted', 'a batch cannot be deleted, even by the owner');
  perform pg_temp.refused(format($q$delete from public.expense_reimbursement_items where reimbursement_id = %L$q$, b),
    'cannot be deleted', 'batch items cannot be deleted, even by the owner');
  perform pg_temp.refused(format($q$update public.expenses set reimbursement_id = null where reimbursement_id = %L$q$, b),
    'only through Finance', 'the owner cannot unlink an expense outside the RPC');
  -- Even past the trigger, the table refuses a reimbursed expense that is not
  -- personal — including one whose source is NULL (the NULL-safe CHECK).
  perform set_config('boe.expense_reimbursement_write', 'on', true);
  perform pg_temp.refused(format($q$update public.expenses set reimbursement_id = %L where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$q$, b),
    'expenses_reimbursed_is_personal', 'an expense with no recorded source cannot carry a reimbursement');
  perform pg_temp.refused(format($q$update public.expenses set reimbursement_id = %L where id = %L$q$, b,
      (select id from public.test_ids where k = 'company')),
    'expenses_reimbursed_is_personal', 'a company-paid expense cannot carry a reimbursement');
  perform set_config('boe.expense_reimbursement_write', 'off', true);
  perform pg_temp.ok(not exists (select 1 from information_schema.role_table_grants
                                 where table_name in ('expense_reimbursements', 'expense_reimbursement_items', 'expense_bill_attachments')
                                   and grantee = 'authenticated' and privilege_type in ('INSERT', 'DELETE')
                                   and table_name <> 'expense_bill_attachments')
                     and not exists (select 1 from information_schema.role_table_grants
                                     where table_name = 'expense_bill_attachments' and grantee = 'authenticated'
                                       and privilege_type = 'DELETE'),
    'clients hold no INSERT on the batch tables and no DELETE on any new table');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. BILLS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  p3 uuid := (select id from public.test_ids where k = 'p3');
  p1 uuid := (select id from public.test_ids where k = 'p1');
  v_path text;
  v_bill uuid;
begin
  perform pg_temp.ok((select not public from storage.buckets where id = 'expense-bills'), 'the bucket is private');

  -- The author uploads a bill later, to an existing pending expense.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  v_path := p3 || '/' || gen_random_uuid() || '.pdf';
  insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', v_path, auth.uid()::text);
  insert into public.expense_bill_attachments (expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (p3, v_path, 'repair-bill.pdf', 'application/pdf', 2048, auth.uid()) returning id into v_bill;
  insert into public.test_ids values ('bill', v_bill);
  perform pg_temp.ok(true, 'the author attaches a bill to an existing expense');

  perform pg_temp.refused(format(
    $q$insert into public.expense_bill_attachments (expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
       values (%L, %L, 'ghost.pdf', 'application/pdf', 10, auth.uid())$q$, p3, p3 || '/' || gen_random_uuid() || '.pdf'),
    'row-level security', 'a bill row cannot name a file that was never uploaded');
  perform pg_temp.refused(format(
    $q$insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', %L, auth.uid()::text)$q$, 'not-a-key.pdf'),
    'row-level security', 'a malformed key is refused by the storage rule');
  reset role;

  -- A colleague inside Finance cannot upload to, or read, somebody else's expense.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  perform pg_temp.refused(format(
    $q$insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', %L, auth.uid()::text)$q$,
    p3 || '/' || gen_random_uuid() || '.pdf'),
    'row-level security', 'a colleague cannot upload to somebody else''s expense');
  perform pg_temp.ok((select count(*) from storage.objects where bucket_id = 'expense-bills') = 0,
    'a colleague cannot read the author''s bill file');
  perform pg_temp.ok((select count(*) from public.expense_bill_attachments) = 0,
    'nor see that it exists');
  reset role;

  -- Finance (view_all) reads it; so does the author.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform pg_temp.ok((select count(*) from storage.objects where name = v_path) = 1,
    'Finance with company-wide sight can open the bill file');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  perform pg_temp.ok((select count(*) from storage.objects where name = v_path) = 0,
    'somebody outside Finance cannot open it');
  reset role;

  -- A recorded bill's file cannot be deleted by a client; an orphan upload can,
  -- by its uploader (the compensation path).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  delete from storage.objects where name = v_path;
  perform pg_temp.ok(not found, 'the author cannot delete a recorded bill''s file');
  insert into storage.objects (bucket_id, name, owner_id)
  values ('expense-bills', p3 || '/00000000-0000-0000-0000-000000000001.png', auth.uid()::text);
  delete from storage.objects where name = p3 || '/00000000-0000-0000-0000-000000000001.png';
  perform pg_temp.ok(found, 'the uploader can remove their own upload that no bill row names');

  -- Removing a bill keeps its row.
  update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where id = v_bill;
  perform pg_temp.ok((select removed_at is not null and removed_by = auth.uid() from public.expense_bill_attachments where id = v_bill),
    'a bill is removed by tombstone, naming who removed it');
  perform pg_temp.refused(format($q$update public.expense_bill_attachments set file_name = 'x' where id = %L$q$, v_bill),
    'permission denied', 'a bill''s details cannot be rewritten');

  -- A reimbursed expense's bills cannot be removed.
  v_path := p1 || '/' || gen_random_uuid() || '.jpg';
  insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', v_path, auth.uid()::text);
  insert into public.expense_bill_attachments (expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (p1, v_path, 'diesel.jpg', 'image/jpeg', 1024, auth.uid()) returning id into v_bill;
  perform pg_temp.ok(true, 'a bill can still be added to a reimbursed expense');
  perform pg_temp.refused(format($q$update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where id = %L$q$, v_bill),
    'reimbursed expense cannot be removed', 'but not removed from it');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. COMPLETING A CAPTURE RECORDS THE SOURCE; THE OLD CALL STILL WORKS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_cat uuid := (select id from public.expense_categories limit 1);
  v_draft uuid;
  v jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  insert into public.expense_drafts (raw_text, created_by) values ('auto 80 cash', auth.uid()) returning id into v_draft;
  v := public.finalize_expense_draft(v_draft, current_date, 80, 'cash', 'Auto', v_cat, null, 'personal', null);
  perform pg_temp.ok((select paid_from = 'personal' and paid_by = auth.uid() from public.expenses where id = (v->>'expense_id')::uuid),
    'a completed capture records personal payment, defaulting the payer to the caller');

  insert into public.expense_drafts (raw_text, created_by) values ('courier 40', auth.uid()) returning id into v_draft;
  v := public.finalize_expense_draft(v_draft, current_date, 40, 'cash', 'Courier', v_cat, null);
  perform pg_temp.ok((select paid_from is null and paid_by is null from public.expenses where id = (v->>'expense_id')::uuid),
    'the old 7-argument call still completes a capture, leaving the source unrecorded');
  reset role;

  perform pg_temp.ok(not has_function_privilege('anon',
    'public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text, text, uuid)', 'execute'),
    'anon cannot execute the extended finalize_expense_draft');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. A LEGACY EXPENSE MAY BE CLASSIFIED, BUT NEVER UN-CLASSIFIED
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare o uuid := (select id from public.test_ids where k = 'oldclient');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  update public.expenses set remark = 'still unknown', updated_by = auth.uid() where id = o;
  perform pg_temp.ok((select paid_from is null from public.expenses where id = o),
    'correcting an unknown expense without choosing leaves it unknown');
  update public.expenses set paid_from = 'company', updated_by = auth.uid() where id = o;
  perform pg_temp.ok(found, 'its author may record the source later');
  perform pg_temp.refused(format($q$update public.expenses set paid_from = null, updated_by = auth.uid() where id = %L$q$, o),
    'cannot go back to not recorded', 'but not forget it again');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. ONE PAYER PER REIMBURSEMENT
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_cat uuid := (select id from public.expense_categories limit 1);
  p3 uuid := (select id from public.test_ids where k = 'p3');
  col uuid := (select id from public.test_ids where k = 'colleague');
  v_ids uuid[] := '{}';
  v_id uuid;
  v jsonb;
  i int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  -- p3 was paid by the Creator (₹300), col by the Colleague (₹60).
  perform pg_temp.refused(format($q$select public.record_expense_reimbursement(array[%L, %L]::uuid[], current_date, 'MIX', 360.00)$q$, p3, col),
    'EXPENSE_REIMBURSEMENT_MIXED_PAYERS', 'a selection spanning two payers is refused');
  perform pg_temp.ok((select count(*) from public.expense_reimbursements where reference = 'MIX') = 0
    and (select reimbursement_id is null from public.expenses where id = p3)
    and (select reimbursement_id is null from public.expenses where id = col),
    'and nothing of it was written');

  -- FIFTEEN expenses for ONE payer, recorded by Finance on the Colleague's behalf,
  -- reimbursed as one batch with one reference.
  for i in 1..15 loop
    insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
    values (current_date - i, 100 + i + 0.25, 'cash', 'Batch vendor ' || i, v_cat, auth.uid(), 'personal',
            '55555555-5555-5555-5555-555555555555')
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  -- Sum of (100 + i + 0.25) for i = 1..15 = 1500 + 120 + 3.75 = 1623.75
  v := public.record_expense_reimbursement(v_ids || col, current_date, 'UTR-15-ONE-PAYER', 1683.75);
  perform pg_temp.ok((v->>'expense_count')::int = 16 and (v->>'total_amount')::numeric = 1683.75,
    'sixteen expenses of ONE payer (15 + the earlier ₹60) are reimbursed as one batch, ₹1,683.75');
  perform pg_temp.ok((select payer_id = '55555555-5555-5555-5555-555555555555' from public.expense_reimbursements
                      where id = (v->>'reimbursement_id')::uuid),
    'the batch names its one payer');
  insert into public.test_ids values ('batch15', (v->>'reimbursement_id')::uuid);
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. THE PAYER SEES WHAT WAS RECORDED ON THEIR BEHALF; NOBODY ELSE NEW DOES
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  col uuid := (select id from public.test_ids where k = 'colleague');
  v_path text;
  v_payer_path text;
begin
  -- Finance attaches the bill to the expense it recorded for the Colleague.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  v_path := col || '/' || gen_random_uuid() || '.pdf';
  insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', v_path, auth.uid()::text);
  insert into public.expense_bill_attachments (expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (col, v_path, 'tea-bill.pdf', 'application/pdf', 900, auth.uid());
  insert into public.test_ids values ('colbill', (select id from public.expense_bill_attachments where storage_path = v_path));
  reset role;

  -- THE PAYER: reads the expense, its reimbursement receipt and its bill.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  perform pg_temp.ok((select count(*) from public.expenses where id = col) = 1,
    'the payer sees an expense Finance recorded on their behalf');
  perform pg_temp.ok((select count(*) from public.expenses where paid_by = auth.uid()) = 16,
    'and all sixteen expenses they paid');
  perform pg_temp.ok((select count(*) = 1 and min(amount) = 60.00 and min(reference) = 'UTR-15-ONE-PAYER'
                      from public.expense_reimbursement_receipts(array[col])),
    'with its reimbursement date, reference and amount');
  perform pg_temp.ok((select count(*) from public.expense_reimbursements) = 0,
    'but not the batch row itself');
  perform pg_temp.ok((select count(*) from storage.objects where name = v_path) = 1
    and (select count(*) from public.expense_bill_attachments where storage_path = v_path) = 1,
    'and can open its bill');
  -- READ ONLY.
  update public.expenses set remark = 'payer edit', updated_by = auth.uid() where id = col;
  perform pg_temp.ok(not found, 'the payer cannot correct it');
  update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where storage_path = v_path;
  perform pg_temp.ok(not found, 'nor remove its bill');

  -- THE PAYER MAY ADD THE MISSING BILL — they are the one holding it.
  v_payer_path := col || '/' || gen_random_uuid() || '.jpg';
  insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', v_payer_path, auth.uid()::text);
  insert into public.expense_bill_attachments (expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (col, v_payer_path, 'payer-receipt.jpg', 'image/jpeg', 512, auth.uid());
  perform pg_temp.ok((select count(*) from public.expense_bill_attachments where expense_id = col and removed_at is null) = 2,
    'the payer adds a bill to the expense Finance entered for them');
  -- This expense is already reimbursed (it is in the 16-expense batch of §12),
  -- so not even the payer's own upload can be removed now.
  perform pg_temp.refused(format(
    $q$update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where storage_path = %L$q$, v_payer_path),
    'reimbursed expense cannot be removed', 'after reimbursement the payer cannot remove even their own upload');
  perform pg_temp.refused(format(
    $q$insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', %L, auth.uid()::text)$q$,
    (select id from public.test_ids where k = 'p3') || '/' || gen_random_uuid() || '.pdf'),
    'row-level security', 'nor add a bill to an expense they did not pay');
  reset role;

  -- AN UNRELATED EMPLOYEE (inside Finance, not the author, not the payer).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform pg_temp.ok((select count(*) from public.expenses where id = col) = 0,
    'an unrelated employee still cannot see it');
  perform pg_temp.ok((select count(*) from storage.objects where name in (v_path, v_payer_path)) = 0
    and (select count(*) from public.expense_bill_attachments where expense_id = col) = 0,
    'nor download or discover either of its bills');
  perform pg_temp.refused(format(
    $q$insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', %L, auth.uid()::text)$q$,
    col || '/' || gen_random_uuid() || '.pdf'),
    'row-level security', 'nor upload a bill to it');
  perform pg_temp.ok((select count(*) from public.expense_reimbursement_receipts(array[col])) = 0,
    'nor read its reimbursement');
  reset role;

  -- Somebody outside Finance, even as the named payer, would see nothing: the
  -- restrictive module gate still applies (checked for 333, who has no entry).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  perform pg_temp.ok((select count(*) from public.expenses) = 0, 'no Finance entry, no expenses at all');
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. THE PAYER REMOVES ONLY THEIR OWN UPLOAD, ONLY BEFORE REIMBURSEMENT
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_cat uuid := (select id from public.expense_categories limit 1);
  v_exp uuid;
  v_fin_path text;
  v_own_path text;
  v_late_path text;
begin
  -- Finance enters a pending personal expense for the Colleague and attaches a bill.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
  values (current_date, 75.00, 'cash', 'Stationery', v_cat, auth.uid(), 'personal', '55555555-5555-5555-5555-555555555555')
  returning id into v_exp;
  v_fin_path := v_exp || '/' || gen_random_uuid() || '.pdf';
  insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', v_fin_path, auth.uid()::text);
  insert into public.expense_bill_attachments (expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (v_exp, v_fin_path, 'finance-copy.pdf', 'application/pdf', 100, auth.uid());
  reset role;

  -- The payer uploads their own bill, then removes it: allowed while pending.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  v_own_path := v_exp || '/' || gen_random_uuid() || '.jpg';
  insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', v_own_path, auth.uid()::text);
  insert into public.expense_bill_attachments (expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (v_exp, v_own_path, 'wrong-photo.jpg', 'image/jpeg', 100, auth.uid());
  update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where storage_path = v_own_path;
  perform pg_temp.ok(found, 'the payer removes a bill they uploaded, while the expense is pending');
  perform pg_temp.ok((select removed_by = auth.uid() and removed_at is not null and file_name = 'wrong-photo.jpg'
                      from public.expense_bill_attachments where storage_path = v_own_path)
    and (select count(*) from storage.objects where name = v_own_path) = 1,
    'the removal is kept as history: the row names who removed it, and the file stays');

  -- …but not Finance's bill on the same expense.
  update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where storage_path = v_fin_path;
  perform pg_temp.ok(not found, 'the payer cannot remove a bill somebody else uploaded');
  perform pg_temp.ok((select removed_at is null from public.expense_bill_attachments where storage_path = v_fin_path),
    'and it is still live');

  -- A third bill, uploaded before reimbursement, to try removing after it.
  v_late_path := v_exp || '/' || gen_random_uuid() || '.png';
  insert into storage.objects (bucket_id, name, owner_id) values ('expense-bills', v_late_path, auth.uid()::text);
  insert into public.expense_bill_attachments (expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (v_exp, v_late_path, 'receipt.png', 'image/png', 100, auth.uid());
  reset role;

  -- An unrelated employee cannot remove the payer's bill (or see it).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where storage_path = v_late_path;
  perform pg_temp.ok(not found, 'an unrelated employee cannot remove the payer''s bill');
  reset role;

  -- Finance reimburses the expense.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform public.record_expense_reimbursement(array[v_exp], current_date, 'UTR-STATIONERY', 75.00);
  reset role;

  -- After reimbursement nobody removes any bill: not the payer's own, not Finance's.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  perform pg_temp.refused(format(
    $q$update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where storage_path = %L$q$, v_late_path),
    'reimbursed expense cannot be removed', 'after reimbursement the payer cannot remove their own upload');
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform pg_temp.refused(format(
    $q$update public.expense_bill_attachments set removed_by = auth.uid(), removed_at = now() where storage_path = %L$q$, v_fin_path),
    'reimbursed expense cannot be removed', 'nor can Finance remove any bill after reimbursement');
  reset role;
end $$;

\echo '== all reimbursement assertions passed'
