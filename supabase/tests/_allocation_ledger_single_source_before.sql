-- Probe run by run_allocation_ledger_single_source_suite.sh BEFORE 20261012000000.
--
-- Emits "<order total>|<link/unlink RPC count>". The runner requires
-- "100000|1": before 112 a legacy-linked payment with NO allocation credits its
-- Order its full amount, and all four Link/Unlink RPCs are present. If this ever
-- stops holding, the fixture no longer reproduces the defect and every
-- assertion after it would be proving nothing.
begin;
insert into public.users (id, email, role)
values ('99999999-9999-4999-8999-999999999999', 'probe@boe.test', 'admin');
insert into public.orders (id, display_number, status, client_name, created_by)
values ('99990000-0000-4000-8000-00000000000a', 'ORD-PROBE', 'running', 'Probe Co',
        '99999999-9999-4999-8999-999999999999');
insert into public.finance_payment_requests
  (id, request_number, client_name, amount, submitted_by, status, order_id)
values ('99990001-0000-4000-8000-000000000001', 'PAY-PROBE', 'Probe Co', 100000,
        '99999999-9999-4999-8999-999999999999', 'approved_linked',
        '99990000-0000-4000-8000-00000000000a');

select public.order_linked_payment_total('99990000-0000-4000-8000-00000000000a')
       || '|' ||
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('link_finance_payment_to_order',
                                        'link_finance_payment_to_order_request',
                                        'unlink_finance_payment_from_order',
                                        'unlink_finance_payment_from_order_request')) = 4
             then 1 else 0 end);
rollback;
