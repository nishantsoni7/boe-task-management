-- ── 20270127000000 — PRODUCTION SNAPSHOT, READ ONLY ─────────────────────────
--
-- Run BEFORE the migration is applied, and again AFTER it (before the merge):
--
--   npx supabase db query --linked -f supabase/tests/expense_reimbursement_production_snapshot.sql
--
-- SELECT only, inside a read-only transaction that is rolled back; it writes
-- nothing. `read_only` must be "on". The fingerprint covers only the expense
-- columns that exist BEFORE the migration, so the before and after values must be
-- identical: the migration adds columns and changes no existing value.

begin transaction read only;

select json_build_object(
  'read_only', current_setting('transaction_read_only'),
  'recent_migrations', (select json_agg(version order by version)
                          from supabase_migrations.schema_migrations
                         where version >= '20270110000000'),
  'expenses', (select count(*) from public.expenses),
  'live_expenses', (select count(*) from public.expenses where deleted_at is null),
  'live_total', (select sum(amount) from public.expenses where deleted_at is null),
  'expenses_fingerprint', (select md5(string_agg(concat_ws('|', id, expense_date, amount, payment_mode, paid_to,
                               category_id, remark, created_by, updated_by, deleted_at, deleted_by), ',' order by id))
                            from public.expenses),
  'migration_20270127_applied', exists (select 1 from supabase_migrations.schema_migrations
                                         where version = '20270127000000')
);

rollback;
