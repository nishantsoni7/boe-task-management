-- Inventory booking notifications (20270314000100). Run against a disposable local database with
-- 20270313000000, 20270314000000 and 20270314000100 applied:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/inventory_notifications_suite.sql
-- One transaction, rolled back. Reuses the actors of inventory_module_suite.sql (an admin and members taken from
-- public.users). now() is shared inside the transaction, so rows are found by content, never by time.

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
create function public.t_eq(p_label text, p_actual anyelement, p_expected anyelement) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then raise exception 'ASSERT % : expected %, got %', p_label, p_expected, p_actual; end if;
end $$;

create temp table t_actor (name text primary key, id uuid) on commit drop;
grant all on t_actor to public;
insert into t_actor values
  ('admin',    '11111111-1111-1111-1111-111111111111'),
  ('manager',  'd0000000-0000-4000-8000-00000000e011'),
  ('manager2', 'd0000000-0000-4000-8000-00000000e014'),
  ('sales',    'd0000000-0000-4000-8000-00000000e012'),
  ('sales2',   'd0000000-0000-4000-8000-00000000e018');
create function public.t_id(p text) returns uuid language sql as $$ select id from t_actor where name = p $$;

-- manager and manager2 hold all five; sales and sales2 only view.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select a.id, pm.id, pa.id, true, '11111111-1111-1111-1111-111111111111'
from t_actor a join public.permission_modules pm on pm.module_key = 'inventory'
join public.permission_actions pa on pa.action_key in ('view', 'create', 'edit', 'delete', 'approve')
where a.name in ('manager', 'manager2');
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select a.id, pm.id, pa.id, true, '11111111-1111-1111-1111-111111111111'
from t_actor a join public.permission_modules pm on pm.module_key = 'inventory'
join public.permission_actions pa on pa.action_key = 'view' where a.name in ('sales', 'sales2');

create temp table t_img (n int primary key, path text) on commit drop;
grant all on t_img to public;
insert into t_img select 1, public.t_id('manager')::text || '/' || gen_random_uuid()::text || '.jpg';
insert into storage.objects (bucket_id, name, owner_id) select 'inventory-images', path, public.t_id('manager')::text from t_img;

-- a product to book
select public.t_as(public.t_id('manager'));
select public.inventory_save_item(null, jsonb_build_object('product_code', 'NT-001', 'name', 'Teak chair', 'size_text', '45 cm',
  'material', 'Teak', 'price', 4500, 'retail_price', 5200, 'condition', 'new', 'stage', 'ready', 'qty_total', 20), array[(select path from t_img where n = 1)]);
select public.t_reset();

