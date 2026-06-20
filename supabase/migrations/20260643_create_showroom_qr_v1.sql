-- Showroom QR V1 — database foundation
-- 3 tables: showroom_products, showroom_inquiries, showroom_inquiry_items
-- RLS follows existing project pattern (public.users role check for admin)
-- No delete policies on any table (soft deactivation via is_active on products)

-- ─── 1. showroom_products ─────────────────────────────────────────────────────

create table public.showroom_products (
  id             uuid           primary key default gen_random_uuid(),
  product_code   text           not null unique,
  name           text           not null,
  category       text           not null,
  description    text,
  specifications jsonb,
  image_url      text,
  mrp            numeric(10,2)  not null,
  is_active      boolean        not null default true,
  created_at     timestamptz    not null default now()
);

create index showroom_products_code_idx     on public.showroom_products(product_code);
create index showroom_products_category_idx on public.showroom_products(category);
create index showroom_products_active_idx   on public.showroom_products(is_active);

alter table public.showroom_products enable row level security;

-- Authenticated users can read active products (needed for product page + search)
create policy "showroom_products_select" on public.showroom_products
  for select to authenticated
  using (is_active = true);

-- Admin can insert
create policy "showroom_products_admin_insert" on public.showroom_products
  for insert to authenticated
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

-- Admin can update (includes toggling is_active — never delete)
create policy "showroom_products_admin_update" on public.showroom_products
  for update to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  )
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );


-- ─── 2. showroom_inquiries ────────────────────────────────────────────────────

create table public.showroom_inquiries (
  id               uuid          primary key default gen_random_uuid(),
  salesperson_id   uuid          not null references public.users(id),
  customer_name    text          not null,
  customer_mobile  text          not null,
  company          text,
  city             text,
  project_name     text,
  lead_source      text          not null default 'Showroom QR',
  status           text          not null default 'new'
                                 check (status in ('new', 'in_discussion', 'quotation_sent', 'closed')),
  discount_percent numeric(5,2)  not null default 0,
  notes            text,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);

create index showroom_inquiries_salesperson_idx on public.showroom_inquiries(salesperson_id);
create index showroom_inquiries_status_idx      on public.showroom_inquiries(status);

alter table public.showroom_inquiries enable row level security;

-- Salesperson reads own inquiries; admin reads all
create policy "showroom_inquiries_select" on public.showroom_inquiries
  for select to authenticated
  using (
    salesperson_id = auth.uid()
    or exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

-- Insert: authenticated users only — server-side API validates salesperson_id = caller
-- (inquiries are only created server-side after customer submits; no client-side anonymous insert)
create policy "showroom_inquiries_insert" on public.showroom_inquiries
  for insert to authenticated
  with check (salesperson_id = auth.uid());

-- Salesperson updates own inquiries; admin updates all
create policy "showroom_inquiries_update" on public.showroom_inquiries
  for update to authenticated
  using (
    salesperson_id = auth.uid()
    or exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  )
  with check (
    salesperson_id = auth.uid()
    or exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

-- Auto-update updated_at
drop trigger if exists showroom_inquiries_set_updated_at on public.showroom_inquiries;
create trigger showroom_inquiries_set_updated_at
  before update on public.showroom_inquiries
  for each row execute function public.set_updated_at();


-- ─── 3. showroom_inquiry_items ────────────────────────────────────────────────

create table public.showroom_inquiry_items (
  id           uuid          primary key default gen_random_uuid(),
  inquiry_id   uuid          not null references public.showroom_inquiries(id) on delete cascade,
  product_id   uuid          not null references public.showroom_products(id),
  quantity     integer       not null default 1 check (quantity > 0),
  mrp_at_time  numeric(10,2) not null,
  created_at   timestamptz   not null default now()
);

create index showroom_inquiry_items_inquiry_idx on public.showroom_inquiry_items(inquiry_id);
create index showroom_inquiry_items_product_idx on public.showroom_inquiry_items(product_id);

alter table public.showroom_inquiry_items enable row level security;

-- Salesperson can read items for own inquiries; admin can read all
create policy "showroom_inquiry_items_select" on public.showroom_inquiry_items
  for select to authenticated
  using (
    exists (
      select 1 from public.showroom_inquiries
      where showroom_inquiries.id = inquiry_id
        and (
          showroom_inquiries.salesperson_id = auth.uid()
          or exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
        )
    )
  );

-- Insert: salesperson inserts items only for own inquiries
create policy "showroom_inquiry_items_insert" on public.showroom_inquiry_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.showroom_inquiries
      where showroom_inquiries.id = inquiry_id
        and (
          showroom_inquiries.salesperson_id = auth.uid()
          or exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
        )
    )
  );

-- Update: salesperson updates items only for own inquiries; admin updates all
create policy "showroom_inquiry_items_update" on public.showroom_inquiry_items
  for update to authenticated
  using (
    exists (
      select 1 from public.showroom_inquiries
      where showroom_inquiries.id = inquiry_id
        and (
          showroom_inquiries.salesperson_id = auth.uid()
          or exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
        )
    )
  )
  with check (
    exists (
      select 1 from public.showroom_inquiries
      where showroom_inquiries.id = inquiry_id
        and (
          showroom_inquiries.salesperson_id = auth.uid()
          or exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
        )
    )
  );

-- Delete: salesperson deletes items only for own inquiries; admin deletes all
create policy "showroom_inquiry_items_delete" on public.showroom_inquiry_items
  for delete to authenticated
  using (
    exists (
      select 1 from public.showroom_inquiries
      where showroom_inquiries.id = inquiry_id
        and (
          showroom_inquiries.salesperson_id = auth.uid()
          or exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
        )
    )
  );
