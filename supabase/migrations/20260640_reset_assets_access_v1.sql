-- Assets & Access V1 reset.
-- Drops the old request-workflow / maintenance / activity-log schema and
-- replaces it with the minimal V1 schema: assets (catalog), employee_assets
-- (assignment + acceptance), access_records (login/credential assignment).
-- This is a clean reset — any existing rows in the dropped tables are lost.

drop table if exists public.asset_access_requests cascade;
drop table if exists public.asset_maintenance_history cascade;
drop table if exists public.asset_activity_log cascade;
drop table if exists public.employee_access_details cascade;
drop table if exists public.employee_assets cascade;

-- ─── 1. assets ─────────────────────────────────────────────────────────────
-- Catalog of company-owned devices. Not employee-specific.

create table public.assets (
  id          uuid        primary key default gen_random_uuid(),
  asset_type  text        not null,
  asset_name  text        not null,
  serial_no   text,

  -- status: available | assigned | returned | lost
  status      text        not null default 'available',

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index assets_status_idx on public.assets(status);

alter table public.assets enable row level security;

-- All authenticated users can read the catalog (non-sensitive fields only).
create policy "assets_select_all" on public.assets
  for select to authenticated
  using (true);

create policy "assets_admin_insert" on public.assets
  for insert to authenticated
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

create policy "assets_admin_update" on public.assets
  for update to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  )
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

drop trigger if exists assets_set_updated_at on public.assets;
create trigger assets_set_updated_at
  before update on public.assets
  for each row execute function public.set_updated_at();


-- ─── 2. employee_assets ───────────────────────────────────────────────────
-- One row per asset assignment to an employee, with one-time acceptance.

create table public.employee_assets (
  id           uuid        primary key default gen_random_uuid(),
  asset_id     uuid        not null references public.assets(id) on delete cascade,
  employee_id  uuid        not null references public.users(id) on delete cascade,
  assigned_by  uuid        not null references public.users(id),

  assigned_at  timestamptz not null default now(),
  accepted_at  timestamptz,
  returned_at  timestamptz,
  lost_at      timestamptz,

  -- status: pending_acceptance | accepted | returned | lost
  status       text        not null default 'pending_acceptance'
);

create index employee_assets_asset_id_idx    on public.employee_assets(asset_id);
create index employee_assets_employee_id_idx on public.employee_assets(employee_id);
create index employee_assets_status_idx      on public.employee_assets(status);

alter table public.employee_assets enable row level security;

-- Employees: read their own assignments only.
create policy "employee_assets_own_select" on public.employee_assets
  for select to authenticated
  using (employee_id = auth.uid());

-- Employees: may only accept a pending assignment (no other edits).
create policy "employee_assets_own_accept" on public.employee_assets
  for update to authenticated
  using (employee_id = auth.uid() and status = 'pending_acceptance')
  with check (employee_id = auth.uid() and status = 'accepted');

-- Admin: full read/write.
create policy "employee_assets_admin_select" on public.employee_assets
  for select to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));

create policy "employee_assets_admin_insert" on public.employee_assets
  for insert to authenticated
  with check (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));

create policy "employee_assets_admin_update" on public.employee_assets
  for update to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'))
  with check (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));


-- ─── 3. access_records ────────────────────────────────────────────────────
-- One row per login/access credential assigned to an employee.
--
-- SECURITY NOTE (secret_value):
--   Stored as plain text for internal V1 convenience. Before any wider
--   rollout, this column MUST be encrypted (e.g. pgcrypto's pgp_sym_encrypt)
--   or moved to a secrets manager.

create table public.access_records (
  id           uuid        primary key default gen_random_uuid(),
  employee_id  uuid        not null references public.users(id) on delete cascade,

  access_type  text        not null,
  username     text        not null,
  secret_value text,

  -- status: active | disabled
  status       text        not null default 'active',

  assigned_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid        references public.users(id)
);

create index access_records_employee_id_idx on public.access_records(employee_id);
create index access_records_status_idx      on public.access_records(status);

alter table public.access_records enable row level security;

-- Employees: read their own access records only.
create policy "access_records_own_select" on public.access_records
  for select to authenticated
  using (employee_id = auth.uid());

-- Admin: full read/write.
create policy "access_records_admin_select" on public.access_records
  for select to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));

create policy "access_records_admin_insert" on public.access_records
  for insert to authenticated
  with check (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));

create policy "access_records_admin_update" on public.access_records
  for update to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'))
  with check (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));

drop trigger if exists access_records_set_updated_at on public.access_records;
create trigger access_records_set_updated_at
  before update on public.access_records
  for each row execute function public.set_updated_at();
