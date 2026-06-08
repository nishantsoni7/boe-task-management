-- Add attachment support to task activity log entries
alter table task_activity_log add column if not exists attachment_url text;
