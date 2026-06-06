-- daily_work_logs: end-of-day submissions by team members
create table if not exists daily_work_logs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  log_date     date not null default current_date,
  summary      text not null,
  highlights   text,
  blockers     text,
  self_score   int check (self_score between 1 and 5),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint daily_work_logs_user_date_unique unique (user_id, log_date)
);

create index if not exists daily_work_logs_user_id_idx on daily_work_logs(user_id);
create index if not exists daily_work_logs_log_date_idx on daily_work_logs(log_date);

alter table daily_work_logs enable row level security;

-- Members can read/write their own logs
create policy "own_logs_all" on daily_work_logs
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Admins and managers can read all logs
create policy "admin_manager_read" on daily_work_logs
  for select
  using (
    exists (
      select 1 from users
      where users.id = auth.uid()
        and users.role in ('admin', 'manager')
    )
  );
