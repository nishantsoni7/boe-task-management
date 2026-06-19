-- Assets & Access module — employee request form
-- Single table for employees to raise asset/access related requests.
-- request_type values: asset_issue | access_issue | new_asset_request | new_access_request | replacement_request
-- related_type values: employee_asset | employee_access_details | null (not related to existing item)
-- status values: pending | resolved (admin review workflow is a future addition)

create table if not exists public.asset_access_requests (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references public.users(id) on delete cascade,

  request_type  text        not null,
  related_type  text,
  related_id    uuid,
  description   text        not null,

  status        text        not null default 'pending',
  admin_note    text,
  resolved_by   uuid        references public.users(id),
  resolved_at   timestamptz,

  created_at    timestamptz not null default now()
);

create index if not exists asset_access_requests_user_id_idx on public.asset_access_requests(user_id);
create index if not exists asset_access_requests_status_idx  on public.asset_access_requests(status);

alter table public.asset_access_requests enable row level security;

-- Owners: insert and read their own requests
create policy "asset_access_requests_own_select" on public.asset_access_requests
  for select to authenticated
  using (user_id = auth.uid());

create policy "asset_access_requests_own_insert" on public.asset_access_requests
  for insert to authenticated
  with check (user_id = auth.uid());

-- Admin: read and update all requests (review/resolve)
create policy "asset_access_requests_admin_select" on public.asset_access_requests
  for select to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );

create policy "asset_access_requests_admin_update" on public.asset_access_requests
  for update to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid()
        and users.role = 'admin'
    )
  );
