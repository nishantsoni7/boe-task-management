-- ── 20270205120000 — PRODUCTION CHECK, READ ONLY ────────────────────────────
--
-- Run AFTER the migration is applied to production and BEFORE the PR is merged
-- (a merge to main deploys the app automatically):
--
--   npx supabase db query --linked -f supabase/tests/expense_reimbursement_production_check.sql
--
-- SELECT only, inside a read-only transaction; it writes nothing. Every value in
-- the JSON must read true, and `expenses_fingerprint` / counts must equal the
-- values captured before the migration was applied.

begin transaction read only;

select json_build_object(
  'read_only', current_setting('transaction_read_only') = 'on',

  'migration_recorded', exists (select 1 from supabase_migrations.schema_migrations
                                 where version = '20270205120000'),

  -- Existing expenses: same rows, same values (the columns that existed before),
  -- and none classified by the migration.
  'expenses', (select count(*) from public.expenses),
  'live_expenses', (select count(*) from public.expenses where deleted_at is null),
  'live_total', (select sum(amount) from public.expenses where deleted_at is null),
  'expenses_fingerprint', (select md5(string_agg(concat_ws('|', id, expense_date, amount, payment_mode, paid_to,
                               category_id, remark, created_by, updated_by, deleted_at, deleted_by), ',' order by id))
                            from public.expenses),
  -- True between apply and deploy: the app in production never sets these.
  'no_existing_expense_classified', (select count(*) from public.expenses
                                      where paid_from is not null or paid_by is not null
                                         or reimbursement_id is not null) = 0,

  'new_columns_nullable', (select count(*) = 3 from information_schema.columns
                            where table_schema = 'public' and table_name = 'expenses'
                              and column_name in ('paid_from', 'paid_by', 'reimbursement_id')
                              and is_nullable = 'YES'),
  'constraints_validated', (select count(*) = 5 from pg_constraint
                             where conrelid = 'public.expenses'::regclass and convalidated
                               and conname in ('expenses_paid_by_fk', 'expenses_reimbursement_fk',
                                               'expenses_paid_from_known', 'expenses_paid_by_matches_source',
                                               'expenses_reimbursed_is_personal')),
  'guard_triggers', (select count(*) = 4 from pg_trigger where not tgisinternal and tgname in
                      ('expenses_guard_reimbursement', 'expense_reimbursements_guard',
                       'expense_reimbursement_items_guard', 'expense_bill_attachments_guard')),

  -- Visibility: the payer may read, the batch is Finance's, nothing for anon.
  'payer_policy_select_only', (select cmd = 'SELECT' from pg_policies
                                where schemaname = 'public' and tablename = 'expenses'
                                  and policyname = 'expenses_paid_by_select'),
  'expense_update_policies_unchanged', (select count(*) = 2 from pg_policies
                                          where schemaname = 'public' and tablename = 'expenses'
                                            and cmd = 'UPDATE' and permissive = 'PERMISSIVE'),
  'batch_select_finance_only', (select count(*) = 1 from pg_policies
                                 where schemaname = 'public' and tablename = 'expense_reimbursements'
                                   and cmd = 'SELECT' and permissive = 'PERMISSIVE'
                                   and qual not like '%created_by%'),
  'no_anon_execute', not (
       has_function_privilege('anon', 'public.record_expense_reimbursement(uuid[], date, text, numeric, text)', 'execute')
    or has_function_privilege('anon', 'public.reverse_expense_reimbursement(uuid, text)', 'execute')
    or has_function_privilege('anon', 'public.expense_reimbursement_receipts(uuid[])', 'execute')
    or has_function_privilege('anon', 'public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text, text, uuid)', 'execute')),
  'authenticated_can_execute', (
        has_function_privilege('authenticated', 'public.record_expense_reimbursement(uuid[], date, text, numeric, text)', 'execute')
    and has_function_privilege('authenticated', 'public.expense_reimbursement_receipts(uuid[])', 'execute')
    and has_function_privilege('authenticated', 'public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text, text, uuid)', 'execute')),
  'old_finalize_signature_gone', to_regprocedure('public.finalize_expense_draft(uuid, date, numeric, text, text, uuid, text)') is null,
  'no_client_delete_on_new_tables', not exists (select 1 from information_schema.role_table_grants
                                     where table_schema = 'public'
                                       and table_name in ('expense_reimbursements', 'expense_reimbursement_items', 'expense_bill_attachments')
                                       and grantee in ('anon', 'authenticated') and privilege_type in ('DELETE', 'TRUNCATE')),

  -- Bills: private bucket, the three storage policies.
  'bucket_private', (select public = false and file_size_limit = 10485760 from storage.buckets where id = 'expense-bills'),
  'storage_policies', (select count(*) = 3 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                        and policyname in ('expense_bills_insert', 'expense_bills_select', 'expense_bills_delete')),

  -- Nothing was seeded.
  'no_batches_or_bills_yet', (select count(*) from public.expense_reimbursements) = 0
                          and (select count(*) from public.expense_bill_attachments) = 0
);

rollback;
