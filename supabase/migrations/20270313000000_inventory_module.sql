-- Inventory: stock that is for sale, the stage each piece has reached, and a booking request flow.
--
-- WHO DOES WHAT (all through Control Center → Permissions → Inventory; nobody is granted anything here)
--   view     open the module, see every product, ask to book stock, see and cancel their OWN requests.
--   create   add a product.                     (the Manager)
--   edit     change a product.                  (the Manager)
--   delete   remove a product.                  (the Manager)
--   approve  see EVERY booking request, confirm / reject / reverse them.   (the Manager)
-- Admin (role) holds all five. Every write goes through a SECURITY DEFINER function below that re-checks the
-- caller; the tables themselves refuse direct writes, and carry the module_entry_open('inventory') gate.
--
-- THE NUMBERS
--   qty_total      every unit of this product ever put into stock.
--   qty_reserved   units held by PENDING booking requests (nobody else can book them).
--   qty_sold       units of CONFIRMED bookings.
--   qty_available  = qty_total - qty_sold - qty_reserved, computed by the database, never typed.
-- A request reserves its units the moment it is made, so two salespeople cannot promise the same chairs.
-- Confirm moves reserved → sold. Reject / cancel gives them back. Reversing a confirmed booking (approvers
-- only) gives sold units back. The CHECK qty_sold + qty_reserved <= qty_total makes an oversell impossible
-- even if a function were wrong.
--
-- STAGE AND LEAD TIME
--   stage is one of raw → in_production → finishing → awaiting_upholstery → under_repair → ready.
--   expected_ready_on is the date the manager expects it to be ready (NULL when stage is 'ready'); the
--   screens show it as "ready in about N days".
--
-- IMAGES live in the public bucket 'inventory-images' (a client must be able to open the picture from a
-- WhatsApp message). Paths are '{uploader uuid}/{uuid}.jpg' — unguessable and carrying no price or customer.
-- The first image (position 0) is the thumbnail.
--
-- DELETE is a soft delete (deleted_at). A product with pending requests cannot be deleted. The product code
-- is unique among live products only, so a deleted code can be used again; its bookings keep the history.
--
-- ROLLBACK: drop the four tables and the inventory_* functions, delete the storage policies named
-- inventory_images_*, empty and delete the bucket, and delete the app_modules / permission_modules /
-- module_permission_actions / role_permissions rows for module_key = 'inventory'.

do $$
begin
  if to_regclass('public.users') is null
     or to_regprocedure('public.module_entry_open(text)') is null
     or to_regprocedure('public.resolve_permission(uuid,text,text)') is null
     or to_regprocedure('public.set_updated_at()') is null
     or to_regprocedure('public.normalize_lead_phone(text)') is null then
    raise exception 'DEPENDENCY MISSING: users, module_entry_open, resolve_permission, set_updated_at and normalize_lead_phone must exist';
  end if;
end $$;

-- ═══ 1. Control Center registration (mirrors src/lib/permissions/modules.ts) ═══════════════════════════

insert into public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
values
  ('inventory', 'Inventory',
   'Furniture stock for sale: stage, condition, availability and booking requests.',
   '/inventory', 'live', null, 110)
on conflict (module_key) do nothing;

insert into public.permission_modules (module_key, display_name, description) values
  ('inventory', 'Inventory',
   'Furniture stock for sale: stage, condition, availability and booking requests.')
