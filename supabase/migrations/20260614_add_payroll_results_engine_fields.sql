-- Payroll results: add fields required by Calculation Engine V1.
-- generated_at: timestamp of last generation run, overwritten on every regeneration.
-- half_day_count: raw count of half-day classified days before leave absorption.

ALTER TABLE public.payroll_results
  ADD COLUMN IF NOT EXISTS generated_at   timestamptz,
  ADD COLUMN IF NOT EXISTS half_day_count smallint;
