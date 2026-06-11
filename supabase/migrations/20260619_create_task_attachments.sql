-- Multi-file attachment support.
-- Keeps existing tasks.attachment_url and task_activity_log.attachment_url untouched.
-- New rows go here; old single-URL fields continue to work for legacy records.

create table if not exists task_attachments (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid references tasks(id) on delete cascade,
  activity_log_id  uuid references task_activity_log(id) on delete cascade,
  url              text not null,
  file_name        text,
  file_type        text,
  created_by       uuid references users(id),
  created_at       timestamptz default now(),
  constraint task_attachments_has_parent check (
    task_id is not null or activity_log_id is not null
  )
);

create index if not exists task_attachments_task_id_idx         on task_attachments(task_id);
create index if not exists task_attachments_activity_log_id_idx on task_attachments(activity_log_id);

alter table task_attachments enable row level security;

-- Authenticated users can read all task attachments (bucket is already public)
create policy "task_attachments_read" on task_attachments
  for select
  to authenticated
  using (true);

-- Authenticated users can insert their own attachment rows
create policy "task_attachments_insert" on task_attachments
  for insert
  to authenticated
  with check (created_by = auth.uid());

-- Uploader can delete their own rows
create policy "task_attachments_delete" on task_attachments
  for delete
  to authenticated
  using (created_by = auth.uid());
