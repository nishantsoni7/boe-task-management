-- Asset catalogue (20270220000000) — production checks. READ-ONLY.
--
-- Every statement is a SELECT. Run it twice:
--   1. BEFORE the release, to record the baseline (section A only is meaningful);
--   2. AFTER `db push`, and compare with the expected values noted per line.
--
--   npx supabase db query --linked -f "docs/Module Docs/asset-catalogue-post-release-checks.sql"
--
-- (That path may initialise a temporary login role; the SQL itself writes
-- nothing. For a strictly zero-write check, run it through psql inside
-- `begin transaction read only; … rollback;`.)
--
-- One JSON row. Any "expect" that does not hold is a stop-the-release finding.

select json_build_object(

  -- ── A. Data that must be IDENTICAL before and after (compare with baseline) ──
  'A_asset_count',            (select count(*) from public.assets),                     -- expect: = baseline (35 on 2026-09-27)
  'A_assets_by_type_status',  (select json_agg(t order by t.asset_type, t.status)
                                 from (select asset_type, status, count(*) n from public.assets group by 1, 2) t),
  'A_assignments_by_status',  (select json_agg(t order by t.status)
                                 from (select status, count(*) n from public.employee_assets group by 1) t),
  'A_access_records',         (select count(*) from public.access_records),              -- expect: = baseline
  'A_status_custody_mismatch',(select count(*) from public.assets a
                                where a.status = 'assigned'
                                  and not exists (select 1 from public.employee_assets e
                                                   where e.asset_id = a.id and e.status in ('pending_acceptance', 'accepted'))),
                                                                                         -- expect: = baseline (0)

  -- ── B. The migration is applied, once ──
  'B_ledger_has_version',     (select count(*) from supabase_migrations.schema_migrations
                                where version = '20270220000000'),                       -- expect: 1

  -- ── C. Catalogue backfill ──
  'C_original_six_present',   (select count(*) from public.asset_categories
                                where key in ('laptop_desktop','monitor','mouse_keyboard','storage','phone','other')), -- expect: 6
  'C_categories_total',       (select count(*) from public.asset_categories),           -- expect: 6 right after release
  'C_assets_without_category',(select count(*) from public.assets a
                                where not exists (select 1 from public.asset_categories c where c.key = a.asset_type)), -- expect: 0
  'C_products_total',         (select count(*) from public.asset_products),             -- expect: 0 right after release
  'C_assets_with_product',    (select count(*) from public.assets where product_id is not null), -- expect: 0 right after release
  'C_catalogue_history_rows', (select count(*) from public.asset_catalogue_activity),   -- expect: 0 right after release

  -- ── D. The permission exists and is held by nobody but admin ──
  'D_action_default_denied',  (select count(*) from public.module_permission_actions mpa
                                 join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'assets_access'
                                 join public.permission_actions pa on pa.id = mpa.action_id and pa.action_key = 'manage_asset_catalogue'
                                where not mpa.default_allowed),                          -- expect: 1
  'D_non_admin_role_grants',  (select count(*) from public.role_permissions rp
                                 join public.permission_actions pa on pa.id = rp.action_id and pa.action_key = 'manage_asset_catalogue'
                                where rp.role <> 'admin' and rp.allowed),                -- expect: 0
  'D_employee_grants',        (select count(*) from public.employee_permission_overrides eo
                                 join public.permission_actions pa on pa.id = eo.action_id and pa.action_key = 'manage_asset_catalogue'
                                where eo.allowed and eo.revoked_at is null),             -- expect: 0 until an admin grants it

  -- ── E. No direct write path for clients ──
  'E_authenticated_write_privs', (select count(*) from (values
                                    (has_table_privilege('authenticated', 'public.asset_categories', 'INSERT')),
                                    (has_table_privilege('authenticated', 'public.asset_categories', 'UPDATE')),
                                    (has_table_privilege('authenticated', 'public.asset_categories', 'DELETE')),
                                    (has_table_privilege('authenticated', 'public.asset_products', 'INSERT')),
                                    (has_table_privilege('authenticated', 'public.asset_products', 'UPDATE')),
                                    (has_table_privilege('authenticated', 'public.asset_products', 'DELETE')),
                                    (has_table_privilege('authenticated', 'public.asset_catalogue_activity', 'INSERT'))) v(p)
                                  where p),                                             -- expect: 0
  'E_anon_select',            (select count(*) from (values
                                    (has_table_privilege('anon', 'public.asset_categories', 'SELECT')),
                                    (has_table_privilege('anon', 'public.asset_products', 'SELECT'))) v(p)
                                  where p),                                             -- expect: 0
  'E_permissive_write_policies', (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
                                   where c.relname in ('asset_categories', 'asset_products', 'asset_catalogue_activity')
                                     and p.polpermissive and p.polcmd <> 'r'),          -- expect: 0
  'E_entry_gates',            (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
                                where p.polname = c.relname || '_module_entry_gate' and not p.polpermissive
                                  and c.relname in ('asset_categories', 'asset_products', 'asset_catalogue_activity')), -- expect: 3

  -- ── F. Functions, triggers and keys ──
  'F_write_rpcs_definer_pinned', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                                   where p.proname in ('create_asset_category', 'update_asset_category',
                                                       'create_asset_product', 'update_asset_product',
                                                       'asset_catalogue_usage', 'can_manage_asset_catalogue')
                                     and p.prosecdef
                                     and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')), -- expect: 6
  'F_rpcs_anon_executable',   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                                where p.proname in ('create_asset_category', 'update_asset_category',
                                                    'create_asset_product', 'update_asset_product',
                                                    'asset_catalogue_usage', 'can_manage_asset_catalogue')
                                  and has_function_privilege('anon', p.oid, 'EXECUTE')), -- expect: 0
  'F_asset_triggers',         (select count(*) from pg_trigger
                                where tgrelid = 'public.assets'::regclass
                                  and tgname in ('assets_enforce_catalogue_links', 'assets_log_product_changed')), -- expect: 2
  'F_restrict_fks',           (select count(*) from pg_constraint
                                where conname in ('assets_asset_type_fkey', 'asset_change_requests_proposed_asset_type_fkey',
                                                  'assets_product_id_fkey')
                                  and confdeltype = 'r'),                                -- expect: 3
  'F_history_guard',          (select count(*) from pg_trigger
                                where tgrelid = 'public.asset_catalogue_activity'::regclass
                                  and tgname = 'asset_catalogue_activity_immutable')     -- expect: 1
) as asset_catalogue_release_check;
