-- ROLLBACK for 20270131000000_asset_catalogue.sql. Reviewed and tested locally; NOT applied anywhere.
-- Run only by an administrator, only if the catalogue must be withdrawn, and
-- only after the matching frontend has been rolled back (the new frontend reads
-- assets.product_id and the catalogue tables and would fail without them).
--
-- Use only if the catalogue has to be withdrawn. It restores the pre-migration
-- schema: assets.asset_type was never modified by the migration, so no asset
-- data needs restoring.
--
-- THE LIMIT: it REFUSES once any asset names a product. That link exists only
-- in assets.product_id, which this script drops, so rolling back would lose
-- it. Clear or record those assignments first, deliberately.
--
-- It WARNS (does not refuse) when assets use a category created after the
-- migration: they keep that key as plain text, and the old app shows it
-- humanised ("Workshop Equipment" from workshop_equipment) but cannot offer it
-- for new assets.

begin;

do $$
declare v_n int;
begin
  select count(*) into v_n from public.assets where product_id is not null;
  if v_n > 0 then
    raise exception 'ROLLBACK REFUSED: % asset(s) name a product; clear or record them first', v_n;
  end if;
  select count(*) into v_n from public.assets
   where asset_type not in ('laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other');
  if v_n > 0 then
    raise notice 'ROLLBACK NOTE: % asset(s) use a category outside the original six; they keep the key as text', v_n;
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