on conflict (module_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view', 'create', 'edit', 'delete', 'approve')
where pm.module_key = 'inventory'
on conflict (module_id, action_id) do nothing;

insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'inventory'
on conflict (role, module_id, action_id) do nothing;

-- ═══ 2. Tables ══════════════════════════════════════════════════════════════════════════════════════════

create table public.inventory_items (
  id               uuid primary key default gen_random_uuid(),
  product_code     text not null check (product_code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  name             text not null check (length(btrim(name)) between 1 and 120),
  category         text check (category is null or length(btrim(category)) between 1 and 60),
  size_text        text not null check (length(btrim(size_text)) between 1 and 120),
  material         text not null check (length(btrim(material)) between 1 and 120),
  description      text check (description is null or length(description) <= 1000),
  price            numeric(12,2) not null check (price >= 0),
  condition        text not null check (condition in ('new', 'refurbished', 'needs_repair', 'antique')),
  stage            text not null check (stage in (
                     'raw', 'in_production', 'finishing', 'awaiting_upholstery', 'under_repair', 'ready')),
  expected_ready_on date,
  qty_total        integer not null check (qty_total between 0 and 100000),
  qty_reserved     integer not null default 0 check (qty_reserved >= 0),
  qty_sold         integer not null default 0 check (qty_sold >= 0),
  qty_available    integer generated always as (qty_total - qty_sold - qty_reserved) stored,
  created_by       uuid references public.users(id),
  updated_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  deleted_by       uuid references public.users(id),
  constraint inventory_items_no_oversell check (qty_sold + qty_reserved <= qty_total),
  constraint inventory_items_ready_has_no_date check (stage <> 'ready' or expected_ready_on is null)
);

create unique index inventory_items_code_live on public.inventory_items (product_code) where deleted_at is null;
create index inventory_items_live_idx on public.inventory_items (stage, condition) where deleted_at is null;

create trigger inventory_items_set_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();

create table public.inventory_images (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.inventory_items(id) on delete cascade,
  path       text not null unique check (path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
  position   integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (item_id, position) deferrable initially immediate
);

create table public.inventory_bookings (
  id             uuid primary key default gen_random_uuid(),
  -- Minted by the form; a retry of one tap returns the first row instead of a second reservation.
  request_id     uuid not null unique,
  item_id        uuid not null references public.inventory_items(id),
  qty            integer not null check (qty between 1 and 100000),
  customer_name  text not null check (length(btrim(customer_name)) between 1 and 120),
  customer_phone text check (customer_phone is null or customer_phone ~ '^\+[1-9][0-9]{7,14}$'),
  note           text check (note is null or length(note) <= 500),
  status         text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'cancelled')),
  requested_by   uuid not null references public.users(id),
  requested_at   timestamptz not null default now(),
  decided_by     uuid references public.users(id),
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 500),
  constraint inventory_bookings_decided_together check ((decided_by is null) = (decided_at is null))
);

create index inventory_bookings_status_idx on public.inventory_bookings (status, requested_at desc);
create index inventory_bookings_item_idx   on public.inventory_bookings (item_id);
create index inventory_bookings_owner_idx  on public.inventory_bookings (requested_by, requested_at desc);

create table public.inventory_events (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.inventory_items(id),
  booking_id uuid references public.inventory_bookings(id),
  actor_id   uuid references public.users(id),
  action     text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint inventory_events_action_known check (action in (
    'created', 'updated', 'deleted', 'requested', 'confirmed', 'rejected', 'cancelled', 'reversed'))
);
create index inventory_events_item_idx on public.inventory_events (item_id, created_at desc);

-- ═══ 3. Access ══════════════════════════════════════════════════════════════════════════════════════════

