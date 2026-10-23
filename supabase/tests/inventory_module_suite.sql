-- Inventory module suite. Run against a disposable local database that has 20270313000000 applied:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/inventory_module_suite.sql
-- Everything happens in ONE transaction that is rolled back, so nothing is left behind. The users are taken
-- from public.users (an admin and three members) and given grants through employee_permission_overrides.
-- NOTE: now() is the same for the whole transaction, so ordering is checked by content, not by time.

begin;

create function public.t_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', case when p_uid is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
end $$;

create function public.t_reset() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Runs p_sql and demands an error whose message starts with p_prefix.
create function public.t_fails(p_sql text, p_prefix text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like p_prefix || '%' then
      raise exception 'WRONG ERROR for [%]: expected prefix %, got %', p_sql, p_prefix, v_msg;
    end if;
    return;
  end;
  raise exception 'EXPECTED FAILURE did not happen: %', p_sql;
end $$;

create function public.t_eq(p_label text, p_actual anyelement, p_expected anyelement) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ASSERT % : expected %, got %', p_label, p_expected, p_actual;
  end if;
end $$;

-- Actors
create temp table t_actor (name text primary key, id uuid) on commit drop;
grant all on t_actor to public;
insert into t_actor values
  ('admin',   '11111111-1111-1111-1111-111111111111'),
  ('manager', 'd0000000-0000-4000-8000-00000000e011'),
  ('sales',   'd0000000-0000-4000-8000-00000000e012'),
  ('sales2',  'd0000000-0000-4000-8000-00000000e018'),
  ('nobody',  'd0000000-0000-4000-8000-00000000e013');

-- Control Center grants: manager holds all five, sales and sales2 only view; nobody holds nothing.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select a.id, pm.id, pa.id, true, '11111111-1111-1111-1111-111111111111'
from t_actor a
join public.permission_modules pm on pm.module_key = 'inventory'
join public.permission_actions pa on pa.action_key in ('view', 'create', 'edit', 'delete', 'approve')
where a.name = 'manager';
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select a.id, pm.id, pa.id, true, '11111111-1111-1111-1111-111111111111'
from t_actor a
join public.permission_modules pm on pm.module_key = 'inventory'
join public.permission_actions pa on pa.action_key = 'view'
where a.name in ('sales', 'sales2');

-- Pictures that "finished uploading": the bucket rows the save function looks for.
create temp table t_img (n int primary key, path text) on commit drop;
grant all on t_img to public;
insert into t_img select n, a.id::text || '/' || gen_random_uuid()::text || '.jpg'
from generate_series(1, 6) n, t_actor a where a.name = 'manager';
insert into t_img select 7, a.id::text || '/' || gen_random_uuid()::text || '.jpg' from t_actor a where a.name = 'sales';
insert into storage.objects (bucket_id, name, owner_id)
select 'inventory-images', path, (select id::text from t_actor where name = 'manager') from t_img where n <= 6;
insert into storage.objects (bucket_id, name, owner_id)
select 'inventory-images', path, (select id::text from t_actor where name = 'sales') from t_img where n = 7;

create function public.t_id(p_name text) returns uuid language sql as $$ select id from t_actor where name = p_name $$;
create function public.t_img(p_n int) returns text language sql as $$ select path from t_img where n = p_n $$;
create function public.t_item(p_code text) returns uuid language sql as $$
  select id from public.inventory_items where product_code = p_code and deleted_at is null $$;
create function public.t_data(p_code text, p_qty int, p_stage text default 'ready') returns jsonb language sql as $$
  select jsonb_build_object('product_code', p_code, 'name', 'Teak chair', 'size_text', '45 x 50 x 90 cm', 'material', 'Teak',
    'price', 4500, 'retail_price', 5200, 'condition', 'new', 'stage', p_stage, 'qty_total', p_qty, 'category', 'Chairs') $$;

-- ═══ 1. Registration ═══
select public.t_eq('module registered', (select count(*) from public.permission_modules where module_key = 'inventory'), 1::bigint);
select public.t_eq('five actions', (select count(*) from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'inventory'), 5::bigint);
select public.t_eq('nothing default-on', (select count(*) from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'inventory' where mpa.default_allowed), 0::bigint);
select public.t_eq('no department grants', (select count(*) from public.department_permissions dp
  join public.permission_modules pm on pm.id = dp.module_id and pm.module_key = 'inventory'), 0::bigint);

-- ═══ 2. Module entry ═══
select public.t_as(public.t_id('nobody'));
select public.t_fails('select public.inventory_my_access()', 'INVENTORY_FORBIDDEN');
select public.t_eq('outsider sees no rows', (select count(*) from public.inventory_items), 0::bigint);
select public.t_as(null);
select public.t_fails('select public.inventory_my_access()', 'permission denied');
select public.t_fails('select count(*) from public.inventory_items', 'permission denied');
select public.t_reset();

select public.t_as(public.t_id('sales'));
select public.t_eq('sales access', public.inventory_my_access(),
  '{"create": false, "edit": false, "delete": false, "approve": false}'::jsonb);
select public.t_as(public.t_id('manager'));
select public.t_eq('manager access', public.inventory_my_access(),
  '{"create": true, "edit": true, "delete": true, "approve": true}'::jsonb);
select public.t_as(public.t_id('admin'));
select public.t_eq('admin access', public.inventory_my_access(),
  '{"create": true, "edit": true, "delete": true, "approve": true}'::jsonb);

-- ═══ 3. Add a product ═══
select public.t_as(public.t_id('sales'));
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, 10), array[public.t_img(7)])', 'CH-001'), 'INVENTORY_FORBIDDEN');

