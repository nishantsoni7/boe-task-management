-- TEST-ONLY. Brings the shaped Orders/Finance allocation table up to PRODUCTION'S
-- shape for what 20270322000000 depends on: the reversal columns and CHECKs, and
-- the guards that make an allocation immutable and a reversal complete.
-- run_payment_edit_reallocates_suite.sh installs the guard FUNCTIONS, extracted
-- verbatim from their own migrations, before this file and the triggers after it.
--
-- Without this the harness's allocation table is a bare table: it has no
-- reversal columns, so reversing an allocation could not even be attempted, and
-- nothing would stop an allocation's amount being edited in place — which is
-- exactly what production forbids and why the migration reverses and re-creates.
--
-- Sources: 20260918000000 §1 (columns, CHECKs), §6 (transition guard), §7
-- (derive_reversal), §4 (payment-side amount guard).

alter table public.finance_payment_allocations
  add column if not exists reversed_by      uuid references public.users(id),
  add column if not exists reversed_at      timestamptz,
  add column if not exists reversal_reason  text;

alter table public.finance_payment_allocations
  drop constraint if exists finance_payment_allocations_reversal_complete;
alter table public.finance_payment_allocations
  add constraint finance_payment_allocations_reversal_complete check (
    (status = 'active'
     and reversed_by is null
     and reversed_at is null
     and reversal_reason is null)
    or
    (status = 'reversed'
     and reversed_by is not null
     and reversed_at is not null
     and reversal_reason is not null
     and btrim(reversal_reason) <> '')
  );

-- The approval marker the 20260921 transition guard asks about: no approval is
-- in flight in this harness, so it answers false.
create or replace function public.in_pi_submission_approval(p_submission_id uuid)
returns boolean language sql stable as $$ select false $$;