-- Internal: the signed-in actor and what they hold. Not callable by clients.
create or replace function public.inventory_actor(
  out p_uid uuid, out p_admin boolean, out p_create boolean, out p_edit boolean,
  out p_delete boolean, out p_approve boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  p_uid := auth.uid();
  if p_uid is not null then
    select (u.role = 'admin') into p_admin
    from public.users u
    where u.id = p_uid and u.is_active and not coalesce(u.is_deleted, false);
  end if;
  if p_uid is null or p_admin is null
     or not (p_admin or public.resolve_permission(p_uid, 'inventory', 'view')) then
    raise exception 'INVENTORY_FORBIDDEN: Inventory is not available to this account' using errcode = '42501';
  end if;
  p_create  := p_admin or public.resolve_permission(p_uid, 'inventory', 'create');
  p_edit    := p_admin or public.resolve_permission(p_uid, 'inventory', 'edit');
  p_delete  := p_admin or public.resolve_permission(p_uid, 'inventory', 'delete');
  p_approve := p_admin or public.resolve_permission(p_uid, 'inventory', 'approve');
end;
$$;
revoke all on function public.inventory_actor() from public, anon, authenticated;

-- What the screens may SHOW. The database decides what is allowed.
create or replace function public.inventory_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.inventory_actor();
  return jsonb_build_object('create', a.p_create, 'edit', a.p_edit, 'delete', a.p_delete, 'approve', a.p_approve);
end;
$$;
revoke all on function public.inventory_my_access() from public, anon;
grant execute on function public.inventory_my_access() to authenticated;

-- Internal: may this caller upload a picture to their own folder? (create or edit)
create or replace function public.inventory_can_upload(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); a record;
begin
  if v_uid is null
     or p_name !~ ('^' || v_uid::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') then
    return false;
  end if;
  select * into a from public.inventory_actor();
  return a.p_create or a.p_edit;
exception when sqlstate '42501' then
  return false;
end;
$$;
revoke all on function public.inventory_can_upload(text) from public, anon;
grant execute on function public.inventory_can_upload(text) to authenticated;

-- ═══ 4. Row security ════════════════════════════════════════════════════════════════════════════════════

alter table public.inventory_items    enable row level security;
alter table public.inventory_images   enable row level security;
alter table public.inventory_bookings enable row level security;
alter table public.inventory_events   enable row level security;

revoke all on public.inventory_items, public.inventory_images, public.inventory_bookings, public.inventory_events
  from anon, authenticated, public;
grant select on public.inventory_items, public.inventory_images, public.inventory_bookings, public.inventory_events
  to authenticated;

create policy inventory_items_select on public.inventory_items
  for select to authenticated using (deleted_at is null);

create policy inventory_images_select on public.inventory_images
  for select to authenticated
  using (exists (select 1 from public.inventory_items i where i.id = item_id and i.deleted_at is null));

-- A salesperson reads their own requests; whoever may approve reads all of them.
create policy inventory_bookings_select on public.inventory_bookings
  for select to authenticated
  using (
    requested_by = auth.uid()
    or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
    or public.resolve_permission(auth.uid(), 'inventory', 'approve')
  );

create policy inventory_events_select on public.inventory_events
  for select to authenticated
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
    or public.resolve_permission(auth.uid(), 'inventory', 'approve')
    or public.resolve_permission(auth.uid(), 'inventory', 'edit')
  );

create policy inventory_items_module_entry_gate on public.inventory_items
  as restrictive for all to authenticated
  using (public.module_entry_open('inventory')) with check (public.module_entry_open('inventory'));
create policy inventory_images_module_entry_gate on public.inventory_images
  as restrictive for all to authenticated
  using (public.module_entry_open('inventory')) with check (public.module_entry_open('inventory'));
create policy inventory_bookings_module_entry_gate on public.inventory_bookings
  as restrictive for all to authenticated
  using (public.module_entry_open('inventory')) with check (public.module_entry_open('inventory'));
create policy inventory_events_module_entry_gate on public.inventory_events
  as restrictive for all to authenticated
  using (public.module_entry_open('inventory')) with check (public.module_entry_open('inventory'));

-- ═══ 5. Pictures ════════════════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inventory-images', 'inventory-images', true, 3145728, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists inventory_images_insert on storage.objects;
create policy inventory_images_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'inventory-images' and public.inventory_can_upload(name));

-- A client may remove only its own upload that no product names (clean-up of an abandoned form).
drop policy if exists inventory_images_delete on storage.objects;
create policy inventory_images_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'inventory-images'
    and owner_id = auth.uid()::text
    and not exists (select 1 from public.inventory_images i where i.path = name)
  );

-- ═══ 6. Writes ══════════════════════════════════════════════════════════════════════════════════════════

-- Create (p_item_id null) or change a product. p_images is the FULL ordered list (1–8 paths, first = thumbnail).
-- p_data keys: product_code, name, category, size_text, material, description, price, condition, stage,
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
    v_qty := (p_data->>'qty_total')::integer;
  exception when others then
    raise exception 'INVENTORY_INVALID: Price and quantity must be numbers' using errcode = '22023';
  end;
  if v_price is null or v_price < 0 or v_price > 9999999999 then raise exception 'INVENTORY_INVALID: Enter a valid price' using errcode = '22023'; end if;
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
      (id, product_code, name, category, size_text, material, description, price, condition, stage,
       expected_ready_on, qty_total, created_by, updated_by)
    values
      (v_id, v_code, v_name, v_cat, v_size, v_mat, v_desc, v_price, v_cond, v_stage,
       v_ready, v_qty, a.p_uid, a.p_uid);
  else
    if v_old.product_code is distinct from v_code then v_fields := array_append(v_fields, 'product_code'::text); end if;
    if v_old.name is distinct from v_name then v_fields := array_append(v_fields, 'name'::text); end if;
    if v_old.category is distinct from v_cat then v_fields := array_append(v_fields, 'category'::text); end if;
    if v_old.size_text is distinct from v_size then v_fields := array_append(v_fields, 'size'::text); end if;
    if v_old.material is distinct from v_mat then v_fields := array_append(v_fields, 'material'::text); end if;
    if v_old.description is distinct from v_desc then v_fields := array_append(v_fields, 'notes'::text); end if;
    if v_old.price is distinct from v_price then v_fields := array_append(v_fields, 'price'::text); end if;
    if v_old.condition is distinct from v_cond then v_fields := array_append(v_fields, 'condition'::text); end if;
    if v_old.stage is distinct from v_stage then v_fields := array_append(v_fields, 'stage'::text); end if;
    if v_old.expected_ready_on is distinct from v_ready then v_fields := array_append(v_fields, 'ready date'::text); end if;
    if v_old.qty_total is distinct from v_qty then v_fields := array_append(v_fields, 'quantity'::text); end if;
    if array(select i.path from public.inventory_images i where i.item_id = v_id order by i.position) is distinct from p_images then
      v_fields := array_append(v_fields, 'pictures'::text);
    end if;
    update public.inventory_items set
      product_code = v_code, name = v_name, category = v_cat, size_text = v_size, material = v_mat,
      description = v_desc, price = v_price, condition = v_cond, stage = v_stage,
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