select public.t_as(public.t_id('manager'));
select public.inventory_save_item(null, public.t_data('ch-001', 10), array[public.t_img(1), public.t_img(2)]);
select public.t_eq('code upper-cased', (select count(*) from public.inventory_items where product_code = 'CH-001'), 1::bigint);
select public.t_eq('available = total', (select qty_available from public.inventory_items where product_code = 'CH-001'), 10);
select public.t_eq('two pictures in order', (select array_agg(path order by position) from public.inventory_images
  where item_id = public.t_item('CH-001')), array[public.t_img(1), public.t_img(2)]);
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, 3), array[public.t_img(3)])', 'ch-001'), 'INVENTORY_DUPLICATE_CODE');
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, 3), array[public.t_img(1)])', 'CH-002'), 'INVENTORY_INVALID: A picture already belongs');
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, 3), array[public.t_img(7)])', 'CH-002'), 'INVENTORY_INVALID: A picture has not finished');
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, 3), array[]::text[])', 'CH-002'), 'INVENTORY_INVALID: Add between');
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, 3), array[%L])', 'CH-002', 'not-a-path'), 'INVENTORY_INVALID: A picture path');
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, 3), array[public.t_img(3)])', 'bad code!'), 'INVENTORY_INVALID: Product code');
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, -1), array[public.t_img(3)])', 'CH-002'), 'INVENTORY_INVALID: Enter a valid quantity');
select public.t_fails(format('select public.inventory_save_item(null, public.t_data(%L, 3, %L), array[public.t_img(3)])', 'CH-002', 'dreaming'), 'INVENTORY_INVALID: Choose the stage');

-- Lead time: stage in production, 12 days from today (IST). 'ready' clears it.
select public.inventory_save_item(null, public.t_data('SF-010', 4, 'finishing') || '{"ready_in_days": 12}', array[public.t_img(3)]);
select public.t_eq('ready date set', (select expected_ready_on from public.inventory_items where product_code = 'SF-010'),
  ((now() at time zone 'Asia/Kolkata')::date + 12));
select public.inventory_save_item(public.t_item('SF-010'), public.t_data('SF-010', 4, 'finishing'), array[public.t_img(3)]);
select public.t_eq('absent days leaves the date alone', (select expected_ready_on from public.inventory_items where product_code = 'SF-010'),
  ((now() at time zone 'Asia/Kolkata')::date + 12));
select public.inventory_save_item(public.t_item('SF-010'), public.t_data('SF-010', 4, 'ready') || '{"ready_in_days": 3}', array[public.t_img(3)]);
select public.t_eq('ready stage clears the date', (select expected_ready_on from public.inventory_items where product_code = 'SF-010'), null::date);

