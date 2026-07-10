-- Showroom QR — dynamic product categories
-- showroom_products.category stays a plain text column (no risky FK conversion);
-- showroom_categories exists as the managed source of truth for the dropdown,
-- and PATCH keeps the two in sync by name.

create table public.showroom_categories (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        not null unique,
  is_active  boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive uniqueness on name (slug is already unique and is derived
-- from name, but two names differing only by case would otherwise slip through).
create unique index showroom_categories_name_lower_idx on public.showroom_categories (lower(name));
create index showroom_categories_active_idx on public.showroom_categories (is_active);

alter table public.showroom_categories enable row level security;

-- Authenticated users can read active categories (needed for the product form dropdown)
create policy "showroom_categories_select" on public.showroom_categories
  for select to authenticated
  using (is_active = true);

create policy "showroom_categories_admin_insert" on public.showroom_categories
  for insert to authenticated
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

create policy "showroom_categories_admin_update" on public.showroom_categories
  for update to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  )
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

create policy "showroom_categories_admin_delete" on public.showroom_categories
  for delete to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

drop trigger if exists showroom_categories_set_updated_at on public.showroom_categories;
create trigger showroom_categories_set_updated_at
  before update on public.showroom_categories
  for each row execute function public.set_updated_at();

-- Backfill: bring every distinct non-empty category already used on
-- showroom_products into showroom_categories, so existing products keep
-- working against the new dropdown. Idempotent — safe to run once or replay.
insert into public.showroom_categories (name, slug)
select distinct
  trim(sp.category),
  regexp_replace(
    regexp_replace(lower(trim(sp.category)), '[^a-z0-9]+', '-', 'g'),
    '(^-+|-+$)', '', 'g'
  )
from public.showroom_products sp
where sp.category is not null and trim(sp.category) <> ''
on conflict do nothing;
