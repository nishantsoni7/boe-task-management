-- ═════════════════════════════════════════════════════════════════════════════
-- Assets & Access — asset catalogue (20270220000000) behavioural assertions
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Proves, against a real database with the migration applied, what a text
-- audit cannot:
--
--   1. An ordinary employee cannot change the catalogue — not through the RPCs
--      and not by writing the tables directly, which is what a hand-made
--      PostgREST request would do. They can still READ the labels.
--   2. Asset authority (create / edit / manage) does not imply catalogue
--      authority.
--   3. A delegated catalogue manager can add, rename, retire and reactivate
--      categories and products, and gains nothing else: no inventory read, no
--      asset write, no access records, no permission management.
--   4. Integrity: duplicate names are refused within the right scope; a
--      product must belong to its asset's category; a retired entry cannot be
--      chosen for a new asset but existing assets keep working; an entry in use
--      cannot be deleted or moved; renaming keeps every asset's link.
--   5. Every change is recorded with who and when, and that record cannot be
--      rewritten.
--   6. Revoking the grant, or deactivating the account, removes the authority.
--
-- Creates its own fixtures (fixed ids, unlikely to collide) and ROLLS BACK.
-- Safe on any disposable local database that has the migration applied. Never
-- run it against production.
--
--   tr -d '\r' < supabase/tests/asset_catalogue_assertions.sql \
--     | docker exec -i supabase_db_<project> psql -U postgres -d postgres

\set ON_ERROR_STOP on

begin;

do $$
begin
  if to_regclass('public.asset_categories') is null then
    raise exception 'ASSET_CATALOGUE_ASSERT_REFUSED: 20270220000000 is not applied here. Nothing was written.';
  end if;
end $$;

-- ─── Fixtures ────────────────────────────────────────────────────────────────

do $$
begin
  perform set_config('t.admin',     'ca7a1000-0000-4000-8000-000000000001', true);
  perform set_config('t.delegate',  'ca7a1000-0000-4000-8000-000000000002', true);
  perform set_config('t.employee',  'ca7a1000-0000-4000-8000-000000000003', true);
  perform set_config('t.inventory', 'ca7a1000-0000-4000-8000-000000000004', true);
end $$;

insert into public.users (id, full_name, email, role, team, is_active)
values
  (current_setting('t.admin')::uuid,     'CAT Admin',     'cat.admin@example.invalid',     'admin',  'management', true),
  (current_setting('t.delegate')::uuid,  'CAT Delegate',  'cat.delegate@example.invalid',  'member', 'operations', true),
  (current_setting('t.employee')::uuid,  'CAT Employee',  'cat.employee@example.invalid',  'member', 'operations', true),
  (current_setting('t.inventory')::uuid, 'CAT Inventory', 'cat.inventory@example.invalid', 'member', 'operations', true);

