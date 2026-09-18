-- Shaped schema for run_verified_payment_permanent_suite.sh (20261218000000).
--
-- Just what the two re-emitted functions read: users and
-- finance_payment_requests (status, is_test_data, request_number). The runner
-- installs the DEPLOYED bodies of finance_payment_status_is_verified(),
-- in_test_data_cleanup(), in_finance_payment_deletion_finalization(), and the
-- 20261011000000 bodies of finance_payment_deletable_by() and
-- finance_payment_requests_guard_approved_delete() with its trigger.
--
-- A disposable database only. It never talks to a linked project.

create table public.users (
  id         uuid primary key,
  role       text not null default 'employee',
  is_active  boolean not null default true,
  is_deleted boolean default false
);

create table public.finance_payment_requests (
  id             uuid primary key,
  request_number text,
  status         text not null,
  is_test_data   boolean not null default false
);
