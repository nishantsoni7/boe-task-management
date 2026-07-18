-- Copy & Assign: record the source a task was copied from.
-- Additive, nullable self-referencing FK. ON DELETE SET NULL keeps copies
-- independent — deleting a source task must never cascade-delete its copies.
alter table tasks
  add column if not exists copied_from_task_id uuid
  references tasks(id) on delete set null;

-- Only copied tasks carry a value here, so a partial index keeps the index
-- small while still making provenance lookups ("copies of task X") fast.
create index if not exists tasks_copied_from_task_id_idx
  on tasks (copied_from_task_id)
  where copied_from_task_id is not null;
