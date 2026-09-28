-- ── 20270211120000, PROVEN ──────────────────────────────────────────────────
--
-- Run by run_expense_reimbursement_source_required_suite.sh. Client checks run
-- as `authenticated` with a jwt sub, so RLS and the triggers are in force; the
-- owner checks prove the rule also binds a caller RLS does not reach.

\set ON_ERROR_STOP on

insert into public.users (id, full_name, role) values
  ('11111111-1111-1111-1111-111111111111', 'Creator', 'employee'),
  ('22222222-2222-2222-2222-222222222222', 'Finance', 'employee')
on conflict (id) do nothing;
insert into public.test_module_entry (user_id, module_key) values
  ('11111111-1111-1111-1111-111111111111', 'finance'),
  ('22222222-2222-2222-2222-222222222222', 'finance'),
  ('77777777-7777-7777-7777-777777777777', 'finance')
on conflict do nothing;
insert into public.test_permissions (user_id, module_key, action_key) values
  ('11111111-1111-1111-1111-111111111111', 'finance', 'create'),
  ('22222222-2222-2222-2222-222222222222', 'finance', 'create'),
  ('22222222-2222-2222-2222-222222222222', 'finance', 'manage'),
  ('22222222-2222-2222-2222-222222222222', 'finance', 'view_all'),
  ('77777777-7777-7777-7777-777777777777', 'finance', 'create')
on conflict do nothing;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok: %', p_what;
end $$;

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

-- ═══ 1. The legacy expense is untouched, and still correctable ═════════════

do $$
begin
  perform pg_temp.ok((select paid_from is null and paid_by is null
                      from public.expenses where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    'the legacy expense is still "not recorded" after the migration');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
  update public.expenses set remark = 'corrected later', updated_by = auth.uid()
   where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  perform pg_temp.ok(found, 'its author can still correct it without choosing a source');
  perform pg_temp.ok((select paid_from is null from public.expenses where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    'and it stays "not recorded"');
  perform pg_temp.refused(
    $q$update public.expenses set paid_from = 'company', updated_by = auth.uid() where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
       update public.expenses set paid_from = null, updated_by = auth.uid() where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$q$,
    'cannot go back to not recorded', 'once recorded, a source still cannot be cleared');
  reset role;
end $$;

-- ═══ 1b. Older expenses: viewed and saved exactly as the app does it ═══════
--
-- The Edit form on an older expense whose source the person leaves unchosen
-- sends the WHOLE payload, including paid_from: null and paid_by: null
-- (expenseWritePayload). That UPDATE must save. So must Finance's correction of
-- somebody else's older expense, recording its source later, and deleting one.

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
  perform pg_temp.ok((select count(*) from public.expenses
                       where id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                                    'cccccccc-cccc-cccc-cccc-cccccccccccc') and paid_from is null) = 3,
    'the author still sees all three older "not recorded" expenses');

  -- The form's exact correction payload, source left unchosen.
  update public.expenses
     set expense_date = '2026-09-21', amount = '260.00', payment_mode = 'upi', paid_to = 'Legacy two (fixed)',
         category_id = '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', remark = null,
         paid_from = null, paid_by = null, updated_by = auth.uid()
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and deleted_at is null;
  perform pg_temp.ok(found, 'the Edit form''s full payload (paid_from null, paid_by null) saves on an older expense');
  perform pg_temp.ok((select amount = 260.00 and paid_to = 'Legacy two (fixed)' and paid_from is null
                      from public.expenses where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
    'with the correction stored and the source still "not recorded"');

  -- Recording the source later, through the same form.
  update public.expenses set paid_from = 'personal', paid_by = auth.uid(), updated_by = auth.uid()
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  perform pg_temp.ok(found, 'its author can record the source later');

  -- Deleting an older expense (soft delete) still works.
  update public.expenses set deleted_by = auth.uid(), updated_by = auth.uid()
   where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and deleted_at is null;
  perform pg_temp.ok(found, 'an older expense can still be deleted');
  reset role;

  -- Finance (finance.manage + view_all) corrects somebody else's older expense.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform pg_temp.ok((select count(*) from public.expenses where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 1,
    'Finance still sees an older expense');
  update public.expenses set remark = 'checked by Finance', paid_from = null, paid_by = null, updated_by = auth.uid()
   where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  perform pg_temp.ok(found, 'Finance can correct somebody else''s older expense without choosing a source');
  reset role;
end $$;

-- ═══ 2. A new expense must say how it was paid ═════════════════════════════

do $$
declare v_cat uuid := '8a0b094a-ddfd-4f97-a204-ac96c983e5b1';
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  perform pg_temp.refused(format(
    $q$insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by)
       values (current_date, 10, 'cash', 'No source', %L, auth.uid())$q$, v_cat),
    'EXPENSE_PAYMENT_SOURCE_REQUIRED', 'a client insert with no payment source is refused');
  perform pg_temp.refused(format(
    $q$insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from)
       values (current_date, 10, 'cash', 'Null source', %L, auth.uid(), null)$q$, v_cat),
    'EXPENSE_PAYMENT_SOURCE_REQUIRED', 'an explicit NULL source is refused too');

  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from)
  values (current_date, 20, 'upi', 'Company vendor', v_cat, auth.uid(), 'company');
  perform pg_temp.ok(found, 'a company-paid expense is recorded');
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by, paid_from, paid_by)
  values (current_date, 30, 'cash', 'Personal', v_cat, auth.uid(), 'personal', auth.uid());
  perform pg_temp.ok(found, 'a personally-paid expense is recorded');
  reset role;

  -- The OWNER (no RLS) is bound by it too: it is a trigger, not a policy.
  perform pg_temp.refused(format(
    $q$insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by)
       values (current_date, 10, 'cash', 'Script', %L, '11111111-1111-1111-1111-111111111111')$q$, v_cat),
    'EXPENSE_PAYMENT_SOURCE_REQUIRED', 'the table owner / service role cannot insert one without a source either');
end $$;

-- ═══ 3. Completing a capture needs a source too, and a refusal changes nothing

do $$
declare
  v_cat uuid := '8a0b094a-ddfd-4f97-a204-ac96c983e5b1';
  v_draft uuid;
  v jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  insert into public.expense_drafts (raw_text, created_by) values ('auto 80 cash', auth.uid()) returning id into v_draft;

  perform pg_temp.refused(format(
    $q$select public.finalize_expense_draft(%L, current_date, 80, 'cash', 'Auto', %L, null)$q$, v_draft, v_cat),
    'EXPENSE_PAYMENT_SOURCE_REQUIRED', 'the old 7-argument finalize call (no source) is refused');
  perform pg_temp.ok((select status = 'pending' and expense_id is null from public.expense_drafts where id = v_draft),
    'and the capture is still pending, with no expense created');

  v := public.finalize_expense_draft(v_draft, current_date, 80, 'cash', 'Auto', v_cat, null, 'personal', null);
  perform pg_temp.ok((select paid_from = 'personal' and paid_by = auth.uid()
                      from public.expenses where id = (v->>'expense_id')::uuid),
    'completing it with a source records the expense');
  reset role;
end $$;

\echo '== all source-required assertions passed'