create or replace function public.inventory_delete_item(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare a record; v_item public.inventory_items; v_pending integer;
begin
  select * into a from public.inventory_actor();
  if not a.p_delete then raise exception 'INVENTORY_FORBIDDEN: You cannot delete products' using errcode = '42501'; end if;
  select * into v_item from public.inventory_items where id = p_item_id and deleted_at is null for update;
  if not found then raise exception 'INVENTORY_NOT_FOUND: That product no longer exists' using errcode = 'P0002'; end if;
  select count(*) into v_pending from public.inventory_bookings where item_id = p_item_id and status = 'pending';
  if v_pending > 0 then
    raise exception 'INVENTORY_INVALID: % booking request(s) are still waiting. Confirm or reject them first', v_pending using errcode = '22023';
  end if;
  update public.inventory_items set deleted_at = now(), deleted_by = a.p_uid, updated_by = a.p_uid where id = p_item_id;
  insert into public.inventory_events (item_id, actor_id, action, detail)
  values (p_item_id, a.p_uid, 'deleted', jsonb_build_object('product_code', v_item.product_code));
  return jsonb_build_object('id', p_item_id);
end;
$$;
revoke all on function public.inventory_delete_item(uuid) from public, anon;
grant execute on function public.inventory_delete_item(uuid) to authenticated;

-- Ask to book units. The units are held at once. An approver may pass p_confirm_now to sell them in one step.
create or replace function public.inventory_request_booking(
  p_request_id uuid, p_item_id uuid, p_qty integer, p_customer_name text,
  p_customer_phone text default null, p_note text default null, p_confirm_now boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a        record;
  v_item   public.inventory_items;
  v_old    public.inventory_bookings;
  v_name   text := btrim(coalesce(p_customer_name, ''));
  v_phone  text := nullif(btrim(coalesce(p_customer_phone, '')), '');
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_id     uuid;
  v_status text := 'pending';
begin
  select * into a from public.inventory_actor();
  if p_request_id is null then raise exception 'INVENTORY_INVALID: Missing request id' using errcode = '22023'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 100000 then raise exception 'INVENTORY_INVALID: Enter how many units' using errcode = '22023'; end if;
  if v_name = '' or length(v_name) > 120 then raise exception 'INVENTORY_INVALID: Customer name is required' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'INVENTORY_INVALID: Note is too long' using errcode = '22023'; end if;
  if v_phone is not null then
    v_phone := public.normalize_lead_phone(v_phone);
    if v_phone is null then raise exception 'INVENTORY_INVALID: That phone number is not valid' using errcode = '22023'; end if;
  end if;
  if p_confirm_now and not a.p_approve then
    raise exception 'INVENTORY_FORBIDDEN: Only a manager can confirm a booking' using errcode = '42501';
  end if;

  select * into v_old from public.inventory_bookings where request_id = p_request_id;
  if found then
    if v_old.requested_by <> a.p_uid or v_old.item_id <> p_item_id or v_old.qty <> p_qty then
      raise exception 'INVENTORY_INVALID: That request id was already used for something else' using errcode = '22023';
    end if;
    return jsonb_build_object('id', v_old.id, 'status', v_old.status, 'replayed', true);
  end if;

  select * into v_item from public.inventory_items where id = p_item_id and deleted_at is null for update;
  if not found then raise exception 'INVENTORY_NOT_FOUND: That product no longer exists' using errcode = 'P0002'; end if;
  if v_item.qty_available < p_qty then
    raise exception 'INVENTORY_INSUFFICIENT: Only % available right now', v_item.qty_available using errcode = '22023';
  end if;

  v_id := gen_random_uuid();
  if p_confirm_now then v_status := 'confirmed'; end if;
  insert into public.inventory_bookings
    (id, request_id, item_id, qty, customer_name, customer_phone, note, status, requested_by, decided_by, decided_at)
  values
    (v_id, p_request_id, p_item_id, p_qty, v_name, v_phone, v_note, v_status, a.p_uid,
     case when p_confirm_now then a.p_uid end, case when p_confirm_now then now() end);

  if p_confirm_now then
    update public.inventory_items set qty_sold = qty_sold + p_qty, updated_by = a.p_uid where id = p_item_id;
  else
    update public.inventory_items set qty_reserved = qty_reserved + p_qty, updated_by = a.p_uid where id = p_item_id;
  end if;
  insert into public.inventory_events (item_id, booking_id, actor_id, action, detail)
  values (p_item_id, v_id, a.p_uid, case when p_confirm_now then 'confirmed' else 'requested' end,
          jsonb_build_object('qty', p_qty, 'customer', v_name));
  return jsonb_build_object('id', v_id, 'status', v_status, 'replayed', false);
end;
$$;
revoke all on function public.inventory_request_booking(uuid, uuid, integer, text, text, text, boolean) from public, anon;
grant execute on function public.inventory_request_booking(uuid, uuid, integer, text, text, text, boolean) to authenticated;

-- Approver: confirm (optionally with a changed quantity) or reject a PENDING request.
create or replace function public.inventory_decide_booking(
  p_booking_id uuid, p_decision text, p_qty integer default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a      record;
  v_item_id uuid;
  v_item public.inventory_items;
  v_bk   public.inventory_bookings;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_qty  integer;
begin
  select * into a from public.inventory_actor();
  if not a.p_approve then raise exception 'INVENTORY_FORBIDDEN: You cannot decide booking requests' using errcode = '42501'; end if;
  if p_decision not in ('confirm', 'reject') then raise exception 'INVENTORY_INVALID: Unknown decision' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'INVENTORY_INVALID: Note is too long' using errcode = '22023'; end if;

  -- Product first, then the request: every writer takes the locks in this order.
  select item_id into v_item_id from public.inventory_bookings where id = p_booking_id;
  if not found then raise exception 'INVENTORY_NOT_FOUND: That request no longer exists' using errcode = 'P0002'; end if;
  select * into v_item from public.inventory_items where id = v_item_id for update;
  select * into v_bk from public.inventory_bookings where id = p_booking_id for update;
  if v_bk.status <> 'pending' then
    raise exception 'INVENTORY_INVALID: This request was already %', v_bk.status using errcode = '22023';
  end if;

  if p_decision = 'reject' then
    update public.inventory_items set qty_reserved = qty_reserved - v_bk.qty, updated_by = a.p_uid where id = v_item_id;
    update public.inventory_bookings set status = 'rejected', decided_by = a.p_uid, decided_at = now(), decision_note = v_note
    where id = p_booking_id;
    insert into public.inventory_events (item_id, booking_id, actor_id, action, detail)
    values (v_item_id, p_booking_id, a.p_uid, 'rejected', jsonb_build_object('qty', v_bk.qty, 'note', v_note));
    return jsonb_build_object('id', p_booking_id, 'status', 'rejected');
  end if;

  v_qty := coalesce(p_qty, v_bk.qty);
  if v_qty < 1 or v_qty > 100000 then raise exception 'INVENTORY_INVALID: Enter how many units' using errcode = '22023'; end if;
  -- A larger quantity needs the extra units to be free right now.
  if v_qty > v_bk.qty and v_item.qty_available < v_qty - v_bk.qty then
    raise exception 'INVENTORY_INSUFFICIENT: Only % available right now', v_item.qty_available + v_bk.qty using errcode = '22023';
  end if;
  update public.inventory_items
     set qty_reserved = qty_reserved - v_bk.qty, qty_sold = qty_sold + v_qty, updated_by = a.p_uid
   where id = v_item_id;
  update public.inventory_bookings
     set status = 'confirmed', qty = v_qty, decided_by = a.p_uid, decided_at = now(), decision_note = v_note
   where id = p_booking_id;
  insert into public.inventory_events (item_id, booking_id, actor_id, action, detail)
  values (v_item_id, p_booking_id, a.p_uid, 'confirmed',
          jsonb_build_object('qty', v_qty, 'requested_qty', v_bk.qty, 'note', v_note));
  return jsonb_build_object('id', p_booking_id, 'status', 'confirmed', 'qty', v_qty);
end;
$$;
revoke all on function public.inventory_decide_booking(uuid, text, integer, text) from public, anon;
grant execute on function public.inventory_decide_booking(uuid, text, integer, text) to authenticated;

-- Cancel: the requester may withdraw their own PENDING request; an approver may cancel a pending request or
-- reverse a CONFIRMED one (the units go back on the shelf). A reason is required to reverse a sale.
create or replace function public.inventory_cancel_booking(p_booking_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record; v_item_id uuid; v_bk public.inventory_bookings;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into a from public.inventory_actor();
  if v_note is not null and length(v_note) > 500 then raise exception 'INVENTORY_INVALID: Note is too long' using errcode = '22023'; end if;
  select item_id into v_item_id from public.inventory_bookings where id = p_booking_id;
  if not found then raise exception 'INVENTORY_NOT_FOUND: That request no longer exists' using errcode = 'P0002'; end if;
  perform 1 from public.inventory_items where id = v_item_id for update;
  select * into v_bk from public.inventory_bookings where id = p_booking_id for update;

  if v_bk.status = 'pending' then
    if not (a.p_approve or v_bk.requested_by = a.p_uid) then
      raise exception 'INVENTORY_FORBIDDEN: You can cancel only your own requests' using errcode = '42501';
    end if;
    update public.inventory_items set qty_reserved = qty_reserved - v_bk.qty, updated_by = a.p_uid where id = v_item_id;
  elsif v_bk.status = 'confirmed' then
    if not a.p_approve then raise exception 'INVENTORY_FORBIDDEN: Only a manager can reverse a confirmed booking' using errcode = '42501'; end if;
    if v_note is null then raise exception 'INVENTORY_INVALID: Say why the sale is being reversed' using errcode = '22023'; end if;
    update public.inventory_items set qty_sold = qty_sold - v_bk.qty, updated_by = a.p_uid where id = v_item_id;
  else
    raise exception 'INVENTORY_INVALID: This request is already %', v_bk.status using errcode = '22023';
  end if;

  update public.inventory_bookings
     set status = 'cancelled', decided_by = a.p_uid, decided_at = now(), decision_note = v_note
   where id = p_booking_id;
  insert into public.inventory_events (item_id, booking_id, actor_id, action, detail)
  values (v_item_id, p_booking_id, a.p_uid, case when v_bk.status = 'confirmed' then 'reversed' else 'cancelled' end,
          jsonb_build_object('qty', v_bk.qty, 'note', v_note));
  return jsonb_build_object('id', p_booking_id, 'status', 'cancelled');
end;
$$;
revoke all on function public.inventory_cancel_booking(uuid, text) from public, anon;
grant execute on function public.inventory_cancel_booking(uuid, text) to authenticated;

-- ═══ 7. Reads that need names ═══════════════════════════════════════════════════════════════════════════

-- Booking requests with the product and people spelled out. scope 'mine' = the caller's own;
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
      select b.id, b.item_id, i.product_code, i.name as item_name, i.price,
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
revoke all on function public.inventory_bookings_list(text, text[], uuid, integer) from public, anon;
grant execute on function public.inventory_bookings_list(text, text[], uuid, integer) to authenticated;

-- The change history of one product, newest first (approvers and editors).
create or replace function public.inventory_item_history(p_item_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.inventory_actor();
  if not (a.p_approve or a.p_edit) then raise exception 'INVENTORY_FORBIDDEN: Not available' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'action', e.action, 'detail', e.detail, 'at', e.created_at, 'actor', u.full_name)
           order by e.created_at desc)
    from (select * from public.inventory_events where item_id = p_item_id
          order by created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) e
    left join public.users u on u.id = e.actor_id
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.inventory_item_history(uuid, integer) from public, anon;
grant execute on function public.inventory_item_history(uuid, integer) to authenticated;
