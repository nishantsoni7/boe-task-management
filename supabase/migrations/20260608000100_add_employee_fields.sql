-- Employee Master V1: extend users table with employee-specific fields.
-- No separate employees table — reuses existing BOE user/member records.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS employee_code  text,
  ADD COLUMN IF NOT EXISTS joining_date   date,
  ADD COLUMN IF NOT EXISTS monthly_salary numeric(12, 2),
  ADD COLUMN IF NOT EXISTS office_timing  text;

-- Employee code must be unique when populated
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_code_unique
  ON public.users (employee_code)
  WHERE employee_code IS NOT NULL;
