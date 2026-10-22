-- Inventory: two prices per product.
--   price         = STANDARD price: the product with basic packaging (the existing column, unchanged).
--   retail_price  = RETAIL price: inclusive of taxes, transportation and packaging; never below the standard price.
-- Existing products start with retail_price = price; the manager edits each one. Rollback: drop the column and
-- re-create inventory_save_item / inventory_bookings_list from 20270313000000.

alter table public.inventory_items add column if not exists retail_price numeric(12,2);
update public.inventory_items set retail_price = price where retail_price is null;
alter table public.inventory_items alter column retail_price set not null;
alter table public.inventory_items drop constraint if exists inventory_items_retail_price_check;
alter table public.inventory_items add constraint inventory_items_retail_price_check check (retail_price >= price);

-- Create (p_item_id null) or change a product. p_images is the FULL ordered list (1–8 paths, first = thumbnail).
-- p_data keys: product_code, name, category, size_text, material, description, price (standard), retail_price, condition, stage,
-- qty_total, ready_in_days (whole days from today; null clears; absent on an edit leaves it alone).
create or replace function public.inventory_save_item(p_item_id uuid, p_data jsonb, p_images text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a        record;
  v_old    public.inventory_items;
  v_id     uuid;
  v_code   text := upper(btrim(coalesce(p_data->>'product_code', '')));
  v_name   text := btrim(coalesce(p_data->>'name', ''));
  v_cat    text := nullif(btrim(coalesce(p_data->>'category', '')), '');
  v_size   text := btrim(coalesce(p_data->>'size_text', ''));
  v_mat    text := btrim(coalesce(p_data->>'material', ''));
  v_desc   text := nullif(btrim(coalesce(p_data->>'description', '')), '');
  v_price  numeric;
  v_retail numeric;
  v_qty    integer;
  v_cond   text := p_data->>'condition';
  v_stage  text := p_data->>'stage';
  v_ready  date;
  v_days   integer;
  v_path   text;
  v_pos    integer := 0;
  v_fields text[] := '{}';
begin
  select * into a from public.inventory_actor();
  if p_item_id is null and not a.p_create then
    raise exception 'INVENTORY_FORBIDDEN: You cannot add products' using errcode = '42501';
  elsif p_item_id is not null and not a.p_edit then
    raise exception 'INVENTORY_FORBIDDEN: You cannot change products' using errcode = '42501';
  end if;

  if v_code !~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$' then
    raise exception 'INVENTORY_INVALID: Product code: letters, digits and . _ / - only (up to 40)' using errcode = '22023';
  end if;
  if v_name = '' or length(v_name) > 120 then raise exception 'INVENTORY_INVALID: Product name is required' using errcode = '22023'; end if;
  if v_size = '' or length(v_size) > 120 then raise exception 'INVENTORY_INVALID: Size is required' using errcode = '22023'; end if;
  if v_mat = '' or length(v_mat) > 120 then raise exception 'INVENTORY_INVALID: Material is required' using errcode = '22023'; end if;
  if v_cat is not null and length(v_cat) > 60 then raise exception 'INVENTORY_INVALID: Category is too long' using errcode = '22023'; end if;
  if v_desc is not null and length(v_desc) > 1000 then raise exception 'INVENTORY_INVALID: Notes are too long' using errcode = '22023'; end if;
  if v_cond not in ('new', 'refurbished', 'needs_repair', 'antique') then
    raise exception 'INVENTORY_INVALID: Choose the condition' using errcode = '22023';
  end if;
  if v_stage not in ('raw', 'in_production', 'finishing', 'awaiting_upholstery', 'under_repair', 'ready') then
    raise exception 'INVENTORY_INVALID: Choose the stage' using errcode = '22023';
  end if;
  begin
    v_price := (p_data->>'price')::numeric;
    v_retail := (p_data->>'retail_price')::numeric;
    v_qty := (p_data->>'qty_total')::integer;
  exception when others then
    raise exception 'INVENTORY_INVALID: Prices and quantity must be numbers' using errcode = '22023';
  end;
  if v_price is null or v_price < 0 or v_price > 9999999999 then raise exception 'INVENTORY_INVALID: Enter a valid standard price' using errcode = '22023'; end if;
  if v_retail is null or v_retail < 0 or v_retail > 9999999999 then raise exception 'INVENTORY_INVALID: Enter a valid retail price' using errcode = '22023'; end if;
  if v_retail < v_price then raise exception 'INVENTORY_INVALID: Retail price cannot be below the standard price' using errcode = '22023'; end if;
  if v_qty is null or v_qty < 0 or v_qty > 100000 then raise exception 'INVENTORY_INVALID: Enter a valid quantity' using errcode = '22023'; end if;
  if coalesce(array_length(p_images, 1), 0) not between 1 and 8 then
    raise exception 'INVENTORY_INVALID: Add between 1 and 8 pictures' using errcode = '22023';
  end if;
  if (select count(distinct x) from unnest(p_images) x) <> array_length(p_images, 1) then
    raise exception 'INVENTORY_INVALID: The same picture is listed twice' using errcode = '22023';
  end if;

  if p_data ? 'ready_in_days' and p_data->>'ready_in_days' is not null then
    begin v_days := (p_data->>'ready_in_days')::integer;
    exception when others then raise exception 'INVENTORY_INVALID: Days must be a whole number' using errcode = '22023'; end;
    if v_days < 0 or v_days > 1000 then raise exception 'INVENTORY_INVALID: Days must be between 0 and 1000' using errcode = '22023'; end if;
    v_ready := (now() at time zone 'Asia/Kolkata')::date + v_days;
  end if;
  if v_stage = 'ready' then v_ready := null; end if;

  if p_item_id is null then
    if exists (select 1 from public.inventory_items where product_code = v_code and deleted_at is null) then
      raise exception 'INVENTORY_DUPLICATE_CODE: % is already used by another product', v_code using errcode = '23505';
    end if;
    v_id := gen_random_uuid();
  else
    select * into v_old from public.inventory_items where id = p_item_id and deleted_at is null for update;
    if not found then raise exception 'INVENTORY_NOT_FOUND: That product no longer exists' using errcode = 'P0002'; end if;
    v_id := v_old.id;
    if exists (select 1 from public.inventory_items where product_code = v_code and deleted_at is null and id <> v_id) then
      raise exception 'INVENTORY_DUPLICATE_CODE: % is already used by another product', v_code using errcode = '23505';
    end if;
    if v_qty < v_old.qty_sold + v_old.qty_reserved then
      raise exception 'INVENTORY_INVALID: Total cannot be below % (already sold or reserved)', v_old.qty_sold + v_old.qty_reserved
        using errcode = '22023';
    end if;
    if not (p_data ? 'ready_in_days') then v_ready := case when v_stage = 'ready' then null else v_old.expected_ready_on end; end if;
  end if;

  -- Every picture must be on the bucket, uploaded by the caller (or already on this product), and not another product's.
  foreach v_path in array p_images loop
    if v_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
      raise exception 'INVENTORY_INVALID: A picture path is not valid' using errcode = '22023';
    end if;
    if exists (select 1 from public.inventory_images i where i.path = v_path and i.item_id <> v_id) then
      raise exception 'INVENTORY_INVALID: A picture already belongs to another product' using errcode = '22023';
    end if;
    if not exists (select 1 from public.inventory_images i where i.path = v_path and i.item_id = v_id)
       and not exists (select 1 from storage.objects o
                       where o.bucket_id = 'inventory-images' and o.name = v_path
                         and (o.owner_id = a.p_uid::text or a.p_admin)) then
      raise exception 'INVENTORY_INVALID: A picture has not finished uploading' using errcode = '22023';
    end if;
  end loop;

  if p_item_id is null then
    insert into public.inventory_items
      (id, product_code, name, category, size_text, material, description, price, retail_price, condition, stage,
       expected_ready_on, qty_total, created_by, updated_by)
    values
      (v_id, v_code, v_name, v_cat, v_size, v_mat, v_desc, v_price, v_retail, v_cond, v_stage,
       v_ready, v_qty, a.p_uid, a.p_uid);
  else
    if v_old.product_code is distinct from v_code then v_fields := array_append(v_fields, 'product_code'::text); end if;
    if v_old.name is distinct from v_name then v_fields := array_append(v_fields, 'name'::text); end if;
    if v_old.category is distinct from v_cat then v_fields := array_append(v_fields, 'category'::text); end if;
    if v_old.size_text is distinct from v_size then v_fields := array_append(v_fields, 'size'::text); end if;
    if v_old.material is distinct from v_mat then v_fields := array_append(v_fields, 'material'::text); end if;
    if v_old.description is distinct from v_desc then v_fields := array_append(v_fields, 'notes'::text); end if;
    if v_old.price is distinct from v_price then v_fields := array_append(v_fields, 'standard price'::text); end if;
    if v_old.retail_price is distinct from v_retail then v_fields := array_append(v_fields, 'retail price'::text); end if;
    if v_old.condition is distinct from v_cond then v_fields := array_append(v_fields, 'condition'::text); end if;
    if v_old.stage is distinct from v_stage then v_fields := array_append(v_fields, 'stage'::text); end if;
    if v_old.expected_ready_on is distinct from v_ready then v_fields := array_append(v_fields, 'ready date'::text); end if;
    if v_old.qty_total is distinct from v_qty then v_fields := array_append(v_fields, 'quantity'::text); end if;
    if array(select i.path from public.inventory_images i where i.item_id = v_id order by i.position) is distinct from p_images then
      v_fields := array_append(v_fields, 'pictures'::text);
    end if;
    update public.inventory_items set
      product_code = v_code, name = v_name, category = v_cat, size_text = v_size, material = v_mat,
      description = v_desc, price = v_price, retail_price = v_retail, condition = v_cond, stage = v_stage,
      expected_ready_on = v_ready, qty_total = v_qty, updated_by = a.p_uid
    where id = v_id;
  end if;

  -- Replace the picture list: free the positions first so the reorder cannot trip the unique constraint.
  delete from public.inventory_images where item_id = v_id and not (path = any (p_images));
  update public.inventory_images set position = position + 100 where item_id = v_id;
  foreach v_path in array p_images loop
    insert into public.inventory_images (item_id, path, position) values (v_id, v_path, v_pos)
    on conflict (path) do update set position = excluded.position;
    v_pos := v_pos + 1;
  end loop;

  if p_item_id is null then
    insert into public.inventory_events (item_id, actor_id, action, detail)
    values (v_id, a.p_uid, 'created', jsonb_build_object('product_code', v_code, 'qty_total', v_qty));
  elsif cardinality(v_fields) > 0 then
    insert into public.inventory_events (item_id, actor_id, action, detail)
    values (v_id, a.p_uid, 'updated', jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
  return jsonb_build_object('id', v_id, 'product_code', v_code);
end;
$$;
revoke all on function public.inventory_save_item(uuid, jsonb, text[]) from public, anon;
grant execute on function public.inventory_save_item(uuid, jsonb, text[]) to authenticated;

-- 'all' = everyone's (approvers only). p_item_id narrows to one product.
create or replace function public.inventory_bookings_list(
  p_scope text default 'mine', p_statuses text[] default null, p_item_id uuid default null, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.inventory_actor();
  if p_scope not in ('mine', 'all') then raise exception 'INVENTORY_INVALID: Unknown scope' using errcode = '22023'; end if;
  if p_scope = 'all' and not a.p_approve then
    raise exception 'INVENTORY_FORBIDDEN: You cannot see everyone''s requests' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(r)::jsonb order by r.requested_at desc)
    from (
      select b.id, b.item_id, i.product_code, i.name as item_name, i.price, i.retail_price,
             (select g.path from public.inventory_images g where g.item_id = i.id order by g.position limit 1) as thumb_path,
             b.qty, b.customer_name, b.customer_phone, b.note, b.status,
             b.requested_by, ru.full_name as requester_name, b.requested_at,
             b.decided_by, du.full_name as decider_name, b.decided_at, b.decision_note,
             i.qty_available as item_available
      from public.inventory_bookings b
      join public.inventory_items i on i.id = b.item_id
      join public.users ru on ru.id = b.requested_by
      left join public.users du on du.id = b.decided_by
      where (p_scope = 'all' or b.requested_by = a.p_uid)
        and (p_statuses is null or b.status = any (p_statuses))
        and (p_item_id is null or b.item_id = p_item_id)
      order by b.requested_at desc
      limit least(greatest(coalesce(p_limit, 200), 1), 500)
    ) r
  ), '[]'::jsonb);
end;
$$;
