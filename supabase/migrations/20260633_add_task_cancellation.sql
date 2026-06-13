-- Add 'cancelled' to the task status enum if the column is an enum type.
-- Works safely whether tasks.status is a Postgres enum or a plain text column.
DO $$
DECLARE
  v_type_name text;
BEGIN
  SELECT t.typname INTO v_type_name
  FROM pg_attribute  a
  JOIN pg_type       t ON t.oid = a.atttypid
  JOIN pg_class      c ON c.oid = a.attrelid
  WHERE c.relname = 'tasks'
    AND a.attname = 'status'
    AND t.typtype  = 'e';

  IF v_type_name IS NOT NULL THEN
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS ''cancelled''', v_type_name);
  END IF;
END $$;

-- Same for task_activity_log.from_status (may be a separate enum)
DO $$
DECLARE
  v_type_name text;
BEGIN
  SELECT t.typname INTO v_type_name
  FROM pg_attribute  a
  JOIN pg_type       t ON t.oid = a.atttypid
  JOIN pg_class      c ON c.oid = a.attrelid
  WHERE c.relname = 'task_activity_log'
    AND a.attname = 'from_status'
    AND t.typtype  = 'e';

  IF v_type_name IS NOT NULL THEN
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS ''cancelled''', v_type_name);
  END IF;
END $$;

-- Add cancellation fields to tasks table
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS cancelled_by        uuid        REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

-- Rebuild partial indexes so 'cancelled' is also excluded from active/overdue sets.
-- A cancelled task is neither active nor overdue.
DROP INDEX IF EXISTS idx_tasks_active_by_user;
CREATE INDEX idx_tasks_active_by_user
  ON tasks (assigned_to, status)
  WHERE is_deleted = false
    AND status NOT IN ('completed', 'cancelled');

DROP INDEX IF EXISTS idx_tasks_overdue_by_user;
CREATE INDEX idx_tasks_overdue_by_user
  ON tasks (assigned_to, due_date)
  WHERE is_deleted = false
    AND status NOT IN ('completed', 'cancelled')
    AND due_date IS NOT NULL;
