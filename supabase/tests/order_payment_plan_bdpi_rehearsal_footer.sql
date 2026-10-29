-- Rehearsal checks for 20270503000000 (old orders kept as BDPI). Everything rolls back.
--   node scripts/dev/rehearse-migration.mjs supabase/migrations/20270503000000_order_payment_plan_bdpi.sql supabase/tests/order_payment_plan_bdpi_rehearsal_footer.sql <out.sql>
--   supabase db query --linked --file <out.sql>     (last row must be REHEARSAL OK)

create temp table zz_ctx (admin_id uuid, lots_before int);
grant select on zz_ctx to authenticated;
insert into zz_ctx
select (select u.id from public.users u where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false order by u.created_at limit 1),
       (select count(*) from public.order_dispatch_lots);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select admin_id from zz_ctx), 'role', 'authenticated')::text, true);

do $$
declare
  c zz_ctx%rowtype;
  r jsonb;
  b uuid;
  v_msg text;
begin
  select * into c from zz_ctx;
  if c.admin_id is null then raise exception 'REHEARSAL: no admin'; end if;

  r := public.create_bdpi(jsonb_build_object(
    'old_order_no', 'zz rehearsal 1', 'client_name', 'Rehearsal Client', 'fabric_responsibility', 'boe',
    'commercial', jsonb_build_object('total_before_gst', 24000, 'gst_amount', 4320, 'grand_total', 28320),
    'items', jsonb_build_array(
      jsonb_build_object('item_sequence', 'B1', 'product_name', 'Sofa', 'quantity', 10, 'rate', 1000,
                         'finish_specs', jsonb_build_array(jsonb_build_object('heading', 'Fabric', 'value', 'Velvet'))),
      jsonb_build_object('item_sequence', 'B2', 'product_name', 'Chair', 'quantity', 20, 'rate', 500))));
  b := (r ->> 'id')::uuid;
  if r ->> 'bdpi_no' not like 'BDPI-%' then raise exception 'REHEARSAL: no BDPI number'; end if;

  r := public.bdpi_payment_plan_read(b);
  if r ->> 'kind' <> 'bdpi' or r -> 'order' ->> 'old_order_no' <> 'ZZ REHEARSAL 1' then raise exception 'REHEARSAL: read wrong %', r -> 'order'; end if;
  if jsonb_array_length(r -> 'items') <> 2 or r -> 'items' -> 0 -> 'finish_specs' -> 0 ->> 'value' <> 'Velvet' then
    raise exception 'REHEARSAL: lines or details missing';
  end if;
  if r -> 'finance' -> 'account_verified' is null then raise exception 'REHEARSAL: no finance block'; end if;

  perform public.bdpi_payment_plan_save(b, 50, 50, null, null, 'rehearsal');
  perform public.bdpi_dispatch_lot_save(b, '[{"item_sequence":"B1","quantity":10}]'::jsonb, null);
  perform public.bdpi_dispatch_lot_mark_dispatched(b, current_date);
  begin
    perform public.bdpi_dispatch_lot_save(b, '[{"item_sequence":"B1","quantity":1}]'::jsonb, null);
    raise exception 'REHEARSAL: over-ordering unexpectedly succeeded';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'DISPATCH_QUANTITY_EXCEEDS_ORDER%' then raise exception 'REHEARSAL: wrong refusal %', v_msg; end if;
  end;
  r := public.bdpi_payment_plan_read(b);
  if r -> 'lots' -> 0 ->> 'status' <> 'dispatched' then raise exception 'REHEARSAL: lot not dispatched'; end if;
  if jsonb_array_length(public.bdpi_list()) < 1 then raise exception 'REHEARSAL: list empty'; end if;

  begin
    perform public.delete_bdpi(b, 'rehearsal delete attempt');
    raise exception 'REHEARSAL: delete with dispatches unexpectedly succeeded';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'BDPI_HAS_DISPATCHES%' then raise exception 'REHEARSAL: wrong delete refusal %', v_msg; end if;
  end;
end $$;

do $$
begin
  begin
    perform 1 from public.bdpi_records;
    raise exception 'REHEARSAL: bdpi_records readable by a client role';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- every Order lot that existed is still an Order lot
do $$
declare c zz_ctx%rowtype;
begin
  select * into c from zz_ctx;
  if (select count(*) from public.order_dispatch_lots where order_id is not null) <> c.lots_before then
    raise exception 'REHEARSAL: existing Order lots changed';
  end if;
end $$;

select 'REHEARSAL OK' as result;
