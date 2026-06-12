-- Assets & Access module — initial schema
-- Creates four tables: employee_assets, employee_access_details,
-- asset_maintenance_history, asset_activity_log.
-- RLS mirrors the pattern used by tasks, payroll, and attendance tables.
--
-- SECURITY NOTE (password_value):
--   password_value is stored as plain text for internal V1 convenience.
--   Before any wider rollout or increased access, this column MUST be
--   replaced with an encrypted value (e.g. pgcrypto's pgp_sym_encrypt,
--   or moved entirely to a secrets manager) and the RLS policies must
--   be tightened so that only the owning user can decrypt / read it.

-- ─── 1. employee_assets ───────────────────────────────────────────────────────
-- One row per device/asset assigned to an employee.
-- asset_type values (enforced in application layer, not a DB enum so we can
-- add new types without a migration): laptop_desktop | monitor | mouse_keyboard
--   | storage | phone | other

create table if not exists public.employee_assets (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references public.users(id) on delete cascade,

  asset_type           text        not null,
  asset_name           text        not null,
  brand                text,
  model                text,
  serial_number        text,
  specifications       text,

  -- status values: in_use | spare | repair | not_working | returned
  status               text        not null default 'in_use',

  assigned_location    text,
  purchase_date        date,
  last_service_date    date,
  last_os_update_date  date,
  last_formatted_date  date,
  notes                text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists employee_assets_user_id_idx   on public.employee_assets(user_id);
create index if not exists employee_assets_asset_type_idx on public.employee_assets(asset_type);
create index if not exists employee_assets_status_idx    on public.employee_assets(status);

alter table public.employee_assets enable row level security;

-- Owners: full read/write on their own rows
create policy "employee_assets_own_select" on public.employee_assets
  for select to authenticated
  using (user_id = auth.uid());

create policy "employee_assets_own_insert" on public.employee_assets
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "employee_assets_own_update" on public.employee_assets
  for update to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Admin: read all employees' assets
create policy "employee_assets_admin_select" on public.employee_assets
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );

-- updated_at trigger (function already defined in 20260609_create_attendance_records)
drop trigger if exists employee_assets_set_updated_at on public.employee_assets;
create trigger employee_assets_set_updated_at
  before update on public.employee_assets
  for each row execute function public.set_updated_at();


-- ─── 2. employee_access_details ──────────────────────────────────────────────
-- One row per platform/system login for an employee.
-- access_type values: system_login | gmail | clickup | other
--
-- SECURITY NOTE: see top-of-file note about password_value.

create table if not exists public.employee_access_details (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.users(id) on delete cascade,

  -- access_type values: system_login | gmail | clickup | other
  access_type         text        not null,
  login_label         text        not null,
  login_id            text        not null,

  -- Plain text for V1 — MUST be encrypted before wider rollout (see note above)
  password_value      text,

  recovery_info       text,
  two_factor_enabled  boolean     not null default false,
  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists employee_access_details_user_id_idx    on public.employee_access_details(user_id);
create index if not exists employee_access_details_access_type_idx on public.employee_access_details(access_type);

alter table public.employee_access_details enable row level security;

-- Owners: full read/write on their own rows
create policy "employee_access_own_select" on public.employee_access_details
  for select to authenticated
  using (user_id = auth.uid());

create policy "employee_access_own_insert" on public.employee_access_details
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "employee_access_own_update" on public.employee_access_details
  for update to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Admin: read all employees' access records
create policy "employee_access_admin_select" on public.employee_access_details
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );

-- updated_at trigger
drop trigger if exists employee_access_details_set_updated_at on public.employee_access_details;
create trigger employee_access_details_set_updated_at
  before update on public.employee_access_details
  for each row execute function public.set_updated_at();


-- ─── 3. asset_maintenance_history ────────────────────────────────────────────
-- Append-only log of service/update/format events for a specific asset.
-- event_type values: service | os_update | format | repair | other
-- Cascades on asset deletion so history is cleaned up automatically.

create table if not exists public.asset_maintenance_history (
  id          uuid        primary key default gen_random_uuid(),
  asset_id    uuid        not null references public.employee_assets(id) on delete cascade,
  user_id     uuid        not null references public.users(id) on delete cascade,

  -- event_type values: service | os_update | format | repair | other
  event_type  text        not null,
  event_date  date        not null,
  notes       text,

  created_at  timestamptz not null default now()
);

create index if not exists asset_maintenance_asset_id_idx  on public.asset_maintenance_history(asset_id);
create index if not exists asset_maintenance_user_id_idx   on public.asset_maintenance_history(user_id);
create index if not exists asset_maintenance_event_date_idx on public.asset_maintenance_history(event_date);

alter table public.asset_maintenance_history enable row level security;

-- Owners: read and append their own maintenance records (no update — history is immutable)
create policy "asset_maintenance_own_select" on public.asset_maintenance_history
  for select to authenticated
  using (user_id = auth.uid());

create policy "asset_maintenance_own_insert" on public.asset_maintenance_history
  for insert to authenticated
  with check (user_id = auth.uid());

-- Admin: read all maintenance records
create policy "asset_maintenance_admin_select" on public.asset_maintenance_history
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );


-- ─── 4. asset_activity_log ───────────────────────────────────────────────────
-- Audit trail for changes in the Assets & Access module.
-- user_id  = the employee whose record was affected.
-- actor_id = who performed the action (may be same as user_id, or admin).
-- entity_type examples: employee_asset | employee_access_details | maintenance_history
-- action examples: created | updated | deleted | viewed

create table if not exists public.asset_activity_log (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.users(id) on delete cascade,
  actor_id     uuid        not null references public.users(id) on delete cascade,

  action       text        not null,
  entity_type  text        not null,
  entity_id    uuid,
  details      text,

  created_at   timestamptz not null default now()
);

create index if not exists asset_activity_log_user_id_idx  on public.asset_activity_log(user_id);
create index if not exists asset_activity_log_actor_id_idx on public.asset_activity_log(actor_id);
create index if not exists asset_activity_log_created_at_idx on public.asset_activity_log(created_at desc);

alter table public.asset_activity_log enable row level security;

-- Users can read activity that affects their own records
create policy "asset_activity_log_own_select" on public.asset_activity_log
  for select to authenticated
  using (user_id = auth.uid());

-- Users can insert activity rows where they are the actor
create policy "asset_activity_log_own_insert" on public.asset_activity_log
  for insert to authenticated
  with check (actor_id = auth.uid());

-- Admin: read all activity log entries
create policy "asset_activity_log_admin_select" on public.asset_activity_log
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );

-- Admin: insert activity log entries on behalf of any user (e.g. admin view events)
create policy "asset_activity_log_admin_insert" on public.asset_activity_log
  for insert to authenticated
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );
