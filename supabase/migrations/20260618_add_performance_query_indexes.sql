create index if not exists idx_tasks_completed_by_user_date
on tasks (assigned_to, completed_at)
where completed_at is not null
and is_deleted = false;

create index if not exists idx_tasks_stale_blocked_by_user
on tasks (assigned_to, last_update_at)
where status = 'blocked'
and is_deleted = false;

create index if not exists idx_tasks_active_by_user
on tasks (assigned_to, status)
where is_deleted = false
and status != 'completed';

create index if not exists idx_tasks_overdue_by_user
on tasks (assigned_to, due_date)
where is_deleted = false
and status != 'completed'
and due_date is not null;
