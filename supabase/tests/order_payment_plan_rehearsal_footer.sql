-- Rehearsal checks for the Orders Payment plan (20270428000000, and since
-- 20270430000000 the account / cash split and the 6-argument save).
--
-- HOW TO USE (everything is rolled back; nothing remains):
--   node scripts/dev/rehearse-migration.mjs supabase/migrations/20270428000000_order_payment_plan.sql supabase/tests/order_payment_plan_rehearsal_footer.sql <out.sql>
--   then:  supabase db query --linked --file <out.sql>   (Windows path, MSYS_NO_PATHCONV=1)
-- The last row printed must be REHEARSAL OK.

create temp table zz_ctx (admin_id uuid, order_id uuid, seq text, qty numeric, before_row text);
grant select on zz_ctx to authenticated;
insert into zz_ctx
select (select u.id from public.users u where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false order by u.created_at limit 1),
       o.id, i.item_sequence, i.quantity, md5(o::text)
  from public.orders o
  join public.order_submission_items i on i.submission_id = o.source_order_submission_id
 where o.status <> 'cancelled' and i.item_sequence is not null and i.quantity >= 1
 order by o.created_at desc limit 1;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select admin_id from zz_ctx), 'role', 'authenticated')::text, true);

do $$
declare
  c zz_ctx%rowtype;
  r jsonb;
  lot uuid;
  v_msg text;
begin
  select * into c from zz_ctx;
  if c.admin_id is null or c.order_id is null then raise exception 'REHEARSAL: no admin or no Order with a PI line found'; end if;

  r := public.order_payment_plan_read(c.order_id);
  if (r ->> 'found')::boolean is not true or (r ->> 'has_pi')::boolean is not true then raise exception 'REHEARSAL: read did not find the PI'; end if;
  if jsonb_array_length(r -> 'items') < 1 then raise exception 'REHEARSAL: no items'; end if;
  if r -> 'finance' is null then raise exception 'REHEARSAL: no finance block'; end if;

  if r -> 'finance' -> 'account_verified' is null or r -> 'finance' -> 'cash_verified' is null then
    raise exception 'REHEARSAL: no account / cash split';
  end if;
  if ((r -> 'finance' ->> 'account_verified')::numeric + (r -> 'finance' ->> 'cash_verified')::numeric)
     <> (r -> 'finance' ->> 'verified')::numeric then
    raise exception 'REHEARSAL: account + cash does not equal the verified total';
  end if;

  perform public.order_payment_plan_save(c.order_id, 50, null, 1234.50, 10, 'rehearsal');
  r := public.order_payment_plan_read(c.order_id);
  if (r -> 'plan' ->> 'advance_account_override')::numeric <> 1234.50
     or (r -> 'plan' ->> 'advance_cash_override')::numeric <> 10 then
    raise exception 'REHEARSAL: plan not saved';
  end if;

  lot := public.order_dispatch_lot_save(c.order_id,
           jsonb_build_array(jsonb_build_object('item_sequence', c.seq, 'quantity', 1)), null);
  r := public.order_payment_plan_read(c.order_id);
  if jsonb_array_length(r -> 'lots') <> 1 or r -> 'lots' -> 0 ->> 'status' <> 'planned' then raise exception 'REHEARSAL: lot not planned'; end if;

  begin
    perform public.order_dispatch_lot_save(c.order_id,
      jsonb_build_array(jsonb_build_object('item_sequence', c.seq, 'quantity', c.qty + 1)), null);
    raise exception 'REHEARSAL: over-ordering unexpectedly succeeded';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'DISPATCH_QUANTITY_EXCEEDS_ORDER%' then raise exception 'REHEARSAL: wrong refusal %', v_msg; end if;
  end;

  perform public.order_dispatch_lot_mark_dispatched(c.order_id, current_date);
  r := public.order_payment_plan_read(c.order_id);
  if r -> 'lots' -> 0 ->> 'status' <> 'dispatched' then raise exception 'REHEARSAL: lot not dispatched'; end if;

  perform public.order_dispatch_lot_admin_change((r -> 'lots' -> 0 ->> 'id')::uuid, 'Rehearsal correction of a lot',
    jsonb_build_array(jsonb_build_object('item_sequence', c.seq, 'quantity', 1)), null);
end $$;

-- a client role can read none of the tables
do $$
begin
  begin
    perform 1 from public.order_dispatch_lots;
    raise exception 'REHEARSAL: lots table readable by a client role';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- the Order itself was never touched
do $$
declare c zz_ctx%rowtype; now_row text;
begin
  select * into c from zz_ctx;
  select md5(o::text) into now_row from public.orders o where o.id = c.order_id;
  if now_row is distinct from c.before_row then raise exception 'REHEARSAL: the Order row changed'; end if;
end $$;

select 'REHEARSAL OK' as result;
