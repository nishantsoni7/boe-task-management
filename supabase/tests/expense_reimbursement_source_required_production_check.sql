-- ── 20270211120000 — PRODUCTION CHECK, READ ONLY ────────────────────────────
--
-- Run AFTER the migration is applied (and, for the counts, also BEFORE it):
--
--   npx supabase db query --linked -f supabase/tests/expense_reimbursement_source_required_production_check.sql
--
-- SELECT only, inside a read-only transaction that is rolled back; it writes
-- nothing. After the migration every boolean must be true, and the counts and
-- fingerprint must equal the values taken before it: the rule touches no row.

begin transaction read only;

select json_build_object(
  'read_only', current_setting('transaction_read_only') = 'on',
  'migration_recorded', exists (select 1 from supabase_migrations.schema_migrations
                                 where version = '20270211120000'),
  'trigger_insert_only', exists (select 1 from pg_trigger
                                  where tgrelid = 'public.expenses'::regclass
                                    and tgname = 'expenses_require_payment_source' and not tgisinternal
                                    and tgtype & 2 = 2 and tgtype & 4 = 4 and tgtype & 16 = 0),
  'paid_from_still_nullable', (select is_nullable = 'YES' from information_schema.columns
                                where table_schema = 'public' and table_name = 'expenses'
                                  and column_name = 'paid_from'),
  -- By oid, so this reads false (not an error) before the function exists.
  'no_client_execute_on_trigger_fn', not coalesce(has_function_privilege('authenticated',
                                to_regprocedure('public.expenses_require_payment_source()'), 'execute'), true),
  'expenses', (select count(*) from public.expenses),
  'source_not_recorded', (select count(*) from public.expenses where paid_from is null),
  'expenses_fingerprint', (select md5(string_agg(concat_ws('|', id, expense_date, amount, payment_mode, paid_to,
                               category_id, remark, created_by, updated_by, deleted_at, deleted_by,
                               paid_from, paid_by, reimbursement_id), ',' order by id))
                            from public.expenses)
);

rollback;
