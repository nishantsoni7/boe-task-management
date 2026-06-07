-- Add attachment support to tasks
alter table tasks add column if not exists attachment_url text;

-- Storage bucket for task attachments (public read, auth write)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'task-attachments',
  'task-attachments',
  true,
  10485760,  -- 10 MB per file
  array['image/jpeg','image/png','image/webp','image/gif','application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain','text/csv']
)
on conflict (id) do nothing;

-- Authenticated users can upload to task-attachments
create policy "auth_upload" on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'task-attachments');

-- Anyone can read (bucket is public)
create policy "public_read" on storage.objects
  for select
  using (bucket_id = 'task-attachments');

-- Uploader can delete their own files
create policy "auth_delete" on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'task-attachments' and auth.uid() = owner);
