-- Probe run by run_payment_entry_destination_model_suite.sh BEFORE 20261013000000.
--
-- Emits four facts about the pre-113 world, joined by '|'. The runner requires
-- all four: client_name is NOT NULL, record_payment_with_allocations REFUSES an
-- empty customer, there is no intent table, and there is no submit RPC. If any
-- of these stops holding, the fixture no longer reproduces what 113 changes and
-- every assertion after it would be proving nothing.
select
  (select case when is_nullable = 'NO' then 'NOT_NULL' else 'ALREADY_NULLABLE' end
     from information_schema.columns
    where table_schema = 'public' and table_name = 'finance_payment_requests'
      and column_name = 'client_name')
  || '|' ||
  (select case when pg_get_functiondef(
                      'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)'::regprocedure
                    ) ~* 'raise\s+exception\s+''PAYMENT_CLIENT_REQUIRED'
               then 'CLIENT_REQUIRED' else 'CLIENT_OPTIONAL' end)
  || '|' ||
  (select case when to_regclass('public.finance_payment_allocation_intents') is null
               then 'NO_INTENT_TABLE' else 'INTENT_TABLE_EXISTS' end)
  || '|' ||
  (select case when to_regprocedure('public.submit_payment_request(text, uuid, numeric, date, text, text, text, text)') is null
               then 'NO_SUBMIT_RPC' else 'SUBMIT_RPC_EXISTS' end);