-- ═══ 4. Sales reads ═══
select public.t_as(public.t_id('sales'));
select public.t_eq('sales sees the products', (select count(*) from public.inventory_items), 2::bigint);
select public.t_eq('sales sees the pictures', (select count(*) from public.inventory_images), 3::bigint);
select public.t_fails('update public.inventory_items set price = 1', 'permission denied');
select public.t_fails('insert into public.inventory_images (item_id, path, position) values (gen_random_uuid(), ''x'', 0)', 'permission denied');
select public.t_fails('select public.inventory_item_history(gen_random_uuid())', 'INVENTORY_FORBIDDEN');
select public.t_fails(format('select public.inventory_delete_item(%L)', public.t_item('CH-001')), 'INVENTORY_FORBIDDEN');
select public.t_fails(format('select public.inventory_save_item(%L, public.t_data(%L, 10), array[public.t_img(1)])', public.t_item('CH-001'), 'CH-001'), 'INVENTORY_FORBIDDEN');

-- ═══ 5. Booking: reserve → confirm → sold ═══
select public.inventory_request_booking('00000000-0000-4000-8000-000000000001', public.t_item('CH-001'), 6, 'Mr Rao', '98765 43210', 'for the lobby');
select public.t_reset();
select public.t_eq('reserved 6', (select qty_reserved from public.inventory_items where product_code = 'CH-001'), 6);
select public.t_eq('available 4', (select qty_available from public.inventory_items where product_code = 'CH-001'), 4);

