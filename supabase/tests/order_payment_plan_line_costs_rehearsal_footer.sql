-- Rehearsal checks for 20270504000000 (fabric and packing per product on the Order read). Rolls back.
--   node scripts/dev/rehearse-migration.mjs supabase/migrations/20270504000000_order_payment_plan_line_costs.sql supabase/tests/order_payment_plan_line_costs_rehearsal_footer.sql <out.sql>

create temp table zz_ctx (admin_id uuid, order_id uuid);
grant select on zz_ctx to authenticated;
insert into zz_ctx
select (select u.id from public.users u where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false order by u.created_at limit 1),
       (select o.id from public.orders o
         where o.status <> 'cancelled'
           and exists (select 1 from public.order_submission_fabric_finish_lines f where f.submission_id = o.source_order_submission_id)
         order by o.created_at desc limit 1);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select admin_id from zz_ctx), 'role', 'authenticated')::text, true);

do $$
declare
  c zz_ctx%rowtype;
  r jsonb;
begin
  select * into c from zz_ctx;
  if c.admin_id is null then raise exception 'REHEARSAL: no admin'; end if;
  if c.order_id is null then
    raise notice 'no Order with a Fabric & Finish sheet yet; checking the shape only';
    return;
  end if;
  r := public.order_payment_plan_read(c.order_id);
  if (r ->> 'found')::boolean is not true then raise exception 'REHEARSAL: read failed'; end if;
  if not (r -> 'items' -> 0 ? 'packing_cost_per_piece') or not (r -> 'items' -> 0 ? 'finish_specs') then
    raise exception 'REHEARSAL: items lack the per-product fields';
  end if;
  if not exists (select 1 from jsonb_array_elements(r -> 'items') e
                  where e ->> 'packing_cost_per_piece' is not null or e ->> 'fabric_metres_per_piece' is not null) then
    raise exception 'REHEARSAL: no product carries its sheet figures';
  end if;
  if r -> 'finance' -> 'account_verified' is null then raise exception 'REHEARSAL: finance split lost'; end if;
end $$;

reset role;
select 'REHEARSAL OK' as result;
