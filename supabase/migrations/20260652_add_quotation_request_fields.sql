-- Add task_type column to distinguish general tasks from quotation requests.
-- Uses a plain text column with CHECK constraint (not a Postgres enum) for simplicity.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'general'
    CHECK (task_type IN ('general', 'quotation_request'));

-- Quotation-specific fields — nullable, only populated for quotation_request tasks.
-- Requirement/notes reuse the existing `note` column.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS customer_name  text,
  ADD COLUMN IF NOT EXISTS contact_number text,
  ADD COLUMN IF NOT EXISTS company_name   text,
  ADD COLUMN IF NOT EXISTS city_project   text;