create or replace function pg_temp.act_as(p_uid uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.grant_action(p_uid uuid, p_action text)
returns void language plpgsql as $$
begin
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  select p_uid, pm.id, pa.id, true, current_setting('t.admin')::uuid
    from public.permission_modules pm
    join public.module_permission_actions mpa on mpa.module_id = pm.id
    join public.permission_actions pa on pa.id = mpa.action_id
   where pm.module_key = 'assets_access' and pa.action_key = p_action
  on conflict (user_id, module_id, action_id)
    do update set allowed = true, revoked_at = null, revoked_by = null;
end $$;

-- Module entry for all three non-admins, then the grants that differ.
select pg_temp.grant_action(current_setting('t.delegate')::uuid,  'view');
select pg_temp.grant_action(current_setting('t.employee')::uuid,  'view');
select pg_temp.grant_action(current_setting('t.inventory')::uuid, 'view');
select pg_temp.grant_action(current_setting('t.delegate')::uuid,  'manage_asset_catalogue');
select pg_temp.grant_action(current_setting('t.inventory')::uuid, 'create');
select pg_temp.grant_action(current_setting('t.inventory')::uuid, 'edit');
select pg_temp.grant_action(current_setting('t.inventory')::uuid, 'manage');

-- Assets that existed BEFORE any catalogue change, on the backfilled keys.
do $$
begin
  perform set_config('t.laptop', gen_random_uuid()::text, true);
  perform set_config('t.phone',  gen_random_uuid()::text, true);
end $$;

insert into public.assets (id, asset_type, asset_name, brand, status)
values
  (current_setting('t.laptop')::uuid, 'laptop_desktop', 'CAT pre-existing laptop', 'Dell',  'available'),
  (current_setting('t.phone')::uuid,  'phone',          'CAT pre-existing phone',  'Pixel', 'available');

-- ═══ 1. An ordinary employee cannot change the catalogue ════════════════════

select pg_temp.act_as(current_setting('t.employee')::uuid);
set local role authenticated;

do $$
declare v_n int;
begin
  -- Reading is fine: labels are needed on My Assets.
  select count(*) into v_n from public.asset_categories
   where key in ('laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other');
  assert v_n = 6, format('employee should read the six categories, read %s', v_n);

  begin
    perform public.create_asset_category('Employee Category');
    raise exception 'employee created a category through the RPC';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DENIED:%', 'employee create: ' || sqlerrm;
  end;

  begin
    perform public.update_asset_category('phone', 'Mobiles', true);
    raise exception 'employee renamed a category through the RPC';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DENIED:%', 'employee rename: ' || sqlerrm;
  end;

  begin
    perform public.create_asset_product('phone', 'Employee Phone');
    raise exception 'employee created a product through the RPC';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DENIED:%', 'employee product: ' || sqlerrm;
  end;

  begin
    perform * from public.asset_catalogue_usage();
    raise exception 'employee read catalogue usage';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DENIED:%', 'employee usage: ' || sqlerrm;
  end;

  -- The direct-request path: what a hand-made PostgREST call would do.
  begin
    insert into public.asset_categories (key, name) values ('direct_cat', 'Direct Category');
    raise exception 'employee inserted a category directly';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.asset_categories set name = 'Hacked' where key = 'phone';
    raise exception 'employee updated a category directly';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.asset_categories where key = 'other';
    raise exception 'employee deleted a category directly';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.asset_products (category_key, name) values ('phone', 'Direct Product');
    raise exception 'employee inserted a product directly';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.asset_catalogue_activity (entity_type, category_key, event_type, summary)
    values ('category', 'phone', 'category_renamed', 'forged');
    raise exception 'employee forged a catalogue history row';
  exception when insufficient_privilege then null;
  end;

  -- Catalogue history is for the people who manage it or the inventory.
  select count(*) into v_n from public.asset_catalogue_activity;
  assert v_n = 0, 'employee must not read catalogue history';
end $$;

reset role;

do $$
begin
  assert (select name from public.asset_categories where key = 'phone') = 'Phone',
    'the direct update must not have landed';
end $$;

-- ═══ 2. Asset authority does not imply catalogue authority ══════════════════

select pg_temp.act_as(current_setting('t.inventory')::uuid);
set local role authenticated;

do $$
begin
  begin
    perform public.create_asset_category('Inventory Category');
    raise exception 'create/edit/manage holder created a category';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DENIED:%', 'inventory create: ' || sqlerrm;
  end;
  -- But they may see the usage counts — they can see the inventory anyway.
  perform * from public.asset_catalogue_usage();
end $$;

reset role;

-- ═══ 3. The delegated catalogue manager ═════════════════════════════════════

select pg_temp.act_as(current_setting('t.delegate')::uuid);
set local role authenticated;

do $$
declare
  v_cat  public.asset_categories;
  v_prod public.asset_products;
  v_n    int;
begin
  -- Acceptance example: add "Workshop Equipment" and a product beneath it.
  v_cat := public.create_asset_category('  Workshop   Equipment ');
  assert v_cat.key = 'workshop_equipment', 'key derived from the name: ' || v_cat.key;
  assert v_cat.name = 'Workshop Equipment', 'name normalised: ' || v_cat.name;
  assert v_cat.is_active, 'a new category is active';
  assert v_cat.created_by = current_setting('t.delegate')::uuid, 'created_by is the delegate';
  perform set_config('t.workshop', v_cat.key, true);

  v_prod := public.create_asset_product('workshop_equipment', 'Bosch GSB 500 Drill');
  assert v_prod.category_key = 'workshop_equipment', 'product sits under its category';
  perform set_config('t.drill', v_prod.id::text, true);

  -- Duplicates, case- and whitespace-insensitive, within the right scope.
  begin
    perform public.create_asset_category('workshop equipment');
    raise exception 'duplicate category accepted';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DUPLICATE:%already exists%', 'dup category: ' || sqlerrm;
  end;

  begin
    perform public.update_asset_category('monitor', ' PHONE ', true);
    raise exception 'renaming onto another category name accepted';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DUPLICATE:%', 'rename onto dup: ' || sqlerrm;
  end;

  begin
    perform public.create_asset_product('workshop_equipment', 'bosch gsb 500 drill');
    raise exception 'duplicate product within a category accepted';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DUPLICATE:%', 'dup product: ' || sqlerrm;
  end;

  -- The same product name under a DIFFERENT category is a different thing.
  v_prod := public.create_asset_product('other', 'Bosch GSB 500 Drill');
  perform set_config('t.other_drill', v_prod.id::text, true);

  -- Blank and over-long names.
  begin
    perform public.create_asset_category('   ');
    raise exception 'blank category accepted';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_INVALID:%', 'blank: ' || sqlerrm;
  end;
  begin
    perform public.create_asset_product('phone', repeat('x', 81));
    raise exception 'over-long product accepted';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_INVALID:%', 'long: ' || sqlerrm;
  end;

  -- It can see usage counts, but NOT the inventory itself.
  perform * from public.asset_catalogue_usage();
  select count(*) into v_n from public.assets;
  assert v_n = 0, format('the catalogue grant must not open the inventory, read %s asset(s)', v_n);
  select count(*) into v_n from public.employee_assets;
  assert v_n = 0, 'the catalogue grant must not reveal who holds what';

  -- It gains nothing else.
  begin
    insert into public.assets (asset_type, asset_name) values ('workshop_equipment', 'Delegate asset');
    raise exception 'delegate created an asset';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.access_records (employee_id, access_type, username)
    values (current_setting('t.employee')::uuid, 'gmail', 'x@example.invalid');
    raise exception 'delegate wrote an access record';
  exception when insufficient_privilege then null;
  end;
  select count(*) into v_n from public.access_records;
  assert v_n = 0, 'delegate must not read access records';

  begin
    insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
    select current_setting('t.employee')::uuid, pm.id, pa.id, true, current_setting('t.delegate')::uuid
      from public.permission_modules pm, public.permission_actions pa
     where pm.module_key = 'assets_access' and pa.action_key = 'manage_asset_catalogue';
    raise exception 'delegate granted a permission';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- ═══ 4. Assets and the catalogue ════════════════════════════════════════════

select pg_temp.act_as(current_setting('t.inventory')::uuid);
set local role authenticated;

do $$
declare v_asset uuid;
begin
  -- The new category and product are selectable wherever an asset is created.
  insert into public.assets (asset_type, asset_name, product_id)
  values ('workshop_equipment', 'CAT drill #1', current_setting('t.drill')::uuid)
  returning id into v_asset;
  perform set_config('t.drill_asset', v_asset::text, true);

  -- A product from another category is refused.
  begin
    insert into public.assets (asset_type, asset_name, product_id)
    values ('phone', 'CAT mismatched', current_setting('t.drill')::uuid);
    raise exception 'mismatched product accepted';
  exception when others then
    assert sqlerrm like 'ASSET_PRODUCT_MISMATCH:%', 'mismatch: ' || sqlerrm;
  end;

  -- An unknown category is refused by the foreign key.
  begin
    insert into public.assets (asset_type, asset_name) values ('no_such_category', 'CAT orphan');
    raise exception 'unknown category accepted';
  exception when foreign_key_violation then null;
  end;
end $$;

reset role;

-- ═══ 5. Rename keeps every link; history records who ════════════════════════

select pg_temp.act_as(current_setting('t.delegate')::uuid);
set local role authenticated;
select public.update_asset_category('laptop_desktop', 'Computers', true);
select public.update_asset_product(current_setting('t.drill')::uuid, 'workshop_equipment', 'Bosch GSB 500 RE', true);
reset role;

do $$
declare v_n int;
begin
  assert (select asset_type from public.assets where id = current_setting('t.laptop')::uuid) = 'laptop_desktop',
    'a pre-existing asset keeps its category key across a rename';
  assert (select c.name from public.assets a join public.asset_categories c on c.key = a.asset_type
           where a.id = current_setting('t.laptop')::uuid) = 'Computers',
    'and now reads the new name';
  assert (select product_id from public.assets where id = current_setting('t.drill_asset')::uuid)
         = current_setting('t.drill')::uuid,
    'an asset keeps its product across a product rename';

  select count(*) into v_n from public.asset_catalogue_activity
   where event_type = 'category_renamed' and category_key = 'laptop_desktop'
     and actor_id = current_setting('t.delegate')::uuid and actor_name = 'CAT Delegate'
     and details ->> 'old_name' = 'Laptop / Desktop' and details ->> 'new_name' = 'Computers';
  assert v_n = 1, format('the rename is recorded with who and what, found %s', v_n);

  select count(*) into v_n from public.asset_catalogue_activity
   where actor_id = current_setting('t.delegate')::uuid
     and event_type in ('category_created', 'product_created', 'product_renamed');
  assert v_n = 4, format('create x3 + product rename recorded, found %s', v_n);
end $$;

-- ═══ 6. Retire, and what still works afterwards ═════════════════════════════

select pg_temp.act_as(current_setting('t.delegate')::uuid);
set local role authenticated;
select public.update_asset_category('workshop_equipment', 'Workshop Equipment', false);
select public.update_asset_product(current_setting('t.other_drill')::uuid, 'other', 'Bosch GSB 500 Drill', false);

do $$
begin
  begin
    perform public.create_asset_product('workshop_equipment', 'Angle Grinder');
    raise exception 'product added under a retired category';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_INVALID:%inactive%', 'retired parent: ' || sqlerrm;
  end;
  -- Re-adding a retired name points at the retired entry.
  begin
    perform public.create_asset_category('Workshop Equipment');
    raise exception 'duplicate of a retired category accepted';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DUPLICATE:%inactive%Reactivate%', 'retired dup: ' || sqlerrm;
  end;
end $$;
reset role;

select pg_temp.act_as(current_setting('t.inventory')::uuid);
set local role authenticated;

do $$
begin
  -- A retired category cannot be chosen for a NEW asset…
  begin
    insert into public.assets (asset_type, asset_name) values ('workshop_equipment', 'CAT drill #2');
    raise exception 'new asset in a retired category accepted';
  exception when others then
    assert sqlerrm like 'ASSET_CATEGORY_INACTIVE:%', 'retired category: ' || sqlerrm;
  end;
  -- …nor moved INTO…
  begin
    update public.assets set asset_type = 'workshop_equipment' where id = current_setting('t.phone')::uuid;
    raise exception 'asset moved into a retired category';
  exception when others then
    assert sqlerrm like 'ASSET_CATEGORY_INACTIVE:%', 'move into retired: ' || sqlerrm;
  end;
  -- …and a retired product cannot be newly chosen.
  begin
    insert into public.assets (asset_type, asset_name, product_id)
    values ('other', 'CAT other drill', current_setting('t.other_drill')::uuid);
    raise exception 'retired product accepted';
  exception when others then
    assert sqlerrm like 'ASSET_PRODUCT_INACTIVE:%', 'retired product: ' || sqlerrm;
  end;

  -- But an existing asset in the retired category still saves other edits.
  update public.assets set asset_name = 'CAT drill #1 (relabelled)'
   where id = current_setting('t.drill_asset')::uuid;
  assert found, 'an edit of another field on an asset in a retired category must succeed';
end $$;

reset role;

-- ═══ 7. In use: no delete, no move ══════════════════════════════════════════

do $$
begin
  -- Even the table owner cannot delete a category or product an asset names.
  begin
    delete from public.asset_categories where key = 'workshop_equipment';
    raise exception 'in-use category deleted';
  exception when foreign_key_violation then null;
  end;
  begin
    delete from public.asset_products where id = current_setting('t.drill')::uuid;
    raise exception 'in-use product deleted';
  exception when foreign_key_violation then null;
  end;
  -- Nor re-key one.
  begin
    update public.asset_categories set key = 'workshop' where key = 'workshop_equipment';
    raise exception 'in-use category re-keyed';
  exception when foreign_key_violation then null;
  end;
end $$;

select pg_temp.act_as(current_setting('t.admin')::uuid);
set local role authenticated;
do $$
begin
  perform public.update_asset_category('workshop_equipment', 'Workshop Equipment', true);
  begin
    perform public.update_asset_product(current_setting('t.drill')::uuid, 'other', 'Bosch GSB 500 RE', true);
    raise exception 'in-use product moved to another category';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_IN_USE:%', 'in-use move: ' || sqlerrm;
  end;
end $$;
reset role;

-- ═══ 8. Changing an asset's category clears a product it no longer fits ═════

select pg_temp.act_as(current_setting('t.inventory')::uuid);
set local role authenticated;
update public.assets set asset_type = 'other' where id = current_setting('t.drill_asset')::uuid;
reset role;

do $$
begin
  assert (select product_id from public.assets where id = current_setting('t.drill_asset')::uuid) is null,
    'a category change clears a product from the old category';
  assert exists (
    select 1 from public.asset_activity_log
     where asset_id = current_setting('t.drill_asset')::uuid
       and event_type = 'asset_edited' and summary = 'Updated product'
       and details -> 'changes' -> 0 ->> 'old' = 'Bosch GSB 500 RE'
  ), 'the cleared product is in the asset''s own history, by name';
end $$;

-- ═══ 9. History cannot be rewritten ═════════════════════════════════════════

do $$
begin
  begin
    update public.asset_catalogue_activity set summary = 'rewritten';
    raise exception 'catalogue history updated';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_IMMUTABLE:%', 'immutable update: ' || sqlerrm;
  end;
  begin
    delete from public.asset_catalogue_activity;
    raise exception 'catalogue history deleted';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_IMMUTABLE:%', 'immutable delete: ' || sqlerrm;
  end;
end $$;

-- ═══ 10. Revoking and deactivating remove the authority ═════════════════════

update public.employee_permission_overrides eo
   set revoked_at = now(), revoked_by = current_setting('t.admin')::uuid
  from public.permission_actions pa
 where pa.id = eo.action_id and pa.action_key = 'manage_asset_catalogue'
   and eo.user_id = current_setting('t.delegate')::uuid;

select pg_temp.act_as(current_setting('t.delegate')::uuid);
set local role authenticated;
do $$
begin
  begin
    perform public.create_asset_category('After Revoke');
    raise exception 'revoked delegate still manages the catalogue';
  exception when others then
    assert sqlerrm like 'ASSET_CATALOGUE_DENIED:%', 'revoked: ' || sqlerrm;
  end;
end $$;
reset role;

select pg_temp.grant_action(current_setting('t.delegate')::uuid, 'manage_asset_catalogue');
update public.users set is_active = false where id = current_setting('t.delegate')::uuid;

select pg_temp.act_as(current_setting('t.delegate')::uuid);
set local role authenticated;
do $$
begin
  begin
    perform public.create_asset_category('After Deactivation');
    raise exception 'deactivated delegate still manages the catalogue';
  exception when others then
    -- The RESTRICTIVE entry gate or the predicate — either refusal is correct.
    assert sqlerrm like 'ASSET_CATALOGUE_DENIED:%' or sqlstate = '42501', 'deactivated: ' || sqlerrm;
  end;
end $$;
reset role;

-- ═══ 11. The pre-existing assets are exactly as they were ═══════════════════

do $$
begin
  assert (select asset_type || '|' || asset_name || '|' || coalesce(brand, '') || '|' || coalesce(product_id::text, 'none')
            from public.assets where id = current_setting('t.phone')::uuid)
         = 'phone|CAT pre-existing phone|Pixel|none',
    'an asset nobody touched is unchanged';
  raise notice 'ASSET_CATALOGUE_ASSERTIONS: all passed';
end $$;

rollback;
