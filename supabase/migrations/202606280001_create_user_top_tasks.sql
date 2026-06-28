-- User Top 3 focus tasks — personal, user-scoped, max 3 active pins
create table if not exists public.user_top_tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  task_id        uuid not null references public.tasks(id) on delete cascade,
  display_order  integer not null,
  created_at     timestamptz not null default now(),
  constraint user_top_tasks_unique_task unique (user_id, task_id)
);

alter table public.user_top_tasks enable row level security;

create policy "user_top_tasks_select"
  on public.user_top_tasks for select
  using (auth.uid() = user_id);

create policy "user_top_tasks_insert"
  on public.user_top_tasks for insert
  with check (auth.uid() = user_id);

create policy "user_top_tasks_delete"
  on public.user_top_tasks for delete
  using (auth.uid() = user_id);

-- Trigger: remove any user_top_tasks row when a task is completed or cancelled.
-- Fires on every status change; only acts when the new status is terminal.
-- This ensures restored tasks do not automatically return to Top 3 — the
-- user must pin them again manually.
create or replace function public.cleanup_top_tasks_on_completion()
returns trigger language plpgsql security definer as $$
begin
  if new.status in ('completed', 'cancelled')
     and old.status not in ('completed', 'cancelled') then
    delete from public.user_top_tasks where task_id = new.id;
  end if;
  return new;
end;
$$;

create trigger cleanup_top_tasks_after_status_change
  after update of status on public.tasks
  for each row
  execute function public.cleanup_top_tasks_on_completion();
