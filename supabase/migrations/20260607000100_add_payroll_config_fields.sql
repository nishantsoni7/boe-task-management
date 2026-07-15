-- Payroll configuration foundation: extend users table with payroll config fields.
-- No payroll calculation logic — configuration only.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS payroll_active    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS employment_type   text CHECK (employment_type IN ('permanent', 'contract')),
  ADD COLUMN IF NOT EXISTS payroll_notes     text;
