-- Add fingerprint_employee_code to map BOE employee codes to attendance machine codes.
-- The attendance machine exports codes like 0014, 0017 which differ from BOE-001 format.
-- This is a separate field — employee_code is not replaced or renamed.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS fingerprint_employee_code text;