create function public.t_item() returns uuid language sql as $$ select id from public.inventory_items where product_code = 'NT-001' $$;
create function public.t_notes(p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where type = p_type::notification_type
    and entity_id in (select id from public.inventory_bookings where item_id = public.t_item()) $$;
create function public.t_told(p_type text, p_who text) returns bigint language sql as $$
  select count(*) from public.notifications where type = p_type::notification_type and user_id = public.t_id(p_who)
    and entity_id in (select id from public.inventory_bookings where item_id = public.t_item()) $$;

select public.t_eq('nothing yet', public.t_notes('inventory_booking_requested'), 0::bigint);

-- ═══ 1. A request tells every approver, and only approvers ═══
select public.t_as(public.t_id('sales'));
select public.inventory_request_booking('00000000-0000-4000-8000-0000000000a1', public.t_item(), 6, 'Hotel Sai', null, 'by month end');
select public.t_reset();
select public.t_eq('manager told', public.t_told('inventory_booking_requested', 'manager'), 1::bigint);
select public.t_eq('manager2 told', public.t_told('inventory_booking_requested', 'manager2'), 1::bigint);
select public.t_eq('admin told', public.t_told('inventory_booking_requested', 'admin'), 1::bigint);
select public.t_eq('requester not told', public.t_told('inventory_booking_requested', 'sales'), 0::bigint);
select public.t_eq('other salesperson not told', public.t_told('inventory_booking_requested', 'sales2'), 0::bigint);
select public.t_eq('every recipient is an approver', (select count(*) from public.notifications n
  where n.type = 'inventory_booking_requested' and n.entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a1')
    and not (exists (select 1 from public.users u where u.id = n.user_id and u.role = 'admin')
             or public.resolve_permission(n.user_id, 'inventory', 'approve'))), 0::bigint);
select public.t_eq('body names the facts', (select bool_and(n.body like '%6 units of Teak chair (NT-001) for Hotel Sai%' and n.body like '%Note: by month end%' and n.title = 'Booking request: 6 × Teak chair')
  from public.notifications n where n.type = 'inventory_booking_requested' and n.entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a1')), true);
select public.t_eq('written as database notifications, not task ones', (select bool_and(task_id is null and is_push_sent)
  from public.notifications where type = 'inventory_booking_requested' and entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a1')), true);

-- a retry of the same tap (replay) writes nothing more
select public.t_as(public.t_id('sales'));
select public.inventory_request_booking('00000000-0000-4000-8000-0000000000a1', public.t_item(), 6, 'Hotel Sai', null, 'by month end');
select public.t_reset();
select public.t_eq('replay adds none', public.t_told('inventory_booking_requested', 'manager'), 1::bigint);

-- a deactivated approver is not told
update public.users set is_active = false where id = public.t_id('manager2');
select public.t_as(public.t_id('sales2'));
select public.inventory_request_booking('00000000-0000-4000-8000-0000000000a2', public.t_item(), 2, 'Mrs Iyer');
select public.t_reset();
update public.users set is_active = true where id = public.t_id('manager2');
select public.t_eq('inactive approver skipped', public.t_told('inventory_booking_requested', 'manager2'), 1::bigint);
select public.t_eq('active approver told again', public.t_told('inventory_booking_requested', 'manager'), 2::bigint);

-- ═══ 2. A decision tells the salesperson ═══
select public.t_as(public.t_id('manager'));
select public.inventory_decide_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a1'), 'confirm', 5, 'advance received');
select public.inventory_decide_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a2'), 'reject', null, 'already promised');
select public.t_reset();
select public.t_eq('confirmed tells the asker', public.t_told('inventory_booking_decided', 'sales'), 1::bigint);
select public.t_eq('rejected tells the asker', public.t_told('inventory_booking_decided', 'sales2'), 1::bigint);
select public.t_eq('confirm text carries the sold quantity and the note', (select n.title || ' | ' || n.body from public.notifications n
  where n.type = 'inventory_booking_decided' and n.user_id = public.t_id('sales')
    and n.entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a1')),
  'Booking confirmed: 5 × Teak chair | ' || (select full_name from public.users where id = public.t_id('manager'))
  || ' confirmed 5 units of Teak chair (NT-001) for Hotel Sai. Note: advance received');
select public.t_eq('reject text carries the reason', (select n.body like '%Reason: already promised%' and n.title = 'Booking rejected: 2 × Teak chair'
  from public.notifications n where n.type = 'inventory_booking_decided' and n.user_id = public.t_id('sales2')), true);
select public.t_eq('approvers get no decided notice', (select count(*) from public.notifications where type = 'inventory_booking_decided'
  and user_id in (public.t_id('manager'), public.t_id('manager2'), public.t_id('admin'))
  and entity_id in (select id from public.inventory_bookings where item_id = public.t_item())), 0::bigint);

-- reversing a confirmed sale tells the asker
select public.t_as(public.t_id('manager'));
select public.inventory_cancel_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a1'), 'customer withdrew');
select public.t_reset();
select public.t_eq('reversal told', public.t_told('inventory_booking_decided', 'sales'), 2::bigint);
select public.t_eq('reversal wording', (select count(*) from public.notifications n where n.type = 'inventory_booking_decided' and n.user_id = public.t_id('sales')
  and n.title = 'Sale reversed: 5 × Teak chair' and n.body like '%reversed the booking%Reason: customer withdrew%'), 1::bigint);

-- ═══ 3. Nobody is told about their own actions ═══
-- withdrawing your own request
select public.t_as(public.t_id('sales'));
select public.inventory_request_booking('00000000-0000-4000-8000-0000000000a3', public.t_item(), 1, 'Mr Das');
select public.t_reset();
select public.t_eq('request #3 told exactly the approvers', (select count(*) from public.notifications where type = 'inventory_booking_requested'
  and entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a3')),
  (select count(*) from public.users u where u.is_active and not coalesce(u.is_deleted, false) and u.id <> public.t_id('sales')
    and (u.role = 'admin' or public.resolve_permission(u.id, 'inventory', 'approve'))));
select public.t_as(public.t_id('sales'));
select public.inventory_cancel_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a3'));
select public.t_reset();
select public.t_eq('withdrawing your own request tells the asker nothing', public.t_told('inventory_booking_decided', 'sales'), 2::bigint);
select public.t_eq('and nobody else', (select count(*) from public.notifications where type = 'inventory_booking_decided'
  and entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a3')), 0::bigint);

-- a manager's own confirm-now sale tells nobody
select public.t_as(public.t_id('manager'));
select public.inventory_request_booking('00000000-0000-4000-8000-0000000000a4', public.t_item(), 1, 'Walk-in', null, null, true);
select public.t_reset();
select public.t_eq('confirm-now writes nothing', (select count(*) from public.notifications
  where entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a4')), 0::bigint);

-- an approver who asks (without confirming) is not told about their own request; the other approvers are
select public.t_as(public.t_id('manager'));
select public.inventory_request_booking('00000000-0000-4000-8000-0000000000a6', public.t_item(), 1, 'Own ask');
select public.t_reset();
select public.t_eq('the asking manager is not told', (select count(*) from public.notifications where type = 'inventory_booking_requested'
  and user_id = public.t_id('manager') and entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a6')), 0::bigint);
select public.t_eq('the other approvers are', (select count(*) from public.notifications where type = 'inventory_booking_requested'
  and user_id = public.t_id('manager2') and entity_id = (select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a6')), 1::bigint);

-- a manager cancelling someone else's PENDING request tells them
select public.t_as(public.t_id('sales2'));
select public.inventory_request_booking('00000000-0000-4000-8000-0000000000a5', public.t_item(), 1, 'Ms Rao');
select public.t_as(public.t_id('manager'));
select public.inventory_cancel_booking((select id from public.inventory_bookings where request_id = '00000000-0000-4000-8000-0000000000a5'), 'duplicate');
select public.t_reset();
select public.t_eq('cancelled by a manager tells the asker', (select count(*) from public.notifications n
  where n.type = 'inventory_booking_decided' and n.user_id = public.t_id('sales2') and n.title = 'Booking cancelled: 1 × Teak chair'), 1::bigint);

-- Who may READ a notification is the notifications table's own policy (production: "Users can see own notifications",
-- auth.uid() = user_id). A local replay does not have that policy, so it is not asserted here.

select 'INVENTORY NOTIFICATIONS SUITE PASSED' as result;
rollback;
