-- Module visibility: allow multiple departments per module.
--
-- app_modules.allowed_department was a single-value `text` column, so
-- `department_only` visibility could only ever name one department (e.g.
-- Showroom QR could be set to 'sales' OR 'showroom', never both). Convert it
-- to `text[]` so a module can be visible to any number of departments.
--
-- Existing single values are wrapped into a one-element array so current
-- department_only modules (e.g. showroom_qr) keep working unchanged.

ALTER TABLE public.app_modules
  ALTER COLUMN allowed_department TYPE text[]
  USING CASE WHEN allowed_department IS NULL THEN NULL ELSE ARRAY[allowed_department] END;
