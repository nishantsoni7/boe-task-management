-- Extra shape for run_received_payment_allocation_targets_suite.sh
-- (20261216000000), layered on _payment_allocation_ledger_shaped_schema.sql.
--
-- Only what the new read touches that the ledger suite's shaped schema does
-- not carry:
--   * order_submissions.reserved_order_number (20261009000000);
--   * finance_payment_status_is_verified(), verbatim from 20260918000000 §5b.
--
-- A disposable database only. It never talks to a linked project.

alter table public.order_submissions add column reserved_order_number text;

create or replace function public.finance_payment_status_is_verified(p_status text)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(p_status in ('approved_unlinked', 'approved_linked'), false)
$$;
revoke execute on function public.finance_payment_status_is_verified(text) from public, anon;
grant  execute on function public.finance_payment_status_is_verified(text) to authenticated;
