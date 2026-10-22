-- Finance: a separate permission to reimburse expenses.
--
-- WHY
--   Recording a reimbursement (a challan paying staff back for expenses they paid
--   personally) required finance.manage AND finance.view_all (20270205120000).
--   finance.manage also lets its holder rewrite and delete anybody's expense, so
--   the person who pays could not be given "see every expense, record the
--   payment, but never edit or delete one" - the two came together.
--
-- WHAT THIS DOES
--   1. Registers finance.reimburse (protected in the app; deny-by-default here:
--      default_allowed = false, so nobody holds it until Control Center grants it
--      to a named person; admins hold it through the admin branch).
--   2. Re-emits can_record_expense_reimbursement() so it asks for
--      finance.reimburse + finance.view_all instead of finance.manage +
--      finance.view_all. record_expense_reimbursement() and
--      reverse_expense_reimbursement() both call it and are NOT changed.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does not grant anything to anybody. Anyone who recorded reimbursements
--     through finance.manage must be granted finance.reimburse to keep doing so.
--   * It does not touch the expenses policies: finance.manage still alone
--     corrects or deletes other people's expenses, so a reimburser who lacks it
--     can read every expense and cannot change one.
--   * It does not change who can read the reimbursement batches (view_all, or the
--     person who recorded one) - a reimburser always holds view_all.
--
-- ROLLBACK
--   Re-run the body of can_record_expense_reimbursement() from 20270205120000
--   (finance.manage + finance.view_all). The permission rows may stay.

do $dep$
begin
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: public.actor_has_module_permission(text, text)';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: public.module_entry_open(text)';
  end if;
  if to_regprocedure('public.can_record_expense_reimbursement()') is null then
    raise exception 'DEPENDENCY MISSING: public.can_record_expense_reimbursement() (20270205120000)';
  end if;
end $dep$;


-- ═══ §1. finance.reimburse ══════════════════════════════════════════════════

insert into public.permission_actions (action_key, display_name, is_system)
values ('reimburse', 'Reimburse Expenses', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'reimburse'
where pm.module_key = 'finance'
on conflict (module_id, action_id) do nothing;


-- ═══ §2. The door ═══════════════════════════════════════════════════════════

create or replace function public.can_record_expense_reimbursement()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid() is not null
     and public.module_entry_open('finance')
     and public.actor_has_module_permission('finance', 'reimburse')
     and public.actor_has_module_permission('finance', 'view_all');
$fn$;
revoke all on function public.can_record_expense_reimbursement() from public, anon;
grant execute on function public.can_record_expense_reimbursement() to authenticated;

comment on function public.can_record_expense_reimbursement() is
  'May record or reverse an expense reimbursement: finance.reimburse AND company-wide Finance sight (view_all). Replaced finance.manage in 20270403000000 so the payer can reimburse without being able to edit or delete anybody''s expense.';


-- ═══ §3. Self-assertion (runs on apply) ═════════════════════════════════════

do $assert$
declare
  v_body text := pg_get_functiondef('public.can_record_expense_reimbursement()'::regprocedure);
begin
  if v_body not like '%''reimburse''%' or v_body not like '%''view_all''%' then
    raise exception 'ASSERT: can_record_expense_reimbursement() must ask for reimburse and view_all';
  end if;
  if v_body like '%''manage''%' then
    raise exception 'ASSERT: can_record_expense_reimbursement() must no longer ask for manage';
  end if;
  if not exists (
    select 1
      from public.module_permission_actions mpa
      join public.permission_actions pa on pa.id = mpa.action_id
      join public.permission_modules pm on pm.id = mpa.module_id
     where pm.module_key = 'finance' and pa.action_key = 'reimburse' and mpa.default_allowed = false
  ) then
    raise exception 'ASSERT: finance.reimburse must be registered and deny-by-default';
  end if;
  if has_function_privilege('anon', 'public.can_record_expense_reimbursement()', 'execute') then
    raise exception 'ASSERT: anon must not execute can_record_expense_reimbursement()';
  end if;
end $assert$;
