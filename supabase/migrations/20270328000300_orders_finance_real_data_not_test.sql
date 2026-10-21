-- ORDERS AND FINANCE RECORDS STAMPED AS TEST DATA ARE REAL (20270328000300)
--
-- Test Data Cleanup was enabled from 2026-07-21 until the owner permanently disabled
-- it on 2026-10-21. While it was enabled stamp_test_data_flag() marked every new row
-- is_test_data = true, and prevent_test_data_flag_change() forbids changing the flag
-- afterwards. The business started using the system for real on 2026-10-18, so the
-- Orders and the payments recorded since then were stamped as test data although
-- they are real: the dashboard, revenue and Factory Focus exclude them, and the
-- test-data cleanup / reset tools would treat them as deletable.
--
-- The owner has stated that ALL Orders and Finance data now in the system is real.
-- This migration clears the flag on exactly what was flagged, once:
--
--   public.orders                        8 rows
--   public.finance_payment_requests     18 rows
--   public.finance_payment_allocations  17 rows
--
-- HOW, AND WHY IT IS SAFE
--   * It runs only if Test Data Cleanup is PERMANENTLY disabled, so nothing can be
--     stamped again and the cleanup tools refuse to run.
--   * It aborts unless the number of flagged rows is exactly the number above. If
--     anything else has been stamped meanwhile, a person looks before it runs.
--   * Only the user triggers of the three tables are switched off for the single
--     UPDATE (the immutability trigger refuses the change, and the others would
--     write activity rows and touch updated_at for what is only a re-labelling).
--     They are switched back on in the same transaction; the migration refuses to
--     start if any user trigger on these tables is ALREADY disabled, so "enable
--     trigger user" restores exactly the state it found.
--   * The three tables are locked against writers for the length of the statement.
--   * order_requests (retired) is left as it is, and so is every other table.
--
-- ROLLBACK: there is none by design — the flag is evidence of a phase that is over.
-- A row could be re-flagged by the same disable / update / enable sequence.

-- ONE EXPLICIT TRANSACTION: the CLI runs statements one at a time, so without it a
-- failure after "disable trigger" would leave the triggers off.
begin;

lock table public.orders, public.finance_payment_requests, public.finance_payment_allocations
  in share row exclusive mode;

do $$
declare
  v_disabled boolean;
  v_orders   bigint;
  v_requests bigint;
  v_allocs   bigint;
  v_off      bigint;
begin
  select s.permanently_disabled into v_disabled from public.test_data_cleanup_settings s where s.id = true;
  if v_disabled is distinct from true then
    raise exception 'PRECONDITION: Test Data Cleanup must be permanently disabled first';
  end if;

  select count(*) into v_orders   from public.orders                       where is_test_data;
  select count(*) into v_requests from public.finance_payment_requests     where is_test_data;
  select count(*) into v_allocs   from public.finance_payment_allocations  where is_test_data;
  if v_orders <> 8 or v_requests <> 18 or v_allocs <> 17 then
    raise exception 'PRECONDITION: expected 8 orders, 18 payment requests and 17 allocations flagged as test data, found %, % and %',
      v_orders, v_requests, v_allocs;
  end if;

  select count(*) into v_off
    from pg_trigger t
   where not t.tgisinternal
     and t.tgrelid in ('public.orders'::regclass, 'public.finance_payment_requests'::regclass, 'public.finance_payment_allocations'::regclass)
     and t.tgenabled <> 'O';
  if v_off > 0 then
    raise exception 'PRECONDITION: % trigger(s) on these tables are already disabled or non-default; refusing to re-enable them blindly', v_off;
  end if;
end $$;

alter table public.orders                       disable trigger user;
alter table public.finance_payment_requests     disable trigger user;
alter table public.finance_payment_allocations  disable trigger user;

update public.orders                       set is_test_data = false where is_test_data;
update public.finance_payment_requests     set is_test_data = false where is_test_data;
update public.finance_payment_allocations  set is_test_data = false where is_test_data;

alter table public.orders                       enable trigger user;
alter table public.finance_payment_requests     enable trigger user;
alter table public.finance_payment_allocations  enable trigger user;

do $$
declare
  v_left bigint;
  v_off  bigint;
begin
  select (select count(*) from public.orders where is_test_data)
       + (select count(*) from public.finance_payment_requests where is_test_data)
       + (select count(*) from public.finance_payment_allocations where is_test_data)
    into v_left;
  if v_left <> 0 then
    raise exception 'VERIFY: % rows are still flagged as test data', v_left;
  end if;

  select count(*) into v_off
    from pg_trigger t
   where not t.tgisinternal
     and t.tgrelid in ('public.orders'::regclass, 'public.finance_payment_requests'::regclass, 'public.finance_payment_allocations'::regclass)
     and t.tgenabled <> 'O';
  if v_off <> 0 then
    raise exception 'VERIFY: % trigger(s) were left disabled', v_off;
  end if;

  -- The immutability guard is back in force.
  begin
    update public.orders set is_test_data = true where id = (select id from public.orders limit 1);
    raise exception 'VERIFY: the test-data immutability trigger is not enforcing';
  exception when sqlstate '42501' then
    null;
  end;
end $$;

commit;
