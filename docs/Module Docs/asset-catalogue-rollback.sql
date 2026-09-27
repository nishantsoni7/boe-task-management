-- ROLLBACK for 20270131000000_asset_catalogue.sql. Reviewed and tested locally; NOT applied anywhere.
-- Run only by an administrator, only if the catalogue must be withdrawn, and
-- only after the matching frontend has been rolled back (the new frontend reads
-- assets.product_id and the catalogue tables and would fail without them).
--
-- Use only if the catalogue has to be withdrawn. It restores the pre-migration
-- schema: assets.asset_type was never modified by the migration, so no asset
-- data needs restoring.
--
-- ═══ HARD LIMIT: any asset with a product ═══════════════════════════════════
-- It REFUSES, with no override, once any asset names a product. That link
-- exists only in assets.product_id, which this script drops. Clear or record
-- those assignments first, as a deliberate decision.
--
-- ═══ WHAT IS PERMANENTLY DISCARDED EVEN WHEN NO ASSET HAS A PRODUCT ═════════
-- This script DROPS asset_categories, asset_products and
-- asset_catalogue_activity. Everything created or changed in the catalogue
-- after the release is deleted, not archived:
--
--   * Categories ADDED after release: the rows and their display names are
--     gone. Assets filed under one keep its KEY as plain text in
--     assets.asset_type (e.g. 'workshop_equipment'). The old app shows it
--     humanised from the key ("Workshop Equipment"), and shows a key that was
--     later renamed by its ORIGINAL words. It can no longer offer that
--     category for new assets, but an edit of such an asset keeps it (the old
--     form lists the asset's own value). Pending change requests that propose
--     it keep the text too.
--   * RENAMES of the six original categories: lost. They read as the old app
--     always showed them ("Laptop Desktop", "Mouse Keyboard").
--   * Every PRODUCT, including unassigned ones: deleted.
--   * RETIRED flags: lost. The old app offers exactly its fixed six again,
--     retired or not.
--   * The CATALOGUE CHANGE HISTORY (who changed what, when): deleted. Per-asset
--     history in asset_activity_log is untouched, including "Updated product"
--     rows, which store product names, not ids.
--   * Every "Manage Asset Catalogue" GRANT (employee, role, department): deleted.
--
-- Because that is irreversible, the script REFUSES whenever any of it is
-- non-empty, and lists the counts, until the operator acknowledges it in the
-- same session:
--
--     set boe.asset_catalogue_rollback_discard = 'yes';
--
-- EXPORT FIRST. Before acknowledging, save the catalogue as a record with this
-- read-only query (keep the JSON it returns):
--
--   select json_build_object(
--     'categories', (select json_agg(c order by c.key) from public.asset_categories c),
--     'products',   (select json_agg(p order by p.category_key, p.name) from public.asset_products p),
--     'history',    (select json_agg(h order by h.created_at) from public.asset_catalogue_activity h),
--     'grants',     (select json_agg(json_build_object('user_id', eo.user_id, 'allowed', eo.allowed,
--                                                      'revoked_at', eo.revoked_at))
--                      from public.employee_permission_overrides eo
--                      join public.permission_actions pa on pa.id = eo.action_id
--                     where pa.action_key = 'manage_asset_catalogue')
--   ) as asset_catalogue_export;
--
-- A rollback straight after release, before anyone has used the catalogue,
-- discards nothing and needs no acknowledgement.

begin;

do $$
declare
  v_n                  int;
  v_added_categories   int;
  v_renamed_originals  int;
  v_products           int;
  v_retired            int;
  v_history            int;
  v_grants             int;
  v_assets_on_added    int;
  v_requests_on_added  int;
begin
  -- Hard limit, no override.
  select count(*) into v_n from public.assets where product_id is not null;
  if v_n > 0 then
    raise exception 'ROLLBACK REFUSED: % asset(s) name a product; clear or record them first', v_n;
  end if;

  select count(*) into v_added_categories from public.asset_categories
   where key not in ('laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other');
  select count(*) into v_renamed_originals from public.asset_categories c
    join (values ('laptop_desktop', 'Laptop / Desktop'), ('monitor', 'Monitor'),
                 ('mouse_keyboard', 'Mouse / Keyboard'), ('storage', 'Storage'),
                 ('phone', 'Phone'), ('other', 'Other')) o(key, name)
      on o.key = c.key
   where c.name <> o.name;
  select count(*) into v_products from public.asset_products;
  select count(*) into v_retired  from (
    select 1 from public.asset_categories where not is_active
    union all select 1 from public.asset_products where not is_active) r;
  select count(*) into v_history  from public.asset_catalogue_activity;
  select count(*) into v_grants   from (
    select 1 from public.employee_permission_overrides eo
      join public.permission_actions pa on pa.id = eo.action_id and pa.action_key = 'manage_asset_catalogue'
    union all
    select 1 from public.role_permissions rp
      join public.permission_actions pa on pa.id = rp.action_id and pa.action_key = 'manage_asset_catalogue'
     where rp.role <> 'admin'
    union all
    select 1 from public.department_permissions dp
      join public.permission_actions pa on pa.id = dp.action_id and pa.action_key = 'manage_asset_catalogue') g;
  select count(*) into v_assets_on_added from public.assets
   where asset_type not in ('laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other');
  select count(*) into v_requests_on_added from public.asset_change_requests
   where proposed_asset_type is not null
     and proposed_asset_type not in ('laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other');

  raise notice 'ROLLBACK WOULD DISCARD: % added categor(ies), % renamed original(s), % product(s), '
               '% retired flag(s), % catalogue history row(s), % catalogue grant(s)',
               v_added_categories, v_renamed_originals, v_products, v_retired, v_history, v_grants;
  raise notice 'ROLLBACK KEEPS AS TEXT: % asset(s) and % change request(s) on a category added after release',
               v_assets_on_added, v_requests_on_added;

  if (v_added_categories + v_renamed_originals + v_products + v_retired + v_history + v_grants) > 0
     and coalesce(current_setting('boe.asset_catalogue_rollback_discard', true), '') <> 'yes' then
    raise exception 'ROLLBACK REFUSED: the catalogue holds data this script would permanently delete (see NOTICE). '
                    'Export it with the query in this file''s header, then run: '
                    'set boe.asset_catalogue_rollback_discard = ''yes''; and re-run this script.';
  end if;
end $$;

drop trigger if exists assets_log_product_changed      on public.assets;
drop trigger if exists assets_enforce_catalogue_links  on public.assets;
drop function if exists public.log_asset_product_changed();
drop function if exists public.enforce_asset_catalogue_links();

drop function if exists public.asset_catalogue_usage();
drop function if exists public.update_asset_product(uuid, text, text, boolean);
drop function if exists public.create_asset_product(text, text);
drop function if exists public.update_asset_category(text, text, boolean);
drop function if exists public.create_asset_category(text);
drop function if exists public.log_asset_catalogue_activity(text, text, uuid, text, text, jsonb);
drop function if exists public.assert_asset_catalogue_manager();
drop function if exists public.asset_catalogue_normalise_name(text);

alter table public.assets                drop constraint if exists assets_asset_type_fkey;
alter table public.asset_change_requests drop constraint if exists asset_change_requests_proposed_asset_type_fkey;
drop index if exists public.assets_product_id_idx;
alter table public.assets drop column if exists product_id;

drop table if exists public.asset_catalogue_activity;
drop function if exists public.prevent_asset_catalogue_activity_mutation();
drop table if exists public.asset_products;
drop table if exists public.asset_categories;

delete from public.employee_permission_overrides eo
 using public.permission_actions pa
 where pa.id = eo.action_id and pa.action_key = 'manage_asset_catalogue';
delete from public.role_permissions rp
 using public.permission_actions pa
 where pa.id = rp.action_id and pa.action_key = 'manage_asset_catalogue';
delete from public.department_permissions dp
 using public.permission_actions pa
 where pa.id = dp.action_id and pa.action_key = 'manage_asset_catalogue';
delete from public.module_permission_actions mpa
 using public.permission_actions pa
 where pa.id = mpa.action_id and pa.action_key = 'manage_asset_catalogue';
delete from public.permission_actions where action_key = 'manage_asset_catalogue';

drop function if exists public.can_manage_asset_catalogue();

commit;
