-- Add old_val / new_val columns to task_activity_log for structured field-change auditing.
-- Used by title_changed, deadline_changed, and priority_changed entries.
alter table task_activity_log add column if not exists old_val text;
alter table task_activity_log add column if not exists new_val text;
