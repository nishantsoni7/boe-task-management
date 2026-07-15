begin;

create index if not exists idx_tasks_completed_by_user_date
on public.tasks (assigned_to, completed_at)
where completed_at is not null;

create index if not exists idx_tasks_stale_blocked_by_user
on public.tasks (assigned_to, last_update_at)
where status = 'blocked';

create index if not exists idx_tasks_active_by_user
on public.tasks (assigned_to, status)
where status not in ('completed', 'cancelled');

create index if not exists idx_tasks_overdue_by_user
on public.tasks (assigned_to, due_date)
where status not in ('completed', 'cancelled')
  and due_date is not null;

commit;
