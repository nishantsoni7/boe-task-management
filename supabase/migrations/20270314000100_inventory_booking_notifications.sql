-- Inventory: tell the right people when a booking request is made or decided.
--
-- WHO IS TOLD
--   A new PENDING request     every active approver (Admin role, or inventory:approve) except the requester.
--   Confirmed / rejected      the salesperson who asked, unless they decided it themselves.
--   Cancelled by someone else the salesperson (a manager cancelling their pending request, or reversing a
--                             confirmed sale). Withdrawing your own request tells nobody: the approvers already
--                             see it leave the queue.
--   A manager's own "confirm now" sale tells nobody (they are both asker and decider).
--
-- HOW. An AFTER trigger on inventory_bookings, in the SAME transaction as the change, so a notification can
-- neither be missing for a request that exists nor exist for one that was rolled back. The booking functions
-- of 20270313000000 are not touched. The trigger sits on inventory_bookings, not on notifications, and calls
-- nothing outside the database. It writes only the two types added by 20270314000000 (apply that first).
--
-- entity_id carries the BOOKING id; the link opens Booking Requests (approvers) or My Requests (salesperson).
-- is_push_sent is true, as for every other database-written notification: the row is the notification, there
-- is no push to send.
--
-- ROLLBACK: drop trigger inventory_bookings_notify on public.inventory_bookings; drop function
-- public.inventory_booking_notify(); the notifications already written stay readable.

do $$
begin
  if to_regclass('public.inventory_bookings') is null
     or to_regclass('public.notifications') is null
     or to_regprocedure('public.resolve_permission(uuid,text,text)') is null
     or not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                    where t.typname = 'notification_type' and e.enumlabel = 'inventory_booking_decided') then
    raise exception 'DEPENDENCY MISSING: 20270313000000 and 20270314000000 must be applied first';
  end if;
end $$;

create or replace function public.inventory_booking_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   public.inventory_items;
  v_who    text;
  v_title  text;
  v_body   text;
  v_units  text := new.qty::text || case when new.qty = 1 then ' unit' else ' units' end;
begin
  select * into v_item from public.inventory_items where id = new.item_id;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then return new; end if;
    select u.full_name into v_who from public.users u where u.id = new.requested_by;
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select u.id, null, new.id, 'inventory_booking_requested'::notification_type,
           format('Booking request: %s × %s', new.qty, v_item.name),
           format('%s asks to book %s of %s (%s) for %s.%s',
                  coalesce(v_who, 'A salesperson'), v_units, v_item.name, v_item.product_code, new.customer_name,
                  coalesce(' Note: ' || new.note, '')),
           true
      from public.users u
     where u.is_active and not coalesce(u.is_deleted, false)
       and u.id <> new.requested_by
       and (u.role = 'admin' or public.resolve_permission(u.id, 'inventory', 'approve'));
    return new;
  end if;

  -- UPDATE of status
  if old.status is not distinct from new.status then return new; end if;
  if new.decided_by is null or new.decided_by = new.requested_by then return new; end if;

  select u.full_name into v_who from public.users u where u.id = new.decided_by;
  if new.status = 'confirmed' and old.status = 'pending' then
    v_title := format('Booking confirmed: %s × %s', new.qty, v_item.name);
    v_body  := format('%s confirmed %s of %s (%s) for %s.%s', coalesce(v_who, 'The manager'), v_units, v_item.name,
                      v_item.product_code, new.customer_name, coalesce(' Note: ' || new.decision_note, ''));
  elsif new.status = 'rejected' and old.status = 'pending' then
    v_title := format('Booking rejected: %s × %s', new.qty, v_item.name);
    v_body  := format('%s did not accept the request for %s of %s (%s) for %s. The units are free again.%s',
                      coalesce(v_who, 'The manager'), v_units, v_item.name, v_item.product_code, new.customer_name,
                      coalesce(' Reason: ' || new.decision_note, ''));
  elsif new.status = 'cancelled' then
    v_title := case when old.status = 'confirmed' then format('Sale reversed: %s × %s', new.qty, v_item.name)
                    else format('Booking cancelled: %s × %s', new.qty, v_item.name) end;
    v_body  := format('%s %s the booking of %s of %s (%s) for %s.%s', coalesce(v_who, 'The manager'),
                      case when old.status = 'confirmed' then 'reversed' else 'cancelled' end,
                      v_units, v_item.name, v_item.product_code, new.customer_name,
                      coalesce(' Reason: ' || new.decision_note, ''));
  else
    return new;
  end if;

  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select u.id, null, new.id, 'inventory_booking_decided'::notification_type, v_title, v_body, true
    from public.users u
   where u.id = new.requested_by and u.is_active and not coalesce(u.is_deleted, false);
  return new;
end;
$$;

revoke all on function public.inventory_booking_notify() from public, anon, authenticated;

drop trigger if exists inventory_bookings_notify on public.inventory_bookings;
create trigger inventory_bookings_notify
  after insert or update of status on public.inventory_bookings
  for each row execute function public.inventory_booking_notify();
