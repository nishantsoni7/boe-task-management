-- positions: central master list of job positions at BOE
create table if not exists positions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now(),
  constraint positions_name_unique unique (name)
);

-- Seed starter positions
insert into positions (name) values
  ('Sales Executive'),
  ('Senior Sales Executive'),
  ('Team Leader'),
  ('Purchase Executive'),
  ('Designer'),
  ('Production Coordinator'),
  ('Accounts Executive')
on conflict (name) do nothing;

-- RLS: admins can do anything; everyone else can read (needed for member forms later)
alter table positions enable row level security;

create policy "admins_all" on positions
  for all
  using (
    exists (
      select 1 from users
      where users.id = auth.uid() and users.role = 'admin'
    )
  );

create policy "authenticated_read" on positions
  for select
  using (auth.role() = 'authenticated');
