-- Extra shape for run_received_payment_allocation_targets_suite.sh
-- (20261216000000), layered on _payment_allocation_ledger_shaped_schema.sql.
--
-- Only what the new read touches that the ledger suite's shaped schema does
-- not carry:
--   * order_submissions.reserved_order_number (20261009000000);
--   * finance_payment_status_is_verified(), verbatim from 20260918000000 §5b;
--   * a reduced security_invoker finance_received_payments, so the defect in
--     its RLS-limited confirmed_allocation_status can be reproduced and the
--     complete_allocation_status computed field has its row type.
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

-- The projection the list reads, reduced to the columns that matter here. Like
-- the live finance_received_payments (20261012000000) it is security_invoker and
-- sums ACTIVE allocations under the caller's RLS, with the same status CASE —
-- which is exactly how a participant without view_all gets a status computed
-- from part of the ledger.
create view public.finance_received_payments
with (security_invoker = true) as
select
  f.id,
  f.amount,
  f.status,
  f.submitted_by,
  case
    when f.amount is null                            then null
    when coalesce(t.allocated_total, 0) <= 0         then 'zero'
    when t.allocated_total > f.amount                then 'over'
    when t.allocated_total = f.amount                then 'full'
    else 'partial'
  end as confirmed_allocation_status
from public.finance_payment_requests f
left join lateral (
  select sum(a.allocated_amount) as allocated_total
  from public.finance_payment_allocations a
  where a.payment_request_id = f.id and a.status = 'active'
) t on true;
grant select on public.finance_received_payments to authenticated;
