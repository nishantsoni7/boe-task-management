-- ── 20270127000000 — PRODUCTION ROLE CHECK, READ ONLY ───────────────────────
--
-- Run AFTER the migration is applied and BEFORE the merge, ONCE PER PERSON
-- (`db query` returns only the last result set):
--
--   npx supabase db query --linked -f <a copy of this file with the id filled in>
--
-- SELECT only, inside a read-only transaction that is rolled back; it writes
-- nothing. It evaluates the rules AS that person, under their JWT claims.
--
-- 1. Get the ids (also read-only):
--      begin transaction read only;
--      select id, full_name from public.users
--       where full_name in ('Nitish Bansal', 'Prerna') and is_active;
--      rollback;
-- 2. Replace <PERSON_ID> below with one id, literally. A lookup inside this file
--    would run under the person's RLS and could hide the row and fake a result.
--
-- Expected (2026-09-27 grants):
--   Nitish Bansal (finance.manage + view_all)  may_record true
--   Prerna (sales: finance view + create)      may_record false, batches_visible 0

begin transaction read only;

select set_config('request.jwt.claims',
                  json_build_object('sub', '<PERSON_ID>', 'role', 'authenticated')::text, true);
set local role authenticated;

select json_build_object(
  'read_only', current_setting('transaction_read_only'),
  'uid', auth.uid(),
  'may_record', public.can_record_expense_reimbursement(),
  'batches_visible', (select count(*) from public.expense_reimbursements),
  'expenses_visible', (select count(*) from public.expenses)
);

rollback;