-- the same tap again is a replay, not a second reservation
select public.t_as(public.t_id('sales'));
select public.t_eq('replay', (public.inventory_request_booking('00000000-0000-4000-8000-000000000001', public.t_item('CH-001'), 6, 'Mr Rao', '98765 43210', 'for the lobby')->>'replayed')::boolean, true);
select public.t_fails(format('select public.inventory_request_booking(%L, %L, 2, %L)', '00000000-0000-4000-8000-000000000001', public.t_item('CH-001'), 'Someone else'), 'INVENTORY_INVALID: That request id');
select public.t_reset();
select public.t_eq('still 6 reserved after replay', (select qty_reserved from public.inventory_items where product_code = 'CH-001'), 6);
select public.t_eq('phone normalised', (select customer_phone from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000001'), '+919876543210');

-- oversell is refused: only 4 left
select public.t_as(public.t_id('sales2'));
select public.t_fails(format('select public.inventory_request_booking(%L, %L, 5, %L)', '00000000-0000-4000-8000-000000000002', public.t_item('CH-001'), 'Mrs Iyer'), 'INVENTORY_INSUFFICIENT: Only 4');
select public.t_fails(format('select public.inventory_request_booking(%L, %L, 0, %L)', '00000000-0000-4000-8000-000000000003', public.t_item('CH-001'), 'Mrs Iyer'), 'INVENTORY_INVALID');
select public.t_fails(format('select public.inventory_request_booking(%L, %L, 1, %L, %L)', '00000000-0000-4000-8000-000000000003', public.t_item('CH-001'), 'Mrs Iyer', '123'), 'INVENTORY_INVALID: That phone');
select public.t_fails(format('select public.inventory_request_booking(%L, %L, 1, %L, null, null, true)', '00000000-0000-4000-8000-000000000003', public.t_item('CH-001'), 'Mrs Iyer'), 'INVENTORY_FORBIDDEN');
select public.inventory_request_booking('00000000-0000-4000-8000-000000000004', public.t_item('CH-001'), 4, 'Mrs Iyer');

-- bookings are private to their owner and to approvers
select public.t_eq('sales2 sees only their request', (select count(*) from public.inventory_bookings), 1::bigint);
select public.t_eq('sales2 list mine', jsonb_array_length(public.inventory_bookings_list('mine')), 1);
select public.t_fails('select public.inventory_bookings_list(''all'')', 'INVENTORY_FORBIDDEN');
select public.t_fails(format('select public.inventory_decide_booking(%L, ''confirm'')', (select id from public.inventory_bookings limit 1)), 'INVENTORY_FORBIDDEN');
select public.t_reset();
select public.t_eq('fully reserved', (select qty_available from public.inventory_items where product_code = 'CH-001'), 0);

-- manager sees everything and decides
select public.t_as(public.t_id('manager'));
select public.t_eq('manager sees both requests', jsonb_array_length(public.inventory_bookings_list('all')), 2);
select public.t_eq('filter by status', jsonb_array_length(public.inventory_bookings_list('all', array['confirmed'])), 0);
select public.inventory_decide_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000001'), 'confirm');
select public.t_eq('sold 6', (select qty_sold from public.inventory_items where product_code = 'CH-001'), 6);
select public.t_eq('reserved 4', (select qty_reserved from public.inventory_items where product_code = 'CH-001'), 4);
select public.t_fails(format('select public.inventory_decide_booking(%L, ''reject'')', (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000001')), 'INVENTORY_INVALID: This request was already confirmed');

-- reject gives the units back
select public.inventory_decide_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000004'), 'reject', null, 'Not practical');
select public.t_eq('reserved back to 0', (select qty_reserved from public.inventory_items where product_code = 'CH-001'), 0);
select public.t_eq('available 4 again', (select qty_available from public.inventory_items where product_code = 'CH-001'), 4);

-- confirm with a smaller quantity: 3 asked, 2 sold, 1 back
select public.t_as(public.t_id('sales'));
select public.inventory_request_booking('00000000-0000-4000-8000-000000000005', public.t_item('CH-001'), 3, 'Mr Das');
select public.t_as(public.t_id('manager'));
select public.inventory_decide_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000005'), 'confirm', 2);
select public.t_eq('sold 8', (select qty_sold from public.inventory_items where product_code = 'CH-001'), 8);
select public.t_eq('reserved 0', (select qty_reserved from public.inventory_items where product_code = 'CH-001'), 0);
select public.t_eq('available 2', (select qty_available from public.inventory_items where product_code = 'CH-001'), 2);
select public.t_eq('booking keeps the sold quantity', (select qty from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000005'), 2);

-- a larger confirm needs free units
select public.t_as(public.t_id('sales'));
select public.inventory_request_booking('00000000-0000-4000-8000-000000000006', public.t_item('CH-001'), 2, 'Mr Sen');
select public.t_as(public.t_id('manager'));
select public.t_fails(format('select public.inventory_decide_booking(%L, ''confirm'', 5)', (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000006')), 'INVENTORY_INSUFFICIENT: Only 2');
select public.inventory_decide_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000006'), 'confirm', 2);
select public.t_eq('sold out', (select qty_available from public.inventory_items where product_code = 'CH-001'), 0);
select public.t_eq('sold 10', (select qty_sold from public.inventory_items where product_code = 'CH-001'), 10);

-- total can never go below sold + reserved
select public.t_fails(format('select public.inventory_save_item(%L, public.t_data(%L, 9), array[public.t_img(1), public.t_img(2)])', public.t_item('CH-001'), 'CH-001'), 'INVENTORY_INVALID: Total cannot be below 10');
select public.inventory_save_item(public.t_item('CH-001'), public.t_data('CH-001', 12), array[public.t_img(2), public.t_img(1)]);
select public.t_eq('picture reorder keeps both', (select array_agg(path order by position) from public.inventory_images
  where item_id = public.t_item('CH-001')), array[public.t_img(2), public.t_img(1)]);
select public.t_eq('more stock', (select qty_available from public.inventory_items where product_code = 'CH-001'), 2);

-- ═══ 6. Cancel and reverse ═══
select public.t_as(public.t_id('sales'));
select public.inventory_request_booking('00000000-0000-4000-8000-000000000007', public.t_item('CH-001'), 1, 'Mr Bose');
select public.t_as(public.t_id('sales2'));
select public.t_fails(format('select public.inventory_cancel_booking(%L)', (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000007' limit 1)), 'INVENTORY_NOT_FOUND');
select public.t_as(public.t_id('sales'));
select public.inventory_cancel_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000007'));
select public.t_reset();
select public.t_eq('cancelled releases the unit', (select qty_reserved from public.inventory_items where product_code = 'CH-001'), 0);
select public.t_as(public.t_id('sales'));
select public.t_fails(format('select public.inventory_cancel_booking(%L)', (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000001')), 'INVENTORY_FORBIDDEN');
select public.t_fails(format('select public.inventory_cancel_booking(%L)', (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000007')), 'INVENTORY_INVALID: This request is already cancelled');
select public.t_as(public.t_id('manager'));
select public.t_fails(format('select public.inventory_cancel_booking(%L)', (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000001')), 'INVENTORY_INVALID: Say why');
select public.inventory_cancel_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000001'), 'Customer withdrew');
select public.t_eq('reversed sale returns 6', (select qty_sold from public.inventory_items where product_code = 'CH-001'), 4);
select public.t_eq('available 8', (select qty_available from public.inventory_items where product_code = 'CH-001'), 8);

-- manager books and confirms in one step
select public.inventory_request_booking('00000000-0000-4000-8000-000000000008', public.t_item('CH-001'), 2, 'Walk-in', null, null, true);
select public.t_eq('confirm_now sold', (select qty_sold from public.inventory_items where product_code = 'CH-001'), 6);
select public.t_eq('confirm_now nothing reserved', (select qty_reserved from public.inventory_items where product_code = 'CH-001'), 0);

-- ═══ 7. History ═══
select public.t_eq('history has the sale story', jsonb_array_length(public.inventory_item_history(public.t_item('CH-001'))) >= 8, true);
select public.t_eq('history actions', (select bool_and(e->>'action' in ('created','updated','requested','confirmed','rejected','cancelled','reversed'))
  from jsonb_array_elements(public.inventory_item_history(public.t_item('CH-001'))) e), true);

-- ═══ 8. Delete ═══
select public.t_as(public.t_id('sales'));
select public.inventory_request_booking('00000000-0000-4000-8000-000000000009', public.t_item('SF-010'), 1, 'Mr Nair');
select public.t_as(public.t_id('manager'));
select public.t_fails(format('select public.inventory_delete_item(%L)', public.t_item('SF-010')), 'INVENTORY_INVALID: 1 booking request');
select public.inventory_decide_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000009'), 'reject');
select public.inventory_delete_item(public.t_item('SF-010'));
select public.t_eq('deleted product disappears', (select count(*) from public.inventory_items where product_code = 'SF-010'), 0::bigint);
select public.t_reset();
create temp table t_del on commit drop as select id from public.inventory_items where product_code = 'SF-010' and deleted_at is not null;
grant all on t_del to public;
select public.t_as(public.t_id('manager'));
select public.t_fails(format('select public.inventory_request_booking(%L, %L, 1, %L)', '00000000-0000-4000-8000-000000000010',
  (select id from t_del), 'x'), 'INVENTORY_NOT_FOUND');
-- the freed code can be used again, and the old booking history stays
select public.t_as(public.t_id('manager'));
select public.inventory_save_item(null, public.t_data('SF-010', 2), array[public.t_img(4)]);
select public.t_eq('code reusable after delete', (select count(*) from public.inventory_items where product_code = 'SF-010' and deleted_at is null), 1::bigint);
select public.t_reset();
select public.t_eq('old booking history kept', (select count(*) from public.inventory_bookings where request_id = '00000000-0000-4000-8000-000000000009'), 1::bigint);

-- ═══ 9. The CHECK is the last line of defence ═══
select public.t_fails('update public.inventory_items set qty_sold = qty_total + 1 where product_code = ''CH-001''', 'new row for relation "inventory_items" violates check constraint');

-- ═══ 10. Standard and retail price (20270408000000) ═══
select public.t_as(public.t_id('manager'));
select public.t_fails(format('select public.inventory_save_item(null, %L::jsonb, array[public.t_img(5)])', (public.t_data('RP-001', 1) - 'retail_price')::text), 'INVENTORY_INVALID: Enter a valid retail price');
select public.t_fails(format('select public.inventory_save_item(null, %L::jsonb, array[public.t_img(5)])', (public.t_data('RP-002', 1) || '{"retail_price": 4000}')::text), 'INVENTORY_INVALID: Retail price cannot be below the standard price');
select public.inventory_save_item(null, public.t_data('RP-003', 1) || '{"retail_price": 4500}', array[public.t_img(5)]);
select public.t_eq('retail may equal standard', (select retail_price from public.inventory_items where product_code = 'RP-003'), 4500.00::numeric);
select public.t_reset();
select public.t_fails('update public.inventory_items set retail_price = 1 where product_code = ''RP-003''', 'new row for relation "inventory_items" violates check constraint');

select 'INVENTORY SUITE PASSED' as result;
rollback;
